/**
 * sharedCache.js
 * ─────────────────────────────────────────────────────────────
 * طبقة تخزين مؤقت مشتركة لقراءات "الشجرة الكاملة" (warehouse, ordersTest, ...)
 * الهدف: أي صفحة تحتاج كل المخزون أو كل الطلبات تستخدم هذا بدل ما تسوي
 * get(ref(db, 'warehouse')) بنفسها — فتتشارك نفس النسخة المحمّلة مع باقي
 * الصفحات المفتوحة بنفس المتصفح خلال مدة قصيرة، بدل ما كل وحدة تحمّل من جديد.
 *
 * ⚠️ مهم جداً: هذا الملف يُستخدم فقط للقراءات الشاملة (تقارير، بحث بالكاشير،
 * قوائم منتجات/طلبات كاملة). عمليات الكتابة (تغيير حالة، إضافة طلب، تعديل
 * منتج) وأي قراءة "لسجل واحد محدد" (تفاصيل طلب معين شغال عليه الموظف الحين)
 * تبقى مباشرة زي ما هي — ما تمر من هذا الملف إطلاقاً.
 *
 * الاستخدام بأي صفحة:
 *   import { getWarehouseCached, getOrdersCached, getCached, invalidateCache }
 *     from "./sharedCache.js";
 *   const warehouseData = await getWarehouseCached(db);
 *   const ordersData    = await getOrdersCached(db);
 *
 * بدل:
 *   const snap = await get(ref(db, "warehouse"));
 *   const warehouseData = snap.exists() ? snap.val() : {};
 */

import { ref, get } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

// مدة صلاحية النسخة المخزنة قبل ما تعتبر "قديمة" وتنعاد قراءتها من فايربيس.
// 75 ثانية = كافية جداً تمنع التكرار (نفس الموظف يفتح كم صفحة بدقيقة وحدة،
// أو نفس الصفحة تسوي كم طلب لنفس البيانات) بدون ما يكون فيه أي تأخير محسوس
// بالعمل، لأن المخزون والطلبات ما تتغير بشكل يحتاج دقة أقل من دقيقة لهالاستخدامات.
const CACHE_TTL_MS = 75 * 1000;

/* ════════════════════════════════════════════════════════
   🔖 بوابة بصمة التغيير
   ────────────────────────────────────────────────────────
   🚨 المشكلة الي انكشفت (٩ تشرين الأول ٢٠٢٦): القاعدة كلها ٥٤.٦ ميكا،
   بس التنزيل اليومي ~١ غيغا — يعني القاعدة تنزّلت ١٨ مرة باليوم.
   السبب: ثلاث صفحات فيها setInterval كل ١٢٠ ثانية تنزّل الفرع كامل
   (stats-employees → ordersTest ٣ ميكا، purchases → ١.٢ ميكا،
   add-order → warehouse ٥١٦ كيلو). ومدة الكاش فوق ٧٥ ثانية — أقل من
   الـ١٢٠ — فالكاش كان ينتهي دائماً قبل ما يوصل الدور وما منع ولا
   تنزيلة وحدة.

   الحل: السيرفر يكتب رقم واحد لكل فرع (stats/touch/*) بأي تعديل.
   قبل ما ننزّل ٣ ميكا، نقرا هذا الرقم (بايتات): إذا ما تغير عن آخر
   مرة نزّلنا بيها، نرجّع نسختنا وما ننزّل شي. التحديث يضل كل دقيقتين
   بالضبط والموظف ما ينتبه لأي فرق.

   ⚠️ أمان: لو وقف السيرفر (مثل انقطاع الفاتورة) البصمة تتجمد، ولو
   اعتمدنا عليها لحالها راح نخدم نسخة قديمة للأبد. لذلك أكو سقف:
   بعد MAX_GATED_AGE_MS من آخر تنزيل حقيقي، ننزّل على أي حال.
   ولو البصمة مو موجودة أصلاً (قبل نشر الدوال) البوابة تنطفي
   والسلوك يرجع مثل ما كان بالضبط.
   ════════════════════════════════════════════════════════ */
const MAX_GATED_AGE_MS = 15 * 60 * 1000;

// أي مسار عنده بصمة بالسيرفر. المسارات الثانية ما تتأثر إطلاقاً.
const TOUCH_BRANCH = {
  ordersTest: "orders",
  warehouse:  "warehouse",
  purchases:  "purchases"
};

async function readTouch(db, path) {
  const branch = TOUCH_BRANCH[path];
  if (!branch) return null;
  try {
    const snap = await get(ref(db, `stats/touch/${branch}`));
    if (!snap.exists()) return null;
    const v = Number(snap.val());
    return Number.isFinite(v) ? v : null;
  } catch (e) {
    return null; // ما نكسر القراءة بسبب البصمة — نرجع للسلوك القديم
  }
}

// نستخدم sessionStorage عشان النسخة المخزنة تنفع حتى لو الموظف تنقل
// من صفحة لصفحة ثانية (كل صفحة HTML منفصلة، الذاكرة العادية تنمسح
// بمجرد ما ينتقل الموظف لصفحة ثانية، لكن sessionStorage يضل موجود
// طول ما التبويب مفتوح).
const memoryCache = new Map(); // نسخة إضافية بالذاكرة لنفس تحميل الصفحة (أسرع من sessionStorage)

function readSession(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.ts !== "number") return null;
    // at = وقت آخر تنزيل حقيقي. النسخ القديمة ما عندها، فنعتبرها = ts.
    if (typeof parsed.at !== "number") parsed.at = parsed.ts;
    if (typeof parsed.touch !== "number") parsed.touch = null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function writeSession(key, data, at, touch) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), at, touch, data }));
  } catch (e) {
    // sessionStorage ممكن يفشل (وضع خاص بالمتصفح، أو البيانات كبيرة جداً) —
    // ما مشكلة، بس نتجاهل ونعتمد على memoryCache بس بهالحالة.
  }
}

/**
 * getCached(db, path)
 * يرجع بيانات المسار المحدد (كامل الشجرة تحته)، من الذاكرة المؤقتة إذا
 * كانت حديثة (أقل من CACHE_TTL_MS)، وإلا يسأل بصمة التغيير أول،
 * وإذا تغيرت فعلاً يجيبها من فايربيس ويخزنها.
 */
export async function getCached(db, path) {
  const now = Date.now();
  const key = "sharedCache:" + path;

  // 1) تحقق من ذاكرة الصفحة الحالية أول (أسرع شي، بدون أي I/O)
  const mem = memoryCache.get(path);
  if (mem && (now - mem.ts) < CACHE_TTL_MS) {
    return mem.data;
  }

  // 2) تحقق من sessionStorage (تشمل بيانات محمّلة من صفحة ثانية فتحها
  //    نفس الموظف بنفس التبويب خلال المدة المسموحة)
  const stored = readSession(key);
  if (stored && (now - stored.ts) < CACHE_TTL_MS) {
    memoryCache.set(path, { ts: stored.ts, at: stored.at, touch: stored.touch, data: stored.data });
    return stored.data;
  }

  // 3) عدنا نسخة بس انتهت مدتها — قبل ما ننزّل الفرع كامل، نسأل
  //    السيرفر رقم واحد: هل تغير شي أصلاً من آخر تنزيل؟
  const cached = mem || stored;
  if (cached && cached.touch != null && (now - cached.at) < MAX_GATED_AGE_MS) {
    const live = await readTouch(db, path);
    if (live != null && live === cached.touch) {
      // ما تغير ولا شي — نجدد ختم الفحص (مو ختم التنزيل) ونرجّع نفس النسخة
      memoryCache.set(path, { ts: now, at: cached.at, touch: cached.touch, data: cached.data });
      writeSession(key, cached.data, cached.at, cached.touch);
      return cached.data;
    }
  }

  // 4) تنزيل فعلي.
  //    ⚠️ نقرا البصمة **قبل** التنزيل مو بعده: لو صار تعديل أثناء
  //    التنزيل، نخزن البصمة القديمة فالقراءة الجاية تنزّل من جديد.
  //    الخطأ بهذا الاتجاه = تنزيلة زايدة، والاتجاه الثاني = بيانات قديمة.
  const touchNow = await readTouch(db, path);
  const snap = await get(ref(db, path));
  const data = snap.exists() ? snap.val() : {};

  memoryCache.set(path, { ts: now, at: now, touch: touchNow, data });
  writeSession(key, data, now, touchNow);

  return data;
}

/** اختصار لقراءة كامل المخزن (warehouse) */
export async function getWarehouseCached(db) {
  return getCached(db, "warehouse");
}

/** اختصار لقراءة كامل الطلبات (ordersTest) */
export async function getOrdersCached(db) {
  return getCached(db, "ordersTest");
}

/**
 * invalidateCache(path)
 * استدعيها بعد أي عملية كتابة تعرف إنها غيّرت البيانات (مثلاً بعد ما
 * موظف يضيف منتج جديد بالمخزن من نفس الصفحة) عشان أي قراءة جاية فوراً
 * تاخذ النسخة الجديدة بدل ما تنتظر انتهاء مدة الـ75 ثانية.
 * (اختياري الاستخدام — إذا ما استدعيتها، النظام يرجع يصحح نفسه تلقائياً
 * خلال 75 ثانية بحد أقصى، وهذا مقبول تماماً لهالنوع من القراءات.)
 */
export function invalidateCache(path) {
  memoryCache.delete(path);
  try { sessionStorage.removeItem("sharedCache:" + path); } catch (e) {}
}

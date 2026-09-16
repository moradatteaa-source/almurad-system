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
    return parsed;
  } catch (e) {
    return null;
  }
}

function writeSession(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch (e) {
    // sessionStorage ممكن يفشل (وضع خاص بالمتصفح، أو البيانات كبيرة جداً) —
    // ما مشكلة، بس نتجاهل ونعتمد على memoryCache بس بهالحالة.
  }
}

/**
 * getCached(db, path)
 * يرجع بيانات المسار المحدد (كامل الشجرة تحته)، من الذاكرة المؤقتة إذا
 * كانت حديثة (أقل من CACHE_TTL_MS)، وإلا يجيبها من فايربيس ويخزنها.
 */
export async function getCached(db, path) {
  const now = Date.now();

  // 1) تحقق من ذاكرة الصفحة الحالية أول (أسرع شي، بدون أي I/O)
  const mem = memoryCache.get(path);
  if (mem && (now - mem.ts) < CACHE_TTL_MS) {
    return mem.data;
  }

  // 2) تحقق من sessionStorage (تشمل بيانات محمّلة من صفحة ثانية فتحها
  //    نفس الموظف بنفس التبويب خلال المدة المسموحة)
  const stored = readSession("sharedCache:" + path);
  if (stored && (now - stored.ts) < CACHE_TTL_MS) {
    memoryCache.set(path, { ts: stored.ts, data: stored.data });
    return stored.data;
  }

  // 3) ما فيه نسخة حديثة — نجيبها فعلياً من فايربيس (هذا هو الطلب الفعلي الوحيد)
  const snap = await get(ref(db, path));
  const data = snap.exists() ? snap.val() : {};

  memoryCache.set(path, { ts: now, data });
  writeSession("sharedCache:" + path, data);

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

const { onValueWritten } = require("firebase-functions/v2/database");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

function normalizeStatus(s) {
  const raw = (s || "").trim();

  if (!raw) return "new"; // ✅ مهم جداً

  if (
    [
      "مثبت",
      "قيد المعالجة",
      "قيد التجهيز",
      "بانتظار البضاعة",
      "قيد التوصيل",
      "تم التسليم",
      "راجع",
      "تم استلام الراجع",
      "رفض"
    ].includes(raw)
  ) {
    return raw;
  }

  return "other"; // ✅ حالات أخرى
}

// 🔁 تحديث تلقائي عند تغيير الحالة
exports.updateOrderCounts = onValueWritten("/orders/{orderId}", async (event) => {
  const before = event.data.before.val();
  const after  = event.data.after.val();

  const db = admin.database();

  // ✅ حالة إضافة طلب جديد
  if (!before && after) {
    const newStatus = normalizeStatus(after.status);

    const snap = await db.ref("stats/ordersCounts/" + newStatus).get();
    const val = snap.exists() ? snap.val() : 0;

    return db.ref("stats/ordersCounts/" + newStatus).set(val + 1);
  }

  // ✅ حالة حذف طلب
  if (before && !after) {
    const oldStatus = normalizeStatus(before.status);

    const snap = await db.ref("stats/ordersCounts/" + oldStatus).get();
    const val = snap.exists() ? snap.val() : 0;

    return db.ref("stats/ordersCounts/" + oldStatus).set(Math.max(0, val - 1));
  }

  // ✅ حالة تحديث الحالة
  const oldStatus = normalizeStatus(before?.status);
  const newStatus = normalizeStatus(after?.status);

  if (oldStatus === newStatus) return;

  const updates = {};

  const oldSnap = await db.ref("stats/ordersCounts/" + oldStatus).get();
  const newSnap = await db.ref("stats/ordersCounts/" + newStatus).get();

  const oldVal = oldSnap.exists() ? oldSnap.val() : 0;
  const newVal = newSnap.exists() ? newSnap.val() : 0;

  updates["stats/ordersCounts/" + oldStatus] = Math.max(0, oldVal - 1);
  updates["stats/ordersCounts/" + newStatus] = newVal + 1;

  return db.ref().update(updates);
});

// 🔁 إعادة حساب كل الطلبات القديمة
exports.rebuildCounts = onRequest(async (req, res) => {
  const db = admin.database();

  const snap = await db.ref("orders").get();

  if (!snap.exists()) {
    return res.send("No orders found");
  }

  const data = snap.val();

  const counts = {};

  Object.values(data).forEach(o => {
    const status = normalizeStatus(o.status);
    counts[status] = (counts[status] || 0) + 1;
  });

  await db.ref("stats/ordersCounts").set(counts);

  res.send(counts);
});
// ════════════════════════════════════════════════════════
// 🔗 صفحة الهبوط بعنوان وصورة صحيحين عند المشاركة (فيسبوك/واتساب/تلي)
// ────────────────────────────────────────────────────────
// المشكلة: landing.html صفحة ثابتة تجيب بيانات المنتج بالجافاسكربت بعد ما
// تفتح. زاحف فيسبوك ما يشغّل جافاسكربت إطلاقاً — يقرأ الـHTML الخام بس،
// فكان يشوف عنوان الصفحة الثابت ("جاري التحميل...") ويعرضه بالمنشور.
//
// الحل: هذي الدالة تنخدم على المسار /l/<اسم-الصفحة> (عبر rewrite بملف
// firebase.json)، تجيب بيانات صفحة الهبوط من قاعدة البيانات، وتركّب
// وسوم العنوان والوصف والصورة داخل الـHTML *قبل* ما يوصل للزاحف. النتيجة:
// المنشور يطلع باسم المنتج وصورته وسعره، بنفس الدومين، بدون أي تغيير
// بطريقة عمل الصفحة للزبون (نفس الملف ونفس الكود يشتغل بعدها عادي).
//
// الروابط القديمة (landing.html?id=...) تبقى شغالة متل ما هي.
// ════════════════════════════════════════════════════════
const LANDING_ORIGINS = ["https://almurad.store", "https://almurad-system.web.app"];
let _landingTemplate = null;
let _landingTemplateAt = 0;

async function getLandingTemplate() {
  // نخزّن نسخة بالذاكرة 5 دقايق حتى ما نجيب الملف بكل طلب
  if (_landingTemplate && Date.now() - _landingTemplateAt < 5 * 60 * 1000) {
    return _landingTemplate;
  }
  let lastErr = null;
  for (const origin of LANDING_ORIGINS) {
    try {
      const r = await fetch(`${origin}/landing.html`, { redirect: "follow" });
      if (!r.ok) { lastErr = new Error(`${origin} → ${r.status}`); continue; }
      const html = await r.text();
      if (html && html.includes("</head>")) {
        _landingTemplate = html;
        _landingTemplateAt = Date.now();
        return html;
      }
      lastErr = new Error(`${origin} → محتوى غير متوقع`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("تعذر جلب قالب صفحة الهبوط");
}

const esc = v => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function buildLandingHead(slug, l, origin) {
  // العنوان: الحقل اليدوي أولاً (إذا الموظف كتبه عند النشر)، وإلا اسم
  // المنتج، وإلا عنوان الصفحة — وبأسوأ حال اسم المتجر. ما يطلع "جاري التحميل" أبداً.
  const title = l.shareTitle || l.productName || l.title || "متجر المراد";
  const priceTxt = Number(l.price) ? `${Number(l.price).toLocaleString("en-US")} د.ع` : "";
  const desc = l.shareDesc || l.tagline ||
    [priceTxt, "توصيل لجميع المحافظات • الدفع عند الاستلام"].filter(Boolean).join(" • ");

  let img = l.mainImage || `${origin}/almurad-logo.png`;
  if (img && !/^https?:\/\//i.test(img)) img = `${origin}/${String(img).replace(/^\/+/, "")}`;

  const url = `${origin}/l/${encodeURIComponent(slug)}`;

  return `<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="متجر المراد">
<meta property="og:locale" content="ar_AR">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="1200">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<script>window.__LANDING_ID=${JSON.stringify(slug)};</script>`;
}

exports.landing = onRequest({ region: "us-central1", cors: false }, async (req, res) => {
  try {
    // المسار يجي بشكل /l/<slug> — وندعم ?id= احتياطاً
    const raw = decodeURIComponent((req.path || "").replace(/^\/+l\/?/, "").replace(/\/+$/, ""));
    const slug = raw || String(req.query.id || "").trim();

    if (!slug) {
      res.set("Cache-Control", "public, max-age=60");
      return res.redirect(302, "/");
    }

    const snap = await admin.database().ref(`landingPages/${slug}`).get();
    const l = snap.exists() ? snap.val() : null;

    const origin = LANDING_ORIGINS[0];
    let html = await getLandingTemplate();

    if (!l || l.active === false) {
      // صفحة محذوفة أو موقوفة — نخلي العنوان محايد بدل ما يطلع "جاري التحميل"
      html = html.replace(/<title>[\s\S]*?<\/title>/i, "<title>متجر المراد</title>");
      res.set("Cache-Control", "public, max-age=60");
      return res.status(404).send(html);
    }

    // نشيل العنوان الثابت ونركّب وسوم المشاركة بداله
    html = html.replace(/<title>[\s\S]*?<\/title>/i, buildLandingHead(slug, l, origin));

    // الزاحف يخزّن النتيجة، والزبون يوصله ملف محدث خلال 5 دقايق من أي تعديل
    res.set("Cache-Control", "public, max-age=300, s-maxage=300");
    res.set("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (err) {
    console.error("❌ landing:", err.message);
    // ما نخلي الزبون يشوف صفحة خطأ — نرجعه للرابط القديم اللي شغال دائماً
    const slug = String(req.path || "").replace(/^\/+l\/?/, "");
    return res.redirect(302, `/landing.html?id=${encodeURIComponent(slug)}`);
  }
});

// ════════════════════════════════════════════════════════
// 🔢 عدّادات الطلبات — الإصلاح الأكبر لتكلفة قاعدة البيانات
// ────────────────────────────────────────────────────────
// ⚠️ المشكلة (2026-09-23): لوحة التحكم كانت تحسب عدد الطلبات بكل حالة
// هيچي: تجيب الفرع كامل ثم تعد مفاتيحه —
//     get(ref(db,"ordersTest/تم التسليم")) → Object.keys(...).length
// يعني كل فتحة للوحة تنزّل *كل طلبات الشركة* حتى تعرض عشر أرقام. وفوقها
// مراقب حي على كل حالة: أي طلب يتغير عند أي موظف، كل لوحة مفتوحة تعيد
// تنزيل ذاك الفرع كامل. مع 10 موظفين و~250 تغيير حالة باليوم، هذا وحده
// كان يطلّع عشرات الغيغات بالشهر — والتكلفة تكبر كل ما زادت الطلبات.
//
// الحل: نخلي السيرفر يمسك العدّاد. كل ما ينضاف أو ينحذف طلب من فرع
// حالة، نعدّل رقم بـstats/ordersCounts. اللوحة تقرا الأرقام مباشرة —
// نفس القيم بالضبط، بس بايتات بدل ميكابايتات، وتحديث أسرع.
//
// نمسك هم عدّاد الطلبات المسلّمة لكل موظف (stats/deliveredBy) — صفحة
// "مهامي" كانت تنزّل كل الطلبات المسلّمة حتى تعد طلبات موظف واحد.
// ════════════════════════════════════════════════════════
function bump(path, delta) {
  return admin.database().ref(path).transaction(v => Math.max(0, (Number(v) || 0) + delta));
}

// ⚠️ إصلاح حرج (2026-09-23): أسماء الفروع عربية، وفايربيس أحياناً
// يوصّل اسم الفرع بـevent.params مشوّه (UTF-8 مقروء كـlatin-1)، مثلاً
// "راجع" توصل "Ø±Ø§Ø¬Ø¹". النتيجة: عدّاد بمفتاح خربان، وسطر بفهرس
// البحث يشير لفرع ما موجود — فالطلب يختفي من نتائج البحث. نصلّح
// الاسم قبل أي استخدام، وما نلمسه إلا إذا فعلاً كان مشوّه ورجع عربي
// سليم بعد التصحيح.
function fixArabicKey(v) {
  const str = String(v == null ? "" : v);
  if (/[\u0600-\u06FF]/.test(str)) return str;          // عربي سليم — ما نلمسه
  // مُرمّز بـ%D8%B1...
  if (/%[0-9A-Fa-f]{2}/.test(str)) {
    try {
      const d = decodeURIComponent(str);
      if (/[\u0600-\u06FF]/.test(d)) return d;
    } catch (e) { /* نتجاهل */ }
  }
  // UTF-8 مقروء كـlatin-1 ("Ø±Ø§Ø¬Ø¹")
  if (/[\u0080-\u00FF]/.test(str)) {
    try {
      const d = Buffer.from(str, "latin1").toString("utf8");
      if (/[\u0600-\u06FF]/.test(d) && !d.includes("\uFFFD")) return d;
    } catch (e) { /* نتجاهل */ }
  }
  return str;                                           // مو عربي أصلاً
}

exports.syncOrderCounts = onValueWritten("/ordersTest/{status}/{orderId}", async (event) => {
  const status = fixArabicKey(event.params.status);
  const { orderId } = event.params;
  if (orderId === "_meta") return;

  const beforeVal = event.data.before.val();
  const afterVal  = event.data.after.val();
  const existedBefore = !!beforeVal;
  const existsAfter   = !!afterVal;

  // عدّاد الحالة: يتغير بس إذا الطلب انضاف للفرع أو انشال منه.
  // تعديل بيانات طلب موجود ما يأثر على العدد.
  if (existedBefore !== existsAfter) {
    await bump(`stats/ordersCounts/${status}`, existsAfter ? 1 : -1);
  }

  // عدّاد المسلّم لكل موظف — يهم فرع "تم التسليم" بس
  if (status === "تم التسليم") {
    const empOf = o => (o && (o.fixedBy || o.assignedTo || o.employee)) || "";
    const b = existedBefore ? empOf(beforeVal) : "";
    const a = existsAfter   ? empOf(afterVal)  : "";
    if (b !== a) {
      // اسم الموظف ممكن يجي بمحارف ما تنفع كمفتاح بفايربيس
      const key = n => String(n).replace(/[.#$\[\]\/]/g, "_");
      if (b) await bump(`stats/deliveredBy/${key(b)}`, -1);
      if (a) await bump(`stats/deliveredBy/${key(a)}`, 1);
    }
  }

  // ── فهرس البحث (orderIndex) ──
  // صفحة الطلبات كانت تنزّل كل فروع ordersTest (٥ ميكابايت) بكل عملية
  // بحث، حتى تدوّر على رقم طلب أو تلفون أو رقم وصل. هسه تنزّل هذا
  // الفهرس الخفيف (~٢٦٠ كيلوبايت) وتطابق محلياً، وبعدها تجيب الطلبات
  // المطابقة بس بمسارها المباشر. نفس النتيجة بالضبط ونفس شكل البحث.
  const idxRef = admin.database().ref(`orderIndex/${orderId}`);
  if (!existsAfter) {
    // الطلب انشال من هذا الفرع — ما نمسح الفهرس إلا إذا كان يشير لهنا،
    // لأن الشيل غالباً جزء من نقل لفرع ثاني (والفرع الجديد يكتب قبل/بعد)
    const cur = await idxRef.get();
    if (cur.exists() && cur.val() && cur.val().s === status) await idxRef.remove();
  } else {
    await idxRef.set(orderIndexEntry(afterVal, status));
  }
});

// سطر الفهرس: الحالة + التلفونات مطبّعة + رقم الوصل + ترتيب الدخول
// ⚠️ التطبيع لازم يطابق normalizeNum بـorders-cards.html حرف بحرف،
// حتى تطلع نتائج البحث نفسها تماماً (أرقام عربية → لاتينية، وحذف
// الفراغات والشرطات والشُرَط السفلية بس — أي شي ثاني يبقى مثل ما هو)
const normalizeNum = v => {
  if (v == null || v === "") return "";
  const ar = "٠١٢٣٤٥٦٧٨٩", en = "0123456789";
  return String(v)
    .split("").map(c => { const i = ar.indexOf(c); return i >= 0 ? en[i] : c; }).join("")
    .replace(/[\s\-_]/g, "");
};

function orderIndexEntry(o, status) {
  const e = { s: status };
  const p1 = normalizeNum(o && o.phone1);
  const p2 = normalizeNum(o && o.phone2);
  const p = [p1, p2].filter(Boolean).join("§");
  if (p) e.p = p;
  const r = normalizeNum(o && o.receiptNum);
  if (r) e.r = r;
  const en = Number(o && o.enterIndex);
  if (en) e.e = en;
  return e;
}

// ── إعادة بناء العدّادات من الصفر ──
// تنادى مرة وحدة بعد النشر (وأي وقت تشك بالأرقام). تمشي على الفروع
// حالة حالة بدل ما تجيب الشجرة كاملة بالذاكرة.
exports.rebuildOrderCounts = onRequest({ timeoutSeconds: 540, memory: "512MiB" }, async (req, res) => {
  const STATUSES = [
    "جديد", "مثبت", "قيد المعالجة", "قيد التجهيز", "بانتظار البضاعة",
    "قيد التوصيل", "تم التسليم", "راجع", "تم استلام الراجع", "رفض"
  ];
  try {
    const db = admin.database();
    const counts = {};
    const deliveredBy = {};

    // مرور واحد: العدّادات والفهرس من نفس القراءة، حتى ما يختلفون إذا
    // تحرك طلب أثناء إعادة البناء
    const index = {};
    for (const status of STATUSES) {
      const snap = await db.ref(`ordersTest/${status}`).get();
      const val = snap.exists() ? snap.val() : {};
      const ids = Object.keys(val).filter(k => k !== "_meta");
      counts[status] = ids.length;

      for (const id of ids) {
        const o = val[id];
        if (!o || typeof o !== "object") continue;
        index[id] = orderIndexEntry(o, status);

        if (status === "تم التسليم") {
          const emp = o.fixedBy || o.assignedTo || o.employee || "";
          if (!emp) continue;
          const key = String(emp).replace(/[.#$\[\]\/]/g, "_");
          deliveredBy[key] = (deliveredBy[key] || 0) + 1;
        }
      }
    }

    // set() يستبدل الفرع كامل، فأي مفتاح مشوّه قديم ينمسح لحاله
    await db.ref("stats/ordersCounts").set(counts);
    await db.ref("stats/deliveredBy").set(deliveredBy);
    await db.ref("stats/countsRebuiltAt").set(Date.now());

    await db.ref("orderIndex").set(index);

    res.json({
      ok: true,
      counts,
      employees: Object.keys(deliveredBy).length,
      indexed: Object.keys(index).length,
      indexKB: Math.round(JSON.stringify(index).length / 1024)
    });
  } catch (err) {
    console.error("❌ rebuildOrderCounts:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// 📦 ملخّصات دفعات الشحن (shippingLogSummaries)
// ────────────────────────────────────────────────────────
// ليش: صفحة سجلات الشحن تعرض كارت لكل دفعة فيه المزوّد والتاريخ ومن
// رفعها وعدد الناجح/الفاشل بس — لكنها كانت تنزّل shippingLogs كامل
// (٣.٥ ميكابايت) لأن كل دفعة تحمل معها تفاصيل كل طلباتها. التفاصيل
// أصلاً تنجاب مرة ثانية لما الموظف يفتح الدفعة، فكانت تنزّل مرتين.
// هسه القائمة تقرا هذا الفرع الخفيف (~١٧٠ كيلوبايت).
//
// الكتابة الجارية تصير من الواجهة وقت رفع الدفعة (send-shipping.html)
// ووقت تسجيل الطباعة (shipping-logs.html). هذي الدالة للترحيل مرة
// وحدة للدفعات القديمة — تنطلب بالمتصفح وتخلص.
// ════════════════════════════════════════════════════════
exports.rebuildLogSummaries = onRequest({ timeoutSeconds: 540, memory: "512MiB" }, async (req, res) => {
  try {
    const db = admin.database();
    const snap = await db.ref("shippingLogs").get();
    if (!snap.exists()) return res.json({ ok: true, logs: 0, note: "ماكو سجلات" });

    const logs = snap.val();
    const out = {};
    for (const [logId, log] of Object.entries(logs)) {
      if (!log || typeof log !== "object") continue;
      const sum = {
        provider: log.provider || "",
        createdAt: log.createdAt || Number(logId) || 0,
        total: Number(log.total || 0),
        successCount: Number(log.successCount || 0),
        failCount: Number(log.failCount || 0),
        uploadedBy: log.uploadedBy || ""
      };
      if (log.printedBy) sum.printedBy = log.printedBy;
      if (log.printedAt) sum.printedAt = log.printedAt;
      out[logId] = sum;
    }

    await db.ref("shippingLogSummaries").set(out);
    const bytes = JSON.stringify(out).length;
    res.json({ ok: true, logs: Object.keys(out).length, summaryKB: Math.round(bytes / 1024) });
  } catch (err) {
    console.error("❌ rebuildLogSummaries:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// 🏬 نسخة المتجر الخفيفة (storeCatalog) + فهرس أسماء المخزن (warehouseIndex)
// ────────────────────────────────────────────────────────
// المشكلة: كل زبون يفتح المتجر كان ينزّل فرع warehouse كامل — ١٨٨٠
// منتج و٥١٦ كيلوبايت — مع إن المتجر يعرض ١٧١ منتج ظاهر بس، ويحتاج
// منهن الاسم والسعر والصور والكمية لا غير. يعني ٨٠٪ من التنزيل ضايع،
// وفوقها سعر الشراء (buyPrice) كان ينوصل للزبون بالمتصفح.
//
// وبنفس الوقت: دفتر المخزن وصفحة إضافة الطلب كانوا ينزّلون warehouse
// كامل بس حتى يلقون "وين المنتج الفلاني" لما الاسم ما يطابق المفتاح —
// وهذا يصير بكل تثبيت طلب. الفهرس يخلّي هذي العملية قراءة سطر واحد.
//
// الفرعين ينبنون تلقائياً من هنا بكل تعديل يصير على أي منتج، فما يحتاج
// أي صفحة تتذكر تحدّثهن، وما يصير اختلاف بينهن وبين المخزن أبداً.
// ════════════════════════════════════════════════════════
const cleanProductName = n => String(n || "").trim().replace(/\s+/g, " ");
const safeKey = k => String(k || "").replace(/[.#$\[\]\/]/g, "_");

// الحقول اللي يحتاجها المتجر بس — أي شي غيرها (سعر الشراء، الباركودات،
// تواريخ الإنشاء، علامات الطلبات) ما ينوصل للزبون إطلاقاً
function toCatalogEntry(p) {
  if (!p || p.visible !== true) return null;
  const e = {
    name: p.name || "",
    visible: true,
    totalQty: p.stock
      ? Object.values(p.stock).reduce((a, b) => a + (Number(b) || 0), 0)
      : Number(p.totalQty || 0)
  };
  if (p.prices)     e.prices     = p.prices;
  if (p.price != null) e.price   = p.price;
  if (p.images)     e.images     = p.images;
  if (p.thumbs)     e.thumbs     = p.thumbs;
  if (p.category)   e.category   = p.category;
  if (p.desc)       e.desc       = p.desc;
  if (p.stock)      e.stock      = p.stock;
  if (p.lastUpdate) e.lastUpdate = p.lastUpdate;
  return e;
}

exports.syncStoreCatalog = onValueWritten("/warehouse/{pkey}", async (event) => {
  const pkey = fixArabicKey(event.params.pkey); // نفس مشكلة ترميز المفاتيح العربية
  const db = admin.database();
  const before = event.data.before.val();
  const after = event.data.after.val();

  // 1) نسخة المتجر
  const entry = toCatalogEntry(after);
  await db.ref(`storeCatalog/${safeKey(pkey)}`).set(entry); // null = ينشال

  // 2) فهرس الأسماء (الاسم المنظّف → مفتاح المنتج بالمخزن)
  const oldName = cleanProductName(before && before.name);
  const newName = cleanProductName(after && after.name);
  if (oldName && oldName !== newName) {
    await db.ref(`warehouseIndex/${safeKey(oldName)}`).remove();
  }
  if (newName) {
    await db.ref(`warehouseIndex/${safeKey(newName)}`).set(pkey);
  }
  // اسم المفتاح نفسه بعد ينفع للبحث (المخزن تاريخياً يخزّن بصيغ مختلفة)
  const fromKey = cleanProductName(String(pkey).replace(/_/g, " "));
  if (after && fromKey && fromKey !== newName) {
    await db.ref(`warehouseIndex/${safeKey(fromKey)}`).set(pkey);
  }
});

// ── بناء الفرعين من الصفر (تنطلب مرة وحدة بعد النشر) ──
exports.rebuildStoreCatalog = onRequest({ timeoutSeconds: 540, memory: "512MiB" }, async (req, res) => {
  try {
    const db = admin.database();
    const snap = await db.ref("warehouse").get();
    if (!snap.exists()) return res.json({ ok: true, products: 0 });

    const wh = snap.val();
    const catalog = {};
    const index = {};
    for (const [pkey, p] of Object.entries(wh)) {
      const entry = toCatalogEntry(p);
      if (entry) catalog[safeKey(pkey)] = entry;

      const name = cleanProductName(p && p.name);
      if (name) index[safeKey(name)] = pkey;
      const fromKey = cleanProductName(String(pkey).replace(/_/g, " "));
      if (fromKey && fromKey !== name) index[safeKey(fromKey)] = pkey;
    }

    await db.ref("storeCatalog").set(catalog);
    await db.ref("warehouseIndex").set(index);

    res.json({
      ok: true,
      products: Object.keys(wh).length,
      visible: Object.keys(catalog).length,
      catalogKB: Math.round(JSON.stringify(catalog).length / 1024),
      indexKB: Math.round(JSON.stringify(index).length / 1024)
    });
  } catch (err) {
    console.error("❌ rebuildStoreCatalog:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


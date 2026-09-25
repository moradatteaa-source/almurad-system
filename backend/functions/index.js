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

// ── مين يستحق الطلب ──
// ⚠️ لازم تطابق docs/orderCredit.js حرف بحرف بالترتيب، وإلا أرقام
// الرواتب (stats/deliveredBy) تختلف عن أرقام صفحات الإحصائيات لنفس
// الطلب. fixedBy أولاً: أول من ثبّت الطلب وما يتغير بعدين.
const AUTOMATED_ACTORS = [
  "google-sheets", "system", "waseet-api", "Prime",
  "system-prime", "system-waseet", "fix-script",
  "admin", "admin-store", "landing-page", "website", "store"
];

function historyBy(order, status) {
  const h = (order && order.statusHistory) || {};
  let e;
  try { e = h[encodeURIComponent(status)]; } catch (x) { e = undefined; }
  if (!e) e = h[status];
  return (e && e.by) || "";
}

function orderConfirmer(o) {
  const order = o || {};
  const candidates = [
    order.fixedBy,
    historyBy(order, "مثبت"),
    historyBy(order, "بانتظار البضاعة"),
    order.rejectedBy,
    historyBy(order, order.status),
    order.employeeName,
    order.assignedTo,
    order.employee,
    order.updatedBy
  ];
  for (const c of candidates) {
    const n = String(c || "").trim();
    if (n && !AUTOMATED_ACTORS.includes(n)) return n;
  }
  return "";
}

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
    const empOf = orderConfirmer;
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
          const emp = orderConfirmer(o);
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


// ════════════════════════════════════════════════════════
// 🗜️ ضغط صور المنتجات بالسيرفر
// ────────────────────────────────────────────────────────
// المشكلة المقاسة (2026-09-24): كل صور المتجر انرفعت بحجمها الأصلي
// متل ما جت من التلفون/تيليكرام — PNG بمتوسط ٢.٤ ميكابايت للصورة
// الوحدة، و١٧١ صورة يعني ٤٠٠ ميكابايت. المتجر يعرض ٨ منتجات بأول
// شاشة، فالزبون ينزّل ١٨.٧ ميكابايت قبل ما يشوف أي شي. على بيانات
// الموبايل هذا بطء قاتل — وهذا سبب "الصور تتأخر يلا تطلع".
//
// أداة الضغط بالمتصفح (imageTools.js) موجودة للرفع الجديد، بس الصور
// القديمة انرفعت قبلها. هذي الدالة تضغطهن كلهن بالسيرفر — أسرع بكثير
// وما تحتاج المتصفح يضل مفتوح.
//
// تنتج نسختين WebP لكل صورة:
//   thumb — ٥٠٠ بكسل، لكروت القائمة  (~٢٥ كيلوبايت)
//   full  — ١٤٠٠ بكسل، لصفحة المنتج  (~١٢٠ كيلوبايت)
// الأصل يضل بمكانه بالتخزين (ما ننحذف شي) — بس ما نعود نشير له.
//
// الاستخدام: تنفتح بالمتصفح وتشتغل على دفعة، وترجّع كم باقي. تنعاد
// لحد ما يصير remaining = 0. تتخطى أي منتج مضغوط من قبل، فإعادة
// تشغيلها آمنة تماماً.
// ════════════════════════════════════════════════════════
const sharp = require("sharp");
const crypto = require("crypto");

const THUMB_SIDE = 500, FULL_SIDE = 1400;
const THUMB_Q = 75, FULL_Q = 82;

// نفكّك رابط فايربيس ستوريج لاسم الباكت ومسار الملف
function parseStorageUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("firebasestorage.googleapis.com")) return null;
    const m = u.pathname.match(/\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (!m) return null;
    return { bucket: m[1], path: decodeURIComponent(m[2]) };
  } catch (e) { return null; }
}

async function uploadWebp(bucketName, objPath, buffer) {
  const bucket = admin.storage().bucket(bucketName);
  const file = bucket.file(objPath);
  const token = crypto.randomUUID();
  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
      metadata: { firebaseStorageDownloadTokens: token }
    }
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objPath)}?alt=media&token=${token}`;
}

exports.compressProductImages = onRequest(
  { timeoutSeconds: 540, memory: "2GiB" },
  async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 60);
    const force = req.query.force === "1";
    const db = admin.database();

    try {
      const snap = await db.ref("warehouse").get();
      if (!snap.exists()) return res.json({ ok: true, note: "المخزن فاضي" });
      const wh = snap.val();

      // المنتجات الظاهرة بالمتجر اللي عندها صور وما عندها مصغّرة بعد
      const pending = Object.keys(wh).filter(k => {
        const p = wh[k];
        if (!p || p.visible !== true) return false;
        if (!Array.isArray(p.images) || !p.images.length) return false;
        if (!force && Array.isArray(p.thumbs) && p.thumbs.length) return false;
        return true;
      });

      const batch = pending.slice(0, limit);
      const done = [];
      const failed = [];
      let bytesBefore = 0, bytesAfter = 0;

      for (const key of batch) {
        const p = wh[key];
        const newImages = [], newThumbs = [];
        try {
          for (const url of p.images) {
            const info = parseStorageUrl(url);
            if (!info) { newImages.push(url); continue; }  // رابط خارجي — نتركه

            const bucket = admin.storage().bucket(info.bucket);
            const [buf] = await bucket.file(info.path).download();
            bytesBefore += buf.length;

            const base = info.path.replace(/\.[^./]+$/, "");
            const [thumbBuf, fullBuf] = await Promise.all([
              sharp(buf).rotate().resize({ width: THUMB_SIDE, height: THUMB_SIDE,
                fit: "inside", withoutEnlargement: true })
                .flatten({ background: "#ffffff" }).webp({ quality: THUMB_Q }).toBuffer(),
              sharp(buf).rotate().resize({ width: FULL_SIDE, height: FULL_SIDE,
                fit: "inside", withoutEnlargement: true })
                .flatten({ background: "#ffffff" }).webp({ quality: FULL_Q }).toBuffer()
            ]);
            bytesAfter += thumbBuf.length + fullBuf.length;

            const [thumbUrl, fullUrl] = await Promise.all([
              uploadWebp(info.bucket, `${base}_thumb.webp`, thumbBuf),
              uploadWebp(info.bucket, `${base}_full.webp`, fullBuf)
            ]);
            newThumbs.push(thumbUrl);
            newImages.push(fullUrl);
          }

          if (newImages.length) {
            await db.ref(`warehouse/${key}`).update({ images: newImages, thumbs: newThumbs });
            done.push(key);
          }
        } catch (e) {
          console.error("ضغط فشل:", key, e.message);
          failed.push({ key, error: e.message });
        }
      }

      res.json({
        ok: true,
        عولجت: done.length,
        فشلت: failed.length,
        باقي: Math.max(0, pending.length - batch.length),
        الحجم_قبل_ميكا: +(bytesBefore / 1048576).toFixed(1),
        الحجم_بعد_ميكا: +(bytesAfter / 1048576).toFixed(2),
        التوفير: bytesBefore ? Math.round((1 - bytesAfter / bytesBefore) * 100) + "%" : "-",
        أخطاء: failed.slice(0, 5)
      });
    } catch (err) {
      console.error("❌ compressProductImages:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ════════════════════════════════════════════════════════
// 🔁 استرداد نسبة الطلبات اللي ضاع صاحبها
// ────────────────────────────────────────────────────────
// خلفية: قبل إصلاح 2026-09-25، سجل الحالات كان ينكتب فوقه بكل نقل،
// فالطلب اللي يرجع لحالة سبق ومرّ بيها يضيع اسم الموظف الأصلي. النتيجة
// ٨٢٢ طلب ما بقى بيها أي اسم موظف — تطلع "غير محدد" بالتقارير.
//
// بس الطلب يحمل حقل `code` (رمز إدخال الطلب)، والفحص على البيانات
// الحية بيّن إنه يطابق الموظف بنسبة ٩٨-١٠٠٪:
//     Nag→نجوى · Fa→Fatma · no→Noor · na→naba · ah→Aya · Fl→Flow · Ze→Zina
//
// فنقدر نسترد منهن ٢٢٦ طلب — منها ١٥٥ من أصل ١٥٦ "تم التسليم".
//
// الخريطة تنبني من بياناتك نفسها كل مرة (مو مكتوبة بالكود)، بشرطين:
//   • الرمز مستعمل ٥ مرات على الأقل بطلبات نعرف صاحبها
//   • ٩٥٪ منهن على الأقل لنفس الموظف
// فأي رمز ملخبط أو مشترك بين موظفين ما ينعتمد.
//
// ⚠️ الوضع الافتراضي معاينة فقط. للتنفيذ الفعلي لازم ?apply=1
// كل طلب يتصلّح ينتّاشر عليه fixedBySource:"code" حتى يبقى واضح إنه
// مسترد مو أصلي، وينقدر يتراجع عنه.
// ════════════════════════════════════════════════════════
exports.recoverOrderCredit = onRequest({ timeoutSeconds: 540, memory: "1GiB" }, async (req, res) => {
  const apply = req.query.apply === "1";
  const MIN_SAMPLES = 5;
  const MIN_CONFIDENCE = 0.95;
  const STATUSES = [
    "جديد", "مثبت", "قيد المعالجة", "قيد التجهيز", "بانتظار البضاعة",
    "قيد التوصيل", "تم التسليم", "راجع", "تم استلام الراجع", "رفض"
  ];
  // نشيل علامات الاتجاه المخفية والفراغات — نفس الرمز ينكتب بصيغ مختلفة
  const normCode = c => String(c == null ? "" : c).replace(/[‎‏\s]/g, "").toLowerCase();

  try {
    const db = admin.database();
    const all = [];
    for (const status of STATUSES) {
      const snap = await db.ref(`ordersTest/${status}`).get();
      const val = snap.exists() ? snap.val() : {};
      for (const [id, o] of Object.entries(val)) {
        if (id === "_meta" || !o || typeof o !== "object") continue;
        all.push({ id, status, order: o });
      }
    }

    // ١) نبني الخريطة من الطلبات اللي نعرف صاحبها
    const tally = {};
    for (const { order } of all) {
      const emp = orderConfirmer(order);
      if (!emp) continue;
      const c = normCode(order.code);
      if (!c) continue;
      tally[c] = tally[c] || {};
      tally[c][emp] = (tally[c][emp] || 0) + 1;
    }
    const codeMap = {};
    const rejectedCodes = [];
    for (const [c, counts] of Object.entries(tally)) {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (total >= MIN_SAMPLES && n / total >= MIN_CONFIDENCE) {
        codeMap[c] = { employee: top, confidence: +(n / total).toFixed(3), samples: total };
      } else {
        rejectedCodes.push({ code: c, samples: total, reason: total < MIN_SAMPLES ? "عينة قليلة" : "مشترك بين موظفين" });
      }
    }

    // ٢) نصلّح الطلبات المجهولة
    const updates = {};
    const perEmployee = {};
    const perStatus = {};
    let recovered = 0, stillUnknown = 0;

    for (const { id, status, order } of all) {
      if (orderConfirmer(order)) continue;          // معروف صاحبها — ما نلمسها
      const hit = codeMap[normCode(order.code)];
      if (!hit) { stillUnknown++; continue; }

      recovered++;
      perEmployee[hit.employee] = (perEmployee[hit.employee] || 0) + 1;
      perStatus[status] = (perStatus[status] || 0) + 1;

      if (apply) {
        updates[`ordersTest/${status}/${id}/fixedBy`] = hit.employee;
        updates[`ordersTest/${status}/${id}/fixedBySource`] = "code";
        updates[`ordersTest/${status}/${id}/fixedByRecoveredAt`] = Date.now();
      }
    }

    if (apply && Object.keys(updates).length) {
      // على دفعات حتى ما تنفجر عملية وحدة كبيرة
      const keys = Object.keys(updates);
      for (let i = 0; i < keys.length; i += 600) {
        const chunk = {};
        for (const k of keys.slice(i, i + 600)) chunk[k] = updates[k];
        await db.ref().update(chunk);
      }
      await db.ref("stats/creditRecoveredAt").set(Date.now());
    }

    res.json({
      ok: true,
      الوضع: apply ? "تم التنفيذ ✅" : "معاينة فقط — ضيف ?apply=1 للتنفيذ",
      مجموع_الطلبات: all.length,
      مستردة: recovered,
      تبقى_مجهولة: stillUnknown,
      حسب_الموظف: perEmployee,
      حسب_الحالة: perStatus,
      الرموز_المعتمدة: codeMap,
      رموز_مرفوضة: rejectedCodes.slice(0, 10),
      ملاحظة: apply
        ? "شغّل rebuildOrderCounts بعدها حتى تتحدث عدّادات الرواتب"
        : "ماكو أي تعديل انكتب"
    });
  } catch (err) {
    console.error("❌ recoverOrderCredit:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// 📡 تصحيح مصدر الطلبات (صفحة الهبوط / الموقع الإلكتروني)
// ────────────────────────────────────────────────────────
// الفحص على البيانات الحية: ٢٨٥ طلب انكتبوا من صفحة الهبوط فعلاً
// (سجل الحالة "جديد" مكتوب باسم landing-page)، بس ٤٧ منهن بس
// مصدرهن مكتوب "صفحة هبوط". الباقي (٢٣٨) مكتوب عليهن اتصال أو
// واتساب أو فيسبوك — غالباً لأن الموظف فتح الطلب وضغط زر مصدر
// (وما كان أكو زر يمثّل صفحة الهبوط أصلاً، فما كان يشوف أي زر
// محدّد). النتيجة: ما تكدر تعرف شنو تجيب صفحات الهبوط فعلاً.
//
// منو ننشئ الطلب هو المصدر الموثوق — مكتوب وقت الإنشاء وما يتغير:
//   landing-page          → صفحة هبوط
//   website / store       → الموقع الإلكتروني
//
// ⚠️ معاينة فقط افتراضياً. التنفيذ يحتاج ?apply=1
// القيمة القديمة تنحفظ بـsourcePrev، فما ينضيع شي ونقدر نتراجع.
// ════════════════════════════════════════════════════════
const CREATOR_SOURCE = {
  "landing-page": "صفحة هبوط",
  "website": "الموقع الإلكتروني",
  "store": "الموقع الإلكتروني",
  "admin-store": "الموقع الإلكتروني"
};

exports.fixOrderSources = onRequest({ timeoutSeconds: 540, memory: "1GiB" }, async (req, res) => {
  const apply = req.query.apply === "1";
  const STATUSES = [
    "جديد", "مثبت", "قيد المعالجة", "قيد التجهيز", "بانتظار البضاعة",
    "قيد التوصيل", "تم التسليم", "راجع", "تم استلام الراجع", "رفض"
  ];

  try {
    const db = admin.database();
    const updates = {};
    const changes = {};     // "من → إلى": عدد
    let checked = 0, alreadyOk = 0, fixed = 0;
    const samples = [];

    for (const status of STATUSES) {
      const snap = await db.ref(`ordersTest/${status}`).get();
      const val = snap.exists() ? snap.val() : {};
      for (const [id, o] of Object.entries(val)) {
        if (id === "_meta" || !o || typeof o !== "object") continue;

        const creator = historyBy(o, "جديد") || o.createdBy || "";
        const trueSource = CREATOR_SOURCE[String(creator).trim()];
        if (!trueSource) continue;          // مو من الموقع ولا الهبوط

        checked++;
        const current = String(o.source || "").trim();
        if (current === trueSource) { alreadyOk++; continue; }

        fixed++;
        const key = `${current || "(فاضي)"} → ${trueSource}`;
        changes[key] = (changes[key] || 0) + 1;
        if (samples.length < 8) samples.push({ id, status, من: current || "(فاضي)", إلى: trueSource });

        if (apply) {
          updates[`ordersTest/${status}/${id}/source`] = trueSource;
          if (current) updates[`ordersTest/${status}/${id}/sourcePrev`] = current;
          updates[`ordersTest/${status}/${id}/sourceFixedAt`] = Date.now();
        }
      }
    }

    if (apply && Object.keys(updates).length) {
      const keys = Object.keys(updates);
      for (let i = 0; i < keys.length; i += 600) {
        const chunk = {};
        for (const k of keys.slice(i, i + 600)) chunk[k] = updates[k];
        await db.ref().update(chunk);
      }
      await db.ref("stats/sourcesFixedAt").set(Date.now());
    }

    res.json({
      ok: true,
      الوضع: apply ? "تم التنفيذ ✅" : "معاينة فقط — ضيف ?apply=1 للتنفيذ",
      طلبات_من_الموقع_والهبوط: checked,
      مصدرها_صحيح_أصلاً: alreadyOk,
      انتصلّحت: fixed,
      التفاصيل: changes,
      عينة: samples,
      ملاحظة: apply
        ? "القيمة القديمة محفوظة بـsourcePrev لكل طلب انتصلّح"
        : "ماكو أي تعديل انكتب"
    });
  } catch (err) {
    console.error("❌ fixOrderSources:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

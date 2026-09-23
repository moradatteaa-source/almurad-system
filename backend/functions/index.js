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

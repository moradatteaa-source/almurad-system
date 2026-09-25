// ════════════════════════════════════════════════════════
// 👤 نسب الطلب للموظف — المصدر الوحيد بكل النظام
// ────────────────────────────────────────────────────────
// ⚠️ ليش انبنى (2026-09-25): "ثبت بواسطة" كان يتغير من موظف لموظف.
// الفحص على البيانات الحية لقى:
//   • ١٬٠٢٦ طلب (٢٣٪ من كل الطلبات) محسوبة لحساب "admin" بصفحة
//     الإحصائيات — ثالث أكبر "موظف" بتقاريرك كان الأدمن نفسه
//   • ٢٤٦ طلب فيها fixedBy يخالف اللي مسجّل بسجل الحالات
//
// السببين:
//
// ١) سجل الحالات مفتاحه اسم الحالة نفسها:
//        statusHistory["مثبت"] = { by: فلان }
//    فأي رجعة لنفس الحالة تمسح اللي قبلها. طلب ثبته موظف ← راح
//    "بانتظار البضاعة" ← الأدمن ينقله جماعياً للمثبت = اسم الموظف
//    الأصلي انمسح للأبد وما بقى أثر يرجّعه.
//
// ٢) صفحات الإحصائيات تقرا سجل الحالات *قبل* fixedBy. فحتى لما
//    fixedBy محفوظ صح، التقرير ياخذ من السجل الممسوح.
//
// الحل هنا:
//   • fixedBy أولاً دائماً — هو الحقل الوحيد المقصود إنه ما يتغير
//   • سجل الحالات: أول من يدخل الحالة يبقى مسجّل، ما ينكتب فوقه.
//     مين نقل الطلب آخر مرة محفوظ بـlastStatusBy (مو بالسجل).
//
// الاستخدام: <script src="orderCredit.js"></script> قبل سكربت الصفحة.
// ════════════════════════════════════════════════════════
(function (global) {

  // حسابات مو موظفين — ما تستحق نسبة ولا تظهر بتقارير الأداء
  const AUTOMATED_ACTORS = [
    "google-sheets", "system", "waseet-api", "Prime",
    "system-prime", "system-waseet", "fix-script",
    "admin", "admin-store", "landing-page", "website", "store"
  ];

  const isAutomated = n => AUTOMATED_ACTORS.includes(String(n || "").trim());

  // نقرا من السجل بالصيغتين — بعض الصفحات كتبت المفتاح مُرمّز
  // (encodeURIComponent) وبعضها خام
  function historyBy(order, status) {
    const h = (order && order.statusHistory) || {};
    let e;
    try { e = h[encodeURIComponent(status)]; } catch (x) { e = undefined; }
    if (!e) e = h[status];
    return (e && e.by) || "";
  }

  function historyTime(order, status) {
    const h = (order && order.statusHistory) || {};
    let e;
    try { e = h[encodeURIComponent(status)]; } catch (x) { e = undefined; }
    if (!e) e = h[status];
    return (e && e.time) || null;
  }

  // ── مين يستحق الطلب ──
  // fixedBy أولاً: هو أول من ثبّت الطلب، وما المفروض يتغير أبداً.
  // باقي المرشحين احتياط للطلبات القديمة اللي ماكو عندها fixedBy.
  function getOrderConfirmer(order, opts) {
    const o = order || {};
    const allowAutomated = !!(opts && opts.allowAutomated);
    const fallback = (opts && opts.fallback) !== undefined ? opts.fallback : "";

    const candidates = [
      o.fixedBy,                       // ← المصدر المقصود
      historyBy(o, "مثبت"),            // احتياط: أول تثبيت بالسجل
      historyBy(o, "بانتظار البضاعة"),
      o.rejectedBy,
      historyBy(o, o.status),
      o.employeeName,
      o.assignedTo,
      o.employee,
      o.updatedBy
    ];

    for (const c of candidates) {
      const n = String(c || "").trim();
      if (!n) continue;
      if (!allowAutomated && isAutomated(n)) continue;
      return n;
    }
    return fallback;
  }

  // ── كتابة سجل الحالات بدون مسح ──
  // يرجّع سجل جديد: كل الموجود متل ما هو، ونضيف الحالة الجديدة فقط
  // إذا ما كانت مسجّلة من قبل.
  function appendStatusHistory(existing, status, by, timeISO) {
    const out = Object.assign({}, existing || {});
    let key;
    try { key = encodeURIComponent(status); } catch (e) { key = String(status); }

    // موجود بأي من الصيغتين؟ نتركه — أول من دخل الحالة يبقى صاحبها
    if (out[key] || out[status]) return out;

    out[key] = { time: timeISO || new Date().toISOString(), by: by || "" };
    return out;
  }

  // ── الحقول اللي تنكتب مع أي تغيير حالة ──
  // نقطة وحدة تضمن إن كل المسارات (نقل جماعي، فردي، لوحة المتجر)
  // تتصرف نفس التصرف بالضبط.
  function buildStatusChangeFields(order, newStatus, userName, timeISO) {
    const o = order || {};
    const now = timeISO || new Date().toISOString();
    const fields = {
      status: newStatus,
      statusHistory: appendStatusHistory(o.statusHistory, newStatus, userName, now),
      updatedAt: now,
      updatedBy: userName,
      // مين نقل الطلب آخر مرة — هذا يتغير، بعكس السجل
      lastStatusBy: userName,
      lastStatusAt: now
    };

    // fixedBy: أول من يوصل الطلب لحالة "مثبت" أو "بانتظار البضاعة"،
    // ويبقى للأبد. الشرط !o.fixedBy هو اللي يمنع أي نقل لاحق (حتى من
    // الأدمن) من سرقة النسبة.
    if (!o.fixedBy && ["مثبت", "بانتظار البضاعة"].includes(newStatus)) {
      fields.fixedBy = userName;
    }
    if (!o.rejectedBy && newStatus === "رفض") {
      fields.rejectedBy = userName;
    }
    return fields;
  }

  global.OrderCredit = {
    AUTOMATED_ACTORS,
    isAutomated,
    historyBy,
    historyTime,
    getOrderConfirmer,
    appendStatusHistory,
    buildStatusChangeFields
  };
  // اختصارات للاستخدام المباشر بالصفحات
  global.getOrderConfirmer = getOrderConfirmer;
  global.appendStatusHistory = appendStatusHistory;
})(typeof window !== "undefined" ? window : globalThis);

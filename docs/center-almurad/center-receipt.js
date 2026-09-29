/* ════════════════════════════════════════════════════════════
   🧾 طباعة الفاتورة — center-receipt.js
   ────────────────────────────────────────────────────────────
   هذا نسخة طبق الأصل من فاتورة الكاشير — نفس الترتيب ونفس
   القياسات ونفس الخط. الهدف أن الفاتورة المطبوعة من صفحة
   الحسابات ما تنفرق ولا شعرة عن المطبوعة من الكاشير.

   ⛔ ما ينضاف ولا ينشال أي حقل هنا. إذا تغيّر شي بفاتورة
   الكاشير لازم يتغيّر هنا بنفس الوقت.

   الشي الوحيد الي انتغيّر عن الكود القديم هو طريقة إخفاء بقية
   الصفحة وقت الطباعة:
     • كان: visibility:hidden — يخفي الشكل بس يبقي المساحة
       محجوزة، فصفحة الحسابات (جدول ٥٠٠ فاتورة) كانت تطبع
       صفحات فاضية والإيصال بأول وحدة بس
     • صار: display:none — المساحة تنطوي كلها
   وكذلك box-sizing حتى يطلع العرض ٧٢ ملم بالضبط (كان يطلع
   ٧٦٫٢ لأن الحشوة تنضاف فوق العرض).
   ════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.CenterReceipt) return;

  var SHOP = { name: "سنتر المراد", phone: "07865393559" };
  var WIDTH = "72mm";

  var f = function (n) {
    return Number(n || 0).toLocaleString("en-US") + " د.ع";
  };
  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };

  /* خط الكاشير — نحمّله بأنفسنا حتى الفاتورة تطلع بنفس الخط
     من أي صفحة، حتى لو الصفحة نفسها تستعمل خط ثاني */
  function ensureFont() {
    if (document.getElementById("crcpt-font")) return;
    var l = document.createElement("link");
    l.id = "crcpt-font";
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Tajawal:wght@300;400;500;700;800&display=swap";
    (document.head || document.documentElement).appendChild(l);
  }

  function ensureStyle() {
    if (document.getElementById("crcpt-style")) return;
    var st = document.createElement("style");
    st.id = "crcpt-style";
    st.textContent = [
      "#crcpt{display:none}",
      "@page{size:" + WIDTH + " auto;margin:0}",
      "@media print{",
      "  html,body{",
      "    width:" + WIDTH + " !important;margin:0 !important;padding:0 !important;",
      "    background:#fff !important;height:auto !important;",
      "  }",
      "  body > *:not(#crcpt){display:none !important}",
      "  #crcpt,#crcpt *{box-sizing:border-box !important;visibility:visible !important}",
      "  #crcpt{",
      "    display:block !important;position:static !important;",
      "    width:" + WIDTH + ";max-width:" + WIDTH + ";margin:0;",
      "    font-family:Tajawal,Tahoma,sans-serif;",
      "    -webkit-print-color-adjust:exact;print-color-adjust:exact;",
      "  }",
      "}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(st);
  }

  function box() {
    var el = document.getElementById("crcpt");
    if (!el) {
      el = document.createElement("div");
      el.id = "crcpt";
      document.body.appendChild(el);
    }
    return el;
  }

  /* ــــ القالب ــــ حرفياً مثل فاتورة الكاشير ــــ */
  function build(d) {
    d = d || {};
    var items = Array.isArray(d.items) ? d.items : [];

    var rows = items.map(function (it) {
      return '<div style="display:flex;justify-content:space-between;font-size:12px;margin:3px 0;">' +
        "<span>" + esc(it.name != null ? it.name : it.product) + "</span>" +
        "<span>×" + Math.abs(Number(it.qty) || 0) + "</span>" +
        "<span>" + f(Math.abs(Number(it.total) || 0)) + "</span>" +
        "</div>";
    }).join("");

    if (Number(d.discount) > 0) {
      rows += '<div style="display:flex;justify-content:space-between;font-size:12px;margin:3px 0;color:#888;">' +
        "<span>الخصم</span><span>- " + f(d.discount) + "</span></div>";
    }

    return '<div style="padding:6px 10px; direction:rtl; font-family:Tajawal,Tahoma,sans-serif;">' +
      '<div style="text-align:center;font-size:16px;font-weight:bold;margin-bottom:4px">' +
        esc(SHOP.name) + "</div>" +
      '<div style="text-align:center;font-size:12px;color:#555;margin-bottom:6px">📞 ' +
        esc(SHOP.phone) + "</div>" +
      '<hr style="border-color:#ddd;margin:6px 0">' +
      '<div style="font-size:11px; line-height:1.7">' +
        "<div>👤 الكاشير: <span>" + esc(d.cashier) + "</span></div>" +
        "<div>📅 التاريخ: <span>" + esc(d.date) + "</span></div>" +
        "<div>🧾 رقم الفاتورة: <span>" + esc(d.invoiceNo) + "</span></div>" +
      "</div>" +
      '<hr style="border-color:#ddd;margin:6px 0">' +
      "<div>" + rows + "</div>" +
      '<hr style="border-color:#ddd;margin:6px 0">' +
      '<div style="display:flex;justify-content:space-between;font-weight:bold;font-size:14px">' +
        "<span>المجموع</span><span>" + f(d.total) + "</span></div>" +
      '<div style="text-align:center;margin-top:10px;font-size:12px;color:#777">شكراً لتسوقكم 🌸</div>' +
      "</div>";
  }

  window.CenterReceipt = {
    /* يرجّع HTML الفاتورة بدون طباعة — للمعاينة أو الاختبار */
    html: function (d) { return build(d); },

    print: function (d) {
      ensureFont();
      ensureStyle();
      box().innerHTML = build(d);
      /* نترك المتصفح يرسم قبل ما ينفتح صندوق الطباعة */
      setTimeout(function () { window.print(); }, 60);
    }
  };
})();

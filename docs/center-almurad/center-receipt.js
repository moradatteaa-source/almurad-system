/* ════════════════════════════════════════════════════════════
   🧾 فاتورة سنتر المراد — center-receipt.js
   ────────────────────────────────────────────────────────────
   محرّك واحد للفاتورة يستعمله الكاشير وصفحة الحسابات، فالمطبوع
   من الاثنين متطابق.

   ملاحظات التصميم (طابعة حرارية ٧٢ ملم):
     • اسم المنتج ياخذ سطر كامل لحاله — بـ٧٢ ملم الاسم العربي
       الطويل ما يسع بسطر مشترك مع الكمية والسعر، فكان ينكسر
       أو ينقص. هسه الاسم فوق، والكمية × السعر تحته باليسار،
       والمبلغ باليمين
     • الطابعة الحرارية أبيض وأسود: ماكو ألوان، والرمادي الفاتح
       يطلع باهت. فالتمييز بالحجم والسماكة مو باللون
     • المجموع بخلفية سوداء — أوضح شي بالفاتورة وأسهل شي تلگاه
       بالعين وقت تراجع الفواتير
     • الخطوط الفاصلة صلبة مو متقطّعة — أنظف على الحرارية

   ⛔ الكاشير والحسابات لازم يبقون على نفس القالب. أي تغيير هنا
      يطلع بالاثنين سوية — وهذا المقصود.
   ════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.CenterReceipt) return;

  var SHOP = { name: "سنتر المراد", phone: "07865393559" };
  var WIDTH = "72mm";

  var num = function (n) { return Number(n || 0).toLocaleString("en-US"); };
  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };

  /* خط الكاشير — نحمّله بأنفسنا حتى الفاتورة تطلع بنفس الخط من
     أي صفحة، حتى لو الصفحة نفسها تستعمل خط ثاني */
  function ensureFont() {
    if (document.getElementById("crcpt-font")) return;
    var l = document.createElement("link");
    l.id = "crcpt-font";
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap";
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
      /* display:none مو visibility:hidden — الثاني يخفي الشكل بس
         يبقي المساحة محجوزة، فجدول ٥٠٠ فاتورة بصفحة الحسابات كان
         يطبع صفحات فاضية والإيصال بأول وحدة بس */
      "  body > *:not(#crcpt){display:none !important}",
      "  #crcpt,#crcpt *{box-sizing:border-box !important;visibility:visible !important}",
      "  #crcpt{",
      "    display:block !important;position:static !important;",
      "    width:" + WIDTH + ";max-width:" + WIDTH + ";margin:0;",
      "    -webkit-print-color-adjust:exact;print-color-adjust:exact;",
      "  }",
      "  .rc-item{page-break-inside:avoid}",
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

  /* ــــ القالب ــــ */
  function build(d) {
    d = d || {};
    var items = Array.isArray(d.items) ? d.items : [];

    var rule = '<div style="border-top:2px solid #000;margin:7px 0"></div>';
    var thin = '<div style="border-top:1px solid #bbb;margin:5px 0"></div>';

    /* سطر المعلومات: العنوان يمين والقيمة يسار */
    function meta(label, value, ltr) {
      /* القيم الرقمية (رقم الفاتورة، التاريخ، الوقت) تنكتب من
         اليسار لليمين — بدونها "1:07 AM" تنقلب لـ "AM 1:07" */
      return '<div style="display:flex;justify-content:space-between;' +
        'font-size:11.5px;line-height:1.85">' +
        '<span style="color:#444">' + label + "</span>" +
        '<span style="font-weight:700' + (ltr ? ";direction:ltr" : "") + '">' +
        esc(value) + "</span></div>";
    }

    /* البند: الاسم بسطر، وتحته الكمية × السعر يسار والمبلغ يمين */
    var rows = items.map(function (it) {
      var qty = Math.abs(Number(it.qty) || 0);
      var tot = Math.abs(Number(it.total) || 0);
      var unit = Number(it.price) > 0 ? Number(it.price)
               : (qty > 0 ? Math.round(tot / qty) : 0);
      return '<div class="rc-item" style="margin:6px 0">' +
        '<div style="font-size:12.5px;font-weight:700;line-height:1.35;' +
          'word-break:break-word">' + esc(it.name != null ? it.name : it.product) + "</div>" +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;' +
          'font-size:11.5px;margin-top:1px">' +
          '<span style="color:#444;direction:ltr">' + qty + " × " + num(unit) + "</span>" +
          '<span style="font-weight:800;direction:ltr">' + num(tot) + "</span>" +
        "</div></div>";
    }).join("");

    var extras = "";
    if (Number(d.discount) > 0) {
      extras += '<div style="display:flex;justify-content:space-between;font-size:12px;' +
        'margin-top:4px"><span>الخصم</span>' +
        '<span style="direction:ltr;font-weight:700">− ' + num(d.discount) + "</span></div>";
    }

    /* المدفوع والباقي ما ينطبعون إلا إذا أكو دين فعلاً —
       الفاتورة النقدية تبقى مختصرة مثل ما هي */
    if (Number(d.rest) > 0) {
      extras += '<div style="display:flex;justify-content:space-between;font-size:12px;' +
        'margin-top:4px"><span>المدفوع</span>' +
        '<span style="direction:ltr;font-weight:700">' + num(d.paid) + "</span></div>" +
        '<div style="display:flex;justify-content:space-between;font-size:13px;' +
        'margin-top:3px;font-weight:900"><span>الباقي (دين)</span>' +
        '<span style="direction:ltr">' + num(d.rest) + "</span></div>";
      if (d.debtorName) {
        extras += '<div style="font-size:11.5px;margin-top:3px">الزبون: <b>' +
          esc(d.debtorName) + "</b></div>";
      }
    }

    return '<div style="padding:8px 10px 10px;direction:rtl;color:#000;' +
        'font-family:Tajawal,Tahoma,sans-serif">' +

      /* الترويسة */
      '<div style="text-align:center;font-size:19px;font-weight:900;letter-spacing:-.2px">' +
        esc(SHOP.name) + "</div>" +
      '<div style="text-align:center;font-size:11.5px;color:#444;margin-top:1px;' +
        'direction:ltr">' + esc(SHOP.phone) + "</div>" +

      (d.isReturn
        ? '<div style="text-align:center;margin-top:6px;border:2px solid #000;' +
          'border-radius:4px;padding:2px;font-size:12.5px;font-weight:900">' +
          "فاتورة استرجاع</div>"
        : "") +

      rule +

      /* معلومات الفاتورة */
      meta("رقم الفاتورة", d.invoiceNo || "—", true) +
      meta("التاريخ", d.date || "—", true) +
      (d.time ? meta("الوقت", d.time, true) : "") +
      meta("الكاشير", d.cashier || "—") +

      rule +

      /* البنود */
      '<div style="display:flex;justify-content:space-between;font-size:10.5px;' +
        'font-weight:800;color:#444;letter-spacing:.3px">' +
        "<span>المنتج</span><span>المبلغ</span></div>" +
      thin +
      rows +

      rule +

      /* المجموع — أبرز شي بالفاتورة */
      '<div style="background:#000;color:#fff;border-radius:5px;padding:7px 10px;' +
        'display:flex;justify-content:space-between;align-items:baseline">' +
        '<span style="font-size:13.5px;font-weight:800">المجموع</span>' +
        '<span style="font-size:18px;font-weight:900;direction:ltr">' +
          num(d.total) + '<span style="font-size:11px;font-weight:700"> د.ع</span></span>' +
      "</div>" +

      extras +

      '<div style="text-align:center;margin-top:12px;font-size:12px;font-weight:700">' +
        "شكراً لتسوقكم 🌸</div>" +
      '<div style="text-align:center;margin-top:2px;font-size:9.5px;color:#666">' +
        "نظام المراد</div>" +
      "</div>";
  }

  window.CenterReceipt = {
    /* يرجّع HTML الفاتورة بدون طباعة — للمعاينة أو الاختبار */
    html: function (d) { return build(d); },

    print: function (d) {
      ensureFont();
      ensureStyle();
      box().innerHTML = build(d);
      /* نترك المتصفح يرسم قبل ما ينفتح صندوق الطباعة.
         ملاحظة: window.print() لازم يفتح نافذة الطباعة — ماكو
         طريقة بالجافاسكربت تتجاوزها. الطباعة المباشرة بضغطة
         وحدة تنفتح بتشغيل كروم بخيار kiosk-printing (شوف
         ملف «طباعة-مباشرة» على سطح المكتب). */
      setTimeout(function () { window.print(); }, 60);
    }
  };
})();

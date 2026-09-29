/* ════════════════════════════════════════════════════════════
   🧾 طباعة الفاتورة — center-receipt.js
   ────────────────────────────────────────────────────────────
   ليش انبنى: الكاشير وصفحة الحسابات كل واحد عنده كود طباعة
   لحاله، فالفاتورة تطلع مختلفة بين الاثنين. والأسوأ: صفحة
   الحسابات كانت تطبع الصفحة كلها بورق زائد وقياس غلط.

   سبب الخلل بالحسابات: كود الطباعة القديم كان يخفي الصفحة بـ
   visibility:hidden — وهذا يخفي الشكل بس يبقي المساحة محجوزة،
   يعني جدول فيه ٥٠٠ فاتورة يظل ياخذ طوله كامل بالطباعة فتطلع
   صفحات فاضية، والإيصال بـ position:fixed يطبع بأول صفحة بس.
   هنا نستعمل display:none — المساحة تنطوي كلها وما يبقى غير
   الإيصال بعرض ٧٢ ملم.

   الاستخدام:
     <script src="center-receipt.js"></script>
     CenterReceipt.print({ invoiceNo, cashier, date, time,
       items:[{name,qty,price,total}], discount, total, paid, rest, isReturn })

   أي صفحة تستدعيها تطلع نفس الفاتورة بالضبط.
   ════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.CenterReceipt) return;

  var SHOP = { name: "سنتر المراد", phone: "07865393559" };
  var WIDTH = "72mm";

  var fmt = function (n) {
    return Number(n || 0).toLocaleString("en-US");
  };
  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };

  /* ── ستايل الطباعة ── يُحقن مرة وحدة ── */
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
      "    background:#fff !important;overflow:visible !important;height:auto !important;",
      "  }",
      /* الفرق الجوهري: display:none مو visibility — تنطوي المساحة كلها */
      "  body > *:not(#crcpt){display:none !important}",
      "  #crcpt{",
      "    display:block !important;position:static !important;",
      "    width:" + WIDTH + ";max-width:" + WIDTH + ";margin:0;padding:6px 8px;",
      "    direction:rtl;color:#000;background:#fff;",
      "    font-family:'Cairo','Tajawal',Tahoma,sans-serif;",
      "    -webkit-print-color-adjust:exact;print-color-adjust:exact;",
      "  }",
      "  #crcpt *{visibility:visible !important}",
      "  #crcpt table{width:100%;border-collapse:collapse;font-size:11px}",
      "  #crcpt tr{page-break-inside:avoid}",
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

  function build(d) {
    d = d || {};
    var items = Array.isArray(d.items) ? d.items : [];
    var isRet = !!d.isReturn;
    var line = '<hr style="border:none;border-top:1px dashed #999;margin:6px 0">';

    var rows = items.map(function (it) {
      var qty = Math.abs(Number(it.qty) || 0);
      var tot = Math.abs(Number(it.total) || 0);
      var unit = Number(it.price) > 0 ? Number(it.price) : (qty > 0 ? Math.round(tot / qty) : 0);
      return (
        '<tr>' +
        '<td style="text-align:right;padding:3px 0;border-bottom:1px solid #eee;' +
        'word-break:break-word">' + esc(it.name || it.product) + "</td>" +
        '<td style="text-align:center;border-bottom:1px solid #eee;white-space:nowrap">×' + qty + "</td>" +
        '<td style="text-align:center;border-bottom:1px solid #eee;white-space:nowrap">' + fmt(unit) + "</td>" +
        '<td style="text-align:left;border-bottom:1px solid #eee;white-space:nowrap">' + fmt(tot) + "</td>" +
        "</tr>"
      );
    }).join("");

    var money = function (label, val, style) {
      return '<div style="display:flex;justify-content:space-between;font-size:12px;' +
        'margin-top:3px;' + (style || "") + '"><span>' + label + "</span><span>" +
        fmt(val) + " د.ع</span></div>";
    };

    var extra = "";
    if (Number(d.discount) > 0) extra += money("الخصم", d.discount, "color:#555");
    if (d.paid != null && Number(d.paid) !== Number(d.total)) extra += money("المدفوع", d.paid);
    if (Number(d.rest) > 0) extra += money("الباقي (دين)", d.rest, "color:#b91c1c;font-weight:800");
    if (d.debtorName) {
      extra += '<div style="font-size:11px;margin-top:5px">👤 الزبون: <strong>' +
        esc(d.debtorName) + "</strong></div>";
    }

    return (
      '<div style="text-align:center;font-size:17px;font-weight:900;margin-bottom:2px">' +
        esc(SHOP.name) + "</div>" +
      '<div style="text-align:center;font-size:11px;color:#444;margin-bottom:6px">📞 ' +
        esc(SHOP.phone) + "</div>" +
      (isRet
        ? '<div style="text-align:center;border:1.5px solid #000;border-radius:5px;' +
          'padding:3px;font-size:12px;font-weight:900;margin-bottom:6px">↩ فاتورة استرجاع</div>'
        : "") +
      line +
      '<div style="font-size:11px;line-height:1.85">' +
        "<div>👤 الكاشير: <strong>" + esc(d.cashier || "—") + "</strong></div>" +
        "<div>📅 التاريخ: <strong>" + esc(d.date || "—") + "</strong></div>" +
        (d.time ? "<div>🕐 الوقت: <strong>" + esc(d.time) + "</strong></div>" : "") +
        "<div>🧾 رقم الفاتورة: <strong>" + esc(d.invoiceNo || "—") + "</strong></div>" +
      "</div>" +
      line +
      "<table><thead><tr style='border-bottom:1.5px solid #000'>" +
        "<th style='text-align:right;padding:3px 0'>المنتج</th>" +
        "<th style='text-align:center'>الكمية</th>" +
        "<th style='text-align:center'>السعر</th>" +
        "<th style='text-align:left'>المجموع</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>" +
      line +
      '<div style="display:flex;justify-content:space-between;font-weight:900;font-size:14px">' +
        "<span>المجموع الإجمالي</span><span>" + fmt(d.total) + " د.ع</span></div>" +
      extra +
      '<div style="text-align:center;margin-top:12px;font-size:11px;color:#555">شكراً لتسوقكم 🌸</div>' +
      '<div style="text-align:center;font-size:10px;color:#888;margin-top:3px">نظام المراد</div>'
    );
  }

  var CenterReceipt = {
    /* يرجّع HTML الفاتورة بدون طباعة — للمعاينة أو الاختبار */
    html: function (d) { return build(d); },

    print: function (d) {
      ensureStyle();
      var el = box();
      el.innerHTML = build(d);
      /* نترك المتصفح يرسم قبل ما ينفتح صندوق الطباعة */
      setTimeout(function () { window.print(); }, 60);
    }
  };

  window.CenterReceipt = CenterReceipt;
})();

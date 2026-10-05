/* ════════════════════════════════════════════════════════════
   🧭 شريط تنقّل سنتر المراد — ملف واحد لكل صفحات السنتر
   ────────────────────────────────────────────────────────────
   ليش انبنى: صفحات السنتر (كاشير، تحليلات، أرباح، حسابات، ديون)
   كانت كل واحدة لحالها — ماكو ولا رابط بينهن، الموظف لازم
   يكتب الرابط بيده أو يرجع للخلف. هذا الملف يضيف شريط تنقّل
   موحّد بكل الصفحات: على اللابتوب شريط تحت الرأس، وعلى الموبايل
   شريط ثابت بالأسفل مثل التطبيقات.

   طريقة الاستخدام — سطر واحد قبل </body> بكل صفحة:
     <script src="center-nav.js"></script>

   الشريط يحدّد الصفحة الحالية لوحده ويميّزها، وستايله مستقل
   تماماً عن ستايل الصفحة حتى ما يتأثر ولا يأثر.
   ════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  if (window.__centerNavLoaded) return;
  window.__centerNavLoaded = true;

  /* private: صفحات تعرض الأرباح — ما تظهر بالشريط إلا للمالك.
     ليش: الشريط كان يبيّن «الأرباح» و«التحليلات» بكل صفحة، فالموظف
     على الكاشير يشوفهن ويضغط. الصفحة نفسها مقفلة برمز، بس الأفضل
     ما نغري أحد أصلاً — الي ما يعرف بيها ما يدق عليها. */
  var PAGES = [
    { file: "cashier.html",       icon: "🧾", label: "الكاشير" },
    { file: "daily-expenses.html", icon: "🧾", label: "مصاريف اليوم" },
    { file: "analytics.html", icon: "📊", label: "التحليلات", private: true },
    { file: "profits.html",   icon: "💵", label: "الأرباح",   private: true },
    { file: "expenses.html",  icon: "💸", label: "المصاريف",  private: true },
    { file: "accounts.html",  icon: "💼", label: "الحسابات" },
    { file: "debts.html",     icon: "📒", label: "الديون" }
  ];

  /* المالك يوصلهن بثلاث طرق: (١) لمن يكون داخل بصفحة محمية،
     (٢) بالضغط المطوّل على شعار الكاشير، (٣) بكتابة الرابط. */
  function ownerMode() {
    try {
      if (window.__centerAuth && window.__centerAuth.user) return true;
      return sessionStorage.getItem("_center_owner_nav") === "1";
    } catch (e) { return false; }
  }

  /* اسم الملف الحالي — بدون مسار ولا باراميترات */
  function currentFile() {
    var p = (location.pathname || "").split("/").pop() || "";
    try { p = decodeURIComponent(p); } catch (e) {}
    return p.toLowerCase() || "cashier.html";
  }

  var CUR = currentFile();

  /* ── الستايل ── مستقل بالكامل، كل الأصناف تبدأ بـ cnav- */
  var css = [
    ".cnav{",
    "  --cn-bg:#0f1c2f; --cn-active:#f97316; --cn-ink:#cbd5e1;",
    "  background:var(--cn-bg); position:sticky; top:0; z-index:55;",
    "  display:flex; gap:4px; align-items:center;",
    "  padding:7px 14px; overflow-x:auto; scrollbar-width:none;",
    "  box-shadow:0 2px 12px rgba(0,0,0,.18); direction:rtl;",
    "  font-family:'Cairo',Tahoma,sans-serif;",
    "}",
    ".cnav::-webkit-scrollbar{display:none}",
    ".cnav a{",
    "  display:inline-flex; align-items:center; gap:6px; flex-shrink:0;",
    "  color:var(--cn-ink); text-decoration:none; font-weight:700; font-size:13px;",
    "  padding:7px 14px; border-radius:9px; white-space:nowrap;",
    "  transition:background .15s, color .15s;",
    "}",
    ".cnav a:hover{background:rgba(255,255,255,.09); color:#fff}",
    ".cnav a.cnav-on{background:var(--cn-active); color:#fff}",
    ".cnav a .cnav-ic{font-size:15px; line-height:1}",
    /* شريط الموبايل الثابت بالأسفل */
    "@media(max-width:820px){",
    "  .cnav{",
    "    position:fixed; top:auto; bottom:0; inset-inline:0; z-index:9000;",
    "    padding:5px 4px 6px; gap:0; justify-content:space-around;",
    "    box-shadow:0 -3px 16px rgba(0,0,0,.28);",
    "    padding-bottom:calc(6px + env(safe-area-inset-bottom,0px));",
    "  }",
    "  .cnav a{",
    "    flex:1; flex-direction:column; gap:2px; justify-content:center;",
    "    padding:6px 1px; font-size:9.5px; border-radius:10px; text-align:center;",
    "  }",
    "  .cnav a .cnav-ic{font-size:17px}",
    "  body{padding-bottom:64px !important}",
    "}",
    /* الطبع ما يحتاج شريط تنقّل */
    "@media print{.cnav{display:none !important}}"
  ].join("\n");

  var styleEl = document.createElement("style");
  styleEl.id = "cnav-style";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ── بناء الشريط ── */
  var nav = document.createElement("nav");
  nav.className = "cnav";
  nav.setAttribute("aria-label", "أقسام السنتر");

  var showOwner = ownerMode();
  PAGES.forEach(function (p) {
    if (p.private && !showOwner && p.file !== CUR) return;
    var a = document.createElement("a");
    a.href = p.file;
    if (p.file === CUR) {
      a.className = "cnav-on";
      a.setAttribute("aria-current", "page");
    }
    var ic = document.createElement("span");
    ic.className = "cnav-ic";
    ic.textContent = p.icon;
    var tx = document.createElement("span");
    tx.textContent = p.label;
    a.appendChild(ic);
    a.appendChild(tx);
    nav.appendChild(a);
  });

  /* ── الإدراج ── بعد رأس الصفحة إن وُجد، وإلا بأول البودي */
  function mount() {
    if (!document.body || document.getElementById("cnav-style") === null) return;
    if (document.querySelector(".cnav")) return;
    var header = document.getElementById("header");
    if (header && header.parentNode) {
      header.parentNode.insertBefore(nav, header.nextSibling);
    } else {
      document.body.insertBefore(nav, document.body.firstChild);
    }
  }

  /* ضغطة مطوّلة (٣ ثواني) على شعار الرأس تبيّن الأقسام الخاصة
     بالشريط لهذا التبويب — حتى المالك ما يحتاج يكتب الرابط بيده. */
  function armOwnerGesture() {
    var brand = document.querySelector("#header .hd-brand, #header .header-brand, #header .logo-dot");
    if (!brand) return;
    var t = null;
    var start = function () {
      t = setTimeout(function () {
        try { sessionStorage.setItem("_center_owner_nav", "1"); } catch (e) {}
        var old = document.querySelector(".cnav");
        if (old) old.remove();
        window.__centerNavLoaded = false;
        location.reload();
      }, 3000);
    };
    var stop = function () { if (t) { clearTimeout(t); t = null; } };
    ["mousedown", "touchstart"].forEach(function (e) { brand.addEventListener(e, start, { passive: true }); });
    ["mouseup", "mouseleave", "touchend", "touchcancel"].forEach(function (e) { brand.addEventListener(e, stop, { passive: true }); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { mount(); armOwnerGesture(); });
  } else {
    mount(); armOwnerGesture();
  }
})();

/* ════════════════════════════════════════════════════════════
   🔒 قفل صفحات السنتر الخاصة — center-auth.js
   ────────────────────────────────────────────────────────────
   ليش انبنى: صفحة الأرباح كان رمزها مكتوب صريح داخل كود الصفحة
   (أي واحد يفتح "عرض مصدر الصفحة" يشوفه)، وما يتغيّر إلا بتعديل
   الملف ورفعه. وصفحة التحليلات كانت مفتوحة للكل مع إنها تعرض
   الأرباح والتكاليف.

   شنو صار بديل:
     • مستخدمين محفوظين بقاعدة البيانات تحت centerAccess/users
     • الرمز ما ينحفظ أبداً — ينحفظ بصمته (SHA-256 مع ملح عشوائي)
       يعني حتى لو واحد فتح قاعدة البيانات ما يعرف الرمز
     • الرمز يتغيّر من داخل الصفحة بأي وقت (زر 🔑)
     • الجلسة تفضل مفتوحة ٨ ساعات على نفس الجهاز

   الاستخدام — سطر واحد داخل <head> قبل أي شي:
     <script src="center-auth.js" data-page="profits"></script>
     <script src="center-auth.js" data-page="analytics"></script>

   الصفحة تبقى مخفية تماماً لحد ما يصير فتح صحيح.
   ════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.__centerAuth) return;

  var SCRIPT = document.currentScript;
  var PAGE = (SCRIPT && SCRIPT.getAttribute("data-page")) || "private";
  var PAGE_LABEL = { profits: "الأرباح", analytics: "التحليلات" }[PAGE] || "هذه الصفحة";

  var SESSION_HOURS = 8;
  var LS_KEY = "_center_auth_v1";
  var DB_URL = "https://almurad-system-default-rtdb.firebaseio.com";
  /* لازم تكون مطابقة حرفياً لإعدادات بقية الصفحات.
     فايربيس يرمي app/duplicate-app إذا انطلق مرتين بإعدادات
     مختلفة — وهذا كان يكسر سكربت صفحة التحليلات كامل. */
  var FB_CONFIG = {
    apiKey: "AIzaSyDtEJYJrmyP45qS2da8Cuc6y6Jv5VD0Uhc",
    authDomain: "almurad-system.firebaseapp.com",
    databaseURL: DB_URL,
    projectId: "almurad-system",
    storageBucket: "almurad-system.firebasestorage.app",
    messagingSenderId: "911755824405",
    appId: "1:911755824405:web:c5520c00c11e336148ad1c"
  };

  /* وعد يُحلّ عند فتح القفل.
     ليش وعد مو حدث لحاله: هذا الملف سكربت عادي بالـ<head> فيشتغل
     قبل أي سكربت module بالصفحة. لكن الفتح نفسه قد يصير بسرعة
     (إذا الجلسة محفوظة) فتنطلق الإشارة قبل ما الصفحة تسجّل
     نفسها للاستماع — وتضل تنتظر للأبد. الوعد ما يفوت: حتى لو
     انحلّ قبل، .then() تشتغل على طول. */
  var _readyResolve;
  window.__centerAuth = {
    page: PAGE,
    user: null,
    ready: new Promise(function (res) { _readyResolve = res; })
  };

  /* ── إخفاء الصفحة فوراً قبل ما يظهر أي شي ── */
  var lockCss = document.createElement("style");
  lockCss.textContent =
    "html.cauth-locked{overflow:hidden}" +
    "html.cauth-locked body > *:not(#cauth){display:none !important}" +
    "#cauth{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;" +
    "justify-content:center;padding:20px;direction:rtl;" +
    "font-family:'Cairo','Tajawal',Tahoma,sans-serif;" +
    "background:linear-gradient(140deg,#0d1b2e,#16304d 55%,#1a3a5c)}" +
    "#cauth .cbox{background:#fff;border-radius:20px;padding:30px 26px 26px;width:100%;" +
    "max-width:370px;box-shadow:0 24px 70px rgba(0,0,0,.45);text-align:center}" +
    "#cauth .clogo{width:62px;height:62px;border-radius:18px;margin:0 auto 14px;" +
    "background:linear-gradient(135deg,#f97316,#fb923c);display:grid;place-items:center;font-size:29px}" +
    "#cauth h2{margin:0 0 4px;font-size:19px;color:#0f1c2f;font-weight:800}" +
    "#cauth .csub{font-size:13px;color:#64748b;margin-bottom:20px}" +
    "#cauth label{display:block;text-align:right;font-size:12.5px;font-weight:700;" +
    "color:#475569;margin:0 0 5px 2px}" +
    "#cauth input{width:100%;padding:12px 14px;border:1.5px solid #e2e8f0;border-radius:11px;" +
    "font-family:inherit;font-size:16px;margin-bottom:13px;background:#f8fafc;color:#0f1c2f;" +
    "text-align:center;letter-spacing:2px;font-weight:700}" +
    "#cauth input.cuser{letter-spacing:0;text-align:right;font-weight:600}" +
    "#cauth input:focus{outline:none;border-color:#f97316;background:#fff}" +
    "#cauth button.cgo{width:100%;padding:13px;border:none;border-radius:11px;background:#f97316;" +
    "color:#fff;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer}" +
    "#cauth button.cgo:hover{background:#ea580c}" +
    "#cauth button.cgo:disabled{background:#cbd5e1;cursor:default}" +
    "#cauth .cerr{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:10px;" +
    "padding:9px 12px;font-size:12.5px;font-weight:700;margin-bottom:13px;display:none}" +
    "#cauth .cerr.on{display:block}" +
    "#cauth .cnote{font-size:11.5px;color:#94a3b8;margin-top:15px;line-height:1.7}" +
    "#cauth .cback{display:inline-block;margin-top:13px;font-size:12.5px;color:#64748b;" +
    "text-decoration:none;font-weight:700}" +
    "#cauth .cback:hover{color:#f97316}" +
    /* زر تغيير الرمز بعد الدخول */
    ".cauth-key{position:fixed;inset-inline-start:14px;bottom:14px;z-index:8000;width:44px;height:44px;" +
    "border-radius:50%;border:none;background:#0f1c2f;color:#fff;font-size:18px;cursor:pointer;" +
    "box-shadow:0 6px 20px rgba(0,0,0,.3)}" +
    ".cauth-key:hover{background:#f97316}" +
    "@media(max-width:820px){.cauth-key{bottom:74px}}" +
    "@media print{#cauth,.cauth-key{display:none !important}}";
  (document.head || document.documentElement).appendChild(lockCss);
  document.documentElement.classList.add("cauth-locked");

  /* ── بصمة الرمز ── الرمز نفسه ما ينحفظ ولا ينرسل ── */
  function hex(buf) {
    return Array.prototype.map
      .call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); })
      .join("");
  }
  async function sha256(txt) {
    if (!window.crypto || !crypto.subtle) throw new Error("no-crypto");
    return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt)));
  }
  function newSalt() {
    var a = new Uint8Array(16);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a)
      : a.forEach(function (_, i) { a[i] = Math.floor(Math.random() * 256); });
    return hex(a.buffer);
  }
  var pinHash = function (salt, pin) { return sha256(salt + "::" + String(pin).trim()); };

  /* ── الجلسة المحفوظة ── */
  function readSession() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (!s || !s.exp || Date.now() > s.exp) return null;
      return s;
    } catch (e) { return null; }
  }
  function writeSession(username, name) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        u: username, n: name, exp: Date.now() + SESSION_HOURS * 3600e3
      }));
    } catch (e) {}
  }
  function clearSession() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }

  /* ── قاعدة البيانات ── */
  var dbP = null;
  function db() {
    if (!dbP) dbP = (async function () {
      var appMod = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js");
      var dbMod = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js");
      var apps = appMod.getApps ? appMod.getApps() : [];
      var app = apps.length ? apps[0] : appMod.initializeApp(FB_CONFIG);
      return { d: dbMod.getDatabase(app), m: dbMod };
    })();
    return dbP;
  }
  async function getUsers() {
    var x = await db();
    var snap = await x.m.get(x.m.ref(x.d, "centerAccess/users"));
    return snap.exists() ? snap.val() : null;
  }
  async function saveUser(username, obj) {
    var x = await db();
    await x.m.update(x.m.ref(x.d, "centerAccess/users/" + username), obj);
  }

  /* ── الواجهة ── */
  var box = document.createElement("div");
  box.id = "cauth";
  function render(html) { box.innerHTML = '<div class="cbox">' + html + "</div>"; }
  function mount() {
    if (!document.body) return document.addEventListener("DOMContentLoaded", mount);
    if (!box.parentNode) document.body.appendChild(box);
  }
  function showErr(msg) {
    var e = box.querySelector(".cerr");
    if (e) { e.textContent = msg; e.classList.add("on"); }
  }

  function unlock(username, name) {
    window.__centerAuth.user = { username: username, name: name };
    document.documentElement.classList.remove("cauth-locked");
    if (box.parentNode) box.parentNode.removeChild(box);
    addKeyButton(username, name);
    _readyResolve(window.__centerAuth.user);
    document.dispatchEvent(new CustomEvent("center-auth-ready", {
      detail: { username: username, name: name }
    }));
  }

  /* ── شاشة الدخول ── */
  function loginScreen(users) {
    var names = Object.keys(users);
    var only = names.length === 1 ? names[0] : "";
    render(
      '<div class="clogo">🔒</div>' +
      "<h2>" + PAGE_LABEL + " — صفحة خاصة</h2>" +
      '<div class="csub">تحتاج رمز دخول</div>' +
      '<div class="cerr"></div>' +
      (only
        ? '<input type="hidden" id="cu" value="' + only + '">' +
          '<div style="font-size:13.5px;font-weight:800;color:#0f1c2f;margin-bottom:14px">👤 ' +
          (users[only].name || only) + "</div>"
        : '<label>المستخدم</label><input class="cuser" id="cu" autocomplete="username" placeholder="اسم المستخدم">') +
      "<label>الرمز</label>" +
      '<input id="cp" type="password" inputmode="numeric" autocomplete="current-password" placeholder="••••">' +
      '<button class="cgo" id="cgo">دخول</button>' +
      '<a class="cback" href="cashier.html">← رجوع للكاشير</a>'
    );
    mount();
    var pin = box.querySelector("#cp");
    var go = box.querySelector("#cgo");
    setTimeout(function () { pin.focus(); }, 120);
    pin.addEventListener("keydown", function (e) { if (e.key === "Enter") go.click(); });

    go.addEventListener("click", async function () {
      var u = String(box.querySelector("#cu").value || "").trim().toLowerCase();
      var p = String(pin.value || "").trim();
      if (!u || !p) return showErr("اكتب المستخدم والرمز");
      var rec = users[u];
      go.disabled = true;
      try {
        if (!rec) { showErr("المستخدم أو الرمز غلط"); return; }
        var h = await pinHash(rec.salt || "", p);
        if (h !== rec.hash) { showErr("المستخدم أو الرمز غلط"); pin.value = ""; pin.focus(); return; }
        if (rec.pages && rec.pages[PAGE] === false) { showErr("ما عندك صلاحية على " + PAGE_LABEL); return; }
        writeSession(u, rec.name || u);
        unlock(u, rec.name || u);
      } catch (e) {
        showErr("تعذّر التحقق — تأكد من الإنترنت");
      } finally { go.disabled = false; }
    });
  }

  /* ── أول تشغيل: تعيين رمز المالك ── */
  function setupScreen() {
    render(
      '<div class="clogo">🔑</div>' +
      "<h2>أول تشغيل</h2>" +
      '<div class="csub">عيّن رمز الدخول لصفحات الأرباح والتحليلات</div>' +
      '<div class="cerr"></div>' +
      '<div style="font-size:13.5px;font-weight:800;color:#0f1c2f;margin-bottom:14px">👤 مراد الكافي</div>' +
      '<label>الرمز الجديد (٤ أرقام أو أكثر)</label>' +
      '<input id="cp1" type="password" inputmode="numeric" placeholder="••••">' +
      "<label>أعد كتابة الرمز</label>" +
      '<input id="cp2" type="password" inputmode="numeric" placeholder="••••">' +
      '<button class="cgo" id="cgo">حفظ وفتح</button>' +
      '<div class="cnote">الرمز ما ينحفظ بقاعدة البيانات — تنحفظ بصمته فقط.<br>' +
      "تكدر تغيّره بأي وقت من زر 🔑 داخل الصفحة.</div>"
    );
    mount();
    var go = box.querySelector("#cgo");
    box.querySelector("#cp2").addEventListener("keydown", function (e) {
      if (e.key === "Enter") go.click();
    });
    go.addEventListener("click", async function () {
      var a = String(box.querySelector("#cp1").value || "").trim();
      var b = String(box.querySelector("#cp2").value || "").trim();
      if (a.length < 4) return showErr("الرمز لازم ٤ أرقام على الأقل");
      if (a !== b) return showErr("الرمزين مو نفس الشي");
      go.disabled = true;
      try {
        var salt = newSalt();
        await saveUser("murad", {
          name: "مراد الكافي", salt: salt, hash: await pinHash(salt, a),
          pages: { profits: true, analytics: true }, createdAt: Date.now()
        });
        writeSession("murad", "مراد الكافي");
        unlock("murad", "مراد الكافي");
      } catch (e) {
        showErr("ما انحفظ — تأكد من الإنترنت وحاول مرة ثانية");
        go.disabled = false;
      }
    });
  }

  /* ── زر تغيير الرمز (بعد الدخول) ── */
  function addKeyButton(username, name) {
    var btn = document.createElement("button");
    btn.className = "cauth-key";
    btn.type = "button";
    btn.title = "تغيير رمز الدخول / خروج";
    btn.textContent = "🔑";
    btn.addEventListener("click", function () { changeScreen(username, name); });
    (document.body || document.documentElement).appendChild(btn);
  }

  function changeScreen(username, name) {
    document.documentElement.classList.add("cauth-locked");
    render(
      '<div class="clogo">🔑</div>' +
      "<h2>تغيير رمز الدخول</h2>" +
      '<div class="csub">👤 ' + name + "</div>" +
      '<div class="cerr"></div>' +
      "<label>الرمز الحالي</label>" +
      '<input id="c0" type="password" inputmode="numeric" placeholder="••••">' +
      "<label>الرمز الجديد</label>" +
      '<input id="c1" type="password" inputmode="numeric" placeholder="••••">' +
      "<label>أعد كتابة الجديد</label>" +
      '<input id="c2" type="password" inputmode="numeric" placeholder="••••">' +
      '<button class="cgo" id="cgo">حفظ الرمز الجديد</button>' +
      '<a class="cback" href="#" id="cclose">إلغاء ورجوع للصفحة</a><br>' +
      '<a class="cback" href="#" id="cout" style="color:#b91c1c">🚪 تسجيل خروج</a>'
    );
    mount();
    box.querySelector("#cclose").addEventListener("click", function (e) {
      e.preventDefault();
      document.documentElement.classList.remove("cauth-locked");
      if (box.parentNode) box.parentNode.removeChild(box);
    });
    box.querySelector("#cout").addEventListener("click", function (e) {
      e.preventDefault(); clearSession(); location.reload();
    });
    var go = box.querySelector("#cgo");
    go.addEventListener("click", async function () {
      var cur = String(box.querySelector("#c0").value || "").trim();
      var a = String(box.querySelector("#c1").value || "").trim();
      var b = String(box.querySelector("#c2").value || "").trim();
      if (a.length < 4) return showErr("الرمز الجديد لازم ٤ أرقام على الأقل");
      if (a !== b) return showErr("الرمزين الجديدين مو نفس الشي");
      go.disabled = true;
      try {
        var users = await getUsers();
        var rec = (users || {})[username];
        if (!rec) { showErr("ما لگيت المستخدم"); return; }
        if ((await pinHash(rec.salt || "", cur)) !== rec.hash) {
          showErr("الرمز الحالي غلط"); return;
        }
        var salt = newSalt();
        await saveUser(username, { salt: salt, hash: await pinHash(salt, a), changedAt: Date.now() });
        clearSession(); writeSession(username, name);
        render('<div class="clogo">✅</div><h2>تم تغيير الرمز</h2>' +
          '<div class="csub">الرمز الجديد شغّال من هسه على كل الأجهزة</div>' +
          '<button class="cgo" id="cok">رجوع للصفحة</button>');
        box.querySelector("#cok").addEventListener("click", function () {
          document.documentElement.classList.remove("cauth-locked");
          if (box.parentNode) box.parentNode.removeChild(box);
        });
      } catch (e) {
        showErr("ما انحفظ — تأكد من الإنترنت");
      } finally { go.disabled = false; }
    });
  }

  function fatal(msg) {
    render('<div class="clogo">⚠️</div><h2>تعذّر فتح الصفحة</h2>' +
      '<div class="csub">' + msg + "</div>" +
      '<a class="cback" href="cashier.html">← رجوع للكاشير</a>');
    mount();
  }

  /* ── البداية ── */
  (async function boot() {
    mount();
    var s = readSession();
    try {
      var users = await getUsers();
      if (!users || !Object.keys(users).length) return setupScreen();
      if (s && users[s.u]) {
        var rec = users[s.u];
        if (!rec.pages || rec.pages[PAGE] !== false) return unlock(s.u, rec.name || s.u);
      }
      clearSession();
      loginScreen(users);
    } catch (e) {
      fatal(e && e.message === "no-crypto"
        ? "المتصفح ما يدعم التشفير — افتح الصفحة عبر https"
        : "ما وصلنا لقاعدة البيانات — تأكد من الإنترنت");
    }
  })();
})();

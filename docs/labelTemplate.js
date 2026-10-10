// ════════════════════════════════════════════════════════
// 🏷️ قالب ليبل الشحن المشترك — نفس الكود بالضبط يُستخدم من:
//   1) shipping-logs.html (الطباعة المباشرة عبر iframe بالمتصفح)
//   2) labels-print.html  (توليد PDF حقيقي بجودة الطباعة عبر السيرفر/Puppeteer)
// وضعناه بملف واحد مشترك حتى التصميم يبقى مطابق 100% بين المسارين دائماً
// (تعديل واحد هنا ينعكس على الاثنين، بدل صيانة نسختين قد تنحرف عن بعض).
// يعتمد على qrcode-lib.js (يجب تحميله قبل هذا الملف بوسم <script> منفصل).
// ════════════════════════════════════════════════════════

// 🏷️ نولّد كود QR (مربع) من رقم الوصل نفسه — عبر مكتبة qrcode بملف qrcode-lib.js.
// errorCorrectionLevel: "M" (تصحيح أخطاء ~15%) توازن جيد بين حجم الكود
// ووضوحه على طابعة حرارية 80mm. typeNumber: 0 يخلي المكتبة تختار أصغر
// حجم QR يكفي لطول النص تلقائياً.
// ⚠️ ملاحظة مهمة (2026-09-19): كنا نرسمه بـ<canvas> ونحوله لصورة PNG
// (data:image/png;base64,...)، وهذا كان يشتغل تمام باللابتوب. بس تبين إن
// متصفح كروم المخفي بالسيرفر (Puppeteer) ما يتعامل مع صور القياسات هذي
// بنفس كفاءة تصدير الطباعة العادي — كل وصل صار يضيف تقريباً 70-80 كيلوبايت
// إضافية للملف بدل أقل من 3 كيلوبايت المتوقعة (36 وصل صاروا 2.8 ميكا بدل
// أقل من 1 ميكا). كود QR أصلاً مجرد مربعات سوداء وبيضاء — نرسمه SVG (خطوط
// متجهة نظيفة) بدل صورة نقطية، فيصير حجمه صغير جداً بأي مسار تصدير (كروم
// عادي أو Puppeteer) لأنه مو صورة أصلاً.
function generateQrSvg(value) {
  if (!value) return null;
  try {
    const qr = qrcode(0, "M");
    qr.addData(String(value));
    qr.make();
    const count = qr.getModuleCount();
    const margin = 4; // هامش أبيض حول الكود (مطلوب لقراءة سليمة بأي سكانر)
    const size = count + margin * 2;
    // 📉 ندمج المربعات السوداء المتجاورة بنفس الصف بمستطيل واحد عريض بدل
    // مربع صغير لكل وحدة — يقلّل عدد العناصر كثير (خط كامل بمستطيل وحدة
    // بدل عشرات) فيصير الناتج أخف وأسرع برسمه.
    let rects = "";
    for (let row = 0; row < count; row++) {
      let col = 0;
      while (col < count) {
        if (qr.isDark(row, col)) {
          let runStart = col;
          while (col < count && qr.isDark(row, col)) col++;
          rects += `<rect x="${runStart + margin}" y="${row + margin}" width="${col - runStart}" height="1"/>`;
        } else {
          col++;
        }
      }
    }
    return `<svg class="label-qr" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  } catch (err) {
    console.warn("⚠️ تعذر توليد كود QR الوصل:", err.message);
    return null;
  }
}

// شركات التوصيل: نفس المفاتيح المستخدمة بكل النظام (send-shipping.html وغيره)
const COURIER_LOGO  = { waseet: "alwaseet-logo.png", prime: "prime-logo.png", jenni: "jenni-logo.png" };
// الشركات الي عندها شعار مضمّن بالستايل. الباقي يطلع بشارة نص.
const COURIER_MARK_CLASS = { waseet: "cm-waseet" };
const COURIER_LABEL = { waseet: "الوسيط",           prime: "برايم",          jenni: "Jenni" };
const COURIER_COLOR = { waseet: "#e63946",           prime: "#8e44ad",        jenni: "#e67e22" };

function escHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

// 🧾 بناء الليبل — نفس تصميم الوصل المعتمد بالضبط، شعار الشركة فقط يتغير
function buildLabelHTML(order, pageNum) {
  const company  = order.shippingCompany || "waseet";
  const label    = COURIER_LABEL[company] || "";

  /* 🖼️ شعار شركة التوصيل — بلا أي طلب شبكة.
     كان <img src="alwaseet-logo.png"> وأخواته. ثلاث مشاكل:
       • prime-logo.png و jenni-logo.png **مو موجودين أصلاً** بالمجلد،
         فكل ليبل برايم أو جيني يرسل طلب يرجع ٤٠٤.
       • على الموبايل والشبكة البطيئة الصورة تتأخر، والطباعة تنتظرها.
       • لو الصورة ما وصلت، الليبل ينطبع بلا شعار.
     هسه شعار الوسيط مضمّن بالستايل نفسه (صورة أبيض/أسود ١.٤ كيلو،
     تنكتب مرة وحدة بالستايل مهما كان عدد الليبلات)، والشركات الي
     ماكو عندها ملف تطلع بشارة نص — بلا أي محاولة تحميل. */
  const courierMark = COURIER_MARK_CLASS[company]
    ? `<div class="label-courier-mark ${COURIER_MARK_CLASS[company]}" role="img" aria-label="${escHtml(label)}"></div>`
    : `<div class="label-courier-fallback">${escHtml(label || company)}</div>`;

  const today = new Date().toLocaleDateString("ar-IQ");
  // ✅ كود QR يُبنى من رقم الوصل نفسه لكل طلب (مو رقم ثابت بالكود) — يتغير
  // تلقائياً حسب رقم الوصل الفعلي المخزّن بقاعدة البيانات لهذا الطلب بالذات
  const qrValue = order.receiptNum || order.orderNumber || order.id;
  const qrSvg = generateQrSvg(qrValue);

  const items = (Array.isArray(order.productsDetailed) && order.productsDetailed.length)
    ? order.productsDetailed
    : [{ name: order.totalProducts || order.productName || "", qty: order.totalQty, price: order.totalPrice, variants: null }];

  const rowsHTML = items.map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escHtml(p.name) || "-"}</td>
      <td>${p.variants ? escHtml(Object.values(p.variants).join(" | ")) : ""}</td>
      <td>${escHtml(p.qty ?? "")}</td>
      <td>${escHtml(p.price ?? "")}</td>
    </tr>`).join("");

  return `
  <div class="label-page">
    <div class="label-page-inner">
    <div class="label-top">
      <div class="label-almurad"><svg viewBox="0 0 701 419" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AL-MURAD"><path fill="#000" fill-rule="evenodd" d="M232.3 411.9C230.6 411.4 228.1 409.7 226.7 408.1C225.4 406.5 217.2 392.2 208.5 376.4C159 286.1 143.1 257.3 137.2 246.5C131.5 236.3 130.5 233.8 130.5 229.7C130.5 225.5 130.9 224.5 133.8 221.9L137 219L181 219L225 219L228 221.8C229.6 223.3 235.3 232.4 240.6 242C262.6 281.8 283.8 320.4 291.5 334.5C296 342.8 304.6 358.3 310.5 369C325.2 395.5 326 397.3 326 401.5C326 404.3 325.2 406 322.8 408.4L319.5 411.7L301.5 412.3C275 413.2 236 413 232.3 411.9ZM384.3 410.6C382.6 409.8 380 407.4 378.7 405.3C377.4 403.2 363.1 377.6 347 348.5C330.9 319.4 314.1 289 309.7 281C305.3 273 297.7 259.4 292.7 250.6C283.1 233.6 281.8 229.3 284.4 224.2C287.6 218 287.6 218 334 218C369.7 218 376.7 218.2 379.4 219.5C383.2 221.3 384 222.7 403.8 259C412 274.1 425.7 299.1 434.2 314.5C466.2 372.1 477.9 393.9 478.9 397.5C480.1 401.9 478.7 406.3 475 409.5C472.9 411.4 471.2 411.5 430.1 411.7C395.4 411.9 386.9 411.7 384.3 410.6ZM539 408.2C535.4 406.4 533.4 403.1 500 342.5C486.2 317.4 462.9 275.4 449.1 251C435.1 226.1 434.5 224.1 440.6 218.4L444.1 215L490.3 215C543.6 214.9 547.5 214.5 561 207.9C576.5 200.3 588.2 185.6 592.1 169C593.7 162.1 593.7 148.2 592.1 141C589.6 130.5 584.2 121.2 575.5 112.5C566.3 103.3 558.8 98.9 547.4 96C539.8 94 535.4 94 297.5 94L55.3 94L51.1 91.7C46.2 89.2 45.9 88.8 23.2 49.1C14.8 34.6 7.6 21.1 7 19.2C5.8 14.6 7.8 9.7 11.9 7.5C14.7 6.1 40.6 6 289.7 6.3L564.5 6.6L574.5 8.8C588.1 12 597.6 15.2 609.6 20.9C654.2 42.2 684.8 82.5 693.1 131.2C695.8 146.7 695.3 169.9 692.1 185.2C680.8 237.7 641.2 281.4 589.7 298.1C584.4 299.8 580.2 301.5 580.4 301.9C580.6 302.2 585.5 310.8 591.2 321C610.3 354.7 628 386.8 630.6 392.5C633 397.6 633.1 398.6 632.1 402.2C631.3 404.8 629.8 406.7 627.7 408C624.7 409.9 622.4 410 583.5 410C546.5 410 542.2 409.8 539 408.2Z"/></svg></div>
      ${qrSvg ? `<div class="label-qr-wrap">${qrSvg}</div>` : ""}
      <div class="label-courier">
        ${courierMark}
        <div class="label-branch-code">${escHtml(order.branchCode || "KRK9")}</div>
      </div>
    </div>

    <div class="label-receipt-title">رقم الوصل: ${escHtml(order.receiptNum) || "--"}</div>
    <div class="label-meta-row">
      <div>التاريخ: ${today}</div>
      <div>طلب رقم: ${escHtml(order.orderNumber || order.id)}</div>
    </div>
    <hr>

    <div class="label-boxes">
      <div class="label-box">
        <b>عنوان الشحن</b>
        الشركة: AL-MURAD<br>
        المحافظة: ${escHtml(order.city)}<br>
        المنطقة: ${escHtml(order.area)}<br>
        أقرب نقطة: ${escHtml(order.address)}<br>
        اسم الزبون: ${escHtml(order.customerName || order.advertiser || order.code) || "غير معروف"}
      </div>
      <div class="label-box">
        <b>تفاصيل الطلب</b>
        مجموع السعر: ${escHtml(order.totalPrice ?? 0)} د.ع<br>
        عدد القطع: ${escHtml(order.totalQty ?? 0)}<br>
        نوع البضاعة: ${escHtml(order.totalProducts || order.productName)}
      </div>
    </div>

    <div class="label-notes">
      <b>ملاحظات:</b>
      ${escHtml(order.notes) || "لا توجد ملاحظات"}
    </div>

    <table class="label-table">
      <thead>
        <tr><th>#</th><th>المنتج</th><th>المتغير</th><th>الكمية</th><th>السعر</th></tr>
      </thead>
      <tbody>${rowsHTML}</tbody>
    </table>

    <!-- ⚠️ تنبيه الزبون — سياسة الفحص عند الاستلام.
         السبب: إذا الزبون استلم البضاعة وراح المندوب، أجرة التوصيل
         تنحسب علينا، وإذا رجّعها بعدين ندفع أجرة توصيل ثانية. أما
         إذا فحصها والمندوب واگف ورجّعها على طول، ما نخسر ولا دينار
         والمندوب ما يحق ياخذ أي مبلغ. -->
    <div class="label-warn"><b>افحص بوجود المندوب</b><span>أي خلل بالمنتج استرجع الطلب بدون دفع أي أجور توصيل.</span></div>

    <div class="label-page-num">${pageNum}</div>
    </div>
  </div>`;
}

// 📐 ملاءمة المحتوى داخل الليبل ٨٠×١٢٠ ملم
// الليبل ورقة ثابتة القياس، والمحتوى يتغير: طلب بمنتج واحد يسع مرتاح،
// وطلب بستة منتجات يفيض فينقص من أسفل الليبل بصمت — وهذا كان يصير
// حتى قبل ما نضيف تنبيه الفحص. بدل ما نخلي شي ينقص، نصغّر المحتوى
// شوي لمن يفيض حتى يسع كامل. ما ننزل تحت ٧٢٪ حتى يبقى مقروء.
function fitLabelContent(scope) {
  const doc = scope.ownerDocument || document;
  const pages = scope.querySelectorAll ? scope.querySelectorAll(".label-page") : [];
  pages.forEach(page => {
    const inner = page.querySelector(".label-page-inner");
    if (!inner) return;
    inner.style.transform = "";
    inner.style.transformOrigin = "";
    const avail = page.clientHeight;
    const need = inner.scrollHeight;
    if (avail > 0 && need > avail + 1) {
      // الأرضية ٠.٧٨: الحجوم الجديدة أكبر ~٣٠٪، فحتى بأقصى تصغير
      // يبقى الخط بحجم الي كان عليه قبل التعديل — ما ينزل تحته.
      const k = Math.max(0.78, avail / need);
      inner.style.transformOrigin = "top center";
      inner.style.transform = `scale(${k})`;
    }
  });
}

// إذا ملف شعار شركة التوصيل غير موجود بعد على الاستضافة، نستبدله تلقائياً
// بشارة نصية ملونة بدل أيقونة صورة مكسورة. تعمل مع أي مستند (الصفحة
// الرئيسية أو مستند إطار الطباعة المنعزل أو صفحة توليد الـPDF) عبر ownerDocument.
function attachLogoFallback(container) {
  const doc = container.ownerDocument;
  container.querySelectorAll(".label-courier img").forEach(img => {
    img.addEventListener("error", () => {
      const div = doc.createElement("div");
      div.className = "label-courier-fallback";
      div.style.background = img.dataset.fallbackColor || "#043B64";
      div.textContent = img.dataset.fallbackLabel || "";
      img.replaceWith(div);
    }, { once: true });
  });
}

// ⏳ ننتظر تحميل كل الصور (شعارات + QR) فعلياً قبل التصوير/الطباعة/توليد PDF
function waitForLabelImages(container, timeoutMs = 1200) {
  return new Promise(resolve => {
    const imgs = Array.from(container.querySelectorAll("img"));
    if (!imgs.length) { resolve(); return; }
    let pending = imgs.length;
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    const onOne = () => { pending--; if (pending <= 0) finish(); };
    imgs.forEach(img => {
      if (img.complete) onOne();
      else {
        img.addEventListener("load", onOne, { once: true });
        img.addEventListener("error", onOne, { once: true });
      }
    });
    setTimeout(finish, timeoutMs);
  });
}

// 📏 مقاس الليبل الفعلي بالطابعة الحرارية ثابت 80×120mm ولازم يضل هيچي دائماً
// (هذا قرار المستخدم النهائي: العرض والطول محددين بحجم الورقة نفسها، مو
// شي نقدر نغيره). المشكلة: بعض الطلبات (منتجات كثيرة/ملاحظات طويلة) محتواها
// أطول من 120mm طبيعياً. الحل: نصغّر محتوى الوصل تلقائياً (transform: scale)
// بس إذا فاض فعلاً عن المساحة المتاحة، بحيث يضل كل وصل بصفحة وحدة بالمقاس
// المطلوب بالضبط بدون ما ينقطع أي تفصيل — وإذا كان المحتوى طبيعي (الحالة
// الغالبة) يطلع بحجمه الطبيعي 100% بدون أي تصغير. مطلوبة بكل من الطباعة
// المباشرة (shipping-logs.html) وتوليد PDF بالسيرفر (labels-print.html)،
// حتى ما ينقطع أي تفصيل بأي من المسارين.
function fitLabelPagesToBox(pages) {
  const MM_TO_PX = 96 / 25.4;
  const availableHeightPx = (120 - 2) * MM_TO_PX; // هامش أمان بسيط 2mm
  pages.forEach(page => {
    const inner = page.querySelector(".label-page-inner");
    if (!inner) return;
    inner.style.transform = "none";
    const naturalHeight = inner.scrollHeight;
    if (naturalHeight > availableHeightPx) {
      const scale = Math.max(0.5, availableHeightPx / naturalHeight);
      inner.style.transform = `scale(${scale})`;
    }
  });
}

// ════════════════════════════════════════════════════════
// 🔎 إيجاد طلب برقمه — بقراءة مسار الطلب مباشرة
// ────────────────────────────────────────────────────────
// ⚠️ إصلاح تكلفة (2026-09-23): قبل، كل طباعة وصل كانت تسحب فرع
// "ordersTest" كامل — يعني كل طلبات الشركة بكل الحالات من أول يوم —
// حتى تلقي طلب واحد برقمه. مع آلاف الطلبات بالشهر صار هذا أكبر مصدر
// استهلاك بقاعدة البيانات، والتكلفة تكبر كل ما زادت الطلبات.
//
// الطلب مخزّن بمسار معروف: ordersTest/<الحالة>/<رقم الطلب>. الحالات
// عددها محدود (10)، فنقرا المسار مباشرة لكل حالة لين نلقاه. عشر قراءات
// صغيرة جداً (أغلبها فاضية) بدل تحميل الشجرة كاملة.
// ════════════════════════════════════════════════════════
const ORDER_STATUSES = [
  'مثبت', 'قيد التجهيز', 'قيد التوصيل', 'تم التسليم', 'راجع',
  'تم استلام الراجع', 'بانتظار البضاعة', 'قيد المعالجة', 'جديد', 'رفض'
];

// تحتاج { db, ref, get } من فايربيس — كل صفحة تمررهن لأن هذا ملف سكربت
// عادي مو module.
async function fetchOrderById(fb, orderId) {
  if (!orderId) return null;
  const { db, ref, get } = fb;
  // نفحص الحالات بالتوازي — أسرع من وحدة وحدة والحمل نفسه
  const results = await Promise.all(
    ORDER_STATUSES.map(async status => {
      try {
        const snap = await get(ref(db, `ordersTest/${status}/${orderId}`));
        return snap.exists() ? { ...snap.val(), id: orderId, status } : null;
      } catch (e) { return null; }
    })
  );
  const found = results.find(Boolean);
  if (found) return found;
  // احتياط: الفرع القديم قبل ordersTest
  try {
    const legacy = await get(ref(db, `orders/${orderId}`));
    if (legacy.exists()) return { ...legacy.val(), id: orderId };
  } catch (e) {}
  return null;
}

// نجيب عدة طلبات سوا، بدفعات حتى ما نفتح مئات الاتصالات مرة وحدة
async function fetchOrdersByIds(fb, ids, batch = 8) {
  const out = [];
  for (let i = 0; i < ids.length; i += batch) {
    const chunk = await Promise.all(ids.slice(i, i + batch).map(id => fetchOrderById(fb, id)));
    for (const o of chunk) if (o) out.push(o);
  }
  return out;
}

// 🔎 النسخة القديمة — تبقى للتوافق مع أي كود لسه يمرر الشجرة
function findOrderInTree(tree, orderId) {
  for (const status of Object.keys(tree)) {
    if (status === "_meta") continue;
    if (tree[status] && tree[status][orderId]) {
      return { ...tree[status][orderId], id: orderId, status };
    }
  }
  return null;
}

// نفس أنماط ".label-*" أعلاه — تُستخدم داخل إطار الطباعة المنعزل بـ
// shipping-logs.html، وأيضاً كنمط الصفحة الرئيسي بـ labels-print.html
// (المصدر الوحيد لتصميم الليبل الفعلي، حتى ما ينحرف بين المسارين)
const LABEL_STYLE_CSS = `
  /* ════════════════════════════════════════════════════════
     🖨️ خط الليبل — إصلاح الوضوح (١٠ تشرين الأول ٢٠٢٦)
     ────────────────────────────────────────────────────────
     المشكلة الي كان يشتكي منها المجهّز: الخط باهت ومو واضح
     فيخربط بالقراءة. السبب سببين مو واحد:

     ١) الخط. الصفحة كانت تحمّل Tajawal-Regular.ttf **بس** — ملف
        وزن عادي واحد، ماكو ملف عريض. ولمن الستايل يطلب
        font-weight:700/900، المتصفح ما يلكى وجه عريض حقيقي
        فيسوي "عريض صناعي": يوسّع حروف الوزن العادي برمجياً.
        وهذا بالعربي يطلع مشوّه وباهت، وعلى الطابعة أسوأ.
        هسه نستخدم Tahoma — موجود بكل أجهزة الويندوز وعنده وجه
        **عريض حقيقي**، وعربيته واضحة ومضبوطة بالطباعة. بلا
        تحميل ولا إنترنت ولا تغيير بالتصميم.

     ٢) الحجم. نصوص الصندوق والجدول كانت ٨–٨.٤ بكسل — صغيرة
        جداً على ورقة ٨٠ ملم. كبّرناها ~٣٠٪. وحتى تسع، صغّرنا
        مربع الـQR من ٢٧ لـ٢٢ ملم (باقي ينمسح عادي) وضيّقنا
        المسافات بين الأسطر.

     الترتيب والتصميم ما تغير ولا شي — نفس الصناديق ونفس
     الجدول ونفس المواضع بالضبط.
     ════════════════════════════════════════════════════════ */
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Tahoma,'Segoe UI','Tajawal',sans-serif; background:#fff; direction: rtl; }
  .label-page {
    width:80mm; height:120mm; overflow:hidden; position:relative;
    color:#000; background:#fff;
    font-family:Tahoma,'Segoe UI','Tajawal',sans-serif;
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }
  .label-page-inner { width:80mm; box-sizing:border-box; padding:3mm; transform-origin: top right; }
  .label-top { display:flex; justify-content:space-between; align-items:center; }
  .label-almurad svg { width:20mm; height:auto; display:block; }
  .label-courier { text-align:center; }
  .label-courier-mark { width:16mm; height:16mm; background-repeat:no-repeat;
    background-position:center; background-size:contain; margin:0 auto; }
  .cm-waseet { background-image:url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQAAAACFI5MzAAAFdUlEQVR42u2Yu47kxhWGP7KJIYOFmmEHA5OBH2ABJxsYaMKxH2IiwaEzKzA0JegF9Ah6EEHgLARow4ViwyhBArTKaiUF3DGnfgd14aV7YiXqYIZdP8+pv06daxfimU/JH8jvgKgoquvIa3jql69FvjmVQOGvyPwCoOEK8gUAby+1KbyzqMsyj0BtkVm4xo/lEzoPXVrIiDlMnOWo94inc0ieQ0LKvI11BRTmac9gOmBLYGDYIW9vGStgxO6QsYcGMLzbsUaikzyZQpTRAdHDI/itzFRrRpLjE7bncZ3mQpItPPcbba5nDowKvtxws0N4tBXGbZAHw1QB44lh2jA4SCO1xFnusNmn4vuBD40YaDas/TEo/2uhwDGznv8U3ztInjWSNuUgKR4o7DNBh3wwjRlX+zg6fSY5uJfGbqXN1lIhyXCUbLfSZqdw5oHfoHUrG9QQPfIJ3LRC3gAVMN5hsPOKQSfNtSQz08kcVgw6aT5KKmRqUSwMtATU3ay9x88tqOT0lMiUAFPyvoobPgWXGfwoaToHFpzgX3mfn4PpoIHxHeOibQaSP7+k6L/JyHcrFg1l66/mkBte8GNm8BdJVpI7S6KbbhMDVTs590xG6qvSRMS/AgrADaAUWhcyHldOY0TmNi2b4C5F4jZJ0g+R38RBdRe5TWttU+2DTfI+FvgeoLkPtKtIazlLOxjzIsq47XF6/LRo+6wY4hdLu9yC5cHwlKgPjR0SUj4NwPuBERhNvLAyxsYErwmWrRxJ9QjUJvpWQTkp2eBzSfrWQy2pkOrxYZX5oMgh8O9+Z+ujeQxe6LPHHyTpW2nmLF9LDzZpq7InvwGgQ2ttDRR8wDfQXt5pRwgK01/ctn0H0LTB+1n1Drcf5hYYXWcWmR7gYIbMaOc7d2+A0l4gPSf6Z3y0Jt/+3hNHm/xuj/TvAGP3yADt46rK+HmNysDAeC1KxiXDzrmASXL2KNnxvL7T+Dn99kwX4G6e4jVcyBSY5zqH8UveJ8RvRHoX+F3KnKbntFWPzyEHPdu7GJMzxa6JvMuRtRdrrWW4qq1xVd7HbMmF+Lkic5ivciuBT9+QvG7coue/X5Npk7uC5DnHC/1B+lWSuyVEVpEbjPj/xXyh7evIok9xynFpFn6V5F+irYcoHTnnHTOl5Broe1fs9pmxodKbbS2BKebA+SKyXMy1RchtwODTcYLw45hllHzdLwUDJI2pVwD9T9JP1PE8fSAjolf+tLqffA2mYp132nRQGEvgvzRZxqZTWYCvMoMpmNRBejhuLeqWstJmbVNSOS/nCdlyTgR9eGXJfD5ZWKszSPLpbyy8cL8wMCkmzRIa4aVz6q3O0hwWo8dbmOAEFuaQ4MpVpebP4PKZyuArUwIncGGxTM6Bhb+lh4z0eBjhH4SHKnNzcK94ZfLRrrmLFhT/MWD8Olc18NZD+fUA47zObxVM86poLNWshMcJqvs+XMaQGfhw1o/4JxxTT1emdN9CSwPvt9nfbKJknauC4tvYHJWrv33ES9hVpnYTP82qt5yiP9ahRK562AqgsJFKf7EbzMPCJ05XAOW4eMnS4ZtY4yx5MCFNWcEuDtI8VS4urqio2eTrBvgoNs3tBrmJZCvgbjcZwStO3C4r5VL3XvExv8BhN01ZsIgjOdklmRMFBWbKBLJdbsCWDLPJBFZzo6lli7HYT4fcVZxo6W8uptCp5qwZ213I1DUDJV/cXciEuSeNbJsc4ovVhLPJo/MNMNgryNQAL69O7y3QuCuI64FquoLYAShXPUlm+ZCGwQvWr9claCMTXMZekWlWvr9hoLDWmAvEBz+vxgtkDkuHS22pZb+7+ssCa8st2rITXfzqsTb5VeSPX5h+B+T/K5j8gRxSKdkAAAAASUVORK5CYII="); }
  .label-courier-fallback { display:inline-flex; align-items:center; justify-content:center; width:16mm; height:10mm; border-radius:2mm; color:#fff; font-size:9px; font-weight:700; }
  .label-branch-code { font-size:14px; font-weight:700; margin-top:1mm; letter-spacing:0.5px; }
  .label-receipt-title { text-align:center; font-size:14.5px; font-weight:700; margin-top:0.5mm; }
  .label-meta-row { display:flex; justify-content:space-between; font-size:11.5px; margin-top:1mm; }
  .label-qr-wrap { text-align:center; margin-top:0.5mm; margin-bottom:0.5mm; }
  .label-qr { width:22mm; height:22mm; object-fit:contain; }
  .label-page hr { margin:1.3mm 0; border:none; border-top:1.2pt solid #000; }
  .label-boxes { display:flex; gap:2mm; }
  .label-box { flex:1; border:1.2pt solid #000; border-radius:1mm; padding:1.3mm; font-size:11px; line-height:1.32; }
  .label-box b { display:block; margin-bottom:0.6mm; font-size:11.5px; }
  .label-notes { border:1.2pt solid #000; border-radius:1mm; padding:1.3mm; margin-top:1.2mm; font-size:11px; line-height:1.3; }
  .label-notes b { display:block; margin-bottom:0.5mm; }
  .label-table { width:100%; border-collapse:collapse; font-size:10.5px; margin-top:1.2mm; }
  .label-table th, .label-table td { border:1.2pt solid #000; padding:0.9mm 0.6mm; text-align:center; }
  /* تنبيه الفحص — سطر واحد صغير ما ياخذ من الورقة، بس عريض غامق
     حتى يبقى مقروء على الطابعة الحرارية */
  .label-warn {
    border:1.2pt solid #000; border-radius:0.6mm; padding:0.7mm 1mm; margin-top:1.2mm;
    display:flex; align-items:center; justify-content:center; gap:1.2mm;
    white-space:nowrap; overflow:hidden;
  }
  .label-warn b {
    flex:none; font-size:7.4px; font-weight:700; color:#fff; background:#000;
    padding:0.5mm 1.1mm; border-radius:0.5mm;
  }
  .label-warn span {
    font-size:7.4px; font-weight:700; color:#000; line-height:1.25;
  }
  .label-page-num { text-align:center; font-size:8.5px; margin-top:0.8mm; }
  /* ⚠️ كل النصوص بوزن ٧٠٠ بالضبط — هذا هو وجه Tahoma العريض
     الحقيقي. ما نطلب ٨٠٠ ولا ٩٠٠ لأن ماكو وجه أعرض منه، وبعض
     المتصفحات تضيف "عريض صناعي" فوقه فيرجع يطيح الوضوح. */
  .label-page, .label-page * { color:#000 !important; font-weight:700 !important; }
  .label-page hr, .label-box, .label-notes, .label-warn, .label-table th, .label-table td { border-color:#000 !important; }
  .label-warn b { background:#000 !important; color:#fff !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .label-courier-fallback { background: #fff !important; border: 1px solid #000; }
  .label-page { page-break-after: always; }
  .label-page:last-child { page-break-after: auto; }
`;

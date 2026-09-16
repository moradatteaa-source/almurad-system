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
function generateQrDataUrl(value) {
  if (!value) return null;
  try {
    const qr = qrcode(0, "M");
    qr.addData(String(value));
    qr.make();
    const count = qr.getModuleCount();
    const cellSize = 6;
    const margin = 4; // هامش أبيض حول الكود (مطلوب لقراءة سليمة بأي سكانر)
    const size = (count + margin * 2) * cellSize;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect((col + margin) * cellSize, (row + margin) * cellSize, cellSize, cellSize);
        }
      }
    }
    return canvas.toDataURL("image/png");
  } catch (err) {
    console.warn("⚠️ تعذر توليد كود QR الوصل:", err.message);
    return null;
  }
}

// شركات التوصيل: نفس المفاتيح المستخدمة بكل النظام (send-shipping.html وغيره)
const COURIER_LOGO  = { waseet: "alwaseet-logo.png", prime: "prime-logo.png", jenni: "jenni-logo.png" };
const COURIER_LABEL = { waseet: "الوسيط",           prime: "برايم",          jenni: "Jenni" };
const COURIER_COLOR = { waseet: "#e63946",           prime: "#8e44ad",        jenni: "#e67e22" };

function escHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

// 🧾 بناء الليبل — نفس تصميم الوصل المعتمد بالضبط، شعار الشركة فقط يتغير
function buildLabelHTML(order, pageNum) {
  const company  = order.shippingCompany || "waseet";
  const logoFile = COURIER_LOGO[company]  || COURIER_LOGO.waseet;
  const label    = COURIER_LABEL[company] || "";
  const color    = COURIER_COLOR[company] || "#043B64";

  const today = new Date().toLocaleDateString("ar-IQ");
  // ✅ كود QR يُبنى من رقم الوصل نفسه لكل طلب (مو رقم ثابت بالكود) — يتغير
  // تلقائياً حسب رقم الوصل الفعلي المخزّن بقاعدة البيانات لهذا الطلب بالذات
  const qrValue = order.receiptNum || order.orderNumber || order.id;
  const qrDataUrl = generateQrDataUrl(qrValue);

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
      <div class="label-almurad"><img src="almurad-logo.png" alt="AL-MURAD"></div>
      ${qrDataUrl ? `<div class="label-qr-wrap"><img class="label-qr" src="${qrDataUrl}" alt="QR"></div>` : ""}
      <div class="label-courier">
        <img src="${logoFile}" alt="${escHtml(label)}"
             data-fallback-color="${color}" data-fallback-label="${escHtml(label)}">
        ${order.branchCode ? `<div class="label-branch-code">${escHtml(order.branchCode)}</div>` : ""}
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
        اسم الزبون: ${escHtml(order.code) || "غير معروف"}
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

    <div class="label-page-num">${pageNum}</div>
    </div>
  </div>`;
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

// 🔎 بحث عن طلب داخل شجرة ordersTest الكاملة (دالة نقية بدون فايربيس —
// الشجرة نفسها تُسحب مرة وحدة بالصفحة المستدعية عبر fetchAllOrdersTree)
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
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Tajawal','Segoe UI',sans-serif; background:#fff; direction: rtl; }
  .label-page { width:80mm; height:120mm; overflow:hidden; position:relative; color:#000; background:#fff; }
  .label-page-inner { width:80mm; box-sizing:border-box; padding:3mm; transform-origin: top right; }
  .label-top { display:flex; justify-content:space-between; align-items:center; }
  .label-almurad img { width:20mm; height:auto; }
  .label-courier { text-align:center; }
  .label-courier img { width:16mm; height:auto; }
  .label-courier-fallback { display:inline-flex; align-items:center; justify-content:center; width:16mm; height:10mm; border-radius:2mm; color:#fff; font-size:8px; font-weight:700; }
  .label-branch-code { font-size:8px; font-weight:700; margin-top:1mm; }
  .label-receipt-title { text-align:center; font-size:11px; font-weight:700; margin-top:0.5mm; }
  .label-meta-row { display:flex; justify-content:space-between; font-size:10px; margin-top:1mm; }
  .label-qr-wrap { text-align:center; margin-top:0.5mm; margin-bottom:0.5mm; }
  .label-qr { width:27mm; height:27mm; object-fit:contain; }
  .label-page hr { margin:1.5mm 0; border:none; border-top:1px solid #000; }
  .label-boxes { display:flex; gap:2mm; }
  .label-box { flex:1; border:1px solid #000; border-radius:1mm; padding:1.5mm; font-size:9px; line-height:1.55; }
  .label-box b { display:block; margin-bottom:0.8mm; font-size:9.5px; }
  .label-notes { border:1px solid #000; border-radius:1mm; padding:1.5mm; margin-top:1.5mm; font-size:9px; line-height:1.5; }
  .label-notes b { display:block; margin-bottom:0.5mm; }
  .label-table { width:100%; border-collapse:collapse; font-size:8.5px; margin-top:1.5mm; }
  .label-table th, .label-table td { border:1px solid #000; padding:1mm; text-align:center; }
  .label-page-num { text-align:center; font-size:10px; margin-top:2mm; }
  .label-page { page-break-after: always; }
  .label-page:last-child { page-break-after: auto; }
`;

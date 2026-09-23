// ════════════════════════════════════════════════════════
// 🖼️ ضغط صور المنتجات — أداة مشتركة
// نفس الكود يُستخدم من:
//   1) admin/index.html      (رفع صورة منتج مفرد)
//   2) admin/bulk-images.html (رفع بالجملة + ضغط الصور القديمة)
// ────────────────────────────────────────────────────────
// ⚠️ ليش انبنت (2026-09-23): صور المنتجات كانت تنرفع بحجمها الأصلي متل
// ما تجي من الكامرة أو تيليكرام — بين 1.7 و3.3 ميكابايت للصورة الوحدة.
// صفحة المتجر تعرض 8 منتجات بأول فتحة، يعني الزبون ينزّل حوالي 20
// ميكابايت قبل ما يشوف أي شي. على بيانات الموبايل هذا بطء قاتل، وأغلب
// الزبائن يتركون الصفحة قبل ما تفتح.
//
// الحل: نضغط الصورة بالمتصفح *قبل* الرفع، وننتج نسختين:
//   • full  — 1400 بكسل للضلع الأطول، للعرض بصفحة المنتج (~120 كيلوبايت)
//   • thumb — 500 بكسل، لكروت القائمة والبحث (~25 كيلوبايت)
// الكروت تستخدم المصغّرة، فأول فتحة تنزّل ~200 كيلوبايت بدل 20 ميكا.
//
// الصيغة: WebP إذا المتصفح يدعمه (أصغر بـ25-35% من JPEG بنفس الجودة)،
// وإلا JPEG. الشفافية تنضيع بالتحويل، فنحط خلفية بيضاء — وهذا مناسب
// لصور المنتجات (المتجر خلفيته بيضاء أصلاً).
// ════════════════════════════════════════════════════════
(function (global) {

  const FULL_SIDE  = 1400;  // الضلع الأطول لنسخة صفحة المنتج
  const THUMB_SIDE = 500;   // الضلع الأطول لنسخة الكارت
  const FULL_Q     = 0.82;
  const THUMB_Q    = 0.75;

  // نفحص دعم WebP مرة وحدة بس
  let _webpOk = null;
  function supportsWebp() {
    if (_webpOk !== null) return _webpOk;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      _webpOk = c.toDataURL('image/webp').indexOf('image/webp') === 5;
    } catch (e) { _webpOk = false; }
    return _webpOk;
  }

  const outMime = () => supportsWebp() ? 'image/webp' : 'image/jpeg';
  const outExt  = () => supportsWebp() ? 'webp' : 'jpg';

  // نقرا أبعاد الصورة بدون ما نحمّلها كاملة بالذاكرة مرتين
  function loadBitmap(blob) {
    if (global.createImageBitmap) {
      // أسرع وأخف بالذاكرة — مهم لما نضغط 200+ صورة وحدة ورا وحدة
      return createImageBitmap(blob).catch(() => loadViaImg(blob));
    }
    return loadViaImg(blob);
  }
  function loadViaImg(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('تعذر قراءة الصورة')); };
      img.src = url;
    });
  }

  function drawToBlob(bitmap, maxSide, quality) {
    const w0 = bitmap.width, h0 = bitmap.height;
    const scale = Math.min(1, maxSide / Math.max(w0, h0)); // ما نكبّر صورة صغيرة أبداً
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // خلفية بيضاء: WebP/JPEG ما يدعمون الشفافية بنفس الشكل، وبدونها
    // الأجزاء الشفافة تطلع سوداء
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);

    return new Promise(resolve => {
      canvas.toBlob(b => resolve(b), outMime(), quality);
    });
  }

  // ── الواجهة الرئيسية ──
  // تاخذ ملف صورة وترجّع { full, thumb, ext, before, after, ratio }
  // full/thumb عبارة عن Blob جاهز للرفع.
  async function compressProductImage(file) {
    const before = file.size;
    let bitmap;
    try {
      bitmap = await loadBitmap(file);
    } catch (e) {
      // ما قدرنا نقراها (ملف تالف أو صيغة غريبة) — نرجّع الأصل بدون ضغط
      // بدل ما نفشل الرفع كله
      return { full: file, thumb: file, ext: (file.name.split('.').pop() || 'jpg').toLowerCase(),
               before, after: before, ratio: 1, skipped: true, reason: e.message };
    }

    const [full, thumb] = await Promise.all([
      drawToBlob(bitmap, FULL_SIDE,  FULL_Q),
      drawToBlob(bitmap, THUMB_SIDE, THUMB_Q),
    ]);
    if (bitmap.close) bitmap.close(); // نفرّغ الذاكرة فوراً

    // لو الأصل أصغر من الناتج (صورة صغيرة أصلاً)، نخلي الأصل للنسخة الكاملة
    const useOriginal = full && full.size >= before;
    const finalFull = useOriginal ? file : full;

    return {
      full: finalFull,
      thumb: thumb || finalFull,
      ext: useOriginal ? (file.name.split('.').pop() || 'jpg').toLowerCase() : outExt(),
      thumbExt: outExt(),
      before,
      after: (finalFull ? finalFull.size : before) + (thumb ? thumb.size : 0),
      ratio: before ? ((finalFull ? finalFull.size : before) / before) : 1,
    };
  }

  const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' م.ب'
                     : b >= 1024    ? Math.round(b / 1024) + ' ك.ب'
                     : b + ' بايت';

  global.compressProductImage = compressProductImage;
  global.imageToolsFmtSize = fmtSize;
  global.IMAGE_TOOLS = { FULL_SIDE, THUMB_SIDE, FULL_Q, THUMB_Q, outExt, supportsWebp };
})(window);

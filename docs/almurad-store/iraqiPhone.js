// ════════════════════════════════════════════════════════
// 📞 تطبيع والتحقق من أرقام الهاتف العراقية
// ────────────────────────────────────────────────────────
// المشكلة: صفحة الهبوط والمتجر كانوا يقبلون أي شي طوله ١٠ خانات أو
// أكثر — فتوصل أرقام ناقصة، أو مكررة الأصفار، أو مكتوبة بصيغ مختلفة
// لنفس الرقم (07xx / 7xx / 009647xx / +9647xx). النتيجة: الموظف
// يتصل ما يرد، وقاعدة الزبائن تتكرر لأن نفس الرقم مخزون بصيغتين.
//
// الأرقام العراقية: مفتاح الشبكة ثلاث خانات (٠٧٠ ٠٧٣ ٠٧٤ ٠٧٥ ٠٧٦
// ٠٧٧ ٠٧٨ ٠٧٩) + سبع خانات. يعني ١١ خانة محلياً بالضبط، لا زيادة
// ولا نقصان. الصيغة الموحّدة اللي ننخزن بيها: +964 7XX XXX XXXX
// ════════════════════════════════════════════════════════
(function (global) {

  // مفاتيح الشبكات العراقية الفعلية (بدون الصفر): 70 73 74 75 76 77 78 79
  const VALID_PREFIXES = ['70', '71', '73', '74', '75', '76', '77', '78', '79'];

  // أرقام عربية/فارسية → لاتينية
  function toLatinDigits(str) {
    const ar = '٠١٢٣٤٥٦٧٨٩', fa = '۰۱۲۳۴۵۶۷۸۹';
    return String(str == null ? '' : str).split('').map(c => {
      let i = ar.indexOf(c); if (i >= 0) return String(i);
      i = fa.indexOf(c);     if (i >= 0) return String(i);
      return c;
    }).join('');
  }

  // يرجّع الخانات العشر بعد المفتاح الدولي (7XXXXXXXXX) أو null
  function coreDigits(input) {
    let d = toLatinDigits(input).replace(/\D/g, '');
    if (!d) return null;

    if (d.startsWith('00964')) d = d.slice(5);
    else if (d.startsWith('964')) d = d.slice(3);
    else if (d.startsWith('0'))  d = d.replace(/^0+/, '');

    // لازم تصير ١٠ خانات تبدي بـ7
    if (d.length !== 10) return null;
    if (d[0] !== '7') return null;
    if (!VALID_PREFIXES.includes(d.slice(0, 2))) return null;
    return d;
  }

  const isValidIraqiPhone = v => coreDigits(v) !== null;

  // الصيغة الموحّدة للتخزين: +9647XXXXXXXXX
  function normalizeIraqiPhone(v) {
    const d = coreDigits(v);
    return d ? '+964' + d : null;
  }

  // صيغة للعرض: 0770 123 4567
  function formatIraqiPhone(v) {
    const d = coreDigits(v);
    if (!d) return String(v == null ? '' : v);
    return '0' + d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6);
  }

  // رسالة تشرح شنو الغلط بالضبط — بدل "أدخل رقم صحيح"
  function iraqiPhoneError(v) {
    const raw = toLatinDigits(v).replace(/\D/g, '');
    if (!raw) return 'اكتب رقم هاتفك';
    let d = raw;
    if (d.startsWith('00964')) d = d.slice(5);
    else if (d.startsWith('964')) d = d.slice(3);
    else if (d.startsWith('0')) d = d.replace(/^0+/, '');

    if (d.length < 10) return `الرقم ناقص ${10 - d.length} خانة — لازم ١١ خانة مثل 07XXXXXXXXX`;
    if (d.length > 10) return `الرقم زايد ${d.length - 10} خانة — لازم ١١ خانة مثل 07XXXXXXXXX`;
    if (d[0] !== '7' || !VALID_PREFIXES.includes(d.slice(0, 2)))
      return 'الرقم لازم يبدي بـ 070 أو 073 أو 074 أو 075 أو 077 أو 078 أو 079';
    return 'رقم غير صحيح';
  }

  global.IraqiPhone = {
    VALID_PREFIXES, toLatinDigits, coreDigits,
    isValidIraqiPhone, normalizeIraqiPhone, formatIraqiPhone, iraqiPhoneError
  };
})(typeof window !== 'undefined' ? window : globalThis);

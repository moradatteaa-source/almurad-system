const { join } = require("path");

/**
 * ملاحظة مهمة (2026-09-16):
 * بيئة البناء (Build) وبيئة التشغيل (Runtime) على Render منفصلتان — أي شي
 * يتحمّل بمسار خارج مجلد المشروع (متل المسار الافتراضي $HOME/.cache) ما
 * ينتقل لبيئة التشغيل، فيطلع خطأ "Could not find Chrome" حتى لو التثبيت
 * نجح بمرحلة البناء. الحل الرسمي من توثيق Puppeteer نفسها: نخلي مجلد
 * تحميل المتصفح داخل مجلد المشروع نفسه (backend/.cache/puppeteer) حتى
 * ينتقل مع باقي الملفات بشكل طبيعي.
 * المرجع: https://pptr.dev/guides/configuration
 *
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};

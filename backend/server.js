/****************************************************
 * server.js
 * الوسيط بين الواجهة وخدمات الشحن
 ****************************************************/

import { updatePrimeStatusesFromFirebase } from "./services/shipping/primeService.js";
import * as primeService   from "./services/shipping/primeService.js";
import * as waseetService  from "./services/shipping/waseetService.js";
import { updateWaseetStatuses } from "./services/shipping/waseetService.js";
import * as jenniService   from "./services/shipping/jenniService.js";
import { updateJenniStatusesFromFirebase } from "./services/shipping/jenniService.js";
import { db } from "./firebase.js";
import { ref, get, update } from "firebase/database";
import express   from "express";
import fetch     from "node-fetch";
import cors      from "cors";
import cron      from "node-cron";
import path      from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import crypto    from "crypto";
import { PDFDocument, PDFDict, PDFArray, PDFRef, PDFRawStream } from "pdf-lib";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "../docs")));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ============================================================
// الصفحة الرئيسية
// ============================================================
app.get("/", (_, res) => res.send("✅ AlMurad Server is running"));

// ============================================================
// 📄 توليد PDF حقيقي بجودة الطباعة لوصولات الشحن (زر "مشاركة" بالموبايل)
// ────────────────────────────────────────────────────────
// ليش بالسيرفر ومو بالمتصفح مباشرة؟ لأن أي متصفح موبايل (آيفون/أندرويد)
// ما يسمح لكود الصفحة يبني ملف مباشر للمشاركة إلا إذا كان: (أ) صورة
// مصوّرة (html2canvas) — نتيجتها ضبابية دائماً ومحدودة السرعة بأعداد
// كبيرة، أو (ب) عبر نافذة الطباعة الأصلية للنظام — ما نقدر نفتحها
// ونشاركها مباشرة بضغطة وحدة بدون تدخل يدوي. الحل: نولّد الـPDF هنا
// بالسيرفر عبر Puppeteer (كروم حقيقي بالخلفية) اللي يفتح labels-print.html
// (نفس تصميم الليبل تماماً من labelTemplate.js) ويصدّرها PDF بنص عربي
// حقيقي حاد 100% (مو صورة) — بعدها الموبايل بس يجيب هذا الملف الجاهز
// ويشاركه فوراً. أسرع بكثير من التصوير بالموبايل حتى لمئات الوصولات،
// لأنه رندر حقيقي بالسيرفر مو تصوير DOM بجهاز ضعيف.
// ⚠️ ملاحظة مهمة (2026-09-19): كانت هذي متصفح كروم واحد "مشترك" يضل شغال
// باستمرار (بفضل نبضة إبقاء السيرفر صاحي كل 10 دقايق) ويعاد استخدامه لكل
// طلبات الطباعة. تبين إن هذا سبب عطل متقطع يزيد كل ما مر وقت أطول على
// تشغيل السيرفر: العشرات من دورات newPage/close على نفس المتصفح، فوق ذاكرة
// Render المجانية المحدودة (512 ميكا)، تراكم ضغط بالذاكرة تدريجياً لحد ما
// يصير فشل عشوائي (خصوصاً بالدفعات 5+ وصل، وأحياناً حتى بأقل من هذا).
// الحل: نشغّل متصفح كروم *جديد تماماً* لكل طلب طباعة ونقفله كامل بعدها —
// أبطأ بثواني قليلة من متصفح جاهز مسبقاً، بس كل طلب يبلش بذاكرة نظيفة
// 100% فينحل التدهور التدريجي نهائياً.
async function launchPrintBrowser() {
  return puppeteer.launch({
    headless: true,
    // ⚠️ مهم جداً — سبب فشل "طباعة الكل" (دفعة فيها وصولات كثيرة) بينما
    // وصل واحد يشتغل عادي: كروم الافتراضي يستخدم /dev/shm (ذاكرة مشتركة)
    // لتبديل البيانات بين تبويباته، وبيئات الاستضافة السحابية متل Render
    // تجيب حجم /dev/shm صغير جداً (64 ميكا بس أغلب الأحيان). لما الصفحة
    // فيها عدد كبير من الوصولات (كل وحدة فيها صورة QR + شعارات)، الذاكرة
    // المشتركة تخلص فجأة فينهار تبويب كروم (Page crashed) — وصل واحد ما
    // يوصلها أصلاً لأنه خفيف. الحل القياسي المعروف: --disable-dev-shm-usage
    // يخلي كروم يستخدم /tmp العادي بدل /dev/shm المحدود، فينحل الانهيار
    // نهائياً بغض النظر عن عدد الوصولات بالدفعة.
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
}

// 🔎 بحث عن طلب داخل شجرة ordersTest الكاملة — نفس منطق findOrderInTree
// بملف labelTemplate.js المشترك بالضبط، بس نسخة لسيرفر Node (ملف
// labelTemplate.js مكتوب كسكربت متصفح عادي، مو ES module، فما نقدر
// نستورده هنا مباشرة — الدالة نفسها قصيرة فما فيها ضرر تكرارها).
function findOrderInTreeServer(tree, orderId) {
  for (const status of Object.keys(tree)) {
    if (status === "_meta") continue;
    if (tree[status] && tree[status][orderId]) {
      return { ...tree[status][orderId], id: orderId, status };
    }
  }
  return null;
}

// ============================================================
// 📦 جلب بيانات الطلبات المطلوبة للطباعة — من السيرفر مباشرة، مو من
// داخل متصفح Puppeteer
// ────────────────────────────────────────────────────────
// ⚠️ السبب الحقيقي وراء فشل الطباعة المتقطع (بالدفعة وحتى بالطلب المفرد
// أحياناً): كانت صفحة labels-print.html تسوي اتصال فايربيس *مستقل* من
// داخل متصفح كروم المخفي نفسه (تحميل مكتبة فايربيس من gstatic.com +
// اتصال جديد لقاعدة البيانات + سحب شجرة ordersTest كاملة) لكل طلب طباعة
// وحدة — هذا اتصال شبكة إضافي بطيء وغير مضمون فوق اتصال السيرفر نفسه
// أصلاً، وبيئة Render المجانية المحدودة تخليه يبطئ أو ينقطع أحياناً
// فيفشل التوليد كامل. الحل: السيرفر (المتصل بفايربيس أصلاً وبثبات، نفس
// الاتصال المستخدم بالكرون) يجيب البيانات هو نفسه، وبعدين "يحقنها" جاهزة
// بصفحة الطباعة قبل ما تفتح — فما تحتاج الصفحة تتصل بأي شي بالإنترنت
// إطلاقاً غير تحميل الخط والصور المحلية.
// ============================================================
async function fetchOrdersForPrint({ logId, orderId, receiptNum }) {
  if (logId) {
    const logSnap = await get(ref(db, `shippingLogs/${logId}/orders`));
    if (!logSnap.exists()) return { error: "لا توجد طلبات بهذا السجل" };

    const stubs = Object.values(logSnap.val()).filter(s => s?.status === "success");
    if (!stubs.length) return { error: "لا توجد طلبات ناجحة بهذا السجل لطباعتها" };

    const treeSnap = await get(ref(db, "ordersTest"));
    const tree = treeSnap.exists() ? treeSnap.val() : {};

    const orders = [];
    for (const stub of stubs) {
      if (!stub?.orderId) continue;
      const full = findOrderInTreeServer(tree, stub.orderId);
      if (full) orders.push({ ...full, receiptNum: stub.receiptNum || full.receiptNum });
    }
    if (!orders.length) return { error: "تعذر إيجاد أي طلب من هذا السجل بقاعدة البيانات الحالية" };
    return { orders };
  }

  if (orderId) {
    const treeSnap = await get(ref(db, "ordersTest"));
    const tree = treeSnap.exists() ? treeSnap.val() : {};
    const full = findOrderInTreeServer(tree, orderId);
    if (!full) return { error: "الطلب غير موجود في قاعدة البيانات" };
    if (receiptNum) full.receiptNum = receiptNum;
    return { orders: [full] };
  }

  return { error: "لازم تمرر logId أو orderId" };
}

// ============================================================
// 📮 مخزن مؤقت بذاكرة السيرفر لتمرير بيانات الطلبات لصفحة الطباعة
// ────────────────────────────────────────────────────────
// ⚠️ جربنا أول شي حقن البيانات مباشرة بمتصفح Puppeteer عبر
// evaluateOnNewDocument، لكن تبين إنها ما توصل فعلياً لصفحة labels-print.html
// (مشكلة توقيت/تنفيذ داخل كروم نفسه ما قدرنا نضمنها). الحل الأوثق: نخزن
// بيانات كل طلب طباعة هنا برمز عشوائي قصير العمر، ونمرر الرمز بس بالرابط،
// وصفحة الطباعة تجيب البيانات بطلب بسيط لنفس السيرفر (سريع وموثوق لأنه
// نفس الاتصال اللي أصلاً ناجح بتحميل الصفحة والصور، عكس الاتصال الخارجي
// بفايربيس اللي كان يفشل أحياناً). كل رمز يُستخدم مرة وحدة بس ويُحذف فوراً،
// وفيه مهلة أمان 60 ثانية تحذفه تلقائياً حتى لو ما استخدم.
// ============================================================
const printDataStore = new Map();
function storePrintData(orders) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  printDataStore.set(token, orders);
  setTimeout(() => printDataStore.delete(token), 60000);
  return token;
}

// ============================================================
// 🗜️ توحيد العناصر المتكررة داخل ملف PDF النهائي (شعارات...الخ)
// ────────────────────────────────────────────────────────
// ⚠️ سبب تضخم الحجم مع زيادة عدد الوصولات: كروم (عبر Puppeteer) يصدّر
// كل صفحة PDF بشكل مستقل تقريباً، فينسخ الشعارات (وأي صورة/عنصر ثابت
// يتكرر بنفس الشكل بكل وصل) نسخة كاملة جديدة لكل صفحة بدل ما "يشاور"
// على نسخة وحدة مشتركة — يعني 41 وصل = 41 نسخة كاملة من نفس الشعار
// بالضبط بداخل الملف! هذا يخلي حجم الملف يكبر بشكل خطي مع عدد الوصولات
// حتى لو الشعار نفسه ما تغيّر إطلاقاً.
//
// الحل: بعد ما ياخذ Puppeteer الـPDF كامل، نفتحه هنا بمكتبة pdf-lib
// ونمشي على كل "الكائنات" (objects) الداخلية بالملف (صور، خطوط...الخ)،
// نسوي بصمة (hash) لمحتوى كل وحدة بالبايت، وأي وحدتين نفس البصمة (يعني
// نفس المحتوى تماماً) نخليهم "يشاورون" على نسخة وحدة بس (الأولى اللي
// لقيناها) ونحذف بقية النسخ المكررة تماماً من الملف. النتيجة: الشعار
// (أو أي عنصر متكرر ثابت) ينخزن مرة وحدة وحدة بغض النظر عن عدد الوصولات
// (لو صار 1000 وصل)، وحجم الملف يكبر بس بمقدار المعلومات الفعلية الجديدة
// بكل وصل (النص + رمز QR المختلف) — تماماً متل ما طلب المستخدم.
//
// ✅ آمن 100%: نفس البايتات بالضبط تنخزن، بس مرجع واحد أقل تكرار — ماكو
// أي تغيير على شكل أو جودة أي صورة أو خط بالملف النهائي.
// ============================================================
async function dedupPdfStreams(pdfBytes) {
  const pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const context = pdfDoc.context;

  const hashToCanonicalRef = new Map(); // بصمة المحتوى → أول مرجع (PDFRef) شفناه لهذا المحتوى
  const replacements = new Map();       // "رقم_الكائن رقم_الجيل" (للنسخ المكررة) → المرجع الأصلي
  const duplicateRefs = [];             // المراجع المكررة اللي لازم تنحذف بالنهاية

  const refKey = (r) => `${r.objectNumber} ${r.generationNumber}`;

  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue; // بس الكائنات اللي فيها محتوى ثنائي (صور/خطوط...)

    let bytes;
    try {
      bytes = obj.getContents();
    } catch {
      continue;
    }
    if (!bytes || !bytes.length) continue;

    const hash = crypto.createHash("sha1").update(bytes).digest("hex");
    const key = `${hash}|${bytes.length}`;

    if (hashToCanonicalRef.has(key)) {
      replacements.set(refKey(ref), hashToCanonicalRef.get(key));
      duplicateRefs.push(ref);
    } else {
      hashToCanonicalRef.set(key, ref);
    }
  }

  if (!replacements.size) return pdfBytes; // ماكو أي تكرار — نرجع الملف الأصلي متل ما هو

  // نمشي بعمق على كل قواميس/مصفوفات الملف (حتى المتداخلة داخل بعضها، متل
  // /Resources أو /XObject اللي غالباً تكون مضمّنة مباشرة بدون مرجع مستقل)
  // ونبدّل أي إشارة لكائن مكرر بإشارة للنسخة الأصلية بدلها
  function fixRefsDeep(container, seen) {
    if (seen.has(container)) return;
    seen.add(container);

    if (container instanceof PDFDict) {
      for (const key of container.keys()) {
        const val = container.get(key);
        if (val instanceof PDFRef) {
          const rep = replacements.get(refKey(val));
          if (rep) container.set(key, rep);
        } else if (val instanceof PDFDict || val instanceof PDFArray) {
          fixRefsDeep(val, seen);
        }
      }
    } else if (container instanceof PDFArray) {
      const size = container.size();
      for (let i = 0; i < size; i++) {
        const val = container.get(i);
        if (val instanceof PDFRef) {
          const rep = replacements.get(refKey(val));
          if (rep) container.set(i, rep);
        } else if (val instanceof PDFDict || val instanceof PDFArray) {
          fixRefsDeep(val, seen);
        }
      }
    }
  }

  const seen = new Set();
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict) fixRefsDeep(obj, seen);
    else if (obj instanceof PDFRawStream) fixRefsDeep(obj.dict, seen);
    else if (obj instanceof PDFArray) fixRefsDeep(obj, seen);
  }

  // حذف النسخ المكررة نهائياً بعد ما صارت كل الإشارات إلها تشاور على
  // النسخة الأصلية بدلها — ما راح تسبب أي مشكلة لأنه ماكو أي كائن ثاني
  // يشاور عليها بعد الآن
  for (const ref of duplicateRefs) context.delete(ref);

  return await pdfDoc.save();
}

// ============================================================
// 🗂️ مخزن الملفات الجاهزة (التجهيز المسبق) + طابور التوليد
// ────────────────────────────────────────────────────────
// المشكلة اللي يحلها: توليد ملف الـPDF يحتاج 10-15 ثانية (تشغيل متصفح كروم
// جديد + رسم الوصولات + تصدير)، والموظف كان ينتظرهن كل مرة يضغط طباعة.
// الحل: نبني الملف *قبل* ما يضغط — أول ما تنرفع دفعة للتوصيل، الواجهة
// تنادي /api/prewarm-labels-pdf وتمشي بحالها، والسيرفر يبني الملف
// بالخلفية ويخزنه هنا جاهز. لما الموظف يضغط طباعة، الملف ينرسل فوراً.
// إذا ما كان جاهز لأي سبب (السيرفر انطفى وصحى، انتهت المهلة...) ينبني
// بنفس الطريقة القديمة — يعني ماكو أي خطر على الشغل الحالي.
//
// الطابور (runExclusive) مهم: يمنع توليد ملفين بنفس الوقت، لأن ذاكرة
// Render المجانية (512 ميكا) ما تتحمل متصفحين كروم سوا.
// ============================================================
const PDF_CACHE_TTL = 30 * 60 * 1000; // صلاحية الملف الجاهز: 30 دقيقة
const PDF_CACHE_MAX = 12;             // أقصى عدد ملفات محفوظة بالذاكرة
const pdfCache = new Map();
const pdfInFlight = new Map();

function pdfCacheKey({ logId, orderId, receiptNum }) {
  return logId ? `log:${logId}` : `order:${orderId}:${receiptNum || ""}`;
}

function pdfCacheGet(key) {
  const entry = pdfCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > PDF_CACHE_TTL) { pdfCache.delete(key); return null; }
  return entry.buffer;
}

function pdfCacheSet(key, buffer) {
  pdfCache.set(key, { buffer, at: Date.now() });
  // Map تحفظ ترتيب الإضافة، فأول مفتاح هو أقدم ملف — نحذفه عند التجاوز
  while (pdfCache.size > PDF_CACHE_MAX) pdfCache.delete(pdfCache.keys().next().value);
}

let printQueue = Promise.resolve();
function runExclusive(task) {
  const result = printQueue.then(task, task);
  printQueue = result.then(() => {}, () => {});
  return result;
}

// ============================================================
// 🧩 توليد الـPDF بالتقسيم — كل 20 وصل بمتصفح منفصل، وبعدها ندمجهن
// ────────────────────────────────────────────────────────
// قبل، الدفعة كلها (80 وصل مثلاً) كانت تنرسم بصفحة وحدة بمتصفح واحد،
// فاستهلاك الذاكرة يكبر مع عدد الوصولات لحد ما ينهار السيرفر (هذا سبب
// "حدث خطأ بالانترنت" بالدفعات الكبيرة — الاتصال ينقطع من طرف السيرفر).
// هسه الذاكرة تبقى ثابتة مهما كان العدد: 20 وصل بس بأي لحظة، والمتصفح
// ينقفل كامل بعد كل مجموعة. الحجم النهائي ما يتأثر (قياس فعلي)، لأن خطوة
// dedupPdfStreams توحّد الخط والشعارات المتكررة بين المجموعات بعد الدمج.
// ============================================================
const LABELS_PER_CHUNK = 20;

async function mergePdfBuffers(parts) {
  if (parts.length === 1) return parts[0];
  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const pg of pages) out.addPage(pg);
  }
  return Buffer.from(await out.save());
}

async function renderChunkToPdf(orders, baseUrl) {
  let browser;
  try {
    browser = await launchPrintBrowser();
    const page = await browser.newPage();
    const token = storePrintData(orders);
    await page.goto(`${baseUrl}/labels-print.html?dataToken=${token}`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForFunction("window.__labelsReady === true", { timeout: 60000 });
    const errMsg = await page.evaluate(() => window.__labelsError || null);
    if (errMsg) throw new Error(errMsg);
    return Buffer.from(await page.pdf({
      width: "80mm",
      height: "120mm",
      printBackground: true,
      margin: { top: "0mm", bottom: "0mm", left: "0mm", right: "0mm" },
    }));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function buildLabelsPdf(orders, baseUrl) {
  // ✅ رقم الصفحة ينحسب على مستوى الدفعة كاملة قبل التقسيم، حتى يبقى
  // الترقيم متسلسل (1/80، 2/80...) بدل ما يبلش من جديد بكل مجموعة
  const total = orders.length;
  const numbered = orders.map((o, i) => ({ ...o, __pageNum: `${i + 1} / ${total}` }));

  const parts = [];
  for (let i = 0; i < numbered.length; i += LABELS_PER_CHUNK) {
    parts.push(await renderChunkToPdf(numbered.slice(i, i + LABELS_PER_CHUNK), baseUrl));
  }

  let pdfBuffer = await mergePdfBuffers(parts);

  try {
    const before = pdfBuffer.length;
    const deduped = Buffer.from(await dedupPdfStreams(pdfBuffer));
    if (deduped.length < before) {
      pdfBuffer = deduped;
      console.log(`🗜️ توحيد PDF: ${before} → ${deduped.length} بايت`);
    }
  } catch (dedupErr) {
    console.error("⚠️ فشل توحيد عناصر PDF (تم تجاهله وإرسال الملف الأصلي):", dedupErr.message);
  }

  return pdfBuffer;
}

// يرجّع الملف الجاهز إذا موجود، وإلا يبنيه. إذا نفس الملف مطلوب مرتين
// بنفس اللحظة (الموظف ضغط طباعة والتجهيز المسبق شغال) ما ننبيه مرتين —
// الطلب الثاني ينتظر نفس العملية الأولى ويوخذ نتيجتها.
function getOrBuildLabelsPdf({ logId, orderId, receiptNum, baseUrl }) {
  const key = pdfCacheKey({ logId, orderId, receiptNum });

  const cached = pdfCacheGet(key);
  if (cached) return Promise.resolve(cached);
  if (pdfInFlight.has(key)) return pdfInFlight.get(key);

  const job = runExclusive(async () => {
    const again = pdfCacheGet(key); // ممكن صار جاهز وإحنا بالطابور
    if (again) return again;

    const { orders, error } = await fetchOrdersForPrint({ logId, orderId, receiptNum });
    if (error) { const e = new Error(error); e.notFound = true; throw e; }

    const buffer = await buildLabelsPdf(orders, baseUrl);
    pdfCacheSet(key, buffer);
    console.log(`✅ ملف طباعة جاهز — ${key} (${orders.length} وصل، ${buffer.length} بايت)`);
    return buffer;
  }).finally(() => pdfInFlight.delete(key));

  pdfInFlight.set(key, job);
  return job;
}

app.get("/api/print-labels-data/:token", (req, res) => {
  const data = printDataStore.get(req.params.token);
  printDataStore.delete(req.params.token); // ✅ استخدام مرة وحدة بس
  if (!data) return res.status(404).json({ success: false, msg: "انتهت صلاحية بيانات الطباعة" });
  res.json(data);
});

// 🔥 التجهيز المسبق: تنادى من الواجهة أول ما تنرفع دفعة (أو عند فتح
// صفحة السجلات) وترجع فوراً بدون ما تنتظر — البناء يصير بالخلفية.
app.get("/api/prewarm-labels-pdf", (req, res) => {
  const { logId, orderId, receiptNum } = req.query;
  if (!logId && !orderId) {
    return res.status(400).json({ success: false, msg: "لازم تمرر logId أو orderId" });
  }

  const key = pdfCacheKey({ logId, orderId, receiptNum });
  if (pdfCacheGet(key)) return res.json({ success: true, status: "ready" });

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  getOrBuildLabelsPdf({ logId, orderId, receiptNum, baseUrl })
    .catch(err => console.error("⚠️ فشل التجهيز المسبق:", err.message));

  res.json({ success: true, status: "preparing" });
});

app.get("/api/print-labels-pdf", async (req, res) => {
  const { logId, orderId, receiptNum } = req.query;
  if (!logId && !orderId) {
    return res.status(400).json({ success: false, msg: "لازم تمرر logId أو orderId" });
  }

  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const cached = pdfCacheGet(pdfCacheKey({ logId, orderId, receiptNum }));
    const pdfBuffer = cached || await getOrBuildLabelsPdf({ logId, orderId, receiptNum, baseUrl });

    res.set("Content-Type", "application/pdf");
    res.set("X-Pdf-Source", cached ? "cache" : "fresh"); // للتشخيص: جاهز مسبقاً لو انبنى الآن
    res.send(pdfBuffer);
  } catch (err) {
    console.error("❌ print-labels-pdf:", err.message);
    res.status(err.notFound ? 404 : 500).json({ success: false, msg: err.message });
  }
});

// ============================================================
// 1) رفع طلب — وسيط أو برايم أو Jenni
// ============================================================
app.post("/api/create-order", async (req, res) => {
  try {
    const { orderId, shippingCompany, waseetCities, waseetRegions } = req.body;

    if (!orderId)         return res.status(400).json({ success: false, msg: "orderId مطلوب" });
    if (!shippingCompany) return res.status(400).json({ success: false, msg: "shippingCompany مطلوب" });
    if (!["waseet","prime","jenni"].includes(shippingCompany))
      return res.status(400).json({ success: false, msg: "shippingCompany: waseet أو prime أو jenni فقط" });

    console.log(`📦 رفع ${orderId} على ${shippingCompany}`);

    let result;
    if (shippingCompany === "prime") {
      result = await primeService.createPrimeOrderFromFirebase(orderId);
    } else if (shippingCompany === "jenni") {
      result = await jenniService.createJenniOrderFromFirebase(orderId);
    } else {
      result = await waseetService.sendOrdersToWaseet(
        [{ id: orderId }],
        waseetCities  || [],
        waseetRegions || []
      );
    }

    res.json(result);
  } catch (err) {
    console.error("❌ create-order:", err.message);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ============================================================
// 2) debug endpoints
// ============================================================
app.get("/debug/order/:id", async (req, res) => {
  const snap = await get(ref(db, `orders/${req.params.id}`));
  res.json(snap.exists() ? snap.val() : { exists: false });
});

app.get("/debug/waseet/:receipt", async (req, res) => {
  try {
    const token = await waseetService.loginToWaseet();
    if (!token) return res.json({ error: "Login failed" });
    const fd = new (await import("form-data")).default();
    fd.append("ids", req.params.receipt);
    const r = await fetch(`https://api.alwaseet-iq.net/v1/merchant/get-orders-by-ids-bulk?token=${token}`, { method: "POST", body: fd });
    res.json(await r.json());
  } catch (err) { res.json({ error: err.message }); }
});

app.get("/debug/run", async (_, res) => {
  try {
    await updateWaseetStatuses();
    await updatePrimeStatusesFromFirebase();
    await updateJenniStatusesFromFirebase();
    res.send("✅ تم التحديث");
  } catch (err) { res.send("❌ " + err.message); }
});

app.get("/debug/fix-stuck", async (_, res) => {
  try {
    const snap = await get(ref(db, "ordersTest/مثبت"));
    if (!snap.exists()) return res.send("✅ لا يوجد طلبات عالقة");

    const now = new Date().toISOString();
    const updates = {};
    let count = 0;

    Object.entries(snap.val()).forEach(([id, o]) => {
      if (id === "_meta" || !o.receiptNum) return;
      updates[`ordersTest/قيد التجهيز/${id}`] = {
        ...o, status: "قيد التجهيز", lastUpdateBy: "fix-script", lastStatusAt: now,
        statusHistory: { ...(o.statusHistory||{}), [encodeURIComponent("قيد التجهيز")]: { time: now, by: "fix-script" } }
      };
      updates[`ordersTest/مثبت/${id}`] = null;
      count++;
    });

    if (count > 0) {
      await update(ref(db), updates);
      await update(ref(db), {
        "ordersTest/قيد التجهيز/_meta/lastModified": Date.now(),
        "ordersTest/مثبت/_meta/lastModified":         Date.now()
      });
    }
    res.send(`✅ تم نقل ${count} طلب`);
  } catch (err) { res.send("❌ " + err.message); }
});

app.get("/myip", async (_, res) => {
  try { res.send(`IP: ${await (await fetch("https://ifconfig.me")).text()}`); }
  catch (err) { res.status(500).send("Error"); }
});

// ============================================================
// 3) Cron — كل 15 دقيقة
// ملاحظة (تحسين استهلاك فايربيس، 2026-09-16):
// كانت هذي تشتغل كل 5 دقائق على مدار الساعة (288 مرة باليوم) بدون أي علاقة
// بوجود نشاط فعلي، وكل تشغيلة كانت تسوي 6 قراءات كاملة لفروع الطلبات
// (updateWaseetStatuses وupdatePrimeStatusesFromFirebase كل وحدة تقرا نفس
// الفروع الثلاثة "قيد التجهيز/قيد التوصيل/راجع" لحالها). صار عدلين:
// 1) نقرا الفروع الثلاثة مرة وحدة هنا ونمررها للدالتين (نص القراءات: 3 بدل 6).
// 2) تباعد الكرون لكل 15 دقيقة بدل 5 (ثلث عدد التشغيلات باليوم).
// النتيجة: تقريباً سدس الاستهلاك السابق لهذا الجزء. تأخير تحديث حالة
// الشحن التلقائي يصير حتى 15 دقيقة بدل 5 — ما يأثر على أي عملية حية لأن
// هذا تحديث تلقائي بالخلفية بس، مو إجراء يسوّيه موظف وينتظر نتيجته فوراً.
// ============================================================
const STATUS_BRANCHES = ["قيد التجهيز", "قيد التوصيل", "راجع"];

async function fetchOrderStatusBranches() {
  const branches = {};
  for (const status of STATUS_BRANCHES) {
    const snap = await get(ref(db, `ordersTest/${status}`));
    branches[status] = snap.exists() ? snap.val() : null;
  }
  return branches;
}

let isUpdating = false;

cron.schedule("*/15 * * * *", async () => {
  if (isUpdating) { console.log("⚠️ Cron skipped — still running"); return; }
  isUpdating = true;
  const timeout = setTimeout(() => { isUpdating = false; }, 300000);
  try {
    const branches = await fetchOrderStatusBranches();
    await updateWaseetStatuses(branches);
    await updatePrimeStatusesFromFirebase(branches);
    await updateJenniStatusesFromFirebase(branches);
    console.log("✅ Cron done:", new Date().toISOString());
  } catch (err) {
    console.error("❌ Cron error:", err.message);
  } finally {
    clearTimeout(timeout);
    isUpdating = false;
  }
});

// ============================================================
// 4) إبقاء السيرفر صاحي دائماً (حل مشكلة "التأخير" بالطباعة من الموبايل)
// ────────────────────────────────────────────────────────
// خطة Render المجانية "تنيّم" السيرفر تلقائياً بعد 15 دقيقة بدون أي طلب
// وارد له، وبعدين أول طلب يوصله بعد النوم لازم ينتظر عدة دقائق لحد ما
// يصحى من جديد (هذا سبب تأخر الـ5 دقايق اللي صار بتجربة الموبايل).
// الحل بدون أي ترقية مدفوعة: نخلي السيرفر نفسه يرسل طلب بسيط لنفسه كل
// 10 دقايق (أقل من 15) — طالما فيه طلب وارد كل هالمدة، Render ما يعتبره
// خامل أبداً وما ينيّمه، فتصير الطباعة/المشاركة من الموبايل سريعة خلال
// ثواني دائماً، تمام متل ما صارت أول مرة لما كان صاحي فعلاً.
// ============================================================
const SELF_URL = process.env.RENDER_EXTERNAL_URL || "https://almurad.onrender.com";

cron.schedule("*/10 * * * *", async () => {
  try {
    await fetch(SELF_URL);
    console.log("💓 Keep-alive ping:", new Date().toISOString());
  } catch (err) {
    console.error("❌ Keep-alive ping failed:", err.message);
  }
});

// ============================================================
// تشغيل السيرفر
// ============================================================
app.listen(process.env.PORT || 3000, () =>
  console.log(`✅ Server on port ${process.env.PORT || 3000}`)
);
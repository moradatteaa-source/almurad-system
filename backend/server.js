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
let sharedBrowser = null;
async function getSharedBrowser() {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return sharedBrowser;
}

app.get("/api/print-labels-pdf", async (req, res) => {
  const { logId, orderId, receiptNum } = req.query;
  if (!logId && !orderId) {
    return res.status(400).json({ success: false, msg: "لازم تمرر logId أو orderId" });
  }

  const qs = logId
    ? `logId=${encodeURIComponent(logId)}`
    : `orderId=${encodeURIComponent(orderId)}${receiptNum ? `&receiptNum=${encodeURIComponent(receiptNum)}` : ""}`;
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const url = `${baseUrl}/labels-print.html?${qs}`;

  let page;
  try {
    const browser = await getSharedBrowser();
    page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForFunction("window.__labelsReady === true", { timeout: 30000 });

    const errMsg = await page.evaluate(() => window.__labelsError || null);
    if (errMsg) {
      return res.status(404).json({ success: false, msg: errMsg });
    }

    // ملاحظة مهمة (2026-09-16): نسخ Puppeteer الحديثة (v22+) صارت ترجع
    // page.pdf() كنوع Uint8Array بدل Buffer التقليدي. express ما يتعرف
    // على Uint8Array كملف ثنائي فيحوّله تلقائياً لنص JSON (شكل
    // {"0":37,"1":80,...} — كل بايت رقم منفصل!) بدل ما يرسله كملف حقيقي،
    // فيطلع حجم الملف كبير جداً وما ينفتح أصلاً كـPDF. الحل: نغلفه بـ
    // Buffer.from() صراحة قبل الإرسال حتى يتعرف عليه express كملف ثنائي.
    const pdfBuffer = Buffer.from(await page.pdf({
      width: "80mm",
      height: "120mm",
      printBackground: true,
      margin: { top: "0mm", bottom: "0mm", left: "0mm", right: "0mm" },
    }));

    res.set("Content-Type", "application/pdf");
    res.send(pdfBuffer);
  } catch (err) {
    console.error("❌ print-labels-pdf:", err.message);
    res.status(500).json({ success: false, msg: err.message });
  } finally {
    if (page) await page.close();
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
// تشغيل السيرفر
// ============================================================
app.listen(process.env.PORT || 3000, () =>
  console.log(`✅ Server on port ${process.env.PORT || 3000}`)
);
import { updatePrimeStatusesFromFirebase } from "./services/shipping/primeService.js";
import * as primeService from "./services/shipping/primeService.js";
import { db } from "./firebase.js";
import { ref, get, update } from "firebase/database";
import * as waseetService from "./services/shipping/waseetService.js";
import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import cors from "cors";
import cron from "node-cron";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ============================================================
// ثوابت
// ============================================================
const FINAL_STATUSES   = ["تم التسليم", "تم استلام الراجع"];
const ALLOWED_FROM     = ["", "مثبت", "قيد التجهيز", "قيد التوصيل", "راجع"];

// الحالات التي نتابع فيها طلبات الوسيط داخل ordersTest
const WASEET_WATCH_STATUSES = ["قيد التجهيز", "قيد التوصيل", "راجع"];

const TEST_STATUSES = [
  "تم التسليم","قيد المعالجة","جديد","مثبت",
  "قيد التجهيز","بانتظار البضاعة","قيد التوصيل",
  "راجع","تم استلام الراجع","رفض"
];

const waseetStatusMap = {
  "تم التسليم للزبون":            "تم التسليم",
  "تم الاستلام من قبل المندوب":  "قيد التوصيل",
  "ارجاع الى التاجر":            "راجع",
  "تم الارجاع الى التاجر":       "تم استلام الراجع",
  "في موقع فرز بغداد":           "قيد التوصيل"
};

// ============================================================
// Express
// ============================================================
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "../docs")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ============================================================
// مساعدات
// ============================================================
function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

function normalizeArabicStatus(str = "") {
  return str.toString().replace(/[^\u0600-\u06FF\s]/g, "").replace(/\s+/g, " ").trim();
}

/** حساب مسار Firebase للطلب بناءً على حالته */
function getPathForStatus(status, id) {
  if (!status || status === "جديد") return `orders/${id}`;
  return TEST_STATUSES.includes(status) ? `ordersTest/${status}/${id}` : `orders/${id}`;
}

// ============================================================
// الصفحة الرئيسية
// ============================================================
app.get("/", (req, res) => res.send("✅ AlMurad Server is running successfully!"));

// ============================================================
// 1) تسجيل الدخول → الوسيط
// ============================================================
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const formData = new FormData();
    formData.append("username", username);
    formData.append("password", password);

    const response = await fetch("https://api.alwaseet-iq.net/v1/merchant/login", {
      method: "POST", body: formData
    });
    res.json(await response.json());
  } catch (err) {
    console.error("❌ Login Error:", err);
    res.status(500).json({ status: false, msg: "Server Login Error" });
  }
});

// ============================================================
// 2) رفع طلب → الوسيط
// ============================================================
app.post("/api/create-order", async (req, res) => {
  try {
    const { token, ...payload } = req.body;
    res.json(await waseetService.createOrder(payload, token));
  } catch (err) {
    console.error("❌ create-order:", err);
    res.status(500).json({ status: false, msg: "Server Error" });
  }
});

// ============================================================
// 3) جلب الحالات → الوسيط
// ============================================================
app.post("/api/get-orders-status", async (req, res) => {
  try {
    const { token, ids } = req.body;
    const response = await fetch(
      `https://api.alwaseet-iq.net/v1/merchant/get-orders-by-ids-bulk?token=${token}`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `ids=${ids}` }
    );
    res.json(await response.json());
  } catch (err) {
    console.error("❌ get-orders-status:", err);
    res.status(500).json({ status: false, msg: "Server Error" });
  }
});

// ============================================================
// 4) IP السيرفر
// ============================================================
app.get("/myip", async (req, res) => {
  try {
    const r = await fetch("https://ifconfig.me");
    res.send(`🌍 Server Public IP: ${await r.text()}`);
  } catch (err) {
    res.status(500).send("Error fetching IP");
  }
});

// ============================================================
// 5) التحديث التلقائي للحالات → الوسيط
//    يسحب من ordersTest/{حالة} بدل orders
// ============================================================
async function autoUpdateStatuses() {
  console.log("🚀 AutoUpdate بدأ:", new Date().toLocaleString("en-US", { hour12: false }));

  try {
    // ✅ جلب الطلبات من المسارات التي نتابعها فقط (بدل كل orders)
    let allOrders = [];

    for (const status of WASEET_WATCH_STATUSES) {
      const snap = await get(ref(db, `ordersTest/${status}`));
      if (!snap.exists()) continue;

      Object.entries(snap.val()).forEach(([id, o]) => {
        if (id === "_meta") return;
        if (o.shippingCompany === "prime") return;  // برايم يتعامل معه primeService
        if (!o.receiptNum) return;
        if (FINAL_STATUSES.includes(o.status)) return;

        allOrders.push({
          id,
          ...o,
          _currentPath: `ordersTest/${status}/${id}`
        });
      });
    }

    if (allOrders.length === 0) {
      console.log("ℹ️ لا يوجد طلبات وسيط للمتابعة");
      return;
    }

    console.log(`📋 ${allOrders.length} طلب وسيط للمتابعة`);

    // تسجيل الدخول
    const token = await waseetService.loginToWaseet();
    if (!token) { console.log("❌ Waseet login failed"); return; }

    // IDs
    const orderIds = allOrders
      .map(o => String(o.receiptNum || "").trim())
      .filter(id => id && /^[0-9]+$/.test(id));

    const batches = chunk(orderIds, 25);
    let allResults = [];

    for (const batch of batches) {
      const response = await fetch(
        `https://api.alwaseet-iq.net/v1/merchant/get-orders-by-ids-bulk?token=${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `ids=${batch.join(",")}`
        }
      );
      const data = await response.json();
      if (data.status && Array.isArray(data.data)) allResults = allResults.concat(data.data);
    }

    const now = new Date().toISOString();
    let updateCount = 0;

    for (const item of allResults) {
      const cleanStatus = normalizeArabicStatus(item.status);
      const mapped      = waseetStatusMap[cleanStatus];

      if (!mapped) {
        console.log(`⏩ UNKNOWN waseet status: ${cleanStatus}`);
        continue;
      }

      // إيجاد الطلب بـ receiptNum
      const foundOrder = allOrders.find(
        o => String(o.receiptNum || "").trim() === String(item.id || "").trim()
      );
      if (!foundOrder) { console.log("❌ Order not found:", item.id); continue; }

      const currentStatus = (foundOrder.status || "").trim();

      // تحقق الحالات
      if (FINAL_STATUSES.includes(currentStatus))      { console.log("⛔ نهائية:", foundOrder.id); continue; }
      if (!ALLOWED_FROM.includes(currentStatus))       { console.log("⚠️ غير مسموح من:", currentStatus); continue; }
      if (currentStatus === mapped)                    continue; // نفس الحالة

      // ✅ بناء البيانات المحدثة
      const existingHistory = foundOrder.statusHistory || {};

      // تنظيف المفاتيح الرقمية القديمة
      const cleanedHistory = {};
      Object.entries(existingHistory).forEach(([k, v]) => {
        if (isNaN(Number(k))) cleanedHistory[k] = v;
      });
      cleanedHistory[encodeURIComponent(mapped)] = { time: now, by: "system-waseet" };

      const updatedOrder = {
        ...foundOrder,
        status:       mapped,
        waseetStatus: cleanStatus,
        lastStatusAt: now,
        lastUpdateBy: "system-waseet",
        statusHistory: cleanedHistory,
        _currentPath: undefined  // لا نحفظ هذا في Firebase
      };
      delete updatedOrder._currentPath;

      // ✅ نقل ذري بين المسارات
      const oldPath = foundOrder._currentPath;
      const newPath = getPathForStatus(mapped, foundOrder.id);

      const atomicUpdate = {
        [newPath]: updatedOrder,
        ...(newPath !== oldPath ? { [oldPath]: null } : {})
      };

      await update(ref(db), atomicUpdate);

      // تحديث meta
      const metaTime = Date.now();
      const oldBase  = oldPath.split("/").slice(0, 2).join("/");
      const newBase  = newPath.split("/").slice(0, 2).join("/");
      await update(ref(db), {
        [`${oldBase}/_meta/lastModified`]: metaTime,
        [`${newBase}/_meta/lastModified`]: metaTime
      });

      console.log(`✅ ${foundOrder.id}: ${currentStatus} → ${mapped}`);
      updateCount++;
    }

    console.log(updateCount > 0 ? `✅ تم تحديث ${updateCount} طلب` : "ℹ️ لا توجد تحديثات جديدة.");

  } catch (err) {
    console.error("❌ autoUpdateStatuses Error:", err);
  }
}

// ============================================================
// تعديل المخزون (بدون تغيير)
// ============================================================
async function adjustStock(orderId, newStatus) {
  try {
    const snap = await get(ref(db, `orders/${orderId}`));
    if (!snap.exists()) return;
    const order = snap.val();
    const products = [];

    function addProduct(name, qty, variants) {
      if (!name || qty <= 0) return;
      const variantKey = variants && Object.keys(variants).length > 0
        ? Object.entries(variants).map(([k, v]) => `${k} | ${v}`).join(" | ")
        : "بدون متغير";
      products.push({ name, qty, variants, variantKey });
    }

    addProduct(order.productName, Number(order.quantity), order.selectedVariants || {});
    if (Array.isArray(order.extraProducts))    order.extraProducts.forEach(p => addProduct(p.name, Number(p.qty), p.selectedVariants || {}));
    if (Array.isArray(order.productsDetailed)) order.productsDetailed.forEach(p => addProduct(p.name, Number(p.qty), p.variants || {}));

    for (const item of products) {
      const { name, qty, variants, variantKey } = item;
      const warehouseRef  = ref(db, `warehouse/${name}`);
      const warehouseSnap = await get(warehouseRef);
      if (!warehouseSnap.exists()) continue;

      const w         = warehouseSnap.val();
      const stock     = w.stock || {};
      const processed = w.processedOrders || {};
      const variantId = variantKey.replace(/\s+/g, "_");
      const unique    = `${orderId}_${name}_${variantId}`;

      let foundKey = null;
      const variantValues = Object.values(variants).map(v => v.trim().toLowerCase());
      for (const key of Object.keys(stock)) {
        const kNorm = key.toLowerCase();
        if (variantValues.filter(v => kNorm.includes(v)).length === variantValues.length && variantValues.length > 0) {
          foundKey = key; break;
        }
      }

      if (newStatus === "قيد التوصيل" && !processed[`deduct_${unique}`]) {
        if (foundKey && stock[foundKey] !== undefined) stock[foundKey] -= qty;
        else if (stock["إجمالي الكمية"] !== undefined) stock["إجمالي الكمية"] -= qty;
        processed[`deduct_${unique}`] = true;
      }

      if (newStatus === "تم استلام الراجع" && processed[`deduct_${unique}`] && !processed[`return_${unique}`]) {
        if (foundKey && stock[foundKey] !== undefined) stock[foundKey] += qty;
        else if (stock["إجمالي الكمية"] !== undefined) stock["إجمالي الكمية"] += qty;
        processed[`return_${unique}`] = true;
      }

      const totalQty = Object.values(stock).reduce((s, v) => s + (Number(v) || 0), 0);
      await update(warehouseRef, { stock, totalQty, processedOrders: processed, lastUpdate: new Date().toISOString() });
    }
  } catch (err) {
    console.error("❌ adjustStock:", err);
  }
}

// ============================================================
// 6) Cron: كل 5 دقائق
// ============================================================
let isUpdating = false;

cron.schedule("*/5 * * * *", async () => {
  console.log("⏱ Cron:", new Date().toISOString());
  if (isUpdating) { console.log("⚠️ Skipped — still running"); return; }

  isUpdating = true;
  const timeout = setTimeout(() => { isUpdating = false; console.log("⛔ Forced reset"); }, 300000);

  try {
    await autoUpdateStatuses();
    await updatePrimeStatusesFromFirebase();
    console.log("✅ All updates completed");
  } catch (err) {
    console.error("❌ Cron error:", err);
  } finally {
    clearTimeout(timeout);
    isUpdating = false;
  }
});

// ============================================================
// 7) APIs إضافية
// ============================================================
app.post("/api/update-stock-on-status", async (req, res) => res.json({ success: true }));

app.get("/debug/order/:id", async (req, res) => {
  const snap = await get(ref(db, `orders/${req.params.id}`));
  res.json(snap.exists() ? snap.val() : { exists: false });
});

app.get("/debug/waseet/:receipt", async (req, res) => {
  try {
    const token = await waseetService.loginToWaseet();
    if (!token) return res.json({ error: "Login failed" });
    const response = await fetch(
      `https://api.alwaseet-iq.net/v1/merchant/get-orders-by-ids-bulk?token=${token}`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `ids=${req.params.receipt}` }
    );
    res.json(await response.json());
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get("/debug/run", async (req, res) => {
  try {
    await autoUpdateStatuses();
    res.send("🔄 autoUpdateStatuses Done");
  } catch (err) {
    res.send("❌ " + err.message);
  }
});

// ============================================================
// 8) رفع طلب → برايم (يعمل مع primeService المحدّث)
// ============================================================
app.post("/api/create-order-prime/:id", async (req, res) => {
  try {
    res.json(await primeService.createPrimeOrderFromFirebase(req.params.id));
  } catch (err) {
    console.error("❌ Prime:", err);
    res.status(500).json({ success: false });
  }
});

app.get("/api/test-prime", async (req, res) => {
  try {
    const token = await primeService.loginToPrime();
    if (!token) return res.json({ success: false, msg: "Prime login failed" });

    const shipmentData = [{
      custReceiptNoOri: 0, district: 0, haveReturnItems: "N",
      locationDetails: "Baghdad Test Address", merchantLoginId: "07808197448",
      productInfo: "Test Product*1", qty: 1, receiptAmtIqd: 25000,
      receiverHp1: "07800000000", receiverName: "Test Customer",
      senderId: 43825, senderSystemCaseIdWithCharacters: "MRDTEST" + Date.now(), state: "BGD"
    }];

    const response = await fetch("https://www.prime-iq.com/myp/webapi/external/create-shipments/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(shipmentData)
    });
    res.json(await response.json());
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get("/cron-update", async (req, res) => {
  try {
    await autoUpdateStatuses();
    await updatePrimeStatusesFromFirebase();
    res.send("✅ Update done");
  } catch (err) {
    res.send("❌ " + err.message);
  }
});

// ============================================================
// 🔧 إصلاح الطلبات العالقة في مثبت (لها receiptNum لكن لم تنتقل)
// ============================================================
app.get("/debug/fix-waseet-stuck", async (req, res) => {
  try {
    const snap = await get(ref(db, "ordersTest/مثبت"));
    if (!snap.exists()) return res.send("✅ لا يوجد طلبات عالقة");

    const data = snap.val();
    const updates = {};
    let count = 0;
    const now = new Date().toISOString();

    for (const [id, o] of Object.entries(data)) {
      if (id === "_meta") continue;
      if (!o.receiptNum || String(o.receiptNum).trim() === "") continue;

      const updatedOrder = {
        ...o,
        status: "قيد التجهيز",
        lastUpdateBy: "fix-script",
        lastStatusAt: now,
        statusHistory: {
          ...(o.statusHistory || {}),
          [encodeURIComponent("قيد التجهيز")]: { time: now, by: "fix-script" }
        }
      };

      updates[`ordersTest/قيد التجهيز/${id}`] = updatedOrder;
      updates[`ordersTest/مثبت/${id}`] = null;
      count++;
    }

    if (count > 0) {
      await update(ref(db), updates);
      await update(ref(db), {
        "ordersTest/قيد التجهيز/_meta/lastModified": Date.now(),
        "ordersTest/مثبت/_meta/lastModified": Date.now()
      });
    }

    res.send(`✅ تم نقل ${count} طلب من مثبت → قيد التجهيز`);
  } catch (err) {
    res.send("❌ خطأ: " + err.message);
  }
});

// ============================================================
// تشغيل السيرفر
// ============================================================
app.listen(process.env.PORT || 3000, () =>
  console.log(`✅ Server running on port ${process.env.PORT || 3000}`)
);
app.get("/test-prime/:id", async (req, res) => {
  try {
    const result = await primeService.createPrimeOrderFromFirebase(req.params.id);
    res.json(result);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});
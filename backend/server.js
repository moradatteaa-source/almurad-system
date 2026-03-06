import { updatePrimeStatusesFromFirebase } from "./services/shipping/primeService.js";
import * as primeService from "./services/shipping/primeService.js";
import { db } from "./firebase.js";
import { ref, get, update } from "firebase/database";
// import * as primeService from "./services/shipping/primeService.js";
import * as waseetService from "./services/shipping/waseetService.js";
import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import cors from "cors";
import cron from "node-cron";

// ------------------------------
// 🟦 Firebase
// ------------------------------


// ------------------------------
// 🟦 وارد من deliveryService.js (اللازم فقط)
// ------------------------------
const waseetStatusMap = {
  "تم التسليم للزبون": "تم التسليم",
  "تم الاستلام من قبل المندوب": "قيد التوصيل",
  "ارجاع الى التاجر": "راجع",
  "تم الارجاع الى التاجر": "تم استلام الراجع",
  "في موقع فرز بغداد": "قيد التوصيل"
};

// =======================================================
// 🔥 Firebase Initialization
// =======================================================




// =======================================================
// 🚀 Express App
// =======================================================
   
const app = express();
app.use(cors());
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// يخدم مجلد docs الموجود بمستوى أعلى من backend
app.use(express.static(path.join(__dirname, "../docs")));app.use(express.urlencoded({ extended: true }));
app.use(express.json());


// =======================================================
// 🟢 الصفحة الرئيسية
// =======================================================
app.get("/", (req, res) => {
  res.send("✅ AlMurad Server is running successfully!");
});


// =======================================================
// 🟢 1) تسجيل الدخول → الوسيط
// =======================================================
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log("📩 Login request received:", { username, password });

    const formData = new FormData();
    formData.append("username", username);
    formData.append("password", password);

    const response = await fetch("https://api.alwaseet-iq.net/v1/merchant/login", {
      method: "POST",
      body: formData,
    });

    const data = await response.json();
    console.log("📩 Login response:", data);
    res.json(data);
  } catch (err) {
    console.error("❌ Login Error:", err);
    res.status(500).json({ status: false, msg: "Server Login Error" });
  }
});



// =======================================================
// 🟢 رفع الطلب → الوسيط (من خلال service)
// =======================================================
app.post("/api/create-order", async (req, res) => {
  try {

    const { token, ...payload } = req.body;

    const result = await waseetService.createOrder(payload, token);

    res.json(result);

  } catch (err) {
    console.error("❌ Error creating order:", err);
    res.status(500).json({ status: false, msg: "Server Error" });
  }
});

// =======================================================
// 🟢 3) جلب الحالات → الوسيط
// =======================================================
app.post("/api/get-orders-status", async (req, res) => {
  try {
    const { token, ids } = req.body;
    console.log("🔄 Fetching order statuses:", ids);

    const response = await fetch(
      `https://api.alwaseet-iq.net/v1/merchant/get-orders-by-ids-bulk?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `ids=${ids}`,
      }
    );

    const data = await response.json();
    console.log("✅ Status response received");

    res.json(data);
  } catch (err) {
    console.error("❌ Error fetching statuses:", err);
    res.status(500).json({ status: false, msg: "Server Error in get-orders-status" });
  }
});


// =======================================================
// 🟢 4) معرفة IP السيرفر
// =======================================================
app.get("/myip", async (req, res) => {
  try {
    const response = await fetch("https://ifconfig.me");
    const ip = await response.text();
    res.send(`🌍 Server Public IP: ${ip}`);
  } catch (err) {
    console.error("❌ Error fetching IP:", err);
    res.status(500).send("Error fetching IP");
  }
});

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// =======================================================
// 🔄 5) الدالة الأساسية: التحديث التلقائي للحالات
// =======================================================
async function autoUpdateStatuses() {
  console.log("🚀 AutoUpdate بدأ يشتغل الآن:", new Date().toLocaleString("en-US", { hour12: false }));

  try {
    console.log("⏳ Running Auto Status Update...");

    // 1) جلب كل الطلبات
    const snap = await get(ref(db, "orders"));
    if (!snap.exists()) return console.log("❌ No orders found");

    const allOrders = Object.entries(snap.val()).map(([id, o]) => ({ id, ...o }));

    // نأخذ فقط الطلبات اللي بيها receiptNum
const FINAL_STATUSES = ["تم التسليم", "تم استلام الراجع"];

const sent = allOrders.filter(o =>
  o.receiptNum &&
  !FINAL_STATUSES.includes(o.status)
);
    if (sent.length === 0) return console.log("❌ No sent orders");

    // 2) تسجيل الدخول
const token = await waseetService.loginToWaseet();
    if (!token) return console.log("❌ Login failed");

    // IDs
const orderIds = sent
  .map(o => String(o.receiptNum || "").trim())
  .filter(id => id !== "" && /^[0-9]+$/.test(id));

const batches = chunk(orderIds, 25);

let allResults = [];

    // 3) جلب الحالات من الوسيط
for (const batch of batches) {
  const ids = batch.join(",");

 const response = await fetch(
  `https://api.alwaseet-iq.net/v1/merchant/get-orders-by-ids-bulk?token=${token}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `ids=${ids}`,
  }
);


  const data = await response.json();

  if (data.status && Array.isArray(data.data)) {
    allResults = allResults.concat(data.data);
  }
}


// 4) تحديث كل حالة داخل Firebase (مع التحقق الصحيح)
let updateCount = 0;

for (const item of allResults) {

  // تنظيف الحالة القادمة من الوسيط
function normalizeArabicStatus(str = "") {
  return str
    .toString()
    .replace(/[^\u0600-\u06FF\s]/g, "") // حذف أي رموز خفية
    .replace(/\s+/g, " ")
    .trim();
}

const cleanStatus = normalizeArabicStatus(item.status);

  // إذا حالة غير موجودة بالمابنغ → تجاهل
  if (!cleanStatus || !waseetStatusMap[cleanStatus]) {
    console.log(`⏩ UNKNOWN | receiptNum: ${item.id} | status: ${cleanStatus}`); 
    continue;
  }

  // الحالة المحوّلة داخل النظام
const mapped = waseetStatusMap[cleanStatus];
const waseetRawStatus = cleanStatus;

  // 🔍 البحث داخل شجرة Firebase حسب receiptNum
  let foundOrder = null;
  let foundKey = null;

  for (const o of allOrders) {
    const fb = String(o.receiptNum || "").trim();
    const ws = String(item.id || "").trim();

    if (fb === ws) {
      foundOrder = o;
      foundKey = o.id;
      break;
    }
  }

  if (!foundOrder) {
    console.log("❌ Order NOT FOUND in Firebase:", item.id);
    continue;
  }
  const isSameStatus = foundOrder.status === mapped;
const fromWaseet = true; // لأن هذا التحديث جاي من الوسيط


  // الحالات اللي نسمح نتحرك منها
  const allowedFromStatuses = ["", "مثبت", "قيد التجهيز", "قيد التوصيل", "راجع"];

  // الحالات النهائية المقفلة
  const lockedStatuses = ["تم التسليم", "تم استلام الراجع"];

  // ❌ إذا حالة نهائية → لا تحدث
  if (lockedStatuses.includes(foundOrder.status)) {
    console.log("⛔ Ignored — locked final status:", foundOrder.status);
    continue;
  }

  // ❌ إذا الحالة الحالية غير مسموح نتحرك منها → لا تحدث
  if (!allowedFromStatuses.includes(foundOrder.status)) {
    console.log("⚠️ Skip — not allowed from-status:", foundOrder.status);
    continue;
  }

  // ❌ إذا الحالة نفسها → لا تحدث
if (isSameStatus) {
  continue;
}



  // تحديث المخزون
const now = new Date().toISOString();


const orderRef = ref(db, `orders/${foundKey}`);
const orderSnap = await get(orderRef);

// تنظيف history القديمة (إزالة الأرقام)
let cleanedHistory = {};

if (orderSnap.exists() && orderSnap.val().statusHistory) {
  for (const key in orderSnap.val().statusHistory) {
    if (isNaN(Number(key))) {
      cleanedHistory[key] = orderSnap.val().statusHistory[key];
    }
  }
}

// إضافة الحالة الحالية باسمها
cleanedHistory[mapped] = {
  time: now,
  by: "system-waseet"
};

await update(orderRef, {
  status: mapped,
  waseetStatus: waseetRawStatus,
  lastStatusAt: now,
  lastUpdateBy: "system-waseet",
  statusHistory: cleanedHistory
});


await adjustStock(foundKey, mapped);


updateCount++;


}

if (updateCount === 0) {
  console.log("ℹ️ لا توجد تحديثات جديدة.");
} else {
  console.log(`✅ Auto Updated: ${updateCount} orders`);
}




  } catch (err) {
    console.error("❌ Auto Update Error:", err);
  }
}
// =======================================================
// 🟢 دالة تحديث المخزون عند تغيير الحالة
// =======================================================
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

    // المنتج الرئيسي
    addProduct(order.productName, Number(order.quantity), order.selectedVariants || {});

    // المنتجات الإضافية
    if (Array.isArray(order.extraProducts)) {
      order.extraProducts.forEach(p => {
        addProduct(p.name, Number(p.qty), p.selectedVariants || {});
      });
    }

    // المنتجات التفصيلية
    if (Array.isArray(order.productsDetailed)) {
      order.productsDetailed.forEach(p => {
        addProduct(p.name, Number(p.qty), p.variants || {});
      });
    }

    for (const item of products) {
      const { name, qty, variants, variantKey } = item;

      const warehouseRef = ref(db, `warehouse/${name}`);
      const warehouseSnap = await get(warehouseRef);
      if (!warehouseSnap.exists()) continue;

      const w = warehouseSnap.val();
      const stock = w.stock || {};
      const processed = w.processedOrders || {};

      const variantId = variantKey.replace(/\s+/g, "_");
      const unique = `${orderId}_${name}_${variantId}`;

      let foundKey = null;
      const variantValues = Object.values(variants).map(v => v.trim().toLowerCase());

      for (const key of Object.keys(stock)) {
        const kNorm = key.toLowerCase();
        const matches = variantValues.filter(v => kNorm.includes(v)).length;
        if (matches === variantValues.length && matches > 0) {
          foundKey = key;
          break;
        }
      }

      // 🔽 الخصم
      if (newStatus === "قيد التوصيل" && !processed[`deduct_${unique}`]) {
        if (foundKey && stock[foundKey] !== undefined) {
          stock[foundKey] -= qty;
        } else if (stock["إجمالي الكمية"] !== undefined) {
          stock["إجمالي الكمية"] -= qty;
        }
        processed[`deduct_${unique}`] = true;
      }

      // 🔼 الإرجاع
      if (newStatus === "تم استلام الراجع" && processed[`deduct_${unique}`] && !processed[`return_${unique}`]) {
        if (foundKey && stock[foundKey] !== undefined) {
          stock[foundKey] += qty;
        } else if (stock["إجمالي الكمية"] !== undefined) {
          stock["إجمالي الكمية"] += qty;
        }
        processed[`return_${unique}`] = true;
      }

      // إعادة الحساب
      let totalQty = 0;
      for (const val of Object.values(stock)) totalQty += Number(val) || 0;

      await update(warehouseRef, {
        stock,
        totalQty,
        processedOrders: processed,
        lastUpdate: new Date().toISOString()
      });
    }

  } catch (err) {
    console.error("❌ خطأ تعديل المخزون:", err);
  }
}



// =======================================================
// 🔁 6) Scheduler: تشغيل كل دقيقة بدون Overlapping
// =======================================================

let isUpdating = false;

cron.schedule("*/5 * * * *", async () => {

  console.log("⏱ Cron running:", new Date().toISOString());

  if (isUpdating) {
    console.log("⚠️ Skipped — update still running...");
    return;
  }

  isUpdating = true;

  try {

    // ❌ إيقاف الوسيط
    // await autoUpdateStatuses();

    // 🟣 تحديث برايم فقط
    await updatePrimeStatusesFromFirebase();

    console.log("✅ Prime update completed");

  } catch (err) {
    console.error("❌ Error inside cron:", err);
  }

  isUpdating = false;

});
// =======================================================
// 🟢 8) API خارجي لتحديث المخزن من صفحة التفاصيل
// =======================================================
app.post("/api/update-stock-on-status", async (req, res) => {
  try {
    const { orderId, status } = req.body;

    if (!orderId || !status) {
      return res.json({ success: false, msg: "Missing data" });
    }

    console.log("🔥 API استلم طلب تحديث مخزن:", orderId, status);

    await adjustStock(orderId, status);

    res.json({ success: true });

  } catch (err) {
    console.error("❌ Error in update-stock-on-status:", err);
    res.json({ success: false, msg: "Server error" });
  }
});

app.get("/debug/order/:id", async (req, res) => {
  const id = req.params.id;
  const snap = await get(ref(db, `orders/${id}`));
  if (!snap.exists()) return res.json({ exists: false });
  res.json(snap.val());
});
// 🟢 Debug: جلب حالة وصل واحد فقط من الوسيط
app.get("/debug/waseet/:receipt", async (req, res) => {
  try {
    const receipt = req.params.receipt;
const token = await waseetService.loginToWaseet();
    if (!token) return res.json({ error: "Login failed" });

    const response = await fetch(
      `https://api.alwaseet-iq.net/v1/merchant/get-orders-by-ids-bulk?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `ids=${receipt}`,
      }
    );

    const data = await response.json();
    return res.json(data);

  } catch (err) {
    return res.json({ error: err.message });
  }
});
// 🟢 Debug: تشغيل التحديث اليدوي للحالات
app.get("/debug/run", async (req, res) => {
  try {
    await autoUpdateStatuses();
    res.send("🔄 Manual update executed: AutoUpdateStatuses Done");
  } catch (err) {
    res.send("❌ Error: " + err.message);
  }
});

// =======================================================
// 🚀 7) تشغيل السيرفر
// =======================================================
app.listen(process.env.PORT || 3000, () =>
  console.log(`✅ Server running on port ${process.env.PORT || 3000}`)
);
// =======================================================
// 🟣 رفع الطلب → برايم
// =======================================================

app.post("/api/create-order-prime/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const result = await primeService.createPrimeOrderFromFirebase(id);
    res.json(result);
  } catch (err) {
    console.error("❌ Prime Error:", err);
    res.status(500).json({ success: false });
  }
});



app.get("/api/test-prime", async (req, res) => {
  try {

const token = await primeService.loginToPrime();    if (!token) {
      return res.json({ success: false, msg: "Prime login failed" });
    }

    const shipmentData = [
      {
        custReceiptNoOri: 0,
        district: 0,
        haveReturnItems: "N",
        locationDetails: "Baghdad Test Address",
        merchantLoginId: "07808197448",
        productInfo: "Test Product*1",
        qty: 1,
        receiptAmtIqd: 25000,
       receiverHp1: "07800000000",
        receiverName: "Test Customer",
        senderId: 43825,
        senderSystemCaseIdWithCharacters: "MRDTEST" + Date.now(),
        state: "BGD"
      }
    ];

    console.log("🚀 TEST PAYLOAD:");
    console.log(JSON.stringify(shipmentData, null, 2));

    const response = await fetch(
      "https://www.prime-iq.com/myp/webapi/external/create-shipments/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify(shipmentData)
      }
    );

    const result = await response.json();

    console.log("📦 PRIME RESPONSE:", result);

    res.json(result);

  } catch (err) {
    console.log("❌ ERROR:", err);
    res.json({ success: false, error: err.message });
  }

});
app.get("/cron-update", async (req, res) => {

  console.log("🔄 External cron triggered");

  try {

    await autoUpdateStatuses();
    await updatePrimeStatusesFromFirebase();

    res.send("Update done");

  } catch (err) {

    res.send("Error: " + err.message);

  }

});
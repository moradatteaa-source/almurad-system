import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import cors from "cors";
import cron from "node-cron";

// ------------------------------
// 🟦 Firebase
// ------------------------------
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, update } from "firebase/database";

// ------------------------------
// 🟦 وارد من deliveryService.js (اللازم فقط)
// ------------------------------
import { waseetStatusMap, loginToWaseet } from "../docs/deliveryService.js";


// =======================================================
// 🔥 Firebase Initialization
// =======================================================
const firebaseConfig = {
  apiKey: "AIzaSyDtEJYJrmyP45qS2da8Cuc6y6Jv5VD0Uhc",
  authDomain: "almurad-system.firebaseapp.com",
  databaseURL: "https://almurad-system-default-rtdb.firebaseio.com/",
  projectId: "almurad-system",
  storageBucket: "almurad-system.appspot.com",
  messagingSenderId: "911755824405",
  appId: "1:911755824405:web:2bfbd18ddcf038ca48ad1c"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);


// =======================================================
// 🚀 Express App
// =======================================================

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
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
// 🟢 2) رفع الطلب → الوسيط
// =======================================================
app.post("/api/create-order", async (req, res) => {
  try {
    const { token, ...payload } = req.body;
    console.log("📦 Create order request received:", payload);

    const formData = new FormData();
    for (const key in payload) formData.append(key, payload[key] ?? "");

    const url = `https://api.alwaseet-iq.net/v1/merchant/create-order?token=${token}`;
    const response = await fetch(url, { method: "POST", body: formData });

    const data = await response.json();
    console.log("📦 Order response:", data);

    res.json(data);
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
    const sent = allOrders.filter(o => o.receiptNum);
    if (sent.length === 0) return console.log("❌ No sent orders");

    // 2) تسجيل الدخول
    const token = await loginToWaseet();
    if (!token) return console.log("❌ Login failed");

    // IDs
    const ids = sent.map(o => o.receiptNum).join(",");

    // 3) جلب الحالات من الوسيط
    const response = await fetch("https://almurad.onrender.com/api/get-orders-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ids })
    });

    const data = await response.json();
    if (!data.status) return console.log("❌ Waseet status failed");

  // 4) تحديث كل حالة داخل Firebase (مع احتساب المتغير فقط)
// 4) تحديث فقط الطلبات ذات الحالات المحددة
let updateCount = 0;

// الحالات التي نعمل عليها فقط
const allowedStatuses = ["قيد التجهيز", "قيد التوصيل", "راجع"];

for (const item of data.data) {

  // تنظيف الحالة القادمة من الوسيط
  const cleanStatus = item.status.replace(/\s+/g, " ").trim();

  // التأكد أن الحالة موجودة داخل المابنغ
  if (!waseetStatusMap[cleanStatus]) {
    console.log(`⏩ UNKNOWN | receiptNum: ${item.id} | status: ${cleanStatus}`);
    continue;
  }

  // الحالة المحوّلة داخل النظام
  const mapped = waseetStatusMap[cleanStatus];

  // جلب الطلب من الفايربيس
  const order = sent.find(o => Number(o.receiptNum) === Number(item.id));
  if (!order) {
    console.log("❌ Order not found in Firebase:", item.id);
    continue;
  }

  // العمل فقط على الحالات 3 (قيد التجهيز, قيد التوصيل, راجع)
  if (!allowedStatuses.includes(order.status)) {
    console.log(`⛔ Skipped — status not allowed: ${order.status}`);
    continue;
  }

  // عدم التحديث للحالات النهائية
  const lockedStatuses = ["تم التسليم", "تم استلام الراجع"];
  if (lockedStatuses.includes(order.status)) {
    console.log("⛔ Ignored — locked final status:", order.status);
    continue;
  }

  // إذا الحالة نفسها لا نحدث
  if (order.status === mapped) continue;

  // تحديث المخزون
  await adjustStock(order.id, mapped);

  // تحديث Firebase
  await update(ref(db, `orders/${order.id}`), { status: mapped });

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

cron.schedule("* * * * *", async () => {
  if (isUpdating) {
    console.log("⚠️ Skipped — update still running...");
    return;
  }

  isUpdating = true;

  try {
    await autoUpdateStatuses();
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


// =======================================================
// 🚀 7) تشغيل السيرفر
// =======================================================
app.listen(process.env.PORT || 3000, () =>
  console.log(`✅ Server running on port ${process.env.PORT || 3000}`)
);

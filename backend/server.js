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
import { waseetStatusMap, loginToWaseet } from "./deliveryService.js";


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
let updateCount = 0;

for (const item of data.data) {
  const mapped = waseetStatusMap[item.status] || "قيد التوصيل";

  const order = sent.find(
    o => String(o.receiptNum).trim() === String(item.id).trim()
  );

  if (!order) continue;

  // الحالة جديدة؟ إذا نعم → حدث واحسب
  if (order.status !== mapped) {
    await update(ref(db, `orders/${order.id}`), { status: mapped });
    updateCount++;
  }
}
if (updateCount === 0) {
  console.log("ℹ️ لا توجد تحديثات جديدة.");
} else {
  console.log(`✅ Auto Updated: ${updateCount} updated orders`);
}

  } catch (err) {
    console.error("❌ Auto Update Error:", err);
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
// 🚀 7) تشغيل السيرفر
// =======================================================
app.listen(process.env.PORT || 3000, () =>
  console.log(`✅ Server running on port ${process.env.PORT || 3000}`)
);
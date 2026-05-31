/****************************************************
 * server.js
 * الوسيط بين الواجهة وخدمات الشحن
 ****************************************************/

import { updatePrimeStatusesFromFirebase } from "./services/shipping/primeService.js";
import * as primeService   from "./services/shipping/primeService.js";
import * as waseetService  from "./services/shipping/waseetService.js";
import { updateWaseetStatuses } from "./services/shipping/waseetService.js";
import { db } from "./firebase.js";
import { ref, get, update } from "firebase/database";
import express   from "express";
import fetch     from "node-fetch";
import cors      from "cors";
import cron      from "node-cron";
import path      from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "../docs")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ============================================================
// الصفحة الرئيسية
// ============================================================
app.get("/", (_, res) => res.send("✅ AlMurad Server is running"));

// ============================================================
// 1) رفع طلب — وسيط أو برايم
// ============================================================
app.post("/api/create-order", async (req, res) => {
  try {
    const { orderId, shippingCompany, waseetCities, waseetRegions } = req.body;

    if (!orderId)         return res.status(400).json({ success: false, msg: "orderId مطلوب" });
    if (!shippingCompany) return res.status(400).json({ success: false, msg: "shippingCompany مطلوب" });
    if (!["waseet","prime"].includes(shippingCompany))
      return res.status(400).json({ success: false, msg: "shippingCompany: waseet أو prime فقط" });

    console.log(`📦 رفع ${orderId} على ${shippingCompany}`);

    let result;
    if (shippingCompany === "prime") {
      result = await primeService.createPrimeOrderFromFirebase(orderId);
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
// 3) Cron — كل 5 دقائق
// ============================================================
let isUpdating = false;

cron.schedule("*/5 * * * *", async () => {
  if (isUpdating) { console.log("⚠️ Cron skipped — still running"); return; }
  isUpdating = true;
  const timeout = setTimeout(() => { isUpdating = false; }, 300000);
  try {
    await updateWaseetStatuses();
    await updatePrimeStatusesFromFirebase();
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
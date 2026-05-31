/****************************************************
 * waseetService.js
 * مسؤول عن كل شي يخص الوسيط:
 * - تسجيل الدخول
 * - رفع الطلبات (مثبت → قيد التجهيز)
 * - تحديث الحالات تلقائياً
 ****************************************************/

import { db } from "../../firebase.js";
import { ref, get, update } from "firebase/database";
import fetch from "node-fetch";
import FormData from "form-data";

// ============================================================
// ثوابت
// ============================================================
const API          = "https://api.alwaseet-iq.net/v1/merchant";
const USERNAME     = "ramadan@almurad";
const PASSWORD     = "ramadan1998@";
const FINAL        = ["تم التسليم", "تم استلام الراجع"];
const WATCH        = ["قيد التجهيز", "قيد التوصيل", "راجع"];

export const STATUS_MAP = {
  "تم التسليم للزبون":           "تم التسليم",
  "تم الاستلام من قبل المندوب": "قيد التوصيل",
  "ارجاع الى التاجر":            "راجع",
  "تم الارجاع الى التاجر":      "تم استلام الراجع",
  "في موقع فرز بغداد":          "قيد التوصيل"
};

// ============================================================
// تسجيل الدخول — مباشرة لـ API الوسيط
// ============================================================
export async function loginToWaseet() {
  try {
    const fd = new FormData();
    fd.append("username", USERNAME);
    fd.append("password", PASSWORD);
    const res  = await fetch(`${API}/login`, { method: "POST", body: fd });
    const data = await res.json();
    if (!data?.data?.token) {
      console.error("❌ Waseet login failed:", data);
      return null;
    }
    return data.data.token;
  } catch (err) {
    console.error("❌ Waseet login error:", err.message);
    return null;
  }
}

// ============================================================
// تنسيق الهاتف → 07XXXXXXXXX
// ============================================================
function normalizePhone(phone) {
  const map = { "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9" };
  let n = (phone + "").replace(/[^\d٠-٩]/g, "");
  n = n.split("").map(c => map[c] || c).join("");
  if      (n.startsWith("9647")) n = "0" + n.slice(3);
  else if (n.startsWith("964"))  n = "0" + n.slice(3);
  else if (n.startsWith("7"))    n = "0" + n;
  return n;
}

// ============================================================
// مساعدات
// ============================================================
export function getCityId(name, cities)   { return cities.find(c => c.city_name   === name)?.id || ""; }
export function getRegionId(name, regions) { return regions.find(r => r.region_name === name)?.id || ""; }

function addHistory(existing = {}, status, by) {
  const clean = {};
  Object.entries(existing).forEach(([k, v]) => { if (isNaN(Number(k))) clean[k] = v; });
  clean[encodeURIComponent(status)] = { time: new Date().toISOString(), by };
  return clean;
}

async function updateMeta(...paths) {
  const t = Date.now();
  const u = {};
  paths.forEach(p => { u[`${p}/_meta/lastModified`] = t; });
  await update(ref(db), u);
}

// ============================================================
// رفع طلب واحد لـ API الوسيط
// ============================================================
async function pushToWaseet(orderData, token, cityId, regionId) {
  const fd = new FormData();
  const p  = {
    token,
    client_name:    orderData.code || "زبون",
    client_mobile:  normalizePhone(orderData.phone1 || orderData.phone || ""),
    client_mobile2: orderData.phone2 ? normalizePhone(orderData.phone2) : "",
    city_id:        cityId,
    region_id:      regionId,
    location:       orderData.address || "",
    type_name:      orderData.totalProducts || orderData.productName || "منتج",
    items_number:   String(orderData.totalQty  || 1),
    price:          String(orderData.totalPrice || 0),
    package_size:   "1",
    merchant_notes: orderData.notes || "",
    replacement:    0,
    promo_code:     "الوسيط"
  };
  Object.entries(p).forEach(([k, v]) => fd.append(k, v ?? ""));
  const res = await fetch(`${API}/create-order?token=${token}`, { method: "POST", body: fd });
  return res.json();
}

// ============================================================
// رفع الطلبات المثبتة → ينقلها من مثبت إلى قيد التجهيز
// ============================================================
export async function sendOrdersToWaseet(orders, waseetCities, waseetRegions) {
  const token = await loginToWaseet();
  if (!token) return { success: 0, failed: orders.length, results: [] };

  let success = 0, failed = 0;
  const results = [];
  const now = new Date().toISOString();

  for (const order of orders) {
    try {
      // جلب الطلب من Firebase
      const snap = await get(ref(db, `ordersTest/مثبت/${order.id}`));
      if (!snap.exists()) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: "غير موجود في ordersTest/مثبت" });
        continue;
      }

      const od = snap.val();

      if ((od.status || "").trim() !== "مثبت") {
        failed++;
        results.push({ orderId: order.id, success: false, reason: `حالته: ${od.status}` });
        continue;
      }

      // التحقق من البيانات
      const cityId = getCityId(od.city, waseetCities);
      if (!cityId) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: `مدينة غير صحيحة: ${od.city}` });
        continue;
      }

      const regionId = getRegionId(od.area, waseetRegions);
      if (!regionId) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: `منطقة غير صحيحة: ${od.area}` });
        continue;
      }

      const phone = normalizePhone(od.phone1 || od.phone || "");
      if (phone.length !== 11) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: `هاتف غير صالح: ${od.phone1} → ${phone}` });
        continue;
      }

      if (!od.totalPrice || od.totalPrice <= 0) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: "السعر غير صالح" });
        continue;
      }

      // رفع الطلب
      console.log(`⬆️  رفع ${order.id} | phone: ${phone}`);
      const data = await pushToWaseet(od, token, cityId, regionId);
      console.log(`📦 waseet response ${order.id}:`, JSON.stringify(data));

      if (data.status === true && data.data?.qr_id) {
        const updated = {
          ...od,
          status:          "قيد التجهيز",
          receiptNum:      data.data.qr_id,
          shippingCompany: "waseet",
          lastUpdateBy:    "waseet-api",
          lastStatusAt:    now,
          statusHistory:   addHistory(od.statusHistory, "قيد التجهيز", "waseet-api")
        };

        // نقل ذري: كتابة في المسار الجديد + حذف من القديم
        await update(ref(db), {
          [`ordersTest/قيد التجهيز/${order.id}`]: updated,
          [`ordersTest/مثبت/${order.id}`]:         null
        });
        await updateMeta("ordersTest/قيد التجهيز", "ordersTest/مثبت");

        console.log(`✅ ${order.id}: مثبت → قيد التجهيز | ${data.data.qr_id}`);
        success++;
        results.push({ orderId: order.id, success: true, receiptNum: data.data.qr_id, qrLink: data.data.qr_link });

      } else {
        failed++;
        results.push({ orderId: order.id, success: false, response: data });
      }

    } catch (err) {
      failed++;
      console.error(`❌ خطأ ${order.id}:`, err.message);
      results.push({ orderId: order.id, success: false, error: err.message });
    }
  }

  return { success, failed, results };
}

// ============================================================
// تحديث الحالات تلقائياً — يُستدعى من الكرون في server.js
// ============================================================
export async function updateWaseetStatuses() {
  const token = await loginToWaseet();
  if (!token) { console.log("❌ Waseet login failed"); return; }

  // جمع طلبات الوسيط من المسارات المراقبة
  let orders = [];
  for (const status of WATCH) {
    const snap = await get(ref(db, `ordersTest/${status}`));
    if (!snap.exists()) continue;
    Object.entries(snap.val()).forEach(([id, o]) => {
      if (id === "_meta")              return;
      if (o.shippingCompany !== "waseet") return;
      if (!o.receiptNum)               return;
      if (FINAL.includes(o.status))   return;
      orders.push({ id, ...o, _path: `ordersTest/${status}/${id}` });
    });
  }

  if (orders.length === 0) { console.log("ℹ️ لا طلبات وسيط للمتابعة"); return; }
  console.log(`📋 ${orders.length} طلب وسيط`);

  // جلب الحالات من API الوسيط (batches 25)
  const ids = orders.map(o => String(o.receiptNum).trim());
  let apiData = [];
  for (let i = 0; i < ids.length; i += 25) {
    const fd = new FormData();
    fd.append("ids", ids.slice(i, i + 25).join(","));
    const res  = await fetch(`${API}/get-orders-by-ids-bulk?token=${token}`, { method: "POST", body: fd });
    const data = await res.json();
    if (data.status && Array.isArray(data.data)) apiData = apiData.concat(data.data);
  }

  let count = 0;
  for (const item of apiData) {
    const waseetStatus = item.status.replace(/\s+/g, " ").trim();
    const mapped = STATUS_MAP[waseetStatus];
    if (!mapped) { console.log(`⏩ حالة غير معروفة: "${waseetStatus}"`); continue; }

    const order = orders.find(o => String(o.receiptNum).trim() === String(item.id).trim());
    if (!order) continue;

    const current = (order.status || "").trim();
    if (FINAL.includes(current) || current === mapped) continue;

    const updated = {
      ...order,
      status:        mapped,
      waseetStatus,
      lastStatusAt:  new Date().toISOString(),
      lastUpdateBy:  "system-waseet",
      statusHistory: addHistory(order.statusHistory, mapped, "system-waseet")
    };
    delete updated._path;

    const oldPath = order._path;
    const newPath = `ordersTest/${mapped}/${order.id}`;

    await update(ref(db), {
      [newPath]: updated,
      ...(newPath !== oldPath ? { [oldPath]: null } : {})
    });

    await updateMeta(
      `ordersTest/${mapped}`,
      oldPath.split("/").slice(0, 2).join("/")
    );

    console.log(`✅ ${order.id}: ${current} → ${mapped}`);
    count++;
  }

  console.log(count > 0 ? `✅ تم تحديث ${count} طلب وسيط` : "ℹ️ لا تحديثات جديدة");
}
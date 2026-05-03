/****************************************************
 * 🚚 waseetService.js
 * محدّث لدعم مسارات ordersTest
 ****************************************************/

import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, update, set } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDtEJYJrmyP45qS2da8Cuc6y6Jv5VD0Uhc",
  authDomain: "almurad-system.firebaseapp.com",
  databaseURL: "https://almurad-system-default-rtdb.firebaseio.com/",
  projectId: "almurad-system",
  storageBucket: "almurad-system.appspot.com",
  messagingSenderId: "911755824405",
  appId: "1:911755824405:web:2bfbd18ddcf038ca48ad1c"
};

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ============================================================
// 1) تسجيل الدخول
// ============================================================
export async function loginToWaseet() {
  try {
    const response = await fetch("https://almurad.onrender.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ramadan@almurad", password: "ramadan1998@" })
    });
    const data  = await response.json();
    const token = data?.data?.token;
    if (!token) { console.error("❌ فشل تسجيل الدخول للوسيط:", data); return null; }
    return token;
  } catch (err) {
    console.error("❌ خطأ تسجيل الدخول:", err);
    return null;
  }
}

// ============================================================
// 2) تنسيق الهاتف
// ============================================================
export function normalizePhone(phone) {
  const map = { "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9" };
  let cleaned = (phone + "").replace(/[^\d٠-٩]/g, "");
  cleaned = cleaned.split("").map(c => map[c] || c).join("");
  if (cleaned.startsWith("0"))    return "+964" + cleaned.slice(1);
  if (cleaned.startsWith("7"))    return "+964" + cleaned;
  if (!cleaned.startsWith("+964")) return "+964" + cleaned;
  return cleaned;
}

// ============================================================
// 3) مابنغ حالات الوسيط
// ============================================================
export const waseetStatusMap = {
  "تم التسليم للزبون":           "تم التسليم",
  "تم الاستلام من قبل المندوب": "قيد التوصيل",
  "ارجاع الى التاجر":            "راجع",
  "تم الارجاع الى التاجر":      "تم استلام الراجع",
  "في موقع فرز بغداد":          "قيد التوصيل"
};

// ============================================================
// 4) City & Region
// ============================================================
export function getCityId(cityName, waseetCities) {
  return waseetCities.find(c => c.city_name === cityName)?.id || "";
}
export function getRegionId(regionName, waseetRegions) {
  return waseetRegions.find(r => r.region_name === regionName)?.id || "";
}

// ============================================================
// 5) بناء Payload
// ============================================================
export function buildOrderPayload(order, token, cityId, regionId) {
  return {
    token,
    client_name:    order.code || "زبون",
    client_mobile:  normalizePhone(order.phone1 || order.phone),
    client_mobile2: order.phone2 ? normalizePhone(order.phone2) : "",
    city_id:        cityId,
    region_id:      regionId,
    location:       order.address || "",
    type_name:      order.totalProducts || order.productName || "غير محدد",
    items_number:   order.totalQty?.toString() || "1",
    price:          order.totalPrice?.toString() || "0",
    package_size:   "1",
    merchant_notes: order.notes || "",
    replacement:    0
  };
}

// ============================================================
// 6) رفع الطلبات المثبتة للوسيط
//    ✅ يسحب من ordersTest/مثبت
//    ✅ بعد النجاح: ينقل ذرياً → ordersTest/قيد التجهيز
// ============================================================
export async function sendOrdersToWaseet(orders, waseetCities, waseetRegions) {
  const token = await loginToWaseet();
  if (!token) return { success: 0, failed: orders.length };

  let success = 0, failed = 0;
  const results = [];
  const now = new Date().toISOString();

  for (const order of orders) {
    try {

      // ✅ التحقق: الطلب لازم يكون من مسار ordersTest/مثبت
      const sourcePath = `ordersTest/مثبت/${order.id}`;
      const snap = await get(ref(db, sourcePath));

      if (!snap.exists()) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: "❌ الطلب غير موجود في ordersTest/مثبت" });
        continue;
      }

      const orderData = snap.val();

      // ✅ التحقق من الحالة
      if ((orderData.status || "").trim() !== "مثبت") {
        failed++;
        results.push({ orderId: order.id, success: false, reason: `❌ الطلب غير مؤهل — حالته: ${orderData.status}` });
        continue;
      }

      // ✅ التحقق من المدينة
      const cityId = getCityId(order.city, waseetCities);
      if (!cityId) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: `❌ المدينة غير صحيحة: ${order.city}` });
        continue;
      }

      // ✅ التحقق من المنطقة
      const regionId = getRegionId(order.area, waseetRegions);
      if (!regionId) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: `❌ المنطقة غير صحيحة: ${order.area}` });
        continue;
      }

      // ✅ التحقق من الهاتف
      const rawPhone = order.phone1 || order.phone;
      if (!rawPhone) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: "❌ رقم الهاتف غير موجود" });
        continue;
      }
      if (normalizePhone(rawPhone).length < 14) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: `❌ رقم الهاتف غير صالح: ${rawPhone}` });
        continue;
      }

      // ✅ التحقق من السعر والكمية والمنتجات
      if (!order.totalPrice || order.totalPrice <= 0) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: "❌ السعر غير صالح" });
        continue;
      }
      if (!order.totalQty || order.totalQty <= 0) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: "❌ الكمية غير صالحة" });
        continue;
      }
      if (!order.totalProducts?.trim()) {
        failed++;
        results.push({ orderId: order.id, success: false, reason: "❌ أسماء المنتجات غير موجودة" });
        continue;
      }

      // ✅ رفع الطلب للوسيط
      const payload  = buildOrderPayload(order, token, cityId, regionId);
      const response = await fetch("https://almurad.onrender.com/api/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();

      if (data.status === true && data.data?.qr_id) {

        // ✅ بناء بيانات الطلب المحدّثة
        const updatedOrder = {
          ...orderData,
          status:        "قيد التجهيز",
          receiptNum:    data.data.qr_id,
          shippingCompany: "waseet",
          lastUpdateBy:  "alwaseet-api",
          lastStatusAt:  now,
          statusHistory: {
            ...(orderData.statusHistory || {}),
            [encodeURIComponent("قيد التجهيز")]: { time: now, by: "alwaseet-api" }
          }
        };

        // ✅ نقل ذري: كتابة في المسار الجديد + حذف من المسار القديم
        const atomicUpdate = {
          [`ordersTest/قيد التجهيز/${order.id}`]: updatedOrder,
          [`ordersTest/مثبت/${order.id}`]:         null
        };
        await update(ref(db), atomicUpdate);

        // تحديث meta للمسارين
        const metaTime = Date.now();
        await update(ref(db), {
          "ordersTest/قيد التجهيز/_meta/lastModified": metaTime,
          "ordersTest/مثبت/_meta/lastModified":         metaTime
        });

        console.log(`✅ ${order.id}: مثبت → قيد التجهيز | وصل: ${data.data.qr_id}`);
        success++;
        results.push({
          orderId:    order.id,
          success:    true,
          receiptNum: data.data.qr_id,
          qrLink:     data.data.qr_link
        });

      } else {
        failed++;
        results.push({ orderId: order.id, success: false, response: data });
      }

    } catch (err) {
      failed++;
      results.push({ orderId: order.id, success: false, error: err.message });
    }
  }

  return { success, failed, results };
}

// ============================================================
// 7) تحديث الحالات من الوسيط (للاستخدام اليدوي من الواجهة)
//    server.js يتكفل بالتحديث التلقائي عبر ordersTest
// ============================================================
export async function updateOrdersStatusFromWaseet(orders) {
  const token = await loginToWaseet();
  if (!token) return [];

  const receiptIds = orders.map(o => o.receiptNum).join(",");
  const response = await fetch("https://almurad.onrender.com/api/get-orders-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ids: receiptIds })
  });

  const data = await response.json();
  if (!data.status) { console.error("❌ فشل جلب الحالات:", data); return []; }

  const results = [];
  const now     = new Date().toISOString();

  for (const item of data.data) {
    const cleanStatus = item.status.replace(/\s+/g, " ").trim();
    const mapped      = waseetStatusMap[cleanStatus];

    if (!mapped) {
      results.push({ receiptNum: item.id, waseetStatus: item.status, success: false, reason: "❌ حالة غير معروفة" });
      continue;
    }

    const targetOrder = orders.find(o => String(o.receiptNum).trim() === String(item.id).trim());
    if (!targetOrder) {
      results.push({ receiptNum: item.id, waseetStatus: cleanStatus, success: false, reason: "❌ لم يتم العثور على الطلب" });
      continue;
    }

    try {
      // جلب الطلب من مساره الحالي
      const currentSnap = await get(ref(db, `ordersTest/${targetOrder.status}/${targetOrder.id}`));
      if (!currentSnap.exists()) {
        results.push({ receiptNum: item.id, success: false, reason: "❌ الطلب غير موجود في Firebase" });
        continue;
      }

      const orderData = currentSnap.val();
      const updatedOrder = {
        ...orderData,
        status:       mapped,
        waseetStatus: cleanStatus,
        lastStatusAt: now,
        lastUpdateBy: "alwaseet-api",
        statusHistory: {
          ...(orderData.statusHistory || {}),
          [encodeURIComponent(mapped)]: { time: now, by: "alwaseet-api" }
        }
      };

      const oldPath = `ordersTest/${targetOrder.status}/${targetOrder.id}`;
      const newPath = `ordersTest/${mapped}/${targetOrder.id}`;

      const atomicUpdate = {
        [newPath]: updatedOrder,
        ...(newPath !== oldPath ? { [oldPath]: null } : {})
      };
      await update(ref(db), atomicUpdate);

      results.push({ receiptNum: item.id, waseetStatus: cleanStatus, systemStatus: mapped, success: true });
    } catch (err) {
      results.push({ receiptNum: item.id, success: false, error: err.message });
    }
  }

  return results;
}
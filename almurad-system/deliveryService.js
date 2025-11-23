/****************************************************
 * 🚚 deliveryService.js
 * ملف كامل ومستقل 100% لتعامل مع شركة الوسيط
 * جاهز للربط بأي صفحة أو نظام
 ****************************************************/

// =============================================
// 🔐 1️⃣ تسجيل الدخول للوسيط والحصول على Token
// =============================================
export async function loginToWaseet() {
  try {
    const response = await fetch("https://almurad.onrender.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "ramadan@almurad",
        password: "ramadan1998@"
      })
    });

    const data = await response.json();
    const token = data?.data?.token;

    if (!token) {
      console.error("❌ فشل تسجيل الدخول للوسيط:", data);
      return null;
    }

    return token;
  } catch (err) {
    console.error("❌ خطأ أثناء تسجيل الدخول:", err);
    return null;
  }
}

// =============================================
// 📞 2️⃣ تنسيق رقم الهاتف
// =============================================
export function normalizePhone(phone) {
  const map = {
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9"
  };

  let cleaned = (phone + "").replace(/[^\d٠-٩]/g, "");
  cleaned = cleaned.split("").map(c => map[c] || c).join("");

  if (cleaned.startsWith("0")) return "+964" + cleaned.slice(1);
  if (cleaned.startsWith("7")) return "+964" + cleaned;
  if (!cleaned.startsWith("+964")) return "+964" + cleaned;

  return cleaned;
}

// =============================================
// 🗺 3️⃣ مابنغ حالات الوسيط → حالات نظامك
// =============================================
export const waseetStatusMap = {
  "تم التسليم للزبون": "تم التسليم",
  "تم الاستلام من قبل المندوب": "قيد التوصيل",
  "ارجاع الى التاجر": "راجع",
  "تم الارجاع الى التاجر": "تم استلام الراجع",
  "في موقع فرز بغداد": "قيد التوصيل"
};

// =============================================
// 🧩 4️⃣ استخراج City ID & Region ID من بيانات الوسيط
// ❗ يجب تمرير قوائم مدنك (waseetCities, waseetRegions)
// =============================================
export function getCityId(cityName, waseetCities) {
  const match = waseetCities.find(c => c.city_name === cityName);
  return match ? match.id : "";
}

export function getRegionId(regionName, waseetRegions) {
  const match = waseetRegions.find(r => r.region_name === regionName);
  return match ? match.id : "";
}

// =============================================
// 📦 5️⃣ تجهيز Payload للرفع
// =============================================
export function buildOrderPayload(order, token, cityId, regionId) {
  return {
    token,

    client_name: order.code || "زبون",

    client_mobile: normalizePhone(order.phone1 || order.phone),
    client_mobile2: order.phone2 ? normalizePhone(order.phone2) : "",

    city_id: cityId,
    region_id: regionId,

    location: order.address || "",

    // 🔥 التعديلات الثلاثة هنا
    type_name: order.totalProducts || order.productName || "غير محدد",
    items_number: order.totalQty?.toString() || "1",
    price: order.totalPrice?.toString() || "0",

    package_size: "1",
    merchant_notes: order.notes || "",
    replacement: 0
  };
}


// =============================================
// 🚀 6️⃣ رفع الطلبات المثبتة للوسيط
// - يستلم Array من الطلبات
// - يرجع نتائج الرفع
// =============================================
export async function sendOrdersToWaseet(orders, waseetCities, waseetRegions) {
  const token = await loginToWaseet();
  if (!token) return { success: 0, failed: orders.length };

  let success = 0, failed = 0;
  const results = [];

  for (const order of orders) {
    try {
      const cityId = getCityId(order.city, waseetCities);
      const regionId = getRegionId(order.area, waseetRegions);
// ⭐ فحص المدينة
if (!cityId) {
  failed++;
  results.push({
    orderId: order.id,
    success: false,
    reason: `❌ المدينة غير صحيحة: ${order.city}`
  });
  continue;
}

// ⭐ فحص المنطقة
if (!regionId) {
  failed++;
  results.push({
    orderId: order.id,
    success: false,
    reason: `❌ المنطقة غير صحيحة: ${order.area}`
  });
  continue;
}

// ⭐ فحص رقم الهاتف
const rawPhone = order.phone1 || order.phone;
if (!rawPhone) {
  failed++;
  results.push({
    orderId: order.id,
    success: false,
    reason: "❌ رقم الهاتف غير موجود"
  });
  continue;
}

const normalized = normalizePhone(rawPhone);
if (normalized.length < 14) {
  failed++;
  results.push({
    orderId: order.id,
    success: false,
    reason: `❌ رقم الهاتف غير صالح: ${rawPhone}`
  });
  continue;
}

// ⭐ السعر
if (!order.totalPrice || order.totalPrice <= 0) {
  failed++;
  results.push({
    orderId: order.id,
    success: false,
    reason: "❌ السعر غير موجود أو غير صالح"
  });
  continue;
}

// ⭐ الكمية
if (!order.totalQty || order.totalQty <= 0) {
  failed++;
  results.push({
    orderId: order.id,
    success: false,
    reason: "❌ الكمية غير صالحة أو غير موجودة"
  });
  continue;
}

// ⭐ أسماء المنتجات
if (!order.totalProducts || !order.totalProducts.trim()) {
  failed++;
  results.push({
    orderId: order.id,
    success: false,
    reason: "❌ أسماء المنتجات غير موجودة"
  });
  continue;
}


      const payload = buildOrderPayload(order, token, cityId, regionId);

      const response = await fetch("https://almurad.onrender.com/api/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (data.status === true && data.data?.qr_id) {
        success++;
        results.push({
          orderId: order.id,
          success: true,
          receiptNum: data.data.qr_id,
          qrLink: data.data.qr_link
        });
      } else {
        failed++;
        results.push({ orderId: order.id, success: false, response: data });
      }
    } catch (err) {
      failed++;
      results.push({ orderId: order.id, success: false, error: err });
    }
  }

  return { success, failed, results };
}

// =============================================
// 🔄 7️⃣ تحديث الحالات من الوسيط
// - يستلم Array من الطلبات (كلها تحتوي receiptNum)
// =============================================
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
  if (!data.status) {
    console.error("❌ فشل جلب الحالات:", data);
    return [];
  }

  // تحويل حالات الوسيط لحالات النظام
  return data.data.map(item => {
    const mappedStatus = waseetStatusMap[item.status] || null;
    return {
      receiptNum: item.id,
      waseetStatus: item.status,
      systemStatus: mappedStatus
    };
  });
}


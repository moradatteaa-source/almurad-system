import { ref, get, update } from "firebase/database";
import { db } from "../../firebase.js";
import fetch from "node-fetch";


const PRIME_BASE_URL = "https://www.prime-iq.com";
const PRIME_LOGIN = "al_murad";
const PRIME_PASSWORD = "dpK[ZOGo}HsbRG!84mWkLPoD$jn4qs";
const PRIME_INITIAL_TOKEN = "x6rQkVAg7PQAfBag23kNOvFFUW8XSd";
const PRIME_SENDER_ID = 43825;
const PRIME_MERCHANT_LOGIN = "07808197448";

let primeToken = null;
let primeTokenTime = 0;

// ======================
// 🔵 Login
// ======================
export async function loginToPrime() {
  const now = Date.now();
  if (primeToken && (now - primeTokenTime < 5 * 60 * 1000)) {
    return primeToken;
  }

  const response = await fetch(
    PRIME_BASE_URL + "/myp/webapi/auth/external-system-login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        login: PRIME_LOGIN,
        password: PRIME_PASSWORD,
        initialToken: PRIME_INITIAL_TOKEN
      })
    }
  );

  const data = await response.json();
  if (!data.accessToken) return null;

  primeToken = data.accessToken;
  primeTokenTime = now;

  return primeToken;
}

// ======================
// 🔵 Helpers
// ======================
function cleanPhoneNumber(input) {
  if (!input) return null;

  const arabicToEnglishMap = {
    "٠": "0","١": "1","٢": "2","٣": "3","٤": "4",
    "٥": "5","٦": "6","٧": "7","٨": "8","٩": "9"
  };

  let number = input.toString().replace(/[٠-٩]/g, d => arabicToEnglishMap[d]);
  number = number.replace(/\D/g, "");

  if (number.startsWith("964")) {
    number = "0" + number.slice(3);
  }

  if (!number.startsWith("0")) {
    number = "0" + number;
  }

  if (!/^07\d{9}$/.test(number)) {
    console.log("❌ Invalid Iraqi phone format after cleaning:", number);
    return null;
  }

  return number;
}

function convertState(city) {
  const states = {
    "بغداد": "BGD",
    "ذي قار": "NAS",
    "ديالى": "DYL",
    "واسط": "KOT",
    "كربلاء": "KRB",
    "دهوك": "DOH",
    "بابل": "BBL",
    "النجف": "NJF",
    "البصرة": "BAS",
    "اربيل": "ARB",
    "كركوك": "KRK",
    "السليمانية": "SMH",
    "صلاح الدين": "SAH",
    "الانبار": "ANB",
    "المثنى": "SAM",
    "الموصل": "MOS",
    "الديوانية": "DWN",
    "ميسان": "AMA"
  };

  return states[city?.trim()] || "BGD";
}

// ======================
// 🔵 Create Order From Firebase
// ======================
export async function createPrimeOrderFromFirebase(orderId) {

  const snap = await get(ref(db, `orders/${orderId}`));
if (!snap.exists()) {
  console.log("❌ Order not found in Firebase");
  return { success: false, msg: "Order not found in Firebase" };
}
  const order = snap.val();

if ((order.status || "").trim() !== "مثبت") {
      console.log("❌ Order not eligible. Current status:", order.status);
  return { success: false, msg: `Order not eligible (${order.status})` };
}

  const token = await loginToPrime();
if (!token) {
  console.log("❌ Prime login failed");
  return { success: false, msg: "Prime login failed" };
}
 const caseId = "MRD" + Date.now();

// 🔥 تنظيف رقم الهاتف
const cleanedPhone =
  cleanPhoneNumber(order.phone1) ||
  cleanPhoneNumber(order.phone2);

console.log("📞 PHONE1:", order.phone1);
console.log("📞 PHONE2:", order.phone2);
console.log("📞 FINAL USED:", cleanedPhone);console.log("📞 RAW PHONE:", order.phone1);
console.log("📞 CLEANED PHONE:", cleanedPhone);
if (!cleanedPhone) {
  console.log("❌ Invalid phone format:", order.phone);
  return { success: false, msg: "Invalid phone format" };
}


// ===== نفس منطق الوسيط 100% =====
const productInfoString = order.totalProducts || order.productName || "منتج";
const totalQty = Number(order.totalQty) > 0 
  ? Number(order.totalQty) 
  : 1;
const finalNotes = order.notes || "";
const shipmentData = [
  {
    custReceiptNoOri: 0,
district: 0,
    haveReturnItems: "N",
    receiverHp2: order.phone2 || "",
rmk: finalNotes,
    locationDetails: order.address || "",
    merchantLoginId: PRIME_MERCHANT_LOGIN,
productInfo: productInfoString,
qty: totalQty,
    receiptAmtIqd: Number(order.totalPrice) || 0,
receiverHp1: cleanedPhone,
receiverName: order.code || order.receiverName || order.customerName || "زبون",
    senderId: PRIME_SENDER_ID,
    senderSystemCaseIdWithCharacters: caseId,
    state: convertState(order.city)
  }
];
console.log("📦 FINAL PAYLOAD SENT TO PRIME:");
console.log(JSON.stringify(shipmentData, null, 2));
  const response = await fetch(
    PRIME_BASE_URL + "/myp/webapi/external/create-shipments/",
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

console.log("📦 Prime raw response:", result);


if (!response.ok) {
  console.log("❌ Prime HTTP Error:", response.status);
  console.log("❌ Prime Error Body:", result);
  return { success: false, error: result };
}

const shipmentNo = result?.shipmentNo
  || result?.data?.shipmentNo
  || Object.keys(result || {})[0]
  || null;

if (!shipmentNo) {
  console.log("❌ Prime returned no shipment number:", result);
  return { success: false, msg: "No shipment number returned", data: result };
}

console.log("✅ Prime shipment created:", shipmentNo);
await update(ref(db, `orders/${orderId}`), {
  receiptNum: shipmentNo,
  status: "قيد التجهيز",
  shippingCompany: "prime",
  lastUpdateBy: "system-prime",
  lastStatusAt: new Date().toISOString()
});

  return { success: true, shipmentNo };
}

// ======================
// 🔵 Update Prime Shipments Status
// ======================
export async function updatePrimeStatusesFromFirebase() {

  const token = await loginToPrime();
  if (!token) {
    console.log("❌ Prime login failed for status update");
    return;
  }

  // 🔎 جلب كل الطلبات المرتبطة بـ prime
  const snap = await get(ref(db, "orders"));
  if (!snap.exists()) return;

  const allOrders = snap.val();

  const primeOrders = Object.entries(allOrders)
    .filter(([id, o]) =>
      o.shippingCompany === "prime" &&
      o.receiptNum
    )
    .map(([id, o]) => ({
      id,
      receiptNum: o.receiptNum,
      totalPrice: o.totalPrice
    }));

  if (primeOrders.length === 0) return;

  const shipmentIds = primeOrders.map(o => Number(o.receiptNum));

  const response = await fetch(
    PRIME_BASE_URL + "/webapi/external/shipments-info",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify(shipmentIds)
    }
  );

  const result = await response.json();

  if (!Array.isArray(result)) {
    console.log("❌ Prime status response invalid:", result);
    return;
  }

  for (const shipment of result) {

    const order = primeOrders.find(
      o => String(o.receiptNum) === String(shipment.id)
    );

    if (!order) continue;

    let newStatus = null;

    // ===== مابنك موحد مثل الوسيط =====
    switch (shipment.status) {
      case "ONWAY":
        newStatus = "قيد التوصيل";
        break;

      case "DELIVERED":
        newStatus = "تم التسليم";
        break;

      case "PART_DELIVERED":
        newStatus = "تم التسليم";
        break;

      case "CNCL":
        newStatus = "راجع";
        break;

      case "FAILED_DELIVER_RETURNED_TO_SENDER":
        newStatus = "تم استلام الراجع";
        break;

      case "DELETED":
        newStatus = "رفض";
        break;

      case "POSTPONED":
        newStatus = "قيد التوصيل";
        break;

      case "DELIVERED_CHANGE_PRICE":
        newStatus = "تم التسليم";
        break;
    }

    if (!newStatus) continue;

    const updateData = {
      status: newStatus,
      lastUpdateBy: "system-prime",
      lastStatusAt: new Date().toISOString()
    };

    // ⭐ معالجة تغيير السعر
    if (shipment.status === "DELIVERED_CHANGE_PRICE") {

      updateData.priceChanged = true;
      updateData.oldPrice = order.totalPrice;
      updateData.newPrice = shipment.receiptAmount;
      updateData.totalPrice = shipment.receiptAmount;
    }

    await update(ref(db, `orders/${order.id}`), updateData);

    await update(ref(db, `orders/${order.id}/statusHistory/${newStatus}`), {
      time: new Date().toISOString(),
      by: "Prime"
    });

    console.log("✅ Updated order:", order.id, "→", newStatus);
  }

  console.log("🔄 Prime status update completed.");
}
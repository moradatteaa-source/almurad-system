import { ref, get, update, set, remove } from "firebase/database";
import { db } from "../../firebase.js";
import fetch from "node-fetch";

const PRIME_BASE_URL        = "https://www.prime-iq.com";
const PRIME_LOGIN           = "al_murad";
const PRIME_PASSWORD        = "dpK[ZOGo}HsbRG!84mWkLPoD$jn4qs";
const PRIME_INITIAL_TOKEN   = "x6rQkVAg7PQAfBag23kNOvFFUW8XSd";
const PRIME_SENDER_ID       = 43825;
const PRIME_MERCHANT_LOGIN  = "07808197448";

let primeToken     = null;
let primeTokenTime = 0;

// ============================================================
// 🔵 تسجيل الدخول
// ============================================================
export async function loginToPrime() {
  const now = Date.now();
  if (primeToken && now - primeTokenTime < 5 * 60 * 1000) return primeToken;

  const res = await fetch(PRIME_BASE_URL + "/myp/webapi/auth/external-system-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      login: PRIME_LOGIN,
      password: PRIME_PASSWORD,
      initialToken: PRIME_INITIAL_TOKEN
    })
  });

  const data = await res.json();
  if (!data.accessToken) return null;

  primeToken     = data.accessToken;
  primeTokenTime = now;
  return primeToken;
}

// ============================================================
// 🛠️ مساعدات
// ============================================================
function cleanPhoneNumber(input) {
  if (!input) return null;

  const ar2en = { "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9" };
  let number = input.toString()
    .replace(/[٠-٩]/g, d => ar2en[d])
    .replace(/\D/g, "");

  if (number.startsWith("964")) number = "0" + number.slice(3);
  if (!number.startsWith("0"))  number = "0" + number;

  if (!/^07\d{9}$/.test(number)) {
    console.log("❌ رقم هاتف غير صالح:", number);
    return null;
  }
  return number;
}

function convertState(city) {
  if (!city) { console.log("❌ المحافظة فارغة"); return null; }

  let c = city.trim();

  const aliases = {
    "الحلة - بابل":          "بابل الحلة",
    "الديوانية - القادسية":  "الديوانية",
    "العمارة - ميسان":       "العمارة ميسان",
    "السماوة - المثنى":      "السماوة المثنى",
    "الناصرية - ذي قار":     "الناصرية ذي قار",
    "الكوت - واسط":          "الكوت واسط",
    "نينوى":                  "موصل"
  };
  if (aliases[c]) c = aliases[c];

  const codes = {
    "النجف":"NJF","كربلاء":"KRB","بابل الحلة":"BBL","الديوانية":"DWN",
    "بغداد":"BGD","ديالى":"DYL","البصرة":"BAS","العمارة ميسان":"AMA",
    "صلاح الدين":"SAH","الانبار":"ANB","الناصرية ذي قار":"NAS",
    "الكوت واسط":"KOT","السماوة المثنى":"SAM","كركوك":"KRK",
    "السليمانية":"SMH","السليمانيه":"SMH","اربيل":"ARB",
    "دهوك":"DOH","موصل":"MOS"
  };

  const code = codes[c];
  if (!code) { console.log("❌ محافظة غير معروفة:", city); return null; }
  return code;
}

// ============================================================
// 🔵 رفع طلب واحد → يسحب من ordersTest/مثبت
// ============================================================
export async function createPrimeOrderFromFirebase(orderId) {

  // ✅ المسار الجديد: ordersTest/مثبت
  const sourcePath = `ordersTest/مثبت/${orderId}`;
  const snap = await get(ref(db, sourcePath));

  if (!snap.exists()) {
    console.log("❌ الطلب غير موجود في ordersTest/مثبت");
    return { success: false, msg: "Order not found in ordersTest/مثبت" };
  }

  const order = snap.val();

  if ((order.status || "").trim() !== "مثبت") {
    console.log("❌ حالة الطلب غير مؤهلة:", order.status);
    return { success: false, msg: `Order not eligible (${order.status})` };
  }

  const token = await loginToPrime();
  if (!token) return { success: false, msg: "Prime login failed" };

  const cleanedPhone = cleanPhoneNumber(order.phone1) || cleanPhoneNumber(order.phone2);
  console.log("📞 phone1:", order.phone1, "| phone2:", order.phone2, "| used:", cleanedPhone);

  if (!cleanedPhone) return { success: false, msg: "Invalid phone format" };

  const stateCode = convertState(order.city);
  if (!stateCode) return { success: false, msg: `Invalid city: ${order.city}` };

  const caseId    = "MRD" + Date.now();
  const totalQty  = Number(order.totalQty) > 0 ? Number(order.totalQty) : 1;

  const shipmentData = [{
    custReceiptNoOri:                 0,
    district:                         0,
    haveReturnItems:                  "N",
    receiverHp2:                      order.phone2 || "",
    rmk:                              order.notes || "",
    locationDetails:                  order.address || "",
    merchantLoginId:                  PRIME_MERCHANT_LOGIN,
    productInfo:                      order.totalProducts || order.productName || "منتج",
    qty:                              totalQty,
    receiptAmtIqd:                    Number(order.totalPrice) || 0,
    receiverHp1:                      cleanedPhone,
    receiverName:                     order.code || order.receiverName || order.customerName || "زبون",
    senderId:                         PRIME_SENDER_ID,
    senderSystemCaseIdWithCharacters: caseId,
    state:                            stateCode
  }];

  console.log("📦 payload:", JSON.stringify(shipmentData, null, 2));

  const response = await fetch(PRIME_BASE_URL + "/myp/webapi/external/create-shipments/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(shipmentData)
  });

  const result = await response.json();
  console.log("📦 Prime response:", result);

  if (!response.ok) {
    console.log("❌ Prime HTTP Error:", response.status, result);
    return { success: false, error: result };
  }

  const shipmentNo = result?.shipmentNo
    || result?.data?.shipmentNo
    || Object.keys(result || {})[0]
    || null;

  if (!shipmentNo) {
    console.log("❌ لم يُرجع رقم شحنة:", result);
    return { success: false, msg: "No shipment number returned", data: result };
  }

  console.log("✅ شحنة برايم:", shipmentNo);

  // ============================================================
  // ✅ نقل الطلب من ordersTest/مثبت → ordersTest/قيد التجهيز
  //    (عملية ذرية واحدة لمنع التكرار)
  // ============================================================
  const now = new Date().toISOString();

  const updatedOrder = {
    ...order,
    receiptNum:    shipmentNo,
    status:        "قيد التجهيز",
    shippingCompany: "prime",
    lastUpdateBy:  "system-prime",
    lastStatusAt:  now,
    statusHistory: {
      ...(order.statusHistory || {}),
      [encodeURIComponent("قيد التجهيز")]: { time: now, by: "Prime" }
    }
  };

  const atomicUpdate = {
    [`ordersTest/قيد التجهيز/${orderId}`]: updatedOrder,  // ✅ كتابة في المسار الجديد
    [`ordersTest/مثبت/${orderId}`]:         null            // ✅ حذف من المسار القديم
  };

  await update(ref(db), atomicUpdate);

  // تحديث meta للمسارين
  const metaTime = Date.now();
  await update(ref(db), {
    "ordersTest/قيد التجهيز/_meta/lastModified": metaTime,
    "ordersTest/مثبت/_meta/lastModified":         metaTime
  });

  console.log(`✅ نُقل الطلب ${orderId}: مثبت → قيد التجهيز`);

  return { success: true, shipmentNo };
}

// ============================================================
// 🔵 تحديث حالات الشحن → يسحب من ordersTest/قيد التوصيل + قيد التجهيز
// ============================================================
export async function updatePrimeStatusesFromFirebase() {

  const token = await loginToPrime();
  if (!token) { console.log("❌ Prime login failed"); return; }

  // ✅ المسارات التي نتابع فيها طلبات Prime
  const pathsToWatch = ["قيد التجهيز", "قيد التوصيل"];
  let primeOrders = [];

  for (const status of pathsToWatch) {
    const snap = await get(ref(db, `ordersTest/${status}`));
    if (!snap.exists()) continue;

    const entries = Object.entries(snap.val())
      .filter(([id, o]) => o.shippingCompany === "prime" && o.receiptNum && id !== "_meta")
      .map(([id, o]) => ({
        id,
        receiptNum:  o.receiptNum,
        totalPrice:  o.totalPrice,
        currentPath: `ordersTest/${status}/${id}`,
        orderData:   o
      }));

    primeOrders = [...primeOrders, ...entries];
  }

  if (primeOrders.length === 0) {
    console.log("ℹ️ لا يوجد طلبات Prime للمتابعة");
    return;
  }

  console.log(`📋 متابعة ${primeOrders.length} طلب Prime...`);

  const shipmentIds = primeOrders.map(o => Number(o.receiptNum));
  const response = await fetch(PRIME_BASE_URL + "/myp/webapi/external/shipments-info", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(shipmentIds)
  });

  const result = await response.json();
  if (!Array.isArray(result)) { console.log("❌ استجابة غير صالحة:", result); return; }

  const now = new Date().toISOString();

  for (const shipment of result) {
    const order = primeOrders.find(
      o => String(o.receiptNum) === String(shipment.id || shipment.caseid)
    );
    if (!order) continue;

    const currentStatus = (order.orderData.status || "").trim();
    const step          = shipment.stepCode;
    let newStatus       = null;

    // ✅ خريطة حالات Prime
    if (["DLEIVERD","PART_SUCC","SUCC_CHANGEPRICE","FORCE_DLV","SUCCARCHV"].includes(step))
      newStatus = "تم التسليم";

    else if (["RTN_INSTORE","RETURNED_TO_CUSTOMER"].includes(step))
      newStatus = "راجع";

    else if (step === "RTNARCHV")
      newStatus = "تم استلام الراجع";

    else if ([
      "NEWINSTORE","PRINTMANIFEST","NEW_ONWAY","LIAISONAGT_NEWONWAY",
      "ONWAY","POSTPONED","TRY_AGAIN","MANIFEST_BRANCHES","RESENEDSHIPMENTS"
    ].includes(step))
      newStatus = "قيد التوصيل";

    else continue;

    console.log(`Prime step: ${step} → ${newStatus} (كانت: ${currentStatus})`);

    // تجاهل نفس الحالة أو الحالات النهائية
    if (currentStatus === newStatus) { console.log("⏩ نفس الحالة:", order.id); continue; }
    if (["تم التسليم","تم استلام الراجع"].includes(currentStatus)) continue;

    const updatedOrder = {
      ...order.orderData,
      status:         newStatus,
      primeStepCode:  step,
      lastUpdateBy:   "system-prime",
      lastStatusAt:   now,
      statusHistory:  {
        ...(order.orderData.statusHistory || {}),
        [encodeURIComponent(newStatus)]: { time: now, by: "Prime" }
      }
    };

    // معالجة تغيير السعر
    if (
      step === "SUCC_CHANGEPRICE" &&
      shipment.receiptAmount &&
      Number(shipment.receiptAmount) !== Number(order.totalPrice)
    ) {
      updatedOrder.priceChanged = true;
      updatedOrder.oldPrice     = order.totalPrice;
      updatedOrder.newPrice     = shipment.receiptAmount;
      updatedOrder.totalPrice   = shipment.receiptAmount;
    }

    // ✅ نقل ذري بين المسارات
    const newPath = `ordersTest/${newStatus}/${order.id}`;
    const oldPath = order.currentPath;

    const atomicUpdate = {
      [newPath]: updatedOrder,
      [oldPath]: newPath !== oldPath ? null : updatedOrder  // حذف فقط إذا اختلف المسار
    };

    await update(ref(db), atomicUpdate);

    // تحديث meta
    const metaTime = Date.now();
    const oldBase  = oldPath.split("/").slice(0, 2).join("/");
    const newBase  = `ordersTest/${newStatus}`;
    await update(ref(db), {
      [`${oldBase}/_meta/lastModified`]: metaTime,
      [`${newBase}/_meta/lastModified`]: metaTime
    });

    console.log(`✅ نُقل ${order.id}: ${currentStatus} → ${newStatus}`);
  }

  console.log("🔄 اكتمل تحديث حالات Prime.");
}
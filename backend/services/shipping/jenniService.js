/****************************************************
 * jenniService.js
 * مسؤول عن كل شي يخص شركة Jenni Logistics:
 * - تسجيل الدخول (JWT)
 * - رفع الطلبات (مثبت → قيد التجهيز) عبر /v2/shipments/create
 * - تحديث الحالات تلقائياً عبر /v2/shipments/query (نفس أسلوب الوسيط وبرايم)
 *
 * ملاحظة: هذا الملف مبني بنفس الأسلوب بالضبط مثل waseetService.js
 * وprimeService.js حتى يبقى الكود متسق وسهل الصيانة. اخترنا أسلوب
 * "polling" (نحنا نسأل عن الحالة) بدل الـ webhook (هم يرسلون لنا)
 * حتى يطابق تماماً طريقة عمل الوسيط وبرايم الحاليين، وما يحتاج بناء
 * endpoint جديد معرض على الإنترنت لازم نؤمنه.
 ****************************************************/

import { ref, get, update } from "firebase/database";
import { db } from "../../firebase.js";
import fetch from "node-fetch";
import { addHistory } from "./statusHistory.js";

// ============================================================
// ثوابت
// ============================================================
const API_BASE      = "https://jenni.cloudexp.co/api";
const USERNAME      = "07707676677";
const PASSWORD      = "76677";
const SYSTEM_CODE    = "ALMURAD"; // ⚠️ لازم يكون طلب التسجيل معتمد (Approved) عند Jenni قبل ما يشتغل فعلياً

// نفس منطق الوسيط: الحالات النهائية ما تحتاج متابعة، والمسارات
// المراقبة هي نفسها اللي تراقبها primeService وwaseetService بالضبط
const FINAL = ["تم التسليم", "تم استلام الراجع"];
const WATCH = ["قيد التجهيز", "قيد التوصيل", "راجع"];

// خريطة رموز حالة Jenni (current_step) → حالاتنا الداخلية.
// مبنية على "Complete Step Status List" بتوثيق Jenni (راجع الشرح المرفق بالمحادثة).
const STATUS_MAP = {
  // 🟢 تم التسليم بنجاح (وأشكاله)
  "DELIVERED":               "تم التسليم",
  "DELIVERED_ARCHIVED":      "تم التسليم",
  "DELIVERED_PRICE_CHANGED": "تم التسليم",
  "PARTIALLY_DELIVERED":     "تم التسليم",
  "FORCE_DELIVERY":          "تم التسليم",

  // 🟡 قيد التوصيل (خارج للتسليم فعلياً)
  "OFD": "قيد التوصيل",

  // 🔴 راجع (بالطريق للرجوع، لسا مو بالمخزن نهائياً)
  "RTO_WITH_DA":            "راجع",
  "RTO_CONFIRMED":          "راجع",
  "RTO_FROM_BRANCH":        "راجع",
  "RTO_IN_TRANSIT_WH":      "راجع",
  "RTO_READY_FOR_BRANCH":   "راجع",
  "RTO_WITH_MA":            "راجع",

  // ✅ تم استلام الراجع فعلياً (رجع كلياً للمخزن)
  "RTO_WH":       "تم استلام الراجع",
  "RTO_ARCHIVED": "تم استلام الراجع"

  // أي رمز غير موجود هنا (IN_SC, NEW_WITH_PA, POSTPONED, WITH_MA...) يعتبر
  // "لسا بمعالجة" ونتجاهله (نفس فلسفة الوسيط وبرايم — نحدث بس لما توصل
  // لإحدى الحالات الأربعة اللي نظامنا يتابعها).
};

// ============================================================
// تسجيل الدخول — JWT صالح 24 ساعة حسب توثيق Jenni، نكاشه لتقليل
// عدد مرات تسجيل الدخول (بحذر: نجدده كل ساعتين احتياطاً)
// ============================================================
let jenniToken     = null;
let jenniTokenTime = 0;
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // ساعتين

export async function loginToJenni() {
  const now = Date.now();
  if (jenniToken && now - jenniTokenTime < TOKEN_TTL_MS) return jenniToken;

  try {
    const res = await fetch(`${API_BASE}/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD })
    });
    const data = await res.json();

    if (!data?.token) {
      console.error("❌ Jenni login failed:", data);
      return null;
    }

    jenniToken     = data.token;
    jenniTokenTime = now;
    return jenniToken;
  } catch (err) {
    console.error("❌ Jenni login error:", err.message);
    return null;
  }
}

// ============================================================
// تنسيق الهاتف → 07XXXXXXXXX (نفس منطق برايم بالضبط — Jenni يطلب نفس الصيغة)
// ============================================================
function cleanPhoneNumber(input) {
  if (!input) return null;
  const ar2en = { "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9" };
  let number = input.toString()
    .replace(/[٠-٩]/g, d => ar2en[d])
    .replace(/\D/g, "");

  if (number.startsWith("964")) number = "0" + number.slice(3);
  if (!number.startsWith("0"))  number = "0" + number;

  if (!/^07\d{9}$/.test(number)) return null;
  return number;
}

// ============================================================
// تحويل اسم المحافظة (بصيغتنا الداخلية) → كود محافظة Jenni
// نفس أسماء وأسلوب alias بملف primeService.js's convertState تماماً،
// بس بأكواد Jenni الصحيحة (18 محافظة، حسب جدول "Governorate Codes
// Reference — Corrected" بتوثيقهم)
// ============================================================
function convertGovernorate(city) {
  if (!city) return null;
  let c = city.trim();

  const aliases = {
    "الحلة - بابل":          "بابل",
    "الديوانية - القادسية":  "الديوانية",
    "العمارة - ميسان":       "العمارة",
    "السماوة - المثنى":      "السماوة",
    "الناصرية - ذي قار":     "الناصرية",
    "الكوت - واسط":          "الكوت",
    "نينوى":                  "موصل"
  };
  if (aliases[c]) c = aliases[c];

  const codes = {
    "النجف":"NJF","كربلاء":"KRB","بابل":"BBL","الديوانية":"QAD",
    "بغداد":"BGD","ديالى":"DYL","البصرة":"BAS","العمارة":"MYS",
    "صلاح الدين":"SAH","الانبار":"ANB","الناصرية":"DHI",
    "الكوت":"WST","السماوة":"MTH","كركوك":"KRK",
    "السليمانية":"SMH","السليمانيه":"SMH","اربيل":"ARB",
    "دهوك":"DOH","موصل":"NIN"
  };

  return codes[c] || null;
}

// ============================================================
// رفع طلب واحد → يسحب من ordersTest/مثبت (Receive In mode)
// ============================================================
export async function createJenniOrderFromFirebase(orderId) {
  const sourcePath = `ordersTest/مثبت/${orderId}`;
  const snap = await get(ref(db, sourcePath));

  if (!snap.exists()) {
    return { success: false, msg: "Order not found in ordersTest/مثبت" };
  }

  const order = snap.val();
  if ((order.status || "").trim() !== "مثبت") {
    return { success: false, msg: `Order not eligible (${order.status})` };
  }

  const token = await loginToJenni();
  if (!token) return { success: false, msg: "Jenni login failed" };

  const phone = cleanPhoneNumber(order.phone1) || cleanPhoneNumber(order.phone2);
  if (!phone) return { success: false, msg: "Invalid phone format" };

  const governorateCode = convertGovernorate(order.city);
  if (!governorateCode) return { success: false, msg: `Invalid city: ${order.city}` };

  const shipmentPayload = {
    system_code: SYSTEM_CODE,
    shipments: [{
      shipment_number:      orderId,
      external_shipment_id: orderId,
      receiver_name:        order.code || order.receiverName || "زبون",
      receiver_phone_1:     phone,
      receiver_phone_2:     order.phone2 ? cleanPhoneNumber(order.phone2) : null,
      governorate_code:     governorateCode,
      city:                 order.area || order.city || "",
      address:              order.address || "",
      amount_iqd:           Number(order.totalPrice) || 0,
      quantity:             Number(order.totalQty) > 0 ? Number(order.totalQty) : 1,
      product_info:         order.totalProducts || order.productName || "منتج",
      note:                 order.notes || ""
    }]
  };

  console.log("📦 Jenni payload:", JSON.stringify(shipmentPayload, null, 2));

  const response = await fetch(`${API_BASE}/v2/shipments/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(shipmentPayload)
  });

  const result = await response.json();
  console.log("📦 Jenni response:", JSON.stringify(result));

  const accepted = result?.accepted_shipments?.[0];
  const rejected = result?.rejected_shipments?.[0];

  if (!accepted?.shipment_id) {
    return { success: false, msg: rejected?.reason || result?.message || "Jenni rejected the shipment", data: result };
  }

  const shipmentId = accepted.shipment_id;
  const now = new Date().toISOString();

  const updatedOrder = {
    ...order,
    receiptNum:      shipmentId,
    status:          "قيد التجهيز",
    shippingCompany: "jenni",
    lastUpdateBy:    "system-jenni",
    lastStatusAt:    now,
    statusHistory: addHistory(order.statusHistory, "قيد التجهيز", "Jenni", now)
  };

  // نقل ذري: كتابة بالمسار الجديد + حذف من القديم
  await update(ref(db), {
    [`ordersTest/قيد التجهيز/${orderId}`]: updatedOrder,
    [`ordersTest/مثبت/${orderId}`]:         null
  });

  const metaTime = Date.now();
  await update(ref(db), {
    "ordersTest/قيد التجهيز/_meta/lastModified": metaTime,
    "ordersTest/مثبت/_meta/lastModified":         metaTime
  });

  console.log(`✅ نُقل الطلب ${orderId}: مثبت → قيد التجهيز | Jenni shipment_id: ${shipmentId}`);
  return { success: true, shipmentNo: shipmentId };
}

// ============================================================
// تحديث الحالات تلقائياً — يُستدعى من الكرون في server.js
// نفس أسلوب preloadedBranches المستخدم بـ waseetService/primeService
// (لتفادي قراءة نفس فروع ordersTest ثلاث مرات بدل مرة وحدة بالكرون)
// ============================================================
export async function updateJenniStatusesFromFirebase(preloadedBranches = null) {
  const token = await loginToJenni();
  if (!token) { console.log("❌ Jenni login failed"); return; }

  let orders = [];
  for (const status of WATCH) {
    let branchData;
    if (preloadedBranches && Object.prototype.hasOwnProperty.call(preloadedBranches, status)) {
      branchData = preloadedBranches[status];
    } else {
      const snap = await get(ref(db, `ordersTest/${status}`));
      branchData = snap.exists() ? snap.val() : null;
    }
    if (!branchData) continue;

    Object.entries(branchData).forEach(([id, o]) => {
      if (id === "_meta")             return;
      if (o.shippingCompany !== "jenni") return;
      if (!o.receiptNum)               return;
      if (FINAL.includes(o.status))   return;
      orders.push({ id, ...o, _path: `ordersTest/${status}/${id}` });
    });
  }

  if (orders.length === 0) { console.log("ℹ️ لا طلبات Jenni للمتابعة"); return; }
  console.log(`📋 ${orders.length} طلب Jenni`);

  // فحص الحالات بالجملة (batches 100 — الحد الأقصى المسموح حسب توثيق Jenni)
  const shipmentIds = orders.map(o => Number(o.receiptNum));
  let shipments = [];
  for (let i = 0; i < shipmentIds.length; i += 100) {
    const batch = shipmentIds.slice(i, i + 100);
    const res = await fetch(`${API_BASE}/v2/shipments/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ shipment_ids: batch })
    });
    const data = await res.json();
    if (data?.success && Array.isArray(data.shipments)) {
      shipments = shipments.concat(data.shipments);
    }
  }

  let count = 0;
  for (const shipment of shipments) {
    const mapped = STATUS_MAP[shipment.current_step];
    if (!mapped) continue; // لسا بمعالجة (IN_SC, OFD السابق تحديثه، POSTPONED...الخ)

    const order = orders.find(o => String(o.receiptNum).trim() === String(shipment.shipment_id).trim());
    if (!order) continue;

    const current = (order.status || "").trim();
    if (FINAL.includes(current) || current === mapped) continue;

    const now = new Date().toISOString();
    const updatedOrder = {
      ...order,
      status:        mapped,
      jenniStep:     shipment.current_step,
      lastStatusAt:  now,
      lastUpdateBy:  "system-jenni",
      statusHistory: addHistory(order.statusHistory, mapped, "Jenni", now)
    };
    delete updatedOrder._path;

    const oldPath = order._path;
    const newPath = `ordersTest/${mapped}/${order.id}`;

    await update(ref(db), {
      [newPath]: updatedOrder,
      ...(newPath !== oldPath ? { [oldPath]: null } : {})
    });

    await update(ref(db), {
      [`ordersTest/${mapped}/_meta/lastModified`]: Date.now(),
      [`${oldPath.split("/").slice(0, 2).join("/")}/_meta/lastModified`]: Date.now()
    });

    // ✅ إرجاع المخزن عند تم استلام الراجع فعلياً
    if (mapped === "تم استلام الراجع" && current !== "تم استلام الراجع") {
      await restoreStockForOrder(order.productsDetailed || []);
    }

    console.log(`✅ ${order.id}: ${current} → ${mapped} (Jenni: ${shipment.current_step})`);
    count++;
  }

  console.log(count > 0 ? `✅ تم تحديث ${count} طلب Jenni` : "ℹ️ لا تحديثات جديدة");
}

// ============================================================
// إرجاع المخزن — نفس الدالة الموجودة بملفي الوسيط وبرايم بالضبط
// (كررناها هنا بدل مشاركتها لتبقى كل ملفات الشحن مستقلة عن بعضها،
// نفس القاعدة المتبعة أصلاً بالمشروع)
// ============================================================
async function restoreStockForOrder(productsDetailed) {
  if (!productsDetailed?.length) return;

  const allSnap = await get(ref(db, "warehouse"));
  if (!allSnap.exists()) return;
  const warehouse = allSnap.val();

  const nameToKey = new Map();
  for (const [key, val] of Object.entries(warehouse)) {
    const name = (val.name || "").trim().replace(/\s+/g, " ");
    if (name) nameToKey.set(name, key);
  }

  const normalize = t => t.split("|").map(s => s.trim()).filter(Boolean).sort().join("|");

  for (const item of productsDetailed) {
    if (!item.name || !item.qty) continue;

    const name = item.name.trim().replace(/\s+/g, " ");
    const productKey = nameToKey.get(name);
    if (!productKey) { console.warn(`⚠️ منتج غير موجود: ${name}`); continue; }

    const stock = warehouse[productKey]?.stock || {};
    const variants = item.variants || {};
    const hasVariants = Object.keys(stock).some(k => k.includes("|"));

    if (!hasVariants) {
      const current = Number(stock.default || 0);
      const newQty = current + item.qty;
      await update(ref(db, `warehouse/${productKey}`), {
        "stock/default": newQty,
        totalQty: newQty,
        lastUpdate: new Date().toISOString()
      });
    } else {
      const variantText = Object.entries(variants)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k} | ${v}`).join(" | ");

      let matchedKey = null;
      for (const stockKey of Object.keys(stock)) {
        if (normalize(stockKey) === normalize(variantText)) {
          matchedKey = stockKey; break;
        }
      }
      if (!matchedKey) { console.warn(`⚠️ متغير غير موجود: ${variantText}`); continue; }

      const current = Number(stock[matchedKey] || 0);
      const newQty = current + item.qty;
      const updatedStock = { ...stock, [matchedKey]: newQty };
      const newTotal = Object.values(updatedStock).reduce((s, v) => s + (Number(v) || 0), 0);

      await update(ref(db, `warehouse/${productKey}`), {
        [`stock/${matchedKey}`]: newQty,
        totalQty: newTotal,
        lastUpdate: new Date().toISOString()
      });
    }

    console.log(`✅ رجع المخزن: ${name} +${item.qty}`);
  }
}

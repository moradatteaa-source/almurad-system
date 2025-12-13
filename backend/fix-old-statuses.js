/****************************************************
 * 🧹 fix-old-statuses.js
 * سكربت مرة وحدة لتنظيف حالات Firebase
 ****************************************************/

import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, update } from "firebase/database";

// 🔥 إعدادات Firebase (نفس مال مشروعك)
const firebaseConfig = {
  apiKey: "AIzaSyDtEJYJrmyP45qS2da8Cuc6y6Jv5VD0Uhc",
  authDomain: "almurad-system.firebaseapp.com",
  databaseURL: "https://almurad-system-default-rtdb.firebaseio.com/",
  projectId: "almurad-system",
  storageBucket: "almurad-system.appspot.com",
  messagingSenderId: "911755824405",
  appId: "1:911755824405:web:2bfbd18ddcf038ca48ad1c"
};

// 🚀 تشغيل Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// 🗺 خريطة التصحيح
const statusFixMap = {
  "تم التسليم للزبون": "تم التسليم",
  "تم الاستلام من قبل المندوب": "قيد التوصيل",
  "ارجاع الى التاجر": "راجع"
};


async function fixStatusesOnce() {
  console.log("🔍 بدء فحص الطلبات...");

  const snap = await get(ref(db, "orders"));
  if (!snap.exists()) {
    console.log("❌ ماكو طلبات");
    process.exit(0);
  }

  const orders = snap.val();
  let fixedCount = 0;

  for (const [id, order] of Object.entries(orders)) {
    const oldStatus = (order.status || "").trim();
    const newStatus = statusFixMap[oldStatus];

    if (!newStatus) continue;

    console.log(`🔄 ${id}: ${oldStatus} → ${newStatus}`);

    await update(ref(db, `orders/${id}`), {
      status: newStatus
    });

    // 🧾 تسجيل بالهستوري
    await update(ref(db, `orders/${id}/statusHistory/${newStatus}`), {
      time: new Date().toLocaleString("en-US"),
      by: "تنظيف تلقائي (مرة وحدة)",
      from: oldStatus
    });

    fixedCount++;
  }

  console.log(`✅ انتهى التنظيف | تم تصحيح ${fixedCount} طلب`);
  process.exit(0);
}

// ▶️ تشغيل مرة وحدة
fixStatusesOnce();

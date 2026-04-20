const { onValueWritten } = require("firebase-functions/v2/database");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

function normalizeStatus(s) {
  const raw = (s || "").trim();

  if (!raw) return "new"; // ✅ مهم جداً

  if (
    [
      "مثبت",
      "قيد المعالجة",
      "قيد التجهيز",
      "بانتظار البضاعة",
      "قيد التوصيل",
      "تم التسليم",
      "راجع",
      "تم استلام الراجع",
      "رفض"
    ].includes(raw)
  ) {
    return raw;
  }

  return "other"; // ✅ حالات أخرى
}

// 🔁 تحديث تلقائي عند تغيير الحالة
exports.updateOrderCounts = onValueWritten("/orders/{orderId}", async (event) => {
  const before = event.data.before.val();
  const after  = event.data.after.val();

  const db = admin.database();

  const oldStatus = normalizeStatus(before?.status);
  const newStatus = normalizeStatus(after?.status);

  if (oldStatus === newStatus) return;

  const updates = {};

  const oldSnap = await db.ref("stats/ordersCounts/" + oldStatus).get();
  const newSnap = await db.ref("stats/ordersCounts/" + newStatus).get();

  const oldVal = oldSnap.exists() ? oldSnap.val() : 0;
  const newVal = newSnap.exists() ? newSnap.val() : 0;

  updates["stats/ordersCounts/" + oldStatus] = Math.max(0, oldVal - 1);
  updates["stats/ordersCounts/" + newStatus] = newVal + 1;

  return db.ref().update(updates);
});

// 🔁 إعادة حساب كل الطلبات القديمة
exports.rebuildCounts = onRequest(async (req, res) => {
  const db = admin.database();

  const snap = await db.ref("orders").get();

  if (!snap.exists()) {
    return res.send("No orders found");
  }

  const data = snap.val();

  const counts = {};

  Object.values(data).forEach(o => {
    const status = normalizeStatus(o.status);
    counts[status] = (counts[status] || 0) + 1;
  });

  await db.ref("stats/ordersCounts").set(counts);

  res.send(counts);
});
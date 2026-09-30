/****************************************************
 * stockLedger.js — نسخة السيرفر من دفتر المخزن
 * ──────────────────────────────────────────────────
 * ليش انبنى (2026-09-30): خدمات الشحن الثلاث (الوسيط، Jenni،
 * Prime) كانت ترجّع بضاعة الطلب الراجع بكودها الخاص، بدون أي
 * تنسيق مع دفتر المخزن الي تشتغل بيه الصفحات.
 *
 * النتيجة: الوسيط يرجّع الحالة لـ"تم استلام الراجع" فالسيرفر
 * يضيف الكمية — بس سجل الخصم يبقى موجود. وبعدين الأدمن ينقل
 * الطلب لنفس الحالة من صفحة الطلبات → الدفتر يشوف الطلب لسه
 * مخصوم فيرجّع الكمية **مرة ثانية**. البضاعة تتضاعف بالأرقام.
 *
 * وكمان الكود القديم كان:
 *   • يقرا warehouse كامل مرة وحدة ويكتب كل البنود من نفس
 *     اللقطة — بندان لنفس المنتج بالطلب = الإضافة الأولى تنفقد
 *   • يدهس totalQty بقيمة stock/default وحدها للمنتج البسيط،
 *     متجاهلاً أي متغير ثاني
 *
 * هذي نسخة مطابقة لمنطق docs/stockLedger.js: تسجّل شنو مخصوم
 * لكل طلب تحت stockApplied/<رقم الطلب>، وتطبّق **الفرق** بس.
 * فأي مناداة زايدة — من السيرفر أو من الصفحة — ما تسوي شي.
 ****************************************************/

import { db } from "../../firebase.js";
import { ref, get, update, runTransaction } from "firebase/database";

const APPLIED_ROOT = "stockApplied";
const SEP = "::";

const cleanName = n => String(n || "").trim().replace(/\s+/g, " ");
const sanitize = s => String(s).replace(/[.#$\[\]\/]/g, "_").replace(/\s+/g, "_");
const toKey = s => cleanName(s).replace(/[.#$\[\]\/]/g, "_").replace(/\s+/g, "_");

/* الحالات الي البضاعة فيها طالعة من المخزن — أي حالة غيرها
   معناها البضاعة بالمخزن. نفس القائمة بالضبط الي بالصفحات. */
export const STOCK_OUT_STATUSES =
  ["مثبت", "قيد التجهيز", "قيد التوصيل", "تم التسليم", "راجع"];
export const isStockOut = st => STOCK_OUT_STATUSES.includes(String(st || "").trim());

/* مفتاح المتغير كما يُخزّن بالمخزن: "اللون | أحمر | القياس | L" */
function getStockKey(item) {
  if (item && item.variants && Object.keys(item.variants).length) {
    return Object.entries(item.variants)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k} | ${v}`).join(" | ");
  }
  return "default";
}

const normVariant = t =>
  String(t || "").split("|").map(s => s.trim()).filter(Boolean).sort().join("|");

function matchStockKey(stock, wantedKey) {
  if (Object.prototype.hasOwnProperty.call(stock, wantedKey)) return wantedKey;
  const hasVariants = Object.keys(stock).some(k => k.includes("|"));
  if (!hasVariants) {
    return Object.prototype.hasOwnProperty.call(stock, "default") ? "default" : null;
  }
  const want = normVariant(wantedKey);
  for (const k of Object.keys(stock)) if (normVariant(k) === want) return k;
  return null;
}

/* نلگي مفتاح المنتج بالمخزن: الاسم الخام، ثم المنظّف، ثم الفهرس */
async function findWarehouseKey(name) {
  const raw = cleanName(name);
  if (!raw) return null;

  let snap = await get(ref(db, `warehouse/${raw}`));
  if (snap.exists()) return { key: raw, snap };

  const safe = toKey(raw);
  if (safe !== raw) {
    snap = await get(ref(db, `warehouse/${safe}`));
    if (snap.exists()) return { key: safe, snap };
  }

  const idx = await get(ref(db, `warehouseIndex/${safe}`));
  if (idx.exists()) {
    const k = idx.val();
    const s2 = await get(ref(db, `warehouse/${k}`));
    if (s2.exists()) return { key: k, snap: s2 };
  }
  return null;
}

/* بنود الطلب موحّدة، مع جمع المكرر — بندان لنفس المنتج والمتغير
   لازم يتجمعان وإلا الإضافة الأولى تنفقد */
function orderItems(order) {
  const raw = order && order.productsDetailed;
  let items = Array.isArray(raw) ? raw
            : (raw && typeof raw === "object") ? Object.values(raw) : [];
  if (!items.length && order && order.productName) {
    items = [{ name: order.productName, qty: Number(order.totalQty || order.quantity || 1) }];
  }
  const merged = new Map();
  for (const item of items) {
    const name = cleanName(item && item.name);
    if (!name) continue;
    const vkey = getStockKey(item);
    const qty = Number(item.qty || 1);
    if (!qty || qty < 0) continue;
    const id = name + "||" + vkey;
    const prev = merged.get(id);
    if (prev) prev.qty += qty; else merged.set(id, { name, vkey, qty });
  }
  return [...merged.values()];
}

async function refreshTotal(pkey) {
  const snap = await get(ref(db, `warehouse/${pkey}/stock`));
  const total = Object.values(snap.val() || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  await update(ref(db, `warehouse/${pkey}`), {
    totalQty: total, lastUpdate: new Date().toISOString()
  });
}

async function readApplied(orderId) {
  const snap = await get(ref(db, `${APPLIED_ROOT}/${sanitize(orderId)}`));
  if (!snap.exists()) return null;
  return (snap.val() || {}).items || {};
}

async function writeApplied(orderId, items) {
  const val = (items && Object.keys(items).length) ? { items, at: Date.now() } : null;
  await update(ref(db, APPLIED_ROOT), { [sanitize(orderId)]: val });
}

/* الطلبات القديمة عندها علامات بدل سجل — نبني منها الحالة الحالية */
const deductMarker = (orderId, name, vkey) =>
  `deduct_${sanitize(orderId)}_${sanitize(name)}_${sanitize(vkey)}`;

async function seedFromLegacy(orderId, order) {
  const items = {}, marks = [];
  for (const it of orderItems(order)) {
    const found = await findWarehouseKey(it.name);
    if (!found) continue;
    const stock = (found.snap.val() || {}).stock || {};
    const sk = matchStockKey(stock, it.vkey);
    if (!sk) continue;
    const mark = deductMarker(orderId, it.name, it.vkey);
    const m = await get(ref(db, `stockMarkers/${found.key}/${mark}`));
    if (!m.exists()) continue;
    const id = found.key + SEP + sk;
    const q = Number(m.val());
    items[id] = (items[id] || 0) + (q > 0 ? q : it.qty);
    marks.push({ pkey: found.key, mark });
  }
  return { items, marks };
}

/**
 * يوازن مخزون الطلب مع حالته.
 * shouldBeOut = true  → بضاعته لازم تكون مخصومة
 * shouldBeOut = false → بضاعته لازم تكون بالمخزن
 * آمنة للتكرار: مناداتها مرتين ما تسوي شي (الفرق = صفر).
 */
export async function reconcileStockForOrder(order, shouldBeOut) {
  const orderId = order && order.id;
  if (!orderId) return { ok: false, problems: ["ماكو رقم طلب"] };

  const problems = [];

  let applied = await readApplied(orderId);
  let legacyMarks = [];
  if (applied === null) {
    const seed = await seedFromLegacy(orderId, order);
    applied = seed.items;
    legacyMarks = seed.marks;
  }

  const desired = {};
  if (shouldBeOut) {
    for (const it of orderItems(order)) {
      const found = await findWarehouseKey(it.name);
      if (!found) { problems.push(`منتج مو موجود: ${it.name}`); continue; }
      const stock = (found.snap.val() || {}).stock || {};
      const sk = matchStockKey(stock, it.vkey);
      if (!sk) { problems.push(`متغير مو موجود: ${it.name} (${it.vkey})`); continue; }
      const id = found.key + SEP + sk;
      desired[id] = (desired[id] || 0) + it.qty;
    }
  }

  const ids = new Set([...Object.keys(applied), ...Object.keys(desired)]);
  const touched = new Set();
  const next = {};

  for (const id of ids) {
    const was = Number(applied[id]) || 0;
    const want = Number(desired[id]) || 0;
    const at = id.indexOf(SEP);
    const pkey = id.slice(0, at), sk = id.slice(at + SEP.length);
    touched.add(pkey);

    const delta = want - was;
    if (delta === 0) { if (want > 0) next[id] = want; continue; }

    let actual = 0;
    try {
      const res = await runTransaction(ref(db, `warehouse/${pkey}/stock/${sk}`), cur => {
        const before = Number(cur) || 0;
        const after = Math.max(0, before - delta);
        actual = before - after;          // الي انخصم فعلاً مو الي طلبناه
        return after;
      });
      if (res && res.committed === false) {
        problems.push(`ما انحفظ: ${pkey} (${sk})`); continue;
      }
    } catch (e) {
      problems.push(`خطأ بتعديل: ${pkey} (${sk})`); continue;
    }

    const now = was + actual;
    if (now > 0) next[id] = now;
    if (delta > 0 && actual < delta) {
      problems.push(`كمية ما تكفي: ${pkey} (${sk}) — ${actual} من ${delta}`);
    }
  }

  await writeApplied(orderId, next);
  for (const { pkey, mark } of legacyMarks) {
    await update(ref(db, `stockMarkers/${pkey}`), { [mark]: null }).catch(() => {});
  }
  for (const pkey of touched) await refreshTotal(pkey).catch(() => {});

  return { ok: problems.length === 0, problems };
}

/** تُنادى بعد أي تغيير حالة يجيه من شركة الشحن */
export async function applyStockForStatus(order, newStatus) {
  return reconcileStockForOrder(order, isStockOut(newStatus));
}

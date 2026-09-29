/* ════════════════════════════════════════════════════════════
   📦 تحميل بيانات السنتر — center-data.js
   ────────────────────────────────────────────────────────────
   ليش انبنى: صفحة التحليلات وصفحة الأرباح كل وحدة كانت تنزّل
   posInvoices و warehouse كاملة لحالها. يعني إذا فتحت الثنتين
   تنزّل نفس البيانات مرتين — وهذا يكلّف بالداونلود.

   هنا مصدر واحد: التحميل مرة وحدة، والكاش مشترك بين الصفحتين
   داخل نفس الجلسة (١٥ دقيقة). وفوقها منطق واحد لإيجاد سعر
   الشراء — حتى الأرباح بالتحليلات تطابق الأرباح بصفحة الأرباح
   تماماً، ما يصير رقمين مختلفين لنفس الشي.
   ════════════════════════════════════════════════════════════ */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getDatabase, ref, get } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDtEJYJrmyP45qS2da8Cuc6y6Jv5VD0Uhc",
  authDomain: "almurad-system.firebaseapp.com",
  databaseURL: "https://almurad-system-default-rtdb.firebaseio.com",
  projectId: "almurad-system",
  storageBucket: "almurad-system.firebasestorage.app",
  messagingSenderId: "911755824405",
  appId: "1:911755824405:web:c5520c00c11e336148ad1c"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const rtdb = getDatabase(app);

export const CACHE_KEY = "_center_data_v1";
export const CACHE_TTL = 15 * 60 * 1000;

/* توقيت بغداد — كل التواريخ بالنظام تنحسب عليه */
export const IRAQ_MS = 3 * 60 * 60 * 1000;
export const bDate = ts => new Date(Number(ts) + IRAQ_MS);
export const dayKey = ts => bDate(ts).toISOString().slice(0, 10);
export const monthKey = ts => bDate(ts).toISOString().slice(0, 7);

export const clean = s => String(s ?? "").trim().replace(/\s+/g, " ");
export const toKey = s => clean(s).replace(/[.#$\[\]\/]/g, "_").replace(/\s+/g, "_");
export const fmt = n => Math.round(Number(n) || 0).toLocaleString("en-US");

/* ── إيجاد المنتج بالمخزن ── ثلاث محاولات ──
   المخزن يخزّن بمفتاح منظّف (الفراغات صارت _) بينما الفاتورة
   تخزّن الاسم الخام. مطابقة الاسم لحاله كانت تفشل بأغلب
   المنتجات العربية، فترجع الكلفة صفر والربح يطلع كامل السعر. */
export function buildResolver(wh) {
  const byKey = {}, byName = {}, byNorm = {};
  for (const [k, p] of Object.entries(wh || {})) {
    if (!p || typeof p !== "object") continue;
    byKey[k] = p;
    if (p.name) byName[clean(p.name)] = p;
    byNorm[toKey(k)] = p;
    if (p.name) byNorm[toKey(p.name)] = p;
  }
  return n => byKey[n] || byName[clean(n)] || byNorm[toKey(n)] || null;
}

/* ── كلفة البند ──
   الكلفة المثبّتة وقت البيع تفوز دائماً: تغيير سعر الشراء اليوم
   ما يجوز يغيّر ربح فاتورة انباعت قبل شهرين. */
export function itemCost(item, resolve) {
  const frozen = Number(item?.buyPrice) || 0;
  if (frozen > 0) return frozen;
  const p = resolve ? resolve(item?.product) : null;
  return p ? Number(p.buyPrice) || 0 : 0;
}

/* ── بنود الفاتورة ──
   Firebase يرجّع المصفوفة أحياناً على شكل كائن {0:…,1:…} إذا كان
   فيها فراغات بالمفاتيح. لو اعتمدنا Array.isArray لحالها راح
   نتجاهل بنود الفاتورة كلها بصمت ويطلع ربحها صفر. */
export function itemsOf(inv) {
  const it = inv?.items;
  if (Array.isArray(it)) return it.filter(Boolean);
  if (it && typeof it === "object") return Object.values(it).filter(Boolean);
  return [];
}

let _mem = null;

export async function loadCenterData(force = false) {
  if (!force && _mem && Date.now() - _mem.ts < CACHE_TTL) return _mem.data;

  if (!force) {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (Date.now() - c.ts < CACHE_TTL) {
          const data = finish(c.inv, c.wh);
          _mem = { ts: c.ts, data };
          return data;
        }
      }
    } catch (e) { /* كاش تالف — نتجاهله ونحمّل من جديد */ }
  }

  const [iSnap, wSnap] = await Promise.all([
    get(ref(rtdb, "posInvoices")),
    get(ref(rtdb, "warehouse"))
  ]);

  const invRaw = iSnap.exists() ? iSnap.val() : {};
  const whRaw = wSnap.exists() ? wSnap.val() : {};

  const invoices = Object.entries(invRaw)
    .map(([id, v]) => ({ id, ...v }))
    .filter(v => v && Number(v.createdAt) > 0)
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

  /* نخفّف المخزن قبل التخزين — نحتاج الاسم والكلفة والكمية والسعر بس */
  const wh = {};
  for (const [k, p] of Object.entries(whRaw)) {
    if (!p || typeof p !== "object") continue;
    wh[k] = {
      name: p.name || k,
      buyPrice: Number(p.buyPrice) || 0,
      totalQty: Number(p.totalQty) || 0,
      pos: Number(p?.prices?.pos) || 0
    };
  }

  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), inv: invoices, wh })); }
  catch (e) { /* أكبر من حد التخزين — نكمل بدون كاش */ }

  const data = finish(invoices, wh);
  _mem = { ts: Date.now(), data };
  return data;
}

function finish(invoices, warehouse) {
  const resolve = buildResolver(warehouse);
  return {
    invoices,
    warehouse,
    resolve,
    buyPriceOf: name => { const p = resolve(name); return p ? Number(p.buyPrice) || 0 : 0; },
    costOf: item => itemCost(item, resolve)
  };
}

/* ── حساب أرباح مجموعة فواتير ──
   منطق واحد يستعمله الكل، حتى ما تختلف الأرقام بين الصفحات.

   الإرجاع: الكاشير يخزّن الكمية بالسالب بينما المبلغ يبقى موجب،
   فالإرجاع ينقص من المبيعات وينقص كلفته من الكلفة — يعني أثره
   على الربح = -(مبلغ الإرجاع - كلفة البضاعة الراجعة). */
export function computeProfit(rows, costOf) {
  let revenue = 0, cost = 0, retValue = 0, retCost = 0;
  let sales = 0, returns = 0, units = 0;

  for (const inv of rows || []) {
    const isRet = inv.type === "return";
    if (isRet) returns++; else sales++;

    for (const it of itemsOf(inv)) {
      const q = Number(it.qty) || 0;
      const lineTotal = Math.abs(Number(it.total) || 0);
      const bp = costOf ? costOf(it) : (Number(it.buyPrice) || 0);
      const aq = Math.abs(q);

      if (isRet || q < 0) {           // بضاعة راجعة
        retValue += lineTotal;
        retCost += bp * aq;
      } else {                        // بيع
        revenue += lineTotal;
        cost += bp * q;
        units += q;
      }
    }
  }

  const netRevenue = revenue - retValue;
  const netCost = cost - retCost;
  const profit = netRevenue - netCost;

  return {
    revenue, cost, retValue, retCost,
    netRevenue, netCost, profit,
    margin: netRevenue > 0 ? (profit / netRevenue) * 100 : 0,
    sales, returns, units,
    avgTicket: sales > 0 ? netRevenue / sales : 0
  };
}

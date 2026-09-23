// ════════════════════════════════════════════════════════
// 📦 دفتر المخزن المشترك — المصدر الوحيد لخصم وإرجاع البضاعة
// نفس الكود بالضبط يُستخدم من:
//   1) orders-cards.html  (النقل الجماعي بين الحالات)
//   2) order-details.html (تعديل طلب مفرد)
//   3) add-order.html     (إنشاء طلب مثبت مباشرة)
// ────────────────────────────────────────────────────────
// ⚠️ ليش انوحّد (2026-09-22): قبل، كل صفحة عندها نسختها الخاصة بمنطق
// مختلف، وهذا سبب ضياع بضاعة فعلي:
//   • orders-cards كانت تحط "علامة" بالمخزن تمنع الخصم/الإرجاع مرتين،
//     وorder-details تخصم وترجّع مباشرة بدون أي علامة. فطلب انخصم من
//     صفحة التفاصيل (بلا علامة) ثم انتقل جماعياً لحالة ترجيع → النظام
//     يشوف "ماكو علامة خصم" ويتجاهله، فالبضاعة ما ترجع للمخزن أبداً.
//   • حالة "بانتظار البضاعة" ما كانت ترجّع البضاعة بأي صفحة.
//   • حالة "رفض" ترجّع بصفحة التفاصيل بس، وبشرط تكون الحالة السابقة
//     "مثبت" بالضبط — فطلب راح مثبت ← قيد التجهيز ← رفض ما يرجع.
//   • علامة الخصم كانت تبقى للأبد، فالطلب المرفوض إذا رجعت ثبّته ما
//     ينخصم مرة ثانية.
//
// الحل: علامة وحدة بالمخزن تقرر إذا الطلب "مخصوم حالياً" أو لا:
// الخصم يحطها (وبداخلها الكمية المخصومة فعلاً)، والإرجاع يشيلها.
// فأي دورة تشتغل صح مهما تكررت: مثبت ← رفض ← مثبت ← بانتظار البضاعة...
// وأي استدعاء زايد ما يأثر بشي (خصم لطلب مخصوم = لا شي، إرجاع لطلب
// مو مخصوم = لا شي)، فصار آمن نناديه بكل انتقال بدون حساب الحالة السابقة.
//
// الاستخدام: الصفحة تحمّل هذا الملف بوسم <script src> عادي قبل سكربتها،
// وبأول سكربتها تنادي initStockLedger({ db, ref, get, update, runTransaction })
// حتى نوصل لفايربيس بدون ما نستورده هنا (هذا ملف سكربت عادي مو module).
// ════════════════════════════════════════════════════════
(function (global) {
  let FB = null;

  function initStockLedger(bindings) { FB = bindings; }

  function ensureReady() {
    if (!FB) throw new Error("stockLedger: لازم تنادي initStockLedger أول");
  }

  // ── تطبيع الأسماء والمتغيرات ──
  const cleanName = n => String(n || "").trim().replace(/\s+/g, " ");

  // مفتاح المتغير كما يُخزّن بالمخزن: "اللون | أحمر | القياس | L"
  function getStockKey(item) {
    if (item && item.variants && Object.keys(item.variants).length) {
      return Object.entries(item.variants)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k} | ${v}`).join(" | ");
    }
    return "default";
  }

  // المقارنة تتجاهل ترتيب الأجزاء والفراغات — نفس المتغير ممكن ينخزن
  // بترتيب مختلف بين الطلب والمخزن
  const normVariant = t =>
    String(t || "").split("|").map(s => s.trim()).filter(Boolean).sort().join("|");

  // يلقي مفتاح المتغير الفعلي الموجود بالمخزن المطابق للمطلوب
  function matchStockKey(stock, wantedKey) {
    if (Object.prototype.hasOwnProperty.call(stock, wantedKey)) return wantedKey;
    const hasVariants = Object.keys(stock).some(k => k.includes("|"));
    if (!hasVariants) return Object.prototype.hasOwnProperty.call(stock, "default") ? "default" : null;
    const want = normVariant(wantedKey);
    for (const k of Object.keys(stock)) if (normVariant(k) === want) return k;
    return null;
  }

  // ── إيجاد المنتج بالمخزن (المخزن يخزّن الأسماء بصيغ مختلفة تاريخياً) ──
  async function findWarehouseKey(pname) {
    ensureReady();
    const { db, ref, get } = FB;
    const original = cleanName(pname);
    if (!original) return null;

    const direct = await get(ref(db, `warehouse/${original}`));
    if (direct.exists()) return { key: original, snap: direct };

    const safe = original.replace(/[.#$\[\]\/]/g, "_").replace(/\s+/g, "_");
    if (safe !== original) {
      const safeSnap = await get(ref(db, `warehouse/${safe}`));
      if (safeSnap.exists()) return { key: safe, snap: safeSnap };
    }

    // ⚠️ إصلاح تكلفة (2026-09-23): هنا كنا ننزّل فرع warehouse كامل
    // (٥١٦ كيلوبايت) بس حتى نلقي مفتاح منتج واحد — وهذا يصير بكل
    // خصم وإرجاع، يعني آلاف المرات بالشهر. هسه نقرا سطر واحد من
    // فهرس الأسماء اللي يبنيه السيرفر تلقائياً (warehouseIndex).
    // مفتاح الفهرس = الاسم المنظّف بعد استبدال الرموز الممنوعة بفايربيس
    // بس (بدون لمس الفراغات) — نفس التحويل المستخدم بالسيرفر تماماً
    const idxKey = original.replace(/[.#$\[\]\/]/g, "_");
    try {
      const idxSnap = await get(ref(db, `warehouseIndex/${idxKey}`));
      if (idxSnap.exists()) {
        const key = idxSnap.val();
        const matchSnap = await get(ref(db, `warehouse/${key}`));
        if (matchSnap.exists()) return { key, snap: matchSnap };
      }
    } catch (e) {
      console.warn("warehouseIndex:", e.message);
    }

    // احتياط أخير: الطريقة القديمة (تشتغل بس إذا الفهرس مو جاهز بعد)
    const allSnap = await get(ref(db, "warehouse"));
    if (allSnap.exists()) {
      const all = allSnap.val();
      const matchKey = Object.keys(all).find(k =>
        cleanName(all[k] && all[k].name) === original ||
        cleanName(k.replace(/_/g, " ")) === original
      );
      if (matchKey) {
        const matchSnap = await get(ref(db, `warehouse/${matchKey}`));
        return { key: matchKey, snap: matchSnap };
      }
    }
    return null;
  }

  // ── قراءة بنود الطلب بصيغة موحّدة، مع جمع المكرر ──
  // (نفس المنتج بنفس المتغير ممكن ينذكر مرتين بالطلب — لازم يتجمع حتى
  //  الكمية المخصومة تطابق الكمية المرجّعة بالضبط)
  function orderItems(order) {
    let items = (order && Array.isArray(order.productsDetailed)) ? order.productsDetailed : [];
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
      if (prev) prev.qty += qty;
      else merged.set(id, { name, vkey, qty });
    }
    return Array.from(merged.values());
  }

  // ── مفاتيح العلامات بالمخزن ──
  // الحالات اللي البضاعة فيها طالعة من المخزن فعلياً — نستخدمها بس
  // للطلبات القديمة اللي انثبتت قبل هذا النظام وماكو عندها علامة خصم
  const STOCK_OUT_STATUSES = ["مثبت", "قيد التجهيز", "قيد التوصيل", "تم التسليم", "راجع"];

  // ⚠️ العلامات انتقلت خارج warehouse (2026-09-23): كانت تنخزن تحت
  // warehouse/<المنتج>/processedOrders، وهذا يعني إن كل زبون يفتح المتجر
  // ينزّل كل علامات كل الطلبات اللي مرّت على كل منتج — وهي تكبر للأبد مع
  // كل طلب. صفحة المتجر تجيب warehouse كامل، فالفتحة الأولى كانت تثقل
  // شهر بعد شهر بلا أي سبب ظاهر. هسه بفرع مستقل ما يقراه المتجر إطلاقاً.
  // نقرا الفرع القديم هم، حتى الطلبات المسجلة قبل هذا التعديل تبقى صحيحة.
  const markPath  = (pkey, mark) => `stockMarkers/${pkey}/${mark}`;
  const markRoot  = pkey => `stockMarkers/${pkey}`;
  const oldPath   = (pkey, mark) => `warehouse/${pkey}/processedOrders/${mark}`;

  // يقرا العلامة من الفرع الجديد، وإذا ماكو يشوف القديم
  async function readMark(pkey, mark) {
    const { db, ref, get } = FB;
    const cur = await get(ref(db, markPath(pkey, mark)));
    if (cur.exists()) return { exists: true, val: cur.val(), legacy: false };
    const old = await get(ref(db, oldPath(pkey, mark)));
    if (old.exists()) return { exists: true, val: old.val(), legacy: true };
    return { exists: false, val: null, legacy: false };
  }

  // يكتب/يحذف بالفرعين حتى ما تبقى علامة يتيمة بالقديم
  async function writeMarks(pkey, patch) {
    const { db, ref, update } = FB;
    await update(ref(db, markRoot(pkey)), patch);
    const clearOld = {};
    for (const k of Object.keys(patch)) clearOld[k] = null;
    await update(ref(db, `warehouse/${pkey}/processedOrders`), clearOld).catch(() => {});
  }

  const sanitize = s => String(s).replace(/[.#$\[\]\/]/g, "_").replace(/\s+/g, "_");
  const deductMarker = (orderId, name, vkey) => `deduct_${sanitize(orderId)}_${sanitize(name)}_${sanitize(vkey)}`;
  // علامة قديمة من النظام السابق — نقراها بس حتى ما نرجّع بضاعة رجعت أصلاً
  const legacyReturnMarker = (orderId, name, vkey) => `return_${sanitize(orderId)}_${sanitize(name)}_${sanitize(vkey)}`;
  // علامة نحطها لما نرجّع بضاعة طلب قديم بلا علامة خصم — تمنع تكرار الإرجاع
  const legacyRestoredMarker = (orderId, name, vkey) => `legacyRestored_${sanitize(orderId)}_${sanitize(name)}_${sanitize(vkey)}`;

  // بعد أي تغيير نعيد حساب المجموع من الأرقام الفعلية بدل ما نجمع/نطرح
  // عليه — هيچي أي انحراف قديم بالمجموع ينصلح لحاله
  async function refreshTotal(pkey) {
    const { db, ref, get, update } = FB;
    const snap = await get(ref(db, `warehouse/${pkey}/stock`));
    const total = Object.values(snap.val() || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    await update(ref(db, `warehouse/${pkey}`), {
      totalQty: total,
      lastUpdate: new Date().toISOString()
    });
  }

  // ── فحص توفر الكمية قبل التثبيت ──
  // يرجّع { ok: true } أو { ok: false, msg } — نفس الشكل المستخدم بالصفحات
  async function checkStockAvailable(order) {
    ensureReady();
    const items = orderItems(order);
    if (!items.length) return { ok: true };

    for (const { name, vkey, qty } of items) {
      const found = await findWarehouseKey(name);
      if (!found) return { ok: false, msg: `❌ المنتج "${name}" غير موجود بالمخزن` };
      const stock = (found.snap.val() || {}).stock || {};
      const key = matchStockKey(stock, vkey);
      if (!key) return { ok: false, msg: `⚠️ المتغير غير موجود بالمخزن: ${name} (${vkey})` };
      const avail = Number(stock[key]);
      if (isNaN(avail) || avail < qty) {
        return {
          ok: false,
          msg: `❌ الكمية غير كافية: ${name}${vkey !== "default" ? " (" + vkey + ")" : ""} — المتاح ${isNaN(avail) ? 0 : avail} والمطلوب ${qty}. استخدم حالة "بانتظار البضاعة" بدلاً من التثبيت`
        };
      }
    }
    return { ok: true };
  }

  // ── خصم بضاعة الطلب من المخزن ──
  // آمن للتكرار: إذا الطلب مخصوم أصلاً ما يصير شي
  async function deductStockForOrder(order) {
    ensureReady();
    const { db, ref, get, update, runTransaction } = FB;
    const orderId = order && order.id;
    if (!orderId) { console.warn("⚠️ stockLedger: خصم بدون رقم طلب — تم التجاهل"); return; }

    for (const { name, vkey, qty } of orderItems(order)) {
      const found = await findWarehouseKey(name);
      if (!found) { console.warn(`⚠️ stockLedger: المنتج غير موجود بالمخزن — ${name}`); continue; }
      const pkey = found.key;

      const mark = deductMarker(orderId, name, vkey);
      const already = await readMark(pkey, mark);
      if (already.exists) continue; // مخصوم أصلاً

      const stock = (found.snap.val() || {}).stock || {};
      const stockKey = matchStockKey(stock, vkey);
      if (!stockKey) { console.warn(`⚠️ stockLedger: المتغير غير موجود — ${name} (${vkey})`); continue; }

      await runTransaction(ref(db, `warehouse/${pkey}/stock/${stockKey}`),
        cur => Math.max(0, (Number(cur) || 0) - qty));

      // ✅ نخزن الكمية المخصومة داخل العلامة نفسها، حتى لو انعدّلت بنود
      // الطلب بعدين يرجع بالضبط اللي انخصم، مو اللي بالطلب هسه
      await writeMarks(pkey, { [mark]: qty, [legacyReturnMarker(orderId, name, vkey)]: null });
      await refreshTotal(pkey);
    }
  }

  // ── إرجاع بضاعة الطلب للمخزن ──
  // آمن للتكرار: إذا الطلب مو مخصوم (أو رجع أصلاً) ما يصير شي
  // prevStatus (اختياري): الحالة اللي كان بيها الطلب قبل الانتقال — نحتاجها
  // بس للطلبات القديمة اللي انثبتت قبل هذا النظام
  async function restoreStockForOrder(order, prevStatus) {
    ensureReady();
    const { db, ref, get, update, runTransaction } = FB;
    const orderId = order && order.id;
    if (!orderId) { console.warn("⚠️ stockLedger: إرجاع بدون رقم طلب — تم التجاهل"); return; }

    for (const { name, vkey, qty } of orderItems(order)) {
      const found = await findWarehouseKey(name);
      if (!found) continue;
      const pkey = found.key;

      const mark = deductMarker(orderId, name, vkey);
      const markSnap = await readMark(pkey, mark);

      if (!markSnap.exists) {
        // ⚠️ طلب قديم: انثبت قبل ما يصير عدنا دفتر مخزن، فبضاعته انخصمت
        // بدون ما تنسجل أي علامة (صفحة تفاصيل الطلب وصفحة الإضافة ما كانوا
        // يسجلون). ما نقدر نتجاهله وإلا البضاعة ما ترجع أبداً. نعتمد على
        // الحالة السابقة: إذا كان بحالة بضاعتها طالعة من المخزن، يعني
        // مخصوم فعلاً ونرجّعه — مرة وحدة بس (علامة legacyRestored تمنع التكرار).
        if (!prevStatus || !STOCK_OUT_STATUSES.includes(prevStatus)) continue;

        const legacyMark = legacyRestoredMarker(orderId, name, vkey);
        const legacyDone = await readMark(pkey, legacyMark);
        if (legacyDone.exists) continue;

        const stockNow = (found.snap.val() || {}).stock || {};
        const key = matchStockKey(stockNow, vkey);
        if (!key) continue;

        await runTransaction(ref(db, `warehouse/${pkey}/stock/${key}`), cur => (Number(cur) || 0) + qty);
        await writeMarks(pkey, { [legacyMark]: qty });
        await refreshTotal(pkey);
        console.log(`↩️ stockLedger: رجّعنا ${qty} من "${name}" لطلب قديم #${orderId} (كان بحالة ${prevStatus})`);
        continue;
      }

      // حالة قديمة: النظام السابق خصم ورجّع وخلّى العلامتين. نشيل علامة
      // الخصم بس بدون ما نضيف كمية (البضاعة رجعت فعلاً قبل)، حتى الطلب
      // يقدر ينخصم من جديد إذا انثبت مرة ثانية.
      const legacy = legacyReturnMarker(orderId, name, vkey);
      const legacySnap = await readMark(pkey, legacy);
      if (legacySnap.exists) {
        await writeMarks(pkey, { [mark]: null, [legacy]: null });
        continue;
      }

      const stored = Number(markSnap.val);
      const back = (!isNaN(stored) && stored > 0) ? stored : qty;

      await runTransaction(ref(db, `warehouse/${pkey}/stock/${matchStockKey((found.snap.val() || {}).stock || {}, vkey) || vkey}`),
        cur => (Number(cur) || 0) + back);

      await writeMarks(pkey, { [mark]: null });
      await refreshTotal(pkey);
    }
  }

  // ── الحالات اللي ترجّع البضاعة للمخزن ──
  // (الاستدعاء آمن دائماً، فما نحتاج نتأكد من الحالة السابقة)
  const STOCK_RETURN_STATUSES = ["رفض", "ملغي", "بانتظار البضاعة", "تم استلام الراجع"];
  const STOCK_DEDUCT_STATUSES = ["مثبت"];

  // نقطة وحدة تنادى بعد أي تغيير حالة — هي اللي تقرر يخصم لو يرجّع
  async function applyStockForStatus(order, newStatus, prevStatus) {
    if (STOCK_DEDUCT_STATUSES.includes(newStatus)) return deductStockForOrder(order);
    if (STOCK_RETURN_STATUSES.includes(newStatus)) return restoreStockForOrder(order, prevStatus);
  }

  global.initStockLedger        = initStockLedger;
  global.getStockKey            = getStockKey;
  global.findWarehouseKey       = findWarehouseKey;
  global.checkStockAvailable    = checkStockAvailable;
  global.deductStockForOrder    = deductStockForOrder;
  global.restoreStockForOrder   = restoreStockForOrder;
  global.applyStockForStatus    = applyStockForStatus;
  global.STOCK_RETURN_STATUSES  = STOCK_RETURN_STATUSES;
  global.STOCK_OUT_STATUSES     = STOCK_OUT_STATUSES;
  global.STOCK_DEDUCT_STATUSES  = STOCK_DEDUCT_STATUSES;
})(window);

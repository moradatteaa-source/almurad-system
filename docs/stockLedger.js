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

  // ════════════════════════════════════════════════════════
  // 🔄 الموازنة — قلب الدفتر الجديد (2026-09-30)
  // ────────────────────────────────────────────────────────
  // ليش انتغيّر: النظام القديم كان يشتغل بـ"علامات" لكل بند
  // (deduct_<الطلب>_<المنتج>_<المتغير>). العلامة تمنع الخصم مرتين —
  // بس هي بنفس الوقت تمنع أي تصحيح:
  //
  //   • موظف يغيّر متغير طلب مثبت (الدب أحمر ← أزرق):
  //     الأزرق ينخصم (ماكو علامة له)، والأحمر يبقى مخصوم للأبد
  //     (علامته موجودة وما أحد يشيلها). قطعة تضيع كل مرة.
  //   • موظف يغيّر الكمية من ٢ إلى ٥: العلامة موجودة → ما يصير
  //     ولا شي. المخزن ناقص ٢ والطلب يقول ٥.
  //   • موظف يبدّل المنتج كلياً: المنتج القديم يبقى ناقص والجديد
  //     ينخصم — خسارة مزدوجة.
  //
  // الحل: بدل "علامة موجودة/مو موجودة"، نسجّل بالضبط **شنو مخصوم
  // حالياً لهذا الطلب** بسجل واحد:
  //     stockApplied/<رقم الطلب> = { items: { "<منتج>::<متغير>": كمية } }
  // وكل مرة ننادي الدفتر، نحسب **شنو لازم يكون مخصوم** حسب بنود
  // الطلب وحالته، ونطبّق **الفرق** بس.
  //
  // هيچي دورة وحدة تعالج كل شي: إنشاء، تعديل كمية، تبديل متغير،
  // تبديل منتج، حذف بند، رفض، إرجاع، حذف الطلب. ومناداتها مرتين
  // ما تسوي شي (الفرق = صفر).
  // ════════════════════════════════════════════════════════

  const APPLIED_ROOT = "stockApplied";
  const SEP = "::";

  // الحالات اللي البضاعة فيها **طالعة** من المخزن فعلياً.
  // أي حالة غيرها = البضاعة **بالمخزن**. ما نحتاج قائمتين تتناقضان.
  //   طالعة : مثبت، قيد التجهيز، قيد التوصيل، تم التسليم، راجع
  //   بالمخزن: جديد، قيد المعالجة، بانتظار البضاعة،
  //            تم استلام الراجع، رفض، ملغي
  // ملاحظة "راجع": البضاعة بيد المندوب لسه ما وصلت، فتبقى مخصومة
  // لحد "تم استلام الراجع".
  const STOCK_OUT_STATUSES = ["مثبت", "قيد التجهيز", "قيد التوصيل", "تم التسليم", "راجع"];
  const isStockOut = st => STOCK_OUT_STATUSES.includes(String(st || "").trim());

  async function readApplied(orderId) {
    const { db, ref, get } = FB;
    const snap = await get(ref(db, `${APPLIED_ROOT}/${sanitize(orderId)}`));
    if (!snap.exists()) return null;          // null = ما عندنا سجل، نجرب القديم
    return (snap.val() || {}).items || {};
  }

  async function writeApplied(orderId, items) {
    const { db, ref, update } = FB;
    const val = (items && Object.keys(items).length)
      ? { items, at: Date.now() } : null;
    await update(ref(db, APPLIED_ROOT), { [sanitize(orderId)]: val });
  }

  // ── الطلبات القديمة ──
  // انثبتت قبل هذا النظام فعندها علامات بدل سجل. نبني منها الحالة
  // الحالية حتى ما ننخصم مرتين، ونشيلها بعد أول موازنة ناجحة.
  async function seedFromLegacy(orderId, order) {
    const items = {}, marks = [];
    for (const it of orderItems(order)) {
      const found = await findWarehouseKey(it.name);
      if (!found) continue;
      const stock = (found.snap.val() || {}).stock || {};
      const sk = matchStockKey(stock, it.vkey);
      if (!sk) continue;
      const mark = deductMarker(orderId, it.name, it.vkey);
      const m = await readMark(found.key, mark);
      if (!m.exists) continue;
      const id = found.key + SEP + sk;
      const q = Number(m.val);
      items[id] = (items[id] || 0) + (q > 0 ? q : it.qty);
      marks.push({ pkey: found.key, mark });
    }
    return { items, marks };
  }

  // ── الموازنة ──
  // shouldBeOut = true  → بضاعة الطلب لازم تكون مخصومة
  // shouldBeOut = false → بضاعة الطلب لازم تكون بالمخزن
  // ترجّع { ok, problems: [نص] } — المشاكل تنعرض للموظف بدل ما
  // تنبلع بصمت مثل قبل
  async function reconcileStockForOrder(order, shouldBeOut) {
    ensureReady();
    const { db, ref, runTransaction } = FB;
    const orderId = order && order.id;
    if (!orderId) return { ok: false, problems: ["ماكو رقم طلب — ما قدرنا نعدّل المخزن"] };

    const problems = [];

    // (١) شنو مخصوم حالياً
    let applied = await readApplied(orderId);
    let legacyMarks = [];
    if (applied === null) {
      const seed = await seedFromLegacy(orderId, order);
      applied = seed.items;
      legacyMarks = seed.marks;
    }

    // (٢) شنو **لازم** يكون مخصوم
    const desired = {};
    if (shouldBeOut) {
      for (const it of orderItems(order)) {
        const found = await findWarehouseKey(it.name);
        if (!found) {
          problems.push(`المنتج مو موجود بالمخزن: ${it.name}`);
          continue;
        }
        const stock = (found.snap.val() || {}).stock || {};
        const sk = matchStockKey(stock, it.vkey);
        if (!sk) {
          problems.push(`المتغير مو موجود بالمخزن: ${it.name} (${it.vkey})`);
          continue;
        }
        const id = found.key + SEP + sk;
        desired[id] = (desired[id] || 0) + it.qty;
      }
    }

    // (٣) نطبّق الفرق بس
    const ids = new Set([...Object.keys(applied), ...Object.keys(desired)]);
    const touched = new Set();
    const next = {};

    for (const id of ids) {
      const was = Number(applied[id]) || 0;
      const want = Number(desired[id]) || 0;
      const at = id.indexOf(SEP);
      const pkey = id.slice(0, at), sk = id.slice(at + SEP.length);
      touched.add(pkey);

      const delta = want - was;      // موجب = نخصم زيادة، سالب = نرجّع
      if (delta === 0) { if (want > 0) next[id] = want; continue; }

      let actual = 0;
      let res = null;
      try {
        res = await runTransaction(ref(db, `warehouse/${pkey}/stock/${sk}`), cur => {
          const before = Number(cur) || 0;
          // ما ننزل تحت الصفر، ونسجّل الي انخصم **فعلاً** مو الي طلبناه —
          // بدون هذا، رفض الطلب لاحقاً يرجّع أكثر مما أخذ ويخلق بضاعة
          // من العدم
          const after = Math.max(0, before - delta);
          actual = before - after;
          return after;
        });
      } catch (e) {
        problems.push(`ما قدرنا نعدّل: ${pkey} (${sk})`);
        continue;
      }
      if (res && res.committed === false) {
        problems.push(`ما انحفظ التعديل: ${pkey} (${sk})`);
        continue;
      }

      const now = was + actual;
      if (now > 0) next[id] = now;
      if (delta > 0 && actual < delta) {
        problems.push(
          `الكمية ما تكفي: ${pkey}${sk !== "default" ? " (" + sk + ")" : ""} — ` +
          `انخصم ${actual} من ${delta} المطلوبة`
        );
      }
    }

    // (٤) نثبّت الحالة الجديدة
    await writeApplied(orderId, next);
    for (const { pkey, mark } of legacyMarks) {
      await writeMarks(pkey, { [mark]: null }).catch(() => {});
    }
    for (const pkey of touched) await refreshTotal(pkey).catch(() => {});

    return { ok: problems.length === 0, problems };
  }

  // ── الواجهات ── نفس الأسماء القديمة حتى ما تنكسر الصفحات ──
  const deductStockForOrder  = order => reconcileStockForOrder(order, true);
  const restoreStockForOrder = order => reconcileStockForOrder(order, false);
  // تُنادى عند حذف الطلب — ترجّع بضاعته للمخزن
  const releaseStockForOrder = order => reconcileStockForOrder(order, false);

  // نقطة وحدة تنادى بعد أي تغيير حالة **أو أي تعديل على البنود**
  async function applyStockForStatus(order, newStatus /*, prevStatus */) {
    return reconcileStockForOrder(order, isStockOut(newStatus));
  }

  // للتوافق مع الكود القديم
  const STOCK_RETURN_STATUSES = ["رفض", "ملغي", "بانتظار البضاعة", "تم استلام الراجع"];
  const STOCK_DEDUCT_STATUSES = ["مثبت"];

  global.initStockLedger         = initStockLedger;
  global.getStockKey             = getStockKey;
  global.findWarehouseKey        = findWarehouseKey;
  global.checkStockAvailable     = checkStockAvailable;
  global.deductStockForOrder     = deductStockForOrder;
  global.restoreStockForOrder    = restoreStockForOrder;
  global.releaseStockForOrder    = releaseStockForOrder;
  global.reconcileStockForOrder  = reconcileStockForOrder;
  global.applyStockForStatus     = applyStockForStatus;
  global.isStockOut              = isStockOut;
  global.STOCK_RETURN_STATUSES   = STOCK_RETURN_STATUSES;
  global.STOCK_OUT_STATUSES      = STOCK_OUT_STATUSES;
  global.STOCK_DEDUCT_STATUSES   = STOCK_DEDUCT_STATUSES;
})(window);

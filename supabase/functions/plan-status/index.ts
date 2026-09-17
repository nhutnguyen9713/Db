// TN5 Dashboard — Edge Function "plan-status"
//
// Tính sẵn (server-side) toàn bộ "công thức" so sánh Plan vs tồn kho + Picking Status — PORT NGUYÊN
// VẸN logic từ app.js (buildItemIndex, buildItemCustPoIndex, buildPickingIndex, phần tính toán của
// renderContainerPickingOverview(), buildCompareTable(), buildCombinedPlanCompareTable() và các hàm
// phụ trợ liên quan tới Ship/Kho/SPP) — CHỈ trả về DỮ LIỆU đã tính xong (mảng/số), KHÔNG trả HTML.
// Phần dựng bảng HTML vẫn nằm ở client (app.js) — không có giá trị gì để "đánh cắp", chỉ là hiển thị.
//
// Không nhận tham số đầu vào — tự đọc TOÀN BỘ dữ liệu cần thiết từ bảng "dashboard_kv" (đúng những
// key mà CloudVault đã đồng bộ lên), dùng SUPABASE_SERVICE_ROLE_KEY (biến môi trường Supabase TỰ
// CẤP SẴN cho mọi Edge Function, không cần cấu hình gì thêm) để đọc thẳng, không phụ thuộc RLS.

// deno-lint-ignore-file no-explicit-any

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TABLE = "dashboard_kv";

const PLAN_TYPES = ["Row", "FC", "HCP"] as const;
type PlanType = typeof PLAN_TYPES[number];

// ============ Đọc dữ liệu thô từ dashboard_kv ============

async function readRows(): Promise<Record<string, any>> {
  const url = `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${TABLE}?select=key,value`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`Đọc dashboard_kv lỗi: HTTP ${res.status}`);
  const rows: { key: string; value: any }[] = await res.json();
  const obj: Record<string, any> = {};
  for (const r of rows) {
    if (r.value !== null && r.value !== undefined) obj[r.key] = r.value;
  }
  return obj;
}

// ============ Helper: giống hệt jsonReviver ở app.js — {__date: iso} do JSON.stringify(jsonReplacer)
// sinh ra khi ghi Date lên Cloud. Chỉ cần đúng chuỗi "DD/MM/YYYY" (theo giờ UTC, y hệt fmtDate() gốc
// dùng getUTCDate/getUTCMonth/getUTCFullYear) — không cần dựng lại nguyên đối tượng Date. ============
function fmtDateVal(v: any): string {
  if (!v) return "";
  const iso = typeof v === "object" && v.__date ? v.__date : typeof v === "string" ? v : null;
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// ============ Vị trí "Prod" — loại khỏi tồn kho khả dụng (y hệt PROD_LOCATOR_RE ở app.js) ============
const PROD_LOCATOR_RE = /prod/i;

// ============ contInstanceKey / isContainerHidden — y hệt app.js ============
function contInstanceKey(type: string, cNo: string, loadDate: string, planTime: string): string {
  return `${type}|${cNo}|${loadDate || ""}|${planTime || ""}`;
}
function isContainerHidden(
  hiddenPlanContainers: Record<string, any>,
  type: string,
  cNo: string,
  loadDate: string,
  planTime: string,
): boolean {
  return !!hiddenPlanContainers[contInstanceKey(type, cNo || "", loadDate, planTime)];
}

// ============ ccIsSppItem / sppOkKey — y hệt app.js ============
function ccIsSppItem(item: string): boolean {
  return !/^0/.test(String(item || "").trim());
}
function sppOkKey(item: string, custpo: string): string {
  return String(item || "").toLowerCase() + "␟" + String(custpo || "").toLowerCase();
}

// ============ buildItemIndex / buildItemCustPoIndex — y hệt app.js (bỏ phần cache theo tham chiếu,
// vì mỗi lần gọi Edge Function là 1 lượt tính mới hoàn toàn) ============
type InvEntry = { byKho: Record<string, number>; pass: number; ng: number; other: number };

function buildItemIndex(khoDetail: Record<string, any[]>): Record<string, InvEntry> {
  const idx: Record<string, InvEntry> = {};
  for (const kho of Object.keys(khoDetail || {})) {
    for (const row of khoDetail[kho]) {
      const [item, , locator, oqc, qty] = row;
      if (PROD_LOCATOR_RE.test(locator || "")) continue;
      const key = String(item).toLowerCase();
      if (!idx[key]) idx[key] = { byKho: {}, pass: 0, ng: 0, other: 0 };
      idx[key].byKho[kho] = (idx[key].byKho[kho] || 0) + qty;
      const o = String(oqc || "").toUpperCase();
      if (o === "PASS") idx[key].pass += qty;
      else if (o === "NG") idx[key].ng += qty;
      else idx[key].other += qty;
    }
  }
  return idx;
}

function buildItemCustPoIndex(khoDetail: Record<string, any[]>): Record<string, InvEntry> {
  const idx: Record<string, InvEntry> = {};
  for (const kho of Object.keys(khoDetail || {})) {
    for (const row of khoDetail[kho]) {
      const [item, custpo, locator, oqc, qty] = row;
      if (PROD_LOCATOR_RE.test(locator || "")) continue;
      const key = String(item).toLowerCase() + "␟" + String(custpo || "").toLowerCase();
      if (!idx[key]) idx[key] = { byKho: {}, pass: 0, ng: 0, other: 0 };
      idx[key].byKho[kho] = (idx[key].byKho[kho] || 0) + qty;
      const o = String(oqc || "").toUpperCase();
      if (o === "PASS") idx[key].pass += qty;
      else if (o === "NG") idx[key].ng += qty;
      else idx[key].other += qty;
    }
  }
  return idx;
}

// ============ getItemLocatorIndex / buildItemLocatorDetail — y hệt app.js ============
type LocEntry = { kho: string; locator: string; custpo: string; oqc: string; qty: number };

function buildItemLocatorIndex(khoDetail: Record<string, any[]>): Map<string, LocEntry[]> {
  const idx = new Map<string, LocEntry[]>();
  for (const kho of Object.keys(khoDetail || {})) {
    for (const row of khoDetail[kho]) {
      const [it, custpo, locator, oqc, qty] = row;
      const key = String(it).toLowerCase();
      let arr = idx.get(key);
      if (!arr) { arr = []; idx.set(key, arr); }
      arr.push({ kho, locator, custpo, oqc, qty });
    }
  }
  return idx;
}

function buildItemLocatorDetail(
  locIdx: Map<string, LocEntry[]>,
  item: string,
  po: string | null,
  excludeProd: boolean,
): LocEntry[] {
  const entries = locIdx.get(String(item).toLowerCase()) || [];
  const poLower = po ? po.trim().toLowerCase() : "";
  const rows: LocEntry[] = [];
  for (const e of entries) {
    if (poLower && String(e.custpo || "").trim().toLowerCase() !== poLower) continue;
    if (excludeProd && PROD_LOCATOR_RE.test(e.locator || "")) continue;
    rows.push(e);
  }
  return rows.sort((a, b) => b.qty - a.qty);
}

// ============ buildPickingIndex — y hệt app.js ============
function buildPickingIndex(khoDetail: Record<string, any[]>): Record<string, number> {
  const idx: Record<string, number> = {};
  for (const kho of Object.keys(khoDetail || {})) {
    for (const row of khoDetail[kho]) {
      const [item, , , oqc, qty, ref] = row;
      if (String(oqc || "").toUpperCase() !== "PASS") continue;
      if (ref && String(ref).trim()) {
        const key = String(item).toLowerCase() + "|" + String(ref).trim().toLowerCase();
        idx[key] = (idx[key] || 0) + qty;
      }
    }
  }
  return idx;
}

// ============ Locator -> Kho (buildLocatorKhoMap / guessKhoFromLocatorPrefix / resolveKhoForLocator)
// — y hệt app.js ============
function buildLocatorKhoMap(khoDetail: Record<string, any[]>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const kho of Object.keys(khoDetail || {})) {
    for (const row of khoDetail[kho]) {
      const locator = row[2];
      if (locator) map[String(locator).trim().toUpperCase()] = kho;
    }
  }
  return map;
}
function guessKhoFromLocatorPrefix(locator: string): string | null {
  const s = String(locator || "").trim().toUpperCase();
  if (!s) return null;
  if (/^D?3B/.test(s)) return "Kho 3B";
  if (/^D?3A/.test(s)) return "Kho 3A";
  if (/^D?2B/.test(s)) return "Kho 2B";
  if (/^DG2/.test(s)) return "Kho 2B";
  return null;
}
function resolveKhoForLocator(locator: string, lookupMap: Record<string, string>): string {
  const norm = String(locator || "").trim().toUpperCase();
  if (!norm) return "—";
  const fromData = lookupMap[norm];
  if (fromData) return fromData.replace("Kho ", "");
  const guess = guessKhoFromLocatorPrefix(norm);
  return guess ? guess.replace("Kho ", "") : "—";
}

// ============ contShipData (deserialize) + contShipDetectSingleKho / contShipIsFullyLoaded —
// y hệt app.js (contShipDeserialize/contShipKhoLabelForRefs) ============
type ContShipData = {
  byRef: Map<string, number>;
  byRefLocators: Map<string, Set<string>>;
};
function contShipDeserialize(obj: any): ContShipData | null {
  if (!obj) return null;
  return {
    byRef: new Map(Object.entries(obj.byRef || {}).map(([k, v]) => [k, Number(v)])),
    byRefLocators: new Map(
      Object.entries(obj.byRefLocators || {}).map(([k, v]) => [k, new Set(v as string[])]),
    ),
  };
}
function contShipKhoLabelForRefs(
  refs: string[],
  byRefLocators: Map<string, Set<string>>,
  locatorKhoMap: Record<string, string>,
): string {
  const khoSet = new Set<string>();
  refs.forEach((ref) => {
    const locs = byRefLocators.get(ref);
    if (!locs) return;
    locs.forEach((loc) => {
      const kho = resolveKhoForLocator(loc, locatorKhoMap);
      if (kho && kho !== "—") khoSet.add(kho);
    });
  });
  if (!khoSet.size) return "";
  return [...khoSet].sort().map((k) => `Kho ${k}`).join(" + ");
}
function contShipDetectSingleKho(
  contShipData: ContShipData | null,
  csrsSet: Set<string>,
  locatorKhoMap: Record<string, string>,
): string | null {
  if (!contShipData || !contShipData.byRef.size || !csrsSet || !csrsSet.size) return null;
  const refs: string[] = [];
  csrsSet.forEach((csr) => {
    const ref = String(csr || "").trim().toUpperCase().replace(/[;,.\s]+$/, "");
    if (contShipData!.byRef.has(ref)) refs.push(ref);
  });
  if (!refs.length) return null;
  const khoLabel = contShipKhoLabelForRefs(refs, contShipData.byRefLocators, locatorKhoMap);
  if (!khoLabel || khoLabel.includes("+")) return null;
  return khoLabel;
}
function contShipIsFullyLoaded(
  contShipData: ContShipData | null,
  csrsSet: Set<string>,
  planQty: number,
): boolean {
  if (!contShipData || !contShipData.byRef.size || !csrsSet || !csrsSet.size) return false;
  let shipQty = 0, matched = false;
  csrsSet.forEach((csr) => {
    const ref = String(csr || "").trim().toUpperCase().replace(/[;,.\s]+$/, "");
    if (contShipData!.byRef.has(ref)) { matched = true; shipQty += contShipData!.byRef.get(ref)!; }
  });
  if (!matched) return false;
  const pct = planQty > 0 ? (shipQty / planQty) * 100 : 0;
  return pct >= 99.995;
}

// ============ Container Picking Overview — PORT từ renderContainerPickingOverview() (phần tính
// toán, KHÔNG có phần vẽ HTML) — sinh ra "detailRows" (tương đương contPickAllRows ở client). ============
function buildPickOverview(ctx: {
  planData: Record<PlanType, any>;
  loadedTypes: PlanType[];
  khoDetail: Record<string, any[]>;
  locIdx: Map<string, LocEntry[]>;
  pickingIdx: Record<string, number>;
  sppManualOk: Record<string, any>;
  manualPickedContainers: Record<string, any>;
  manualKhoOverrides: Record<string, any>;
  hiddenPlanContainers: Record<string, any>;
  planContainerChangeInfo: Record<string, any>;
  contPickComments: Record<string, any>;
  contShipData: ContShipData | null;
  locatorKhoMap: Record<string, string>;
}) {
  const {
    planData, loadedTypes, locIdx, pickingIdx, sppManualOk, manualPickedContainers,
    manualKhoOverrides, hiddenPlanContainers, planContainerChangeInfo, contPickComments,
    contShipData, locatorKhoMap,
  } = ctx;

  const contMap = new Map<string, any>();

  loadedTypes.forEach((type) => {
    const rows = (planData[type] && planData[type].detailRows) || [];
    rows.forEach((r: any) => {
      const cNo = r.containerNo;
      if (!cNo || cNo === "—") return;
      const loadDateStr = fmtDateVal(r.loadDate);
      const planTimeStr = r.planTime || "";
      const key = contInstanceKey(type, cNo, loadDateStr, planTimeStr);
      const itemKey = String(r.item || "").toLowerCase();
      const csrKey = String(r.csr || "").trim().toLowerCase();
      let passQty = 0;
      if (csrKey) {
        const lookupKey = itemKey + "|" + csrKey;
        passQty = pickingIdx[lookupKey] || 0;
      }
      const planQty = r.qty || 0;
      let contribution = planQty > 0 ? Math.min(passQty, planQty) : 0;
      const custPoForSppKey = r.custPo && r.custPo.trim() ? r.custPo.trim() : "(Khong co)";
      if (ccIsSppItem(r.item) && sppManualOk[sppOkKey(r.item, custPoForSppKey)]) {
        contribution = planQty;
      }
      let entry = contMap.get(key);
      if (!entry) {
        entry = {
          type, cNo, loadDate: loadDateStr, planTime: planTimeStr, planQty: 0, contribution: 0,
          invoices: new Set<string>(), csrs: new Set<string>(), loadDates: new Set<string>(),
          planTimes: new Set<string>(), items: new Map<string, any>(),
        };
        contMap.set(key, entry);
      }
      entry.planQty += planQty;
      entry.contribution += contribution;
      if (r.invoice) entry.invoices.add(r.invoice);
      if (r.csr) entry.csrs.add(r.csr);
      if (r.loadDate) entry.loadDates.add(fmtDateVal(r.loadDate));
      if (r.planTime) entry.planTimes.add(r.planTime);
      const itemPoKey = r.item + "||" + (r.custPo || "");
      if (!entry.items.has(itemPoKey)) {
        entry.items.set(itemPoKey, { item: r.item, po: r.custPo || "", qty: 0, cbm: 0 });
      }
      const itEntry = entry.items.get(itemPoKey);
      itEntry.qty += planQty;
      itEntry.cbm += parseFloat(r.cbm) || 0;
    });
  });

  let notStarted = 0, inProgress = 0, done = 0, total = 0;
  const detailRows: any[] = [];

  contMap.forEach((entry) => {
    if (entry.planQty <= 0) return;
    const instanceKey = contInstanceKey(entry.type, entry.cNo, entry.loadDate, entry.planTime);
    if (hiddenPlanContainers[instanceKey]) return;
    total++;
    const pct = (entry.contribution / entry.planQty) * 100;
    let autoStatus: string;
    if (pct >= 99.995) autoStatus = "done";
    else if (pct <= 0.005) autoStatus = "notStarted";
    else autoStatus = "inProgress";

    const manualKey = instanceKey;
    const isManualUser = !!(manualPickedContainers && manualPickedContainers[manualKey]);
    const isShipDone = !isManualUser &&
      contShipIsFullyLoaded(contShipData, entry.csrs, entry.planQty);
    const isManual = isManualUser || isShipDone;
    const status = isManual ? "manualDone" : autoStatus;
    if (status === "manualDone" || status === "done") done++;
    else if (status === "notStarted") notStarted++;
    else inProgress++;

    const items = [...entry.items.values()].map((it: any) => {
      const locs = buildItemLocatorDetail(locIdx, it.item, it.po, true);
      const totalOnHand = locs.reduce((s, l) => s + l.qty, 0);
      const passOnHand = locs.reduce((s, l) => s + (l.oqc === "PASS" ? l.qty : 0), 0);
      return { item: it.item, po: it.po, qty: it.qty, cbm: it.cbm, locs, totalOnHand, passOnHand };
    });

    const shortItems = isManual ? [] : items
      .filter((it) =>
        it.qty > it.passOnHand &&
        !(ccIsSppItem(it.item) && sppManualOk[sppOkKey(it.item, it.po || "(Khong co)")])
      )
      .map((it) => ({ item: it.item, po: it.po, qty: it.qty, passOnHand: it.passOnHand, diff: it.passOnHand - it.qty }));

    const qtyByKho: Record<string, number> = {};
    items.forEach((it) => it.locs.forEach((l) => { qtyByKho[l.kho] = (qtyByKho[l.kho] || 0) + l.qty; }));
    let topKho: string | null = null, topKhoQty = 0;
    Object.entries(qtyByKho).forEach(([kho, qty]) => { if (qty > topKhoQty) { topKho = kho; topKhoQty = qty; } });

    let isManualKho = false;
    if (manualKhoOverrides[manualKey]) {
      topKho = manualKhoOverrides[manualKey];
      topKhoQty = qtyByKho[topKho!] || 0;
      isManualKho = true;
    } else {
      const shipKho = contShipDetectSingleKho(contShipData, entry.csrs, locatorKhoMap);
      if (shipKho && shipKho !== topKho) {
        topKho = shipKho;
        topKhoQty = qtyByKho[topKho] || 0;
      }
    }

    const changeInfo = planContainerChangeInfo[instanceKey];
    detailRows.push({
      type: entry.type, cNo: entry.cNo, pct, status, autoStatus, autoPct: pct, isManual,
      changeStatus: changeInfo ? changeInfo.status : null,
      comment: contPickComments[instanceKey] || "",
      instanceKey, planQty: entry.planQty,
      loadDateKey: entry.loadDate, planTimeKey: entry.planTime,
      loadDate: [...entry.loadDates].join(", ") || "—",
      planTime: [...entry.planTimes].join(", ") || "—",
      invoice: [...entry.invoices].join(", ") || "—",
      csr: [...entry.csrs].join(", ") || "—",
      items, shortItems, topKho, topKhoQty, isManualKho,
    });
  });

  return { detailRows, total, notStarted, inProgress, done };
}

// ============ buildCompareTable(type) — PORT từ app.js (phần dữ liệu, không có HTML) ============
function buildCompareTableData(ctx: {
  type: PlanType;
  planData: Record<PlanType, any>;
  khoOrder: string[];
  itemIdx: Record<string, InvEntry>;
  poIdx: Record<string, InvEntry>;
  hiddenPlanContainers: Record<string, any>;
  sppManualOk: Record<string, any>;
  doneContSet: Set<string>;
}) {
  const { type, planData, khoOrder, itemIdx, poIdx, hiddenPlanContainers, sppManualOk, doneContSet } = ctx;
  const planPairs: Record<string, any> = {};
  for (const r of (planData[type] && planData[type].detailRows) || []) {
    const rLoadDateStr = fmtDateVal(r.loadDate);
    const rPlanTimeStr = r.planTime || "";
    if (isContainerHidden(hiddenPlanContainers, type, r.containerNo, rLoadDateStr, rPlanTimeStr)) continue;
    const custpo = r.custPo && r.custPo.trim() ? r.custPo.trim() : "(Khong co)";
    const key = String(r.item).toLowerCase() + "␟" + custpo.toLowerCase();
    if (!planPairs[key]) planPairs[key] = { item: r.item, custpo, qty: 0 };
    const isDone = r.containerNo && doneContSet.has(contInstanceKey(type, r.containerNo, rLoadDateStr, rPlanTimeStr));
    if (isDone) continue;
    planPairs[key].qty += r.qty;
  }

  const rows = Object.values(planPairs).map((p: any) => {
    const anyPO = p.custpo === "(Khong co)";
    let inv: InvEntry;
    if (anyPO) {
      inv = itemIdx[p.item.toLowerCase()] || { byKho: {}, pass: 0, ng: 0, other: 0 };
    } else {
      const key = p.item.toLowerCase() + "␟" + p.custpo.toLowerCase();
      inv = poIdx[key] || { byKho: {}, pass: 0, ng: 0, other: 0 };
    }
    const khoQtys = khoOrder.map((k) => inv.byKho[k] || 0);
    const totalOnHand = inv.pass || 0;
    const itemAnyPO = khoOrder.reduce((s, k) => s + ((itemIdx[p.item.toLowerCase()] || { byKho: {} } as any).byKho[k] || 0), 0);
    const poMismatch = !anyPO && totalOnHand === 0 && itemAnyPO > 0;
    const isSpp = ccIsSppItem(p.item);
    const manualOk = isSpp && !!sppManualOk[sppOkKey(p.item, p.custpo)];
    return {
      item: p.item, custpo: p.custpo, anyPO, khoQtys, totalOnHand, pass: inv.pass, ng: inv.ng,
      planQty: p.qty, diff: totalOnHand - p.qty, poMismatch, itemAnyPO, isSpp, manualOk,
    };
  }).sort((a: any, b: any) => a.diff - b.diff);

  const shortCount = rows.filter((r: any) => r.diff < 0 && !r.manualOk).length;
  const okCount = rows.length - shortCount;
  const poMismatchCount = rows.filter((r: any) => r.poMismatch).length;

  return { rows, okCount, shortCount, poMismatchCount, khoOrder };
}

// ============ buildCombinedPlanCompareTable() — PORT từ app.js (phần dữ liệu) ============
function buildCombinedPlanCompareData(ctx: {
  loadedTypes: PlanType[];
  planData: Record<PlanType, any>;
  khoOrder: string[];
  itemIdx: Record<string, InvEntry>;
  poIdx: Record<string, InvEntry>;
  hiddenPlanContainers: Record<string, any>;
  sppManualOk: Record<string, any>;
  doneContSet: Set<string>;
}) {
  const { loadedTypes, planData, khoOrder, itemIdx, poIdx, hiddenPlanContainers, sppManualOk, doneContSet } = ctx;
  const planPairs: Record<string, any> = {};
  loadedTypes.forEach((type) => {
    for (const r of (planData[type] && planData[type].detailRows) || []) {
      const rLoadDateStr = fmtDateVal(r.loadDate);
      const rPlanTimeStr = r.planTime || "";
      if (isContainerHidden(hiddenPlanContainers, type, r.containerNo, rLoadDateStr, rPlanTimeStr)) continue;
      const custpo = r.custPo && r.custPo.trim() ? r.custPo.trim() : "(Khong co)";
      const key = String(r.item).toLowerCase() + "␟" + custpo.toLowerCase();
      if (!planPairs[key]) planPairs[key] = { item: r.item, custpo, qtyByType: {}, totalPlanQty: 0 };
      const isDone = r.containerNo && doneContSet.has(contInstanceKey(type, r.containerNo, rLoadDateStr, rPlanTimeStr));
      if (isDone) continue;
      planPairs[key].qtyByType[type] = (planPairs[key].qtyByType[type] || 0) + r.qty;
      planPairs[key].totalPlanQty += r.qty;
    }
  });

  const rows = Object.values(planPairs).map((p: any) => {
    const anyPO = p.custpo === "(Khong co)";
    let inv: InvEntry;
    if (anyPO) {
      inv = itemIdx[p.item.toLowerCase()] || { byKho: {}, pass: 0, ng: 0, other: 0 };
    } else {
      const key = p.item.toLowerCase() + "␟" + p.custpo.toLowerCase();
      inv = poIdx[key] || { byKho: {}, pass: 0, ng: 0, other: 0 };
    }
    const khoQtys = khoOrder.map((k) => inv.byKho[k] || 0);
    const totalOnHand = inv.pass || 0;
    const itemAnyPO = khoOrder.reduce((s, k) => s + ((itemIdx[p.item.toLowerCase()] || { byKho: {} } as any).byKho[k] || 0), 0);
    const poMismatch = !anyPO && totalOnHand === 0 && itemAnyPO > 0;
    const isSpp = ccIsSppItem(p.item);
    const manualOk = isSpp && !!sppManualOk[sppOkKey(p.item, p.custpo)];
    return {
      item: p.item, custpo: p.custpo, anyPO,
      qtyByType: p.qtyByType, totalPlanQty: p.totalPlanQty,
      khoQtys, totalOnHand, pass: inv.pass, ng: inv.ng,
      diff: totalOnHand - p.totalPlanQty, poMismatch, itemAnyPO,
      isSpp, manualOk,
    };
  }).sort((a: any, b: any) => a.diff - b.diff);

  const isShortRow = (r: any) => r.diff < 0 && !r.manualOk;
  const shortCount = rows.filter(isShortRow).length;
  const okCount = rows.length - shortCount;
  const poMismatchCount = rows.filter((r: any) => r.poMismatch).length;
  const mainRows = rows.filter((r: any) => !r.isSpp);
  const sppRows = rows.filter((r: any) => r.isSpp);

  return { rows, mainRows, sppRows, okCount, shortCount, poMismatchCount, loadedTypes, khoOrder };
}

// ============ Handler chính ============
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  try {
    const kv = await readRows();

    const inventory = kv["tn5_dashboard_inventory_v1"] ? JSON.parse(kv["tn5_dashboard_inventory_v1"]) : null;
    const khoDetail: Record<string, any[]> = (inventory && inventory.kho_detail) || {};
    const khoOrder: string[] = (inventory && inventory.kho_order) || [];

    const planDataRaw = kv["tn5_dashboard_plans_v1"] ? JSON.parse(kv["tn5_dashboard_plans_v1"]) : {};
    const planData: Record<PlanType, any> = {} as any;
    PLAN_TYPES.forEach((t) => { planData[t] = planDataRaw[t] || null; });
    const loadedTypes = PLAN_TYPES.filter((t) => planData[t]);

    const sppManualOk = kv["tn5_dashboard_spp_ok_v1"] ? JSON.parse(kv["tn5_dashboard_spp_ok_v1"]) : {};
    const manualPickedContainers = kv["tn5_dashboard_manual_picked_v1"] ? JSON.parse(kv["tn5_dashboard_manual_picked_v1"]) : {};
    const manualKhoOverrides = kv["tn5_dashboard_manual_kho_v1"] ? JSON.parse(kv["tn5_dashboard_manual_kho_v1"]) : {};
    const hiddenPlanContainers = kv["tn5_dashboard_hidden_containers_v1"] ? JSON.parse(kv["tn5_dashboard_hidden_containers_v1"]) : {};
    const planContainerChangeInfo = kv["tn5_dashboard_plan_change_info_v1"] ? JSON.parse(kv["tn5_dashboard_plan_change_info_v1"]) : {};
    const contPickComments = kv["tn5_dashboard_cont_comments_v1"] ? JSON.parse(kv["tn5_dashboard_cont_comments_v1"]) : {};
    const contShipRaw = kv["tn5_dashboard_cont_ship_v1"] ? JSON.parse(kv["tn5_dashboard_cont_ship_v1"]) : null;
    const contShipData = contShipDeserialize(contShipRaw);

    const itemIdx = buildItemIndex(khoDetail);
    const poIdx = buildItemCustPoIndex(khoDetail);
    const locIdx = buildItemLocatorIndex(khoDetail);
    const pickingIdx = buildPickingIndex(khoDetail);
    const locatorKhoMap = buildLocatorKhoMap(khoDetail);

    const pickOverview = buildPickOverview({
      planData, loadedTypes, khoDetail, locIdx, pickingIdx, sppManualOk, manualPickedContainers,
      manualKhoOverrides, hiddenPlanContainers, planContainerChangeInfo, contPickComments,
      contShipData, locatorKhoMap,
    });

    const doneContSet = new Set(
      pickOverview.detailRows
        .filter((r) => r.status === "done" || r.status === "manualDone")
        .map((r) => r.instanceKey),
    );

    const compareByType: Record<string, any> = {};
    loadedTypes.forEach((type) => {
      compareByType[type] = buildCompareTableData({
        type, planData, khoOrder, itemIdx, poIdx, hiddenPlanContainers, sppManualOk, doneContSet,
      });
    });

    const combined = buildCombinedPlanCompareData({
      loadedTypes, planData, khoOrder, itemIdx, poIdx, hiddenPlanContainers, sppManualOk, doneContSet,
    });

    const body = JSON.stringify({ pickOverview, compareByType, combined });
    return new Response(body, {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ message: String((e as Error).message || e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});

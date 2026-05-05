// ============================================================
// DATA LOADER — Proxy API (replaces CSV fetch)
// All data comes from the local proxy server at localhost:3001
// Start with: node proxy.js
// ============================================================

const BASE = `${window.location.protocol}//${window.location.hostname}:3001/proxy`;

// ── Progress UI helpers ───────────────────────────────────────

function setLoadMsg(msg) {
  const el = document.getElementById('load-msg');
  if (el) el.textContent = msg;
}

function setLoadProgress(pct) {
  const bar = document.querySelector('.load-bar-inner');
  if (bar) bar.style.width = Math.min(100, Math.round(pct)) + '%';
}

// ── Boot loader — populates all global state ──────────────────
// Keeps the same globals (pipelineData, storeData, dailySalesIndex, normalityMap)
// so all view files work without changes.

async function loadData() {
  hide('file-picker');
  show('loading-screen');
  setLoadMsg('Connecting to proxy...');
  setLoadProgress(0);

  try {
    // Fetch rankings and store data at boot — daily sales loaded on demand per item
    setLoadMsg('Loading data from proxy...');
    const [rankingsResp, storeDataResp] = await Promise.all([
      fetch(`${BASE}/rankings`),
      fetch(`${BASE}/store-data`),
    ]);

    if (!rankingsResp.ok) throw new Error('Could not load rankings from proxy. Is node proxy.js running?');
    if (!storeDataResp.ok) throw new Error('Could not load store data from proxy.');

    setLoadProgress(40);

    const [rankingsRaw, storeDataRaw] = await Promise.all([
      rankingsResp.json(),
      storeDataResp.json(),
    ]);

    setLoadProgress(70);

    // Populate pipelineData — used by item-zoom and category views
    pipelineData = rankingsRaw.map(r => ({
      ITEM_NO:               (r.ITEM_NO || '').trim(),
      ITEM_NAME:             r.DESCR          || r.ITEM_NAME     || '',
      CATEG_COD:             r.CATEG_COD      || r.CATEGORY      || '',
      SUBCAT_COD:            r.SUBCAT_COD     || r.SUBCAT        || '',
      RAW_QTY_90D:           r.RAW_QTY_90D    || r.SALES_90D     || 0,
      RAW_AMT_90D:           r.RAW_AMT_90D    || r.REV_90D       || 0,
      RAW_QTY_12M_TOTAL:     r.RAW_QTY_12M_TOTAL || r.SALES_90D  || 0,
      RAW_AMT_12M_TOTAL:     r.RAW_AMT_12M_TOTAL || r.REV_90D    || 0,
      PCT_RECENT:            r.PCT_RECENT     || 0,
      SUBCAT_RANK:           r.SUBCAT_RANK    || 0,
      SUBCAT_TOTAL:          r.SUBCAT_TOTAL   || 0,
      PEER_COUNT:            r.PEER_COUNT     || r.SUBCAT_TOTAL  || 0,
      PERCENTILE:            r.PERCENTILE     || 0,
      RANK_METHOD:           r.RANK_METHOD    || '',
      STATUS:                r.STATUS         || '',
      QTY_AVAIL_ALL_STORES:  r.QTY_AVAIL_ALL_STORES  || 0,
      QTY_ON_HND_ALL_STORES: r.QTY_ON_HND_ALL_STORES || 0,
      STORES_WITH_STOCK:     r.STORES_WITH_STOCK      || 0,
      PRICE:                 r.PRICE      || r.price1    || null,
      LAST_COST:             r.LAST_COST  || r.lastCost  || null,
      MARGIN_PCT:            r.MARGIN_PCT || null,
    }));

    // Populate normalityMap — keyed by "CATEG|SUBCAT", used by computePercentile()
    normalityMap = {};
    rankingsRaw.forEach(r => {
      const cat    = r.CATEG_COD  || r.CATEGORY || '';
      const subcat = r.SUBCAT_COD || r.SUBCAT   || '';
      const key    = `${cat}|${subcat}`;
      if (!normalityMap[key]) {
        normalityMap[key] = { CATEG_COD: cat, SUBCAT_COD: subcat, RANK_METHOD: r.RANK_METHOD || '' };
      }
    });

    // Populate storeData — used by store view (legacy CSV with tier/revenue fields)
    storeData = storeDataRaw;

    // dailySalesIndex populated on demand in loadItemData() — not pre-loaded at boot
    dailySalesIndex = {};

    setLoadProgress(100);
    dataReady = true;

    const subcatCount = new Set(
      pipelineData.map(i => `${i.CATEG_COD}|${i.SUBCAT_COD}`)
    ).size;

    const ts = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
    document.getElementById('dash-footer-ts').textContent   = `Data as of ${ts}`;
    document.getElementById('toolbar-status').textContent   = `${pipelineData.length.toLocaleString()} items loaded`;
    document.getElementById('welcome-data-msg').textContent =
      `${pipelineData.length.toLocaleString()} items · ${subcatCount} sub-categories loaded.`;

    hide('loading-screen');
    document.getElementById('app-content').style.display = 'flex';
    doSearch('4000');

  } catch (err) {
    setLoadMsg('Error: ' + err.message);
    const el = document.getElementById('load-msg');
    if (el) el.style.color = '#dc2626';
    console.error(err);
  }
}

// ── Item Zoom data (per search) ───────────────────────────────
// Fetches live inventory + daily sales on demand for the searched item.

async function loadItemData(itemNo) {
  const key = (itemNo || '').trim();
  const enc = encodeURIComponent(key);

  const [itemResp, invResp, dailyResp] = await Promise.all([
    fetch(`${BASE}/item/${enc}`),
    fetch(`${BASE}/item/${enc}/inventory`),
    fetch(`${BASE}/item/${enc}/daily-sales`),
  ]);

  const item      = itemResp.ok  ? await itemResp.json()  : {};
  const inventory = invResp.ok   ? await invResp.json()   : [];
  const dailyRaw  = dailyResp.ok ? await dailyResp.json() : [];

  const itemData = item.data || item;
  const inv      = Array.isArray(inventory) ? inventory : (inventory.data || []);

  const qtyAvail        = inv.reduce((s, r) => s + (parseFloat(r.qtyAvailable || r.QTY_AVAILABLE) || 0), 0);
  const qtyOH           = inv.reduce((s, r) => s + (parseFloat(r.qtyOnHand    || r.QTY_ON_HAND)   || 0), 0);
  const storesWithStock = inv.filter(r => (parseFloat(r.qtyAvailable || r.QTY_AVAILABLE) || 0) > 0).length;

  // Populate dailySalesIndex for this item so getDailySalesForItem() works
  const rows = Array.isArray(dailyRaw) ? dailyRaw : (dailyRaw.data || []);
  dailySalesIndex[key] = rows;

  return {
    QTY_AVAIL_ALL_STORES:  qtyAvail,
    QTY_ON_HND_ALL_STORES: qtyOH,
    STORES_WITH_STOCK:     storesWithStock,
    PRICE:                 itemData.price1   || 0,
    LAST_COST:             itemData.lastCost || 0,
  };
}

// ── All rankings ──────────────────────────────────────────────
async function loadAllRankings() {
  const r = await fetch(`${BASE}/rankings`);
  if (!r.ok) return [];
  return r.json();
}

// ── Stores ────────────────────────────────────────────────────
async function loadStores() {
  const r = await fetch(`${BASE}/stores`);
  if (!r.ok) return [];
  return r.json();
}

// ── Browse/search items ───────────────────────────────────────
async function browseItems(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r  = await fetch(`${BASE}/items?${qs}`);
  if (!r.ok) return { data: [] };
  return r.json();
}

// ============================================================
// Item routes
// GET /proxy/ytd-items/:custNo/:category   — items bought YTD with cadence
// GET /proxy/top-items/:custNo/:category   — best seller list vs customer history
// GET /proxy/item-search?q=               — autocomplete item search
// GET /proxy/item-stats/:itemNo           — 90-day KPIs + daily trend for one item
// ============================================================

const express  = require('express');
const router   = express.Router();
const { doFetch, fetchAllPages, fetchAllPagesPar, ytdDateRange, baseItemNo, calcCadence, routeTimer } = require('../lib/api');

// ── Cadence label from avg days between orders ────────────────
function cadenceLbl(avgDays) {
  if (avgDays === null) return null;
  if (avgDays <= 7)   return 'Weekly';
  if (avgDays <= 16)  return 'Bi-weekly';
  if (avgDays <= 35)  return 'Monthly';
  if (avgDays <= 50)  return 'Every 5–6 weeks';
  if (avgDays <= 75)  return 'Every 2 months';
  if (avgDays <= 120) return 'Quarterly';
  return 'Infrequent';
}

// Strip trailing R variant suffix (e.g. ITEM123R → ITEM123)
function baseNo(n) { return (n || '').trim().replace(/R$/, '').toUpperCase(); }

// ── ytd-items result cache (5 min TTL keyed by custNo::category) ─
const ytdItemsCache = {};
const YTD_ITEMS_TTL = 5 * 60 * 1000;

// ── Category item-master cache (30 min TTL keyed by category) ──
const catMasterCache = {};
const CAT_MASTER_TTL = 30 * 60 * 1000;

async function getCategoryItemSet(category) {
  const cached = catMasterCache[category];
  if (cached && Date.now() - cached.ts < CAT_MASTER_TTL) return cached;
  const items = await fetchAllPages(
    `/api/v1/Items?filter=categoryCode:eq:${encodeURIComponent(category)}&fields=itemNo,status,description&pageSize=500`
  ).catch(() => []);
  const catItemSet = new Set();
  const statusMap  = {};
  for (const i of items) {
    if (!i.itemNo) continue;
    const key = baseNo(i.itemNo);
    catItemSet.add(key);
    statusMap[key] = {
      status:      (i.status || i.statusCode || 'A').toUpperCase() === 'A' ? 'A' : 'I',
      description: i.description || '',
    };
  }
  catMasterCache[category] = { catItemSet, statusMap, ts: Date.now() };
  return catMasterCache[category];
}

// ── GET /proxy/ytd-items/:custNo/:category ────────────────────
// Items this customer bought this year OR same period last year in the category.
// Uses Customers/{custNo}/line-items — one paginated call, no per-ticket fan-out.
router.get('/ytd-items/:custNo/:category', async (req, res) => {
  try {
    const t0        = Date.now();
    const custNoRaw = req.params.custNo;
    const custEnc   = encodeURIComponent(custNoRaw);
    const category  = req.params.category;
    const cacheKey  = `${custNoRaw}::${category}`;

    const hit = ytdItemsCache[cacheKey];
    if (hit && Date.now() - hit.ts < YTD_ITEMS_TTL) {
      console.log(`⏱  GET /proxy/ytd-items → cache hit [${custNoRaw} / ${category}]`);
      return res.json(hit.data);
    }

    const now = new Date();
    const yr  = now.getFullYear();
    const mm  = String(now.getMonth() + 1).padStart(2, '0');
    const dd  = String(now.getDate()).padStart(2, '0');
    const today       = `${yr}-${mm}-${dd}`;
    const ytdStart    = `${yr}-01-01`;
    const priorStart  = `${yr - 1}-01-01`;
    const priorEnd    = `${yr - 1}-${mm}-${dd}`;
    const threeYrsAgo = `${yr - 3}-01-01`;
    const catEnc      = encodeURIComponent(category);

    // One parallel-paged call to the customer-scoped line-items endpoint +
    // item status lookup in parallel — no per-ticket fan-out needed.
    const [lineItems, { statusMap }] = await Promise.all([
      fetchAllPagesPar(
        `/api/v1/Customers/${custEnc}/line-items?filter=categoryCode:eq:${catEnc},businessDate:gte:${threeYrsAgo}&compact=true&pageSize=2000`
      ),
      getCategoryItemSet(category),
    ]);

    console.log(`  ytd-items [${category}]: lines=${lineItems.length}`);

    const byItem = {};
    for (const l of lineItems) {
      const key  = baseNo(l.itemNo || '');
      if (!key) continue;
      const date = (l.businessDate || l.BusinessDate || '').slice(0, 10);
      const qty  = parseFloat(l.quantity || 0);
      if (!byItem[key]) byItem[key] = {
        itemNo: key, description: l.description || statusMap[key]?.description || '',
        qty_current: 0, qty_prior: 0, all_dates: [],
      };
      if (date >= ytdStart  && date <= today)      byItem[key].qty_current += qty;
      if (date >= priorStart && date <= priorEnd)  byItem[key].qty_prior   += qty;
      if (date) byItem[key].all_dates.push(date);
    }

    const result = Object.values(byItem)
      .filter(i => i.qty_current > 0 || i.qty_prior > 0)
      .sort((a, b) => b.qty_current - a.qty_current)
      .map((item, idx) => ({
        rank:        idx + 1,
        itemNo:      item.itemNo,
        description: item.description || statusMap[item.itemNo]?.description || '',
        status:      statusMap[item.itemNo]?.status || 'A',
        current_qty: Math.round(item.qty_current),
        prior_qty:   Math.round(item.qty_prior),
        cadence:     cadenceLbl(calcCadence(item.all_dates.map(d => ({ date: d })))),
        last_sold:   [...item.all_dates].sort().pop() || null,
      }));

    ytdItemsCache[cacheKey] = { data: result, ts: Date.now() };
    routeTimer(`GET /proxy/ytd-items`, t0, { custNo: custNoRaw, category, lines: lineItems.length, items: result.length });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/top-items/:custNo/:category ────────────────────
// Store's profCod1=Y best-seller list for the category, annotated with this
// customer's 3-year buying history. Items the customer hasn't bought included
// as gaps (current_qty = 0). Returns: rank, itemNo, description, status,
// current_qty, prior_qty, prior_full_qty, current_sales, prior_sales, last_sold, cadence
router.get('/top-items/:custNo/:category', async (req, res) => {
  try {
    const t0       = Date.now();
    const custNo   = encodeURIComponent(req.params.custNo);
    const category = req.params.category;
    const now = new Date();
    const yr  = now.getFullYear();
    const mm  = String(now.getMonth() + 1).padStart(2, '0');
    const dd  = String(now.getDate()).padStart(2, '0');
    const threeYrsAgo = `${yr - 3}-01-01`;
    const todayStr    = `${yr}-${mm}-${dd}`;
    const currStart   = `${yr}-01-01`;
    const priorStart  = `${yr - 1}-01-01`;
    const priorEnd    = `${yr - 1}-${mm}-${dd}`;
    const priorFull   = `${yr - 1}-12-31`;
    const catEnc = encodeURIComponent(category);

    // Two parallel fetches: master best-seller list + all customer line items (3 yrs)
    // Uses customer-scoped line-items endpoint — single paginated call, no per-ticket fan-out.
    const [masterItems, allLines] = await Promise.all([
      fetchAllPages(
        `/api/v1/Items?filter=profCod1:eq:Y,categoryCode:eq:${catEnc}&fields=itemNo,description,status&pageSize=200`
      ),
      fetchAllPagesPar(
        `/api/v1/Customers/${custNo}/line-items?filter=categoryCode:eq:${catEnc},businessDate:gte:${threeYrsAgo}&compact=true&pageSize=2000`
      ),
    ]);

    // Aggregate customer data by base item number
    const custByItem = {};
    for (const l of allLines) {
      const raw = (l.itemNo || '').trim();
      if (!raw) continue;
      const key  = baseNo(raw);
      const qty  = parseFloat(l.quantity || 0);
      const rev  = parseFloat(l.extPrice  || 0);
      const date = (l.businessDate || l.BusinessDate || '').slice(0, 10);
      if (!custByItem[key]) custByItem[key] = { qty_current: 0, qty_prior: 0, qty_prior_full: 0, rev_current: 0, rev_prior: 0, dates: [] };
      if (date >= currStart && date <= todayStr) {
        custByItem[key].qty_current += qty;
        custByItem[key].rev_current += rev;
      }
      if (date >= priorStart && date <= priorFull) {
        custByItem[key].qty_prior_full += qty;
        custByItem[key].rev_prior      += rev;
        if (date <= priorEnd) custByItem[key].qty_prior += qty;
      }
      if (date) custByItem[key].dates.push(date);
    }

    const result = masterItems.map((item, idx) => {
      const key   = baseNo(item.itemNo);
      const cust  = custByItem[key] || {};
      const s     = (item.status || item.statusCode || 'A').toUpperCase();
      const dates = [...(cust.dates || [])].sort();
      return {
        rank:           idx + 1,
        itemNo:         key,
        description:    item.description || '',
        status:         s === 'A' ? 'A' : 'I',
        current_qty:    Math.round(cust.qty_current    || 0),
        prior_qty:      Math.round(cust.qty_prior      || 0),
        prior_full_qty: Math.round(cust.qty_prior_full || 0),
        current_sales:  +((cust.rev_current || 0).toFixed(2)),
        prior_sales:    +((cust.rev_prior   || 0).toFixed(2)),
        last_sold:      dates[dates.length - 1] || null,
        cadence:        cadenceLbl(calcCadence(dates.map(d => ({ date: d })))),
      };
    });

    routeTimer(`GET /proxy/top-items`, t0, { custNo: req.params.custNo, category, items: result.length });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Per-category item cache (30 min TTL — item master rarely changes)
const itemCatCache = {};
const ITEM_CACHE_TTL = 30 * 60 * 1000;

async function fetchCategoryItems(cat) {
  const cached = itemCatCache[cat];
  if (cached && Date.now() - cached.ts < ITEM_CACHE_TTL) return cached.data;

  const r    = await doFetch('GET', `/api/v1/Items?filter=categoryCode:eq:${encodeURIComponent(cat)}&pageSize=50&page=1`);
  const body = r.ok ? await r.json() : {};
  const rows = Array.isArray(body) ? body : (body.data || []);

  if (rows.length) console.log(`[recommended-items] ${cat} sample keys:`, Object.keys(rows[0]));

  itemCatCache[cat] = { data: rows, ts: Date.now() };
  return rows;
}

// ── GET /proxy/recommended-items?categories=CAT1,CAT2 ────────
router.get('/recommended-items', async (req, res) => {
  try {
    const categories = (req.query.categories || '')
      .split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);

    console.log(`[recommended-items] categories=${JSON.stringify(categories)}`);
    if (!categories.length) return res.json([]);

    const itemSets = await Promise.all(categories.map(cat => fetchCategoryItems(cat).catch(() => [])));

    const sample = itemSets.flat()[0];
    if (sample) console.log('[recommended-items] sample fields:', Object.keys(sample));

    const seen   = new Set();
    const result = [];

    for (const pass of ['Y', '']) {
      for (const items of itemSets) {
        const filtered = pass === 'Y' ? items.filter(i => i.profCod1 === 'Y') : items;
        for (const item of filtered) {
          if (!item.itemNo || seen.has(item.itemNo)) continue;
          seen.add(item.itemNo);
          result.push({
            itemNo:      item.itemNo,
            description: item.description || item.itemNo,
            upc:         item.barcode || item.barcod3Of9 || '',
            caseCost:    parseFloat(item.lastCost || 0),
            unitQty:     item.prefUnitNumer > 0 ? item.prefUnitNumer : 0,
            unit:        item.prefUnitNam || item.prefUnit || item.stockingUnit || '',
          });
          if (result.length >= 15) break;
        }
        if (result.length >= 15) break;
      }
      if (result.length >= 15) break;
    }

    res.json(result);
  } catch (e) {
    console.error('/proxy/recommended-items error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Category top-items cache (5 min TTL) ──────────────────────
const catTopItemsCache = {};
const CAT_TOP_ITEMS_TTL = 5 * 60 * 1000;

// ── GET /proxy/category-top-items/:category ───────────────────
// Top items by 90-day revenue across ALL customers for one category
router.get('/category-top-items/:category', async (req, res) => {
  try {
    const category = req.params.category;
    const cached   = catTopItemsCache[category];
    if (cached && Date.now() - cached.ts < CAT_TOP_ITEMS_TTL) return res.json(cached.data);

    const now  = new Date();
    const d90  = new Date(now); d90.setDate(d90.getDate() - 90);
    const fmt  = d => d.toISOString().slice(0, 10);

    // Single large-page fetch — avoids slow multi-page pagination for busy categories.
    // 2000 records covers top-item ranking accurately for all but the highest-volume categories.
    const r     = await doFetch('GET', `/api/v1/pos/ticket-history-lines?filter=categoryCode:eq:${encodeURIComponent(category)},businessDate:gte:${fmt(d90)},businessDate:lte:${fmt(now)}&pageSize=2000&page=1`);
    const body  = r.ok ? await r.json() : {};
    const lines = Array.isArray(body) ? body : (body.data || []);

    const byItem = {};
    for (const l of lines) {
      const key = l.itemNo || '';
      if (!key) continue;
      if (!byItem[key]) byItem[key] = { itemNo: key, description: l.description || key, rev90: 0, units90: 0 };
      byItem[key].rev90   += parseFloat(l.extPrice  || 0);
      byItem[key].units90 += parseFloat(l.quantity  || 0);
    }

    const result = Object.values(byItem)
      .map(i => ({ itemNo: i.itemNo, description: i.description, rev90: +i.rev90.toFixed(2), units90: +i.units90.toFixed(0) }))
      .sort((a, b) => b.rev90 - a.rev90)
      .slice(0, 50);

    catTopItemsCache[category] = { data: result, ts: Date.now() };
    res.json(result);
  } catch (e) {
    console.error('/proxy/category-top-items error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Item search cache (2 min TTL) ─────────────────────────────
const itemSearchCache = {};
const SEARCH_CACHE_TTL = 2 * 60 * 1000;

// ── GET /proxy/item-search?q= ─────────────────────────────────
router.get('/item-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);

    const cacheKey = q.toLowerCase();
    const cached   = itemSearchCache[cacheKey];
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) return res.json(cached.data);

    // Try description-contains and itemNo-starts-with in parallel
    const [byDesc, byNo] = await Promise.all([
      doFetch('GET', `/api/v1/Items?filter=description:like:${encodeURIComponent(q)}&pageSize=20&page=1`)
        .then(r => r.ok ? r.json() : {}).then(b => Array.isArray(b) ? b : (b.data || [])).catch(() => []),
      doFetch('GET', `/api/v1/Items?filter=itemNo:like:${encodeURIComponent(q)}&pageSize=10&page=1`)
        .then(r => r.ok ? r.json() : {}).then(b => Array.isArray(b) ? b : (b.data || [])).catch(() => []),
    ]);

    const seen = new Set();
    const results = [];
    for (const item of [...byNo, ...byDesc]) {
      if (!item.itemNo || seen.has(item.itemNo)) continue;
      seen.add(item.itemNo);
      results.push({ itemNo: item.itemNo, description: item.description || item.itemNo, categoryCode: item.categoryCode || '', statusCode: item.statusCode || '' });
      if (results.length >= 25) break;
    }

    itemSearchCache[cacheKey] = { data: results, ts: Date.now() };
    res.json(results);
  } catch (e) {
    console.error('/proxy/item-search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Item stats cache (5 min TTL) ──────────────────────────────
const itemStatsCache = {};
const STATS_CACHE_TTL = 5 * 60 * 1000;

// ── GET /proxy/item-stats/:itemNo ─────────────────────────────
// Returns 90-day KPIs + daily revenue breakdown for one item (all customers)
router.get('/item-stats/:itemNo', async (req, res) => {
  try {
    const itemNo = req.params.itemNo;
    const cached = itemStatsCache[itemNo];
    if (cached && Date.now() - cached.ts < STATS_CACHE_TTL) return res.json(cached.data);

    const now    = new Date();
    const d90    = new Date(now); d90.setDate(d90.getDate() - 90);
    const d30    = new Date(now); d30.setDate(d30.getDate() - 30);
    const d7     = new Date(now); d7.setDate(d7.getDate() - 7);
    const fmt    = d => d.toISOString().slice(0, 10);

    // Fetch item master and 90-day lines in parallel
    const [itemMasterResp, lines] = await Promise.all([
      doFetch('GET', `/api/v1/Items/${encodeURIComponent(itemNo)}`).then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetchAllPages(
        `/api/v1/pos/ticket-history-lines?filter=itemNo:eq:${encodeURIComponent(itemNo)},businessDate:gte:${fmt(d90)},businessDate:lte:${fmt(now)}&fields=itemNo,description,quantity,extPrice,price,unitCost,businessDate,categoryCode&pageSize=1000`
      ),
    ]);

    const master = itemMasterResp.data || itemMasterResp;

    // Aggregate
    let rev90 = 0, units90 = 0;
    let rev30 = 0, units30 = 0;
    let rev7  = 0, units7  = 0;
    let totalPrice = 0, totalCost = 0, pricedLines = 0, costedLines = 0;
    const daily = {}; // YYYY-MM-DD → { revenue, units }

    const d30str = fmt(d30);
    const d7str  = fmt(d7);

    for (const l of lines) {
      const qty  = parseFloat(l.quantity || 0);
      const rev  = parseFloat(l.extPrice  || 0);
      const date = (l.businessDate || '').slice(0, 10);
      if (!date) continue;

      rev90   += rev;
      units90 += qty;

      if (date >= d30str) { rev30 += rev; units30 += qty; }
      if (date >= d7str)  { rev7  += rev; units7  += qty; }

      const price = parseFloat(l.price    || 0);
      const cost  = parseFloat(l.unitCost || 0);
      if (price > 0) { totalPrice += price; pricedLines++; }
      if (cost  > 0) { totalCost  += cost;  costedLines++; }

      if (!daily[date]) daily[date] = { revenue: 0, units: 0 };
      daily[date].revenue += rev;
      daily[date].units   += qty;
    }

    const avgSell = pricedLines > 0 ? totalPrice / pricedLines : 0;
    const avgCost = costedLines > 0 ? totalCost  / costedLines : 0;
    const margin  = avgSell > 0 ? ((avgSell - avgCost) / avgSell * 100) : null;

    // Fill in zero days for the 90-day range
    const dailyFull = [];
    for (let i = 89; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const k = fmt(d);
      dailyFull.push({ date: k, revenue: daily[k] ? +daily[k].revenue.toFixed(2) : 0, units: daily[k] ? +daily[k].units.toFixed(0) : 0 });
    }

    const data = {
      itemNo,
      description: master.description || (lines[0] && lines[0].description) || itemNo,
      categoryCode: master.categoryCode || (lines[0] && lines[0].categoryCode) || '',
      statusCode:   master.statusCode || '',
      isBestSeller: master.profCod1 === 'Y',
      kpis: {
        rev90:   +rev90.toFixed(2),   units90: +units90.toFixed(0),
        rev30:   +rev30.toFixed(2),   units30: +units30.toFixed(0),
        rev7:    +rev7.toFixed(2),    units7:  +units7.toFixed(0),
        avgSell: +avgSell.toFixed(2), avgCost: +avgCost.toFixed(2),
        margin:  margin !== null ? +margin.toFixed(1) : null,
      },
      daily: dailyFull,
    };

    itemStatsCache[itemNo] = { data, ts: Date.now() };
    res.json(data);
  } catch (e) {
    console.error('/proxy/item-stats error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

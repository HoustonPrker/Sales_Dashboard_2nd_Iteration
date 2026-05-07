// ============================================================
// Item routes
// GET /proxy/ytd-items/:custNo/:category   — items bought YTD with cadence
// GET /proxy/top-items/:custNo/:category   — best seller list vs customer history
// GET /proxy/item-search?q=               — autocomplete item search
// GET /proxy/item-stats/:itemNo           — 90-day KPIs + daily trend for one item
// ============================================================

const express  = require('express');
const router   = express.Router();
const { doFetch, fetchAllPages, ytdDateRange, baseItemNo, calcCadence } = require('../lib/api');

// ── GET /proxy/ytd-items/:custNo/:category ────────────────────
// Items this customer bought YTD in the given category, with order cadence
router.get('/ytd-items/:custNo/:category', async (req, res) => {
  try {
    const custNo   = encodeURIComponent(req.params.custNo);
    const category = req.params.category;
    const { ytdStart, ytdEnd } = ytdDateRange();

    const lines = await fetchAllPages(
      `/api/v1/pos/ticket-history-lines?filter=custNo:eq:${custNo},categoryCode:eq:${encodeURIComponent(category)},businessDate:gte:${ytdStart},businessDate:lte:${ytdEnd}&fields=itemNo,description,categoryCode,quantity,extPrice,businessDate&pageSize=1000`
    );

    // Aggregate by itemNo
    const byItem = {};
    for (const l of lines) {
      const key = l.itemNo || '';
      if (!key) continue;
      if (!byItem[key]) byItem[key] = {
        itemNo: key,
        description:  l.description  || '',
        categoryCode: l.categoryCode || category,
        qty:    0, revenue: 0,
        dates:  [],
      };
      byItem[key].qty     += parseFloat(l.quantity || 0);
      byItem[key].revenue += parseFloat(l.extPrice  || 0);
      const d = (l.businessDate || '').slice(0, 10);
      if (d) byItem[key].dates.push(d);
    }

    const result = Object.values(byItem).map(item => ({
      itemNo:       item.itemNo,
      description:  item.description,
      categoryCode: item.categoryCode,
      qty:          +item.qty.toFixed(0),
      revenue:      +item.revenue.toFixed(2),
      cadence:      calcCadence(item.dates.map(d => ({ date: d }))),
      lastBought:   item.dates.sort().pop() || null,
    })).sort((a, b) => b.revenue - a.revenue);

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/top-items/:custNo/:category ────────────────────
// Best sellers in this category (all accounts) vs what this customer has bought
router.get('/top-items/:custNo/:category', async (req, res) => {
  try {
    const custNo   = encodeURIComponent(req.params.custNo);
    const category = req.params.category;
    const { ytdStart, ytdEnd } = ytdDateRange();

    // Fetch category-wide top sellers and this customer's items in parallel
    const [allLines, custLines] = await Promise.all([
      fetchAllPages(
        `/api/v1/pos/ticket-history-lines?filter=categoryCode:eq:${encodeURIComponent(category)},businessDate:gte:${ytdStart},businessDate:lte:${ytdEnd}&fields=itemNo,description,quantity,extPrice&pageSize=1000`
      ),
      fetchAllPages(
        `/api/v1/pos/ticket-history-lines?filter=custNo:eq:${custNo},categoryCode:eq:${encodeURIComponent(category)},businessDate:gte:${ytdStart},businessDate:lte:${ytdEnd}&fields=itemNo,quantity,extPrice&pageSize=500`
      ),
    ]);

    // Aggregate all-accounts top sellers
    const allByItem = {};
    for (const l of allLines) {
      const key = l.itemNo || '';
      if (!key) continue;
      if (!allByItem[key]) allByItem[key] = { itemNo: key, description: l.description || '', totalQty: 0, totalRev: 0, custCount: new Set() };
      allByItem[key].totalQty += parseFloat(l.quantity || 0);
      allByItem[key].totalRev += parseFloat(l.extPrice  || 0);
    }

    // This customer's item set
    const custItemRevenue = {};
    for (const l of custLines) {
      const key = l.itemNo || '';
      if (!key) continue;
      custItemRevenue[key] = (custItemRevenue[key] || 0) + parseFloat(l.extPrice || 0);
    }

    const top = Object.values(allByItem)
      .sort((a, b) => b.totalRev - a.totalRev)
      .slice(0, 50)
      .map(item => ({
        itemNo:       item.itemNo,
        description:  item.description,
        totalQty:     +item.totalQty.toFixed(0),
        totalRev:     +item.totalRev.toFixed(2),
        custRev:      +(custItemRevenue[item.itemNo] || 0).toFixed(2),
        custBuys:     !!custItemRevenue[item.itemNo],
      }));

    res.json(top);
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

  // Single page fetch — no pagination needed, we only want a sample of items per category
  const r    = await doFetch('GET', `/api/v1/Items?filter=categoryCode:eq:${encodeURIComponent(cat)}&pageSize=50&page=1`);
  const body = r.ok ? await r.json() : {};
  const rows = Array.isArray(body) ? body : (body.data || []);

  itemCatCache[cat] = { data: rows, ts: Date.now() };
  return rows;
}

// ── GET /proxy/recommended-items?categories=CAT1,CAT2 ────────
router.get('/recommended-items', async (req, res) => {
  try {
    const categories = (req.query.categories || '')
      .split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);

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
            upc:         item.upcCode  || item.upc      || item.upc1      || item.primaryUpc || '',
            caseCost:    parseFloat(item.cost || item.unitCost || item.avgCost || item.lastCost || 0),
            packSize:    parseInt(item.qtyPerCase || item.sellMult || item.caseQty || item.packSize || 0),
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

// ============================================================
// Category routes
// GET /proxy/categories/:custNo  — YTD category breakdown for one customer
// GET /proxy/all-categories      — aggregated across all rep accounts
// ============================================================

const express       = require('express');
const router        = express.Router();
const { doFetch, fetchAllPages, ytdDateRange, SALES_REP } = require('../lib/api');
const categoryCache = require('../lib/category-cache');

// Cache for all-categories keyed by rep (5 min TTL)
const allCatCache  = {};
const custCatCache = {};  // per-customer { [custNo]: { data, ts } }
const CACHE_TTL    = 5 * 60 * 1000;

function aggregateCategories(rawRows) {
  const agg = {};
  for (const row of rawRows) {
    const cat        = row.categoryCode || '';
    if (!cat) continue;
    const currentAmt = parseFloat(row.currentYtdAmount || 0);
    const priorAmt   = parseFloat(row.priorYtdAmount   || 0);
    if (currentAmt <= 0 && priorAmt <= 0) continue;
    if (!agg[cat]) {
      agg[cat] = { categoryCode: cat, description: row.description || cat, currentYtdAmt: 0, priorYtdAmt: 0, accountCount: 0 };
    }
    agg[cat].currentYtdAmt += currentAmt;
    agg[cat].priorYtdAmt   += priorAmt;
    if (currentAmt > 0) agg[cat].accountCount += 1;
  }
  return Object.values(agg)
    .map(c => ({ ...c, avgPerAccount: c.accountCount > 0 ? +(c.currentYtdAmt / c.accountCount).toFixed(2) : 0 }))
    .sort((a, b) => b.currentYtdAmt - a.currentYtdAmt);
}

// ── GET /proxy/categories/:custNo ─────────────────────────────
router.get('/categories/:custNo', async (req, res) => {
  try {
    const key = req.params.custNo;
    if (custCatCache[key] && Date.now() - custCatCache[key].ts < CACHE_TTL) {
      return res.json(custCatCache[key].data);
    }
    const custNo = encodeURIComponent(key);
    const r      = await doFetch('GET', `/api/v1/Customers/${custNo}/sales-by-category`);
    if (!r.ok) return res.status(r.status).json([]);
    const body = await r.json();
    const rows = Array.isArray(body) ? body : (body.data || []);
    const result = rows.map(c => ({
      categoryCode:  c.categoryCode || '',
      description:   c.description  || c.categoryCode || '',
      currentYtdAmt: parseFloat(c.currentYtdAmount || 0),
      currentQty:    parseFloat(c.currentUniqQty   || 0),
      priorYtdAmt:   parseFloat(c.priorYtdAmount   || 0),
      priorQty:      parseFloat(c.priorUniqQty     || 0),
      dollarChange:  c.dollarChange != null
        ? parseFloat(c.dollarChange)
        : parseFloat(c.currentYtdAmount || 0) - parseFloat(c.priorYtdAmount || 0),
    })).filter(c => c.currentYtdAmt > 0 || c.priorYtdAmt > 0)
      .sort((a, b) => b.currentYtdAmt - a.currentYtdAmt);
    custCatCache[key] = { data: result, ts: Date.now() };
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/all-categories ─────────────────────────────────
router.get('/all-categories', async (req, res) => {
  try {
    const rep      = (req.query.rep || SALES_REP || '').trim();
    const cacheKey = rep || '__all__';

    // Check own result cache first
    if (allCatCache[cacheKey] && Date.now() - allCatCache[cacheKey].ts < CACHE_TTL) {
      return res.json(allCatCache[cacheKey].data);
    }

    // Use shared raw rows from accounts load if available (avoids ~200 duplicate API calls)
    const sharedRows = categoryCache.get(cacheKey);
    if (sharedRows) {
      const result = aggregateCategories(sharedRows);
      allCatCache[cacheKey] = { data: result, ts: Date.now() };
      return res.json(result);
    }

    // Fallback: fetch everything ourselves (first load before accounts cache is warm)
    const repFilter = rep ? `filter=salesRep:eq:${encodeURIComponent(rep)}&` : '';
    const customers = await fetchAllPages(
      `/api/v1/Customers?${repFilter}fields=custNo&pageSize=200`
    );

    const rawRows = [];
    await Promise.all(customers.map(async c => {
      try {
        const r    = await doFetch('GET', `/api/v1/Customers/${encodeURIComponent(c.custNo)}/sales-by-category`);
        const body = r.ok ? await r.json() : [];
        const rows = Array.isArray(body) ? body : (body.data || []);
        for (const row of rows) rawRows.push({ custNo: c.custNo, ...row });
      } catch (_) {}
    }));

    categoryCache.set(cacheKey, rawRows);
    const result = aggregateCategories(rawRows);
    allCatCache[cacheKey] = { data: result, ts: Date.now() };
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/category-items/:categoryCode ───────────────────
// Master item list for a category (for drill-down on Item Performance tab)
router.get('/category-items/:categoryCode', async (req, res) => {
  try {
    const categoryCode = req.params.categoryCode;
    const items = await fetchAllPages(
      `/api/v1/Items?filter=categoryCode:eq:${encodeURIComponent(categoryCode)}&fields=itemNo,description,statusCode,profCod1&pageSize=200`
    );
    const result = items
      .map(i => ({
        itemNo:       i.itemNo       || '',
        description:  i.description  || '',
        statusCode:   i.statusCode   || '',
        isBestSeller: i.profCod1 === 'Y',
      }))
      .sort((a, b) => {
        // Best sellers first, then by description
        if (a.isBestSeller !== b.isBestSeller) return a.isBestSeller ? -1 : 1;
        return (a.description || '').localeCompare(b.description || '');
      });
    res.json(result);
  } catch (e) {
    console.error('/proxy/category-items error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

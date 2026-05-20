// ============================================================
// Category routes
// GET /proxy/categories/:custNo  — YTD category breakdown for one customer
// GET /proxy/all-categories      — aggregated across all rep accounts
// ============================================================

// Pinned categories: always included in every customer's breakdown even at $0.
// categoryCode must match NCR's actual code; description is the display label.
const PINNED_CATEGORIES = [
  { categoryCode: 'BABY',       description: 'BABY'         },
  { categoryCode: 'BLNWEIGHTS', description: 'BALLOON WTS'  },
  { categoryCode: 'BLOON',      description: 'BALLOONS'      },
  { categoryCode: 'CANDY',      description: 'CANDY'         },
  { categoryCode: 'ELECTRONIC', description: 'ELECTRONICS'   },
  { categoryCode: 'FASHN',      description: 'FASHION'       },
  { categoryCode: 'FIXTURES',   description: 'FIXTURES'      },
  { categoryCode: 'GIFTS',      description: 'GIFTS'         },
  { categoryCode: 'HBA',        description: 'HEALTH & BEAUTY' },
  { categoryCode: 'HOMEOFFICE', description: 'HOME OFFICE'   },
  { categoryCode: 'INSPR',      description: 'INSPIRATIONAL' },
  { categoryCode: 'KELBOUQUET', description: 'BOUQUET'       },
  { categoryCode: 'KELCHNGMKR', description: 'CHANGEMAKER'   },
  { categoryCode: 'KELLILOON',  description: 'KELLILOON'     },
  { categoryCode: 'PLUSH',      description: 'PLUSH'         },
  { categoryCode: 'SEASN',      description: 'SEASONAL'      },
  { categoryCode: 'TOYS',       description: 'TOYS'          },
];

function mergePinnedCategories(result) {
  const seen = new Set(result.map(c => (c.categoryCode || '').toUpperCase()));
  for (const p of PINNED_CATEGORIES) {
    if (!seen.has(p.categoryCode.toUpperCase())) {
      result.push({
        categoryCode:  p.categoryCode,
        description:   p.description,
        currentYtdAmt: 0,
        currentQty:    0,
        priorYtdAmt:   0,
        priorQty:      0,
        mtdAmt:        0,
        mtdQty:        0,
        dollarChange:  0,
      });
    }
  }
  return result;
}

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
    const custNo  = encodeURIComponent(key);
    const now     = new Date();
    const mtdStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const today    = now.toISOString().slice(0, 10);

    const [catResp, mtdLines] = await Promise.all([
      doFetch('GET', `/api/v1/Customers/${custNo}/sales-by-category`),
      fetchAllPages(`/api/v1/Customers/${custNo}/line-items?filter=businessDate:gte:${mtdStart},businessDate:lte:${today}&fields=categoryCode,quantity,lineTotal,extPrice&pageSize=500`),
    ]);

    if (!catResp.ok) return res.status(catResp.status).json([]);
    const body = await catResp.json();
    const rows = Array.isArray(body) ? body : (body.data || []);

    // Aggregate MTD by category
    const mtdMap = {};
    for (const l of mtdLines) {
      const cat = (l.categoryCode || '').toUpperCase().trim();
      if (!cat) continue;
      if (!mtdMap[cat]) mtdMap[cat] = { amt: 0, qty: 0 };
      mtdMap[cat].amt += parseFloat(l.lineTotal || l.extPrice || 0);
      mtdMap[cat].qty += parseFloat(l.quantity || 0);
    }

    const result = rows.map(c => {
      const catKey = (c.categoryCode || '').toUpperCase().trim();
      const mtd    = mtdMap[catKey] || { amt: 0, qty: 0 };
      return {
        categoryCode:  c.categoryCode || '',
        description:   c.description  || c.categoryCode || '',
        currentYtdAmt: parseFloat(c.currentYtdAmount || 0),
        currentQty:    parseFloat(c.currentUniqQty   || 0),
        priorYtdAmt:   parseFloat(c.priorYtdAmount   || 0),
        priorQty:      parseFloat(c.priorUniqQty     || 0),
        mtdAmt:        +mtd.amt.toFixed(2),
        mtdQty:        Math.round(mtd.qty),
        dollarChange:  c.dollarChange != null
          ? parseFloat(c.dollarChange)
          : parseFloat(c.currentYtdAmount || 0) - parseFloat(c.priorYtdAmount || 0),
      };
    }).filter(c => c.currentYtdAmt > 0 || c.priorYtdAmt > 0);
    mergePinnedCategories(result);
    result.sort((a, b) => b.currentYtdAmt - a.currentYtdAmt);
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

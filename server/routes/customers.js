// ============================================================
// Customer routes
// GET /proxy/customers/search?q=
// GET /proxy/customer/:custNo
// GET /proxy/accounts
// GET /proxy/orders/:custNo
// GET /proxy/mtd/:custNo
// ============================================================

const express      = require('express');
const router       = express.Router();
const { doFetch, fetchAllPages, fetchAllPagesPar, ytdDateRange, aggregateLineItems, routeTimer, SALES_REP, MONTHLY_GROWTH_GOAL_PCT, pyMonthGlobalCache } = require('../lib/api');
const categoryCache = require('../lib/category-cache');
const { getActiveReps, isActiveRep } = require('../data/active-reps');
const { classifyAccountHealth, computeTypicalInterval } = require('../utils/health-classification');
const { monthBusinessDayContext, computePaceScore } = require('../utils/business-days');

// ── In-memory cache keyed by rep (5-minute TTL) ───────────────
const accountsCache = {};  // { [rep]: { data, ts } }
const CACHE_TTL     = 5 * 60 * 1000;

// Global ticket caches — keyed by date range, shared across all reps.
// Tickets carry the historical salesRep at write time, not current account owner,
// so we must NOT filter by rep; scope to current accounts via custNo join instead.
const cyYtdGlobalCache   = {};  // keyed by 'YYYY-MM-DD:YYYY-MM-DD' (ytdStart:today)
const pyYtdGlobalCache   = {};  // keyed by 'YYYY-MM-DD:YYYY-MM-DD' (pyStart:pyEnd)
const pyFullYearCache    = {};  // keyed by prior year (e.g. '2024') — full Jan–Dec, long TTL

// ── Per-customer caches (5-minute TTL) ───────────────────────
const custDetailCache = {};  // { [custNo]: { data, ts } }
const custOrdersCache = {};  // { [custNo]: { data, ts } }
const custMtdCache    = {};  // { [custNo]: { data, ts } }

// pyMonthGlobalCache is imported from lib/api.js — shared with overview.js

// ── Best-seller item set — 30-min TTL ────────────────────────
const bsCache = { set: null, ts: 0 };
const BS_TTL  = 30 * 60 * 1000;
async function getBestSellerSet() {
  if (bsCache.set && Date.now() - bsCache.ts < BS_TTL) return bsCache.set;
  const items = await fetchAllPagesPar(
    `/api/v1/Items?filter=profCod1:eq:Y&fields=itemNo&pageSize=500`
  ).catch(() => []);
  const s = new Set(items.map(i => (i.itemNo || '').trim().toUpperCase()));
  bsCache.set = s; bsCache.ts = Date.now();
  return s;
}

// ── Leaderboard cache (15-minute TTL) ────────────────────────
const leaderboardCache = { data: null, ts: 0 };
const LEADERBOARD_TTL  = 15 * 60 * 1000;

// ── Leaderboard monthly-window caches ────────────────────────
// Completed months never change — use 2-hour TTL.
// Current month changes daily — use same 5-min CACHE_TTL.
const lbMonthCache = {}; // keyed by 'start:end'
const LB_HIST_TTL  = 2 * 60 * 60 * 1000; // 2 hours for completed months

// ── Compute health tier ───────────────────────────────────────
// Run rate: % of year elapsed, used to judge if account is pacing correctly.
function computeTier(pctToTarget, daysSince, ytdSales, priorYtd) {
  const now     = new Date();
  const dayOfYr = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 86400000) + 1;
  const runRate = dayOfYr / 365; // fraction of year elapsed

  // Critical: no recent orders (90+ days) OR YTD down 50%+ vs prior
  if (daysSince >= 90) return 'Critical';
  if (priorYtd > 0 && ytdSales < priorYtd * 0.5) return 'Critical';

  // At Risk: 45-90 days no order OR more than 25 pts below run-rate pace
  if (daysSince >= 45) return 'AtRisk';
  if (priorYtd > 0 && pctToTarget < (runRate - 0.25)) return 'AtRisk';

  // No prior year target — base on recency only
  if (priorYtd === 0) {
    if (daysSince <= 30 && ytdSales > 0) return 'Healthy';
    if (daysSince <= 45) return 'Attention';
    return 'AtRisk';
  }

  // Healthy: ordered within 30 days AND on or near run-rate pace (within 10 pts)
  if (daysSince <= 30 && pctToTarget >= (runRate - 0.10)) return 'Healthy';

  // Attention: ordered within 30 days but behind pace, or 15-45 days but otherwise on track
  if (daysSince <= 45) return 'Attention';

  return 'AtRisk';
}

// ── GET /proxy/sales-reps/active — authoritative active rep list ──
// Single source of truth for "who is a current sales rep".
// Returns [{id}] — callers resolve display names from NCR or show the id.
// Future: wraps a DB query to dbo.CK_SALES_REPS; shape stays the same.
router.get('/sales-reps/active', async (req, res) => {
  try {
    const reps = await getActiveReps();
    res.json(reps);
  } catch (e) {
    console.error('/proxy/sales-reps/active error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/reps — rep picker list (id + display name) ────────
// Uses the active-reps registry, then resolves display names from NCR
// in one batch call so the picker can show human-readable names.
router.get('/reps', async (req, res) => {
  try {
    const activeReps = await getActiveReps(); // [{id}]

    // Resolve display names from NCR in a single call, then join
    const usersRes = await doFetch('GET', `/api/v1/System/users?filter=wrkgrpId:eq:KGS&fields=usrId,name&pageSize=500`);
    const body     = usersRes.ok ? await usersRes.json() : {};
    const nameMap  = {};
    (body.data || []).forEach(u => {
      nameMap[(u.usrId || '').trim().toUpperCase()] = (u.name || '').trim();
    });

    const reps = activeReps
      .map(({ id }) => {
        const raw  = nameMap[id.toUpperCase()] || id;
        const name = raw.replace(/\s*[-–]\s*(ACTIVE|ACT)$/i, '').trim();
        return { id, name: name || id };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json(reps);
  } catch (e) {
    console.error('/proxy/reps error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/accounts/basic?rep= — customer list only, no YTD (fast) ──
router.get('/accounts/basic', async (req, res) => {
  try {
    const rep       = (req.query.rep || SALES_REP || '').trim();
    const repFilter = rep ? `filter=salesRep:eq:${encodeURIComponent(rep)}&` : '';
    const customers = await fetchAllPages(
      `/api/v1/Customers?${repFilter}fields=custNo,name,state,salesRep,lastSaleDate&pageSize=200`
    );
    const accounts = customers.map(c => {
      const lastDate  = c.lastSaleDate ? c.lastSaleDate.slice(0, 10) : null;
      const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate)) / 86400000) : 999;
      const tier      = daysSince >= 90 ? 'Critical' : daysSince >= 45 ? 'AtRisk' : daysSince >= 30 ? 'Attention' : 'Healthy';
      return {
        custNo: c.custNo, name: c.name || '', state: c.state || '', salesRep: c.salesRep || '',
        ytdSales: 0, priorYtd: 0, target: 0, pctToTarget: 0,
        daysSinceOrder: daysSince, lastOrderDate: lastDate, tier,
        _partial: true,
      };
    });
    accounts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json(accounts);
  } catch (e) {
    console.error('/proxy/accounts/basic error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/accounts?rep=REPNAME ──────────────────────────
router.get('/accounts', async (req, res) => {
  try {
    // ?rep= query param overrides env SALES_REP
    const rep = (req.query.rep || SALES_REP || '').trim();
    const cacheKey = rep || '__all__';

    if (accountsCache[cacheKey] && Date.now() - accountsCache[cacheKey].ts < CACHE_TTL) {
      console.log(`⏱  GET /proxy/accounts → cache hit (${cacheKey})`);
      return res.json(accountsCache[cacheKey].data);
    }

    const t0 = Date.now();
    const repFilter = rep ? `filter=salesRep:eq:${encodeURIComponent(rep)}&` : '';

    // 1. Fetch customers + CY/PY ticket totals in parallel (3 calls total regardless of customer count)
    const now    = new Date();
    const yr     = now.getFullYear();
    const mm     = String(now.getMonth() + 1).padStart(2, '0');
    const dd     = String(now.getDate()).padStart(2, '0');
    const today  = `${yr}-${mm}-${dd}`;
    const ytdStart  = `${yr}-01-01`;
    const pyStart   = `${yr - 1}-01-01`;
    const pyEnd     = `${yr - 1}-${mm}-${dd}`;
    const repTicketFilter = rep ? `SalesRep:eq:${encodeURIComponent(rep)},` : '';

    const pyMonthStart   = `${yr - 1}-${mm}-01`;
    // Last day of the full prior-year same month (not today's day last year)
    const pyMonthEnd     = new Date(yr - 1, parseInt(mm, 10), 0).toISOString().slice(0, 10);
    const pyMonthCacheKey = `${yr - 1}-${mm}`;
    const cyYtdCacheKey   = `${ytdStart}:${today}`;
    const pyYtdCacheKey   = `${pyStart}:${pyEnd}`;

    // All three ticket fetches drop the SalesRep filter — historical tickets carry the rep
    // at write time, not the current account owner, so a rep filter silently drops
    // transferred accounts. Scope to current rep via custNo join against customer list below.
    const pyMonthTicketsPromise = (pyMonthGlobalCache[pyMonthCacheKey] && Date.now() - pyMonthGlobalCache[pyMonthCacheKey].ts < CACHE_TTL)
      ? Promise.resolve(pyMonthGlobalCache[pyMonthCacheKey].data)
      : fetchAllPagesPar(
          `/api/v1/pos/ticket-history?filter=BusinessDate:gte:${pyMonthStart},BusinessDate:lte:${pyMonthEnd}&fields=CustNo,Total&pageSize=500`
        ).then(data => { pyMonthGlobalCache[pyMonthCacheKey] = { data, ts: Date.now() }; return data; });

    const cyTicketsPromise = (cyYtdGlobalCache[cyYtdCacheKey] && Date.now() - cyYtdGlobalCache[cyYtdCacheKey].ts < CACHE_TTL)
      ? Promise.resolve(cyYtdGlobalCache[cyYtdCacheKey].data)
      : fetchAllPagesPar(
          `/api/v1/pos/ticket-history?filter=BusinessDate:gte:${ytdStart},BusinessDate:lte:${today}&fields=CustNo,Total,BusinessDate&pageSize=500`
        ).then(data => { cyYtdGlobalCache[cyYtdCacheKey] = { data, ts: Date.now() }; return data; });

    const pyTicketsPromise = (pyYtdGlobalCache[pyYtdCacheKey] && Date.now() - pyYtdGlobalCache[pyYtdCacheKey].ts < CACHE_TTL)
      ? Promise.resolve(pyYtdGlobalCache[pyYtdCacheKey].data)
      : fetchAllPagesPar(
          `/api/v1/pos/ticket-history?filter=BusinessDate:gte:${pyStart},BusinessDate:lte:${pyEnd}&fields=CustNo,Total&pageSize=500`
        ).then(data => { pyYtdGlobalCache[pyYtdCacheKey] = { data, ts: Date.now() }; return data; });

    // Full prior calendar year — for annual target (Signal 3) and order-date history (Signal 1)
    const pyFullStart    = `${yr - 1}-01-01`;
    const pyFullEnd      = `${yr - 1}-12-31`;
    const pyFullCacheKey = String(yr - 1);
    const PY_FULL_TTL    = 60 * 60 * 1000; // 1-hour TTL (historical data rarely changes)
    const pyFullPromise  = (pyFullYearCache[pyFullCacheKey] && Date.now() - pyFullYearCache[pyFullCacheKey].ts < PY_FULL_TTL)
      ? Promise.resolve(pyFullYearCache[pyFullCacheKey].data)
      : fetchAllPagesPar(
          `/api/v1/pos/ticket-history?filter=BusinessDate:gte:${pyFullStart},BusinessDate:lte:${pyFullEnd}&fields=CustNo,Total,BusinessDate&pageSize=500`
        ).then(data => { pyFullYearCache[pyFullCacheKey] = { data, ts: Date.now() }; return data; });

    const t1 = Date.now();
    const [customers, cyTickets, pyTickets, pyMonthTickets, pyFullTickets] = await Promise.all([
      fetchAllPages(
        `/api/v1/Customers?${repFilter}fields=custNo,name,state,salesRep,lastSaleDate&pageSize=200`
      ),
      cyTicketsPromise,
      pyTicketsPromise,
      pyMonthTicketsPromise,
      pyFullPromise,
    ]);
    console.log(`  customers+tickets: ${customers.length} customers, ${cyTickets.length} CY / ${pyTickets.length} PY / ${pyMonthTickets.length} pyMonth tickets in ${((Date.now()-t1)/1000).toFixed(2)}s`);

    // Fetch YTD line items per customer to compute best-seller % (unit-based).
    // bestSeller set is profCod1=Y items; cached 30 min.
    const [bsSet] = await Promise.all([getBestSellerSet()]);
    const bsPctData = {};
    await parallelLimit(customers.map(c => async () => {
      try {
        const enc   = encodeURIComponent(c.custNo);
        const items = await fetchAllPagesPar(
          `/api/v1/Customers/${enc}/line-items?filter=businessDate:gte:${ytdStart},businessDate:lte:${today}&compact=true&fields=itemNo,quantity&pageSize=500`
        );
        let bsUnits = 0, totalUnits = 0;
        for (const l of items) {
          const qty = parseFloat(l.quantity || l.qty || 1);
          totalUnits += qty;
          if (bsSet.has((l.itemNo || '').trim().toUpperCase())) bsUnits += qty;
        }
        bsPctData[c.custNo] = { bsUnits, totalUnits };
      } catch (_) {
        bsPctData[c.custNo] = { bsUnits: 0, totalUnits: 0 };
      }
    }), 20);
    console.log(`  bsPct fetch done for ${customers.length} customers`);

    if (!customers.length) {
      accountsCache[cacheKey] = { data: [], ts: Date.now() };
      return res.json([]);
    }

    // 2. Aggregate ticket totals by custNo
    const salesMap = {};
    for (const t of cyTickets) {
      const c = (t.CustNo || t.custNo || '').trim();
      if (c) salesMap[c] = salesMap[c] || { ytd: 0, prior: 0, monthGoal: 0 };
      if (c) salesMap[c].ytd += parseFloat(t.Total || t.total || 0);
    }
    for (const t of pyTickets) {
      const c = (t.CustNo || t.custNo || '').trim();
      if (c) salesMap[c] = salesMap[c] || { ytd: 0, prior: 0, monthGoal: 0 };
      if (c) salesMap[c].prior += parseFloat(t.Total || t.total || 0);
    }
    for (const t of pyMonthTickets) {
      const c = (t.CustNo || t.custNo || '').trim();
      if (c) salesMap[c] = salesMap[c] || { ytd: 0, prior: 0, monthGoal: 0 };
      if (c) salesMap[c].monthGoal += parseFloat(t.Total || t.total || 0);
    }

    // 3. Build pyFull totals + per-customer order-date pool for health signals
    const pyFullMap  = {}; // custNo → full prior year total
    const dateMap    = {}; // custNo → Set of date strings (cy + pyFull combined)

    for (const t of pyFullTickets) {
      const c = (t.CustNo || t.custNo || '').trim();
      if (!c) continue;
      pyFullMap[c] = (pyFullMap[c] || 0) + parseFloat(t.Total || t.total || 0);
      const d = (t.BusinessDate || t.businessDate || '').slice(0, 10);
      if (d) { if (!dateMap[c]) dateMap[c] = new Set(); dateMap[c].add(d); }
    }
    for (const t of cyTickets) {
      const c = (t.CustNo || t.custNo || '').trim();
      if (!c) continue;
      const d = (t.BusinessDate || t.businessDate || '').slice(0, 10);
      if (d) { if (!dateMap[c]) dateMap[c] = new Set(); dateMap[c].add(d); }
    }

    // Precompute typicalIntervalDays for every customer
    const intervalMap = {};
    for (const [custNo, dateSet] of Object.entries(dateMap)) {
      intervalMap[custNo] = computeTypicalInterval([...dateSet]);
    }

    // Run-rate: fraction of calendar year elapsed
    const dayOfYr  = Math.floor((now - new Date(yr, 0, 1)) / 86400000) + 1;
    const runRate  = dayOfYr / 365;

    // 4. Build account records
    const accounts = customers.map(c => {
      const s        = salesMap[c.custNo] || { ytd: 0, prior: 0, monthGoal: 0 };
      const ytdSales = s.ytd;
      const priorYtd = s.prior;
      const target   = priorYtd;

      const pctToTarget = target > 0 ? ytdSales / target : (ytdSales > 0 ? 1 : 0);

      const lastDate  = c.lastSaleDate ? c.lastSaleDate.slice(0, 10) : null;
      const daysSince = lastDate
        ? Math.floor((Date.now() - new Date(lastDate)) / 86400000)
        : 999;

      const tier = computeTier(pctToTarget, daysSince, ytdSales, priorYtd);

      const pyFullYear        = +(pyFullMap[c.custNo] || 0).toFixed(2);
      const typicalIntervalDays = intervalMap[c.custNo] ?? null;
      const healthSignals     = classifyAccountHealth({
        daysSinceOrder: daysSince,
        typicalIntervalDays,
        ytdSales,
        priorYtd,
        pyFullYear,
        runRate,
      });

      const bs = bsPctData[c.custNo] || { bsUnits: 0, totalUnits: 0 };

      return {
        custNo:         c.custNo,
        name:           c.name || '',
        state:          c.state || '',
        salesRep:       c.salesRep || '',
        ytdSales:       +ytdSales.toFixed(2),
        priorYtd:       +priorYtd.toFixed(2),
        monthGoal:      +(s.monthGoal * (1 + MONTHLY_GROWTH_GOAL_PCT)).toFixed(2),
        target:         +target.toFixed(2),
        pctToTarget:    +pctToTarget.toFixed(4),
        daysSinceOrder: daysSince,
        lastOrderDate:  lastDate,
        tier,          // current classification (old rules) — pending diagnostic review
        healthSignals, // new 3-signal classification — use after diagnostic approval
        typicalIntervalDays,
        pyFullYear,
        bsUnits:        +bs.bsUnits.toFixed(0),
        totalUnits:     +bs.totalUnits.toFixed(0),
        bsPct:          bs.totalUnits > 0 ? +(bs.bsUnits / bs.totalUnits).toFixed(4) : 0,
      };
    });

    accounts.sort((a, b) => b.ytdSales - a.ytdSales);
    // Bust any stale cache entries that may have been built before this fix
    Object.keys(accountsCache).forEach(k => { if (k !== cacheKey) delete accountsCache[k]; });
    accountsCache[cacheKey] = { data: accounts, ts: Date.now() };
    routeTimer('GET /proxy/accounts', t0, { customers: customers.length, cyTickets: cyTickets.length, pyTickets: pyTickets.length });
    res.json(accounts);
  } catch (e) {
    console.error('/proxy/accounts error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/accounts/health-diagnostic?rep= ───────────────
// Compares old tier classification vs new 3-signal classification.
// Load /proxy/accounts first so the cache is warm, then call this endpoint.
// Review the output before enabling the new classification in production.
router.get('/accounts/health-diagnostic', async (req, res) => {
  try {
    const rep      = (req.query.rep || SALES_REP || '').trim();
    const cacheKey = rep || '__all__';
    if (!accountsCache[cacheKey]) {
      return res.status(503).json({
        error: 'Cache is cold. Load /proxy/accounts?rep=<REP> first, then retry this endpoint.',
      });
    }

    const accounts = accountsCache[cacheKey].data;

    const TIER_ORDER = { Healthy: 0, Attention: 1, AtRisk: 2, Critical: 3 };
    const comparison = accounts.map(a => {
      const oldTier = a.tier;
      const newTier = a.healthSignals?.tier || 'Unknown';
      const swing   = TIER_ORDER[newTier] - TIER_ORDER[oldTier];
      return {
        custNo:             a.custNo,
        name:               a.name,
        oldTier,
        newTier,
        swing,              // positive = got worse, negative = improved
        driverSignal:       a.healthSignals?.driverSignal,
        signals:            a.healthSignals?.signals,
        daysSinceOrder:     a.daysSinceOrder,
        typicalIntervalDays: a.typicalIntervalDays,
        ytdSales:           a.ytdSales,
        priorYtd:           a.priorYtd,
        pyFullYear:         a.pyFullYear,
      };
    });

    // Summary stats
    const tierDist = { old: {}, new: {} };
    const TIERS = ['Healthy', 'Attention', 'AtRisk', 'Critical'];
    TIERS.forEach(t => { tierDist.old[t] = 0; tierDist.new[t] = 0; });
    comparison.forEach(r => {
      if (tierDist.old[r.oldTier] !== undefined) tierDist.old[r.oldTier]++;
      if (tierDist.new[r.newTier] !== undefined) tierDist.new[r.newTier]++;
    });

    const changed      = comparison.filter(r => r.oldTier !== r.newTier);
    const bigSwings    = comparison.filter(r => Math.abs(r.swing) >= 2); // 2+ tier jumps
    const noInterval   = comparison.filter(r => r.typicalIntervalDays === null);

    res.json({
      summary: {
        total:           comparison.length,
        unchanged:       comparison.length - changed.length,
        changed:         changed.length,
        bigSwings:       bigSwings.length,
        noTypicalInterval: noInterval.length,
        tierDistributionOld: tierDist.old,
        tierDistributionNew: tierDist.new,
      },
      changed,
      bigSwings,
      noTypicalInterval: noInterval.map(r => ({ custNo: r.custNo, name: r.name, daysSinceOrder: r.daysSinceOrder })),
      all: comparison,
    });
  } catch (e) {
    console.error('/proxy/accounts/health-diagnostic error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/customers/search?q= ───────────────────────────
router.get('/customers/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json([]);

    // Search from any cached rep data, fall back to API
    const anyCache = Object.values(accountsCache).find(c => c.data);
    let customers = anyCache ? anyCache.data : null;
    if (!customers) {
      const repFilter = SALES_REP ? `filter=salesRep:eq:${encodeURIComponent(SALES_REP)}&` : '';
      customers = await fetchAllPages(
        `/api/v1/Customers?${repFilter}fields=custNo,name,state,salesRep&pageSize=200`
      );
    }

    const scored = [];
    for (const c of customers) {
      const custNo = (c.custNo || '').toLowerCase();
      const name   = (c.name   || '').toLowerCase();
      let score = -1;
      if (custNo === q)              score = 0;
      else if (custNo.startsWith(q)) score = 1;
      else if (name.startsWith(q))   score = 2;
      else if (custNo.includes(q))   score = 3;
      else if (name.includes(q))     score = 4;
      if (score >= 0) scored.push({ score, c });
    }

    const results = scored
      .sort((a, b) => a.score - b.score)
      .slice(0, 10)
      .map(({ c }) => ({
        custNo: c.custNo,
        name:   c.name  || '',
        state:  c.state || '',
      }));

    res.json(results);
  } catch (e) {
    console.error('/proxy/customers/search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/customer/:custNo ───────────────────────────────
router.get('/customer/:custNo', async (req, res) => {
  try {
    const key = req.params.custNo;
    if (custDetailCache[key] && Date.now() - custDetailCache[key].ts < CACHE_TTL) {
      return res.json(custDetailCache[key].data);
    }
    const r    = await doFetch('GET', `/api/v1/Customers/${encodeURIComponent(key)}?includeCustomFields=true&compact=true`);
    const body = await r.json();
    const d    = body.data || body;
    if (d && d.USER_BEST_PRICE_COD_CUST !== undefined) {
      d.best_price_code = d.USER_BEST_PRICE_COD_CUST || null;
    }
    if (r.ok) custDetailCache[key] = { data: d, ts: Date.now() };
    res.status(r.status).json(d);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/orders/:custNo — 2-year order history ─────────
router.get('/orders/:custNo', async (req, res) => {
  try {
    const key = req.params.custNo;
    if (custOrdersCache[key] && Date.now() - custOrdersCache[key].ts < CACHE_TTL) {
      return res.json(custOrdersCache[key].data);
    }
    const custNo = encodeURIComponent(key);
    const since  = (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 2);
      return d.toISOString().slice(0, 10);
    })();
    const today = new Date().toISOString().slice(0, 10);
    const raw = await fetchAllPagesPar(
      `/api/v1/pos/ticket-history?filter=custNo:eq:${custNo},businessDate:gte:${since},businessDate:lte:${today}&fields=TicketNo,Total,SaleSubtotal,SaleLines,BusinessDate&pageSize=200`
    );
    const orders = raw.map(o => ({
      date:      o.BusinessDate  || o.businessDate  || '',
      ticketNo:  o.TicketNo      || o.ticketNo      || '',
      amount:    parseFloat(o.SaleSubtotal || o.saleSubtotal || o.Total || o.total || 0),
      itemCount: o.SaleLines     || o.saleLines     || null,
    }));
    custOrdersCache[key] = { data: orders, ts: Date.now() };
    res.json(orders);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/order-lines/:ticketNo — line items for one ticket ──
router.get('/order-lines/:ticketNo', async (req, res) => {
  try {
    const tktNo = encodeURIComponent(req.params.ticketNo);
    const r     = await doFetch('GET', `/api/v1/pos/ticket-history/${tktNo}`);
    if (!r.ok) {
      console.error(`order-lines: ticket-history returned ${r.status} for ${req.params.ticketNo}`);
      return res.json([]);
    }
    const body = await r.json();
    const raw  = (body.data || body).lineItems || [];
    const lines = raw.map(l => ({
      itemNo:      l.itemNo      || '',
      description: l.description || '',
      qty:         parseFloat(l.quantity  || 0),
      unitPrice:   parseFloat(l.price     || 0),
      extPrice:    parseFloat(l.extPrice  || 0),
    })).filter(l => l.itemNo);
    res.json(lines);
  } catch (e) {
    console.error('/proxy/order-lines error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/order-detail/:ticketNo?custNo= ────────────────
router.get('/order-detail/:ticketNo', async (req, res) => {
  try {
    const key   = req.params.ticketNo;
    const tktNo = encodeURIComponent(key);
    const r     = await doFetch('GET', `/api/v1/pos/ticket-history/${tktNo}`);
    if (!r.ok) return res.status(r.status).json({ error: 'Order not found' });
    const body = await r.json();
    const raw  = body.data || body;

    const baseLines = (raw.lineItems || []).map(l => ({
      itemNo:      (l.itemNo || '').trim(),
      category:    l.categoryCode || l.category || l.deptCode || l.dept || '',
      description: l.description || '',
      qty:         parseFloat(l.quantity  || l.qty    || 0),
      unitPrice:   parseFloat(l.price     || 0),
      unitCost:    parseFloat(l.unitCost  || l.cost   || 0),
      extPrice:    parseFloat(l.extPrice  || l.extAmt || 0),
    })).filter(l => l.itemNo);

    const headerTotal = parseFloat(raw.total || raw.Total || 0);
    const calcTotal   = baseLines.reduce((s, l) => s + l.extPrice, 0);
    const orderDate   = (raw.businessDate || raw.BusinessDate || '').slice(0, 10);

    // ── Optional enrichment when custNo is provided ───────────
    const custNo = (req.query.custNo || raw.custNo || raw.CustNo || '').trim();
    let lines = baseLines;
    let priorOrderTotal = 0;

    if (custNo && orderDate) {
      const custNoEnc = encodeURIComponent(custNo);
      // 365 days before the order date (day before order as upper bound)
      const orderDateObj = new Date(orderDate + 'T00:00:00Z');
      const dayBeforeObj = new Date(orderDateObj);
      dayBeforeObj.setUTCDate(dayBeforeObj.getUTCDate() - 1);
      const dayBefore  = dayBeforeObj.toISOString().slice(0, 10);
      const yearBefore = new Date(dayBeforeObj);
      yearBefore.setUTCFullYear(yearBefore.getUTCFullYear() - 1);
      const yearBeforeStr = yearBefore.toISOString().slice(0, 10);

      const [bsSet, custLines, priorTickets] = await Promise.all([
        getBestSellerSet(),
        // Customer line-items purchased in the 365-day window before this order
        fetchAllPagesPar(
          `/api/v1/Customers/${custNoEnc}/line-items?filter=businessDate:gte:${yearBeforeStr},businessDate:lte:${dayBefore}&compact=true&fields=itemNo&pageSize=2000`
        ).catch(() => []),
        // Customer tickets in same window — used to find the most recent prior order
        fetchAllPages(
          `/api/v1/pos/ticket-history?filter=custNo:eq:${custNoEnc},BusinessDate:gte:${yearBeforeStr},BusinessDate:lte:${dayBefore}&fields=TicketNo,Total,BusinessDate&pageSize=200`
        ).catch(() => []),
      ]);

      const priorPurchaseSet = new Set(
        custLines.map(l => (l.itemNo || '').trim().toUpperCase()).filter(Boolean)
      );

      // Most recent ticket before this order
      const sortedPrior = priorTickets
        .filter(t => (t.BusinessDate || t.businessDate || '').slice(0, 10) < orderDate)
        .sort((a, b) =>
          (b.BusinessDate || b.businessDate || '').localeCompare(a.BusinessDate || a.businessDate || '')
        );
      priorOrderTotal = sortedPrior.length > 0
        ? +(parseFloat(sortedPrior[0].Total || sortedPrior[0].total || 0)).toFixed(2)
        : 0;

      lines = baseLines.map(l => ({
        ...l,
        isBestSeller: bsSet.has(l.itemNo.toUpperCase()),
        isRepeat:     priorPurchaseSet.has(l.itemNo.toUpperCase()),
      }));
    }

    res.json({
      ticketNo:        raw.ticketNo  || raw.TicketNo  || key,
      date:            orderDate,
      custNo:          raw.custNo    || raw.CustNo    || custNo,
      custName:        raw.custName  || raw.CustName  || '',
      rep:             raw.salesRep  || raw.SalesRep  || '',
      storeNo:         raw.storeNo   || raw.StoreNo   || '',
      total:           +(headerTotal || calcTotal).toFixed(2),
      priorOrderTotal,
      lines,
    });
  } catch (e) {
    console.error('/proxy/order-detail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/mtd/:custNo — month-to-date sales ──────────────
router.get('/mtd/:custNo', async (req, res) => {
  try {
    const key = req.params.custNo;
    if (custMtdCache[key] && Date.now() - custMtdCache[key].ts < CACHE_TTL) {
      return res.json(custMtdCache[key].data);
    }
    const custNo = encodeURIComponent(key);
    const now    = new Date();
    const mtdStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const mtdEnd   = now.toISOString().slice(0, 10);

    const tickets = await fetchAllPages(
      `/api/v1/pos/ticket-history?filter=custNo:eq:${custNo},businessDate:gte:${mtdStart},businessDate:lte:${mtdEnd}&fields=custNo,total,SaleSubtotal,businessDate&pageSize=200`
    );

    const mtdTotal  = tickets.reduce((s, t) => s + (parseFloat(t.SaleSubtotal || t.saleSubtotal || t.Total || t.total) || 0), 0);
    const orderDays = new Set(tickets.map(t => (t.businessDate || '').slice(0, 10))).size;
    const result    = { total: +mtdTotal.toFixed(2), orderDays, orders: tickets.length };
    custMtdCache[key] = { data: result, ts: Date.now() };
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Concurrency-limited parallel executor ─────────────────────
async function parallelLimit(fns, limit = 20) {
  const results = new Array(fns.length);
  let idx = 0;
  async function worker() {
    while (idx < fns.length) {
      const i = idx++;
      results[i] = await fns[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
  return results;
}

// ── GET /proxy/leaderboard ────────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  if (req.query.refresh !== '1' && leaderboardCache.data && Date.now() - leaderboardCache.ts < LEADERBOARD_TTL) {
    return res.json(leaderboardCache.data);
  }

  try {
    const now  = new Date();
    const yr   = now.getFullYear();
    const mm   = now.getMonth(); // 0-indexed
    const dd   = String(now.getDate()).padStart(2, '0');

    // ── Date window helpers ───────────────────────────────────
    const isoMonth = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`;
    const monthStart = (y, m) => `${isoMonth(y, m)}-01`;
    // Last day of a month
    const monthEnd = (y, m) => new Date(y, m + 1, 0).toISOString().slice(0, 10);
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    // Current month: Jan 1 of current month → today
    const cmStart  = monthStart(yr, mm);
    const cmEnd    = `${yr}-${String(mm + 1).padStart(2, '0')}-${dd}`;
    // Last completed month
    const lmY = mm === 0 ? yr - 1 : yr;
    const lmM = mm === 0 ? 11 : mm - 1;
    const lmStart  = monthStart(lmY, lmM);
    const lmEnd    = monthEnd(lmY, lmM);
    // Prior month (2 months back, for Most Improved)
    const pmY = lmM === 0 ? lmY - 1 : lmY;
    const pmM = lmM === 0 ? 11 : lmM - 1;
    const pmStart  = monthStart(pmY, pmM);
    const pmEnd    = monthEnd(pmY, pmM);
    // Prior-year equivalents (for monthly goal = prior year same month × growth factor)
    const pyCmStart = monthStart(yr - 1, mm);
    const pyCmEnd   = monthEnd(yr - 1, mm);
    const pyLmStart = monthStart(lmY - 1, lmM);
    const pyLmEnd   = monthEnd(lmY - 1, lmM);

    // ticketFetch with optional cache (ttl=0 → no cache, ttl>0 → lbMonthCache)
    const ticketFetch = (start, end, ttl = 0) => {
      const key = `${start}:${end}`;
      if (ttl > 0 && lbMonthCache[key] && Date.now() - lbMonthCache[key].ts < ttl) {
        return Promise.resolve(lbMonthCache[key].data);
      }
      const p = fetchAllPagesPar(
        `/api/v1/pos/ticket-history?filter=BusinessDate:gte:${start},BusinessDate:lte:${end}&fields=CustNo,Total&pageSize=500`
      );
      if (ttl > 0) p.then(d => { lbMonthCache[key] = { data: d, ts: Date.now() }; });
      return p;
    };

    const { ytdStart, ytdEnd, priorStart, priorEnd } = ytdDateRange();
    const cyKey = `${ytdStart}:${ytdEnd}`;
    const pyKey = `${priorStart}:${priorEnd}`;

    // 1. All fetches in parallel — users fetch moved here (was sequential before)
    const [activeReps, allCustomers, cyTickets, pyTickets, cmTickets, lmTickets, pmTickets, pyCmTickets, pyLmTickets, usersRes] = await Promise.all([
      getActiveReps(),
      fetchAllPagesPar(`/api/v1/Customers?fields=custNo,salesRep,lastSaleDate&pageSize=200`),
      cyYtdGlobalCache[cyKey] && Date.now() - cyYtdGlobalCache[cyKey].ts < CACHE_TTL
        ? Promise.resolve(cyYtdGlobalCache[cyKey].data)
        : ticketFetch(ytdStart, ytdEnd).then(d => { cyYtdGlobalCache[cyKey] = { data: d, ts: Date.now() }; return d; }),
      pyYtdGlobalCache[pyKey] && Date.now() - pyYtdGlobalCache[pyKey].ts < CACHE_TTL
        ? Promise.resolve(pyYtdGlobalCache[pyKey].data)
        : ticketFetch(priorStart, priorEnd).then(d => { pyYtdGlobalCache[pyKey] = { data: d, ts: Date.now() }; return d; }),
      ticketFetch(cmStart,   cmEnd,   CACHE_TTL),   // current month — 5-min cache
      ticketFetch(lmStart,   lmEnd,   LB_HIST_TTL), // last completed month — 2-hr cache
      ticketFetch(pmStart,   pmEnd,   LB_HIST_TTL), // prior month — 2-hr cache
      ticketFetch(pyCmStart, pyCmEnd, LB_HIST_TTL), // PY current month — 2-hr cache
      ticketFetch(pyLmStart, pyLmEnd, LB_HIST_TTL), // PY last month — 2-hr cache
      doFetch('GET', `/api/v1/System/users?filter=wrkgrpId:eq:KGS&fields=usrId,name&pageSize=500`),
    ]);

    // Build rep display name map
    const usersBody = usersRes.ok ? await usersRes.json() : {};
    const nameMap   = {};
    (usersBody.data || []).forEach(u => {
      nameMap[(u.usrId || '').trim().toUpperCase()] = (u.name || '').trim();
    });

    const repMap = {};
    activeReps.forEach(({ id }) => {
      const raw  = nameMap[id.toUpperCase()] || id;
      repMap[id] = raw.replace(/\s*[-–]\s*(ACTIVE|ACT)$/i, '').trim() || id;
    });

    // 2. Build per-custNo sales maps from all windows
    const buildMap = (tickets) => {
      const m = {};
      for (const t of tickets) {
        const k = (t.CustNo || t.custNo || '').trim();
        if (k) m[k] = (m[k] || 0) + parseFloat(t.Total || t.total || 0);
      }
      return m;
    };
    const ytdMap    = buildMap(cyTickets);
    const pyYtdMap  = buildMap(pyTickets);
    const cmMap     = buildMap(cmTickets);
    const lmMap     = buildMap(lmTickets);
    const pmMap     = buildMap(pmTickets);
    const pyCmMap   = buildMap(pyCmTickets);
    const pyLmMap   = buildMap(pyLmTickets);

    // 3. Walk customer list, join to all windows, group by rep
    const repData = {};
    Object.keys(repMap).forEach(id => {
      repData[id] = { ytd: 0, priorYtd: 0, cm: 0, lm: 0, pm: 0, pyCm: 0, pyLm: 0, accounts: [] };
    });

    for (const c of allCustomers) {
      const repId = (c.salesRep || '').trim();
      if (!repData[repId]) continue;
      const d = repData[repId];
      const k = c.custNo;
      d.ytd    += ytdMap[k]   || 0;
      d.priorYtd += pyYtdMap[k] || 0;
      d.cm     += cmMap[k]    || 0;
      d.lm     += lmMap[k]    || 0;
      d.pm     += pmMap[k]    || 0;
      d.pyCm   += pyCmMap[k]  || 0;
      d.pyLm   += pyLmMap[k]  || 0;
      const lastDate  = c.lastSaleDate ? c.lastSaleDate.slice(0, 10) : null;
      const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate)) / 86400000) : 999;
      const ytdSales  = ytdMap[k] || 0;
      const priorYtd  = pyYtdMap[k] || 0;
      d.accounts.push({ tier: computeTier(priorYtd > 0 ? ytdSales / priorYtd : 0, daysSince, ytdSales, priorYtd) });
    }

    // 4a. Business-day context for current month (used by pace score)
    const bdCtx = monthBusinessDayContext(now);
    // bdCtx: { elapsed, total, pctElapsed }

    // 4. Compute per-rep stats including monthly goal (prior year × growth factor)
    const G = 1 + MONTHLY_GROWTH_GOAL_PCT;
    const repStats = Object.entries(repMap).map(([repId, repName]) => {
      const d        = repData[repId] || {};
      const accounts = d.accounts || [];
      const tiers    = { Healthy: 0, Attention: 0, AtRisk: 0, Critical: 0 };
      accounts.forEach(a => { if (tiers[a.tier] !== undefined) tiers[a.tier]++; });
      const healthScore = accounts.length > 0
        ? Math.round((tiers.Healthy * 100 + tiers.Attention * 60 + tiers.AtRisk * 25) / accounts.length)
        : 0;

      const cmGoal  = d.pyCm > 0 ? +(d.pyCm * G).toFixed(2) : null;
      const lmGoal  = d.pyLm > 0 ? +(d.pyLm * G).toFixed(2) : null;
      const cmOver  = cmGoal !== null ? +(d.cm - cmGoal).toFixed(2) : null;
      const lmOver  = lmGoal !== null ? +(d.lm - lmGoal).toFixed(2) : null;
      // Most Improved: lm − pm (only if both have sales)
      const improvement = (d.lm > 0 && d.pm > 0) ? +(d.lm - d.pm).toFixed(2) : null;

      // Pace score: percentage points ahead of / behind monthly pace
      const paceScore  = computePaceScore(d.cm, cmGoal, bdCtx.elapsed, bdCtx.total);
      const pctToGoal  = cmGoal > 0 ? +((d.cm / cmGoal) * 100).toFixed(2) : null;

      // Award eligibility: goal must be set AND ≥ $5,000
      const AWARD_FLOOR = 5000;
      const awardEligible = cmGoal !== null && cmGoal >= AWARD_FLOOR;

      return {
        repId, repName,
        accountCount:    accounts.length,
        healthScore,
        ...tiers,
        // Current month
        currentMonthSales: +d.cm.toFixed(2),
        currentMonthGoal:  cmGoal,
        currentMonthOver:  cmOver,
        pctToGoal,
        paceScore:         paceScore !== null ? +paceScore.toFixed(2) : null,
        awardEligible,
        // Last completed month
        lastMonthSales:    +d.lm.toFixed(2),
        lastMonthGoal:     lmGoal,
        lastMonthOver:     lmOver,
        // Prior month (for Most Improved)
        priorMonthSales:   +d.pm.toFixed(2),
        improvement,
      };
    });

    const eligibleReps = repStats.filter(r => r.accountCount > 0);

    // 5. Compute awards
    // SOTM: ranked by paceScore among award-eligible reps (goal set AND ≥ $5,000)
    const sotmCandidates = eligibleReps.filter(r => r.awardEligible && r.paceScore !== null);
    sotmCandidates.sort((a, b) => b.paceScore - a.paceScore);
    const sotmWinner = sotmCandidates[0] || null;
    const allUnderGoal = sotmWinner !== null && sotmWinner.paceScore < 0;

    // Most Improved: highest (lm − pm), both months must have data
    const miCandidates = eligibleReps.filter(r => r.improvement !== null);
    miCandidates.sort((a, b) => b.improvement - a.improvement);
    const miWinner = miCandidates[0] || null;

    // 6. Current-month podium — award-eligible reps only, ranked by paceScore
    const podiumReps = eligibleReps
      .filter(r => r.awardEligible && r.paceScore !== null)
      .sort((a, b) => b.paceScore - a.paceScore)
      .slice(0, 3);

    // 7. Full standings:
    //   Group A: award-eligible reps (goal ≥ $5k), sorted by paceScore desc
    //   Group B: reps with goal < $5k (below floor), sorted by paceScore desc
    //   Group C: no-goal reps, sorted by sales desc — always at bottom
    const AWARD_FLOOR = 5000;
    const standings = [
      ...eligibleReps
        .filter(r => r.awardEligible && r.paceScore !== null)
        .sort((a, b) => b.paceScore - a.paceScore),
      ...eligibleReps
        .filter(r => !r.awardEligible && r.currentMonthGoal !== null && r.currentMonthGoal > 0 && r.paceScore !== null)
        .sort((a, b) => b.paceScore - a.paceScore),
      ...eligibleReps
        .filter(r => r.currentMonthGoal === null || r.currentMonthGoal <= 0)
        .sort((a, b) => b.currentMonthSales - a.currentMonthSales),
    ].map((r, i) => ({ ...r, standingsRank: i + 1 }));

    const payload = {
      updatedAt:         now.toISOString(),
      currentMonthLabel: `${MONTHS[mm]} ${yr}`,
      lastMonthLabel:    `${MONTHS[lmM]} ${lmY}`,
      priorMonthLabel:   `${MONTHS[pmM]} ${pmY}`,
      // Business-day context for the current month — used by frontend pace indicator
      businessDays: {
        elapsed:    bdCtx.elapsed,
        total:      bdCtx.total,
        pctElapsed: +bdCtx.pctElapsed.toFixed(2),
      },
      awards: {
        sotm: sotmWinner ? {
          repId:        sotmWinner.repId,
          repName:      sotmWinner.repName,
          paceScore:    sotmWinner.paceScore,
          overGoal:     sotmWinner.currentMonthOver,
          sales:        sotmWinner.currentMonthSales,
          goal:         sotmWinner.currentMonthGoal,
          pctToGoal:    sotmWinner.pctToGoal,
          allUnderGoal,
          inProgress:   true,
        } : null,
        mostImproved: miWinner ? {
          repId:        miWinner.repId,
          repName:      miWinner.repName,
          improvement:  miWinner.improvement,
          lastMonthSales:  miWinner.lastMonthSales,
          priorMonthSales: miWinner.priorMonthSales,
        } : null,
      },
      podium:    podiumReps,
      standings,
      totalAccounts: eligibleReps.reduce((s, r) => s + r.accountCount, 0),
      repCount:      eligibleReps.length,
      // last-month territory revenue (for stat strip)
      lastMonthTerritoryRevenue: +eligibleReps.reduce((s, r) => s + r.lastMonthSales, 0).toFixed(2),
    };

    leaderboardCache.data = payload;
    leaderboardCache.ts   = Date.now();
    res.json(payload);
  } catch (e) {
    console.error('/proxy/leaderboard error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

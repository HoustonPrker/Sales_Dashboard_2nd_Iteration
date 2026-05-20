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
const enforceRepScope = require('../middleware/enforceRepScope');
const requireRoles    = require('../middleware/requireRoles');
const { listUsers }   = require('../lib/user-store');
const { doFetch, fetchAllPages, fetchAllPagesPar, ytdDateRange, aggregateLineItems, routeTimer, SALES_REP, pyMonthGlobalCache } = require('../lib/api');
const { getAnnualGrowthPct, getMonthlyGrowthPct } = require('../lib/kellis-config');
const categoryCache = require('../lib/category-cache');
const { getActiveReps, isActiveRep } = require('../data/active-reps');
const { classifyAccountHealth, computeTypicalInterval } = require('../utils/health-classification');
const { monthBusinessDayContext, computePaceScore, computeYearRunRate } = require('../utils/business-days');

// ── In-memory cache keyed by rep (15-minute TTL) ──────────────
const accountsCache = {};  // { [rep]: { data, ts } }
const CACHE_TTL     = 15 * 60 * 1000;

const diskCache = require('../lib/disk-cache');
// Hydrate in-memory cache from disk on startup
Object.assign(accountsCache, diskCache.load());

// ── Best-seller % cache (30-min TTL) — keyed by rep ──────────
// Decoupled from accountsCache so 498 per-customer line-item calls
// only fire once every 30 min regardless of accounts cache churn.
const bsPctCache    = {};  // { [rep]: { data: {custNo→{bsUnits,…}}, ts } }
const BSPCT_TTL     = 30 * 60 * 1000;
let   bsPctInflight = {};  // { [rep]: true } — prevent duplicate background recomputes

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
// Annual health — based on YTD pace vs prior year. Recency thresholds are
// intentionally loose (60/90 days) so a monthly gap doesn't drag down annual health.
function computeTier(pctToTarget, daysSince, ytdSales, priorYtd) {
  const now     = new Date();
  const dayOfYr = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 86400000) + 1;
  const runRate = dayOfYr / 365;

  if (daysSince >= 90) return 'Critical';
  if (priorYtd > 0 && ytdSales < priorYtd * 0.5) return 'Critical';

  if (daysSince >= 60) return 'AtRisk';
  if (priorYtd > 0 && pctToTarget < (runRate - 0.25)) return 'AtRisk';

  if (priorYtd === 0) {
    if (daysSince <= 45 && ytdSales > 0) return 'Healthy';
    if (daysSince <= 60) return 'Attention';
    return 'AtRisk';
  }

  if (pctToTarget < (runRate - 0.10)) return 'Attention';
  return 'Healthy';
}

// Monthly health — based on MTD sales pace vs expected (goal × % of month elapsed).
function computeMonthTier(mtdSales, monthGoal, pctMonthElapsed) {
  if (monthGoal <= 0) return 'Healthy';
  if (pctMonthElapsed < 0.05) return 'Healthy'; // first ~1-2 days — too early to judge
  const expected = monthGoal * pctMonthElapsed;
  const pace = mtdSales / expected;
  if (pace >= 0.85) return 'Healthy';
  if (pace >= 0.65) return 'Attention';
  if (pace >= 0.40) return 'AtRisk';
  return 'Critical';
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

// ── Accounts: extracted build logic ──────────────────────────
async function buildAccountsData(repParam, repPrefix, cacheKey) {
    const repList   = [];  // unused — prefix filtering done after customer fetch
    const repFilter = '';  // always fetch all, filter client-side by prefix
    const t0 = Date.now();

    // 1. Fetch customers + CY/PY ticket totals in parallel (3 calls total regardless of customer count)
    const now    = new Date();
    const yr     = now.getFullYear();
    const mm     = String(now.getMonth() + 1).padStart(2, '0');
    const dd     = String(now.getDate()).padStart(2, '0');
    const today  = `${yr}-${mm}-${dd}`;
    const ytdStart  = `${yr}-01-01`;
    const mtdStart  = `${yr}-${mm}-01`;
    const pyStart   = `${yr - 1}-01-01`;
    const pyEnd     = `${yr - 1}-${mm}-${dd}`;
    const pyMtdStart = `${yr - 1}-${mm}-01`;
    const repTicketFilter = repList.length === 1 ? `SalesRep:eq:${encodeURIComponent(repList[0])},` : '';

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
        `/api/v1/Customers?${repFilter}fields=custNo,name,state,salesRep,lastSaleDate,categoryCode,termsCode,email1,phone1,discountPercent&pageSize=200`
      ),
      cyTicketsPromise,
      pyTicketsPromise,
      pyMonthTicketsPromise,
      pyFullPromise,
    ]);
    console.log(`  customers+tickets: ${customers.length} customers, ${cyTickets.length} CY / ${pyTickets.length} PY / ${pyMonthTickets.length} pyMonth tickets in ${((Date.now()-t1)/1000).toFixed(2)}s`);
    if (customers.length) console.log(`  [phone-debug] sample customer keys:`, Object.keys(customers[0]).filter(k => /phone|mobile|fax|alt/i.test(k)));

    // Keep customers with a sale in the last 24 months — excludes truly dormant/closed accounts
    const cutoff = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const recentCustomers = customers.filter(c => c.lastSaleDate && c.lastSaleDate.slice(0, 10) >= cutoff);

    // For advisors: filter to their rep prefix (e.g. MEGAN matches MEGAN, MEGAN-NEW, MEGAN-ACT)
    const filteredCustomers = repPrefix
      ? recentCustomers.filter(c => {
          const rep = (c.salesRep || '').trim().toUpperCase();
          return rep === repPrefix || rep.startsWith(repPrefix + '-');
        })
      : recentCustomers;
    console.log(`  active filter: ${customers.length} total → ${filteredCustomers.length} (cutoff=${cutoff}${repPrefix ? ` prefix=${repPrefix}` : ''})`);

    // ── Best-seller % — use cached data immediately, recompute in background if stale ──
    // bsPctCache has a 30-min TTL independent of accountsCache (15 min) so the
    // 249×2=498 per-customer line-item calls only fire once every 30 min.
    const bsPctData = (bsPctCache[cacheKey] && Date.now() - bsPctCache[cacheKey].ts < BSPCT_TTL)
      ? bsPctCache[cacheKey].data
      : {};

    const bsPctStale = !bsPctCache[cacheKey] || Date.now() - bsPctCache[cacheKey].ts >= BSPCT_TTL;
    if (bsPctStale && !bsPctInflight[cacheKey]) {
      // Fire-and-forget: recompute in background, update cache when done
      bsPctInflight[cacheKey] = true;
      const _customers  = filteredCustomers;
      const _ytdStart   = ytdStart, _today = today;
      const _pyStart    = pyStart,  _pyEnd  = pyEnd;
      const _cacheKey   = cacheKey;
      (async () => {
        try {
          const bsSet = await getBestSellerSet();
          const fresh = {};
          await parallelLimit(_customers.map(c => async () => {
            try {
              const enc = encodeURIComponent(c.custNo);
              const [cyItems, pyItems] = await Promise.all([
                fetchAllPagesPar(
                  `/api/v1/Customers/${enc}/line-items?filter=businessDate:gte:${_ytdStart},businessDate:lte:${_today}&compact=true&fields=itemNo&pageSize=500`
                ),
                fetchAllPagesPar(
                  `/api/v1/Customers/${enc}/line-items?filter=businessDate:gte:${_pyStart},businessDate:lte:${_pyEnd}&compact=true&fields=itemNo&pageSize=500`
                ),
              ]);
              let bsUnits = 0, totalUnits = 0, pyBsUnits = 0, pyTotalUnits = 0;
              for (const l of cyItems) { totalUnits++; if (bsSet.has((l.itemNo||'').trim().toUpperCase())) bsUnits++; }
              for (const l of pyItems) { pyTotalUnits++; if (bsSet.has((l.itemNo||'').trim().toUpperCase())) pyBsUnits++; }
              fresh[c.custNo] = { bsUnits, totalUnits, pyBsUnits, pyTotalUnits };
            } catch (_) {
              fresh[c.custNo] = { bsUnits: 0, totalUnits: 0, pyBsUnits: 0, pyTotalUnits: 0 };
            }
          }), 40);
          bsPctCache[_cacheKey] = { data: fresh, ts: Date.now() };
          // Bust accountsCache so next request gets updated bsPct values
          delete accountsCache[_cacheKey];
          console.log(`  bsPct background refresh done for ${_customers.length} customers`);
        } catch (e) {
          console.error('  bsPct background refresh error:', e.message);
        } finally {
          bsPctInflight[_cacheKey] = false;
        }
      })();
      if (!bsPctCache[cacheKey]) console.log(`  bsPct cache cold — serving zeros, recomputing in background`);
      else console.log(`  bsPct cache stale — serving cached, recomputing in background`);
    }

    if (!filteredCustomers.length) {
      accountsCache[cacheKey] = { data: [], ts: Date.now() };
      diskCache.save(accountsCache);
      return [];
    }

    // 2. Aggregate ticket totals by custNo
    const salesMap = {};
    const ensureEntry = c => { if (c) salesMap[c] = salesMap[c] || { ytd: 0, mtd: 0, prior: 0, priorMtd: 0, priorMonth: 0, monthGoal: 0 }; };
    for (const t of cyTickets) {
      const c = (t.CustNo || t.custNo || '').trim();
      ensureEntry(c);
      if (!c) continue;
      const amt = parseFloat(t.Total || t.total || 0);
      salesMap[c].ytd += amt;
      const d = (t.BusinessDate || t.businessDate || '').slice(0, 10);
      if (d >= mtdStart) salesMap[c].mtd += amt;
    }
    for (const t of pyTickets) {
      const c = (t.CustNo || t.custNo || '').trim();
      ensureEntry(c);
      if (!c) continue;
      const amt = parseFloat(t.Total || t.total || 0);
      salesMap[c].prior += amt;
      const d = (t.BusinessDate || t.businessDate || '').slice(0, 10);
      if (d >= pyMtdStart) salesMap[c].priorMtd += amt;
    }
    for (const t of pyMonthTickets) {
      const c = (t.CustNo || t.custNo || '').trim();
      ensureEntry(c);
      if (c) {
        const amt = parseFloat(t.Total || t.total || 0);
        salesMap[c].monthGoal  += amt;
        salesMap[c].priorMonth += amt;
      }
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

    // Month elapsed % — used by computeMonthTier and month run rate
    const monthBd         = monthBusinessDayContext(now);
    const pctMonthElapsed = monthBd.pctElapsed / 100; // 0–1

    // Annual run rate — weekday-based (Mon–Fri, excluding federal holidays)
    const yearRr          = computeYearRunRate(now);
    const pctYearElapsed  = yearRr.rate; // 0–1

    // 4. Build account records
    const accounts = filteredCustomers.map(c => {
      const s          = salesMap[c.custNo] || { ytd: 0, mtd: 0, prior: 0, priorMtd: 0, priorMonth: 0, monthGoal: 0 };
      const ytdSales   = s.ytd;
      const mtdSales   = s.mtd;
      const priorYtd   = s.prior;
      const priorMtd   = s.priorMtd;
      const priorMonth = s.priorMonth;
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

      const yyyyMM          = `${yr}-${mm}`;
      const monthlyG        = getMonthlyGrowthPct(yyyyMM);
      const annualG         = getAnnualGrowthPct();
      const monthGoalFinal  = +(s.monthGoal * (1 + monthlyG)).toFixed(2);
      const pctToMonthGoal  = monthGoalFinal > 0 ? +(mtdSales / monthGoalFinal).toFixed(4) : 0;
      const monthTier       = computeMonthTier(mtdSales, monthGoalFinal, pctMonthElapsed);

      const annualGoal      = +(pyFullYear * (1 + annualG)).toFixed(2);
      const pctToAnnualGoal = annualGoal > 0 ? +(ytdSales / annualGoal).toFixed(4) : 0;
      const monthRunRate    = pctMonthElapsed > 0 ? +(mtdSales / pctMonthElapsed).toFixed(2) : 0;
      const annualRunRate   = pctYearElapsed  > 0 ? +(ytdSales  / pctYearElapsed).toFixed(2)  : 0;

      return {
        custNo:         c.custNo,
        name:           c.name || '',
        state:          c.state || '',
        salesRep:       c.salesRep || '',
        category:       (c.categoryCode || '').trim(),
        termsCode:      (c.termsCode || '').trim(),
        email:          (c.email1 || '').trim(),
        phone:          (c.phone1 || '').trim(),
        phone2:         (c.phone1a || '').trim(),
        discount:       +(c.discountPercent || 0),
        ytdSales:       +ytdSales.toFixed(2),
        mtdSales:       +mtdSales.toFixed(2),
        priorYtd:       +priorYtd.toFixed(2),
        priorMtd:       +priorMtd.toFixed(2),
        priorMonth:     +priorMonth.toFixed(2),
        monthGoal:      monthGoalFinal,
        annualGoal,
        pctToMonthGoal,
        pctToAnnualGoal,
        monthRunRate,
        annualRunRate,
        target:         +target.toFixed(2),
        pctToTarget:    +pctToTarget.toFixed(4),
        daysSinceOrder: daysSince,
        lastOrderDate:  lastDate,
        tier,
        monthTier,
        healthSignals,
        typicalIntervalDays,
        pyFullYear,
        bsUnits:        +bs.bsUnits.toFixed(0),
        totalUnits:     +bs.totalUnits.toFixed(0),
        bsPct:          bs.totalUnits > 0 ? +(bs.bsUnits / bs.totalUnits).toFixed(4) : 0,
        pyBsUnits:      +(bs.pyBsUnits  || 0).toFixed(0),
        pyTotalUnits:   +(bs.pyTotalUnits || 0).toFixed(0),
        pyBsPct:        (bs.pyTotalUnits || 0) > 0 ? +((bs.pyBsUnits || 0) / bs.pyTotalUnits).toFixed(4) : 0,
      };
    });

    accounts.sort((a, b) => b.ytdSales - a.ytdSales);
    accountsCache[cacheKey] = { data: accounts, ts: Date.now() };

    // When ALL cache builds, derive each advisor's subset for free — no extra API calls
    if (!repPrefix) {
      const advisors = listUsers().filter(u => u.role === 'advisor' && u.rep_prefix && u.active);
      for (const u of advisors) {
        const prefix = u.rep_prefix.toUpperCase();
        const subset = accounts.filter(a => {
          const rep = (a.salesRep || '').trim().toUpperCase();
          return rep === prefix || rep.startsWith(prefix + '-');
        });
        accountsCache[u.rep_prefix] = { data: subset, ts: Date.now() };
      }
      console.log(`  advisor caches pre-populated for ${advisors.length} advisors`);
    }

    diskCache.save(accountsCache);  // persist all caches to disk
    routeTimer('GET /proxy/accounts', t0, { customers: filteredCustomers.length, cyTickets: cyTickets.length, pyTickets: pyTickets.length });
    return accounts;
}

// ── Fire-and-forget background refresh ───────────────────────
const refreshInflight = {};  // cacheKey → Promise (while building) or false
function triggerRefresh(repParam, repPrefix, cacheKey) {
  if (refreshInflight[cacheKey]) return refreshInflight[cacheKey];
  const p = buildAccountsData(repParam, repPrefix, cacheKey)
    .catch(e => console.error('[accounts] background refresh error:', e.message))
    .finally(() => { refreshInflight[cacheKey] = null; });
  refreshInflight[cacheKey] = p;
  return p;
}

// ── GET /proxy/accounts?rep=REPNAME ──────────────────────────
router.get('/accounts', enforceRepScope, async (req, res) => {
  const repParam  = (req.query.rep || SALES_REP || '').trim();
  // prefix-based: repParam is either 'ALL' or a rep prefix (e.g. 'MEGAN')
  const repPrefix = (repParam && repParam !== 'ALL') ? repParam.toUpperCase() : null;
  const cacheKey  = repParam || '__all__';

  const cached  = accountsCache[cacheKey];
  const isStale = !cached || Date.now() - cached.ts > CACHE_TTL;

  if (cached && cached.data.length > 0) {
    if (isStale) triggerRefresh(repParam, repPrefix, cacheKey);  // background
    return res.json(cached.data);  // serve immediately
  }

  // No cache yet — join the already-running warmup if possible, else start a new build
  try {
    await triggerRefresh(repParam, repPrefix, cacheKey);
    return res.json(accountsCache[cacheKey]?.data || []);
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
router.get('/leaderboard', requireRoles('advisor', 'manager', 'admin'), async (req, res) => {
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
    // Prior-prior month (3 months back, for Most Consistent)
    const ppmY = pmM === 0 ? pmY - 1 : pmY;
    const ppmM = pmM === 0 ? 11 : pmM - 1;
    const ppmStart = monthStart(ppmY, ppmM);
    const ppmEnd   = monthEnd(ppmY, ppmM);
    // Prior-year equivalents (for monthly goal = prior year same month × growth factor)
    const pyCmStart  = monthStart(yr - 1, mm);
    const pyCmEnd    = monthEnd(yr - 1, mm);
    const pyLmStart  = monthStart(lmY - 1, lmM);
    const pyLmEnd    = monthEnd(lmY - 1, lmM);
    const pyPpmStart = monthStart(ppmY - 1, ppmM);
    const pyPpmEnd   = monthEnd(ppmY - 1, ppmM);

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
    const [activeReps, allCustomers, cyTickets, pyTickets, cmTickets, lmTickets, pmTickets, ppmTickets, pyCmTickets, pyLmTickets, pyPpmTickets, usersRes] = await Promise.all([
      getActiveReps(),
      fetchAllPagesPar(`/api/v1/Customers?fields=custNo,salesRep,lastSaleDate&pageSize=200`),
      cyYtdGlobalCache[cyKey] && Date.now() - cyYtdGlobalCache[cyKey].ts < CACHE_TTL
        ? Promise.resolve(cyYtdGlobalCache[cyKey].data)
        : ticketFetch(ytdStart, ytdEnd).then(d => { cyYtdGlobalCache[cyKey] = { data: d, ts: Date.now() }; return d; }),
      pyYtdGlobalCache[pyKey] && Date.now() - pyYtdGlobalCache[pyKey].ts < CACHE_TTL
        ? Promise.resolve(pyYtdGlobalCache[pyKey].data)
        : ticketFetch(priorStart, priorEnd).then(d => { pyYtdGlobalCache[pyKey] = { data: d, ts: Date.now() }; return d; }),
      ticketFetch(cmStart,    cmEnd,    CACHE_TTL),   // current month — 5-min cache
      ticketFetch(lmStart,    lmEnd,    LB_HIST_TTL), // last completed month — 2-hr cache
      ticketFetch(pmStart,    pmEnd,    LB_HIST_TTL), // 2 months back — 2-hr cache
      ticketFetch(ppmStart,   ppmEnd,   LB_HIST_TTL), // 3 months back — 2-hr cache
      ticketFetch(pyCmStart,  pyCmEnd,  LB_HIST_TTL), // PY current month — 2-hr cache
      ticketFetch(pyLmStart,  pyLmEnd,  LB_HIST_TTL), // PY last month — 2-hr cache
      ticketFetch(pyPpmStart, pyPpmEnd, LB_HIST_TTL), // PY 3-months-back — 2-hr cache
      doFetch('GET', `/api/v1/System/users?filter=wrkgrpId:eq:KGS&fields=usrId,name&pageSize=500`),
    ]);

    // Build rep display name map
    const usersBody = usersRes.ok ? await usersRes.json() : {};
    const nameMap   = {};
    (usersBody.data || []).forEach(u => {
      nameMap[(u.usrId || '').trim().toUpperCase()] = (u.name || '').trim();
    });

    // Only advisor-role users compete on the leaderboard — managers/admins with rep_prefix are excluded
    const advisorUsers = listUsers().filter(u => u.role === 'advisor' && u.rep_prefix && u.active);
    const advisorPrefixes = new Set(advisorUsers.map(u => u.rep_prefix.toUpperCase()));
    // Build prefix → displayName from users.json (authoritative source for human-readable names)
    const prefixDisplayName = {};
    advisorUsers.forEach(u => { prefixDisplayName[u.rep_prefix.toUpperCase()] = u.displayName; });

    const repMap = {};
    activeReps.forEach(({ id }) => {
      const prefix = id.toUpperCase().replace(/-.*$/, ''); // strip suffix like -NEW, -ACT
      if (!advisorPrefixes.has(prefix) && !advisorPrefixes.has(id.toUpperCase())) return;
      // Prefer users.json displayName; fall back to NCR name if available, then raw ID
      const ncrRaw  = nameMap[id.toUpperCase()];
      const ncrName = ncrRaw ? ncrRaw.replace(/\s*[-–]\s*(ACTIVE|ACT)$/i, '').trim() : null;
      repMap[id] = prefixDisplayName[prefix] || ncrName || prefix;
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
    const ppmMap    = buildMap(ppmTickets);
    const pyCmMap   = buildMap(pyCmTickets);
    const pyLmMap   = buildMap(pyLmTickets);
    const pyPpmMap  = buildMap(pyPpmTickets);

    // 3. Walk customer list, join to all windows, group by rep
    const repData = {};
    Object.keys(repMap).forEach(id => {
      repData[id] = { ytd: 0, priorYtd: 0, cm: 0, lm: 0, pm: 0, ppm: 0, pyCm: 0, pyLm: 0, pyPpm: 0, accounts: [], minDaysSince: 999 };
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
      d.ppm    += ppmMap[k]   || 0;
      d.pyCm   += pyCmMap[k]  || 0;
      d.pyLm   += pyLmMap[k]  || 0;
      d.pyPpm  += pyPpmMap[k] || 0;
      const lastDate  = c.lastSaleDate ? c.lastSaleDate.slice(0, 10) : null;
      const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate)) / 86400000) : 999;
      if (daysSince < d.minDaysSince) d.minDaysSince = daysSince;
      const ytdSales  = ytdMap[k] || 0;
      const priorYtd  = pyYtdMap[k] || 0;
      d.accounts.push({ tier: computeTier(priorYtd > 0 ? ytdSales / priorYtd : 0, daysSince, ytdSales, priorYtd) });
    }

    // 4a. Business-day context for current month (used by pace score)
    const bdCtx = monthBusinessDayContext(now);
    // bdCtx: { elapsed, total, pctElapsed }

    // 4. Compute per-rep stats including monthly goal (prior year × growth factor)
    const lbYYYYMM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const G = 1 + getMonthlyGrowthPct(lbYYYYMM);
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

      // Pace score: percentage points ahead of / behind monthly pace
      const paceScore  = computePaceScore(d.cm, cmGoal, bdCtx.elapsed, bdCtx.total);
      const pctToGoal  = cmGoal > 0 ? +((d.cm / cmGoal) * 100).toFixed(2) : null;
      const lmPctToGoal  = lmGoal > 0 ? +((d.lm  / lmGoal)  * 100).toFixed(2) : null;
      const ppmGoal      = d.pyPpm > 0 ? +(d.pyPpm * G).toFixed(2) : null;
      const pmPctToGoal  = lmGoal  > 0 ? +((d.pm  / lmGoal)  * 100).toFixed(2) : null; // use lmGoal as denominator (same month type)
      const ppmPctToGoal = ppmGoal > 0 ? +((d.ppm / ppmGoal) * 100).toFixed(2) : null;

      // Most Improved: percentage-point gain vs prior month (same goal denominator)
      const improvementPts = (lmGoal > 0 && d.lm > 0 && d.pm > 0)
        ? +((d.lm - d.pm) / lmGoal * 100).toFixed(1) : null;

      // Most Consistent: sum of negative month-over-month pct-point changes over last 3 months
      // Lower (less negative) = more consistent. Requires at least 2 of 3 months to have data.
      const changes = [];
      if (lmPctToGoal !== null && pmPctToGoal !== null) changes.push(lmPctToGoal - pmPctToGoal);
      if (pmPctToGoal !== null && ppmPctToGoal !== null) changes.push(pmPctToGoal - ppmPctToGoal);
      const totalNegative = changes.length >= 1
        ? +changes.reduce((s, c) => s + Math.min(0, c), 0).toFixed(2)
        : null;

      // Award eligibility: goal must be set AND ≥ $5,000
      const AWARD_FLOOR = 5000;
      const awardEligible = cmGoal !== null && cmGoal >= AWARD_FLOOR;

      const daysIdle = d.minDaysSince < 999 ? d.minDaysSince : null;

      return {
        repId, repName,
        healthyCount:  tiers.Healthy,
        pctToGoal,
        lmPctToGoal,
        improvementPts,
        totalNegative,
        paceScore:     paceScore !== null ? +paceScore.toFixed(2) : null,
        awardEligible,
        daysIdle,
        // keep accountCount only for internal sorting — stripped from final payload below
        _accountCount: accounts.length,
        _cmGoal:       cmGoal,
        _lmGoal:       lmGoal,
      };
    });

    const eligibleReps = repStats.filter(r => r._accountCount > 0);

    // 5. Compute awards
    // SOTM: ranked by paceScore among award-eligible reps (goal set AND ≥ $5,000)
    const sotmCandidates = eligibleReps.filter(r => r.awardEligible && r.paceScore !== null);
    sotmCandidates.sort((a, b) => b.paceScore - a.paceScore);
    const sotmWinner = sotmCandidates[0] || null;
    const allUnderGoal = sotmWinner !== null && sotmWinner.paceScore < 0;

    // Most Improved: highest pct-point gain lm vs pm
    const miCandidates = eligibleReps.filter(r => r.improvementPts !== null);
    miCandidates.sort((a, b) => b.improvementPts - a.improvementPts);
    const miWinner = miCandidates[0] || null;

    // Most Consistent: least total negative month-over-month pct change over last 3 months
    const mcCandidates = eligibleReps.filter(r => r.totalNegative !== null);
    mcCandidates.sort((a, b) => b.totalNegative - a.totalNegative); // closest to 0 = most consistent
    const mcWinner = mcCandidates[0] || null;

    // 6. Current-month podium — award-eligible reps only, ranked by paceScore
    const podiumReps = eligibleReps
      .filter(r => r.awardEligible && r.paceScore !== null)
      .sort((a, b) => b.paceScore - a.paceScore)
      .slice(0, 3)
      .map(({ repId, repName, pctToGoal, paceScore }) => ({ repId, repName, pctToGoal, paceScore }));

    // 7. Full standings — strip all private fields before sending
    const AWARD_FLOOR = 5000;
    const standings = [
      ...eligibleReps
        .filter(r => r.awardEligible && r.paceScore !== null)
        .sort((a, b) => b.paceScore - a.paceScore),
      ...eligibleReps
        .filter(r => !r.awardEligible && r._cmGoal !== null && r._cmGoal > 0 && r.paceScore !== null)
        .sort((a, b) => b.paceScore - a.paceScore),
      ...eligibleReps
        .filter(r => r._cmGoal === null || r._cmGoal <= 0)
        .sort((a, b) => (b.pctToGoal || 0) - (a.pctToGoal || 0)),
    ].map((r, i) => ({
      standingsRank:  i + 1,
      repId:          r.repId,
      repName:        r.repName,
      pctToGoal:      r.pctToGoal,
      paceScore:      r.paceScore,
      daysIdle:       r.daysIdle,
      accountCount:   r._accountCount,
      healthyCount:   r.healthyCount,
      pctHealthy:     r._accountCount > 0 ? Math.round(r.healthyCount / r._accountCount * 100) : null,
    }));

    const payload = {
      updatedAt:         now.toISOString(),
      currentMonthLabel: `${MONTHS[mm]} ${yr}`,
      lastMonthLabel:    `${MONTHS[lmM]} ${lmY}`,
      businessDays: {
        elapsed:    bdCtx.elapsed,
        total:      bdCtx.total,
        pctElapsed: +bdCtx.pctElapsed.toFixed(2),
      },
      awards: {
        sotm: sotmWinner ? {
          repId:       sotmWinner.repId,
          repName:     sotmWinner.repName,
          pctToGoal:   sotmWinner.pctToGoal,
          allUnderGoal,
          inProgress:  true,
        } : null,
        mostImproved: miWinner ? {
          repId:          miWinner.repId,
          repName:        miWinner.repName,
          improvementPts: miWinner.improvementPts,
        } : null,
        mostConsistent: mcWinner ? {
          repId:         mcWinner.repId,
          repName:       mcWinner.repName,
          totalNegative: mcWinner.totalNegative,
        } : null,
      },
      podium:   podiumReps,
      standings,
      repCount: eligibleReps.length,
    };

    leaderboardCache.data = payload;
    leaderboardCache.ts   = Date.now();
    res.json(payload);
  } catch (e) {
    console.error('/proxy/leaderboard error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/rep-scorecard — manager/admin team overview ───────
const repScorecardCache = { data: null, ts: 0 };
const REP_SCORECARD_TTL = 5 * 60 * 1000;

router.get('/rep-scorecard', requireRoles('manager', 'admin'), (req, res) => {
  try {
    // Serve from cache if fresh
    if (repScorecardCache.data && Date.now() - repScorecardCache.ts < REP_SCORECARD_TTL) {
      return res.json(repScorecardCache.data);
    }

    const now      = new Date();
    const bdCtx    = monthBusinessDayContext(now);
    const advisors = listUsers().filter(u => u.role === 'advisor' && u.rep_prefix && u.active);
    const allAccts = accountsCache['ALL']?.data || [];

    const advisorRows = advisors.map(u => {
      const prefix = u.rep_prefix.toUpperCase();
      const accts  = allAccts.filter(a => {
        const rep = (a.salesRep || '').trim().toUpperCase();
        return rep === prefix || rep.startsWith(prefix + '-');
      });

      const ytd          = accts.reduce((s, a) => s + (a.ytdSales   || 0), 0);
      const mtd          = accts.reduce((s, a) => s + (a.mtdSales   || 0), 0);
      const annual_goal  = accts.reduce((s, a) => s + (a.annualGoal || 0), 0);
      const monthly_goal = accts.reduce((s, a) => s + (a.monthGoal  || 0), 0);

      const pct_to_goal    = annual_goal  > 0 ? +(ytd / annual_goal  * 100).toFixed(2) : null;
      const pct_to_monthly = monthly_goal > 0 ? +(mtd / monthly_goal * 100).toFixed(2) : null;

      const healthy_count  = accts.filter(a => a.tier === 'Healthy').length;
      const atrisk_count   = accts.filter(a => a.tier === 'AtRisk').length;
      const critical_count = accts.filter(a => a.tier === 'Critical').length;

      // Most-recently-ordered = min daysSinceOrder
      const days_idle = accts.length > 0
        ? Math.min(...accts.map(a => a.daysSinceOrder ?? 999))
        : null;

      // Pace score from leaderboard cache if available, else compute
      let pace_score = null;
      if (leaderboardCache.data) {
        const lbRep = leaderboardCache.data.standings?.find(r => {
          const lbPrefix = (r.repId || '').toUpperCase().replace(/-.*$/, '');
          return lbPrefix === prefix || r.repId.toUpperCase() === prefix;
        });
        if (lbRep) pace_score = lbRep.paceScore;
      }
      if (pace_score === null && monthly_goal > 0 && bdCtx.total > 0) {
        pace_score = +computePaceScore(mtd, monthly_goal, bdCtx.elapsed, bdCtx.total).toFixed(2);
      }

      return {
        username:        u.username,
        displayName:     u.displayName,
        rep_prefix:      u.rep_prefix,
        accounts:        accts.length,
        ytd:             +ytd.toFixed(2),
        annual_goal:     +annual_goal.toFixed(2),
        pct_to_goal,
        mtd:             +mtd.toFixed(2),
        monthly_goal:    +monthly_goal.toFixed(2),
        pct_to_monthly,
        pace_score,
        healthy_count,
        atrisk_count,
        critical_count,
        days_idle,
      };
    });

    const ytd_sum         = +advisorRows.reduce((s, r) => s + r.ytd, 0).toFixed(2);
    const monthly_goal_sum = +advisorRows.reduce((s, r) => s + r.monthly_goal, 0).toFixed(2);
    const mtd_sum         = +advisorRows.reduce((s, r) => s + r.mtd, 0).toFixed(2);
    const on_pace_count   = advisorRows.filter(r => r.pace_score !== null && r.pace_score >= 0).length;
    const critical_accts  = advisorRows.reduce((s, r) => s + r.critical_count, 0);

    const payload = {
      team: {
        ytd_sum,
        monthly_goal_sum,
        mtd_sum,
        on_pace_count,
        critical_accts,
        advisor_count: advisorRows.length,
        business_days_elapsed: bdCtx.elapsed,
        business_days_total:   bdCtx.total,
        pct_elapsed:           +bdCtx.pctElapsed.toFixed(2),
      },
      advisors: advisorRows,
    };

    repScorecardCache.data = payload;
    repScorecardCache.ts   = Date.now();
    res.json(payload);
  } catch (e) {
    console.error('/proxy/rep-scorecard error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function warmCache() {
  triggerRefresh('ALL', null, 'ALL');  // stores promise in refreshInflight['ALL']
}
module.exports = router;
module.exports.warmCache = warmCache;

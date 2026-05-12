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
const { doFetch, fetchAllPages, ytdDateRange, aggregateLineItems, routeTimer, SALES_REP } = require('../lib/api');
const categoryCache = require('../lib/category-cache');

// ── In-memory cache keyed by rep (5-minute TTL) ───────────────
const accountsCache = {};  // { [rep]: { data, ts } }
const CACHE_TTL     = 5 * 60 * 1000;

// ── Leaderboard cache (15-minute TTL) ────────────────────────
const leaderboardCache = { data: null, ts: 0 };
const LEADERBOARD_TTL  = 15 * 60 * 1000;

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

// ── GET /proxy/reps — list of unique sales reps ───────────────
// List Kellis sales reps.
// Each rep has 4 user records: REPID, REPID-ACT, REPID-INA, REPID-NEW.
// Customer.salesRep stores the usrId directly (e.g. "BRIANH-ACT").
// We show only the -ACT variants so the picker maps 1:1 to active customer accounts.
router.get('/reps', async (req, res) => {
  try {
    // Fetch all KGS workgroup users — no secCod filter so CS staff are included
    const r    = await doFetch('GET', `/api/v1/System/users?filter=wrkgrpId:eq:KGS&fields=usrId,name&pageSize=500`);
    const body = r.ok ? await r.json() : {};
    const rows = body.data || (Array.isArray(body) ? body : []);
    const reps = rows
      .filter(u => {
        const id = (u.usrId || '').toUpperCase();
        return id.endsWith('-ACT') || id.endsWith('-ACTIVE');
      })
      .map(u => ({
        id:   (u.usrId || '').trim(),
        name: (u.name  || u.usrId || '').trim()
                .replace(/\s*[-–]\s*(ACTIVE|ACT)$/i, '').trim(),
      }))
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

    const t1 = Date.now();
    const [customers, cyTickets, pyTickets] = await Promise.all([
      fetchAllPages(
        `/api/v1/Customers?${repFilter}fields=custNo,name,state,salesRep,lastSaleDate&pageSize=200`
      ),
      // All CY YTD tickets for this rep — aggregate by custNo
      fetchAllPages(
        `/api/v1/pos/ticket-history?filter=${repTicketFilter}BusinessDate:gte:${ytdStart},BusinessDate:lte:${today}&fields=CustNo,Total&pageSize=500`
      ),
      // All PY same-period tickets for this rep — aggregate by custNo
      fetchAllPages(
        `/api/v1/pos/ticket-history?filter=${repTicketFilter}BusinessDate:gte:${pyStart},BusinessDate:lte:${pyEnd}&fields=CustNo,Total&pageSize=500`
      ),
    ]);
    console.log(`  customers+tickets: ${customers.length} customers, ${cyTickets.length} CY / ${pyTickets.length} PY tickets in ${((Date.now()-t1)/1000).toFixed(2)}s`);

    if (!customers.length) {
      accountsCache[cacheKey] = { data: [], ts: Date.now() };
      return res.json([]);
    }

    // 2. Aggregate ticket totals by custNo
    const salesMap = {};
    for (const t of cyTickets) {
      const c = (t.CustNo || t.custNo || '').trim();
      if (c) salesMap[c] = salesMap[c] || { ytd: 0, prior: 0 };
      if (c) salesMap[c].ytd += parseFloat(t.Total || t.total || 0);
    }
    for (const t of pyTickets) {
      const c = (t.CustNo || t.custNo || '').trim();
      if (c) salesMap[c] = salesMap[c] || { ytd: 0, prior: 0 };
      if (c) salesMap[c].prior += parseFloat(t.Total || t.total || 0);
    }

    // 3. Build account records
    const accounts = customers.map(c => {
      const s        = salesMap[c.custNo] || { ytd: 0, prior: 0 };
      const ytdSales = s.ytd;
      const priorYtd = s.prior;
      const target   = priorYtd;

      const pctToTarget = target > 0 ? ytdSales / target : (ytdSales > 0 ? 1 : 0);

      const lastDate  = c.lastSaleDate ? c.lastSaleDate.slice(0, 10) : null;
      const daysSince = lastDate
        ? Math.floor((Date.now() - new Date(lastDate)) / 86400000)
        : 999;

      const tier = computeTier(pctToTarget, daysSince, ytdSales, priorYtd);

      return {
        custNo:         c.custNo,
        name:           c.name || '',
        state:          c.state || '',
        salesRep:       c.salesRep || '',
        ytdSales:       +ytdSales.toFixed(2),
        priorYtd:       +priorYtd.toFixed(2),
        target:         +target.toFixed(2),
        pctToTarget:    +pctToTarget.toFixed(4),
        daysSinceOrder: daysSince,
        lastOrderDate:  lastDate,
        tier,
      };
    });

    accounts.sort((a, b) => b.ytdSales - a.ytdSales);
    accountsCache[cacheKey] = { data: accounts, ts: Date.now() };
    routeTimer('GET /proxy/accounts', t0, { customers: customers.length, cyTickets: cyTickets.length, pyTickets: pyTickets.length });
    res.json(accounts);
  } catch (e) {
    console.error('/proxy/accounts error:', e.message);
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
    const r    = await doFetch('GET', `/api/v1/Customers/${encodeURIComponent(req.params.custNo)}?includeCustomFields=true&compact=true`);
    const body = await r.json();
    const d    = body.data || body;
    // Surface discount custom field at a predictable key
    if (d && d.USER_BEST_PRICE_COD_CUST !== undefined) {
      d.best_price_code = d.USER_BEST_PRICE_COD_CUST || null;
    }
    res.status(r.status).json(d);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/orders/:custNo — 2-year order history ─────────
router.get('/orders/:custNo', async (req, res) => {
  try {
    const custNo = encodeURIComponent(req.params.custNo);
    const since  = (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 2);
      return d.toISOString().slice(0, 10);
    })();
    const today = new Date().toISOString().slice(0, 10);
    const raw = await fetchAllPages(
      `/api/v1/pos/ticket-history?filter=custNo:eq:${custNo},businessDate:gte:${since},businessDate:lte:${today}&fields=TicketNo,Total,SaleLines,BusinessDate&pageSize=200`
    );
    const orders = raw.map(o => ({
      date:      o.BusinessDate || o.businessDate || '',
      ticketNo:  o.TicketNo    || o.ticketNo     || '',
      amount:    parseFloat(o.Total || o.total   || 0),
      itemCount: o.SaleLines   || o.saleLines    || null,
    }));
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

// ── GET /proxy/mtd/:custNo — month-to-date sales ──────────────
router.get('/mtd/:custNo', async (req, res) => {
  try {
    const custNo = encodeURIComponent(req.params.custNo);
    const now    = new Date();
    const mtdStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const mtdEnd   = now.toISOString().slice(0, 10);

    const tickets = await fetchAllPages(
      `/api/v1/pos/ticket-history?filter=custNo:eq:${custNo},businessDate:gte:${mtdStart},businessDate:lte:${mtdEnd}&fields=custNo,total,businessDate&pageSize=200`
    );

    const mtdTotal  = tickets.reduce((s, t) => s + (parseFloat(t.Total || t.total) || 0), 0);
    const orderDays = new Set(tickets.map(t => (t.businessDate || '').slice(0, 10))).size;

    res.json({ total: +mtdTotal.toFixed(2), orderDays, orders: tickets.length });
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
    // 1. Fetch all customers + all active reps in parallel — two calls total
    const [repsResp, allCustomers] = await Promise.all([
      doFetch('GET', `/api/v1/System/users?filter=wrkgrpId:eq:KGS,secCod:eq:SALES&fields=usrId,name&pageSize=500`),
      fetchAllPages(`/api/v1/Customers?fields=custNo,salesRep,lastSaleDate&pageSize=200`),
    ]);

    const repsBody = repsResp.ok ? await repsResp.json() : {};
    const repMap   = {};
    (repsBody.data || [])
      .filter(u => { const id = (u.usrId || '').toUpperCase(); return id.endsWith('-ACT') || id.endsWith('-ACTIVE'); })
      .forEach(u => {
        repMap[u.usrId.trim()] = (u.name || u.usrId).trim().replace(/\s*[-–]\s*(ACTIVE|ACT)$/i, '').trim();
      });

    // 2. For customers whose rep already has a warm accountsCache, use it directly.
    //    Collect only the customers we actually need to fetch.
    const repAccounts = {}; // repId → [{ ytdSales, priorYtd, tier }]
    Object.keys(repMap).forEach(id => { repAccounts[id] = []; });

    const toFetch = []; // customers needing a live sales-by-category call

    for (const c of allCustomers) {
      const repId = (c.salesRep || '').trim();
      if (!repMap[repId]) continue; // not an active rep we care about

      const cached = accountsCache[repId];
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        // Already have full account objects for this rep — no individual fetch needed
        continue;
      }
      toFetch.push(c);
    }

    // 3. Fire all outstanding sales-by-category calls at full parallelism (capped at 20)
    const fetchResults = await parallelLimit(toFetch.map(c => async () => {
      try {
        const r    = await doFetch('GET', `/api/v1/Customers/${encodeURIComponent(c.custNo)}/sales-by-category`);
        const body = r.ok ? await r.json() : [];
        const rows = Array.isArray(body) ? body : (body.data || []);
        const ytd   = rows.reduce((s, r) => s + (parseFloat(r.currentYtdAmount) || 0), 0);
        const prior = rows.reduce((s, r) => s + (parseFloat(r.priorYtdAmount)   || 0), 0);
        const lastDate  = c.lastSaleDate ? c.lastSaleDate.slice(0, 10) : null;
        const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate)) / 86400000) : 999;
        return { repId: (c.salesRep || '').trim(), ytdSales: ytd, priorYtd: prior,
                 tier: computeTier(prior > 0 ? ytd / prior : 0, daysSince, ytd, prior) };
      } catch (_) {
        return { repId: (c.salesRep || '').trim(), ytdSales: 0, priorYtd: 0, tier: 'AtRisk' };
      }
    }), 20);

    // Merge live fetch results
    for (const row of fetchResults) {
      if (repAccounts[row.repId]) repAccounts[row.repId].push(row);
    }

    // Merge cached rep accounts
    for (const repId of Object.keys(repMap)) {
      const cached = accountsCache[repId];
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        repAccounts[repId] = cached.data;
      }
    }

    // 4. Aggregate per rep
    const now     = new Date();
    const quarter = Math.ceil((now.getMonth() + 1) / 3);

    const repStats = Object.entries(repMap).map(([repId, repName]) => {
      const accounts = repAccounts[repId] || [];
      const ytd   = accounts.reduce((s, a) => s + (a.ytdSales || 0), 0);
      const prior = accounts.reduce((s, a) => s + (a.priorYtd || 0), 0);
      const tiers = { Healthy: 0, Attention: 0, AtRisk: 0, Critical: 0 };
      accounts.forEach(a => { if (tiers[a.tier] !== undefined) tiers[a.tier]++; });
      const healthScore = accounts.length > 0
        ? Math.round((tiers.Healthy * 100 + tiers.Attention * 60 + tiers.AtRisk * 25) / accounts.length)
        : 0;
      return {
        repId, repName,
        ytdSales:     +ytd.toFixed(2),
        priorYtd:     +prior.toFixed(2),
        pctToTarget:  prior > 0 ? +(ytd / prior).toFixed(4) : 0,
        pctChange:    prior > 0 ? +((ytd - prior) / prior).toFixed(4) : null,
        accountCount: accounts.length,
        healthScore,
        ...tiers,
      };
    });

    const ranked = repStats
      .filter(r => r.accountCount > 0)
      .sort((a, b) => b.ytdSales - a.ytdSales)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    leaderboardCache.data = { reps: ranked, quarter, year: now.getFullYear(), updatedAt: now.toISOString() };
    leaderboardCache.ts   = Date.now();
    res.json(leaderboardCache.data);
  } catch (e) {
    console.error('/proxy/leaderboard error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

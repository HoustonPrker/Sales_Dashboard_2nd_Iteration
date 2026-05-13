// ============================================================
// Rep Overview route
// GET /proxy/rep-overview?rep=REPID
//
// Returns KPI data for the Account Performance header strip:
//   yearRunRate, businessDaysElapsed, businessDaysTotal,
//   monthly (goal, mtd, pctToGoal, remainingBusinessDays,
//            dailySalesNeeded, activeAccounts, totalAccounts),
//   avg (ticketCurrent, ticketPrior, linesCurrent, linesPrior),
//   bestSeller (pct, lines, total)
// ============================================================

const express = require('express');
const router  = express.Router();
const { doFetch, fetchAllPages, fetchAllPagesPar, routeTimer, SALES_REP, MONTHLY_GROWTH_GOAL_PCT, pyMonthGlobalCache } = require('../lib/api');
const { countBusinessDays, computeYearRunRate } = require('../utils/business-days');

// 5-minute cache keyed by rep
const overviewCache = {};
const CACHE_TTL = 5 * 60 * 1000;


// ── GET /proxy/rep-overview?rep= ─────────────────────────────
router.get('/rep-overview', async (req, res) => {
  try {
    const rep = (req.query.rep || SALES_REP || '').trim();
    if (!rep) return res.status(400).json({ error: 'rep param required' });

    if (overviewCache[rep] && Date.now() - overviewCache[rep].ts < CACHE_TTL) {
      console.log(`⏱  GET /proxy/rep-overview → cache hit (${rep})`);
      return res.json(overviewCache[rep].data);
    }

    const t0    = Date.now();
    const now   = new Date();
    const yr    = now.getFullYear();
    const mm    = String(now.getMonth() + 1).padStart(2, '0');
    const dd    = String(now.getDate()).padStart(2, '0');
    const today = `${yr}-${mm}-${dd}`;

    // MTD window
    const mtdStart = `${yr}-${mm}-01`;

    // Prior year same month — full month, fixed target (last day via Date arithmetic)
    const pyMonthStart = `${yr - 1}-${mm}-01`;
    const pyMonthEnd   = new Date(yr - 1, parseInt(mm, 10), 0).toISOString().slice(0, 10);

    // Current year YTD for avg ticket/lines (Jan 1 – today)
    const ytdStart = `${yr}-01-01`;

    // Prior year YTD same period for avg ticket/lines comparison
    const pyYtdStart = `${yr - 1}-01-01`;
    const pyYtdEnd   = `${yr - 1}-${mm}-${dd}`;

    const repEnc   = encodeURIComponent(rep);
    const pyMonthCacheKey = `${yr - 1}-${mm}`;

    // pyMonthTickets: use shared global cache (no SalesRep filter — same logic as /proxy/accounts).
    // Scope to this rep's current accounts via custNo join below.
    const pyMonthAllPromise = (pyMonthGlobalCache[pyMonthCacheKey] && Date.now() - pyMonthGlobalCache[pyMonthCacheKey].ts < CACHE_TTL)
      ? Promise.resolve(pyMonthGlobalCache[pyMonthCacheKey].data)
      : fetchAllPagesPar(
          `/api/v1/pos/ticket-history?filter=BusinessDate:gte:${pyMonthStart},BusinessDate:lte:${pyMonthEnd}&fields=CustNo,Total&pageSize=500`
        ).then(data => { pyMonthGlobalCache[pyMonthCacheKey] = { data, ts: Date.now() }; return data; });

    // Phase 1 — fire all independent fetches in parallel
    const repFilter = `filter=salesRep:eq:${repEnc}&`;
    const [cyDays, repCustomers, pyYtdDays, mtdTickets, pyMonthAllTickets] = await Promise.all([
      // CY YTD daily rows (for avg ticket/lines)
      fetchAllPages(
        `/api/v1/sales-analysis/by-sales-rep?filter=salesRep:eq:${repEnc},postDate:gte:${ytdStart},postDate:lte:${today}&fields=postDate,ticketCount,saleSubTotal,saleLines&pageSize=200`
      ),
      // Current customer list — needed to scope pyMonth tickets to this rep's accounts
      fetchAllPages(`/api/v1/Customers?${repFilter}fields=custNo&pageSize=200`),
      // PY YTD daily rows (for avg ticket/lines prior year)
      fetchAllPages(
        `/api/v1/sales-analysis/by-sales-rep?filter=salesRep:eq:${repEnc},postDate:gte:${pyYtdStart},postDate:lte:${pyYtdEnd}&fields=postDate,ticketCount,saleSubTotal,saleLines&pageSize=200`
      ),
      // MTD ticket headers — source of MTD total, active accounts, avg lines, % invoiced
      fetchAllPages(
        `/api/v1/pos/ticket-history?filter=SalesRep:eq:${repEnc},BusinessDate:gte:${mtdStart},BusinessDate:lte:${today}&fields=TicketNo,Total,SaleLines,CustNo,CustPoNo,BusinessDate&pageSize=200`
      ),
      pyMonthAllPromise,
    ]);

    // ── Year run rate ─────────────────────────────────────────
    const { elapsed, total: bdTotal, rate: yearRunRate } = computeYearRunRate(now);

    // ── Monthly goal — filter global pyMonth tickets to this rep's current accounts ─
    const repCustSet = new Set(repCustomers.map(c => (c.custNo || '').trim()).filter(Boolean));
    const pyMonthRaw = pyMonthAllTickets
      .filter(t => repCustSet.has((t.CustNo || t.custNo || '').trim()))
      .reduce((s, t) => s + (parseFloat(t.Total || t.total) || 0), 0);
    const monthGoal  = +(pyMonthRaw * (1 + MONTHLY_GROWTH_GOAL_PCT)).toFixed(2);

    // ── MTD total — sum ticket-history Total (matches sales console) ─────
    const mtdTotal  = mtdTickets.reduce((s, t) => s + (parseFloat(t.Total || t.total) || 0), 0);
    const pctToGoal = monthGoal > 0 ? +(mtdTotal / monthGoal).toFixed(4) : 0;

    // Remaining business days in month — includes today (rep can still sell today)
    const monthEnd    = new Date(yr, now.getMonth() + 1, 0); // last day of this month
    const remainingBD = countBusinessDays(now, monthEnd);

    const gap = monthGoal - mtdTotal;
    const dailySalesNeeded = remainingBD > 0 && gap > 0 ? +(gap / remainingBD).toFixed(2) : 0;

    // ── Active accounts this month (CustNo, not CustPoNo) ─────────────────
    const activeCustNos  = new Set(mtdTickets.map(t => (t.CustNo || t.custNo || '').trim()).filter(Boolean));
    const activeAccounts = activeCustNos.size;

    // ── % Invoiced — tickets that carry a customer PO number ─────────────
    // A ticket with CustPoNo means the customer issued a PO; sale is invoiced/shipped.
    const invoicedSales = mtdTickets
      .filter(t => (t.CustPoNo || t.custPoNo || '').trim())
      .reduce((s, t) => s + (parseFloat(t.Total || t.total) || 0), 0);
    const pctInvoiced = mtdTotal > 0 ? +(invoicedSales / mtdTotal).toFixed(4) : 0;

    // We don't have totalAccounts in this route — front-end can use accountsData.length
    // Expose -1 as a sentinel meaning "use client-side total"
    const totalAccounts = -1;

    // ── Average ticket & lines — CY YTD (from daily rows) ───────────────
    // ticketCount and saleLines from sales-analysis are used for YTD averages.
    // MTD total comes from ticket-history (more accurate); YTD avg uses daily rows
    // since we don't fetch all YTD ticket headers (too many rows).
    const cyTicketCount = cyDays.reduce((s, r) => s + (parseInt(r.ticketCount) || 0), 0);
    const cySales       = cyDays.reduce((s, r) => s + (parseFloat(r.saleSubTotal) || 0), 0);
    const cyLineCount   = cyDays.reduce((s, r) => s + (parseInt(r.saleLines) || 0), 0);
    const ticketCurrent = cyTicketCount > 0 ? +(cySales     / cyTicketCount).toFixed(2) : 0;
    const linesCurrent  = cyTicketCount > 0 ? +(cyLineCount / cyTicketCount).toFixed(2) : 0;

    // ── Average ticket & lines — PY YTD ──────────────────────
    const pyTicketCount = pyYtdDays.reduce((s, r) => s + (parseInt(r.ticketCount) || 0), 0);
    const pySales       = pyYtdDays.reduce((s, r) => s + (parseFloat(r.saleSubTotal) || 0), 0);
    const pyLineCount   = pyYtdDays.reduce((s, r) => s + (parseInt(r.saleLines) || 0), 0);
    const ticketPrior   = pyTicketCount > 0 ? +(pySales     / pyTicketCount).toFixed(2) : 0;
    const linesPrior    = pyTicketCount > 0 ? +(pyLineCount / pyTicketCount).toFixed(2) : 0;

    const mtdCustNos = [...new Set(
      mtdTickets.map(t => (t.CustPoNo || t.custPoNo || '').trim()).filter(Boolean)
    )];

    const result = {
      yearRunRate,
      businessDaysElapsed: elapsed,
      businessDaysTotal: bdTotal,
      monthly: {
        goal:                  +monthGoal.toFixed(2),
        mtd:                   +mtdTotal.toFixed(2),
        pctToGoal,
        remainingBusinessDays: remainingBD,
        dailySalesNeeded,
        activeAccounts,
        totalAccounts,
      },
      avg: {
        ticketCurrent,
        ticketPrior,
        linesCurrent,
        linesPrior,
      },
      pctInvoiced,
      bestSeller: { pct: 0, lines: 0, total: 0 },
    };

    overviewCache[rep] = { data: result, ts: Date.now() };
    routeTimer(`GET /proxy/rep-overview`, t0, { rep, pyMonthTickets: pyMonthAllTickets.length, monthGoal: monthGoal.toFixed(2), mtdCusts: mtdCustNos.length });
    res.json(result);
  } catch (e) {
    console.error('/proxy/rep-overview error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/rep-overview/invoiced-diagnostic?rep= ─────────
// Shows the first 20 MTD tickets with CustPoNo, TermsCode, and Type fields
// so we can identify which field correctly distinguishes "on PO" sales.
router.get('/rep-overview/invoiced-diagnostic', async (req, res) => {
  try {
    const rep = (req.query.rep || SALES_REP || '').trim();
    if (!rep) return res.status(400).json({ error: 'rep param required' });
    const now   = new Date();
    const yr    = now.getFullYear();
    const mm    = String(now.getMonth() + 1).padStart(2, '0');
    const dd    = String(now.getDate()).padStart(2, '0');
    const today = `${yr}-${mm}-${dd}`;
    const mtdStart = `${yr}-${mm}-01`;
    const repEnc = encodeURIComponent(rep);
    const tickets = await fetchAllPages(
      `/api/v1/pos/ticket-history?filter=SalesRep:eq:${repEnc},BusinessDate:gte:${mtdStart},BusinessDate:lte:${today}&fields=TicketNo,Total,CustNo,CustPoNo,TermsCode,Type,BusinessDate&pageSize=200`
    );
    const sample = tickets.slice(0, 40).map(t => ({
      ticketNo:  t.TicketNo  || t.ticketNo,
      date:      t.BusinessDate || t.businessDate,
      custNo:    t.CustNo    || t.custNo,
      total:     t.Total     || t.total,
      custPoNo:  t.CustPoNo  || t.custPoNo  || null,
      termsCode: t.TermsCode || t.termsCode || null,
      type:      t.Type      || t.type      || null,
    }));
    const uniqueTerms = [...new Set(tickets.map(t => t.TermsCode || t.termsCode || '(empty)'))];
    const uniqueTypes = [...new Set(tickets.map(t => t.Type || t.type || '(empty)'))];
    const pctWithPoNo = tickets.length > 0
      ? (tickets.filter(t => (t.CustPoNo || t.custPoNo || '').trim()).length / tickets.length * 100).toFixed(1)
      : 0;
    res.json({ totalTickets: tickets.length, pctWithPoNo: pctWithPoNo + '%', uniqueTermsCodes: uniqueTerms, uniqueTypes, sample });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

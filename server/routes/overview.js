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
const { doFetch, fetchAllPages, routeTimer, SALES_REP, MONTHLY_GROWTH_GOAL_PCT } = require('../lib/api');

// 5-minute cache keyed by rep
const overviewCache = {};
const CACHE_TTL = 5 * 60 * 1000;

// ── US Federal Holiday helpers ────────────────────────────────
// Returns true if the given Date falls on a US federal holiday.
function isUSFederalHoliday(date) {
  const yr = date.getFullYear();
  const mm = date.getMonth() + 1; // 1-based
  const dd = date.getDate();
  const dow = date.getDay(); // 0=Sun

  // Helper: nth weekday of month (n=1..5, dow=0..6)
  function nthWeekday(year, month, nth, weekday) {
    const first = new Date(year, month - 1, 1).getDay();
    let offset = weekday - first;
    if (offset < 0) offset += 7;
    return 1 + offset + (nth - 1) * 7;
  }
  // Helper: last weekday of month
  function lastWeekday(year, month, weekday) {
    const last = new Date(year, month, 0); // last day of month
    let d = last.getDate();
    const dw = last.getDay();
    let diff = dw - weekday;
    if (diff < 0) diff += 7;
    return d - diff;
  }

  // Fixed-date holidays (observed Mon if Sun, Fri if Sat)
  function fixedObserved(m, d) {
    const raw = new Date(yr, m - 1, d).getDay();
    let od = d;
    if (raw === 0) od = d + 1; // Sun → Mon
    if (raw === 6) od = d - 1; // Sat → Fri
    return mm === m && dd === od;
  }

  // New Year's Day
  if (fixedObserved(1, 1)) return true;
  // Juneteenth
  if (fixedObserved(6, 19)) return true;
  // Independence Day
  if (fixedObserved(7, 4)) return true;
  // Veterans Day
  if (fixedObserved(11, 11)) return true;
  // Christmas Day
  if (fixedObserved(12, 25)) return true;

  // Martin Luther King Jr. Day — 3rd Monday of January
  if (mm === 1 && dow === 1 && dd === nthWeekday(yr, 1, 3, 1)) return true;
  // Presidents' Day — 3rd Monday of February
  if (mm === 2 && dow === 1 && dd === nthWeekday(yr, 2, 3, 1)) return true;
  // Memorial Day — last Monday of May
  if (mm === 5 && dow === 1 && dd === lastWeekday(yr, 5, 1)) return true;
  // Labor Day — 1st Monday of September
  if (mm === 9 && dow === 1 && dd === nthWeekday(yr, 9, 1, 1)) return true;
  // Columbus Day — 2nd Monday of October
  if (mm === 10 && dow === 1 && dd === nthWeekday(yr, 10, 2, 1)) return true;
  // Thanksgiving — 4th Thursday of November
  if (mm === 11 && dow === 4 && dd === nthWeekday(yr, 11, 4, 4)) return true;

  return false;
}

// Count business days (Mon-Fri, excl. US federal holidays) in [start, end] inclusive
function countBusinessDays(start, end) {
  let count = 0;
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const fin = new Date(end);
  fin.setHours(0, 0, 0, 0);
  while (cur <= fin) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6 && !isUSFederalHoliday(cur)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Year run rate: business days elapsed / business days in full year
function computeYearRunRate(now) {
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const dec31 = new Date(now.getFullYear(), 11, 31);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const elapsed = countBusinessDays(jan1, yesterday < jan1 ? jan1 : yesterday);
  const total   = countBusinessDays(jan1, dec31);
  return { elapsed, total, rate: total > 0 ? +(elapsed / total).toFixed(4) : 0 };
}

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

    const repEnc = encodeURIComponent(rep);

    // Phase 1 — fire all independent fetches in parallel
    const [cyDays, pyMonthTickets, pyYtdDays, mtdTickets] = await Promise.all([
      // CY YTD daily rows (for avg ticket/lines)
      fetchAllPages(
        `/api/v1/sales-analysis/by-sales-rep?filter=salesRep:eq:${repEnc},postDate:gte:${ytdStart},postDate:lte:${today}&fields=postDate,ticketCount,saleSubTotal,saleLines&pageSize=200`
      ),
      // PY full same month — ticket-history Total matches /proxy/accounts monthGoal field
      fetchAllPages(
        `/api/v1/pos/ticket-history?filter=SalesRep:eq:${repEnc},BusinessDate:gte:${pyMonthStart},BusinessDate:lte:${pyMonthEnd}&fields=Total&pageSize=500`
      ),
      // PY YTD daily rows (for avg ticket/lines prior year)
      fetchAllPages(
        `/api/v1/sales-analysis/by-sales-rep?filter=salesRep:eq:${repEnc},postDate:gte:${pyYtdStart},postDate:lte:${pyYtdEnd}&fields=postDate,ticketCount,saleSubTotal,saleLines&pageSize=200`
      ),
      // MTD ticket headers (for active accounts count)
      fetchAllPages(
        `/api/v1/pos/ticket-history?filter=SalesRep:eq:${repEnc},BusinessDate:gte:${mtdStart},BusinessDate:lte:${today}&fields=TicketNo,Total,SaleLines,CustPoNo,BusinessDate&pageSize=200`
      ),
    ]);

    // ── Year run rate ─────────────────────────────────────────
    const { elapsed, total: bdTotal, rate: yearRunRate } = computeYearRunRate(now);

    // ── Monthly goal = PY full same month sum(Total) × growth multiplier ─
    // Matches /proxy/accounts per-customer monthGoal formula exactly.
    const pyMonthRaw = pyMonthTickets.reduce((s, t) => s + (parseFloat(t.Total || t.total) || 0), 0);
    const monthGoal  = +(pyMonthRaw * (1 + MONTHLY_GROWTH_GOAL_PCT)).toFixed(2);

    // ── MTD from CY daily rows ────────────────────────────────
    const mtdDays = cyDays.filter(r => (r.postDate || '').slice(0, 7) === `${yr}-${mm}`);
    const mtdTotal = mtdDays.reduce((s, r) => s + (parseFloat(r.saleSubTotal) || 0), 0);
    const pctToGoal = monthGoal > 0 ? +(mtdTotal / monthGoal).toFixed(4) : 0;

    // Remaining business days in month — includes today (rep can still sell today)
    const monthEnd    = new Date(yr, now.getMonth() + 1, 0); // last day of this month
    const remainingBD = countBusinessDays(now, monthEnd);

    const gap = monthGoal - mtdTotal;
    const dailySalesNeeded = remainingBD > 0 && gap > 0 ? +(gap / remainingBD).toFixed(2) : 0;

    // ── Active accounts this month ────────────────────────────
    // MTD ticket-history gives us CustPoNo — that IS the customer number for this rep's accounts
    const activeCustNos = new Set(mtdTickets.map(t => (t.CustPoNo || t.custPoNo || '').trim()).filter(Boolean));
    const activeAccounts = activeCustNos.size;

    // We don't have totalAccounts in this route — front-end can use accountsData.length
    // Expose -1 as a sentinel meaning "use client-side total"
    const totalAccounts = -1;

    // ── Average ticket & lines — CY YTD ──────────────────────
    const cyTickets = cyDays.reduce((s, r) => s + (parseInt(r.ticketCount) || 0), 0);
    const cySales   = cyDays.reduce((s, r) => s + (parseFloat(r.saleSubTotal) || 0), 0);
    const cyLines   = cyDays.reduce((s, r) => s + (parseInt(r.saleLines) || 0), 0);
    const ticketCurrent = cyTickets > 0 ? +(cySales  / cyTickets).toFixed(2) : 0;
    const linesCurrent  = cyTickets > 0 ? +(cyLines  / cyTickets).toFixed(2) : 0;

    // ── Average ticket & lines — PY YTD ──────────────────────
    const pyTickets = pyYtdDays.reduce((s, r) => s + (parseInt(r.ticketCount) || 0), 0);
    const pySales   = pyYtdDays.reduce((s, r) => s + (parseFloat(r.saleSubTotal) || 0), 0);
    const pyLines   = pyYtdDays.reduce((s, r) => s + (parseInt(r.saleLines) || 0), 0);
    const ticketPrior = pyTickets > 0 ? +(pySales / pyTickets).toFixed(2) : 0;
    const linesPrior  = pyTickets > 0 ? +(pyLines / pyTickets).toFixed(2) : 0;

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
      bestSeller: { pct: 0, lines: 0, total: 0 },
    };

    overviewCache[rep] = { data: result, ts: Date.now() };
    routeTimer(`GET /proxy/rep-overview`, t0, { rep, pyMonthTickets: pyMonthTickets.length, monthGoal: monthGoal.toFixed(2), mtdCusts: mtdCustNos.length });
    res.json(result);
  } catch (e) {
    console.error('/proxy/rep-overview error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

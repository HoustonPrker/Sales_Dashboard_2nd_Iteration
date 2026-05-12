'use strict';

// Signal rank — higher = worse tier
const ENG_RANK = { OnCadence: 0, Slowing: 1, Late: 2, GoneQuiet: 3 };
const FIN_RANK = { Growing: 0, Steady: 0, Declining: 2, Collapsing: 3 };
const TGT_RANK = { Ahead: 0, OnPace: 0, Behind: 1, WayBehind: 2 };
const RANK_TIER = ['Healthy', 'Attention', 'AtRisk', 'Critical'];

function engagementSignal(daysSinceOrder, typicalIntervalDays) {
  const ds = typeof daysSinceOrder === 'number' ? daysSinceOrder : 999;
  let state;
  if (typicalIntervalDays !== null && typicalIntervalDays > 0) {
    const gqThreshold = Math.max(typicalIntervalDays * 2.5, 90);
    if      (ds <= typicalIntervalDays)       state = 'OnCadence';
    else if (ds <= typicalIntervalDays * 1.5) state = 'Slowing';
    else if (ds <= gqThreshold)               state = 'Late';
    else                                      state = 'GoneQuiet';
  } else {
    // Fallback: fewer than 3 prior orders, use fixed thresholds
    if      (ds <= 30) state = 'OnCadence';
    else if (ds <= 60) state = 'Slowing';
    else if (ds <= 90) state = 'Late';
    else               state = 'GoneQuiet';
  }
  return { state, daysSinceOrder: ds, typicalInterval: typicalIntervalDays };
}

function financialSignal(ytdSales, priorYtd) {
  if (!priorYtd || priorYtd <= 0) return null; // new customer — no prior data
  const yoyDollar = ytdSales - priorYtd;
  const yoyPct    = (yoyDollar / priorYtd) * 100;
  // Evaluate worst-to-best; "use harsher" means OR conditions escalate the tier
  let state;
  if      (yoyDollar <= -5000 || yoyPct <= -25) state = 'Collapsing';
  else if (yoyDollar <= -500  || yoyPct <= -5)  state = 'Declining';
  else if (yoyDollar >= 500   && yoyPct > 0)    state = 'Growing';
  else                                           state = 'Steady';
  return { state, yoyDollar: +yoyDollar.toFixed(2), yoyPct: +yoyPct.toFixed(1) };
}

function targetSignal(ytdSales, pyFullYear, runRate) {
  if (!pyFullYear || pyFullYear <= 0) return null; // no annual target
  const pctToTarget  = (ytdSales / pyFullYear) * 100;
  const runRatePct   = runRate * 100;
  const paceVsTarget = pctToTarget - runRatePct;
  let state;
  if      (paceVsTarget >= 0)   state = 'Ahead';
  else if (paceVsTarget >= -5)  state = 'OnPace';
  else if (paceVsTarget >= -15) state = 'Behind';
  else                          state = 'WayBehind';
  return { state, paceVsTarget: +paceVsTarget.toFixed(1) };
}

/**
 * Classify an account into a health tier using 3 independent signals.
 * The worst signal wins (highest rank across all active signals sets the tier).
 *
 * @param {object} p
 * @param {number}      p.daysSinceOrder      days since last order (999 = never)
 * @param {number|null} p.typicalIntervalDays mean days between orders; null if < 3 distinct order dates
 * @param {number}      p.ytdSales            current YTD sales
 * @param {number}      p.priorYtd            same-period prior year YTD (for YoY comparison)
 * @param {number}      p.pyFullYear          full prior year sales (annual target proxy)
 * @param {number}      p.runRate             fraction of year elapsed (0..1)
 * @returns {{ tier: string, signals: object, driverSignal: string }}
 */
function classifyAccountHealth({ daysSinceOrder, typicalIntervalDays, ytdSales, priorYtd, pyFullYear, runRate }) {
  const engagement = engagementSignal(daysSinceOrder, typicalIntervalDays);
  const financial  = financialSignal(ytdSales, priorYtd);
  const target     = targetSignal(ytdSales, pyFullYear, runRate);

  const engRank = ENG_RANK[engagement.state];
  const finRank = financial ? FIN_RANK[financial.state] : -1;
  const tgtRank = target    ? TGT_RANK[target.state]    : -1;

  const worstRank = Math.max(engRank, finRank, tgtRank);
  const tier = RANK_TIER[worstRank];

  // Driver: which signal produced the worst rank? Financial wins ties (most actionable).
  const candidates = [
    { key: 'financial',  rank: finRank },
    { key: 'engagement', rank: engRank },
    { key: 'target',     rank: tgtRank },
  ].filter(p => p.rank === worstRank && p.rank >= 0);
  const driverSignal = candidates[0]?.key || 'engagement';

  return { tier, signals: { engagement, financial, target }, driverSignal };
}

/**
 * Compute the typical order interval from a list of order date strings.
 * Uses the most recent 6 intervals (7 dates).
 * Returns null if fewer than 3 distinct order dates are available.
 *
 * @param {string[]} orderDates ISO date strings (any order, duplicates ok)
 * @returns {number|null} mean days between orders, rounded to nearest day
 */
function computeTypicalInterval(orderDates) {
  const unique = [...new Set((orderDates || []).map(d => (d || '').slice(0, 10)))]
    .filter(Boolean)
    .sort()
    .reverse(); // most recent first

  if (unique.length < 3) return null;

  const recent = unique.slice(0, 7); // up to 7 dates → up to 6 intervals
  const asc    = [...recent].reverse();
  let totalDays = 0;
  for (let i = 1; i < asc.length; i++) {
    totalDays += (new Date(asc[i]) - new Date(asc[i - 1])) / 86400000;
  }
  return Math.round(totalDays / (asc.length - 1));
}

module.exports = { classifyAccountHealth, computeTypicalInterval };

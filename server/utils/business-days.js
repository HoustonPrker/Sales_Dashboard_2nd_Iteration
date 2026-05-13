// ============================================================
// Business-day utilities
// Shared by overview.js, customers.js (leaderboard), and tests.
// ============================================================

// Returns true if the given Date falls on a US federal holiday.
function isUSFederalHoliday(date) {
  const yr  = date.getFullYear();
  const mm  = date.getMonth() + 1; // 1-based
  const dd  = date.getDate();
  const dow = date.getDay(); // 0=Sun

  function nthWeekday(year, month, nth, weekday) {
    const first = new Date(year, month - 1, 1).getDay();
    let offset  = weekday - first;
    if (offset < 0) offset += 7;
    return 1 + offset + (nth - 1) * 7;
  }

  function lastWeekday(year, month, weekday) {
    const last = new Date(year, month, 0);
    const dw   = last.getDay();
    let diff   = dw - weekday;
    if (diff < 0) diff += 7;
    return last.getDate() - diff;
  }

  // Fixed-date holidays observed Mon if Sun, Fri if Sat
  function fixedObserved(m, d) {
    const raw = new Date(yr, m - 1, d).getDay();
    let od    = d;
    if (raw === 0) od = d + 1;
    if (raw === 6) od = d - 1;
    return mm === m && dd === od;
  }

  if (fixedObserved(1, 1))  return true; // New Year's Day
  if (fixedObserved(6, 19)) return true; // Juneteenth
  if (fixedObserved(7, 4))  return true; // Independence Day
  if (fixedObserved(11, 11)) return true; // Veterans Day
  if (fixedObserved(12, 25)) return true; // Christmas Day

  // MLK Jr. Day — 3rd Monday of January
  if (mm === 1  && dow === 1 && dd === nthWeekday(yr, 1,  3, 1)) return true;
  // Presidents' Day — 3rd Monday of February
  if (mm === 2  && dow === 1 && dd === nthWeekday(yr, 2,  3, 1)) return true;
  // Memorial Day — last Monday of May
  if (mm === 5  && dow === 1 && dd === lastWeekday(yr, 5, 1))    return true;
  // Labor Day — 1st Monday of September
  if (mm === 9  && dow === 1 && dd === nthWeekday(yr, 9,  1, 1)) return true;
  // Columbus Day — 2nd Monday of October
  if (mm === 10 && dow === 1 && dd === nthWeekday(yr, 10, 2, 1)) return true;
  // Thanksgiving — 4th Thursday of November
  if (mm === 11 && dow === 4 && dd === nthWeekday(yr, 11, 4, 4)) return true;

  return false;
}

// Count business days (Mon–Fri, excl. federal holidays) in [start, end] inclusive.
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

// Returns business-day context for a given date within its calendar month.
//   elapsed — business days from the 1st through and including `date`
//   total   — business days in the full calendar month
//   pctElapsed — elapsed / total * 100 (0 if total === 0)
function monthBusinessDayContext(date) {
  const yr       = date.getFullYear();
  const mo       = date.getMonth(); // 0-based
  const monthFirstDay = new Date(yr, mo, 1);
  const monthLastDay  = new Date(yr, mo + 1, 0);

  const today = new Date(date);
  today.setHours(0, 0, 0, 0);

  const elapsed    = countBusinessDays(monthFirstDay, today);
  const total      = countBusinessDays(monthFirstDay, monthLastDay);
  const pctElapsed = total > 0 ? (elapsed / total) * 100 : 0;

  return { elapsed, total, pctElapsed };
}

// Year run-rate: business days elapsed through yesterday / business days in full year.
// Used by overview.js for the annual KPI strip.
function computeYearRunRate(now) {
  const jan1     = new Date(now.getFullYear(), 0, 1);
  const dec31    = new Date(now.getFullYear(), 11, 31);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const elapsed = countBusinessDays(jan1, yesterday < jan1 ? jan1 : yesterday);
  const total   = countBusinessDays(jan1, dec31);
  return { elapsed, total, rate: total > 0 ? +(elapsed / total).toFixed(4) : 0 };
}

// Pace score: how many percentage points ahead of (or behind) monthly pace.
//   score > 0 → ahead of pace
//   score < 0 → behind pace
//   null if no goal or goal ≤ 0
function computePaceScore(monthlyActual, monthlyGoal, businessDaysElapsed, businessDaysTotal) {
  if (!monthlyGoal || monthlyGoal <= 0) return null;
  const pctToGoal  = (monthlyActual / monthlyGoal) * 100;
  const pctElapsed = businessDaysTotal > 0 ? (businessDaysElapsed / businessDaysTotal) * 100 : 0;
  return pctToGoal - pctElapsed;
}

module.exports = {
  isUSFederalHoliday,
  countBusinessDays,
  monthBusinessDayContext,
  computeYearRunRate,
  computePaceScore,
};

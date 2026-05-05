// ============================================================
// UTILS — Formatting helpers and DOM helpers
// ============================================================

function fmt$(v) {
  return '$' + (parseFloat(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtQty(v) {
  return Math.round(parseFloat(v) || 0).toLocaleString('en-US');
}

function fmtRevMM(v) {
  const n = parseFloat(v) || 0;
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
}

// ── Daily sales helper ────────────────────────────────────────

function getDailySalesForItem(itemNo) {
  const key  = (itemNo || '').trim();
  const rows = dailySalesIndex[key] || [];

  // Find global date range across all daily data
  let minDate = null, maxDate = null;
  // Use the item's own rows to find range if available, else fall back to 90-day window
  if (rows.length > 0) {
    rows.forEach(r => {
      const d = (r.POST_DATE || r.SALE_DATE || '').slice(0, 10);
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    });
    // Expand to full 90-day window based on max date
    const end   = new Date(maxDate);
    const start = new Date(end);
    start.setDate(end.getDate() - 89);
    minDate = start.toISOString().slice(0, 10);
  } else {
    // No data — build empty 90-day window ending today
    const end   = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - 89);
    minDate = start.toISOString().slice(0, 10);
    maxDate = end.toISOString().slice(0, 10);
  }

  // Build lookup by date for this item
  const byDate = {};
  rows.forEach(r => {
    const dateKey = (r.POST_DATE || r.SALE_DATE || '').slice(0, 10);
    byDate[dateKey] = {
      qty: parseFloat(r.QTY_SOLD ?? r.DAILY_QTY) || 0,
      amt: parseFloat(r.EXT_PRC  ?? r.DAILY_AMT)  || 0
    };
  });

  // Walk every date from minDate to maxDate, zero-filling gaps
  const labels = [], qty = [], amt = [];
  const cur = new Date(minDate);
  const end = new Date(maxDate);
  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10);
    labels.push(cur.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    const d = byDate[iso] || { qty: 0, amt: 0 };
    qty.push(d.qty);
    amt.push(d.amt);
    cur.setDate(cur.getDate() + 1);
  }

  return { labels, qty, amt };
}

// IDs that use flex display when shown
const _FLEX_IDS = new Set(['welcome-screen', 'loading-screen', 'file-picker', 'error-view']);

function show(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = _FLEX_IDS.has(id) ? 'flex' : 'block';
}

function hide(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

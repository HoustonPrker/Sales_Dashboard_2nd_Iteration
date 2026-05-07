// ============================================================
// Shared API helpers for Kellis Sales proxy server
// ============================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fetch = require('node-fetch');

const API_BASE  = (process.env.API_BASE_URL || 'http://172.16.20.185:8084').replace(/\/$/, '');
const API_KEY   = process.env.API_KEY  || '';
const SALES_REP = process.env.SALES_REP || '';

function authHeaders() {
  return { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' };
}

async function doFetch(method, urlPath, opts = {}) {
  const url = `${API_BASE}${urlPath}`;
  const t0  = Date.now();
  const res = await fetch(url, { method, headers: authHeaders(), ...opts });
  console.log(`  ${method} ${urlPath} → ${res.status} (${Date.now() - t0}ms)`);
  return res;
}

async function fetchAllPages(urlPath) {
  const records = [];
  let page = 1;
  while (true) {
    const sep     = urlPath.includes('?') ? '&' : '?';
    const res     = await doFetch('GET', `${urlPath}${sep}page=${page}`);
    if (!res.ok) break;
    const body    = await res.json();
    const data    = body.data ?? body;
    const items   = Array.isArray(data) ? data : (data.Items || data.items || []);
    const hasNext = body.hasNextPage ?? data.hasNextPage ?? (items.length > 0 && body.totalPages && page < body.totalPages) ?? false;
    records.push(...items);
    if (!hasNext || !items.length) break;
    page++;
  }
  return records;
}

// Strip size/variant suffix to get base item number
function baseItemNo(itemNo) {
  return (itemNo || '').replace(/[-_](?:S|M|L|XL|XXL|\d+(?:OZ|CT|PK)?)$/i, '').trim();
}

// YTD and prior-YTD date ranges (Jan 1 – today, same period last year)
function ytdDateRange() {
  const now = new Date();
  const yr  = now.getFullYear();
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const dd  = String(now.getDate()).padStart(2, '0');
  return {
    ytdStart:   `${yr}-01-01`,
    ytdEnd:     `${yr}-${mm}-${dd}`,
    priorStart: `${yr - 1}-01-01`,
    priorEnd:   `${yr - 1}-${mm}-${dd}`,
  };
}

// Average days between orders (cadence) from an array of order objects with a date field
function calcCadence(orders, dateField = 'date') {
  if (!orders || orders.length < 2) return null;
  const dates = [...new Set(orders.map(o => (o[dateField] || '').slice(0, 10)).filter(Boolean))].sort();
  if (dates.length < 2) return null;
  const first = new Date(dates[0]);
  const last  = new Date(dates[dates.length - 1]);
  return (last - first) / 86400000 / (dates.length - 1);
}

// Aggregate ticket-history lines by custNo → { total, lastDate }
function aggregateLineItems(lines) {
  const byCust = {};
  for (const l of lines) {
    const custNo = l.custNo || l.CustNo || l.CUST_NO || '';
    if (!custNo) continue;
    if (!byCust[custNo]) byCust[custNo] = { total: 0, lastDate: null };
    byCust[custNo].total += parseFloat(l.total || l.extPrice || l.ExtPrice || l.extAmt || 0);
    const d  = (l.businessDate || l.BusinessDate || l.date || '').slice(0, 10);
    if (d && (!byCust[custNo].lastDate || d > byCust[custNo].lastDate)) {
      byCust[custNo].lastDate = d;
    }
  }
  return byCust;
}

module.exports = {
  doFetch, fetchAllPages, authHeaders,
  baseItemNo, ytdDateRange, calcCadence, aggregateLineItems,
  SALES_REP, API_BASE, API_KEY,
};

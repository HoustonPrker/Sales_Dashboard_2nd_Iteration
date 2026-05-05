// ============================================================
// CK Analytics — Proxy Server
// Bridges the browser dashboard to the internal CK API
// and serves CSV-backed data (daily sales, rankings)
// ============================================================

require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const { parse } = require('csv-parse/sync');

const PORT     = parseInt(process.env.PROXY_PORT || '3001', 10);
const API_BASE = (process.env.API_BASE_URL || 'http://172.16.20.185:8085').replace(/\/$/, '');
const API_KEY  = process.env.API_KEY || '';

const DATA_DIR = path.resolve(__dirname, 'data');

const app = express();

// ── CORS — allow all origins ──────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Auth headers ──────────────────────────────────────────────
function authHeaders() {
  return { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' };
}

// ── Fetch helper with logging ─────────────────────────────────
async function doFetch(method, urlPath, opts = {}) {
  const url = `${API_BASE}${urlPath}`;
  const t0  = Date.now();
  const res = await fetch(url, { method, headers: authHeaders(), ...opts });
  console.log(`  ${method} ${urlPath} → ${res.status} (${Date.now() - t0}ms)`);
  return res;
}

// ── Paginator ─────────────────────────────────────────────────
async function fetchAllPages(urlPath) {
  const records = [];
  let page = 1;
  while (true) {
    const sep = urlPath.includes('?') ? '&' : '?';
    const res  = await doFetch('GET', `${urlPath}${sep}page=${page}`);
    if (!res.ok) break;
    const body     = await res.json();
    const data     = body.data ?? body;
    const items    = Array.isArray(data) ? data : (data.items || []);
    const hasNext  = body.hasNextPage ?? data.hasNextPage ?? false;
    records.push(...items);
    if (!hasNext) break;
    page++;
  }
  return records;
}

// ── CSV cache (mtime-based reload) ───────────────────────────
const csvCache = {};

function loadCsv(filename) {
  const filepath = path.join(DATA_DIR, filename);
  const mtime    = fs.statSync(filepath).mtimeMs;
  if (csvCache[filename] && csvCache[filename].mtime === mtime) {
    return csvCache[filename].rows;
  }
  const content = fs.readFileSync(filepath, 'utf-8').replace(/^\uFEFF/, '');
  const rows    = parse(content, { columns: true, skip_empty_lines: true });
  csvCache[filename] = { mtime, rows };
  console.log(`  Loaded ${filename}: ${rows.length} rows`);
  return rows;
}

// ================================================================
// Routes
// ================================================================

// GET /proxy/item/:itemNo
app.get('/proxy/item/:itemNo', async (req, res) => {
  try {
    const r    = await doFetch('GET', `/api/v1/items/${req.params.itemNo}`);
    const body = await r.json();
    res.status(r.status).json(body.data !== undefined ? { data: body.data } : body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /proxy/item/:itemNo/inventory
app.get('/proxy/item/:itemNo/inventory', async (req, res) => {
  try {
    const r = await doFetch('GET', `/api/v1/items/${req.params.itemNo}/inventory`);
    if (r.status === 503) {
      return res.json({ data: [], warning: 'inventory_unavailable' });
    }
    const body = await r.json();
    res.status(r.status).json(body.data !== undefined ? body.data : body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /proxy/item/:itemNo/store-sales — 30D and 90D sales aggregated by store
app.get('/proxy/item/:itemNo/store-sales', async (req, res) => {
  try {
    const itemNo  = (req.params.itemNo || '').trim();
    const today   = new Date();
    const date90  = new Date(today); date90.setDate(today.getDate() - 90);
    const date30  = new Date(today); date30.setDate(today.getDate() - 30);
    const d90str  = date90.toISOString().split('T')[0];

    const url = (page) =>
      `/api/v1/pos/ticket-history-lines?filter=ItemNo:eq:${encodeURIComponent(itemNo)},BusinessDate:gte:${d90str}&fields=storeId,quantity,extPrice,businessDate&pageSize=1000&page=${page}`;

    // Fetch page 1 to learn totalPages, then fire all remaining pages in parallel
    const first     = await doFetch('GET', url(1));
    if (!first.ok) return res.json([]);
    const firstBody = await first.json();
    const totalPages = firstBody.totalPages || 1;

    const remaining = [];
    for (let p = 2; p <= totalPages; p++) remaining.push(p);

    const extraBodies = await Promise.all(
      remaining.map(p => doFetch('GET', url(p)).then(r => r.ok ? r.json() : { data: [] }))
    );

    const records = [
      ...(firstBody.data || []),
      ...extraBodies.flatMap(b => b.data || []),
    ];

    // Aggregate by store
    const byStore = {};
    for (const rec of records) {
      const sid  = String(rec.storeId || rec.StoreId || '').trim();
      const qty  = parseFloat(rec.quantity  || 0);
      const amt  = parseFloat(rec.extPrice  || 0);
      const dat  = String(rec.businessDate || '').slice(0, 10);
      if (!sid) continue;
      if (!byStore[sid]) byStore[sid] = { storeId: sid, qty90: 0, amt90: 0, qty30: 0, amt30: 0 };
      byStore[sid].qty90 += qty;
      byStore[sid].amt90 += amt;
      if (dat >= date30.toISOString().split('T')[0]) {
        byStore[sid].qty30 += qty;
        byStore[sid].amt30 += amt;
      }
    }

    const result = Object.values(byStore)
      .map(s => ({
        storeId: s.storeId,
        qty30:   Math.round(s.qty30),
        amt30:   +s.amt30.toFixed(2),
        qty90:   Math.round(s.qty90),
        amt90:   +s.amt90.toFixed(2),
      }))
      .sort((a, b) => b.qty90 - a.qty90);

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /proxy/item/:itemNo/daily-sales
app.get('/proxy/item/:itemNo/daily-sales', (req, res) => {
  try {
    const itemNo = (req.params.itemNo || '').trim();
    const rows   = loadCsv('CK_daily_sales.csv');
    const result = rows.filter(r => (r.ITEM_NO || '').trim() === itemNo);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /proxy/item/:itemNo/ranking
app.get('/proxy/item/:itemNo/ranking', (req, res) => {
  try {
    const itemNo = (req.params.itemNo || '').trim();
    const rows   = loadCsv('CK_math_pipeline_data.csv');
    const row    = rows.find(r => (r.ITEM_NO || '').trim() === itemNo);
    res.json(row || {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /proxy/stores
app.get('/proxy/stores', async (req, res) => {
  try {
    const records = await fetchAllPages('/api/v1/Stores?pageSize=200');
    res.json(records);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /proxy/categories
app.get('/proxy/categories', async (req, res) => {
  try {
    const r    = await doFetch('GET', '/api/v1/items/categories?pageSize=200');
    const body = await r.json();
    res.status(r.status).json(body.data || body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /proxy/items?page=1&pageSize=50&category=SNACKS&search=reese
app.get('/proxy/items', async (req, res) => {
  try {
    const { page = 1, pageSize = 50, category, search } = req.query;
    const r    = await doFetch('GET',
      `/api/v1/items?pageSize=${pageSize}&page=${page}&filter=status:eq:A`
    );
    const body = await r.json();
    let rows   = body.data || [];

    if (category) {
      rows = rows.filter(row => row.categoryCode === category);
    }
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(row => (row.description || '').toLowerCase().includes(q));
    }

    res.status(r.status).json({
      data:        rows,
      hasNextPage: body.hasNextPage,
      totalCount:  body.totalCount,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /proxy/items/search?q=reese — search by item number or description (CSV-backed)
app.get('/proxy/items/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    const rows = loadCsv('CK_math_pipeline_data.csv');

    // Score each match: 0=exact item# | 1=item# starts-with | 2=name starts-with | 3=item# contains | 4=name contains
    const scored = [];
    for (const r of rows) {
      const itemNo = (r.ITEM_NO || '').trim().toLowerCase();
      const name   = (r.ITEM_NAME || r.DESCR || '').toLowerCase();
      let score = -1;
      if (itemNo === q)                   score = 0;
      else if (itemNo.startsWith(q))      score = 1;
      else if (name.startsWith(q))        score = 2;
      else if (itemNo.includes(q))        score = 3;
      else if (name.includes(q))          score = 4;
      if (score >= 0) scored.push({ score, r });
    }

    const results = scored
      .sort((a, b) => a.score - b.score)
      .slice(0, 10)
      .map(({ r }) => ({
        itemNo:   (r.ITEM_NO || '').trim(),
        name:     r.ITEM_NAME || r.DESCR || '',
        category: r.CATEG_COD || r.CATEGORY || '',
        subcat:   r.SUBCAT_COD || r.SUBCAT || '',
      }));
    res.json(results);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /proxy/rankings
// GET /proxy/store/:storeId/category-sales — per-store 90D revenue by category
// Built from rankings CSV (Cloverkey-wide) — instant, no API pagination
app.get('/proxy/store/:storeId/category-sales', (req, res) => {
  try {

    // Build item→category lookup from rankings CSV
    const rankings = loadCsv('CK_math_pipeline_data.csv');
    const itemCat  = {};
    rankings.forEach(r => {
      const itemNo = (r.ITEM_NO || '').trim();
      if (itemNo) itemCat[itemNo] = r.CATEG_COD || r.CATEGORY || '—';
    });

    // Aggregate from rankings CSV (Cloverkey-wide — no per-store daily CSV available)
    const byCat = {};
    rankings.forEach(r => {
      const cat = r.CATEG_COD || r.CATEGORY || '—';
      const amt = parseFloat(r.RAW_AMT_90D || 0);
      const qty = parseFloat(r.RAW_QTY_90D || 0);
      if (!byCat[cat]) byCat[cat] = { cat, rev: 0, qty: 0 };
      byCat[cat].rev += amt;
      byCat[cat].qty += qty;
    });

    const result = Object.values(byCat)
      .map(c => ({ cat: c.cat, rev: +c.rev.toFixed(2), qty: Math.round(c.qty) }))
      .sort((a, b) => b.rev - a.rev);

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/proxy/rankings', (req, res) => {
  try {
    const rows = loadCsv('CK_math_pipeline_data.csv');
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /proxy/store-data — full CK_store_data.csv as JSON (legacy tier/revenue data)
app.get('/proxy/store-data', (req, res) => {
  try {
    const rows = loadCsv('CK_store_data.csv');
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /proxy/daily-sales — full CK_daily_sales.csv as JSON (for pre-loading dailySalesIndex)
app.get('/proxy/daily-sales', (req, res) => {
  try {
    const rows = loadCsv('CK_daily_sales.csv');
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Static files ──────────────────────────────────────────────
app.use(express.static(path.resolve(__dirname)));

app.listen(PORT, () =>
  console.log(`CK Analytics proxy on http://localhost:${PORT}  →  ${API_BASE}`)
);

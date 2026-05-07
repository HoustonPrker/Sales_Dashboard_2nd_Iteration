// ============================================================
// ITEM PERFORMANCE VIEW
// Level 1: Category overview  →  Level 2: Category items  →  Level 3: Item deep-dive
// ============================================================

let ipLevel        = 1;                   // 1 | 2 | 3
let ipCatData      = [];                  // all-categories response
let ipCatSort      = { col: 'currentYtdAmt', dir: 'desc' };
let ipDrillCat     = null;               // { categoryCode, catName, currentYtdAmt, priorYtdAmt }
let ipDrillItems   = [];                 // top items for drilled category
let ipSelectedItem = null;               // { itemNo, description, categoryCode }
let ipStatsData    = null;               // item-stats response
let ipCharts       = {};
let ipTrendMode    = 'daily';
let ipLoading      = false;

// ── Persistent search bar (wired once on first tab open) ──────
let _ipSearchInited  = false;
let _ipSearchTimer   = null;
let _ipSearchResults = [];
let _ipSearchActive  = -1;

function ipInitSearch() {
  if (_ipSearchInited) return;
  _ipSearchInited = true;

  const inp = document.getElementById('ip-search-input');
  if (!inp) return;

  inp.addEventListener('input', () => {
    clearTimeout(_ipSearchTimer);
    const q   = inp.value.trim();
    const dd  = document.getElementById('ip-search-dropdown');
    const hint = document.getElementById('ip-search-hint');
    if (q.length < 2) {
      if (dd) dd.style.display = 'none';
      if (hint) hint.textContent = '';
      return;
    }
    if (hint) hint.textContent = 'Searching…';
    _ipSearchTimer = setTimeout(() => _ipSearchFetch(q), 280);
  });

  inp.addEventListener('keydown', e => {
    const dd   = document.getElementById('ip-search-dropdown');
    const rows = dd ? dd.querySelectorAll('.ip-dd-row') : [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _ipSearchActive = Math.min(_ipSearchActive + 1, rows.length - 1);
      rows.forEach((r, i) => r.style.background = i === _ipSearchActive ? '#f0f4f8' : '');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _ipSearchActive = Math.max(_ipSearchActive - 1, 0);
      rows.forEach((r, i) => r.style.background = i === _ipSearchActive ? '#f0f4f8' : '');
    } else if (e.key === 'Enter') {
      if (_ipSearchActive >= 0) _ipSearchSelect(_ipSearchActive);
      else if (_ipSearchResults.length) _ipSearchSelect(0);
    } else if (e.key === 'Escape') {
      if (dd) dd.style.display = 'none';
    }
  });

  document.addEventListener('click', e => {
    const bar = document.getElementById('tab-ip-search');
    if (bar && !bar.contains(e.target)) {
      const dd = document.getElementById('ip-search-dropdown');
      if (dd) dd.style.display = 'none';
    }
  });
}

async function _ipSearchFetch(q) {
  const dd   = document.getElementById('ip-search-dropdown');
  const hint = document.getElementById('ip-search-hint');
  if (!dd) return;
  try {
    const resp  = await fetch(`/proxy/item-search?q=${encodeURIComponent(q)}`);
    const items = resp.ok ? await resp.json() : [];
    _ipSearchResults = items;
    _ipSearchActive  = -1;

    if (!items.length) {
      dd.innerHTML = '<div style="padding:12px 14px;color:#9ca3af;font-size:13px">No items found.</div>';
      dd.style.display = 'block';
      if (hint) hint.textContent = '';
      return;
    }

    dd.innerHTML = items.map((item, i) =>
      `<div class="ip-dd-row" data-idx="${i}"
        style="padding:9px 14px;cursor:pointer;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:10px"
        onclick="_ipSearchSelect(${i})"
        onmouseenter="this.style.background='#f0f4f8';_ipSearchActive=${i}"
        onmouseleave="this.style.background=''">
        <span style="font-family:monospace;font-size:11px;font-weight:700;color:#3d5a80;min-width:72px">${item.itemNo}</span>
        <span style="font-size:13px;color:#1a2332;flex:1">${item.description}</span>
        ${item.categoryCode ? `<span style="font-size:11px;color:#9ca3af">${item.categoryCode}</span>` : ''}
      </div>`
    ).join('');
    dd.style.display = 'block';
    if (hint) hint.textContent = `${items.length} result${items.length !== 1 ? 's' : ''}`;
  } catch (_) {
    if (hint) hint.textContent = '';
  }
}

function _ipSearchSelect(idx) {
  const item = _ipSearchResults[idx];
  if (!item) return;

  const inp  = document.getElementById('ip-search-input');
  const dd   = document.getElementById('ip-search-dropdown');
  const hint = document.getElementById('ip-search-hint');
  if (inp)  inp.value = `${item.description} (${item.itemNo})`;
  if (dd)   dd.style.display = 'none';
  if (hint) hint.textContent = '';

  // Jump straight to item deep-dive (level 3), preserving category context if available
  ipSelectedItem = { itemNo: item.itemNo, description: item.description, categoryCode: item.categoryCode || '' };
  ipLevel = 3;
  ipOpenItem(item.itemNo);
}

const ipTooltip = {
  backgroundColor: '#fff', titleColor: '#1a2332', bodyColor: '#374151',
  borderColor: '#e5e7eb', borderWidth: 1, padding: 10,
  titleFont: { family: 'Inter, sans-serif', size: 12, weight: '600' },
  bodyFont:  { family: 'Inter, sans-serif', size: 12 },
};

// ── Entry point ───────────────────────────────────────────────

async function renderItemPerformanceView() {
  ipInitSearch();

  const panel = document.getElementById('item-perf-panel');
  if (!panel) return;

  // Restore in-session state
  if (ipLevel === 2 && ipDrillCat && ipDrillItems.length) { renderIPLevel2(); return; }
  if (ipLevel === 3 && ipStatsData)                        { renderIPLevel3(); return; }
  if (ipCatData.length)                                    { renderIPLevel1();  return; }

  // First load
  ipLevel = 1;
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;padding:60px;color:#6b7280;font-size:15px;gap:10px">
      <span style="width:18px;height:18px;border:2px solid #e5e7eb;border-top-color:#3d5a80;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block"></span>
      Loading category data…
    </div>`;

  ipLoading = true;
  try {
    const repParam = (typeof currentRep !== 'undefined' && currentRep) ? `?rep=${encodeURIComponent(currentRep)}` : '';
    const resp = await fetch(`/proxy/all-categories${repParam}`);
    ipCatData = resp.ok ? await resp.json() : [];
    ipLoading = false;
    renderIPLevel1();
  } catch (e) {
    ipLoading = false;
    const p = document.getElementById('item-perf-panel');
    if (p) p.innerHTML = `<div style="padding:40px;color:#dc2626">Error loading data: ${e.message}</div>`;
  }
}

function destroyItemPerfCharts() {
  Object.values(ipCharts).forEach(c => { try { c.destroy(); } catch (_) {} });
  ipCharts = {};
}

function resetItemPerformanceData() {
  ipLevel        = 1;
  ipCatData      = [];
  ipDrillCat     = null;
  ipDrillItems   = [];
  ipSelectedItem = null;
  ipStatsData    = null;
  destroyItemPerfCharts();
}

// ── Breadcrumb ────────────────────────────────────────────────

function ipBreadcrumb() {
  if (ipLevel === 1) return '';
  const parts = [`<a class="cat-back-link" onclick="ipGoLevel1()">Item Performance</a>`];
  if (ipLevel >= 2 && ipDrillCat) {
    if (ipLevel === 2) parts.push(`<span style="color:#1a2332;font-weight:600">${ipDrillCat.catName}</span>`);
    else               parts.push(`<a class="cat-back-link" onclick="ipGoLevel2()">${ipDrillCat.catName}</a>`);
  }
  if (ipLevel === 3 && ipSelectedItem) {
    parts.push(`<span style="color:#1a2332;font-weight:600">${ipSelectedItem.description}</span>`);
  }
  return `<div class="cat-nav-breadcrumb" style="margin-bottom:14px">${parts.join('<span style="color:#9ca3af;margin:0 8px">/</span>')}</div>`;
}

function ipGoLevel1() {
  ipLevel = 1;
  ipSelectedItem = null;
  ipStatsData    = null;
  destroyItemPerfCharts();
  const inp = document.getElementById('ip-search-input');
  if (inp) inp.value = '';
  const hint = document.getElementById('ip-search-hint');
  if (hint) hint.textContent = '';
  renderIPLevel1();
}

function ipGoLevel2() {
  ipLevel = 2;
  destroyItemPerfCharts();
  renderIPLevel2();
}

// ══════════════════════════════════════════════════════════════
// LEVEL 1 — Category overview
// ══════════════════════════════════════════════════════════════

function renderIPLevel1() {
  destroyItemPerfCharts();
  const panel = document.getElementById('item-perf-panel');
  if (!panel) return;

  const catData    = ipCatData;
  const totalYtd   = catData.reduce((s, c) => s + c.currentYtdAmt, 0);
  const priorYtd   = catData.reduce((s, c) => s + c.priorYtdAmt,   0);
  const numAccts   = typeof accountsData !== 'undefined' ? accountsData.length : 0;
  const avgPerAcct = numAccts > 0 ? totalYtd / numAccts : 0;
  const pctChange  = priorYtd > 0 ? ((totalYtd - priorYtd) / priorYtd * 100) : null;
  const chgCls     = pctChange === null ? '' : pctChange >= 0 ? 'vel-up' : 'vel-down';
  const chgStr     = pctChange !== null ? (pctChange >= 0 ? '+' : '') + pctChange.toFixed(1) + '%' : '—';

  const sorted = [...catData].sort((a, b) => {
    const dir = ipCatSort.dir === 'asc' ? 1 : -1;
    switch (ipCatSort.col) {
      case 'description':   return dir * (a.description || '').localeCompare(b.description || '');
      case 'currentYtdAmt': return dir * (a.currentYtdAmt - b.currentYtdAmt);
      case 'priorYtdAmt':   return dir * (a.priorYtdAmt   - b.priorYtdAmt);
      case 'pctChange':     return dir * ((a.priorYtdAmt > 0 ? a.currentYtdAmt/a.priorYtdAmt : 0) - (b.priorYtdAmt > 0 ? b.currentYtdAmt/b.priorYtdAmt : 0));
      case 'accountCount':  return dir * ((a.accountCount  || 0) - (b.accountCount  || 0));
      case 'avgPerAccount': return dir * ((a.avgPerAccount || 0) - (b.avgPerAccount || 0));
      default:              return dir * (a.currentYtdAmt - b.currentYtdAmt);
    }
  });

  const th = (key, label, cls = '') => {
    const active = ipCatSort.col === key;
    const icon   = active ? (ipCatSort.dir === 'asc' ? '▲' : '▼') : '⇅';
    return `<th class="${cls} sort-th${active ? ' sort-active' : ''}" onclick="ipSortCat('${key}')">${label}<span class="sort-icon">${icon}</span></th>`;
  };

  const rows = sorted.map(c => {
    const pct    = c.priorYtdAmt > 0 ? ((c.currentYtdAmt - c.priorYtdAmt) / c.priorYtdAmt * 100) : null;
    const pctCls = pct === null ? '' : pct >= 0 ? 'vel-up' : 'vel-down';
    const pctStr = pct !== null ? (pct >= 0 ? '↑ +' : '↓ ') + pct.toFixed(1) + '%' : '—';
    const code   = (c.categoryCode || '').replace(/'/g, "\\'");
    return `<tr onclick="ipOpenCategory('${code}')" style="cursor:pointer">
      <td class="cat-name-cell"><a class="acct-name-link">${c.description || c.categoryCode}</a></td>
      <td class="num-ctr">${fmt$(c.currentYtdAmt)}</td>
      <td class="num-ctr">${c.priorYtdAmt > 0 ? fmt$(c.priorYtdAmt) : '—'}</td>
      <td class="num-ctr"><span class="${pctCls}">${pctStr}</span></td>
      <td class="num-ctr">${c.accountCount != null ? c.accountCount : '—'}</td>
      <td class="num-ctr">${c.avgPerAccount > 0 ? fmt$(c.avgPerAccount) : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="padding:20px;color:#9ca3af;text-align:center">No category data found.</td></tr>';

  panel.innerHTML = `
    <div class="cat-stat-bar">
      <div class="cat-stat-item"><span class="cat-stat-lbl">Categories:</span><span class="cat-stat-val">${catData.length}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Total YTD:</span><span class="cat-stat-val">${fmt$(totalYtd)}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">vs Prior YTD:</span><span class="cat-stat-val"><span class="${chgCls}">${chgStr}</span></span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Avg / Account:</span><span class="cat-stat-val">${fmt$(avgPerAcct)}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Accounts:</span><span class="cat-stat-val">${numAccts}</span></div>
    </div>

    <div style="display:grid;grid-template-columns:3fr 2fr;gap:12px;margin-bottom:12px">
      <div class="chart-panel">
        <div class="chart-panel-title">Top 15 Categories — Current vs Prior YTD</div>
        <div style="position:relative;height:340px"><canvas id="ip-bar-chart"></canvas></div>
      </div>
      <div class="chart-panel">
        <div class="chart-panel-title">Category Revenue Mix</div>
        <div style="position:relative;height:340px"><canvas id="ip-donut-chart"></canvas></div>
      </div>
    </div>

    <div class="inv-wrap">
      <table class="data-table">
        <thead><tr>
          ${th('description',   'Category')}
          ${th('currentYtdAmt', 'Current YTD',    'num-ctr')}
          ${th('priorYtdAmt',   'Prior YTD',      'num-ctr')}
          ${th('pctChange',     '% Change',       'num-ctr')}
          ${th('accountCount',  '# Accts Buying', 'num-ctr')}
          ${th('avgPerAccount', 'Avg / Acct',     'num-ctr')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  setTimeout(() => ipRenderLevel1Charts(catData), 0);
}

function ipSortCat(col) {
  ipCatSort.dir = ipCatSort.col === col ? (ipCatSort.dir === 'desc' ? 'asc' : 'desc') : 'desc';
  ipCatSort.col = col;
  renderIPLevel1();
}

function ipRenderLevel1Charts(catData) {
  destroyItemPerfCharts();
  const top15 = [...catData].sort((a, b) => b.currentYtdAmt - a.currentYtdAmt).slice(0, 15);

  const barCtx = document.getElementById('ip-bar-chart');
  if (barCtx && top15.length) {
    ipCharts.bar = new Chart(barCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: top15.map(c => { const s = c.description || c.categoryCode; return s.length > 22 ? s.slice(0,22)+'…' : s; }),
        datasets: [
          { label: 'Current YTD', data: top15.map(c => c.currentYtdAmt), backgroundColor: '#0d9488', borderRadius: 2 },
          { label: 'Prior YTD',   data: top15.map(c => c.priorYtdAmt),   backgroundColor: '#f97316', borderRadius: 2 },
        ],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'top', labels: { font:{size:11}, boxWidth:12, padding:8 } },
          tooltip: { ...ipTooltip, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt$(ctx.parsed.x)}` } },
        },
        scales: {
          x: { ticks: { font:{size:11}, color:'#6b7280', callback: v => fmtRevMM(v) }, grid: { color:'rgba(0,0,0,0.04)' } },
          y: { ticks: { font:{size:11}, color:'#374151' }, grid: { display: false } },
        },
      },
    });
  }

  const donutCtx = document.getElementById('ip-donut-chart');
  if (donutCtx && catData.length) {
    const PIE_COLORS = ['#3d5a80','#e07b39','#4caf7d','#e8c53a','#9b59b6','#e74c3c','#17a2b8','#f06292'];
    const byRev  = [...catData].sort((a,b) => b.currentYtdAmt - a.currentYtdAmt);
    const top7   = byRev.slice(0,7);
    const other  = byRev.slice(7).reduce((s,c) => s + c.currentYtdAmt, 0);
    const total  = catData.reduce((s,c) => s + c.currentYtdAmt, 0);
    const labels = top7.map(c => c.description || c.categoryCode);
    const vals   = top7.map(c => c.currentYtdAmt);
    if (other > 0) { labels.push('Other'); vals.push(other); }

    ipCharts.donut = new Chart(donutCtx.getContext('2d'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data: vals, backgroundColor: labels.map((_,i) => PIE_COLORS[i%PIE_COLORS.length]), borderColor:'#fff', borderWidth:2 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '55%',
        plugins: {
          legend: { display: true, position: 'right', labels: { font:{size:10}, boxWidth:10, padding:6 } },
          tooltip: { ...ipTooltip, callbacks: { label: ctx => { const pct = total>0?(ctx.parsed/total*100).toFixed(1):'0.0'; return ` ${fmt$(ctx.parsed)} (${pct}%)`; } } },
        },
      },
    });
  }
}

// ══════════════════════════════════════════════════════════════
// LEVEL 2 — Category item list
// ══════════════════════════════════════════════════════════════

async function ipOpenCategory(categoryCode) {
  const cat     = ipCatData.find(c => c.categoryCode === categoryCode);
  const catName = cat ? (cat.description || cat.categoryCode) : categoryCode;
  ipDrillCat    = { categoryCode, catName, currentYtdAmt: cat?.currentYtdAmt || 0, priorYtdAmt: cat?.priorYtdAmt || 0 };
  ipLevel       = 2;

  destroyItemPerfCharts();
  const panel = document.getElementById('item-perf-panel');
  if (!panel) return;

  panel.innerHTML = `
    ${ipBreadcrumb()}
    <div style="display:flex;align-items:center;justify-content:center;padding:60px;color:#6b7280;font-size:15px;gap:10px">
      <span style="width:18px;height:18px;border:2px solid #e5e7eb;border-top-color:#3d5a80;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block"></span>
      Loading top items for <strong style="margin-left:6px;color:#3d5a80">${catName}</strong>…
    </div>`;

  try {
    const resp  = await fetch(`/proxy/category-top-items/${encodeURIComponent(categoryCode)}`);
    ipDrillItems = resp.ok ? await resp.json() : [];
    renderIPLevel2();
  } catch (e) {
    const p = document.getElementById('item-perf-panel');
    if (p) p.innerHTML = `<div style="padding:40px;color:#dc2626">Error loading items: ${e.message}</div>`;
  }
}

function renderIPLevel2() {
  destroyItemPerfCharts();
  const panel = document.getElementById('item-perf-panel');
  if (!panel || !ipDrillCat) return;

  const { catName, currentYtdAmt, priorYtdAmt } = ipDrillCat;
  const items   = ipDrillItems;
  const catPct  = priorYtdAmt > 0 ? ((currentYtdAmt - priorYtdAmt) / priorYtdAmt * 100) : null;
  const catPctStr = catPct !== null ? (catPct >= 0 ? '+' : '') + catPct.toFixed(1) + '%' : '—';
  const catPctCls = catPct === null ? '' : catPct >= 0 ? 'vel-up' : 'vel-down';
  const totalRev  = items.reduce((s, i) => s + i.rev90, 0);

  const rows = items.slice(0, 50).map((item, idx) => {
    const pct  = totalRev > 0 ? (item.rev90 / totalRev * 100).toFixed(1) : '0.0';
    const code = item.itemNo.replace(/'/g, "\\'");
    return `<tr onclick="ipOpenItem('${code}')" style="cursor:pointer">
      <td class="num-ctr" style="color:#9ca3af;font-size:13px;width:40px">${idx+1}</td>
      <td style="font-family:monospace;font-size:12px;font-weight:700;color:#3d5a80;white-space:nowrap">${item.itemNo}</td>
      <td><a class="acct-name-link">${item.description}</a></td>
      <td class="num-ctr">${fmt$(item.rev90)}</td>
      <td class="num-ctr">${fmt0(item.units90)}</td>
      <td class="num-ctr" style="color:#6b7280">${pct}%</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="padding:20px;color:#9ca3af;text-align:center">No item sales data found for this category in the last 90 days.</td></tr>';

  panel.innerHTML = `
    ${ipBreadcrumb()}

    <div class="cat-stat-bar" style="margin-bottom:14px">
      <div class="cat-stat-item"><span class="cat-stat-lbl">Category:</span><span class="cat-stat-val">${catName}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">YTD Revenue:</span><span class="cat-stat-val">${fmt$(currentYtdAmt)}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">vs Prior YTD:</span><span class="cat-stat-val"><span class="${catPctCls}">${catPctStr}</span></span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Items Active (90d):</span><span class="cat-stat-val">${items.length}</span></div>
    </div>

    <div style="display:grid;grid-template-columns:3fr 2fr;gap:12px;margin-bottom:14px">
      <div class="chart-panel">
        <div class="chart-panel-title">Top 15 Items by 90-Day Revenue</div>
        <div style="position:relative;height:320px"><canvas id="ip-cat-bar"></canvas></div>
      </div>
      <div class="chart-panel">
        <div class="chart-panel-title">Revenue Share — Top Items</div>
        <div style="position:relative;height:320px"><canvas id="ip-cat-donut"></canvas></div>
      </div>
    </div>

    <div class="inv-wrap">
      <table class="data-table">
        <thead><tr>
          <th class="num-ctr" style="width:40px">#</th>
          <th>Item #</th>
          <th>Description</th>
          <th class="num-ctr">90-Day Revenue</th>
          <th class="num-ctr">90-Day Units</th>
          <th class="num-ctr">Rev Share</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  setTimeout(() => ipRenderLevel2Charts(items), 0);
}

function ipRenderLevel2Charts(items) {
  destroyItemPerfCharts();
  const top15     = items.slice(0, 15);
  const totalRev  = items.reduce((s, i) => s + i.rev90, 0);

  const barCtx = document.getElementById('ip-cat-bar');
  if (barCtx && top15.length) {
    ipCharts.catBar = new Chart(barCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: top15.map(i => { const s = i.description; return s.length > 24 ? s.slice(0,24)+'…' : s; }),
        datasets: [{
          label: '90-Day Revenue', data: top15.map(i => i.rev90),
          backgroundColor: '#3d5a80', borderRadius: 3, borderWidth: 0,
        }],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { ...ipTooltip, callbacks: { label: ctx => ` Revenue: ${fmt$(ctx.parsed.x)}` } },
        },
        scales: {
          x: { ticks: { font:{size:11}, color:'#6b7280', callback: v => fmtRevMM(v) }, grid:{ color:'rgba(0,0,0,0.04)' } },
          y: { ticks: { font:{size:11}, color:'#374151' }, grid:{ display:false } },
        },
        onClick: (e, els) => { if (els.length) ipOpenItem(top15[els[0].index].itemNo); },
      },
    });
  }

  const donutCtx = document.getElementById('ip-cat-donut');
  if (donutCtx && items.length) {
    const PIE_COLORS = ['#3d5a80','#e07b39','#4caf7d','#e8c53a','#9b59b6','#e74c3c','#17a2b8','#f06292'];
    const top7  = items.slice(0, 7);
    const other = items.slice(7).reduce((s, i) => s + i.rev90, 0);
    const labels = top7.map(i => { const s = i.description; return s.length > 18 ? s.slice(0,18)+'…' : s; });
    const vals   = top7.map(i => i.rev90);
    if (other > 0) { labels.push('Other'); vals.push(other); }

    ipCharts.catDonut = new Chart(donutCtx.getContext('2d'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data: vals, backgroundColor: labels.map((_,i) => PIE_COLORS[i%PIE_COLORS.length]), borderColor:'#fff', borderWidth:2 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '55%',
        plugins: {
          legend: { display: true, position: 'right', labels: { font:{size:10}, boxWidth:10, padding:6 } },
          tooltip: { ...ipTooltip, callbacks: { label: ctx => { const pct = totalRev>0?(ctx.parsed/totalRev*100).toFixed(1):'0.0'; return ` ${fmt$(ctx.parsed)} (${pct}%)`; } } },
        },
      },
    });
  }
}

// ══════════════════════════════════════════════════════════════
// LEVEL 3 — Individual item deep-dive
// ══════════════════════════════════════════════════════════════

async function ipOpenItem(itemNo) {
  const found = ipDrillItems.find(i => i.itemNo === itemNo);
  ipSelectedItem = found
    ? { itemNo: found.itemNo, description: found.description, categoryCode: ipDrillCat?.categoryCode || '' }
    : { itemNo, description: itemNo, categoryCode: '' };
  ipLevel = 3;

  destroyItemPerfCharts();
  const panel = document.getElementById('item-perf-panel');
  if (!panel) return;

  panel.innerHTML = `
    ${ipBreadcrumb()}
    <div style="display:flex;align-items:center;justify-content:center;padding:60px;color:#6b7280;font-size:15px;gap:10px">
      <span style="width:18px;height:18px;border:2px solid #e5e7eb;border-top-color:#3d5a80;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block"></span>
      Loading stats for <strong style="margin-left:6px;color:#3d5a80">${ipSelectedItem.description}</strong>…
    </div>`;

  ipLoading = true;
  try {
    const resp = await fetch(`/proxy/item-stats/${encodeURIComponent(itemNo)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    ipStatsData = await resp.json();
    ipLoading   = false;
    renderIPLevel3();
  } catch (e) {
    ipLoading = false;
    const p = document.getElementById('item-perf-panel');
    if (p) p.innerHTML = `${ipBreadcrumb()}<div style="padding:40px;color:#dc2626">Error: ${e.message}</div>`;
  }
}

function renderIPLevel3() {
  destroyItemPerfCharts();
  const panel = document.getElementById('item-perf-panel');
  if (!panel || !ipStatsData) return;

  const data = ipStatsData;
  const k    = data.kpis;
  const marginColor = k.margin === null ? '#9ca3af' : k.margin >= 40 ? '#059669' : k.margin >= 20 ? '#d97706' : '#dc2626';
  const marginStr   = k.margin !== null ? k.margin.toFixed(1) + '%' : '—';

  const statusBadge = s => {
    if (!s) return '';
    if (s === 'A') return `<span style="background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">Active</span>`;
    if (s === 'I') return `<span style="background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">Inactive</span>`;
    if (s === 'D') return `<span style="background:#f3f4f6;color:#6b7280;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">Discontinued</span>`;
    return `<span style="background:#f3f4f6;color:#6b7280;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">${s}</span>`;
  };

  panel.innerHTML = `
    ${ipBreadcrumb()}

    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:18px">
      <div style="font-size:17px;font-weight:700;color:#1a2332">${data.description}</div>
      <span style="background:#e8edf2;color:#3d5a80;padding:2px 8px;border-radius:8px;font-size:12px;font-weight:600;font-family:monospace">${data.itemNo}</span>
      ${data.categoryCode ? `<span style="background:#f0f4f8;color:#4b6080;padding:2px 8px;border-radius:8px;font-size:12px">${data.categoryCode}</span>` : ''}
      ${statusBadge(data.statusCode)}
      ${data.isBestSeller ? `<span style="background:#fef3c7;color:#b45309;padding:2px 8px;border-radius:8px;font-size:12px;font-weight:600">★ Best Seller</span>` : ''}
    </div>

    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px">
      ${ipKpiCard('90-Day Revenue', fmt$(k.rev90), fmt0(k.units90) + ' units', '#3d5a80')}
      ${ipKpiCard('30-Day Revenue', fmt$(k.rev30), fmt0(k.units30) + ' units', '#3d5a80')}
      ${ipKpiCard('7-Day Revenue',  fmt$(k.rev7),  fmt0(k.units7)  + ' units', '#3d5a80')}
      ${ipKpiCard('Avg Sell / Cost', fmt$(k.avgSell), k.avgCost > 0 ? 'Cost: ' + fmt$(k.avgCost) : 'No cost data', '#3d5a80')}
      ${ipKpiCard('Margin', marginStr, k.avgSell > 0 ? 'on avg sell price' : 'No price data', marginColor)}
    </div>

    <div style="display:grid;grid-template-columns:3fr 2fr;gap:12px;margin-bottom:12px">
      <div class="chart-panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div class="chart-panel-title" style="margin:0">Revenue &amp; Units Trend</div>
          <div style="display:flex;gap:4px">
            <button onclick="ipSetTrendMode('daily')"
              style="padding:3px 10px;font-size:11px;font-family:inherit;border-radius:6px;cursor:pointer;border:1.5px solid #3d5a80;background:${ipTrendMode==='daily'?'#3d5a80':'#fff'};color:${ipTrendMode==='daily'?'#fff':'#3d5a80'}">Daily</button>
            <button onclick="ipSetTrendMode('weekly')"
              style="padding:3px 10px;font-size:11px;font-family:inherit;border-radius:6px;cursor:pointer;border:1.5px solid #3d5a80;background:${ipTrendMode==='weekly'?'#3d5a80':'#fff'};color:${ipTrendMode==='weekly'?'#fff':'#3d5a80'}">Weekly</button>
          </div>
        </div>
        <div style="position:relative;height:260px"><canvas id="ip-trend-chart"></canvas></div>
      </div>
      <div class="chart-panel">
        <div class="chart-panel-title">Revenue by Period</div>
        <div style="position:relative;height:260px"><canvas id="ip-period-donut"></canvas></div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="chart-panel">
        <div class="chart-panel-title">Weekly Revenue — Last 13 Weeks</div>
        <div style="position:relative;height:200px"><canvas id="ip-weekly-bar"></canvas></div>
      </div>
      <div class="chart-panel">
        <div class="chart-panel-title">Units Sold by Week</div>
        <div style="position:relative;height:200px"><canvas id="ip-units-bar"></canvas></div>
      </div>
    </div>`;

  setTimeout(() => ipRenderLevel3Charts(data), 0);
}

function ipKpiCard(label, value, sub, accent) {
  return `
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;border-top:3px solid ${accent}">
      <div style="font-size:11px;color:#6b7280;font-weight:500;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">${label}</div>
      <div style="font-size:20px;font-weight:700;color:#1a2332;margin-bottom:3px">${value}</div>
      <div style="font-size:12px;color:#9ca3af">${sub}</div>
    </div>`;
}

function ipSetTrendMode(mode) {
  ipTrendMode = mode;
  if (ipStatsData) renderIPLevel3();
}

function ipAggregateWeekly(daily) {
  const weeks = {};
  for (const d of daily) {
    const dt  = new Date(d.date);
    const day = dt.getDay();
    const mon = new Date(dt); mon.setDate(dt.getDate() + (day === 0 ? -6 : 1 - day));
    const wk  = mon.toISOString().slice(0, 10);
    if (!weeks[wk]) weeks[wk] = { revenue: 0, units: 0 };
    weeks[wk].revenue += d.revenue;
    weeks[wk].units   += d.units;
  }
  return Object.keys(weeks).sort().map(k => ({
    label:   (() => { const d = new Date(k); return (d.getMonth()+1)+'/'+d.getDate(); })(),
    revenue: +weeks[k].revenue.toFixed(2),
    units:   +weeks[k].units.toFixed(0),
  }));
}

function ipRenderLevel3Charts(data) {
  destroyItemPerfCharts();
  const daily  = data.daily;
  const weekly = ipAggregateWeekly(daily);
  const last13 = weekly.slice(-13);
  const k      = data.kpis;

  // Trend line: revenue + units dual-axis
  const trendCtx = document.getElementById('ip-trend-chart');
  if (trendCtx) {
    let tLabels, tRevenue, tUnits;
    if (ipTrendMode === 'weekly') {
      tLabels  = weekly.map(w => w.label);
      tRevenue = weekly.map(w => w.revenue);
      tUnits   = weekly.map(w => w.units);
    } else {
      const weekdays = daily.filter(d => { const day = new Date(d.date).getDay(); return day !== 0 && day !== 6; });
      tLabels  = weekdays.map(d => { const dt = new Date(d.date); return (dt.getMonth()+1)+'/'+dt.getDate(); });
      tRevenue = weekdays.map(d => d.revenue);
      tUnits   = weekdays.map(d => d.units);
    }
    const step = ipTrendMode === 'weekly' ? 1 : Math.ceil(tLabels.length / 18);
    ipCharts.trend = new Chart(trendCtx.getContext('2d'), {
      type: 'line',
      data: {
        labels: tLabels,
        datasets: [
          { label:'Revenue', data:tRevenue, yAxisID:'yRev',   borderColor:'#3d5a80', backgroundColor:'rgba(61,90,128,0.08)', borderWidth:2, pointRadius:ipTrendMode==='weekly'?3:0, pointHoverRadius:5, fill:true,  tension:0.3 },
          { label:'Units',   data:tUnits,   yAxisID:'yUnits', borderColor:'#e07b39', backgroundColor:'transparent',          borderWidth:1.5, borderDash:[4,3], pointRadius:ipTrendMode==='weekly'?3:0, pointHoverRadius:4, fill:false, tension:0.3 },
        ],
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        interaction:{ mode:'index', intersect:false },
        plugins: {
          legend:{ display:true, position:'top', labels:{ font:{size:11}, boxWidth:12, padding:8 } },
          tooltip:{ ...ipTooltip, callbacks:{ label: ctx => ctx.dataset.yAxisID==='yRev' ? ` Revenue: ${fmt$(ctx.parsed.y)}` : ` Units: ${fmt0(ctx.parsed.y)}` } },
        },
        scales: {
          x:      { ticks:{ font:{size:10}, color:'#9ca3af', maxTicksLimit:16, callback:(v,i)=>(i%step===0?tLabels[i]:'') }, grid:{display:false} },
          yRev:   { position:'left',  ticks:{ font:{size:10}, color:'#3d5a80', callback:v=>fmtRevMM(v) }, grid:{ color:'rgba(0,0,0,0.04)' } },
          yUnits: { position:'right', ticks:{ font:{size:10}, color:'#e07b39', callback:v=>fmt0(v) },     grid:{ display:false } },
        },
      },
    });
  }

  // Period donut
  const donutCtx = document.getElementById('ip-period-donut');
  if (donutCtx) {
    const v7 = k.rev7, v30 = k.rev30 - k.rev7, v90 = k.rev90 - k.rev30, total = k.rev90;
    ipCharts.donut = new Chart(donutCtx.getContext('2d'), {
      type: 'doughnut',
      data: { labels:['Last 7 Days','Days 8–30','Days 31–90'], datasets:[{ data:[v7,v30,v90], backgroundColor:['#3d5a80','#4caf7d','#e07b39'], borderColor:'#fff', borderWidth:2 }] },
      options: {
        responsive:true, maintainAspectRatio:false, cutout:'58%',
        plugins: {
          legend:{ display:true, position:'bottom', labels:{ font:{size:11}, boxWidth:12, padding:8 } },
          tooltip:{ ...ipTooltip, callbacks:{ label: ctx => { const pct=total>0?(ctx.parsed/total*100).toFixed(1):'0.0'; return ` ${fmt$(ctx.parsed)} (${pct}%)`; } } },
        },
      },
    });
  }

  // Weekly revenue bar
  const wBarCtx = document.getElementById('ip-weekly-bar');
  if (wBarCtx && last13.length) {
    ipCharts.weekBar = new Chart(wBarCtx.getContext('2d'), {
      type: 'bar',
      data: { labels:last13.map(w=>w.label), datasets:[{ label:'Revenue', data:last13.map(w=>w.revenue), backgroundColor:last13.map(w=>w.revenue>0?'#3d5a80':'#e5e7eb'), borderRadius:4, borderWidth:0 }] },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ ...ipTooltip, callbacks:{ label:ctx=>` Revenue: ${fmt$(ctx.parsed.y)}` } } },
        scales:{ x:{ ticks:{font:{size:11},color:'#6b7280'}, grid:{display:false} }, y:{ ticks:{font:{size:11},color:'#6b7280',callback:v=>fmtRevMM(v)}, grid:{color:'rgba(0,0,0,0.04)'} } },
      },
    });
  }

  // Units bar
  const uBarCtx = document.getElementById('ip-units-bar');
  if (uBarCtx && last13.length) {
    ipCharts.unitsBar = new Chart(uBarCtx.getContext('2d'), {
      type: 'bar',
      data: { labels:last13.map(w=>w.label), datasets:[{ label:'Units', data:last13.map(w=>w.units), backgroundColor:last13.map(w=>w.units>0?'#4caf7d':'#e5e7eb'), borderRadius:4, borderWidth:0 }] },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ ...ipTooltip, callbacks:{ label:ctx=>` Units: ${fmt0(ctx.parsed.y)}` } } },
        scales:{ x:{ ticks:{font:{size:11},color:'#6b7280'}, grid:{display:false} }, y:{ ticks:{font:{size:11},color:'#6b7280',callback:v=>fmt0(v)}, grid:{color:'rgba(0,0,0,0.04)'} } },
      },
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────

function fmt0(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
}

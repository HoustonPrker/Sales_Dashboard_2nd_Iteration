// ============================================================
// CATEGORY PERFORMANCE VIEW
// Uses globals: pipelineData, normalityMap, dataReady
// ============================================================

let catSortCol = 'revenue', catSortDir = 'desc';
let subcatSortCol = 'revenue', subcatSortDir = 'desc';
let catViewCharts = {};
let subcatFilterVal = '';

function destroyCatCharts() {
  Object.values(catViewCharts).forEach(c => { try { c.destroy(); } catch (_) {} });
  catViewCharts = {};
}

// ── Data aggregation ─────────────────────────────────────────

function buildCategoryMap() {
  const catMap = {};
  pipelineData.forEach(item => {
    const cat = item.CATEG_COD || 'UNKNOWN';
    const sub = item.SUBCAT_COD || 'UNKNOWN';
    if (!catMap[cat]) catMap[cat] = { name: cat, subcats: {}, items: [] };
    catMap[cat].items.push(item);
    if (!catMap[cat].subcats[sub]) catMap[cat].subcats[sub] = { name: sub, items: [] };
    catMap[cat].subcats[sub].items.push(item);
  });
  return catMap;
}

// ── Entry point ───────────────────────────────────────────────

function renderCategoryView() {
  if (!dataReady) return;
  renderCatOverview();
}

// ── Abbreviated revenue formatter for chart axes ──────────────

function fmtRevAxis(v) {
  if (v >= 1000000) return '$' + (v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1) + 'M';
  if (v >= 1000)    return '$' + Math.round(v / 1000) + 'K';
  return '$' + Math.round(v);
}

// ── Category overview table ───────────────────────────────────

function renderCatOverview() {
  destroyCatCharts();

  const catMap  = buildCategoryMap();
  const catList = Object.values(catMap).map(cat => {
    const rev     = cat.items.reduce((s, i) => s + (parseFloat(i.RAW_AMT_90D) || 0), 0);
    const qty     = cat.items.reduce((s, i) => s + (parseFloat(i.RAW_QTY_90D) || 0), 0);
    const vel     = cat.items.reduce((s, i) => s + (parseFloat(i.PCT_RECENT)  || 0), 0) / cat.items.length;
    const trendUp = cat.items.filter(i => (parseFloat(i.PCT_RECENT) || 0) >= 30).length;
    const oos     = cat.items.filter(i => (i.STATUS || '').toUpperCase() === 'OUT OF STOCK').length;
    const scCount = Object.keys(cat.subcats).length;
    return { name: cat.name, itemCount: cat.items.length, subcats: scCount, rev, qty, vel, trendUp, oos };
  });

  catList.sort((a, b) => {
    const dir = catSortDir === 'asc' ? 1 : -1;
    switch (catSortCol) {
      case 'name':     return dir * a.name.localeCompare(b.name);
      case 'items':    return dir * (a.itemCount - b.itemCount);
      case 'subcats':  return dir * (a.subcats - b.subcats);
      case 'qty':      return dir * (a.qty - b.qty);
      case 'revenue':  return dir * (a.rev - b.rev);
      case 'qty30':    return dir * (a.qty - b.qty);
      case 'rev30':    return dir * (a.rev - b.rev);
      case 'vel':      return dir * (a.vel - b.vel);
      default:         return dir * (a.rev - b.rev);
    }
  });

  const totalRev   = catList.reduce((s, c) => s + c.rev, 0);
  const totalItems = pipelineData.length;
  const totalCats  = catList.length;

  const cols = [
    { key: 'name',    label: 'Category' },
    { key: 'items',   label: 'Items',        cls: 'num-ctr' },
    { key: 'subcats', label: 'Sub-cats',     cls: 'num-ctr' },
    { key: 'qty',     label: '90D Qty',      cls: 'num-ctr' },
    { key: 'revenue', label: '90D Revenue',  cls: 'num-ctr' },
    { key: 'qty30',   label: '30D Qty',      cls: 'num-ctr' },
    { key: 'rev30',   label: '30D Revenue',  cls: 'num-ctr' },
    { key: 'vel',     label: 'Avg Velocity', cls: 'num-ctr' },
  ];

  const thead = cols.map(c => {
    const active = catSortCol === c.key;
    const icon   = active ? (catSortDir === 'asc' ? '▲' : '▼') : '⇅';
    const cls    = [c.cls || '', 'sort-th', active ? 'sort-active' : ''].filter(Boolean).join(' ');
    return `<th class="${cls}" onclick="catSortBy('${c.key}')">${c.label}<span class="sort-icon">${icon}</span></th>`;
  }).join('');

  const tbody = catList.map((c, idx) => {
    const velCls     = c.vel >= 35 ? 'vel-up' : c.vel >= 25 ? 'vel-ss' : 'vel-down';
    const velArrow   = c.vel >= 35 ? '↑'      : c.vel >= 25 ? '→'       : '↓';
    const isTop5     = idx < 5;
    const isGroupEnd = (idx + 1) % 5 === 0 && idx !== catList.length - 1;
    const rowCls     = [isTop5 ? 'cat-top5' : '', isGroupEnd ? 'cat-group-end' : ''].filter(Boolean).join(' ');
    return `<tr class="${rowCls}" onclick="showCategoryDetail('${c.name.replace(/'/g, "\\'")}')">
      <td class="cat-name-cell"><strong>${c.name}</strong></td>
      <td class="num-ctr">${c.itemCount.toLocaleString()}</td>
      <td class="num-ctr">${c.subcats}</td>
      <td class="num-ctr">${fmtQty(c.qty)}</td>
      <td class="num-ctr">${fmtRevMM(c.rev)}</td>
      <td class="num-ctr">${fmtQty(c.qty / 3)}</td>
      <td class="num-ctr">${fmtRevMM(c.rev / 3)}</td>
      <td class="num-ctr"><span class="${velCls}">${velArrow}</span> ${c.vel.toFixed(1)}%</td>
    </tr>`;
  }).join('');

  document.getElementById('cat-view-content').innerHTML = `
    <div class="cat-stat-bar">
      <div class="cat-stat-item"><span class="cat-stat-lbl">Categories:</span><span class="cat-stat-val">${totalCats}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Total Items:</span><span class="cat-stat-val">${totalItems.toLocaleString()}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">90D Revenue:</span><span class="cat-stat-val">${fmtRevMM(totalRev)}</span></div>
    </div>
    <div class="chart-row-2">
      <div class="chart-panel">
        <div class="chart-panel-title">Category Revenue (90D)</div>
        <div class="chart-container" style="height:420px"><canvas id="cat-bar-chart"></canvas></div>
      </div>
      <div class="chart-panel">
        <div class="chart-panel-title">Top 8 Categories by Revenue</div>
        <div class="chart-container" style="height:420px"><canvas id="cat-donut-chart"></canvas></div>
      </div>
    </div>
    <div class="inv-wrap" style="margin-top:16px">
      <table class="data-table">
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;

  setTimeout(() => renderCatCharts(catList), 0);
}

function renderCatCharts(catList) {
  const sorted = [...catList].sort((a, b) => b.rev - a.rev);

  // Velocity thresholds: green >35%, yellow 25-35%, red <25%
  const barColors = sorted.map(c =>
    c.vel > 35 ? '#16a34a' : c.vel >= 25 ? '#d97706' : '#dc2626'
  );

  const tooltipDefaults = {
    backgroundColor: '#fff',
    titleColor: '#1a2332',
    bodyColor: '#374151',
    borderColor: '#e5e7eb',
    borderWidth: 1,
    padding: 10,
    titleFont: { family: 'Inter, sans-serif', size: 12, weight: '600' },
    bodyFont: { family: 'Inter, sans-serif', size: 12 }
  };

  // ── Horizontal bar chart ──────────────────────────────────────
  const barCtx = document.getElementById('cat-bar-chart');
  if (barCtx) {
    catViewCharts.bar = new Chart(barCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: sorted.map(c => c.name),
        datasets: [{
          data: sorted.map(c => c.rev),
          backgroundColor: barColors,
          borderColor: barColors,
          borderWidth: 0,
          borderRadius: 3
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipDefaults,
            callbacks: { label: ctx => ` ${fmtRevMM(ctx.parsed.x)}` }
          }
        },
        scales: {
          x: {
            ticks: {
              font: { size: 11, family: 'Inter, sans-serif' },
              color: '#6b7280',
              callback: v => fmtRevAxis(v)
            },
            grid: { color: 'rgba(0,0,0,0.04)' }
          },
          y: {
            ticks: { font: { size: 11, family: 'Inter, sans-serif' }, color: '#374151' },
            grid: { display: false }
          }
        }
      }
    });
  }

  // ── Top-8 doughnut ────────────────────────────────────────────
  const donutCtx = document.getElementById('cat-donut-chart');
  if (donutCtx) {
    const top8    = sorted.slice(0, 8);
    const others  = sorted.slice(8);
    const otherRev = others.reduce((s, c) => s + c.rev, 0);
    const palette  = ['#0d9488','#7c3aed','#d97706','#dc2626','#059669','#db2777','#2563eb','#ea580c','#6b7280'];

    const labels = [...top8.map(c => c.name), ...(others.length ? [`Other (${others.length})`] : [])];
    const data   = [...top8.map(c => c.rev),  ...(others.length ? [otherRev] : [])];
    const colors = others.length ? palette : palette.slice(0, top8.length);

    catViewCharts.donut = new Chart(donutCtx.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors, borderColor: '#fff', borderWidth: 2 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '52%',
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              font: { size: 12, family: 'Inter, sans-serif' },
              color: '#374151',
              boxWidth: 12,
              padding: 8
            }
          },
          tooltip: {
            ...tooltipDefaults,
            callbacks: {
              label: ctx => ` ${fmtRevMM(ctx.parsed)} (${((ctx.parsed / ctx.dataset.data.reduce((a,b)=>a+b,0))*100).toFixed(1)}%)`
            }
          }
        }
      }
    });
  }
}

function catSortBy(col) {
  if (catSortCol === col) {
    catSortDir = catSortDir === 'desc' ? 'asc' : 'desc';
  } else {
    catSortCol = col;
    catSortDir = col === 'name' ? 'asc' : 'desc';
  }
  renderCatOverview();
}

// ── Category detail (sub-categories) ─────────────────────────

function showCategoryDetail(catName) {
  destroyCatCharts();
  subcatFilterVal = '';

  const catMap = buildCategoryMap();
  const cat    = catMap[catName];
  if (!cat) return;

  const subcatList = Object.values(cat.subcats).map(sub => {
    const rev  = sub.items.reduce((s, i) => s + (parseFloat(i.RAW_AMT_90D) || 0), 0);
    const qty  = sub.items.reduce((s, i) => s + (parseFloat(i.RAW_QTY_90D) || 0), 0);
    const vel  = sub.items.reduce((s, i) => s + (parseFloat(i.PCT_RECENT)  || 0), 0) / sub.items.length;
    // 30D revenue: estimated as 90D / 3
    const rev30 = rev / 3;
    const normKey = `${catName}|${sub.name}`;
    const norm    = normalityMap[normKey];
    return { name: sub.name, items: sub.items, itemCount: sub.items.length, rev, qty, vel, rev30, norm };
  });

  const catRev   = subcatList.reduce((s, c) => s + c.rev, 0);
  const catRev30 = subcatList.reduce((s, c) => s + c.rev30, 0);

  subcatList.sort((a, b) => {
    const dir = subcatSortDir === 'asc' ? 1 : -1;
    switch (subcatSortCol) {
      case 'name':    return dir * a.name.localeCompare(b.name);
      case 'items':   return dir * (a.itemCount - b.itemCount);
      case 'qty':     return dir * (a.qty - b.qty);
      case 'revenue': return dir * (a.rev - b.rev);
      case 'qty30':   return dir * (a.qty - b.qty);
      case 'rev30':   return dir * (a.rev30 - b.rev30);
      case 'vel':     return dir * (a.vel - b.vel);
      default:        return dir * (a.rev - b.rev);
    }
  });

  document.getElementById('cat-view-content').innerHTML = `
    <div class="cat-nav-breadcrumb">
      <a class="cat-back-link" onclick="renderCatOverview()">← All Categories</a>
      <span style="color:#9ca3af;margin:0 8px">/</span>
      <span style="color:#1a2332;font-weight:600">${catName} (${cat.items.length.toLocaleString()} items)</span>
    </div>
    <div class="cat-stat-bar">
      <div class="cat-stat-item"><span class="cat-stat-lbl">Sub-categories:</span><span class="cat-stat-val">${subcatList.length}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Total Items:</span><span class="cat-stat-val">${cat.items.length.toLocaleString()}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">90D Revenue:</span><span class="cat-stat-val">${fmtRevMM(catRev)}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">30D Revenue:</span><span class="cat-stat-val">${fmtRevMM(catRev30)}</span></div>
    </div>
    <input class="subcat-filter-input" id="subcat-filter" placeholder="Filter sub-categories…"
           oninput="filterSubcatTable(this.value)" value="${subcatFilterVal}">
    <div class="inv-wrap" style="margin-top:8px">
      <table class="data-table" id="subcat-detail-table">
        <thead><tr>${buildSubcatThead(catName)}</tr></thead>
        <tbody id="subcat-detail-tbody">${buildSubcatTbody(subcatList, catName)}</tbody>
      </table>
    </div>`;
}

function buildSubcatThead(catName) {
  const cols = [
    { key: '',        label: '' },
    { key: 'name',    label: 'Sub-Category' },
    { key: 'items',   label: 'Items',        cls: 'num-ctr' },
    { key: 'qty',     label: '90D Qty',      cls: 'num-ctr' },
    { key: 'revenue', label: '90D Revenue',  cls: 'num-ctr' },
    { key: 'qty30',   label: '30D Qty',      cls: 'num-ctr' },
    { key: 'rev30',   label: '30D Revenue',  cls: 'num-ctr' },
    { key: 'vel',     label: 'Avg Velocity', cls: 'num-ctr' },
    { key: '',        label: 'Normal?',      cls: 'num-ctr' },
  ];
  return cols.map(c => {
    if (!c.key) return `<th${c.cls ? ` class="${c.cls}"` : ''}>${c.label}</th>`;
    const active = subcatSortCol === c.key;
    const icon   = active ? (subcatSortDir === 'asc' ? '▲' : '▼') : '⇅';
    const cls    = [c.cls || '', 'sort-th', active ? 'sort-active' : ''].filter(Boolean).join(' ');
    return `<th class="${cls}" onclick="subcatDetailSortBy('${catName.replace(/'/g, "\\'")}','${c.key}')">${c.label}<span class="sort-icon">${icon}</span></th>`;
  }).join('');
}

function buildSubcatTbody(subcatList, catName) {
  return subcatList.map(sub => {
    const velCls    = sub.vel >= 35 ? 'vel-up' : sub.vel >= 25 ? 'vel-ss' : 'vel-down';
    const velArrow  = sub.vel >= 35 ? '↑' : sub.vel >= 25 ? '→' : '↓';
    const normBadge = sub.norm
      ? (sub.norm.NORMAL === 'Yes'
        ? '<span class="norm-badge norm-yes">Normal</span>'
        : '<span class="norm-badge norm-no">Non-normal</span>')
      : '<span style="color:#9ca3af;font-size:10px">—</span>';
    const safeId = (catName + '_' + sub.name).replace(/[^a-zA-Z0-9_]/g, '_');
    return `
      <tr class="subcat-header-row" data-subcat="${sub.name.toLowerCase()}" onclick="toggleSubcatAccordion('${safeId}', '${catName.replace(/'/g, "\\'")}', '${sub.name.replace(/'/g, "\\'")}')">
        <td style="width:28px;text-align:center"><span class="acc-toggle-btn" id="acc-btn-${safeId}">▶</span></td>
        <td><strong>${sub.name}</strong></td>
        <td class="num-ctr">${sub.itemCount}</td>
        <td class="num-ctr">${fmtQty(sub.qty)}</td>
        <td class="num-ctr">${fmtRevMM(sub.rev)}</td>
        <td class="num-ctr">${fmtQty(sub.qty / 3)}</td>
        <td class="num-ctr">${fmtRevMM(sub.rev30)}</td>
        <td class="num-ctr"><span class="${velCls}">${velArrow}</span> ${sub.vel.toFixed(1)}%</td>
        <td class="num-ctr">${normBadge}</td>
      </tr>
      <tr class="acc-expand-row" id="acc-row-${safeId}" style="display:none">
        <td colspan="9"><div class="acc-content" id="acc-content-${safeId}"></div></td>
      </tr>`;
  }).join('');
}

function filterSubcatTable(val) {
  subcatFilterVal = val;
  const q = val.trim().toLowerCase();
  document.querySelectorAll('#subcat-detail-tbody .subcat-header-row').forEach(row => {
    const name  = (row.dataset.subcat || '').toLowerCase();
    const show  = !q || name.includes(q);
    const safeId = row.querySelector('.acc-toggle-btn')?.id?.replace('acc-btn-', '');
    row.style.display = show ? '' : 'none';
    if (safeId) {
      const accRow = document.getElementById('acc-row-' + safeId);
      if (accRow) accRow.style.display = show && accRow.dataset.wasOpen ? '' : 'none';
    }
  });
}

function subcatDetailSortBy(catName, col) {
  if (subcatSortCol === col) {
    subcatSortDir = subcatSortDir === 'desc' ? 'asc' : 'desc';
  } else {
    subcatSortCol = col;
    subcatSortDir = col === 'name' ? 'asc' : 'desc';
  }
  showCategoryDetail(catName);
}

// ── Accordion: items within a sub-category ────────────────────

function toggleSubcatAccordion(safeId, catName, subcatName) {
  const row     = document.getElementById('acc-row-' + safeId);
  const btn     = document.getElementById('acc-btn-' + safeId);
  const content = document.getElementById('acc-content-' + safeId);
  if (!row) return;

  const isOpen = row.style.display !== 'none';
  if (isOpen) {
    row.style.display = 'none';
    delete row.dataset.wasOpen;
    btn.classList.remove('open');
  } else {
    row.style.display = '';
    row.dataset.wasOpen = '1';
    btn.classList.add('open');
    if (!content.dataset.built) {
      buildAccordionItems(content, catName, subcatName);
      content.dataset.built = '1';
    }
  }
}

const ACC_PAGE_SIZE = 50;

function buildAccordionItems(container, catName, subcatName) {
  const items = pipelineData.filter(
    i => i.CATEG_COD === catName && i.SUBCAT_COD === subcatName
  );

  const withPct = items.map(item => {
    const { pct } = computePercentile(item);
    return { item, pct };
  });

  withPct.sort((a, b) => b.pct - a.pct);

  // Store full sorted list on container for "show more"
  container._allRows = withPct;
  container._shownCount = 0;

  container.innerHTML = `
    <table class="items-inner-table">
      <thead>
        <tr>
          <th>Item #</th>
          <th>Name</th>
          <th class="num">Percentile</th>
          <th class="num">90D Qty</th>
          <th class="num">90D Revenue</th>
          <th class="num">Velocity</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="acc-tbody-${container.id}"></tbody>
    </table>
    <div id="acc-footer-${container.id}" class="acc-pagination-footer"></div>`;

  appendAccordionRows(container, ACC_PAGE_SIZE);
}

function makeAccordionRow({ item, pct }) {
  const pctR     = Math.round(pct * 10) / 10;
  const pctCls   = pct >= 75 ? 'pct-green' : pct >= 25 ? 'pct-yellow' : 'pct-red';
  const sparkCls = pct >= 75 ? 'spark-green' : pct >= 25 ? 'spark-yellow' : 'spark-red';
  const velCls   = (parseFloat(item.PCT_RECENT) || 0) >= 35 ? 'vel-up'
                 : (parseFloat(item.PCT_RECENT) || 0) >= 25 ? 'vel-ss' : 'vel-down';
  const velArrow = (parseFloat(item.PCT_RECENT) || 0) >= 35 ? '↑'
                 : (parseFloat(item.PCT_RECENT) || 0) >= 25 ? '→' : '↓';
  const status   = (item.STATUS || '').trim().toUpperCase();
  const stsCls   = status === 'ACTIVE' ? 'sts-active' : status === 'OUT OF STOCK' ? 'sts-oos' : 'sts-ns';
  const stsLbl   = status === 'ACTIVE' ? 'Active' : status === 'OUT OF STOCK' ? 'OOS' : 'Not Selling';
  return `<tr onclick="zoomToItem('${(item.ITEM_NO||'').replace(/'/g,"\\'")}')">
    <td><a class="item-link" title="Open in Item Zoom">${item.ITEM_NO || '—'}</a></td>
    <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis">${item.ITEM_NAME || '—'}</td>
    <td class="num">
      <span class="pct-badge ${pctCls}" style="font-size:14px;font-weight:700">${pctR}%</span>
      <div class="pct-spark"><div class="pct-spark-fill ${sparkCls}" style="width:${Math.min(100, pctR)}%"></div></div>
    </td>
    <td class="num">${fmtQty(item.RAW_QTY_90D)}</td>
    <td class="num">${fmt$(item.RAW_AMT_90D)}</td>
    <td class="num"><span class="${velCls}">${velArrow}</span> ${parseFloat(item.PCT_RECENT)||0}%</td>
    <td><span class="${stsCls}">${stsLbl}</span></td>
  </tr>`;
}

function appendAccordionRows(container, count) {
  const all    = container._allRows;
  const start  = container._shownCount;
  const end    = Math.min(start + count, all.length);
  const tbody  = document.getElementById('acc-tbody-' + container.id);
  const footer = document.getElementById('acc-footer-' + container.id);
  if (!tbody) return;

  const chunk = all.slice(start, end).map(makeAccordionRow).join('');
  tbody.insertAdjacentHTML('beforeend', chunk);
  container._shownCount = end;

  const remaining = all.length - end;
  if (footer) {
    if (remaining > 0) {
      footer.innerHTML = `<div class="acc-pagination-bar">
        Showing <strong>${end}</strong> of <strong>${all.length}</strong> items &nbsp;·&nbsp;
        <button class="btn btn-ghost btn-sm" onclick="appendAccordionRows(this.closest('.acc-content'), ${ACC_PAGE_SIZE})">Show next ${Math.min(ACC_PAGE_SIZE, remaining)}</button>
        &nbsp;
        <button class="btn btn-ghost btn-sm" onclick="appendAccordionRows(this.closest('.acc-content'), ${all.length})">Load all</button>
      </div>`;
    } else {
      footer.innerHTML = `<div class="acc-pagination-bar" style="color:#9ca3af">Showing all <strong>${all.length}</strong> items</div>`;
    }
  }
}

// ── Navigate to item zoom from category ───────────────────────

function zoomToItem(itemNo) {
  switchTab('item');
  document.getElementById('item-search').value = itemNo;
  doSearch();
}

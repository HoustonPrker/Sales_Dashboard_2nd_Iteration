// ============================================================
// ORDER DETAIL VIEW
// Route: #/customer/{custNo}/order/{ticketNo}
// ============================================================

let odFilter = 'all';                        // 'all' | 'best' | 'new' | 'repeat'
let odSort   = { col: 'ext', dir: 'desc' };  // col: 'item'|'cat'|'desc'|'qty'|'unit'|'ext'|'margin'
let odSearch = '';
let odCurrentLines = [];
const odCharts = {};    // Chart.js instances

async function loadOrderDetail(custNo, ticketNo) {
  if (typeof switchTab === 'function') switchTab('item');

  const panel = document.getElementById('customer-account-panel');
  if (!panel) return;

  window.location.hash = `#/customer/${encodeURIComponent(custNo)}/order/${encodeURIComponent(ticketNo)}`;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;padding:60px;color:#6b7280;font-size:15px">
      Loading order <strong style="margin-left:6px;color:#3d5a80">#${ticketNo}</strong>…
    </div>`;

  try {
    const [orderRes, custRes] = await Promise.all([
      fetch(`/proxy/order-detail/${encodeURIComponent(ticketNo)}?custNo=${encodeURIComponent(custNo)}`),
      fetch(`/proxy/customer/${encodeURIComponent(custNo)}`),
    ]);
    const order = orderRes.ok ? await orderRes.json() : {};
    const cust  = custRes.ok  ? await custRes.json()  : {};
    renderOrderDetail(custNo, cust, order);
  } catch (e) {
    const p = document.getElementById('customer-account-panel');
    if (p) p.innerHTML = `<div style="padding:40px;color:#dc2626">Error loading order: ${e.message}</div>`;
  }
}

function renderOrderDetail(custNo, cust, order) {
  const panel = document.getElementById('customer-account-panel');
  if (!panel) return;

  // Destroy any existing Chart.js instances
  ['od-bs-chart', 'od-nr-chart'].forEach(id => {
    if (odCharts[id]) { try { odCharts[id].destroy(); } catch (_) {} delete odCharts[id]; }
  });

  odFilter = 'all'; odSort = { col: 'ext', dir: 'desc' }; odSearch = '';

  const custName = cust.name || order.custName || custNo;
  const ticketNo = order.ticketNo || '—';
  const date     = order.date     || '—';
  const rep      = order.rep      || cust.salesRep || '—';
  const storeNo  = order.storeNo  || '';
  const lines    = order.lines    || [];

  odCurrentLines = lines;

  const fmt$ = n => {
    const abs = Math.abs(n);
    const s   = abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + '$' + s;
  };
  const fmtPct = n => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

  // ── KPI calculations ─────────────────────────────────────────
  const lineCount   = lines.length;
  const totQty      = lines.reduce((s, l) => s + l.qty, 0);
  const totExt      = lines.reduce((s, l) => s + l.extPrice, 0);
  const margin      = lines.reduce((s, l) => s + (l.unitPrice - l.unitCost) * l.qty, 0);
  const marginPct   = totExt > 0 ? (margin / totExt * 100) : 0;
  const avgLine     = lineCount > 0 ? totExt / lineCount : 0;
  const priorTotal  = parseFloat(order.priorOrderTotal || 0);
  const vsPriorPct  = priorTotal > 0 ? ((totExt - priorTotal) / priorTotal * 100) : null;

  // ── Composition counts ───────────────────────────────────────
  const bsLines     = lines.filter(l => l.isBestSeller);
  const repeatLines = lines.filter(l => l.isRepeat);
  const newLines    = lines.filter(l => !l.isRepeat);

  // ── Breadcrumb ───────────────────────────────────────────────
  const custSafe = custNo.replace(/'/g, "\\'");
  const breadcrumb = `
    <div class="od-no-print" style="display:flex;align-items:center;gap:6px;font-size:13px;color:#6b7280;margin-bottom:12px;flex-wrap:wrap">
      <a onclick="loadCustomerAccount('${custSafe}');return false;" href="#"
         style="color:#3d5a80;font-weight:600;text-decoration:none"
         onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">
        ← Customer Account
      </a>
      <span>·</span>
      <a onclick="loadCustomerAccount('${custSafe}');return false;" href="#"
         style="color:#3d5a80;font-weight:600;text-decoration:none"
         onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">
        ${custName}
      </a>
      <span>·</span>
      <span style="color:#1a2332;font-weight:600">Order ${ticketNo}</span>
    </div>`;

  const kpiTile = (label, value, sub) => `
    <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:10px 12px">
      <div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#fff;margin-bottom:4px;font-weight:600">${label}</div>
      <div style="font-size:19px;font-weight:600;color:#fff;line-height:1.2">${value}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.8);margin-top:2px">${sub}</div>
    </div>`;

  const vsPriorValue = vsPriorPct !== null
    ? `<span style="color:${vsPriorPct >= 0 ? '#86efac' : '#fca5a5'}">${fmtPct(vsPriorPct)}</span>`
    : '<span style="color:rgba(255,255,255,0.4)">—</span>';
  const vsPriorSub = vsPriorPct !== null
    ? `${fmt$(totExt)} vs ${fmt$(priorTotal)}`
    : 'no prior order found';

  const bsPct    = lineCount > 0 ? Math.round(bsLines.length / lineCount * 100) : 0;
  const repPct   = lineCount > 0 ? Math.round(repeatLines.length / lineCount * 100) : 0;

  const donutCard = (id, title, rows) => `
    <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:14px 16px;display:grid;grid-template-columns:1fr auto;align-items:center;gap:14px;min-width:250px">
      <div>
        <div style="font-family:ui-monospace,monospace;font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:#fff;margin-bottom:8px;font-weight:600">${title}</div>
        <div style="display:flex;flex-direction:column;gap:5px">
          ${rows.map(r => `
          <div style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:rgba(255,255,255,0.92)">
            <span style="width:10px;height:10px;border-radius:2px;background:${r.color};display:inline-block;flex-shrink:0"></span>
            <span style="flex:1">${r.label}</span>
            <span style="font-family:ui-monospace,monospace;font-size:10.5px;color:#fff">${r.pct}%</span>
          </div>`).join('')}
        </div>
      </div>
      <div id="${id}-wrap" style="width:130px;height:130px;flex-shrink:0;position:relative">
        <canvas id="${id}" width="130" height="130"></canvas>
      </div>
    </div>`;

  // ── Combined header — flex: left cluster + right cluster ─────
  const header = `
    <div id="od-header" class="mgr-panel" style="margin-bottom:12px;display:flex;align-items:stretch;gap:18px">

      <!-- Left cluster: identity + KPI grid (flex:1 so it fills space before donuts) -->
      <div style="flex:1;display:flex;gap:18px;align-items:stretch">

        <!-- Identity col -->
        <div style="display:flex;flex-direction:column;justify-content:space-between;min-width:210px">
          <div>
            <div style="font-family:ui-monospace,monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:3px">Order</div>
            <div style="font-size:26px;font-weight:800;color:#fff;line-height:1">#${ticketNo}</div>
            <div style="margin-top:10px;display:flex;flex-direction:column;gap:4px">
              <div style="display:flex;gap:6px;align-items:baseline">
                <span style="font-size:10px;color:rgba(255,255,255,0.45);width:30px;flex-shrink:0">Date</span>
                <span style="font-size:13px;color:#fff;font-weight:500">${date}</span>
              </div>
              <div style="display:flex;gap:6px;align-items:baseline">
                <span style="font-size:10px;color:rgba(255,255,255,0.45);width:30px;flex-shrink:0">Cust</span>
                <span style="font-size:13px;color:#fff;font-weight:500;line-height:1.3">${custName}</span>
              </div>
              <div style="display:flex;gap:6px;align-items:baseline">
                <span style="font-size:10px;color:rgba(255,255,255,0.45);width:30px;flex-shrink:0">Rep</span>
                <span style="font-size:13px;color:#fff;font-weight:500">${rep}</span>
              </div>
              ${storeNo ? `<div style="display:flex;gap:6px;align-items:baseline">
                <span style="font-size:10px;color:rgba(255,255,255,0.45);width:30px;flex-shrink:0">Store</span>
                <span style="font-size:13px;color:#fff;font-weight:500">${storeNo}</span>
              </div>` : ''}
            </div>
          </div>
          <div class="od-no-print" style="display:flex;gap:7px;margin-top:12px">
            <button onclick="orderDetailExportCsv()" style="background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.22);color:#fff;border-radius:6px;padding:5px 11px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;transition:background 0.15s"
              onmouseover="this.style.background='rgba(255,255,255,0.22)'" onmouseout="this.style.background='rgba(255,255,255,0.12)'">Export CSV</button>
            <button onclick="orderDetailPrint()" style="background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.22);color:#fff;border-radius:6px;padding:5px 11px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;transition:background 0.15s"
              onmouseover="this.style.background='rgba(255,255,255,0.22)'" onmouseout="this.style.background='rgba(255,255,255,0.12)'">Print</button>
          </div>
        </div>

        <!-- KPI tiles 3×2 — flex:1 spreads tiles across available width -->
        <div id="od-kpi-grid" style="flex:1;display:flex;flex-direction:column;gap:10px;justify-content:center">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
            ${kpiTile('Order Total', fmt$(totExt), 'post-discount')}
            ${kpiTile('Profit', fmt$(margin), marginPct.toFixed(1) + '% of order')}
            ${kpiTile('vs Prior Order', vsPriorValue, vsPriorSub)}
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
            ${kpiTile('Lines', lineCount.toLocaleString(), 'unique items')}
            ${kpiTile('Units', totQty.toLocaleString(), 'total qty')}
            ${kpiTile('Avg Line', fmt$(avgLine), 'revenue per line')}
          </div>
        </div>

      </div><!-- end left cluster -->

      <!-- Right cluster: two donut cards side-by-side -->
      ${lineCount > 0 ? `
      <div class="od-no-print" style="flex-shrink:0;display:flex;gap:14px;align-items:center">
        ${donutCard('od-bs-chart', 'Best-Seller Mix', [
          { color: '#fbbf24', label: 'Best sellers', pct: bsPct },
          { color: '#64748b', label: 'Other',        pct: 100 - bsPct },
        ])}
        ${donutCard('od-nr-chart', 'New vs Repeat', [
          { color: '#10b981', label: 'Repeat', pct: repPct },
          { color: '#cbd5e1', label: 'New',    pct: 100 - repPct },
        ])}
      </div>` : ''}

    </div>`;

  // ── Filter toolbar ───────────────────────────────────────────
  const chipStyle = (active) =>
    `display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid ${active ? '#3d5a80' : '#d1d5db'};background:${active ? '#3d5a80' : '#fff'};color:${active ? '#fff' : '#374151'};transition:all 0.12s;font-family:inherit`;

  const toolbar = `
    <div id="od-toolbar" class="od-no-print" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;padding:0 2px">
      <input id="od-search" type="text" placeholder="Filter items by name, item #, or category…"
        oninput="odApplyFilter()"
        style="flex:1;min-width:160px;max-width:280px;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit;color:#1a2332;outline:none">
      <button id="od-chip-all"    onclick="odSetFilter('all')"    style="${chipStyle(true)}">All (${lineCount})</button>
      <button id="od-chip-best"   onclick="odSetFilter('best')"   style="${chipStyle(false)}">★ Best Sellers (${bsLines.length})</button>
      <button id="od-chip-new"    onclick="odSetFilter('new')"    style="${chipStyle(false)}">+ New (${newLines.length})</button>
      <button id="od-chip-repeat" onclick="odSetFilter('repeat')" style="${chipStyle(false)}">↻ Repeat (${repeatLines.length})</button>
      <span id="od-row-count" style="font-size:12px;color:#9ca3af;margin-left:auto;white-space:nowrap">showing ${lineCount} of ${lineCount}</span>
    </div>`;

  // ── Line items table ─────────────────────────────────────────
  const tableWrap = `
    <div class="card" style="padding:0">
      <div style="padding:14px 16px 10px;border-bottom:1px solid #f3f4f6;flex-shrink:0">
        <div style="font-size:14px;font-weight:700;color:#1a2332">Line Items <span style="font-weight:400;color:#9ca3af;font-size:12px">(${lineCount} lines · ${fmt$(totExt)} total)</span></div>
      </div>
      ${toolbar}
      <div class="inv-wrap" id="od-table-wrap">
        ${odBuildTable(lines, lines, fmt$)}
      </div>
    </div>`;

  panel.innerHTML = breadcrumb + header + tableWrap;
  panel._orderData = { custName, ticketNo, date, rep, lines, total: totExt, margin };

  if (lineCount > 0) {
    requestAnimationFrame(() => {
      odRenderCompositionCharts(bsLines.length, lineCount, repeatLines.length, newLines.length);
    });
  }
}

// ── Chart.js donut charts (matches accounts/customer-account style) ──

function odRenderCompositionCharts(bsCount, totalCount, repeatCount, newCount) {
  // Map chart slice index → odSetFilter key
  const BS_FILTER_MAP = ['best', 'all'];   // index 0 = Best Sellers, 1 = Other
  const NR_FILTER_MAP = ['repeat', 'new']; // index 0 = Repeat, 1 = New

  function makeChartOpts(filterMap) {
    return {
      responsive: false,
      maintainAspectRatio: false,
      cutout: '60%',
      width: 130,
      height: 130,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${ctx.parsed} lines (click to filter)`,
          },
        },
      },
      onClick(event, elements) {
        if (!elements.length) return;
        const key = filterMap[elements[0].index];
        if (key) odSetFilter(odFilter === key ? 'all' : key); // toggle off if already active
      },
      onHover(event, elements) {
        event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
      },
    };
  }

  const bsCtx = document.getElementById('od-bs-chart');
  if (bsCtx) {
    if (odCharts['od-bs-chart']) { try { odCharts['od-bs-chart'].destroy(); } catch (_) {} }
    odCharts['od-bs-chart'] = new Chart(bsCtx.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Best Sellers', 'Other Items'],
        datasets: [{
          data: [bsCount, totalCount - bsCount],
          backgroundColor: ['#fbbf24', '#64748b'],
          borderColor: '#ffffff',
          borderWidth: 3,
        }],
      },
      options: makeChartOpts(BS_FILTER_MAP),
    });
  }

  const nrCtx = document.getElementById('od-nr-chart');
  if (nrCtx) {
    if (odCharts['od-nr-chart']) { try { odCharts['od-nr-chart'].destroy(); } catch (_) {} }
    odCharts['od-nr-chart'] = new Chart(nrCtx.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Repeat (12mo)', 'New Items'],
        datasets: [{
          data: [repeatCount, newCount],
          backgroundColor: ['#34d399', '#60a5fa'],
          borderColor: '#ffffff',
          borderWidth: 3,
        }],
      },
      options: makeChartOpts(NR_FILTER_MAP),
    });
  }
}

// ── Table builder (used on initial render and re-filter) ──────

function odBuildTable(allLines, visibleLines, fmt$Fn) {
  const f = fmt$Fn || (n => {
    const abs = Math.abs(n);
    const s   = abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + '$' + s;
  });

  const stickyTd = 'position:sticky;bottom:0;z-index:2;background:#f8fafc;border-top:2px solid #e5e7eb;font-weight:700;box-shadow:0 -2px 4px rgba(0,0,0,0.06)';
  const totQty    = visibleLines.reduce((s, l) => s + l.qty, 0);
  const totExt    = visibleLines.reduce((s, l) => s + l.extPrice, 0);
  const totMargin = visibleLines.reduce((s, l) => s + (l.unitPrice - l.unitCost) * l.qty, 0);

  const tagPill = (label, bg, color) =>
    `<span style="background:${bg};color:${color};padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap">${label}</span>`;

  const tableRows = visibleLines.map(l => {
    const lineMargin    = (l.unitPrice - l.unitCost) * l.qty;
    const lineMarginPct = l.extPrice > 0 ? (lineMargin / l.extPrice * 100) : null;
    const tags = [];
    if (l.isBestSeller) tags.push(tagPill('★ Best',   '#fde68a', '#92400e'));
    if (l.isRepeat)     tags.push(tagPill('↻ Repeat', '#99f6e4', '#0f766e'));
    else if (l.isRepeat !== undefined) tags.push(tagPill('+ New', '#bfdbfe', '#1e40af'));
    return `<tr>
      <td style="padding:8px 12px;min-width:80px;text-align:center">
        <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center">${tags.join('') || ''}</div>
      </td>
      <td style="padding:8px 12px;font-size:12px;color:#6b7280;white-space:nowrap;text-align:center">${l.category || '—'}</td>
      <td style="padding:8px 12px;font-size:13px">${l.description || '—'}</td>
      <td style="padding:8px 12px;font-family:monospace;font-size:12px;font-weight:600;color:#3d5a80;white-space:nowrap;text-align:center">${l.itemNo}</td>
      <td class="num-ctr" style="padding:8px 12px;font-size:13px">${l.qty}</td>
      <td class="num-ctr" style="padding:8px 12px;font-size:13px;color:#6b7280">${l.unitPrice > 0 ? f(l.unitPrice) : '—'}</td>
      <td class="num-ctr" style="padding:8px 12px;font-size:13px;font-weight:600">${l.extPrice > 0 ? f(l.extPrice) : '—'}</td>
      <td class="num-ctr" style="padding:8px 12px;font-size:13px;color:#1a2332">${l.unitCost > 0 ? f(lineMargin) : '—'}</td>
      <td class="num-ctr" style="padding:8px 12px;font-size:13px;color:#1a2332">${lineMarginPct !== null && l.unitCost > 0 ? lineMarginPct.toFixed(1) + '%' : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" style="padding:24px;color:#9ca3af;text-align:center">No matching items.</td></tr>';

  // Sortable header helper — shows active column + direction indicator
  const thStyle = 'cursor:pointer;user-select:none;white-space:nowrap;';
  const thHover = `onmouseover="this.style.color='#3d5a80'" onmouseout="this.style.color=''"`;
  const arrow = (col) => {
    if (odSort.col !== col) return ' <span style="color:#d1d5db;font-size:10px">⇅</span>';
    return odSort.dir === 'asc'
      ? ' <span style="color:#3d5a80;font-size:10px">▲</span>'
      : ' <span style="color:#3d5a80;font-size:10px">▼</span>';
  };
  const th = (col, label, extraClass = '') =>
    `<th class="${extraClass}" style="${thStyle}" onclick="odSortBy('${col}')" ${thHover}>${label}${arrow(col)}</th>`;

  const totMarginPct = totExt > 0 ? (totMargin / totExt * 100) : null;
  const totMarginColor = totMargin >= 0 ? '#059669' : '#dc2626';

  return `<table class="data-table">
    <thead style="position:sticky;top:0;z-index:2;background:#fff">
      <tr>
        <th style="text-align:center">Tags</th>
        ${th('cat',  'Category', 'num-ctr')}
        ${th('desc', 'Description')}
        ${th('item', 'Item #',   'num-ctr')}
        ${th('qty',    'Qty',      'num-ctr')}
        ${th('unit',   'Unit $',   'num-ctr')}
        ${th('ext',    'Ext $',    'num-ctr')}
        ${th('margin', 'Margin $', 'num-ctr')}
        ${th('marginPct', 'Margin %', 'num-ctr')}
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
    <tfoot>
      <tr>
        <td colspan="4" style="${stickyTd};padding:10px 12px;color:#1a2332">Total · ${visibleLines.length} lines</td>
        <td class="num-ctr" style="${stickyTd};padding:10px 12px">${totQty}</td>
        <td style="${stickyTd};padding:10px 12px"></td>
        <td class="num-ctr" style="${stickyTd};padding:10px 12px">${f(totExt)}</td>
        <td class="num-ctr" style="${stickyTd};padding:10px 12px;color:#1a2332">${totMargin !== 0 ? f(totMargin) : '—'}</td>
        <td class="num-ctr" style="${stickyTd};padding:10px 12px;color:#1a2332">${totMarginPct !== null ? totMarginPct.toFixed(1) + '%' : '—'}</td>
      </tr>
    </tfoot>
  </table>`;
}

// ── Filter / sort logic ───────────────────────────────────────

function odSetFilter(f) {
  odFilter = f;
  ['all', 'best', 'new', 'repeat'].forEach(id => {
    const btn = document.getElementById(`od-chip-${id}`);
    if (!btn) return;
    const active = id === f;
    btn.style.background  = active ? '#3d5a80' : '#fff';
    btn.style.color       = active ? '#fff'    : '#374151';
    btn.style.borderColor = active ? '#3d5a80' : '#d1d5db';
  });
  odApplyFilter();
}

function odSortBy(col) {
  if (odSort.col === col) {
    odSort.dir = odSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    // sensible default direction per column
    odSort = { col, dir: ['item','cat','desc'].includes(col) ? 'asc' : 'desc' };
  }
  odApplyFilter();
}

function odApplyFilter() {
  const searchEl = document.getElementById('od-search');
  if (searchEl) odSearch = searchEl.value.toLowerCase();

  let list = odCurrentLines.slice();

  // Chip filter
  if (odFilter === 'best')   list = list.filter(l => l.isBestSeller);
  if (odFilter === 'new')    list = list.filter(l => l.isRepeat === false);
  if (odFilter === 'repeat') list = list.filter(l => l.isRepeat === true);

  // Text search
  if (odSearch) {
    list = list.filter(l =>
      (l.itemNo      || '').toLowerCase().includes(odSearch) ||
      (l.category    || '').toLowerCase().includes(odSearch) ||
      (l.description || '').toLowerCase().includes(odSearch)
    );
  }

  // Column sort
  const { col, dir } = odSort;
  const sign = dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    switch (col) {
      case 'item':   return sign * (a.itemNo || '').localeCompare(b.itemNo || '');
      case 'cat':    return sign * (a.category || '').localeCompare(b.category || '');
      case 'desc':   return sign * (a.description || '').localeCompare(b.description || '');
      case 'qty':    return sign * (a.qty - b.qty);
      case 'unit':   return sign * (a.unitPrice - b.unitPrice);
      case 'ext':    return sign * (a.extPrice - b.extPrice);
      case 'margin': {
        const mA = (a.unitPrice - a.unitCost) * a.qty;
        const mB = (b.unitPrice - b.unitCost) * b.qty;
        return sign * (mA - mB);
      }
      case 'marginPct': {
        const pA = a.extPrice > 0 ? (a.unitPrice - a.unitCost) * a.qty / a.extPrice : 0;
        const pB = b.extPrice > 0 ? (b.unitPrice - b.unitCost) * b.qty / b.extPrice : 0;
        return sign * (pA - pB);
      }
      default: return 0;
    }
  });

  const wrap = document.getElementById('od-table-wrap');
  if (wrap) wrap.innerHTML = odBuildTable(odCurrentLines, list);

  const rc = document.getElementById('od-row-count');
  if (rc) rc.textContent = `showing ${list.length} of ${odCurrentLines.length}`;
}

// ── Utility functions ─────────────────────────────────────────

function orderDetailPrint() {
  window.print();
}

function orderDetailToast(msg) {
  let t = document.getElementById('od-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'od-toast';
    t.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#1a2332;color:#fff;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:600;z-index:9999;opacity:0;transition:opacity 0.2s;pointer-events:none';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._hide);
  t._hide = setTimeout(() => { t.style.opacity = '0'; }, 2400);
}

function orderDetailExportCsv() {
  const panel = document.getElementById('customer-account-panel');
  const d = panel && panel._orderData;
  if (!d || typeof XLSX === 'undefined') return;

  const headers = ['Category', 'Description', 'Item #', 'Qty', 'Unit $', 'Ext $', 'Profit $', 'Profit %'];

  const dataRows = (d.lines || []).map(l => {
    const profit    = (l.unitPrice - l.unitCost) * l.qty;
    const profitPct = l.extPrice > 0 ? +(profit / l.extPrice * 100).toFixed(1) : null;
    return [
      l.category    || '',
      l.description || '',
      l.itemNo      || '',
      l.qty         || 0,
      l.unitPrice   > 0 ? +l.unitPrice.toFixed(2) : '',
      l.extPrice    > 0 ? +l.extPrice.toFixed(2)  : '',
      l.unitCost    > 0 ? +profit.toFixed(2)       : '',
      profitPct     !== null && l.unitCost > 0 ? profitPct / 100 : '',
    ];
  });

  const XS = typeof XLSXStyle !== 'undefined' ? XLSXStyle : XLSX;

  const ws = XS.utils.aoa_to_sheet([headers, ...dataRows]);

  // Header row style — bold, light grey fill
  const headerStyle = {
    font:      { bold: true },
    fill:      { fgColor: { rgb: 'D0D0D0' }, patternType: 'solid' },
    alignment: { horizontal: 'center' },
  };
  headers.forEach((_, ci) => {
    const addr = XS.utils.encode_cell({ r: 0, c: ci });
    if (ws[addr]) ws[addr].s = headerStyle;
  });

  // Format Profit % column (col index 7) as percentage
  dataRows.forEach((_, ri) => {
    const addr = XS.utils.encode_cell({ r: ri + 1, c: 7 });
    if (ws[addr] && ws[addr].v !== '') ws[addr].z = '0.0%';
  });

  // Auto-fit column widths based on max character length
  const allRows = [headers, ...dataRows];
  ws['!cols'] = headers.map((_, ci) => {
    const maxLen = allRows.reduce((max, row) => {
      const v = row[ci] == null ? '' : String(row[ci]);
      return Math.max(max, v.length);
    }, 10);
    return { wch: Math.min(maxLen + 2, 60) };
  });

  const wb = XS.utils.book_new();
  XS.utils.book_append_sheet(wb, ws, `Order ${d.ticketNo}`);
  XS.writeFile(wb, `Order-${d.ticketNo}.xlsx`);
}

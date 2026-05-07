// ============================================================
// ACCOUNT PERFORMANCE VIEW
// Uses globals: accountsData, dataReady
// Registered as the 'store' tab — renderStoreView() is called by app.js
// ============================================================

let acctSortCol    = 'ytdSales', acctSortDir = 'desc';
let acctTierFilter = 'All';
let acctRepFilter  = 'All';
let acctViewCharts = {};

const HEALTH_COLORS = {
  Healthy:   '#059669',
  Attention: '#d97706',
  AtRisk:    '#ea580c',
  Critical:  '#dc2626',
};

const acctTooltipDefaults = {
  backgroundColor: '#fff',
  titleColor:      '#1a2332',
  bodyColor:       '#374151',
  borderColor:     '#e5e7eb',
  borderWidth:     1,
  padding:         10,
  titleFont: { family: 'Inter, sans-serif', size: 12, weight: '600' },
  bodyFont:  { family: 'Inter, sans-serif', size: 12 },
};

// ── Entry points (called by app.js) ──────────────────────────

function renderStoreView() {
  if (!dataReady) return;
  renderAccountsOverview();
}

function destroyStoreCharts() {
  Object.values(acctViewCharts).forEach(c => { try { c.destroy(); } catch (_) {} });
  acctViewCharts = {};
}

// ── Overview ──────────────────────────────────────────────────

function renderAccountsOverview() {
  destroyStoreCharts();

  const byRep = accountsData || [];

  // KPIs
  const total        = byRep.length;
  const totalYtd     = byRep.reduce((s, a) => s + a.ytdSales,   0);
  const behindTarget = byRep.filter(a => a.ytdSales < a.target && a.target > 0).length;
  const noOrders30   = byRep.filter(a => a.daysSinceOrder >= 30).length;
  const growing      = byRep.filter(a => a.ytdSales > a.priorYtd && a.priorYtd > 0).length;
  const declining    = byRep.filter(a => a.ytdSales < a.priorYtd && a.priorYtd > 0).length;

  const tierCounts = { All: byRep.length, Healthy: 0, Attention: 0, AtRisk: 0, Critical: 0 };
  byRep.forEach(a => tierCounts[a.tier] = (tierCounts[a.tier] || 0) + 1);

  // Apply tier filter then sort
  let list = acctTierFilter === 'All' ? byRep : byRep.filter(a => a.tier === acctTierFilter);
  list = [...list].sort((a, b) => {
    const dir = acctSortDir === 'asc' ? 1 : -1;
    const pctChange = x => x.priorYtd > 0 ? (x.ytdSales - x.priorYtd) / x.priorYtd : -1;
    switch (acctSortCol) {
      case 'name':        return dir * (a.name || '').localeCompare(b.name || '');
      case 'custNo':      return dir * (a.custNo || '').localeCompare(b.custNo || '');
      case 'state':       return dir * (a.state || '').localeCompare(b.state || '');
      case 'tier':        return dir * (a.tier || '').localeCompare(b.tier || '');
      case 'ytdSales':    return dir * (a.ytdSales    - b.ytdSales);
      case 'target':      return dir * (a.target      - b.target);
      case 'pctToTarget': return dir * (a.pctToTarget - b.pctToTarget);
      case 'priorYtd':    return dir * (a.priorYtd    - b.priorYtd);
      case 'pctChange':   return dir * (pctChange(a)  - pctChange(b));
      case 'daysSince':   return dir * (a.daysSinceOrder - b.daysSinceOrder);
      case 'lastOrder':   return dir * (a.lastOrderDate || '').localeCompare(b.lastOrderDate || '');
      default:            return dir * (a.ytdSales - b.ytdSales);
    }
  });

  // ── Tier filter buttons ───────────────────────────────────────
  const tierBtn = tier => {
    const active = acctTierFilter === tier;
    const count  = tierCounts[tier] || 0;
    const label  = tier === 'All' ? `All (${count})` : `${tier.replace('AtRisk', 'At Risk')} (${count})`;
    return `<button class="tier-filter-btn${active ? ' active' : ''}" onclick="setAcctTierFilter('${tier}')">${label}</button>`;
  };

  // ── Table ─────────────────────────────────────────────────────
  const cols = [
    { key: 'name',        label: 'Customer Name' },
    { key: 'custNo',      label: 'Acct #',             cls: 'num-ctr' },
    { key: 'state',       label: 'State',               cls: 'num-ctr' },
    { key: 'tier',        label: 'Tier',                cls: 'num-ctr' },
    { key: 'ytdSales',    label: 'YTD Sales',           cls: 'num-ctr' },
    { key: 'target',      label: 'Target',              cls: 'num-ctr' },
    { key: 'pctToTarget', label: '% to Target',         cls: 'num-ctr' },
    { key: 'priorYtd',    label: 'Prior YTD',           cls: 'num-ctr' },
    { key: 'pctChange',   label: '% Change',            cls: 'num-ctr' },
    { key: 'daysSince',   label: 'Days Since Order',    cls: 'num-ctr' },
    { key: 'lastOrder',   label: 'Last Order Date',     cls: 'num-ctr' },
  ];

  const thead = cols.map(c => {
    const active = acctSortCol === c.key;
    const icon   = active ? (acctSortDir === 'asc' ? '▲' : '▼') : '⇅';
    const cls    = [c.cls || '', 'sort-th', active ? 'sort-active' : ''].filter(Boolean).join(' ');
    return `<th class="${cls}" onclick="acctSortBy('${c.key}')">${c.label}<span class="sort-icon">${icon}</span></th>`;
  }).join('');

  const tbody = list.map(a => {
    const pctTgt = a.target > 0 ? (a.pctToTarget * 100).toFixed(1) + '%' : '—';
    const pctTgtCls = a.target > 0 ? (a.pctToTarget >= 1 ? 'vel-up' : a.pctToTarget >= 0.75 ? 'vel-ss' : 'vel-down') : '';

    const pctChange = a.priorYtd > 0
      ? ((a.ytdSales - a.priorYtd) / a.priorYtd * 100).toFixed(1)
      : null;
    const pctChangeCls  = pctChange !== null ? (parseFloat(pctChange) >= 0 ? 'vel-up' : 'vel-down') : '';
    const pctChangeArrow = pctChange !== null ? (parseFloat(pctChange) >= 0 ? '↑' : '↓') : '';

    const tierKey  = a.tier;
    const tierCls  = `tier-${tierKey.toLowerCase().replace('atrisk', 'atrisk')}`;
    const tierLabel = tierKey.replace('AtRisk', 'At Risk');

    const daysCls = a.daysSinceOrder >= 60 ? 'vel-down' : a.daysSinceOrder >= 30 ? 'vel-ss' : '';
    const daysStr = a.daysSinceOrder >= 999 ? '—' : a.daysSinceOrder + 'd';

    const rowBg = tierKey === 'Critical' ? 'background:#fff5f5'
                : tierKey === 'AtRisk'   ? 'background:#fff8f0' : '';

    return `<tr style="${rowBg}">
      <td><a class="acct-name-link" onclick="openCustomerAccount('${a.custNo}')">${a.name || '—'}</a></td>
      <td class="num-ctr" style="font-family:monospace;font-size:12px;font-weight:600;color:#3d5a80">${a.custNo}</td>
      <td class="num-ctr">${a.state || '—'}</td>
      <td class="num-ctr"><span class="tier-badge ${tierCls}">${tierLabel}</span></td>
      <td class="num-ctr">${fmt$(a.ytdSales)}</td>
      <td class="num-ctr">${a.target > 0 ? fmt$(a.target) : '—'}</td>
      <td class="num-ctr"><span class="${pctTgtCls}">${pctTgt}</span></td>
      <td class="num-ctr">${a.priorYtd > 0 ? fmt$(a.priorYtd) : '—'}</td>
      <td class="num-ctr"><span class="${pctChangeCls}">${pctChangeArrow}</span>${pctChange !== null ? ' ' + pctChange + '%' : '—'}</td>
      <td class="num-ctr"><span class="${daysCls}">${daysStr}</span></td>
      <td class="num-ctr">${a.lastOrderDate || '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="11" style="padding:20px;color:#9ca3af;text-align:center">No accounts found.</td></tr>';

  const behindCls = behindTarget > 0 ? 'color:#dc2626;font-weight:700' : '';
  const noOrdCls  = noOrders30   > 0 ? 'color:#dc2626;font-weight:700' : '';

  document.getElementById('store-view-content').innerHTML = `
    <div class="cat-stat-bar">
      <div class="cat-stat-item"><span class="cat-stat-lbl">Accounts:</span><span class="cat-stat-val">${total}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">YTD Sales:</span><span class="cat-stat-val">${fmt$(totalYtd)}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Behind Target:</span><span class="cat-stat-val" style="${behindCls}">${behindTarget}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">No Orders 30+ Days:</span><span class="cat-stat-val" style="${noOrdCls}">${noOrders30}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Growing:</span><span class="cat-stat-val" style="color:#059669">${growing}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Declining:</span><span class="cat-stat-val" style="color:#dc2626">${declining}</span></div>
    </div>

    <div class="chart-row-3">
      <div class="chart-panel">
        <div class="chart-panel-title">Top 15 Accounts — YTD Sales</div>
        <div class="chart-container" style="height:350px"><canvas id="acct-bar-chart"></canvas></div>
      </div>
      <div class="chart-panel">
        <div class="chart-panel-title">Accounts by Health Tier</div>
        <div class="chart-container" style="height:350px"><canvas id="acct-donut-chart"></canvas></div>
      </div>
      <div class="chart-panel">
        <div class="chart-panel-title">YTD Sales vs Prior YTD</div>
        <div class="chart-container" style="height:350px"><canvas id="acct-scatter-chart"></canvas></div>
      </div>
    </div>

    <div class="tier-filter-bar">
      ${tierBtn('All')}${tierBtn('Healthy')}${tierBtn('Attention')}${tierBtn('AtRisk')}${tierBtn('Critical')}
    </div>

    <div class="inv-wrap">
      <table class="data-table">
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;

  setTimeout(() => renderAccountsCharts(byRep), 0);
}

// ── Charts ────────────────────────────────────────────────────

function renderAccountsCharts(accounts) {
  // ── Bar: top 15 accounts by YTD sales ────────────────────────
  const top15 = [...accounts].sort((a, b) => b.ytdSales - a.ytdSales).slice(0, 15);
  const barCtx = document.getElementById('acct-bar-chart');
  if (barCtx) {
    acctViewCharts.bar = new Chart(barCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: top15.map(a => a.name.length > 22 ? a.name.slice(0, 22) + '…' : a.name),
        datasets: [{
          data: top15.map(a => a.ytdSales),
          backgroundColor: top15.map(a => HEALTH_COLORS[a.tier] || '#6b8eb5'),
          borderWidth: 0,
          borderRadius: 3,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...acctTooltipDefaults,
            callbacks: {
              title: ctx => top15[ctx[0].dataIndex]?.name || '',
              label: ctx => ` YTD Sales: ${fmt$(ctx.parsed.x)}`,
            }
          }
        },
        scales: {
          x: { ticks: { font: { size: 11 }, color: '#6b7280', callback: v => fmtRevMM(v) }, grid: { color: 'rgba(0,0,0,0.04)' } },
          y: { ticks: { font: { size: 11 }, color: '#374151' }, grid: { display: false } },
        }
      }
    });
  }

  // ── Donut: accounts by health tier ───────────────────────────
  const donutCtx = document.getElementById('acct-donut-chart');
  if (donutCtx) {
    const tiers  = ['Healthy', 'Attention', 'AtRisk', 'Critical'];
    const counts = tiers.map(t => accounts.filter(a => a.tier === t).length);
    acctViewCharts.donut = new Chart(donutCtx.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Healthy', 'Attention', 'At Risk', 'Critical'],
        datasets: [{
          data: counts,
          backgroundColor: tiers.map(t => HEALTH_COLORS[t]),
          borderColor: '#fff', borderWidth: 2,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '55%',
        plugins: {
          legend: {
            display: true, position: 'bottom',
            labels: { font: { size: 11, family: 'Inter, sans-serif' }, color: '#374151', boxWidth: 12, padding: 10 },
          },
          tooltip: {
            ...acctTooltipDefaults,
            callbacks: {
              label: ctx => {
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                return ` ${ctx.parsed} accounts (${total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0}%)`;
              }
            }
          }
        }
      }
    });
  }

  // ── Scatter: YTD vs Prior YTD ─────────────────────────────────
  const scatterCtx = document.getElementById('acct-scatter-chart');
  if (scatterCtx) {
    const maxVal = Math.max(...accounts.map(a => Math.max(a.ytdSales, a.priorYtd)), 1);
    const datasets = ['Healthy', 'Attention', 'AtRisk', 'Critical'].map(tier => ({
      label: tier.replace('AtRisk', 'At Risk'),
      data: accounts
        .filter(a => a.tier === tier && (a.ytdSales > 0 || a.priorYtd > 0))
        .map(a => ({ x: a.priorYtd, y: a.ytdSales, name: a.name })),
      backgroundColor: HEALTH_COLORS[tier] + 'cc',
      borderColor:     HEALTH_COLORS[tier],
      borderWidth: 1,
      pointRadius: 5,
    }));

    // Diagonal reference line
    datasets.push({
      label: 'Flat (0% growth)',
      data: [{ x: 0, y: 0 }, { x: maxVal, y: maxVal }],
      type: 'line',
      borderColor: '#d1d5db',
      borderWidth: 1,
      borderDash: [4, 4],
      pointRadius: 0,
      fill: false,
    });

    acctViewCharts.scatter = new Chart(scatterCtx.getContext('2d'), {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true, position: 'bottom',
            labels: { font: { size: 11 }, color: '#374151', boxWidth: 12, padding: 10,
              filter: item => item.text !== 'Flat (0% growth)' }
          },
          tooltip: {
            ...acctTooltipDefaults,
            callbacks: {
              label: ctx => {
                if (!ctx.raw.name) return '';
                return [`  ${ctx.raw.name}`, `  Prior YTD: ${fmt$(ctx.raw.x)}`, `  YTD: ${fmt$(ctx.raw.y)}`];
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { font: { size: 11 }, color: '#6b7280', callback: v => fmtRevMM(v) },
            grid: { color: 'rgba(0,0,0,0.04)' },
            title: { display: true, text: 'Prior YTD', font: { size: 11 }, color: '#6b7280' },
          },
          y: {
            ticks: { font: { size: 11 }, color: '#6b7280', callback: v => fmtRevMM(v) },
            grid: { color: 'rgba(0,0,0,0.04)' },
            title: { display: true, text: 'Current YTD', font: { size: 11 }, color: '#6b7280' },
          },
        }
      }
    });
  }
}

// ── Event handlers ────────────────────────────────────────────

function acctSortBy(col) {
  if (acctSortCol === col) {
    acctSortDir = acctSortDir === 'desc' ? 'asc' : 'desc';
  } else {
    acctSortCol = col;
    acctSortDir = (col === 'name' || col === 'state' || col === 'tier' || col === 'lastOrder') ? 'asc' : 'desc';
  }
  renderAccountsOverview();
}

function setAcctTierFilter(tier) {
  acctTierFilter = tier;
  renderAccountsOverview();
}

// Navigate to Customer Account tab for the given custNo
function openCustomerAccount(custNo) {
  switchTab('item');
  if (typeof loadCustomerAccount === 'function') {
    loadCustomerAccount(custNo);
  }
}

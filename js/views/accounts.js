// ============================================================
// ACCOUNT PERFORMANCE VIEW
// Uses globals: accountsData, dataReady
// Registered as the 'store' tab — renderStoreView() is called by app.js
// ============================================================

let acctSortCol    = 'ytdSales', acctSortDir = 'desc';
let acctTierFilter = 'All';
let acctRepFilter  = 'All';
let acctViewCharts = {};
let acctOverviewData = null; // cached rep-overview API response

const HEALTH_COLORS = {
  Healthy:   '#059669',
  Attention: '#eab308',
  AtRisk:    '#ea580c',
  Critical:  '#dc2626',
};

// ── Health-signal tooltip ─────────────────────────────────────
(function initHealthTooltip() {
  const styleId = 'hs-tooltip-style';
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = `
      #hs-tip {
        position: fixed; z-index: 9999; pointer-events: none;
        background: #1a2332; color: #e2e8f0; border: 1px solid rgba(255,255,255,0.12);
        border-radius: 6px; padding: 10px 13px; font-size: 12px;
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        line-height: 1.6; white-space: pre; min-width: 310px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        opacity: 0; transition: opacity 0.1s;
      }
      #hs-tip.hs-tip-visible { opacity: 1; }
      .hs-tip-driver { color: #fbbf24; font-weight: 700; }
    `;
    document.head.appendChild(s);
  }

  let tip = document.getElementById('hs-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'hs-tip';
    document.body.appendChild(tip);
  }

  const STATE_LABEL = {
    // Engagement
    OnCadence: 'On cadence', Slowing: 'Slowing', Late: 'Late', GoneQuiet: 'Gone quiet',
    // Financial
    Growing: 'Growing', Steady: 'Steady', Declining: 'Declining', Collapsing: 'Collapsing',
    // Target
    Ahead: 'Ahead', OnPace: 'On pace', Behind: 'Behind', WayBehind: 'Way behind',
  };

  function money(v) {
    const abs = Math.abs(v);
    const s = abs >= 1000 ? '$' + (abs / 1000).toFixed(1) + 'k' : '$' + abs.toFixed(0);
    return v < 0 ? '-' + s : '+' + s;
  }

  function buildTip(hs) {
    const { tier, signals, driverSignal } = hs;
    const { engagement, financial, target } = signals;

    function row(key, label, detail) {
      const isDriver = key === driverSignal;
      const lbl  = label.padEnd(14);
      const line = `${lbl}${detail}`;
      return isDriver ? `<span class="hs-tip-driver">▶ ${line}</span>` : `  ${line}`;
    }

    const engDetail = (() => {
      const s = engagement;
      const ds = s.daysSinceOrder >= 999 ? 'never' : s.daysSinceOrder + 'd';
      const ti = s.typicalInterval !== null ? `, typically ~${s.typicalInterval}d` : ' (fallback thresholds)';
      return `${STATE_LABEL[s.state]} (${ds}${ti})`;
    })();

    const finDetail = (() => {
      if (!financial) return '— (no prior year data)';
      const f = financial;
      return `${STATE_LABEL[f.state]} (${money(f.yoyDollar)} / ${f.yoyPct > 0 ? '+' : ''}${f.yoyPct}%)`;
    })();

    const tgtDetail = (() => {
      if (!target) return '— (no annual target set)';
      const t = target;
      const pp = t.paceVsTarget > 0 ? `+${t.paceVsTarget}pp` : `${t.paceVsTarget}pp`;
      return `${STATE_LABEL[t.state]} (${pp} vs run rate)`;
    })();

    const divider = '─'.repeat(36);
    return [
      tier.replace('AtRisk', 'At Risk'),
      divider,
      row('engagement', 'Engagement', engDetail),
      row('financial',  'Financial',  finDetail),
      row('target',     'Target',     tgtDetail),
    ].join('\n');
  }

  document.addEventListener('mouseover', e => {
    const badge = e.target.closest('[data-hs]');
    if (!badge) return;
    try {
      const hs = JSON.parse(badge.getAttribute('data-hs'));
      tip.innerHTML = buildTip(hs);
      tip.classList.add('hs-tip-visible');
    } catch (_) {}
  });

  document.addEventListener('mousemove', e => {
    if (!tip.classList.contains('hs-tip-visible')) return;
    const x = e.clientX + 14;
    const y = e.clientY - 10;
    tip.style.left = Math.min(x, window.innerWidth - 340) + 'px';
    tip.style.top  = Math.min(y, window.innerHeight - 140) + 'px';
  });

  document.addEventListener('mouseout', e => {
    if (!e.target.closest('[data-hs]')) return;
    tip.classList.remove('hs-tip-visible');
  });
})();

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
  fetchRepOverview();
}

// ── Rep Overview KPI fetch ─────────────────────────────────────

async function fetchRepOverview() {
  const rep = (typeof currentRep !== 'undefined' ? currentRep : '').trim();
  if (!rep) return;
  try {
    const res = await fetch(`/proxy/rep-overview?rep=${encodeURIComponent(rep)}`);
    if (!res.ok) return;
    acctOverviewData = await res.json();

    // Regression guard: per-account monthGoal sum and rep-overview monthly.goal
    // should agree within 10%. A wider gap means the customer-list scope has drifted
    // (e.g. inactive accounts, rep reassignments). Log so it surfaces in DevTools.
    if (Array.isArray(accountsData) && accountsData.length > 0) {
      const perAcctSum  = accountsData.reduce((s, a) => s + (a.monthGoal || 0), 0);
      const repOvGoal   = acctOverviewData.monthly && acctOverviewData.monthly.goal;
      if (perAcctSum > 0 && repOvGoal > 0) {
        const drift = Math.abs(perAcctSum - repOvGoal) / perAcctSum;
        if (drift > 0.10) {
          console.warn(
            `[Monthly Goal drift] per-account sum $${perAcctSum.toFixed(2)} vs rep-overview $${repOvGoal.toFixed(2)} — ${(drift*100).toFixed(1)}% gap. Check for inactive/transferred accounts.`
          );
        }
      }
    }

    renderOverviewKpis();
  } catch (_) {}
}

function renderOverviewKpis() {
  const el = document.getElementById('acct-overview-kpis');
  if (!el || !acctOverviewData) return;
  const d = acctOverviewData;

  const totalAccounts  = (accountsData || []).length;
  const activeAccounts = d.monthly.activeAccounts;

  const runRatePct   = (d.yearRunRate * 100).toFixed(1);
  const totalBsUnits    = (accountsData || []).reduce((s, a) => s + (a.bsUnits    || 0), 0);
  const totalAllUnits   = (accountsData || []).reduce((s, a) => s + (a.totalUnits || 0), 0);
  const repBsPct        = totalAllUnits > 0 ? totalBsUnits / totalAllUnits : (d.bestSeller.pct || 0);
  const bsPct           = (repBsPct * 100).toFixed(1);
  const activeAccPct = totalAccounts > 0 ? ((activeAccounts / totalAccounts) * 100).toFixed(0) : 0;

  // Defer mtdPct / mtdColor until totalMonthGoal is computed below
  const totalYtd      = (accountsData || []).reduce((s, a) => s + a.ytdSales, 0);
  const totalMonthGoal = (accountsData || []).reduce((s, a) => s + (a.monthGoal || 0), 0);
  const mtdRatio     = totalMonthGoal > 0 ? d.monthly.mtd / totalMonthGoal : 0;
  const mtdPct       = (mtdRatio * 100).toFixed(1);
  const mtdColor     = mtdRatio >= 1.0 ? '#059669' : mtdRatio >= 0.75 ? '#d97706' : '#dc2626';
  const bsColor    = repBsPct >= 0.5 ? '#059669' : repBsPct >= 0.3 ? '#d97706' : '#dc2626';

  // Daily Needed — uses per-account monthGoal (same source as the Monthly Goal pill) and
  // remainingBusinessDays from rep-overview (already includes today after server fix).
  const remainingBD  = d.monthly.remainingBusinessDays;
  const gapToGoal    = totalMonthGoal - d.monthly.mtd;
  const dailyNeeded  = remainingBD > 0 && gapToGoal > 0 ? gapToGoal / remainingBD : 0;
  const dailyColor   = dailyNeeded > 0 ? '#d97706' : '#059669';

  const ticketChg = d.avg.ticketPrior > 0
    ? ((d.avg.ticketCurrent - d.avg.ticketPrior) / d.avg.ticketPrior * 100).toFixed(1)
    : null;
  const linesChg = d.avg.linesPrior > 0
    ? ((d.avg.linesCurrent - d.avg.linesPrior) / d.avg.linesPrior * 100).toFixed(1)
    : null;

  const chgBadge = v => {
    if (v === null) return '<span class="mgr-bench-chg neutral">no prior yr</span>';
    const n = parseFloat(v);
    const cls = n >= 0 ? 'up' : 'down';
    const sign = n >= 0 ? '↑' : '↓';
    return `<span class="mgr-bench-chg ${cls}">${sign} ${Math.abs(v)}%</span>`;
  };

  const totalAcctsFmt = totalAccounts.toLocaleString();

  // Tooltip text for Monthly Goal — update this constant to refine wording
  const MONTHLY_GOAL_TOOLTIP = `Monthly Goal = sum of prior-year same-month sales across your ${totalAccounts} currently-assigned accounts × (1 + growth factor). Includes all sales to these accounts regardless of which rep entered the order at the time.`;

  const pill = (label, value, sub, valueStyle, tooltip) => `
    <div class="mgr-pill">
      <div class="mgr-pill-label" style="display:flex;align-items:center;gap:4px">${label}${tooltip ? `<span title="${tooltip.replace(/"/g, '&quot;')}" style="cursor:help;font-size:10px;opacity:0.6;line-height:1;flex-shrink:0">ⓘ</span>` : ''}</div>
      <div class="mgr-pill-value" style="${valueStyle || ''}">${value}</div>
      ${sub ? `<div class="mgr-pill-sub">${sub}</div>` : ''}
    </div>`;

  const bsValueColor = bsColor === '#059669' ? '#86efac' : bsColor === '#d97706' ? '#fcd34d' : '#fca5a5';

  el.innerHTML = `
    <div class="mgr-panel">
      <div style="display:flex;gap:0;align-items:stretch">

        <!-- Left: donut chart (click slice to filter grid) -->
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:240px;width:240px;padding:8px 20px 8px 4px;border-right:1px solid rgba(255,255,255,0.12);margin-right:20px;flex-shrink:0">
          <canvas id="acct-donut-chart" style="max-height:200px;cursor:pointer" title="Click a slice to filter by tier"></canvas>
        </div>

        <!-- Right: 2-row KPI grid -->
        <div style="flex:1;display:flex;flex-direction:column;gap:8px;padding:4px 0">
          <!-- Row 1 — 6 pills -->
          <div class="mgr-pill-row">
            <div class="mgr-pill">
              <div class="mgr-pill-label">Year Run Rate</div>
              <div class="mgr-pill-value">${runRatePct}%</div>
              <div class="mgr-pill-sub">${d.businessDaysElapsed} of ${d.businessDaysTotal} days elapsed</div>
            </div>
            ${pill('Total Accounts',  totalAcctsFmt,         'all rep accounts')}
            ${pill('Total YTD Sales', fmt$(totalYtd),         'current year to date')}
            ${pill('Monthly Goal',    fmt$(totalMonthGoal),   'prior yr same month', '', MONTHLY_GOAL_TOOLTIP)}
            ${pill('MTD Sales',       fmt$(d.monthly.mtd),    `${d.monthly.remainingBusinessDays} biz days left`)}
            ${pill('MTD %',           mtdPct + '%',           'of monthly goal')}
          </div>

          <!-- Row 2 — 6 pills -->
          <div class="mgr-pill-row">
            ${pill('Daily Needed',    dailyNeeded > 0 ? fmt$(dailyNeeded) : '—', 'to close gap')}
            ${pill('Active Accounts', `${activeAccounts} <span style="opacity:0.55;font-size:14px;font-weight:500">/ ${totalAccounts}</span>`, `${activeAccPct}% ordered this month`)}
            ${pill('Avg Ticket (CY)', fmt$(d.avg.ticketCurrent), 'current year YTD')}
            ${pill('Avg Ticket (PY)', fmt$(d.avg.ticketPrior),
              ticketChg !== null
                ? (parseFloat(ticketChg) >= 0
                    ? `<span class="mgr-chg-up">↑ ${ticketChg}% vs prior</span>`
                    : `<span class="mgr-chg-down">↓ ${Math.abs(ticketChg)}% vs prior</span>`)
                : 'no prior yr data')}
            ${pill('Avg Lines (CY)',  d.avg.linesCurrent.toFixed(1), 'lines per ticket CY')}
            ${pill('Best Sellers on PO', bsPct + '%', `${totalBsUnits.toLocaleString()} of ${totalAllUnits.toLocaleString()} units`)}
          </div>
        </div>

      </div>
    </div>`;

  // Render donut now that the canvas is in the DOM
  renderAccountsDonut();
}

function renderAccountsDonut() {
  const full = accountsData || [];
  const donutCtx = document.getElementById('acct-donut-chart');
  if (!donutCtx) return;
  if (acctViewCharts.donut) { try { acctViewCharts.donut.destroy(); } catch (_) {} }

  // tier order matches label index used in onClick
  const tiers      = ['Healthy', 'Attention', 'AtRisk', 'Critical'];
  const labels     = ['Healthy', 'Attention', 'At Risk', 'Critical'];
  const counts     = tiers.map(t => full.filter(a => a.tier === t).length);
  const isFiltered = acctTierFilter !== 'All';
  const bgColors   = tiers.map(t => {
    const base = HEALTH_COLORS[t];
    return (!isFiltered || t === acctTierFilter) ? base : base + '44';
  });

  acctViewCharts.donut = new Chart(donutCtx.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: counts, backgroundColor: bgColors, borderColor: 'rgba(255,255,255,0.15)', borderWidth: 2 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '52%',
      onClick(evt, elements) {
        if (!elements.length) {
          // Clicked outside any slice — reset to All
          setAcctTierFilter('All');
          return;
        }
        const clickedTier = tiers[elements[0].index];
        // Toggle: clicking the already-active tier resets to All
        setAcctTierFilter(acctTierFilter === clickedTier ? 'All' : clickedTier);
      },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            font: { size: 12, family: 'Inter, sans-serif', weight: '600' },
            color: '#fff',
            boxWidth: 12,
            boxHeight: 12,
            padding: 12,
            usePointStyle: false,
          },
          onClick(evt, legendItem) {
            const tier = tiers[legendItem.index];
            setAcctTierFilter(acctTierFilter === tier ? 'All' : tier);
          },
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
      case 'bsPct':       return dir * ((a.bsPct || 0)    - (b.bsPct    || 0));
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
    { key: 'bsPct',       label: 'BS %',                cls: 'num-ctr' },
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

    const tierKey   = a.tier;
    const tierCls   = `tier-${tierKey.toLowerCase().replace('atrisk', 'atrisk')}`;
    const tierLabel = tierKey.replace('AtRisk', 'At Risk');
    const hsAttr    = a.healthSignals ? ` data-hs='${JSON.stringify(a.healthSignals).replace(/'/g, '&#39;')}'` : '';

    const daysCls = a.daysSinceOrder >= 60 ? 'vel-down' : a.daysSinceOrder >= 30 ? 'vel-ss' : '';
    const daysStr = a.daysSinceOrder >= 999 ? '—' : a.daysSinceOrder + 'd';

    const rowBg = tierKey === 'Critical' ? 'background:#fff5f5'
                : tierKey === 'AtRisk'   ? 'background:#fff8f0' : '';

    return `<tr style="${rowBg}">
      <td><a class="acct-name-link" onclick="openCustomerAccount('${a.custNo}')">${a.name || '—'}</a></td>
      <td class="num-ctr" style="font-family:monospace;font-size:12px;font-weight:600;color:#3d5a80">${a.custNo}</td>
      <td class="num-ctr">${a.state || '—'}</td>
      <td class="num-ctr"><span class="tier-badge ${tierCls}"${hsAttr}>${tierLabel}</span></td>
      <td class="num-ctr">${fmt$(a.ytdSales)}</td>
      <td class="num-ctr">${a.target > 0 ? fmt$(a.target) : '—'}</td>
      <td class="num-ctr"><span class="${pctTgtCls}">${pctTgt}</span></td>
      <td class="num-ctr">${a.priorYtd > 0 ? fmt$(a.priorYtd) : '—'}</td>
      <td class="num-ctr"><span class="${pctChangeCls}">${pctChangeArrow}</span>${pctChange !== null ? ' ' + pctChange + '%' : '—'}</td>
      <td class="num-ctr">${a.totalUnits > 0 ? (a.bsPct * 100).toFixed(1) + '%' : '—'}</td>
      <td class="num-ctr"><span class="${daysCls}">${daysStr}</span></td>
      <td class="num-ctr">${a.lastOrderDate || '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="12" style="padding:20px;color:#9ca3af;text-align:center">No accounts found.</td></tr>';

  document.getElementById('store-view-content').innerHTML = `
    <div id="acct-overview-kpis">
      <div class="mgr-panel">
        <div style="display:flex;gap:0;align-items:stretch;opacity:0.35">
          <div style="min-width:240px;width:240px;padding:8px 20px 8px 4px;border-right:1px solid rgba(255,255,255,0.12);margin-right:20px;flex-shrink:0"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:8px;padding:4px 0">
            <div class="mgr-pill-row">
              ${['Year Run Rate','Total Accounts','Total YTD Sales','Monthly Goal','MTD Sales','MTD %'].map(lbl => `
                <div class="mgr-pill"><div class="mgr-pill-label">${lbl}</div><div class="mgr-pill-value">—</div></div>`).join('')}
            </div>
            <div class="mgr-pill-row">
              ${['Daily Needed','Active Accounts','Avg Ticket (CY)','Avg Ticket (PY)','Avg Lines (CY)','Best Sellers on PO'].map(lbl => `
                <div class="mgr-pill"><div class="mgr-pill-label">${lbl}</div><div class="mgr-pill-value">—</div></div>`).join('')}
            </div>
          </div>
        </div>
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

  setTimeout(() => renderAccountsCharts(list, byRep), 0);
  if (acctOverviewData) renderOverviewKpis();
}

// ── Charts ────────────────────────────────────────────────────

function renderAccountsCharts(accounts, allAccounts) {
  // accounts  = tier-filtered list (what the table shows)
  // allAccounts = full rep list (always used for donut distribution)
  const full = allAccounts || accounts;

  // Donut is rendered via renderAccountsDonut() called from renderOverviewKpis()

  // ── Growth chart: top growers + top decliners, sorted by % change ──
  const growthCtx  = document.getElementById('acct-scatter-chart');
  const growthTitleEl = growthCtx && growthCtx.closest('.chart-panel')?.querySelector('.chart-panel-title');

  if (growthCtx) {
    // Only include accounts with a prior year to compare against
    const withPrior = (acctTierFilter === 'All' ? full : accounts)
      .filter(a => a.priorYtd > 0)
      .map(a => ({ ...a, pctChg: (a.ytdSales - a.priorYtd) / a.priorYtd }))
      .sort((a, b) => b.pctChg - a.pctChg);

    // Show top N growers + top N decliners; cap so chart stays readable
    const CAP = accounts.length <= 30 ? 15 : 12;
    const growers   = withPrior.slice(0, CAP);
    const decliners = withPrior.slice(-CAP).reverse(); // worst first
    // Deduplicate in case account list is small
    const declinersFiltered = decliners.filter(a => !growers.includes(a));
    const display = [...growers, ...declinersFiltered];

    const label = acctTierFilter === 'All'
      ? `Top ${CAP} Growing · Top ${CAP} Declining`
      : `${acctTierFilter.replace('AtRisk','At Risk')} — Growth vs Prior Year`;
    if (growthTitleEl) growthTitleEl.textContent = label;

    const labels = display.map(a => a.name.length > 20 ? a.name.slice(0, 20) + '…' : a.name);
    const values = display.map(a => +(a.pctChg * 100).toFixed(1));
    const colors = display.map(a => {
      const p = a.pctChg;
      if (p >= 0.10) return HEALTH_COLORS.Healthy;
      if (p >= 0)    return '#6aab8e';
      if (p >= -0.15) return HEALTH_COLORS.Attention;
      if (p >= -0.30) return HEALTH_COLORS.AtRisk;
      return HEALTH_COLORS.Critical;
    });

    acctViewCharts.scatter = new Chart(growthCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderWidth: 0,
          borderRadius: 3,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          annotation: {},
          tooltip: {
            ...acctTooltipDefaults,
            callbacks: {
              title: ctx => display[ctx[0].dataIndex]?.name || '',
              label: ctx => {
                const a = display[ctx[0].dataIndex];
                const sign = ctx.parsed.x >= 0 ? '+' : '';
                return [
                  ` Growth: ${sign}${ctx.parsed.x}%`,
                  ` CY YTD: ${fmt$(a.ytdSales)}`,
                  ` PY YTD: ${fmt$(a.priorYtd)}`,
                ];
              },
            }
          }
        },
        scales: {
          x: {
            ticks: {
              font: { size: 11 }, color: '#6b7280',
              callback: v => (v >= 0 ? '+' : '') + v + '%',
            },
            grid: { color: 'rgba(0,0,0,0.04)' },
            // Draw a zero line
            border: { display: false },
          },
          y: {
            ticks: { font: { size: 10 }, color: '#374151' },
            grid: { display: false },
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
  renderAccountsDonut();
}

// Navigate to Customer Account tab for the given custNo
function openCustomerAccount(custNo) {
  switchTab('item');
  if (typeof loadCustomerAccount === 'function') {
    loadCustomerAccount(custNo);
  }
}

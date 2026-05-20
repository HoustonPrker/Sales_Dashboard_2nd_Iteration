// ============================================================
// Rep Performance View
// Renders into #tab-rp — accessible to manager/admin only.
// Data source: GET /proxy/rep-scorecard
// ============================================================

let rpData         = null;
let rpSortCol      = 'pct_to_monthly';
let rpSortDir      = -1;   // -1 = desc, 1 = asc
let rpDrillAdvisor = null;
let rpDrillChart   = null;
let rpDrillSortCol = 'ytdSales';
let rpDrillSortDir = -1;

// ── Formatters ────────────────────────────────────────────────

function rpFmtM(n) {
  if (n == null) return '—';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
  return '$' + Math.round(n);
}

function rpFmtPct(n) {
  if (n == null) return '—';
  return n.toFixed(1) + '%';
}

function rpMonthLabel() {
  const months = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  const now = new Date();
  return `${months[now.getMonth()]} ${now.getFullYear()}`;
}

// ── Pace class ────────────────────────────────────────────────

function rpPctClass(pct, pctElapsed) {
  if (pct == null || pctElapsed == null) return 'rp-pct-neutral';
  const delta = pct - pctElapsed;
  if (delta >= 0)   return 'rp-pct-green';
  if (delta >= -5)  return 'rp-pct-neutral';
  if (delta >= -15) return 'rp-pct-amber';
  return 'rp-pct-red';
}

function rpPaceClass(paceScore) {
  if (paceScore == null) return 'rp-neutral';
  if (paceScore >= -5)  return 'rp-ok';
  if (paceScore >= -15) return 'rp-warn';
  return 'rp-behind';
}

// ── Sort ──────────────────────────────────────────────────────

const COL_MAP = {
  displayName:      a => (a.displayName || '').toLowerCase(),
  ytd:              a => a.ytd,
  pct_to_goal:      a => a.pct_to_goal      ?? -Infinity,
  dollar_to_annual: a => a.annual_goal - a.ytd,
  annual_goal:      a => a.annual_goal,
  mtd:              a => a.mtd,
  pct_to_monthly:   a => a.pct_to_monthly   ?? -Infinity,
  dollar_to_monthly:a => a.monthly_goal - a.mtd,
  monthly_goal:     a => a.monthly_goal,
  healthy_count:    a => a.healthy_count,
  critical_count:   a => a.critical_count,
};

function rpSortedAdvisors(advisors) {
  const fn = COL_MAP[rpSortCol] || (a => a.mtd);
  return [...advisors].sort((a, b) => {
    const av = fn(a), bv = fn(b);
    if (av < bv) return rpSortDir;
    if (av > bv) return -rpSortDir;
    return 0;
  });
}

// ── HTML escape ───────────────────────────────────────────────

function escRp(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Table header ──────────────────────────────────────────────

function rpRenderHeader() {
  const cols = [
    { key: null,               label: '#',                    cls: 'num-ctr',  tip: '' },
    { key: 'displayName',      label: 'Advisor',              cls: '',         tip: '' },
    { key: 'ytd',              label: 'YTD Sales',            cls: 'num-ctr',  tip: '' },
    { key: 'pct_to_goal',      label: '% to Annual Goal',     cls: 'num-ctr',  tip: 'Percentage of annual goal achieved year-to-date' },
    { key: 'dollar_to_annual', label: '$ to Annual Goal',     cls: 'num-ctr',  tip: 'Remaining dollars needed to hit annual goal' },
    { key: 'annual_goal',      label: 'Annual Goal',          cls: 'num-ctr',  tip: '' },
    { key: 'mtd',              label: 'MTD Sales',            cls: 'num-ctr',  tip: '' },
    { key: 'pct_to_monthly',   label: '% to Monthly Goal',   cls: 'num-ctr',  tip: 'Percentage of monthly goal achieved this month' },
    { key: 'dollar_to_monthly',label: '$ to Monthly Goal',   cls: 'num-ctr',  tip: 'Remaining dollars needed to hit monthly goal' },
    { key: 'monthly_goal',     label: 'Monthly Goal',         cls: 'num-ctr',  tip: '' },
    { key: 'healthy_count',    label: '# Healthy',            cls: 'num-ctr',  tip: '' },
    { key: 'critical_count',   label: '# Critical',           cls: 'num-ctr',  tip: '' },
  ];

  return cols.map(c => {
    const active   = c.key && rpSortCol === c.key;
    const sortIcon = active ? `<span class="sort-icon">${rpSortDir === -1 ? '▼' : '▲'}</span>` : '';
    const cls      = ['sort-th', c.cls || '', active ? 'sort-active' : ''].filter(Boolean).join(' ');
    const titleAttr = c.tip ? ` title="${escRp(c.tip)}"` : '';
    if (!c.key) return `<th class="${cls}"${titleAttr}>${c.label}</th>`;
    return `<th class="${cls}"${titleAttr} onclick="rpOnHeaderClick('${c.key}')" style="cursor:pointer;user-select:none">
      <div class="th-inner"><span class="th-label">${c.label}</span><span class="th-tail">${sortIcon}</span></div>
    </th>`;
  }).join('');
}

// ── Table rows ────────────────────────────────────────────────

function rpRenderRows(advisors) {
  const sorted      = rpSortedAdvisors(advisors);
  const pctElapsed  = rpData?.team?.pct_elapsed ?? 0;

  return sorted.map((a, i) => {
    const rank      = i + 1;
    const rankStyle = rank === 1 ? 'font-weight:700;color:#b45309' : 'color:#6b7280';

    // Annual goal %
    const annualPctCls  = rpPctClass(a.pct_to_goal, pctElapsed);
    const annualTip     = a.pct_to_goal != null
      ? `On pace would be ${pctElapsed.toFixed(1)}% — you are at ${a.pct_to_goal.toFixed(1)}%`
      : '';
    const dollarToAnnual = a.annual_goal - a.ytd;

    // Monthly goal %
    const monthlyPctCls  = rpPctClass(a.pct_to_monthly, pctElapsed);
    const monthlyTip     = a.pct_to_monthly != null
      ? `On pace would be ${pctElapsed.toFixed(1)}% — you are at ${a.pct_to_monthly.toFixed(1)}%`
      : '';
    const dollarToMonthly = a.monthly_goal - a.mtd;

    const critStyle  = a.critical_count > 0 ? 'color:#dc2626;font-weight:600' : 'color:#6b7280';
    const healthyStyle = a.healthy_count > 0 ? 'color:#15803d;font-weight:600' : 'color:#9ca3af';

    const rowData = JSON.stringify(a).replace(/"/g, '&quot;');

    return `<tr style="cursor:pointer" onclick="rpOpenDrilldown(${rowData})"
        onmouseenter="this.style.background='#f0f4ff'" onmouseleave="this.style.background=''">
      <td class="num-ctr" style="font-size:12px;${rankStyle}">${rank}</td>
      <td>
        <div style="font-weight:600;color:#1a2332">${escRp(a.displayName)}</div>
        <div style="font-size:11px;color:#6b7280;font-family:monospace">${escRp(a.rep_prefix)} · ${a.accounts} accts</div>
      </td>
      <td class="num-ctr" style="font-weight:600">${rpFmtM(a.ytd)}</td>
      <td class="num-ctr ${annualPctCls}" title="${escRp(annualTip)}">${rpFmtPct(a.pct_to_goal)}</td>
      <td class="num-ctr" style="color:#6b7280">${a.annual_goal > 0 ? rpFmtM(dollarToAnnual) : '—'}</td>
      <td class="num-ctr" style="color:#9ca3af">${a.annual_goal > 0 ? rpFmtM(a.annual_goal) : '—'}</td>
      <td class="num-ctr">${a.mtd > 0 ? rpFmtM(a.mtd) : '—'}</td>
      <td class="num-ctr ${monthlyPctCls}" title="${escRp(monthlyTip)}">${rpFmtPct(a.pct_to_monthly)}</td>
      <td class="num-ctr" style="color:#6b7280">${a.monthly_goal > 0 ? rpFmtM(dollarToMonthly) : '—'}</td>
      <td class="num-ctr" style="color:#9ca3af">${a.monthly_goal > 0 ? rpFmtM(a.monthly_goal) : '—'}</td>
      <td class="num-ctr" style="${healthyStyle}">${a.healthy_count}</td>
      <td class="num-ctr" style="${critStyle}">${a.critical_count}</td>
    </tr>`;
  }).join('');
}

// ── Header sort click ─────────────────────────────────────────

function rpOnHeaderClick(col) {
  if (rpSortCol === col) {
    rpSortDir = -rpSortDir;
  } else {
    rpSortCol = col;
    rpSortDir = col === 'displayName' ? 1 : -1;
  }
  rpRefreshTable();
}

function rpRefreshTable() {
  if (!rpData) return;
  const thead = document.querySelector('#rp-scorecard-table thead tr');
  const tbody  = document.getElementById('rp-tbody');
  if (thead) thead.innerHTML = rpRenderHeader();
  if (tbody)  tbody.innerHTML = rpRenderRows(rpData.advisors);
}

// ── Skeleton loader ───────────────────────────────────────────

function rpRenderSkeleton() {
  const rows = Array.from({ length: 8 }, (_, i) => `
    <tr>
      <td><div class="rp-skeleton" style="height:14px;width:18px"></div></td>
      <td><div class="rp-skeleton" style="height:14px;width:${100 + (i % 3) * 30}px;margin-bottom:4px"></div>
          <div class="rp-skeleton" style="height:10px;width:70px"></div></td>
      ${Array.from({length:10},(_,j)=>`<td class="num-ctr"><div class="rp-skeleton" style="height:14px;width:${40+j%3*12}px;margin:0 auto"></div></td>`).join('')}
    </tr>`).join('');

  return `
    <div style="padding:16px 0 0">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0 0 14px">
        <div>
          <div class="rp-skeleton" style="height:20px;width:280px;margin-bottom:6px"></div>
          <div class="rp-skeleton" style="height:13px;width:200px"></div>
        </div>
        <div class="rp-skeleton" style="height:30px;width:72px;border-radius:6px"></div>
      </div>
      <div class="inv-wrap" style="overflow-x:auto">
        <table class="data-table" id="rp-scorecard-table">
          <thead><tr>${rpRenderHeader()}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Full page render ──────────────────────────────────────────

function rpRenderFull() {
  const container = document.getElementById('tab-rp');
  if (!container || !rpData) return;
  const t = rpData.team;

  container.innerHTML = `
    <div style="padding:16px 0 0">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0 0 14px">
        <div style="font-size:22px;font-weight:800;color:#1a2332">${rpMonthLabel()}</div>
        <button onclick="rpForceRefresh()" class="btn btn-secondary" style="font-size:13px;padding:6px 16px">↺ Refresh</button>
      </div>
      <div class="inv-wrap" style="overflow-x:auto">
        <table class="data-table" id="rp-scorecard-table">
          <thead><tr>${rpRenderHeader()}</tr></thead>
          <tbody id="rp-tbody">${rpRenderRows(rpData.advisors)}</tbody>
        </table>
      </div>
    </div>`;
}

async function rpForceRefresh() {
  rpData = null;
  await renderRepPerformance();
}

// ── Rep drill-down ────────────────────────────────────────────

function rpGetRepAccounts(rep_prefix) {
  if (!rep_prefix || !Array.isArray(accountsData)) return [];
  return accountsData.filter(a => {
    const r = a.salesRep || '';
    return r === rep_prefix || r.startsWith(rep_prefix + '-');
  });
}

function rpOpenDrilldown(advisor) {
  if (rpDrillChart) { try { rpDrillChart.destroy(); } catch (_) {} rpDrillChart = null; }
  rpDrillAdvisor = advisor;
  rpDrillSortCol = 'ytdSales';
  rpDrillSortDir = -1;
  rpRenderDrilldown();
}

function rpCloseDrilldown() {
  if (rpDrillChart) { try { rpDrillChart.destroy(); } catch (_) {} rpDrillChart = null; }
  rpDrillAdvisor = null;
  rpRenderFull();
}

function rpRenderDrilldown() {
  const container = document.getElementById('tab-rp');
  if (!container || !rpDrillAdvisor) return;
  const a = rpDrillAdvisor;
  const accounts = rpGetRepAccounts(a.rep_prefix);
  const pctElapsed = rpData ? rpData.team.pct_elapsed : 0;

  const tierCounts = { Healthy: 0, Attention: 0, AtRisk: 0, Critical: 0 };
  accounts.forEach(acc => { tierCounts[acc.tier] = (tierCounts[acc.tier] || 0) + 1; });

  const pctGoalStr = a.pct_to_goal    != null ? a.pct_to_goal.toFixed(1)    + '%' : '—';
  const pctMoStr   = a.pct_to_monthly != null ? a.pct_to_monthly.toFixed(1) + '%' : '—';
  const goalOnPace = a.pct_to_goal    != null && a.pct_to_goal    >= pctElapsed;
  const moOnPace   = a.pct_to_monthly != null && a.pct_to_monthly >= pctElapsed;

  const drillHeaders = [
    { col: 'custNo',          label: 'Acct #',         cls: '' },
    { col: 'name',            label: 'Customer',       cls: '' },
    { col: 'tier',            label: 'Health',         cls: 'num-ctr' },
    { col: 'ytdSales',        label: 'YTD Sales',      cls: 'num-ctr' },
    { col: 'pctToAnnualGoal', label: '% to Annual',    cls: 'num-ctr' },
    { col: 'mtdSales',        label: 'MTD Sales',      cls: 'num-ctr' },
    { col: 'pctToMonthGoal',  label: '% to Monthly',   cls: 'num-ctr' },
    { col: 'daysSince',       label: 'Days Since',     cls: 'num-ctr' },
    { col: 'lastOrder',       label: 'Last Order',     cls: 'num-ctr' },
  ];

  const drillThHtml = drillHeaders.map(h => {
    const active = rpDrillSortCol === h.col;
    const icon   = active ? (rpDrillSortDir === -1 ? ' ▼' : ' ▲') : '';
    const cls    = ['sort-th', h.cls, active ? 'sort-active' : ''].filter(Boolean).join(' ');
    return `<th class="${cls}" data-rp-drill-col="${h.col}" onclick="rpDrillSort('${h.col}')" style="cursor:pointer;user-select:none">
      <div class="th-inner"><span class="th-label">${h.label}</span><span class="th-tail"><span class="sort-icon">${icon}</span></span></div>
    </th>`;
  }).join('');

  const pill = (label, value, sub, valueStyle) => `
    <div class="mgr-pill">
      <div class="mgr-pill-label">${label}</div>
      <div class="mgr-pill-value" style="${valueStyle || ''}">${value}</div>
      ${sub ? `<div class="mgr-pill-sub">${sub}</div>` : ''}
    </div>`;

  container.innerHTML = `
    <div style="padding:0">
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0 14px">
        <button onclick="rpCloseDrilldown()" class="btn btn-secondary" style="font-size:13px;padding:6px 14px">← Back to Team</button>
        <div>
          <span style="font-size:18px;font-weight:700;color:#1a2332">${escRp(a.displayName)}</span>
          <span style="font-size:12px;color:#6b7280;margin-left:8px;font-family:monospace">${escRp(a.rep_prefix)}</span>
        </div>
        <span style="font-size:12px;color:#6b7280;margin-left:auto">${accounts.length} accounts</span>
      </div>

      <div class="mgr-panel" style="margin-bottom:14px">
        <div class="mgr-pill-row">
          ${pill('YTD Sales', rpFmtM(a.ytd), 'current year to date')}
          ${pill('% to Annual Goal', pctGoalStr, goalOnPace ? 'on pace ✓' : 'below pace', goalOnPace ? 'color:#86efac' : '')}
          ${pill('MTD Sales', rpFmtM(a.mtd), 'this month')}
          ${pill('% to Monthly Goal', pctMoStr, moOnPace ? 'on pace ✓' : 'below pace', moOnPace ? 'color:#86efac' : '')}
          ${pill('Accounts', String(accounts.length), `${tierCounts.Critical} critical · ${tierCounts.AtRisk} at risk`, tierCounts.Critical > 0 ? 'color:#fca5a5' : '')}
          ${pill('Account Health', `${tierCounts.Healthy} healthy`, `${tierCounts.Attention} attention · ${tierCounts.Critical + tierCounts.AtRisk} flagged`)}
        </div>
      </div>

      <div style="display:flex;align-items:flex-start;gap:24px;margin-bottom:14px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);padding:16px 20px">
        <canvas id="rp-drill-donut" width="160" height="160" style="flex-shrink:0"></canvas>
        <div style="display:flex;flex-direction:column;gap:8px;padding-top:12px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#6b7280;margin-bottom:4px">Account Health Breakdown</div>
          ${['Healthy','Attention','AtRisk','Critical'].map(tier => {
            return `<div style="display:flex;align-items:center;gap:10px;font-size:13px">
              <span class="tier-badge tier-${tier.toLowerCase()}" style="min-width:72px;text-align:center">${tier.replace('AtRisk','At Risk')}</span>
              <span style="font-weight:600;color:#1a2332">${tierCounts[tier]}</span>
              <span style="color:#9ca3af">accounts</span>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="inv-wrap" style="overflow-x:auto;padding-bottom:80px">
        <table class="data-table" id="rp-drill-table">
          <thead><tr>${drillThHtml}</tr></thead>
          <tbody id="rp-drill-tbody">${rpDrillRowsHtml(rpDrillSortedAccounts(accounts))}</tbody>
        </table>
      </div>
    </div>`;

  setTimeout(() => rpRenderDrillDonut(tierCounts), 0);
}

function rpDrillSortedAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    const dir = rpDrillSortDir;
    switch (rpDrillSortCol) {
      case 'custNo':          return dir * (a.custNo || '').localeCompare(b.custNo || '');
      case 'name':            return dir * (a.name   || '').localeCompare(b.name   || '');
      case 'tier':            return dir * (a.tier   || '').localeCompare(b.tier   || '');
      case 'ytdSales':        return dir * (a.ytdSales - b.ytdSales);
      case 'pctToAnnualGoal': return dir * ((a.pctToAnnualGoal || 0) - (b.pctToAnnualGoal || 0));
      case 'mtdSales':        return dir * ((a.mtdSales || 0) - (b.mtdSales || 0));
      case 'pctToMonthGoal':  return dir * ((a.pctToMonthGoal || 0) - (b.pctToMonthGoal || 0));
      case 'daysSince':       return dir * (a.daysSinceOrder - b.daysSinceOrder);
      case 'lastOrder':       return dir * (a.lastOrderDate || '').localeCompare(b.lastOrderDate || '');
      default:                return dir * (a.ytdSales - b.ytdSales);
    }
  });
}

function rpDrillRowsHtml(rows) {
  if (!rows.length) return `<tr><td colspan="9" style="padding:24px;text-align:center;color:#9ca3af">No accounts found.</td></tr>`;
  const tierBg = { Critical:'background:#fff5f5', AtRisk:'background:#fff8f0' };
  return rows.map(a => {
    const rowBg   = tierBg[a.tier] || '';
    const tier    = a.tier || 'Healthy';
    const tierLbl = tier.replace('AtRisk','At Risk');
    const daysCls = a.daysSinceOrder >= 60 ? 'vel-down' : a.daysSinceOrder >= 30 ? 'vel-ss' : '';
    const pctAnn  = a.annualGoal > 0 ? (a.pctToAnnualGoal * 100).toFixed(1) + '%' : '—';
    const pctMo   = a.monthGoal  > 0 ? (a.pctToMonthGoal  * 100).toFixed(1) + '%' : '—';
    const lastOrd = a.lastOrderDate ? a.lastOrderDate.slice(5,7)+'-'+a.lastOrderDate.slice(8,10)+'-'+a.lastOrderDate.slice(0,4) : '—';
    const daysStr = a.daysSinceOrder >= 999 ? '—' : a.daysSinceOrder + 'd';
    return `<tr style="${rowBg};cursor:pointer"
      onmouseenter="this.style.background='#e8f0fb'" onmouseleave="this.style.background='${rowBg ? rowBg.replace('background:','') : ''}'">
      <td style="font-family:monospace;font-size:12px;font-weight:600;color:#3d5a80" onclick="rpDrillOpenCustomer('${a.custNo}')">${a.custNo}</td>
      <td class="acct-pin-col" style="max-width:220px" onclick="rpDrillOpenCustomer('${a.custNo}')"><a class="acct-name-link">${a.name || '—'}</a></td>
      <td class="num-ctr"><span class="tier-badge tier-${tier.toLowerCase()}">${tierLbl}</span></td>
      <td class="num-ctr" style="font-weight:600">${typeof fmt$ === 'function' ? fmt$(a.ytdSales) : rpFmtM(a.ytdSales)}</td>
      <td class="num-ctr">${pctAnn}</td>
      <td class="num-ctr">${a.mtdSales > 0 ? rpFmtM(a.mtdSales) : '—'}</td>
      <td class="num-ctr">${pctMo}</td>
      <td class="num-ctr"><span class="${daysCls}">${daysStr}</span></td>
      <td class="num-ctr">${lastOrd}</td>
    </tr>`;
  }).join('');
}

function rpDrillSort(col) {
  if (rpDrillSortCol === col) {
    rpDrillSortDir = -rpDrillSortDir;
  } else {
    rpDrillSortCol = col;
    rpDrillSortDir = col === 'name' || col === 'custNo' ? 1 : -1;
  }
  if (!rpDrillAdvisor) return;
  const sorted = rpDrillSortedAccounts(rpGetRepAccounts(rpDrillAdvisor.rep_prefix));
  const tbody  = document.getElementById('rp-drill-tbody');
  if (tbody) tbody.innerHTML = rpDrillRowsHtml(sorted);
  document.querySelectorAll('#rp-drill-table th[data-rp-drill-col]').forEach(th => {
    const isActive = th.dataset.rpDrillCol === rpDrillSortCol;
    th.classList.toggle('sort-active', isActive);
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = isActive ? (rpDrillSortDir === -1 ? '▼' : '▲') : '';
  });
}

function rpDrillOpenCustomer(custNo) {
  if (typeof switchTab === 'function') switchTab('item');
  if (typeof loadCustomerAccount === 'function') loadCustomerAccount(custNo);
}

function rpRenderDrillDonut(tierCounts) {
  const ctx = document.getElementById('rp-drill-donut');
  if (!ctx) return;
  if (rpDrillChart) { try { rpDrillChart.destroy(); } catch (_) {} rpDrillChart = null; }
  const tiers  = ['Healthy','Attention','AtRisk','Critical'];
  const labels = ['Healthy','Attention','At Risk','Critical'];
  const colors = ['#059669','#eab308','#ea580c','#dc2626'];
  rpDrillChart = new Chart(ctx.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: tiers.map(t => tierCounts[t] || 0), backgroundColor: colors, borderColor: '#ffffff', borderWidth: 3 }]
    },
    options: {
      responsive: false,
      cutout: '52%',
      plugins: {
        legend: { display: true, position: 'bottom', labels: { font: { size: 11 }, boxWidth: 10, padding: 8 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.parsed} accounts` } }
      }
    }
  });
}

// ── Public entry point ────────────────────────────────────────

async function renderRepPerformance() {
  const container = document.getElementById('tab-rp');
  if (!container) return;

  if (rpDrillAdvisor) { rpRenderDrilldown(); return; }

  if (rpData) { rpRenderFull(); return; }

  container.innerHTML = rpRenderSkeleton();

  try {
    const r = await fetch('/proxy/rep-scorecard');
    if (!r.ok) {
      container.innerHTML = `<div style="padding:60px;text-align:center;color:#dc2626;font-size:14px">Error loading scorecard (${r.status})</div>`;
      return;
    }
    rpData = await r.json();
    rpRenderFull();
  } catch (e) {
    container.innerHTML = `<div style="padding:60px;text-align:center;color:#dc2626;font-size:14px">Failed to load scorecard: ${escRp(e.message)}</div>`;
    console.error('[rep-performance]', e);
  }
}

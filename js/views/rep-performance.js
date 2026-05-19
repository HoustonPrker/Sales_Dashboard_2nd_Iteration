// ============================================================
// Rep Performance View — editorial redesign
// Renders into #tab-rp — accessible to manager/admin only.
// Data source: GET /proxy/rep-scorecard
// ============================================================

let rpData         = null;
let rpSortCol      = 'pct_to_goal';
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

// ── Sort ──────────────────────────────────────────────────────

const COL_MAP = {
  displayName:     a => (a.displayName || '').toLowerCase(),
  accounts:        a => a.accounts,
  ytd:             a => a.ytd,
  pct_to_goal:     a => a.pct_to_goal    ?? -Infinity,
  mtd:             a => a.mtd,
  pct_to_monthly:  a => a.pct_to_monthly ?? -Infinity,
  pace_score:      a => a.pace_score     ?? -Infinity,
  healthy_count:   a => a.healthy_count,
  atrisk_count:    a => a.atrisk_count,
  days_idle:       a => a.days_idle      ?? Infinity,
};

function rpSortedAdvisors(advisors) {
  const fn = COL_MAP[rpSortCol] || (a => a.ytd);
  return [...advisors].sort((a, b) => {
    const av = fn(a), bv = fn(b);
    if (av < bv) return rpSortDir;
    if (av > bv) return -rpSortDir;
    return 0;
  });
}

function rpSortLabel() {
  const map = {
    displayName: 'name', accounts: 'account count', ytd: 'YTD sales',
    pct_to_goal: '% goal achieved', mtd: 'MTD sales',
    pct_to_monthly: '% monthly goal', pace_score: 'pace score',
    healthy_count: 'healthy accounts', atrisk_count: 'at-risk accounts',
    days_idle: 'idle days',
  };
  return map[rpSortCol] || rpSortCol;
}

// ── HTML escape ───────────────────────────────────────────────

function escRp(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Pace bar helpers ──────────────────────────────────────────

function rpPaceClass(paceScore) {
  if (paceScore == null) return 'rp-neutral';
  if (paceScore >= -5)  return 'rp-ok';
  if (paceScore >= -15) return 'rp-warn';
  return 'rp-behind';
}

// ── KPI panel (matches mgr-panel on Account Performance) ──────

function rpRenderKpiPanel(t, advisors) {
  const teamPriorYtd = (typeof accountsData !== 'undefined' && Array.isArray(accountsData))
    ? accountsData.reduce((s, a) => s + (a.priorYtd || 0), 0) : 0;
  const yoy = teamPriorYtd > 0 ? (t.ytd_sum - teamPriorYtd) / teamPriorYtd * 100 : null;
  const yoyStr = yoy !== null
    ? (yoy >= 0 ? `<span style="color:#86efac">↑ +${yoy.toFixed(1)}%</span>` : `<span style="color:#fca5a5">↓ ${Math.abs(yoy).toFixed(1)}%</span>`) + ' vs prior yr'
    : '';

  const bizLeft = t.business_days_total - t.business_days_elapsed;
  const goalPct = t.monthly_goal_sum > 0 ? (t.mtd_sum / t.monthly_goal_sum * 100).toFixed(1) + '%' : '—';

  const paceScores = advisors.map(a => a.pace_score).filter(v => v != null);
  const avgPace = paceScores.length > 0 ? paceScores.reduce((s, v) => s + v, 0) / paceScores.length : null;
  const avgPaceStr = avgPace != null ? (avgPace >= 0 ? `+${avgPace.toFixed(1)} pp` : `${avgPace.toFixed(1)} pp`) : '—';
  const avgPaceColor = avgPace == null ? '' : avgPace >= 0 ? 'color:#86efac' : avgPace >= -10 ? '' : 'color:#fca5a5';

  const onPaceColor = t.on_pace_count === t.advisor_count ? 'color:#86efac' : t.on_pace_count === 0 ? 'color:#fca5a5' : '';
  const critColor   = t.critical_accts > 0 ? 'color:#fca5a5' : 'color:#86efac';

  const pill = (label, value, sub, valueStyle) => `
    <div class="mgr-pill">
      <div class="mgr-pill-label">${label}</div>
      <div class="mgr-pill-value" style="${valueStyle || ''}">${value}</div>
      ${sub ? `<div class="mgr-pill-sub">${sub}</div>` : ''}
    </div>`;

  return `
    <div class="mgr-panel" style="margin-bottom:14px">
      <div class="mgr-pill-row">
        ${pill('Team YTD', rpFmtM(t.ytd_sum), yoyStr || `${t.advisor_count} advisors`)}
        ${pill('Monthly Goal', rpFmtM(t.monthly_goal_sum), `${goalPct} achieved`)}
        ${pill('MTD Sales', rpFmtM(t.mtd_sum), `${bizLeft} biz days left`)}
        ${pill('On Pace', `${t.on_pace_count} / ${t.advisor_count}`, 'advisors on monthly pace', onPaceColor)}
        ${pill('Critical Accts', String(t.critical_accts), 'across all advisors', critColor)}
        ${pill('Avg Pace', avgPaceStr, avgPace != null && avgPace < 0 ? `team behind ${Math.abs(avgPace).toFixed(1)} pp` : 'team on pace', avgPaceColor)}
      </div>
    </div>`;
}

// ── Table header ──────────────────────────────────────────────

function rpRenderHeader() {
  const cols = [
    { key: null,             label: '#',                cls: 'num-ctr'  },
    { key: 'displayName',    label: 'Advisor'                           },
    { key: 'ytd',            label: 'YTD Sales',        cls: 'num-ctr'  },
    { key: 'pct_to_goal',    label: '% to Annual Goal', cls: 'num-ctr'  },
    { key: 'pct_to_monthly', label: 'Monthly Pace',     cls: 'num-ctr'  },
    { key: 'mtd',            label: 'MTD Sales',        cls: 'num-ctr'  },
    { key: 'healthy_count',  label: 'Healthy',          cls: 'num-ctr'  },
    { key: 'atrisk_count',   label: 'At Risk',          cls: 'num-ctr'  },
    { key: 'days_idle',      label: 'Idle Days',        cls: 'num-ctr'  },
  ];

  return cols.map(c => {
    const active = c.key && rpSortCol === c.key;
    const sortIcon = active ? `<span class="sort-icon">${rpSortDir === -1 ? '▼' : '▲'}</span>` : '';
    const cls = ['sort-th', c.cls || '', active ? 'sort-active' : ''].filter(Boolean).join(' ');
    if (!c.key) return `<th class="${cls}">${c.label}</th>`;
    return `<th class="${cls}" onclick="rpOnHeaderClick('${c.key}')" style="cursor:pointer;user-select:none">
      <div class="th-inner"><span class="th-label">${c.label}</span><span class="th-tail">${sortIcon}</span></div>
    </th>`;
  }).join('');
}

// ── Table rows ────────────────────────────────────────────────

function rpRenderRows(advisors) {
  const sorted = rpSortedAdvisors(advisors);
  const pctElapsed = rpData?.team?.pct_elapsed ?? 0;

  return sorted.map((a, i) => {
    const rank = i + 1;
    const rankStyle = rank === 1 ? 'font-weight:700;color:#b45309' : 'color:#6b7280';

    const goalNum = a.pct_to_goal;
    const goalOnPace = goalNum != null && goalNum >= pctElapsed;
    const goalStyle = goalOnPace ? 'color:#059669;font-weight:700' : '';

    const paceWidth = Math.min(100, Math.max(0, a.pct_to_monthly ?? 0)).toFixed(1);
    const paceClass = rpPaceClass(a.pace_score);
    const paceStr = a.pace_score != null
      ? (a.pace_score >= 0 ? '+' : '') + a.pace_score.toFixed(1) + 'pp' : '—';

    const atRiskStyle = (a.atrisk_count > 0 || a.critical_count > 0) ? 'color:#ea580c;font-weight:600' : '';
    const idleStr = a.days_idle != null ? a.days_idle + 'd' : '—';

    const rowData = JSON.stringify(a).replace(/"/g, '&quot;');

    return `<tr style="cursor:pointer" onclick="rpOpenDrilldown(${rowData})"
        onmouseenter="this.style.background='#f0f4ff'" onmouseleave="this.style.background=''">
      <td class="num-ctr" style="font-size:12px;${rankStyle}">${rank}</td>
      <td>
        <div style="font-weight:600;color:#1a2332">${escRp(a.displayName)}</div>
        <div style="font-size:11px;color:#6b7280;font-family:monospace">${escRp(a.rep_prefix)} · ${a.accounts} accts</div>
      </td>
      <td class="num-ctr" style="font-weight:600">${rpFmtM(a.ytd)}</td>
      <td class="num-ctr" style="${goalStyle}">${rpFmtPct(goalNum)}</td>
      <td class="num-ctr">
        <div style="display:flex;align-items:center;gap:6px;justify-content:flex-end">
          <div style="width:60px;height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;flex-shrink:0">
            <div style="height:100%;border-radius:3px;width:${paceWidth}%" class="rp-pace-fill ${paceClass}"></div>
          </div>
          <span style="font-size:12px;min-width:44px;text-align:right" class="rp-pace-score ${paceClass}">${paceStr}</span>
        </div>
      </td>
      <td class="num-ctr">${rpFmtM(a.mtd)}</td>
      <td class="num-ctr" style="color:#059669;font-weight:600">${a.healthy_count}</td>
      <td class="num-ctr" style="${atRiskStyle}">${(a.atrisk_count || 0) + (a.critical_count || 0)}</td>
      <td class="num-ctr" style="color:#6b7280">${idleStr}</td>
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
  const tbody = document.getElementById('rp-tbody');
  if (thead) thead.innerHTML = rpRenderHeader();
  if (tbody) tbody.innerHTML = rpRenderRows(rpData.advisors);
}

// ── Full page render ──────────────────────────────────────────

function rpRenderFull() {
  const container = document.getElementById('tab-rp');
  if (!container || !rpData) return;
  const t = rpData.team;

  container.innerHTML = `
    <div style="padding:16px 0 0">
      ${rpRenderKpiPanel(t, rpData.advisors)}
      <div class="tier-filter-bar" style="margin-bottom:8px">
        <span style="font-size:13px;font-weight:600;color:#1a2332">${rpMonthLabel()} — Advisor Standings</span>
        <span style="font-size:12px;color:#6b7280;margin-left:8px">Day ${t.business_days_elapsed} of ${t.business_days_total} &middot; ${t.pct_elapsed}% elapsed</span>
      </div>
      <div class="inv-wrap" style="overflow-x:auto">
        <table class="data-table" id="rp-scorecard-table">
          <thead><tr>${rpRenderHeader()}</tr></thead>
          <tbody id="rp-tbody">${rpRenderRows(rpData.advisors)}</tbody>
        </table>
      </div>
    </div>`;
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

  const pctGoalStr = a.pct_to_goal != null ? a.pct_to_goal.toFixed(1) + '%' : '—';
  const pctMoStr   = a.pct_to_monthly != null ? a.pct_to_monthly.toFixed(1) + '%' : '—';
  const goalOnPace = a.pct_to_goal != null && a.pct_to_goal >= pctElapsed;
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
    const icon = active ? (rpDrillSortDir === -1 ? ' ▼' : ' ▲') : '';
    const cls = ['sort-th', h.cls, active ? 'sort-active' : ''].filter(Boolean).join(' ');
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
            const colors = { Healthy:'#059669', Attention:'#eab308', AtRisk:'#ea580c', Critical:'#dc2626' };
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
    const rowBg  = tierBg[a.tier] || '';
    const tier   = a.tier || 'Healthy';
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
  const tbody = document.getElementById('rp-drill-tbody');
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

  // If drill-down is active, just re-render it
  if (rpDrillAdvisor) { rpRenderDrilldown(); return; }

  // If data already loaded, render immediately
  if (rpData) { rpRenderFull(); return; }

  container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:300px;color:#6b7280;font-size:14px">Loading scorecard…</div>`;

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

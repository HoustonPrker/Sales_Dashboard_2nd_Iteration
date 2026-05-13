// ============================================================
// LEADERBOARD VIEW — Editorial direction
// ============================================================

let lbData    = null;
let lbLoading = false;

// ── CSS variables (scoped to leaderboard panel) ───────────────
const LB_STYLES = `
<style id="lb-style">
  #leaderboard-panel {
    --gold:        #b45309;
    --gold-bg:     #fef9c3;
    --silver:      #57534e;
    --silver-bg:   #e7e5e4;
    --bronze:      #92400e;
    --bronze-bg:   #fff7ed;
    --accent:      #0f766e;
    --accent-soft: #ccfbf1;
    --ink:         #0c0a09;
    --ink-soft:    #44403c;
    --muted:       #78716c;
    --soft:        #e7e5e4;
    --good:        #15803d;
    --danger:      #991b1b;
    --serif:       ui-serif, Georgia, "Times New Roman", serif;
    --mono:        ui-monospace, "SF Mono", Menlo, monospace;
    font-family:   var(--serif);
    background:    #fafaf9;
    color:         var(--ink);
  }
  #leaderboard-panel .lb-kicker {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 10px;
  }
  #leaderboard-panel .lb-headline {
    font-family: var(--serif);
    font-size: 52px;
    font-weight: 700;
    letter-spacing: -0.030em;
    line-height: 1.05;
    color: var(--ink);
    margin-bottom: 12px;
  }
  #leaderboard-panel .lb-deck {
    font-family: var(--serif);
    font-style: italic;
    font-size: 15px;
    line-height: 1.6;
    color: var(--ink-soft);
    max-width: 720px;
  }
  #leaderboard-panel .lb-rule {
    border: none;
    border-bottom: 3px double var(--ink);
    margin: 20px 0 0;
  }
  #leaderboard-panel .lb-stat-strip {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border-top: 1.5px solid var(--ink);
    border-bottom: 1.5px solid var(--ink);
    margin: 0 40px 28px;
  }
  #leaderboard-panel .lb-stat-cell {
    padding: 16px 20px;
    border-right: 1px solid var(--soft);
  }
  #leaderboard-panel .lb-stat-cell:last-child { border-right: none; }
  #leaderboard-panel .lb-stat-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }
  #leaderboard-panel .lb-stat-value {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 700;
    color: var(--ink);
    line-height: 1.1;
  }
  #leaderboard-panel .lb-stat-sub {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    margin-top: 3px;
  }
  #leaderboard-panel .lb-section-kicker {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 14px;
    padding: 0 40px;
  }
  #leaderboard-panel .lb-podium {
    display: grid;
    grid-template-columns: 1fr 1.2fr 1fr;
    gap: 16px;
    padding: 0 40px 28px;
    align-items: end;
    max-width: 1320px;
    margin: 0 auto;
    box-sizing: border-box;
  }
  #leaderboard-panel .lb-podium-box {
    padding: 24px 20px 20px;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    position: relative;
    overflow: hidden;
  }
  #leaderboard-panel .lb-podium-inner {
    position: relative;
    z-index: 1;
  }
  #leaderboard-panel .lb-ghost-rank {
    position: absolute;
    top: -12px;
    right: 14px;
    font-family: var(--serif);
    font-weight: 700;
    letter-spacing: -0.04em;
    line-height: 1;
    pointer-events: none;
    z-index: 0;
    user-select: none;
  }
  #leaderboard-panel .lb-podium-crown {
    font-size: 22px;
    line-height: 1;
    margin-bottom: 4px;
    display: block;
  }
  #leaderboard-panel .lb-podium-rank {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  #leaderboard-panel .lb-podium-name {
    font-family: var(--serif);
    font-weight: 700;
    line-height: 1.1;
    margin-bottom: 10px;
    color: var(--ink);
  }
  #leaderboard-panel .lb-podium-figure {
    font-family: var(--serif);
    font-weight: 700;
    line-height: 1;
    margin-bottom: 4px;
    letter-spacing: -0.02em;
  }
  #leaderboard-panel .lb-podium-subtitle {
    font-family: var(--mono);
    font-style: italic;
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 10px;
    line-height: 1.4;
  }
  #leaderboard-panel .lb-podium-meta {
    font-family: var(--mono);
    font-style: italic;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.6;
    opacity: 0.85;
  }
  #leaderboard-panel .lb-table-wrap {
    padding: 0 40px 40px;
  }
  #leaderboard-panel .lb-table {
    width: 100%;
    border-collapse: collapse;
  }
  #leaderboard-panel .lb-table thead th {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 10px 12px;
    text-align: left;
    border-bottom: 1.5px solid var(--ink);
    font-weight: 400;
  }
  #leaderboard-panel .lb-table thead th.num { text-align: right; }
  #leaderboard-panel .lb-table tbody td {
    padding: 14px 12px;
    border-bottom: 1px solid var(--soft);
    vertical-align: middle;
  }
  #leaderboard-panel .lb-table tbody tr:last-child td { border-bottom: none; }
  #leaderboard-panel .lb-table tbody tr.you-row {
    background: var(--accent-soft);
    border-left: 3px solid var(--accent);
  }
  #leaderboard-panel .lb-table tbody tr.you-row td:first-child {
    padding-left: 9px;
  }
  #leaderboard-panel .lb-rep-name {
    font-family: var(--serif);
    font-weight: 600;
    font-size: 15px;
    color: var(--ink);
  }
  #leaderboard-panel .lb-money {
    font-family: var(--serif);
    font-weight: 600;
    font-size: 14px;
  }
  #leaderboard-panel .lb-meta {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }
  #leaderboard-panel .lb-good  { color: var(--good); }
  #leaderboard-panel .lb-danger { color: var(--danger); }
  #leaderboard-panel .lb-tag {
    display: inline-block;
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 5px;
    border-radius: 3px;
    margin-left: 5px;
    vertical-align: middle;
  }
  #leaderboard-panel .lb-tag-you    { background: var(--accent); color: #fff; }
  #leaderboard-panel .lb-tag-nogoal { background: #f5f5f4; color: var(--muted); border: 1px solid var(--soft); }
  #leaderboard-panel .lb-pill {
    display: inline-block;
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 10px;
    margin: 0 2px;
    font-weight: 600;
  }
  #leaderboard-panel .lb-pill-crit { background: #fee2e2; color: #991b1b; }
  #leaderboard-panel .lb-pill-risk { background: #fef9c3; color: #92400e; }
</style>`;

// ── Entry point ───────────────────────────────────────────────

async function renderLeaderboardView(forceRefresh) {
  const panel = document.getElementById('leaderboard-panel');
  if (!panel) return;

  if (!document.getElementById('lb-style')) {
    panel.insertAdjacentHTML('beforebegin', LB_STYLES);
  }

  if (lbData && !forceRefresh) { renderLBLayout(lbData); return; }

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px;gap:16px">
      <div style="width:40px;height:40px;border:2px solid var(--soft,#e7e5e4);border-top-color:var(--ink,#0c0a09);border-radius:50%;animation:spin 0.8s linear infinite"></div>
      <div style="font-family:ui-serif,Georgia,serif;font-style:italic;font-size:15px;color:#78716c">Building leaderboard…</div>
    </div>`;

  lbLoading = true;
  try {
    const url  = `/proxy/leaderboard${forceRefresh ? '?refresh=1' : ''}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    lbData    = await resp.json();
    lbLoading = false;
    renderLBLayout(lbData);
  } catch (e) {
    lbLoading = false;
    const p = document.getElementById('leaderboard-panel');
    if (p) p.innerHTML = `<div style="padding:40px;font-family:ui-serif,Georgia,serif;color:#991b1b">Error loading leaderboard: ${e.message}</div>`;
  }
}

function resetLeaderboardData() { lbData = null; }

// ── Money helpers ─────────────────────────────────────────────

function lbMoney(v, opts = {}) {
  const n   = parseFloat(v) || 0;
  const abs = Math.abs(n);
  const str = '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const sign = opts.sign ? (n >= 0 ? '+' : '−') : (n < 0 ? '−' : '');
  return sign + str;
}

// ── Main render ───────────────────────────────────────────────

function renderLBLayout(data) {
  const panel = document.getElementById('leaderboard-panel');
  if (!panel) return;

  const { awards, podium, standings, currentMonthLabel, lastMonthLabel,
          totalAccounts, repCount, lastMonthTerritoryRevenue, updatedAt,
          businessDays } = data;

  const updated = updatedAt
    ? new Date(updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';

  const bdPct    = businessDays ? Math.round(businessDays.pctElapsed) : null;
  const bdNote   = bdPct !== null
    ? `${bdPct}% through the business month · ${businessDays.elapsed} of ${businessDays.total} days elapsed`
    : '';
  panel.innerHTML = `
    ${renderLBHeader(updated)}

    <!-- ── April: finalized award section ── -->
    <div style="background:#fdf6e3;border:1px solid #f0e4c8;border-radius:4px;margin:0 24px;padding:0 0 4px">
      ${renderLBMasthead(awards, lastMonthLabel)}
      ${renderLBStatStrip(awards, lastMonthLabel, lastMonthTerritoryRevenue, totalAccounts, repCount)}
    </div>

    <!-- ── May: live race ── -->
    <div style="margin-top:56px;padding:0 40px 12px">
      <div style="font-family:var(--mono);font-size:10px;letter-spacing:0.20em;text-transform:uppercase;color:var(--muted);margin-bottom:10px">Current Race</div>
      <div style="font-family:var(--serif);font-size:26px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);margin-bottom:6px">${currentMonthLabel} — Race in Progress</div>
      <div style="font-family:var(--serif);font-style:italic;font-size:14px;color:var(--ink-soft);margin-bottom:0">${bdNote ? `The race for ${currentMonthLabel}'s Salesperson of the Month · ${bdNote}` : `The race for ${currentMonthLabel}'s Salesperson of the Month`}</div>
      <hr style="border:none;border-bottom:2px solid var(--ink);margin:16px 0 0">
    </div>

    ${renderLBPodium(podium, businessDays)}
    <div class="lb-section-kicker" style="margin-top:4px">Full Standings · ${currentMonthLabel}</div>
    ${renderLBStandings(standings)}`;
}

// ── Header bar ────────────────────────────────────────────────

function renderLBHeader(updated) {
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 40px 24px;border-bottom:1px solid var(--soft)">
      <div style="font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:0.10em">
        Last updated ${updated || '—'}
      </div>
      <button onclick="renderLeaderboardView(true)"
        style="font-family:var(--mono);font-size:11px;letter-spacing:0.10em;padding:6px 14px;background:transparent;border:1px solid var(--soft);border-radius:3px;color:var(--ink-soft);cursor:pointer">
        ↻ Refresh
      </button>
    </div>`;
}

// ── Masthead ──────────────────────────────────────────────────

function renderLBMasthead(awards, lastMonthLabel) {
  const sotm = awards?.sotm;

  if (!sotm) {
    return `
      <div style="padding:32px 40px 20px">
        <div class="lb-kicker">Salesperson of the Month · ${lastMonthLabel} · Final Results</div>
        <div class="lb-deck" style="font-style:normal;color:var(--muted)">
          No eligible reps — no monthly goals are set. Award requires a monthly goal to be configured.
        </div>
        <hr class="lb-rule">
      </div>`;
  }

  const monthOnly = lastMonthLabel.split(' ')[0];
  const kicker    = `🏆 Salesperson of the Month · ${lastMonthLabel} · Final Results`;
  const headline  = `${sotm.repName} Won ${monthOnly}`;

  return `
    <div style="padding:32px 40px 20px">
      <div class="lb-kicker">${kicker}</div>
      <div class="lb-headline">${headline}</div>
      <hr class="lb-rule">
    </div>`;
}

// ── Stat strip ────────────────────────────────────────────────

function renderLBStatStrip(awards, lastMonthLabel, territoryRev, totalAccounts, repCount) {
  const sotm = awards?.sotm;
  const mi   = awards?.mostImproved;
  const month = lastMonthLabel.split(' ')[0];

  const cell = (label, value, sub) => `
    <div class="lb-stat-cell">
      <div class="lb-stat-label">${label}</div>
      <div class="lb-stat-value">${value}</div>
      <div class="lb-stat-sub">${sub}</div>
    </div>`;

  const sotmValue = sotm ? sotm.repName : '—';
  const sotmSub   = sotm
    ? `${lbMoney(sotm.overGoal, { sign: true })} over goal`
    : 'no goals set';

  const miValue = mi ? mi.repName : '—';
  const miSub   = mi
    ? `+${lbMoney(mi.improvement)} vs prior month`
    : 'insufficient data';

  return `
    <div class="lb-stat-strip">
      ${cell('Territory Revenue', lbMoney(territoryRev), `${month} across all reps`)}
      ${cell('Total Accounts', totalAccounts.toLocaleString(), `${repCount} reps competing`)}
      ${cell(`${month} Winner`, sotmValue, sotmSub)}
      ${cell('Most Improved', miValue, miSub)}
    </div>`;
}

// ── Podium ────────────────────────────────────────────────────

function renderLBPodium(podium, businessDays) {
  if (!podium || !podium.length) {
    return `
      <div style="padding:0 40px 28px;font-family:var(--mono);font-size:12px;color:var(--muted);font-style:italic">
        No reps with monthly goals and current-month sales yet.
      </div>`;
  }

  const repByRank = {};
  podium.forEach((r, i) => { repByRank[i + 1] = r; });

  const first  = repByRank[1];
  const second = repByRank[2];

  // Lead indicator for 1st place
  let leadStr = '';
  if (first && second && first.paceScore !== null && second.paceScore !== null) {
    const lead = +(first.paceScore - second.paceScore).toFixed(1);
    if (lead >= 0.5)      leadStr = ` · +${lead} pt lead`;
    else if (lead > 0)    leadStr = ' · narrow lead';
  }

  const configs = {
    1: {
      label:     'First Place',
      crown:     true,
      minHeight: 280,
      marginTop: 0,
      ghostSize: 220,
      ghostColor:'rgba(180, 83, 9, 0.18)',
      nameSize:  28,
      figSize:   52,
      accentClr: '#92400e',
      rankClr:   '#b45309',
      style:     'background:linear-gradient(180deg,#fde68a 0%,#fcd34d 100%);border:3px solid #f59e0b;box-shadow:0 8px 20px -8px rgba(245,158,11,0.4)',
    },
    2: {
      label:     'Second Place',
      crown:     false,
      minHeight: 220,
      marginTop: 30,
      ghostSize: 180,
      ghostColor:'rgba(71, 85, 105, 0.15)',
      nameSize:  22,
      figSize:   38,
      accentClr: '#334155',
      rankClr:   '#57534e',
      style:     'background:linear-gradient(180deg,#f1f5f9 0%,#e2e8f0 100%);border:2px solid #94a3b8',
    },
    3: {
      label:     'Third Place',
      crown:     false,
      minHeight: 180,
      marginTop: 50,
      ghostSize: 180,
      ghostColor:'rgba(146, 64, 14, 0.18)',
      nameSize:  22,
      figSize:   38,
      accentClr: '#9a3412',
      rankClr:   '#92400e',
      style:     'background:linear-gradient(180deg,#fed7aa 0%,#fdba74 100%);border:2px solid #c2410c',
    },
  };

  const displayOrder = [2, 1, 3]; // left=2nd, center=1st, right=3rd

  const boxes = displayOrder.map(rank => {
    const cfg = configs[rank];
    const rep = repByRank[rank];
    if (!rep) return '<div></div>';

    const pctVal = rep.currentMonthGoal > 0
      ? (rep.currentMonthSales / rep.currentMonthGoal * 100).toFixed(1) + '%'
      : '—';

    const subtitle = rank === 1
      ? `to goal${leadStr}`
      : 'to goal';

    const dollarCtx = lbMoney(rep.currentMonthSales);

    const crownHtml = cfg.crown ? `<span class="lb-podium-crown">👑</span>` : '';

    return `
      <div class="lb-podium-box" style="min-height:${cfg.minHeight}px;margin-top:${cfg.marginTop}px;${cfg.style}">
        <span class="lb-ghost-rank" style="font-size:${cfg.ghostSize}px;color:${cfg.ghostColor}">${rank}</span>
        <div class="lb-podium-inner">
          ${crownHtml}
          <div class="lb-podium-rank" style="color:${cfg.rankClr}">${cfg.label}</div>
          <div class="lb-podium-name" style="font-size:${cfg.nameSize}px">${rep.repName}</div>
          <div class="lb-podium-figure" style="font-size:${cfg.figSize}px;color:${cfg.accentClr}">${pctVal}</div>
          <div class="lb-podium-subtitle">${subtitle}</div>
          <div class="lb-podium-meta">${dollarCtx}<br>${rep.accountCount} accounts</div>
        </div>
      </div>`;
  });

  return `
    <div class="lb-podium">${boxes.join('')}</div>`;
}

// ── Standings table ───────────────────────────────────────────

function renderLBStandings(standings) {
  if (!standings || !standings.length) {
    return `<div class="lb-table-wrap" style="font-style:italic;color:var(--muted);font-family:var(--mono);font-size:12px">No rep data available.</div>`;
  }

  const loggedInRep = (typeof currentRep !== 'undefined' ? currentRep : '').trim().toUpperCase();

  const rows = standings.map(r => {
    const isYou = loggedInRep && r.repId.toUpperCase() === loggedInRep;
    const hasGoal = r.currentMonthGoal !== null;

    const pctGoalCell = hasGoal && r.currentMonthGoal > 0
      ? `<span class="lb-meta">${(r.currentMonthSales / r.currentMonthGoal * 100).toFixed(1)}%</span>`
      : `<span class="lb-meta">—</span>`;

    const hs    = r.healthScore;
    const hsClr = hs >= 70 ? 'var(--good)' : hs >= 45 ? '#b45309' : 'var(--danger)';

    const critPill = r.Critical > 0
      ? `<span class="lb-pill lb-pill-crit">${r.Critical} crit</span>` : '';
    const riskPill = r.AtRisk > 0
      ? `<span class="lb-pill lb-pill-risk">${r.AtRisk} risk</span>` : '';

    const youTag    = isYou    ? `<span class="lb-tag lb-tag-you">You</span>`    : '';
    const noGoalTag = !hasGoal ? `<span class="lb-tag lb-tag-nogoal">no goal</span>` : '';

    return `
      <tr class="${isYou ? 'you-row' : ''}">
        <td><span class="lb-meta">${r.standingsRank}</span></td>
        <td>
          <span class="lb-rep-name">${r.repName}</span>${youTag}${noGoalTag}
        </td>
        <td style="text-align:right"><span class="lb-money">${lbMoney(r.currentMonthSales)}</span></td>
        <td style="text-align:right">${pctGoalCell}</td>
        <td style="text-align:right"><span class="lb-meta">${r.accountCount}</span></td>
        <td style="text-align:right"><span style="font-family:var(--mono);font-size:13px;font-weight:600;color:${hsClr}">${hs}</span></td>
        <td style="text-align:right">${critPill}${riskPill}${(!critPill && !riskPill) ? '<span class="lb-meta" style="color:var(--good)">✓</span>' : ''}</td>
      </tr>`;
  });

  return `
    <div class="lb-table-wrap">
      <table class="lb-table">
        <thead>
          <tr>
            <th style="width:36px">#</th>
            <th>Rep</th>
            <th class="num">Month Sales</th>
            <th class="num">% to Goal</th>
            <th class="num">Accounts</th>
            <th class="num">Health</th>
            <th class="num">Alerts</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

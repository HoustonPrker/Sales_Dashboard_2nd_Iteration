// ============================================================
// LEADERBOARD VIEW — Path C redesign, privacy-safe
// ============================================================

let lbData    = null;
let lbLoading = false;

// ── CSS ───────────────────────────────────────────────────────
const LB_STYLES = `
<style id="lb-style">
  #leaderboard-panel {
    --navy:     #1e3a5f;
    --navy-2:   #162d4a;
    --gold:     #fbbf24;
    --gold-bg:  #fef3c7;
    --gold-bdr: #fcd34d;
    --silver-bg:  #f1f5f9;
    --silver-bdr: #cbd5e1;
    --bronze-bg:  #ffedd5;
    --bronze-bdr: #fdba74;
    --ink:      #0c0a09;
    --muted:    #78716c;
    --soft:     #e7e5e4;
    --good:     #15803d;
    --warn:     #b45309;
    --danger:   #991b1b;
    --mono:     ui-monospace, "SF Mono", Menlo, monospace;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #fafaf9;
    color: var(--ink);
  }

  /* ── Toolbar ── */
  #leaderboard-panel .lb-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 24px;
    border-bottom: 1px solid var(--soft);
    background: #fff;
  }
  #leaderboard-panel .lb-toolbar-ts {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.06em;
  }
  #leaderboard-panel .lb-toolbar-btn {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    padding: 5px 13px;
    background: transparent;
    border: 1px solid var(--soft);
    border-radius: 4px;
    color: var(--ink);
    cursor: pointer;
    transition: background 0.12s;
  }
  #leaderboard-panel .lb-toolbar-btn:hover { background: #f5f5f4; }

  /* ── KPI Ribbon ── */
  #leaderboard-panel .lb-ribbon {
    background: var(--navy);
    padding: 20px 28px 24px;
  }
  #leaderboard-panel .lb-ribbon-eyebrow {
    font-family: var(--mono);
    font-size: 15px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 700;
    color: #fff;
    margin-bottom: 10px;
  }
  #leaderboard-panel .lb-ribbon-headline {
    font-size: 32px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #fff;
    margin-bottom: 0;
    line-height: 1.15;
  }
  #leaderboard-panel .lb-ribbon-winner {
    color: var(--gold);
  }
  #leaderboard-panel .lb-ribbon-divider {
    border: none;
    border-top: 1px solid rgba(255,255,255,0.12);
    margin: 0 0 20px;
  }
  #leaderboard-panel .lb-ribbon-tiles {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: rgba(255,255,255,0.1);
    border-radius: 6px;
    overflow: hidden;
  }
  #leaderboard-panel .lb-ribbon-tile {
    background: rgba(255,255,255,0.05);
    padding: 16px 18px;
  }
  #leaderboard-panel .lb-tile-label {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.55);
    margin-bottom: 8px;
  }
  #leaderboard-panel .lb-tile-value {
    font-size: 22px;
    font-weight: 600;
    color: #fff;
    letter-spacing: -0.01em;
    line-height: 1.15;
    margin-bottom: 4px;
  }
  #leaderboard-panel .lb-tile-sub {
    font-family: var(--mono);
    font-size: 11px;
    color: rgba(255,255,255,0.55);
  }

  /* ── Section label ── */
  #leaderboard-panel .lb-section-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 22px 28px 14px;
  }

  /* ── Podium ── */
  #leaderboard-panel .lb-podium {
    display: grid;
    grid-template-columns: 1fr 1.15fr 1fr;
    gap: 14px;
    padding: 0 28px 28px;
    align-items: end;
  }
  #leaderboard-panel .lb-podium-box {
    border-radius: 8px;
    padding: 32px 24px 32px;
    position: relative;
    overflow: hidden;
  }
  #leaderboard-panel .lb-ghost {
    position: absolute;
    top: -12px;
    right: 10px;
    font-size: 150px;
    font-weight: 800;
    line-height: 1;
    pointer-events: none;
    user-select: none;
    z-index: 0;
  }
  #leaderboard-panel .lb-podium-inner { position: relative; z-index: 1; }
  #leaderboard-panel .lb-place-label {
    font-family: var(--mono);
    font-size: 9.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  #leaderboard-panel .lb-podium-name {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin-bottom: 14px;
    color: var(--ink);
    line-height: 1.2;
  }
  #leaderboard-panel .lb-podium-pct {
    font-size: 48px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1;
    margin-bottom: 10px;
  }
  #leaderboard-panel .lb-podium-sub {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }

  /* ── Standings table ── */
  #leaderboard-panel .lb-table-wrap {
    padding: 0 28px 40px;
  }
  #leaderboard-panel .lb-table {
    width: 100%;
    border-collapse: collapse;
  }
  #leaderboard-panel .lb-table thead tr {
    background: var(--navy);
  }
  #leaderboard-panel .lb-table thead th {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.75);
    padding: 11px 14px;
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
  }
  #leaderboard-panel .lb-table thead th.num { text-align: right; }
  #leaderboard-panel .lb-table thead th.ctr { text-align: center; }
  #leaderboard-panel .lb-table tbody td {
    padding: 7px 14px;
    border-bottom: 1px solid var(--soft);
    vertical-align: middle;
    font-size: 13px;
  }
  #leaderboard-panel .lb-table tbody tr:last-child td { border-bottom: none; }
  #leaderboard-panel .lb-table tbody tr:hover td { background: #f5f5f4; }
  #leaderboard-panel .lb-rep-name {
    font-weight: 600;
    font-size: 15px;
    color: var(--ink);
  }
  #leaderboard-panel .lb-meta {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }

  /* ── Pace bar ── */
  #leaderboard-panel .lb-pace-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #leaderboard-panel .lb-pace-bar-bg {
    flex: 1;
    height: 6px;
    background: #e5e7eb;
    border-radius: 3px;
    overflow: hidden;
    min-width: 60px;
    max-width: 120px;
  }
  #leaderboard-panel .lb-pace-bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s;
  }
  #leaderboard-panel .lb-pace-score {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    min-width: 44px;
    text-align: right;
  }
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
      <div style="width:36px;height:36px;border:2px solid #e7e5e4;border-top-color:#0c0a09;border-radius:50%;animation:spin 0.8s linear infinite"></div>
      <div style="font-size:14px;color:#78716c">Building leaderboard…</div>
    </div>`;

  lbLoading = true;
  try {
    const resp = await fetch(`/proxy/leaderboard${forceRefresh ? '?refresh=1' : ''}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    lbData    = await resp.json();
    lbLoading = false;
    renderLBLayout(lbData);
  } catch (e) {
    lbLoading = false;
    const p = document.getElementById('leaderboard-panel');
    if (p) p.innerHTML = `<div style="padding:40px;color:#991b1b">Error loading leaderboard: ${e.message}</div>`;
  }
}

function resetLeaderboardData() { lbData = null; }

// ── Main render ───────────────────────────────────────────────

function renderLBLayout(data) {
  const panel = document.getElementById('leaderboard-panel');
  if (!panel) return;

  const { awards, podium, standings, currentMonthLabel, lastMonthLabel,
          businessDays, updatedAt } = data;

  const updatedTime = updatedAt
    ? new Date(updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '—';

  const bdPct     = businessDays ? Math.round(businessDays.pctElapsed) : null;
  const bdSubLine = businessDays
    ? `${businessDays.elapsed} of ${businessDays.total} business days · ${bdPct}% elapsed`
    : '';

  panel.innerHTML = `
  <div style="border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
    ${renderLBRibbon(awards, lastMonthLabel, updatedTime)}
    <div style="margin-top:28px;padding:0 28px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between">
        <div>
          <div style="font-size:24px;font-weight:600;letter-spacing:-0.01em;text-transform:uppercase;color:var(--ink);line-height:1.1">${currentMonthLabel} — Race in Progress</div>
          ${bdSubLine ? `<div style="font-size:13px;color:var(--muted);margin-top:4px">${bdSubLine}</div>` : ''}
        </div>
        <button onclick="renderLeaderboardView(true)" class="lb-toolbar-btn" style="margin-top:4px">↺ Refresh</button>
      </div>
      <hr style="border:none;border-top:1px solid #e7e5e4;margin:14px 0 20px">
    </div>
    ${renderLBPodium(podium, businessDays)}
    <div style="padding:8px 28px 10px;display:flex;align-items:center;gap:12px">
      <span style="font-family:var(--mono);font-size:10px;letter-spacing:0.20em;text-transform:uppercase;color:var(--muted)">Full Standings</span>
      <div style="flex:1;height:1px;background:#e7e5e4"></div>
    </div>
    ${renderLBStandings(standings)}
  </div>`;
}

// ── Toolbar ───────────────────────────────────────────────────

function renderLBToolbar(updatedTime) {
  return '';
}

// ── KPI Ribbon ────────────────────────────────────────────────

function renderLBRibbon(awards, lastMonthLabel, updatedTime) {
  const sotm = awards?.sotm;
  const mi   = awards?.mostImproved;
  const mc   = awards?.mostConsistent;
  const month = lastMonthLabel.split(' ')[0];
  const year  = lastMonthLabel.split(' ')[1] || '';

  const awardCol = (label, headline) => `
    <div style="flex:1;min-width:0;padding:0 28px 0 0">
      <div class="lb-ribbon-eyebrow">${label}</div>
      <div class="lb-ribbon-headline">${headline}</div>
    </div>`;

  const sotmHeadline = sotm
    ? `<span class="lb-ribbon-winner">${sotm.repName}</span> Won ${month}`
    : `${month} — No Winner`;
  const miHeadline = mi ? mi.repName : '—';
  const mcHeadline = mc ? mc.repName : '—';

  return `
    <div class="lb-ribbon">
      <div style="font-family:var(--mono);font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.55);margin-bottom:16px">${lastMonthLabel.toUpperCase()} — FINAL RESULTS</div>
      <div style="display:flex;align-items:flex-start;gap:0">
        ${awardCol('🏆 Salesperson of the Month Winner', sotmHeadline)}
        <div style="width:1px;background:rgba(255,255,255,0.15);align-self:stretch;margin-right:28px"></div>
        ${awardCol('Most Improved', miHeadline)}
        <div style="width:1px;background:rgba(255,255,255,0.15);align-self:stretch;margin-right:28px"></div>
        ${awardCol('Most Consistent', mcHeadline)}
      </div>
    </div>`;
}

// ── Podium ────────────────────────────────────────────────────

function renderLBPodium(podium, businessDays) {
  if (!podium || !podium.length) {
    return `<div style="padding:0 28px 28px;font-size:13px;color:var(--muted)">No reps with goals and current-month activity yet.</div>`;
  }

  const byRank = {};
  podium.forEach((r, i) => { byRank[i + 1] = r; });

  const first  = byRank[1];
  const second = byRank[2];
  let leadStr = '';
  if (first && second && first.paceScore !== null && second.paceScore !== null) {
    const lead = +(first.paceScore - second.paceScore).toFixed(1);
    if (lead >= 0.5) leadStr = ` · +${lead} pt lead`;
  }

  const configs = {
    1: {
      label: '👑 1st Place', marginTop: 0,
      bg: `background:var(--gold-bg);border:2px solid var(--gold-bdr)`,
      ghost: 'rgba(0,0,0,0.05)', placeClr: '#92400e',
      pctClr: '#b45309', nameSize: '22px', pctSize: '48px',
    },
    2: {
      label: '2nd Place', marginTop: 18,
      bg: `background:var(--silver-bg);border:2px solid var(--silver-bdr)`,
      ghost: 'rgba(0,0,0,0.04)', placeClr: '#475569',
      pctClr: '#334155', nameSize: '20px', pctSize: '44px',
    },
    3: {
      label: '3rd Place', marginTop: 34,
      bg: `background:var(--bronze-bg);border:2px solid var(--bronze-bdr)`,
      ghost: 'rgba(0,0,0,0.05)', placeClr: '#9a3412',
      pctClr: '#c2410c', nameSize: '20px', pctSize: '44px',
    },
  };

  const displayOrder = [2, 1, 3];
  const boxes = displayOrder.map(rank => {
    const cfg = configs[rank];
    const rep = byRank[rank];
    if (!rep) return '<div></div>';

    const pctVal  = rep.pctToGoal !== null ? rep.pctToGoal.toFixed(1) + '%' : '—';
    const subtitle = rank === 1 ? `to goal${leadStr}` : 'to goal';

    return `
      <div class="lb-podium-box" style="margin-top:${cfg.marginTop}px;${cfg.bg}">
        <span class="lb-ghost" style="color:${cfg.ghost}">${rank}</span>
        <div class="lb-podium-inner">
          <div class="lb-place-label" style="color:${cfg.placeClr}">${cfg.label}</div>
          <div class="lb-podium-name" style="font-size:${cfg.nameSize}">${rep.repName}</div>
          <div class="lb-podium-pct" style="color:${cfg.pctClr};font-size:${cfg.pctSize}">${pctVal}</div>
          <div class="lb-podium-sub">${subtitle}</div>
        </div>
      </div>`;
  });

  return `<div class="lb-podium">${boxes.join('')}</div>`;
}

// ── Standings table ───────────────────────────────────────────

function renderLBStandings(standings) {
  if (!standings || !standings.length) {
    return `<div class="lb-table-wrap" style="font-size:13px;color:var(--muted)">No rep data available.</div>`;
  }

  const loggedInRep = (typeof currentRep !== 'undefined' ? currentRep : '').trim().toUpperCase();

  const rows = standings.map(r => {
    const isYou   = loggedInRep && r.repId.toUpperCase() === loggedInRep;
    const pctStr  = r.pctToGoal  !== null ? r.pctToGoal.toFixed(1)  + '%' : '—';
    const hlthStr = r.pctHealthy !== null ? r.pctHealthy + '%' : '—';
    const rankClr = r.standingsRank === 1 ? '#b45309' : 'var(--muted)';
    const ctr     = 'text-align:center';
    const mono    = 'font-family:var(--mono);font-size:13px;font-weight:600;color:var(--ink)';

    return `
      <tr style="${isYou ? 'background:#f0fdf4;border-left:3px solid #16a34a' : ''}">
        <td style="${ctr}"><span style="font-family:var(--mono);font-size:13px;font-weight:700;color:${rankClr}">${r.standingsRank}</span></td>
        <td>
          <span class="lb-rep-name">${r.repName}</span>
          ${isYou ? `<span style="display:inline-block;font-family:var(--mono);font-size:9px;letter-spacing:0.10em;text-transform:uppercase;padding:2px 5px;border-radius:3px;background:#16a34a;color:#fff;margin-left:6px;vertical-align:middle">You</span>` : ''}
        </td>
        <td style="${ctr}"><span style="${mono}">${r.accountCount ?? '—'}</span></td>
        <td style="${ctr}"><span style="${mono}">${hlthStr}</span></td>
        <td style="${ctr}"><span style="${mono}">${pctStr}</span></td>
      </tr>`;
  });

  return `
    <div class="lb-table-wrap">
      <table class="lb-table" style="table-layout:fixed;width:100%">
        <colgroup>
          <col style="width:60px">
          <col style="width:160px">
          <col style="width:120px">
          <col style="width:120px">
          <col style="width:160px">
        </colgroup>
        <thead>
          <tr>
            <th class="ctr">#</th>
            <th>Rep</th>
            <th class="ctr">Accounts</th>
            <th class="ctr">% Healthy</th>
            <th class="ctr">% to Monthly Goal</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

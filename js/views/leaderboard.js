// ============================================================
// LEADERBOARD VIEW
// Territory-wide rep rankings with gamification
// ============================================================

let lbData    = null;   // last fetched leaderboard response
let lbCharts  = {};
let lbLoading = false;

// ── Entry point ───────────────────────────────────────────────

async function renderLeaderboardView(forceRefresh) {
  const panel = document.getElementById('leaderboard-panel');
  if (!panel) return;

  if (lbData && !forceRefresh) { renderLBLayout(lbData); return; }

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px;gap:16px">
      <div style="width:48px;height:48px;border:3px solid #e5e7eb;border-top-color:#3d5a80;border-radius:50%;animation:spin 0.8s linear infinite"></div>
      <div style="font-size:15px;color:#6b7280">Building leaderboard — this may take a moment on first load…</div>
      <div style="font-size:12px;color:#9ca3af">Aggregating sales data across all reps</div>
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
    if (p) p.innerHTML = `<div style="padding:40px;color:#dc2626">Error loading leaderboard: ${e.message}</div>`;
  }
}

function destroyLeaderboardCharts() {
  Object.values(lbCharts).forEach(c => { try { c.destroy(); } catch (_) {} });
  lbCharts = {};
}

function resetLeaderboardData() {
  lbData   = null;
  destroyLeaderboardCharts();
}

// ── Main render ───────────────────────────────────────────────

function renderLBLayout(data) {
  destroyLeaderboardCharts();
  const panel = document.getElementById('leaderboard-panel');
  if (!panel) return;

  const reps    = data.reps || [];
  const top3    = reps.slice(0, 3);
  const rest    = reps.slice(3);
  const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';

  const totalRev    = reps.reduce((s, r) => s + r.ytdSales, 0);
  const totalAccts  = reps.reduce((s, r) => s + r.accountCount, 0);
  const mostImproved = [...reps].filter(r => r.pctChange !== null).sort((a, b) => b.pctChange - a.pctChange)[0];
  const bestHealth   = [...reps].sort((a, b) => b.healthScore - a.healthScore)[0];

  // Special badges
  const badges = {};
  if (reps[0])        badges[reps[0].repId]        = (badges[reps[0].repId] || []).concat('🏆 Top Earner');
  if (mostImproved)   badges[mostImproved.repId]    = (badges[mostImproved.repId] || []).concat('📈 Most Improved');
  if (bestHealth && bestHealth.repId !== reps[0]?.repId)
                      badges[bestHealth.repId]       = (badges[bestHealth.repId] || []).concat('💚 Healthiest Book');

  panel.innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:20px">
      <div>
        <div style="font-size:22px;font-weight:700;color:#1a2332">Sales Leaderboard</div>
        <div style="font-size:13px;color:#6b7280;margin-top:2px">Q${data.quarter} ${data.year} · ${reps.length} reps · Last updated ${updated}</div>
      </div>
      <button onclick="renderLeaderboardView(true)"
        style="display:flex;align-items:center;gap:6px;padding:7px 14px;background:#f0f4f8;border:1px solid #d1d5db;border-radius:8px;font-size:13px;font-weight:600;color:#3d5a80;cursor:pointer;font-family:inherit">
        &#8635; Refresh
      </button>
    </div>

    <!-- Territory KPI bar -->
    <div class="cat-stat-bar" style="margin-bottom:20px">
      <div class="cat-stat-item"><span class="cat-stat-lbl">Territory Revenue:</span><span class="cat-stat-val">${fmt$(totalRev)}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Total Accounts:</span><span class="cat-stat-val">${totalAccts}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Leader:</span><span class="cat-stat-val" style="color:#b45309">${reps[0]?.repName || '—'}</span></div>
      <span class="cat-stat-sep">·</span>
      <div class="cat-stat-item"><span class="cat-stat-lbl">Most Improved:</span><span class="cat-stat-val" style="color:#059669">${mostImproved?.repName || '—'}</span></div>
    </div>

    <!-- Podium -->
    ${top3.length >= 1 ? renderLBPodium(top3, badges) : ''}

    <!-- Revenue chart -->
    <div class="chart-panel" style="margin-bottom:16px">
      <div class="chart-panel-title">YTD Revenue by Rep — Current vs Prior Year</div>
      <div style="position:relative;height:${Math.max(160, reps.length * 38)}px"><canvas id="lb-bar-chart"></canvas></div>
    </div>

    <!-- Full rankings table -->
    <div class="inv-wrap">
      <table class="data-table">
        <thead><tr>
          <th style="width:52px;text-align:center">Rank</th>
          <th>Rep</th>
          <th class="num-ctr">YTD Revenue</th>
          <th class="num-ctr">vs Target</th>
          <th class="num-ctr">YTD Change</th>
          <th class="num-ctr">Accounts</th>
          <th class="num-ctr">Health Score</th>
          <th class="num-ctr">Critical / At-Risk</th>
        </tr></thead>
        <tbody>
          ${reps.map(r => renderLBRow(r, badges)).join('')}
        </tbody>
      </table>
    </div>`;

  setTimeout(() => renderLBCharts(reps), 0);
}

// ── Podium ────────────────────────────────────────────────────

function renderLBPodium(top3, badges) {
  const medal  = ['🥇','🥈','🥉'];
  const colors = ['#f59e0b','#9ca3af','#cd7c41'];
  const heights= ['140px','110px','90px'];
  const order  = [1, 0, 2]; // display order: silver left, gold center, bronze right

  const card = (r, displayIdx) => {
    if (!r) return '<div style="flex:1"></div>';
    const pct    = r.pctToTarget > 0 ? (r.pctToTarget * 100).toFixed(1) + '%' : '—';
    const chg    = r.pctChange !== null ? (r.pctChange >= 0 ? '+' : '') + (r.pctChange * 100).toFixed(1) + '%' : '—';
    const chgCls = r.pctChange === null ? '#9ca3af' : r.pctChange >= 0 ? '#059669' : '#dc2626';
    const repBadges = (badges[r.repId] || []).join(' ');
    return `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:0">
        <div style="text-align:center;margin-bottom:10px">
          <div style="font-size:13px;font-weight:700;color:#1a2332">${r.repName}</div>
          <div style="font-size:20px;font-weight:800;color:#1a2332;margin:4px 0">${fmt$(r.ytdSales)}</div>
          <div style="font-size:12px;color:#6b7280">${pct} to target · <span style="color:${chgCls}">${chg} YoY</span></div>
          ${repBadges ? `<div style="font-size:11px;margin-top:4px;color:#6b7280">${repBadges}</div>` : ''}
        </div>
        <div style="width:100%;height:${heights[displayIdx]};background:${colors[displayIdx]};border-radius:8px 8px 0 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;box-shadow:0 4px 12px rgba(0,0,0,0.12)">
          <div style="font-size:32px;line-height:1">${medal[r.rank - 1]}</div>
          <div style="font-size:22px;font-weight:900;color:rgba(0,0,0,0.35)">#${r.rank}</div>
        </div>
      </div>`;
  };

  const orderedReps = order.map(i => top3[i] || null);
  return `
    <div style="display:flex;align-items:flex-end;gap:12px;margin-bottom:20px;padding:0 20px">
      ${orderedReps.map((r, di) => card(r, order[di])).join('')}
    </div>`;
}

// ── Table row ─────────────────────────────────────────────────

function renderLBRow(r, badges) {
  const medal   = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : '';
  const rankStr = medal ? `<span style="font-size:18px">${medal}</span>` : `<span style="font-size:13px;color:#9ca3af;font-weight:600">#${r.rank}</span>`;

  const pct     = r.pctToTarget > 0 ? (r.pctToTarget * 100).toFixed(1) + '%' : '—';
  const barPct  = Math.min(r.pctToTarget * 100, 100);
  const barClr  = r.pctToTarget >= 1.0 ? '#059669' : r.pctToTarget >= 0.75 ? '#d97706' : '#dc2626';

  const chg     = r.pctChange !== null ? (r.pctChange >= 0 ? '↑ +' : '↓ ') + (r.pctChange * 100).toFixed(1) + '%' : '—';
  const chgCls  = r.pctChange === null ? '' : r.pctChange >= 0 ? 'vel-up' : 'vel-down';

  const hs      = r.healthScore;
  const hsClr   = hs >= 70 ? '#059669' : hs >= 45 ? '#d97706' : '#dc2626';

  const repBadges = (badges[r.repId] || []).map(b =>
    `<span style="font-size:10px;background:#f0f4f8;border-radius:4px;padding:1px 5px;color:#3d5a80;margin-left:4px">${b}</span>`
  ).join('');

  return `<tr>
    <td style="text-align:center">${rankStr}</td>
    <td>
      <span style="font-weight:600;color:#1a2332">${r.repName}</span>${repBadges}
    </td>
    <td class="num-ctr" style="font-weight:700">${fmt$(r.ytdSales)}</td>
    <td class="num-ctr">
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
        <span style="font-size:12px;color:${barClr};font-weight:600">${pct}</span>
        <div style="width:80px;height:5px;background:#e5e7eb;border-radius:3px;overflow:hidden">
          <div style="width:${barPct}%;height:100%;background:${barClr};border-radius:3px"></div>
        </div>
      </div>
    </td>
    <td class="num-ctr"><span class="${chgCls}">${chg}</span></td>
    <td class="num-ctr">${r.accountCount}</td>
    <td class="num-ctr">
      <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px">
        <span style="font-size:13px;font-weight:700;color:${hsClr}">${hs}</span>
        <div style="width:48px;height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden">
          <div style="width:${hs}%;height:100%;background:${hsClr};border-radius:3px"></div>
        </div>
      </div>
    </td>
    <td class="num-ctr">
      ${r.Critical > 0 ? `<span style="color:#dc2626;font-weight:700">${r.Critical}🔴</span> ` : ''}
      ${r.AtRisk   > 0 ? `<span style="color:#d97706;font-weight:600">${r.AtRisk}🟡</span>` : ''}
      ${r.Critical === 0 && r.AtRisk === 0 ? '<span style="color:#059669">✓ Clean</span>' : ''}
    </td>
  </tr>`;
}

// ── Charts ────────────────────────────────────────────────────

function renderLBCharts(reps) {
  destroyLeaderboardCharts();
  const ctx = document.getElementById('lb-bar-chart');
  if (!ctx || !reps.length) return;

  const sorted = [...reps].sort((a, b) => b.ytdSales - a.ytdSales);

  lbCharts.bar = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: sorted.map(r => r.repName),
      datasets: [
        { label: 'Current YTD', data: sorted.map(r => r.ytdSales),  backgroundColor: sorted.map((r,i) => i===0?'#f59e0b':i===1?'#9ca3af':i===2?'#cd7c41':'#3d5a80'), borderRadius: 3 },
        { label: 'Prior YTD',   data: sorted.map(r => r.priorYtd),  backgroundColor: 'rgba(0,0,0,0.08)', borderRadius: 3 },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { font:{size:11}, boxWidth:12, padding:8 } },
        tooltip: {
          backgroundColor:'#fff', titleColor:'#1a2332', bodyColor:'#374151',
          borderColor:'#e5e7eb', borderWidth:1, padding:10,
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt$(ctx.parsed.x)}` },
        },
      },
      scales: {
        x: { ticks:{ font:{size:11}, color:'#6b7280', callback: v => fmtRevMM(v) }, grid:{ color:'rgba(0,0,0,0.04)' } },
        y: { ticks:{ font:{size:12}, color:'#374151' }, grid:{ display:false } },
      },
    },
  });
}

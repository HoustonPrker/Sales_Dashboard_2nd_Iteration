// ============================================================
// CSAT — Customer Satisfaction Score
// Derived 0-100 score from behavioral signals + rep override
// ============================================================

// ── Derived score from account data ──────────────────────────
// Three components, each capped and summed to 100:
//   Recency (0-40): days since last order
//   Growth  (0-40): YTD % change vs prior year
//   Pace    (0-20): YTD progress vs run-rate target

function computeCSAT({ daysSinceOrder, pctChange, pctToTarget }) {
  const d = (daysSinceOrder != null ? daysSinceOrder : 999);
  const recency = d <= 14 ? 40 : d <= 30 ? 30 : d <= 45 ? 20 : d <= 60 ? 10 : d <= 90 ? 5 : 0;

  const growth = (pctChange == null)
    ? 20                          // no prior year → neutral
    : pctChange >= 0.15  ? 40
    : pctChange >= 0.05  ? 32
    : pctChange >= -0.05 ? 24
    : pctChange >= -0.15 ? 12
    : pctChange >= -0.30 ? 4
    : 0;

  const t = pctToTarget || 0;
  const pace = t >= 1.0 ? 20 : t >= 0.85 ? 16 : t >= 0.70 ? 12 : t >= 0.50 ? 6 : 0;

  return recency + growth + pace;
}

// ── Display helpers ───────────────────────────────────────────

function csatColor(score) {
  return score >= 70 ? '#059669' : score >= 45 ? '#d97706' : '#dc2626';
}

function csatLabel(score) {
  return score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Poor';
}

// ── Rep override (localStorage) ───────────────────────────────

function csatGetOverride(custNo) {
  try {
    const raw = localStorage.getItem('ks_csat_' + custNo);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function csatSetOverride(custNo, score) {
  try {
    localStorage.setItem('ks_csat_' + custNo, JSON.stringify({ score, updatedAt: new Date().toISOString() }));
  } catch (_) {}
}

function csatClearOverride(custNo) {
  try { localStorage.removeItem('ks_csat_' + custNo); } catch (_) {}
}

// ── Resolve: override wins, else derived ─────────────────────
// Returns { score: number, isOverride: boolean }

function csatResolve(account) {
  const custNo = account.custNo;
  const ov = custNo ? csatGetOverride(custNo) : null;
  if (ov && ov.score != null) return { score: +ov.score, isOverride: true };
  return { score: computeCSAT(account), isOverride: false };
}

// ── Inline edit UI (called from onclick) ─────────────────────

function csatEditOpen(custNo, derivedScore) {
  const wrap    = document.getElementById('csat-edit-wrap-' + custNo);
  const display = document.getElementById('csat-display-' + custNo);
  const inp     = document.getElementById('csat-inp-' + custNo);
  if (!wrap || !display) return;
  const ov = csatGetOverride(custNo);
  inp.value = ov ? ov.score : derivedScore;
  display.style.display = 'none';
  wrap.style.display    = 'flex';
  inp.focus();
  inp.select();
}

function csatEditSave(custNo) {
  const inp = document.getElementById('csat-inp-' + custNo);
  if (!inp) return;
  const val = parseInt(inp.value, 10);
  if (!isNaN(val) && val >= 0 && val <= 100) {
    csatSetOverride(custNo, val);
  }
  csatEditClose(custNo);
  _csatRefreshCard(custNo);
}

function csatEditClear(custNo) {
  csatClearOverride(custNo);
  csatEditClose(custNo);
  _csatRefreshCard(custNo);
}

function csatEditClose(custNo) {
  const wrap    = document.getElementById('csat-edit-wrap-' + custNo);
  const display = document.getElementById('csat-display-' + custNo);
  if (wrap)    wrap.style.display    = 'none';
  if (display) display.style.display = '';
}

function _csatRefreshCard(custNo) {
  // Find account data — fall back to re-deriving from visible KPI values
  let account = null;
  if (typeof accountsData !== 'undefined') {
    account = accountsData.find(a => a.custNo === custNo);
  }
  if (!account) {
    // Derive from page-level globals set during renderCA
    account = window._csatLastAccount || {};
  }
  account.custNo = custNo;
  const { score, isOverride } = csatResolve(account);
  const clr   = csatColor(score);
  const lbl   = csatLabel(score);
  const derived = computeCSAT(account);

  const scoreEl = document.getElementById('csat-score-' + custNo);
  const lblEl   = document.getElementById('csat-lbl-'   + custNo);
  const subEl   = document.getElementById('csat-sub-'   + custNo);
  const barEl   = document.getElementById('csat-bar-'   + custNo);
  if (scoreEl) { scoreEl.textContent = score; scoreEl.style.color = clr; }
  if (lblEl)   lblEl.textContent  = lbl;
  if (barEl)   { barEl.style.width = score + '%'; barEl.style.background = clr; }
  if (subEl)   subEl.innerHTML = isOverride
    ? `Rep-entered · <a style="color:#9ca3af;cursor:pointer;text-decoration:underline" onclick="csatEditClear('${custNo}')">reset</a>`
    : `Derived · <a style="color:#9ca3af;cursor:pointer;text-decoration:underline" onclick="csatEditOpen('${custNo}',${derived})">override</a>`;
}

// ── Build KPI card HTML ───────────────────────────────────────

function buildCSATCard(account) {
  const custNo  = account.custNo || '';
  const { score, isOverride } = csatResolve(account);
  const derived = computeCSAT(account);
  const clr  = csatColor(score);
  const lbl  = csatLabel(score);
  const sub  = isOverride
    ? `Rep-entered · <a style="color:#9ca3af;cursor:pointer;text-decoration:underline" onclick="csatEditClear('${custNo}')">reset</a>`
    : `Derived · <a style="color:#9ca3af;cursor:pointer;text-decoration:underline" onclick="csatEditOpen('${custNo}',${derived})">override</a>`;

  // Store a reference for _csatRefreshCard when accountsData isn't available
  window._csatLastAccount = account;

  return `
    <div class="kpi-card kpi-card-status" style="position:relative">
      <div class="kpi-lbl" style="display:flex;align-items:center;gap:6px">
        CSAT Score
        <svg onclick="csatEditOpen('${custNo}',${derived})" title="Edit CSAT" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="cursor:pointer;flex-shrink:0;margin-top:1px">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </div>

      <!-- Display state -->
      <div id="csat-display-${custNo}">
        <div class="kpi-val" style="font-size:26px;color:${clr}" id="csat-score-${custNo}">${score}</div>
        <div style="width:100%;height:4px;background:#e5e7eb;border-radius:2px;margin:4px 0 2px">
          <div id="csat-bar-${custNo}" style="height:100%;width:${score}%;background:${clr};border-radius:2px;transition:width 0.3s"></div>
        </div>
        <div class="kpi-sub" style="font-weight:600;color:${clr}" id="csat-lbl-${custNo}">${lbl}</div>
        <div class="kpi-sub" id="csat-sub-${custNo}" style="font-size:10px;margin-top:2px">${sub}</div>
      </div>

      <!-- Edit state -->
      <div id="csat-edit-wrap-${custNo}" style="display:none;flex-direction:column;gap:6px;margin-top:4px">
        <input id="csat-inp-${custNo}" type="number" min="0" max="100"
          style="width:100%;padding:4px 8px;border:1.5px solid #3d5a80;border-radius:6px;font-size:18px;font-weight:700;text-align:center;color:#1a2332;font-family:inherit"
          onkeydown="if(event.key==='Enter')csatEditSave('${custNo}');if(event.key==='Escape')csatEditClose('${custNo}')">
        <div style="display:flex;gap:6px">
          <button onclick="csatEditSave('${custNo}')"
            style="flex:1;background:#3d5a80;color:#fff;border:none;border-radius:5px;padding:4px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Save</button>
          <button onclick="csatEditClose('${custNo}')"
            style="flex:1;background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb;border-radius:5px;padding:4px;font-size:12px;cursor:pointer;font-family:inherit">Cancel</button>
        </div>
        <div style="font-size:10px;color:#9ca3af;text-align:center">0 = Poor · 100 = Excellent</div>
      </div>
    </div>`;
}

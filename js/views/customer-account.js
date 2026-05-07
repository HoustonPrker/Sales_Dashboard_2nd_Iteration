// ============================================================
// CUSTOMER ACCOUNT VIEW
// Deep-dive single-customer page
// ============================================================

let caCustNo      = null;
let caCharts      = {};
let caCatSort     = { col: 'currentYtdAmt', dir: 'desc' };
let caDrill       = null; // null = overview | { category, tab: 'ytd'|'best' }
let caAiCtrl      = null; // AbortController for in-flight AI stream
let caConversation = [];  // [{role,content}] full chat history

const tooltip = {
  backgroundColor: '#fff', titleColor: '#1a2332', bodyColor: '#374151',
  borderColor: '#e5e7eb', borderWidth: 1, padding: 10,
  titleFont: { family: 'Inter, sans-serif', size: 12, weight: '600' },
  bodyFont:  { family: 'Inter, sans-serif', size: 12 },
};

// ── Entry point ───────────────────────────────────────────────

async function loadCustomerAccount(custNo) {
  if (caAiCtrl) { caAiCtrl.abort(); caAiCtrl = null; }
  resetCAState();
  caCustNo       = custNo;
  caDrill        = null;
  caCatSort      = { col: 'currentYtdAmt', dir: 'desc' };
  caConversation = [];
  Object.keys(caOrderLinesCache).forEach(k => delete caOrderLinesCache[k]);

  window.location.hash = `#/customer?cust=${encodeURIComponent(custNo)}`;

  const panel = document.getElementById('customer-account-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;padding:60px;color:#6b7280;font-size:15px">
      Loading account <strong style="margin-left:6px;color:#3d5a80">${custNo}</strong>…
    </div>`;

  try {
    const enc = encodeURIComponent(custNo);
    const [custResp, catResp, mtdResp, ordersResp] = await Promise.all([
      fetch(`/proxy/customer/${enc}`),
      fetch(`/proxy/categories/${enc}`),
      fetch(`/proxy/mtd/${enc}`),
      fetch(`/proxy/orders/${enc}`),
    ]);

    const cust    = custResp.ok    ? await custResp.json()    : {};
    const catData = catResp.ok     ? await catResp.json()     : [];
    const mtd     = mtdResp.ok     ? await mtdResp.json()     : { total: 0, orderDays: 0 };
    const orders  = ordersResp.ok  ? await ordersResp.json()  : [];

    renderCA(cust, catData, mtd, orders);
    ensureAITab();
    setTimeout(() => renderCACharts(catData, orders), 0);
    startAIPitch(cust, catData, mtd);
  } catch (e) {
    const p = document.getElementById('customer-account-panel');
    if (p) p.innerHTML = `<div style="padding:40px;color:#dc2626">Error loading account: ${e.message}</div>`;
  }
}

function destroyCACharts() {
  Object.values(caCharts).forEach(c => { try { c.destroy(); } catch (_) {} });
  caCharts = {};
}

function resetCAState() {
  closeAIDrawer();
  removeAITab();
  destroyCACharts();
}

// ── Empty default state (shown before any customer is selected) ─

function renderCAEmpty() {
  const panel = document.getElementById('customer-account-panel');
  if (!panel) return;

  const emptyKpi = (lbl, sub) => `
    <div class="kpi-card kpi-card-sales">
      <div class="kpi-lbl">${lbl}</div>
      <div class="kpi-val" style="font-size:26px;color:#d1d5db">—</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;

  panel.innerHTML = `
    <div class="cat-nav-breadcrumb" style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div style="display:flex;align-items:center">
        <span style="color:#9ca3af;font-size:13px">Select a customer to view their account</span>
      </div>
    </div>

    <div class="item-header-card" style="flex-direction:column;align-items:flex-start;gap:10px;padding:18px 24px">
      <div style="display:flex;align-items:center;gap:16px;width:100%;flex-wrap:wrap">
        <div class="hdr-name" style="font-size:26px;color:#d1d5db">Customer Name</div>
        <span style="background:#f3f4f6;color:#d1d5db;padding:4px 14px;border-radius:8px;font-size:13px;font-weight:600">—</span>
      </div>
      <div class="hdr-meta-row" style="justify-content:flex-start">
        <span class="hdr-pill"><span class="hdr-lbl">Acct #</span><span class="hdr-val" style="color:#d1d5db">—</span></span>
        <span class="hdr-pill"><span class="hdr-lbl">Rep</span><span class="hdr-val" style="color:#d1d5db">—</span></span>
        <span class="hdr-pill"><span class="hdr-lbl">State</span><span class="hdr-val" style="color:#d1d5db">—</span></span>
        <span class="hdr-pill"><span class="hdr-lbl">Segment</span><span class="hdr-val" style="color:#d1d5db">—</span></span>
        <span class="hdr-pill"><span class="hdr-lbl">Last Order</span><span class="hdr-val" style="color:#d1d5db">—</span></span>
      </div>
    </div>

    <div class="kpi-row" style="grid-template-columns:repeat(7,1fr)">
      ${emptyKpi('YTD Sales',       'Current year to date')}
      ${emptyKpi('% to Target',     'vs prior same period')}
      ${emptyKpi('Prior YTD',       'Same period last year')}
      ${emptyKpi('YTD Change',      'vs prior year')}
      ${emptyKpi('Month to Date',   'This month')}
      ${emptyKpi('Days Since Order','Last order date')}
      ${emptyKpi('Target (Annual)', 'Prior YTD baseline')}
    </div>

    <div class="rank-strip" style="margin-bottom:12px">
      <div class="rank-text">
        <div class="rank-main">YTD Performance vs Target <span class="rank-pct" style="color:#d1d5db">—</span></div>
        <div class="rank-method" style="color:#d1d5db">Search for a customer above to load their account</div>
      </div>
      <div class="rank-bar-wrap" style="width:320px">
        <div class="rank-bar-fill" style="width:0%;background:#d1d5db"></div>
        <div class="rank-bar-lbl">—</div>
      </div>
    </div>

    <div class="charts-row" id="ca-charts-row">
      <div class="chart-panel">
        <div class="chart-title">Category Sales — Current vs Prior YTD</div>
        <div class="chart-container" style="height:300px;display:flex;align-items:center;justify-content:center;color:#d1d5db;font-size:14px">
          No data loaded
        </div>
      </div>
      <div class="chart-panel">
        <div class="chart-title">Order History</div>
        <div class="chart-container" style="height:300px;display:flex;align-items:center;justify-content:center;color:#d1d5db;font-size:14px">
          No data loaded
        </div>
      </div>
    </div>

    <div class="inv-wrap" style="margin-top:12px">
      <table class="data-table">
        <thead><tr>
          <th>Category</th>
          <th class="num-ctr">Current YTD</th>
          <th class="num-ctr">Prior YTD</th>
          <th class="num-ctr">Change</th>
          <th class="num-ctr">% of Total</th>
          <th class="num-ctr">Cadence</th>
        </tr></thead>
        <tbody>
          <tr><td colspan="6" style="padding:32px;text-align:center;color:#d1d5db">Search for a customer above to load their data</td></tr>
        </tbody>
      </table>
    </div>`;
}

// ── Main render ───────────────────────────────────────────────

function renderCA(cust, catData, mtd, orders) {
  const panel = document.getElementById('customer-account-panel');
  if (!panel) return;

  const name      = cust.name || cust.custNo || '—';
  const custNo    = cust.custNo || caCustNo;
  const state     = cust.state || '—';
  const salesRep  = cust.salesRep || '—';
  const segment   = cust.categoryCode || '—';
  const phone     = cust.phone1 || cust.phone2 || cust.busPhone || cust.phoneNo || cust.phone || '';
  const lastDate  = cust.lastSaleDate ? cust.lastSaleDate.slice(0, 10) : null;
  const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate)) / 86400000) : null;

  const ytdTotal   = catData.reduce((s, c) => s + c.currentYtdAmt, 0);
  const priorTotal = catData.reduce((s, c) => s + c.priorYtdAmt,   0);
  const target     = priorTotal;
  const pctToTgt   = target > 0 ? ytdTotal / target : 0;
  const pctChange  = priorTotal > 0 ? (ytdTotal - priorTotal) / priorTotal : null;
  const mtdTotal   = mtd?.total || 0;

  // Determine account tier from accounts data if loaded
  let tier = 'Unknown';
  if (typeof accountsData !== 'undefined') {
    const acct = accountsData.find(a => a.custNo === custNo);
    if (acct) tier = acct.tier;
  }
  if (tier === 'Unknown') {
    const ds = daysSince || 999;
    const now2    = new Date();
    const dayOfYr = Math.floor((now2 - new Date(now2.getFullYear(), 0, 1)) / 86400000) + 1;
    const runRate = dayOfYr / 365;
    if (ds >= 90 || (priorTotal > 0 && ytdTotal < priorTotal * 0.5)) tier = 'Critical';
    else if (ds >= 45 || (priorTotal > 0 && pctToTgt < (runRate - 0.25))) tier = 'AtRisk';
    else if (priorTotal === 0) tier = (ds <= 30 && ytdTotal > 0) ? 'Healthy' : ds <= 45 ? 'Attention' : 'AtRisk';
    else if (ds <= 30 && pctToTgt >= (runRate - 0.10)) tier = 'Healthy';
    else tier = 'Attention';
  }
  const tierCls = `tier-${tier.toLowerCase().replace('atrisk','atrisk')}`;

  // Progress bar
  const barPct    = Math.min(pctToTgt * 100, 100);
  const barColor  = pctToTgt >= 1.0 ? '#059669' : pctToTgt >= 0.75 ? '#d97706' : '#dc2626';
  const barLabel  = target > 0 ? (pctToTgt * 100).toFixed(1) + '% to target' : 'No prior year target';

  // Days badge color
  const daysCls = !daysSince ? '' : daysSince <= 14 ? 'vel-up' : daysSince <= 30 ? 'vel-ss' : 'vel-down';

  // Change arrow
  const chgArrow = pctChange === null ? '' : pctChange >= 0 ? '↑' : '↓';
  const chgCls   = pctChange === null ? '' : pctChange >= 0 ? 'vel-up' : 'vel-down';
  const chgStr   = pctChange !== null ? (pctChange >= 0 ? '+' : '') + (pctChange * 100).toFixed(1) + '%' : '—';

  panel.innerHTML = `
    <!-- Back link -->
    <div class="cat-nav-breadcrumb" style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div style="display:flex;align-items:center">
        <a class="cat-back-link" onclick="switchTab('store')">← Account Performance</a>
        <span style="color:#9ca3af;margin:0 8px">/</span>
        <span style="color:#1a2332;font-weight:600">${name}</span>
      </div>
      <button onclick="openProductListModal('${custNo.replace(/'/g,"\\'")}','${name.replace(/'/g,"\\'")}')"
        style="display:flex;align-items:center;gap:7px;background:#0d9488;color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>
        Generate Product List
      </button>
    </div>

    <!-- Customer header -->
    <div class="item-header-card" style="flex-direction:column;align-items:flex-start;gap:10px;padding:18px 24px">
      <div style="display:flex;align-items:center;gap:16px;width:100%;flex-wrap:wrap">
        <div class="hdr-name" style="font-size:26px">${name}</div>
        <span class="tier-badge ${tierCls}" style="font-size:13px;padding:4px 14px">${tier.replace('AtRisk','At Risk')}</span>
        ${daysSince !== null ? (() => {
          const bg = daysSince <= 14 ? 'rgba(22,163,74,0.35)' : daysSince <= 30 ? 'rgba(217,119,6,0.35)' : 'rgba(220,38,38,0.35)';
          const border = daysSince <= 14 ? 'rgba(134,239,172,0.5)' : daysSince <= 30 ? 'rgba(252,211,77,0.5)' : 'rgba(252,165,165,0.5)';
          return `<span style="font-size:13px;font-weight:600;background:${bg};border:1px solid ${border};border-radius:6px;padding:4px 12px;white-space:nowrap;color:#fff">${daysSince}d since last order</span>`;
        })() : ''}
      </div>
      <div class="hdr-meta-row" style="justify-content:flex-start">
        <span class="hdr-pill"><span class="hdr-lbl">Acct #</span><span class="hdr-val">${custNo}</span></span>
        <span class="hdr-pill"><span class="hdr-lbl">Rep</span><span class="hdr-val">${salesRep}</span></span>
        <span class="hdr-pill"><span class="hdr-lbl">State</span><span class="hdr-val">${state}</span></span>
        <span class="hdr-pill"><span class="hdr-lbl">Segment</span><span class="hdr-val">${segment}</span></span>
        ${lastDate ? `<span class="hdr-pill"><span class="hdr-lbl">Last Order</span><span class="hdr-val">${lastDate}</span></span>` : ''}
        ${phone ? `<span class="hdr-pill"><span class="hdr-lbl">Phone</span><a href="tel:${phone.replace(/[^\d+]/g,'')}" class="hdr-val" style="color:#0d9488;text-decoration:none;font-weight:600" title="Call ${phone}">${phone}</a></span>` : ''}
      </div>
    </div>

    <!-- KPI row -->
    <div class="kpi-row" style="grid-template-columns:repeat(7,1fr)">
      <div class="kpi-card kpi-card-sales">
        <div class="kpi-lbl">YTD Sales</div>
        <div class="kpi-val" style="font-size:26px">${fmt$(ytdTotal)}</div>
        <div class="kpi-sub">Current year to date</div>
      </div>
      <div class="kpi-card kpi-card-vel">
        <div class="kpi-lbl">% to Target</div>
        <div class="kpi-val" style="font-size:26px;color:${barColor}">${target > 0 ? (pctToTgt * 100).toFixed(1) + '%' : '—'}</div>
        <div class="kpi-sub">vs prior same period</div>
      </div>
      <div class="kpi-card kpi-card-sales">
        <div class="kpi-lbl">Prior YTD</div>
        <div class="kpi-val" style="font-size:26px">${priorTotal > 0 ? fmt$(priorTotal) : '—'}</div>
        <div class="kpi-sub">Same period last year</div>
      </div>
      <div class="kpi-card kpi-card-sales">
        <div class="kpi-lbl">YTD Change</div>
        <div class="kpi-val" style="font-size:26px"><span class="${chgCls}">${chgArrow} ${chgStr}</span></div>
        <div class="kpi-sub">${fmt$(ytdTotal - priorTotal)} vs prior</div>
      </div>
      <div class="kpi-card kpi-card-sales">
        <div class="kpi-lbl">Month to Date</div>
        <div class="kpi-val" style="font-size:26px">${fmt$(mtdTotal)}</div>
        <div class="kpi-sub">${mtd?.orderDays || 0} order days this month</div>
      </div>
      <div class="kpi-card kpi-card-status">
        <div class="kpi-lbl">Days Since Order</div>
        <div class="kpi-val" style="font-size:26px"><span class="${daysCls}">${daysSince !== null ? daysSince : '—'}</span></div>
        <div class="kpi-sub">${lastDate || 'No orders found'}</div>
      </div>
      <div class="kpi-card kpi-card-status">
        <div class="kpi-lbl">Target (Annual)</div>
        <div class="kpi-val" style="font-size:26px">${target > 0 ? fmt$(target) : '—'}</div>
        <div class="kpi-sub">Prior YTD baseline</div>
      </div>
    </div>

    <!-- Progress bar -->
    <div class="rank-strip" style="margin-bottom:12px">
      <div class="rank-text">
        <div class="rank-main">YTD Performance vs Target
          <span class="rank-pct" style="color:${barColor === '#059669' ? '#86efac' : barColor === '#d97706' ? '#fcd34d' : '#fca5a5'}">
            ${target > 0 ? (pctToTgt * 100).toFixed(1) + '%' : '—'}
          </span>
        </div>
        <div class="rank-method">${fmt$(ytdTotal)} of ${fmt$(target)} target · ${chgStr} vs prior year</div>
      </div>
      <div class="rank-bar-wrap" style="width:320px">
        <div class="rank-bar-fill" id="ca-progress-bar" style="width:0%;background:${barColor}"></div>
        <div class="rank-bar-lbl">${barLabel}</div>
      </div>
    </div>

    <!-- Charts -->
    <div class="charts-row" id="ca-charts-row">
      <div class="chart-panel">
        <div class="chart-title">Category Sales — Current vs Prior YTD</div>
        <div class="chart-container" style="height:300px"><canvas id="ca-bar-chart"></canvas></div>
      </div>
      <div class="chart-panel">
        <div class="chart-title">Category Mix</div>
        <div class="chart-container" style="height:260px"><canvas id="ca-donut-chart"></canvas></div>
      </div>
      <div class="chart-panel">
        <div class="chart-title">Monthly Sales — ${new Date().getFullYear()}</div>
        <div class="chart-container" style="height:260px"><canvas id="ca-monthly-chart"></canvas></div>
      </div>
    </div>

    <!-- Category table -->
    <div id="ca-cat-section">
      ${buildCatTable(catData)}
    </div>

    <!-- Order History (full width) -->
    <div class="card" style="margin-bottom:12px" id="ca-orders-card">
      <div class="card-title">
        Order History <span style="font-weight:400;color:#9ca3af;font-size:12px;text-transform:none">(${Math.min(orders.length, 5)} most recent)</span>
      </div>
      ${buildOrderHistory(orders)}
    </div>

    <!-- AI Sales Assistant drawer (slides in from right) -->
    <div id="ca-ai-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.15);z-index:1999" onclick="closeAIDrawer()"></div>
    <div id="ca-ai-drawer" style="position:fixed;top:0;right:0;height:100vh;width:440px;max-width:96vw;background:#fff;box-shadow:-8px 0 40px rgba(0,0,0,0.2);z-index:2001;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.32s cubic-bezier(0.4,0,0.2,1)">
      <!-- Drawer header -->
      <div style="background:#3d5a80;color:#fff;padding:18px 20px;display:flex;align-items:center;gap:14px;flex-shrink:0">
        <div style="width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:700;letter-spacing:0.2px">AI Sales Assistant</div>
          <div style="font-size:12px;opacity:0.75;margin-top:1px">Powered by Claude</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <button onclick="startAIConversation(caLastCust,caLastCatData,caLastMtd)" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:#fff;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit" title="Start over">↺ Restart</button>
          <button onclick="closeAIDrawer()" style="background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.8);font-size:22px;line-height:1;padding:2px 6px;border-radius:4px" title="Close">✕</button>
        </div>
      </div>
      <!-- Messages -->
      <div class="ai-chat-messages" id="ca-ai-messages" style="max-width:none;flex:1;height:auto"></div>
      <!-- Option buttons -->
      <div id="ca-ai-options" class="ai-chat-options" style="display:none;max-width:none"></div>
      <!-- Input row -->
      <div class="ai-chat-input-row" style="max-width:none;flex-shrink:0;border-top:1px solid #e5e7eb;padding:12px 16px">
        <input type="text" class="ai-chat-input" id="ca-ai-input" placeholder="Ask a follow-up question…" onkeydown="if(event.key==='Enter')caSendMessage()">
        <button class="ai-chat-send" onclick="caSendMessage()">Send</button>
      </div>
    </div>

    <!-- Product List Modal -->
    <div id="pl-modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:3000;align-items:flex-start;justify-content:center;padding-top:60px" onclick="if(event.target===this)closePLModal()">
      <div style="background:#fff;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,0.3);width:720px;max-width:96vw;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="background:#0d9488;color:#fff;padding:16px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>
          <div style="flex:1">
            <div style="font-size:15px;font-weight:700">Recommended Product List</div>
            <div id="pl-modal-subtitle" style="font-size:12px;opacity:0.8;margin-top:1px">Top items from this account's categories</div>
          </div>
          <button onclick="closePLModal()" style="background:none;border:none;color:rgba(255,255,255,0.8);font-size:22px;cursor:pointer;padding:2px 6px;line-height:1;border-radius:4px">✕</button>
        </div>
        <div id="pl-modal-body" style="flex:1;overflow-y:auto;padding:16px 20px">
          <div style="text-align:center;padding:40px;color:#6b7280">Loading items…</div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;gap:10px;flex-shrink:0">
          <button onclick="closePLModal()" style="background:#f1f5f9;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Close</button>
          <button id="pl-copy-btn" onclick="copyPLTable()" style="display:none;align-items:center;gap:7px;background:#f1f5f9;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy Table
          </button>
          <a id="pl-outlook-btn" href="#" style="display:none;align-items:center;gap:7px;background:#0d9488;color:#fff;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:600;text-decoration:none;font-family:inherit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
            Open in Outlook
          </a>
        </div>
      </div>
    </div>

    <!-- Notes -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-title">Account Notes</div>
      <textarea id="ca-note-input" placeholder="Add a note about this account…"
        style="width:100%;border:1px solid #d1d5db;border-radius:6px;padding:10px;font-size:14px;font-family:inherit;resize:vertical;min-height:72px;outline:none;color:#374151"></textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:8px">
        <button class="btn btn-sm" style="background:#0d9488;color:#fff;border-color:#0d9488" onclick="saveCANote()">Save Note</button>
      </div>
      <div id="ca-notes-list" style="margin-top:12px">${buildNotesList(custNo)}</div>
    </div>`;

  // Animate progress bar
  setTimeout(() => {
    const bar = document.getElementById('ca-progress-bar');
    if (bar) bar.style.width = barPct + '%';
  }, 100);

  // Ensure AI tab is always visible after render
  setTimeout(ensureAITab, 0);

  // Store refs for regenerate button
  window.caLastCust    = cust;
  window.caLastCatData = catData;
  window.caLastMtd     = mtd;
}

// ── Charts ────────────────────────────────────────────────────

function renderCACharts(catData, orders) {
  destroyCACharts();

  const top8 = [...catData].sort((a, b) => b.currentYtdAmt - a.currentYtdAmt).slice(0, 8);

  // ── Horizontal bar: current vs prior YTD by category ─────────
  const barCtx = document.getElementById('ca-bar-chart');
  if (barCtx && top8.length) {
    caCharts.bar = new Chart(barCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: top8.map(c => {
          const s = c.description || c.categoryCode;
          return s.length > 18 ? s.slice(0, 18) + '…' : s;
        }),
        datasets: [
          { label: 'Current YTD', data: top8.map(c => c.currentYtdAmt), backgroundColor: '#0d9488', borderRadius: 3, borderWidth: 0 },
          { label: 'Prior YTD',   data: top8.map(c => c.priorYtdAmt),   backgroundColor: '#f97316', borderRadius: 3, borderWidth: 0 },
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'top', labels: { font: { size: 11 }, boxWidth: 12, padding: 8 } },
          tooltip: { ...tooltip, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt$(ctx.parsed.x)}` } }
        },
        scales: {
          x: { ticks: { font: { size: 11 }, color: '#6b7280', callback: v => fmtRevMM(v) }, grid: { color: 'rgba(0,0,0,0.04)' } },
          y: { ticks: { font: { size: 11 }, color: '#374151' }, grid: { display: false } }
        }
      }
    });
  }

  // ── Donut: category mix ───────────────────────────────────────
  const donutCtx = document.getElementById('ca-donut-chart');
  if (donutCtx && top8.length) {
    const PIE_COLORS = ['#3d5a80','#e07b39','#4caf7d','#e8c53a','#9b59b6','#e74c3c','#17a2b8','#f06292'];
    const allTotal   = catData.reduce((s, c) => s + c.currentYtdAmt, 0);
    const top7       = top8.slice(0, 7);
    const other      = catData.slice(7).reduce((s, c) => s + c.currentYtdAmt, 0);
    const labels     = top7.map(c => c.description || c.categoryCode);
    const data       = top7.map(c => c.currentYtdAmt);
    if (other > 0) { labels.push('Other'); data.push(other); }

    caCharts.donut = new Chart(donutCtx.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: labels.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]), borderColor: '#fff', borderWidth: 2 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '55%',
        plugins: {
          legend: { display: true, position: 'right', labels: { font: { size: 10 }, boxWidth: 10, padding: 6 } },
          tooltip: {
            ...tooltip,
            callbacks: {
              label: ctx => {
                const pct = allTotal > 0 ? ((ctx.parsed / allTotal) * 100).toFixed(1) : '0.0';
                return ` ${fmt$(ctx.parsed)} (${pct}%)`;
              }
            }
          }
        }
      }
    });
  }

  // ── Monthly bar ───────────────────────────────────────────────
  const monthCtx = document.getElementById('ca-monthly-chart');
  if (monthCtx) {
    const { labels, data } = buildMonthlyData(orders);
    caCharts.monthly = new Chart(monthCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Sales', data, backgroundColor: '#3d5a80', borderRadius: 3 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltip, callbacks: { label: ctx => ` ${fmt$(ctx.parsed.y)}` } }
        },
        scales: {
          x: { ticks: { font: { size: 11 }, color: '#374151' }, grid: { display: false } },
          y: { ticks: { font: { size: 11 }, color: '#6b7280', callback: v => fmtRevMM(v) }, grid: { color: 'rgba(0,0,0,0.04)' }, beginAtZero: true }
        }
      }
    });
  }
}

function buildMonthlyData(orders) {
  const now    = new Date();
  const year   = now.getFullYear();
  const months = Array(12).fill(0);
  for (const o of orders) {
    const raw = o.date || o.ticketDate || '';
    const d   = new Date(raw);
    if (!isNaN(d) && d.getFullYear() === year) {
      months[d.getMonth()] += parseFloat(o.amount || 0);
    }
  }
  const allLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const max = now.getMonth() + 1;
  return { labels: allLabels.slice(0, max), data: months.slice(0, max) };
}

// ── Category table ────────────────────────────────────────────

function buildCatTable(catData) {
  if (!catData.length) return '<div style="padding:20px;color:#9ca3af">No category data available.</div>';

  const sorted = [...catData].sort((a, b) => {
    const dir = caCatSort.dir === 'asc' ? 1 : -1;
    switch (caCatSort.col) {
      case 'description':   return dir * (a.description || '').localeCompare(b.description || '');
      case 'currentYtdAmt': return dir * (a.currentYtdAmt - b.currentYtdAmt);
      case 'currentQty':    return dir * (a.currentQty    - b.currentQty);
      case 'priorYtdAmt':   return dir * (a.priorYtdAmt   - b.priorYtdAmt);
      case 'priorQty':      return dir * (a.priorQty      - b.priorQty);
      case 'dollarChange':  return dir * (a.dollarChange   - b.dollarChange);
      case 'pctChange':     return dir * (
        (a.priorYtdAmt > 0 ? a.currentYtdAmt / a.priorYtdAmt : 0) -
        (b.priorYtdAmt > 0 ? b.currentYtdAmt / b.priorYtdAmt : 0)
      );
      default: return dir * (a.currentYtdAmt - b.currentYtdAmt);
    }
  });

  const th = (key, label, cls = '') => {
    const active = caCatSort.col === key;
    const icon   = active ? (caCatSort.dir === 'asc' ? '▲' : '▼') : '⇅';
    return `<th class="${cls} sort-th${active ? ' sort-active' : ''}" onclick="caSortCat('${key}')">${label}<span class="sort-icon">${icon}</span></th>`;
  };

  const rows = sorted.map(c => {
    const pctChange = c.priorYtdAmt > 0 ? ((c.currentYtdAmt - c.priorYtdAmt) / c.priorYtdAmt * 100) : null;
    const pctCls    = pctChange === null ? '' : pctChange >= 0 ? 'vel-up' : 'vel-down';
    const pctArrow  = pctChange === null ? '' : pctChange >= 0 ? '↑' : '↓';
    const pctStr    = pctChange !== null ? (pctChange >= 0 ? '+' : '') + pctChange.toFixed(1) + '%' : '—';
    const dollarCls = c.dollarChange >= 0 ? 'vel-up' : 'vel-down';
    const catLabel  = c.description || c.categoryCode;
    return `<tr>
      <td class="cat-name-cell">
        <a class="acct-name-link" onclick="openCategoryDrill('${caCustNo}','${c.categoryCode}')">${catLabel}</a>
      </td>
      <td class="num-ctr">${fmt$(c.currentYtdAmt)}</td>
      <td class="num-ctr">${c.currentQty > 0 ? Math.round(c.currentQty).toLocaleString() : '—'}</td>
      <td class="num-ctr">${c.priorYtdAmt > 0 ? fmt$(c.priorYtdAmt) : '—'}</td>
      <td class="num-ctr">${c.priorQty > 0 ? Math.round(c.priorQty).toLocaleString() : '—'}</td>
      <td class="num-ctr"><span class="${dollarCls}">${c.dollarChange >= 0 ? '+' : ''}${fmt$(c.dollarChange)}</span></td>
      <td class="num-ctr"><span class="${pctCls}">${pctArrow} ${pctStr}</span></td>
    </tr>`;
  }).join('');

  return `
    <div class="card" style="margin-bottom:12px;padding:0">
      <div style="padding:16px 20px 10px;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:#3d5a80;border-bottom:1px solid #f3f4f6">
        Category Breakdown — click a category to drill into items
      </div>
      <div class="inv-wrap">
        <table class="data-table">
          <thead><tr>
            ${th('description',   'Category')}
            ${th('currentYtdAmt', 'Current YTD $', 'num-ctr')}
            ${th('currentQty',    'Curr Qty',       'num-ctr')}
            ${th('priorYtdAmt',   'Prior YTD $',    'num-ctr')}
            ${th('priorQty',      'Prior Qty',       'num-ctr')}
            ${th('dollarChange',  '$ Change',        'num-ctr')}
            ${th('pctChange',     '% Change',        'num-ctr')}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function caSortCat(col) {
  caCatSort.dir = caCatSort.col === col ? (caCatSort.dir === 'desc' ? 'asc' : 'desc') : 'desc';
  caCatSort.col = col;
  const sec = document.getElementById('ca-cat-section');
  if (sec) sec.innerHTML = buildCatTable(window.caLastCatData || []);
}

// ── Item drill-down ───────────────────────────────────────────

async function openCategoryDrill(custNo, category) {
  caDrill = { category, tab: 'ytd' };
  const sec = document.getElementById('ca-cat-section');
  if (!sec) return;
  sec.innerHTML = `<div style="padding:20px;color:#6b7280">Loading items for ${category}…</div>`;

  const enc = encodeURIComponent(custNo);
  const cat = encodeURIComponent(category);

  try {
    const [ytdResp, topResp] = await Promise.all([
      fetch(`/proxy/ytd-items/${enc}/${cat}`),
      fetch(`/proxy/top-items/${enc}/${cat}`),
    ]);
    const ytdItems = ytdResp.ok ? await ytdResp.json() : [];
    const topItems = topResp.ok ? await topResp.json() : [];
    caDrill = { category, tab: 'ytd', ytdItems, topItems };
    renderItemDrill();
  } catch (e) {
    sec.innerHTML = `<div style="padding:20px;color:#dc2626">Error loading items: ${e.message}</div>`;
  }
}

function renderItemDrill() {
  const sec = document.getElementById('ca-cat-section');
  if (!sec || !caDrill) return;
  const { category, tab, ytdItems = [], topItems = [] } = caDrill;

  const tabBtn = (t, label) =>
    `<button class="tier-filter-btn${tab === t ? ' active' : ''}" onclick="caDrillTab('${t}')">${label} (${t === 'ytd' ? ytdItems.length : topItems.length})</button>`;

  let tableHTML = '';
  if (tab === 'ytd') {
    const rows = ytdItems.map(i => `<tr>
      <td style="font-family:monospace;font-size:12px;font-weight:600;color:#3d5a80">${i.itemNo}</td>
      <td>${i.description || '—'}</td>
      <td class="num-ctr">${i.qty}</td>
      <td class="num-ctr">${fmt$(i.revenue)}</td>
      <td class="num-ctr">${i.cadence !== null ? i.cadence.toFixed(0) + 'd' : '—'}</td>
      <td class="num-ctr">${i.lastBought || '—'}</td>
    </tr>`).join('') || '<tr><td colspan="6" style="color:#9ca3af;padding:16px">No items found.</td></tr>';
    tableHTML = `<table class="data-table"><thead><tr>
      <th>Item #</th><th>Description</th>
      <th class="num-ctr">Qty</th><th class="num-ctr">Revenue</th>
      <th class="num-ctr">Avg Cadence</th><th class="num-ctr">Last Bought</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  } else {
    const rows = topItems.map(i => {
      const cls = i.custBuys ? 'vel-up' : 'vel-down';
      const lbl = i.custBuys ? '✓ Buys' : '✗ Missing';
      return `<tr style="${!i.custBuys ? 'background:#fff8f0' : ''}">
        <td style="font-family:monospace;font-size:12px;font-weight:600;color:#3d5a80">${i.itemNo}</td>
        <td>${i.description || '—'}</td>
        <td class="num-ctr"><span class="${cls}">${lbl}</span></td>
        <td class="num-ctr">${fmt$(i.totalRev)}</td>
        <td class="num-ctr">${i.custBuys ? fmt$(i.custRev) : '<span style="color:#9ca3af">—</span>'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" style="color:#9ca3af;padding:16px">No items found.</td></tr>';
    tableHTML = `<table class="data-table"><thead><tr>
      <th>Item #</th><th>Description</th>
      <th class="num-ctr">This Acct</th><th class="num-ctr">All-Accts Rev</th>
      <th class="num-ctr">This Acct Rev</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  sec.innerHTML = `
    <div class="card" style="margin-bottom:12px;padding:0">
      <div style="padding:14px 20px 10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid #f3f4f6">
        <a class="cat-back-link" onclick="closeCategoryDrill()">← Categories</a>
        <span style="color:#9ca3af">/</span>
        <span style="font-weight:600;color:#1a2332">${category}</span>
      </div>
      <div style="padding:12px 16px 8px;display:flex;gap:8px">
        ${tabBtn('ytd', 'YTD Purchased')}
        ${tabBtn('best', 'Best Sellers')}
      </div>
      <div class="inv-wrap">${tableHTML}</div>
    </div>`;
}

function caDrillTab(tab) {
  if (caDrill) { caDrill.tab = tab; renderItemDrill(); }
}

function closeCategoryDrill() {
  caDrill = null;
  const sec = document.getElementById('ca-cat-section');
  if (sec) sec.innerHTML = buildCatTable(window.caLastCatData || []);
}

// ── AI Chat ───────────────────────────────────────────────────

function startAIConversation(cust, catData, mtd) {
  if (caAiCtrl) { caAiCtrl.abort(); caAiCtrl = null; }
  caConversation = [];
  const msgs = document.getElementById('ca-ai-messages');
  const opts = document.getElementById('ca-ai-options');
  const inp  = document.getElementById('ca-ai-input');
  if (msgs) msgs.innerHTML = '';
  if (opts) { opts.innerHTML = ''; opts.style.display = 'none'; }
  if (inp)  inp.value = '';

  const context = buildPromptContext(cust, catData, mtd);
  caConversation.push({ role: 'user', content: context });
  caStreamResponse();
}

// Alias for the original call site in loadCustomerAccount
function startAIPitch(cust, catData, mtd) {
  startAIConversation(cust, catData, mtd);
}

function caSendMessage(textOverride) {
  const inp  = document.getElementById('ca-ai-input');
  const text = textOverride || (inp ? inp.value.trim() : '');
  if (!text) return;
  if (inp) inp.value = '';

  // Hide options while processing
  const opts = document.getElementById('ca-ai-options');
  if (opts) { opts.innerHTML = ''; opts.style.display = 'none'; }

  caAppendBubble('user', text);
  caConversation.push({ role: 'user', content: text });
  caStreamResponse();
}

async function caStreamResponse() {
  if (caAiCtrl) caAiCtrl.abort();
  caAiCtrl = new AbortController();

  // Typing indicator
  const typingId = 'ca-typing-' + Date.now();
  const msgs = document.getElementById('ca-ai-messages');
  if (msgs) {
    msgs.insertAdjacentHTML('beforeend', `
      <div class="ai-chat-msg ai" id="${typingId}">
        <div class="ai-chat-bubble ai-chat-typing">
          <span></span><span></span><span></span>
        </div>
      </div>`);
    msgs.scrollTop = msgs.scrollHeight;
  }

  try {
    const resp = await fetch('/proxy/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system:   typeof SYSTEM_PROMPT !== 'undefined' ? SYSTEM_PROMPT : undefined,
        messages: caConversation,
      }),
      signal: caAiCtrl.signal,
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `Server returned ${resp.status}`);
    }

    // Replace typing indicator with real bubble
    const typing = document.getElementById(typingId);
    if (typing) typing.remove();
    const bubbleId = 'ca-bubble-' + Date.now();
    caAppendBubble('ai', '', bubbleId);
    const bubble = document.getElementById(bubbleId);

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') break;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === 'delta' && evt.text) {
            fullText += evt.text;
            if (bubble) bubble.innerHTML = formatAIText(fullText);
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
          } else if (evt.type === 'error') {
            throw new Error(evt.error);
          }
        } catch (_) {}
      }
    }

    caConversation.push({ role: 'assistant', content: fullText });

    // Extract and render follow-up options
    const options = caExtractOptions(fullText);
    if (options.length >= 2) caRenderOptions(options);

    // If AI drafted an email, show "Open in Outlook" button
    caCheckEmailDraft(fullText, bubble);
    // If AI created a calendar event, show "Add to Calendar" button
    caCheckCalendarEvent(fullText, bubble);

  } catch (e) {
    const typing = document.getElementById(typingId);
    if (typing) typing.remove();
    if (e.name !== 'AbortError') {
      caAppendBubble('ai', `<span style="color:#dc2626">Error: ${e.message}</span>`);
    }
  }
}

function caAppendBubble(role, html, id) {
  const msgs = document.getElementById('ca-ai-messages');
  if (!msgs) return;
  const idAttr = id ? `id="${id}"` : '';
  msgs.insertAdjacentHTML('beforeend', `
    <div class="ai-chat-msg ${role}">
      <div class="ai-chat-bubble" ${idAttr}>${html}</div>
    </div>`);
  msgs.scrollTop = msgs.scrollHeight;
}

function caExtractOptions(text) {
  // Find numbered list items at or near the end of text (e.g. "1. ...\n2. ...\n3. ...")
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const opts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(\d+)\.\s+(.+)$/);
    if (m) opts.unshift(m[2]);
    else if (opts.length > 0) break; // stop at first non-numbered line after finding some
  }
  return opts.length >= 2 ? opts : [];
}

function caRenderOptions(options) {
  const container = document.getElementById('ca-ai-options');
  if (!container) return;
  container.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'ai-option-btn';
    btn.textContent = opt;
    btn.addEventListener('click', () => caSendMessage(opt));
    container.appendChild(btn);
  });
  container.style.display = 'flex';
}

function ensureAITab() {
  const btn = document.getElementById('ca-ai-tab');
  if (btn) btn.style.display = 'flex';
}

function removeAITab() {
  const btn = document.getElementById('ca-ai-tab');
  if (btn) btn.style.display = 'none';
}

function toggleAIDrawer() {
  const drawer  = document.getElementById('ca-ai-drawer');
  const overlay = document.getElementById('ca-ai-overlay');
  if (!drawer) return;
  const isOpen = drawer.style.transform === 'translateX(0px)' || drawer.style.transform === 'translateX(0%)';
  if (isOpen) {
    closeAIDrawer();
  } else {
    overlay.style.display = 'block';
    drawer.style.transform = 'translateX(0)';
    // Auto-start if no conversation yet
    if (caConversation.length === 0 && window.caLastCust) {
      startAIConversation(window.caLastCust, window.caLastCatData, window.caLastMtd);
    }
  }
}

function closeAIDrawer() {
  const drawer  = document.getElementById('ca-ai-drawer');
  const overlay = document.getElementById('ca-ai-overlay');
  if (drawer)  drawer.style.transform = 'translateX(100%)';
  if (overlay) overlay.style.display = 'none';
}

function formatAIText(text) {
  let cleaned = text
    .replace(/\n\n\*\*What would you like to explore\?\*\*[\s\S]*$/, '')
    .replace(/\n\n\d+\.\s.+(\n\d+\.\s.+){1,}$/, '')
    .replace(/\nSUBJECT:[\s\S]*?END_EMAIL/g, '')       // strip email block
    .replace(/\nCALENDAR_EVENT:[\s\S]*?END_CALENDAR/g, ''); // strip calendar block
  return cleaned
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function caCheckCalendarEvent(fullText, bubbleEl) {
  const match = fullText.match(/CALENDAR_EVENT:\nTITLE:\s*(.+)\nDATE:\s*(.+)\nTIME:\s*(.+)\nDURATION:\s*(\d+)\nNOTES:\s*([\s\S]*?)\nEND_CALENDAR/);
  if (!match || !bubbleEl) return;

  const title    = match[1].trim();
  const date     = match[2].trim();     // YYYY-MM-DD
  const time     = match[3].trim();     // HH:MM
  const duration = parseInt(match[4]) || 60;
  const notes    = match[5].trim();

  // Build ICS content
  const [year, month, day] = date.split('-').map(Number);
  const [hour, min]        = time.split(':').map(Number);

  function pad(n) { return String(n).padStart(2, '0'); }
  function icsDate(y, mo, d, h, m) {
    return `${y}${pad(mo)}${pad(d)}T${pad(h)}${pad(m)}00`;
  }

  const dtStart = icsDate(year, month, day, hour, min);
  const endDate = new Date(year, month - 1, day, hour, min + duration);
  const dtEnd   = icsDate(endDate.getFullYear(), endDate.getMonth() + 1, endDate.getDate(), endDate.getHours(), endDate.getMinutes());
  const uid     = `kellis-${Date.now()}@kellissales`;
  const now     = icsDate(...new Date().toISOString().slice(0,16).split(/[-T:]/).map(Number));

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kellis Sales//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${title}`,
    notes ? `DESCRIPTION:${notes.replace(/\n/g, '\\n')}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url  = URL.createObjectURL(blob);

  const btn = document.createElement('a');
  btn.href     = url;
  btn.download = `${title.replace(/[^a-z0-9]/gi, '_')}.ics`;
  btn.style.cssText = 'display:inline-flex;align-items:center;gap:7px;margin-top:12px;padding:8px 16px;background:#3d5a80;color:#fff;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;font-family:inherit;cursor:pointer';
  btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> Add to Outlook Calendar`;

  const wrap = document.createElement('div');
  wrap.appendChild(btn);
  bubbleEl.parentElement.appendChild(wrap);

  const msgs = document.getElementById('ca-ai-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

// ── Product List Modal ────────────────────────────────────────

function toKellisSlug(description) {
  return description.toLowerCase()
    .replace(/['''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

async function openProductListModal(custNo, custName) {
  const overlay = document.getElementById('pl-modal-overlay');
  const body    = document.getElementById('pl-modal-body');
  const sub     = document.getElementById('pl-modal-subtitle');
  const btn     = document.getElementById('pl-outlook-btn');
  if (!overlay) return;

  sub.textContent  = `Top items from ${custName}'s categories`;
  body.innerHTML   = '<div style="text-align:center;padding:40px;color:#6b7280">Loading items…</div>';
  btn.style.display = 'none';
  overlay.style.display = 'flex';

  try {
    // Use already-loaded category data — avoids a round-trip and history scan
    const topCats = (window.caLastCatData || [])
      .sort((a, b) => b.currentYtdAmt - a.currentYtdAmt)
      .slice(0, 5)
      .map(c => c.categoryCode)
      .join(',');

    const resp  = await fetch(`/proxy/recommended-items?categories=${encodeURIComponent(topCats)}`);
    const items = resp.ok ? await resp.json() : [];

    if (!items.length) {
      body.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280">No item data found for this account.</div>';
      return;
    }

    // Build table
    const rows = items.map((item, i) => {
      const slug = toKellisSlug(item.description);
      const url  = `https://www.kellisgifts.com/${slug}/`;
      const cost = item.caseCost > 0 ? `$${item.caseCost.toFixed(2)}` : '—';
      const pack = item.packSize > 0 ? item.packSize : '—';
      return `<tr style="${i % 2 === 0 ? '' : 'background:#f8f9fb'}">
        <td style="padding:9px 12px;font-size:13px;color:#374151;font-weight:500">
          <a href="${url}" target="_blank" style="color:#0d9488;text-decoration:none;font-weight:600" title="View on Kellis">${item.description}</a>
        </td>
        <td style="padding:9px 12px;font-family:monospace;font-size:12px;color:#6b7280">${item.upc || '—'}</td>
        <td style="padding:9px 12px;font-size:13px;text-align:right;font-weight:600;color:#1a2332">${cost}</td>
        <td style="padding:9px 12px;font-size:13px;text-align:center;color:#6b7280">${pack}</td>
      </tr>`;
    }).join('');

    body.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-family:inherit">
        <thead>
          <tr style="background:#f1f5f9;border-bottom:2px solid #e5e7eb">
            <th style="padding:9px 12px;text-align:left;font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.04em">Item Name</th>
            <th style="padding:9px 12px;text-align:left;font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.04em">UPC</th>
            <th style="padding:9px 12px;text-align:right;font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.04em">Case Cost</th>
            <th style="padding:9px 12px;text-align:center;font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.04em">Pack Size</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

    // Build mailto body (plain text — URLs auto-link in Outlook)
    const emailLines = items.map((item, i) => {
      const slug = toKellisSlug(item.description);
      const url  = `https://www.kellisgifts.com/${slug}/`;
      const cost = item.caseCost > 0 ? `$${item.caseCost.toFixed(2)}` : 'N/A';
      const pack = item.packSize > 0 ? item.packSize : 'N/A';
      return `${i + 1}. ${item.description}\n   ${url}\n   UPC: ${item.upc || 'N/A'} | Case Cost: ${cost} | Pack Size: ${pack}`;
    }).join('\n\n');

    const subject = `Recommended Products — ${custName}`;
    const emailBody = `Hi,\n\nHere are our top recommended products for your review:\n\n${emailLines}\n\nLet me know if you have any questions!\n\nBest regards`;
    const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(emailBody)}`;
    btn.href = mailto;
    btn.style.display = 'flex';

    const copyBtn = document.getElementById('pl-copy-btn');
    if (copyBtn) copyBtn.style.display = 'flex';

  } catch (e) {
    body.innerHTML = `<div style="padding:24px;color:#dc2626">Error loading items: ${e.message}</div>`;
  }
}

function closePLModal() {
  const overlay = document.getElementById('pl-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function copyPLTable() {
  const table = document.querySelector('#pl-modal-body table');
  if (!table) return;

  // Build clean HTML table for clipboard (styled for pasting into Outlook/Word)
  const rows = table.querySelectorAll('tbody tr');
  const headerCells = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());

  const htmlRows = [...rows].map((tr, i) => {
    const cells = [...tr.querySelectorAll('td')].map((td, ci) => {
      const link = td.querySelector('a');
      const align = ci >= 2 ? (ci === 2 ? 'right' : 'center') : 'left';
      const val = link
        ? `<a href="${link.href}" style="color:#0d9488;text-decoration:none">${link.textContent.trim()}</a>`
        : td.textContent.trim();
      return `<td style="padding:7px 12px;border:1px solid #d1d5db;font-size:13px;text-align:${align};background:${i % 2 === 0 ? '#fff' : '#f8f9fb'}">${val}</td>`;
    });
    return `<tr>${cells.join('')}</tr>`;
  }).join('');

  const htmlHeader = headerCells.map((h, ci) => {
    const align = ci >= 2 ? (ci === 2 ? 'right' : 'center') : 'left';
    return `<th style="padding:7px 12px;border:1px solid #d1d5db;background:#f1f5f9;font-size:12px;font-weight:700;text-align:${align};text-transform:uppercase;letter-spacing:0.04em;color:#374151">${h}</th>`;
  }).join('');

  const html = `<table style="border-collapse:collapse;font-family:Arial,sans-serif;width:100%"><thead><tr>${htmlHeader}</tr></thead><tbody>${htmlRows}</tbody></table>`;

  // Plain text fallback (tab-separated)
  const plainRows = [...rows].map(tr =>
    [...tr.querySelectorAll('td')].map(td => td.textContent.trim()).join('\t')
  );
  const plain = [headerCells.join('\t'), ...plainRows].join('\n');

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html':  new Blob([html],  { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })
    ]);
    const btn = document.getElementById('pl-copy-btn');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '✓ Copied!';
      btn.style.background = '#dcfce7';
      btn.style.borderColor = '#86efac';
      btn.style.color = '#166534';
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.style.color = '';
      }, 2000);
    }
  } catch (_) {
    // Fallback for browsers that don't support ClipboardItem
    navigator.clipboard.writeText(plain).catch(() => {});
    const btn = document.getElementById('pl-copy-btn');
    if (btn) { btn.textContent = '✓ Copied (text)'; setTimeout(() => { btn.textContent = 'Copy Table'; }, 2000); }
  }
}

function caCheckEmailDraft(fullText, bubbleEl) {
  const match = fullText.match(/SUBJECT:\s*(.+)\nBODY:\n([\s\S]*?)END_EMAIL/);
  if (!match || !bubbleEl) return;
  const subject = match[1].trim();
  const body    = match[2].trim();

  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  const btn = document.createElement('a');
  btn.href = mailto;
  btn.target = '_blank';
  btn.style.cssText = 'display:inline-flex;align-items:center;gap:7px;margin-top:12px;padding:8px 16px;background:#0d9488;color:#fff;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;font-family:inherit;cursor:pointer';
  btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg> Open in Outlook`;

  const wrap = document.createElement('div');
  wrap.appendChild(btn);
  bubbleEl.parentElement.appendChild(wrap);

  const msgs = document.getElementById('ca-ai-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

// ── Order History ─────────────────────────────────────────────

const caOrderLinesCache = {}; // ticketNo → lines[]

function buildOrderHistory(orders) {
  if (!orders.length) return '<div style="padding:16px;color:#9ca3af;font-size:14px">No order history found.</div>';

  const sorted = [...orders].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5);
  const rows = sorted.map((o, idx) => {
    const date    = (o.date || '').slice(0, 10);
    const amt     = fmt$(parseFloat(o.amount || 0));
    const items   = o.itemCount ? `${o.itemCount} items` : '';
    const safeIdx = idx; // use index as stable key to avoid special-char issues
    const linesId = `order-lines-${safeIdx}`;
    const tktEsc  = (o.ticketNo || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    return `<tr class="order-hdr-row" style="cursor:pointer" data-tkt="${tktEsc}" data-lid="${linesId}">
      <td style="font-size:13px;color:#6b7280;width:18px;text-align:center;padding-right:4px">
        <span class="order-toggle-icon" style="color:#9ca3af;font-size:10px">▶</span>
      </td>
      <td style="font-size:13px;color:#6b7280">${date}</td>
      <td style="font-family:monospace;font-size:12px;color:#3d5a80;font-weight:600">${o.ticketNo || '—'}</td>
      <td style="font-size:13px">${items}</td>
      <td class="num-ctr" style="font-weight:600">${amt}</td>
    </tr>
    <tr id="${linesId}" style="display:none">
      <td colspan="5" style="padding:0;background:#f8f9fb;border-bottom:2px solid #e5e7eb"></td>
    </tr>`;
  }).join('');

  const html = `<div class="inv-wrap" style="max-height:500px;overflow-y:auto;border-top:1px solid #f3f4f6">
    <table class="data-table" id="ca-orders-table">
      <thead><tr>
        <th style="width:18px"></th>
        <th>Date</th><th>Ticket #</th><th>Items</th><th class="num-ctr">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  // Wire delegation after render (next tick)
  setTimeout(() => {
    const tbl = document.getElementById('ca-orders-table');
    if (tbl) tbl.addEventListener('click', e => {
      const row = e.target.closest('.order-hdr-row');
      if (!row) return;
      toggleOrderLines(row.dataset.tkt, row.dataset.lid, row);
    });
  }, 0);
  return html;
}

async function toggleOrderLines(ticketNo, linesRowId, hdrRow) {
  const row    = document.getElementById(linesRowId);
  const toggle = hdrRow ? hdrRow.querySelector('.order-toggle-icon') : null;
  if (!row) return;

  const isOpen = row.style.display !== 'none';
  if (isOpen) {
    row.style.display = 'none';
    if (toggle) toggle.textContent = '▶';
    return;
  }

  row.style.display = 'table-row';
  if (toggle) toggle.textContent = '▼';
  const td = row.querySelector('td');

  // Use cache if available
  if (caOrderLinesCache[ticketNo]) {
    td.innerHTML = buildLinesTable(caOrderLinesCache[ticketNo]);
    return;
  }

  td.innerHTML = '<div style="padding:10px 16px;color:#9ca3af;font-size:13px">Loading line items…</div>';

  try {
    const resp  = await fetch(`/proxy/order-lines/${encodeURIComponent(ticketNo)}`);
    const lines = resp.ok ? await resp.json() : [];
    caOrderLinesCache[ticketNo] = lines;
    td.innerHTML = buildLinesTable(lines);
  } catch (e) {
    td.innerHTML = `<div style="padding:10px 16px;color:#dc2626;font-size:13px">Error: ${e.message}</div>`;
  }
}

function buildLinesTable(lines) {
  if (!lines.length) return '<div style="padding:10px 16px;color:#9ca3af;font-size:13px">No line items found.</div>';
  const rows = lines.map(l => `<tr>
    <td style="font-family:monospace;font-size:11px;color:#3d5a80;font-weight:600;padding:6px 12px;white-space:nowrap">${l.itemNo || '—'}</td>
    <td style="font-size:12px;padding:6px 12px">${l.description || '—'}</td>
    <td class="num-ctr" style="font-size:12px;padding:6px 12px">${l.qty || '—'}</td>
    <td class="num-ctr" style="font-size:12px;padding:6px 12px">${l.unitPrice > 0 ? fmt$(l.unitPrice) : '—'}</td>
    <td class="num-ctr" style="font-size:12px;font-weight:600;padding:6px 12px">${l.extPrice > 0 ? fmt$(l.extPrice) : '—'}</td>
  </tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="background:#f1f5f9">
      <th style="text-align:left;padding:5px 12px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Item #</th>
      <th style="text-align:left;padding:5px 12px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Description</th>
      <th style="text-align:right;padding:5px 12px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Qty</th>
      <th style="text-align:right;padding:5px 12px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Unit $</th>
      <th style="text-align:right;padding:5px 12px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Ext $</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}


// ── Notes ─────────────────────────────────────────────────────

function saveCANote() {
  const input = document.getElementById('ca-note-input');
  const text  = (input?.value || '').trim();
  if (!text || !caCustNo) return;

  const key   = `ks_notes_${caCustNo}`;
  const notes = JSON.parse(localStorage.getItem(key) || '[]');
  notes.unshift({ text, ts: new Date().toISOString() });
  localStorage.setItem(key, JSON.stringify(notes));

  if (input) input.value = '';
  const list = document.getElementById('ca-notes-list');
  if (list) list.innerHTML = buildNotesList(caCustNo);
}

function buildNotesList(custNo) {
  const notes = JSON.parse(localStorage.getItem(`ks_notes_${custNo}`) || '[]');
  if (!notes.length) return '<div style="font-size:13px;color:#9ca3af">No notes yet.</div>';
  return notes.map(n => {
    const d = new Date(n.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `<div style="border-left:3px solid #3d5a80;padding:8px 12px;margin-bottom:8px;background:#f8f9fb;border-radius:0 6px 6px 0">
      <div style="font-size:12px;color:#9ca3af;margin-bottom:3px">${d}</div>
      <div style="font-size:14px;color:#374151">${n.text}</div>
    </div>`;
  }).join('');
}

// ── Welcome state (no customer selected) ─────────────────────

function showCustomerAccountWelcome() {
  const panel = document.getElementById('customer-account-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;padding:80px 20px;text-align:center">
      <div style="font-size:48px;margin-bottom:16px">👤</div>
      <div style="font-size:20px;font-weight:600;color:#1a2332;margin-bottom:8px">Customer Account</div>
      <div style="font-size:15px;color:#6b7280">Search for a customer using the search bar above, or<br>click a customer name on Account Performance.</div>
      <button class="btn btn-primary btn-sm" style="margin-top:20px" onclick="switchTab('store')">← Account Performance</button>
    </div>`;
}

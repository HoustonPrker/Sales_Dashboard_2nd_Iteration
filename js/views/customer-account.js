// ============================================================
// CUSTOMER ACCOUNT VIEW
// Deep-dive single-customer page
// ============================================================

let caCustNo          = null;
let caCharts          = {};
let caCatSort         = { col: 'description', dir: 'asc' };
let caDrill           = null; // null | { category, tab: 'ytd'|'best', ytdItems, topItems }
let caDrillSort       = { col: 'rank', dir: 'asc' };
let caSelectedCategory = null; // currently highlighted category row
let caAiCtrl          = null; // AbortController for in-flight AI stream
let caConversation    = [];   // [{role,content}] full chat history

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
  caCustNo           = custNo;
  caDrill            = null;
  caCatSort          = { col: 'description', dir: 'asc' };
  caSelectedCategory = null;
  caConversation     = [];

  window.location.hash = `#/customer?cust=${encodeURIComponent(custNo)}`;

  const panel = document.getElementById('customer-account-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;padding:60px;color:#6b7280;font-size:15px">
      Loading account <strong style="margin-left:6px;color:#3d5a80">${custNo}</strong>…
    </div>`;

  try {
    const enc = encodeURIComponent(custNo);

    // Fire orders in parallel immediately — don't await it yet
    const ordersPromise = fetch(`/proxy/orders/${enc}`)
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);

    // Critical path: customer + categories + MTD (all fast)
    const [custResp, catResp, mtdResp] = await Promise.all([
      fetch(`/proxy/customer/${enc}`),
      fetch(`/proxy/categories/${enc}`),
      fetch(`/proxy/mtd/${enc}`),
    ]);

    const cust    = custResp.ok ? await custResp.json() : {};
    const catData = catResp.ok  ? await catResp.json()  : [];
    const mtd     = mtdResp.ok  ? await mtdResp.json()  : { total: 0, orderDays: 0 };

    // Guard: user may have navigated away while we were fetching
    if (caCustNo !== custNo) return;

    // Render immediately with empty orders — order history shows loading state
    renderCA(cust, catData, mtd, []);
    ensureAITab();

    // Auto-select highest-revenue category immediately (before orders load)
    const topCat = [...catData].sort((a, b) => b.currentYtdAmt - a.currentYtdAmt)[0];
    if (topCat) openCategoryDrill(custNo, topCat.categoryCode, 'best');

    // Background: await orders, then fill in order history + charts + AI
    ordersPromise.then(orders => {
      if (caCustNo !== custNo) return; // navigated away
      // Patch order history section in place
      const ohWrap = document.getElementById('ca-order-history-wrap');
      if (ohWrap) ohWrap.innerHTML = `
        <div class="card-title">
          Order History <span style="font-weight:400;color:#9ca3af;font-size:12px;text-transform:none">(${Math.min(orders.length, 5)} most recent)</span>
        </div>
        ${buildOrderHistory(orders)}
      `;
      window.caLastOrders = orders; // update so showMonthOrders has the real data
      renderCACharts(catData, orders);
      startAIPitch(cust, catData, mtd);

      // Patch Monthly Goal / % to Goal KPIs — these depend on orders and were blank on first render
      const now2 = new Date();
      const yr2  = now2.getFullYear();
      const mm2  = String(now2.getMonth() + 1).padStart(2, '0');
      const pyMonthStart2 = `${yr2 - 1}-${mm2}-01`;
      const pyMonthEnd2   = new Date(yr2 - 1, parseInt(mm2, 10), 0).toISOString().slice(0, 10);
      const monthGoal2    = orders.filter(o => { const d = (o.date || '').slice(0, 10); return d >= pyMonthStart2 && d <= pyMonthEnd2; })
                                  .reduce((s, o) => s + (o.amount || 0), 0);
      const mtdPctOfGoal2 = monthGoal2 > 0 ? (mtd.total / monthGoal2 * 100).toFixed(1) : null;
      const elGoal  = document.getElementById('ca-kpi-month-goal');
      const elPct   = document.getElementById('ca-kpi-pct-goal');
      const elSub   = document.getElementById('ca-kpi-mtd-sub');
      if (elGoal) elGoal.textContent = monthGoal2 > 0 ? fmt$(monthGoal2) : '—';
      if (elPct)  elPct.textContent  = mtdPctOfGoal2 !== null ? mtdPctOfGoal2 + '%' : '—';
      if (elSub)  elSub.textContent  = monthGoal2 > 0 ? 'Goal: ' + fmt$(monthGoal2) : (mtd?.orderDays || 0) + ' order days';

      // Patch Orders/Frequency/Cadence tooltip — also order-dependent
      const oneYearAgo2  = new Date(now2); oneYearAgo2.setFullYear(now2.getFullYear() - 1);
      const orders12mo2  = orders.filter(o => o.date && new Date(o.date) >= oneYearAgo2).length;
      const orderDates2  = [...new Set(orders.map(o => o.date).filter(Boolean))].sort();
      let avgCadence2 = null;
      if (orderDates2.length >= 2) {
        const span2 = (new Date(orderDates2[orderDates2.length - 1]) - new Date(orderDates2[0])) / 86400000;
        avgCadence2 = span2 / (orderDates2.length - 1);
      }
      const cadenceLabel2 = avgCadence2 === null ? null
        : avgCadence2 <= 7  ? 'Weekly'
        : avgCadence2 <= 16 ? 'Bi-weekly'
        : avgCadence2 <= 35 ? 'Monthly'
        : avgCadence2 <= 50 ? 'Every 6 weeks'
        : avgCadence2 <= 75 ? 'Every 2 months'
        : 'Quarterly';
      const el12mo    = document.getElementById('ca-kpi-orders12mo');
      const elFreq    = document.getElementById('ca-kpi-avg-freq');
      const elCadence = document.getElementById('ca-kpi-cadence');
      if (el12mo)    el12mo.textContent    = orders12mo2;
      if (elFreq)    elFreq.textContent    = avgCadence2 !== null ? '(~every ' + Math.round(avgCadence2) + ' days)' : '—';
      if (elCadence) elCadence.textContent = cadenceLabel2 || '—';
    });

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

    <div class="kpi-row" style="grid-template-columns:repeat(8,1fr)">
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
        <div class="chart-title">Category % Change vs Prior YTD</div>
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
  // Build contact list from NCR's two contact slots
  const contacts = [
    { name: cust.contact1, phone: cust.phone1, mobile: cust.mobilePhone1, email: cust.email1, url: cust.url1 },
    { name: cust.contact2, phone: cust.phone2, mobile: cust.mobilePhone2, email: cust.email2, url: cust.url2 },
  ].filter(c => c.name || c.phone || c.mobile || c.email);

  const rawDiscount = cust.best_price_code || cust.USER_BEST_PRICE_COD_CUST || null;
  const discountStr = (() => {
    if (!rawDiscount) return 'No Discount';
    const m = rawDiscount.match(/(\d+(?:\.\d+)?)%?$/);
    return m ? `${parseFloat(m[1])}% Discount` : rawDiscount;
  })();
  const lastDate  = cust.lastSaleDate ? cust.lastSaleDate.slice(0, 10) : null;
  const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate)) / 86400000) : null;

  // Authoritative KPIs from customer record custom fields (set by NCR at the account level).
  // These match v1 exactly and cover full calendar years, not same-period partials.
  const custYtdSales  = parseFloat(cust.USER_YTD_SALES      || 0) || null; // CY YTD
  const custPytdSales = parseFloat(cust.USER_PYTD_SALES     || 0) || null; // full prior year
  const custPpytdSales= parseFloat(cust.USER_PPYTD_SALES    || 0) || null; // full prior-prior year
  const annualTarget  = parseFloat(cust.USER_ANNUAL_GOALS   || 0) || null; // annual goal
  const custLifetime  = parseFloat(cust.USER_LIFETIME_SALES || 0) || null; // lifetime total

  // Fall back to catData sums if custom fields are absent
  const catYtd     = catData.reduce((s, c) => s + c.currentYtdAmt, 0);
  const priorTotal = catData.reduce((s, c) => s + c.priorYtdAmt,   0); // same-period, used in category table only

  const ytdTotal  = custYtdSales  ?? catYtd;
  const target    = annualTarget  ?? priorTotal;
  const pctToTgt  = target > 0 ? ytdTotal / target : 0;
  const pctChange = custPytdSales > 0 ? (ytdTotal - custPytdSales) / custPytdSales
                  : priorTotal    > 0 ? (ytdTotal - priorTotal)    / priorTotal
                  : null;
  const mtdTotal   = mtd?.total || 0;

  // ── Derived KPIs ──────────────────────────────────────────────
  const now2 = new Date();
  const yr   = now2.getFullYear();
  const mm   = String(now2.getMonth() + 1).padStart(2, '0');
  const dd   = String(now2.getDate()).padStart(2, '0');

  // Run rate: % of calendar year elapsed
  const jan1    = new Date(yr, 0, 1);
  const runRate = (now2 - jan1) / (365 * 86400000);
  const runRatePct = (runRate * 100).toFixed(1);
  const runRateColor = pctToTgt >= runRate ? '#059669' : pctToTgt >= runRate - 0.10 ? '#d97706' : '#dc2626';

  // Monthly business-day run rate (Mon–Fri, excl. US federal holidays)
  const _isHoliday = d => {
    const y = d.getFullYear(), mo = d.getMonth()+1, dy = d.getDate(), dow = d.getDay();
    const nth = (yr,m,n,wd) => { const f=new Date(yr,m-1,1).getDay(); let o=wd-f; if(o<0)o+=7; return 1+o+(n-1)*7; };
    const last = (yr,m,wd) => { const l=new Date(yr,m,0); let dif=l.getDay()-wd; if(dif<0)dif+=7; return l.getDate()-dif; };
    const fixed = (fm,fd) => { const raw=new Date(y,fm-1,fd).getDay(); let od=fd; if(raw===0)od=fd+1; if(raw===6)od=fd-1; return mo===fm&&dy===od; };
    if (fixed(1,1)||fixed(6,19)||fixed(7,4)||fixed(11,11)||fixed(12,25)) return true;
    if (mo===1 &&dow===1&&dy===nth(y,1,3,1)) return true;
    if (mo===2 &&dow===1&&dy===nth(y,2,3,1)) return true;
    if (mo===5 &&dow===1&&dy===last(y,5,1))  return true;
    if (mo===9 &&dow===1&&dy===nth(y,9,1,1)) return true;
    if (mo===10&&dow===1&&dy===nth(y,10,2,1))return true;
    if (mo===11&&dow===4&&dy===nth(y,11,4,4))return true;
    return false;
  };
  const _countBD = (start, end) => {
    let n=0; const c=new Date(start); c.setHours(0,0,0,0); const f=new Date(end); f.setHours(0,0,0,0);
    while(c<=f){const dw=c.getDay();if(dw!==0&&dw!==6&&!_isHoliday(c))n++;c.setDate(c.getDate()+1);}
    return n;
  };
  const _moStart  = new Date(yr, now2.getMonth(), 1);
  const _moEnd    = new Date(yr, now2.getMonth()+1, 0);
  const _moElapsed = _countBD(_moStart, now2);
  const _moTotal   = _countBD(_moStart, _moEnd);
  const monthRunRatePct = _moTotal > 0 ? (_moElapsed / _moTotal * 100).toFixed(1) : '0.0';

  // Prior-prior year — from customer record (full calendar year), falls back to 2-yr order window
  const ppyStart = `${yr - 2}-01-01`;
  const ppyEnd   = `${yr - 2}-${mm}-${dd}`;
  const ppyOrderTotal = orders.filter(o => o.date >= ppyStart && o.date <= ppyEnd)
                               .reduce((s, o) => s + (o.amount || 0), 0);
  const ppyTotal = custPpytdSales ?? (ppyOrderTotal > 0 ? ppyOrderTotal : 0);

  // Monthly goal: prior year FULL month (not same-day partial — matches v1)
  const pyMonthStart = `${yr - 1}-${mm}-01`;
  const pyMonthEnd   = new Date(yr - 1, parseInt(mm, 10), 0).toISOString().slice(0, 10);
  const monthGoal = orders.filter(o => {
    const d = (o.date || '').slice(0, 10);
    return d >= pyMonthStart && d <= pyMonthEnd;
  }).reduce((s, o) => s + (o.amount || 0), 0);
  const mtdPctOfGoal = monthGoal > 0 ? (mtdTotal / monthGoal * 100).toFixed(1) : null;

  // Orders in last 12 months + avg cadence
  const oneYearAgo  = new Date(now2); oneYearAgo.setFullYear(yr - 1);
  const orders12mo  = orders.filter(o => o.date && new Date(o.date) >= oneYearAgo).length;
  const orderDates  = [...new Set(orders.map(o => o.date).filter(Boolean))].sort();
  let avgCadence = null;
  if (orderDates.length >= 2) {
    const span = (new Date(orderDates[orderDates.length - 1]) - new Date(orderDates[0])) / 86400000;
    avgCadence = span / (orderDates.length - 1);
  }
  const cadenceLabel = avgCadence === null ? null
    : avgCadence <= 7  ? 'Weekly'
    : avgCadence <= 16 ? 'Bi-weekly'
    : avgCadence <= 35 ? 'Monthly'
    : avgCadence <= 50 ? 'Every 6 weeks'
    : avgCadence <= 75 ? 'Every 2 months'
    : 'Quarterly';

  // Annual Retail Sales — customer-level YTD field from the API
  const annualRetailSales = parseFloat(
    cust.ytdSales || cust.ytdAmount || cust.annualSales || cust.retailSales ||
    cust.currentYtdSales || cust.salesYtd || 0
  ) || null;

  // Lifetime sales — use authoritative customer field, fall back to 2-yr order sum
  const ordersSum     = orders.reduce((s, o) => s + (o.amount || 0), 0);
  const lifetimeSales = custLifetime ?? (ordersSum > 0 ? ordersSum : null);
  const customerSince = cust.createDate || cust.openDate || cust.firstSaleDate || null;
  const custAge = customerSince ? Math.floor((now2 - new Date(customerSince)) / (365.25 * 86400000)) : null;
  const customerAgeStr = (() => {
    if (!customerSince) return null;
    const s = new Date(customerSince);
    let yrs = now2.getFullYear() - s.getFullYear();
    let mos = now2.getMonth() - s.getMonth();
    if (mos < 0) { yrs--; mos += 12; }
    const yPart = yrs > 0 ? `${yrs} yr${yrs !== 1 ? 's' : ''}` : '';
    const mPart = mos > 0 ? `${mos} mo` : '';
    return [yPart, mPart].filter(Boolean).join(', ') || '< 1 mo';
  })();

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

  const runRateFill = Math.min(parseFloat(monthRunRatePct), 100).toFixed(1);
  const mtdPctColor = mtdPctOfGoal === null ? '#fff' : parseFloat(mtdPctOfGoal) >= 100 ? '#86efac' : parseFloat(mtdPctOfGoal) >= 70 ? '#fcd34d' : '#fca5a5';
  const daysSinceColor = daysSince === null ? '#fff' : daysSince <= 14 ? '#86efac' : daysSince <= 30 ? '#fcd34d' : '#fca5a5';

  panel.innerHTML = `
    <!-- Back link -->
    <div class="cat-nav-breadcrumb" style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div style="display:flex;align-items:center">
        <a class="cat-back-link" onclick="switchTab('store')">← Account Performance</a>
        <span style="color:#9ca3af;margin:0 8px">/</span>
        <span style="color:#1a2332;font-weight:600">${name}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        ${contacts.map(c => {
          const svgPhone  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.4 2 2 0 0 1 3.6 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.77a16 16 0 0 0 6 6l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7a2 2 0 0 1 1.72 2.03z"/></svg>`;
          const svgMobile = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`;
          const svgEmail  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`;
          const svgUrl    = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
          const row = (icon, href, label) => `<a href="${href}" style="display:flex;align-items:center;gap:4px;color:#3d5a80;text-decoration:none;font-size:12px;white-space:nowrap" onmouseover="this.style.color='#0d9488'" onmouseout="this.style.color='#3d5a80'">${icon}<span>${label}</span></a>`;
          const lines = [
            c.phone  ? row(svgPhone,  `tel:${c.phone.replace(/\D/g,'')}`,   c.phone)  : '',
            c.mobile ? row(svgMobile, `tel:${c.mobile.replace(/\D/g,'')}`,  c.mobile) : '',
            c.email  ? row(svgEmail,  `mailto:${c.email}`,                  c.email)  : '',
            c.url    ? row(svgUrl,    c.url.startsWith('http') ? c.url : `https://${c.url}`, c.url) : '',
          ].filter(Boolean).join('');
          return `<div style="border-left:3px solid #3d5a80;padding:4px 10px;display:flex;flex-direction:column;gap:3px;min-width:0">
            ${c.name ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#1a2332">${c.name}</div>` : ''}
            ${lines}
          </div>`;
        }).join('')}
        <button onclick="openProductListModal('${custNo.replace(/'/g,"\\'")}','${name.replace(/'/g,"\\'")}')"
          style="display:flex;align-items:center;gap:7px;background:#0d9488;color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>
          Generate Product List
        </button>
      </div>
    </div>

    <!-- Combined customer identity + KPI panel -->
    <div class="mgr-panel" style="margin-bottom:12px">
      <div style="display:flex;gap:0;align-items:stretch">

        <!-- Left: customer identity -->
        <div style="display:flex;flex-direction:column;justify-content:center;min-width:190px;max-width:210px;padding:16px 20px 16px 4px;border-right:1px solid rgba(255,255,255,0.12);margin-right:20px;flex-shrink:0">
          <div style="font-size:20px;font-weight:800;color:#fff;line-height:1.2;margin-bottom:6px">${name}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.65);line-height:1.8">
            <div>${salesRep} · ${state}${segment && segment !== '—' ? ' · ' + segment : ''}</div>
            <div>${discountStr}</div>
          </div>
          <div style="margin-top:6px;font-size:12px;color:rgba(255,255,255,0.55);font-family:monospace;letter-spacing:0.5px">${custNo}</div>
        </div>

        <!-- Right: KPI grid + donut -->
        <div style="flex:1;display:flex;gap:0;align-items:stretch">

        <!-- KPI pills -->
        <div style="flex:1;display:flex;flex-direction:column;gap:8px;padding:12px 0">

          <!-- Row 1: Annual Retail Sales | Annual Target | % to Target | Prior Year | Month to Date -->
          <div class="mgr-pill-row ca-kpi-row" style="margin:0">
            <div class="mgr-pill">
              <div class="mgr-pill-label">Annual Retail Sales</div>
              <div class="mgr-pill-value">${annualRetailSales ? fmt$(annualRetailSales) : fmt$(0)}</div>
              <div class="mgr-pill-sub">Current year retail</div>
            </div>
            <div class="mgr-pill">
              <div class="mgr-pill-label">Annual Target</div>
              <div class="mgr-pill-value">${target > 0 ? fmt$(target) : '—'}</div>
              <div class="mgr-pill-sub">Full prior year goal</div>
            </div>
            <div class="mgr-pill">
              <div class="mgr-pill-label">% to Target</div>
              <div class="mgr-pill-value">${target > 0 ? (pctToTgt * 100).toFixed(1) + '%' : '—'}</div>
              <div class="mgr-pill-sub">${chgStr} vs prior year</div>
            </div>
            <div class="mgr-pill">
              <div class="mgr-pill-label">Prior Year</div>
              <div class="mgr-pill-value">${custPytdSales ? fmt$(custPytdSales) : priorTotal > 0 ? fmt$(priorTotal) : '—'}</div>
              <div class="mgr-pill-sub">Full prior year</div>
            </div>
            <div class="mgr-pill">
              <div class="mgr-pill-label">Month to Date</div>
              <div class="mgr-pill-value">
                <span class="kpi-info-wrap">
                  ${fmt$(mtdTotal)}
                  <span class="kpi-info-icon">i
                    <span class="kpi-tooltip-box">
                      <strong>Monthly Goal:</strong> <span id="ca-kpi-month-goal">${monthGoal > 0 ? fmt$(monthGoal) : '—'}</span><br>
                      <strong>% to Goal:</strong> <span id="ca-kpi-pct-goal">${mtdPctOfGoal !== null ? mtdPctOfGoal + '%' : '—'}</span><br>
                      <strong>Run Rate:</strong> ${monthRunRatePct}%
                    </span>
                  </span>
                </span>
              </div>
              <div class="mgr-pill-sub" id="ca-kpi-mtd-sub">${monthGoal > 0 ? 'Goal: ' + fmt$(monthGoal) : (mtd?.orderDays || 0) + ' order days'}</div>
            </div>
          </div>

          <!-- Row 2: Lifetime Sales | YTD Sales | Run Rate | Prior Prior Year | Last Order Date -->
          <div class="mgr-pill-row ca-kpi-row" style="margin:0">
            <div class="mgr-pill">
              <div class="mgr-pill-label">Lifetime Sales</div>
              <div class="mgr-pill-value">
                <span class="kpi-info-wrap">
                  ${lifetimeSales ? fmt$(lifetimeSales) : '—'}
                  ${customerSince ? `<span class="kpi-info-icon">i
                    <span class="kpi-tooltip-box">
                      <strong>Origin Date:</strong> ${customerSince.slice(0,10)}<br>
                      <strong>Customer For:</strong> ${customerAgeStr}
                    </span>
                  </span>` : ''}
                </span>
              </div>
              <div class="mgr-pill-sub">${customerAgeStr ? customerAgeStr + ' customer' : 'Last 2 years'}</div>
            </div>
            <div class="mgr-pill">
              <div class="mgr-pill-label">YTD Sales</div>
              <div class="mgr-pill-value">${fmt$(ytdTotal)}</div>
              <div class="mgr-pill-sub">Current year to date</div>
            </div>
            <div class="mgr-pill mgr-pill-runrate">
              <div class="mgr-pill-label">Month Run Rate</div>
              <div class="mgr-pill-value">${monthRunRatePct}%</div>
              <div class="mgr-runrate-bar-track" style="margin:4px 0 2px">
                <div class="mgr-runrate-bar-fill" style="width:${runRateFill}%"></div>
              </div>
              <div class="mgr-pill-sub">${_moElapsed} of ${_moTotal} business days</div>
            </div>
            <div class="mgr-pill">
              <div class="mgr-pill-label">Prior Prior Year</div>
              <div class="mgr-pill-value">${ppyTotal > 0 ? fmt$(ppyTotal) : '—'}</div>
              <div class="mgr-pill-sub">2 years ago same period</div>
            </div>
            <div class="mgr-pill">
              <div class="mgr-pill-label">Last Order Date</div>
              <div class="mgr-pill-value">
                <span class="kpi-info-wrap">
                  ${lastDate || '—'}
                  <span class="kpi-info-icon">i
                    <span class="kpi-tooltip-box">
                      <strong>Orders (last 12 mo):</strong> <span id="ca-kpi-orders12mo">${orders12mo}</span><br>
                      <strong>Avg. Frequency:</strong> <span id="ca-kpi-avg-freq">${avgCadence !== null ? '(~every ' + Math.round(avgCadence) + ' days)' : '—'}</span><br>
                      <strong>Cadence:</strong> <span id="ca-kpi-cadence">${cadenceLabel || '—'}</span>
                    </span>
                  </span>
                </span>
              </div>
              <div class="mgr-pill-sub">${daysSince !== null ? daysSince + ' days ago' : 'No orders found'}</div>
            </div>
          </div>

        </div>

        </div>
      </div>
    </div>

    <!-- Two-column master-detail: align-items:flex-start so left anchors height -->
    <div id="ca-two-col" style="display:flex;gap:16px;margin-bottom:12px;align-items:flex-start">

      <!-- Left: category table — natural content height, never stretched -->
      <div id="ca-cat-panel" style="flex:0 0 45%;min-width:0">
        ${buildCatTable(catData)}
      </div>

      <!-- Right: two separate peer cards stacked in a flex column.
           Height is set by JS to match the left column. -->
      <div id="ca-right-col" style="flex:1;min-width:0;display:flex;flex-direction:column;gap:12px">

        <!-- Donut + bar chart card (side by side, same box) -->
        <div id="ca-donut-card" style="background:#fff;border-radius:6px;padding:0;display:flex;flex-direction:row;gap:12px;height:300px;flex-shrink:0">

          <!-- Left: donut -->
          <div style="flex:1;min-width:0;display:flex;flex-direction:column;border:1px solid #e7e5e4;border-radius:6px;padding:10px 12px">
            <div style="text-align:center;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:#3d5a80;margin-bottom:8px">Category Mix</div>
            <div style="flex:1;min-height:0;position:relative">
              <canvas id="ca-donut-canvas" style="position:absolute;inset:0;width:100%;height:100%"></canvas>
            </div>
          </div>

          <!-- Right: 6-month bar chart -->
          <div style="flex:1;min-width:0;display:flex;flex-direction:column;border:1px solid #e7e5e4;border-radius:6px;padding:10px 12px">
            <div style="text-align:center;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:#3d5a80;margin-bottom:8px">Last 12 Months</div>
            <div style="flex:1;min-height:0;position:relative">
              <canvas id="ca-bar-canvas" style="position:absolute;inset:0;width:100%;height:100%"></canvas>
            </div>
          </div>

        </div>

        <!-- Popup table card — flex:1 so it fills remaining right-col height; content scrolls inside -->
        <div id="ca-drill-card" style="background:#fff;border:1px solid #e7e5e4;border-radius:6px;flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden">
          <div id="ca-drill-content" style="flex:1;min-height:0;overflow-y:auto">
            <div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:120px;color:#9ca3af;font-size:14px;padding:32px;text-align:center">
              Click a category name or quantity to explore items
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- Order History (full width) -->
    <div class="card" style="margin-bottom:12px" id="ca-orders-card">
      <div id="ca-order-history-wrap">
        <div class="card-title">
          Order History <span style="font-weight:400;color:#9ca3af;font-size:12px;text-transform:none">${orders.length ? `(${Math.min(orders.length, 5)} most recent)` : '<span style="font-style:italic">loading…</span>'}</span>
        </div>
        ${buildOrderHistory(orders)}
      </div>
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

    <!-- Activity Log -->
    <div class="card" style="margin-bottom:12px">
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Activity Log</span>
        <button onclick="activityLogOpen('${custNo.replace(/'/g,"\\'")}')"
          style="background:#3d5a80;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
          + Log Activity
        </button>
      </div>
      <div id="ca-activity-list">${buildActivityList(custNo)}</div>
    </div>

    <!-- Activity Log Modal -->
    <div id="activity-modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:3100;align-items:center;justify-content:center" onclick="if(event.target===this)activityLogClose()">
      <div style="background:#fff;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,0.3);width:440px;max-width:96vw;overflow:hidden">
        <div style="background:#3d5a80;color:#fff;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
          <span style="font-size:15px;font-weight:700">Log Activity</span>
          <button onclick="activityLogClose()" style="background:none;border:none;color:rgba(255,255,255,0.8);font-size:20px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:4px">✕</button>
        </div>
        <div style="padding:18px 20px;display:flex;flex-direction:column;gap:12px">
          <input type="hidden" id="activity-cust-no" value="">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:#6b7280;margin-bottom:4px">Type of Contact</label>
            <select id="activity-type" onchange="activityToggleDuration()" style="width:100%;border:1px solid #d1d5db;border-radius:6px;padding:8px 10px;font-size:14px;font-family:inherit;color:#374151;outline:none">
              <option value="Call">Call</option>
              <option value="Email">Email</option>
              <option value="Visit">Visit</option>
              <option value="Other">Other</option>
            </select>
          </div>
          <div id="activity-duration-row">
            <label style="display:block;font-size:12px;font-weight:600;color:#6b7280;margin-bottom:4px">Duration (minutes)</label>
            <input type="number" id="activity-duration" min="0" placeholder="e.g. 15"
              style="width:100%;border:1px solid #d1d5db;border-radius:6px;padding:8px 10px;font-size:14px;font-family:inherit;color:#374151;outline:none">
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:#6b7280;margin-bottom:4px">Notes</label>
            <textarea id="activity-notes" placeholder="What was discussed?" rows="3"
              style="width:100%;border:1px solid #d1d5db;border-radius:6px;padding:8px 10px;font-size:14px;font-family:inherit;resize:vertical;color:#374151;outline:none"></textarea>
          </div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;gap:10px">
          <button onclick="activityLogClose()" style="background:#f1f5f9;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Cancel</button>
          <button onclick="activityLogSave()" style="background:#3d5a80;color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Save</button>
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

  // Sync right column height to left column after layout settles, then watch for resize
  setTimeout(() => { syncCARightColHeight(); attachCARightColSync(); }, 0);

  // Ensure AI tab is always visible after render
  setTimeout(ensureAITab, 0);

  // Store refs for regenerate button
  window.caLastCust    = cust;
  window.caLastCatData = catData;
  window.caLastMtd     = mtd;
  window.caLastOrders  = orders;
}

// ── Right-column height sync ──────────────────────────────────
// Sets #ca-right-col height to match #ca-cat-panel's natural content height.
// Called after render and on window resize so bottom edges always align.

function syncCARightColHeight() {
  const left  = document.getElementById('ca-cat-panel');
  const right = document.getElementById('ca-right-col');
  if (!left || !right) return;
  right.style.height = left.offsetHeight + 'px';
}

let _caResizeObserver = null;
function attachCARightColSync() {
  if (_caResizeObserver) _caResizeObserver.disconnect();
  const left = document.getElementById('ca-cat-panel');
  if (!left) return;
  _caResizeObserver = new ResizeObserver(() => syncCARightColHeight());
  _caResizeObserver.observe(left);
}

// ── Charts ────────────────────────────────────────────────────

function renderCACharts(catData, orders) {
  destroyCACharts();

  const top8 = [...catData].sort((a, b) => b.currentYtdAmt - a.currentYtdAmt).slice(0, 8);

  // ── Donut: category mix (right panel, white background) ──────
  const donutCtx = document.getElementById('ca-donut-canvas');
  if (donutCtx && top8.length) {
    const allTotal = catData.reduce((s, c) => s + c.currentYtdAmt, 0);
    const top7     = top8.slice(0, 7);
    const other    = catData.slice(7).reduce((s, c) => s + c.currentYtdAmt, 0);
    const LABEL_MAP = { 'KGS CHANGEMAKER': 'Changemaker', 'KGS CHANGEMAKERS': 'Changemaker', 'KELCHNGMKR': 'Changemaker', 'SEASONAL': 'Seasonal', 'KGS SEASONAL': 'Seasonal' };
    const slices = top7.map(c => {
      const raw   = (c.description || c.categoryCode).trim();
      const label = LABEL_MAP[raw.toUpperCase()] || raw.replace(/^KGS\s+/i, '');
      return { label: label.length > 13 ? label.slice(0, 12) + '…' : label, value: c.currentYtdAmt, color: getCategoryColor(c.categoryCode || c.description), catCode: c.categoryCode };
    });
    if (other > 0) slices.push({ label: 'Other', value: other, color: getCategoryColor('OTHER'), catCode: null });

    caCharts.donut = new Chart(donutCtx.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: slices.map(s => s.label),
        datasets: [{ data: slices.map(s => s.value), backgroundColor: slices.map(s => s.color), borderColor: '#000', borderWidth: 1 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '52%', layout: { padding: 0 },
        onClick: (_e, elements) => {
          if (!elements.length) return;
          const catCode = slices[elements[0].index]?.catCode;
          if (catCode) openCategoryDrill(caCustNo, catCode, 'ytd');
        },
        plugins: {
          legend: {
            display: true, position: 'right',
            labels: { font: { size: 10 }, color: '#374151', boxWidth: 10, boxHeight: 10, padding: 5 },
            onClick: (_e, legendItem) => {
              const catCode = slices[legendItem.index]?.catCode;
              if (catCode) openCategoryDrill(caCustNo, catCode, 'ytd');
            }
          },
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
    donutCtx.style.cursor = 'pointer';
  }

  // ── Bar chart: last 12 months of sales ────────────────────────
  const barCtx = document.getElementById('ca-bar-canvas');
  if (barCtx && orders.length) {
    const now   = new Date();
    const allMonthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    // Build last-12-months window (may span prior year)
    const months = [];
    for (let i = 12; i >= 1; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ year: d.getFullYear(), month: d.getMonth(), label: allMonthLabels[d.getMonth()] });
    }
    const totals     = months.map(() => 0);
    const orderCounts = months.map(() => 0);
    const lineCounts  = months.map(() => 0);
    for (const o of orders) {
      const d = new Date(o.date || o.ticketDate || '');
      if (isNaN(d)) continue;
      const idx = months.findIndex(m => m.year === d.getFullYear() && m.month === d.getMonth());
      if (idx !== -1) {
        totals[idx]      += parseFloat(o.amount || 0);
        orderCounts[idx] += 1;
        lineCounts[idx]  += parseInt(o.itemCount || 0, 10);
      }
    }
    // Sequential blue: oldest bar = lightest, newest = darkest
    caCharts.bar = new Chart(barCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: months.map(m => m.label),
        datasets: [{
          data: totals,
          backgroundColor: months.map((_, i) => getSequentialColor(i)),
          borderColor: '#000000',
          borderWidth: 2,
          borderRadius: 4,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltip,
            callbacks: {
              label: ctx => ' ' + fmt$(ctx.parsed.y),
              afterLabel: ctx => {
                const i = ctx.dataIndex;
                const oc = orderCounts[i];
                const lc = lineCounts[i];
                const lines = [];
                if (oc > 0) lines.push(` ${oc} order${oc !== 1 ? 's' : ''}`);
                if (lc > 0) lines.push(` ${lc} line${lc !== 1 ? 's' : ''}`);
                return lines;
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 }, color: '#6b7280' } },
          y: {
            grid: { color: '#f3f4f6' },
            ticks: {
              font: { size: 11 }, color: '#6b7280',
              callback: v => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v)
            }
          }
        }
      }
    });
    barCtx.style.cursor = 'default';
  }

}

// ── Month orders drill-in (bar chart click) ───────────────────
function showMonthOrders(year, month) {
  const drill = document.getElementById('ca-drill-content');
  if (!drill) return;

  const allMonthLabels = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthLabel = `${allMonthLabels[month]} ${year}`;
  const orders = (window.caLastOrders || []).filter(o => {
    const d = new Date(o.date || o.ticketDate || '');
    return !isNaN(d) && d.getFullYear() === year && d.getMonth() === month;
  }).sort((a, b) => new Date(b.date || b.ticketDate) - new Date(a.date || a.ticketDate));

  if (!orders.length) {
    removeDrillTitleBar();
    drill.innerHTML = `<div style="padding:32px;text-align:center;color:#9ca3af;font-size:14px">No orders found for ${monthLabel}</div>`;
    return;
  }

  const total = orders.reduce((s, o) => s + parseFloat(o.amount || 0), 0);
  const rows = orders.map(o => {
    const date   = (o.date || o.ticketDate || '').slice(0, 10);
    const amt    = parseFloat(o.amount || 0);
    const ticket = o.ticketNo || o.ticketNumber || o.orderId || '—';
    return `<tr>
      <td style="padding:8px 12px;color:#6b7280;font-size:13px">${date}</td>
      <td style="padding:8px 12px;font-family:monospace;font-size:13px">
        <a onclick="switchTab('item');loadOrderDetail('${caCustNo}','${ticket}')"
           style="color:#3d5a80;text-decoration:none;cursor:pointer"
           onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${ticket}</a>
      </td>
      <td style="padding:8px 12px;text-align:right;font-weight:600;color:#1a2332;font-size:13px">${fmt$(amt)}</td>
    </tr>`;
  }).join('');

  const card2 = document.getElementById('ca-drill-card');
  let tb2 = card2 && card2.querySelector('#ca-drill-titlebar');
  if (!tb2 && card2) {
    tb2 = document.createElement('div');
    tb2.id = 'ca-drill-titlebar';
    tb2.style.cssText = 'flex-shrink:0;border-bottom:1px solid #f3f4f6;background:#fff';
    card2.insertBefore(tb2, drill);
  }
  if (tb2) {
    tb2.innerHTML = `
      <div style="padding:10px 14px 8px;display:flex;align-items:center;gap:10px">
        <span style="font-weight:800;color:#1a2332;font-size:15px">${monthLabel}</span>
        <span style="color:#9ca3af;font-size:13px">${orders.length} order${orders.length !== 1 ? 's' : ''}</span>
        <span style="margin-left:auto;font-weight:700;color:#1a2332;font-size:15px">${fmt$(total)}</span>
      </div>`;
  }

  drill.innerHTML = `
    <table class="data-table" style="width:100%">
      <thead style="position:sticky;top:0;z-index:2;background:#3d5a80">
        <tr>
          <th style="padding:8px 12px;text-align:left;font-size:12px">Date</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px">Order #</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
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

// ── Always-show category list ─────────────────────────────────
// NCR category codes that are pinned — server guarantees these arrive even at $0.
// Client-side list is the fallback safety net; must use real NCR codes.
const CA_ALWAYS_SHOW = [
  'BABY','BLNWEIGHTS','BLOON','CANDY','ELECTRONIC','FASHN',
  'FIXTURES','GIFTS','HBA','HOMEOFFICE','INSPR',
  'KELBOUQUET','KELCHNGMKR','KELLILOON','PLUSH','SEASN','TOYS',
];

// ── Category table ────────────────────────────────────────────

function buildCatTable(catData) {
  // Merge always-show list with actual data
  const lookup = {};
  for (const c of catData) {
    const dk = (c.description  || '').toUpperCase().trim();
    const ck = (c.categoryCode || '').toUpperCase().trim();
    if (dk) lookup[dk] = c;
    if (ck && !lookup[ck]) lookup[ck] = c;
  }
  const seen = new Set();
  const merged = [];
  for (const name of CA_ALWAYS_SHOW) {
    const key = name.toUpperCase();
    const found = lookup[key];
    if (found) {
      const fk = (found.categoryCode || '').toUpperCase().trim();
      const fd = (found.description  || '').toUpperCase().trim();
      if (seen.has(fk) || seen.has(fd)) continue;
      merged.push(found);
      if (fk) seen.add(fk);
      if (fd) seen.add(fd);
    } else {
      if (seen.has(key)) continue;
      merged.push({ categoryCode: name, description: name, currentYtdAmt: 0, currentQty: 0, priorYtdAmt: 0, priorQty: 0, mtdAmt: 0, mtdQty: 0, dollarChange: 0 });
      seen.add(key);
    }
  }
  // Append any categories from actual data not already in the list
  for (const c of catData) {
    const ck = (c.categoryCode || '').toUpperCase().trim();
    const dk = (c.description  || '').toUpperCase().trim();
    if (!seen.has(ck) && !seen.has(dk)) {
      merged.push(c);
      if (ck) seen.add(ck);
      if (dk) seen.add(dk);
    }
  }

  const sorted = [...merged].sort((a, b) => {
    const dir = caCatSort.dir === 'asc' ? 1 : -1;
    switch (caCatSort.col) {
      case 'description':   return dir * (a.description || '').localeCompare(b.description || '');
      case 'currentYtdAmt': return dir * (a.currentYtdAmt - b.currentYtdAmt);
      case 'currentQty':    return dir * (a.currentQty    - b.currentQty);
      case 'priorYtdAmt':   return dir * (a.priorYtdAmt   - b.priorYtdAmt);
      case 'priorQty':      return dir * (a.priorQty      - b.priorQty);
      case 'dollarChange':  return dir * (a.dollarChange   - b.dollarChange);
      default: return dir * (a.currentYtdAmt - b.currentYtdAmt);
    }
  });

  const th = (key, label, cls = '', style = '', tip = '') => {
    const active = caCatSort.col === key;
    const icon   = active ? (caCatSort.dir === 'asc' ? '▲' : '▼') : '⇅';
    return `<th class="${cls} sort-th${active ? ' sort-active' : ''}" onclick="caSortCat('${key}')"${style ? ` style="${style}"` : ''}${tip ? ` title="${tip}"` : ''}>${label}<span class="sort-icon">${icon}</span></th>`;
  };

  // Totals row
  const totCurrAmt  = sorted.reduce((s, c) => s + (c.currentYtdAmt || 0), 0);
  const totCurrQty  = sorted.reduce((s, c) => s + (c.currentQty    || 0), 0);
  const totPriorAmt = sorted.reduce((s, c) => s + (c.priorYtdAmt   || 0), 0);
  const totPriorQty = sorted.reduce((s, c) => s + (c.priorQty      || 0), 0);
  const totDollar   = totCurrAmt - totPriorAmt;
  const totDollarBg = totDollar >= 0 ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.12)';
  const totDollarCl = totDollar >= 0 ? '#059669' : '#dc2626';

  const rows = sorted.map(c => {
    const dBg      = c.dollarChange >= 0 ? 'rgba(22,163,74,0.10)' : 'rgba(220,38,38,0.10)';
    const dCl      = c.dollarChange >= 0 ? '#059669' : '#dc2626';
    const catFull  = c.description || c.categoryCode;
    const catLabel = catFull.length > 15 ? catFull.slice(0, 15).trimEnd() + '…' : catFull;
    const isSel    = c.categoryCode === caSelectedCategory;
    const rowStyle = isSel ? 'background:#ccfbf1;border-left:3px solid #0f766e' : 'border-left:3px solid transparent';
    return `<tr data-category="${c.categoryCode}" style="${rowStyle}">
      <td class="cat-name-cell">
        <a class="acct-name-link" onclick="openCategoryDrill('${caCustNo}','${c.categoryCode}','best')" title="${catFull}">${catLabel}</a>
      </td>
      <td class="num-ctr">${fmt$(c.currentYtdAmt)}</td>
      <td class="num-ctr">${c.currentQty > 0 ? `<a class="acct-name-link" onclick="openCategoryDrill('${caCustNo}','${c.categoryCode}','ytd')" title="View YTD items" style="font-weight:700">${Math.round(c.currentQty).toLocaleString()}</a>` : '—'}</td>
      <td class="num-ctr">${c.priorYtdAmt > 0 ? fmt$(c.priorYtdAmt) : '—'}</td>
      <td class="num-ctr">${c.priorQty > 0 ? Math.round(c.priorQty).toLocaleString() : '—'}</td>
      <td class="num-ctr"><span style="background:${dBg};color:${dCl};padding:3px 8px;border-radius:12px;font-size:13px;font-weight:700;white-space:nowrap;display:inline-block">${c.dollarChange >= 0 ? '+' : ''}${fmt$(c.dollarChange)}</span></td>
    </tr>`;
  }).join('');

  const totalsRow = `
    <tr style="background:#f8fafc;font-weight:700;border-top:2px solid #e5e7eb">
      <td style="padding:12px 14px;color:#1a2332">TOTAL</td>
      <td class="num-ctr" style="padding:12px 8px;color:#1a2332">${fmt$(totCurrAmt)}</td>
      <td class="num-ctr" style="padding:12px 8px;color:#1a2332">${totCurrQty > 0 ? Math.round(totCurrQty).toLocaleString() : '—'}</td>
      <td class="num-ctr" style="padding:12px 8px;color:#1a2332">${totPriorAmt > 0 ? fmt$(totPriorAmt) : '—'}</td>
      <td class="num-ctr" style="padding:12px 8px;color:#1a2332">${totPriorQty > 0 ? Math.round(totPriorQty).toLocaleString() : '—'}</td>
      <td class="num-ctr" style="padding:12px 8px"><span style="background:${totDollarBg};color:${totDollarCl};padding:3px 8px;border-radius:12px;font-size:13px;font-weight:700;white-space:nowrap;display:inline-block">${totDollar >= 0 ? '+' : ''}${fmt$(totDollar)}</span></td>
    </tr>`;

  return `
    <div class="card" style="padding:0">
      <div style="padding:14px 20px 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f3f4f6">
        <span style="font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:#3d5a80">Category Breakdown</span>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button onclick="exportCatCSV()" style="display:flex;align-items:center;gap:5px;background:#f1f5f9;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export CSV
          </button>
          <button onclick="printCatTable()" style="display:flex;align-items:center;gap:5px;background:#f1f5f9;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            Print
          </button>
        </div>
      </div>
      <div class="inv-wrap">
        <table class="data-table" id="ca-cat-table">
          <thead style="position:sticky;top:0;z-index:2;background:#fff"><tr>
            ${th('description',   'Category',       '')}
            ${th('currentYtdAmt', 'Current YTD $', 'num-ctr')}
            ${th('currentQty',    'Curr Unq Qty',  'num-ctr')}
            ${th('priorYtdAmt',   'Prior YTD $',   'num-ctr')}
            ${th('priorQty',      'Prior Unq Qty', 'num-ctr', 'cursor:help', 'Prior year to date (Jan 1 – same date last year), not the full prior calendar year')}
            ${th('dollarChange',  '$ Change',       'num-ctr')}
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot style="position:sticky;bottom:0;z-index:2">${totalsRow}</tfoot>
        </table>
      </div>
    </div>`;
}

function caSortCat(col) {
  const defaultDir = col === 'description' ? 'asc' : 'desc';
  caCatSort.dir = caCatSort.col === col ? (caCatSort.dir === 'asc' ? 'desc' : 'asc') : defaultDir;
  caCatSort.col = col;
  const panel = document.getElementById('ca-cat-panel');
  if (panel) panel.innerHTML = buildCatTable(window.caLastCatData || []);
}

function exportCatCSV() {
  const data = window.caLastCatData || [];
  if (!data.length) return;
  const custName = (window.caLastCust && (window.caLastCust.name || window.caLastCust.custNo)) || caCustNo || 'account';
  const headers  = ['Category', 'Current YTD $', 'Curr Qty', 'Prior YTD $', 'Prior Qty', '$ Change', '% Change'];
  const dataRows = data.map(c => {
    const pctChg = c.priorYtdAmt > 0 ? ((c.currentYtdAmt - c.priorYtdAmt) / c.priorYtdAmt * 100).toFixed(1) + '%' : '-';
    return [
      c.description || c.categoryCode,
      c.currentYtdAmt.toFixed(2),
      Math.round(c.currentQty || 0),
      c.priorYtdAmt.toFixed(2),
      Math.round(c.priorQty || 0),
      (c.dollarChange >= 0 ? '+' : '') + c.dollarChange.toFixed(2),
      pctChg,
    ];
  });

  const XS = typeof XLSXStyle !== 'undefined' ? XLSXStyle : XLSX;
  const ws = XS.utils.aoa_to_sheet([headers, ...dataRows]);

  const maxLens = headers.map((h, ci) => {
    const colVals = [h, ...dataRows.map(r => String(r[ci] ?? ''))];
    return Math.max(...colVals.map(v => v.length));
  });
  ws['!cols'] = maxLens.map(w => ({ wch: Math.min(w + 2, 60) }));

  headers.forEach((_, ci) => {
    const addr = XS.utils.encode_cell({ r: 0, c: ci });
    if (ws[addr]) ws[addr].s = { font: { bold: true }, fill: { fgColor: { rgb: 'D8D8D8' }, patternType: 'solid' }, alignment: { horizontal: 'center' } };
  });

  const wb = XS.utils.book_new();
  XS.utils.book_append_sheet(wb, ws, custName.slice(0, 31));
  XS.writeFile(wb, `${custName.replace(/[^a-z0-9]/gi, '_')}_categories.xlsx`);
}

function printCatTable() {
  const cust    = window.caLastCust    || {};
  const catData = window.caLastCatData || [];
  if (!catData.length) return;

  const custName = cust.name || cust.custNo || '';
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Clone the live KPI rows from the DOM so values are always in sync
  const liveKpiRows = document.querySelectorAll('.ca-kpi-row');
  let kpiHtml = '';
  liveKpiRows.forEach(row => {
    // Strip tooltip icons and interactive elements, keep labels/values/subs
    const clone = row.cloneNode(true);
    clone.querySelectorAll('.kpi-info-icon, .kpi-tooltip-box, .kpi-info-wrap').forEach(el => {
      // Unwrap kpi-info-wrap (keep its text children), remove icon+tooltip
      if (el.classList.contains('kpi-info-wrap')) {
        const txt = el.querySelector('.mgr-pill-value') ? el.textContent : el.childNodes[0]?.textContent || '';
        el.replaceWith(document.createTextNode(txt.trim()));
      } else {
        el.remove();
      }
    });
    // Flatten inline styles for print: remove run-rate bar track markup
    clone.querySelectorAll('.mgr-runrate-bar-track').forEach(el => el.remove());
    kpiHtml += `<div style="display:flex;gap:6px;margin-bottom:6px">${clone.innerHTML}</div>`;
  });

  // Build sorted category rows
  const sorted = [...catData].sort((a, b) => {
    const dir = caCatSort.dir === 'asc' ? 1 : -1;
    switch (caCatSort.col) {
      case 'currentYtdAmt': return dir * (a.currentYtdAmt - b.currentYtdAmt);
      case 'currentQty':    return dir * (a.currentQty    - b.currentQty);
      case 'priorYtdAmt':   return dir * (a.priorYtdAmt   - b.priorYtdAmt);
      case 'priorQty':      return dir * (a.priorQty      - b.priorQty);
      case 'dollarChange':  return dir * (a.dollarChange   - b.dollarChange);
      default: return dir * (a.description || '').localeCompare(b.description || '');
    }
  });

  let totCurr = 0, totPrior = 0, totCurrQ = 0, totPriorQ = 0;
  const tableRows = sorted.map(c => {
    totCurr  += c.currentYtdAmt || 0;
    totPrior += c.priorYtdAmt   || 0;
    totCurrQ += c.currentQty    || 0;
    totPriorQ += c.priorQty     || 0;
    const dc  = c.dollarChange || 0;
    const dBg = dc >= 0 ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.12)';
    const dCl = dc >= 0 ? '#059669' : '#dc2626';
    const pctChg = c.priorYtdAmt > 0 ? ((c.currentYtdAmt - c.priorYtdAmt) / c.priorYtdAmt * 100) : null;
    const pctStr = pctChg !== null ? (pctChg >= 0 ? '+' : '') + pctChg.toFixed(1) + '%' : '—';
    const pctCl  = pctChg !== null ? (pctChg >= 0 ? '#059669' : '#dc2626') : '#9ca3af';
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;font-size:11px">${c.description || c.categoryCode}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;font-size:11px">${fmt$(c.currentYtdAmt)}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;font-size:11px">${c.currentQty > 0 ? Math.round(c.currentQty).toLocaleString() : '—'}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;font-size:11px">${c.priorYtdAmt > 0 ? fmt$(c.priorYtdAmt) : '—'}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;font-size:11px">${c.priorQty > 0 ? Math.round(c.priorQty).toLocaleString() : '—'}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;font-size:11px"><span style="background:${dBg};color:${dCl};padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap;display:inline-block">${dc >= 0 ? '+' : ''}${fmt$(dc)}</span></td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;font-size:11px;font-weight:600;color:${pctCl}">${pctStr}</td>
    </tr>`;
  }).join('');

  const totDollar   = totCurr - totPrior;
  const totDollarBg = totDollar >= 0 ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.12)';
  const totDollarCl = totDollar >= 0 ? '#059669' : '#dc2626';
  const totPct      = totPrior > 0 ? ((totDollar / totPrior) * 100) : null;
  const totPctStr   = totPct !== null ? (totPct >= 0 ? '+' : '') + totPct.toFixed(1) + '%' : '—';
  const totPctCl    = totPct !== null ? (totPct >= 0 ? '#059669' : '#dc2626') : '#9ca3af';

  let area = document.getElementById('ca-print-area');
  if (!area) {
    area = document.createElement('div');
    area.id = 'ca-print-area';
    document.body.appendChild(area);
  }

  area.innerHTML = `
    <div style="font-family:Inter,Arial,sans-serif;color:#1a2332;padding:0">
      <!-- Header -->
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #3d5a80">
        <div style="font-size:18px;font-weight:800;color:#3d5a80">${custName}</div>
        <div style="font-size:10px;color:#6b7280">${today}</div>
      </div>

      <!-- Full KPI ribbon cloned from live DOM -->
      <div style="margin-bottom:16px">${kpiHtml}</div>

      <!-- Category breakdown -->
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#3d5a80;margin-bottom:6px">Category Breakdown</div>
      <table style="border-collapse:collapse;width:100%">
        <thead>
          <tr style="background:#f3f4f6">
            <th style="text-align:left;padding:7px 10px;font-size:11px;font-weight:700;border-bottom:2px solid #e5e7eb">Category</th>
            <th style="text-align:right;padding:7px 10px;font-size:11px;font-weight:700;border-bottom:2px solid #e5e7eb">Current YTD $</th>
            <th style="text-align:right;padding:7px 10px;font-size:11px;font-weight:700;border-bottom:2px solid #e5e7eb">Curr Qty</th>
            <th style="text-align:right;padding:7px 10px;font-size:11px;font-weight:700;border-bottom:2px solid #e5e7eb">Prior YTD $</th>
            <th style="text-align:right;padding:7px 10px;font-size:11px;font-weight:700;border-bottom:2px solid #e5e7eb">Prior Qty</th>
            <th style="text-align:right;padding:7px 10px;font-size:11px;font-weight:700;border-bottom:2px solid #e5e7eb">$ Change</th>
            <th style="text-align:right;padding:7px 10px;font-size:11px;font-weight:700;border-bottom:2px solid #e5e7eb">% Change</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
          <tr style="font-weight:700;background:#f8fafc;border-top:2px solid #e5e7eb">
            <td style="padding:7px 10px;font-size:11px">TOTAL</td>
            <td style="padding:7px 10px;text-align:right;font-size:11px">${fmt$(totCurr)}</td>
            <td style="padding:7px 10px;text-align:right;font-size:11px">${totCurrQ > 0 ? Math.round(totCurrQ).toLocaleString() : '—'}</td>
            <td style="padding:7px 10px;text-align:right;font-size:11px">${totPrior > 0 ? fmt$(totPrior) : '—'}</td>
            <td style="padding:7px 10px;text-align:right;font-size:11px">${totPriorQ > 0 ? Math.round(totPriorQ).toLocaleString() : '—'}</td>
            <td style="padding:7px 10px;text-align:right;font-size:11px"><span style="background:${totDollarBg};color:${totDollarCl};padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap;display:inline-block">${totDollar >= 0 ? '+' : ''}${fmt$(totDollar)}</span></td>
            <td style="padding:7px 10px;text-align:right;font-size:11px;font-weight:700;color:${totPctCl}">${totPctStr}</td>
          </tr>
        </tbody>
      </table>
    </div>`;

  document.body.classList.add('ca-print-mode');
  window.print();
  setTimeout(() => {
    area.innerHTML = '';
    document.body.classList.remove('ca-print-mode');
  }, 1000);
}

function removeDrillTitleBar() {
  const tb = document.getElementById('ca-drill-titlebar');
  if (tb) tb.remove();
}

// ── Item drill-down ───────────────────────────────────────────

async function openCategoryDrill(custNo, category, defaultTab = 'best') {
  caDrill     = { category, tab: defaultTab };
  caDrillSort = { col: defaultTab === 'ytd' ? 'current_qty' : 'rank', dir: defaultTab === 'ytd' ? 'desc' : 'asc' };

  // Update selected category and re-render left table to move highlight
  caSelectedCategory = category;
  const catPanel = document.getElementById('ca-cat-panel');
  if (catPanel) catPanel.innerHTML = buildCatTable(window.caLastCatData || []);

  const drill = document.getElementById('ca-drill-content');
  if (!drill) return;

  removeDrillTitleBar();
  drill.innerHTML = `<div style="padding:24px;color:#6b7280;display:flex;align-items:center;justify-content:center;min-height:160px">Loading items for <strong style="margin-left:5px">${category}</strong>…</div>`;

  const enc = encodeURIComponent(custNo);
  const cat = encodeURIComponent(category);

  try {
    const [ytdResp, topResp] = await Promise.all([
      fetch(`/proxy/ytd-items/${enc}/${cat}`),
      fetch(`/proxy/top-items/${enc}/${cat}`),
    ]);
    const ytdItems = ytdResp.ok ? await ytdResp.json() : [];
    const topItems = topResp.ok ? await topResp.json() : [];
    caDrill = { category, tab: defaultTab, ytdItems, topItems };
    renderItemDrill();
  } catch (e) {
    if (drill) { removeDrillTitleBar(); drill.innerHTML = `<div style="padding:20px;color:#dc2626">Error loading items: ${e.message}</div>`; }
  }
}

function renderItemDrill() {
  const sec = document.getElementById('ca-drill-content');
  if (!sec || !caDrill) return;
  const { category, tab, ytdItems = [], topItems = [] } = caDrill;

  const th = (key, label, cls = '') => {
    const active = caDrillSort.col === key;
    const icon   = active ? (caDrillSort.dir === 'asc' ? '▲' : '▼') : '⇅';
    return `<th class="${cls} sort-th${active ? ' sort-active' : ''}" onclick="caDrillSortBy('${key}')">${label}<span class="sort-icon">${icon}</span></th>`;
  };

  const statusBadge = s => s === 'A'
    ? `<span style="background:rgba(22,163,74,0.12);color:#059669;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700">A</span>`
    : `<span style="background:rgba(220,38,38,0.10);color:#dc2626;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700">I</span>`;

  const itemLink = itemNo =>
    `<span style="display:inline-flex;align-items:center;gap:5px">
      <a href="https://www.kellisgifts.com/shop?q=${encodeURIComponent(itemNo)}" target="_blank" rel="noopener"
         style="font-family:monospace;font-weight:600;color:#3d5a80;text-decoration:none"
         onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${itemNo}</a>
      <a onclick="switchTab('category');ipOpenItem('${itemNo}')" title="View item performance"
         style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;background:#e0f2fe;border-radius:3px;cursor:pointer;flex-shrink:0;text-decoration:none"
         onmouseover="this.style.background='#bae6fd'" onmouseout="this.style.background='#e0f2fe'">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0369a1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      </a>
    </span>`;

  // Sort the active list
  const { col, dir } = caDrillSort;
  const d = dir === 'asc' ? 1 : -1;
  const list = [...(tab === 'ytd' ? ytdItems : topItems)].sort((a, b) => {
    switch (col) {
      case 'rank':        return d * (a.rank - b.rank);
      case 'status':      return d * (a.status || '').localeCompare(b.status || '');
      case 'itemNo':      return d * (a.itemNo || '').localeCompare(b.itemNo || '');
      case 'description': return d * (a.description || '').localeCompare(b.description || '');
      case 'prior_qty':   return d * ((a.prior_qty || 0) - (b.prior_qty || 0));
      case 'current_qty': return d * ((a.current_qty || 0) - (b.current_qty || 0));
      case 'qty_12mo':    return d * ((a.qty_12mo || 0) - (b.qty_12mo || 0));
      case 'cadence':     return d * (a.cadence || '').localeCompare(b.cadence || '');
      case 'last_sold':   return d * (a.last_sold || '').localeCompare(b.last_sold || '');
      default: return 0;
    }
  });

  let tableHTML = '';

  if (tab === 'ytd') {
    const totYTD  = list.reduce((s, i) => s + (i.current_qty || 0), 0);
    const totLYTD = list.reduce((s, i) => s + (i.prior_qty   || 0), 0);

    const rows = list.map(i => `<tr>
      <td style="padding:8px 10px;color:#9ca3af;text-align:center;width:36px">${i.rank}</td>
      <td style="padding:8px 10px;text-align:center;width:48px">${statusBadge(i.status)}</td>
      <td style="padding:8px 10px;text-align:center">${itemLink(i.itemNo)}</td>
      <td style="padding:8px 10px">${i.description || '—'}</td>
      <td class="num-ctr" style="padding:8px 10px;color:#6b7280">${i.prior_qty > 0 ? i.prior_qty : '—'}</td>
      <td class="num-ctr" style="padding:8px 10px;font-weight:700;color:#1a2332">${i.current_qty > 0 ? i.current_qty : '—'}</td>
      <td style="padding:8px 10px;color:#6b7280;white-space:nowrap">${i.cadence || '—'}</td>
    </tr>`).join('') || '<tr><td colspan="7" style="color:#9ca3af;padding:24px;text-align:center">No items with purchases this year or same period last year.</td></tr>';

    const stickyTd = 'position:sticky;bottom:0;z-index:2;background:#f8fafc;border-top:2px solid #e5e7eb;font-weight:700;box-shadow:0 -2px 4px rgba(0,0,0,0.06)';
    const totRow = list.length ? `<tr>
      <td colspan="4" style="${stickyTd};padding:10px 10px;color:#1a2332">TOTAL</td>
      <td class="num-ctr" style="${stickyTd};padding:10px 10px;color:#6b7280">${totLYTD || '—'}</td>
      <td class="num-ctr" style="${stickyTd};padding:10px 10px;font-weight:800;color:#1a2332">${totYTD || '—'}</td>
      <td style="${stickyTd};padding:10px 10px"></td>
    </tr>` : '';

    tableHTML = `<table class="data-table">
      <thead style="position:sticky;top:0;z-index:2;background:#3d5a80"><tr>
        ${th('rank',        '#',         'num-ctr')}
        ${th('status',      'Stat',      'num-ctr')}
        ${th('itemNo',      'Item #',    'num-ctr')}
        ${th('description', 'Description')}
        ${th('prior_qty',   'LYTD',      'num-ctr')}
        ${th('current_qty', 'YTD',       'num-ctr')}
        ${th('cadence',     'Frequency', '',        'white-space:nowrap')}
      </tr></thead>
      <tbody>${rows}</tbody>
      ${totRow ? `<tfoot>${totRow}</tfoot>` : ''}
    </table>`;

  } else {
    // Best Sellers mode: # / Stat / Item # / Description / 12 MO Qty / Last Purchase
    const rows = list.map(i => {
      let lastStyle = '';
      if (i.last_sold) {
        const daysAgo = Math.floor((Date.now() - new Date(i.last_sold)) / 86400000);
        if (daysAgo <= 30)  lastStyle = 'background:rgba(22,163,74,0.14);color:#059669;font-weight:600;padding:2px 6px;border-radius:6px;';
        if (daysAgo >= 365) lastStyle = 'background:rgba(220,38,38,0.10);color:#dc2626;font-weight:600;padding:2px 6px;border-radius:6px;';
      }
      const notBuying = (i.qty_12mo === 0 || i.qty_12mo == null) && !i.last_sold;
      return `<tr style="${notBuying ? 'background:#fff8f0' : ''}">
        <td style="padding:8px 10px;color:#9ca3af;text-align:center;width:36px">${i.rank}</td>
        <td style="padding:8px 10px;text-align:center;width:48px">${statusBadge(i.status)}</td>
        <td style="padding:8px 10px;text-align:center">${itemLink(i.itemNo)}</td>
        <td style="padding:8px 10px">${i.description || '—'}</td>
        <td class="num-ctr" style="padding:8px 10px;font-weight:${i.qty_12mo > 0 ? '700' : '400'};color:${i.qty_12mo > 0 ? '#1a2332' : '#9ca3af'}">${i.qty_12mo > 0 ? i.qty_12mo : '—'}</td>
        <td style="padding:8px 10px;text-align:center"><span style="${lastStyle}">${i.last_sold || 'N/A'}</span></td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="color:#9ca3af;padding:24px;text-align:center">No best-seller items found for this category.</td></tr>';

    const stickyTd = 'position:sticky;bottom:0;z-index:2;background:#f8fafc;border-top:2px solid #e5e7eb;font-weight:700;box-shadow:0 -2px 4px rgba(0,0,0,0.06)';
    const tot12mo  = list.reduce((s, i) => s + (i.qty_12mo || 0), 0);
    const bsTotRow = list.length ? `<tr>
      <td colspan="4" style="${stickyTd};padding:10px 10px;color:#1a2332">TOTAL</td>
      <td class="num-ctr" style="${stickyTd};padding:10px 10px;font-weight:800;color:#1a2332">${tot12mo || '—'}</td>
      <td style="${stickyTd};padding:10px 10px"></td>
    </tr>` : '';

    tableHTML = `<table class="data-table">
      <thead style="position:sticky;top:0;z-index:2;background:#3d5a80"><tr>
        ${th('rank',        '#',             'num-ctr')}
        ${th('status',      'Stat',          'num-ctr')}
        ${th('itemNo',      'Item #',        'num-ctr')}
        ${th('description', 'Description')}
        ${th('qty_12mo',    '12 MO Qty',     'num-ctr')}
        ${th('last_sold',   'Last Purchase', 'num-ctr')}
      </tr></thead>
      <tbody>${rows}</tbody>
      ${bsTotRow ? `<tfoot style="position:sticky;bottom:0;z-index:2">${bsTotRow}</tfoot>` : ''}
    </table>`;
  }

  const btnBase = 'padding:5px 12px;border:none;font-weight:600;font-size:12px;cursor:pointer;font-family:inherit;transition:background 0.12s';
  const btnYtd  = `${btnBase};background:${tab==='ytd'?'#3d5a80':'#f8fafc'};color:${tab==='ytd'?'#fff':'#6b7280'}`;
  const btnBest = `${btnBase};border-left:1px solid #d1d5db;background:${tab==='best'?'#3d5a80':'#f8fafc'};color:${tab==='best'?'#fff':'#6b7280'}`;

  // Title bar goes into the card (non-scrolling); table goes into the scroll container.
  // This lets thead top:0 and tfoot bottom:0 work without any offset arithmetic.
  const card = document.getElementById('ca-drill-card');
  let titleBar = card && card.querySelector('#ca-drill-titlebar');
  if (!titleBar && card) {
    titleBar = document.createElement('div');
    titleBar.id = 'ca-drill-titlebar';
    titleBar.style.cssText = 'flex-shrink:0;border-bottom:1px solid #f3f4f6;background:#fff';
    card.insertBefore(titleBar, sec);
  }
  if (titleBar) {
    titleBar.innerHTML = `
      <div style="padding:10px 14px 8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:#3d5a80">${category}</span>
        <div style="margin-left:auto;display:inline-flex;border:1px solid #d1d5db;border-radius:8px;overflow:hidden">
          <button onclick="caDrillSwapTab('ytd')" style="${btnYtd}">YTD Purchased (${ytdItems.length})</button>
          <button onclick="caDrillSwapTab('best')" style="${btnBest}">Best Sellers (${topItems.length})</button>
        </div>
      </div>`;
  }

  sec.innerHTML = `<div class="inv-wrap" style="margin:0;overflow:visible">${tableHTML}</div>`;
}

function caDrillSortBy(col) {
  caDrillSort.dir = caDrillSort.col === col ? (caDrillSort.dir === 'asc' ? 'desc' : 'asc') : 'asc';
  caDrillSort.col = col;
  renderItemDrill();
}

function caDrillSwapTab(newTab) {
  if (!caDrill) return;
  caDrill.tab = newTab;
  caDrillSort = { col: newTab === 'ytd' ? 'current_qty' : 'rank', dir: newTab === 'ytd' ? 'desc' : 'asc' };
  renderItemDrill();
}

// ── AI Chat ───────────────────────────────────────────────────

async function startAIConversation(cust, catData, mtd) {
  if (caAiCtrl) { caAiCtrl.abort(); caAiCtrl = null; }
  caConversation = [];
  const msgs = document.getElementById('ca-ai-messages');
  const opts = document.getElementById('ca-ai-options');
  const inp  = document.getElementById('ca-ai-input');
  if (msgs) msgs.innerHTML = '';
  if (opts) { opts.innerHTML = ''; opts.style.display = 'none'; }
  if (inp)  inp.value = '';

  const orders  = window.caLastOrders || [];
  const custNo  = cust.custNo || caCustNo;
  let itemData  = { topItems: {}, missedItems: [] };

  const topCatCodes = [...(catData || [])]
    .filter(c => c.currentYtdAmt > 0)
    .sort((a, b) => b.currentYtdAmt - a.currentYtdAmt)
    .slice(0, 3).map(c => c.categoryCode);

  if (topCatCodes.length && custNo) {
    try {
      const enc     = encodeURIComponent(custNo);
      const results = await Promise.all(
        topCatCodes.map(cat =>
          fetch(`/proxy/ytd-items/${enc}/${encodeURIComponent(cat)}`)
            .then(r => r.ok ? r.json() : []).catch(() => [])
        )
      );
      for (let i = 0; i < topCatCodes.length; i++) {
        const cat   = topCatCodes[i];
        const items = results[i] || [];
        itemData.topItems[cat] = items.filter(it => it.current_qty > 0).slice(0, 5);
        const missed = items
          .filter(it => it.current_qty === 0 && it.prior_qty > 0)
          .map(it => ({ itemNo: it.itemNo, description: it.description, category: cat, qty_full_prior_year: it.prior_qty, last_bought_date: it.last_sold || null }));
        itemData.missedItems.push(...missed);
      }
      itemData.missedItems.sort((a, b) => b.qty_full_prior_year - a.qty_full_prior_year);
      itemData.missedItems = itemData.missedItems.slice(0, 10);
    } catch (_) {}
  }

  const context = buildPromptContext(cust, catData, mtd, orders, itemData);
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
    const DEFAULT_CATS = 'CANDY,BALLOONS,GIFTS,PLUSH,TOYS';
    const topCats = (window.caLastCatData || [])
      .filter(c => c.categoryCode)
      .sort((a, b) => b.currentYtdAmt - a.currentYtdAmt)
      .slice(0, 5)
      .map(c => c.categoryCode)
      .join(',') || DEFAULT_CATS;

    const resp  = await fetch(`/proxy/recommended-items?categories=${encodeURIComponent(topCats)}`);
    const items = resp.ok ? await resp.json() : [];

    if (!items.length) {
      body.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280">No item data found for this account.</div>';
      return;
    }

    // Build table
    const th = (label, align = 'left') =>
      `<th style="padding:9px 12px;text-align:${align};font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap">${label}</th>`;
    const rows = items.map((item, i) => {
      const slug  = toKellisSlug(item.description);
      const url   = `https://www.kellisgifts.com/${slug}/`;
      const bg = i % 2 === 0 ? '' : 'background:#f8f9fb';
      return `<tr style="${bg}">
        <td style="padding:9px 12px;font-size:12px;color:#6b7280;white-space:nowrap">${item.category || '—'}</td>
        <td style="padding:9px 12px;font-size:13px;color:#374151;font-weight:500">
          <a href="${url}" target="_blank" style="color:#0d9488;text-decoration:none;font-weight:600" title="View on Kellis">${item.description}</a>
        </td>
        <td style="padding:9px 12px;font-family:monospace;font-size:12px;color:#6b7280;white-space:nowrap">${item.itemNo}</td>
        <td style="padding:9px 12px;font-family:monospace;font-size:12px;color:#6b7280">${item.upc || '—'}</td>
      </tr>`;
    }).join('');

    body.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-family:inherit">
        <thead>
          <tr style="background:#f1f5f9;border-bottom:2px solid #e5e7eb">
            ${th('Category')}
            ${th('Item Name')}
            ${th('Item #')}
            ${th('UPC')}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

    // Build mailto body (plain text — URLs auto-link in Outlook)
    const emailLines = items.map((item, i) => {
      const slug = toKellisSlug(item.description);
      const url  = `https://www.kellisgifts.com/${slug}/`;
      return `${i + 1}. [${item.itemNo}] ${item.description}\n   ${url}\n   UPC: ${item.upc || 'N/A'}`;
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

function buildOrderHistory(orders) {
  if (!orders.length) return '<div style="padding:16px;color:#9ca3af;font-size:14px">No order history found.</div>';

  const sorted = [...orders].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5);

  const fmtDate = iso => {
    if (!iso) return '—';
    const d = iso.slice(0, 10);
    return d.slice(5, 7) + '-' + d.slice(8, 10) + '-' + d.slice(0, 4);
  };

  const rows = sorted.map(o => {
    const date    = fmtDate(o.date);
    const amt     = fmt$(parseFloat(o.amount || 0));
    const items   = o.itemCount ? `${o.itemCount}` : '—';
    const tktEsc  = (o.ticketNo || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    const custEsc = (caCustNo || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,"\\'");
    const tktJs   = (o.ticketNo || '').replace(/'/g,"\\'");
    return `<tr class="order-hdr-row"
      onclick="loadOrderDetail('${custEsc}','${tktJs}')"
      style="cursor:pointer;transition:background 0.12s"
      onmouseover="this.style.background='#f0f4f8'" onmouseout="this.style.background=''">
      <td style="font-size:13px;color:#6b7280;text-align:center">${date}</td>
      <td style="font-family:monospace;font-size:12px;color:#3d5a80;font-weight:600;text-align:center">${tktEsc}</td>
      <td style="font-size:13px;text-align:center">${items}</td>
      <td class="num-ctr" style="font-weight:600;text-align:center">${amt}</td>
      <td style="font-size:12px;color:#9ca3af;text-align:center;padding-right:12px">View →</td>
    </tr>`;
  }).join('');

  return `<div class="inv-wrap" style="max-height:500px;overflow-y:auto;border-top:1px solid #f3f4f6">
    <table class="data-table" id="ca-orders-table">
      <thead><tr>
        <th style="text-align:center">Date</th>
        <th style="text-align:center">Ticket #</th>
        <th style="text-align:center">Lines</th>
        <th class="num-ctr">Total</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
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

// ── Activity Log ─────────────────────────────────────────────

const ACTIVITY_KEY = cn => `ks_activity_${cn}`;

function activityLogOpen(custNo) {
  const overlay = document.getElementById('activity-modal-overlay');
  if (!overlay) return;
  document.getElementById('activity-cust-no').value = custNo;
  document.getElementById('activity-type').value    = 'Call';
  document.getElementById('activity-duration').value = '';
  document.getElementById('activity-notes').value    = '';
  activityToggleDuration();
  overlay.style.display = 'flex';
  document.getElementById('activity-type').focus();
}

function activityLogClose() {
  const overlay = document.getElementById('activity-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

function activityToggleDuration() {
  const type = (document.getElementById('activity-type') || {}).value;
  const row  = document.getElementById('activity-duration-row');
  if (row) row.style.display = (type === 'Call' || type === 'Visit') ? 'block' : 'none';
}

function activityLogSave() {
  const custNo   = (document.getElementById('activity-cust-no')  || {}).value || '';
  const type     = (document.getElementById('activity-type')      || {}).value || 'Other';
  const duration = parseInt((document.getElementById('activity-duration') || {}).value) || null;
  const notes    = ((document.getElementById('activity-notes') || {}).value || '').trim();
  if (!custNo) return;

  const now      = new Date();
  const entry = {
    id:       now.getTime(),
    date:     now.toISOString().slice(0, 10),
    time:     now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    type,
    duration: (type === 'Call' || type === 'Visit') ? duration : null,
    notes,
  };

  const log = JSON.parse(localStorage.getItem(ACTIVITY_KEY(custNo)) || '[]');
  log.unshift(entry); // most recent first
  localStorage.setItem(ACTIVITY_KEY(custNo), JSON.stringify(log));

  activityLogClose();
  const listEl = document.getElementById('ca-activity-list');
  if (listEl) listEl.innerHTML = buildActivityList(custNo);
}

function activityLogDelete(custNo, id) {
  const log = JSON.parse(localStorage.getItem(ACTIVITY_KEY(custNo)) || '[]');
  const updated = log.filter(e => e.id !== id);
  localStorage.setItem(ACTIVITY_KEY(custNo), JSON.stringify(updated));
  const listEl = document.getElementById('ca-activity-list');
  if (listEl) listEl.innerHTML = buildActivityList(custNo);
}

function buildActivityList(custNo) {
  const log = JSON.parse(localStorage.getItem(ACTIVITY_KEY(custNo)) || '[]');
  if (!log.length) return '<div style="font-size:13px;color:#9ca3af;padding:4px 0">No activity logged yet.</div>';

  const typeIcon = { Call: '📞', Email: '✉️', Visit: '🤝', Other: '📝' };
  const typeColor = { Call: '#3d5a80', Email: '#0d9488', Visit: '#059669', Other: '#6b7280' };

  return `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:4px">
    <thead>
      <tr style="border-bottom:1px solid #e5e7eb;color:#9ca3af;font-size:11px;font-weight:600;text-transform:uppercase">
        <th style="padding:6px 8px;text-align:left">Date</th>
        <th style="padding:6px 8px;text-align:left">Time</th>
        <th style="padding:6px 8px;text-align:left">Type</th>
        <th style="padding:6px 8px;text-align:left">Duration</th>
        <th style="padding:6px 8px;text-align:left">Notes</th>
        <th style="padding:6px 8px;text-align:center;width:28px"></th>
      </tr>
    </thead>
    <tbody>
      ${log.map(e => `
        <tr style="border-bottom:1px solid #f3f4f6">
          <td style="padding:7px 8px;color:#374151;white-space:nowrap">${e.date}</td>
          <td style="padding:7px 8px;color:#6b7280;white-space:nowrap">${e.time || '—'}</td>
          <td style="padding:7px 8px;white-space:nowrap">
            <span style="display:inline-flex;align-items:center;gap:4px;background:${typeColor[e.type] || '#6b7280'}18;color:${typeColor[e.type] || '#6b7280'};border-radius:4px;padding:2px 8px;font-weight:600;font-size:12px">
              ${typeIcon[e.type] || '📝'} ${e.type}
            </span>
          </td>
          <td style="padding:7px 8px;color:#6b7280">${e.duration != null ? e.duration + ' min' : '—'}</td>
          <td style="padding:7px 8px;color:#374151;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(e.notes || '').replace(/"/g,'&quot;')}">${e.notes || '—'}</td>
          <td style="padding:7px 8px;text-align:center">
            <button onclick="activityLogDelete('${custNo}',${e.id})"
              style="background:none;border:none;cursor:pointer;color:#d1d5db;font-size:14px;padding:2px 4px;line-height:1;border-radius:3px" title="Delete">✕</button>
          </td>
        </tr>`).join('')}
    </tbody>
  </table>`;
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

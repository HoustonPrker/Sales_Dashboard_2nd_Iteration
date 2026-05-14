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
let acctFilters    = {};     // { colId → Set | string | {min,max} }
let acctFilterOpenId    = null;
let acctFilterDebounce  = null;

// Territory AI state
let acctAiCtrl         = null; // AbortController for in-flight stream
let acctAiConversation = [];   // [{role,content}] chat history

// ── Column layout system ──────────────────────────────────────

const ACCT_COL_DEFS = {
  name:           { id: 'name',           label: 'Customer Name',   sortKey: 'name',           cls: '',        tip: '<strong>Customer Name</strong><br>Legal business name as recorded in NCR.' },
  custNo:         { id: 'custNo',         label: 'Acct #',     sortKey: 'custNo',         cls: 'num-ctr', tip: '<strong>Account Number</strong><br>NCR customer ID used to look up order history.' },
  state:          { id: 'state',          label: 'State',           sortKey: 'state',          cls: 'num-ctr', tip: '<strong>State</strong><br>Billing state on the customer record.' },
  tier:           { id: 'tier',           label: 'Annual Health',   sortKey: 'tier',           cls: 'num-ctr', tip: '<strong>Annual Health</strong><br>Based on YTD pace vs prior year and order recency (annual view).<br><strong>Critical:</strong> YTD down 50%+ vs PY or no order in 90+ days<br><strong>At Risk:</strong> significantly behind annual pace or no order in 60+ days<br><strong>Attention:</strong> moderately behind annual pace<br><strong>Healthy:</strong> on or ahead of prior year pace' },
  monthTier:      { id: 'monthTier',      label: 'Monthly Health',  sortKey: 'monthTier',      cls: 'num-ctr', tip: '<strong>Monthly Health</strong><br>Based on MTD sales vs expected monthly pace (Monthly Goal × % of month elapsed).<br><strong>Critical:</strong> MTD far below expected pace<br><strong>At Risk:</strong> MTD well below expected pace<br><strong>Attention:</strong> MTD slightly behind expected pace<br><strong>Healthy:</strong> MTD on or ahead of expected monthly pace' },
  ytdSales:       { id: 'ytdSales',       label: 'YTD Sales',    sortKey: 'ytdSales',       cls: 'num-ctr', tip: '<strong>Current Year YTD Sales</strong><br>Sum of all ticket totals from Jan 1 of the current year through today.' },
  mtdSales:       { id: 'mtdSales',       label: 'MTD Sales',       sortKey: 'mtdSales',       cls: 'num-ctr', tip: '<strong>Month-to-Date Sales</strong><br>Sum of ticket totals from the 1st of the current month through today.' },
  priorYtd:       { id: 'priorYtd',       label: 'Prior YTD',       sortKey: 'priorYtd',       cls: 'num-ctr', tip: '<strong>Prior Year YTD Sales</strong><br>Sum of ticket totals for the same Jan 1 – today window one year ago.' },
  priorMtd:       { id: 'priorMtd',       label: 'Prior MTD',       sortKey: 'priorMtd',       cls: 'num-ctr', tip: '<strong>Prior Year MTD Sales</strong><br>Sales for the same month, same number of days, one year ago.' },
  priorMonth:     { id: 'priorMonth',     label: 'Prior Month',     sortKey: 'priorMonth',     cls: 'num-ctr', tip: '<strong>Prior Full Month Sales</strong><br>Complete prior-year same-calendar-month total (Jan–Dec last year).' },
  pctToTarget:    { id: 'pctToTarget',    label: 'YTD Pace %',      sortKey: 'pctToTarget',    cls: 'num-ctr', tip: '<strong>YTD Pace %</strong><br>Formula: CY YTD Sales ÷ Prior YTD Sales<br>100% = exactly matching last year\'s pace. Above 100% = ahead of prior year.' },
  target:         { id: 'target',         label: 'Prior YTD',       sortKey: 'target',         cls: 'num-ctr', tip: '<strong>Prior Year YTD Sales</strong><br>Sales for the same Jan 1 – today window one year ago. Used as the YTD Pace % denominator.' },
  pctChange:      { id: 'pctChange',      label: 'YoY Growth',      sortKey: 'pctChange',      cls: 'num-ctr', tip: '<strong>Year-over-Year Growth</strong><br>Formula: (CY YTD − Prior YTD) ÷ Prior YTD<br>Positive = growing vs same period last year.' },
  bsPct:          { id: 'bsPct',          label: 'Best Seller %',   sortKey: 'bsPct',          cls: 'num-ctr', tip: '<strong>Best Seller %</strong><br>Formula: Best Seller lines ÷ Total lines (YTD)<br>Items flagged in NCR with profCod1 = Y.' },
  daysSince:      { id: 'daysSince',      label: 'Days Since Order',sortKey: 'daysSince',      cls: 'num-ctr', tip: '<strong>Days Since Last Order</strong><br>Calendar days from the customer\'s most recent order date to today.' },
  lastOrder:      { id: 'lastOrder',      label: 'Last Order Date', sortKey: 'lastOrder',      cls: 'num-ctr', tip: '<strong>Last Order Date</strong><br>Date of the most recent ticket in NCR for this customer.' },
  // Hidden by default — available via Column Chooser
  category:       { id: 'category',       label: 'Category',        sortKey: 'category',       cls: 'num-ctr', tip: '<strong>Category</strong><br>Customer type code from NCR (e.g. UNIV, HOTEL, HOSP, CASINO).' },
  termsCode:      { id: 'termsCode',      label: 'Terms',           sortKey: 'termsCode',      cls: 'num-ctr', tip: '<strong>Terms Code</strong><br>Payment terms assigned to this account (e.g. N30, COD).' },
  email:          { id: 'email',          label: 'Email',           sortKey: 'email',          cls: '',        tip: '<strong>Email</strong><br>Primary email address on the customer record.' },
  phone:          { id: 'phone',          label: 'Phone',           sortKey: 'phone',          cls: 'num-ctr', tip: '<strong>Phone</strong><br>Primary phone number on the customer record.' },
  discount:       { id: 'discount',       label: 'Discount %',      sortKey: 'discount',       cls: 'num-ctr', tip: '<strong>Discount %</strong><br>Customer-level discount percentage applied to orders.' },
  monthGoal:      { id: 'monthGoal',      label: 'Monthly Goal',     sortKey: 'monthGoal',      cls: 'num-ctr', tip: '<strong>Monthly Goal</strong><br>Prior-year same-month sales × 1.05 for this individual account.' },
  annualGoal:     { id: 'annualGoal',     label: 'Annual Goal',      sortKey: 'annualGoal',     cls: 'num-ctr', tip: '<strong>Annual Goal</strong><br>Prior full-year sales × 1.05. The target this account needs to hit by Dec 31.' },
  pctToMonthGoal: { id: 'pctToMonthGoal', label: 'MTD vs Goal %',    sortKey: 'pctToMonthGoal', cls: 'num-ctr', tip: '<strong>MTD vs Monthly Goal %</strong><br>Formula: MTD Sales ÷ Monthly Goal<br>Monthly Goal = prior-year same-month sales × 1.05.' },
  pctToAnnualGoal:{ id: 'pctToAnnualGoal',label: '% to Annual Goal', sortKey: 'pctToAnnualGoal',cls: 'num-ctr', tip: '<strong>% to Annual Goal</strong><br>Formula: YTD Sales ÷ Annual Goal<br>Shows overall progress toward the full-year target (not pace-adjusted).' },
  monthRunRate:   { id: 'monthRunRate',   label: 'Month Run Rate',   sortKey: 'monthRunRate',   cls: 'num-ctr', tip: '<strong>Month Run Rate</strong><br>MTD Sales projected to end of month based on business days elapsed (weekdays, no holidays).' },
  annualRunRate:  { id: 'annualRunRate',  label: 'Annual Run Rate',  sortKey: 'annualRunRate',  cls: 'num-ctr', tip: '<strong>Annual Run Rate</strong><br>YTD Sales projected to end of year based on business days elapsed (weekdays, no holidays).' },
  pyFullYear:     { id: 'pyFullYear',     label: 'Annual Goal Basis',sortKey: 'pyFullYear',     cls: 'num-ctr', tip: '<strong>Annual Goal Basis</strong><br>Full prior calendar year sales (Jan 1 – Dec 31 last year). Multiply by 1.05 to get this account\'s annual goal.' },
};

const ACCT_DEFAULT_LAYOUT = {
  name: 'Default',
  columns: [
    // Visible by default — in requested order
    { id: 'custNo',          visible: true,  order: 0  },
    { id: 'name',            visible: true,  order: 1  },
    { id: 'tier',            visible: true,  order: 2  },
    { id: 'monthTier',       visible: true,  order: 3  },
    { id: 'category',        visible: true,  order: 4  },
    { id: 'state',           visible: true,  order: 5  },
    { id: 'annualGoal',      visible: true,  order: 6  },
    { id: 'ytdSales',        visible: true,  order: 7  },
    { id: 'pctToAnnualGoal', visible: true,  order: 8  },
    { id: 'monthGoal',       visible: true,  order: 9  },
    { id: 'mtdSales',        visible: true,  order: 10 },
    { id: 'pctToMonthGoal',  visible: true,  order: 11 },
    { id: 'priorMonth',      visible: true,  order: 12 },
    { id: 'daysSince',       visible: true,  order: 13 },
    { id: 'lastOrder',       visible: true,  order: 14 },
    { id: 'bsPct',           visible: true,  order: 15 },
    { id: 'discount',        visible: true,  order: 16 },
    { id: 'email',           visible: true,  order: 17 },
    // Hidden by default
    { id: 'priorYtd',        visible: false, order: 18 },
    { id: 'priorMtd',        visible: false, order: 19 },
    { id: 'pctToTarget',     visible: false, order: 20 },
    { id: 'target',          visible: false, order: 21 },
    { id: 'pctChange',       visible: false, order: 22 },
    { id: 'termsCode',       visible: false, order: 23 },
    { id: 'phone',           visible: false, order: 24 },
    { id: 'monthRunRate',    visible: false, order: 25 },
    { id: 'annualRunRate',   visible: false, order: 26 },
    { id: 'pyFullYear',      visible: false, order: 27 },
  ]
};

// TODO: future migration — when real auth lands, swap localStorage for
// backend storage keyed by user email. Caller interface stays the same.
const layoutStore = {
  _key:       'kellis_account_layouts',
  _activeKey: 'kellis_account_active_layout',
  getSavedLayouts()         { try { return JSON.parse(localStorage.getItem(this._key) || '[]'); } catch (_) { return []; } },
  saveLayout(layout)        { const ll = this.getSavedLayouts().filter(l => l.name !== layout.name); if (ll.length >= 20) ll.shift(); ll.push(layout); localStorage.setItem(this._key, JSON.stringify(ll)); },
  deleteLayout(name)        { localStorage.setItem(this._key, JSON.stringify(this.getSavedLayouts().filter(l => l.name !== name))); },
  getActiveLayoutName()     { return localStorage.getItem(this._activeKey) || null; },
  setActiveLayoutName(name) { name ? localStorage.setItem(this._activeKey, name) : localStorage.removeItem(this._activeKey); },
};

let acctLayout = null;

function initAcctLayout() {
  if (acctLayout) return;
  const activeName = layoutStore.getActiveLayoutName();
  if (activeName) {
    const saved = layoutStore.getSavedLayouts().find(l => l.name === activeName);
    if (saved) { acctLayout = JSON.parse(JSON.stringify(saved)); return; }
  }
  acctLayout = JSON.parse(JSON.stringify(ACCT_DEFAULT_LAYOUT));
}

function acctVisibleCols() {
  return [...acctLayout.columns]
    .sort((a, b) => a.order - b.order)
    .filter(c => c.visible && ACCT_COL_DEFS[c.id])
    .map(c => ACCT_COL_DEFS[c.id]);
}

// ── Per-cell renderers ────────────────────────────────────────

function renderAcctTd(colId, a) {
  switch (colId) {
    case 'name': {
      const pinBg = a.tier === 'Critical' ? '#fff5f5' : a.tier === 'AtRisk' ? '#fff8f0' : '#fff';
      return `<td class="acct-pin-col" data-col-id="name" style="background:${pinBg}"><a class="acct-name-link" onclick="openCustomerAccount('${a.custNo}')">${a.name || '—'}</a></td>`;
    }
    case 'custNo':
      return `<td class="num-ctr" style="font-family:monospace;font-size:12px;font-weight:600;color:#3d5a80">${a.custNo}</td>`;
    case 'state':
      return `<td class="num-ctr">${a.state || '—'}</td>`;
    case 'tier': {
      const tierKey   = a.tier;
      const tierCls   = `tier-${tierKey.toLowerCase()}`;
      const tierLabel = tierKey.replace('AtRisk', 'At Risk');
      const hsAttr    = a.healthSignals ? ` data-hs='${JSON.stringify(a.healthSignals).replace(/'/g, '&#39;')}'` : '';
      return `<td class="num-ctr"><span class="tier-badge ${tierCls}"${hsAttr}>${tierLabel}</span></td>`;
    }
    case 'monthTier': {
      const mk  = a.monthTier || 'Healthy';
      const mcls = `tier-${mk.toLowerCase()}`;
      return `<td class="num-ctr"><span class="tier-badge ${mcls}">${mk.replace('AtRisk','At Risk')}</span></td>`;
    }
    case 'ytdSales':       return `<td class="num-ctr">${fmt$(a.ytdSales)}</td>`;
    case 'mtdSales':       return `<td class="num-ctr">${a.mtdSales > 0 ? fmt$(a.mtdSales) : '—'}</td>`;
    case 'priorYtd':       return `<td class="num-ctr">${a.priorYtd > 0 ? fmt$(a.priorYtd) : '—'}</td>`;
    case 'priorMtd':       return `<td class="num-ctr">${a.priorMtd > 0 ? fmt$(a.priorMtd) : '—'}</td>`;
    case 'priorMonth':     return `<td class="num-ctr">${a.priorMonth > 0 ? fmt$(a.priorMonth) : '—'}</td>`;
    case 'target':         return `<td class="num-ctr">${a.target > 0 ? fmt$(a.target) : '—'}</td>`;
    case 'pctToTarget': {
      const pct = a.target > 0 ? (a.pctToTarget * 100).toFixed(1) + '%' : '—';
      return `<td class="num-ctr">${pct}</td>`;
    }
    case 'pctToMonthGoal': {
      const pct = a.monthGoal > 0 ? (a.pctToMonthGoal * 100).toFixed(1) + '%' : '—';
      return `<td class="num-ctr">${pct}</td>`;
    }
    case 'annualGoal':      return `<td class="num-ctr">${a.annualGoal > 0 ? fmt$(a.annualGoal) : '—'}</td>`;
    case 'pctToAnnualGoal': {
      const pct = a.annualGoal > 0 ? (a.pctToAnnualGoal * 100).toFixed(1) + '%' : '—';
      return `<td class="num-ctr">${pct}</td>`;
    }
    case 'monthRunRate':    return `<td class="num-ctr">${a.monthRunRate > 0 ? fmt$(a.monthRunRate) : '—'}</td>`;
    case 'annualRunRate':   return `<td class="num-ctr">${a.annualRunRate > 0 ? fmt$(a.annualRunRate) : '—'}</td>`;
    case 'pctChange': {
      const v     = a.priorYtd > 0 ? ((a.ytdSales - a.priorYtd) / a.priorYtd * 100).toFixed(1) : null;
      const cls   = v !== null ? (parseFloat(v) >= 0 ? 'vel-up' : 'vel-down') : '';
      const arrow = v !== null ? (parseFloat(v) >= 0 ? '↑' : '↓') : '';
      return `<td class="num-ctr"><span class="${cls}">${arrow}</span>${v !== null ? ' ' + v + '%' : '—'}</td>`;
    }
    case 'bsPct':       return `<td class="num-ctr">${a.totalUnits > 0 ? (a.bsPct * 100).toFixed(1) + '%' : '—'}</td>`;
    case 'daysSince': {
      const cls = a.daysSinceOrder >= 60 ? 'vel-down' : a.daysSinceOrder >= 30 ? 'vel-ss' : '';
      const str = a.daysSinceOrder >= 999 ? '—' : a.daysSinceOrder + 'd';
      return `<td class="num-ctr"><span class="${cls}">${str}</span></td>`;
    }
    case 'lastOrder': {
      const d = a.lastOrderDate;
      return `<td class="num-ctr">${d ? d.slice(5,7) + '-' + d.slice(8,10) + '-' + d.slice(0,4) : '—'}</td>`;
    }
    case 'category':    return `<td class="num-ctr">${a.category || '—'}</td>`;
    case 'termsCode':   return `<td class="num-ctr">${a.termsCode || '—'}</td>`;
    case 'email':       return `<td style="font-size:12px">${a.email ? `<a href="mailto:${a.email}" style="color:#3d5a80">${a.email}</a>` : '—'}</td>`;
    case 'phone':       return `<td class="num-ctr">${a.phone || '—'}</td>`;
    case 'discount':    return `<td class="num-ctr">${a.discount > 0 ? a.discount.toFixed(1) + '%' : '—'}</td>`;
    case 'monthGoal':   return `<td class="num-ctr">${a.monthGoal > 0 ? fmt$(a.monthGoal) : '—'}</td>`;
    case 'pyFullYear':  return `<td class="num-ctr">${a.pyFullYear > 0 ? fmt$(a.pyFullYear) : '—'}</td>`;
    default:            return '<td>—</td>';
  }
}

function renderAcctTotalsCell(colId, t) {
  switch (colId) {
    case 'name':
      return `<td class="acct-pin-col" data-col-id="name" style="text-align:left;font-size:12px;opacity:0.75;font-weight:600;background:#dde4ee">${t.label}</td>`;
    case 'ytdSales':       return `<td class="num-ctr">${fmt$(t.ytd)}</td>`;
    case 'mtdSales':       return `<td class="num-ctr">${t.mtd > 0 ? fmt$(t.mtd) : '—'}</td>`;
    case 'priorYtd':       return `<td class="num-ctr">${t.priorYtd > 0 ? fmt$(t.priorYtd) : '—'}</td>`;
    case 'priorMtd':       return `<td class="num-ctr">${t.priorMtd > 0 ? fmt$(t.priorMtd) : '—'}</td>`;
    case 'priorMonth':     return `<td class="num-ctr">${t.priorMonth > 0 ? fmt$(t.priorMonth) : '—'}</td>`;
    case 'target':         return `<td class="num-ctr">${t.target > 0 ? fmt$(t.target) : '—'}</td>`;
    case 'pctToTarget': {
      const v = t.target > 0 ? (t.ytd / t.target * 100).toFixed(1) + '%' : '—';
      return `<td class="num-ctr">${v}</td>`;
    }
    case 'pctToMonthGoal': {
      const v = t.monthGoal > 0 ? (t.mtd / t.monthGoal * 100).toFixed(1) + '%' : '—';
      return `<td class="num-ctr">${v}</td>`;
    }
    case 'pctChange': {
      const v     = t.priorYtd > 0 ? ((t.ytd - t.priorYtd) / t.priorYtd * 100).toFixed(1) : null;
      const cls   = v !== null ? (parseFloat(v) >= 0 ? 'vel-up' : 'vel-down') : '';
      const arrow = v !== null ? (parseFloat(v) >= 0 ? '↑' : '↓') : '';
      return `<td class="num-ctr"><span class="${cls}">${arrow}</span>${v !== null ? ' ' + v + '%' : '—'}</td>`;
    }
    case 'bsPct':       return `<td class="num-ctr">${t.allUnits > 0 ? (t.bsUnits / t.allUnits * 100).toFixed(1) + '%' : '—'}</td>`;
    case 'monthGoal':      return `<td class="num-ctr">${t.monthGoal > 0 ? fmt$(t.monthGoal) : '—'}</td>`;
    case 'annualGoal':     return `<td class="num-ctr">${t.annualGoal > 0 ? fmt$(t.annualGoal) : '—'}</td>`;
    case 'pctToAnnualGoal': {
      const v = t.annualGoal > 0 ? (t.ytd / t.annualGoal * 100).toFixed(1) + '%' : '—';
      return `<td class="num-ctr">${v}</td>`;
    }
    case 'monthRunRate':   return `<td class="num-ctr">${t.monthRunRate > 0 ? fmt$(t.monthRunRate) : '—'}</td>`;
    case 'annualRunRate':  return `<td class="num-ctr">${t.annualRunRate > 0 ? fmt$(t.annualRunRate) : '—'}</td>`;
    case 'pyFullYear':     return `<td class="num-ctr">${t.pyFullYear > 0 ? fmt$(t.pyFullYear) : '—'}</td>`;
    default:               return '<td></td>';
  }
}

// ── Column filter system ─────────────────────────────────────

const ACCT_FILTER_TYPES = {
  name: 'text', custNo: 'text', lastOrder: 'text',
  category: 'text', termsCode: 'text', email: 'text', phone: 'text',
  state: 'checklist', tier: 'checklist', monthTier: 'checklist',
  ytdSales: 'range', mtdSales: 'range', target: 'range', pctToTarget: 'range',
  priorYtd: 'range', priorMtd: 'range', priorMonth: 'range', pctToMonthGoal: 'range',
  pctChange: 'range', bsPct: 'range', daysSince: 'range',
  discount: 'range', monthGoal: 'range', annualGoal: 'range',
  pctToMonthGoal: 'range', pctToAnnualGoal: 'range',
  monthRunRate: 'range', annualRunRate: 'range', pyFullYear: 'range',
};

function acctFilterActive(colId) {
  const f = acctFilters[colId];
  if (!f) return false;
  if (f instanceof Set) return f.size > 0;
  if (typeof f === 'object') return f.min != null || f.max != null;
  return !!f;
}

function applyAcctFilters(list) {
  return list.filter(a => {
    for (const [colId, filter] of Object.entries(acctFilters)) {
      if (!acctFilterActive(colId)) continue;
      switch (colId) {
        case 'tier':      if (!filter.has(a.tier))            return false; break;
        case 'monthTier': if (!filter.has(a.monthTier||'Healthy')) return false; break;
        case 'state':     if (!filter.has(a.state || ''))     return false; break;
        case 'name':      if (!(a.name       || '').toLowerCase().includes(filter.toLowerCase())) return false; break;
        case 'custNo':    if (!(a.custNo     || '').toLowerCase().includes(filter.toLowerCase())) return false; break;
        case 'category':  if (!(a.category   || '').toLowerCase().includes(filter.toLowerCase())) return false; break;
        case 'termsCode': if (!(a.termsCode  || '').toLowerCase().includes(filter.toLowerCase())) return false; break;
        case 'email':     if (!(a.email      || '').toLowerCase().includes(filter.toLowerCase())) return false; break;
        case 'phone':     if (!(a.phone      || '').toLowerCase().includes(filter.toLowerCase())) return false; break;
        case 'lastOrder': if (!(a.lastOrderDate || '').includes(filter)) return false; break;
        case 'ytdSales':       if (filter.min != null && a.ytdSales < filter.min) return false;
                               if (filter.max != null && a.ytdSales > filter.max) return false; break;
        case 'mtdSales':       if (filter.min != null && (a.mtdSales||0) < filter.min) return false;
                               if (filter.max != null && (a.mtdSales||0) > filter.max) return false; break;
        case 'target':         if (filter.min != null && a.target < filter.min) return false;
                               if (filter.max != null && a.target > filter.max) return false; break;
        case 'pctToTarget':  { const v = a.pctToTarget * 100;
                               if (filter.min != null && v < filter.min) return false;
                               if (filter.max != null && v > filter.max) return false; break; }
        case 'priorYtd':       if (filter.min != null && a.priorYtd < filter.min) return false;
                               if (filter.max != null && a.priorYtd > filter.max) return false; break;
        case 'priorMtd':       if (filter.min != null && (a.priorMtd||0) < filter.min) return false;
                               if (filter.max != null && (a.priorMtd||0) > filter.max) return false; break;
        case 'priorMonth':     if (filter.min != null && (a.priorMonth||0) < filter.min) return false;
                               if (filter.max != null && (a.priorMonth||0) > filter.max) return false; break;
        case 'pctToMonthGoal': { const v = (a.pctToMonthGoal||0) * 100;
                               if (filter.min != null && v < filter.min) return false;
                               if (filter.max != null && v > filter.max) return false; break; }
        case 'pctChange':    { const v = a.priorYtd > 0 ? (a.ytdSales - a.priorYtd) / a.priorYtd * 100 : null;
                               if (v === null) return false;
                               if (filter.min != null && v < filter.min) return false;
                               if (filter.max != null && v > filter.max) return false; break; }
        case 'bsPct':        { const v = a.bsPct * 100;
                               if (filter.min != null && v < filter.min) return false;
                               if (filter.max != null && v > filter.max) return false; break; }
        case 'daysSince':      if (filter.min != null && a.daysSinceOrder < filter.min) return false;
                               if (filter.max != null && a.daysSinceOrder > filter.max) return false; break;
        case 'monthGoal':      if (filter.min != null && (a.monthGoal||0) < filter.min) return false;
                               if (filter.max != null && (a.monthGoal||0) > filter.max) return false; break;
        case 'annualGoal':     if (filter.min != null && (a.annualGoal||0) < filter.min) return false;
                               if (filter.max != null && (a.annualGoal||0) > filter.max) return false; break;
        case 'pctToAnnualGoal':{ const v = (a.pctToAnnualGoal||0) * 100;
                               if (filter.min != null && v < filter.min) return false;
                               if (filter.max != null && v > filter.max) return false; break; }
        case 'monthRunRate':   if (filter.min != null && (a.monthRunRate||0) < filter.min) return false;
                               if (filter.max != null && (a.monthRunRate||0) > filter.max) return false; break;
        case 'annualRunRate':  if (filter.min != null && (a.annualRunRate||0) < filter.min) return false;
                               if (filter.max != null && (a.annualRunRate||0) > filter.max) return false; break;
        case 'pyFullYear':     if (filter.min != null && (a.pyFullYear||0) < filter.min) return false;
                               if (filter.max != null && (a.pyFullYear||0) > filter.max) return false; break;
        case 'discount':       if (filter.min != null && (a.discount||0) < filter.min) return false;
                               if (filter.max != null && (a.discount||0) > filter.max) return false; break;
      }
    }
    return true;
  });
}

function showColFilter(colId, event) {
  event.stopPropagation();
  // Toggle: clicking the same button again closes the panel
  if (acctFilterOpenId === colId) { closeColFilter(); return; }
  closeColFilter();
  acctFilterOpenId = colId;
  _mountFilterPanel(colId, event.currentTarget.getBoundingClientRect());
  setTimeout(() => document.addEventListener('mousedown', _onOutsideFilter), 0);
}

function _mountFilterPanel(colId, anchorRect) {
  const type  = ACCT_FILTER_TYPES[colId] || 'text';
  const panel = document.createElement('div');
  panel.id    = 'acct-col-filter-panel';
  panel.className = 'acct-col-filter-panel';
  panel.innerHTML = _buildFilterHTML(colId, type);
  document.body.appendChild(panel);
  const pw   = 230;
  panel.style.left = Math.min(anchorRect.left, window.innerWidth - pw - 8) + 'px';
  panel.style.top  = (anchorRect.bottom + 4) + 'px';
  const inp = panel.querySelector('input:not([type=checkbox])');
  if (inp) { inp.focus(); inp.select && inp.select(); }
}

function _onOutsideFilter(e) {
  const p = document.getElementById('acct-col-filter-panel');
  if (p && p.contains(e.target)) return;
  // Also ignore clicks on the filter buttons themselves (they handle toggle)
  if (e.target.closest('.col-filter-btn')) return;
  closeColFilter();
  document.removeEventListener('mousedown', _onOutsideFilter);
}

function closeColFilter() {
  const p = document.getElementById('acct-col-filter-panel');
  if (p) p.remove();
  acctFilterOpenId = null;
}

function reopenActiveFilter() {
  if (!acctFilterOpenId) return;
  const btn = document.querySelector(`th[data-col-id="${acctFilterOpenId}"] .col-filter-btn`);
  if (!btn) { acctFilterOpenId = null; return; }
  _mountFilterPanel(acctFilterOpenId, btn.getBoundingClientRect());
}

function _buildFilterHTML(colId, type) {
  const def   = ACCT_COL_DEFS[colId] || {};
  const label = def.label || colId;
  let body = '';

  if (type === 'checklist') {
    let options = [];
    if (colId === 'tier' || colId === 'monthTier') {
      options = [
        { value: 'Healthy',   label: 'Healthy',   color: '#059669' },
        { value: 'Attention', label: 'Attention', color: '#eab308' },
        { value: 'AtRisk',    label: 'At Risk',   color: '#ea580c' },
        { value: 'Critical',  label: 'Critical',  color: '#dc2626' },
      ];
    } else if (colId === 'state') {
      const states = [...new Set((accountsData || []).map(a => a.state || '').filter(Boolean))].sort();
      options = states.map(s => ({ value: s, label: s }));
    }
    const currentSet = (acctFilters[colId] instanceof Set) ? acctFilters[colId] : new Set();
    // Unchecked = filtered out; checked = included. If set is empty all are shown (no filter).
    const rows = options.map(opt => {
      const checked = currentSet.size === 0 || currentSet.has(opt.value);
      const dot = opt.color
        ? `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${opt.color};flex-shrink:0"></span>`
        : '';
      return `<label class="acf-check-row">
        <input type="checkbox" value="${opt.value}" ${checked ? 'checked' : ''} onchange="acctChecklistChange('${colId}',this)">
        ${dot}<span>${opt.label}</span>
      </label>`;
    }).join('');
    const allChecked = currentSet.size === 0;
    body = `
      <label class="acf-check-row acf-select-all">
        <input type="checkbox" ${allChecked ? 'checked' : ''} onchange="acctChecklistSelectAll('${colId}',this)">
        <span style="font-weight:600;color:#374151">Select All</span>
      </label>
      <div class="acf-sep"></div>
      <div class="acf-checklist">${rows}</div>`;
  } else if (type === 'text') {
    const cur = typeof acctFilters[colId] === 'string' ? acctFilters[colId] : '';
    body = `<input class="acf-text" type="text" placeholder="Search ${label}…" value="${cur.replace(/"/g,'&quot;')}"
      oninput="acctTextChange('${colId}',this.value)"
      onkeydown="if(event.key==='Enter'||event.key==='Escape')closeColFilter()">`;
  } else {
    // range
    const cur = (acctFilters[colId] && typeof acctFilters[colId] === 'object' && !(acctFilters[colId] instanceof Set))
      ? acctFilters[colId] : {};
    const isPercent = ['pctToTarget','pctToMonthGoal','pctToAnnualGoal','pctChange','bsPct','discount'].includes(colId);
    const isDollar  = ['ytdSales','mtdSales','target','priorYtd','priorMtd','priorMonth','monthGoal','annualGoal','monthRunRate','annualRunRate','pyFullYear'].includes(colId);
    const unit = isPercent ? '%' : colId === 'daysSince' ? 'days' : isDollar ? '$' : '';
    body = `<div class="acf-range">
      <input class="acf-range-inp" type="number" placeholder="Min${unit ? ' '+unit : ''}" value="${cur.min ?? ''}"
        oninput="acctRangeChange('${colId}','min',this.value)">
      <span class="acf-range-dash">—</span>
      <input class="acf-range-inp" type="number" placeholder="Max${unit ? ' '+unit : ''}" value="${cur.max ?? ''}"
        oninput="acctRangeChange('${colId}','max',this.value)">
    </div>`;
  }

  return `
    <div class="acf-header">
      <span class="acf-title">${label}</span>
      <button class="acf-clear" onclick="clearColFilter('${colId}')">Clear</button>
    </div>
    ${body}`;
}

function acctChecklistChange(colId, cb) {
  const panel = document.getElementById('acct-col-filter-panel');
  if (!panel) return;
  const boxes   = [...panel.querySelectorAll('.acf-checklist input[type=checkbox]')];
  const checked = boxes.filter(b => b.checked).map(b => b.value);
  // Update "Select All" checkbox state
  const allBox = panel.querySelector('.acf-select-all input');
  if (allBox) allBox.checked = checked.length === boxes.length;

  if (checked.length === 0 || checked.length === boxes.length) delete acctFilters[colId];
  else acctFilters[colId] = new Set(checked);
  renderAccountsOverview();
  setTimeout(reopenActiveFilter, 0);
}

function acctChecklistSelectAll(colId, cb) {
  const panel = document.getElementById('acct-col-filter-panel');
  if (!panel) return;
  panel.querySelectorAll('.acf-checklist input[type=checkbox]').forEach(b => { b.checked = cb.checked; });
  if (cb.checked) delete acctFilters[colId];
  else acctFilters[colId] = new Set(); // empty set = show nothing
  renderAccountsOverview();
  setTimeout(reopenActiveFilter, 0);
}

function acctTextChange(colId, value) {
  clearTimeout(acctFilterDebounce);
  acctFilterDebounce = setTimeout(() => {
    const v = value.trim();
    if (v) acctFilters[colId] = v; else delete acctFilters[colId];
    renderAccountsOverview();
    // Don't reopen — user is typing in the panel which persists until outside click
  }, 280);
}

function acctRangeChange(colId, side, value) {
  clearTimeout(acctFilterDebounce);
  acctFilterDebounce = setTimeout(() => {
    if (!acctFilters[colId] || acctFilters[colId] instanceof Set) acctFilters[colId] = {};
    const num = parseFloat(value);
    if (!isNaN(num)) acctFilters[colId][side] = num;
    else delete acctFilters[colId][side];
    if (acctFilters[colId].min == null && acctFilters[colId].max == null) delete acctFilters[colId];
    renderAccountsOverview();
  }, 280);
}

function clearColFilter(colId) {
  delete acctFilters[colId];
  closeColFilter();
  renderAccountsOverview();
}

function clearAllAcctFilters() {
  acctFilters = {};
  renderAccountsOverview();
}

// ── Context menu ──────────────────────────────────────────────

function showAcctColMenu(e) {
  e.preventDefault();
  closeAcctColMenu();
  const layouts    = layoutStore.getSavedLayouts();
  const activeName = layoutStore.getActiveLayoutName();
  const vw = window.innerWidth;

  const layoutItems = layouts.length
    ? layouts.map(l => {
        const safe = l.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `<div class="acm-item" onclick="loadAcctLayout('${safe}')">
          <span class="acm-check">${l.name === activeName ? '✓' : ''}</span>${l.name}
          <span class="acm-del" onclick="event.stopPropagation();deleteAcctLayout('${safe}')" title="Delete">✕</span>
        </div>`;
      }).join('')
    : '<div class="acm-disabled">No saved layouts</div>';

  const el = document.createElement('div');
  el.id = 'acct-col-menu';
  el.className = 'acct-col-menu';
  el.innerHTML = `
    <div class="acm-item" onclick="openAcctChooser()">⊞ Column Chooser</div>
    <div class="acm-sep"></div>
    <div class="acm-label">Saved Layouts</div>
    ${layoutItems}
    <div class="acm-sep"></div>
    <div class="acm-item" onclick="saveAcctLayoutPrompt()">💾 Save current layout…</div>
    <div class="acm-item" onclick="resetAcctLayout()">↺ Reset to default</div>`;
  document.body.appendChild(el);
  const menuW = 210;
  el.style.left = (e.clientX + menuW > vw ? e.clientX - menuW : e.clientX) + 'px';
  el.style.top  = e.clientY + 'px';
  // Use 'click' (not 'mousedown') so menu item onclick handlers fire before the menu is removed
  setTimeout(() => document.addEventListener('click', closeAcctColMenu, { once: true }), 0);
}

function closeAcctColMenu() {
  const m = document.getElementById('acct-col-menu');
  if (m) m.remove();
}

// ── Column chooser panel ──────────────────────────────────────

function openAcctChooser() {
  closeAcctColMenu();
  if (document.getElementById('acct-chooser')) return;

  const panel = document.createElement('div');
  panel.id = 'acct-chooser';
  panel.className = 'acct-chooser';
  panel.innerHTML = buildChooserHTML();
  document.body.appendChild(panel);
  requestAnimationFrame(() => panel.classList.add('acct-chooser-open'));
  bindChooserDrag();
}

function _buildChooserRows() {
  const visible = acctLayout.columns.filter(c =>  c.visible).sort((a, b) => a.order - b.order);
  const hidden  = acctLayout.columns.filter(c => !c.visible).sort((a, b) => a.order - b.order);

  const makeRow = c => {
    const def = ACCT_COL_DEFS[c.id];
    if (!def) return '';
    return `<div class="acc-row" data-id="${c.id}" draggable="${c.visible ? 'true' : 'false'}">
      <span class="acc-drag" title="Drag to reorder" style="${c.visible ? '' : 'opacity:0.3;cursor:default'}">⠿</span>
      <label class="acc-label">
        <input type="checkbox" ${c.visible ? 'checked' : ''} onchange="acctChooserToggle('${c.id}',this.checked)">
        ${def.label}
      </label>
    </div>`;
  };

  const hiddenSection = hidden.length
    ? `<div class="acc-section-divider">Hidden columns</div>${hidden.map(makeRow).join('')}`
    : '';

  return visible.map(makeRow).join('') + hiddenSection;
}

function buildChooserHTML() {
  return `
    <div class="acc-header">
      <span style="font-weight:700;font-size:14px;color:#1a2332">Column Chooser</span>
      <button class="acc-close" onclick="closeAcctChooser()">✕</button>
    </div>
    <input class="acc-search" id="acc-search" placeholder="Filter columns…" oninput="acctChooserFilter(this.value)">
    <div class="acc-list" id="acc-list">${_buildChooserRows()}</div>
    <div class="acc-footer">
      <button class="acc-btn acc-btn-secondary" onclick="closeAcctChooser(false)">Close</button>
      <button class="acc-btn acc-btn-primary" onclick="saveAcctLayoutPrompt()">💾 Save Layout</button>
    </div>`;
}

function refreshAcctChooserList() {
  const list = document.getElementById('acc-list');
  if (!list) return;
  list.innerHTML = _buildChooserRows();
  bindChooserDrag();
}

function closeAcctChooser() {
  const el = document.getElementById('acct-chooser');
  if (el) { el.classList.remove('acct-chooser-open'); setTimeout(() => el.remove(), 220); }
}

function acctChooserToggle(id, visible) {
  const col = acctLayout.columns.find(c => c.id === id);
  if (!col) return;
  col.visible = visible;
  renderAccountsOverview();
  refreshAcctChooserList(); // re-sort list: visible first, hidden last
}

function acctChooserFilter(q) {
  const term = q.toLowerCase();
  document.querySelectorAll('#acc-list .acc-row').forEach(row => {
    const lbl = (row.querySelector('.acc-label') || {}).textContent || '';
    row.style.display = lbl.toLowerCase().includes(term) ? '' : 'none';
  });
}

function bindChooserDrag() {
  const list = document.getElementById('acc-list');
  if (!list) return;
  let dragging = null;
  list.addEventListener('dragstart', e => {
    dragging = e.target.closest('.acc-row');
    if (dragging) { dragging.classList.add('acc-dragging'); e.dataTransfer.effectAllowed = 'move'; }
  });
  list.addEventListener('dragover', e => {
    e.preventDefault();
    const target = e.target.closest('.acc-row');
    if (!target || target === dragging) return;
    const after = e.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
    after ? target.after(dragging) : target.before(dragging);
  });
  list.addEventListener('dragend', () => {
    if (dragging) dragging.classList.remove('acc-dragging');
    dragging = null;
    document.querySelectorAll('#acc-list .acc-row').forEach((row, idx) => {
      const col = acctLayout.columns.find(c => c.id === row.dataset.id);
      if (col) col.order = idx;
    });
    renderAccountsOverview();
  });
}

// ── Layout save / load / delete / reset ──────────────────────

function saveAcctLayoutPrompt() {
  closeAcctColMenu();
  const defaultName = acctLayout.name !== 'Default' ? acctLayout.name : 'My Layout';
  const name = prompt('Layout name:', defaultName);
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  const exists  = layoutStore.getSavedLayouts().find(l => l.name === trimmed);
  if (exists && !confirm(`"${trimmed}" already exists. Overwrite?`)) return;
  const layout = { name: trimmed, columns: JSON.parse(JSON.stringify(acctLayout.columns)) };
  layoutStore.saveLayout(layout);
  layoutStore.setActiveLayoutName(trimmed);
  acctLayout.name = trimmed;
  renderAccountsOverview();
}

function loadAcctLayout(name) {
  closeAcctColMenu();
  const layout = layoutStore.getSavedLayouts().find(l => l.name === name);
  if (!layout) return;
  acctLayout = JSON.parse(JSON.stringify(layout));
  layoutStore.setActiveLayoutName(name);
  renderAccountsOverview();
}

function deleteAcctLayout(name) {
  closeAcctColMenu();
  if (!confirm(`Delete layout "${name}"?`)) return;
  layoutStore.deleteLayout(name);
  if (layoutStore.getActiveLayoutName() === name) {
    layoutStore.setActiveLayoutName(null);
    acctLayout = JSON.parse(JSON.stringify(ACCT_DEFAULT_LAYOUT));
  }
  renderAccountsOverview();
}

function resetAcctLayout() {
  closeAcctColMenu();
  acctLayout = JSON.parse(JSON.stringify(ACCT_DEFAULT_LAYOUT));
  layoutStore.setActiveLayoutName(null);
  renderAccountsOverview();
}

// ── Fixed totals bar sync ─────────────────────────────────────

function syncAcctTotalsBar() {
  const bar      = document.getElementById('acct-totals-bar');
  const wrap     = document.querySelector('.acct-grid-wrap');
  const hScroll  = document.querySelector('.acct-h-scroll');
  if (!bar || !wrap) return;

  const rect = wrap.getBoundingClientRect();
  bar.style.left  = rect.left + 'px';
  bar.style.width = rect.width + 'px';

  // Sync each td width to its corresponding th
  const ths = wrap.querySelectorAll('thead th');
  const tds = bar.querySelectorAll('td');
  ths.forEach((th, i) => { if (tds[i]) tds[i].style.width = th.offsetWidth + 'px'; });

  // Sync table width and horizontal scroll offset from the h-scroll container
  const mainTable = wrap.querySelector('table');
  const footTable = bar.querySelector('table');
  if (mainTable && footTable) {
    footTable.style.tableLayout = 'fixed';
    footTable.style.width       = mainTable.offsetWidth + 'px';
    footTable.style.marginLeft  = hScroll ? -hScroll.scrollLeft + 'px' : '0';
  }
}

// ── Header drag-to-reorder ────────────────────────────────────

function bindAcctHeaderDrag() {
  const thead = document.querySelector('.acct-grid-wrap thead tr');
  if (!thead) return;

  let indicator = document.getElementById('acct-col-drop-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'acct-col-drop-indicator';
    indicator.className = 'acct-col-drop-indicator';
    document.body.appendChild(indicator);
  }

  let dragId = null, dropTarget = null, dropAfter = false;

  function hide() { indicator.style.display = 'none'; }

  thead.addEventListener('dragstart', e => {
    const handle = e.target.closest('.col-drag-handle');
    if (!handle) { e.preventDefault(); return; }
    dragId = handle.dataset.colId;
    handle.closest('th').classList.add('col-th-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);

    // Custom drag image: pill showing the column label
    const def   = ACCT_COL_DEFS[dragId];
    const ghost = document.createElement('div');
    ghost.textContent = def ? def.label : dragId;
    ghost.style.cssText = 'position:fixed;top:-200px;left:0;background:#1a2332;color:#e2e8f0;padding:5px 12px;border-radius:6px;font-size:13px;font-weight:600;font-family:inherit;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.12)';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 16);
    setTimeout(() => ghost.remove(), 0);
  });

  thead.addEventListener('dragover', e => {
    e.preventDefault();
    const th = e.target.closest('th[data-col-id]');
    if (!th || th.dataset.colId === dragId) { hide(); return; }
    dropTarget = th;
    const rect = th.getBoundingClientRect();
    dropAfter  = e.clientX > rect.left + rect.width / 2;
    indicator.style.cssText = `display:block;left:${(dropAfter ? rect.right : rect.left) - 2}px;top:${rect.top}px;height:${rect.height}px`;
  });

  thead.addEventListener('dragleave', e => {
    if (!thead.contains(e.relatedTarget)) hide();
  });

  thead.addEventListener('dragend', () => {
    hide();
    thead.querySelectorAll('th').forEach(th => th.classList.remove('col-th-dragging'));
    dragId = null; dropTarget = null;
  });

  thead.addEventListener('drop', e => {
    e.preventDefault();
    hide();
    const fromId = e.dataTransfer.getData('text/plain');
    const toId   = dropTarget && dropTarget.dataset.colId;
    thead.querySelectorAll('th').forEach(th => th.classList.remove('col-th-dragging'));
    dragId = null; dropTarget = null;
    if (!fromId || !toId || fromId === toId) return;
    const sorted   = [...acctLayout.columns].sort((a, b) => a.order - b.order);
    const fromIdx  = sorted.findIndex(c => c.id === fromId);
    const toIdx    = sorted.findIndex(c => c.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved]  = sorted.splice(fromIdx, 1);
    const insertAt = dropAfter
      ? (fromIdx < toIdx ? toIdx : toIdx + 1)
      : (fromIdx < toIdx ? toIdx - 1 : toIdx);
    sorted.splice(Math.max(0, Math.min(insertAt, sorted.length)), 0, moved);
    sorted.forEach((c, i) => { c.order = i; });
    acctLayout.columns = sorted;
    renderAccountsOverview();
    setTimeout(bindAcctHeaderDrag, 0);
  });
}

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
  initAcctLayout();
  renderAccountsOverview();
  fetchRepOverview();
  // Show territory AI button (may be first render — switchTab won't have fired yet)
  const acctAiBtn = document.getElementById('acct-ai-tab');
  if (acctAiBtn) acctAiBtn.style.display = 'flex';
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

  const totalAccounts     = (accountsData || []).length;
  const activeAccounts    = d.monthly.activeAccounts;      // 180-day unique CustNos
  const mtdActiveAccounts = d.monthly.mtdActiveAccounts ?? 0;

  const runRatePct   = (d.yearRunRate * 100).toFixed(1);
  const totalBsUnits    = (accountsData || []).reduce((s, a) => s + (a.bsUnits    || 0), 0);
  const totalAllUnits   = (accountsData || []).reduce((s, a) => s + (a.totalUnits || 0), 0);
  const totalPyBsUnits  = (accountsData || []).reduce((s, a) => s + (a.pyBsUnits  || 0), 0);
  const totalPyAllUnits = (accountsData || []).reduce((s, a) => s + (a.pyTotalUnits || 0), 0);
  const repBsPct        = totalAllUnits > 0 ? totalBsUnits / totalAllUnits : (d.bestSeller.pct || 0);
  const repPyBsPct      = totalPyAllUnits > 0 ? totalPyBsUnits / totalPyAllUnits : 0;
  const bsPct           = (repBsPct * 100).toFixed(1);
  const pyBsPct         = (repPyBsPct * 100).toFixed(1);
  const activeAccPct = totalAccounts > 0 ? ((mtdActiveAccounts / totalAccounts) * 100).toFixed(0) : 0;


  const totalYtd        = (accountsData || []).reduce((s, a) => s + a.ytdSales, 0);
  const totalMonthGoal  = (accountsData || []).reduce((s, a) => s + (a.monthGoal || 0), 0);
  const totalAnnualTarget = (accountsData || []).reduce((s, a) => s + (a.annualGoal || 0), 0);
  const annualPctRatio  = totalAnnualTarget > 0 ? totalYtd / totalAnnualTarget : 0;
  const annualPct       = (annualPctRatio * 100).toFixed(1);
  const mtdRatio     = totalMonthGoal > 0 ? d.monthly.mtd / totalMonthGoal : 0;
  const mtdPct       = (mtdRatio * 100).toFixed(1);

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
  const ticketChgStr = ticketChg !== null
    ? (parseFloat(ticketChg) >= 0 ? `<span style="color:#86efac">↑ +${ticketChg}%</span>` : `<span style="color:#fca5a5">↓ ${ticketChg}%</span>`)
    : '<span style="color:#94a3b8">—</span>';
  const linesChgStr = linesChg !== null
    ? (parseFloat(linesChg) >= 0 ? `<span style="color:#86efac">↑ +${linesChg}%</span>` : `<span style="color:#fca5a5">↓ ${linesChg}%</span>`)
    : '<span style="color:#94a3b8">—</span>';

  const annualGrowthPct  = d.annualGrowthPct  != null ? (d.annualGrowthPct  * 100).toFixed(1) + '%' : '—';
  const monthlyGrowthPct = d.monthlyGrowthPct != null ? (d.monthlyGrowthPct * 100).toFixed(1) + '%' : '—';
  const ANNUAL_GOAL_TOOLTIP  = `<strong>Annual Goal:</strong> prior full-year sales × annual growth target<br><strong>Annual growth target:</strong> +${annualGrowthPct}<br><strong>Prior year:</strong> Jan 1 – Dec 31 last year<br><strong>Accounts:</strong> ${totalAccounts} currently assigned`;
  const MONTHLY_GOAL_TOOLTIP = `<strong>Basis:</strong> Prior-year same-month sales<br><strong>Monthly growth target:</strong> +${monthlyGrowthPct} (set per month)<br><strong>Accounts:</strong> ${totalAccounts} currently assigned`;

  // tooltip = HTML string shown in the dark kpi-tooltip-box on hover
  const pill = (label, value, sub, valueStyle, tooltip) => `
    <div class="mgr-pill">
      <div class="mgr-pill-label">${label}</div>
      <div class="mgr-pill-value" style="${valueStyle || ''}">
        ${tooltip ? `<span class="kpi-info-wrap">${value}<span class="kpi-info-icon">i<span class="kpi-tooltip-box">${tooltip}</span></span></span>` : value}
      </div>
      ${sub ? `<div class="mgr-pill-sub">${sub}</div>` : ''}
    </div>`;

  el.innerHTML = `
    <div class="mgr-panel">
      <div style="display:flex;gap:0;align-items:stretch">

        <!-- Left: donut chart (click slice to filter grid) -->
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:240px;width:240px;padding:8px 20px 8px 4px;border-right:1px solid rgba(255,255,255,0.12);margin-right:20px;flex-shrink:0">
          <canvas id="acct-donut-chart" style="max-height:200px;cursor:pointer" title="Click a slice to filter by tier"></canvas>
        </div>

        <!-- Right: 2-row KPI grid -->
        <div style="flex:1;display:flex;flex-direction:column;gap:8px;padding:4px 0">
          <!-- Row 1: Year Run Rate | Annual Goal | Month Run Rate | Monthly Goal $$ | Daily Needed | Active Accounts -->
          <div class="mgr-pill-row">
            <div class="mgr-pill">
              <div class="mgr-pill-label">Year Run Rate</div>
              <div class="mgr-pill-value">${runRatePct}%</div>
              <div class="mgr-pill-sub">${d.businessDaysElapsed} of ${d.businessDaysTotal} days elapsed</div>
            </div>
            ${pill('Annual Goal', fmt$(totalAnnualTarget), `prior yr × ${annualGrowthPct}`, '', ANNUAL_GOAL_TOOLTIP)}
            ${pill('Month Run Rate',
              d.monthRunRate ? d.monthRunRate.pctElapsed.toFixed(1) + '%' : '—',
              d.monthRunRate ? `${d.monthRunRate.elapsed} of ${d.monthRunRate.total} business days` : '',
              '',
              '<strong>Month Run Rate:</strong> business days elapsed ÷ total business days in the month<br><strong>Business day:</strong> Mon–Fri excluding US federal holidays')}
            ${pill('Monthly Goal', fmt$(totalMonthGoal), `prior mo × ${monthlyGrowthPct}`, '', MONTHLY_GOAL_TOOLTIP)}
            ${pill('Daily Needed', dailyNeeded > 0 ? fmt$(dailyNeeded) : '—', 'to close gap')}
            ${pill('Active Accounts', `${activeAccounts} <span style="opacity:0.55;font-size:14px;font-weight:500">/ ${totalAccounts}</span>`, `${activeAccPct}% ordered this month`, '', '<strong>Active account:</strong> at least one order in the last 180 days<br><strong>Sub-text:</strong> % of total accounts with an order so far this month')}
          </div>

          <!-- Row 2: % to Annual Target | YTD Sales | % to Monthly Target | MTD Sales | Avg Order | Best Sellers on PO -->
          <div class="mgr-pill-row">
            ${pill('% to Annual Target', `${annualPct}%`, fmt$(totalYtd) + ' YTD', '', `<strong>% to Annual Target:</strong> YTD Sales ÷ Annual Goal<br><strong>YTD Sales:</strong> ${fmt$(totalYtd)}<br><strong>Annual Goal:</strong> ${fmt$(totalAnnualTarget)}`)}
            ${pill('YTD Sales', fmt$(totalYtd), 'current year to date')}
            ${pill('% to Monthly Target', `${mtdPct}%`, 'of monthly goal')}
            ${pill('MTD Sales', fmt$(d.monthly.mtd), `${d.monthly.remainingBusinessDays} biz days left`)}
            ${pill('Avg Order',
              `${fmt$(d.avg.ticketCurrent)}<br>${d.avg.linesCurrent.toFixed(1)} lines`,
              '',
              '',
              `<strong>Avg Ticket</strong><br>CY: ${fmt$(d.avg.ticketCurrent)}<br>PY: ${d.avg.ticketPrior > 0 ? fmt$(d.avg.ticketPrior) : '—'}<br>Change: ${ticketChgStr}<br><br><strong>Avg Lines</strong><br>CY: ${d.avg.linesCurrent.toFixed(1)}<br>PY: ${d.avg.linesPrior > 0 ? d.avg.linesPrior.toFixed(1) : '—'}<br>Change: ${linesChgStr}`)}
            ${(() => {
              const bsChgPts = repPyBsPct > 0 ? (repBsPct - repPyBsPct) * 100 : null;
              const bsChgStr = bsChgPts !== null
                ? (bsChgPts >= 0 ? `<span style="color:#86efac">↑ +${bsChgPts.toFixed(1)} pts YoY</span>` : `<span style="color:#fca5a5">↓ ${bsChgPts.toFixed(1)} pts YoY</span>`)
                : '<span style="color:#94a3b8">no prior yr data</span>';
              return pill('Best Sellers on PO', bsPct + '%', `${totalBsUnits.toLocaleString()} of ${totalAllUnits.toLocaleString()} lines`, '', `<strong>Current Year:</strong> ${bsPct}%<br><strong>Prior Year:</strong> ${pyBsPct}%<br><strong>Change:</strong> ${bsChgStr}`);
            })()}
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
      datasets: [{ data: counts, backgroundColor: bgColors, borderColor: '#ffffff', borderWidth: 3 }]
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

  // Apply tier filter, column filters, then sort
  let list = acctTierFilter === 'All' ? byRep : byRep.filter(a => a.tier === acctTierFilter);
  list = applyAcctFilters(list);
  list = [...list].sort((a, b) => {
    const dir = acctSortDir === 'asc' ? 1 : -1;
    const pctChange = x => x.priorYtd > 0 ? (x.ytdSales - x.priorYtd) / x.priorYtd : -1;
    switch (acctSortCol) {
      case 'name':        return dir * (a.name || '').localeCompare(b.name || '');
      case 'custNo':      return dir * (a.custNo || '').localeCompare(b.custNo || '');
      case 'state':       return dir * (a.state || '').localeCompare(b.state || '');
      case 'tier':           return dir * (a.tier || '').localeCompare(b.tier || '');
      case 'monthTier':      return dir * (a.monthTier || '').localeCompare(b.monthTier || '');
      case 'ytdSales':       return dir * (a.ytdSales       - b.ytdSales);
      case 'mtdSales':       return dir * ((a.mtdSales||0)  - (b.mtdSales||0));
      case 'target':         return dir * (a.target         - b.target);
      case 'pctToTarget':    return dir * (a.pctToTarget    - b.pctToTarget);
      case 'priorYtd':       return dir * (a.priorYtd       - b.priorYtd);
      case 'priorMtd':       return dir * ((a.priorMtd||0)   - (b.priorMtd||0));
      case 'priorMonth':     return dir * ((a.priorMonth||0) - (b.priorMonth||0));
      case 'pctToMonthGoal': return dir * ((a.pctToMonthGoal||0) - (b.pctToMonthGoal||0));
      case 'pctChange':      return dir * (pctChange(a)     - pctChange(b));
      case 'bsPct':       return dir * ((a.bsPct || 0)    - (b.bsPct    || 0));
      case 'daysSince':   return dir * (a.daysSinceOrder - b.daysSinceOrder);
      case 'lastOrder':   return dir * (a.lastOrderDate || '').localeCompare(b.lastOrderDate || '');
      case 'category':    return dir * (a.category  || '').localeCompare(b.category  || '');
      case 'termsCode':   return dir * (a.termsCode || '').localeCompare(b.termsCode || '');
      case 'email':       return dir * (a.email     || '').localeCompare(b.email     || '');
      case 'phone':       return dir * (a.phone     || '').localeCompare(b.phone     || '');
      case 'discount':    return dir * ((a.discount || 0) - (b.discount || 0));
      case 'monthGoal':       return dir * ((a.monthGoal       || 0) - (b.monthGoal       || 0));
      case 'annualGoal':      return dir * ((a.annualGoal      || 0) - (b.annualGoal      || 0));
      case 'pctToAnnualGoal': return dir * ((a.pctToAnnualGoal || 0) - (b.pctToAnnualGoal || 0));
      case 'monthRunRate':    return dir * ((a.monthRunRate    || 0) - (b.monthRunRate    || 0));
      case 'annualRunRate':   return dir * ((a.annualRunRate   || 0) - (b.annualRunRate   || 0));
      case 'pyFullYear':      return dir * ((a.pyFullYear      || 0) - (b.pyFullYear      || 0));
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

  // ── Table — dynamic column layout ───────────────────────────
  const visCols = acctVisibleCols();
  const colCount = visCols.length;

  const thead = visCols.map(col => {
    const active      = acctSortCol === col.sortKey;
    const sortIcon    = active ? `<span class="sort-icon">${acctSortDir === 'asc' ? '▲' : '▼'}</span>` : '';
    const cls         = [col.cls || '', 'sort-th', active ? 'sort-active' : ''].filter(Boolean).join(' ');
    const tipHtml     = col.tip
      ? `<span class="kpi-info-wrap col-tip-wrap"><span class="kpi-info-icon">i<span class="kpi-tooltip-box col-tip-box">${col.tip}</span></span></span>`
      : '';
    const filterOn    = acctFilterActive(col.id);
    const filterBtnCls = 'col-filter-btn' + (filterOn ? ' col-filter-active' : '');
    const hasFilter   = ACCT_FILTER_TYPES[col.id];
    const filterBtn   = hasFilter
      ? `<button class="${filterBtnCls}" title="Filter" onclick="showColFilter('${col.id}',event)">▾</button>`
      : '';
    return `<th class="${cls}" data-col-id="${col.id}" onclick="acctSortBy('${col.sortKey}')" oncontextmenu="showAcctColMenu(event)">
      <div class="th-inner">
        <span class="col-drag-handle" draggable="true" data-col-id="${col.id}" title="Drag to reorder" onclick="event.stopPropagation()">⠿</span>
        <span class="th-label">${col.label}</span>
        <span class="th-tail">${tipHtml}${filterBtn}${sortIcon}</span>
      </div>
    </th>`;
  }).join('');

  // ── Totals row ───────────────────────────────────────────────
  const totYtd       = list.reduce((s, a) => s + a.ytdSales, 0);
  const totMtd       = list.reduce((s, a) => s + (a.mtdSales || 0), 0);
  const totTarget    = list.reduce((s, a) => s + (a.target || 0), 0);
  const totPriorYtd  = list.reduce((s, a) => s + (a.priorYtd || 0), 0);
  const totPriorMtd  = list.reduce((s, a) => s + (a.priorMtd   || 0), 0);
  const totPriorMonth= list.reduce((s, a) => s + (a.priorMonth || 0), 0);
  const totBsUnits   = list.reduce((s, a) => s + (a.bsUnits || 0), 0);
  const totAllUnits  = list.reduce((s, a) => s + (a.totalUnits || 0), 0);
  const totMonthGoal    = list.reduce((s, a) => s + (a.monthGoal    || 0), 0);
  const totAnnualGoal   = list.reduce((s, a) => s + (a.annualGoal   || 0), 0);
  const totMonthRunRate = list.reduce((s, a) => s + (a.monthRunRate  || 0), 0);
  const totAnnualRunRate= list.reduce((s, a) => s + (a.annualRunRate || 0), 0);
  const totPyFull       = list.reduce((s, a) => s + (a.pyFullYear   || 0), 0);
  const activeFilterCount = Object.keys(acctFilters).filter(k => acctFilterActive(k)).length;
  const totLabel     = (acctTierFilter === 'All' ? `All ${list.length} accounts` : `${acctTierFilter.replace('AtRisk','At Risk')} (${list.length})`) +
                       (activeFilterCount > 0 ? ` · ${activeFilterCount} filter${activeFilterCount > 1 ? 's' : ''}` : '');
  const totData      = { label: totLabel, ytd: totYtd, mtd: totMtd, target: totTarget, priorYtd: totPriorYtd, priorMtd: totPriorMtd, priorMonth: totPriorMonth, bsUnits: totBsUnits, allUnits: totAllUnits, monthGoal: totMonthGoal, annualGoal: totAnnualGoal, monthRunRate: totMonthRunRate, annualRunRate: totAnnualRunRate, pyFullYear: totPyFull };

  const totalsRowHtml = visCols.map(c => renderAcctTotalsCell(c.id, totData)).join('');

  const tbody = list.map(a => {
    const rowBg = a.tier === 'Critical' ? 'background:#fff5f5' : a.tier === 'AtRisk' ? 'background:#fff8f0' : '';
    return `<tr style="${rowBg}">${visCols.map(c => renderAcctTd(c.id, a)).join('')}</tr>`;
  }).join('') || `<tr><td colspan="${colCount}" style="padding:20px;color:#9ca3af;text-align:center">No accounts found.</td></tr>`;

  document.getElementById('store-view-content').innerHTML = `
    <div id="acct-overview-kpis">
      <div class="mgr-panel">
        <div style="display:flex;gap:0;align-items:stretch;opacity:0.35">
          <div style="min-width:240px;width:240px;padding:8px 20px 8px 4px;border-right:1px solid rgba(255,255,255,0.12);margin-right:20px;flex-shrink:0"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:8px;padding:4px 0">
            <div class="mgr-pill-row">
              ${['Year Run Rate','Annual Goal','Month Run Rate','Monthly Goal','Daily Needed','Active Accounts'].map(lbl => `
                <div class="mgr-pill"><div class="mgr-pill-label">${lbl}</div><div class="mgr-pill-value">—</div></div>`).join('')}
            </div>
            <div class="mgr-pill-row">
              ${['% to Annual Target','YTD Sales','% to Monthly Target','MTD Sales','Avg Order','Best Sellers on PO'].map(lbl => `
                <div class="mgr-pill"><div class="mgr-pill-label">${lbl}</div><div class="mgr-pill-value">—</div></div>`).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="tier-filter-bar">
      ${tierBtn('All')}${tierBtn('Healthy')}${tierBtn('Attention')}${tierBtn('AtRisk')}${tierBtn('Critical')}
      <span class="acct-layout-badge">${(() => {
        const n = layoutStore.getActiveLayoutName();
        return n && n !== 'Default'
          ? `Layout: <strong>${n}</strong> · <a href="#" class="acct-layout-reset" onclick="event.preventDefault();resetAcctLayout()">Reset</a>`
          : '';
      })()}</span>
      ${activeFilterCount > 0 ? `<button class="acct-clear-filters-btn" onclick="clearAllAcctFilters()">✕ Clear ${activeFilterCount} filter${activeFilterCount > 1 ? 's' : ''}</button>` : ''}
      <button class="acct-layout-chooser-btn" onclick="openAcctChooser()" title="Column Chooser">⊞ Columns</button>
    </div>

    <div class="inv-wrap acct-grid-wrap">
      <div class="acct-h-scroll">
        <table class="data-table">
          <thead><tr>${thead}</tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    </div>`;

  // ── Fixed totals bar — always visible at viewport bottom ─────
  let totBar = document.getElementById('acct-totals-bar');
  if (!totBar) {
    totBar = document.createElement('div');
    totBar.id = 'acct-totals-bar';
    document.body.appendChild(totBar);
  }
  totBar.innerHTML = `<table class="data-table acct-totals-table"><tbody><tr class="acct-totals-row">${totalsRowHtml}</tr></tbody></table>`;
  totBar.style.display = 'block';

  setTimeout(() => {
    renderAccountsCharts(list, byRep);
    bindAcctHeaderDrag();
    reopenActiveFilter();
    syncAcctTotalsBar();
    // Sync totals bar on horizontal scroll within the table's h-scroll container
    const hScroll = document.querySelector('.acct-h-scroll');
    if (hScroll && !hScroll._acctTotalsScrollBound) {
      hScroll.addEventListener('scroll', syncAcctTotalsBar);
      hScroll._acctTotalsScrollBound = true;
    }
    if (!window._acctTotalsResizeBound) {
      window.addEventListener('resize', syncAcctTotalsBar);
      window._acctTotalsResizeBound = true;
    }
  }, 0);
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

// ── Territory AI Panel ────────────────────────────────────────

function toggleTerritoryAIDrawer() {
  const drawer  = document.getElementById('acct-ai-drawer');
  const overlay = document.getElementById('acct-ai-overlay');
  if (!drawer) return;
  const isOpen = drawer.style.transform === 'translateX(0px)' || drawer.style.transform === 'translateX(0%)';
  if (isOpen) {
    drawer.style.transform = 'translateX(100%)';
    if (overlay) overlay.style.display = 'none';
  } else {
    if (overlay) overlay.style.display = 'block';
    drawer.style.transform = 'translateX(0)';
    if (acctAiConversation.length === 0) startTerritoryBriefing();
  }
}

function closeTerritoryAIDrawer() {
  const drawer  = document.getElementById('acct-ai-drawer');
  const overlay = document.getElementById('acct-ai-overlay');
  if (drawer)  drawer.style.transform = 'translateX(100%)';
  if (overlay) overlay.style.display = 'none';
}

async function startTerritoryBriefing() {
  if (acctAiCtrl) { acctAiCtrl.abort(); acctAiCtrl = null; }
  acctAiConversation = [];

  const msgs = document.getElementById('acct-ai-messages');
  const opts = document.getElementById('acct-ai-options');
  const inp  = document.getElementById('acct-ai-input');
  if (msgs) msgs.innerHTML = '';
  if (opts) { opts.innerHTML = ''; opts.style.display = 'none'; }
  if (inp)  inp.value = '';

  if (!accountsData || !acctOverviewData) {
    acctAiAppendBubble('ai', '<span style="color:#6b7280">Waiting for territory data to load…</span>');
    return;
  }

  const rep = (typeof currentRep !== 'undefined' ? currentRep : '');
  const context = buildTerritoryContext(accountsData, acctOverviewData, rep);
  acctAiConversation.push({ role: 'user', content: context });
  acctAiStreamResponse();
}

function acctAiSendMessage(textOverride) {
  const inp  = document.getElementById('acct-ai-input');
  const text = textOverride || (inp ? inp.value.trim() : '');
  if (!text) return;
  if (inp) inp.value = '';

  const opts = document.getElementById('acct-ai-options');
  if (opts) { opts.innerHTML = ''; opts.style.display = 'none'; }

  acctAiAppendBubble('user', text);
  acctAiConversation.push({ role: 'user', content: text });
  acctAiStreamResponse();
}

async function acctAiStreamResponse() {
  if (acctAiCtrl) acctAiCtrl.abort();
  acctAiCtrl = new AbortController();

  const typingId = 'acct-typing-' + Date.now();
  const msgs = document.getElementById('acct-ai-messages');
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
        system:   typeof TERRITORY_SYSTEM_PROMPT !== 'undefined' ? TERRITORY_SYSTEM_PROMPT : undefined,
        messages: acctAiConversation,
      }),
      signal: acctAiCtrl.signal,
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `Server returned ${resp.status}`);
    }

    const typing = document.getElementById(typingId);
    if (typing) typing.remove();
    const bubbleId = 'acct-bubble-' + Date.now();
    acctAiAppendBubble('ai', '', bubbleId);
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
            if (bubble) bubble.innerHTML = typeof formatAIText === 'function' ? formatAIText(fullText) : fullText;
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
          } else if (evt.type === 'error') {
            throw new Error(evt.error);
          }
        } catch (_) {}
      }
    }

    acctAiConversation.push({ role: 'assistant', content: fullText });

    const options = acctAiExtractOptions(fullText);
    if (options.length >= 2) acctAiRenderOptions(options);

  } catch (e) {
    const typing = document.getElementById(typingId);
    if (typing) typing.remove();
    if (e.name !== 'AbortError') {
      acctAiAppendBubble('ai', `<span style="color:#dc2626">Error: ${e.message}</span>`);
    }
  }
}

function acctAiAppendBubble(role, html, id) {
  const msgs = document.getElementById('acct-ai-messages');
  if (!msgs) return;
  const idAttr = id ? `id="${id}"` : '';
  msgs.insertAdjacentHTML('beforeend', `
    <div class="ai-chat-msg ${role}">
      <div class="ai-chat-bubble" ${idAttr}>${html}</div>
    </div>`);
  msgs.scrollTop = msgs.scrollHeight;
}

function acctAiExtractOptions(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const opts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(\d+)\.\s+(.+)$/);
    if (m) opts.unshift(m[2]);
    else if (opts.length > 0) break;
  }
  return opts.length >= 2 ? opts : [];
}

function acctAiRenderOptions(options) {
  const container = document.getElementById('acct-ai-options');
  if (!container) return;
  container.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'ai-option-btn';
    btn.textContent = opt;
    btn.addEventListener('click', () => acctAiSendMessage(opt));
    container.appendChild(btn);
  });
  container.style.display = 'flex';
  const msgs = document.getElementById('acct-ai-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

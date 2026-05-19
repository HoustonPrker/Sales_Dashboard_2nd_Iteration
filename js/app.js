// ============================================================
// APP — Global state, init, tab switching, event listeners
// Loads LAST — all other modules must be loaded first
// ============================================================

let accountsData = [];
let dataReady    = false;
let activeTab    = 'store';
let currentRep   = '';    // rep selected at boot — used by sub-views that need their own fetches

// ── Tab switching ─────────────────────────────────────────────

function switchTab(tab) {
  if (activeTab === 'store'       && typeof destroyStoreCharts       === 'function') destroyStoreCharts();
  if (activeTab === 'category'    && typeof destroyItemPerfCharts    === 'function') destroyItemPerfCharts();
  if (activeTab === 'leaderboard' && typeof destroyLeaderboardCharts === 'function') destroyLeaderboardCharts();
  if (activeTab === 'rp' && typeof rpDrillChart !== 'undefined' && rpDrillChart) { try { rpDrillChart.destroy(); } catch(_){} rpDrillChart = null; }

  activeTab = tab;

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('tab-btn-' + tab);
  if (btn) btn.classList.add('active');

  ['item', 'category', 'store', 'leaderboard', 'rp'].forEach(t => {
    const panel = document.getElementById('tab-' + t);
    if (panel) panel.style.display = t === tab ? (t === 'rp' || t === 'leaderboard' ? 'block' : 'flex') : 'none';
  });

  // Show/hide inline tab-bar search bars
  const caBar = document.getElementById('tab-ca-search');
  const ipBar = document.getElementById('tab-ip-search');
  if (caBar) caBar.style.display = tab === 'item'     ? 'flex' : 'none';
  if (ipBar) ipBar.style.display = tab === 'category' ? 'flex' : 'none';

  // Show/hide AI floating buttons
  const caAiBtn   = document.getElementById('ca-ai-tab');
  const acctAiBtn = document.getElementById('acct-ai-tab');
  if (caAiBtn)   caAiBtn.style.display   = tab === 'item'  ? 'flex' : 'none';
  if (acctAiBtn) acctAiBtn.style.display = tab === 'store' ? 'flex' : 'none';

  // Close territory drawer when leaving store tab
  if (tab !== 'store' && typeof closeTerritoryAIDrawer === 'function') closeTerritoryAIDrawer();

  // Hide the fixed accounts totals bar when not on the accounts tab
  const acctTotBar = document.getElementById('acct-totals-bar');
  if (acctTotBar) acctTotBar.style.display = tab === 'store' ? 'block' : 'none';

  if (tab === 'store'       && dataReady) renderStoreView();
  if (tab === 'category'    && dataReady) renderItemPerformanceView();
  if (tab === 'leaderboard' && dataReady) renderLeaderboardView();
  if (tab === 'rp'          && typeof renderRepPerformance === 'function') renderRepPerformance();

  if (tab === 'item' && !caCustNo && typeof renderCAEmpty === 'function') {
    renderCAEmpty();
  }
}

// Handle back/forward and direct hash links
window.addEventListener('popstate', () => {
  const hash  = window.location.hash;
  // Order detail: #/customer/KG12345/order/1565156
  const orderMatch = hash.match(/^#\/customer\/([^\/]+)\/order\/([^?&]+)/);
  if (orderMatch) {
    const custNo   = decodeURIComponent(orderMatch[1]);
    const ticketNo = decodeURIComponent(orderMatch[2]);
    switchTab('item');
    if (typeof loadOrderDetail === 'function') loadOrderDetail(custNo, ticketNo);
    return;
  }
  // Customer account: #/customer?cust=KG12345
  const custMatch = hash.match(/[?&]cust=([^&]+)/);
  if (custMatch && dataReady) {
    const custNo = decodeURIComponent(custMatch[1]);
    switchTab('item');
    if (typeof loadCustomerAccount === 'function') loadCustomerAccount(custNo);
  }
});

// ── Switch rep — go back to the rep picker ────────────────────

function switchRep() {
  dataReady    = false;
  accountsData = [];
  if (typeof resetItemPerformanceData === 'function') resetItemPerformanceData();
  const appEl  = document.getElementById('app-content');
  if (appEl) appEl.style.display = 'none';
  loadData();
}

// ── Nav search bar — live dropdown ───────────────────────────

// ── Boot — loadData is called by checkAuth() in auth.js after session is confirmed ──

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

  activeTab = tab;

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('tab-btn-' + tab);
  if (btn) btn.classList.add('active');

  ['item', 'category', 'store', 'leaderboard'].forEach(t => {
    const panel = document.getElementById('tab-' + t);
    if (panel) panel.style.display = t === tab ? 'flex' : 'none';
  });

  // Show/hide inline tab-bar search bars
  const caBar = document.getElementById('tab-ca-search');
  const ipBar = document.getElementById('tab-ip-search');
  if (caBar) caBar.style.display = tab === 'item'     ? 'flex' : 'none';
  if (ipBar) ipBar.style.display = tab === 'category' ? 'flex' : 'none';

  if (tab === 'store'       && dataReady) renderStoreView();
  if (tab === 'category'    && dataReady) renderItemPerformanceView();
  if (tab === 'leaderboard' && dataReady) renderLeaderboardView();

  if (tab === 'item' && !caCustNo && typeof renderCAEmpty === 'function') {
    renderCAEmpty();
  }
}

// Handle back/forward and direct hash links
window.addEventListener('popstate', () => {
  const hash  = window.location.hash;
  const match = hash.match(/[?&]cust=([^&]+)/);
  if (match && dataReady) {
    const custNo = decodeURIComponent(match[1]);
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

// ── Boot ──────────────────────────────────────────────────────

loadData();

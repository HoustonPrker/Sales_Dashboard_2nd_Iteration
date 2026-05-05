// ============================================================
// APP — Global state, init, tab switching, event listeners
// Loads LAST — all other modules must be loaded first
// ============================================================

let pipelineData    = [];
let normalityMap    = {};
let storeData       = [];
let dailySalesData  = [];
let dailySalesIndex = {};
let dataReady       = false;
let activeCharts    = {};
let activeTab       = 'item';

// ── Tab switching ─────────────────────────────────────────────

function switchTab(tab) {
  // Only destroy charts for the tab we're leaving, not item charts —
  // item charts survive tab switches and are recreated only on new searches.
  if (activeTab === 'category' && typeof destroyCatCharts   === 'function') destroyCatCharts();
  if (activeTab === 'store'    && typeof destroyStoreCharts === 'function') destroyStoreCharts();
  // Destroy cat/store charts when entering item tab to free canvas references
  if (tab === 'item') {
    if (typeof destroyCatCharts   === 'function') destroyCatCharts();
    if (typeof destroyStoreCharts === 'function') destroyStoreCharts();
  }

  activeTab = tab;

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('tab-btn-' + tab);
  if (btn) btn.classList.add('active');

  ['item', 'category', 'store'].forEach(t => {
    const panel = document.getElementById('tab-' + t);
    if (panel) panel.style.display = t === tab ? 'flex' : 'none';
  });

  if (tab === 'category' && dataReady) renderCategoryView();
  if (tab === 'store'    && dataReady) renderStoreView();
}

// ── Event listeners ───────────────────────────────────────────

document.getElementById('item-search').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

window.addEventListener('popstate', () => {
  const hash = window.location.hash;
  if (hash.startsWith('#store') && activeTab === 'store' && dataReady) {
    renderStoreView();
  }
});

// ── Boot ──────────────────────────────────────────────────────

loadData();

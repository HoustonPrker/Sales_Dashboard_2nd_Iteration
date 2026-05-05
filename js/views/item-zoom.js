// ============================================================
// ITEM ZOOM VIEW
// Uses globals: pipelineData, normalityMap, dataReady, activeCharts
// ============================================================

async function doSearch(prefill) {
  if (prefill !== undefined) document.getElementById('item-search').value = prefill;
  const q = document.getElementById('item-search').value.trim().toUpperCase();
  if (!q) return;
  if (!dataReady) { alert('Data is still loading — please wait.'); return; }

  // Always switch to Item Zoom tab before showing the result
  switchTab('item');

  const item = pipelineData.find(i => (i.ITEM_NO || '').trim().toUpperCase() === q);

  hide('welcome-screen'); hide('item-view'); hide('error-view');

  if (!item) {
    document.getElementById('error-msg').textContent =
      `No item found for item number "${q}". Check the number and try again.`;
    show('error-view');
    return;
  }

  // Fetch daily sales on demand before rendering charts
  if (!dailySalesIndex[item.ITEM_NO]) {
    try {
      const BASE_D = `${window.location.protocol}//${window.location.hostname}:3001/proxy`;
      const resp   = await fetch(`${BASE_D}/item/${encodeURIComponent(item.ITEM_NO)}/daily-sales`);
      const rows   = resp.ok ? await resp.json() : [];
      dailySalesIndex[item.ITEM_NO] = Array.isArray(rows) ? rows : (rows.data || []);
    } catch (_) {
      dailySalesIndex[item.ITEM_NO] = [];
    }
  }

  renderItem(item);
}

function clearView() {
  document.getElementById('item-search').value = '';
  hide('item-view'); hide('error-view');
  destroyCharts();
  show('welcome-screen');
  document.getElementById('item-search').focus();
}

function renderItem(item) {
  destroyCharts();

  const { pct } = computePercentile(item);
  const pctR = Math.round(pct * 10) / 10;

  show('item-view');

  // ── HEADER ──────────────────────────────────────────────────
  document.getElementById('h-name').textContent   = item.ITEM_NAME || '—';
  document.getElementById('h-itemno').textContent = `#${item.ITEM_NO}`;
  document.getElementById('h-categ').textContent  = item.CATEG_COD || '—';
  document.getElementById('h-subcat').textContent = item.SUBCAT_COD || '—';
  document.getElementById('h-peers').textContent  = item.PEER_COUNT || '—';

  const rankNum   = parseInt(item.SUBCAT_RANK)  || 0;
  const rankTotal = parseInt(item.SUBCAT_TOTAL) || parseInt(item.PEER_COUNT) || 0;
  const topPct    = rankTotal > 0 ? Math.round((1 - (rankNum - 1) / rankTotal) * 100) : 0;
  document.getElementById('h-rank').textContent = `Rank ${rankNum} of ${rankTotal} · Top ${topPct}%`;

  // "View in Category →" link
  const catLink = document.getElementById('h-catlink');
  if (item.CATEG_COD && item.SUBCAT_COD) {
    catLink.textContent = `View in Category →`;
    catLink.onclick = () => {
      switchTab('category');
      // give category view a moment to render, then drill into this sub-cat
      setTimeout(() => showCategoryDetail(item.CATEG_COD), 50);
    };
    catLink.style.display = '';
  } else {
    catLink.style.display = 'none';
  }

  // ── KPI CARDS ───────────────────────────────────────────────
  const qty90 = parseFloat(item.RAW_QTY_90D) || 0;
  const amt90 = parseFloat(item.RAW_AMT_90D) || 0;

  document.getElementById('k-qty90').textContent = fmtQty(qty90);
  document.getElementById('k-amt90').textContent = fmt$(amt90);
  // Real 30D and 7D from daily sales data
  const dailyData = getDailySalesForItem(item.ITEM_NO);
  const qty30 = dailyData.qty.slice(-30).reduce((a, b) => a + b, 0);
  const amt30 = dailyData.amt.slice(-30).reduce((a, b) => a + b, 0);
  const qty7  = dailyData.qty.slice(-7).reduce((a, b) => a + b, 0);
  const amt7  = dailyData.amt.slice(-7).reduce((a, b) => a + b, 0);

  document.getElementById('k-qty30').textContent = fmtQty(qty30);
  document.getElementById('k-amt30').textContent = fmt$(amt30);
  document.getElementById('k-qty7').textContent  = fmtQty(qty7);
  document.getElementById('k-amt7').textContent  = fmt$(amt7);

  // Velocity — PCT_RECENT is already a percentage (26.6 = 26.6%)
  const pctRecent = parseFloat(item.PCT_RECENT) || 0;
  let velLabel, velClass, velArrow;
  if      (pctRecent >= 30) { velLabel = 'Trending Up';   velClass = 'vel-up';   velArrow = '↑'; }
  else if (pctRecent <  20) { velLabel = 'Trending Down'; velClass = 'vel-down'; velArrow = '↓'; }
  else                      { velLabel = 'Steady';        velClass = 'vel-ss';   velArrow = '→'; }
  document.getElementById('k-vel').innerHTML =
    `<span class="${velClass}" style="font-size:20px;line-height:1">${velArrow}</span>&nbsp;<span class="${velClass}" style="font-size:20px">${velLabel}</span>`;
  document.getElementById('k-pct').textContent = `${pctRecent}% of 12M in last 90 days`;

  // Margin % and 90D Profit — seeded from CSV if available, else fetched live
  document.getElementById('k-margin').textContent     = '…';
  document.getElementById('k-margin-sub').textContent = '';
  document.getElementById('k-profit').textContent     = '…';
  document.getElementById('k-profit-sub').textContent = '';

  (async () => {
    let price    = parseFloat(item.PRICE)     || 0;
    let lastCost = parseFloat(item.LAST_COST) || 0;

    // CSV doesn't have price yet — fetch live from API
    if (!price) {
      try {
        const BASE = `${window.location.protocol}//${window.location.hostname}:3001/proxy`;
        const resp = await fetch(`${BASE}/item/${encodeURIComponent(item.ITEM_NO)}`);
        if (resp.ok) {
          const data = await resp.json();
          const d    = data.data || data;
          price    = parseFloat(d.price1   || d.PRICE)    || 0;
          lastCost = parseFloat(d.lastCost || d.LAST_COST) || 0;
        }
      } catch (_) {}
    }

    const rev90     = parseFloat(item.RAW_AMT_90D) || 0;
    const marginPct = price > 0 ? (price - lastCost) / price : null;
    const profit90  = marginPct != null ? rev90 * marginPct : null;

    if (marginPct != null) {
      document.getElementById('k-margin').textContent     = `${(marginPct * 100).toFixed(1)}%`;
      document.getElementById('k-margin-sub').textContent = `${fmt$(price)} sell · ${fmt$(lastCost)} cost`;
    } else {
      document.getElementById('k-margin').textContent     = '—';
      document.getElementById('k-margin-sub').textContent = 'No price data';
    }
    document.getElementById('k-profit').textContent     = profit90 != null ? fmt$(profit90) : '—';
    document.getElementById('k-profit-sub').textContent = profit90 != null ? `on ${fmt$(rev90)} revenue` : '';
  })();

  // Status
  const status = (item.STATUS || '').trim().toUpperCase();
  const stsCls = status === 'ACTIVE' ? 'sts-active' : status === 'OUT OF STOCK' ? 'sts-oos' : 'sts-ns';
  const stsLbl = status === 'ACTIVE' ? '● ACTIVE'   : status === 'OUT OF STOCK' ? '● OUT OF STOCK' : '● NOT SELLING';
  document.getElementById('k-status').innerHTML =
    `<span class="${stsCls}" style="font-size:28px;font-weight:700">${stsLbl}</span>`;
  document.getElementById('k-stock').textContent =
    `${fmtQty(item.QTY_AVAIL_ALL_STORES)} units available`;
  // ── RANK STRIP ───────────────────────────────────────────────
  const topPctStrip = Math.round((100 - pctR) * 10) / 10;
  document.getElementById('rank-main').innerHTML =
    `Sub-category rank: <strong>${rankNum}</strong> of <strong>${rankTotal}</strong>`
    + ` — <span class="rank-pct">Top ${topPctStrip}%</span> of ${item.SUBCAT_COD} items`;
  document.getElementById('rank-bar').style.width     = `${Math.min(100, pctR)}%`;
  document.getElementById('rank-bar-lbl').textContent = `Top ${topPctStrip}%`;

  // ── CHARTS ──────────────────────────────────────────────────
  renderCharts(item, qty90);

  // ── INVENTORY TABLE ──────────────────────────────────────────
  const qtyOH = parseFloat(item.QTY_ON_HND_ALL_STORES) || 0;
  const qtyAv = parseFloat(item.QTY_AVAIL_ALL_STORES)  || 0;
  const stksN = parseInt(item.STORES_WITH_STOCK)        || 0;
  const q12m  = parseFloat(item.RAW_QTY_12M_TOTAL)      || 0;
  const a12m  = parseFloat(item.RAW_AMT_12M_TOTAL)      || 0;

  document.getElementById('inv-summary').textContent =
    `${fmtQty(qtyAv)} units available across ${stksN} stores`;

  const tbody = document.getElementById('inv-body');
  tbody.innerHTML = '';

  const aggRow = tbody.insertRow();
  aggRow.className = 'agg-row';
  aggRow.innerHTML = `
    <td>ALL STORES (Aggregate)</td>
    <td class="num-ctr" style="color:#000">${fmtQty(qty30)}</td>
    <td class="num-ctr" style="color:#000">${fmt$(amt30)}</td>
    <td class="num-ctr" style="color:#000">${fmtQty(qty90)}</td>
    <td class="num-ctr" style="color:#000">${fmt$(amt90)}</td>
    <td class="num-ctr">${fmtQty(item.QTY_AVAIL_ALL_STORES)}</td>
    <td class="num-ctr">—</td>
    <td class="num-ctr">—</td>`;

  // Loading placeholder while store sales fetch
  const loadRow = tbody.insertRow();
  loadRow.innerHTML = `<td colspan="8" style="color:#9ca3af;font-size:12px;padding:10px 12px">Loading per-store sales...</td>`;

  // Fetch per-store sales and inventory in parallel
  const BASE = `${window.location.protocol}//${window.location.hostname}:3001/proxy`;
  Promise.all([
    fetch(`${BASE}/item/${encodeURIComponent(item.ITEM_NO)}/store-sales`).then(r => r.ok ? r.json() : []),
    fetch(`${BASE}/item/${encodeURIComponent(item.ITEM_NO)}/inventory`).then(r => r.ok ? r.json() : []),
  ]).then(([storeSales, inventory]) => {
      loadRow.remove();
      if (!storeSales.length) {
        const nr = tbody.insertRow();
        nr.innerHTML = `<td colspan="8" style="color:#9ca3af;font-size:12px;padding:10px 12px">No per-store sales data in the last 90 days.</td>`;
        return;
      }

      // Build store name lookup from storeData global
      const storeNames = {};
      (storeData || []).forEach(s => {
        const id = String(s.STR_ID || s.strId || '').trim();
        storeNames[id] = s.STR_NAM || s.STORE_NAME || s.storeName || s.descr || id;
      });

      // Build per-store inventory lookup
      const invByStore = {};
      (Array.isArray(inventory) ? inventory : (inventory.data || [])).forEach(r => {
        const sid = String(r.storeId || r.StoreId || r.STORE_ID || '').trim();
        if (sid) invByStore[sid] = {
          qtyAvail:    parseFloat(r.qtyAvailable  || r.QTY_AVAILABLE  || 0),
          markdownQty: parseFloat(r.markdownQty   || r.MARKDOWN_QTY   || r.clearanceQty || 0) || null,
          expiredQty:  parseFloat(r.expiredQty    || r.EXPIRED_QTY    || r.mosQty       || 0) || null,
        };
      });

      storeSales.forEach(s => {
        const name = storeNames[s.storeId] || '';
        const inv  = invByStore[s.storeId] || {};
        const row  = tbody.insertRow();
        row.innerHTML = `
          <td><span style="font-family:monospace;font-weight:700;color:#3d5a80;margin-right:6px">#${s.storeId}</span>${name}</td>
          <td class="num-ctr" style="color:#000">${fmtQty(s.qty30)}</td>
          <td class="num-ctr" style="color:#000">${fmt$(s.amt30)}</td>
          <td class="num-ctr" style="color:#000">${fmtQty(s.qty90)}</td>
          <td class="num-ctr" style="color:#000">${fmt$(s.amt90)}</td>
          <td class="num-ctr" style="color:#000">${inv.qtyAvail != null ? fmtQty(inv.qtyAvail) : '—'}</td>
          <td class="num-ctr">${inv.markdownQty != null ? fmtQty(inv.markdownQty) : '—'}</td>
          <td class="num-ctr">${inv.expiredQty  != null ? fmtQty(inv.expiredQty)  : '—'}</td>`;
      });
    })
    .catch(() => {
      loadRow.innerHTML = `<td colspan="8" style="color:#9ca3af;font-size:12px;padding:10px 12px">Could not load per-store sales.</td>`;
    });
}

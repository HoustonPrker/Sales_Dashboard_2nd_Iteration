// ============================================================
// ORDER DETAIL VIEW
// Route: #/customer/{custNo}/order/{ticketNo}
// ============================================================

let odFilter = 'all';   // 'all' | 'best' | 'new' | 'repeat'
let odSort   = 'ext';   // 'ext' | 'item' | 'qty' | 'margin'
let odSearch = '';
let odCurrentLines = [];

async function loadOrderDetail(custNo, ticketNo) {
  if (typeof switchTab === 'function') switchTab('item');

  const panel = document.getElementById('customer-account-panel');
  if (!panel) return;

  window.location.hash = `#/customer/${encodeURIComponent(custNo)}/order/${encodeURIComponent(ticketNo)}`;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;padding:60px;color:#6b7280;font-size:15px">
      Loading order <strong style="margin-left:6px;color:#3d5a80">#${ticketNo}</strong>…
    </div>`;

  try {
    const [orderRes, custRes] = await Promise.all([
      fetch(`/proxy/order-detail/${encodeURIComponent(ticketNo)}?custNo=${encodeURIComponent(custNo)}`),
      fetch(`/proxy/customer/${encodeURIComponent(custNo)}`),
    ]);
    const order = orderRes.ok ? await orderRes.json() : {};
    const cust  = custRes.ok  ? await custRes.json()  : {};
    renderOrderDetail(custNo, cust, order);
  } catch (e) {
    const p = document.getElementById('customer-account-panel');
    if (p) p.innerHTML = `<div style="padding:40px;color:#dc2626">Error loading order: ${e.message}</div>`;
  }
}

function renderOrderDetail(custNo, cust, order) {
  const panel = document.getElementById('customer-account-panel');
  if (!panel) return;

  odFilter = 'all'; odSort = 'ext'; odSearch = '';

  const custName = cust.name || order.custName || custNo;
  const ticketNo = order.ticketNo || '—';
  const date     = order.date     || '—';
  const rep      = order.rep      || cust.salesRep || '—';
  const storeNo  = order.storeNo  || '';
  const total    = parseFloat(order.total || 0);
  const lines    = order.lines    || [];

  odCurrentLines = lines;

  const fmt$ = n => {
    const abs = Math.abs(n);
    const s   = abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + '$' + s;
  };
  const fmtPct = n => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

  // ── KPI calculations ─────────────────────────────────────────
  const lineCount   = lines.length;
  const totQty      = lines.reduce((s, l) => s + l.qty, 0);
  const totExt      = lines.reduce((s, l) => s + l.extPrice, 0);
  const margin      = lines.reduce((s, l) => s + (l.unitPrice - l.unitCost) * l.qty, 0);
  const marginPct   = totExt > 0 ? (margin / totExt * 100) : 0;
  const avgLine     = lineCount > 0 ? totExt / lineCount : 0;
  const priorTotal  = parseFloat(order.priorOrderTotal || 0);
  const vsPriorPct  = priorTotal > 0 ? ((totExt - priorTotal) / priorTotal * 100) : null;

  // ── Composition counts ───────────────────────────────────────
  const bsLines     = lines.filter(l => l.isBestSeller);
  const repeatLines = lines.filter(l => l.isRepeat);
  const newLines    = lines.filter(l => !l.isRepeat);
  const bsPct       = lineCount > 0 ? (bsLines.length / lineCount * 100) : 0;
  const nonBsPct    = 100 - bsPct;
  const repeatPct   = lineCount > 0 ? (repeatLines.length / lineCount * 100) : 0;
  const newPct      = 100 - repeatPct;

  // ── Breadcrumb ───────────────────────────────────────────────
  const custSafe = custNo.replace(/'/g, "\\'");
  const breadcrumb = `
    <div style="display:flex;align-items:center;gap:6px;font-size:13px;color:#6b7280;margin-bottom:12px;flex-wrap:wrap">
      <a onclick="loadCustomerAccount('${custSafe}');return false;" href="#"
         style="color:#3d5a80;font-weight:600;text-decoration:none"
         onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">
        ← Customer Account
      </a>
      <span>·</span>
      <a onclick="loadCustomerAccount('${custSafe}');return false;" href="#"
         style="color:#3d5a80;font-weight:600;text-decoration:none"
         onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">
        ${custName}
      </a>
      <span>·</span>
      <span style="color:#1a2332;font-weight:600">Order ${ticketNo}</span>
    </div>`;

  // ── Order header ─────────────────────────────────────────────
  const header = `
    <div style="background:#1a2332;border-radius:8px;padding:16px 22px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.45);margin-bottom:2px">ORDER</div>
        <div style="font-size:24px;font-weight:800;color:#fff;line-height:1">#${ticketNo}</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:rgba(255,255,255,0.6)">
          <span>${date}</span>
          <span>·</span><span>${custName}</span>
          <span>·</span><span>Rep: ${rep}</span>
          ${storeNo ? `<span>·</span><span>Store: ${storeNo}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button onclick="orderDetailCopy()" style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Copy</button>
        <button onclick="orderDetailToast('Export PDF coming soon')" style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Export PDF</button>
        <button onclick="orderDetailToast('Reorder coming soon')" style="background:#0d9488;border:none;color:#fff;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Reorder</button>
      </div>
    </div>`;

  // ── KPI strip ────────────────────────────────────────────────
  const kpiPill = (label, value, sub, hero) => `
    <div style="background:${hero ? '#0f172a' : 'rgba(255,255,255,0.10)'};border:1px solid ${hero ? '#334155' : 'rgba(255,255,255,0.14)'};border-radius:8px;padding:13px 16px;flex:1;min-width:0;cursor:default;transition:background 0.15s,transform 0.15s"
         onmouseover="this.style.background='${hero ? '#1e293b' : 'rgba(255,255,255,0.18)'}';this.style.transform='translateY(-2px)'"
         onmouseout="this.style.background='${hero ? '#0f172a' : 'rgba(255,255,255,0.10)'}';this.style.transform=''">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:rgba(255,255,255,0.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
      <div style="font-size:${hero ? '26px' : '22px'};font-weight:800;color:#fff;line-height:1.15;margin-top:2px">${value}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:auto;padding-top:4px">${sub}</div>
    </div>`;

  const vsPriorValue = vsPriorPct !== null
    ? `<span style="color:${vsPriorPct >= 0 ? '#86efac' : '#fca5a5'}">${fmtPct(vsPriorPct)}</span>`
    : '—';
  const vsPriorSub = vsPriorPct !== null
    ? `${fmt$(totExt)} vs ${fmt$(priorTotal)}`
    : 'no prior order found';

  const kpiStrip = `
    <div style="background:#3d5a80;border-radius:8px;padding:14px 16px;margin-bottom:12px">
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${kpiPill('Order Total', fmt$(totExt), 'post-discount')}
        ${kpiPill('Margin', fmt$(margin), marginPct.toFixed(1) + '% margin', true)}
        ${kpiPill('Lines', lineCount.toLocaleString(), 'unique items')}
        ${kpiPill('Units', totQty.toLocaleString(), 'total qty')}
        ${kpiPill('Avg Line', fmt$(avgLine), 'revenue per line')}
        <div style="background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);border-radius:8px;padding:13px 16px;flex:1;min-width:0;cursor:default;transition:background 0.15s,transform 0.15s"
             onmouseover="this.style.background='rgba(255,255,255,0.18)';this.style.transform='translateY(-2px)'"
             onmouseout="this.style.background='rgba(255,255,255,0.10)';this.style.transform=''">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:rgba(255,255,255,0.9)">vs Prior Order</div>
          <div style="font-size:22px;font-weight:800;line-height:1.15;margin-top:2px">${vsPriorValue}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:auto;padding-top:4px">${vsPriorSub}</div>
        </div>
      </div>
    </div>`;

  // ── Composition bars ─────────────────────────────────────────
  const bar = (pctA, pctB, colA, colB, labelA, labelB, countA, countB) => `
    <div style="height:22px;border-radius:6px;overflow:hidden;display:flex;margin-bottom:10px">
      ${pctA > 0 ? `<div style="width:${pctA.toFixed(1)}%;background:${colA};transition:width 0.4s"></div>` : ''}
      ${pctB > 0 ? `<div style="width:${pctB.toFixed(1)}%;background:${colB};transition:width 0.4s"></div>` : ''}
    </div>
    <div style="display:flex;gap:16px;font-size:12px;color:#6b7280;flex-wrap:wrap">
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colA};margin-right:5px;vertical-align:middle"></span>${countA} lines · ${labelA}</span>
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colB};margin-right:5px;vertical-align:middle"></span>${countB} lines · ${labelB}</span>
    </div>`;

  const composition = lineCount > 0 ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div class="card" style="padding:16px 18px">
        <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Best-Seller Mix · top 250 items</div>
        ${bar(bsPct, nonBsPct, '#b45309', '#e5e7eb', 'best sellers', 'other items', bsLines.length, lineCount - bsLines.length)}
      </div>
      <div class="card" style="padding:16px 18px">
        <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">New vs Repeat · 12-month window</div>
        ${bar(repeatPct, newPct, '#0d9488', '#1d4ed8', 'repeat from last 12mo', 'new to customer', repeatLines.length, newLines.length)}
      </div>
    </div>` : '';

  // ── Filter toolbar ───────────────────────────────────────────
  const chipStyle = (active) =>
    `display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid ${active ? '#3d5a80' : '#d1d5db'};background:${active ? '#3d5a80' : '#fff'};color:${active ? '#fff' : '#374151'};transition:all 0.12s;font-family:inherit`;

  const toolbar = `
    <div id="od-toolbar" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;padding:0 2px">
      <input id="od-search" type="text" placeholder="Filter items by name, item #, or category…"
        oninput="odApplyFilter()"
        style="flex:1;min-width:160px;max-width:280px;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit;color:#1a2332;outline:none">
      <button id="od-chip-all"    onclick="odSetFilter('all')"    style="${chipStyle(true)}">All (${lineCount})</button>
      <button id="od-chip-best"   onclick="odSetFilter('best')"   style="${chipStyle(false)}">★ Best Sellers (${bsLines.length})</button>
      <button id="od-chip-new"    onclick="odSetFilter('new')"    style="${chipStyle(false)}">+ New (${newLines.length})</button>
      <button id="od-chip-repeat" onclick="odSetFilter('repeat')" style="${chipStyle(false)}">↻ Repeat (${repeatLines.length})</button>
      <select id="od-sort" onchange="odApplyFilter()"
        style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit;color:#374151;background:#fff;cursor:pointer;outline:none">
        <option value="ext">Ext $ (high → low)</option>
        <option value="item">Item #</option>
        <option value="qty">Qty</option>
        <option value="margin">Margin %</option>
      </select>
      <span id="od-row-count" style="font-size:12px;color:#9ca3af;margin-left:auto;white-space:nowrap">showing ${lineCount} of ${lineCount}</span>
    </div>`;

  // ── Line items table ─────────────────────────────────────────
  const tableWrap = `
    <div class="card" style="padding:0">
      <div style="padding:14px 16px 10px;border-bottom:1px solid #f3f4f6;flex-shrink:0">
        <div style="font-size:14px;font-weight:700;color:#1a2332">Line Items <span style="font-weight:400;color:#9ca3af;font-size:12px">(${lineCount} lines · ${fmt$(totExt)} total)</span></div>
      </div>
      ${toolbar}
      <div class="inv-wrap" id="od-table-wrap">
        ${odBuildTable(lines, lines, fmt$)}
      </div>
    </div>`;

  panel.innerHTML = breadcrumb + header + kpiStrip + composition + tableWrap;
  panel._orderData = { custName, ticketNo, date, rep, lines, total: totExt, margin };
}

// ── Table builder (used on initial render and re-filter) ──────

function odBuildTable(allLines, visibleLines, fmt$Fn) {
  const f = fmt$Fn || (n => {
    const abs = Math.abs(n);
    const s   = abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + '$' + s;
  });

  const stickyTd = 'position:sticky;bottom:0;z-index:2;background:#f8fafc;border-top:2px solid #e5e7eb;font-weight:700;box-shadow:0 -2px 4px rgba(0,0,0,0.06)';
  const totQty    = visibleLines.reduce((s, l) => s + l.qty, 0);
  const totExt    = visibleLines.reduce((s, l) => s + l.extPrice, 0);
  const totMargin = visibleLines.reduce((s, l) => s + (l.unitPrice - l.unitCost) * l.qty, 0);

  const tagPill = (label, bg, color) =>
    `<span style="background:${bg};color:${color};padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap">${label}</span>`;

  const tableRows = visibleLines.map(l => {
    const lineMargin = (l.unitPrice - l.unitCost) * l.qty;
    const tags = [];
    if (l.isBestSeller) tags.push(tagPill('★ Best',   '#fde68a', '#92400e'));
    if (l.isRepeat)     tags.push(tagPill('↻ Repeat', '#99f6e4', '#0f766e'));
    else if (l.isRepeat !== undefined) tags.push(tagPill('+ New', '#bfdbfe', '#1e40af'));
    return `<tr>
      <td style="padding:8px 12px;font-family:monospace;font-size:12px;font-weight:600;color:#3d5a80;white-space:nowrap">${l.itemNo}</td>
      <td style="padding:8px 12px;font-size:13px">${l.description || '—'}</td>
      <td style="padding:8px 12px;min-width:100px">
        <div style="display:flex;gap:4px;flex-wrap:wrap">${tags.join('') || ''}</div>
      </td>
      <td class="num-ctr" style="padding:8px 12px;font-size:13px">${l.qty}</td>
      <td class="num-ctr" style="padding:8px 12px;font-size:13px;color:#6b7280">${l.unitPrice > 0 ? f(l.unitPrice) : '—'}</td>
      <td class="num-ctr" style="padding:8px 12px;font-size:13px;font-weight:600">${l.extPrice > 0 ? f(l.extPrice) : '—'}</td>
      <td class="num-ctr" style="padding:8px 12px;font-size:13px;color:${lineMargin > 0 ? '#059669' : lineMargin < 0 ? '#dc2626' : '#9ca3af'}">${l.unitCost > 0 ? f(lineMargin) : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="padding:24px;color:#9ca3af;text-align:center">No matching items.</td></tr>';

  return `<table class="data-table">
    <thead style="position:sticky;top:0;z-index:2;background:#fff">
      <tr>
        <th>Item #</th>
        <th>Description</th>
        <th>Tags</th>
        <th class="num-ctr">Qty</th>
        <th class="num-ctr">Unit $</th>
        <th class="num-ctr">Ext $</th>
        <th class="num-ctr">Margin $</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
    <tfoot>
      <tr>
        <td colspan="3" style="${stickyTd};padding:10px 12px;color:#1a2332">Total · ${visibleLines.length} lines</td>
        <td class="num-ctr" style="${stickyTd};padding:10px 12px">${totQty}</td>
        <td style="${stickyTd};padding:10px 12px"></td>
        <td class="num-ctr" style="${stickyTd};padding:10px 12px">${f(totExt)}</td>
        <td class="num-ctr" style="${stickyTd};padding:10px 12px;color:${totMargin >= 0 ? '#059669' : '#dc2626'}">${totMargin !== 0 ? f(totMargin) : '—'}</td>
      </tr>
    </tfoot>
  </table>`;
}

// ── Filter / sort logic ───────────────────────────────────────

function odSetFilter(f) {
  odFilter = f;
  ['all', 'best', 'new', 'repeat'].forEach(id => {
    const btn = document.getElementById(`od-chip-${id}`);
    if (!btn) return;
    const active = id === f;
    btn.style.background    = active ? '#3d5a80' : '#fff';
    btn.style.color         = active ? '#fff'    : '#374151';
    btn.style.borderColor   = active ? '#3d5a80' : '#d1d5db';
  });
  odApplyFilter();
}

function odApplyFilter() {
  const searchEl = document.getElementById('od-search');
  const sortEl   = document.getElementById('od-sort');
  if (searchEl) odSearch = searchEl.value.toLowerCase();
  if (sortEl)   odSort   = sortEl.value;

  let list = odCurrentLines.slice();

  // Filter by chip
  if (odFilter === 'best')   list = list.filter(l => l.isBestSeller);
  if (odFilter === 'new')    list = list.filter(l => l.isRepeat === false);
  if (odFilter === 'repeat') list = list.filter(l => l.isRepeat === true);

  // Filter by search
  if (odSearch) {
    list = list.filter(l =>
      (l.itemNo      || '').toLowerCase().includes(odSearch) ||
      (l.description || '').toLowerCase().includes(odSearch)
    );
  }

  // Sort
  if (odSort === 'ext')    list.sort((a, b) => b.extPrice - a.extPrice);
  if (odSort === 'item')   list.sort((a, b) => (a.itemNo || '').localeCompare(b.itemNo || ''));
  if (odSort === 'qty')    list.sort((a, b) => b.qty - a.qty);
  if (odSort === 'margin') {
    list.sort((a, b) => {
      const mA = a.unitCost > 0 ? (a.unitPrice - a.unitCost) / a.unitPrice : 0;
      const mB = b.unitCost > 0 ? (b.unitPrice - b.unitCost) / b.unitPrice : 0;
      return mB - mA;
    });
  }

  const wrap = document.getElementById('od-table-wrap');
  if (wrap) wrap.innerHTML = odBuildTable(odCurrentLines, list);

  const rc = document.getElementById('od-row-count');
  if (rc) rc.textContent = `showing ${list.length} of ${odCurrentLines.length}`;
}

// ── Utility functions ─────────────────────────────────────────

function orderDetailToast(msg) {
  let t = document.getElementById('od-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'od-toast';
    t.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#1a2332;color:#fff;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:600;z-index:9999;opacity:0;transition:opacity 0.2s;pointer-events:none';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._hide);
  t._hide = setTimeout(() => { t.style.opacity = '0'; }, 2400);
}

function orderDetailCopy() {
  const panel = document.getElementById('customer-account-panel');
  const d = panel && panel._orderData;
  if (!d) return;
  const lines = (d.lines || []).map(l => {
    const m = (l.unitPrice - l.unitCost) * l.qty;
    return `${l.itemNo}\t${l.description}\t${l.qty}\t${l.unitPrice.toFixed(2)}\t${l.extPrice.toFixed(2)}\t${m.toFixed(2)}`;
  }).join('\n');
  const text = [
    `Order #${d.ticketNo}`,
    `Date: ${d.date}`,
    `Customer: ${d.custName}`,
    `Rep: ${d.rep}`,
    `Total: $${d.total.toFixed(2)}`,
    `Margin: $${d.margin.toFixed(2)}`,
    '',
    'Item #\tDescription\tQty\tUnit $\tExt $\tMargin $',
    lines,
  ].join('\n');
  navigator.clipboard.writeText(text).then(
    () => orderDetailToast('Copied to clipboard'),
    () => orderDetailToast('Copy failed — try again')
  );
}

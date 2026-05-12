// ============================================================
// ORDER DETAIL VIEW
// Route: #/customer/{custNo}/order/{ticketNo}
// ============================================================

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
      fetch(`/proxy/order-detail/${encodeURIComponent(ticketNo)}`),
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

  const custName = cust.name || order.custName || custNo;
  const ticketNo = order.ticketNo || '—';
  const date     = order.date     || '—';
  const rep      = order.rep      || cust.salesRep || '—';
  const storeNo  = order.storeNo  || '—';
  const total    = parseFloat(order.total || 0);
  const lines    = order.lines    || [];

  const fmt$ = n => {
    const abs = Math.abs(n);
    const s = abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + '$' + s;
  };

  // ── Breadcrumb ───────────────────────────────────────────────
  const breadcrumb = `
    <div style="display:flex;align-items:center;gap:6px;font-size:13px;color:#6b7280;margin-bottom:12px;flex-wrap:wrap">
      <a onclick="loadCustomerAccount('${custNo.replace(/'/g,"\\'")}');return false;" href="#"
         style="color:#3d5a80;font-weight:600;text-decoration:none"
         onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">
        ← Customer Account
      </a>
      <span>·</span>
      <a onclick="loadCustomerAccount('${custNo.replace(/'/g,"\\'")}');return false;" href="#"
         style="color:#3d5a80;font-weight:600;text-decoration:none"
         onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">
        ${custName}
      </a>
      <span>·</span>
      <span style="color:#1a2332;font-weight:600">Order ${ticketNo}</span>
    </div>`;

  // ── Order header bar ─────────────────────────────────────────
  const header = `
    <div style="background:#1a2332;border-radius:8px;padding:16px 22px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.45);margin-bottom:2px">ORDER</div>
        <div style="font-size:24px;font-weight:800;color:#fff;line-height:1">#${ticketNo}</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:rgba(255,255,255,0.6)">
          <span>${date}</span>
          <span>·</span>
          <span>${custName}</span>
          <span>·</span>
          <span>Rep: ${rep}</span>
          ${storeNo && storeNo !== '—' ? `<span>·</span><span>Store: ${storeNo}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button onclick="orderDetailCopy()" style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
          Copy
        </button>
        <button onclick="orderDetailToast('Export PDF coming soon')" style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
          Export PDF
        </button>
        <button onclick="orderDetailToast('Reorder coming soon')" style="background:#0d9488;border:1px solid #0d9488;color:#fff;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
          Reorder
        </button>
      </div>
    </div>`;

  // ── Line items table ─────────────────────────────────────────
  const stickyTd = 'position:sticky;bottom:0;z-index:2;background:#f8fafc;border-top:2px solid #e5e7eb;font-weight:700;box-shadow:0 -2px 4px rgba(0,0,0,0.06)';
  const totQty   = lines.reduce((s, l) => s + l.qty, 0);
  const totExt   = lines.reduce((s, l) => s + l.extPrice, 0);

  const tableRows = lines.map(l => `<tr>
    <td style="padding:8px 12px;font-family:monospace;font-size:12px;font-weight:600;color:#3d5a80;white-space:nowrap">${l.itemNo}</td>
    <td style="padding:8px 12px;font-size:13px">${l.description || '—'}</td>
    <td class="num-ctr" style="padding:8px 12px;font-size:13px">${l.qty}</td>
    <td class="num-ctr" style="padding:8px 12px;font-size:13px;color:#6b7280">${l.unitPrice > 0 ? fmt$(l.unitPrice) : '—'}</td>
    <td class="num-ctr" style="padding:8px 12px;font-size:13px;font-weight:600">${l.extPrice > 0 ? fmt$(l.extPrice) : '—'}</td>
  </tr>`).join('') || '<tr><td colspan="5" style="padding:24px;color:#9ca3af;text-align:center">No line items found.</td></tr>';

  const tableHTML = `
    <div class="card" style="padding:0">
      <div style="padding:14px 16px 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f3f4f6;flex-shrink:0">
        <div style="font-size:14px;font-weight:700;color:#1a2332">Line Items <span style="font-weight:400;color:#9ca3af;font-size:12px">(${lines.length} lines · ${fmt$(total)} total)</span></div>
      </div>
      <div class="inv-wrap" style="max-height:600px">
        <table class="data-table">
          <thead style="position:sticky;top:0;z-index:2;background:#fff">
            <tr>
              <th>Item #</th>
              <th>Description</th>
              <th class="num-ctr">Qty</th>
              <th class="num-ctr">Unit $</th>
              <th class="num-ctr">Ext $</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
          <tfoot>
            <tr>
              <td colspan="2" style="${stickyTd};padding:10px 12px;color:#1a2332">Total · ${lines.length} lines</td>
              <td class="num-ctr" style="${stickyTd};padding:10px 12px">${totQty}</td>
              <td style="${stickyTd};padding:10px 12px"></td>
              <td class="num-ctr" style="${stickyTd};padding:10px 12px;color:#1a2332">${fmt$(totExt)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>`;

  panel.innerHTML = breadcrumb + header + tableHTML;

  // Store for copy button
  panel._orderData = { custName, ticketNo, date, rep, lines, total };
}

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
  const lines = (d.lines || []).map(l =>
    `${l.itemNo}\t${l.description}\t${l.qty}\t${l.unitPrice.toFixed(2)}\t${l.extPrice.toFixed(2)}`
  ).join('\n');
  const text = `Order #${d.ticketNo}\nDate: ${d.date}\nCustomer: ${d.custName}\nRep: ${d.rep}\nTotal: $${d.total.toFixed(2)}\n\nItem #\tDescription\tQty\tUnit $\tExt $\n${lines}`;
  navigator.clipboard.writeText(text).then(
    () => orderDetailToast('Copied to clipboard'),
    () => orderDetailToast('Copy failed — try again')
  );
}

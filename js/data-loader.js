// ============================================================
// DATA LOADER — Kellis Sales proxy API
// Start with: node server/proxy.js
// ============================================================

const BASE = '/proxy';

function setLoadMsg(msg) {
  const el = document.getElementById('load-msg');
  if (el) el.textContent = msg;
}

function setLoadProgress(pct) {
  const bar = document.querySelector('.load-bar-inner');
  if (bar) bar.style.width = Math.min(100, Math.round(pct)) + '%';
}

// ── Boot: show rep picker immediately (no API call needed) ────

async function loadData() {
  show('loading-screen');
  setLoadMsg('Loading sales reps…');
  setLoadProgress(20);

  try {
    const resp = await fetch(`${BASE}/reps`);
    if (!resp.ok) throw new Error(`Proxy not reachable (${resp.status}). Is node server/proxy.js running?`);
    const reps = await resp.json();
    setLoadProgress(100);
    hide('loading-screen');
    showRepPicker(reps);
  } catch (err) {
    setLoadMsg('Error: ' + err.message);
    const el = document.getElementById('load-msg');
    if (el) el.style.color = '#dc2626';
    console.error(err);
  }
}

// ── Background prefetch for Item Performance ──────────────────

async function prefetchItemPerformance(rep) {
  if (typeof ipCatData === 'undefined' || typeof ipLoading === 'undefined') return;
  if (ipCatData.length || ipLoading) return;
  try {
    ipLoading = true;
    const repParam = rep ? `?rep=${encodeURIComponent(rep)}` : '';
    const resp = await fetch(`${BASE}/all-categories${repParam}`);
    ipCatData = resp.ok ? await resp.json() : [];
  } catch (_) {
  } finally {
    ipLoading = false;
  }
}

// ── Rep picker screen ─────────────────────────────────────────

function showRepPicker(reps) {
  const appEl = document.getElementById('app-content');
  if (appEl) appEl.style.display = 'none';

  let picker = document.getElementById('rep-picker-screen');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'rep-picker-screen';
    picker.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;padding:60px 20px;text-align:center;background:#f0f2f5';
    document.body.insertBefore(picker, document.querySelector('.dash-footer'));
  }

  const options = reps.map(r => `<option value="${r.id}">${r.name}</option>`).join('');

  picker.innerHTML = `
    <div style="background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.10);padding:48px 56px;max-width:420px;width:100%">
      <div style="width:48px;height:48px;background:#3d5a80;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff;margin:0 auto 20px">KS</div>
      <div style="font-size:22px;font-weight:700;color:#1a2332;margin-bottom:6px">Kellis Sales</div>
      <div style="font-size:14px;color:#6b7280;margin-bottom:28px">Select your sales rep to continue</div>
      <select id="rep-select" style="width:100%;border:1px solid #d1d5db;border-radius:8px;padding:10px 14px;font-size:15px;font-family:inherit;color:#1a2332;background:#fff;outline:none;margin-bottom:20px">
        <option value="" disabled selected>Choose a rep…</option>
        ${options}
      </select>
      <button id="rep-go-btn" onclick="loadAccountsForRep()"
        style="width:100%;background:#3d5a80;color:#fff;border:none;border-radius:8px;padding:11px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer">
        View Accounts →
      </button>
      <div id="rep-picker-error" style="margin-top:12px;font-size:13px;color:#dc2626;display:none">Please select a rep.</div>
    </div>`;

  picker.style.display = 'flex';

  document.getElementById('rep-select').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadAccountsForRep();
  });
}

// ── Load accounts for selected rep ───────────────────────────

async function loadAccountsForRep() {
  const select = document.getElementById('rep-select');
  const errEl  = document.getElementById('rep-picker-error');
  const rep    = select ? select.value : '';

  if (!rep) {
    if (errEl) errEl.style.display = 'block';
    return;
  }
  if (errEl) errEl.style.display = 'none';

  const btn = document.getElementById('rep-go-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  try {
    const resp = await fetch(`${BASE}/accounts?rep=${encodeURIComponent(rep)}`);
    if (!resp.ok) throw new Error(`Failed to load accounts (${resp.status})`);
    accountsData = await resp.json();
    currentRep   = rep;

    const picker = document.getElementById('rep-picker-screen');
    if (picker) picker.style.display = 'none';
    const appEl = document.getElementById('app-content');
    if (appEl) appEl.style.display = 'flex';

    dataReady = true;

    const ts = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
    const footer = document.getElementById('dash-footer-ts');
    if (footer) footer.textContent = `Data as of ${ts}`;

    const status = document.getElementById('toolbar-status');
    if (status) status.textContent = `${rep} · ${accountsData.length} accounts`;

    switchTab('store');
    prefetchItemPerformance(rep);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'View Accounts →'; }
    const errEl = document.getElementById('rep-picker-error');
    if (errEl) { errEl.textContent = 'Error: ' + err.message; errEl.style.display = 'block'; }
    console.error(err);
  }
}

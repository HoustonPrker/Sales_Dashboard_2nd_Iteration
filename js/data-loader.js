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
  const pctEl = document.getElementById('load-pct');
  const p = Math.min(100, Math.round(pct));
  if (bar) bar.style.width = p + '%';
  if (pctEl) pctEl.textContent = p + '%';
}

// Animate progress bar from startPct toward 90% over estSeconds, returns cancel fn
function startProgressAnimation(startPct, estSeconds) {
  const startTime = Date.now();
  const etaEl = document.getElementById('load-eta');
  let cancelled = false;

  function tick() {
    if (cancelled) return;
    const elapsed = (Date.now() - startTime) / 1000;
    // Ease toward 90% asymptotically — never reaches 90% until done
    const pct = startPct + (90 - startPct) * (1 - Math.exp(-elapsed / estSeconds));
    setLoadProgress(pct);

    const remaining = Math.max(0, Math.round(estSeconds - elapsed));
    if (etaEl) {
      etaEl.textContent = remaining > 0
        ? `~${remaining}s remaining`
        : 'Almost done…';
    }
    requestAnimationFrame(tick);
  }

  tick();
  return () => {
    cancelled = true;
    if (etaEl) etaEl.textContent = '';
  };
}

// ── Boot: show rep picker immediately (no API call needed) ────

async function loadData() {
  show('loading-screen');
  setLoadMsg('Loading…');
  setLoadProgress(20);

  const user = getKsUser();
  if (!user) return; // checkAuth() will redirect if not logged in

  // If manager/admin is viewing as a rep, load that rep's data
  const viewAs = user.scoped_view_as;

  try {
    if (viewAs && ['manager', 'admin'].includes(user.role)) {
      setLoadMsg(`Loading ${viewAs.displayName}'s accounts…`);
      setLoadProgress(0);
      await loadAccountsForRep(viewAs.rep_prefix);
    } else if (user.role === 'advisor') {
      setLoadMsg('Loading your accounts…');
      setLoadProgress(0);
      await loadAccountsForRep(user.rep_prefix || '');
    } else {
      setLoadMsg('Loading all accounts…');
      setLoadProgress(0);
      await loadAccountsForRep('ALL');
    }
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

function showRepPicker(reps, user) {
  const appEl = document.getElementById('app-content');
  if (appEl) appEl.style.display = 'none';

  let picker = document.getElementById('rep-picker-screen');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'rep-picker-screen';
    picker.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;padding:60px 20px;text-align:center;background:#f0f2f5';
    document.body.insertBefore(picker, document.querySelector('.dash-footer'));
  }

  const allOption = `<option value="ALL">All Reps (Combined)</option>`;
  const repOptions = reps.map(r => `<option value="${r.id}">${r.name}</option>`).join('');

  picker.innerHTML = `
    <div style="background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.10);padding:48px 56px;max-width:420px;width:100%">
      <div style="width:48px;height:48px;background:#3d5a80;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff;margin:0 auto 20px">KS</div>
      <div style="font-size:22px;font-weight:700;color:#1a2332;margin-bottom:6px">Kellis Sales</div>
      <div style="font-size:14px;color:#6b7280;margin-bottom:28px">Welcome, ${user.displayName}. Select a view to continue.</div>
      <select id="rep-select" style="width:100%;border:1px solid #d1d5db;border-radius:8px;padding:10px 14px;font-size:15px;font-family:inherit;color:#1a2332;background:#fff;outline:none;margin-bottom:20px">
        ${allOption}
        ${repOptions}
      </select>
      <button id="rep-go-btn" onclick="loadAccountsForRep()"
        style="width:100%;background:#3d5a80;color:#fff;border:none;border-radius:8px;padding:11px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer">
        View Accounts →
      </button>
      <div id="rep-picker-error" style="margin-top:12px;font-size:13px;color:#dc2626;display:none">Please select a view.</div>
    </div>`;

  picker.style.display = 'flex';
  document.getElementById('rep-select').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadAccountsForRep();
  });
}

// ── Load accounts for selected rep ───────────────────────────

async function loadAccountsForRep(repOverride) {
  const select = document.getElementById('rep-select');
  const rep    = repOverride || (select ? select.value : '');
  const errEl  = document.getElementById('rep-picker-error');

  if (!rep) { if (errEl) errEl.style.display = 'block'; return; }
  if (errEl) errEl.style.display = 'none';

  const btn = document.getElementById('rep-go-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  setLoadMsg('Loading accounts…');
  setLoadProgress(0);
  show('loading-screen');

  // Animate progress — estimate 15s for cold load, 2s if cache is likely warm
  const estSecs = 15;
  const cancelAnim = startProgressAnimation(0, estSecs);

  try {
    const url  = `${BASE}/accounts?rep=${encodeURIComponent(rep)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load accounts (${resp.status})`);
    accountsData = await resp.json();
    currentRep   = rep;

    cancelAnim();
    setLoadProgress(100);
    await new Promise(r => setTimeout(r, 300)); // brief pause at 100%
    hide('loading-screen');
    const picker = document.getElementById('rep-picker-screen');
    if (picker) picker.style.display = 'none';
    const appEl = document.getElementById('app-content');
    if (appEl) appEl.style.display = 'flex';

    dataReady = true;

    const ts = new Date().toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
    const footer = document.getElementById('dash-footer-ts');
    if (footer) footer.textContent = `Data as of ${ts}`;

    const label  = rep === 'ALL' ? 'All Reps' : rep;
    const status = document.getElementById('toolbar-status');
    if (status) status.textContent = `${label} · ${accountsData.length} accounts`;

    switchTab('store');
    prefetchItemPerformance(rep);
    // Fetch advisor name→prefix map for the Rep column filter
    fetch('/auth/advisors').then(r => r.ok ? r.json() : []).then(d => { acctAdvisors = d; }).catch(() => { acctAdvisors = []; });
  } catch (err) {
    cancelAnim();
    hide('loading-screen');
    if (btn) { btn.disabled = false; btn.textContent = 'View Accounts →'; }
    const errEl2 = document.getElementById('rep-picker-error');
    if (errEl2) { errEl2.textContent = 'Error: ' + err.message; errEl2.style.display = 'block'; }
    console.error(err);
  }
}

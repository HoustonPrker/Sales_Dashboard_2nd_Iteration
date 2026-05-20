// ── Auth — cookie-based ───────────────────────────────────────
// The browser sends kellis_session cookie automatically.
// We store user info in a JS variable only (not localStorage).

let ksUser = null;  // { username, displayName, role, rep_ids, is_super_admin }

function getKsUser() { return ksUser; }

async function checkAuth() {
  try {
    const r = await fetch('/auth/me');
    if (r.status === 401) { window.location.href = '/login.html'; return; }
    if (!r.ok) { window.location.href = '/login.html'; return; }
    ksUser = await r.json();
    renderNavUser(ksUser);
    if (ksUser.scoped_view_as) showViewAsBanner(ksUser.scoped_view_as);
    if (typeof loadData === 'function') loadData();
  } catch {
    window.location.href = '/login.html';
  }
}

function renderNavUser(user) {
  const el = document.getElementById('nav-user-info');
  if (!el) return;
  const roleLabel = user.is_super_admin ? 'Super Admin'
    : { admin: 'Admin', manager: 'Manager', advisor: 'Advisor', customer_service: 'CS' }[user.role] || user.role;
  const roleBg = user.is_super_admin ? '#b91c1c'
    : { admin: '#7c3aed', manager: '#0d9488', advisor: '#3d5a80', customer_service: '#b45309' }[user.role] || '#6b7280';
  const gearBtn = user.role === 'admin' ? `
    <a href="/admin/users" title="Account Manager" style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:5px;background:rgba(255,255,255,0.1);color:#cbd5e1;text-decoration:none;font-size:15px;transition:background 0.15s" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">⚙</a>
  ` : '';
  el.innerHTML = `
    <span style="font-size:13px;color:#cbd5e1">${user.displayName}</span>
    <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;background:${roleBg};color:#fff;text-transform:uppercase;letter-spacing:0.05em">${roleLabel}</span>
    ${gearBtn}
    <button onclick="ksLogout()" style="background:rgba(255,255,255,0.1);border:none;color:#cbd5e1;padding:4px 10px;border-radius:5px;font-size:12px;cursor:pointer;font-family:inherit">Logout</button>
  `;

  // Tab visibility by role
  // advisor:          Account Perf, Customer Account, Item Perf, Leaderboard
  // customer_service: Account Perf, Customer Account, Item Perf
  // manager:          all four + Rep Performance
  // admin:            all four + Rep Performance
  const showLeaderboard = ['advisor', 'manager', 'admin'].includes(user.role);
  const lb = document.getElementById('tab-btn-leaderboard');
  if (lb) lb.style.display = showLeaderboard ? '' : 'none';

  const showRp = ['manager', 'admin'].includes(user.role);
  const rpBtn = document.getElementById('tab-btn-rp');
  if (rpBtn) rpBtn.style.display = showRp ? '' : 'none';
}

async function startViewAs(username) {
  const r = await fetch(`/auth/view-as/${encodeURIComponent(username)}`, { method: 'POST' });
  if (!r.ok) { alert('Could not switch view'); return; }
  const data = await r.json();
  ksUser = { ...ksUser, scoped_view_as: data.scoped_view_as };
  showViewAsBanner(data.scoped_view_as);
  if (typeof loadData === 'function') loadData();
}

async function exitViewAs() {
  await fetch('/auth/view-as', { method: 'DELETE' });
  ksUser = { ...ksUser, scoped_view_as: null };
  hideViewAsBanner();
  if (typeof switchTab === 'function') switchTab('rp');
  if (typeof loadData === 'function') loadData();
}

function showViewAsBanner(scopedUser) {
  const banner = document.getElementById('view-as-banner');
  const nameEl = document.getElementById('view-as-name');
  if (!banner) return;
  if (nameEl) nameEl.textContent = `${scopedUser.displayName} (${scopedUser.rep_prefix})`;
  banner.style.display = 'flex';
  // Hide rep performance tab while in view-as mode
  const rpBtn = document.getElementById('tab-btn-rp');
  if (rpBtn) rpBtn.style.display = 'none';
}

function hideViewAsBanner() {
  const banner = document.getElementById('view-as-banner');
  if (banner) banner.style.display = 'none';
  // Restore rep performance tab
  const user = getKsUser();
  const rpBtn = document.getElementById('tab-btn-rp');
  if (rpBtn) rpBtn.style.display = ['manager', 'admin'].includes(user?.role) ? '' : 'none';
}

async function ksLogout() {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/login.html';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkAuth);
} else {
  checkAuth();
}

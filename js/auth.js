// ── Auth state ────────────────────────────────────────────────
const KS_TOKEN_KEY = 'ks_auth_token';
const KS_USER_KEY  = 'ks_auth_user';

function getToken() { return localStorage.getItem(KS_TOKEN_KEY); }
function getUser()  { const u = localStorage.getItem(KS_USER_KEY); try { return u ? JSON.parse(u) : null; } catch { return null; } }

function setAuth(token, user) {
  localStorage.setItem(KS_TOKEN_KEY, token);
  localStorage.setItem(KS_USER_KEY, JSON.stringify(user));
}

function clearAuth() {
  localStorage.removeItem(KS_TOKEN_KEY);
  localStorage.removeItem(KS_USER_KEY);
}

// Intercept all /proxy/ fetches to inject Bearer token
const _origFetch = window.fetch.bind(window);
window.fetch = function(url, opts) {
  opts = opts || {};
  const token = getToken();
  if (token && typeof url === 'string' && url.startsWith('/proxy/')) {
    opts = { ...opts, headers: { ...(opts.headers || {}), 'Authorization': 'Bearer ' + token } };
  }
  return _origFetch(url, opts).then(function(res) {
    if (res.status === 401 && typeof url === 'string' && url.startsWith('/proxy/') && !url.includes('/proxy/auth/')) {
      clearAuth();
      window.location.href = '/login.html';
    }
    return res;
  });
};

async function checkAuth() {
  const token = getToken();
  if (!token) { window.location.href = '/login.html'; return; }
  try {
    const r = await _origFetch('/proxy/auth/me', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) { clearAuth(); window.location.href = '/login.html'; return; }
    const user = await r.json();
    localStorage.setItem(KS_USER_KEY, JSON.stringify(user));
    renderNavUser(user);
  } catch {
    // Network error — let user proceed with cached user info if available
    const cached = getUser();
    if (cached) renderNavUser(cached);
    else { clearAuth(); window.location.href = '/login.html'; }
  }
}

function renderNavUser(user) {
  const el = document.getElementById('nav-user-info');
  if (!el) return;
  const roleLabel = { admin: 'Admin', manager: 'Manager', customer_advisor: 'Advisor' }[user.role] || user.role;
  const roleBg    = { admin: '#7c3aed', manager: '#0d9488', customer_advisor: '#3d5a80' }[user.role] || '#6b7280';
  el.innerHTML = `
    <span style="font-size:13px;color:#cbd5e1">${user.displayName || user.userId}</span>
    <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;background:${roleBg};color:#fff;text-transform:uppercase;letter-spacing:0.05em">${roleLabel}</span>
    <button onclick="ksLogout()" style="background:rgba(255,255,255,0.1);border:none;color:#cbd5e1;padding:4px 10px;border-radius:5px;font-size:12px;cursor:pointer;font-family:inherit">Logout</button>
  `;
}

async function ksLogout() {
  const token = getToken();
  if (token) {
    await _origFetch('/proxy/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(function() {});
  }
  clearAuth();
  window.location.href = '/login.html';
}

// Run on load
checkAuth();

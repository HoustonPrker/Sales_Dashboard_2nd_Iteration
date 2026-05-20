// ============================================================
// Account Manager — admin UI
// ============================================================

let amUsers     = [];
let panelMode   = null;   // 'create' | 'edit'
let editTarget  = null;   // username being edited
let deactTarget = null;
let reactTarget = null;
let deleteTarget = null;
let currentUser = null;   // logged-in user from /auth/me

const ROLE_ORDER  = ['admin', 'manager', 'advisor', 'customer_service'];
const ROLE_LABELS = { admin: 'Admins', manager: 'Managers', advisor: 'Advisors', customer_service: 'Customer Service' };

// ── Boot ─────────────────────────────────────────────────────

async function amInit() {
  try {
    const me = await fetch('/auth/me');
    if (me.status === 401) { window.location.href = '/login.html'; return; }
    currentUser = await me.json();
    if (currentUser.role !== 'admin') { window.location.href = '/'; return; }
    document.getElementById('am-nav-user').textContent = currentUser.displayName;
    // Hide Admin option in role dropdown if not super_admin
    if (!currentUser.is_super_admin) {
      const opt = document.getElementById('opt-admin');
      if (opt) opt.remove();
    }
    await loadUsers();
    document.getElementById('btn-create').addEventListener('click', () => openPanel('create'));
  } catch (e) {
    window.location.href = '/login.html';
  }
}

async function loadUsers() {
  try {
    const r = await fetch('/proxy/admin/users');
    if (!r.ok) throw new Error('Failed to load users');
    const data = await r.json();
    amUsers = data.users || [];
    renderPage();
  } catch (e) {
    document.getElementById('am-content').innerHTML =
      `<div style="padding:40px;text-align:center;color:#dc2626">Failed to load users: ${e.message}</div>`;
  }
}

// ── Render ───────────────────────────────────────────────────

function renderPage() {
  const grouped = {};
  for (const role of ROLE_ORDER) grouped[role] = [];
  for (const u of amUsers) {
    if (grouped[u.role]) grouped[u.role].push(u);
    else grouped['advisor'] && grouped['advisor'].push(u);
  }
  // Sort: within admins, super_admin first; others alphabetically
  grouped.admin.sort((a, b) => (b.is_super_admin ? 1 : 0) - (a.is_super_admin ? 1 : 0) || a.displayName.localeCompare(b.displayName));
  for (const role of ['manager', 'advisor', 'customer_service'])
    grouped[role].sort((a, b) => a.displayName.localeCompare(b.displayName));

  const html = ROLE_ORDER.map(role => renderSection(role, grouped[role])).join('');
  document.getElementById('am-content').innerHTML = html;

  // Re-attach toggle handlers
  document.querySelectorAll('.am-section-header').forEach(h => {
    h.addEventListener('click', () => {
      const body    = h.nextElementSibling;
      const chevron = h.querySelector('.am-section-chevron');
      body.classList.toggle('open');
      chevron.classList.toggle('open');
    });
  });
}

function renderSection(role, users) {
  const label   = ROLE_LABELS[role] || role;
  const bodyOpen = role === 'admin' ? 'open' : 'open'; // all open by default
  return `
  <div class="am-section">
    <div class="am-section-header">
      <span class="am-section-label">
        ${label}
        <span class="am-section-count">${users.length}</span>
      </span>
      <span class="am-section-chevron open">▼</span>
    </div>
    <div class="am-section-body ${bodyOpen}">
      <table class="am-table">
        <thead><tr>
          <th>Display Name</th>
          <th>Username</th>
          <th>Rep Prefix</th>
          <th>Status</th>
          <th>Notes</th>
          <th>Actions</th>
        </tr></thead>
        <tbody>${users.map(u => renderRow(u)).join('')}</tbody>
      </table>
    </div>
  </div>`;
}

function renderRow(u) {
  const isSelf       = currentUser && u.username === currentUser.username;
  const isAdminUser  = u.role === 'admin';
  const canEdit      = !isAdminUser || currentUser.is_super_admin;
  const canDeact     = !isSelf && canEdit;
  const canDelete    = currentUser.is_super_admin && !isSelf;

  const roleCls  = u.is_super_admin ? 'role-super-admin' : `role-${u.role}`;
  const roleLabel = u.is_super_admin ? 'Super Admin' : u.role.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
  const crown    = u.is_super_admin ? '<span class="super-crown" title="Super Admin">★</span>' : '';
  const status   = u.active
    ? '<span class="status-active">Active</span>'
    : '<span class="status-inactive">Inactive</span>';

  const editTip   = canEdit ? '' : 'title="Only super-admins can edit admin accounts"';
  const deactBtn  = u.active
    ? `<button class="btn-sm btn-deact" ${canDeact ? `onclick="confirmDeactivate('${u.username}')"` : 'disabled title="Cannot deactivate this account"'}>${canDeact ? 'Deactivate' : '—'}</button>`
    : `<button class="btn-sm btn-react" ${canDeact ? `onclick="confirmReactivate('${u.username}')"` : 'disabled'}>Reactivate</button>`;
  const delTitle  = canDelete ? '' : (isSelf ? 'title="Cannot delete your own account"' : 'title="Only super-admins can permanently delete users"');

  return `<tr>
    <td>
      <span style="font-weight:600">${esc(u.displayName)}</span>${crown}
      ${isSelf ? '<span style="font-size:11px;color:#94a3b8;margin-left:6px">(you)</span>' : ''}
    </td>
    <td><span class="mono">${esc(u.username)}</span></td>
    <td><span class="mono">${u.rep_prefix ? esc(u.rep_prefix) : '<span style="color:#cbd5e1">—</span>'}</span></td>
    <td>${status}</td>
    <td class="notes-cell" title="${esc(u.notes || '')}">${esc((u.notes || '').slice(0, 60))}</td>
    <td>
      <div class="am-actions">
        <button class="btn-sm btn-edit" ${editTip} ${canEdit ? `onclick="openPanel('edit','${u.username}')"` : 'disabled'}>Edit</button>
        ${deactBtn}
        <button class="btn-sm btn-del" ${delTitle} ${canDelete ? `onclick="confirmDelete('${u.username}')"` : 'disabled'}>Delete</button>
      </div>
    </td>
  </tr>`;
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Panel ────────────────────────────────────────────────────

function openPanel(mode, username) {
  panelMode  = mode;
  editTarget = username || null;
  clearPanelErrors();
  document.getElementById('panel-error').classList.remove('visible');

  if (mode === 'create') {
    document.getElementById('panel-title').textContent    = 'Create User';
    document.getElementById('btn-panel-save').textContent = 'Create User';
    document.getElementById('f-username').value     = '';
    document.getElementById('f-username').disabled  = false;
    document.getElementById('f-displayname').value  = '';
    document.getElementById('f-role').value         = 'advisor';
    document.getElementById('f-prefix').value       = '';
    document.getElementById('f-active').checked     = true;
    document.getElementById('f-notes').value        = '';
    onRoleChange();
  } else {
    const u = amUsers.find(x => x.username === username);
    if (!u) return;
    document.getElementById('panel-title').textContent    = 'Edit User';
    document.getElementById('btn-panel-save').textContent = 'Save Changes';
    document.getElementById('f-username').value     = u.username;
    document.getElementById('f-username').disabled  = true;
    document.getElementById('f-displayname').value  = u.displayName;
    document.getElementById('f-role').value         = u.role;
    document.getElementById('f-prefix').value       = u.rep_prefix || '';
    document.getElementById('f-active').checked     = u.active;
    document.getElementById('f-notes').value        = u.notes || '';

    // Disable role + active if editing self
    const isSelf = currentUser && u.username === currentUser.username;
    document.getElementById('f-role').disabled   = isSelf;
    document.getElementById('f-active').disabled = isSelf;
    onRoleChange();
  }

  document.getElementById('panel-overlay').classList.add('open');
  document.getElementById('am-panel').classList.add('open');
}

function closePanel() {
  document.getElementById('panel-overlay').classList.remove('open');
  document.getElementById('am-panel').classList.remove('open');
  panelMode  = null;
  editTarget = null;
}

function onRoleChange() {
  // Rep prefix label hint update
  const role  = document.getElementById('f-role').value;
  const hint  = document.getElementById('f-prefix').nextElementSibling;
  if (role === 'advisor') {
    hint.textContent = 'Required for advisors with a sales book.';
  } else {
    hint.textContent = 'Leave blank if this user has no sales book.';
  }
}

function clearPanelErrors() {
  ['err-username','err-displayname','err-role','err-prefix'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.classList.remove('visible'); }
  });
}

function showFieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.add('visible'); }
}

async function submitPanel() {
  clearPanelErrors();
  document.getElementById('panel-error').classList.remove('visible');

  const username    = document.getElementById('f-username').value.trim().toLowerCase();
  const displayName = document.getElementById('f-displayname').value.trim();
  const role        = document.getElementById('f-role').value;
  const prefix      = document.getElementById('f-prefix').value.trim().toUpperCase() || null;
  const active      = document.getElementById('f-active').checked;
  const notes       = document.getElementById('f-notes').value.trim();

  let valid = true;
  if (!username) { showFieldError('err-username', 'Username is required'); valid = false; }
  if (!displayName) { showFieldError('err-displayname', 'Display name is required'); valid = false; }
  if (!valid) return;

  const btn = document.getElementById('btn-panel-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    let r;
    if (panelMode === 'create') {
      r = await fetch('/proxy/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName, role, rep_prefix: prefix, active, notes }),
      });
    } else {
      const u = amUsers.find(x => x.username === editTarget);
      const isSelf = currentUser && editTarget === currentUser.username;
      const body = { displayName, rep_prefix: prefix, notes };
      if (!isSelf) { body.role = role; body.active = active; }
      r = await fetch(`/proxy/admin/users/${encodeURIComponent(editTarget)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    if (r.ok) {
      closePanel();
      await loadUsers();
      toast(panelMode === 'create' ? `User ${username} created` : 'Changes saved');
    } else {
      const data = await r.json();
      const errEl = document.getElementById('panel-error');
      errEl.textContent = data.error || 'An error occurred';
      errEl.classList.add('visible');
    }
  } catch (e) {
    const errEl = document.getElementById('panel-error');
    errEl.textContent = 'Network error — please try again';
    errEl.classList.add('visible');
  } finally {
    btn.disabled = false;
    btn.textContent = panelMode === 'create' ? 'Create User' : 'Save Changes';
  }
}

// ── Deactivate ───────────────────────────────────────────────

function confirmDeactivate(username) {
  deactTarget = username;
  const u = amUsers.find(x => x.username === username);
  document.getElementById('deact-body').textContent =
    `Deactivate ${u?.displayName || username}? They will be unable to sign in but their record is preserved.`;
  openModal('modal-deact');
}

async function doDeactivate() {
  if (!deactTarget) return;
  const btn = document.getElementById('btn-deact-confirm');
  btn.disabled = true;
  try {
    const r = await fetch(`/proxy/admin/users/${encodeURIComponent(deactTarget)}/deactivate`, { method: 'POST' });
    if (r.ok) {
      closeModal('modal-deact');
      await loadUsers();
      toast(`${deactTarget} deactivated`);
    } else {
      const d = await r.json();
      toast(d.error || 'Failed to deactivate', 'error');
    }
  } catch { toast('Network error', 'error'); }
  finally { btn.disabled = false; deactTarget = null; }
}

// ── Reactivate ───────────────────────────────────────────────

function confirmReactivate(username) {
  reactTarget = username;
  const u = amUsers.find(x => x.username === username);
  document.getElementById('react-body').textContent =
    `Reactivate ${u?.displayName || username}? They will be able to sign in again.`;
  openModal('modal-react');
}

async function doReactivate() {
  if (!reactTarget) return;
  const btn = document.getElementById('btn-react-confirm');
  btn.disabled = true;
  try {
    const r = await fetch(`/proxy/admin/users/${encodeURIComponent(reactTarget)}/activate`, { method: 'POST' });
    if (r.ok) {
      closeModal('modal-react');
      await loadUsers();
      toast(`${reactTarget} reactivated`);
    } else {
      const d = await r.json();
      toast(d.error || 'Failed to reactivate', 'error');
    }
  } catch { toast('Network error', 'error'); }
  finally { btn.disabled = false; reactTarget = null; }
}

// ── Hard delete ──────────────────────────────────────────────

function confirmDelete(username) {
  deleteTarget = username;
  const u = amUsers.find(x => x.username === username);
  document.getElementById('delete-body').textContent =
    `Permanently delete ${u?.displayName || username} (${username})? This cannot be undone. They will be removed from the user list entirely.`;
  document.getElementById('delete-confirm-input').value = '';
  document.getElementById('delete-confirm-input').placeholder = username;
  document.getElementById('btn-delete-confirm').disabled = true;
  openModal('modal-delete');
}

function onDeleteInput() {
  const val = document.getElementById('delete-confirm-input').value.trim().toLowerCase();
  document.getElementById('btn-delete-confirm').disabled = val !== (deleteTarget || '').toLowerCase();
}

async function doHardDelete() {
  if (!deleteTarget) return;
  const btn = document.getElementById('btn-delete-confirm');
  btn.disabled = true;
  try {
    const r = await fetch(`/proxy/admin/users/${encodeURIComponent(deleteTarget)}`, { method: 'DELETE' });
    if (r.ok) {
      closeModal('modal-delete');
      await loadUsers();
      toast(`${deleteTarget} permanently deleted`);
    } else {
      const d = await r.json();
      toast(d.error || 'Failed to delete', 'error');
    }
  } catch { toast('Network error', 'error'); }
  finally { btn.disabled = false; deleteTarget = null; }
}

// ── Modal helpers ────────────────────────────────────────────

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ── Toast ────────────────────────────────────────────────────

let toastTimer = null;
function toast(msg, type) {
  const el = document.getElementById('am-toast');
  el.textContent = msg;
  el.className = 'show' + (type === 'error' ? ' toast-error' : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

// ── Keyboard: close panel on Escape ──────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('am-panel').classList.contains('open')) closePanel();
    ['modal-deact','modal-react','modal-delete'].forEach(id => closeModal(id));
  }
});

document.addEventListener('DOMContentLoaded', amInit);

// ============================================================
// Admin-only routes — user management
// All routes require admin role.
// Super-admin-only operations are guarded individually.
// ============================================================

const express     = require('express');
const fs          = require('fs');
const path        = require('path');
const router      = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { listUsers, createUser, updateUser, deleteUser } = require('../lib/user-store');
const { getAllSettings, setMonthSettings, deleteMonthSettings } = require('../lib/monthly-goal-store');
const { kickUser } = require('../lib/sessions');

const AUDIT_LOG = path.resolve(__dirname, '../data/admin-audit.log');

function audit(callerUsername, action) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `${ts}  ${(callerUsername || '?').toUpperCase()}  ${action}\n`;
  try { fs.appendFileSync(AUDIT_LOG, line, 'utf8'); } catch (_) {}
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user?.is_super_admin) return res.status(403).json({ error: 'Super-admin access required' });
  next();
}

router.use(requireAuth, requireAdmin);

// ── GET /proxy/admin/users ────────────────────────────────────
router.get('/users', (_req, res) => res.json({ users: listUsers() }));

// ── POST /proxy/admin/users ───────────────────────────────────
router.post('/users', (req, res) => {
  const { username, displayName, role, rep_prefix, notes } = req.body || {};
  if (!username || !displayName || !role)
    return res.status(400).json({ error: 'username, displayName, and role are required' });
  if (!['advisor', 'customer_service', 'manager', 'admin'].includes(role))
    return res.status(400).json({ error: 'Invalid role' });
  if (role === 'admin' && !req.user.is_super_admin)
    return res.status(403).json({ error: 'Only the super-admin can create admin accounts' });
  try {
    createUser({
      username:      username.toLowerCase().trim(),
      displayName:   displayName.trim(),
      role,
      is_super_admin: false,
      rep_prefix:    rep_prefix ? rep_prefix.trim().toUpperCase() : null,
      active:        true,
      notes:         (notes || '').trim(),
    });
    audit(req.user.username, `created user ${username.toLowerCase()} (role=${role}${rep_prefix ? ', prefix=' + rep_prefix : ''})`);
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

// ── PATCH /proxy/admin/users/:username ───────────────────────
router.patch('/users/:username', (req, res) => {
  const target   = req.params.username.toLowerCase();
  const caller   = req.user.username.toLowerCase();
  const users    = listUsers();
  const targetUser = users.find(u => u.username.toLowerCase() === target);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  // Cannot edit own role or active flag
  if (target === caller && (req.body.role !== undefined || req.body.active !== undefined))
    return res.status(403).json({ error: 'You cannot change your own role or active status' });

  // Editing an admin account requires super-admin
  if (targetUser.role === 'admin' && !req.user.is_super_admin)
    return res.status(403).json({ error: 'Only the super-admin can edit admin accounts' });

  // Promoting to admin requires super-admin
  if (req.body.role === 'admin' && !req.user.is_super_admin)
    return res.status(403).json({ error: 'Only the super-admin can promote users to admin' });

  // is_super_admin cannot be set via API (sacred — edit users.json directly)
  if (req.body.is_super_admin !== undefined)
    return res.status(403).json({ error: 'Super-admin status cannot be changed via the UI' });

  // Cannot demote the last super-admin
  if (targetUser.is_super_admin && req.body.role && req.body.role !== 'admin') {
    const superAdmins = users.filter(u => u.is_super_admin && u.active);
    if (superAdmins.length <= 1)
      return res.status(403).json({ error: 'Cannot demote the last super-admin' });
  }

  const allowed = {};
  for (const f of ['displayName', 'role', 'rep_prefix', 'active', 'notes'])
    if (req.body[f] !== undefined) allowed[f] = req.body[f];

  try {
    updateUser(target, allowed);
    const changes = Object.entries(allowed).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
    audit(req.user.username, `updated ${target}: ${changes}`);
    // Kick sessions on permission-affecting changes
    if (allowed.active === false || allowed.role !== undefined)
      kickUser(target);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── POST /proxy/admin/users/:username/deactivate ─────────────
router.post('/users/:username/deactivate', (req, res) => {
  const target     = req.params.username.toLowerCase();
  const caller     = req.user.username.toLowerCase();
  const users      = listUsers();
  const targetUser = users.find(u => u.username.toLowerCase() === target);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  if (target === caller)
    return res.status(403).json({ error: 'You cannot deactivate your own account' });

  if (targetUser.role === 'admin' && !req.user.is_super_admin)
    return res.status(403).json({ error: 'Only the super-admin can deactivate admin accounts' });

  try {
    updateUser(target, { active: false });
    audit(req.user.username, `deactivated ${target}`);
    kickUser(target);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── POST /proxy/admin/users/:username/activate ───────────────
router.post('/users/:username/activate', (req, res) => {
  const target     = req.params.username.toLowerCase();
  const users      = listUsers();
  const targetUser = users.find(u => u.username.toLowerCase() === target);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  if (targetUser.role === 'admin' && !req.user.is_super_admin)
    return res.status(403).json({ error: 'Only the super-admin can reactivate admin accounts' });

  try {
    updateUser(target, { active: true });
    audit(req.user.username, `reactivated ${target}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── DELETE /proxy/admin/users/:username — hard delete ────────
router.delete('/users/:username', requireSuperAdmin, (req, res) => {
  const target = req.params.username.toLowerCase();
  const caller = req.user.username.toLowerCase();

  if (target === caller)
    return res.status(403).json({ error: 'You cannot delete your own account' });

  const users      = listUsers();
  const targetUser = users.find(u => u.username.toLowerCase() === target);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  // Cannot delete the last super-admin
  if (targetUser.is_super_admin) {
    const superAdmins = users.filter(u => u.is_super_admin);
    if (superAdmins.length <= 1)
      return res.status(403).json({ error: 'Cannot delete the last super-admin' });
  }

  try {
    deleteUser(target);
    audit(req.user.username, `permanently deleted ${target} (was role=${targetUser.role})`);
    kickUser(target);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── GET /proxy/admin/monthly-goal-settings ───────────────────
router.get('/monthly-goal-settings', (_req, res) => {
  res.json({ settings: getAllSettings() });
});

// ── PUT /proxy/admin/monthly-goal-settings/:yearMonth ─────────
router.put('/monthly-goal-settings/:yearMonth', (req, res) => {
  const { yearMonth } = req.params;
  const { monthly_increase_pct, note } = req.body || {};
  if (monthly_increase_pct == null)
    return res.status(400).json({ error: 'monthly_increase_pct is required' });
  try {
    const existing = getAllSettings()[yearMonth];
    const oldVal = existing ? existing.monthly_increase_pct : null;
    const entry = setMonthSettings(yearMonth, { monthly_increase_pct, note, set_by: req.user.username });
    const auditNote = oldVal != null
      ? `monthly_goal_set ${yearMonth} ${oldVal}% -> ${entry.monthly_increase_pct}%`
      : `monthly_goal_set ${yearMonth} (new) ${entry.monthly_increase_pct}%`;
    audit(req.user.username, auditNote);
    res.json({ ok: true, entry });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── DELETE /proxy/admin/monthly-goal-settings/:yearMonth ──────
router.delete('/monthly-goal-settings/:yearMonth', (req, res) => {
  const { yearMonth } = req.params;
  const existed = deleteMonthSettings(yearMonth);
  if (existed) audit(req.user.username, `monthly_goal_delete ${yearMonth}`);
  res.json({ ok: true, existed });
});

// ── GET /proxy/admin/audit — last 200 lines ──────────────────
router.get('/audit', requireSuperAdmin, (_req, res) => {
  try {
    const lines = fs.existsSync(AUDIT_LOG)
      ? fs.readFileSync(AUDIT_LOG, 'utf8').trim().split('\n').slice(-200).reverse()
      : [];
    res.json({ lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

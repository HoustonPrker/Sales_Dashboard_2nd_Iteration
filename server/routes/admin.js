// ============================================================
// Admin-only routes — user management
// All routes require admin role.
// ============================================================

const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { listUsers, createUser, updateUser } = require('../lib/user-store');

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}
function requireSuperAdmin(req, res, next) {
  if (!req.user?.is_super_admin) return res.status(403).json({ error: 'Super-admin access required' });
  next();
}

router.use(requireAuth, requireAdmin);

router.get('/users', (_req, res) => res.json(listUsers()));

router.post('/users', (req, res) => {
  const { username, displayName, role, rep_prefix } = req.body || {};
  if (!username || !displayName || !role)
    return res.status(400).json({ error: 'username, displayName, and role are required' });
  if (!['advisor', 'customer_service', 'manager', 'admin'].includes(role))
    return res.status(400).json({ error: 'role must be advisor, customer_service, manager, or admin' });
  try {
    createUser({ username, displayName, role, rep_prefix: rep_prefix || null, is_super_admin: false });
    res.status(201).json({ ok: true });
  } catch (e) { res.status(409).json({ error: e.message }); }
});

router.patch('/users/:username', (req, res) => {
  const allowed = {};
  const fields  = ['displayName', 'role', 'rep_prefix', 'active'];
  for (const f of fields) if (req.body[f] !== undefined) allowed[f] = req.body[f];
  // Promote/demote admin requires super-admin
  if (allowed.role === 'admin' || req.body.is_super_admin !== undefined) {
    if (!req.user.is_super_admin) return res.status(403).json({ error: 'Super-admin required to promote/demote admins' });
    if (req.body.is_super_admin !== undefined) allowed.is_super_admin = req.body.is_super_admin;
  }
  try { updateUser(req.params.username, allowed); res.json({ ok: true }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

// Soft delete = deactivate
router.delete('/users/:username', (req, res) => {
  try { updateUser(req.params.username, { active: false }); res.json({ ok: true }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

module.exports = router;

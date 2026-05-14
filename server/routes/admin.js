// ============================================================
// Admin-only routes — user management
// All routes require admin role.
// ============================================================

const express   = require('express');
const router    = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { listUsers, createUser, updateUser, deleteUser } = require('../lib/user-store');

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

router.use(requireAuth, requireAdmin);

// GET /proxy/admin/users
router.get('/users', (_req, res) => {
  res.json(listUsers());
});

// POST /proxy/admin/users — create a user
router.post('/users', async (req, res) => {
  const { username, password, displayName, role } = req.body || {};
  if (!username || !password || !displayName || !role)
    return res.status(400).json({ error: 'username, password, displayName, and role are required' });
  if (!['admin', 'manager', 'customer_advisor'].includes(role))
    return res.status(400).json({ error: 'role must be admin, manager, or customer_advisor' });
  try {
    await createUser({ username, password, displayName, role });
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

// PATCH /proxy/admin/users/:username — update role, displayName, or password
router.patch('/users/:username', async (req, res) => {
  const allowed = {};
  if (req.body.role)        allowed.role        = req.body.role;
  if (req.body.displayName) allowed.displayName = req.body.displayName;
  if (req.body.password)    allowed.password    = req.body.password;
  try {
    await updateUser(req.params.username, allowed);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// DELETE /proxy/admin/users/:username
router.delete('/users/:username', async (req, res) => {
  try {
    deleteUser(req.params.username);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

module.exports = router;

const express     = require('express');
const router      = express.Router();
const { createSession, deleteSession } = require('../lib/sessions');
const requireAuth = require('../middleware/requireAuth');
const { validateUser } = require('../lib/user-store');

// POST /proxy/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const user = await validateUser(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const sessionUser = { userId: user.username, displayName: user.displayName, role: user.role };
  const token = createSession(sessionUser);
  console.log(`[auth] login OK user=${sessionUser.userId} role=${sessionUser.role}`);
  return res.json({ token, user: sessionUser });
});

// POST /proxy/auth/logout
router.post('/logout', requireAuth, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || null;
  if (token) deleteSession(token);
  res.json({ ok: true });
});

// GET /proxy/auth/me
router.get('/me', requireAuth, (req, res) => {
  const { userId, displayName, role } = req.user;
  res.json({ userId, displayName, role });
});

module.exports = router;

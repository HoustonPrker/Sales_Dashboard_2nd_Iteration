const express        = require('express');
const router         = express.Router();
const { validateLDAP } = require('../lib/ldap-auth');
const { findUser, listUsers } = require('../lib/user-store');
const { createSession, deleteSession, updateSession } = require('../lib/sessions');
const requireAuth    = require('../middleware/requireAuth');

const IS_PROD = process.env.NODE_ENV === 'production';

function setCookie(res, sessionId) {
  res.cookie('kellis_session', sessionId, {
    httpOnly: true,
    secure:   IS_PROD,   // HTTPS only in production
    sameSite: 'Lax',
    // NO maxAge — session cookie, dies when browser closes
  });
}

// POST /auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });

  // Step 1: user must exist in users.json and be active
  const record = findUser(username);
  if (!record) {
    console.log(`[auth] 401 — user "${username}" not found in users.json`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (!record.active) {
    console.log(`[auth] 401 — user "${username}" exists but active=false`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Step 2: validate against LDAP
  let ldapOk = false;
  try {
    const { LDAP_URL, LDAP_BIND_DN_TEMPLATE } = process.env;
    if (!LDAP_URL) {
      console.log('[auth] 503 — LDAP_URL is not configured');
      return res.status(503).json({ error: 'Authentication service unavailable — try again shortly' });
    }
    ldapOk = await validateLDAP(username, password);
  } catch (err) {
    if (err.message.startsWith('LDAP_UNREACHABLE')) {
      console.log(`[auth] 503 — LDAP server unreachable: ${err.message}`);
      return res.status(503).json({ error: 'Authentication service unavailable — try again shortly' });
    }
    console.log(`[auth] 503 — LDAP unexpected error: ${err.message}`);
    return res.status(503).json({ error: 'Authentication service unavailable — try again shortly' });
  }

  if (!ldapOk) {
    console.log(`[auth] 401 — LDAP bind returned false for "${username}" (wrong password or bad bind template)`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Step 3: create session
  const sessionUser = {
    username:        record.username,
    displayName:     record.displayName,
    role:            record.role,
    rep_prefix:      record.rep_prefix || null,
    is_super_admin:  record.is_super_admin || false,
  };
  const sessionId = createSession(sessionUser);
  setCookie(res, sessionId);

  console.log(`[auth] login OK user=${record.username} role=${record.role}`);
  return res.json({
    displayName:    record.displayName,
    role:           record.role,
    rep_ids:        record.rep_ids || [],
    is_super_admin: record.is_super_admin || false,
  });
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  const sessionId = req.cookies?.kellis_session;
  deleteSession(sessionId);
  res.clearCookie('kellis_session');
  res.json({ ok: true });
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  const { username, displayName, role, rep_prefix, is_super_admin, scoped_view_as } = req.user;
  res.json({ username, displayName, role, rep_prefix, is_super_admin, scoped_view_as: scoped_view_as || null });
});

// POST /auth/view-as/:username — manager/admin only
router.post('/view-as/:username', requireAuth, (req, res) => {
  if (!['manager', 'admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Forbidden' });
  const target = findUser(req.params.username);
  if (!target || target.role !== 'advisor')
    return res.status(404).json({ error: 'Advisor not found' });
  const scopedViewAs = {
    username:    target.username,
    displayName: target.displayName,
    rep_prefix:  target.rep_prefix,
  };
  updateSession(req.cookies.kellis_session, { scoped_view_as: scopedViewAs });
  res.json({ ok: true, scoped_view_as: scopedViewAs });
});

// GET /auth/advisors — list all active users with a rep_prefix (for Rep filter UI)
router.get('/advisors', requireAuth, (req, res) => {
  const advisors = listUsers()
    .filter(u => u.active && u.rep_prefix)
    .map(u => ({ displayName: u.displayName, rep_prefix: u.rep_prefix }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  res.json(advisors);
});

// DELETE /auth/view-as — clear scope
router.delete('/view-as', requireAuth, (req, res) => {
  updateSession(req.cookies.kellis_session, { scoped_view_as: null });
  res.json({ ok: true });
});

module.exports = router;

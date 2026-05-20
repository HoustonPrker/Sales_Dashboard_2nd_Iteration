const express          = require('express');
const router           = express.Router();
const { validateLDAP, validateUsername } = require('../lib/ldap-auth');
const { findUser, listUsers }            = require('../lib/user-store');
const { createSession, deleteSession, updateSession } = require('../lib/sessions');
const requireAuth      = require('../middleware/requireAuth');
const rl               = require('../lib/login-rate-limiter');

const IS_PROD = process.env.NODE_ENV === 'production';

// Single generic error message for every auth failure — never reveal which step failed
const AUTH_FAIL = { error: 'Invalid username or password' };

function setCookie(res, sessionId) {
  res.cookie('kellis_session', sessionId, {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: 'Lax',
    // No maxAge — session cookie, dies when browser closes
  });
}

function clientIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();
}

// POST /auth/login
router.post('/login', async (req, res) => {
  const ip = clientIP(req);

  // 1. Extract and type-check inputs — never log raw inputs at this stage
  const { username, password } = req.body || {};

  // 2. Validate username against strict allowlist BEFORE touching LDAP
  if (!validateUsername(username)) {
    console.log(`[auth] validation_failed ip=${ip} reason=bad_username`);
    return res.status(401).json(AUTH_FAIL);
  }

  // 3. Reject empty or whitespace-only passwords — never let them reach client.bind()
  if (typeof password !== 'string' || password.trim().length === 0) {
    console.log(`[auth] validation_failed ip=${ip} username="${username}" reason=empty_password`);
    return res.status(401).json(AUTH_FAIL);
  }

  // 4. Rate limit — check BEFORE any expensive operations
  if (rl.checkIP(ip)) {
    console.log(`[auth] rate_limited ip=${ip} username="${username}" reason=ip_lockout`);
    return res.status(401).json(AUTH_FAIL);
  }
  if (rl.checkUsername(username)) {
    console.log(`[auth] rate_limited ip=${ip} username="${username}" reason=username_lockout`);
    return res.status(401).json(AUTH_FAIL);
  }

  // 5. User must exist in users.json and be active
  const record = findUser(username);
  if (!record || !record.active) {
    // Still consume a rate-limit slot — prevents username enumeration via timing
    rl.failUsername(username);
    rl.failIP(ip);
    console.log(`[auth] not_in_users_json ip=${ip} username="${username}"`);
    return res.status(401).json(AUTH_FAIL);
  }

  // 6. LDAP bind — username has already been validated, password is non-empty
  let ldapOk = false;
  try {
    if (!process.env.LDAP_URL) {
      console.log('[auth] 503 LDAP_URL not configured');
      return res.status(503).json({ error: 'Authentication service unavailable — try again shortly' });
    }
    ldapOk = await validateLDAP(username, password);
  } catch (err) {
    // Log server-side only — never expose LDAP error detail to client
    if (err.message.startsWith('LDAP_UNREACHABLE')) {
      console.log(`[auth] 503 LDAP unreachable ip=${ip} username="${username}"`);
    } else {
      console.error(`[auth] 503 LDAP unexpected error ip=${ip} username="${username}"`, err.message);
    }
    return res.status(503).json({ error: 'Authentication service unavailable — try again shortly' });
  }

  if (!ldapOk) {
    rl.failUsername(username);
    rl.failIP(ip);
    console.log(`[auth] bind_failed ip=${ip} username="${username}"`);
    return res.status(401).json(AUTH_FAIL);
  }

  // 7. Auth success — clear per-username failure counter, create session
  rl.succeedUsername(username);

  const sessionUser = {
    username:       record.username,
    displayName:    record.displayName,
    role:           record.role,
    rep_prefix:     record.rep_prefix || null,
    is_super_admin: record.is_super_admin || false,
  };
  const sessionId = createSession(sessionUser);
  setCookie(res, sessionId);

  console.log(`[auth] success ip=${ip} username="${record.username}" role=${record.role}`);
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

// GET /auth/advisors — list active users with a rep_prefix (for Rep filter UI)
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

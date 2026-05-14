const express  = require('express');
const fetch    = require('node-fetch');
const router   = express.Router();
const { createSession, deleteSession } = require('../lib/sessions');
const requireAuth = require('../middleware/requireAuth');

const API_BASE = process.env.API_BASE_URL || 'http://172.16.20.185:8084';

function mapRole(wrkgrpId) {
  const adminIds   = (process.env.ADMIN_WRKGRP_IDS   || '').split(',').map(s => s.trim()).filter(Boolean);
  const managerIds = (process.env.MANAGER_WRKGRP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (adminIds.includes(String(wrkgrpId)))   return 'admin';
  if (managerIds.includes(String(wrkgrpId))) return 'manager';
  return 'customer_advisor';
}

// POST /proxy/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const credentials = Buffer.from(`${username}:${password}`).toString('base64');
  const url = `${API_BASE}/api/v1/System/users/${encodeURIComponent(username)}`;

  try {
    const cpRes = await fetch(url, {
      headers: { 'Authorization': `Basic ${credentials}` }
    });

    if (cpRes.status === 401 || cpRes.status === 403) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!cpRes.ok) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const data = await cpRes.json();
    // Counterpoint wraps responses — handle both direct object and SystemUser array
    const userObj = (data.SystemUsers && data.SystemUsers[0]) || data;

    const wrkgrpId   = userObj.wrkgrpId   || userObj.WrkgrpId   || '';
    const displayName = userObj.name       || userObj.Name       || userObj.usrId || username;
    const userId      = userObj.usrId      || userObj.UsrId      || username;

    const role = mapRole(wrkgrpId);
    const token = createSession({ userId, displayName, role, wrkgrpId });

    return res.json({ token, user: { userId, displayName, role } });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    return res.status(503).json({ error: 'Could not reach authentication server' });
  }
});

// POST /proxy/auth/logout
router.post('/logout', requireAuth, (req, res) => {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) deleteSession(token);
  res.json({ ok: true });
});

// GET /proxy/auth/me
router.get('/me', requireAuth, (req, res) => {
  const { userId, displayName, role } = req.user;
  res.json({ userId, displayName, role });
});

module.exports = router;

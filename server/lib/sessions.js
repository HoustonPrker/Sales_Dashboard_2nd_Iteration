const sessions = new Map(); // token → {userId, displayName, role, wrkgrpId, ts}
const SESSION_TTL = 8 * 60 * 60 * 1000;

function createSession(user) {
  const { randomBytes } = require('crypto');
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { ...user, ts: Date.now() });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_TTL) { sessions.delete(token); return null; }
  return s;
}

function deleteSession(token) { sessions.delete(token); }

module.exports = { createSession, getSession, deleteSession };

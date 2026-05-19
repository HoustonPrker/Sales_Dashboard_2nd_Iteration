const { randomUUID } = require('crypto');
const sessions = new Map(); // sessionId → { username, displayName, role, rep_ids, is_super_admin, createdAt }

// Session-lifetime only — no TTL (browser close kills the cookie, server-side we keep for up to 24h max to handle lingering)
const SERVER_MAX_AGE = 24 * 60 * 60 * 1000;

function createSession(user) {
  const id = randomUUID();
  sessions.set(id, { ...user, createdAt: Date.now() });
  return id;
}

function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.createdAt > SERVER_MAX_AGE) { sessions.delete(id); return null; }
  return s;
}

function deleteSession(id) { if (id) sessions.delete(id); }

function updateSession(id, updates) {
  const session = getSession(id);
  if (!session) return;
  sessions.set(id, { ...session, ...updates });
}

module.exports = { createSession, getSession, deleteSession, updateSession };

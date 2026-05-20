// In-memory login rate limiter.
// Resets on server restart — acceptable for v1.
// Two independent limits:
//   - per username: 5 failures in 15 min → 15-min lockout
//   - per IP:       20 failures in 15 min → 60-min lockout

const USERNAME_MAX      = 5;
const USERNAME_WINDOW   = 15 * 60 * 1000;
const USERNAME_LOCKOUT  = 15 * 60 * 1000;

const IP_MAX            = 20;
const IP_WINDOW         = 15 * 60 * 1000;
const IP_LOCKOUT        = 60 * 60 * 1000;

// { key → { count, windowStart, lockedUntil } }
const _store = new Map();

function _get(key) {
  return _store.get(key) || { count: 0, windowStart: Date.now(), lockedUntil: 0 };
}

function isBlocked(key, maxAttempts, windowMs, lockoutMs) {
  const now   = Date.now();
  const entry = _get(key);

  if (entry.lockedUntil > now) return true;

  // Reset window if expired
  if (now - entry.windowStart > windowMs) {
    _store.set(key, { count: 0, windowStart: now, lockedUntil: 0 });
    return false;
  }

  return false;
}

function recordFailure(key, maxAttempts, windowMs, lockoutMs) {
  const now   = Date.now();
  const entry = _get(key);

  let { count, windowStart, lockedUntil } = entry;

  // Reset window if expired
  if (now - windowStart > windowMs) {
    count       = 0;
    windowStart = now;
    lockedUntil = 0;
  }

  count += 1;

  if (count >= maxAttempts) {
    lockedUntil = now + lockoutMs;
    count       = 0;   // reset so lockout renews cleanly after expiry
    windowStart = now;
  }

  _store.set(key, { count, windowStart, lockedUntil });
}

function recordSuccess(usernameKey) {
  // Clear per-username counter on successful auth
  _store.delete(usernameKey);
}

// Public API — callers use "u:username" and "ip:1.2.3.4" as keys

function checkUsername(username) {
  return isBlocked(`u:${username}`, USERNAME_MAX, USERNAME_WINDOW, USERNAME_LOCKOUT);
}

function checkIP(ip) {
  return isBlocked(`ip:${ip}`, IP_MAX, IP_WINDOW, IP_LOCKOUT);
}

function failUsername(username) {
  recordFailure(`u:${username}`, USERNAME_MAX, USERNAME_WINDOW, USERNAME_LOCKOUT);
}

function failIP(ip) {
  recordFailure(`ip:${ip}`, IP_MAX, IP_WINDOW, IP_LOCKOUT);
}

function succeedUsername(username) {
  recordSuccess(`u:${username}`);
}

module.exports = { checkUsername, checkIP, failUsername, failIP, succeedUsername };

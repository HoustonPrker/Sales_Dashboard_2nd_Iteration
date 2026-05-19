const { getSession } = require('../lib/sessions');

module.exports = function requireAuth(req, res, next) {
  const sessionId = req.cookies?.kellis_session;
  const session   = getSession(sessionId);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  req.user = session;
  next();
};

const { getSession } = require('../lib/sessions');
module.exports = (req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  req.user = session;
  next();
};

module.exports = function enforceRepScope(req, res, next) {
  const { role, rep_prefix, scoped_view_as } = req.user;

  if (scoped_view_as && ['manager', 'admin'].includes(role)) {
    // Manager/admin viewing as a rep — scope to that rep's prefix
    req.query.rep = scoped_view_as.rep_prefix;
    return next();
  }

  if (role === 'advisor') {
    if (!rep_prefix) return res.status(403).json({ error: 'Advisor account has no rep_prefix configured' });
    // Advisors always get their own prefix — ignore whatever the client sent
    req.query.rep = rep_prefix;
  } else {
    // customer_service, manager, admin — full access
    if (!req.query.rep) req.query.rep = 'ALL';
  }

  next();
};

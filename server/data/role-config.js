// ============================================================
// Role overrides — keyed by CP username (case-insensitive).
// Any user listed here gets the specified role regardless of
// their Counterpoint workgroup.
// Everyone else defaults to 'customer_advisor'.
// ============================================================

const ROLE_OVERRIDES = {
  'HOUSTONP': 'admin',
  // Add more as needed, e.g.:
  // 'CTREECE': 'admin',
  // 'SOMEMANAGER': 'manager',
};

function getRoleOverride(username) {
  return ROLE_OVERRIDES[(username || '').trim().toUpperCase()] || null;
}

module.exports = { ROLE_OVERRIDES, getRoleOverride };

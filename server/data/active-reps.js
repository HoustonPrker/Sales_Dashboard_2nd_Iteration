// ============================================================
// Active Sales Reps — single source of truth
//
// Future: replace the array with a DB query to dbo.CK_SALES_REPS.
// The exported shape (getActiveReps → Promise<[{id, name}]>) stays
// the same so all callers continue to work without modification.
// ============================================================

const ACTIVE_SALES_REPS = [
  'MEGAN-ACT',
  'MJELIN-ACT',
  'SUER-ACT',
  'BOB-ACTIVE',
  'LESLIW-ACT',
  'JADAP-ACT',
  'ANDREAS-AC',
  'KENEDYR-AC',
  'CHARLESM-A',
  'MICHEL-ACT',
  'ANNAB-ACT',
];

// Set for O(1) membership checks
const ACTIVE_REP_SET = new Set(ACTIVE_SALES_REPS.map(id => id.toUpperCase()));

/**
 * Returns the list of active reps.
 * Async so callers are forwards-compatible with a future DB implementation.
 * @returns {Promise<Array<{id: string}>>}
 */
async function getActiveReps() {
  return ACTIVE_SALES_REPS.map(id => ({ id }));
}

/**
 * Returns true if the given repId is an active sales rep.
 * Case-insensitive.
 */
function isActiveRep(repId) {
  return ACTIVE_REP_SET.has((repId || '').trim().toUpperCase());
}

module.exports = { ACTIVE_SALES_REPS, ACTIVE_REP_SET, getActiveReps, isActiveRep };

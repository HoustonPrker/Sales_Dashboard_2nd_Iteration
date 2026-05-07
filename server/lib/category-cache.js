// Shared in-process store: accounts route writes raw category rows per rep,
// all-categories route reads and aggregates from it — no duplicate API calls.

const store = {}; // repKey → { rows: [{custNo, categoryCode, description, currentYtdAmount, priorYtdAmount}], ts }
const TTL   = 5 * 60 * 1000;

function set(repKey, rows) {
  store[repKey] = { rows, ts: Date.now() };
}

function get(repKey) {
  const entry = store[repKey];
  if (!entry || Date.now() - entry.ts > TTL) return null;
  return entry.rows;
}

module.exports = { set, get };

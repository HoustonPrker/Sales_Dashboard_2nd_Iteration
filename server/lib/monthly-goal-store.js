// ============================================================
// Monthly goal settings store
// File: server/data/monthly_goal_settings.json
// Schema: { "YYYY-MM": { monthly_increase_pct, note, set_by, set_at } }
// ============================================================

const fs   = require('fs');
const path = require('path');

const STORE_PATH = path.resolve(__dirname, '../data/monthly_goal_settings.json');
const TMP_PATH   = STORE_PATH + '.tmp';

let _cache = null;

function _read() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (_) {
    _cache = {};
  }
  return _cache;
}

function _flush(data) {
  fs.writeFileSync(TMP_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(TMP_PATH, STORE_PATH);
  _cache = data;
}

// Returns the full settings map { "YYYY-MM": { ... } }
function getAllSettings() {
  return { ..._read() };
}

// Returns the entry for one month, or null if not set
function getMonthSettings(yyyyMM) {
  return _read()[yyyyMM] ?? null;
}

// Returns the decimal growth rate for a month (e.g. 0.058 for 5.8%)
// Falls back to defaultFallback if the month isn't explicitly configured.
function getGrowthPct(yyyyMM, defaultFallback = 0.05) {
  const entry = getMonthSettings(yyyyMM);
  if (entry && entry.monthly_increase_pct != null) {
    return entry.monthly_increase_pct / 100;
  }
  return defaultFallback;
}

// Upsert a month entry. Fields: monthly_increase_pct (required), note (optional), set_by, set_at.
function setMonthSettings(yyyyMM, { monthly_increase_pct, note, set_by }) {
  if (!/^\d{4}-\d{2}$/.test(yyyyMM)) throw new Error('Invalid month format — expected YYYY-MM');
  const pct = parseFloat(monthly_increase_pct);
  if (isNaN(pct) || pct < -100 || pct > 200) throw new Error('monthly_increase_pct must be a number between -100 and 200');

  const data = _read();
  data[yyyyMM] = {
    monthly_increase_pct: Math.round(pct * 10000) / 10000,
    note:   (note || '').trim(),
    set_by: (set_by || '').toUpperCase(),
    set_at: new Date().toISOString(),
  };
  _flush(data);
  return data[yyyyMM];
}

// Delete a month entry (revert to default)
function deleteMonthSettings(yyyyMM) {
  const data = _read();
  const existed = yyyyMM in data;
  if (existed) {
    delete data[yyyyMM];
    _flush(data);
  }
  return existed;
}

module.exports = { getAllSettings, getMonthSettings, getGrowthPct, setMonthSettings, deleteMonthSettings };

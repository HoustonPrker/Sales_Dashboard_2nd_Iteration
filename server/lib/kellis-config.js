// ============================================================
// Kellis business-rule configuration
// Source of truth: server/data/kellis-config.json
// Infrastructure secrets (API keys, ports) stay in .env.
// Business rules (growth targets, etc.) live here.
// ============================================================

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '../data/kellis-config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[kellis-config] Failed to read config, using defaults:', e.message);
    return {};
  }
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// Annual growth target — applied to prior full-year sales.
// e.g. 0.10 = 10% growth over last year's total.
function getAnnualGrowthPct() {
  return readConfig().annualGrowthPct ?? 0.10;
}

// Monthly growth target for a specific month, e.g. '2026-05'.
// Falls back to defaultMonthlyGrowthPct if the month isn't explicitly set.
function getMonthlyGrowthPct(yyyyMM) {
  const cfg = readConfig();
  if (yyyyMM && cfg.monthlyGrowthPct && cfg.monthlyGrowthPct[yyyyMM] != null) {
    return cfg.monthlyGrowthPct[yyyyMM];
  }
  return cfg.defaultMonthlyGrowthPct ?? 0.05;
}

module.exports = { readConfig, writeConfig, getAnnualGrowthPct, getMonthlyGrowthPct };

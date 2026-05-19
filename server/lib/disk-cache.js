const fs   = require('fs');
const path = require('path');
const FILE = path.resolve(__dirname, '../data/accounts-cache.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function save(data) {
  try { fs.writeFileSync(FILE, JSON.stringify(data), 'utf8'); } catch (e) {
    console.error('[disk-cache] write failed:', e.message);
  }
}
module.exports = { load, save };

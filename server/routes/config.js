// ============================================================
// GET  /proxy/config          — read Kellis business config
// PATCH /proxy/config         — update fields in Kellis config
// ============================================================

const express = require('express');
const router  = express.Router();
const { readConfig, writeConfig } = require('../lib/kellis-config');

router.get('/config', (req, res) => {
  try {
    res.json(readConfig());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/config', (req, res) => {
  try {
    const current = readConfig();
    const updated = { ...current, ...req.body };
    writeConfig(updated);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

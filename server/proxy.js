// ============================================================
// Kellis Sales — Proxy Server
// Bridges the browser dashboard to the Counterpoint REST API
// ============================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const path    = require('path');

const PORT = parseInt(process.env.PROXY_PORT || process.env.PORT || '3001', 10);
const app  = express();

app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Auth routes (no auth required) ───────────────────────────
app.use('/proxy/auth', require('./routes/auth'));

// ── Require auth for all other /proxy routes ──────────────────
app.use('/proxy', require('./middleware/requireAuth'));

// ── Routes ────────────────────────────────────────────────────
app.use('/proxy', require('./routes/config'));
app.use('/proxy', require('./routes/customers'));
app.use('/proxy', require('./routes/categories'));
app.use('/proxy', require('./routes/items'));
app.use('/proxy', require('./routes/overview'));
app.use('/proxy/ai', require('./routes/ai'));

// ── Static files (serve the project root) ────────────────────
app.use(express.static(path.resolve(__dirname, '..')));

app.listen(PORT, () => {
  const { API_BASE_URL, SALES_REP } = process.env;
  console.log(`Kellis Sales proxy → http://localhost:${PORT}`);
  console.log(`  API: ${API_BASE_URL || 'http://172.16.20.185:8084'}`);
  console.log(`  Rep: ${SALES_REP || '(all reps)'}`);
});

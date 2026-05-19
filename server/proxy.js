require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express      = require('express');
const path         = require('path');
const cookieParser = require('cookie-parser');

const PORT = parseInt(process.env.PROXY_PORT || process.env.PORT || '3001', 10);
const app  = express();

app.use(express.json());
app.use(cookieParser());

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth routes — no auth required
app.use('/auth', require('./routes/auth'));

// Require auth for all /proxy routes
app.use('/proxy', require('./middleware/requireAuth'));

// Protected proxy routes
app.use('/proxy/admin', require('./routes/admin'));
app.use('/proxy', require('./routes/config'));
app.use('/proxy', require('./routes/customers'));
app.use('/proxy', require('./routes/categories'));
app.use('/proxy', require('./routes/items'));
app.use('/proxy', require('./routes/overview'));
app.use('/proxy/ai', require('./routes/ai'));

// Static files
app.use(express.static(path.resolve(__dirname, '..')));

const { warmCache } = require('./routes/customers');
app.listen(PORT, () => {
  const { API_BASE_URL, SALES_REP, LDAP_URL, LDAP_BIND_DN_TEMPLATE, LDAP_TLS } = process.env;
  console.log(`Kellis Sales proxy → http://localhost:${PORT}`);
  console.log(`  API: ${API_BASE_URL || 'http://172.16.20.185:8084'}`);
  console.log(`  Rep: ${SALES_REP || '(all reps)'}`);
  console.log(`  LDAP_URL configured: ${LDAP_URL ? 'yes' : 'no'}`);
  console.log(`  LDAP_BIND_DN_TEMPLATE configured: ${LDAP_BIND_DN_TEMPLATE ? 'yes' : 'no'}`);
  console.log(`  LDAP_TLS: ${LDAP_TLS || 'false'}`);
  warmCache();
  console.log('  Cache: warming in background…');
});

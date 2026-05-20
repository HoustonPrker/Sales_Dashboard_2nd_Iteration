const ldap = require('ldapjs');

// UPN bind — username goes into "user@domain" format, NOT into a search filter
// and NOT into a parsed DN, so RFC 4515/4514 escaping is not required.
// The USERNAME_PATTERN allowlist is the primary injection defence.

const LDAP_URL       = process.env.LDAP_URL       || '';
const BIND_TEMPLATE  = process.env.LDAP_BIND_DN_TEMPLATE || '{username}@kellis.local';
const LDAP_TLS       = process.env.LDAP_TLS === 'true';
const LDAP_TLS_CERT  = process.env.LDAP_TLS_CERT  || '';  // path to internal CA cert (preferred)
// Set LDAP_TLS_REJECT_UNAUTHORIZED=false only while waiting for IT to provide the CA cert.
// Remove once LDAP_TLS_CERT is configured.
const REJECT_UNAUTH  = process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false';

// AD sAMAccountName: 1–20 chars, letters/digits/dot/underscore/hyphen only.
// Rejects all LDAP special chars (*, (, ), \, NUL) and spaces.
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,20}$/;

function validateUsername(input) {
  if (typeof input !== 'string') return false;
  return USERNAME_PATTERN.test(input);
}

function buildBindDN(username) {
  return BIND_TEMPLATE.replace('{username}', username);
}

async function validateLDAP(username, password) {
  if (!LDAP_URL) throw new Error('LDAP_URL not configured');

  return new Promise((resolve, reject) => {
    const tlsOptions = LDAP_TLS
      ? {
          rejectUnauthorized: REJECT_UNAUTH,
          ...(LDAP_TLS_CERT ? { ca: [require('fs').readFileSync(LDAP_TLS_CERT)] } : {}),
        }
      : undefined;

    const client = ldap.createClient({
      url:            LDAP_URL,
      tlsOptions,
      timeout:        5000,
      connectTimeout: 5000,
    });

    client.on('error', (err) => {
      client.destroy();
      reject(new Error('LDAP_UNREACHABLE: ' + err.message));
    });

    client.bind(buildBindDN(username), password, (err) => {
      client.destroy();
      if (err) {
        // Log outcome only — never log password
        console.log(`[ldap-auth] bind failed user="${username}" code=${err.code} name=${err.name}`);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

module.exports = { validateLDAP, validateUsername };

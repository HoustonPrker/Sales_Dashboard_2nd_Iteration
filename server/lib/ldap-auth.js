const ldap = require('ldapjs');

const LDAP_URL      = process.env.LDAP_URL      || '';
const BIND_TEMPLATE = process.env.LDAP_BIND_DN_TEMPLATE || '{username}@kellis.local';
const USE_TLS       = process.env.LDAP_TLS === 'true';

function bindDN(username) {
  return BIND_TEMPLATE.replace('{username}', username);
}

async function validateLDAP(username, password) {
  if (!LDAP_URL) throw new Error('LDAP_URL not configured');

  return new Promise((resolve, reject) => {
    const client = ldap.createClient({
      url: LDAP_URL,
      tlsOptions: USE_TLS ? { rejectUnauthorized: false } : undefined,
      timeout: 5000,
      connectTimeout: 5000,
    });

    client.on('error', (err) => {
      client.destroy();
      reject(new Error('LDAP_UNREACHABLE: ' + err.message));
    });

    client.bind(bindDN(username), password, (err) => {
      client.destroy();
      if (err) {
        console.log(`[auth] LDAP bind failed for "${username}" — code=${err.code} name=${err.name} message=${err.message}`);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

module.exports = { validateLDAP };

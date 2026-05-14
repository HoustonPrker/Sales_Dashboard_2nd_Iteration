// Run once to create initial users:
//   node server/scripts/seed-users.js
// Then delete or don't run again (createUser throws on duplicates).

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { createUser, listUsers } = require('../lib/user-store');

const INITIAL_USERS = [
  { username: 'HOUSTONP',  password: 'ChangeMe1!', displayName: 'Houston Parker',  role: 'admin'    },
  { username: 'MCARTR',    password: 'ChangeMe1!', displayName: 'Mike Carter',      role: 'manager'  },
  { username: 'BHALL',     password: 'ChangeMe1!', displayName: 'Brian Hall',       role: 'manager'  },
];

(async () => {
  for (const u of INITIAL_USERS) {
    try {
      await createUser(u);
      console.log(`✓  Created ${u.username} (${u.role})`);
    } catch (e) {
      console.log(`⚠  ${u.username}: ${e.message}`);
    }
  }
  console.log('\nAll users:');
  listUsers().forEach(u => console.log(`  ${u.username.padEnd(12)} ${u.role.padEnd(16)} ${u.displayName}`));
  console.log('\nDone. Set real passwords via the admin panel or PATCH /proxy/admin/users/:username');
})();

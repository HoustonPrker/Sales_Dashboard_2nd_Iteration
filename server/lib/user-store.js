// ============================================================
// User store — reads/writes server/data/users.json
// Passwords are bcrypt-hashed (cost 10).
// ============================================================

const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');

const USERS_FILE = path.resolve(__dirname, '../data/users.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return { users: [] };
  }
}

function writeStore(store) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// Returns user object (without passwordHash) or null
async function validateUser(username, password) {
  const store = readStore();
  const u = store.users.find(u => u.username.toUpperCase() === username.toUpperCase());
  if (!u) return null;
  const ok = await bcrypt.compare(password, u.passwordHash);
  if (!ok) return null;
  return { username: u.username, displayName: u.displayName, role: u.role };
}

function getUser(username) {
  const store = readStore();
  const u = store.users.find(u => u.username.toUpperCase() === username.toUpperCase());
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

function listUsers() {
  return readStore().users.map(({ passwordHash, ...safe }) => safe);
}

async function createUser({ username, password, displayName, role }) {
  const store = readStore();
  const exists = store.users.find(u => u.username.toUpperCase() === username.toUpperCase());
  if (exists) throw new Error(`User '${username}' already exists`);
  const passwordHash = await bcrypt.hash(password, 10);
  store.users.push({ username: username.toUpperCase(), displayName, role, passwordHash, createdAt: new Date().toISOString() });
  writeStore(store);
}

async function updateUser(username, updates) {
  const store = readStore();
  const idx = store.users.findIndex(u => u.username.toUpperCase() === username.toUpperCase());
  if (idx === -1) throw new Error(`User '${username}' not found`);
  if (updates.password) {
    updates.passwordHash = await bcrypt.hash(updates.password, 10);
    delete updates.password;
  }
  store.users[idx] = { ...store.users[idx], ...updates };
  writeStore(store);
}

function deleteUser(username) {
  const store = readStore();
  const before = store.users.length;
  store.users = store.users.filter(u => u.username.toUpperCase() !== username.toUpperCase());
  if (store.users.length === before) throw new Error(`User '${username}' not found`);
  writeStore(store);
}

module.exports = { validateUser, getUser, listUsers, createUser, updateUser, deleteUser };

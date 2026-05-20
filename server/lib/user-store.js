const fs   = require('fs');
const path = require('path');
const FILE = path.resolve(__dirname, '../data/users.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}

function writeAll(users) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, FILE);
  } catch (_) {
    // Windows: destination exists — unlink first
    try { fs.unlinkSync(FILE); } catch (_2) {}
    fs.renameSync(tmp, FILE);
  }
}

function findUser(username) {
  return readAll().find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
}

function listUsers() { return readAll(); }

function createUser(u) {
  const all = readAll();
  if (all.find(x => x.username.toLowerCase() === u.username.toLowerCase()))
    throw new Error(`User '${u.username}' already exists`);
  all.push({ ...u, username: u.username.toLowerCase(), active: true, created_at: new Date().toISOString() });
  writeAll(all);
}

function updateUser(username, updates) {
  const all = readAll();
  const idx = all.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) throw new Error(`User '${username}' not found`);
  delete updates.passwordHash;
  all[idx] = { ...all[idx], ...updates };
  writeAll(all);
}

function deleteUser(username) {
  const all = readAll();
  const idx = all.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) throw new Error(`User '${username}' not found`);
  all.splice(idx, 1);
  writeAll(all);
}

module.exports = { findUser, listUsers, createUser, updateUser, deleteUser };

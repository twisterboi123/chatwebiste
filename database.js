const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'users.db');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('journal_mode = WAL');

async function load() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const count = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  console.log(`Database loaded: ${count} users`);
}

async function save() {
  // SQLite auto-saves; kept for API compatibility
}

async function getUser(username) {
  const row = db.prepare('SELECT username, password FROM users WHERE username = ?').get(username.toLowerCase());
  return row || null;
}

async function createUser(username, password) {
  const userId = username.toLowerCase();
  try {
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(userId, password);
    return { username: userId, password };
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      throw new Error('Username already exists');
    }
    throw err;
  }
}

async function userExists(username) {
  const row = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username.toLowerCase());
  return Boolean(row);
}

async function getAllUsers() {
  return db.prepare('SELECT username, created_at FROM users').all();
}

module.exports = {
  load,
  save,
  getUser,
  createUser,
  userExists,
  getAllUsers,
};

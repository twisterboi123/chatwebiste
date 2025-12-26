const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('DATABASE_URL is not set. Please configure Render Postgres.');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : false,
});

async function load() {
  if (!connectionString) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  console.log(`Database loaded: ${rows[0].count} users`);
}

async function save() {
  // no-op for postgres; kept for API compatibility
}

async function getUser(username) {
  if (!connectionString) return null;
  const { rows } = await pool.query('SELECT username, password FROM users WHERE username = $1', [username.toLowerCase()]);
  return rows[0] || null;
}

async function createUser(username, password) {
  if (!connectionString) throw new Error('DATABASE_URL not configured');
  const userId = username.toLowerCase();
  await pool.query(
    'INSERT INTO users (username, password) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
    [userId, password]
  );
  return { username, password };
}

async function userExists(username) {
  if (!connectionString) return false;
  const { rows } = await pool.query('SELECT 1 FROM users WHERE username = $1', [username.toLowerCase()]);
  return rows.length > 0;
}

async function getAllUsers() {
  if (!connectionString) return [];
  const { rows } = await pool.query('SELECT username, created_at FROM users');
  return rows;
}

module.exports = {
  load,
  save,
  getUser,
  createUser,
  userExists,
  getAllUsers,
};

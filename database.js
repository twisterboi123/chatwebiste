const fs = require('fs').promises;
const path = require('path');

const DB_FILE = path.join(__dirname, 'database.json');

// Initialize database structure
let db = {
  users: {},
  version: 1
};

// Load database from file
async function load() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    db = JSON.parse(data);
    console.log(`Database loaded: ${Object.keys(db.users).length} users`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist, create it
      await save();
      console.log('Database created');
    } else {
      console.error('Error loading database:', error);
    }
  }
}

// Save database to file
async function save() {
  try {
    await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving database:', error);
  }
}

// User operations
function getUser(username) {
  return db.users[username.toLowerCase()];
}

function createUser(username, password) {
  const userId = username.toLowerCase();
  db.users[userId] = {
    username,
    password,
    createdAt: Date.now()
  };
  save(); // Save asynchronously
  return db.users[userId];
}

function userExists(username) {
  return db.users.hasOwnProperty(username.toLowerCase());
}

function getAllUsers() {
  return Object.values(db.users);
}

module.exports = {
  load,
  save,
  getUser,
  createUser,
  userExists,
  getAllUsers
};

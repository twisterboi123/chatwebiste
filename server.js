require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cookieParser = require("cookie-parser");
const db = require("./database");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const publicDir = path.join(__dirname, "public");

app.use(express.static(publicDir));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Session middleware (simple in-memory sessions)
const sessions = new Map(); // sessionId -> { username, userId }

function generateSessionId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

async function requireAuth(req, res, next) {
  const sessionId = req.cookies.sessionId;
  let session = sessions.get(sessionId);

  // Rebuild session from DB if memory was cleared (e.g., Render restart)
  if (!session && sessionId) {
    const user = await db.getUser(sessionId);
    if (user) {
      session = { username: user.username, userId: sessionId };
      sessions.set(sessionId, session);
    }
  }

  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.user = session;
  next();
}

// In-memory state (no database yet)
const rooms = new Map(); // roomId -> room
const clients = new Map(); // socketId -> user state
const randomQueue = []; // socketIds
const interestQueues = new Map(); // interest -> [socketIds]

const DEFAULT_WAIT_MS = 30_000;

// Create default Lobby room
const LOBBY_ID = "room-lobby";
rooms.set(LOBBY_ID, {
  id: LOBBY_ID,
  name: "Lobby",
  emoji: "🏠",
  topic: "Welcome! Main chat room for everyone",
  tags: [],
  isPrivate: false,
  creatorId: "system",
  moderatorId: "system",
  members: new Set(),
  muted: new Set(),
  closed: false,
});

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/api/stats", (req, res) => {
  res.json({
    onlineUsers: clients.size,
    totalRooms: rooms.size,
    activeRooms: [...rooms.values()].filter(r => r.members.size > 0).length
  });
});

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  if (await db.userExists(username)) {
    return res.status(400).json({ error: 'Username already taken' });
  }
  
  await db.createUser(username, password);
  
  // Use stable sessionId = username to survive restarts (db-backed)
  const sessionId = username.toLowerCase();
  sessions.set(sessionId, { username, userId: sessionId });
  
  res.cookie('sessionId', sessionId, { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ success: true, username });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  const user = await db.getUser(username);
  
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  
  const sessionId = username.toLowerCase();
  sessions.set(sessionId, { username: user.username, userId: sessionId });
  
  res.cookie('sessionId', sessionId, { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ success: true, username: user.username });
});

app.post("/api/logout", (req, res) => {
  const sessionId = req.headers.cookie?.split('sessionId=')[1]?.split(';')[0];
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.clearCookie('sessionId');
  res.json({ success: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

// ---------- Socket layer ----------
io.on("connection", async (socket) => {
  // Check authentication
  const sessionId = socket.handshake.auth?.sessionId || (socket.handshake.headers.cookie || '').split('sessionId=')[1]?.split(';')[0];
  let session = sessions.get(sessionId);

  // Rebuild session from DB if missing in memory
  if (!session && sessionId) {
    const user = await db.getUser(sessionId);
    if (user) {
      session = { username: user.username, userId: sessionId };
      sessions.set(sessionId, session);
    }
  }
  
  if (!session) {
    socket.emit("auth:required");
    socket.disconnect();
    return;
  }
  
  const username = session.username;
  const user = {
    id: socket.id,
    username,
    status: "idle", // idle | room | random | queue
    roomId: null,
    partnerId: null,
    randomRoomId: null,
    lastPartnerId: null,
    interests: new Set(),
    interestEnabled: false,
    waitMs: DEFAULT_WAIT_MS,
    waitUntil: 0,
    inRandomQueue: false,
    inInterestQueue: false,
  };
  clients.set(socket.id, user);

  socket.emit("init", {
    username,
    rooms: serializeRooms(),
    status: user.status,
  });

  // Rooms
  socket.on("room:create", (payload = {}, cb) => {
    const { name, topic, tags, isPrivate, emoji } = payload;
    const cleanName = (name || "").trim().slice(0, 60);
    if (!cleanName) return cb?.({ error: "Room name required" });
    const id = `room-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const room = {
      id,
      name: cleanName,
      emoji: (emoji || "").trim().slice(0, 2) || "💬",
      topic: (topic || "").trim().slice(0, 120),
      tags: parseTags(tags),
      isPrivate: Boolean(isPrivate),
      creatorId: socket.id,
      moderatorId: socket.id,
      members: new Set(),
      muted: new Set(),
      closed: false,
    };
    rooms.set(id, room);
    joinRoom(socket, room);
    broadcastRooms();
    cb?.({ ok: true, room });
  });

  socket.on("room:join", (roomId, cb) => {
    const room = rooms.get(roomId);
    if (!room || room.closed) return cb?.({ error: "Room not available" });
    joinRoom(socket, room);
    cb?.({ ok: true, room });
  });

  socket.on("room:leave", () => {
    leaveRoom(socket, true);
    setIdle(user, socket);
  });

  socket.on("room:message", (text) => {
    const u = clients.get(socket.id);
    if (!u?.roomId) return;
    const room = rooms.get(u.roomId);
    if (!room || room.closed) return;
    if (room.muted.has(socket.id)) return;

    const clean = sanitizeText(text, 500);
    if (!clean) return;
    const msg = makeMessage("text", clean, u.username, room.id, u.id);
    io.to(room.id).emit("room:message", msg);
  });

  socket.on("room:delete", (messageId) => {
    const u = clients.get(socket.id);
    if (!u?.roomId) return;
    const room = rooms.get(u.roomId);
    if (!room || room.closed) return;
    if (!isModerator(room, socket.id)) return;
    io.to(room.id).emit("room:delete", { id: messageId });
  });

  socket.on("room:mute", (targetId) => {
    const room = getRoomFor(socket.id);
    if (!room || !isModerator(room, socket.id)) return;
    room.muted.add(targetId);
    io.to(room.id).emit("room:system", makeSystem(`${safeUserNameById(targetId)} was muted`));
  });

  socket.on("room:kick", (targetId) => {
    const room = getRoomFor(socket.id);
    if (!room || !isModerator(room, socket.id)) return;
    if (room.members.has(targetId)) {
      const targetSocket = io.sockets.sockets.get(targetId);
      room.members.delete(targetId);
      room.muted.delete(targetId);
      if (targetSocket) {
        targetSocket.leave(room.id);
        const tu = clients.get(targetId);
        if (tu) {
          tu.roomId = null;
          tu.status = "idle";
        }
        targetSocket.emit("room:kicked");
      }
      io.to(room.id).emit("room:system", makeSystem(`${safeUserNameById(targetId)} was kicked`));
      ensureModerator(room);
      if (room.members.size === 0) rooms.delete(room.id);
      broadcastRooms();
    }
  });

  socket.on("room:close", () => {
    const room = getRoomFor(socket.id);
    if (!room || !isModerator(room, socket.id)) return;
    room.closed = true;
    io.to(room.id).emit("room:closed");
    for (const memberId of [...room.members]) {
      const memberSocket = io.sockets.sockets.get(memberId);
      if (memberSocket) memberSocket.leave(room.id);
      const mu = clients.get(memberId);
      if (mu) {
        mu.roomId = null;
        mu.status = "idle";
      }
    }
    rooms.delete(room.id);
    broadcastRooms();
  });

  // Random chat (1:1)
  socket.on("random:start", () => {
    const u = clients.get(socket.id);
    if (!u) return;
    leaveRoom(socket, false);
    queueForRandom(u);
  });

  socket.on("random:next", () => {
    const u = clients.get(socket.id);
    if (!u) return;
    if (u.partnerId) {
      endPair(u, "next");
      queueForRandom(u);
    } else {
      removeFromQueues(u);
      queueForRandom(u);
    }
  });

  socket.on("random:stop", () => {
    const u = clients.get(socket.id);
    if (!u) return;
    if (u.partnerId) endPair(u, "stop");
    removeFromQueues(u);
    setIdle(u, socket);
  });

  socket.on("random:message", (text) => {
    const u = clients.get(socket.id);
    if (!u || u.status !== "random" || !u.randomRoomId) return;
    const clean = sanitizeText(text, 500);
    if (!clean) return;
    const msg = makeMessage("text", clean, u.username, u.randomRoomId, u.id);
    io.to(u.randomRoomId).emit("random:message", msg);
  });

  // Interest settings
  socket.on("interests:update", (tags) => {
    const u = clients.get(socket.id);
    if (!u) return;
    u.interests = parseTags(tags);
  });

  socket.on("interests:toggle", (enabled) => {
    const u = clients.get(socket.id);
    if (!u) return;
    u.interestEnabled = Boolean(enabled);
  });

  socket.on("interests:wait", (ms) => {
    const u = clients.get(socket.id);
    if (!u) return;
    u.waitMs = clampWait(ms);
  });

  socket.on("disconnect", () => {
    const u = clients.get(socket.id);
    if (!u) return;
    if (u.partnerId) endPair(u, "disconnect");
    leaveRoom(socket, false);
    removeFromQueues(u);
    clients.delete(socket.id);
    broadcastRooms();
  });
});

// ---------- Helpers ----------
function joinRoom(socket, room) {
  const u = clients.get(socket.id);
  if (!u) return;
  removeFromQueues(u);
  if (u.partnerId) endPair(u, "switch");

  leaveRoom(socket, false);

  room.members.add(socket.id);
  socket.join(room.id);
  u.roomId = room.id;
  u.status = "room";
  ensureModerator(room);

  io.to(room.id).emit("room:system", makeSystem(`${u.username} joined #${room.name}`));
  broadcastRooms();
}

function leaveRoom(socket, notify) {
  const u = clients.get(socket.id);
  if (!u || !u.roomId) return;
  const room = rooms.get(u.roomId);
  if (room) {
    room.members.delete(socket.id);
    room.muted.delete(socket.id);
    socket.leave(room.id);
    if (notify) {
      io.to(room.id).emit("room:system", makeSystem(`${u.username} left`));
    }
    ensureModerator(room);
    if (room.members.size === 0) {
      rooms.delete(room.id);
    }
    broadcastRooms();
  }
  u.roomId = null;
}

function getRoomFor(socketId) {
  const u = clients.get(socketId);
  if (!u?.roomId) return null;
  return rooms.get(u.roomId);
}

function isModerator(room, socketId) {
  return room.moderatorId === socketId;
}

function ensureModerator(room) {
  if (!room.moderatorId || !room.members.has(room.moderatorId)) {
    room.moderatorId = room.members.values().next().value || null;
  }
}

function broadcastRooms() {
  io.emit("rooms", serializeRooms());
}

function serializeRooms() {
  return [...rooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    emoji: r.emoji || "💬",
    topic: r.topic,
    tags: [...r.tags],
    isPrivate: r.isPrivate,
    members: r.members.size,
    closed: r.closed,
  }));
}

function parseTags(input) {
  if (!input) return new Set();
  if (Array.isArray(input)) return new Set(input.map(cleanTag).filter(Boolean));
  return new Set(
    String(input)
      .split(/[,\s]+/)
      .map(cleanTag)
      .filter(Boolean)
  );
}

function cleanTag(tag) {
  return String(tag || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
}

function sanitizeText(text, max = 500) {
  return typeof text === "string" ? text.trim().slice(0, max) : "";
}

function makeMessage(type, body, username, scopeId, userId) {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    type,
    text: type === "text" ? body : undefined,
    username,
    scopeId,
    userId,
    ts: Date.now(),
  };
}

function makeSystem(text) {
  return { type: "system", text, ts: Date.now() };
}

function safeUserNameById(id) {
  const u = clients.get(id);
  return u ? u.username : "user";
}

function safeUsername(name) {
  if (typeof name !== "string") return "";
  return name.trim().replace(/[^\w\s.-]/g, "").slice(0, 24) || "";
}

function genGuest() {
  return `Guest${Math.floor(Math.random() * 9000) + 1000}`;
}

// ---------- Random chat / Interest matching ----------
function queueForRandom(u) {
  removeFromQueues(u);
  u.partnerId = null;
  u.randomRoomId = null;
  if (u.interestEnabled && u.interests.size > 0) {
    u.inInterestQueue = true;
    u.waitUntil = Date.now() + u.waitMs;
    for (const interest of u.interests) {
      const q = interestQueues.get(interest) || [];
      q.push(u.id);
      interestQueues.set(interest, q);
    }
  } else {
    u.inRandomQueue = true;
    randomQueue.push(u.id);
  }
  u.status = "queue";
  attemptInterestMatches();
  attemptRandomMatches();
  const sock = io.sockets.sockets.get(u.id);
  sock?.emit("status", { status: "queue" });
}

function removeFromQueues(u) {
  if (u.inRandomQueue) {
    const idx = randomQueue.indexOf(u.id);
    if (idx >= 0) randomQueue.splice(idx, 1);
  }
  if (u.inInterestQueue) {
    for (const [key, q] of interestQueues.entries()) {
      const idx = q.indexOf(u.id);
      if (idx >= 0) q.splice(idx, 1);
      if (q.length === 0) interestQueues.delete(key);
    }
  }
  u.inRandomQueue = false;
  u.inInterestQueue = false;
  u.waitUntil = 0;
}

function attemptInterestMatches() {
  for (const [interest, queue] of interestQueues.entries()) {
    while (queue.length > 1) {
      const aId = queue.shift();
      const bIndex = queue.findIndex((id) => canPair(aId, id));
      if (bIndex === -1) {
        queue.unshift(aId);
        break;
      }
      const bId = queue.splice(bIndex, 1)[0];
      pairUsers(aId, bId, true);
    }
    if (queue.length === 0) interestQueues.delete(interest);
  }
}

function attemptRandomMatches() {
  while (randomQueue.length > 1) {
    const aId = randomQueue.shift();
    const bIndex = randomQueue.findIndex((id) => canPair(aId, id));
    if (bIndex === -1) {
      randomQueue.unshift(aId);
      break;
    }
    const bId = randomQueue.splice(bIndex, 1)[0];
    pairUsers(aId, bId, false);
  }
}

function canPair(aId, bId) {
  if (aId === bId) return false;
  const a = clients.get(aId);
  const b = clients.get(bId);
  if (!a || !b) return false;
  if (a.partnerId || b.partnerId) return false;
  if (a.lastPartnerId === bId || b.lastPartnerId === aId) return false;
  return true;
}

function pairUsers(aId, bId, isInterest) {
  const a = clients.get(aId);
  const b = clients.get(bId);
  if (!a || !b) return;
  removeFromQueues(a);
  removeFromQueues(b);

  const roomId = `rand-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  a.partnerId = bId;
  b.partnerId = aId;
  a.randomRoomId = roomId;
  b.randomRoomId = roomId;
  a.lastPartnerId = bId;
  b.lastPartnerId = aId;
  a.status = "random";
  b.status = "random";

  const aSock = io.sockets.sockets.get(aId);
  const bSock = io.sockets.sockets.get(bId);
  aSock?.join(roomId);
  bSock?.join(roomId);

  io.to(roomId).emit("random:matched", {
    roomId,
    partner: { id: bId, name: b.username },
    you: { id: aId, name: a.username },
    isInterest,
  });
  io.to(roomId).emit("status", { status: "random" });
}

function endPair(user, reason) {
  const partnerId = user.partnerId;
  const roomId = user.randomRoomId;
  const partner = partnerId ? clients.get(partnerId) : null;
  user.partnerId = null;
  user.randomRoomId = null;

  const sock = io.sockets.sockets.get(user.id);
  if (sock && roomId) sock.leave(roomId);

  if (partner) {
    partner.partnerId = null;
    partner.randomRoomId = null;
    const psock = io.sockets.sockets.get(partner.id);
    if (psock && roomId) psock.leave(roomId);
    // Return partner to queue when the other leaves
    queueForRandom(partner);
    psock?.emit("random:ended", { reason: reason || "left" });
  }
  user.status = "idle";
}

function setIdle(user, socket) {
  user.status = "idle";
  socket?.emit("status", { status: "idle" });
}

function clampWait(ms) {
  const n = Number(ms) || DEFAULT_WAIT_MS;
  return Math.max(5_000, Math.min(3_600_000, n));
}

// Periodic timeout check for interest queues -> fallback to random
setInterval(() => {
  const now = Date.now();
  for (const u of clients.values()) {
    if (u.inInterestQueue && u.waitUntil && now > u.waitUntil) {
      removeFromQueues(u);
      u.interestEnabled = false; // fallback to random
      queueForRandom(u);
    }
  }
}, 1500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  await db.load();
  console.log(`Server running on http://localhost:${PORT}`);
});

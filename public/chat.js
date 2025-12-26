const els = {
  username: document.getElementById("username"),
  saveUsername: document.getElementById("save-username"),
  status: document.getElementById("status"),
  roomList: document.getElementById("room-list"),
  roomCards: document.getElementById("room-cards"),
  roomsView: document.getElementById("rooms-view"),
  chatView: document.getElementById("chat-view"),
  startRandom: document.getElementById("start-random"),
  nextRandom: document.getElementById("next-random"),
  stopRandom: document.getElementById("stop-random"),
  randomControls: document.getElementById("random-controls"),
  interestToggle: document.getElementById("interest-toggle"),
  interestInput: document.getElementById("interest-input"),
  messages: document.getElementById("messages"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("msg"),
  contextLabel: document.getElementById("context-label"),
  contextSub: document.getElementById("context-sub"),
};

let username = loadUsername();
els.username.value = username;

// Get sessionId from cookie
function getSessionId() {
  const match = document.cookie.match(/sessionId=([^;]+)/);
  console.log('Looking for sessionId, cookies:', document.cookie, 'match:', match);
  return match ? match[1] : null;
}

const sessionId = getSessionId();
if (!sessionId) {
  console.log('No session found, redirecting to login');
  window.location.href = 'login.html';
}

const socket = io({ auth: { sessionId } });

let mode = "idle"; // idle | room | random | queue
let currentRoom = null;
let currentPartner = null;

// Initial data
socket.on("init", (data) => {
  username = data.username; // Use server-provided username
  els.username.value = username;
  renderRooms(data.rooms || []);
  setStatus(data.status || "idle");
});

// Auth required
socket.on("auth:required", () => {
  window.location.href = 'login.html';
});

// Room list updates
socket.on("rooms", renderRooms);

// Room events
socket.on("room:message", (msg) => renderMessage(msg, "Room Chat"));
socket.on("room:system", (msg) => renderMessage({ ...msg, type: "system" }, "Room Chat"));
socket.on("room:delete", ({ id }) => removeMessage(id));
socket.on("room:kicked", () => {
  currentRoom = null;
  setStatus("idle");
  notify("You were kicked from the room.");
});
socket.on("room:closed", () => {
  currentRoom = null;
  setStatus("idle");
  notify("Room closed.");
});

// Random chat events
socket.on("random:matched", (data) => {
  mode = "random";
  currentPartner = data.partner?.name || "Partner";
  currentRoom = null;
  setContext("Random Chat", data.isInterest ? "Interest match" : "Random match");
  setStatus("random");
  clearMessages();
});

socket.on("random:message", (msg) => renderMessage(msg, "Random Chat"));
socket.on("random:ended", () => {
  currentPartner = null;
  setStatus("queue");
  setContext("Random Chat", "Re-queued");
});

// Generic status updates
socket.on("status", (payload) => {
  if (payload?.status) setStatus(payload.status);
});

// UI actions
els.saveUsername.addEventListener("click", () => {
  username = els.username.value.trim() || loadUsername();
  els.username.value = username;
  localStorage.setItem("cl_name", username);
  socket.auth = { username };
  socket.connect();
});

// Create room form moved to create-room.html

els.startRandom.addEventListener("click", () => {
  pushInterestSettings();
  socket.emit("random:start");
  setContext("Random Chat", "Finding a partner...");
  setStatus("queue");
  clearMessages();
  if (els.randomControls) els.randomControls.style.display = "block";
});

els.nextRandom.addEventListener("click", () => {
  socket.emit("random:next");
  setContext("Random Chat", "Finding a new partner...");
  setStatus("queue");
  clearMessages();
});

els.stopRandom.addEventListener("click", () => {
  socket.emit("random:stop");
  setContext("Browse Rooms", "Select a room to join");
  setStatus("idle");
  if (els.randomControls) els.randomControls.style.display = "none";
  showRoomsView();
});

els.interestToggle.addEventListener("change", pushInterestSettings);
els.interestInput.addEventListener("blur", pushInterestSettings);

els.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;

  if (mode === "room" && currentRoom) {
    socket.emit("room:message", text);
  } else if (mode === "random") {
    socket.emit("random:message", text);
  }
  els.chatInput.value = "";
  els.chatInput.focus();
});

function renderRooms(list = []) {
  // Render sidebar room list
  els.roomList.innerHTML = "";
  list.forEach((room) => {
    const li = document.createElement("li");
    li.className = "room-item";
    if (currentRoom === room.id && mode === "room") {
      li.classList.add("active");
    }
    li.innerHTML = `
      <div class="room-info">
        <div class="room-emoji">${room.emoji || "💬"}</div>
        <div class="room-details">
          <div class="room-name">${room.name}</div>
          <div class="room-count">${room.members} online</div>
        </div>
      </div>
    `;
    li.addEventListener("click", () => joinRoomById(room.id, room));
    els.roomList.appendChild(li);
  });

  // Render main room cards
  els.roomCards.innerHTML = "";
  list.forEach((room) => {
    const card = document.createElement("div");
    card.className = "room-card";
    card.innerHTML = `
      <div class="room-card-header">
        <div>
          <div style="font-size: 32px; margin-bottom: 8px;">${room.emoji || "💬"}</div>
          <div class="room-card-title">${room.name}</div>
        </div>
        <div class="room-card-users">${room.members}</div>
      </div>
      <div class="room-card-description">${room.topic || "No description"}</div>
      ${room.tags && room.tags.length > 0 ? `
        <div class="room-card-tags">
          ${room.tags.map(tag => `<span class="room-tag">${tag}</span>`).join("")}
        </div>
      ` : ""}
      <div class="room-card-footer">
        <button class="btn primary full join-room-btn">Join Chat</button>
      </div>
    `;
    card.querySelector(".join-room-btn").addEventListener("click", () => joinRoomById(room.id, room));
    els.roomCards.appendChild(card);
  });
}

function joinRoomById(roomId, room) {
  socket.emit("room:join", roomId);
  currentRoom = roomId;
  currentPartner = null;
  mode = "room";
  setContext("Room Chat", `${room.emoji || "💬"} ${room.name}`);
  setStatus("room");
  clearMessages();
  showChatView();
  socket.emit("rooms"); // Refresh room list to update active state
}

function renderMessage(msg, label) {
  const li = document.createElement("li");
  li.className = "message";
  li.dataset.id = msg.id || "";

  if (msg.type === "system") {
    li.classList.add("message-system");
    li.textContent = msg.text;
  } else {
    const author = document.createElement("span");
    author.className = "message-author";
    author.textContent = msg.username || "User";
    
    const text = document.createElement("span");
    text.textContent = msg.text || "";
    
    li.appendChild(author);
    li.appendChild(text);
  }

  els.messages.appendChild(li);
  els.messages.scrollTop = els.messages.scrollHeight;
  setContext(label || "Chat", currentPartner ? `With ${currentPartner}` : "");
}

function removeMessage(id) {
  if (!id) return;
  const el = els.messages.querySelector(`[data-id="${id}"]`);
  if (el) el.remove();
}

function setStatus(state) {
  mode = state;
  els.status.textContent = state;
  
  // Toggle views based on state
  if (state === "idle") {
    showRoomsView();
  } else {
    showChatView();
  }
}

function showRoomsView() {
  els.roomsView.style.display = "block";
  els.chatView.style.display = "none";
}

function showChatView() {
  els.roomsView.style.display = "none";
  els.chatView.style.display = "block";
}

function setContext(title, sub) {
  els.contextLabel.textContent = title;
  els.contextSub.textContent = sub || "";
}

function clearMessages() {
  els.messages.innerHTML = "";
}

function pushInterestSettings() {
  const enabled = els.interestToggle.checked;
  const tags = els.interestInput.value;
  const waitMs = 30000; // Default 30 seconds
  socket.emit("interests:toggle", enabled);
  socket.emit("interests:update", tags);
  socket.emit("interests:wait", waitMs);
}

function loadUsername() {
  const existing = localStorage.getItem("cl_name");
  if (existing) return existing;
  const generated = `Guest${Math.floor(Math.random() * 9000) + 1000}`;
  localStorage.setItem("cl_name", generated);
  return generated;
}

function notify(msg) {
  renderMessage({ type: "system", text: msg }, "System");
}


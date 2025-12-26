const els = {
  usernameDisplay: document.getElementById("username-display"),
  status: document.getElementById("status"),
  backToChat: document.getElementById("back-to-chat"),
  logoutBtn: document.getElementById("logout-btn"),
  joinRoomBtn: document.querySelector(".join-room-btn"),
  randomChatBtn: document.querySelector(".random-chat-btn"),
  interestBtn: document.querySelector(".interest-btn"),
  interestModal: document.getElementById("interest-modal"),
  interestToggle: document.getElementById("interest-toggle"),
  interestInput: document.getElementById("interest-input"),
  saveInterests: document.getElementById("save-interests"),
  modalClose: document.querySelector(".modal-close"),
  modalCloseBtn: document.querySelector(".modal-close-btn"),
};

let username = "";

// Get sessionId from cookie
function getSessionId() {
  const match = document.cookie.match(/sessionId=([^;]+)/);
  return match ? match[1] : null;
}

const sessionId = getSessionId();
if (!sessionId) {
  window.location.href = 'login.html';
}

const socket = io({ auth: { sessionId } });

// Initial data
socket.on("init", (data) => {
  username = data.username;
  els.usernameDisplay.textContent = `👤 ${username}`;
  setStatus(data.status || "idle");
});

socket.on("auth:required", () => {
  window.location.href = 'login.html';
});

function setStatus(s) {
  els.status.textContent = s.charAt(0).toUpperCase() + s.slice(1);
  els.status.className = `status-badge status-${s}`;
}

// Navigate to chat rooms
els.joinRoomBtn.addEventListener("click", () => {
  window.location.href = 'chat.html';
});

// Start random chat
els.randomChatBtn.addEventListener("click", () => {
  socket.emit("random:start");
  window.location.href = 'chat.html';
});

// Open interest modal
els.interestBtn.addEventListener("click", () => {
  els.interestModal.style.display = "flex";
});

// Close modal
function closeModal() {
  els.interestModal.style.display = "none";
}

els.modalClose.addEventListener("click", closeModal);
els.modalCloseBtn.addEventListener("click", closeModal);

// Save interests
els.saveInterests.addEventListener("click", () => {
  const tags = els.interestInput.value
    .split(",")
    .map(t => t.trim())
    .filter(t => t);
  
  socket.emit("interests:update", tags);
  socket.emit("interests:toggle", els.interestToggle.checked);
  
  closeModal();
});

// Log out
els.logoutBtn.addEventListener("click", async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = 'login.html';
  } catch (err) {
    console.error('Logout failed:', err);
  }
});

// Back to chat
els.backToChat.addEventListener("click", () => {
  window.location.href = 'chat.html';
});

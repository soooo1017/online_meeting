const params = new URLSearchParams(location.search);
const roomCode = (params.get("code") || "").toUpperCase();
const isHost = params.get("host") === "1";
const roomName = params.get("name") ? decodeURIComponent(params.get("name")) : "미팅";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const JOIN_CHECK_DELAY_MS = 1200;

const clientId = crypto.randomUUID();
const peers = new Map(); // peerId -> { pc: RTCPeerConnection }

let localStream = null;
let channel = null;
let micOn = true;
let camOn = true;

const el = {
  loading: document.getElementById("state-loading"),
  loadingText: document.getElementById("loading-text"),
  error: document.getElementById("state-error"),
  errorText: document.getElementById("error-text"),
  room: document.getElementById("state-room"),
  videoGrid: document.getElementById("video-grid"),
  roomNameLabel: document.getElementById("room-name-label"),
  roomCodeLabel: document.getElementById("room-code-label"),
  btnCopyCode: document.getElementById("btn-copy-code"),
  btnCopyLink: document.getElementById("btn-copy-link"),
  btnToggleMic: document.getElementById("btn-toggle-mic"),
  btnToggleCam: document.getElementById("btn-toggle-cam"),
  btnLeave: document.getElementById("btn-leave"),
};

function showState(name) {
  el.loading.classList.toggle("hidden", name !== "loading");
  el.error.classList.toggle("hidden", name !== "error");
  el.room.style.display = name === "room" ? "flex" : "none";
}

function showError(message) {
  el.errorText.textContent = message;
  showState("error");
}

function videoTileId(peerId) {
  return `tile-${peerId}`;
}

function addVideoTile(peerId, stream, { local }) {
  let tile = document.getElementById(videoTileId(peerId));
  if (!tile) {
    tile = document.createElement("div");
    tile.id = videoTileId(peerId);
    tile.className = "video-tile" + (local ? " local" : "");
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    if (local) video.muted = true;
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = local ? "나" : "참가자";
    tile.appendChild(video);
    tile.appendChild(tag);
    el.videoGrid.appendChild(tile);
  }
  tile.querySelector("video").srcObject = stream;
}

function removeVideoTile(peerId) {
  const tile = document.getElementById(videoTileId(peerId));
  if (tile) tile.remove();
}

function sendSignal(to, data) {
  channel.send({
    type: "broadcast",
    event: "signal",
    payload: { from: clientId, to, ...data },
  });
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(peerId, { type: "ice-candidate", candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    addVideoTile(peerId, event.streams[0], { local: false });
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) {
      removePeer(peerId);
    }
  };

  return pc;
}

function getOrCreatePeer(peerId) {
  let peer = peers.get(peerId);
  if (!peer) {
    peer = { pc: createPeerConnection(peerId) };
    peers.set(peerId, peer);
  }
  return peer;
}

async function connectToPeer(peerId) {
  if (peers.has(peerId)) return;
  const { pc } = getOrCreatePeer(peerId);
  // 두 클라이언트 모두 서로에게 연결을 시도하므로, id를 비교해 한쪽만 offer를 보내게 함
  if (clientId < peerId) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(peerId, { type: "offer", sdp: offer });
  }
}

async function handleSignal(payload) {
  const { from, type } = payload;
  const { pc } = getOrCreatePeer(from);

  if (type === "offer") {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal(from, { type: "answer", sdp: answer });
  } else if (type === "answer") {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  } else if (type === "ice-candidate") {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    } catch (err) {
      console.error("ICE candidate 추가 실패", err);
    }
  }
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.pc.close();
  peers.delete(peerId);
  removeVideoTile(peerId);
}

async function leaveRoom() {
  peers.forEach((_, peerId) => removePeer(peerId));
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  if (channel) {
    await channel.untrack();
    await supabaseClient.removeChannel(channel);
  }
  location.href = "index.html";
}

function setupControls() {
  el.btnToggleMic.addEventListener("click", () => {
    micOn = !micOn;
    localStream.getAudioTracks().forEach((track) => (track.enabled = micOn));
    el.btnToggleMic.classList.toggle("off", !micOn);
    el.btnToggleMic.textContent = micOn ? "🎤" : "🔇";
  });

  el.btnToggleCam.addEventListener("click", () => {
    camOn = !camOn;
    localStream.getVideoTracks().forEach((track) => (track.enabled = camOn));
    el.btnToggleCam.classList.toggle("off", !camOn);
    el.btnToggleCam.textContent = camOn ? "📷" : "🚫";
  });

  el.btnLeave.addEventListener("click", leaveRoom);

  el.btnCopyCode.addEventListener("click", () => copyToClipboard(roomCode, el.btnCopyCode, "코드 복사"));
  el.btnCopyLink.addEventListener("click", () => {
    const link = new URL(`room.html?code=${roomCode}`, location.href).toString();
    copyToClipboard(link, el.btnCopyLink, "링크 복사");
  });
}

async function copyToClipboard(text, button, resetLabel) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = "복사됨!";
    setTimeout(() => (button.textContent = resetLabel ?? original), 1500);
  } catch (err) {
    console.error("클립보드 복사 실패", err);
  }
}

async function init() {
  if (!roomCode) {
    location.href = "index.html";
    return;
  }

  el.roomNameLabel.textContent = roomName;
  el.roomCodeLabel.textContent = roomCode;
  setupControls();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    showError("캠/마이크 권한이 필요해요. 브라우저 권한 설정을 확인해주세요.");
    return;
  }

  showState("room");
  addVideoTile(clientId, localStream, { local: true });

  channel = supabaseClient.channel(`room-${roomCode}`, {
    config: { presence: { key: clientId } },
  });

  channel
    .on("presence", { event: "join" }, ({ key }) => {
      if (key !== clientId) connectToPeer(key);
    })
    .on("presence", { event: "leave" }, ({ key }) => {
      removePeer(key);
    })
    .on("broadcast", { event: "signal" }, ({ payload }) => {
      if (payload.to === clientId) handleSignal(payload);
    })
    .subscribe(async (status) => {
      if (status !== "SUBSCRIBED") return;
      await channel.track({ joinedAt: Date.now() });

      if (!isHost) {
        setTimeout(() => {
          const state = channel.presenceState();
          const others = Object.keys(state).filter((key) => key !== clientId);
          if (others.length === 0) {
            leavePeersOnly();
            showError("방을 찾을 수 없어요. 코드를 다시 확인하거나, 방이 이미 종료되지 않았는지 확인해주세요.");
          } else {
            others.forEach((peerId) => connectToPeer(peerId));
          }
        }, JOIN_CHECK_DELAY_MS);
      }
    });
}

// 방을 못 찾았을 때는 화면 전환 전에 미디어/채널만 정리 (index.html로 리다이렉트하지 않음)
function leavePeersOnly() {
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  if (channel) supabaseClient.removeChannel(channel);
}

window.addEventListener("beforeunload", () => {
  if (channel) channel.untrack();
});

init();

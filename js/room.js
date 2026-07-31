const params = new URLSearchParams(location.search);
const roomCode = (params.get("code") || "").toUpperCase();
const isHost = params.get("host") === "1";
const roomName = params.get("name") ? decodeURIComponent(params.get("name")) : "미팅";
const nickname = params.get("nickname") ? decodeURIComponent(params.get("nickname")).slice(0, 20) : "";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const JOIN_CHECK_DELAY_MS = 1200;
const RECONNECT_GRACE_MS = 5000; // "disconnected" 상태가 이 시간 넘게 지속되면 재연결 시도
const RECONNECT_RETRY_DELAY_MS = 1000;

const clientId = crypto.randomUUID();
const peers = new Map(); // peerId -> { pc: RTCPeerConnection }
const peerMeta = new Map(); // peerId -> 마지막으로 받은 presence 정보 (닉네임 등)

let localStream = null;
let localScreenStream = null;
let channel = null;
let micOn = true;
let camOn = true;
let isSharingScreen = false;
let sharingPeerId = null; // 지금 화면 공유 중인 사람의 clientId (없으면 null)
let handRaised = false;
let chatOpen = false;
let unreadChatCount = 0;
let participantsOpen = false;
let roomStartedAt = Date.now();
let meetingId = null; // meetings 테이블의 row id (host가 생성, presence로 전파)
let hasRecordedJoin = false;

const screenShareSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "👏", "🎉"];

// ---- 발화자(말하는 사람) 감지 ----
// 파형(time-domain) 데이터의 RMS(실효값)로 음량을 판단한다. 주파수 대역 평균보다
// 목소리처럼 에너지가 넓게 퍼진 신호와 순음처럼 한 주파수에 몰린 신호 모두에 안정적으로 반응한다.
const SPEAKING_RMS_THRESHOLD = 0.02; // 0~1 스케일, 이 값보다 크면 "말하는 중"으로 판단 (필요하면 조정)
const SPEAKING_HANGOVER_MS = 400; // 잠깐 조용해져도 이 시간 동안은 계속 "말하는 중"으로 유지 (깜빡임 방지)
const SPEAKING_CHECK_INTERVAL_MS = 150;

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = AudioContextClass ? new AudioContextClass() : null;
const speakingAnalysers = new Map(); // peerId -> { source, analyser, dataArray }
const speakingUntil = new Map(); // peerId -> 이 시각까지는 "말하는 중"으로 취급

function attachSpeakingDetector(peerId, stream) {
  if (!audioCtx || speakingAnalysers.has(peerId)) return;
  if (stream.getAudioTracks().length === 0) return;

  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  speakingAnalysers.set(peerId, { source, analyser, dataArray: new Uint8Array(analyser.fftSize) });
}

function detachSpeakingDetector(peerId) {
  const entry = speakingAnalysers.get(peerId);
  if (entry) {
    entry.source.disconnect();
    speakingAnalysers.delete(peerId);
  }
  speakingUntil.delete(peerId);
  setSpeakingClass(peerId, false);
}

function setSpeakingClass(peerId, isSpeaking) {
  const tile = document.getElementById(videoTileId(peerId));
  if (tile) tile.classList.toggle("speaking", isSpeaking);
}

function speakingDetectionTick() {
  const now = Date.now();
  speakingAnalysers.forEach((entry, peerId) => {
    entry.analyser.getByteTimeDomainData(entry.dataArray);
    let sumSquares = 0;
    for (let i = 0; i < entry.dataArray.length; i++) {
      const normalized = (entry.dataArray[i] - 128) / 128; // -1..1
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / entry.dataArray.length);

    if (rms > SPEAKING_RMS_THRESHOLD) {
      speakingUntil.set(peerId, now + SPEAKING_HANGOVER_MS);
    }
    setSpeakingClass(peerId, (speakingUntil.get(peerId) || 0) > now);
  });
}

if (audioCtx) {
  setInterval(speakingDetectionTick, SPEAKING_CHECK_INTERVAL_MS);
  // 브라우저 자동재생 정책으로 AudioContext가 suspended 상태로 시작할 수 있어 깨워준다.
  audioCtx.resume().catch(() => {});
  document.addEventListener(
    "click",
    () => {
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    },
    { once: true },
  );
}

function defaultLabel(id) {
  return "참가자 " + id.slice(0, 4);
}

// 항상 이 객체 전체를 다시 track()해서 필드가 서로 덮어써지지 않게 한다.
const myPresence = {
  nickname: nickname || defaultLabel(clientId),
  joinedAt: Date.now(),
  micOn: true,
  sharing: false,
  sharingSince: 0,
  handRaised: false,
  isHost,
  // 방 이름은 만든 사람의 링크에만 담겨있어서, 참여자는 이 값을 host의 Presence로 전달받아야 한다.
  roomName: isHost ? roomName : null,
  meetingId: null, // meetings 테이블 row id, host가 만든 뒤 채워짐
};

function trackPresence(patch) {
  Object.assign(myPresence, patch);
  return channel.track(myPresence);
}

const el = {
  loading: document.getElementById("state-loading"),
  loadingText: document.getElementById("loading-text"),
  error: document.getElementById("state-error"),
  errorText: document.getElementById("error-text"),
  room: document.getElementById("state-room"),
  videoGrid: document.getElementById("video-grid"),
  tileRow: document.getElementById("tile-row"),
  mainStage: document.getElementById("main-stage"),
  roomNameLabel: document.getElementById("room-name-label"),
  roomCodeLabel: document.getElementById("room-code-label"),
  btnCopyCode: document.getElementById("btn-copy-code"),
  btnCopyLink: document.getElementById("btn-copy-link"),
  btnToggleMic: document.getElementById("btn-toggle-mic"),
  btnToggleCam: document.getElementById("btn-toggle-cam"),
  btnScreenShare: document.getElementById("btn-screen-share"),
  btnRaiseHand: document.getElementById("btn-raise-hand"),
  btnLeave: document.getElementById("btn-leave"),
  btnRetry: document.getElementById("btn-retry"),
  btnToggleChat: document.getElementById("btn-toggle-chat"),
  chatBadge: document.getElementById("chat-badge"),
  chatPanel: document.getElementById("chat-panel"),
  btnCloseChat: document.getElementById("btn-close-chat"),
  chatMessages: document.getElementById("chat-messages"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  btnReaction: document.getElementById("btn-reaction"),
  reactionPicker: document.getElementById("reaction-picker"),
  btnToggleParticipants: document.getElementById("btn-toggle-participants"),
  participantsCount: document.getElementById("participants-count"),
  participantsPanel: document.getElementById("participants-panel"),
  btnCloseParticipants: document.getElementById("btn-close-participants"),
  participantsList: document.getElementById("participants-list"),
  elapsedTime: document.getElementById("elapsed-time"),
};

el.btnRetry.addEventListener("click", () => location.reload());

function mediaErrorMessage(err) {
  switch (err.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "캠/마이크 접근이 차단되어 있어요.\n주소창 왼쪽의 자물쇠(또는 카메라) 아이콘을 눌러 카메라/마이크 권한을 '허용'으로 바꾼 뒤 다시 시도해주세요.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "캠 또는 마이크 장치를 찾을 수 없어요.\n기기가 제대로 연결되어 있는지 확인해주세요.";
    case "NotReadableError":
    case "TrackStartError":
      return "다른 프로그램이 캠/마이크를 사용 중인 것 같아요.\n다른 화상회의 앱을 종료하고 다시 시도해주세요.";
    default:
      return "캠/마이크 권한이 필요해요.\n브라우저 권한 설정을 확인해주세요.";
  }
}

function showState(name) {
  el.loading.classList.toggle("hidden", name !== "loading");
  el.error.classList.toggle("hidden", name !== "error");
  el.room.classList.toggle("hidden", name !== "room");
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
    // presence 정보가 ontrack보다 먼저 도착했을 수도 있으니, 이미 알고 있는 닉네임이 있으면 바로 반영한다.
    const knownMeta = peerMeta.get(peerId);
    tag.textContent = local ? "나" : (knownMeta && knownMeta.nickname) || defaultLabel(peerId);

    const indicators = document.createElement("div");
    indicators.className = "tile-indicators";
    const micIndicator = document.createElement("span");
    micIndicator.className = "mic-indicator hidden";
    micIndicator.textContent = "🔇";
    const handIndicator = document.createElement("span");
    handIndicator.className = "hand-indicator hidden";
    handIndicator.textContent = "✋";
    indicators.appendChild(micIndicator);
    indicators.appendChild(handIndicator);

    tile.appendChild(video);
    tile.appendChild(tag);
    tile.appendChild(indicators);
    el.tileRow.appendChild(tile);
  }
  tile.querySelector("video").srcObject = stream;
}

function removeVideoTile(peerId) {
  const tile = document.getElementById(videoTileId(peerId));
  if (tile) tile.remove();
}

// Presence에 올라온 닉네임/마이크/손들기 상태를 각 타일과 채팅 라벨에 반영한다.
function applyPresenceMeta() {
  if (!channel) return;
  const state = channel.presenceState();
  for (const key of Object.keys(state)) {
    const meta = state[key][0];
    if (!meta) continue;
    peerMeta.set(key, meta);

    const tile = document.getElementById(videoTileId(key));
    if (!tile) continue;
    const tagEl = tile.querySelector(".tag");
    if (tagEl) tagEl.textContent = key === clientId ? "나" : meta.nickname || defaultLabel(key);
    const micIndicator = tile.querySelector(".mic-indicator");
    if (micIndicator) micIndicator.classList.toggle("hidden", meta.micOn !== false);
    const handIndicator = tile.querySelector(".hand-indicator");
    if (handIndicator) handIndicator.classList.toggle("hidden", !meta.handRaised);
  }
}

// 화면 공유 중인 사람의 타일은 메인 스테이지로, 아니면 다시 작은 줄로 되돌린다.
function updateLayout() {
  Array.from(el.mainStage.querySelectorAll(".video-tile")).forEach((tile) => {
    tile.classList.remove("is-main");
    el.tileRow.appendChild(tile);
  });
  hideLocalScreenPreview();

  const active = !!sharingPeerId;
  el.videoGrid.classList.toggle("spotlight-active", active);
  el.mainStage.classList.toggle("hidden", !active);

  if (!active) return;

  if (sharingPeerId === clientId) {
    showLocalScreenPreview();
  } else {
    const tile = document.getElementById(videoTileId(sharingPeerId));
    if (tile) {
      tile.classList.add("is-main");
      el.mainStage.appendChild(tile);
    }
  }
}

function showLocalScreenPreview() {
  let video = document.getElementById("local-screen-video");
  if (!video) {
    video = document.createElement("video");
    video.id = "local-screen-video";
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    el.mainStage.appendChild(video);
  }
  video.srcObject = localScreenStream;
}

function hideLocalScreenPreview() {
  const video = document.getElementById("local-screen-video");
  if (video) video.remove();
}

// Presence에 기록된 sharing 플래그를 보고 "지금 화면 공유 중인 사람"을 다시 계산한다.
// 여러 명이 동시에 sharing:true인 순간(막 전환되는 찰나)이 있을 수 있어서,
// 목록 순서가 아니라 sharingSince(공유 시작 시각)가 가장 최근인 사람을 우승자로 뽑는다.
function recomputeSharer() {
  if (!channel) return;
  const state = channel.presenceState();
  let sharer = null;
  let latestSince = -Infinity;
  for (const key of Object.keys(state)) {
    const meta = state[key].find((m) => m.sharing);
    if (meta && (meta.sharingSince ?? 0) > latestSince) {
      latestSince = meta.sharingSince ?? 0;
      sharer = key;
    }
  }

  // 내가 공유 중인데 다른 사람이 새로 공유를 시작했으면 내 공유는 자동으로 내려간다.
  if (isSharingScreen && sharer !== clientId) {
    stopScreenShare();
    return; // stopScreenShare가 다시 recomputeSharer를 트리거함
  }

  sharingPeerId = sharer;
  updateLayout();
}

async function startScreenShare() {
  if (!screenShareSupported || isSharingScreen) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    return; // 사용자가 선택 창에서 취소한 경우
  }

  localScreenStream = stream;
  const screenTrack = stream.getVideoTracks()[0];
  screenTrack.onended = () => stopScreenShare();

  peers.forEach(({ pc }) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender) sender.replaceTrack(screenTrack);
  });

  isSharingScreen = true;
  el.btnScreenShare.classList.add("active");
  await trackPresence({ sharing: true, sharingSince: Date.now() });
  recomputeSharer();
}

async function stopScreenShare() {
  if (!isSharingScreen) return;
  isSharingScreen = false;
  el.btnScreenShare.classList.remove("active");

  if (localScreenStream) {
    localScreenStream.getTracks().forEach((track) => track.stop());
    localScreenStream = null;
  }

  const camTrack = localStream.getVideoTracks()[0];
  peers.forEach(({ pc }) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender && camTrack) sender.replaceTrack(camTrack);
  });

  if (channel) await trackPresence({ sharing: false });
  recomputeSharer();
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
    attachSpeakingDetector(peerId, event.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      handleConnectionLost(peerId);
    } else if (pc.connectionState === "disconnected") {
      // 와이파이가 잠깐 끊기는 정도는 몇 초 안에 자연 복구되기도 해서, 바로 끊지 않고 잠깐 지켜본다.
      setTimeout(() => {
        const peer = peers.get(peerId);
        if (peer && peer.pc === pc && pc.connectionState !== "connected") {
          handleConnectionLost(peerId);
        }
      }, RECONNECT_GRACE_MS);
    } else if (pc.connectionState === "closed") {
      removePeer(peerId);
    }
  };

  return pc;
}

// 연결이 끊어지면 기존 연결을 정리하고, 상대가 아직 방(Presence)에 남아있으면 재연결을 시도한다.
function handleConnectionLost(peerId) {
  removePeer(peerId);
  if (!channel) return;
  const state = channel.presenceState();
  if (state[peerId]) {
    setTimeout(() => connectToPeer(peerId), RECONNECT_RETRY_DELAY_MS);
  }
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
  detachSpeakingDetector(peerId);
}

async function leaveRoom() {
  peers.forEach((_, peerId) => removePeer(peerId));
  detachSpeakingDetector(clientId);
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  if (localScreenStream) localScreenStream.getTracks().forEach((track) => track.stop());
  if (meetingId) {
    try {
      await supabaseClient.from("meetings").update({ ended_at: new Date().toISOString() }).eq("id", meetingId);
    } catch (err) {
      console.error("미팅 기록 종료 시각 저장 실패", err);
    }
  }
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
    trackPresence({ micOn });
  });

  el.btnToggleCam.addEventListener("click", () => {
    camOn = !camOn;
    localStream.getVideoTracks().forEach((track) => (track.enabled = camOn));
    el.btnToggleCam.classList.toggle("off", !camOn);
    el.btnToggleCam.textContent = camOn ? "📷" : "🚫";
  });

  if (screenShareSupported) {
    el.btnScreenShare.addEventListener("click", () => {
      if (isSharingScreen) {
        stopScreenShare();
      } else {
        startScreenShare();
      }
    });
  } else {
    el.btnScreenShare.disabled = true;
    el.btnScreenShare.title = "이 브라우저에서는 화면 공유를 지원하지 않아요";
  }

  el.btnRaiseHand.addEventListener("click", () => {
    handRaised = !handRaised;
    el.btnRaiseHand.classList.toggle("active", handRaised);
    trackPresence({ handRaised });
  });

  el.btnLeave.addEventListener("click", leaveRoom);

  el.btnCopyCode.addEventListener("click", () => copyToClipboard(roomCode, el.btnCopyCode, "코드 복사"));
  el.btnCopyLink.addEventListener("click", () => {
    // room.html로 바로 보내면 닉네임 입력 단계를 건너뛰게 되니, index.html을 거치게 한다.
    const link = new URL(`index.html?code=${roomCode}`, location.href).toString();
    copyToClipboard(link, el.btnCopyLink, "링크 복사");
  });

  el.btnToggleChat.addEventListener("click", () => (chatOpen ? closeChat() : openChat()));
  el.btnCloseChat.addEventListener("click", closeChat);

  el.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    const message = { from: clientId, text, ts: Date.now() };
    channel.send({ type: "broadcast", event: "chat", payload: message });
    appendChatMessage(message, { mine: true });
    el.chatInput.value = "";
  });

  el.btnToggleParticipants.addEventListener("click", () => (participantsOpen ? closeParticipants() : openParticipants()));
  el.btnCloseParticipants.addEventListener("click", closeParticipants);

  buildReactionPicker();
  el.btnReaction.addEventListener("click", (e) => {
    e.stopPropagation();
    el.reactionPicker.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!el.reactionPicker.contains(e.target) && e.target !== el.btnReaction) {
      el.reactionPicker.classList.add("hidden");
    }
  });
}

function peerLabel(id) {
  if (id === clientId) return "나";
  const meta = peerMeta.get(id);
  return (meta && meta.nickname) || defaultLabel(id);
}

// ---- 리액션 ----

function buildReactionPicker() {
  REACTION_EMOJIS.forEach((emoji) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = emoji;
    btn.addEventListener("click", () => {
      channel.send({ type: "broadcast", event: "reaction", payload: { from: clientId, emoji } });
      showFloatingReaction(clientId, emoji);
      el.reactionPicker.classList.add("hidden");
    });
    el.reactionPicker.appendChild(btn);
  });
}

function showFloatingReaction(peerId, emoji) {
  const tile = document.getElementById(videoTileId(peerId));
  if (!tile) return;
  const span = document.createElement("span");
  span.className = "floating-reaction";
  span.textContent = emoji;
  span.addEventListener("animationend", () => span.remove());
  tile.appendChild(span);
}

// ---- 참가자 목록 ----

function openParticipants() {
  closeChat();
  participantsOpen = true;
  el.participantsPanel.classList.add("open");
  renderParticipantList();
}

function closeParticipants() {
  participantsOpen = false;
  el.participantsPanel.classList.remove("open");
}

function renderParticipantList() {
  if (!channel) return;
  const state = channel.presenceState();
  const ids = Object.keys(state);
  el.participantsCount.textContent = String(ids.length);

  el.participantsList.innerHTML = "";
  ids
    .slice()
    .sort((a, b) => (a === clientId ? -1 : b === clientId ? 1 : 0))
    .forEach((id) => {
      const meta = state[id][0] || {};
      const row = document.createElement("div");
      row.className = "participant-row";

      const name = document.createElement("span");
      name.textContent = id === clientId ? `나 (${meta.nickname || ""})` : meta.nickname || defaultLabel(id);
      row.appendChild(name);

      const icons = document.createElement("span");
      icons.className = "participant-icons";
      let iconText = "";
      if (meta.sharing) iconText += "🖥️";
      if (meta.handRaised) iconText += "✋";
      if (meta.micOn === false) iconText += "🔇";
      icons.textContent = iconText;
      row.appendChild(icons);

      el.participantsList.appendChild(row);
    });
}

// ---- 경과 시간 ----

function recomputeRoomStartedAt() {
  if (!channel) return;
  const state = channel.presenceState();
  let earliest = myPresence.joinedAt;
  for (const key of Object.keys(state)) {
    const meta = state[key][0];
    if (meta && meta.joinedAt && meta.joinedAt < earliest) earliest = meta.joinedAt;
  }
  roomStartedAt = earliest;
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function updateElapsedTime() {
  el.elapsedTime.textContent = formatElapsed(Date.now() - roomStartedAt);
}

function openChat() {
  closeParticipants();
  chatOpen = true;
  el.chatPanel.classList.add("open");
  unreadChatCount = 0;
  updateChatBadge();
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function closeChat() {
  chatOpen = false;
  el.chatPanel.classList.remove("open");
}

function updateChatBadge() {
  el.chatBadge.textContent = unreadChatCount > 9 ? "9+" : String(unreadChatCount);
  el.chatBadge.classList.toggle("hidden", unreadChatCount === 0);
}

function appendChatMessage(message, { mine }) {
  const empty = el.chatMessages.querySelector(".chat-empty");
  if (empty) empty.remove();

  const bubble = document.createElement("div");
  bubble.className = "chat-message" + (mine ? " mine" : "");

  const sender = document.createElement("span");
  sender.className = "sender";
  sender.textContent = mine ? "나" : peerLabel(message.from);
  bubble.appendChild(sender);

  const text = document.createElement("span");
  text.textContent = message.text;
  bubble.appendChild(text);

  el.chatMessages.appendChild(bubble);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;

  if (!mine && !chatOpen) {
    unreadChatCount += 1;
    updateChatBadge();
  }
}

// 방 이름은 host의 Presence를 통해서만 알 수 있으므로, 한 번 알게 되면 host가 나가도 계속 유지한다.
let knownRoomName = isHost ? roomName : null;

function updateRoomName() {
  if (!channel) return;
  const state = channel.presenceState();
  for (const key of Object.keys(state)) {
    const meta = state[key][0];
    if (meta && meta.isHost && meta.roomName) {
      knownRoomName = meta.roomName;
      break;
    }
  }
  el.roomNameLabel.textContent = knownRoomName || "미팅";
}

// ---- 미팅 기록(이름/시작·종료 시각/참여자) ----

async function createMeetingLog() {
  try {
    const { data, error } = await supabaseClient
      .from("meetings")
      .insert({ room_name: roomName, room_code: roomCode, participants: [myPresence.nickname] })
      .select("id")
      .single();
    if (error) throw error;
    meetingId = data.id;
  } catch (err) {
    console.error("미팅 기록 생성 실패 (meetings 테이블이 없을 수 있어요)", err);
  }
}

async function recordJoinInLog() {
  try {
    const { data, error } = await supabaseClient.from("meetings").select("participants").eq("id", meetingId).single();
    if (error) throw error;
    const current = data.participants || [];
    if (current.includes(myPresence.nickname)) return;
    await supabaseClient
      .from("meetings")
      .update({ participants: [...current, myPresence.nickname] })
      .eq("id", meetingId);
  } catch (err) {
    console.error("미팅 기록에 참여자 추가 실패", err);
  }
}

// host의 Presence에서 meetingId를 전달받아, 참여자 본인을 기록에 추가한다.
function updateMeetingId() {
  if (meetingId || !channel) return;
  const state = channel.presenceState();
  for (const key of Object.keys(state)) {
    const meta = state[key][0];
    if (meta && meta.isHost && meta.meetingId) {
      meetingId = meta.meetingId;
      break;
    }
  }
  if (meetingId && !isHost && !hasRecordedJoin) {
    hasRecordedJoin = true;
    recordJoinInLog();
  }
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

  el.roomNameLabel.textContent = knownRoomName || "미팅";
  el.roomCodeLabel.textContent = roomCode;
  setupControls();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    showError(mediaErrorMessage(err));
    return;
  }

  showState("room");
  addVideoTile(clientId, localStream, { local: true });
  attachSpeakingDetector(clientId, localStream);

  channel = supabaseClient.channel(`room-${roomCode}`, {
    config: { presence: { key: clientId } },
  });

  channel
    .on("presence", { event: "join" }, ({ key }) => {
      if (key !== clientId) connectToPeer(key);
    })
    .on("presence", { event: "leave" }, ({ key }) => {
      removePeer(key);
      peerMeta.delete(key);
      recomputeSharer();
      recomputeRoomStartedAt();
      renderParticipantList();
    })
    .on("presence", { event: "sync" }, () => {
      applyPresenceMeta();
      recomputeSharer();
      recomputeRoomStartedAt();
      renderParticipantList();
      updateRoomName();
      updateMeetingId();
    })
    .on("broadcast", { event: "chat" }, ({ payload }) => {
      if (payload.from !== clientId) appendChatMessage(payload, { mine: false });
    })
    .on("broadcast", { event: "reaction" }, ({ payload }) => {
      if (payload.from !== clientId) showFloatingReaction(payload.from, payload.emoji);
    })
    .on("broadcast", { event: "signal" }, ({ payload }) => {
      if (payload.to === clientId) handleSignal(payload);
    })
    .subscribe(async (status) => {
      if (status !== "SUBSCRIBED") return;
      if (isHost) {
        await createMeetingLog();
        myPresence.meetingId = meetingId;
      }
      await trackPresence({});
      applyPresenceMeta();
      recomputeRoomStartedAt();
      updateElapsedTime();
      setInterval(updateElapsedTime, 1000);

      // 이미 들어와있는 사람이 있으면 host 여부와 상관없이 항상 먼저 연결을 시도한다.
      // (예: 방을 만든 사람이 재접속하는 경우에도 기존 참가자와 반드시 연결돼야 함)
      // "아무도 없다 = 에러"는 코드로 참여하는 사람에게만 적용한다.
      // host는 방금 막 만든 빈 방일 수 있으므로 혼자인 게 정상이다.
      setTimeout(() => {
        const state = channel.presenceState();
        const others = Object.keys(state).filter((key) => key !== clientId);
        if (others.length === 0 && !isHost) {
          leavePeersOnly();
          showError("방을 찾을 수 없어요.\n코드를 다시 확인하거나, 방이 이미 종료되지 않았는지 확인해주세요.");
          return;
        }
        others.forEach((peerId) => connectToPeer(peerId));
      }, JOIN_CHECK_DELAY_MS);
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

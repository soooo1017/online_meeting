const params = new URLSearchParams(location.search);
const roomCode = (params.get("code") || "").toUpperCase();
const isHost = params.get("host") === "1";
const roomName = params.get("name") ? decodeURIComponent(params.get("name")) : "미팅";
const nickname = params.get("nickname") ? decodeURIComponent(params.get("nickname")).slice(0, 20) : "";

// STUN만으로는 두 참가자가 서로 다른 네트워크(예: 한쪽은 이동통신망, 한쪽은 집 와이파이)에
// 있고 그중 한쪽이 symmetric NAT을 쓰면 P2P 직접 연결 경로를 못 찾는다 — 이 경우 영상/음성이
// 아예 전달되지 않고 검은 화면으로 멈춰버린다(Presence/채팅은 Supabase를 거쳐서 별개로 정상
// 동작하니 헷갈리기 쉽다). TURN 서버는 이럴 때 중계 역할을 해준다. 아래는 Open Relay
// Project(metered.ca)가 제공하는 공개 무료 TURN 서버로, 회원가입 없이 누구나 쓸 수 있지만
// 공유 자원이라 트래픽이 몰리면 느려질 수 있다. 더 안정적으로 쓰고 싶다면 metered.ca 등에서
// 무료 API 키를 받아 이 자리에 자신만의 TURN 자격 증명으로 바꿔 넣으면 된다.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:openrelay.metered.ca:80" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];
const JOIN_CHECK_DELAY_MS = 1200;
const RECONNECT_GRACE_MS = 5000; // "disconnected" 상태가 이 시간 넘게 지속되면 재연결 시도
const RECONNECT_RETRY_DELAY_MS = 1000;
const MEETING_SYNC_INTERVAL_MS = 20000; // 진행 중인 미팅 기록을 이 주기로 계속 동기화
const MEETING_STALE_MS = 90000; // last_active_at이 이만큼 안 갱신되면 비정상 종료로 간주 (동기화 주기의 4~5배)

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
// 사용자가 채팅/참가자 패널 크기를 드래그로 조절하면 여기에 기억해뒀다가,
// 닫았다 다시 열어도 같은 크기로 유지되게 한다 (기본 크기는 CSS의 .open 규칙이 정함).
const panelCustomSize = { chat: null, participants: null };
let roomStartedAt = Date.now();

// ---- 채팅 미리보기(채팅창을 안 열었을 때 방송 채팅처럼 오른쪽 아래에 잠깐 뜨는 알림) 설정 ----
const CHAT_PREVIEW_ENABLED_KEY = "same-meeting-chat-preview-enabled";
const CHAT_PREVIEW_DURATION_KEY = "same-meeting-chat-preview-duration";
const CHAT_PREVIEW_DURATIONS = [3000, 5000, 8000];
const CHAT_PREVIEW_DEFAULT_DURATION = 5000;
const CHAT_TOAST_GAP = 8;

function loadChatPreviewEnabled() {
  try {
    const v = localStorage.getItem(CHAT_PREVIEW_ENABLED_KEY);
    return v === null ? true : v === "1";
  } catch (err) {
    return true;
  }
}

function saveChatPreviewEnabled(enabled) {
  try {
    localStorage.setItem(CHAT_PREVIEW_ENABLED_KEY, enabled ? "1" : "0");
  } catch (err) {
    // 시크릿 모드 등에서는 그냥 이번 세션 동안만 적용됨
  }
}

function loadChatPreviewDuration() {
  try {
    const v = parseInt(localStorage.getItem(CHAT_PREVIEW_DURATION_KEY), 10);
    return CHAT_PREVIEW_DURATIONS.includes(v) ? v : CHAT_PREVIEW_DEFAULT_DURATION;
  } catch (err) {
    return CHAT_PREVIEW_DEFAULT_DURATION;
  }
}

function saveChatPreviewDuration(ms) {
  try {
    localStorage.setItem(CHAT_PREVIEW_DURATION_KEY, String(ms));
  } catch (err) {
    // 무시
  }
}

let chatPreviewEnabled = loadChatPreviewEnabled();
let chatPreviewDuration = loadChatPreviewDuration();
const chatToastQueue = []; // { el, timeoutId }, 오래된 것이 앞, 최신이 뒤
let meetingId = null; // meetings 테이블의 row id (host가 생성, presence로 전파)

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

// ---- 알림음 ----
// 외부 음원 파일 없이 Web Audio API로 그때그때 짧은 톤을 합성해서 재생한다.
// 발화자 감지에서 이미 만들어둔 audioCtx(사용자 클릭으로 resume까지 된 상태)를 그대로 재사용한다.
const SOUND_TYPES = [
  { key: "join", label: "참가자 입장", defaultOn: true },
  { key: "leave", label: "참가자 퇴장", defaultOn: true },
  { key: "handRaise", label: "손들기", defaultOn: true },
  { key: "chat", label: "채팅 메시지", defaultOn: true },
  { key: "shareStart", label: "화면 공유 시작", defaultOn: true },
  { key: "shareStop", label: "화면 공유 종료", defaultOn: true },
  { key: "handLower", label: "손 내리기", defaultOn: false },
  { key: "reaction", label: "리액션 전송", defaultOn: false },
  { key: "micToggle", label: "마이크 켜짐/꺼짐", defaultOn: false },
  { key: "camToggle", label: "캠 켜짐/꺼짐", defaultOn: false },
];

const SOUND_MASTER_KEY = "same-meeting-sound-master";
const SOUND_SETTING_PREFIX = "same-meeting-sound-";

function loadSoundMaster() {
  try {
    const v = localStorage.getItem(SOUND_MASTER_KEY);
    return v === null ? true : v === "1";
  } catch (err) {
    return true;
  }
}

function saveSoundMaster(on) {
  try {
    localStorage.setItem(SOUND_MASTER_KEY, on ? "1" : "0");
  } catch (err) {
    // 무시
  }
}

function loadSoundSetting(key, defaultOn) {
  try {
    const v = localStorage.getItem(SOUND_SETTING_PREFIX + key);
    return v === null ? defaultOn : v === "1";
  } catch (err) {
    return defaultOn;
  }
}

function saveSoundSetting(key, on) {
  try {
    localStorage.setItem(SOUND_SETTING_PREFIX + key, on ? "1" : "0");
  } catch (err) {
    // 무시
  }
}

let soundMasterOn = loadSoundMaster();
const soundSettings = {};
SOUND_TYPES.forEach(({ key, defaultOn }) => {
  soundSettings[key] = loadSoundSetting(key, defaultOn);
});

// 순수한 톤 하나를 짧게 재생한다. startTime은 지금 이 순간부터 몇 초 뒤에 시작할지(초 단위).
function playTone({ freq, startTime = 0, duration = 0.12, type = "sine", gain = 0.15 }) {
  const t0 = audioCtx.currentTime + startTime;
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gainNode.gain.setValueAtTime(0.0001, t0);
  gainNode.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

// 주파수가 시간에 따라 미끄러지듯 바뀌는 스윕음 (손들기/손내리기 등에 사용).
function playSweep({ fromFreq, toFreq, startTime = 0, duration = 0.15, gain = 0.13 }) {
  const t0 = audioCtx.currentTime + startTime;
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(fromFreq, t0);
  osc.frequency.linearRampToValueAtTime(toFreq, t0 + duration);
  gainNode.gain.setValueAtTime(0.0001, t0);
  gainNode.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

const SOUND_PLAYERS = {
  join() {
    playTone({ freq: 880, startTime: 0, duration: 0.12 });
    playTone({ freq: 1318.5, startTime: 0.1, duration: 0.16 });
  },
  leave() {
    playTone({ freq: 1174.7, startTime: 0, duration: 0.11 });
    playTone({ freq: 880, startTime: 0.09, duration: 0.11 });
    playTone({ freq: 587.3, startTime: 0.18, duration: 0.18 });
  },
  handRaise() {
    playSweep({ fromFreq: 500, toFreq: 1000, duration: 0.15 });
  },
  handLower() {
    playSweep({ fromFreq: 700, toFreq: 400, duration: 0.12 });
  },
  chat() {
    playTone({ freq: 1046.5, duration: 0.1, gain: 0.12 });
  },
  shareStart() {
    playTone({ freq: 440, startTime: 0, duration: 0.12 });
    playTone({ freq: 880, startTime: 0.1, duration: 0.18 });
  },
  shareStop() {
    playTone({ freq: 880, startTime: 0, duration: 0.1 });
    playTone({ freq: 440, startTime: 0.08, duration: 0.16 });
  },
  reaction() {
    playTone({ freq: 1200, startTime: 0, duration: 0.06, gain: 0.1 });
    playTone({ freq: 1500, startTime: 0.05, duration: 0.08, gain: 0.1 });
  },
  micToggle() {
    playTone({ freq: 700, duration: 0.05, gain: 0.08, type: "square" });
  },
  camToggle() {
    playTone({ freq: 700, duration: 0.05, gain: 0.08, type: "square" });
  },
};

function playSound(key) {
  if (!audioCtx || !soundMasterOn || !soundSettings[key]) return;
  try {
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    const player = SOUND_PLAYERS[key];
    if (player) player();
  } catch (err) {
    console.error("알림음 재생 실패", err);
  }
}

function defaultLabel(id) {
  return "참가자 " + id.slice(0, 4);
}

// 항상 이 객체 전체를 다시 track()해서 필드가 서로 덮어써지지 않게 한다.
const myPresence = {
  nickname: nickname || defaultLabel(clientId),
  joinedAt: Date.now(),
  micOn: true,
  camOn: true,
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
  toast: document.getElementById("toast"),
  chatToastStack: document.getElementById("chat-toast-stack"),
  btnChatSettings: document.getElementById("btn-chat-settings"),
  chatSettingsPopover: document.getElementById("chat-settings-popover"),
  chatPreviewToggle: document.getElementById("chat-preview-toggle"),
  chatDurationOptions: Array.from(document.querySelectorAll(".duration-option")),
  btnSoundSettings: document.getElementById("btn-sound-settings"),
  soundSettingsPopover: document.getElementById("sound-settings-popover"),
  soundMasterToggle: document.getElementById("sound-master-toggle"),
  soundSettingsList: document.getElementById("sound-settings-list"),
};

let toastTimer = null;
function showToast(message, duration = 5000) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), duration);
}

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

// 오디오 트랙이 섞인 원격 영상은 브라우저(특히 iOS Safari, 첫 방문 Chrome)가 사용자
// 동작 없는 autoplay를 막아서 영상 자체가 아예 멈춰버릴 수 있다(검은 타일로 보이는 원인
// 중 하나). play()가 막히면 일단 음소거로라도 재생시켜서 최소한 영상은 보이게 한다.
// (로컬 미리보기는 항상 muted라 이 문제와 무관함)
function playVideoWithAutoplayFallback(video) {
  const playResult = video.play();
  if (!playResult || typeof playResult.catch !== "function") return;
  playResult.catch(() => {
    if (video.muted) return;
    video.muted = true;
    video.play().catch(() => {});
  });
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
  const video = tile.querySelector("video");
  video.srcObject = stream;
  playVideoWithAutoplayFallback(video);
}

function removeVideoTile(peerId) {
  const tile = document.getElementById(videoTileId(peerId));
  if (tile) tile.remove();
}

// 연결이 disconnected 상태로 들어가면(끊기기 직전, 몇 초 지켜보는 유예 구간) 화면이 멈춘
// 채로 남아있을 수 있어서, 스피너를 띄워 "재연결 중"임을 알려준다.
function setTileReconnecting(peerId, reconnecting) {
  const tile = document.getElementById(videoTileId(peerId));
  if (!tile) return;
  tile.classList.toggle("reconnecting", reconnecting);
  let overlay = tile.querySelector(".reconnect-overlay");
  if (reconnecting) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "reconnect-overlay";
      const spinner = document.createElement("div");
      spinner.className = "spinner";
      overlay.appendChild(spinner);
      tile.appendChild(overlay);
    }
  } else if (overlay) {
    overlay.remove();
  }
}

// Presence에 올라온 닉네임/마이크/손들기 상태를 각 타일과 채팅 라벨에 반영한다.
function applyPresenceMeta() {
  if (!channel) return;
  const state = channel.presenceState();
  for (const key of Object.keys(state)) {
    const meta = state[key][0];
    if (!meta) continue;
    const prevMeta = peerMeta.get(key);
    peerMeta.set(key, meta);

    // 다른 사람의 상태 변화만 소리로 알려준다 (내가 한 건 이미 알고 있으니 제외).
    // prevMeta가 없으면 방금 처음 들어온 사람이라, 원래 켜져 있던 상태를 "변화"로 오인해
    // 소리가 나지 않도록 건너뛴다.
    if (prevMeta && key !== clientId) {
      if (!prevMeta.handRaised && meta.handRaised) playSound("handRaise");
      else if (prevMeta.handRaised && !meta.handRaised) playSound("handLower");
      if ((prevMeta.micOn !== false) !== (meta.micOn !== false)) playSound("micToggle");
      if ((prevMeta.camOn !== false) !== (meta.camOn !== false)) playSound("camToggle");
    }

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
let lastSharingPeerId = null; // 화면 공유 시작/종료 알림음을 중복 없이 울리기 위한 이전 상태
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

  // 내가 시작/종료한 공유는 이미 알고 있으니 소리 없이, 다른 사람 것만 알림음을 울린다.
  if (sharer !== lastSharingPeerId) {
    if (sharer && sharer !== clientId) playSound("shareStart");
    else if (!sharer && lastSharingPeerId && lastSharingPeerId !== clientId) playSound("shareStop");
    lastSharingPeerId = sharer;
  }

  sharingPeerId = sharer;
  updateLayout();
}

// getDisplayMedia 실패 사유는 대부분 "사용자가 선택 창에서 취소" 또는 "브라우저/OS가
// 화면 기록 권한을 막음"인데, 둘 다 브라우저는 같은 NotAllowedError를 던져서 코드로는
// 구분이 안 된다. 그래서 조용히 무시하지 않고, 흔한 원인(맥 시스템 권한 포함)을 안내한다.
function displayMediaErrorMessage(err) {
  if (err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")) {
    return "화면 공유가 취소되었거나 권한이 차단되어 있어요.\nMac이라면 시스템 설정 > 개인정보 보호 및 보안 > 화면 기록에서 브라우저 권한을 확인한 뒤 다시 시도해주세요.";
  }
  return "화면 공유를 시작하지 못했어요. 잠시 후 다시 시도해주세요.";
}

async function startScreenShare() {
  if (!screenShareSupported || isSharingScreen) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    showToast(displayMediaErrorMessage(err));
    return;
  }

  const screenTrack = stream.getVideoTracks()[0];
  if (!screenTrack) {
    showToast(displayMediaErrorMessage(null));
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  try {
    localScreenStream = stream;
    const startedAt = Date.now();
    screenTrack.onended = () => {
      // 화면 공유 권한이 시스템 단에서 막혀 있으면 선택 직후 트랙이 바로 끊기기도 한다.
      if (Date.now() - startedAt < 1500) {
        showToast("화면 공유가 바로 종료됐어요. 시스템 화면 기록 권한을 확인해주세요.\nMac: 시스템 설정 > 개인정보 보호 및 보안 > 화면 기록");
      }
      stopScreenShare();
    };

    peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(screenTrack);
    });

    isSharingScreen = true;
    el.btnScreenShare.classList.add("active");
    await trackPresence({ sharing: true, sharingSince: Date.now() });
    recomputeSharer();
  } catch (err) {
    console.error("화면 공유 시작 중 오류", err);
    showToast("화면 공유를 시작하는 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.");
    stream.getTracks().forEach((track) => track.stop());
    localScreenStream = null;
    isSharingScreen = false;
    el.btnScreenShare.classList.remove("active");
  }
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

// 화면 공유 중에 새로 연결이 맺어지면(신규 입장, 재연결 등) 캠이 아니라 지금 공유 중인
// 화면을 바로 넣어줘야 한다. 오디오는 항상 localStream 기준으로 묶어서, 수신 쪽에서
// 오디오/비디오가 서로 다른 스트림으로 쪼개져 도착하는 일이 없게 한다.
function getActiveVideoTrack() {
  if (isSharingScreen && localScreenStream) return localScreenStream.getVideoTracks()[0];
  return localStream.getVideoTracks()[0];
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.addTrack(getActiveVideoTrack(), localStream);
  localStream.getAudioTracks().forEach((track) => pc.addTrack(track, localStream));

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
    console.log(`[peer ${peerId.slice(0, 4)}] connectionState: ${pc.connectionState}`);
    if (pc.connectionState === "connected") {
      setTileReconnecting(peerId, false);
    } else if (pc.connectionState === "failed") {
      handleConnectionLost(peerId);
    } else if (pc.connectionState === "disconnected") {
      // 와이파이가 잠깐 끊기는 정도는 몇 초 안에 자연 복구되기도 해서, 바로 끊지 않고 잠깐 지켜본다.
      // 그동안은 화면이 멈춘 채로 남아있을 수 있어서 로딩 스피너로 "재연결 중"임을 알려준다.
      setTileReconnecting(peerId, true);
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
// 상대방에게도 "reconnect-request"를 보내서 자기 쪽 연결도 같이 버리고 새로 만들게 한다 —
// 나만 새 연결을 준비하고 상대는 예전(멈춰버린) 연결을 그대로 들고 있으면 서로 안 맞아서
// 영영 다시 못 붙는 상황을 막기 위함이다.
function handleConnectionLost(peerId) {
  removePeer(peerId);
  if (!channel) return;
  const state = channel.presenceState();
  if (state[peerId]) {
    sendSignal(peerId, { type: "reconnect-request" });
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

  if (type === "reconnect-request") {
    // 상대가 자기 쪽 연결이 끊긴 걸 감지했다는 신호. 나도 기존 연결을 버리고 새로 맺는다.
    removePeer(from);
    setTimeout(() => connectToPeer(from), RECONNECT_RETRY_DELAY_MS);
    return;
  }

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

// 나 말고 남아있는 사람이 없을 때만 "진짜로 끝났다"고 기록한다. 이걸 아무나 나갈 때마다
// 찍어버리면, 한 명만 먼저 나가고 다른 사람은 계속 남아있는 상황도 "종료됨"으로 잘못
// 기록되어 초대코드 무효화 판단(isRoomCodeExpired)이 틀어진다.
// leaveRoom()(정상적으로 나가기 버튼을 누른 경우)뿐 아니라, presence의 leave 이벤트에서도
// 호출된다 — 상대가 강제종료/인터넷끊김으로 사라졌을 때 "남은 사람"이 대신 감지해서 기록한다.
async function markEndedIfEmpty() {
  if (!meetingId || !channel) return;
  const state = channel.presenceState();
  const stillHere = Object.keys(state).filter((key) => key !== clientId);
  if (stillHere.length > 0) return;
  try {
    await supabaseClient.from("meetings").update({ ended_at: new Date().toISOString() }).eq("id", meetingId);
  } catch (err) {
    console.error("미팅 기록 종료 시각 저장 실패", err);
  }
}

async function leaveRoom() {
  peers.forEach((_, peerId) => removePeer(peerId));
  detachSpeakingDetector(clientId);
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  if (localScreenStream) localScreenStream.getTracks().forEach((track) => track.stop());

  if (channel) await channel.untrack();
  await markEndedIfEmpty();
  if (channel) await supabaseClient.removeChannel(channel);
  // href로 이동하면 이 페이지가 히스토리에 남아서, 뒤로가기를 누르면 이미 나간 회의 화면이
  // (심하면 bfcache에 저장된 예전 상태 그대로) 다시 보인다. replace로 아예 히스토리에서 지운다.
  location.replace("index.html");
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
    trackPresence({ camOn });
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
    resizeChatInput();
  });

  // textarea라 Enter가 기본적으로 줄바꿈이라, Enter만 누르면 전송하고
  // Shift+Enter일 때만 줄바꿈이 들어가도록 (흔한 메신저 관례) 분리한다.
  el.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el.chatForm.requestSubmit();
    }
  });
  el.chatInput.addEventListener("input", resizeChatInput);

  el.chatPreviewToggle.checked = chatPreviewEnabled;
  el.chatPreviewToggle.addEventListener("change", () => {
    chatPreviewEnabled = el.chatPreviewToggle.checked;
    saveChatPreviewEnabled(chatPreviewEnabled);
    if (!chatPreviewEnabled) clearChatToasts();
  });

  el.chatDurationOptions.forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.duration) === chatPreviewDuration);
    btn.addEventListener("click", () => {
      chatPreviewDuration = Number(btn.dataset.duration);
      saveChatPreviewDuration(chatPreviewDuration);
      el.chatDurationOptions.forEach((b) => b.classList.toggle("active", b === btn));
    });
  });

  el.btnChatSettings.addEventListener("click", (e) => {
    e.stopPropagation();
    el.chatSettingsPopover.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!el.chatSettingsPopover.contains(e.target) && e.target !== el.btnChatSettings) {
      el.chatSettingsPopover.classList.add("hidden");
    }
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

  buildSoundSettings();
  el.btnSoundSettings.addEventListener("click", (e) => {
    e.stopPropagation();
    el.soundSettingsPopover.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!el.soundSettingsPopover.contains(e.target) && e.target !== el.btnSoundSettings) {
      el.soundSettingsPopover.classList.add("hidden");
    }
  });

  setupPanelResizer(el.chatPanel);
  setupPanelResizer(el.participantsPanel);
}

// 알림음 설정 패널: 맨 위 "전체 알림음" 하나, 그 아래 항목별 개별 on/off.
function buildSoundSettings() {
  updateSoundBellIcon();
  el.soundMasterToggle.checked = soundMasterOn;
  el.soundMasterToggle.addEventListener("change", () => {
    soundMasterOn = el.soundMasterToggle.checked;
    saveSoundMaster(soundMasterOn);
    updateSoundBellIcon();
  });

  SOUND_TYPES.forEach(({ key, label }) => {
    const row = document.createElement("label");
    row.className = "sound-setting-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = soundSettings[key];
    checkbox.addEventListener("change", () => {
      soundSettings[key] = checkbox.checked;
      saveSoundSetting(key, checkbox.checked);
    });

    const span = document.createElement("span");
    span.textContent = label;

    row.appendChild(checkbox);
    row.appendChild(span);
    el.soundSettingsList.appendChild(row);
  });
}

function updateSoundBellIcon() {
  el.btnSoundSettings.textContent = soundMasterOn ? "🔔" : "🔕";
}

// 채팅/참가자 패널의 기본 크기(.open의 flex-basis)는 그대로 두고, 사용자가 손잡이를
// 드래그했을 때만 인라인 flex-basis로 덮어써서 캠 영역과 크기를 나눠 갖게 한다.
// 데스크톱은 좌우(너비), 모바일은 상하로 쌓이니 위아래(높이)로 드래그 방향이 바뀐다.
function setupPanelResizer(panel) {
  const handle = panel.querySelector(".panel-resizer");
  if (!handle) return;
  const key = handle.dataset.panel; // "chat" | "participants"
  const isHorizontal = () => window.matchMedia("(min-width: 900px)").matches;

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const horizontal = isHorizontal();
    const startPos = horizontal ? e.clientX : e.clientY;
    const startSize = horizontal ? panel.getBoundingClientRect().width : panel.getBoundingClientRect().height;
    const containerSize = horizontal
      ? panel.parentElement.getBoundingClientRect().width
      : panel.parentElement.getBoundingClientRect().height;
    const maxSize = Math.max(containerSize - 200, 160); // 캠 영역이 최소한은 남도록
    panel.classList.add("resizing");
    document.body.style.userSelect = "none";

    const onMove = (moveEvent) => {
      const pos = horizontal ? moveEvent.clientX : moveEvent.clientY;
      // 손잡이가 패널의 시작 모서리(왼쪽/위쪽)에 있어서, 컨테이너 안쪽으로 끌수록 패널이 커진다.
      const delta = startPos - pos;
      const newSize = Math.min(Math.max(startSize + delta, 160), maxSize);
      panel.style.flexBasis = `${newSize}px`;
      panelCustomSize[key] = newSize;
    };

    const onUp = (upEvent) => {
      handle.releasePointerCapture(upEvent.pointerId);
      panel.classList.remove("resizing");
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
  if (panelCustomSize.participants != null) {
    el.participantsPanel.style.flexBasis = `${panelCustomSize.participants}px`;
  }
  renderParticipantList();
}

function closeParticipants() {
  participantsOpen = false;
  el.participantsPanel.classList.remove("open");
  el.participantsPanel.style.flexBasis = "";
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

// 줄바꿈이 늘어나는 만큼 입력창 높이도 같이 늘어나게 한다 (CSS max-height 넘어가면 그때부터 스크롤).
function resizeChatInput() {
  el.chatInput.style.height = "auto";
  el.chatInput.style.height = `${el.chatInput.scrollHeight}px`;
}

function openChat() {
  closeParticipants();
  chatOpen = true;
  el.chatPanel.classList.add("open");
  if (panelCustomSize.chat != null) el.chatPanel.style.flexBasis = `${panelCustomSize.chat}px`;
  unreadChatCount = 0;
  updateChatBadge();
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  clearChatToasts();
}

function closeChat() {
  chatOpen = false;
  el.chatPanel.classList.remove("open");
  el.chatPanel.style.flexBasis = "";
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
  text.className = "text";
  text.textContent = message.text;
  bubble.appendChild(text);

  el.chatMessages.appendChild(bubble);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;

  if (!mine && !chatOpen) {
    unreadChatCount += 1;
    updateChatBadge();
    showChatToastPreview(message);
    playSound("chat");
  }
}

// 채팅창을 안 열어놨을 때, 인터넷 방송 채팅처럼 오른쪽 아래에서 올라왔다가 잠깐 있다 사라지는
// 미리보기. 여러 개가 겹치면 최신 메시지가 제일 아래, 오래된 메시지가 위로 밀려 올라간다.
function showChatToastPreview(message) {
  if (!chatPreviewEnabled || chatOpen) return;

  const toastEl = document.createElement("div");
  toastEl.className = "chat-toast";

  const sender = document.createElement("span");
  sender.className = "sender";
  sender.textContent = peerLabel(message.from);
  toastEl.appendChild(sender);

  const text = document.createElement("span");
  text.className = "text";
  text.textContent = message.text;
  toastEl.appendChild(text);

  toastEl.style.bottom = "-16px"; // 아래에서 위로 슥 올라오는 시작 위치
  el.chatToastStack.appendChild(toastEl);

  const item = { el: toastEl, timeoutId: null };
  chatToastQueue.push(item);

  requestAnimationFrame(() => {
    repositionChatToasts();
    toastEl.style.opacity = "1";
  });

  item.timeoutId = setTimeout(() => removeChatToast(item), chatPreviewDuration);
}

function removeChatToast(item) {
  const idx = chatToastQueue.indexOf(item);
  if (idx === -1) return;
  chatToastQueue.splice(idx, 1);
  clearTimeout(item.timeoutId);
  item.el.style.opacity = "0";
  repositionChatToasts();
  setTimeout(() => item.el.remove(), 250);
}

// 채팅창을 열면 미리보기는 더 이상 필요 없으니 남아있던 것들을 바로 정리한다.
function clearChatToasts() {
  chatToastQueue.splice(0).forEach((item) => {
    clearTimeout(item.timeoutId);
    item.el.remove();
  });
}

// 최신 메시지가 스택 맨 아래(offset 0), 오래된 메시지일수록 그 위로 쌓이도록 위치를 다시 계산한다.
function repositionChatToasts() {
  let offset = 0;
  for (let i = chatToastQueue.length - 1; i >= 0; i--) {
    const item = chatToastQueue[i];
    item.el.style.bottom = `${offset}px`;
    offset += item.el.offsetHeight + CHAT_TOAST_GAP;
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

function localDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// host=1 링크는 "방금 막 만든 빈 방이라 혼자인 게 정상"이라고 보고 존재 확인을 건너뛰는데,
// 이 코드로 예전에 이미 다 끝난 미팅이 있었다면 그 예외를 적용하면 안 된다 (그러면 다 나간
// 방이 옛날 링크로 계속 부활함). 같은 room_code의 가장 최근 기록에 ended_at이 찍혀있으면
// "완전히 끝난 적 있는 코드"로 보고 막는다.
async function isRoomCodeExpired() {
  try {
    const { data, error } = await supabaseClient
      .from("meetings")
      .select("id, ended_at, last_active_at")
      .eq("room_code", roomCode)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return false;
    if (data.ended_at) return true;

    // 아무도 나가기를 누르지 못하고(강제종료/인터넷끊김) 사라진 경우, ended_at은 끝까지 안
    // 찍힌다. last_active_at(20초마다 갱신됨)이 한참 멈춰있으면 사실상 끝난 걸로 보고,
    // 이 참에 기록도 종료 처리해서 다음부터는 바로 판단할 수 있게 한다.
    const staleMs = Date.now() - new Date(data.last_active_at).getTime();
    if (staleMs > MEETING_STALE_MS) {
      try {
        await supabaseClient.from("meetings").update({ ended_at: data.last_active_at }).eq("id", data.id);
      } catch (err) {
        console.error("멈춰있던 미팅 기록 종료 처리 실패", err);
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error("초대코드 만료 여부 확인 실패 (기록 없이 그냥 진행함)", err);
    return false; // 확인 자체가 안 되면 막지 않고 진행 (가용성 우선)
  }
}

async function createMeetingLog() {
  try {
    const { data, error } = await supabaseClient
      .from("meetings")
      .insert({
        room_name: roomName,
        room_code: roomCode,
        meeting_date: localDateString(new Date()),
        participants: [myPresence.nickname],
      })
      .select("id")
      .single();
    if (error) throw error;
    meetingId = data.id;
  } catch (err) {
    console.error("미팅 기록 생성 실패 (meetings 테이블이 없을 수 있어요)", err);
  }
}

// 미팅이 진행 중인 동안 주기적으로 호출된다. 참여자 목록을 지금 이 순간 방에 있는
// 사람들과 합쳐서(한 번이라도 들어왔던 사람은 계속 남도록) 다시 써넣고, last_active_at을
// 갱신한다. 한 번 실패해도 다음 주기에 다시 시도되므로 일회성 기록보다 훨씬 안정적이다.
async function syncMeetingLog() {
  if (!meetingId || !channel) return;
  try {
    const { data, error } = await supabaseClient
      .from("meetings")
      .select("participants")
      .eq("id", meetingId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      console.warn("meetings row를 찾을 수 없어요 (meetingId:", meetingId, ") — 테이블/RLS 설정을 확인해주세요.");
      return;
    }

    const nicknames = new Set(data.participants || []);
    const state = channel.presenceState();
    Object.keys(state).forEach((key) => {
      const meta = state[key][0];
      if (meta && meta.nickname) nicknames.add(meta.nickname);
    });

    const { error: updateError } = await supabaseClient
      .from("meetings")
      .update({ participants: Array.from(nicknames), last_active_at: new Date().toISOString() })
      .eq("id", meetingId);
    if (updateError) throw updateError;
  } catch (err) {
    console.error("미팅 기록 실시간 동기화 실패", err);
  }
}

// host의 Presence에서 meetingId를 전달받는다.
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
  if (meetingId) syncMeetingLog();
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

  if (isHost && (await isRoomCodeExpired())) {
    showError("이 초대코드는 이미 종료된 미팅이에요.\n같은 코드로는 다시 열 수 없어요, 새로 미팅을 만들어주세요.");
    return;
  }

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
      if (key !== clientId) {
        connectToPeer(key);
        playSound("join");
      }
    })
    .on("presence", { event: "leave" }, ({ key }) => {
      removePeer(key);
      peerMeta.delete(key);
      recomputeSharer();
      recomputeRoomStartedAt();
      renderParticipantList();
      markEndedIfEmpty();
      if (key !== clientId) playSound("leave");
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
      if (payload.from !== clientId) {
        showFloatingReaction(payload.from, payload.emoji);
        playSound("reaction");
      }
    })
    .on("broadcast", { event: "signal" }, ({ payload }) => {
      if (payload.to === clientId) handleSignal(payload);
    })
    .subscribe(async (status) => {
      if (status !== "SUBSCRIBED") return;
      if (isHost) {
        await createMeetingLog();
        myPresence.meetingId = meetingId;
        syncMeetingLog();
      }
      await trackPresence({});
      applyPresenceMeta();
      recomputeRoomStartedAt();
      updateElapsedTime();
      setInterval(updateElapsedTime, 1000);
      setInterval(syncMeetingLog, MEETING_SYNC_INTERVAL_MS);

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

// 뒤로/앞으로 가기로 이 페이지가 bfcache에서 그대로(스크립트 재실행 없이) 복원되면
// 캠/채널이 이미 정리된 상태 그대로 화면만 남아있게 된다. 강제로 새로고침해서
// 방이 실제로 아직 있는지부터 다시 확인하게 한다.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

init();

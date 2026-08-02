const CODE_LENGTH = 6;
// 0/O, 1/I/L처럼 헷갈리는 문자는 제외
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const NICKNAME_STORAGE_KEY = "same-meeting-nickname";
const CREATOR_CODE_VERIFIED_KEY = "same-meeting-creator-code-verified";

function generateRoomCode() {
  const values = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(values);
  return Array.from(values, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");
}

function showView(id) {
  document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

function loadSavedNickname() {
  try {
    return localStorage.getItem(NICKNAME_STORAGE_KEY) || "";
  } catch (err) {
    return "";
  }
}

function saveNickname(name) {
  try {
    localStorage.setItem(NICKNAME_STORAGE_KEY, name);
  } catch (err) {
    // 시크릿 모드 등 localStorage를 못 쓰는 환경이면 그냥 넘어감
  }
}

// 한번 코드를 확인받은 브라우저는 다음에 "방 만들기"를 눌러도 코드를 또 안 물어본다.
function isCreatorCodeVerified() {
  try {
    return localStorage.getItem(CREATOR_CODE_VERIFIED_KEY) === "1";
  } catch (err) {
    return false;
  }
}

function markCreatorCodeVerified() {
  try {
    localStorage.setItem(CREATOR_CODE_VERIFIED_KEY, "1");
  } catch (err) {
    // 시크릿 모드 등 localStorage를 못 쓰는 환경이면 매번 다시 물어보게 됨
  }
}

document.getElementById("btn-start").addEventListener("click", () => {
  showView(isCreatorCodeVerified() ? "view-create" : "view-creator-code");
});
document.getElementById("btn-join").addEventListener("click", () => showView("view-join"));
document.querySelectorAll(".btn-back").forEach((btn) => {
  btn.addEventListener("click", () => showView("view-landing"));
});

const savedNickname = loadSavedNickname();
document.getElementById("input-nickname-create").value = savedNickname;
document.getElementById("input-nickname-join").value = savedNickname;

document.getElementById("form-creator-code").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("creator-code-error");
  const submitBtn = e.target.querySelector("button[type=submit]");
  const code = document.getElementById("input-creator-code").value.trim();

  if (!/^\d{5}$/.test(code)) {
    errorEl.textContent = "5자리 숫자로 입력해주세요.";
    return;
  }
  errorEl.textContent = "";
  submitBtn.disabled = true;

  try {
    const { data, error } = await supabaseClient
      .from("creator_codes")
      .select("id")
      .eq("code", code)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      errorEl.textContent = "코드가 올바르지 않아요. 다시 확인해주세요.";
      return;
    }
    markCreatorCodeVerified();
    showView("view-create");
  } catch (err) {
    console.error("코드 확인 실패", err);
    errorEl.textContent = "코드를 확인하는 중 문제가 생겼어요. 잠시 후 다시 시도해주세요.";
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("form-create").addEventListener("submit", (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("create-error");
  const name = document.getElementById("input-room-name").value.trim() || "이름 없는 방";
  const nickname = document.getElementById("input-nickname-create").value.trim();
  if (!nickname) {
    errorEl.textContent = "닉네임을 입력해주세요.";
    return;
  }
  errorEl.textContent = "";
  saveNickname(nickname);

  const code = generateRoomCode();
  const url = new URL("room.html", location.href);
  url.searchParams.set("code", code);
  url.searchParams.set("host", "1");
  url.searchParams.set("name", name);
  url.searchParams.set("nickname", nickname);
  location.href = url.toString();
});

document.getElementById("form-join").addEventListener("submit", (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("join-error");
  const code = document.getElementById("input-code").value.trim().toUpperCase();
  const nickname = document.getElementById("input-nickname-join").value.trim();
  if (!code) {
    errorEl.textContent = "초대코드를 입력해주세요.";
    return;
  }
  if (!nickname) {
    errorEl.textContent = "닉네임을 입력해주세요.";
    return;
  }
  errorEl.textContent = "";
  saveNickname(nickname);

  const url = new URL("room.html", location.href);
  url.searchParams.set("code", code);
  url.searchParams.set("nickname", nickname);
  location.href = url.toString();
});

// 초대 링크(?code=...)로 index.html에 직접 들어온 경우 참여 화면을 미리 채워줌
(function prefillFromQuery() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (code) {
    showView("view-join");
    document.getElementById("input-code").value = code.toUpperCase();
  }
})();

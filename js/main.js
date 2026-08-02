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
  btn.addEventListener("click", () => {
    showView("view-landing");
    loadPublicMeetings();
  });
});

const savedNickname = loadSavedNickname();
document.getElementById("input-nickname-create").value = savedNickname;
document.getElementById("input-nickname-join").value = savedNickname;

// ---- 공개 미팅 목록 ----

// 실제 비밀번호 값(password 컬럼)은 목록 조회에서 절대 select하지 않는다 — 대신
// has_password만 가져와서 프라이빗/퍼블릭 표시용으로만 쓴다.
async function loadPublicMeetings() {
  const container = document.getElementById("public-meeting-items");
  try {
    const { data, error } = await supabaseClient
      .from("meetings")
      .select("room_code, room_name, host_nickname, has_password")
      .eq("is_public", true)
      .is("ended_at", null)
      .order("started_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    renderPublicMeetings(data || []);
  } catch (err) {
    console.error("공개 미팅 목록 조회 실패", err);
    container.innerHTML = "";
    const errorText = document.createElement("p");
    errorText.className = "meeting-list-empty";
    errorText.textContent = "목록을 불러오지 못했어요.";
    container.appendChild(errorText);
  }
}

function renderPublicMeetings(meetings) {
  const container = document.getElementById("public-meeting-items");
  container.innerHTML = "";

  if (meetings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "meeting-list-empty";
    empty.textContent = "지금 열려있는 공개 미팅이 없어요.";
    container.appendChild(empty);
    return;
  }

  meetings.forEach((meeting) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "meeting-list-row";

    const title = document.createElement("span");
    title.className = "meeting-list-title";
    title.textContent = meeting.room_name;

    const meta = document.createElement("span");
    meta.className = "meeting-list-meta";
    const hostLabel = meeting.host_nickname || "알 수 없음";
    const modeLabel = meeting.has_password ? "프라이빗" : "퍼블릭";
    meta.textContent = `${hostLabel} · ${modeLabel}`;

    row.appendChild(title);
    row.appendChild(meta);
    row.addEventListener("click", () => {
      showView("view-join");
      document.getElementById("input-code").value = meeting.room_code;
      document.getElementById("input-join-password").value = "";
      document.getElementById("input-join-password").focus();
    });
    container.appendChild(row);
  });
}

loadPublicMeetings();

document.getElementById("form-creator-code").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("creator-code-error");
  const submitBtn = e.target.querySelector("button[type=submit]");
  const code = document.getElementById("input-creator-code").value.trim();

  if (!/^\d{6}$/.test(code)) {
    errorEl.textContent = "6자리 숫자로 입력해주세요.";
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

// "공개"를 선택했을 때만 비밀번호 입력칸을 보여준다.
document.querySelectorAll('input[name="visibility"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const isPublic = document.querySelector('input[name="visibility"]:checked').value === "public";
    document.getElementById("create-password-wrap").classList.toggle("hidden", !isPublic);
  });
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
  const isPublic = document.querySelector('input[name="visibility"]:checked').value === "public";
  const password = document.getElementById("input-room-password").value.trim();
  if (isPublic && password && !/^\d{4,6}$/.test(password)) {
    errorEl.textContent = "비밀번호는 4~6자리 숫자로 입력해주세요.";
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
  if (isPublic) {
    url.searchParams.set("public", "1");
    if (password) url.searchParams.set("password", password);
  }
  location.href = url.toString();
});

document.getElementById("form-join").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("join-error");
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const code = document.getElementById("input-code").value.trim().toUpperCase();
  const nickname = document.getElementById("input-nickname-join").value.trim();
  const password = document.getElementById("input-join-password").value.trim();
  if (!code) {
    errorEl.textContent = "초대코드를 입력해주세요.";
    return;
  }
  if (!nickname) {
    errorEl.textContent = "닉네임을 입력해주세요.";
    return;
  }
  errorEl.textContent = "";
  submitBtn.disabled = true;

  try {
    // 이 방에 비밀번호가 걸려있는지 확인한다. 실제 비밀번호 값은 여기서 select하지
    // 않고, room_code+password가 둘 다 일치하는지만 별도로 물어본다 (틀려도 진짜
    // 값은 알 수 없음 — creator_codes와 동일한 방식).
    const { data, error } = await supabaseClient
      .from("meetings")
      .select("has_password")
      .eq("room_code", code)
      .is("ended_at", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    if (data && data.has_password) {
      if (!password) {
        errorEl.textContent = "비밀번호가 필요한 방이에요.";
        return;
      }
      const { data: matched, error: matchError } = await supabaseClient
        .from("meetings")
        .select("id")
        .eq("room_code", code)
        .eq("password", password)
        .is("ended_at", null)
        .maybeSingle();
      if (matchError) throw matchError;
      if (!matched) {
        errorEl.textContent = "비밀번호가 일치하지 않아요.";
        return;
      }
    }

    saveNickname(nickname);
    const url = new URL("room.html", location.href);
    url.searchParams.set("code", code);
    url.searchParams.set("nickname", nickname);
    location.href = url.toString();
  } catch (err) {
    console.error("방 확인 실패, 그냥 진행합니다", err);
    // 확인 자체가 안 되면(테이블 문제 등) 막지 않고 진행 — room.html의 기존
    // 방 존재 확인 로직이 이어서 처리한다.
    saveNickname(nickname);
    const url = new URL("room.html", location.href);
    url.searchParams.set("code", code);
    url.searchParams.set("nickname", nickname);
    location.href = url.toString();
  } finally {
    submitBtn.disabled = false;
  }
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

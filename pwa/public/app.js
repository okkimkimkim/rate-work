// 마인약품 요율표 PWA
// 1) 접속: 개인 코드 + 이 기기의 무작위 ID로 /api/activate → 토큰을 받아 보관 (기기 1대 고정은 서버가 판단)
// 2) 데이터: 토큰으로 /api/data를 받아 기기 안 캐시에 보관 → 다음부터는 캐시로 바로 띄우고 뒤에서 새 버전 확인
// 3) 화면: 검색(+생산형태 필터)·이달 변동·즐겨찾기 탭 + 상단 배너(banner.json)

const PAGE = 50;
const $ = (id) => document.getElementById(id);
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// 숫자가 아닌 약가(예: "비급여")가 오면 NaN원 대신 적힌 그대로 보여준다
const won = (v) => (v === "" || v == null ? "" : Number.isFinite(Number(v)) ? Number(v).toLocaleString("ko-KR") + "원" : String(v));

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

// ── 기기·접속 상태 ────────────────────────────────────────────────
// 저장이 안 되는 브라우저(개인정보 보호 모드 등)면 null - 그대로 등록하면 서버엔 이 기기로 묶이는데
// 기기 ID가 남지 않아 다음에 "다른 기기"로 잠기므로 등록 자체를 막는다
function deviceId() {
  let id = store.get("mr-device");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
    store.set("mr-device", id);
    if (store.get("mr-device") !== id) return null;
  }
  return id;
}

const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isKakao = /KAKAOTALK/i.test(ua);
const isInApp = isKakao || /NAVER\(inapp|Instagram|FBAN|FBAV|Line\//i.test(ua);

function showGate(message) {
  $("app").hidden = true;
  $("gate").hidden = false;
  $("gate-code").hidden = $("gate-ios").hidden = $("gate-inapp").hidden = true;
  if (isInApp) {
    $("gate-inapp").hidden = false;
    $("open-external").href = isKakao
      ? "kakaotalk://web/openExternal?url=" + encodeURIComponent(location.href)
      : location.href;
  } else if (isIOS && !isStandalone) {
    // 아이폰은 사파리와 홈 화면 앱의 저장공간이 달라서, 사파리에서 코드를 넣으면 홈 화면 앱이 다른 기기가 된다
    $("gate-ios").hidden = false;
  } else {
    $("gate-code").hidden = false;
    $("code-msg").textContent = message || "";
    setTimeout(() => $("code").focus(), 50);
  }
}

$("code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("code").value.trim();
  if (!code) { $("code-msg").textContent = "코드를 입력해 주세요."; return; }
  const device = deviceId();
  if (!device) {
    $("code-msg").textContent = "이 브라우저는 정보를 저장할 수 없어요(개인정보 보호 모드 등). 일반 모드로 열거나 홈 화면 앱에서 입력해 주세요.";
    return;
  }
  $("code-submit").disabled = true;
  $("code-msg").textContent = "";
  try {
    const res = await fetch("/api/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, device }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) {
      $("code-msg").textContent = body.message || "코드를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
      return;
    }
    store.set("mr-token", body.token);
    startApp();
  } catch (err) {
    $("code-msg").textContent = "인터넷 연결을 확인한 뒤 다시 시도해 주세요.";
  } finally {
    $("code-submit").disabled = false;
  }
});

// ── 데이터 (기기 안 캐시 + 새 버전 확인) ──────────────────────────────
const DATA_CACHE = "mine-rate-data";
const DATA_KEY = "/__data__";

async function cachedData() {
  try {
    const c = await caches.open(DATA_CACHE);
    const res = await c.match(DATA_KEY);
    if (!res) return null;
    return { etag: res.headers.get("x-etag") || "", data: await res.json() };
  } catch (e) { return null; }
}

async function saveData(text, etag) {
  try {
    const c = await caches.open(DATA_CACHE);
    await c.put(DATA_KEY, new Response(text, { headers: { "content-type": "application/json", "x-etag": etag } }));
  } catch (e) {}
}

async function clearData() {
  try { await caches.delete(DATA_CACHE); } catch (e) {}
}

function notice(msg) {
  $("notice").textContent = msg || "";
  $("notice").hidden = !msg;
}

async function startApp() {
  const token = store.get("mr-token");
  if (!token) { showGate(); return; }
  $("gate").hidden = true;
  $("app").hidden = false;
  loadBanner();

  const cached = await cachedData();
  if (cached) setData(cached.data);

  try {
    const res = await fetch("/api/data", {
      headers: { authorization: "Bearer " + token, ...(cached && cached.etag ? { "if-none-match": cached.etag } : {}) },
      cache: "no-store",
    });
    if (res.status === 304) { notice(""); return; }
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      store.del("mr-token");
      await clearData();
      showGate(body.message || "코드를 다시 입력해 주세요.");
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    await saveData(text, res.headers.get("etag") || "");
    setData(JSON.parse(text));
    notice("");
  } catch (err) {
    if (cached) notice("인터넷에 연결되지 않아 마지막으로 받은 요율표를 보여드려요.");
    else $("list").innerHTML = `<p class="empty">요율표를 받지 못했습니다.<br>인터넷 연결을 확인한 뒤 앱을 다시 열어 주세요.</p>`;
  }
}

// ── 상단 배너 (banner.json: {items: [{image, url, start?, end?}]}) ──────────
let bannerTimer;
async function loadBanner() {
  let items = [];
  try {
    const res = await fetch("/banner.json", { cache: "no-store" });
    // 시작·종료일은 이 폰의 날짜(한국 시간) 기준. toISOString()은 UTC라 새벽 0~9시에 하루가 어긋난다
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    items = ((await res.json()).items || []).filter((b) => {
      return b.image && (!b.start || b.start <= today) && (!b.end || today <= b.end);
    });
  } catch (e) {}
  const box = $("banner");
  clearInterval(bannerTimer);
  if (!items.length) { box.hidden = true; return; }
  let i = 0;
  const show = () => {
    const b = items[i];
    const img = `<img src="${esc(b.image)}" alt="${esc(b.alt || "")}">`;
    box.innerHTML = (b.url ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">${img}</a>` : `<a>${img}</a>`) +
      (items.length > 1 ? `<span class="dots">${items.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</span>` : "");
  };
  show();
  box.hidden = false;
  if (items.length > 1) bannerTimer = setInterval(() => { i = (i + 1) % items.length; show(); }, 5000);
}

// ── 앱 설치 안내 (안드로이드 크롬 등에서 브라우저로 열었을 때) ─────────────
let installEvent;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  if (!isStandalone && store.get("mr-install-closed") !== "1") $("install").hidden = false;
});
$("install-btn").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => null);
  installEvent = null;
  $("install").hidden = true;
});
$("install-close").addEventListener("click", () => { $("install").hidden = true; store.set("mr-install-closed", "1"); });

// ── 검색·이달 변동 화면 (Artifact 버전과 같은 동작) ───────────────────────
// 행 구조: [성분명, 코드, 제약사명, 제조형태, 품목명, 약가, 오리지날/대조약, 보험코드, 포장]
let DATA = null, rows = [], coNorm = [], hay = [];

function setData(d) {
  DATA = d;
  rows = d.rows || [];
  coNorm = rows.map((r) => norm(r[2]));
  hay = rows.map((r) => norm([r[0], r[2], r[4], r[6], r[7]].join("|")));
  const mon = (String(d.month || "").split(".")[1] || "").replace(/^0/, "");
  $("src").textContent = d.source || "";
  $("tab-month").textContent = (mon ? mon + "월" : "이달") + " 변동";
  render();
}

let state = { tab: "search", q: "", co: "", sort: "base", mfg: "all", shown: PAGE };
try { Object.assign(state, JSON.parse(store.get("rate-ui") || "{}"), { shown: PAGE }); } catch (e) {}
const save = () => store.set("rate-ui", JSON.stringify({ tab: state.tab, q: state.q, co: state.co, sort: state.sort, mfg: state.mfg }));

// 즐겨찾기: 이 폰에만 저장. 보험코드로 기억해서 2달마다 데이터가 바뀌어도 그대로 남는다
// (보험코드는 행마다 유일 - 앞에 D가 붙은 다른 유통채널 행도 따로 구분됨). 최근에 추가한 것이 앞.
const favKey = (r) => (r[7] ? "e:" + r[7] : "n:" + r[2] + "|" + r[4]);
let favs = [];
try { favs = JSON.parse(store.get("mr-favs") || "[]"); } catch (e) {}
const isFav = (k) => favs.includes(k);
function toggleFav(k) {
  favs = isFav(k) ? favs.filter((x) => x !== k) : [k, ...favs];
  store.set("mr-favs", JSON.stringify(favs));
}

const mfgKind = (mfg) => (!mfg ? "unknown" : String(mfg).startsWith("위탁") ? "consigned" : "self");

function card(r, cls) {
  const [ing, rate, co, mfg, name, price, orig, ins, pack] = r;
  const mfgCls = mfgKind(mfg);
  const k = favKey(r), on = isFav(k);
  return `<article class="card">
    <div class="body">
      ${cls ? `<div class="cls">${esc(cls)}</div>` : ""}
      <div class="namerow"><span class="name">${esc(name)}</span><button type="button" class="fav" data-fav="${esc(k)}" aria-pressed="${on}" aria-label="즐겨찾기">${on ? "★" : "☆"}</button></div>
      <div class="co">${esc(co)}${price !== "" && price != null ? ` · <span class="price">${won(price)}</span>` : ""}</div>
      <div class="chips">
        ${ing ? `<button class="ing" data-q="${esc(ing)}">${esc(ing)}</button>` : ""}
        ${orig ? `<span class="tag">대조약 ${esc(orig)}</span>` : ""}
        <span class="mfg ${mfgCls}">${mfg ? esc(mfg) : "제조형태 확인불가"}</span>
        ${ins ? `<span class="tag">보험 ${esc(ins)}</span>` : ""}
        ${pack ? `<span class="tag">포장 ${esc(String(pack).replace(/\s*,\s*/g, ", "))}</span>` : ""}
      </div>
    </div>
    <div class="rate"><span class="l">코드</span><span class="n">${esc(rate)}</span></div>
  </article>`;
}

function filtered() {
  const terms = state.q.trim().split(/\s+/).map(norm).filter(Boolean);
  const co = norm(state.co);
  const mfg = state.mfg;
  const idx = [];
  for (let i = 0; i < rows.length; i++) {
    if (terms.every((t) => hay[i].includes(t)) && (!co || coNorm[i].includes(co)) &&
        (mfg === "all" || mfgKind(rows[i][3]) === mfg)) idx.push(i);
  }
  const num = (v) => (typeof v === "number" ? v : -1);
  if (state.sort === "rate") idx.sort((a, b) => num(rows[b][1]) - num(rows[a][1]));
  if (state.sort === "price") idx.sort((a, b) => num(rows[b][5]) - num(rows[a][5]));
  return idx;
}

function renderSearch() {
  const idx = filtered();
  const filtering = state.q || state.co || state.mfg !== "all";
  $("meta").innerHTML = `<span><b>${idx.length.toLocaleString()}</b>건${filtering ? "" : ` (전체)`}</span><span>성분 칩을 누르면 같은 성분 비교</span>`;
  if (!idx.length) {
    const what = [state.q, state.co, state.mfg === "self" ? "자체생산" : state.mfg === "consigned" ? "위탁생산" : ""].filter(Boolean).join(" · ");
    $("list").innerHTML = `<p class="empty">“${esc(what)}”에 맞는 품목이 없습니다.<br>띄어쓰기를 바꾸거나 조건을 줄여 보세요.</p>`;
    return;
  }
  const html = idx.slice(0, state.shown).map((i) => card(rows[i])).join("");
  const rest = idx.length - state.shown;
  $("list").innerHTML = html + (rest > 0 ? `<button class="more" id="more">${Math.min(rest, PAGE)}건 더 보기 (남은 ${rest.toLocaleString()}건)</button>` : "");
}

const HEAD_MAP = { "성분명": 0, "코드": 1, "제약사명": 2, "생동/생산": 3, "품목명": 4, "약가": 5, "오리지날/대조약": 6, "보험코드": 7, "포장": 8 };
function renderMonth() {
  let out = "", total = 0;
  for (const s of DATA.special || []) {
    const h = s.header || [];
    total += s.rows.length;
    out += `<h2>${esc(s.title)}<span>${s.rows.length}건</span></h2>`;
    if (h.includes("변경 전")) {
      const isPrice = /약가/.test(s.title);
      out += s.rows.map((r) => {
        const o = Object.fromEntries(h.map((k, i) => [k, r[i]]));
        const a = o["변경 전"], b = o["변경 후"];
        const dir = b > a ? "up" : b < a ? "down" : "";
        const f = (v) => esc(isPrice && Number.isFinite(Number(v)) && v !== "" ? Number(v).toLocaleString("ko-KR") : v);
        return `<button class="chg" data-q="${esc(o["품목명"])}"><span class="body"><span class="name">${esc(o["품목명"])}</span><br><span class="co">${esc(o["제약사명"])}</span></span><span class="vals"><s>${f(a)}</s> → <b class="${dir}">${f(b)}</b></span></button>`;
      }).join("");
    } else {
      out += s.rows.map((r) => {
        const row = Array(9).fill("");
        h.forEach((k, i) => { if (k in HEAD_MAP) row[HEAD_MAP[k]] = r[i]; });
        return card(row, r[h.indexOf("분류(A)")]);
      }).join("");
    }
  }
  $("meta").innerHTML = `<span><b>${total}</b>건 변동</span><span>요율·약가 변동 항목을 누르면 검색</span>`;
  $("list").innerHTML = out || `<p class="empty">이달 특이사항이 없습니다.</p>`;
}

function renderFav() {
  const pos = new Map(rows.map((r, i) => [favKey(r), i]));
  const found = favs.filter((k) => pos.has(k));
  const missing = favs.length - found.length;
  $("meta").innerHTML = `<span><b>${found.length}</b>개 즐겨찾기</span><span>☆를 누르면 추가·해제</span>`;
  const note = missing
    ? `<div class="fav-missing"><span>즐겨찾기 ${missing}개는 이번 요율표에 없어요.</span><button type="button" id="fav-clean">정리</button></div>`
    : "";
  $("list").innerHTML = note + (found.length
    ? found.map((k) => card(rows[pos.get(k)])).join("")
    : `<p class="empty">아직 즐겨찾기가 없어요.<br>검색 결과에서 품목 이름 옆 ☆를 눌러 모아 보세요.</p>`);
}

function render() {
  if (!DATA) return;
  for (const t of ["search", "month", "fav"]) $("tab-" + t).setAttribute("aria-selected", state.tab === t);
  $("searchrow").hidden = $("filters").hidden = state.tab !== "search";
  $("clear").hidden = !state.q;
  document.querySelectorAll("#filters .chip").forEach((c) => c.setAttribute("aria-pressed", c.dataset.mfg === state.mfg));
  if (state.tab === "search") renderSearch();
  else if (state.tab === "month") renderMonth();
  else renderFav();
  save();
}

function search(q) {
  // 이달 변동·즐겨찾기 탭에서 품목을 눌렀을 때는 검색 탭에 남아 있던 제약사·생산형태 조건 때문에
  // 그 품목이 안 보일 수 있으므로 조건을 풀고 찾는다. 검색 탭 안의 성분 칩은 조건을 그대로 둔다.
  if (state.tab !== "search") { state.co = ""; state.mfg = "all"; $("co").value = ""; }
  state.q = q; state.tab = "search"; state.shown = PAGE;
  $("q").value = q; render(); window.scrollTo(0, 0);
}

let timer;
$("co").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => { state.co = e.target.value; state.shown = PAGE; render(); }, 150); });
$("co").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
$("q").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value; state.shown = PAGE; render(); }, 150); });
$("q").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
$("clear").addEventListener("click", () => { search(""); $("q").focus(); });
$("sort").addEventListener("change", (e) => { state.sort = e.target.value; state.shown = PAGE; render(); });
$("tab-search").addEventListener("click", () => { state.tab = "search"; render(); });
$("tab-month").addEventListener("click", () => { state.tab = "month"; render(); window.scrollTo(0, 0); });
$("tab-fav").addEventListener("click", () => { state.tab = "fav"; render(); window.scrollTo(0, 0); });
$("filters").addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  state.mfg = c.dataset.mfg; state.shown = PAGE; render();
});
$("list").addEventListener("click", (e) => {
  const f = e.target.closest("[data-fav]");
  if (f) {
    toggleFav(f.dataset.fav);
    if (state.tab === "fav") { renderFav(); return; }
    // 검색·이달 변동 화면은 다시 그리지 않고 같은 품목의 별만 바꾼다(스크롤 위치 유지)
    const on = isFav(f.dataset.fav);
    document.querySelectorAll(`[data-fav="${CSS.escape(f.dataset.fav)}"]`).forEach((b) => {
      b.setAttribute("aria-pressed", on); b.textContent = on ? "★" : "☆";
    });
    return;
  }
  if (e.target.closest("#fav-clean")) {
    const keys = new Set(rows.map(favKey));
    favs = favs.filter((k) => keys.has(k));
    store.set("mr-favs", JSON.stringify(favs));
    renderFav();
    return;
  }
  const t = e.target.closest("[data-q], #more");
  if (!t) return;
  if (t.id === "more") { state.shown += PAGE; renderSearch(); return; }
  search(t.dataset.q);
});

$("q").value = state.q;
$("co").value = state.co;
$("sort").value = state.sort;

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
startApp();

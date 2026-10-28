// 마인약품 요율표 PWA - Cloudflare Worker
//
// 정적 파일(public/)은 Cloudflare가 그대로 내주고, /api/* 만 이 코드가 처리한다.
// 요율 데이터는 정적 파일에 넣지 않고 KV(RATE_KV)의 "data"에만 둔다 → 등록된 코드+기기로만 받을 수 있다.
//
// D1(DB) codes 표: 코드별 이름·사용 여부·등록 기기 (schema.sql). 기기 등록은 "아직 미등록일 때만" 같은
//   조건부 UPDATE로 해서 동시에 두 기기가 들어와도 하나만 성공한다. (KV는 쓰기가 퍼지는 데 1분쯤 걸려
//   처음엔 KV에 뒀다가 실서버 시험에서 두 번째 기기가 끼어드는 걸 보고 D1로 옮김)
// KV 키
//   data        build.py가 만든 요율 데이터 JSON (admin.py upload-data). 버전(etag)은 같은 키의 metadata에
//               붙여 둔다 — 키를 따로 두면 KV가 지역마다 늦게 반영될 때 "새 버전 표시 + 옛 데이터"가 섞여
//               앱이 옛 데이터를 최신으로 착각할 수 있어서.
//
// 기기 고정: 코드를 처음 입력한 기기(device = 앱이 만든 무작위 ID)에 묶는다. 다른 기기에서 같은 코드를
// 넣으면 거절. 단, 첫 등록 후 10분 안에는 한 번 옮길 수 있다(아이폰 사파리 → 홈 화면 앱처럼 저장공간이
// 바뀌는 경우 대비). 폰을 바꾼 사람은 admin.py reset 으로 풀어준다.

const REBIND_WINDOW_MS = 10 * 60 * 1000;
const LAST_SEEN_EVERY_MS = 10 * 60 * 1000; // 쓰기 횟수를 아끼려고 접속 기록은 10분에 한 번만 갱신

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/activate" && request.method === "POST") return await activate(request, env);
      if (url.pathname === "/api/data" && request.method === "GET") return await data(request, env);
    } catch (e) {
      return json({ error: "server", message: "잠시 후 다시 시도해 주세요." }, 500);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

// 코드는 대소문자·하이픈·공백 무시 (예: "7k3p q9xa" == "7K3P-Q9XA")
const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const validDevice = (d) => typeof d === "string" && /^[A-Za-z0-9-]{16,64}$/.test(d);

const LOCKED = { error: "device_locked", message: "이미 다른 기기에서 사용 중인 코드입니다. 폰을 바꾸셨다면 관리자에게 기기 초기화를 요청해 주세요." };

async function activate(request, env) {
  let body;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body !== "object") return json({ error: "bad_request", message: "코드를 다시 확인해 주세요." }, 400);
  const code = normCode(body.code);
  const device = body.device;
  if (code.length < 6 || !validDevice(device)) return json({ error: "bad_request", message: "코드를 다시 확인해 주세요." }, 400);

  const id = await sha256(code);
  const rec = await env.DB.prepare("SELECT name, active, device, rebind_until FROM codes WHERE id = ?").bind(id).first();
  if (!rec || !rec.active) return json({ error: "invalid_code", message: "사용할 수 없는 코드입니다. 코드를 다시 확인해 주세요." }, 403);

  const now = Date.now();
  let ok = rec.device === device;
  if (!rec.device) {
    // 첫 등록: 아직 아무 기기도 없을 때만
    const r = await env.DB.prepare(
      "UPDATE codes SET device = ?, activated_at = ?, rebind_until = ?, last_seen = ? WHERE id = ? AND device IS NULL"
    ).bind(device, now, now + REBIND_WINDOW_MS, now, id).run();
    ok = r.meta.changes === 1;
  } else if (!ok && now < rec.rebind_until) {
    // 첫 등록 10분 안 1회 이동: 등록 기기가 그대로이고 이동 여유가 남았을 때만
    const r = await env.DB.prepare(
      "UPDATE codes SET device = ?, rebind_until = 0, last_seen = ? WHERE id = ? AND device = ? AND rebind_until > ?"
    ).bind(device, now, id, rec.device, now).run();
    ok = r.meta.changes === 1;
  } else if (ok) {
    await env.DB.prepare("UPDATE codes SET last_seen = ? WHERE id = ?").bind(now, id).run();
  }
  if (!ok) return json(LOCKED, 403);

  const token = `${id}.${device}.${await hmac(env.TOKEN_SECRET, `${id}.${device}`)}`;
  return json({ token, name: rec.name });
}

async function data(request, env) {
  const auth = request.headers.get("authorization") || "";
  const [id, device, sig] = auth.replace(/^Bearer\s+/i, "").split(".");
  if (!id || !validDevice(device) || !sig || sig !== (await hmac(env.TOKEN_SECRET, `${id}.${device}`))) {
    return json({ error: "unauthorized", message: "코드를 다시 입력해 주세요." }, 401);
  }
  const rec = await env.DB.prepare("SELECT active, device, last_seen FROM codes WHERE id = ?").bind(id).first();
  if (!rec || !rec.active) return json({ error: "revoked", message: "사용이 중지된 코드입니다. 관리자에게 문의해 주세요." }, 401);
  if (!rec.device) return json({ error: "reset", message: "기기 등록이 초기화됐어요. 코드를 다시 입력해 주세요." }, 401);
  if (rec.device !== device) return json({ error: "device_locked", message: "다른 기기에 등록된 코드입니다. 관리자에게 기기 초기화를 요청해 주세요." }, 401);

  const now = Date.now();
  if (now - (rec.last_seen || 0) > LAST_SEEN_EVERY_MS) {
    await env.DB.prepare("UPDATE codes SET last_seen = ? WHERE id = ?").bind(now, id).run();
  }

  // 데이터는 글자로 바꾸지 않고 그대로 흘려보낸다(무료 플랜 CPU 시간 10ms 제한 대비)
  const { value, metadata } = await env.RATE_KV.getWithMetadata("data", "stream");
  if (!value) return json({ error: "no_data", message: "아직 데이터가 올라가지 않았습니다." }, 503);
  const quoted = `"${(metadata && metadata.etag) || "none"}"`;
  // 폰이 압축 응답을 받으면 Cloudflare가 etag를 W/"..."(약한 표시)로 바꿔 보내므로, 돌아온 값의 W/를 떼고 비교
  const sent = (request.headers.get("if-none-match") || "").replace(/^W\//, "");
  if (sent === quoted) {
    await value.cancel();
    return new Response(null, { status: 304, headers: { etag: quoted, "cache-control": "no-store" } });
  }
  return new Response(value, {
    headers: { "content-type": "application/json; charset=utf-8", etag: quoted, "cache-control": "no-store" },
  });
}

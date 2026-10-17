// 앱 화면 파일만 캐시한다(네트워크 우선, 끊겼을 때만 캐시). 요율 데이터(/api/data)는 app.js가
// 토큰과 함께 따로 받아 자체 캐시에 보관하므로 여기서는 손대지 않는다.
const CACHE = "mine-rate-shell-v1";
const SHELL = ["/", "/app.js", "/style.css", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((n) => n.startsWith("mine-rate-shell-") && n !== CACHE).map((n) => caches.delete(n)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request, { cache: "no-store" })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/")))
  );
});

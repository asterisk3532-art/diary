// アプリ本体だけをキャッシュする。日記データ（googleapis）はキャッシュしない。
const CACHE = "diary-shell-v3";
const SHELL = ["./", "./index.html", "./app.js", "./config.js", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png",
  "https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("google.com")) return;
  // 自分のファイル（index/app/config など）は通信できれば常に最新、圏外ならキャッシュ
  if (url.origin === location.origin) {
    e.respondWith(caches.open(CACHE).then(c => fetch(e.request, { cache: "no-store" })
      .then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })
      .catch(() => c.match(e.request, { ignoreSearch: true }))));
    return;
  }
  // フォント・ライブラリはキャッシュ優先
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request);
    if (hit) return hit;
    const r = await fetch(e.request); if (r && (r.ok || r.type === "opaque")) c.put(e.request, r.clone()); return r;
  }));
});

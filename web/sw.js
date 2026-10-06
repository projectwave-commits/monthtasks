// Offline support for the phone app. Online: always fetch the latest files
// (and refresh the cache). Offline: fall back to the cached copy.
const CACHE = "monthtasks-__BUILD__";
const FILES = ["./", "index.html", "style.css", "app.js", "sync.js", "icons.js", "manifest.webmanifest",
  "fonts/patrick-hand-latin-400-normal.woff2", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // GitHub API calls go straight to the network
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const fresh = await fetch(e.request, { cache: "no-cache" });
      if (fresh.ok) c.put(e.request, fresh.clone());
      return fresh;
    } catch {
      return (await c.match(e.request, { ignoreSearch: true })) || (await c.match("index.html"));
    }
  })());
});

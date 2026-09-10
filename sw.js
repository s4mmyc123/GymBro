// We Go Gym service worker: caches the app shell so it works with no signal.
// Data itself lives in IndexedDB (handled in app.js), untouched by this file.

const CACHE = "we-go-gym-v15";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first with cache fallback: you always get the newest version when
// online (no more double-reload to see updates), and the cached copy still
// keeps the app working with no signal.
//
// Only successful http(s) GETs are cached: caching a 404 or a server error
// would replay it forever offline, and cache.put() rejects outright for
// non-http schemes (the backup import fetches data: URLs through here).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || !req.url.startsWith("http")) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() =>
      caches.match(req).then((hit) =>
        // A navigation we never cached under that exact URL (e.g. "/?x=1")
        // still gets the app shell rather than the browser's offline page.
        hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined)
      )
    )
  );
});

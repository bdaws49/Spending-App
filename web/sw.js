// Service worker for the Spending PWA.
// Deliberately does NOT cache the app HTML/JS/config — those always come fresh
// from the network so updates land immediately and the OAuth redirect flow is
// never served a stale page. Only the icons/manifest are cached (for the
// installed-app icon). All bank/network calls (Convex, Plaid) pass through.

const CACHE = "spending-v3";
const ASSETS = [
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Cache-first only for the static icons/manifest.
  const isAsset = /\.(png|webmanifest)$/.test(url.pathname);
  if (isAsset) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // Everything else (index.html, config.js, sw.js) is ALWAYS network — never cached.
  // Fall back to a cached index only if truly offline.
  event.respondWith(fetch(req).catch(() => caches.match("./index.html")));
});

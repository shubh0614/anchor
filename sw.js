// sw.js
// Cache the shell so the app works with no signal. Gym basements
// have no signal. Bump CACHE when any shell file changes.

const CACHE = "anchor-v7";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./storage.js",
  "./styles.css",
  "./plan.json",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network first for our own files, cache fallback when offline. This means a
// pushed fix (layout, plan, logic) always reaches the phone the next time it is
// online, instead of a stale cached copy sticking around. Cross origin requests
// (Google Fonts) are left untouched and go straight to the network.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // fonts and other hosts pass through

  event.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html")))
  );
});

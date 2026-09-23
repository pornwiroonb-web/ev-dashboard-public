const CACHE_NAME = "ts-ev-shell-v1";
const APP_SHELL = [
  "/",
  "/contractor.html",
  "/client.html",
  "/admin-records.html",
  "/planner-import.html",
  "/report.html",
  "/planner.html",
  "/app.js",
  "/auth-guard.js",
  "/style.css",
  "/manifest-admin.json",
  "/manifest-contractor.json",
  "/manifest-client.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Best-effort: don't fail install if one asset 404s (e.g. a page
      // that doesn't exist on an older deploy).
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls or uploaded files — those must always be
  // live/fresh (or fail loudly so the page's own offline handling kicks in).
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) {
    return;
  }
  // Only handle our own origin's GET requests (skip Google Fonts etc. —
  // let the browser's normal HTTP cache handle those).
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline: fall back to whatever we had cached
      // Stale-while-revalidate: serve cached immediately if we have it,
      // still refresh the cache in the background for next time.
      return cached || network;
    })
  );
});

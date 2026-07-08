const CACHE_NAME = "vomebook-search-v3";

const PRECACHE_URLS = [
  "/search/",
  "/search/static/style.css",
  "/search/static/app.js",
  "/search/manifest.json",
  "/search/icons/logo.svg",
  "/search/icons/icon.svg",
  "/search/icons/icon-192.png",
  "/search/icons/icon-512.png"
];

// ── Install: precache app shell ─────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn("[SW] precache partial failure:", err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ──────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// ── Fetch: cache strategies ─────────────────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // External domains (HuggingFace): network only
  if (url.hostname !== self.location.hostname) {
    return;
  }

  // ── Data file: stale-while-revalidate ─────────────
  if (url.pathname.endsWith("search_data.json.gz")) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cached) => {
          const fetchPromise = fetch(event.request).then((response) => {
            if (response.ok) {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() => cached);
          return cached || fetchPromise;
        });
      })
    );
    return;
  }

  // ── App shell: cache first, network fallback ──────
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        if (response.ok && response.status !== 206) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

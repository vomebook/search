const CACHE_NAME = "vomebook-search-v1.0.0";

const PRECACHE_URLS = [
  "/search/",
  "/search/static/style.css",
  "/search/static/reader-contract.js",
  "/search/static/reader-store.js",
  "/search/static/reader.html",
  "/search/static/reader.css",
  "/search/static/reader.js",
  "/search/static/app.js",
  "/search/static/index-worker.js",
  "/search/data/initial/manifest.json",
  "/search/data/sidebar/manifest.json",
  "/search/manifest.json",
  "/search/icons/logo.svg",
  "/search/icons/logo-dark.svg",
  "/search/icons/icon.svg",
  "/search/icons/icon-192.png",
  "/search/icons/icon-512.png"
];
const READER_RUNTIME_PATHS = new Set([
  "/search/static/reader-contract.js",
  "/search/static/reader-store.js",
  "/search/static/reader.css",
  "/search/static/reader.js"
]);
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).then(() => {
        return Promise.all([
          fetch("/search/data/initial/manifest.json")
            .then((resp) => resp.ok ? resp.json() : null)
            .then((manifest) => {
              if (manifest && Array.isArray(manifest.urls)) return cache.addAll(manifest.urls);
            })
            .catch(() => {}),
          fetch("/search/data/sidebar/manifest.json")
            .then((resp) => resp.ok ? resp.json() : null)
            .then((manifest) => {
              if (manifest && Array.isArray(manifest.urls)) return cache.addAll(manifest.urls);
            })
            .catch(() => {})
        ]);
      }).catch((err) => {
        console.warn("[SW] precache partial failure:", err);
      });
    }).then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.hostname !== self.location.hostname) {
    return;
  }
  if ((event.request.mode === "navigate" && url.pathname === "/search/static/reader.html") || READER_RUNTIME_PATHS.has(url.pathname)) {
    const cacheKey = event.request.mode === "navigate" ? "/search/static/reader.html" : event.request;
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => cache.match(cacheKey).then((cached) =>
        fetch(event.request).then((response) => {
          if (response.ok) cache.put(cacheKey, response.clone());
          return response.ok || !cached ? response : cached;
        }).catch(() => cached)
      ))
    );
    return;
  }
  if (url.pathname.endsWith(".json.gz")) {
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
  if ((url.pathname.startsWith("/search/data/initial/") || url.pathname.startsWith("/search/data/sidebar/")) && url.pathname.endsWith(".json")) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cached) => {
          const fetchPromise = fetch(event.request).then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached);
          return cached || fetchPromise;
        });
      })
    );
    return;
  }
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

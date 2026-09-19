const CACHE_NAME = "vomebook-search-v1.0.0";
const CURRENT_HASHED_ASSETS = []; // Filled by the static build.
let cachePruning = Promise.resolve();
function pruneHashedAssets(cache) {
  cachePruning = cachePruning.catch(() => {}).then(async () => {
    const groups = new Map();
    const current = new Set(CURRENT_HASHED_ASSETS);
    for (const request of await cache.keys()) {
      const url = new URL(request.url);
      const match = url.pathname.match(/^(.*)\.[0-9a-f]{12}\.(js|mjs|css)$/);
      if (!match || current.has(url.pathname)) continue;
      const key = match[1] + "." + match[2];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(request);
    }
    // Retain two preceding variants for cached shells and already-open tabs.
    for (const requests of groups.values()) {
      for (const request of requests.slice(0, -2)) await cache.delete(request);
    }
  });
  return cachePruning;
}

const PRECACHE_URLS = [
  "/search/",
  "/search/static/style.css",
  "/search/static/reader-contract.js",
  "/search/static/reader-navigation.js",
  "/search/static/app.js",
  "/search/static/index-worker.js",
  "/search/data/initial/manifest.json",
  "/search/data/sidebar/manifest.json",
  "/search/data/initial/global.json",
  "/search/data/sidebar/global.json",
  "/search/manifest.json",
  "/search/icons/logo.svg",
  "/search/icons/logo-dark.svg",
  "/search/icons/icon.svg",
  "/search/icons/icon-192.png",
  "/search/icons/icon-512.png"
];
const READER_RUNTIME_PATHS = new Set([
  "/search/static/reader-chapter-search.mjs",
  "/search/static/reader-chapter-search-worker.mjs",
  "/search/static/reader-navigation.js",
  "/search/static/reader-contract.js",
  "/search/static/reader-store.js",
  "/search/static/reader-request-manager.js",
  "/search/static/reader-chapter-repository.js",
  "/search/static/reader-scroll-anchor.js",
  "/search/static/reader-section-virtualizer.js",
  "/search/static/reader-runtime.js",
  "/search/static/reader-format-adapters.js",
  "/search/static/reader-security.js",
  "/search/static/reader.css",
  "/search/static/reader.js",
  "/search/static/pdf-worker-wrapper.mjs"
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
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
    }).then(() => caches.open(CACHE_NAME).then(pruneHashedAssets).catch(() => {})).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.hostname !== self.location.hostname || (event.request.method || "GET") !== "GET") {
    return;
  }
  const readerNavigation = event.request.mode === "navigate" && url.pathname === "/search/static/reader.html";
  const networkFirst = readerNavigation || READER_RUNTIME_PATHS.has(url.pathname);
  const cacheKey = readerNavigation ? "/search/static/reader.html" : event.request;
  const cachePromise = caches.open(CACHE_NAME).catch(() => null);
  const cachedPromise = cachePromise.then(cache => cache ? cache.match(cacheKey) : undefined).catch(() => undefined);
  // Content-addressed assets never need a revalidation request on cache hits.
  const immutable = /\.[0-9a-f]{12}\.(?:js|mjs|css)$/.test(url.pathname);
  let cacheWrite;
  const networkPromise = Promise.all([cachePromise, immutable ? cachedPromise : null]).then(([cache, cached]) => cached || fetch(event.request).then(response => {
    if (cache && response.ok && response.status !== 206) {
      cacheWrite = cache.put(cacheKey, response.clone()).then(() => immutable ? pruneHashedAssets(cache) : undefined).catch(() => {});
    }
    return response;
  }));
  // A cached response can finish immediately; keep revalidation and the entire
  // cache write alive independently, without delaying streaming cache misses.
  event.waitUntil(networkPromise.then(() => cacheWrite).catch(() => {}));
  event.respondWith(networkFirst
    ? networkPromise.then(response => response.ok ? response : cachedPromise.then(cached => cached || response)).catch(() => cachedPromise)
    : cachedPromise.then(cached => cached || networkPromise.catch(() => cached)));
});

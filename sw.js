importScripts("/search/static/reader-resources.js");
const CACHE_NAME = "vomebook-search-v1.0.0";
const CURRENT_HASHED_ASSETS = []; // Filled by the static build.
let cachePruning = Promise.resolve();
function isRetiredAsset(pathname) {
  return CURRENT_HASHED_ASSETS.length > 0 &&
    (/\.[0-9a-f]{12}\.(js|mjs|css)$/.test(pathname) || /^\/search\/static\/[^/]+\.(js|mjs|css)$/.test(pathname)) &&
    !CURRENT_HASHED_ASSETS.includes(pathname);
}
function pruneHashedAssets(cache, resetShell = false) {
  cachePruning = cachePruning.catch(() => {}).then(async () => {
    for (const request of await cache.keys()) {
      const url = new URL(request.url);
      if (isRetiredAsset(url.pathname) || (resetShell && url.pathname === "/search/static/reader.html")) await cache.delete(request);
    }
  });
  return cachePruning;
}

const PRECACHE_URLS = [
  "/search/",
  "/search/static/style.css",
  "/search/static/reader-resources.js",
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
const READER_RUNTIME_PATHS = new Set(VoiceOfMLReaderResources.runtimePaths("/search/static/"));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => caches.open(CACHE_NAME).then(cache => pruneHashedAssets(cache, true)).catch(() => {})).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.hostname !== self.location.hostname || (event.request.method || "GET") !== "GET") {
    return;
  }
  // Retired URLs must reach the server; never return or repopulate old cache entries.
  if (isRetiredAsset(url.pathname)) return;
  const readerNavigation = event.request.mode === "navigate" && url.pathname === "/search/static/reader.html";
  const searchNavigation = event.request.mode === "navigate" && ["/search/", "/search/index.html"].includes(url.pathname);
  const networkFirst = searchNavigation || readerNavigation || READER_RUNTIME_PATHS.has(url.pathname);
  const cacheKey = readerNavigation ? "/search/static/reader.html" : searchNavigation ? "/search/" : event.request;
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

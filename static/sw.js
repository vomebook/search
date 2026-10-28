importScripts("/search/static/reader-resources.js");
const CACHE_NAME = "vomebook-search-v1.0.0";
const CURRENT_HASHED_ASSETS = []; // Filled by the static build.
let cachePruning = Promise.resolve();
function isRetiredAsset(pathname) {
  if (CURRENT_HASHED_ASSETS.length && isDjvuDecoderAsset(pathname)) return !CURRENT_HASHED_ASSETS.includes(pathname);
  return CURRENT_HASHED_ASSETS.length > 0 &&
    (/\.[0-9a-f]{12}\.(js|mjs|css)$/.test(pathname) || /^\/search\/static\/(?:(?:reader|search)\/[^?]+|[^/]+)\.(js|mjs|css)$/.test(pathname)) &&
    !CURRENT_HASHED_ASSETS.includes(pathname);
}
// Activation keeps the previous generation's hashed files under a marker key for
// one more release: an already-open old page may still lazy-load them after the
// new worker claims it, and the server no longer has them. They are used only as
// a fallback when the network cannot serve the retired URL, never repopulated,
// and the generation before that is deleted.
const RETAINED_MARKER = "sw-retained-generation";
function retainedKey(url) {
  const key = new URL(url); key.search = "?" + RETAINED_MARKER; return key.href;
}
function pruneHashedAssets(cache, resetShell = false, activation = false) {
  cachePruning = cachePruning.catch(() => {}).then(async () => {
    for (const request of await cache.keys()) {
      const url = new URL(request.url);
      if (url.search === "?" + RETAINED_MARKER) {
        if (activation) await cache.delete(request);
        continue;
      }
      if (resetShell && url.pathname === "/search/static/reader.html") { await cache.delete(request); continue; }
      if (!isRetiredAsset(url.pathname)) continue;
      if (activation && (/\.[0-9a-f]{12}\.(?:js|mjs|css)$/.test(url.pathname) || isDjvuDecoderAsset(url.href))) {
        const response = await cache.match(request, { ignoreVary: true });
        if (response) await cache.put(retainedKey(url.href), response);
      }
      await cache.delete(request);
    }
  });
  return cachePruning;
}

// Unversioned shells/data must revalidate with the server: a browser HTTP-cache
// copy can predate the current deploy and reference hashes this worker prunes.
function revalidatedRequest(request) {
  const url = typeof request === "string" ? request : request.url;
  if (/\.[0-9a-f]{12}\.(?:js|mjs|css)$/.test(url) || isDjvuDecoderAsset(url) || typeof Request !== "function" ||
      (typeof request !== "string" && request.cache && request.cache !== "default")) return request;
  try { return new Request(request, { cache: "no-cache" }); } catch (_) { return request; }
}

function isDjvuDecoderAsset(value) {
  try { return /^\/search\/static\/vendor\/djvu-rs-reader\/release-[0-9a-f]{12}-[0-9a-f]{12}\/(?:scalar|simd128)\/djvu_rs(?:_bg\.wasm|\.js)$/.test(value.startsWith('/') ? value : new URL(value).pathname); }
  catch (_) { return false; }
}

const PRECACHE_URLS = [
  "/search/",
  "/search/static/style.css",
  "/search/static/reader-resources.js",
  "/search/static/reader/core/reader-contract.js",
  "/search/static/search/reader-navigation.js",
  "/search/static/app.js",
  "/search/static/search/index-worker.js",
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
      return cache.addAll(PRECACHE_URLS.map(revalidatedRequest));
    }).then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => caches.open(CACHE_NAME).then(cache => pruneHashedAssets(cache, true, true)).catch(() => {})).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.hostname !== self.location.hostname || (event.request.method || "GET") !== "GET") {
    return;
  }
  // Retired URLs always reach the server first and are never repopulated; only a
  // missing/failed response falls back to the one retained previous generation.
  if (isRetiredAsset(url.pathname)) {
    const retained = () => caches.open(CACHE_NAME).then(cache => cache.match(retainedKey(url.href), { ignoreVary: true })).catch(() => undefined);
    event.respondWith(fetch(event.request).then(response =>
      response.ok ? response : retained().then(cached => cached || response),
      error => retained().then(cached => { if (cached) return cached; throw error; })));
    return;
  }
  const readerShell = url.pathname === "/search/static/reader.html";
  const searchNavigation = event.request.mode === "navigate" && ["/search/", "/search/index.html"].includes(url.pathname);
  // Catalog HTML and its manifest/sitemap must not inherit the SPA shell cache.
  if ((event.request.mode === "navigate" && !searchNavigation && !readerShell) ||
      ["/search/sitemap.xml", "/search/seo-publication.json"].includes(url.pathname)) return;
  const generatedData = url.pathname.startsWith("/search/data/");
  const networkFirst = !readerShell && (searchNavigation || generatedData || READER_RUNTIME_PATHS.has(url.pathname));
  const cacheKey = readerShell ? "/search/static/reader.html" : searchNavigation ? "/search/" : event.request;
  const immutable = /\.[0-9a-f]{12}\.(?:js|mjs|css)$/.test(url.pathname) || isDjvuDecoderAsset(url.href);
  const cachePromise = caches.open(CACHE_NAME).catch(() => null);
  // Pinned same-origin assets are identical across classic/module Origin headers.
  const cachedPromise = cachePromise.then(cache => cache ? cache.match(cacheKey, { ignoreVary: immutable }) : undefined).catch(() => undefined);
  let cacheWrite;
  const networkPromise = Promise.all([cachePromise, immutable ? cachedPromise : null]).then(([cache, cached]) => cached || fetch(revalidatedRequest(event.request)).then(response => {
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

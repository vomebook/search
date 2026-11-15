const readerWorkerScope = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
importScripts("/search/static/reader-resources.js");
const CACHE_PREFIX = "vomebook-search-";
const CACHE_VERSION = "development"; // Replaced with a content digest by the static build.
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
/** @type {string[]} */
const CURRENT_HASHED_ASSETS = []; // Filled by the static build.
let cachePruning = Promise.resolve();
/** @param {string} pathname @returns {boolean} */
function isRetiredAsset(pathname) {
  if (CURRENT_HASHED_ASSETS.length && (isDjvuDecoderAsset(pathname) || isRuffleAsset(pathname))) return !CURRENT_HASHED_ASSETS.includes(pathname);
  return CURRENT_HASHED_ASSETS.length > 0 &&
    (/\.[0-9a-f]{12}\.(js|mjs|css)$/.test(pathname) || /^\/search\/static\/(?:(?:reader|search)\/[^?]+|[^/]+)\.(js|mjs|css)$/.test(pathname)) &&
    !CURRENT_HASHED_ASSETS.includes(pathname);
}
// Keep the actual previous cache for one release, including immutable assets
// written by its worker after takeover. Install never changes this pointer.
const METADATA_CACHE = CACHE_PREFIX + "metadata";
const ACTIVE_KEY = "/search/.sw-active-generation";
/** @typedef {{ active: string, previous: string | null }} GenerationState */
/** @param {unknown} name @returns {name is string} */
function isGenerationName(name) {
  return typeof name === "string" && name.startsWith(CACHE_PREFIX) && name !== METADATA_CACHE;
}
/** @returns {Promise<GenerationState | null>} */
async function activeGeneration() {
  const response = await (await caches.open(METADATA_CACHE)).match(ACTIVE_KEY);
  if (!response) return null;
  const state = await response.json();
  return state && isGenerationName(state.active)
    ? { active: state.active, previous: isGenerationName(state.previous) ? state.previous : null } : null;
}
/** @param {URL} url @returns {boolean} */
function isImmutableURL(url) {
  return url.origin === self.location.origin && !url.searchParams.has("sw-retained-generation") && url.pathname.startsWith("/search/static/") &&
    (/\.[0-9a-f]{12}\.(?:js|mjs|css)$/.test(url.pathname) || isDjvuDecoderAsset(url.href) || isRuffleAsset(url.href));
}
/** @param {URL} url @returns {Promise<Response | undefined>} */
async function previousAsset(url) {
  if (!isImmutableURL(url)) return undefined;
  try {
    const state = await activeGeneration();
    if (!state || state.active !== CACHE_NAME || !state.previous || state.previous === CACHE_NAME ||
        !(await caches.keys()).includes(state.previous)) return undefined;
    return await (await caches.open(state.previous)).match(url.href, { ignoreVary: true });
  } catch (_) { return undefined; }
}
/** @param {string} name @returns {Promise<void>} */
async function prunePreviousGeneration(name) {
  const cache = await caches.open(name);
  for (const request of await cache.keys()) {
    // Shells, data, aliases and the former snapshot-marker entries are never
    // fallback candidates. Late mutable writes are harmless: reads check again.
    if (!isImmutableURL(new URL(request.url))) await cache.delete(request);
  }
}
/** @param {Cache} cache @returns {Promise<void>} */
function pruneHashedAssets(cache) {
  cachePruning = cachePruning.catch(() => {}).then(async () => {
    for (const request of await cache.keys()) {
      const url = new URL(request.url);
      if (!isRetiredAsset(url.pathname)) continue;
      await cache.delete(request);
    }
  });
  return cachePruning;
}

// Unversioned shells/data must revalidate with the server: a browser HTTP-cache
// copy can predate the current deploy and reference hashes this worker prunes.
/** @param {Request | string} request @returns {Request | string} */
function revalidatedRequest(request) {
  const url = typeof request === "string" ? request : request.url;
  if (/\.[0-9a-f]{12}\.(?:js|mjs|css)$/.test(url) || isDjvuDecoderAsset(url) || isRuffleAsset(url) || typeof Request !== "function" ||
      (typeof request !== "string" && request.cache && request.cache !== "default")) return request;
  try { return new Request(request, { cache: "no-cache" }); } catch (_) { return request; }
}

/** @param {string} value @returns {boolean} */
function isDjvuDecoderAsset(value) {
  try { return /^\/search\/static\/vendor\/djvu-rs-reader\/release-[0-9a-f]{12}-[0-9a-f]{12}\/(?:scalar|simd128)\/djvu_rs(?:_bg\.wasm|\.js)$/.test(value.startsWith('/') ? value : new URL(value).pathname); }
  catch (_) { return false; }
}

/** @param {string} value @returns {boolean} */
function isRuffleAsset(value) {
  try { return /^\/search\/static\/vendor\/ruffle\/release-[0-9a-f]{12}\/(?:ruffle\.js|core\.ruffle\.[0-9a-f]{20}\.js|[0-9a-f]{20}\.wasm)$/.test(value.startsWith('/') ? (value.split(/[?#]/)[0] || '') : new URL(value).pathname); }
  catch (_) { return false; }
}

const PRECACHE_URLS = [
  "/search/",
  "/search/static/style.css",
  "/search/static/reader-resources.js",
  "/search/static/reader/core/reader-contract.js",
  "/search/static/search/reader-navigation.js",
  "/search/static/search/reader-host/presentation/return-position.js",
  "/search/static/search/reader-host/application/host.js",
  "/search/static/search/positions/domain/policy.js",
  "/search/static/search/positions/infrastructure/indexed-db.js",
  "/search/static/search/positions/application/persistence.js",
  "/search/static/search/positions/application/restoration.js",
  "/search/static/search/results/presentation/row.js",
  "/search/static/search/results/application/interactions.js",
  "/search/static/search/discovery/application/random.js",
  "/search/static/search/shell/presentation/view.js",
  "/search/static/search/shell/application/controller.js",
  "/search/static/search/history/infrastructure/store.js",
  "/search/static/search/history/application/controller.js",
  "/search/static/search/ambient/application/quotation.js",
  "/search/static/search/corpus/application/client.js",
  "/search/static/search/results/snapshots/domain/copy-budget.js",
  "/search/static/search/results/snapshots/application/store.js",
  "/search/static/search/input/domain/ownership.js",
  "/search/static/search/input/application/controller.js",
  "/search/static/search/sidebar/presentation/filter-list.js",
  "/search/static/search/sidebar/presentation/folder-tree.js",
  "/search/static/search/sidebar/application/filters.js",
  "/search/static/search/sidebar/infrastructure/scroll.js",
  "/search/static/search/sidebar/presentation/directory.js",
  "/search/static/search/sidebar/application/directory.js",
  "/search/static/search/results/domain/paging-policy.js",
  "/search/static/search/results/application/paging-controller.js",
  "/search/static/search/requests/infrastructure/shared-transport.js",
  "/search/static/search/requests/application/prefetch-controller.js",
  "/search/static/search/results/presentation/paging-status.js",
  "/search/static/search/results/window/application/page-loader.js",
  "/search/static/search/results/window/presentation/status.js",
  "/search/static/search/execution/domain/policy.js",
  "/search/static/search/execution/application/controller.js",
  "/search/static/search/downloads/application/batch.js",
  "/search/static/search/downloads/presentation/queue.js",
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

readerWorkerScope.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const existed = (await caches.keys()).includes(CACHE_NAME);
    try {
      const state = await activeGeneration();
      // Reinstalling the serving generation must not replace its shell/data.
      // Rollback to a retained cache still refreshes the complete core atomically.
      if (!existed || !state || state.active !== CACHE_NAME) {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(PRECACHE_URLS.map(revalidatedRequest));
      }
    } catch (error) {
      // A failed candidate must not leave a cache that looks like a release.
      // Preserve an existing generation when reinstalling or rolling back.
      if (!existed) await caches.delete(CACHE_NAME);
      throw error;
    }
    await readerWorkerScope.skipWaiting();
  })());
});
readerWorkerScope.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const state = await activeGeneration();
    const legacy = CACHE_PREFIX + "v1.0.0";
    const previous = state ? (state.active === CACHE_NAME ? state.previous : state.active)
      : names.includes(legacy) ? legacy : null;
    const previousName = previous && previous !== CACHE_NAME && names.includes(previous) ? previous : null;
    // A single metadata write replaces stale rollback state before any cleanup.
    // Failed/unactivated candidates never become a previous generation.
    await (await caches.open(METADATA_CACHE)).put(ACTIVE_KEY,
      new Response(JSON.stringify({ active: CACHE_NAME, previous: previousName })));
    if (previousName) await prunePreviousGeneration(previousName).catch(() => {});
    const oldNames = names.filter(name => isGenerationName(name) && name !== CACHE_NAME && name !== previousName);
    await Promise.all(oldNames.map(name => caches.delete(name).catch(() => false)));
    await readerWorkerScope.clients.claim();
  })());
});
readerWorkerScope.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || (event.request.method || "GET") !== "GET") {
    return;
  }
  // Retired URLs always reach the server first and are never repopulated; only a
  // missing/failed response falls back to the one retained previous generation.
  if (isRetiredAsset(url.pathname)) {
    const retained = () => previousAsset(url);
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
  const immutable = /\.[0-9a-f]{12}\.(?:js|mjs|css)$/.test(url.pathname) || isDjvuDecoderAsset(url.href) || isRuffleAsset(url.href);
  const cachePromise = caches.open(CACHE_NAME).catch(() => null);
  /** @type {Promise<void> | undefined} */
  let cacheWrite;
  // Pinned same-origin assets are identical across classic/module Origin headers.
  const cachedPromise = cachePromise.then(async cache => {
    const cached = cache ? await cache.match(cacheKey, { ignoreVary: immutable }) : undefined;
    if (cached || !immutable) return cached;
    const previous = await previousAsset(url);
    if (cache && previous && previous.ok && previous.status !== 206) {
      // Promote only requested current assets so the next release can retain
      // them. The event lifetime covers persistence without delaying delivery.
      cacheWrite = cache.put(cacheKey, previous.clone()).then(() => pruneHashedAssets(cache)).catch(() => {});
    }
    return previous;
  }).catch(() => undefined);
  const networkPromise = Promise.all([cachePromise, immutable ? cachedPromise : null]).then(([cache, cached]) => cached || fetch(revalidatedRequest(event.request)).then(response => {
    if (cache && response.ok && response.status !== 206) {
      cacheWrite = cache.put(cacheKey, response.clone()).then(() => immutable ? pruneHashedAssets(cache) : undefined).catch(() => {});
    }
    return response;
  }));
  // A cached response can finish immediately; keep revalidation and the entire
  // cache write alive independently, without delaying streaming cache misses.
  event.waitUntil(networkPromise.then(() => cacheWrite).catch(() => {}));
  const responsePromise = networkFirst
    ? networkPromise.then(response => response.ok ? response : cachedPromise.then(cached => cached || response)).catch(() => cachedPromise)
    : cachedPromise.then(cached => cached || networkPromise.catch(() => cached));
  event.respondWith(responsePromise.then(response => {
    // respondWith requires a Response; reject on a true offline cache miss
    // so the browser reports a network failure instead of receiving undefined.
    if (!response) throw new TypeError("Network unavailable and no cached response");
    return response;
  }));
});

const readerWorkerScope = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
importScripts("/search/static/reader-resources.js");
const CACHE_PREFIX = "vomebook-search-";
const CACHE_VERSION = "development"; // Replaced with a content digest by the static build.
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const READER_SHELL_INTEGRITY = "development"; // Stamped from the rewritten Reader HTML.
const SEARCH_SHELL_INTEGRITY = "development"; // Installation only; online navigation stays network first.
const CORPUS_INTEGRITY = "development";
/** @type {Record<string, string>} */
const PDF_SUPPORT_INTEGRITY = {}; // Pinned support files keep their public URLs.
/** @type {string[]} */
const CURRENT_HASHED_ASSETS = []; // Filled by the static build.
const currentAssetPaths = new Set(CURRENT_HASHED_ASSETS);
const HASHED_ASSET_PATTERN = /\.[0-9a-f]{12}\.(?:js|mjs|css)$/;
/** @type {Promise<void> | null} */
let cachePruning = null;
let cachePruningDirty = false;
/** @typedef {{ sequence: number, cache: Cache, key: Request | string, copy: Response }} MutableWrite */
/** @typedef {{ started: number, committed: number, pending: number, writes: Promise<void> | null, queued: MutableWrite | null }} MutableRequests */
/** @type {Map<string, MutableRequests>} */
const mutableRequests = new Map();
/** @param {Response} response */
function discardMutableCopy(response) {
  // Tee cancellation can wait for the client branch. Never await it here.
  try { if (response.body && typeof response.body.cancel === "function") void response.body.cancel().catch(() => {}); } catch (_) {}
}
/** @param {MutableRequests} state @param {number} sequence @param {Cache} cache @param {Request | string} key @param {Response} response @returns {Promise<void>} */
function writeMutable(state, sequence, cache, key, response) {
  // Do not create an unread tee for an already obsolete response. While a put
  // is active, coalesce only eligible responses into the newest pending slot.
  if (sequence <= state.committed || (state.queued && sequence <= state.queued.sequence)) return state.writes || Promise.resolve();
  if (state.queued) {
    discardMutableCopy(state.queued.copy);
    state.queued = null;
  }
  state.queued = { sequence, cache, key, copy: response.clone() };
  if (!state.writes) state.writes = Promise.resolve().then(async () => {
    while (state.queued) {
      const write = state.queued;
      state.queued = null;
      if (write.sequence <= state.committed) {
        discardMutableCopy(write.copy);
        continue;
      }
      try {
        await write.cache.put(write.key, write.copy);
        state.committed = write.sequence;
      } catch (_) {
        discardMutableCopy(write.copy);
      }
    }
    // Clear synchronously with observing an empty slot: an arriving response
    // must either join this drain or start another, never land between them.
    state.writes = null;
  });
  return state.writes;
}
/** @param {string} pathname @returns {boolean} */
function isRemovedReaderAsset(pathname) {
  return /^\/search\/static\/(?:foliate-reader\/|vendor\/(?:(?:zip|ruffle)\.[0-9a-f]{12}\.js|LICENSE_zipjs\.[0-9a-f]{12}\.txt)$)/.test(pathname);
}
/** @param {string} pathname @returns {boolean} */
function isRetiredAsset(pathname) {
  return currentAssetPaths.size > 0 &&
    (isDjvuDecoderAsset(pathname) || isRuffleAsset(pathname) || HASHED_ASSET_PATTERN.test(pathname) ||
      /^\/search\/static\/(?:(?:reader|search)\/[^?]+|[^/]+)\.(js|mjs|css)$/.test(pathname)) &&
    !currentAssetPaths.has(pathname);
}
// Retain a bounded history of serving generations for older open clients.
// Install never changes this pointer.
const RETAINED_GENERATIONS = 3;
const METADATA_CACHE = CACHE_PREFIX + "metadata";
const ACTIVE_KEY = "/search/.sw-active-generation";
/** @typedef {{ active: string, history: string[] }} GenerationState */
/** @param {unknown} name @returns {name is string} */
function isGenerationName(name) {
  return typeof name === "string" && name.startsWith(CACHE_PREFIX) && name !== METADATA_CACHE;
}
/** @returns {Promise<GenerationState | null>} */
async function activeGeneration() {
  const response = await (await caches.open(METADATA_CACHE)).match(ACTIVE_KEY);
  if (!response) return null;
  try {
    const state = await response.json();
    if (!state || !isGenerationName(state.active)) return null;
    const history = Array.isArray(state.history) ? state.history.filter(isGenerationName) : [];
    // Older stored metadata may have only the previous pointer.
    if (isGenerationName(state.previous)) history.unshift(state.previous);
    return { active: state.active,
      history: [...new Set(history)].filter(name => name !== state.active).slice(0, RETAINED_GENERATIONS) };
  } catch (_) { return null; }
}
/** @param {URL} url @returns {boolean} */
function isImmutableURL(url) {
  return url.origin === self.location.origin && !url.searchParams.has("sw-retained-generation") && url.pathname.startsWith("/search/static/") &&
    !isRemovedReaderAsset(url.pathname) &&
    (HASHED_ASSET_PATTERN.test(url.pathname) || isDjvuDecoderAsset(url.href) || isRuffleAsset(url.href));
}
/** @param {URL} url @returns {Promise<Response | undefined>} */
async function previousAsset(url) {
  if (!isImmutableURL(url)) return undefined;
  try {
    const state = await activeGeneration();
    if (!state || state.active !== CACHE_NAME) return undefined;
    const names = await caches.keys();
    for (const name of state.history) {
      if (!names.includes(name)) continue;
      const response = await (await caches.open(name)).match(url.href, { ignoreVary: true });
      if (response && response.ok && response.status !== 206) return response;
    }
    return undefined;
  } catch (_) { return undefined; }
}
/** @param {string} path */
function reusableIntegrity(path) {
  if (path === "/search/data/search_data.json.gz" && CORPUS_INTEGRITY !== "development") return CORPUS_INTEGRITY;
  return PDF_SUPPORT_INTEGRITY[path];
}
/** @param {string | undefined} previous */
async function reuseCurrentBytes(previous) {
  if (!previous || !self.crypto?.subtle) return;
  const from = await caches.open(previous), to = await caches.open(CACHE_NAME);
  for (const key of await from.keys()) {
    const url = new URL(key.url), expected = reusableIntegrity(url.pathname);
    if (!expected || url.origin !== self.location.origin || url.search) continue;
    const response = await from.match(key);
    if (!response?.ok || response.status === 206) continue;
    const bytes = await response.arrayBuffer();
    const digest = await self.crypto.subtle.digest("SHA-256", bytes);
    if (expected === "sha256-" + btoa(String.fromCharCode(...new Uint8Array(digest))))
      await to.put(key, new Response(bytes, { headers: response.headers, status: response.status, statusText: response.statusText }));
  }
}
/** @param {string} name @param {(url: URL) => boolean} shouldDelete @returns {Promise<void>} */
async function pruneGeneration(name, shouldDelete) {
  const cache = await caches.open(name);
  for (const request of await cache.keys()) {
    if (shouldDelete(new URL(request.url))) await cache.delete(request);
  }
}
/** @param {Cache} cache @returns {Promise<void>} */
function pruneHashedAssets(cache) {
  // All callers use CACHE_NAME, even when caches.open returns different handles.
  cachePruningDirty = true;
  if (!cachePruning) {
    cachePruning = Promise.resolve().then(async () => {
      try {
        while (cachePruningDirty) {
          cachePruningDirty = false;
          for (const request of await cache.keys()) {
            const url = new URL(request.url);
            if (isRemovedReaderAsset(url.pathname) || isRetiredAsset(url.pathname)) await cache.delete(request);
          }
        }
      } finally {
        // Release in this task: a later microtask must start a new scan, not
        // join a finished one. Rejections also leave the next call free to retry.
        cachePruning = null;
      }
    });
  }
  return cachePruning;
}

// Unversioned shells/data must revalidate with the server: a browser HTTP-cache
// copy can predate the current deploy and reference hashes this worker prunes.
/** @param {Request | string} request @returns {Request | string} */
function revalidatedRequest(request) {
  const url = typeof request === "string" ? request : request.url;
  if (HASHED_ASSET_PATTERN.test(url) || isDjvuDecoderAsset(url) || isRuffleAsset(url) || typeof Request !== "function") return request;
  // Pin both installation and background refresh: a concurrent deploy must
  // not put HTML that references a different graph into this generation.
  if (READER_SHELL_INTEGRITY !== "development" && new URL(url, self.location.origin).pathname === "/search/static/reader.html") {
    const cache = typeof request !== "string" && request.cache !== "default" ? request.cache : "no-cache";
    return new Request(request, { cache, integrity: READER_SHELL_INTEGRITY });
  }
  if (typeof request !== "string" && request.cache && request.cache !== "default") return request;
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
  "/search/static/search/reader-host/application/navigation.js",
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
  "/search/static/search/bootstrap/domain/initial-payload.js",
  "/search/static/search/bootstrap/application/controller.js",
  "/search/static/search/results/virtual/domain/heights.js",
  "/search/static/search/results/virtual/presentation/rows.js",
  "/search/static/search/results/virtual/application/controller.js",
  "/search/static/search/reader-assets/infrastructure/scheduling.js",
  "/search/static/search/reader-assets/infrastructure/sidecar.js",
  "/search/static/search/reader-assets/application/snapshot.js",
  "/search/static/search/routing/domain/route.js",
  "/search/static/search/routing/application/router.js",
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
  "/search/static/search/requests/application/response-store.js",
  "/search/static/search/catalog/domain/sidebar-payload.js",
  "/search/static/search/catalog/application/client.js",
  "/search/static/search/results/presentation/paging-status.js",
  "/search/static/search/results/window/application/page-loader.js",
  "/search/static/search/results/window/presentation/status.js",
  "/search/static/search/execution/domain/policy.js",
  "/search/static/search/execution/application/controller.js",
  "/search/static/search/downloads/application/batch.js",
  "/search/static/search/downloads/presentation/queue.js",
  "/search/static/app.js",
  "/search/static/search/index-worker.js",
  "/search/static/search/worker/domain/text.js",
  "/search/static/search/worker/domain/intersection.js",
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
const READER_SHELL_ASSETS = VoiceOfMLReaderResources.shellAssets("/search/static/");
if (READER_SHELL_INTEGRITY === "development") {
  // The production Reader entry bundles these static imports.
  READER_SHELL_ASSETS.push("/search/static/reader/reader-components.mjs",
    ...VoiceOfMLReaderResources.readerComponentFiles.map(file => "/search/static/" + file));
}
for (const url of READER_SHELL_ASSETS) if (!PRECACHE_URLS.includes(url)) PRECACHE_URLS.push(url);
// Keep the chapter search graph across updates without warming or importing
// these lazy modules when a document opens.
if (READER_SHELL_INTEGRITY !== "development") for (const url of READER_RUNTIME_PATHS) {
  if (/\/reader\/search\/(?:workers\/)?reader-chapter-search(?:[.-]).*\.mjs$/.test(url) && !PRECACHE_URLS.includes(url))
    PRECACHE_URLS.push(url);
}

readerWorkerScope.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const existed = (await caches.keys()).includes(CACHE_NAME);
    try {
      const state = await activeGeneration();
      // Reinstalling the serving generation must not replace its shell/data.
      // Rollback to a retained cache still refreshes the complete core atomically.
      if (!existed || (state && state.active !== CACHE_NAME)) {
        const cache = await caches.open(CACHE_NAME);
        const entries = PRECACHE_URLS.map(revalidatedRequest);
        if (SEARCH_SHELL_INTEGRITY !== "development")
          entries[PRECACHE_URLS.indexOf("/search/")] = new Request("/search/", { cache: "no-cache", integrity: SEARCH_SHELL_INTEGRITY });
        await cache.addAll(entries);
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
    // With unreadable/missing metadata we cannot identify the serving worker.
    // Preserve existing caches during recovery rather than guessing and deleting it.
    const history = state
      ? [...new Set([...(state.active === CACHE_NAME ? [] : [state.active]), ...state.history])]
          .filter(name => name !== CACHE_NAME && names.includes(name)).slice(0, RETAINED_GENERATIONS)
      : names.filter(name => isGenerationName(name) && name !== CACHE_NAME)
          .slice(-RETAINED_GENERATIONS).reverse();
    await (await caches.open(METADATA_CACHE)).put(ACTIVE_KEY,
      new Response(JSON.stringify({ active: CACHE_NAME, previous: history[0] || null, history })));
    if (names.includes(CACHE_NAME)) await pruneGeneration(CACHE_NAME, url => isRemovedReaderAsset(url.pathname)).catch(() => {});
    await reuseCurrentBytes(history[0]).catch(() => {});
    // Only immutable, eligible assets may remain as fallbacks. Do not prune
    // unknown serving generations during metadata recovery.
    if (state) for (const name of history) await pruneGeneration(name, url => !isImmutableURL(url)).catch(() => {});
    if (state) {
      const oldNames = names.filter(name => isGenerationName(name) && name !== CACHE_NAME && !history.includes(name));
      await Promise.all(oldNames.map(name => caches.delete(name).catch(() => false)));
    }
    await readerWorkerScope.clients.claim();
  })());
});
readerWorkerScope.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || (event.request.method || "GET") !== "GET") {
    return;
  }
  // Removed Reader assets never use Cache Storage or the browser HTTP cache.
  if (isRemovedReaderAsset(url.pathname)) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }
  // Other retired URLs try the network first and fall back to retained generations.
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
  const immutable = HASHED_ASSET_PATTERN.test(url.pathname) || isDjvuDecoderAsset(url.href) || isRuffleAsset(url.href);
  // Assign order before any asynchronous work, using the actual normalized key.
  const mutableKey = new URL(typeof cacheKey === "string" ? cacheKey : cacheKey.url, self.location.origin).href;
  // Online navigations may see the next release before its worker activates.
  // In a hashed build only precache owns the offline Search shell; development
  // still refreshes its unversioned shell. Protect the key, not just navigations.
  const precachedSearchShell = currentAssetPaths.size > 0 && mutableKey.replace(/#.*$/, "") === self.location.origin + "/search/";
  const mutable = immutable || precachedSearchShell ? null : mutableRequests.get(mutableKey) || { started: 0, committed: 0, pending: 0, writes: null, queued: null };
  const sequence = mutable ? ++mutable.started : 0;
  if (mutable) {
    ++mutable.pending;
    mutableRequests.set(mutableKey, mutable);
  }
  const cachePromise = caches.open(CACHE_NAME).catch(() => null);
  /** @type {Promise<void> | undefined} */
  let cacheWrite;
  // Pinned same-origin assets are identical across classic/module Origin headers.
  const cachedPromise = cachePromise.then(async cache => {
    const cached = cache ? await cache.match(cacheKey, { ignoreVary: immutable }) : undefined;
    if (cached || !immutable) return cached;
    const previous = await previousAsset(url);
    if (cache && previous) {
      // Promote only requested current assets so the next release can retain
      // them. The event lifetime covers persistence without delaying delivery.
      cacheWrite = cache.put(cacheKey, previous.clone()).then(() => pruneHashedAssets(cache)).catch(() => {});
    }
    return previous;
  }).catch(() => undefined);
  const networkPromise = Promise.all([cachePromise, immutable ? cachedPromise : null]).then(([cache, cached]) => cached || fetch(revalidatedRequest(event.request)).then(response => {
    if (cache && !precachedSearchShell && response.ok && response.status !== 206) {
      cacheWrite = mutable ? writeMutable(mutable, sequence, cache, cacheKey, response)
        : cache.put(cacheKey, response.clone()).then(() => pruneHashedAssets(cache)).catch(() => {});
    }
    return response;
  }));
  // A cached response can finish immediately; keep revalidation and the entire
  // cache write alive independently, without delaying streaming cache misses.
  event.waitUntil(networkPromise.then(() => cacheWrite).catch(() => {}).finally(() => {
    // Each request owns its queued write; retain ordering until all have settled.
    if (mutable && --mutable.pending === 0) mutableRequests.delete(mutableKey);
  }));
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

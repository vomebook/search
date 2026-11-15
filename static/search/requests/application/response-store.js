// Memory-only response copies and deferred cache maintenance for one search host.
(function () {
  /** @param {SearchResponseStoreDependencies} deps */
  function create(deps) {
    /** @type {BoundedResponseCache<{time: number, data: VoiceOfMLSearchWindowPageData}>} */
    const cache = new BoundedResponseCache(deps.limit, deps.ttl);
    /** @type {Map<string, {data: VoiceOfMLSearchWindowPageData, viewKey: string}>} */
    const pendingWrites = new Map();
    const identities = new WeakMap();
    let writeFrame = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let writeTimer = null;

    /** @template T @param {T} data @returns {T} */
    function cloneSearchData(data) {
      const page = /** @type {T & {results?: unknown[], total?: unknown, page?: unknown, page_size?: unknown}} */ (data);
      if (!page || !Array.isArray(page.results)) return data;
      deps.rememberSearchPageMetadata(data);
      const copy = {
        ...page,
        results: page.results.slice(),
        total: page.total,
        page: page.page,
        page_size: page.page_size,
      };
      const identity = identities.get(page) || {};
      identities.set(page, identity);
      identities.set(copy, identity);
      return copy;
    }

    /** @param {string} key */
    function getCachedSearchResponse(key) {
      const pending = pendingWrites.get(key);
      if (pending && pending.viewKey === deps.getSearchViewKey()) return cloneSearchData(pending.data);
      const cached = cache.get(key);
      if (!cached) return null;
      if (Date.now() - cached.time > deps.ttl) {
        cache.delete(key);
        return null;
      }
      return cloneSearchData(cached.data);
    }

    function cancelPendingSearchCacheWrites() {
      if (writeFrame) cancelAnimationFrame(writeFrame);
      if (writeTimer !== null) clearTimeout(writeTimer);
      writeFrame = 0;
      writeTimer = null;
      pendingWrites.clear();
    }

    /** @param {string} key @param {VoiceOfMLSearchWindowPageData} data @param {boolean} [defer] */
    function setCachedSearchResponse(key, data, defer = false) {
      const cached = cache.get(key)?.data;
      const identity = identities.get(data);
      if (cached && identity && identities.get(cached) === identity) return;
      if (!defer) {
        pendingWrites.delete(key);
        cache.set(key, { time: Date.now(), data: cloneSearchData(data) });
        return;
      }
      // Keep the existing lookahead's three pages in replacement insertion order.
      pendingWrites.delete(key);
      pendingWrites.set(key, { data: cloneSearchData(data), viewKey: deps.getSearchViewKey() });
      while (pendingWrites.size > 3) pendingWrites.delete(/** @type {string} */ (pendingWrites.keys().next().value));
      if (writeFrame || writeTimer !== null) return;
      writeFrame = requestAnimationFrame(() => {
        writeFrame = 0;
        writeTimer = setTimeout(() => {
          writeTimer = null;
          const writes = [...pendingWrites];
          pendingWrites.clear();
          for (const [cacheKey, entry] of writes) if (entry.viewKey === deps.getSearchViewKey()) {
            setCachedSearchResponse(cacheKey, entry.data);
          }
        }, 0);
      });
    }

    return { cache, pendingWrites, cloneSearchData, getCachedSearchResponse,
      cancelPendingSearchCacheWrites, setCachedSearchResponse };
  }
  globalThis.VoiceOfMLSearchResponseStore = { create };
})();

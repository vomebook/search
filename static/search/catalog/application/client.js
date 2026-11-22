// Catalog metadata requests and caches; route publication remains with the host.
(function () {
  /** @param {PagesCatalogDependencies} deps */
  function create(deps) {
    const folderTreeCache = new Map();
    const sidebarInitialCache = new Map();
    const sidebarInitialPending = new Map();
    /** @type {VoiceOfMLFilterCount[] | null} */
    let repoApiCache = null;
    /** @type {Promise<VoiceOfMLFilterCount[] | null> | null} */
    let repoApiPending = null;
    const extensionApiCache = new Map();
    const extensionApiPending = new Map();

    async function fetchRepos() {
      if (repoApiCache) return repoApiCache;
      if (repoApiPending) return repoApiPending;
      if (!deps.apiAvailable()) return null;
      repoApiPending = fetchMetadataList(deps.apiBase + "/api/repos")
        .then(function(data) {
          deps.noteApiSuccess();
          repoApiCache = data;
          return data;
        })
        .catch(function(error) {
          if (!error || error.name !== "AbortError") deps.noteApiFailure();
          return null;
        })
        .finally(function() { repoApiPending = null; });
      return repoApiPending;
    }

    /** @param {string | null} repo */
    async function fetchExtensions(repo) {
      var key = repo || "__global__";
      // The renderer augments its result with selected-only types. Keep that
      // mutable array separate from the reusable API inventory.
      if (extensionApiCache.has(key)) return extensionApiCache.get(key).slice();
      if (extensionApiPending.has(key)) return extensionApiPending.get(key);
      if (!deps.apiAvailable()) return null;
      var url = repo ? deps.apiBase + "/api/extensions?repo=" + encodeURIComponent(repo) : deps.apiBase + "/api/extensions";
      var pending = fetchMetadataList(url)
        .then(function(data) { deps.noteApiSuccess(); extensionApiCache.set(key, data.slice()); return data; })
        .catch(function(error) { if (!error || error.name !== "AbortError") deps.noteApiFailure(); return null; })
        .finally(function() { extensionApiPending.delete(key); });
      extensionApiPending.set(key, pending);
      return pending;
    }

    /** @param {string} repo @param {string | null} [cacheKey] */
    async function fetchFolderTree(repo, cacheKey) {
      cacheKey = cacheKey || repo;
      if (cacheKey && folderTreeCache.has(cacheKey)) return folderTreeCache.get(cacheKey);
      if (!deps.apiAvailable()) return null;
      try {
        var data = await fetchMetadataList(deps.apiBase + "/api/folders/" + encodeURIComponent(repo));
        deps.noteApiSuccess();
        if (cacheKey && data) folderTreeCache.set(cacheKey, data);
        return data;
      } catch (e) { if (!e || /** @type {{name?: string}} */ (e).name !== "AbortError") deps.noteApiFailure(); return null; }
    }
    const BROWSER_API_CACHE_MAX = 200;
    /** @type {BoundedResponseCache<VoiceOfMLSidebarEntries>} */
    const browserApiCache = new BoundedResponseCache(BROWSER_API_CACHE_MAX, 5 * 60 * 1000);
    const browserApiPending = new Map();
    /** @param {string} url */
    async function fetchMetadataList(url) {
      const data = await deps.fetchJSON(url, 5000, true);
      if (!Array.isArray(data)) throw new Error("Invalid metadata response");
      return data;
    }

    /** @param {string} repo @param {string} path */
    async function fetchFolderContents(repo, path) {
      if (!deps.apiAvailable()) return null;
      var cacheKey = repo + "|" + (path || "");
      if (browserApiCache.has(cacheKey)) return browserApiCache.get(cacheKey);
      if (browserApiPending.has(cacheKey)) return browserApiPending.get(cacheKey);
      try {
        var qs = path ? "?path=" + encodeURIComponent(path) : "";
        var controller = new AbortController();
        var timeoutId = setTimeout(function() { controller.abort(); }, 12000);
        var promise = fetch(deps.apiBase + "/api/folders/" + encodeURIComponent(repo) + "/contents" + qs, { signal: controller.signal })
          .then(function(resp) {
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            return resp.json();
          })
          .then(function(data) {
            if (browserApiPending.get(cacheKey) !== promise) return null;
            if (data) {
              deps.noteApiSuccess();
              browserApiCache.set(cacheKey, data);
            }
            return data;
          })
          .catch(function(error) {
            if (browserApiPending.get(cacheKey) === promise && (!error || error.name !== "AbortError")) deps.noteApiFailure();
            return null;
          })
          .finally(function() {
            clearTimeout(timeoutId);
            if (browserApiPending.get(cacheKey) === promise) browserApiPending.delete(cacheKey);
          });
        browserApiPending.set(cacheKey, promise);
        return await promise;
      } catch (e) { return null; }
    }

    /** @param {string | null} repo */
    function sidebarInitialUrlForRepo(repo) {
      return repo ? "/search/data/sidebar/repos/" + encodeURIComponent(repo) + ".json" : "/search/data/sidebar/global.json";
    }

    /** @param {string | null} repo */
    async function loadSidebarInitial(repo) {
      var key = repo || "__global__";
      if (sidebarInitialCache.has(key)) return sidebarInitialCache.get(key);
      if (sidebarInitialPending.has(key)) return sidebarInitialPending.get(key);
      var pending = deps.fetchJSON(sidebarInitialUrlForRepo(repo), 4000)
        .then(function(raw) {
          if (!raw) return null;
          var data = /** @type {VoiceOfMLSidebarEntries} */ (VoiceOfMLCatalogSidebarPayload.normalize(raw));
          sidebarInitialCache.set(key, data);
          return data;
        })
        .catch(function() { return null; })
        .finally(function() { sidebarInitialPending.delete(key); });
      sidebarInitialPending.set(key, pending);
      return pending;
    }

    /** @type {BoundedResponseCache<VoiceOfMLSidebarEntries>} */
    const folderContentsCache = new BoundedResponseCache(100, 5 * 60 * 1000);

    /** @param {string} repo @param {string} path */
    async function getFolderContents(repo, path) {
      const cacheKey = repo + "|" + (path || "");
      if (folderContentsCache.has(cacheKey)) return folderContentsCache.get(cacheKey);
      const result = await deps.localWorker(repo, path || "");
      folderContentsCache.set(cacheKey, result);
      return result;
    }

    return { fetchRepos, fetchExtensions, fetchFolderTree, fetchFolderContents, loadSidebarInitial, getFolderContents,
      folderTreeCache, browserApiPending,
      folderContentsCache, extensionApiCache, extensionApiPending,
      get repoApiCache() { return repoApiCache; }, set repoApiCache(value) { repoApiCache = value; },
      get repoApiPending() { return repoApiPending; }, set repoApiPending(value) { repoApiPending = value; } };
  }
  globalThis.VoiceOfMLCatalogClient = { create };
})();

// Own first-page intent, acquisition and application; host effects commit bounded fields.
(function () {
  /** @param {SearchBootstrapDependencies} deps */
  function create(deps) {
    const policy = VoiceOfMLInitialPayload;
    /** @param {SearchInitialPayload | null} data @param {number} intent @param {number | null} [acquiredAt] */
    function apply(data, intent, acquiredAt = Date.now()) {
      if (intent !== deps.intent()) return false;
      if (!data || !Array.isArray(data.results) || !deps.eligible()) return false;
      if (!policy.accepts(data, deps.view())) return false;
      if (!deps.cancelSearch() || intent !== deps.intent()) return false;
      const page = deps.commitPage(data);
      if (acquiredAt !== null) deps.cacheResponse(Object.assign(deps.cloneData(data), page), acquiredAt);
      if (page.results[0] && !(typeof data.generation === "string" && data.generation)) {
        deps.markUnverified(page.results[0], page);
      }
      deps.renderPage();
      deps.syncRoute();
      deps.prefetch();
      deps.scheduleLocalData();
      return true;
    }
    /** @param {string} mode @param {string | null} repo @param {number} intent */
    function currentRoute(mode, repo, intent) {
      const key = deps.viewKey();
      return () => intent === deps.intent() && deps.viewKey() === key
        && deps.view().mode === mode && deps.view().repo === repo;
    }
    /** @param {string} mode @param {string | null} repo @param {number} intent */
    async function tryPayload(mode, repo, intent) {
      const current = currentRoute(mode, repo, intent);
      if (!deps.eligible()) return false;
      const url = deps.payloadURL();
      try {
        if (!current()) return false;
        const cached = deps.cachedResponse();
        let entry = deps.cache.get(url);
        if (cached) {
          const applied = deps.applyPayload(Object.assign(deps.cloneData(cached), {
            mode: deps.view().mode, repo: deps.view().repoFull,
          }), intent, null);
          if (applied && entry && deps.identity(entry.data) !== deps.identity(cached)) deps.cache.delete(url);
          return applied;
        }
        if (!entry) {
          const data = await deps.fetchJSON(url, 6000);
          if (!current()) return false;
          if (!data) return false;
          entry = { data, time: Date.now() };
          deps.cache.set(url, entry);
        }
        if (!current()) return false;
        return deps.applyPayload(entry.data, intent, entry.time);
      } catch (e) {
        return false;
      }
    }
    /** @param {number} intent */
    function fresh(intent) {
      const { mode, repo } = deps.view();
      // View identity alone cannot distinguish a new intent returning to the same key.
      const current = currentRoute(mode, repo, intent);
      if (deps.eligible()) {
        return deps.tryPayload(mode, repo, intent).then(applied => {
          if (!applied && current()) deps.search();
          return applied;
        });
      }
      if (current()) deps.search();
      return Promise.resolve(false);
    }
    return { apply, tryPayload, fresh };
  }
  globalThis.VoiceOfMLSearchBootstrap = { create };
})();

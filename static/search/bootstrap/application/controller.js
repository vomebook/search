// Own first-page intent, acquisition and application; host effects commit bounded fields.
(function () {
  /** @param {SearchBootstrapDependencies} deps */
  function create(deps) {
    const policy = VoiceOfMLInitialPayload;
    /** @param {SearchInitialPayload | null} data @param {number} intent */
    function apply(data, intent) {
      if (intent !== deps.intent()) return false;
      if (!data || !Array.isArray(data.results) || !deps.eligible()) return false;
      if (!policy.accepts(data, deps.view())) return false;
      if (!deps.cancelSearch() || intent !== deps.intent()) return false;
      const page = deps.commitPage(data);
      deps.cacheResponse(page);
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
        let data = deps.cache.get(url);
        if (!data) {
          data = await deps.fetchJSON(url, 6000);
          if (!current()) return false;
          if (!data) return false;
          deps.cache.set(url, data);
        }
        if (!current()) return false;
        return deps.applyPayload(data, intent);
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

// Owns an API prefetch group's queue, disk waits and concurrency. The host
// shares only its cancellation slot with local prefetch and commits page data.
(function () {
  /** @param {VoiceOfMLSearchPrefetchDependencies} deps */
  function create(deps) {
    /** @param {string} base @param {VoiceOfMLSearchRequestBody} template */
    function prefetch(base, template) {
      const key = deps.readView().key, groupKey = base + "|" + deps.stringify(template);
      let controller = deps.getGroup();
      if (!controller || controller.signal.aborted || controller.groupKey !== groupKey) {
        controller?.abort();
        controller = Object.assign(new AbortController(), {
          groupKey, active: new Map(), attempted: new Set(), cacheWaits: new Map(),
        });
        deps.setGroup(controller);
      }
      const current = () => deps.getGroup() === controller && !controller.signal.aborted && key === deps.readView().key;
      const pump = () => {
        const view = deps.readView();
        if (!current() || view.inactive) return;
        const promoted = controller.cacheWaits.get(view.loadedPage + 1);
        if (promoted && !promoted.urgent) promoted.controller.abort();
        const last = Math.min(Math.ceil(view.total / view.pageSize), view.loadedPage + 3);
        for (const page of controller.attempted) if (page <= view.loadedPage) controller.attempted.delete(page);
        for (let page = view.loadedPage + 1; page <= last && controller.active.size < 2; page++) {
          if (deps.hasPage(page) || controller.attempted.has(page)) continue;
          controller.attempted.add(page);
          const body = Object.assign({}, template, {page});
          const cacheKey = base + "|" + deps.stringify(body);
          const expected = view.generation ? {generation: view.generation, total: view.total, query: {pageSize: view.pageSize}} : null;
          const task = (async () => {
            let data = deps.getCached(cacheKey);
            if (data && expected && (data.generation !== expected.generation || data.total !== expected.total)) {
              deps.evictCached(cacheKey); data = null;
            }
            if (!data && expected) {
              const wait = { controller: new AbortController(), urgent: page === deps.readView().loadedPage + 1 };
              controller.cacheWaits.set(page, wait);
              try { data = await deps.readRecent(key, page, expected, wait.urgent ? 25 : 150, wait.controller.signal); }
              finally { controller.cacheWaits.delete(page); }
            }
            if (!current()) return;
            if (!data) data = await deps.fetchPage(cacheKey, base, body, controller.signal);
            if (!current()) return;
            deps.validate(data, page, body.page_size, expected);
            deps.acceptPage(page, data);
            deps.scheduleReady(page);
            deps.writeCached(cacheKey, data);
          })().catch(error => {
            if (current()) deps.onFailure(error);
          }).finally(() => { controller.active.delete(page); pump(); });
          controller.active.set(page, task);
        }
      };
      pump();
      return controller.active.get(deps.readView().loadedPage + 1) || Promise.resolve();
    }
    return { prefetch };
  }
  globalThis.VoiceOfMLSearchPrefetch = { create };
})();

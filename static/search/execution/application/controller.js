// Owns backend selection, fallback and completion. Intent/cancellation and
// position navigation stay in the host before an attempt enters this module.
(function () {
  /** @param {SearchExecutionDependencies} deps */
  function create(deps) {
    /** @param {number} id @param {number} intent */
    const current = (id, intent) => {
      const view = deps.readView();
      return id === view.searchId && intent === view.intent;
    };
    /** @param {number} id */
    const currentLocal = id => id === deps.readView().searchId;
    /** @param {boolean} waiting */
    function unavailable(waiting) {
      deps.update({ isLoading: waiting });
      deps.visualLoading(waiting);
      deps.clearUnavailableResults();
      deps.renderUnavailable(waiting);
    }
    /** @param {boolean | undefined} append @param {number} id @param {number} intent @param {boolean} allowFallback */
    function apiFailure(append, id, intent, allowFallback) {
      if (!current(id, intent)) return Promise.resolve();
      if (append) {
        deps.update({ page: Math.max(1, deps.readView()._loadedPage) });
        deps.notify("加载更多失败，请重试");
        return Promise.resolve();
      }
      if (!allowFallback) { unavailable(false); return Promise.resolve(); }
      deps.notify("在线搜索失败，正在切换本地搜索...");
      unavailable(true);
      return deps.loadLocal().then(ok => {
        if (!current(id, intent)) return;
        if (!ok) { unavailable(false); return; }
        deps.setLocalMode(true);
        deps.syncURL();
        deps.retry(undefined, false);
      });
    }
    /** @param {SearchExecutionParams} params @param {boolean | undefined} append @param {number} id @param {boolean} [allowFallback] */
    async function local(params, append, id, allowFallback = true) {
      let pagingSucceeded = false;
      let pagingError = null;
      if (!currentLocal(id)) return;
      try {
        const data = await (deps.pendingLocal(params.page, append) || deps.searchLocal(params));
        if (!currentLocal(id)) return;
        if (append && !data.results.length && deps.readView().resultCount < data.total) throw new Error("EMPTY_LOCAL_PAGE");
        if (!deps.applyPage(data, append)) return;
        deps.update({ page: deps.readView()._loadedPage });
        pagingSucceeded = true;
        deps.renderPage(append);
        deps.prefetch();
        deps.syncURL();
      } catch (error) {
        const err = /** @type {Error} */ (error);
        console.error("Local Worker search failed:", err);
        if (!currentLocal(id)) return;
        if (err.name === "AbortError") return;
        pagingError = err;
        if (append) {
          deps.update({ page: Math.max(1, deps.readView()._loadedPage) });
          return;
        }
        deps.update({ dataLoaded: false });
        if (allowFallback && deps.readView().apiAvailable) {
          deps.setLocalMode(false);
          deps.syncURL();
          deps.notify("本地搜索不可用，正在切换在线搜索...");
          deps.update({ isLoading: false });
          deps.retry(undefined, false);
        } else {
          unavailable(false);
          deps.notify("本地搜索不可用");
        }
      } finally {
        if (currentLocal(id)) {
          deps.update({ isLoading: false, resultsSkeletonActive: false });
          if (!append) deps.visualLoading(false);
          else deps.updateStatus();
          if (append && (pagingSucceeded || pagingError)) deps.finishPaging(pagingSucceeded, pagingError);
          else deps.updatePaging();
        }
      }
    }
    /** @param {SearchExecutionParams} params @param {boolean | undefined} append @param {number} id @param {number} intent @param {boolean} allowFallback */
    function api(params, append, id, intent, allowFallback) {
      deps.update({ _resultBackend: "api" });
      const view = deps.readView();
      if (append && view._pendingPage === view.page) {
        deps.update({ isLoading: false });
        return;
      }
      deps.update({ _pendingPage: view.page });
      params.signal = deps.signal(true);
      const requestId = deps.readView().requestId;
      let pagingSucceeded = false;
      /** @type {Error | null} */
      let pagingError = null;
      deps.searchAPI(params, append, requestId).then(applied => {
        if (!applied || !current(id, intent)) return;
        if (deps.readView()._deferredAppendWhileDragging) return;
        deps.update({ page: deps.readView()._loadedPage });
        pagingSucceeded = true;
        deps.renderPage(append);
        deps.prefetch();
        deps.warmConnection();
        deps.syncURL();
      }).catch(err => {
        if (!current(id, intent)) return;
        pagingError = err.name === "AbortError" ? null : err;
        if (err.name === "AbortError") {
          deps.update({ isLoading: false });
          if (append) deps.update({ page: Math.max(1, deps.readView()._loadedPage) });
          if (!append) deps.visualLoading(false);
          return;
        }
        console.warn("API search failed:", err);
        return apiFailure(append, id, intent, allowFallback).then(() => {
          // A successful fallback transfers ownership. If local acquisition
          // failed, keep the original bounded first-page recovery.
          if (!append && allowFallback && current(id, intent) && !deps.readView()._loadedPage)
            deps.update({ hasMore: true });
        });
      }).finally(() => {
        if (current(id, intent)) {
          deps.update({ _pendingPage: 0, isLoading: false, resultsSkeletonActive: false });
          if (!append) deps.visualLoading(false);
          else deps.updateStatus();
          if (!deps.readView()._deferredAppendWhileDragging && (pagingSucceeded || pagingError)) deps.finishPaging(pagingSucceeded, pagingError);
          else deps.updatePaging();
        }
      });
    }
    /** @param {SearchExecutionParams} params @param {boolean | undefined} append @param {number} id @param {number} intent @param {boolean} [allowFallback] */
    function execute(params, append, id, intent, allowFallback = true) {
      const view = deps.readView();
      const backend = globalThis.VoiceOfMLSearchExecutionPolicy.backend(view, append);
      if (backend === "api") { api(params, append, id, intent, allowFallback); return; }
      if (backend === "unavailable") {
        deps.update({ isLoading: false, page: view._loadedPage });
        deps.finishPaging(false, new Error("API_UNAVAILABLE"));
        return;
      }
      if (!view.dataLoaded) {
        if (!append) unavailable(true);
        deps.loadLocal().then(ok => {
          if (!current(id, intent)) return;
          deps.update({ isLoading: false });
          if (ok) deps.retry(append, allowFallback);
          else if (!append && allowFallback && deps.readView().apiAvailable) {
            deps.setLocalMode(false);
            deps.retry(undefined, false);
          } else if (!append) unavailable(false);
          else {
            deps.update({ page: Math.max(1, deps.readView()._loadedPage) });
            deps.finishPaging(false, new Error("LOCAL_UNAVAILABLE"));
          }
        });
        return;
      }
      if (view._resultBackend !== "local") deps.clearPrefetch();
      deps.update({ _resultBackend: "local" });
      void local({ ...params, signal: deps.signal(false) }, append, id, allowFallback);
    }
    return { execute, local };
  }
  globalThis.VoiceOfMLSearchExecution = { create };
})();

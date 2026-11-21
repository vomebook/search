// Owns recovery waits and the bounded sparse-page request lifecycle. The host
// supplies transport, cache and current-window checks; it commits result pages.
(function () {
  /** @param {AbortSignal} signal @param {number} delay @param {boolean | number | undefined} local */
  function waitForRecovery(signal, delay, local) {
    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      let elapsed = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        document.removeEventListener("visibilitychange", ready);
        window.removeEventListener("online", ready);
        window.removeEventListener("pageshow", ready);
      };
      const abort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
      const ready = () => {
        if (elapsed && !document.hidden && (local || navigator.onLine)) { cleanup(); resolve(); }
      };
      const timer = setTimeout(() => { elapsed = true; ready(); }, delay);
      signal.addEventListener("abort", abort, { once: true });
      document.addEventListener("visibilitychange", ready);
      window.addEventListener("online", ready);
      window.addEventListener("pageshow", ready);
      if (signal.aborted) abort();
    }));
  }

  /** @param {VoiceOfMLWindowRecoveryDependencies} deps @param {VoiceOfMLSearchViewProjection} query
   * @param {number} page @param {AbortSignal} signal @param {string | undefined} anchorId @param {() => boolean} demanded */
  async function fetchWithRecovery(deps, query, page, signal, anchorId, demanded = () => true) {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      try { return await deps.fetchPage(query, page, signal, anchorId); }
      catch (error) {
        if (signal.aborted || attempt >= 2 || !demanded() || !deps.isRecoverable(error)) throw error;
        await deps.wait(signal, (attempt + 1) * 750, deps.isLocal(query));
      }
    }
  }

  /** @param {VoiceOfMLWindowRequestDependencies} deps @param {VoiceOfMLResultWindow} window
   * @param {number} page @param {boolean} prefetch */
  function requestPage(deps, window, page, prefetch = false) {
    if (window.prefetched?.has(page)) return Promise.resolve(window.prefetched.get(page));
    if (window.pending.has(page)) {
      const request = window.pending.get(page);
      if (!prefetch && request && !("demanded" in request && request.demanded)) {
        Object.assign(request, {demanded: true});
        if ("diskWait" in request) request.diskWait?.abort();
      }
      return request;
    }
    if (prefetch && window.prefetchFailures?.has(page)) return Promise.resolve(null);
    if (window.pending.size >= 3 || window.failures.has(page) || window.invalid) return Promise.resolve(null);
    const diskWait = new AbortController();
    const releaseDisk = () => diskWait.abort();
    window.controller.signal.addEventListener("abort", releaseDisk, { once: true });
    if (window.controller.signal.aborted) releaseDisk();
    const request = /** @type {VoiceOfMLWindowRequest} */ ((async () => {
      const cached = await deps.readRecent(window.key, page, window, prefetch ? 150 : 25, diskWait.signal);
      if (!deps.isCurrent(window)) return null;
      return cached || deps.fetchPage(window.query, page, window.controller.signal, undefined, () => request.demanded);
    })().then(data => {
      if (!data) return null;
      deps.validate(data, page, window.query.pageSize, window);
      return data;
    }).finally(() => {
      window.controller.signal.removeEventListener("abort", releaseDisk);
      window.pending.delete(page);
      if (deps.isCurrent(window)) deps.scheduleRender();
    }));
    window.pending.set(page, request);
    request.demanded = !prefetch;
    request.diskWait = diskWait;
    return request;
  }

  /** @param {VoiceOfMLResultWindow} window @param {() => boolean} current
   * @param {(page: number) => Promise<boolean>} load @param {() => void} update */
  async function retryFailed(window, current, load, update) {
    if (window.retrying) return;
    window.retrying = true;
    try {
      for (const page of [...window.failures.keys()]) {
        while (window.pending.size >= 3 && current() && !window.invalid)
          await Promise.race([...window.pending.values()].map(request => request.catch(() => null)));
        if (!current() || window.invalid) break;
        if (!window.failures.delete(page)) continue;
        await load(page);
      }
    } finally {
      window.retrying = false;
      if (current()) update();
    }
  }

  globalThis.VoiceOfMLResultWindowLoader = { waitForRecovery, fetchWithRecovery, requestPage, retryFailed };
})();

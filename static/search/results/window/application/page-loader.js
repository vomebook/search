// Owns the displayed sparse window and its page lifecycle. The host supplies
// transport, persistence and the presentation of accepted pages.
(function () {
  const MAX_PENDING = 3;

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
    const pending = window.pending.get(page);
    if (pending) {
      // A preview only reads disk; it has no transport or retry to promote.
      if (!prefetch && "demanded" in pending && !pending.demanded) {
        pending.demanded = true;
        pending.diskWait.abort();
      }
      return pending;
    }
    if (prefetch && window.prefetchFailures?.has(page)) return Promise.resolve(null);
    if (window.pending.size >= MAX_PENDING || window.failures.has(page) || window.invalid) return Promise.resolve(null);
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
        while (window.pending.size >= MAX_PENDING && current() && !window.invalid)
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

  /** @param {VoiceOfMLResultWindowHost} host */
  function create(host) {
    /** @type {VoiceOfMLManagedResultWindow | null} */
    let current = null;

    /** @param {VoiceOfMLResultWindow} owner */
    const isCurrent = owner => owner === current && current.results === host.results() &&
      owner.key === host.currentKey() && !owner.controller.signal.aborted;
    const requestHost = { readRecent: host.readRecent, fetchPage: host.fetchPage, validate: host.validate,
      scheduleRender: host.scheduleRender, isCurrent };

    // The restoration owner clears both lifetimes before aborting either one.
    function detach() {
      const previous = current;
      current = null;
      return previous?.controller;
    }

    /** @param {VoiceOfMLWindowSavedState} saved @param {string} key @param {number} total @param {VoiceOfMLWindowQuery} query */
    function open(saved, key, total, query) {
      const previous = current;
      const next = { ...saved, key, total, query, results: host.results(), pages: new Set(saved.pages),
        pending: new Map(), failures: new Map(), controller: new AbortController() };
      current = next;
      previous?.controller.abort();
      // Abort listeners may synchronously install another window. A route can
      // also be transitioning, so the key check belongs at page admission.
      return current === next && next.results === host.results();
    }

    /** @param {VoiceOfMLManagedResultWindow} owner @param {number} page */
    function canRequest(owner, page) {
      return isCurrent(owner) && !owner.invalid && !owner.pages.has(page) &&
        page >= 1 && page <= Math.ceil(owner.total / owner.query.pageSize);
    }

    /** @param {VoiceOfMLManagedResultWindow} owner @param {number} page
     * @param {unknown[]} records @param {VoiceOfMLCachedWindowPage} [preview] */
    function acceptPage(owner, page, records, preview) {
      const { pageSize } = owner.query;
      const start = (page - 1) * pageSize;
      // Preview pages can fill holes in the displayed prefix, never replace it.
      if (preview && start + records.length > owner.results.length) return;
      /** @type {number[]} */
      const indices = [];
      records.forEach((record, offset) => {
        const index = start + offset;
        if (preview && owner.results[index]) return;
        owner.results[index] = record;
        indices.push(index);
      });
      owner.pages.add(page);
      if (!preview) {
        owner.prefetched?.delete(page);
        owner.failures.delete(page);
      }
      owner.count += preview ? indices.length : records.length;
      host.accepted({ page, indices, pageSize, ...(preview ? {preview} : {}) });
    }

    /** @param {VoiceOfMLManagedResultWindow} owner @param {number} page */
    async function loadPreview(owner, page) {
      if (!canRequest(owner, page) || !owner.generation || owner.pending.has(page) ||
          owner.pending.size >= MAX_PENDING || owner.missingPages?.has(page)) return;
      const request = host.readRecent(owner.key, page, owner, 150, owner.controller.signal);
      owner.pending.set(page, request);
      try {
        const data = await request;
        if (!canRequest(owner, page) || !host.isPreview() || host.isDragging()) return;
        if (!data) { (owner.missingPages ||= new Set()).add(page); return; }
        acceptPage(owner, page, data.results, data);
      } finally {
        owner.pending.delete(page);
        if (isCurrent(owner)) host.scheduleRender();
      }
    }

    /** @param {number} page @param {boolean} [prefetch] */
    async function load(page, prefetch = false) {
      const owner = current;
      if (!owner || host.isRestoring() || !canRequest(owner, page)) return false;
      /** @type {VoiceOfMLSearchWindowPageData | null | undefined} */
      let data;
      try {
        data = await requestPage(requestHost, owner, page, prefetch);
      } catch (error) {
        if (!canRequest(owner, page)) return false;
        const changed = error != null && Reflect.get(Object(error), "message") === "RESTORE_PAGE_CHANGED";
        if (prefetch && !changed) {
          const failures = owner.prefetchFailures ||= new Set();
          failures.add(page);
          for (const oldest of failures) { if (failures.size <= 64) break; failures.delete(oldest); }
          return false;
        }
        owner.failures.set(page, error);
        if (changed) owner.invalid = true;
        host.failed(owner.key, changed);
        return false;
      }
      if (!data || !canRequest(owner, page)) return false;
      if (prefetch || host.isDragging()) {
        const prefetched = owner.prefetched ||= new Map();
        prefetched.set(page, data);
        for (const oldest of prefetched.keys()) { if (prefetched.size <= 3) break; prefetched.delete(oldest); }
        return true;
      }
      acceptPage(owner, page, data.results);
      return true;
    }

    /** @param {number} start @param {number} end @param {number} visibleStart @param {number} visibleEnd @param {number} direction */
    function demandRange(start, end, visibleStart, visibleEnd, direction) {
      const owner = current;
      if (!owner || !isCurrent(owner) || host.isDragging()) return;
      const size = owner.query.pageSize;
      const first = Math.floor(start / size) + 1, last = Math.ceil(end / size);
      if (host.isRestoring()) {
        if (host.isPreview()) for (let page = first; page <= last; page++) void loadPreview(owner, page);
        return;
      }
      const visibleFirst = Math.floor(visibleStart / size) + 1;
      const visibleLast = Math.floor(visibleEnd / size) + 1;
      const pages = new Set();
      // Demand the viewport before directional lookahead and remaining overscan.
      for (let page = visibleFirst; page <= visibleLast; page++) pages.add(page);
      for (let distance = 1; distance <= 4; distance++) pages.add(direction >= 0 ? visibleLast + distance : visibleFirst - distance);
      for (let page = first; page <= last; page++) pages.add(page);
      for (const page of pages) {
        if (!isCurrent(owner)) break;
        void load(page);
      }
    }

    /** @param {number} index */
    function prefetchAfter(index) {
      const owner = current;
      if (!owner) return;
      const page = Math.floor(index / owner.query.pageSize) + 1;
      for (let next = page + 1; next <= page + 2 && isCurrent(owner) && owner.pending.size < 2; next++) void load(next, true);
    }

    /** @param {number} start @param {number} end */
    function clearRecoverable(start, end) {
      const owner = current;
      if (!owner || !isCurrent(owner) || owner.invalid) return false;
      for (const [page, error] of owner.failures) {
        if (page >= start && page <= end && host.isRecoverable(error)) owner.failures.delete(page);
      }
      owner.prefetchFailures?.clear();
      return true;
    }

    /** @param {() => void} update */
    function retry(update) {
      const owner = current;
      if (!owner || !isCurrent(owner) || owner.invalid) return undefined;
      return retryFailed(owner, () => isCurrent(owner), page => isCurrent(owner) ? load(page) : Promise.resolve(false), update);
    }

    /** @param {number} page */
    function retryPage(page) {
      if (!current || !isCurrent(current) || current.invalid) return;
      current.failures.delete(page);
      void load(page);
    }

    return { get current() { return current; }, detach, open, load, demandRange, prefetchAfter, clearRecoverable, retry, retryPage };
  }

  globalThis.VoiceOfMLResultWindowLoader = { create, waitForRecovery, fetchWithRecovery, requestPage, retryFailed };
})();

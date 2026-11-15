// Owns recovery state and timer lifetime; the host supplies detached view data and effects.
(function () {
  /** @param {VoiceOfMLPagingDependencies} deps @returns {VoiceOfMLPagingController} */
  function create(deps) {
    const { policy, clock } = deps;
    let recovery = { failures: 0, retryAt: 0 };
    /** @type {number | null} */
    let timer = null;
    let revision = 0, timerRevision = 0, disposed = false, loading = false, reading = false;
    function readView() {
      reading = true;
      try { return deps.readView(); } finally { reading = false; }
    }
    const readRecovery = () => ({ ...recovery });
    let publishing = false;
    const updateStatus = () => {
      if (disposed || publishing) return;
      publishing = true;
      try { deps.onState(readRecovery()); } finally { publishing = false; }
    };
    function cancelTimer() {
      ++timerRevision;
      const previous = timer;
      timer = null;
      if (previous !== null) clock.clearTimeout(previous);
    }
    function reset() {
      if (disposed) return;
      ++revision;
      cancelTimer();
      recovery = { failures: 0, retryAt: 0 };
      updateStatus();
    }
    /** @param {boolean} [bottomOnly] @param {boolean} [retry] */
    function maybeLoad(bottomOnly = false, retry = false) {
      if (disposed || loading || reading) return;
      const token = revision;
      const before = readView();
      if (disposed || token !== revision || before.suspended) return;
      // Expiring a request may synchronously finish, reset, or reenter paging.
      loading = true;
      try {
        deps.expireRequests();
        if (disposed || token !== revision) return;
        const view = readView();
        const now = clock.now();
        if (disposed || token !== revision || view.generation !== before.generation) return;
        if (policy.shouldLoad(view, recovery, now, bottomOnly, retry)) {
          deps.append(view.loadedPage + 1, view.scrollTop);
        }
      } finally { loading = false; }
    }
    /** @param {number} [delay] @param {number} [readyPage] */
    function schedule(delay = 0, readyPage = 0) {
      if (disposed || reading) return;
      const operation = revision, previousTimer = timerRevision;
      const view = readView();
      if (disposed || operation !== revision || previousTimer !== timerRevision ||
          (readyPage && readyPage !== view.loadedPage + 1)) return;
      cancelTimer();
      const token = timerRevision;
      timer = clock.setTimeout(() => {
        // Cancelled callbacks must not clear a replacement timer.
        if (disposed || token !== timerRevision) return;
        timer = null;
        const current = readView();
        if (disposed || token !== timerRevision || current.generation !== view.generation || !policy.acceptsReadyPage(current, readyPage)) return;
        maybeLoad(!readyPage);
      }, Math.max(delay, recovery.retryAt - clock.now()));
    }
    /** @param {boolean} success @param {boolean} [terminal] */
    function finish(success, terminal = false) {
      if (disposed || reading) return;
      const token = ++revision;
      const generation = readView().generation;
      if (disposed || token !== revision) return;
      cancelTimer();
      recovery = policy.afterAttempt(recovery.failures, success, terminal, clock.now());
      updateStatus();
      // Presentation may synchronously reset, replace the search, or dispose.
      if (disposed || token !== revision) return;
      const current = readView();
      if (!disposed && token === revision && generation === current.generation && recovery.failures < 2) schedule();
    }
    function retryBottom() {
      if (disposed || loading || reading) return;
      const token = revision, before = readView();
      if (disposed || token !== revision || !policy.isAtBottom(before)) return;
      loading = true;
      try { deps.expireRequests(); } finally { loading = false; }
      const current = readView();
      if (disposed || token !== revision || before.generation !== current.generation) return;
      if (!current.loading && clock.now() >= recovery.retryAt && recovery.failures >= 2) {
        reset();
        const after = readView();
        if (disposed || revision !== token + 1 || before.generation !== after.generation) return;
      }
      schedule();
    }
    function retry() {
      if (disposed || loading || reading) return;
      const token = revision, before = readView();
      if (disposed || token !== revision) return;
      reset();
      const current = readView();
      if (!disposed && revision === token + 1 && before.generation === current.generation) maybeLoad(false, true);
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      ++revision;
      cancelTimer();
    }
    return { readRecovery, updateStatus, reset, schedule, finish, retryBottom, retry, maybeLoad, dispose };
  }
  globalThis.VoiceOfMLPagingController = { create };
})();

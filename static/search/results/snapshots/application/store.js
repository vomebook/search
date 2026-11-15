// Owns retained snapshots, copy identities and the cancellable neighborhood-first clone.
(function () {
  /** @param {SearchSnapshotHost} host @returns {SearchSnapshotStore} */
  function create(host) {
    const policy = VoiceOfMLSnapshotPolicy, budget = policy.createBudget();
    /** @type {Map<string, SearchResultSnapshot>} */
    const snapshots = new Map();
    /** @type {WeakMap<object, SearchSnapshotSource>} */
    const sources = new WeakMap();
    /** @type {WeakMap<unknown[], SearchResultSnapshot>} */
    const cloneSources = new WeakMap();
    /** @type {SearchSnapshotCloneTask | null} */
    let cloneTask = null;
    /** @param {Record<string, unknown>} cache */
    function copyPageCache(cache) {
      /** @type {Record<string, unknown>} */
      const copy = {};
      for (const [page, records] of Object.entries(cache || {})) copy[page] = Array.isArray(records) ? records.map(host.cloneResult) : records;
      return copy;
    }
    function trim() {
      let bytes = 0;
      for (const [key, snapshot] of Array.from(snapshots).reverse()) {
        // Reserve room for position-only updates without serializing results again.
        if (!snapshot.bytes) snapshot.bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength + 256;
        if (bytes + snapshot.bytes > policy.BYTES_MAX) snapshots.delete(key);
        else bytes += snapshot.bytes;
      }
      while (snapshots.size > policy.MAX) snapshots.delete(/** @type {string} */ (snapshots.keys().next().value));
    }
    /** @param {SearchSnapshotView} view @param {SearchSnapshotScroll | null} position @param {SearchSnapshotGeometry} geometry */
    function save(view, position, geometry) {
      const key = view.key, restoring = cloneSources.get(view.results);
      if (restoring?.key === key) {
        if (position) restoring.scroll = { ...position, viewKey: key };
        restoring.savedAt = Date.now();
        return restoring;
      }
      const existing = snapshots.get(key), source = existing && sources.get(existing);
      const signature = `${view.revision}:${geometry.revision}:${geometry.measurementKey}`;
      if (existing && source?.signature === signature) {
        if (position) existing.scroll = { ...position, viewKey: key };
        existing.savedAt = Date.now();
        snapshots.delete(key); snapshots.set(key, existing);
        return existing;
      }
      const resultsBytes = budget.measure(view.results, !!view.window);
      if (resultsBytes > policy.BYTES_MAX) { snapshots.delete(key); return null; }
      const heights = budget.captureHeights(geometry.heightCache);
      /** @type {SearchResultSnapshot} */
      const snapshot = {
        version: policy.VERSION, key, results: [], total: view.total,
        page: view.loadedPage, loadedPage: view.loadedPage, pageCache: copyPageCache(view.pageCache),
        ...(view.resultBackend === undefined ? {} : { resultBackend: view.resultBackend }),
        hasMore: view.results.length < view.total,
        window: view.window ? { generation: view.window.generation, pages: [...view.window.pages], count: view.window.count } : null,
        estimatedHeight: geometry.estimatedHeight, heightCache: [], heightRecords: [],
        scroll: position ? { ...position, viewKey: key } : { index: 0, offset: 0, viewKey: key }, savedAt: Date.now()
      };
      snapshot.bytes = resultsBytes + heights.bytes + new TextEncoder().encode(JSON.stringify(snapshot)).byteLength + 256;
      snapshots.delete(key);
      if (snapshot.bytes > policy.BYTES_MAX) return null;
      snapshot.results = existing && source?.revision === view.revision ? existing.results : view.results.map(host.cloneResult);
      snapshot.heightCache = heights.entries;
      snapshots.set(key, snapshot);
      sources.set(snapshot, { signature, revision: view.revision, resultsBytes });
      trim();
      return snapshot;
    }
    function cancelClone() {
      const task = cloneTask;
      cloneTask = null;
      if (!task) return;
      clearTimeout(task.timer);
      if (task.frame) cancelAnimationFrame(task.frame);
      // Keep the weak source association: saving a cancelled partial copy must
      // still return the complete source, never publish the partial array.
    }
    /** @param {SearchSnapshotCloneTask} task @param {number} start @param {number} end @param {boolean} [deferHeights] */
    function materializeRange(task, start, end, deferHeights = false) {
      for (let index = Math.max(0, start); index < Math.min(end, task.results.length); index++) {
        if (index in task.results || !(index in task.snapshot.results)) continue;
        task.results[index] = host.cloneResult(task.snapshot.results[index]);
        host.materialized(task, index);
      }
      if (!deferHeights) host.applyHeights(task);
    }
    /** @param {SearchResultSnapshot} snapshot @param {string} key @param {number} size @param {boolean} restoreScroll */
    function prepareClone(snapshot, key, size, restoreScroll) {
      const task = /** @type {SearchSnapshotCloneTask} */ ({ snapshot, key, results: new Array(snapshot.results.length), cursor: 0,
        keys: snapshot.window ? Object.keys(snapshot.results) : null, timer: undefined, frame: 0 });
      cloneTask = task;
      cloneSources.set(task.results, snapshot);
      const index = restoreScroll ? snapshot.scroll?.index || 0 : 0;
      materializeRange(task, 0, size);
      materializeRange(task, Math.max(0, Math.floor(index / size) - 2) * size, (Math.floor(index / size) + 3) * size);
      return task.results;
    }
    /** @param {SearchResultSnapshot} snapshot @param {unknown[]} results */
    function rememberBudget(snapshot, results) {
      const source = sources.get(snapshot);
      if (source) budget.remember(results, source.resultsBytes);
    }
    /** @param {SearchResultSnapshot} snapshot @param {string} key @param {number} pageSize @param {boolean} restoreScroll @param {boolean} preserveRestore */
    function restoreResults(snapshot, key, pageSize, restoreScroll, preserveRestore) {
      const materialized = snapshot.window?.count ?? snapshot.results.length;
      if (materialized > 2000 && !preserveRestore) return prepareClone(snapshot, key, pageSize, restoreScroll);
      const results = snapshot.results.map(host.cloneResult);
      if (!cloneTask) rememberBudget(snapshot, results);
      return results;
    }
    function startClone() {
      const task = cloneTask;
      if (!task) return;
      const step = () => {
        task.timer = undefined;
        if (cloneTask !== task || !host.isCurrent(task)) {
          if (cloneTask === task) cancelClone();
          return;
        }
        const count = task.keys ? task.keys.length : task.results.length, started = performance.now();
        for (let batch = 0; task.cursor < count && batch < 256 && performance.now() - started < 4; batch++) {
          const index = task.keys ? Number(task.keys[task.cursor++]) : task.cursor++;
          materializeRange(task, index, index + 1, true);
        }
        host.applyHeights(task);
        if (task.cursor < count) { task.timer = setTimeout(step, 0); return; }
        cloneTask = null;
        cloneSources.delete(task.results);
        rememberBudget(task.snapshot, task.results);
        host.completed();
      };
      task.frame = requestAnimationFrame(() => { task.frame = 0; task.timer = setTimeout(step, 0); });
    }
    return { snapshots, budget, get cloneTask() { return cloneTask; }, source: snapshot => sources.get(snapshot),
      put: (key, snapshot) => { snapshots.set(key, snapshot); }, remove: key => { snapshots.delete(key); },
      save, trim, copyPageCache, cancelClone, materializeRange, restoreResults, startClone };
  }
  globalThis.VoiceOfMLResultSnapshots = { create };
})();

// Coordinates asynchronous restoration. The host retains synchronous search
// cancellation/publication because abort listeners can reenter navigation.
(function () {
  /** @param {SearchPositionRestoreInput} input */
  function createTask({ key, position, previous, backend }) {
    const pinned = backend ?? previous?.backend;
    const reusable = previous?.backend === pinned && previous?.key === key &&
      previous?.position.anchorId === position.anchorId ? previous : null;
    return /** @type {SearchPositionRestoreTask} */ ({ key, controller: new AbortController(),
      position: { ...position }, backend: pinned,
      lookup: reusable?.lookup, ready: reusable?.ready || new Map() });
  }

  /** @param {SearchPositionRestorationHost} host */
  function create(host) {
    /** @param {SearchPositionRestoreTask} task @param {SearchPositionViewport | null | undefined} viewport */
    async function run(task, viewport) {
      const { key, controller } = task;
      let position = task.position;
      const current = () => host.isCurrent(task) && !controller.signal.aborted;
      try {
        const query = JSON.parse(key);
        if (viewport === undefined) viewport = await host.readViewport(key);
        if (!current()) return;
        host.showPreview(viewport, position, task);
        while (current()) {
          if (!task.lookup) {
            const {data, backend} = await host.lookupPage(query, controller.signal, position.anchorId, task.backend);
            if (!current()) return;
            host.validatePage(data, 1, query.pageSize);
            task.backend = backend;
            task.lookup = data;
          }
          const lookup = task.lookup;
          const pinnedQuery = {...query, resultBackend: task.backend};
          task.ready.set(1, lookup);
          const total = lookup.total;
          const index = typeof lookup.anchor_index === "number" && Number.isInteger(lookup.anchor_index) && lookup.anchor_index >= 0 && lookup.anchor_index < total
            ? lookup.anchor_index : Math.min(position.index, Math.max(0, total - 1));
          const targetPage = Math.floor(index / query.pageSize) + 1;
          const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
          const pages = Array.from({length: Math.min(lastPage, targetPage + 1) - Math.max(1, targetPage - 1) + 1}, (_, i) => Math.max(1, targetPage - 1) + i);
          const responses = await Promise.all(pages.map(async page => {
            try { return {page, data: task.ready.get(page) || await host.fetchPage(pinnedQuery, page, controller.signal)}; }
            catch (error) { return {page, error}; }
          }));
          if (!current()) return;
          for (const {page, data, error} of responses) if (!error) {
            host.validatePage(data, page, query.pageSize, lookup);
            task.ready.set(page, /** @type {SearchPositionRestorePage} */ (data));
          }
          const failure = responses.find(response => response.error);
          if (failure) throw failure.error;
          while (task.preview && host.isDragging() && current()) await new Promise(resolve => setTimeout(resolve, 30));
          if (!current()) return;
          // Preview pages are authoritative only on the same backend and generation.
          for (const [page, data] of task.cachedPages || []) {
            if (!task.ready.has(page) && data.resultBackend === task.backend && data.generation === lookup.generation && data.total === total) task.ready.set(page, data);
          }
          const latest = task.preview ? host.capturePreviewAnchor() : null;
          // Preserve geometry when the reader moved into a hole; a missing ID
          // at the untouched saved location still uses the nearby fallback.
          const geometry = latest && !latest.anchorId &&
            (latest.index !== task.position.index || latest.offset !== task.position.offset) ? latest : null;
          if (latest) {
            const { anchorId } = latest;
            if (anchorId && anchorId !== position.anchorId) {
              position = task.position = {...position, index: latest.index, offset: latest.offset, anchorId};
              const available = [...task.ready.values()].some(data => data.results.some(item => host.stableId(item) === anchorId));
              if (!available) { task.lookup = null; task.ready.clear(); continue; }
            } else if (anchorId) position = task.position = {...position, offset: latest.offset};
          }
          // Empty slots reserve scroll geometry only; visible slots are fetched on demand.
          let lastReady = 1;
          for (const ready of task.ready.keys()) lastReady = Math.max(lastReady, ready);
          const page = Math.min(lastPage, Math.max(position.loadedPage, targetPage + 1, lastReady));
          const results = new Array(Math.min(total, page * query.pageSize));
          let found = -1;
          for (const [number, data] of task.ready) data.results.forEach((record, offset) => {
            const index = (number - 1) * query.pageSize + offset;
            results[index] = record;
            if (host.stableId(record) === position.anchorId) found = index;
          });
          const snapshot = { version: globalThis.VoiceOfMLSnapshotPolicy.VERSION, key, results, total,
            loadedPage: page, pageCache: {}, hasMore: results.length < total,
            resultBackend: task.backend,
            window: { generation: lookup.generation, pages: [...task.ready.keys()], count: [...task.ready.values()].reduce((sum, data) => sum + data.results.length, 0) },
            estimatedHeight: host.estimatedHeight(), heightCache: [], heightRecords: [],
            scroll: { index: geometry ? Math.min(geometry.index, Math.max(0, total - 1)) : found < 0 ? index : found,
              offset: total ? geometry?.offset ?? position.offset : 0, viewKey: key }, savedAt: Date.now() };
          host.release();
          if (task.preview && (geometry || found === position.index)) host.applyPreview(snapshot);
          else {
            host.snapshots.putRestored(key, snapshot);
            host.restoreSnapshot(key);
          }
          host.completed();
          host.snapshots.trim();
          if (!geometry && found < 0 && position.anchorId) host.notify("搜索结果已变化，已恢复到原位置附近");
          return;
        }
      } catch (error) {
        if (!current()) return;
        const err = /** @type {Error} */ (error);
        task.failed = true;
        task.error = err;
        if (err.message === "RESTORE_PAGE_CHANGED") { task.lookup = null; task.ready.clear(); }
        host.failed(err.message === "RESTORE_PAGE_CHANGED"
          ? "搜索数据已更新，请重试恢复" : "暂时无法加载原位置附近的结果");
      }
    }
    return { run };
  }
  globalThis.VoiceOfMLPositionRestoration = { createTask, create };
})();

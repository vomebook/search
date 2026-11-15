// Owns retained positions/content and save scheduling. Geometry is a bounded input.
(function () {
  /** @param {Parameters<typeof VoiceOfMLSearchPositions.create>[0]} deps
   * @returns {SearchPositionPersistence} */
  function create(deps) {
    const policy = VoiceOfMLPositionPolicy, storage = deps.storage;
    /** @type {Map<string, SearchPosition>} */
    const positions = new Map();
    /** @type {Map<string, SearchPositionViewport>} */
    const viewports = new Map();
    /** @type {Map<string, SearchRecentPage>} */
    const recentPages = new Map();
    /** @type {WeakMap<SearchRecentPage, {first: unknown; last: unknown}>} */
    const pageSources = new WeakMap();
    /** @type {WeakMap<SearchPositionViewport, Map<number, {record: unknown; height: number}>>} */
    const viewportSources = new WeakMap();
    let lastPruneAt = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let saveTimer;
    function cancelSave() { clearTimeout(saveTimer); saveTimer = undefined; }
    /** @param {() => void} save */
    function scheduleSave(save) { cancelSave(); saveTimer = setTimeout(save, 250); }
    function init() {
      return storage.init(values => {
        for (const value of values) if (!positions.has(value.key)) positions.set(value.key, value);
      });
    }
    /** @param {SearchRecentPage} entry */
    function cachePage(entry) {
      const id = JSON.stringify(entry.id);
      recentPages.delete(id); recentPages.set(id, entry);
      while (recentPages.size > policy.RECENT_PAGE_MAX) recentPages.delete(/** @type {string} */ (recentPages.keys().next().value));
    }
    /** @param {SearchPosition} position @param {SearchPositionView} view @param {number} visibleEnd */
    function saveRecentPages(position, view, visibleEnd) {
      const size = JSON.parse(view.key).pageSize;
      const writes = [];
      for (let page = Math.floor(position.index / size) + 1; page <= Math.floor(visibleEnd / size) + 1; page++) {
        const start = (page - 1) * size, length = Math.min(size, view.total - start);
        const metadata = view.window || deps.metadata(view.results[start]);
        if (!metadata?.generation || metadata.total !== view.total || (view.window && !view.window.pages.has(page))) continue;
        /** @type {[string, number]} */
        const id = [view.key, page];
        const previous = recentPages.get(JSON.stringify(id)), source = previous && pageSources.get(previous);
        if (previous && source?.first === view.results[start] && source?.last === view.results[start + length - 1]
            && previous.generation === metadata.generation && Date.now() - previous.savedAt < 60000) {
          cachePage(previous); continue;
        }
        const results = view.results.slice(start, start + length);
        if (results.length !== length || Object.keys(results).length !== length || results.some(record => !record)) continue;
        const entry = {id, key: view.key, page, page_size: size, total: view.total, generation: metadata.generation,
          results: results.map(deps.cloneResult), savedAt: Date.now()};
        if (new TextEncoder().encode(JSON.stringify(entry)).byteLength > policy.RECENT_PAGE_BYTES_MAX) continue;
        cachePage(entry);
        pageSources.set(entry, {first: results[0], last: results[length - 1]});
        writes.push(entry);
      }
      storage.writeContent("recent-pages", writes, policy.RECENT_PAGE_MAX, policy.RECENT_PAGE_TTL);
    }
    /** @param {string} key @param {number} page
     * @param {VoiceOfMLSearchWindowExpected & {query: {pageSize: number}}} expected
     * @param {number} [timeoutMs] @param {AbortSignal | null} [signal] */
    async function readRecentPage(key, page, expected, timeoutMs = 150, signal = null) {
      const id = [key, page];
      const entry = recentPages.get(JSON.stringify(id)) || await storage.read("recent-pages", id, timeoutMs, signal);
      if (signal?.aborted || !policy.validRecentPage(entry, key, page, expected)) return null;
      cachePage(entry);
      return entry;
    }
    /** @param {string} key */
    async function readViewport(key) {
      return viewports.get(key) || /** @type {SearchPositionViewport | null} */ (await storage.read("viewports", key));
    }
    /** @param {SearchPosition} position @param {SearchPositionView} view @param {SearchPositionGeometry} geometry */
    function saveViewport(position, view, geometry) {
      const {visibleEnd, pageSize, measurementKey, estimatedHeight, heightAt} = geometry;
      saveRecentPages(position, view, visibleEnd);
      const previous = viewports.get(view.key), source = previous && viewportSources.get(previous);
      const pageStart = Math.floor(position.index / pageSize) * pageSize;
      const generation = view.window?.generation || deps.metadata(view.results[pageStart])?.generation;
      if (previous && source && previous.total === view.total && previous.generation === generation
          && previous.measurementKey === measurementKey && Date.now() - previous.savedAt < 24 * 60 * 60 * 1000) {
        let covered = true;
        for (let index = position.index; index <= visibleEnd; index++) {
          const saved = source.get(index);
          if (!saved || saved.record !== view.results[index] || saved.height !== heightAt(index)) { covered = false; break; }
        }
        if (covered) return;
      }
      const start = Math.max(0, position.index - 24), end = Math.min(view.results.length, position.index + 56);
      /** @type {[number, unknown, number][]} */
      const records = [];
      for (let index = start; index < end; index++) {
        if (view.results[index]) records.push([index, deps.cloneResult(view.results[index]), heightAt(index)]);
      }
      /** @type {SearchPositionViewport} */
      const viewport = {key: position.key, savedAt: position.savedAt, anchorId: position.anchorId, index: position.index,
        total: view.total, generation, estimatedHeight, measurementKey, records: []};
      // Spend the byte budget on visible records before nearest neighbors.
      /** @param {number} index */
      const distance = index => Math.max(position.index - index, index - visibleEnd, 0);
      records.sort((a, b) => distance(a[0]) - distance(b[0]) || a[0] - b[0]);
      const encoder = new TextEncoder();
      let bytes = encoder.encode(JSON.stringify(viewport)).byteLength;
      for (const record of records) {
        const cost = encoder.encode(JSON.stringify(record)).byteLength + 1;
        if (bytes + cost > policy.VIEWPORT_BYTES_MAX) continue;
        viewport.records.push(record); bytes += cost;
      }
      viewport.records.sort((a, b) => a[0] - b[0]);
      if (!viewport.records.some(([index]) => index === position.index)) return;
      viewports.delete(viewport.key); viewports.set(viewport.key, viewport);
      viewportSources.set(viewport, new Map(viewport.records.map(([index, , height]) => [index, {record: view.results[index], height}])));
      while (viewports.size > policy.VIEWPORT_MAX) viewports.delete(/** @type {string} */ (viewports.keys().next().value));
      storage.writeContent("viewports", [viewport], policy.VIEWPORT_MAX, policy.POSITION_TTL);
    }
    /** @param {SearchPosition} position @param {() => void} capture */
    function save(position, capture) {
      const previous = positions.get(position.key);
      if (previous && position.savedAt - previous.savedAt < 1000 && previous.index === position.index
          && previous.offset === position.offset && previous.anchorId === position.anchorId
          && previous.loadedPage === position.loadedPage) return previous;
      positions.set(position.key, position);
      capture();
      const prune = Date.now() - lastPruneAt >= 60000 || positions.size > policy.POSITION_MAX;
      if (prune) {
        const ordered = Array.from(positions.values()).sort((a, b) => b.savedAt - a.savedAt);
        ordered.forEach((item, i) => { if (!policy.validPosition(item) || i >= policy.POSITION_MAX) positions.delete(item.key); });
        lastPruneAt = Date.now();
      }
      storage.writePosition(position, prune);
      return position;
    }
    return {positions, viewports, recentPages, init, getPosition: key => positions.get(key), save,
      saveViewport, saveRecentPages, readViewport, readRecentPage, scheduleSave, cancelSave};
  }
  Object.assign(globalThis, {VoiceOfMLSearchPositions: {create}});
})();

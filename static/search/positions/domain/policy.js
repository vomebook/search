// Persistence budgets and validation of untrusted IndexedDB values.
(function () {
  const POSITION_MAX = 500, POSITION_TTL = 90 * 24 * 60 * 60 * 1000;
  const VIEWPORT_MAX = 64, VIEWPORT_BYTES_MAX = 64 * 1024;
  const RECENT_PAGE_MAX = 32, RECENT_PAGE_BYTES_MAX = 256 * 1024;
  const RECENT_PAGE_TTL = 7 * 24 * 60 * 60 * 1000;

  /** @param {unknown} value @returns {value is SearchPosition} */
  function validPosition(value) {
    if (!value || typeof value !== "object") return false;
    const item = /** @type {SearchPosition} */ (value);
    return item.version === 1 && typeof item.key === "string"
      && Number.isInteger(item.index) && item.index >= 0
      && Number.isFinite(item.offset) && item.offset >= 0
      && Number.isInteger(item.loadedPage) && item.loadedPage >= 1
      && typeof item.anchorId === "string" && item.savedAt > Date.now() - POSITION_TTL;
  }

  /** @param {unknown} value */
  function validRenderingRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = /** @type {Record<string, unknown>} */ (value);
    return typeof record.File === "string"
      && (record.Repo == null || typeof record.Repo === "string")
      && (record.Extension == null || typeof record.Extension === "string")
      && (record.Folder == null || (Array.isArray(record.Folder) && Array.from(record.Folder).every(folder => typeof folder === "string")))
      && (record.Size == null || typeof record.Size === "string" || (typeof record.Size === "number" && Number.isFinite(record.Size) && record.Size >= 0));
  }

  /** @param {unknown} value @param {SearchPosition | null | undefined} position
   * @param {(record: unknown) => string} stableId @returns {value is SearchPositionViewport} */
  function validViewport(value, position, stableId) {
    if (!position || !value || typeof value !== "object") return false;
    const viewport = /** @type {SearchPositionViewport} */ (value);
    /** @param {number} height */
    const validHeight = height => Number.isFinite(height) && height > 0 && height <= 1000000;
    if (viewport.key !== position.key || !Number.isFinite(viewport.savedAt) || viewport.savedAt < Date.now() - POSITION_TTL
        || !Number.isInteger(viewport.total) || viewport.total <= position.index || viewport.total > 0x7ffffffe
        || !Number.isInteger(position.index) || position.index < 0
        || (viewport.resultBackend != null && viewport.resultBackend !== "local" && viewport.resultBackend !== "api")
        || !Array.isArray(viewport.records) || !viewport.records.length || viewport.records.length > 80
        || (viewport.estimatedHeight != null && viewport.estimatedHeight !== 0 && !validHeight(viewport.estimatedHeight))) return false;
    const indexes = new Set();
    let anchor = false;
    for (const tuple of viewport.records) {
      if (!Array.isArray(tuple) || tuple.length !== 3) return false;
      const [index, record, height] = tuple;
      if (!Number.isInteger(index) || index < 0 || index >= viewport.total || indexes.has(index)
          || !validRenderingRecord(record) || !validHeight(height)) return false;
      indexes.add(index);
      if (index === position.index && stableId(record) === position.anchorId) anchor = true;
    }
    return anchor;
  }

  /** @param {unknown} value @param {string} key @param {number} page
   * @param {SearchRecentPageExpected} expected
   * @returns {value is SearchRecentPage} */
  function validRecentPage(value, key, page, expected) {
    if (!value || typeof value !== "object") return false;
    const entry = /** @type {SearchRecentPage} */ (value);
    if (entry.key !== key || !Number.isFinite(entry.savedAt) || entry.savedAt < Date.now() - RECENT_PAGE_TTL
        || !expected.generation || (entry.resultBackend ?? null) !== (expected.query.resultBackend ?? null) || !Array.isArray(entry.results)
        || !Array.isArray(entry.id) || entry.id.length !== 2 || entry.id[0] !== key || entry.id[1] !== page
        || Object.keys(entry.results).length !== entry.results.length
        || !entry.results.every(validRenderingRecord)) return false;
    try { VoiceOfMLSearchWindowPage.validate(entry, page, expected.query.pageSize, expected); }
    catch (_) { return false; }
    return true;
  }
  Object.assign(globalThis, {VoiceOfMLPositionPolicy: {POSITION_MAX, POSITION_TTL, VIEWPORT_MAX,
    VIEWPORT_BYTES_MAX, RECENT_PAGE_MAX, RECENT_PAGE_BYTES_MAX, RECENT_PAGE_TTL,
    validPosition, validViewport, validRecentPage}});
})();

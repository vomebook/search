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

  /** @param {unknown} value @param {SearchPosition | null | undefined} position
   * @param {(record: unknown) => string} stableId @returns {value is SearchPositionViewport} */
  function validViewport(value, position, stableId) {
    if (!position || !value || typeof value !== "object") return false;
    const viewport = /** @type {SearchPositionViewport} */ (value);
    return viewport.key === position.key && viewport.savedAt >= Date.now() - POSITION_TTL
      && Number.isInteger(viewport.total) && viewport.total > position.index
      && Array.isArray(viewport.records) && viewport.records.length <= 80
      && viewport.records.every(row => Array.isArray(row) && row.length === 3
        && Number.isInteger(row[0]) && row[0] >= 0 && row[1] !== null && typeof row[1] === "object"
        && Number.isFinite(row[2]) && row[2] > 0)
      && viewport.records.some(([index, record]) => index === position.index && stableId(record) === position.anchorId);
  }

  /** @param {unknown} value @param {string} key @param {number} page
   * @param {VoiceOfMLSearchWindowExpected & {query: {pageSize: number}}} expected
   * @returns {value is SearchRecentPage} */
  function validRecentPage(value, key, page, expected) {
    if (!value || typeof value !== "object") return false;
    const entry = /** @type {SearchRecentPage} */ (value);
    if (entry.key !== key || !Number.isFinite(entry.savedAt) || entry.savedAt < Date.now() - RECENT_PAGE_TTL
        || !expected.generation || !Array.isArray(entry.results)
        || Object.keys(entry.results).length !== entry.results.length) return false;
    try { VoiceOfMLSearchWindowPage.validate(entry, page, expected.query.pageSize, expected); }
    catch (_) { return false; }
    return true;
  }
  Object.assign(globalThis, {VoiceOfMLPositionPolicy: {POSITION_MAX, POSITION_TTL, VIEWPORT_MAX,
    VIEWPORT_BYTES_MAX, RECENT_PAGE_MAX, RECENT_PAGE_BYTES_MAX, RECENT_PAGE_TTL,
    validPosition, validViewport, validRecentPage}});
})();

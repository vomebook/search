// Validation of a page against the search window's pinned generation.
// Fetching, cancellation and committing results belong to the host.
(function () {
  /**
   * @typedef {{results: unknown[], page: number, page_size: number, total: number, generation?: string | undefined}} Page
   * @typedef {{total: number, generation?: string | undefined}} Expected
   */

  /** @param {Page} data @param {number} page @param {number} pageSize */
  function invalidContents(data, page, pageSize) {
    return data.page !== page || data.page_size !== pageSize ||
      !Number.isInteger(data.total) || data.total < 0 ||
      data.results.length !== Math.min(pageSize, Math.max(0, data.total - (page - 1) * pageSize)) ||
      data.results.some(record => !record || typeof record !== "object");
  }

  /**
   * @param {Page | null | undefined} data
   * @param {number} page
   * @param {number} pageSize
   * @param {Expected | null | undefined} [expected]
   * @returns {void}
   */
  function validate(data, page, pageSize, expected) {
    if (!data || !Array.isArray(data.results) || invalidContents(data, page, pageSize) ||
        (expected && (data.total !== expected.total || data.generation !== expected.generation)))
      throw new Error("RESTORE_PAGE_CHANGED");
  }

  /** @type {typeof globalThis & {VoiceOfMLSearchWindowPage: typeof VoiceOfMLSearchWindowPage}} */
  const globals = globalThis;
  globals.VoiceOfMLSearchWindowPage = {validate};
})();

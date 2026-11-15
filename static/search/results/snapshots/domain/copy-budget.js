// Snapshot copy policy and incremental UTF-8 accounting; no rendering or navigation.
(function () {
  const VERSION = 1, MAX = 20, BYTES_MAX = 8 * 1024 * 1024;
  /** @param {unknown} result @returns {unknown} */
  function cloneResult(result) {
    if (!result || typeof result !== "object") return result;
    const record = /** @type {{Folder?: unknown}} */ (result);
    return { ...record, ...(Array.isArray(record.Folder) ? { Folder: record.Folder.slice() } : {}) };
  }
  /** @returns {SearchSnapshotBudget} */
  function createBudget() {
    /** @type {WeakMap<unknown[], {length: number; bytes: number}>} */
    const results = new WeakMap();
    /** @type {WeakMap<SearchSnapshotHeight, {id: string; entry: SearchSnapshotHeightEntry; bytes: number}>} */
    const heights = new WeakMap();
    /** @param {unknown[]} records @param {boolean} [sparse] */
    function measure(records, sparse = false) {
      const cached = results.get(records);
      if (cached?.length === records.length) return cached.bytes;
      const encoder = new TextEncoder();
      let bytes = 2;
      if (sparse) {
        const keys = Object.keys(records);
        bytes += Math.max(0, records.length - 1) + (records.length - keys.length) * 4;
        for (const key of keys) {
          if (bytes > BYTES_MAX) break;
          bytes += encoder.encode(JSON.stringify(records[Number(key)]) ?? "null").byteLength;
        }
      } else {
        for (let start = 0; start < records.length && bytes <= BYTES_MAX; start += 100) {
          bytes += encoder.encode(JSON.stringify(records.slice(start, start + 100))).byteLength - 2 + (start ? 1 : 0);
        }
      }
      // An over-budget lower bound suffices until replacement or sparse-page mutation.
      results.set(records, { length: records.length, bytes });
      return bytes;
    }
    /** @param {unknown[]} records @param {unknown[]} page */
    function extend(records, page) {
      const budget = results.get(records);
      if (!budget) return;
      if (budget.length !== records.length - page.length) { results.delete(records); return; }
      if (page.length && budget.bytes <= BYTES_MAX) {
        budget.bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength - 2 + (budget.length ? 1 : 0);
      }
      budget.length = records.length;
    }
    /** @param {ReadonlyMap<string, SearchSnapshotHeight>} cache */
    function captureHeights(cache) {
      /** @type {SearchSnapshotHeightEntry[]} */
      const entries = [];
      let bytes = 2;
      const encoder = new TextEncoder();
      for (const [id, value] of cache) {
        let cached = heights.get(value);
        if (!cached || cached.id !== id) {
          const entry = Object.freeze(/** @type {[string, SearchSnapshotHeight]} */ ([id, Object.freeze({ ...value })]));
          cached = { id, entry, bytes: encoder.encode(JSON.stringify(entry)).byteLength };
          heights.set(value, cached);
        }
        bytes += cached.bytes + (entries.length ? 1 : 0);
        if (bytes > BYTES_MAX) return { entries: [], bytes };
        entries.push(cached.entry);
      }
      return { entries, bytes };
    }
    return { measure, extend, captureHeights, has: records => results.has(records),
      invalidate: records => { results.delete(records); },
      remember: (records, bytes) => { results.set(records, { length: records.length, bytes }); } };
  }
  globalThis.VoiceOfMLSnapshotPolicy = { VERSION, MAX, BYTES_MAX, cloneResult, createBudget };
})();

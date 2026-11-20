// Snapshot copy policy and incremental UTF-8 accounting; no rendering or navigation.
(function () {
  const VERSION = 1, MAX = 20, BYTES_MAX = 8 * 1024 * 1024;
  /** @param {unknown} result @returns {unknown} */
  function cloneResult(result) {
    if (!result || typeof result !== "object") return result;
    const record = /** @type {{Folder?: unknown}} */ (result);
    return { ...record, ...(Array.isArray(record.Folder) ? { Folder: record.Folder.slice() } : {}) };
  }
  /** @param {string} key @param {number} length */
  function isIndex(key, length) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
  }
  /** @param {number} length @param {number} filled */
  function sparseOverhead(length, filled) {
    return 2 + Math.max(0, length - 1) + (length - filled) * 4; // brackets, commas, and null holes
  }
  /** @param {unknown} value @param {number} [depth] @returns {boolean} */
  function plainData(value, depth = 0) {
    if (value === null || value === undefined) return true;
    if (typeof value !== "object") return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    const array = Array.isArray(value);
    // Delegate custom serialization, accessors, cycles and deeply nested values to native JSON.
    if (depth === 32 || Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) || "toJSON" in value) return false;
    for (const key of array ? Object.getOwnPropertyNames(value) : Object.keys(value)) {
      if (array && !isIndex(key, value.length)) continue;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !Object.hasOwn(property, "value") || !plainData(property.value, depth + 1)) return false;
    }
    return true;
  }
  /** @param {SearchResultSnapshot} snapshot @returns {number | undefined} */
  function measureRestoreSnapshot(snapshot) {
    // Only the coordinator's own snapshot can opt in. Records come from JSON
    // or structured clone, but page validation alone doesn't narrow legacy fields.
    // Keep native whole-snapshot JSON for anything outside plain data.
    if (Object.getPrototypeOf(snapshot) !== Object.prototype || "toJSON" in snapshot ||
        Object.getPrototypeOf(Array.prototype) !== Object.prototype ||
        [Array.prototype, Object.prototype].some(proto => Object.getOwnPropertyNames(proto).some(key => isIndex(key, 0xffffffff)))) return;
    /** @type {Record<string, unknown>} */
    const envelope = Object.create(null);
    /** @type {unknown} */
    let results;
    for (const key of Object.keys(snapshot)) {
      const property = Object.getOwnPropertyDescriptor(snapshot, key);
      if (!property || !Object.hasOwn(property, "value")) return;
      if (key === "results") {
        results = property.value;
        envelope.results = [];
      } else {
        if (!plainData(property.value)) return;
        envelope[key] = property.value;
      }
    }
    if (!Array.isArray(results) || Object.getPrototypeOf(results) !== Array.prototype || "toJSON" in results) return;
    const encoder = new TextEncoder();
    let slots = 0, bytes = 0;
    /** @type {unknown[]} */
    const batch = [];
    function flush() {
      bytes += encoder.encode(JSON.stringify(batch)).byteLength - 2 - Math.max(0, batch.length - 1);
      batch.length = 0;
    }
    for (const key of Object.getOwnPropertyNames(results)) {
      if (!isIndex(key, results.length)) continue;
      const property = Object.getOwnPropertyDescriptor(results, key);
      if (!property || !Object.hasOwn(property, "value") || !plainData(property.value)) return;
      slots++;
      batch.push(property.value);
      if (batch.length === 100) flush();
    }
    // Only populated slots were serialized, in bounded batches. The envelope
    // already includes its empty results brackets. Don't seed the live cache.
    flush();
    return bytes + sparseOverhead(results.length, slots) + encoder.encode(JSON.stringify(envelope)).byteLength - 2;
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
        bytes = sparseOverhead(records.length, keys.length);
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
  globalThis.VoiceOfMLSnapshotPolicy = { VERSION, MAX, BYTES_MAX, cloneResult, createBudget, measureRestoreSnapshot };
})();

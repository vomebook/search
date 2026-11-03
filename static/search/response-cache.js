// Shared search-response cache. Keep byte accounting, expiry and replacement
// behavior identical to the original per-site implementation.
{
  /** @template T @extends {Map<string, T>} */
  class SearchBoundedResponseCache extends Map {
    /** @param {number} limit @param {number} ttl @param {number} [budget] */
    constructor(limit, ttl, budget = 8 * 1024 * 1024) {
      super();
      this.limit = limit; this.ttl = ttl; this.budget = budget;
      this.bytes = 0; this.entriesInfo = /** @type {Map<string, {bytes: number, time: number}>} */ (new Map());
    }
    /** @param {string} key */
    delete(key) {
      this.bytes -= this.entriesInfo.get(key)?.bytes || 0;
      this.entriesInfo.delete(key);
      return super.delete(key);
    }
    clear() { super.clear(); this.entriesInfo.clear(); this.bytes = 0; }
    /** @param {string} key */
    get(key) {
      const info = this.entriesInfo.get(key);
      if (!info) return undefined;
      if (Date.now() - info.time >= this.ttl) { this.delete(key); return undefined; }
      const value = /** @type {T} */ (super.get(key));
      super.delete(key); super.set(key, value);
      return value;
    }
    /** @param {string} key */
    has(key) { return this.get(key) !== undefined; }
    /** @param {string} key @param {T} value */
    set(key, value) {
      this.delete(key);
      const now = Date.now();
      for (const [oldKey, info] of this.entriesInfo) if (now - info.time >= this.ttl) this.delete(oldKey);
      // UTF-16 serialized content budget, not an engine-specific heap estimate.
      const bytes = 2 * (JSON.stringify(value).length + String(key).length);
      if (bytes > Math.min(this.budget, 1024 * 1024)) return this;
      while (this.size && (this.size >= this.limit || this.bytes + bytes > this.budget)) this.delete(/** @type {string} */ (this.keys().next().value));
      super.set(key, value);
      this.entriesInfo.set(key, {bytes, time: now}); this.bytes += bytes;
      return this;
    }
  }
  const globals = /** @type {typeof globalThis & {BoundedResponseCache: typeof BoundedResponseCache}} */ (/** @type {unknown} */ (globalThis));
  globals.BoundedResponseCache = SearchBoundedResponseCache;
}

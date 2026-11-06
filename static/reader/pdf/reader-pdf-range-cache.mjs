/** @typedef {{etag: string, total: number}} PdfRangeVersion
 * @typedef {{url: string, begin: number, end: number, etag: string, total: number,
 *   bytes: Uint8Array, at: number}} PdfRangeCacheEntry
 */
// A search-tab-owned, bounded memory cache. Every opening still fetches its
// fresh range to establish a strong ETag/total before any reuse. No disk,
// Service Worker body cache or change to the PDF HTTP no-store policy is involved.
/** @param {{maxBytes?: number, maxEntries?: number, maxAgeMs?: number, now?: () => number}} [options] */
export function createPdfRangeCache({maxBytes = 8 * 1024 * 1024, maxEntries = 64,
  maxAgeMs = 600000, now = () => Date.now()} = {}) {
  /** @type {Map<string, PdfRangeCacheEntry>} */
  const entries = new Map();
  let bytes = 0, nextExpiry = Infinity;
  /** @param {string} key */
  const remove = key => { const row = entries.get(key); if (row) { bytes -= row.bytes.byteLength; entries.delete(key); } };
  /** @param {string} url @param {PdfRangeVersion} version */
  const valid = (url, version) => typeof url === "string" && url.length <= 4096 &&
    /^"[^"\r\n]+"$/.test(version?.etag || "") && version.etag.length <= 256 &&
    Number.isSafeInteger(version.total) && version.total > 0;
  const prune = () => {
    const timestamp = now();
    // Access-order changes independently of insertion time. This conservative
    // lower bound only skips the scan when no entry can have expired; removing
    // an older entry may leave it stale, which merely triggers an extra scan.
    if (timestamp < nextExpiry) return;
    nextExpiry = Infinity;
    for (const [key, row] of entries) {
      if (timestamp - row.at >= maxAgeMs) remove(key);
      else nextExpiry = Math.min(nextExpiry, row.at + maxAgeMs);
    }
  };
  return Object.freeze({
    /** @param {string} url @param {number} begin @param {number} end */
    version(url, begin, end) {
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin) return null;
      prune();
      for (const row of entries.values()) {
        if (row.url === url && begin >= row.begin && Math.min(end, row.total) <= row.end)
          return {etag:row.etag, total:row.total};
      }
      return null;
    },
    /** @param {string} url @param {number} begin @param {number} end @param {PdfRangeVersion} version */
    get(url, begin, end, version) {
      if (!valid(url, version) || !Number.isSafeInteger(begin) || !Number.isSafeInteger(end) ||
          begin < 0 || end <= begin || end > version.total) return null;
      prune();
      for (const [key, row] of entries) {
        if (row.url !== url || row.etag !== version.etag || row.total !== version.total ||
            begin < row.begin || end > row.end) continue;
        entries.delete(key); entries.set(key, row);
        // PDF.js transfers ArrayBuffers. Never let it detach our retained bytes.
        return row.bytes.slice(begin - row.begin, end - row.begin);
      }
      return null;
    },
    /** @param {string} url @param {number} begin @param {Uint8Array} value @param {PdfRangeVersion} version */
    put(url, begin, value, version) {
      if (!valid(url, version) || value.byteLength > 2 * 1024 * 1024 || value.byteLength > maxBytes) return;
      prune();
      const end = begin + value.byteLength;
      if (!Number.isSafeInteger(begin) || begin < 0 || end > version.total) return;
      for (const [key, row] of entries) {
        if (row.url === url && (row.etag !== version.etag || row.total !== version.total ||
            (row.begin >= begin && row.end <= end))) remove(key);
      }
      const key = JSON.stringify([url, version.etag, version.total, begin, end]);
      remove(key);
      const retained = value.slice();
      const at = now();
      entries.set(key, {url, begin, end, etag:version.etag, total:version.total, bytes:retained, at});
      nextExpiry = Math.min(nextExpiry, at + maxAgeMs);
      bytes += retained.byteLength;
      while (bytes > maxBytes || entries.size > maxEntries) remove(/** @type {string} */ (entries.keys().next().value));
    },
    get byteLength() { return bytes; },
    get size() { return entries.size; }
  });
}

// The only intentional cache shared across same-origin Reader overlays. The
// cache stays owned by the parent search tab and is never persisted to disk.
export function sharedPdfRangeCache() {
  if (typeof window === "undefined") return null;
  /** @type {Window} */
  let owner = window;
  try {
    if (parent !== window && parent.location.origin === location.origin &&
        [...parent.document.querySelectorAll("iframe.reader-overlay")].some(frame => /** @type {HTMLIFrameElement} */ (frame).contentWindow === window)) owner = parent;
  } catch (_) {}
  const key = Symbol.for("voice-reader-pdf-ranges-v1");
  try {
    if (!Object.prototype.hasOwnProperty.call(owner, key))
      Object.defineProperty(owner, key, {value:createPdfRangeCache()});
    return /** @type {ReturnType<typeof createPdfRangeCache>} */ (Reflect.get(owner, key));
  } catch (_) { return null; }
}

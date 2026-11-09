// Request ownership is scoped to one PDF Worker, not shared across books.
/** @typedef {{add(request: AbortController): unknown, delete(request: AbortController): unknown}} RequestOwners */
/** @returns {DOMException} */
const aborted = () => new DOMException("Search cancelled", "AbortError");

export function createPdfPartitionRequests() {
  /** @type {Set<AbortController>} */
  const requests = new Set();
  /** @type {Set<() => void>} */
  const waiters = new Set();
  function abort() { for (const request of requests) request.abort(); }
  /** @returns {Promise<void>} */
  function wait() {
    if (!requests.size) return Promise.resolve();
    return new Promise(resolve => waiters.add(resolve));
  }
  /** @template T @param {() => boolean} current @param {RequestOwners | null} owners
   * @param {(signal: AbortSignal) => Promise<T>} action @returns {Promise<T>} */
  async function run(current, owners, action) {
    if (!current()) throw aborted();
    const request = new AbortController();
    requests.add(request);
    owners?.add(request);
    const timer = setTimeout(() => request.abort(), 120000);
    try { return await action(request.signal); }
    finally {
      clearTimeout(timer);
      requests.delete(request);
      owners?.delete(request);
      request.abort();
      if (!requests.size) {
        for (const resolve of waiters) resolve();
        waiters.clear();
      }
    }
  }
  return {abort, wait, run};
}

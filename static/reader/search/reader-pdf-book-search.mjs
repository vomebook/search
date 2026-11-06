/**
 * @typedef {{start: number, end: number, url: string, bytes: number, sha256: string}} PdfSearchPartition
 * @typedef {{url: string, bytes: number, sha256: string, pageCount: number, sourceSha?: string,
 *   generation?: string, partitions?: PdfSearchPartition[]}} PdfBookSearchConfiguration
 * @typedef {{box: number[], block?: unknown, precision?: string}} PdfBookSearchBox
 * @typedef {{page: number, start: number, length: number, boxes: PdfBookSearchBox[],
 *   snippet: {text: string, matchStart: number, matchLength: number, prefix: string, suffix: string},
 *   textGeneration?: string}} PdfBookSearchHit
 * @typedef {{id: number, session: number, total: number, offset: number, pageSize: number,
 *   results: PdfBookSearchHit[], complete?: boolean}} PdfBookSearchResult
 * @typedef {PdfBookSearchResult & {progress: true, scanned: number, pages: number}} PdfBookSearchProgress
 * @typedef {{id: number, ready: true, session: number | null}} PdfBookPrefetchResult
 * @typedef {{id?: number, bookReady?: boolean, progress?: boolean, session?: unknown, error?: string} &
 *   Partial<Omit<PdfBookSearchResult, "session">> & {scanned?: number, pages?: number}} PdfBookSearchMessage
 * @typedef {{id: number, type: "search" | "page" | "prefetch", resolve: (value: PdfBookSearchResult | PdfBookPrefetchResult) => void, reject: (reason?: unknown) => void,
 *   progress: ((value: PdfBookSearchProgress) => void) | undefined}} PdfBookSearchPending
 */
/** @param {PdfBookSearchConfiguration} configuration */
export function createPdfBookSearch(configuration) {
  let /** @type {Worker | null} */ worker = null, bookReady = false;
  let sequence = 0, /** @type {PdfBookSearchPending | null} */ pending = null,
    disposed = false, /** @type {unknown} */ session = null,
    /** @type {Error | null} */ failure = null;
  function cancelPending() {
    pending?.reject(new DOMException("Search cancelled", "AbortError"));
    pending = null;
  }
  function startWorker() {
    const owner = worker = new Worker(new URL("./workers/reader-pdf-book-search-worker.mjs", import.meta.url), { type: "module" });
    // The paired Worker sends this protocol; these annotations do not validate
    // arbitrary messages at runtime or change the existing Worker boundary.
    owner.onmessage = (/** @type {MessageEvent<PdfBookSearchMessage>} */ { data }) => {
      if (worker !== owner || disposed) return;
      if (data.bookReady) { bookReady = true; return; }
      if (!pending || pending.id !== data.id) return;
      if (data.progress) {
        session = data.session;
        pending.progress?.(/** @type {PdfBookSearchProgress} */ (data));
        return;
      }
      const task = pending;
      pending = null;
      if (data.error) task.reject(new Error(data.error));
      else { session = data.session; task.resolve(/** @type {PdfBookSearchResult | PdfBookPrefetchResult} */ (data)); }
    };
    owner.onerror = event => {
      if (worker !== owner || disposed) return;
      event.preventDefault();
      failure = new Error("PDF 全文搜索组件加载失败，请重试");
      pending?.reject(failure);
      pending = null;
    };
    owner.postMessage({ type: "init", configuration });
  }
  startWorker();
  /** @param {"search" | "page" | "prefetch"} type @param {Record<string, unknown>} values
   * @param {(value: PdfBookSearchProgress) => void} [progress] @returns {Promise<PdfBookSearchResult | PdfBookPrefetchResult>} */
  function request(type, values, progress) {
    if (disposed) return Promise.reject(new DOMException("Reader closed", "AbortError"));
    if (failure) return Promise.reject(failure);
    if (type === "prefetch" && pending && pending.type !== "prefetch")
      return Promise.reject(new DOMException("Search in progress", "AbortError"));
    if (!worker) startWorker();
    cancelPending();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending = { id, type, resolve, reject, progress };
      // startWorker runs above when needed; Promise executors run synchronously.
      (/** @type {Worker} */ (worker)).postMessage({ type, id, ...values });
    });
  }
  return {
    get failed() { return !!failure; },
    prefetch() { return /** @type {Promise<PdfBookPrefetchResult>} */ (request("prefetch", {})); },
    /** @param {string} query @param {(value: PdfBookSearchProgress) => void} [progress] */
    search(query, progress) { return /** @type {Promise<PdfBookSearchResult>} */ (request("search", { query }, progress)); },
    /** @param {number} offset */
    page(offset) { return /** @type {Promise<PdfBookSearchResult>} */ (request("page", { offset, session })); },
    cancel() {
      cancelPending(); session = null;
      if (!bookReady) {
        // Termination interrupts synchronous JSON parsing too.
        worker?.terminate(); worker = null; failure = null;
      } else worker?.postMessage({ type: "cancel" });
    },
    dispose() { disposed = true; cancelPending(); worker?.terminate(); worker = null; }
  };
}

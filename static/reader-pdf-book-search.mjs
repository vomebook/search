export function createPdfBookSearch(configuration) {
  let worker = null, bookReady = false;
  let sequence = 0, pending = null, disposed = false, session = null, failure = null;
  function cancelPending() {
    pending?.reject(new DOMException("Search cancelled", "AbortError"));
    pending = null;
  }
  function startWorker() {
    const owner = worker = new Worker(new URL("./reader-pdf-book-search-worker.mjs", import.meta.url), { type: "module" });
    owner.onmessage = ({ data }) => {
      if (worker !== owner || disposed) return;
      if (data.bookReady) { bookReady = true; return; }
      if (!pending || pending.id !== data.id) return;
      if (data.progress) {
        session = data.session;
        pending.progress?.(data);
        return;
      }
      const task = pending;
      pending = null;
      if (data.error) task.reject(new Error(data.error));
      else { session = data.session; task.resolve(data); }
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
  function request(type, values, progress) {
    if (disposed) return Promise.reject(new DOMException("Reader closed", "AbortError"));
    if (failure) return Promise.reject(failure);
    if (!worker) startWorker();
    cancelPending();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending = { id, resolve, reject, progress };
      worker.postMessage({ type, id, ...values });
    });
  }
  return {
    get failed() { return !!failure; },
    prefetch() { return request("prefetch", {}); },
    search(query, progress) { return request("search", { query }, progress); },
    page(offset) { return request("page", { offset, session }); },
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

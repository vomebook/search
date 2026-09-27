export function createPdfBookSearch(configuration) {
  const worker = new Worker(new URL("./reader-pdf-book-search-worker.mjs", import.meta.url), { type: "module" });
  let sequence = 0, pending = null, disposed = false, session = null, failure = null;
  function cancelPending() {
    pending?.reject(new DOMException("Search cancelled", "AbortError"));
    pending = null;
  }
  worker.onmessage = ({ data }) => {
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
  worker.onerror = event => {
    event.preventDefault();
    failure = new Error("PDF 全文搜索组件加载失败，请重试");
    pending?.reject(failure);
    pending = null;
  };
  worker.postMessage({ type: "init", configuration });
  function request(type, values, progress) {
    if (disposed) return Promise.reject(new DOMException("Reader closed", "AbortError"));
    if (failure) return Promise.reject(failure);
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
    cancel() { cancelPending(); session = null; worker.postMessage({ type: "cancel" }); },
    dispose() { disposed = true; cancelPending(); worker.terminate(); }
  };
}

export function createPdfFetchPolicy() {
  const documents = new Set();
  const controller = new AbortController();
  const nativeFetch = globalThis.fetch;
  const pdfFetch = (input, init) => {
    let url;
    try { url = new URL(input instanceof Request ? input.url : input, location.href).href; }
    catch (_) { return nativeFetch.call(globalThis, input, init); }
    if (!documents.has(url)) return nativeFetch.call(globalThis, input, init);
    const callerSignal = init?.signal || (input instanceof Request ? input.signal : null);
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    return nativeFetch.call(globalThis, input, { ...init, cache: "no-store", signal });
  };
  globalThis.fetch = pdfFetch;
  return {
    add(urls) {
      for (const url of urls) documents.add(new URL(url, location.href).href);
    },
    dispose() {
      controller.abort(new DOMException("Reader closed", "AbortError"));
      documents.clear();
      if (globalThis.fetch === pdfFetch) globalThis.fetch = nativeFetch;
    }
  };
}

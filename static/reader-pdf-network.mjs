export function createPdfFetchPolicy() {
  const documents = new Set();
  const nativeFetch = globalThis.fetch;
  const pdfFetch = (input, init) => {
    let url;
    try { url = new URL(input instanceof Request ? input.url : input, location.href).href; }
    catch (_) { return nativeFetch.call(globalThis, input, init); }
    return nativeFetch.call(globalThis, input, documents.has(url) ? { ...init, cache: "no-store" } : init);
  };
  globalThis.fetch = pdfFetch;
  return {
    add(urls) {
      for (const url of urls) documents.add(new URL(url, location.href).href);
    },
    dispose() {
      documents.clear();
      if (globalThis.fetch === pdfFetch) globalThis.fetch = nativeFetch;
    }
  };
}

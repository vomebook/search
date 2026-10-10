function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, {once:true});
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function createPdfFetchPolicy({idleMs = 15000, attemptMs = 45000} = {}) {
  const documents = new Set();
  const versions = new Map(), timings = [];
  const controller = new AbortController();
  const nativeFetch = globalThis.fetch;
  let version = null, inconsistent = false, buffered = 0;
  const remember = (response, url) => {
    const etag = response.headers.get("ETag");
    const range = /^bytes \d+-\d+\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
    const size = Number(range?.[1] || response.headers.get("Content-Length"));
    if (!/^"[^"\r\n]+"$/.test(etag || "") || !Number.isSafeInteger(size) || size < 1 ||
        (response.headers.get("Content-Encoding") && response.headers.get("Content-Encoding") !== "identity")) {
      if (versions.has(url)) inconsistent = true;
      return;
    }
    const identity = JSON.stringify([etag, size]);
    if (versions.has(url) && versions.get(url) !== identity) {
      inconsistent = true;
      throw new Error("PDF_SOURCE_CHANGED");
    }
    versions.set(url, identity);
    version = identity;
  };
  const pdfFetch = async (input, init) => {
    let url;
    try { url = new URL(input instanceof Request ? input.url : input, location.href).href; }
    catch (_) { return nativeFetch.call(globalThis, input, init); }
    if (!documents.has(url)) return nativeFetch.call(globalThis, input, init);
    const callerSignal = init?.signal || (input instanceof Request ? input.signal : null);
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("Range") || "");
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const start = Number(match?.[1]), end = Number(match?.[2]);
    const eligible = method === "GET" && match && Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
      start <= end && end - start < 2 * 1024 * 1024 &&
      !["If-Range","If-None-Match","If-Match","If-Modified-Since","If-Unmodified-Since"].some(name=>headers.has(name));
    for (let attempt = 0; attempt <= (eligible ? 1 : 0); attempt++) {
      signal.throwIfAborted();
      const owner = new AbortController(), active = AbortSignal.any([signal, owner.signal]);
      const began = performance.now();
      const measurement = {at:began, attempt, range:match ? [start,end] : null, headersMs:0, bodyMs:0, bytes:0};
      let idle, reader, response, bodyAt = 0, ownsBuffer = false;
      const timeout = () => owner.abort(new DOMException("PDF request stalled", "TimeoutError"));
      const arm = () => { clearTimeout(idle); idle = setTimeout(timeout, idleMs); };
      const deadline = setTimeout(timeout, attemptMs);
      arm();
      try {
        response = await abortable(Promise.resolve(nativeFetch.call(globalThis, input, {...init, cache:"no-store", signal:active}))
          .then(value => {
            if (active.aborted) { value.body?.cancel().catch(() => {}); throw active.reason; }
            return value;
          }), active);
        measurement.headersMs = performance.now() - began;
        measurement.status = response.status;
        measurement.serverTiming = (response.headers.get("Server-Timing") || "").slice(0, 512);
        if (eligible && [408,429,500,502,503,504].includes(response.status)) {
          owner.abort();
          response.body?.cancel().catch(() => {});
          throw Object.assign(new Error("PDF temporary upstream failure"), {retryable:true});
        }
        if (response.ok) remember(response, url);
        if (!eligible || response.status !== 206 || buffered >= 8) return response;
        buffered++; ownsBuffer = true;
        const actual = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
        if (!actual || actual.slice(1).some(value=>!Number.isSafeInteger(Number(value))) ||
            Number(actual[1]) !== start || Number(actual[2]) !== Math.min(end, Number(actual[3])-1) ||
            Number(actual[3]) <= start) throw new Error("PDF_RANGE_INVALID");
        const length = Number(actual[2]) - start + 1, bytes = new Uint8Array(length);
        reader = response.body.getReader();
        bodyAt = performance.now();
        arm();
        while (true) {
          const chunk = await abortable(reader.read(), active);
          if (chunk.done) break;
          if (measurement.bytes + chunk.value.byteLength > length) throw new Error("PDF_RANGE_INVALID");
          bytes.set(chunk.value, measurement.bytes);
          measurement.bytes += chunk.value.byteLength;
          arm();
        }
        measurement.bodyMs = performance.now() - bodyAt;
        if (measurement.bytes !== length) throw Object.assign(new Error("PDF_RANGE_TRUNCATED"), {retryable:true});
        const result = new Response(bytes, {status:response.status, statusText:response.statusText, headers:response.headers});
        Object.defineProperty(result, "url", {value:response.url});
        return result;
      } catch (error) {
        measurement.error = signal.aborted ? "cancelled" : error?.name === "TimeoutError" ? "timeout" : "failure";
        signal.throwIfAborted();
        if (attempt || !eligible || !(error?.retryable || error?.name === "TimeoutError" || error instanceof TypeError)) throw error;
      } finally {
        clearTimeout(idle); clearTimeout(deadline);
        if (measurement.error) {
          owner.abort();
          if (!reader) response?.body?.cancel().catch(() => {});
        }
        if (reader) { reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (ownsBuffer) buffered--;
        if (bodyAt) measurement.bodyMs = performance.now()-bodyAt;
        else if (!measurement.status) measurement.headersMs = performance.now()-began;
        measurement.totalMs = performance.now() - began;
        if (!controller.signal.aborted) timings.push(measurement);
        if (timings.length > 64) timings.shift();
      }
    }
  };
  globalThis.fetch = pdfFetch;
  return {
    add(urls) {
      for (const url of urls) documents.add(new URL(url, location.href).href);
    },
    get identity() { return inconsistent ? null : version; },
    get timings() { return timings.map(row => ({...row,range:row.range?.slice() || null})); },
    dispose() {
      controller.abort(new DOMException("Reader closed", "AbortError"));
      documents.clear();
      versions.clear(); timings.length = 0;
      if (globalThis.fetch === pdfFetch) globalThis.fetch = nativeFetch;
    }
  };
}

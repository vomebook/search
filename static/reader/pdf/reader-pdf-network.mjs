// A search-tab-owned, bounded memory cache. Every opening still fetches its
// fresh range to establish a strong ETag/total before any reuse. No disk,
// Service Worker body cache or change to the PDF HTTP no-store policy is involved.
export function createPdfRangeCache({maxBytes = 8 * 1024 * 1024, maxEntries = 64,
  maxAgeMs = 600000, now = () => Date.now()} = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = key => { const row = entries.get(key); if (row) { bytes -= row.bytes.byteLength; entries.delete(key); } };
  const valid = (url, version) => typeof url === "string" && url.length <= 4096 &&
    /^"[^"\r\n]+"$/.test(version?.etag || "") && version.etag.length <= 256 &&
    Number.isSafeInteger(version.total) && version.total > 0;
  const prune = () => {
    for (const [key, row] of entries) if (now() - row.at >= maxAgeMs) remove(key);
  };
  return Object.freeze({
    version(url, begin, end) {
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin) return null;
      prune();
      for (const row of entries.values()) {
        if (row.url === url && begin >= row.begin && Math.min(end, row.total) <= row.end)
          return {etag:row.etag, total:row.total};
      }
      return null;
    },
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
      entries.set(key, {url, begin, end, etag:version.etag, total:version.total, bytes:retained, at:now()});
      bytes += retained.byteLength;
      while (bytes > maxBytes || entries.size > maxEntries) remove(entries.keys().next().value);
    },
    get byteLength() { return bytes; },
    get size() { return entries.size; }
  });
}

function sharedPdfRangeCache() {
  if (typeof window === "undefined") return null;
  let owner = window;
  try {
    if (parent !== window && parent.location.origin === location.origin &&
        [...parent.document.querySelectorAll("iframe.reader-overlay")].some(frame => frame.contentWindow === window)) owner = parent;
  } catch (_) {}
  const key = Symbol.for("voice-reader-pdf-ranges-v1");
  try {
    if (!Object.prototype.hasOwnProperty.call(owner, key))
      Object.defineProperty(owner, key, {value:createPdfRangeCache()});
    return owner[key];
  } catch (_) { return null; }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, {once:true});
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readPdfRange(options, begin, end, {signal, readBytes, limit, rangeCache}, expected = null, onHeaders = null, partialOnly = false) {
  signal.throwIfAborted();
  const key = new URL(options.url, globalThis.location?.href).href;
  let cached = null;
  try { if (expected) cached = rangeCache?.get(key, begin, Math.min(end, expected.total), expected); }
  catch (_) { /* Cache allocation failure must retain normal network reading. */ }
  if (cached) return {bytes:cached, total:expected.total, etag:expected.etag};
  const response = await fetch(options.url, {
    headers: {Range: `bytes=${begin}-${end-1}`}, signal, credentials:"same-origin"
  });
  const invalid = () => new Error("PDF_RANGE_INVALID");
  try {
    if (!response.ok) throw Object.assign(new Error(`server response (${response.status})`), {status:response.status});
    if (!expected && response.status === 200) {
      if (partialOnly) { await response.body?.cancel(); return null; }
      const bytes = await readBytes(response, limit);
      return {bytes, complete:true};
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
    if (response.status !== 206 || !match || match.slice(1).some(value=>!Number.isSafeInteger(Number(value))))
      throw invalid();
    const [start, last, total] = match.slice(1).map(Number);
    if (total > limit) throw Object.assign(new Error("READER_RESOURCE_LIMIT"), {code:"READER_RESOURCE_LIMIT"});
    if (start !== begin || last !== Math.min(end,total)-1 || total <= start) throw invalid();
    const etag = response.headers.get("ETag"), encoding = response.headers.get("Content-Encoding");
    if (encoding && encoding !== "identity") throw invalid();
    if (expected && (total !== expected.total || etag !== expected.etag)) throw new Error("PDF_SOURCE_CHANGED");
    if (!expected && !/^"[^"\r\n]+"$/.test(etag || "") && last+1 < total) {
      await response.body?.cancel();
      return null;
    }
    onHeaders?.({total, etag});
    const bytes = await readBytes(response, last-start+1);
    if (bytes.byteLength !== last-start+1) throw invalid();
    signal.throwIfAborted();
    try { rangeCache?.put(key, start, bytes, {total, etag}); }
    catch (_) { /* Retaining an optional copy must never fail the document. */ }
    return {bytes, total, etag, complete:bytes.byteLength === total};
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
}

function firstPageSectionEnd(bytes, total, chunkSize) {
  // A bounded scheduling hint, not a PDF parser. Only a direct, internally
  // consistent first-object linearization dictionary can justify first-page
  // lookahead. PDF.js remains the authority for all content and rendering.
  // Keep this section disjoint from the already scheduled two-chunk tail.
  if (total <= chunkSize * 6) return 0;
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const object = /\b\d+\s+\d+\s+obj\s*<<([^]*?)>>/.exec(header);
  if (!object || object.index > 1024 || !/\/Linearized\s+1(?:\.0+)?(?=[\s/>]|$)/.test(object[1])) return 0;
  const integer = name => {
    const match = new RegExp("/" + name + "\\s+(\\d+)(?=[\\s/>]|$)").exec(object[1]);
    if (!match || /^\s+\d+\s+R\b/.test(object[1].slice(match.index + match[0].length))) return NaN;
    return Number(match[1]);
  };
  const length = integer("L"), end = integer("E"), firstPage = /\/P\s/.test(object[1]) ? integer("P") : 0;
  if (length !== total || firstPage !== 0 || !Number.isSafeInteger(end) || end <= chunkSize ||
      end >= total || end > chunkSize * 4) return 0;
  return Math.min(total, Math.ceil(end / chunkSize) * chunkSize);
}

// The first demand overlaps engine preparation. After its complete validation,
// a qualified page-one file may overlap at most three more existing chunks.
export async function preparePdfInitialRange(options, hooks) {
  hooks = {...hooks, rangeCache:hooks.rangeCache === undefined ? sharedPdfRangeCache() : hooks.rangeCache};
  const owner = new AbortController();
  const signal = AbortSignal.any([hooks.signal, owner.signal]);
  let tail = null;
  try {
    const onHeaders = metadata => {
      if (metadata.total <= options.rangeChunkSize * 4) return;
      // Start the existing two-chunk tail on validated headers, not after the
      // first body finishes. This changes scheduling, not the fetched range.
      const begin = Math.floor((metadata.total - 1) / options.rangeChunkSize) * options.rangeChunkSize - options.rangeChunkSize;
      tail = {begin, promise:readPdfRange(options, begin, metadata.total, {...hooks, signal}, metadata).catch(() => null)};
    };
    let first = null;
    // A complete retained prefix may be reused only after a fresh no-store
    // one-byte 206 proves its exact strong ETag and whole-document length.
    // A changed/weak source or origin ignoring Range takes the ordinary path.
    const key = new URL(options.url, globalThis.location?.href).href;
    let previous = null;
    try { previous = hooks.rangeCache?.version?.(key, 0, options.rangeChunkSize); } catch (_) {}
    if (previous) {
      const checked = await readPdfRange(options, 0, 1, {...hooks, signal, rangeCache:null}, null, null, true);
      if (checked && checked.etag === previous.etag && checked.total === previous.total) {
        let bytes = null;
        try { bytes = hooks.rangeCache?.get(key, 0, Math.min(options.rangeChunkSize, checked.total), checked); } catch (_) {}
        if (bytes) {
          first = {bytes, total:checked.total, etag:checked.etag, complete:bytes.byteLength === checked.total};
          if (!first.complete) onHeaders(first);
        }
      }
    }
    first ||= await readPdfRange(options, 0, options.rangeChunkSize, {...hooks, signal}, null, onHeaders);
    if (!first) { owner.abort(); return first; }
    const openingRanges = [];
    const end = !first.complete && hooks.canPrefetchFirstPage?.()
      ? firstPageSectionEnd(first.bytes, first.total, options.rangeChunkSize) : 0;
    for (let begin = options.rangeChunkSize; begin < end; begin += options.rangeChunkSize * 2) {
      const last = Math.min(end, begin + options.rangeChunkSize * 2);
      openingRanges.push({begin, end:last,
        promise:readPdfRange(options, begin, last, {...hooks, signal}, first).catch(() => null)});
    }
    return {...first, tail, openingRanges, cancelInitial:reason => owner.abort(reason)};
  } catch (error) {
    owner.abort(error);
    throw error;
  }
}

export async function openPdfRangeTask(pdfjs, options, {signal, readBytes, limit, onError, initial = null,
  rangeCache = sharedPdfRangeCache(), canPrefetchFirstPage = () => false, canPrefetchOpening = () => false}) {
  if (typeof pdfjs.PDFDataRangeTransport !== "function") return pdfjs.getDocument(options);
  const chunkSize = options.rangeChunkSize;
  const owner = new AbortController();
  const active = AbortSignal.any([signal, owner.signal]);
  let task = null, stopped = false, prepared = null;
  const failure = Promise.withResolvers();
  failure.promise.catch(() => {});
  const stop = reason => {
    if (stopped) return;
    stopped = true;
    owner.abort(reason);
    prepared?.cancelInitial?.(reason);
    signal.removeEventListener("abort", cancelled);
  };
  const cancelled = () => stop(signal.reason);
  signal.addEventListener("abort", cancelled, {once:true});
  const read = (begin, end, expected = null) => readPdfRange(options, begin, end,
    {signal:active, readBytes, limit, rangeCache}, expected);
  try {
    const first = prepared = await (initial || preparePdfInitialRange(options,
      {signal:active, readBytes, limit, rangeCache, canPrefetchFirstPage}));
    active.throwIfAborted();
    if (!first) {
      stop();
      return pdfjs.getDocument(options);
    }
    if (first.complete) {
      stop();
      return pdfjs.getDocument({...options, data:first.bytes});
    }
    // PDF.js owns parsing and range demand; the bootstrap is the first real range.
    const transport = new pdfjs.PDFDataRangeTransport(first.total, first.bytes, true);
    transport.abort = () => stop(new DOMException("PDF transport closed", "AbortError"));
    // PDF.js parses non-linearized files from their end (trailer, then the
    // cross-reference table), demanding those chunks one round trip at a
    // time. Fetch the last two aligned chunks once, alongside its startup.
    let tail = first.tail || null;
    if (!tail && first.total > chunkSize * 4) {
      const begin = Math.floor((first.total - 1) / chunkSize) * chunkSize - chunkSize;
      tail = {begin, promise:read(begin, first.total, first).catch(() => null)};
    }
    // A conservative read-ahead hint, not a PDF parser: only a direct Length
    // before the first stream, in the bounded opening header, can qualify.
    // Missing/indirect/complete streams retain ordinary PDF.js range demand.
    const header = new TextDecoder("latin1").decode(first.bytes.subarray(0, 4096));
    const stream = /\bstream(?:\r\n|\r|\n)/.exec(header);
    const length = stream && /\/Length\s+(\d+)(?:\s+\d+\s+R)?(?=[\s/>])/.exec(header.slice(0, stream.index));
    const streamEnd = length && stream.index + stream[0].length + Number(length[1]);
    const openingStreamContinues = length && !/\sR$/.test(length[0]) && Number.isSafeInteger(streamEnd) &&
      streamEnd > first.bytes.byteLength && streamEnd <= first.total;
    // One chunk only; deep restorations and non-v3/native URLs do not opt in.
    const openingRanges = first.openingRanges || [];
    const prefix = first.total > chunkSize * 4 && openingStreamContinues && canPrefetchOpening() &&
      !openingRanges.some(range => range.begin <= chunkSize && range.end >= chunkSize * 2)
      ? {begin:chunkSize, end:chunkSize * 2,
        promise:read(chunkSize, chunkSize * 2, first).catch(() => null)}
      : null;
    const fetchOrdinaryRange = (begin, end) => prefix && begin >= prefix.begin && end <= prefix.end
      ? prefix.promise.then(result => result
        ? {bytes:result.bytes.slice(begin - prefix.begin, end - prefix.begin)}
        : read(begin, end, first))
      : tail && begin >= tail.begin
      ? tail.promise.then(result => result
        ? {bytes:result.bytes.slice(begin - tail.begin, end - tail.begin)}
        : read(begin, end, first))
      : read(begin, end, first);
    const fetchRange = (begin, end) => {
      const parts = [];
      let offset = begin;
      for (const range of openingRanges) {
        if (offset < range.begin || offset >= range.end) continue;
        const last = Math.min(end, range.end);
        const from = offset;
        parts.push({range, from, last});
        offset = last;
        if (offset === end) break;
      }
      if (offset !== end) return fetchOrdinaryRange(begin, end);
      return Promise.all(parts.map(({range, from, last}) => range.promise.then(result => result
        ? result.bytes.slice(from - range.begin, last - range.begin)
        : read(from, last, first).then(row => row.bytes)))).then(values => {
        const bytes = new Uint8Array(end - begin);
        let at = 0;
        for (const value of values) { bytes.set(value, at); at += value.byteLength; }
        return {bytes};
      });
    };
    transport.requestDataRange = (begin, end) => {
      fetchRange(begin,end).then(result => {
        if (!stopped) transport.onDataRange(begin,result.bytes);
      }).catch(error => {
        if (stopped) return;
        failure.reject(error);
        stop(error);
        task?.destroy()?.catch?.(() => {});
        onError?.(error);
      });
    };
    task = pdfjs.getDocument({...options, range:transport});
    task.promise.catch(error => stop(error));
    return {
      promise:Promise.race([task.promise,failure.promise]),
      destroy() {transport.abort();return task.destroy();}
    };
  } catch (error) {
    stop(error);
    throw error;
  }
}

export function createPdfFetchPolicy({idleMs = 15000, attemptMs = 45000,
  initialIdleMs = 10000, initialTotalMs = 120000} = {}) {
  const documents = new Set();
  const versions = new Map(), timings = [];
  const controller = new AbortController();
  const nativeFetch = globalThis.fetch;
  let version = null, inconsistent = false;
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
    const conditional = ["If-Range","If-None-Match","If-Match","If-Modified-Since","If-Unmodified-Since"]
      .some(name=>headers.has(name));
    const eligible = method === "GET" && match && Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
      start <= end && end - start < 2 * 1024 * 1024 && !conditional;
    const initialRecovery = method === "GET" && !headers.has("Range") && !conditional;
    const initialAt = performance.now();
    let attempt = 0, record, response, reader, length = 0, delivered = 0, validator = null, stopped = false;
    function finish(error = null) {
      if (!record || record.finished) return;
      record.finished = true;
      clearTimeout(record.idle); clearTimeout(record.deadline);
      const row = record.row;
      if (error) {
        row.error = signal.aborted ? "cancelled" : error.name === "TimeoutError" ? "timeout" : "failure";
        record.owner.abort(error);
      }
      if (reader) {
        const owned = reader; reader = null;
        owned.cancel().catch(() => {}).finally(() => owned.releaseLock());
      } else if (error) response?.body?.cancel().catch(() => {});
      row.totalMs = performance.now()-row.at;
      if (record.bodyAt) row.bodyMs = performance.now()-record.bodyAt;
      else if (!row.status) row.headersMs = row.totalMs;
      if (!controller.signal.aborted) timings.push(row);
      if (timings.length > 64) timings.shift();
    }
    function arm() {
      clearTimeout(record.idle); clearTimeout(record.deadline);
      const owner = record.owner;
      const timeout = () => owner.abort(new DOMException("PDF request stalled", "TimeoutError"));
      if (!initialRecovery || attempt === 0)
        record.idle = setTimeout(timeout,initialRecovery ? initialIdleMs : idleMs);
      record.deadline = setTimeout(timeout,Math.max(0,initialRecovery
        ? initialTotalMs-(performance.now()-initialAt) : attemptMs-(performance.now()-record.row.at)));
    }
    function retryable(error) {
      return !signal.aborted && attempt === 0 && (initialRecovery
        ? performance.now()-initialAt < initialTotalMs : eligible && (!delivered || validator)) &&
        (error?.retryable || error?.name === "TimeoutError" || error instanceof TypeError);
    }
    async function open() {
      signal.throwIfAborted();
      response = null;
      const owner = new AbortController();
      record = {owner, active:AbortSignal.any([signal,owner.signal]),
        row:{at:performance.now(),attempt,range:match?[start,end]:null,headersMs:0,bodyMs:0,bytes:0}};
      if (eligible || initialRecovery) arm();
      response = await abortable(Promise.resolve(nativeFetch.call(globalThis,input,{...init,cache:"no-store",signal:record.active}))
        .then(value => {
          if (owner.signal.aborted || signal.aborted) {value.body?.cancel().catch(() => {});throw record.active.reason;}
          return value;
        }),record.active);
      record.row.headersMs = performance.now()-record.row.at;
      record.row.status = response.status;
      record.row.serverTiming = (response.headers.get("Server-Timing") || "").slice(0,512);
      if ((eligible || initialRecovery) && [408,429,500,502,503,504].includes(response.status))
        throw Object.assign(new Error("PDF temporary upstream failure"),{retryable:true});
      // PDF.js needs headers immediately to cancel the full GET and demand ranges.
      // Initial recovery must not read or wait for this potentially large body.
      if (response.ok) remember(response,url);
      if (!eligible || response.status !== 206) {
        if (delivered) throw new Error("PDF_RANGE_INVALID");
        return false;
      }
      const actual = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
      if (!actual || actual.slice(1).some(value=>!Number.isSafeInteger(Number(value))) ||
          Number(actual[1]) !== start || Number(actual[2]) !== Math.min(end,Number(actual[3])-1) || Number(actual[3]) <= start)
        throw new Error("PDF_RANGE_INVALID");
      const size = Number(actual[2])-start+1, etag = response.headers.get("ETag");
      if (delivered && (etag !== validator || size !== length)) throw new Error("PDF_SOURCE_CHANGED");
      length = size;
      validator = /^"[^"\r\n]+"$/.test(etag || "") ? etag : null;
      reader = response.body.getReader();
      record.bodyAt = performance.now();
      clearTimeout(record.idle); clearTimeout(record.deadline);
      return true;
    }
    let streaming;
    while (true) {
      try {streaming = await open();break;}
      catch(error) {const retry = retryable(error);finish(error);if (!retry) throw error;attempt++;}
    }
    if (!streaming) {finish();return response;}
    const firstResponse = response;
    let output;
    const abort = () => {
      if (stopped) return;
      stopped = true;finish(signal.reason);output.error(signal.reason);
      signal.removeEventListener("abort",abort);
    };
    const stream = new ReadableStream({
      start(control) {output=control;signal.addEventListener("abort",abort,{once:true});if (signal.aborted) abort();},
      async pull(control) {
        while (!stopped) {
          try {
            arm();
            const chunk = await abortable(reader.read(),record.active);
            clearTimeout(record.idle); clearTimeout(record.deadline);
            if (stopped) return;
            if (chunk.done) {
              if (record.row.bytes !== length) throw Object.assign(new Error("PDF_RANGE_TRUNCATED"),{retryable:true});
              stopped=true;finish();signal.removeEventListener("abort",abort);control.close();return;
            }
            const offset = record.row.bytes;
            record.row.bytes += chunk.value.byteLength;
            if (record.row.bytes > length) throw new Error("PDF_RANGE_INVALID");
            // A validated retry replays only bytes not already delivered.
            const skip = Math.min(chunk.value.byteLength,Math.max(0,delivered-offset));
            if (skip === chunk.value.byteLength) continue;
            // PDF.js consumes value.buffer, ignoring typed-array offsets.
            const value = skip || chunk.value.byteOffset || chunk.value.byteLength !== chunk.value.buffer.byteLength
              ? chunk.value.slice(skip) : chunk.value;
            delivered += value.byteLength;control.enqueue(value);return;
          } catch(error) {
            if (stopped) return;
            const retry = retryable(error);finish(error);
            if (retry) {
              attempt++;
              try {
                if (await open()) continue;
                error = new Error("PDF_RANGE_INVALID");finish(error);
              } catch(next) {error=next;finish(error);}
            }
            stopped=true;signal.removeEventListener("abort",abort);control.error(error);return;
          }
        }
      },
      cancel(reason) {stopped=true;signal.removeEventListener("abort",abort);finish(reason || new DOMException("PDF read cancelled","AbortError"));}
    },{highWaterMark:0});
    const result = new Response(stream,{status:firstResponse.status,statusText:firstResponse.statusText,headers:firstResponse.headers});
    Object.defineProperty(result,"url",{value:firstResponse.url});
    return result;
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

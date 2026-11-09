import { createPdfRangeCache, sharedPdfRangeCache } from "./reader-pdf-range-cache.mjs";
import { PDF_ADAPTIVE_CHUNK_BYTES, PDF_LARGE_FLAT_CHUNK_BYTES, PDF_DEFAULT_CHUNK_BYTES, firstPageSectionEnd,
  firstPageTailHintStart, firstImageSectionEnd, choosePdfRangeChunkSize, isFirstPageCandidate }
  from "./reader-pdf-range-hints.mjs";
export { choosePdfRangeChunkSize, isFirstPageCandidate };

export const PDF_METADATA_RANGE_CONCURRENCY = 24;
const PDF_LARGE_FLAT_BATCH_DELAY_MS = 12;
const PDF_LARGE_FLAT_GAP_BUDGET = PDF_LARGE_FLAT_CHUNK_BYTES * 3;

// Preserve the existing public import path while cache ownership is isolated.
export { createPdfRangeCache };

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, {once:true});
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// Complete bodies retain `limit`. A validated range-transport document may be
// larger (`rangeLimit`): PDF.js reserves one length-sized buffer, but only
// demanded chunks are fetched or written. See the dated large-PDF report.
async function readPdfRange(options, begin, end, {signal, readBytes, limit, rangeLimit = limit, rangeCache}, expected = null, onHeaders = null, partialOnly = false) {
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
    if (total > (total === last + 1 - start ? limit : rangeLimit))
      throw Object.assign(new Error("READER_RESOURCE_LIMIT"), {code:"READER_RESOURCE_LIMIT"});
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

function preparePdfRangeHint(options, begin, end, hooks, expected) {
  const waiters = new Set();
  let bytes = null, loaded = 0, complete = false, failed = false;
  let published = false, failure = null, failureHandler = null, notified = false;
  const notifyFailure = () => {
    if (!failed || !published || notified || !failureHandler || hooks.signal.aborted) return;
    notified = true;
    failureHandler(failure);
  };
  const flush = () => {
    for (const waiter of waiters) {
      if (!failed && (!bytes || loaded < waiter.end - begin || (!complete && waiter.end === end))) continue;
      waiters.delete(waiter);
      if (failed) { waiter.resolve(null); continue; }
      published = true;
      // Each PDF.js range reader accepts one complete, exact requested buffer.
      // A proper subrange must not wait for unrelated trailing hint bytes/EOF.
      waiter.resolve({bytes:bytes.slice(waiter.begin - begin, waiter.end - begin)});
    }
  };
  const promise = readPdfRange(options, begin, end, {
    ...hooks,
    readBytes: async (response, length) => {
      const declared = response.headers.get("Content-Length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== length))
        throw new Error("PDF_RANGE_INVALID");
      if (!response.body?.getReader) return hooks.readBytes(response, length);
      const reader = response.body.getReader();
      try {
        bytes = new Uint8Array(length);
        while (true) {
          const {value, done} = await abortable(reader.read(), hooks.signal);
          hooks.signal.throwIfAborted();
          if (done) break;
          if (!value?.byteLength) continue;
          if (loaded + value.byteLength > length) throw new Error("PDF_RANGE_INVALID");
          bytes.set(value, loaded);
          loaded += value.byteLength;
          flush();
        }
        if (loaded !== length) throw new Error("PDF_RANGE_INVALID");
        return bytes;
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
    }
  }, expected).then(result => {
    // readPdfRange retains only an exact, version-checked complete response.
    bytes = result.bytes;
    loaded = bytes.byteLength;
    complete = true;
    flush();
    return result;
  }, error => {
    failure = error;
    failed = true;
    flush();
    // If a proper subrange was already used, a malformed/truncated remainder
    // must invalidate that document, not silently leave an accepted bad stream.
    notifyFailure();
    return null;
  });
  return {
    begin, end, promise,
    read(from, last) {
      if (from < begin || last > end || last <= from) return Promise.reject(new Error("PDF_RANGE_INVALID"));
      const pending = Promise.withResolvers();
      waiters.add({begin:from, end:last, resolve:pending.resolve});
      flush();
      return pending.promise;
    },
    onFailure(handler) { failureHandler = handler; notifyFailure(); }
  };
}

// The first demand overlaps engine preparation. After its complete validation,
// qualified page-one files may overlap bounded opening or tail range hints.
export async function preparePdfInitialRange(options, hooks) {
  hooks = {...hooks, rangeCache:hooks.rangeCache === undefined ? sharedPdfRangeCache() : hooks.rangeCache};
  const owner = new AbortController();
  const signal = AbortSignal.any([hooks.signal, owner.signal]);
  let tail = null, extendedTail = null;
  try {
    const onHeaders = metadata => {
      if (metadata.total <= options.rangeChunkSize * 4) return;
      // Start the existing two-chunk tail on validated headers, not after the
      // first body finishes. This changes scheduling, not the fetched range.
      const begin = Math.floor((metadata.total - 1) / options.rangeChunkSize) * options.rangeChunkSize - options.rangeChunkSize;
      tail = preparePdfRangeHint(options, begin, metadata.total, {...hooks, signal}, metadata);
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
    const pageOne = !first.complete && hooks.canPrefetchFirstPage?.();
    const connection = globalThis.navigator?.connection;
    const extraLookahead = pageOne && !connection?.saveData && !["slow-2g", "2g"].includes(connection?.effectiveType);
    const rangeChunkSize = first.complete ? options.rangeChunkSize :
      choosePdfRangeChunkSize(first.bytes, first.total, options.rangeChunkSize);
    // The ordinary tail ends after startxref but some flat files store a
    // large xref immediately before it. One extra chunk avoids serial tiny
    // reads; it remains ETag-bound and is suppressed for data-saving modes.
    const largeFlatTail = !connection?.saveData && !["slow-2g", "2g"].includes(connection?.effectiveType) &&
      first.total > options.rangeChunkSize * 6 && tail && rangeChunkSize === PDF_LARGE_FLAT_CHUNK_BYTES;
    const tailStart = largeFlatTail
      ? Math.max(options.rangeChunkSize, tail.begin - options.rangeChunkSize)
      : extraLookahead ? firstPageTailHintStart(first.bytes, first.total, options.rangeChunkSize) : 0;
    if (tailStart && tail) extendedTail = preparePdfRangeHint(options, tailStart, tail.begin, {...hooks, signal}, first);
    const end = pageOne
      ? firstPageSectionEnd(first.bytes, first.total, options.rangeChunkSize) ||
        (extraLookahead ? firstImageSectionEnd(first.bytes, first.total, options.rangeChunkSize) : 0) : 0;
    for (let begin = options.rangeChunkSize; begin < end; begin += options.rangeChunkSize * 2) {
      const last = Math.min(end, begin + options.rangeChunkSize * 2);
      openingRanges.push(preparePdfRangeHint(options, begin, last, {...hooks, signal}, first));
    }
    return {...first, tail, extendedTail, openingRanges, rangeChunkSize, cancelInitial:reason => owner.abort(reason)};
  } catch (error) {
    owner.abort(error);
    throw error;
  }
}

export async function openPdfRangeTask(pdfjs, options, {signal, readBytes, limit, rangeLimit = limit, onError, initial = null,
  rangeCache = sharedPdfRangeCache(), canPrefetchFirstPage = () => false, canPrefetchOpening = () => false, admitRange = null,
  boundedMetadata = false, ratePriority = null}) {
  if (typeof pdfjs.PDFDataRangeTransport !== "function") return pdfjs.getDocument(options);
  let chunkSize = options.rangeChunkSize;
  const owner = new AbortController();
  const active = AbortSignal.any([signal, owner.signal]);
  let task = null, stopped = false, prepared = null;
  const failure = Promise.withResolvers();
  failure.promise.catch(() => {});
  const rangeWaiters = [], demandQueue = [];
  const priorityRanges = [];
  let demandScheduled = false, demandTimer = 0;
  let rangeReads = 0, metadataAdmission = false;
  // Reserve one existing transport slot for current foreground demand ranges.
  // This promotes a PDF.js demand already in the queue; it never fetches a
  // guessed page range and never raises the document's concurrency ceiling.
  const isPriority = row => priorityRanges.some(range => row.begin < range.end && row.end > range.begin);
  const drainRanges = () => {
    while (rangeWaiters.length && rangeReads < PDF_METADATA_RANGE_CONCURRENCY) {
      const priority = rangeWaiters.findIndex(isPriority);
      const index = priority >= 0 ? priority :
        (!boundedMetadata || rangeReads < PDF_METADATA_RANGE_CONCURRENCY - 1 ? 0 : -1);
      if (index < 0) return;
      rangeWaiters.splice(index,1)[0].resolve();
    }
  };
  const admitMetadata = (begin,end) => {
    if (!metadataAdmission) return Promise.resolve(null);
    active.throwIfAborted();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      rangeReads--;
      drainRanges();
    };
    const row = {begin,end};
    if (rangeReads < PDF_METADATA_RANGE_CONCURRENCY &&
        (isPriority(row) || !boundedMetadata || rangeReads < PDF_METADATA_RANGE_CONCURRENCY - 1)) {
      rangeReads++;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const waiter = {begin,end,resolve: () => {
        active.removeEventListener('abort', abort);
        rangeReads++;
        resolve(release);
      }};
      const abort = () => {
        const index = rangeWaiters.indexOf(waiter);
        if (index >= 0) rangeWaiters.splice(index, 1);
        reject(active.reason);
      };
      active.addEventListener('abort', abort, {once:true});
      rangeWaiters.push(waiter);
      if (active.aborted) abort();
    });
  };
  const stop = reason => {
    if (stopped) return;
    stopped = true;
    owner.abort(reason);
    if (demandTimer) clearTimeout(demandTimer);
    demandTimer = 0;
    for (const row of demandQueue.splice(0)) row.reject(active.reason);
    prepared?.cancelInitial?.(reason);
    signal.removeEventListener("abort", cancelled);
  };
  const cancelled = () => stop(signal.reason);
  signal.addEventListener("abort", cancelled, {once:true});
  // Optional admission for demand reads only: the bootstrap, tail and opening
  // hints are already bounded. A queued read is cancelled with its document.
  const read = async (begin, end, expected = null) => {
    const metadataRelease = await admitMetadata(begin,end);
    let release = null;
    try {
      release = admitRange ? await admitRange(active) : null;
      return await readPdfRange(options, begin, end, {signal:active, readBytes, limit, rangeLimit, rangeCache}, expected);
    } finally {
      release?.();
      metadataRelease?.();
    }
  };
  // Coalesce only queued PDF.js requests. The large-flat policy may bridge at
  // most 96 KiB in total per 256 KiB response; no future request is guessed.
  // Other documents retain the old adjacent-only, immediate-microtask path.
  const flushDemand = () => {
    demandScheduled = false;
    demandTimer = 0;
    if (active.aborted) {
      for (const row of demandQueue.splice(0)) row.reject(active.reason);
      return;
    }
    const pending = demandQueue.splice(0).sort((a, b) => a.begin - b.begin || a.end - b.end);
    const groups = [];
    for (const row of pending) {
      const previous = groups.at(-1);
      const gap = previous ? Math.max(0, row.begin - previous.end) : 0;
      const maxGap = chunkSize === PDF_LARGE_FLAT_CHUNK_BYTES ? PDF_LARGE_FLAT_GAP_BUDGET : 0;
      if (previous && previous.gapBytes + gap <= maxGap &&
          Math.max(previous.end, row.end) - previous.begin <= PDF_DEFAULT_CHUNK_BYTES) {
        previous.end = Math.max(previous.end, row.end);
        previous.gapBytes += gap;
        previous.rows.push(row);
      } else groups.push({begin:row.begin, end:row.end, rows:[row], gapBytes:0});
    }
    for (const group of groups) read(group.begin, group.end, prepared).then(result => {
      for (const row of group.rows)
        row.resolve({bytes:result.bytes.slice(row.begin - group.begin, row.end - group.begin)});
    }, error => { for (const row of group.rows) row.reject(error); });
  };
  const demand = (begin, end) => {
    if (!metadataAdmission) return read(begin, end, prepared);
    if (active.aborted) return Promise.reject(active.reason);
    return new Promise((resolve, reject) => {
      demandQueue.push({begin, end, resolve, reject});
      const priority = isPriority({begin,end});
      if (priority && demandTimer) {
        clearTimeout(demandTimer);
        demandTimer = 0;
        queueMicrotask(flushDemand);
      } else if (!demandScheduled) {
        demandScheduled = true;
        if (chunkSize === PDF_LARGE_FLAT_CHUNK_BYTES && !priority)
          demandTimer = setTimeout(flushDemand, PDF_LARGE_FLAT_BATCH_DELAY_MS);
        else queueMicrotask(flushDemand);
      }
    });
  };
  try {
    const first = prepared = await (initial || preparePdfInitialRange(options,
      {signal:active, readBytes, limit, rangeLimit, rangeCache, canPrefetchFirstPage}));
    active.throwIfAborted();
    if (!first) {
      stop();
      return pdfjs.getDocument(options);
    }
    if (first.complete) {
      stop();
      return pdfjs.getDocument({...options, data:first.bytes});
    }
    // The initial prefix and tail remain available at their original size;
    // only PDF.js's subsequent demand chunk granularity changes.
    const candidate = first.rangeChunkSize ?? choosePdfRangeChunkSize(first.bytes, first.total, options.rangeChunkSize);
    if ((candidate === PDF_ADAPTIVE_CHUNK_BYTES || candidate === PDF_LARGE_FLAT_CHUNK_BYTES) &&
        options.rangeChunkSize === PDF_DEFAULT_CHUNK_BYTES) chunkSize = candidate;
    metadataAdmission = boundedMetadata || chunkSize < options.rangeChunkSize;
    // PDF.js owns parsing and range demand; the bootstrap is the first real range.
    const transport = new pdfjs.PDFDataRangeTransport(first.total, first.bytes, true);
    transport.abort = () => stop(new DOMException("PDF transport closed", "AbortError"));
    // PDF.js parses non-linearized files from their end (trailer, then the
    // cross-reference table), demanding those chunks one round trip at a
    // time. Fetch the last two aligned chunks once, alongside its startup.
    let tail = first.tail || null;
    const extendedTail = first.extendedTail || null;
    if (!tail && first.total > chunkSize * 4) {
      const begin = Math.floor((first.total - 1) / chunkSize) * chunkSize - chunkSize;
      tail = preparePdfRangeHint(options, begin, first.total, {signal:active, readBytes, limit, rangeLimit, rangeCache}, first);
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
    const prefix = !metadataAdmission && first.total > chunkSize * 4 && openingStreamContinues && canPrefetchOpening() &&
      !openingRanges.some(range => range.begin <= chunkSize && range.end >= chunkSize * 2)
      ? {begin:chunkSize, end:chunkSize * 2,
        promise:read(chunkSize, chunkSize * 2, first).catch(() => null)}
      : null;
    const fetchOrdinaryRange = (begin, end) => prefix && begin >= prefix.begin && end <= prefix.end
      ? prefix.promise.then(result => result
        ? {bytes:result.bytes.slice(begin - prefix.begin, end - prefix.begin)}
        : demand(begin, end))
      : tail && begin >= tail.begin && end <= first.total
      ? tail.read(begin, end).then(result => result || demand(begin, end))
      : extendedTail && tail && begin >= extendedTail.begin && begin < extendedTail.end &&
        end > tail.begin && end <= first.total
      ? Promise.all([extendedTail.read(begin,extendedTail.end),tail.read(tail.begin,end)]).then(([a,b]) => {
        if (!a || !b) return demand(begin,end);
        const bytes = new Uint8Array(end-begin); bytes.set(a.bytes); bytes.set(b.bytes,a.bytes.length);
        return {bytes};
      })
      : extendedTail && begin >= extendedTail.begin && end <= extendedTail.end
      ? extendedTail.read(begin, end).then(result => result || demand(begin, end))
      : demand(begin, end);
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
      return Promise.all(parts.map(({range, from, last}) => range.read(from, last).then(result => result
        ? result.bytes
        : demand(from, last).then(row => row.bytes)))).then(values => {
        const bytes = new Uint8Array(end - begin);
        let at = 0;
        for (const value of values) { bytes.set(value, at); at += value.byteLength; }
        return {bytes};
      });
    };
    const fail = error => {
      if (stopped) return;
      failure.reject(error);
      stop(error);
      task?.destroy()?.catch?.(() => {});
      onError?.(error);
    };
    for (const hint of [tail, extendedTail, ...openingRanges]) hint?.onFailure(fail);
    /** @param {{begin?: number, end?: number}} [range] */
    const prioritizeRange = ({begin,end} = {}) => {
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > first.total) return;
      ratePriority?.(begin,end);
      // A requested range may already be in the short large-flat batching
      // window when the page worker promotes it. Flush now, without adding
      // any new range or waiting for the remainder of the timer.
      if (demandTimer && demandQueue.some(row => row.begin < end && row.end > begin)) {
        clearTimeout(demandTimer);
        demandTimer = 0;
        queueMicrotask(flushDemand);
      }
      // Keep a small rolling set of PDF.js misses. Hints only reorder existing
      // requests; they neither fetch bytes nor identify a page.
      if (priorityRanges.some(range => range.begin <= begin && range.end >= end)) { drainRanges(); return; }
      priorityRanges.push({begin,end});
      if (priorityRanges.length > 32) priorityRanges.shift();
      drainRanges();
    };
    transport.requestDataRange = (begin, end) => {
      fetchRange(begin,end).then(result => {
        for (let index=priorityRanges.length-1;index>=0;index--)
          if (begin <= priorityRanges[index].begin && end >= priorityRanges[index].end) priorityRanges.splice(index,1);
        if (!stopped) transport.onDataRange(begin,result.bytes);
      }).catch(fail);
    };
    task = pdfjs.getDocument({...options, rangeChunkSize:chunkSize, range:transport});
    task.promise.catch(error => stop(error));
    return {
      promise:Promise.race([task.promise,failure.promise]),
      prioritizeRange,
      destroy() {transport.abort();return task.destroy();}
    };
  } catch (error) {
    stop(error);
    throw error;
  }
}

export function createPdfFetchPolicy({idleMs = 15000, attemptMs = 45000,
  initialIdleMs = 10000, initialTotalMs = 120000,
  rateLimitDelayMs = 1000, rateLimitSpacingMs = 100, maxRateLimitDelayMs = 10000,
  rateLimitRecoveryMs = 3000} = {}) {
  const documents = new Set();
  const versions = new Map(), timings = [];
  const controller = new AbortController();
  const nativeFetch = globalThis.fetch;
  let version = null, inconsistent = false;
  // Shared per-document admission activates only after HTTP 429. The 100ms
  // recovery spacing is a conservative retry policy, not a claimed origin
  // limit; normal traffic is unaffected and all waiters remain cancellable.
  let throttled = false, throttleUntil = 0, nextRateStart = 0, recovering = false, rateGeneration = 0;
  const blockedUntil = new Map();
  const ratePriorityRanges = [];
  const rateAdmissions = [];
  let recoveryIdle = 0, rateTimer = 0, normalRecoveryAdmissions = 0;
  const now = () => performance.now();
  const drainRate = () => {
    clearTimeout(rateTimer); rateTimer=0;
    if (controller.signal.aborted) {
      for (const item of rateAdmissions.splice(0)) item.reject(controller.signal.reason);
      return;
    }
    if (!rateAdmissions.length) return;
    const delay=Math.max(throttleUntil,nextRateStart)-now();
    if (delay > 0) {rateTimer=setTimeout(drainRate,delay);return;}
    const priority=rateAdmissions.findIndex(item=>ratePriority(item.start,item.end,item.url));
    const chosen=rateAdmissions.splice(priority < 0 ? 0 : priority,1)[0];
    if (chosen.signal.aborted) chosen.reject(chosen.signal.reason);
    else {
      nextRateStart=now()+rateLimitSpacingMs;
      normalRecoveryAdmissions++;
      chosen.resolve();
    }
    if (rateAdmissions.length) rateTimer=setTimeout(drainRate,Math.max(0,nextRateStart-now()));
  };
  const noteRateLimit = (response,url) => {
    rateGeneration++;
    normalRecoveryAdmissions = 0;
    clearTimeout(recoveryIdle);
    const value = response.headers.get("Retry-After");
    let delay = rateLimitDelayMs;
    if (value && /^\d+$/.test(value.trim())) delay = Number(value.trim()) * 1000;
    else if (value) { const at = Date.parse(value); if (Number.isFinite(at)) delay = Math.max(0,at-Date.now()); }
    if (!Number.isFinite(delay) || delay > maxRateLimitDelayMs) {
      const until=Number.isFinite(delay) ? now()+delay : Infinity;
      blockedUntil.set(url,Math.max(blockedUntil.get(url) || 0,until));
      // A longer response must reject existing queued admissions as well as
      // future ones. Never retry before the server's announced time.
      for (let index=rateAdmissions.length-1;index>=0;index--) {
        const item=rateAdmissions[index];
        if (item.url!==url) continue;
        rateAdmissions.splice(index,1);
        item.reject(Object.assign(new Error("PDF rate limited"),{status:429,code:"READER_PDF_RATE_LIMIT",retryable:false}));
      }
      if (!rateAdmissions.length) {clearTimeout(rateTimer);rateTimer=0;}
      return false;
    }
    throttled = true;
    recovering = true;
    throttleUntil = Math.max(throttleUntil, now() + Math.max(delay,rateLimitDelayMs));
    return true;
  };
  const noteRateSuccess = generation => {
    if (!recovering || !throttled || generation !== rateGeneration) return;
    clearTimeout(recoveryIdle);
    recoveryIdle = setTimeout(() => {
      if (now() >= throttleUntil && normalRecoveryAdmissions > 0 && !rateAdmissions.length) {
        throttled = false;recovering = false;clearTimeout(rateTimer);rateTimer=0;
      }
    },rateLimitRecoveryMs);
  };
  const enqueueRangePriority = (begin,end,url) => {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin) return;
    try {url = url ? new URL(url,location.href).href : null;} catch (_) {return;}
    ratePriorityRanges.push({begin,end,url});
    if (ratePriorityRanges.length > 32) ratePriorityRanges.shift();
  };
  const ratePriority = (start,end,url) => ratePriorityRanges.some(range=>(!range.url || range.url===url) && start < range.end && end >= range.begin);
  const rateAdmission = async (signal,start,end,url) => {
    signal.throwIfAborted();
    if ((blockedUntil.get(url) || 0) > now())
      throw Object.assign(new Error("PDF rate limited"),{status:429,code:"READER_PDF_RATE_LIMIT",retryable:false});
    blockedUntil.delete(url);
    if (!throttled) return;
    let complete;
    const admitted = new Promise((resolve,reject)=>{complete={resolve,reject};});
    const row={signal,start,end,url,...complete};rateAdmissions.push(row);
    const cancel = () => {
      const index=rateAdmissions.indexOf(row);
      if (index>=0) rateAdmissions.splice(index,1);
      if (!rateAdmissions.length) {clearTimeout(rateTimer);rateTimer=0;}
      row.reject(signal.reason);
    };
    signal.addEventListener("abort",cancel,{once:true});
    if (signal.aborted) cancel();
    if (!rateTimer) drainRate();
    return admitted.finally(()=>signal.removeEventListener("abort",cancel));
  };
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
    const clearRatePriority = () => {
      if (!eligible) return;
      for (let index=ratePriorityRanges.length-1;index>=0;index--) {
        const range=ratePriorityRanges[index];
        if ((!range.url || range.url===url) && start <= range.begin && end+1 >= range.end)
          ratePriorityRanges.splice(index,1);
      }
    };
    const initialRecovery = method === "GET" && !headers.has("Range") && !conditional;
    const initialAt = performance.now();
    const admissionRemaining = () => Math.max(0, (initialRecovery ? initialTotalMs : attemptMs * 2) -
      (performance.now()-initialAt));
    let attempt = 0, rateRetried = false, record, response, reader, length = 0, delivered = 0, validator = null, stopped = false;
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
      const valid = !signal.aborted && (initialRecovery
        ? performance.now()-initialAt < initialTotalMs : eligible && (!delivered || validator));
      if (!valid) return false;
      if (error?.status === 429) return !rateRetried && error.retryable;
      return attempt === 0 && (error?.retryable || error?.name === "TimeoutError" || error instanceof TypeError);
    }
    function advance(error) {
      if (error?.status === 429) rateRetried = true;
      else attempt++;
    }
    async function open() {
      signal.throwIfAborted();
      if (eligible || initialRecovery) {
        const remaining=admissionRemaining();
        if (!remaining) throw new DOMException("PDF recovery deadline elapsed", "TimeoutError");
        const admissionSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.ceil(remaining))]);
        await rateAdmission(admissionSignal,start,end,url);
        // The Reader or caller may have closed after admission resolved but
        // before this continuation ran. Do not start even an aborted fetch.
        signal.throwIfAborted();
      }
      response = null;
      const owner = new AbortController();
      record = {owner, active:AbortSignal.any([signal,owner.signal]), generation:rateGeneration,
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
      if ((eligible || initialRecovery) && response.status === 429) {
        const retryable = noteRateLimit(response,url);
        throw Object.assign(new Error("PDF rate limited"),{retryable,status:429,code:"READER_PDF_RATE_LIMIT"});
      }
      if ((eligible || initialRecovery) && [408,500,502,503,504].includes(response.status))
        throw Object.assign(new Error("PDF temporary upstream failure"),{retryable:true});
      // PDF.js needs headers immediately to cancel the full GET and demand ranges.
      // Initial recovery must not read or wait for this potentially large body.
      if (response.ok) {
        remember(response,url);
        if (eligible || initialRecovery) noteRateSuccess(record.generation);
      }
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
      catch(error) {const retry = retryable(error);finish(error);if (!retry) throw error;advance(error);}
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
              stopped=true;clearRatePriority();finish();signal.removeEventListener("abort",abort);control.close();return;
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
            finish(error);
            while (retryable(error)) {
              advance(error);
              try {
                if (await open()) {error=null;break;}
                error = new Error("PDF_RANGE_INVALID");finish(error);
              } catch(next) {error=next;finish(error);}
            }
            if (!error) continue;
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
    get queuedAdmissions() { return rateAdmissions.length; },
    prioritizeRange: enqueueRangePriority,
    get timings() { return timings.map(row => ({...row,range:row.range?.slice() || null})); },
    dispose() {
      clearTimeout(recoveryIdle);
      clearTimeout(rateTimer);rateTimer=0;
      controller.abort(new DOMException("Reader closed", "AbortError"));
      documents.clear();
      blockedUntil.clear();
      versions.clear(); timings.length = 0;
      if (globalThis.fetch === pdfFetch) globalThis.fetch = nativeFetch;
    }
  };
}

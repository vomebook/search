import { sharedPdfRangeCache } from "./reader-pdf-range-cache.mjs";
import { PDF_ADAPTIVE_CHUNK_BYTES, PDF_LARGE_FLAT_CHUNK_BYTES, PDF_DEFAULT_CHUNK_BYTES, firstPageSectionEnd,
  firstPageTailHintStart, firstImageSectionEnd, choosePdfRangeChunkSize, adjacentXrefChunkStart }
  from "./reader-pdf-range-hints.mjs";

export const PDF_METADATA_RANGE_CONCURRENCY = 24;
const PDF_LARGE_FLAT_BATCH_DELAY_MS = 12;
const PDF_LARGE_FLAT_GAP_BUDGET = PDF_LARGE_FLAT_CHUNK_BYTES * 3;

/**
 * @template T
 * @param {PromiseLike<T>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, {once:true});
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * @typedef {{url: string, rangeChunkSize: number}} RangeOptions
 * @typedef {{total: number, etag: string | null}} RangeVersion
 * @typedef {ReturnType<typeof import('./reader-pdf-range-cache.mjs').createPdfRangeCache>} RangeCache
 * @typedef {{signal: AbortSignal, readBytes: (response: Response, limit: number) => Promise<Uint8Array>, limit: number, rangeLimit?: number, rangeCache?: RangeCache | null, canPrefetchFirstPage?: () => boolean}} RangeHooks
 * @typedef {({bytes: Uint8Array} & ((RangeVersion & {complete?: boolean}) | {total?: never, etag?: never, complete: true}))} RangeResult
 * @typedef {{begin: number, end: number}} Bounds
 * @typedef {{bytes: Uint8Array}} BytesResult
 * @typedef {ReturnType<typeof preparePdfRangeHint>} RangeHint
 * @typedef {{begin: number, end: number, hint: RangeHint | null, demanded: boolean}} AdjacentTail
 * @typedef {{tail?: RangeHint | null, extendedTail?: RangeHint | null, xrefTail?: AdjacentTail | null, openingRanges?: RangeHint[], rangeChunkSize?: number, cancelInitial?: (reason?: unknown) => void}} InitialHints
 * @typedef {RangeResult & InitialHints} InitialRange
 * @typedef {import('../../../typings/reader-pdf-engine-strict').PdfDocument} PdfDocument
 * @typedef {{promise: Promise<PdfDocument>, destroy: () => Promise<void> | void}} PdfTask
 * @typedef {{abort: () => void, requestDataRange: (begin: number, end: number) => void, onDataRange: (begin: number, bytes: Uint8Array) => void}} PdfTransport
 * @typedef {{PDFDataRangeTransport?: unknown}} PdfEngine
 * @typedef {RangeHooks & {onError?: (error: unknown) => void, initial?: Promise<InitialRange | null> | null, canPrefetchOpening?: () => boolean, admitRange?: ((signal: AbortSignal) => Promise<(() => void) | null>) | null, boundedMetadata?: boolean, ratePriority?: ((begin: number, end: number) => void) | null}} TransportHooks
 * @typedef {Bounds & {resolve: (value: BytesResult) => void, reject: (reason?: unknown) => void}} DemandRow
 * @typedef {{at: number, attempt: number, range: number[] | null, headersMs: number, bodyMs: number, bytes: number, status?: number, serverTiming?: string, totalMs?: number, error?: string}} TimingRow
 * @typedef {{owner: AbortController, active: AbortSignal, generation: number, row: TimingRow, finished?: boolean, idle?: number, deadline?: number, bodyAt?: number}} RequestRecord
 * @typedef {{signal: AbortSignal, start: number, end: number, url: string, resolve: () => void, reject: (reason?: unknown) => void}} RateAdmission
 */
// Complete bodies retain `limit`. A validated range-transport document may be
// larger (`rangeLimit`): PDF.js reserves one length-sized buffer, but only
// demanded chunks are fetched or written. See the dated large-PDF report.
/**
 * @param {RangeOptions} options @param {number} begin @param {number} end
 * @param {RangeHooks} hooks @param {RangeVersion | null} [expected]
 * @param {((version: RangeVersion) => void) | null} [onHeaders] @param {boolean} [partialOnly]
 * @returns {Promise<RangeResult | null>}
 */
async function readPdfRange(options, begin, end, {signal, readBytes, limit, rangeLimit = limit, rangeCache}, expected = null, onHeaders = null, partialOnly = false) {
  signal.throwIfAborted();
  const key = new URL(options.url, globalThis.location?.href).href;
  let cached = null;
  try {
    if (expected && expected.etag !== null)
      cached = rangeCache?.get(key, begin, Math.min(end, expected.total), {total:expected.total, etag:expected.etag});
  } catch (_) { /* Cache allocation failure must retain normal network reading. */ }
  if (cached && expected) return {bytes:cached, total:expected.total, etag:expected.etag};
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
    if (response.status !== 206 || !match) throw invalid();
    const start = Number(match[1]), last = Number(match[2]), total = Number(match[3]);
    if (![start, last, total].every(Number.isSafeInteger)) throw invalid();
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
    try { if (etag !== null) rangeCache?.put(key, start, bytes, {total, etag}); }
    catch (_) { /* Retaining an optional copy must never fail the document. */ }
    return {bytes, total, etag, complete:bytes.byteLength === total};
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
}

/** @param {RangeOptions} options @param {number} begin @param {number} end @param {RangeHooks} hooks @param {RangeVersion} expected */
function preparePdfRangeHint(options, begin, end, hooks, expected) {
  /** @type {Set<{begin: number, end: number, resolve: (value: BytesResult | null) => void}>} */
  const waiters = new Set();
  /** @type {Uint8Array | null} */
  let bytes = null;
  let loaded = 0, complete = false, failed = false;
  /** @type {unknown} */
  let failure = null;
  /** @type {((error: unknown) => void) | null} */
  let failureHandler = null;
  let published = false, notified = false;
  const notifyFailure = () => {
    if (!failed || !published || notified || !failureHandler || hooks.signal.aborted) return;
    notified = true;
    failureHandler(failure);
  };
  const flush = () => {
    for (const waiter of waiters) {
      if (failed) { waiters.delete(waiter); waiter.resolve(null); continue; }
      if (!bytes || loaded < waiter.end - begin || (!complete && waiter.end === end)) continue;
      waiters.delete(waiter);
      published = true;
      // Each PDF.js range reader accepts one complete, exact requested buffer.
      // A proper subrange must not wait for unrelated trailing hint bytes/EOF.
      waiter.resolve({bytes:bytes.slice(waiter.begin - begin, waiter.end - begin)});
    }
  };
  /** @param {unknown} error */
  const failHint = error => {
    failure = error;
    failed = true;
    flush();
    // If a proper subrange was already used, a malformed/truncated remainder
    // must invalidate that document, not silently leave an accepted bad stream.
    notifyFailure();
    return null;
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
    if (!result) return failHint(new Error("PDF_RANGE_INVALID"));
    bytes = result.bytes;
    loaded = bytes.byteLength;
    complete = true;
    flush();
    return result;
  }, failHint);
  return {
    begin, end, promise,
    /** @param {number} from @param {number} last */
    read(from, last) {
      if (from < begin || last > end || last <= from) return Promise.reject(new Error("PDF_RANGE_INVALID"));
      /** @type {PromiseWithResolvers<BytesResult | null>} */
      const pending = Promise.withResolvers();
      waiters.add({begin:from, end:last, resolve:pending.resolve});
      flush();
      return pending.promise;
    },
    /** @param {(error: unknown) => void} handler */
    onFailure(handler) { failureHandler = handler; notifyFailure(); }
  };
}

// The first demand overlaps engine preparation. After its complete validation,
// qualified page-one files may overlap bounded opening or tail range hints.
/** @param {RangeOptions} options @param {RangeHooks} hooks
 * @returns {Promise<(InitialRange & {rangeChunkSize: number}) | null>}
 */
export async function preparePdfInitialRange(options, hooks) {
  hooks = {...hooks, rangeCache:hooks.rangeCache === undefined ? sharedPdfRangeCache() : hooks.rangeCache};
  const owner = new AbortController();
  const signal = AbortSignal.any([hooks.signal, owner.signal]);
  /** @type {{tail: RangeHint | null}} */
  const hints = {tail:null};
  /** @type {RangeHint | null} */
  let extendedTail = null;
  try {
    /** @param {RangeVersion} metadata */
    const onHeaders = metadata => {
      if (metadata.total <= options.rangeChunkSize * 4) return;
      // Start the existing two-chunk tail on validated headers, not after the
      // first body finishes. This changes scheduling, not the fetched range.
      const begin = Math.floor((metadata.total - 1) / options.rangeChunkSize) * options.rangeChunkSize - options.rangeChunkSize;
      hints.tail = preparePdfRangeHint(options, begin, metadata.total, {...hooks, signal}, metadata);
    };
    /** @type {RangeResult | null} */
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
        try { bytes = hooks.rangeCache?.get(key, 0, Math.min(options.rangeChunkSize, previous.total), previous); } catch (_) {}
        if (bytes) {
          first = {bytes, total:previous.total, etag:previous.etag, complete:bytes.byteLength === previous.total};
          if (!first.complete) onHeaders(first);
        }
      }
    }
    first ||= await readPdfRange(options, 0, options.rangeChunkSize, {...hooks, signal}, null, onHeaders);
    if (!first) { owner.abort(); return null; }
    const currentTail = hints.tail;
    /** @type {RangeHint[]} */
    const openingRanges = [];
    /** @param {unknown} [reason] */
    const cancelInitial = reason => owner.abort(reason);
    // A complete 200 has no range metadata; do not run range scheduling on it.
    if (first.total === undefined || first.etag === undefined)
      return {...first, tail:currentTail, extendedTail, xrefTail:null, openingRanges, rangeChunkSize:options.rangeChunkSize, cancelInitial};
    const metadata = {total:first.total, etag:first.etag};
    const pageOne = !first.complete && hooks.canPrefetchFirstPage?.();
    const connection = /** @type {(Navigator & {connection?: {saveData?: boolean, effectiveType?: string}}) | undefined} */ (globalThis.navigator)?.connection;
    const allowLookahead = !connection?.saveData && connection?.effectiveType !== "slow-2g" && connection?.effectiveType !== "2g";
    const extraLookahead = pageOne && allowLookahead;
    const rangeChunkSize = first.complete ? options.rangeChunkSize :
      choosePdfRangeChunkSize(first.bytes, metadata.total, options.rangeChunkSize);
    // The ordinary tail ends after startxref but some flat files store a
    // large xref immediately before it. One extra chunk avoids serial tiny
    // reads; it remains ETag-bound and is suppressed for data-saving modes.
    const largeFlatTail = allowLookahead && metadata.total > options.rangeChunkSize * 6 && rangeChunkSize === PDF_LARGE_FLAT_CHUNK_BYTES;
    const tailStart = largeFlatTail && currentTail
      ? Math.max(options.rangeChunkSize, currentTail.begin - options.rangeChunkSize)
      : extraLookahead ? firstPageTailHintStart(first.bytes, metadata.total, options.rangeChunkSize) : 0;
    if (tailStart && currentTail) extendedTail = preparePdfRangeHint(options, tailStart, currentTail.begin, {...hooks, signal}, metadata);
    // A wide, classic xref (or a distant xref stream) can start one chunk
    // before the normal trailer hint. Read at most that adjacent chunk, and
    // only after the whole trailer range has passed its byte/ETag checks.
    /** @type {AdjacentTail | null} */
    const xrefTail = extraLookahead && currentTail && !extendedTail && rangeChunkSize === PDF_DEFAULT_CHUNK_BYTES &&
      !/\/Linearized\b/.test(new TextDecoder("latin1").decode(first.bytes.subarray(0, 1024)))
      ? {begin:currentTail.begin - rangeChunkSize, end:currentTail.begin, hint:null, demanded:false} : null;
    if (xrefTail && currentTail) void currentTail.promise.then(result => {
      if (!result || signal.aborted || xrefTail.demanded || !hooks.canPrefetchFirstPage?.()) return;
      const begin = adjacentXrefChunkStart(result.bytes, xrefTail.end, rangeChunkSize);
      if (begin) xrefTail.hint = preparePdfRangeHint(options, begin, xrefTail.end, {...hooks, signal}, metadata);
    }).catch(() => {});
    const end = pageOne
      ? firstPageSectionEnd(first.bytes, metadata.total, options.rangeChunkSize) ||
        (extraLookahead ? firstImageSectionEnd(first.bytes, metadata.total, options.rangeChunkSize) : 0) : 0;
    for (let begin = options.rangeChunkSize; begin < end; begin += options.rangeChunkSize * 2) {
      const last = Math.min(end, begin + options.rangeChunkSize * 2);
      openingRanges.push(preparePdfRangeHint(options, begin, last, {...hooks, signal}, metadata));
    }
    return {...first, tail:currentTail, extendedTail, xrefTail, openingRanges, rangeChunkSize, cancelInitial};
  } catch (error) {
    owner.abort(error);
    throw error;
  }
}

/** @param {PdfEngine} pdfjs @param {RangeOptions} options @param {TransportHooks} hooks */
export async function openPdfRangeTask(pdfjs, options, {signal, readBytes, limit, rangeLimit = limit, onError, initial = null,
  rangeCache = sharedPdfRangeCache(), canPrefetchFirstPage = () => false, canPrefetchOpening = () => false, admitRange = null,
  boundedMetadata = false, ratePriority = null}) {
  const engine = /** @type {PdfEngine & {getDocument: (options: RangeOptions & {data?: Uint8Array, range?: PdfTransport}) => PdfTask, PDFDataRangeTransport?: new (total: number, bytes: Uint8Array, progressiveDone: boolean) => PdfTransport}} */ (pdfjs);
  if (typeof engine.PDFDataRangeTransport !== "function") return engine.getDocument(options);
  let chunkSize = options.rangeChunkSize;
  const owner = new AbortController();
  const active = AbortSignal.any([signal, owner.signal]);
  /** @type {PdfTask | null} */
  let task = null;
  /** @type {InitialRange | null} */
  let prepared = null;
  /** @type {RangeVersion | null} */
  let version = null;
  let stopped = false;
  /** @type {PromiseWithResolvers<never>} */
  const failure = Promise.withResolvers();
  failure.promise.catch(() => {});
  /** @type {(Bounds & {resolve: () => void})[]} */
  const rangeWaiters = [];
  /** @type {DemandRow[]} */
  const demandQueue = [];
  /** @type {Bounds[]} */
  const priorityRanges = [];
  let demandScheduled = false, demandTimer = 0;
  let rangeReads = 0, metadataAdmission = false;
  // Reserve one existing transport slot for current foreground demand ranges.
  // This promotes a PDF.js demand already in the queue; it never fetches a
  // guessed page range and never raises the document's concurrency ceiling.
  /** @param {Bounds} row */
  const isPriority = row => priorityRanges.some(range => row.begin < range.end && row.end > range.begin);
  const drainRanges = () => {
    while (rangeWaiters.length && rangeReads < PDF_METADATA_RANGE_CONCURRENCY) {
      const priority = rangeWaiters.findIndex(isPriority);
      const index = priority >= 0 ? priority :
        (!boundedMetadata || rangeReads < PDF_METADATA_RANGE_CONCURRENCY - 1 ? 0 : -1);
      if (index < 0) return;
      const [waiter] = rangeWaiters.splice(index,1);
      if (waiter) waiter.resolve();
    }
  };
  /** @param {number} begin @param {number} end @returns {Promise<(() => void) | null>} */
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
  /** @param {unknown} [reason] */
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
  /** @param {number} begin @param {number} end */
  const read = async (begin, end) => {
    const expected = version;
    if (!expected) throw new Error("PDF_RANGE_INVALID");
    const metadataRelease = await admitMetadata(begin,end);
    let release = null;
    try {
      release = admitRange ? await admitRange(active) : null;
      const result = await readPdfRange(options, begin, end, {signal:active, readBytes, limit, rangeLimit, rangeCache}, expected);
      if (!result) throw new Error("PDF_RANGE_INVALID");
      return result;
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
    /** @type {(Bounds & {rows: DemandRow[], gapBytes: number})[]} */
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
    for (const group of groups) read(group.begin, group.end).then(result => {
      for (const row of group.rows)
        row.resolve({bytes:result.bytes.slice(row.begin - group.begin, row.end - group.begin)});
    }, error => { for (const row of group.rows) row.reject(error); });
  };
  /** @param {number} begin @param {number} end @returns {Promise<BytesResult>} */
  const demand = (begin, end) => {
    if (!metadataAdmission) return read(begin, end);
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
      return engine.getDocument(options);
    }
    if (first.complete) {
      stop();
      return engine.getDocument({...options, data:first.bytes});
    }
    // The initial prefix and tail remain available at their original size;
    // only PDF.js's subsequent demand chunk granularity changes.
    const {total, etag} = first;
    if (total === undefined || etag === undefined) throw new Error("PDF_RANGE_INVALID");
    version = {total, etag};
    const candidate = first.rangeChunkSize ?? choosePdfRangeChunkSize(first.bytes, total, options.rangeChunkSize);
    if ((candidate === PDF_ADAPTIVE_CHUNK_BYTES || candidate === PDF_LARGE_FLAT_CHUNK_BYTES) &&
        options.rangeChunkSize === PDF_DEFAULT_CHUNK_BYTES) chunkSize = candidate;
    metadataAdmission = boundedMetadata || chunkSize < options.rangeChunkSize;
    // PDF.js owns parsing and range demand; the bootstrap is the first real range.
    const transport = new engine.PDFDataRangeTransport(total, first.bytes, true);
    transport.abort = () => stop(new DOMException("PDF transport closed", "AbortError"));
    // PDF.js parses non-linearized files from their end (trailer, then the
    // cross-reference table), demanding those chunks one round trip at a
    // time. Fetch the last two aligned chunks once, alongside its startup.
    let tail = first.tail || null;
    const extendedTail = first.extendedTail || null;
    if (!tail && total > chunkSize * 4) {
      const begin = Math.floor((total - 1) / chunkSize) * chunkSize - chunkSize;
      tail = preparePdfRangeHint(options, begin, total, {signal:active, readBytes, limit, rangeLimit, rangeCache}, version);
    }
    // A conservative read-ahead hint, not a PDF parser: only a direct Length
    // before the first stream, in the bounded opening header, can qualify.
    // Missing/indirect/complete streams retain ordinary PDF.js range demand.
    const header = new TextDecoder("latin1").decode(first.bytes.subarray(0, 4096));
    const stream = /\bstream(?:\r\n|\r|\n)/.exec(header);
    const length = stream && /\/Length\s+(\d+)(?:\s+\d+\s+R)?(?=[\s/>])/.exec(header.slice(0, stream.index));
    const streamEnd = length && stream.index + stream[0].length + Number(length[1]);
    const openingStreamContinues = length && !/\sR$/.test(length[0]) && streamEnd !== null && Number.isSafeInteger(streamEnd) &&
      streamEnd > first.bytes.byteLength && streamEnd <= total;
    // One chunk only; deep restorations and non-v3/native URLs do not opt in.
    const openingRanges = first.openingRanges || [];
    const prefix = !metadataAdmission && total > chunkSize * 4 && openingStreamContinues && canPrefetchOpening() &&
      !openingRanges.some(range => range.begin <= chunkSize && range.end >= chunkSize * 2)
      ? {begin:chunkSize, end:chunkSize * 2,
        promise:read(chunkSize, chunkSize * 2).catch(() => null)}
      : null;
    /** @param {number} begin @param {number} end */
    const fetchOrdinaryRange = (begin, end) => prefix && begin >= prefix.begin && end <= prefix.end
      ? prefix.promise.then(result => result
        ? {bytes:result.bytes.slice(begin - prefix.begin, end - prefix.begin)}
        : demand(begin, end))
      : tail && begin >= tail.begin && end <= total
      ? tail.read(begin, end).then(result => result || demand(begin, end))
      : extendedTail && tail && begin >= extendedTail.begin && begin < extendedTail.end &&
        end > tail.begin && end <= total
      ? Promise.all([extendedTail.read(begin,extendedTail.end),tail.read(tail.begin,end)]).then(([a,b]) => {
        if (!a || !b) return demand(begin,end);
        const bytes = new Uint8Array(end-begin); bytes.set(a.bytes); bytes.set(b.bytes,a.bytes.length);
        return {bytes};
      })
      : extendedTail && begin >= extendedTail.begin && end <= extendedTail.end
      ? extendedTail.read(begin, end).then(result => result || demand(begin, end))
      : readAdjacentXref(begin, end);
    /** @param {number} begin @param {number} end */
    const readAdjacentXref = (begin, end) => {
      const adjacent = first.xrefTail;
      if (adjacent && begin < adjacent.end && end > adjacent.begin) {
        const hint = adjacent.hint;
        if (hint && begin >= hint.begin && end <= hint.end) {
          hint.onFailure(fail);
          return hint.read(begin, end).then(result => result || demand(begin, end));
        }
        // Do not wait for the trailer, or fetch a second copy once PDF.js asks.
        adjacent.demanded = true;
      }
      return demand(begin, end);
    };
    /** @param {number} begin @param {number} end */
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
    /** @param {unknown} error */
    const fail = error => {
      if (stopped) return;
      failure.reject(error);
      stop(error);
      const destroyed = task?.destroy();
      if (destroyed) destroyed.catch?.(() => {});
      onError?.(error);
    };
    for (const hint of [tail, extendedTail, ...openingRanges]) hint?.onFailure(fail);
    /** @param {{begin?: number, end?: number}} [range] */
    const prioritizeRange = ({begin,end} = {}) => {
      if (typeof begin !== "number" || typeof end !== "number" || !Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > total) return;
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
        for (let index=priorityRanges.length-1;index>=0;index--) {
          const row = priorityRanges[index];
          if (row && begin <= row.begin && end >= row.end) priorityRanges.splice(index,1);
        }
        if (!stopped) transport.onDataRange(begin,result.bytes);
      }).catch(fail);
    };
    task = engine.getDocument({...options, rangeChunkSize:chunkSize, range:transport});
    const activeTask = task;
    activeTask.promise.catch(error => stop(error));
    return {
      promise:Promise.race([activeTask.promise,failure.promise]),
      prioritizeRange,
      destroy() {transport.abort();return activeTask.destroy();}
    };
  } catch (error) {
    stop(error);
    throw error;
  }
}

/**
 * @param {{idleMs?: number, attemptMs?: number, initialIdleMs?: number,
 *   initialTotalMs?: number, rateLimitDelayMs?: number, rateLimitSpacingMs?: number,
 *   maxRateLimitDelayMs?: number, rateLimitRecoveryMs?: number}} [options]
 */
export function createPdfFetchPolicy({idleMs = 15000, attemptMs = 45000,
  initialIdleMs = 10000, initialTotalMs = 120000,
  rateLimitDelayMs = 1000, rateLimitSpacingMs = 100, maxRateLimitDelayMs = 10000,
  rateLimitRecoveryMs = 3000} = {}) {
  /** @type {Set<string>} */
  const documents = new Set();
  /** @type {Map<string, string>} */
  const versions = new Map();
  /** @type {TimingRow[]} */
  const timings = [];
  const controller = new AbortController();
  const nativeFetch = globalThis.fetch;
  /** @type {string | null} */
  let version = null;
  let inconsistent = false;
  // Shared per-document admission activates only after HTTP 429. The 100ms
  // recovery spacing is a conservative retry policy, not a claimed origin
  // limit; normal traffic is unaffected and all waiters remain cancellable.
  let throttled = false, throttleUntil = 0, nextRateStart = 0, recovering = false, rateGeneration = 0;
  /** @type {Map<string, number>} */
  const blockedUntil = new Map();
  /** @type {(Bounds & {url: string | null})[]} */
  const ratePriorityRanges = [];
  /** @type {RateAdmission[]} */
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
    const [chosen]=rateAdmissions.splice(priority < 0 ? 0 : priority,1);
    if (!chosen) return;
    if (chosen.signal.aborted) chosen.reject(chosen.signal.reason);
    else {
      nextRateStart=now()+rateLimitSpacingMs;
      normalRecoveryAdmissions++;
      chosen.resolve();
    }
    if (rateAdmissions.length) rateTimer=setTimeout(drainRate,Math.max(0,nextRateStart-now()));
  };
  /** @param {Response} response @param {string} url */
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
        if (!item || item.url!==url) continue;
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
  /** @param {number} generation */
  const noteRateSuccess = generation => {
    if (!recovering || !throttled || generation !== rateGeneration) return;
    clearTimeout(recoveryIdle);
    recoveryIdle = setTimeout(() => {
      if (now() >= throttleUntil && normalRecoveryAdmissions > 0 && !rateAdmissions.length) {
        throttled = false;recovering = false;clearTimeout(rateTimer);rateTimer=0;
      }
    },rateLimitRecoveryMs);
  };
  /** @param {number} begin @param {number} end @param {string | null} [url] */
  const enqueueRangePriority = (begin,end,url) => {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin) return;
    try {url = url ? new URL(url,location.href).href : null;} catch (_) {return;}
    ratePriorityRanges.push({begin,end,url});
    if (ratePriorityRanges.length > 32) ratePriorityRanges.shift();
  };
  /** @param {number} start @param {number} end @param {string} url */
  const ratePriority = (start,end,url) => ratePriorityRanges.some(range=>(!range.url || range.url===url) && start < range.end && end >= range.begin);
  /** @param {AbortSignal} signal @param {number} start @param {number} end @param {string} url */
  const rateAdmission = async (signal,start,end,url) => {
    signal.throwIfAborted();
    if ((blockedUntil.get(url) || 0) > now())
      throw Object.assign(new Error("PDF rate limited"),{status:429,code:"READER_PDF_RATE_LIMIT",retryable:false});
    blockedUntil.delete(url);
    if (!throttled) return;
    /** @type {{resolve: () => void, reject: (reason?: unknown) => void} | undefined} */
    let complete;
    /** @type {Promise<void>} */
    const admitted = new Promise((resolve,reject)=>{complete={resolve,reject};});
    const row={signal,start,end,url,.../** @type {{resolve: () => void, reject: (reason?: unknown) => void}} */ (complete)};rateAdmissions.push(row);
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
  /** @param {Response} response @param {string} url */
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
  /** @type {typeof fetch} */
  const pdfFetch = async (input, init) => {
    /** @type {string} */
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
        if (range && (!range.url || range.url===url) && start <= range.begin && end+1 >= range.end)
          ratePriorityRanges.splice(index,1);
      }
    };
    const initialRecovery = method === "GET" && !headers.has("Range") && !conditional;
    const initialAt = performance.now();
    const admissionRemaining = () => Math.max(0, (initialRecovery ? initialTotalMs : attemptMs * 2) -
      (performance.now()-initialAt));
    let attempt = 0, rateRetried = false, length = 0, delivered = 0, stopped = false;
    /** @type {RequestRecord} */
    let record;
    /** @type {Response | null} */
    let response = null;
    /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
    let reader = null;
    /** @type {string | null} */
    let validator = null;
    /** @param {unknown} [error] */
    function finish(error = null) {
      if (!record || record.finished) return;
      record.finished = true;
      clearTimeout(record.idle); clearTimeout(record.deadline);
      const row = record.row;
      if (error) {
        row.error = signal.aborted ? "cancelled" : /** @type {{name?: string}} */ (error).name === "TimeoutError" ? "timeout" : "failure";
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
    /** @param {unknown} cause */
    function retryable(cause) {
      const error = /** @type {{status?: number, retryable?: boolean, name?: string} | null} */ (cause);
      const valid = !signal.aborted && (initialRecovery
        ? performance.now()-initialAt < initialTotalMs : eligible && (!delivered || validator));
      if (!valid) return false;
      if (error?.status === 429) return !rateRetried && error.retryable;
      return attempt === 0 && (error?.retryable || error?.name === "TimeoutError" || error instanceof TypeError);
    }
    /** @param {unknown} cause */
    function advance(cause) {
      const error = /** @type {{status?: number} | null} */ (cause);
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
      const received = await abortable(Promise.resolve(nativeFetch.call(globalThis,input,{...init,cache:"no-store",signal:record.active}))
        .then(value => {
          if (owner.signal.aborted || signal.aborted) {value.body?.cancel().catch(() => {});throw record.active.reason;}
          return value;
        }),record.active);
      response = received;
      record.row.headersMs = performance.now()-record.row.at;
      record.row.status = received.status;
      record.row.serverTiming = (received.headers.get("Server-Timing") || "").slice(0,512);
      if ((eligible || initialRecovery) && received.status === 429) {
        const retryable = noteRateLimit(received,url);
        throw Object.assign(new Error("PDF rate limited"),{retryable,status:429,code:"READER_PDF_RATE_LIMIT"});
      }
      if ((eligible || initialRecovery) && [408,500,502,503,504].includes(received.status))
        throw Object.assign(new Error("PDF temporary upstream failure"),{retryable:true});
      // PDF.js needs headers immediately to cancel the full GET and demand ranges.
      // Initial recovery must not read or wait for this potentially large body.
      if (received.ok) {
        remember(received,url);
        if (eligible || initialRecovery) noteRateSuccess(record.generation);
      }
      if (!eligible || received.status !== 206) {
        if (delivered) throw new Error("PDF_RANGE_INVALID");
        return false;
      }
      const actual = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(received.headers.get("Content-Range") || "");
      if (!actual || actual.slice(1).some(value=>!Number.isSafeInteger(Number(value))) ||
          Number(actual[1]) !== start || Number(actual[2]) !== Math.min(end,Number(actual[3])-1) || Number(actual[3]) <= start)
        throw new Error("PDF_RANGE_INVALID");
      const size = Number(actual[2])-start+1, etag = received.headers.get("ETag");
      if (delivered && (etag !== validator || size !== length)) throw new Error("PDF_SOURCE_CHANGED");
      length = size;
      validator = /^"[^"\r\n]+"$/.test(etag || "") ? etag : null;
      reader = /** @type {ReadableStream<Uint8Array>} */ (received.body).getReader();
      record.bodyAt = performance.now();
      clearTimeout(record.idle); clearTimeout(record.deadline);
      return true;
    }
    let streaming;
    while (true) {
      try {streaming = await open();break;}
      catch(error) {const retry = retryable(error);finish(error);if (!retry) throw error;advance(error);}
    }
    if (!streaming) {finish();return /** @type {Response} */ (/** @type {unknown} */ (response));}
    const firstResponse = /** @type {Response} */ (/** @type {unknown} */ (response));
    /** @type {ReadableStreamDefaultController<Uint8Array>} */
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
            const chunk = await abortable(/** @type {ReadableStreamDefaultReader<Uint8Array>} */ (reader).read(),record.active);
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
    /** @param {Iterable<string>} urls */
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

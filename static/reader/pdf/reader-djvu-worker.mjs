// Serialize requests to one decoder worker. A fatal error, timeout or opening
// abort always terminates the worker and settles the outstanding operation.
/** @typedef {{total: number, read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>,
 * close(): void, readonly failure?: unknown}} DjvuRangeReader */
/** @typedef {{id: number, resolve(value: Record<string, unknown>): void, reject(reason?: unknown): void}} DjvuTask */
/** @typedef {{t: string, x: number, y: number, w: number, h: number}} DjvuTextZone */
/** @typedef {{title: string, depth: number, page: number}} DjvuOutlineEntry */
/** @typedef {{width: number, height: number, dpi: number, rotation: number}} DjvuGeometry */
/** @typedef {{rangeId: number, offset: number, length: number}} DjvuRangeRequest */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && (typeof value === 'object' || typeof value === 'function'); }

/** @param {unknown} value @returns {value is number} */
function isNonNegativeFinite(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

/** @param {unknown} value @param {number} min @param {number} max @returns {value is number} */
function isIntegerInRange(value, min, max) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** @param {Record<string, unknown>} value @param {number} minDpi @param {number} maxDpi @param {number} maxPixels
 * @returns {value is Record<string, unknown> & DjvuGeometry} */
function isGeometry(value, minDpi, maxDpi, maxPixels) {
  const {width, height, dpi, rotation} = value;
  return isIntegerInRange(width, 1, Number.MAX_SAFE_INTEGER) && isIntegerInRange(height, 1, Number.MAX_SAFE_INTEGER) &&
    isIntegerInRange(dpi, minDpi, maxDpi) && typeof rotation === 'number' && [0,90,180,270].includes(rotation) &&
    !(width * height > maxPixels);
}

/** @param {unknown} offset @param {unknown} length @param {number} total */
function isRangeWindow(offset, length, total) {
  return isIntegerInRange(offset, 0, Number.MAX_SAFE_INTEGER) && isIntegerInRange(length, 1, 65536) && !(offset + length > total);
}

/** @param {Record<string, unknown>} data @param {number} total
 * @returns {data is Record<string, unknown> & DjvuRangeRequest} */
function isRangeRequest(data, total) {
  return isIntegerInRange(data.rangeId, 1, Number.MAX_SAFE_INTEGER) && isRangeWindow(data.offset, data.length, total);
}

/** @param {unknown} error */
function rangeErrorCode(error) {
  const details = isRecord(error) ? error : null;
  if (typeof details?.code === 'string' && /^DJVU_[A-Z_]+$/.test(details.code)) return details.code;
  if (typeof details?.message === 'string' && /^DJVU_[A-Z_]+$/.test(details.message)) return details.message;
  return 'DJVU_RANGE_FAILED';
}

/** @param {unknown} value @returns {value is DjvuTextZone} */
function isTextZone(value) {
  return isRecord(value) && typeof value.t === 'string' && value.t.length <= 4000 &&
    isNonNegativeFinite(value.x) && isNonNegativeFinite(value.y) &&
    isNonNegativeFinite(value.w) && isNonNegativeFinite(value.h);
}

/** @param {unknown} value @returns {value is DjvuOutlineEntry} */
function isOutlineEntry(value) {
  return isRecord(value) && typeof value.title === 'string' && value.title.length <= 1000 &&
    isIntegerInRange(value.depth, 0, 32) && typeof value.page === 'number' && Number.isSafeInteger(value.page);
}

/** @param {string | URL} workerUrl
 * @param {{maxPixels?: number, timeoutMs?: number, cacheBytes?: number | undefined,
 * rangeReader?: DjvuRangeReader | null | undefined, createWorker?: ((url: string | URL) => Worker) | undefined}} [options] */
export function createDjvuWorkerAdapter(workerUrl, { maxPixels = 50_000_000, timeoutMs = 60000,
  cacheBytes = 32 * 1024 * 1024, rangeReader = null, createWorker = url => new Worker(url, { type: 'module' }) } = {}) {
  const worker = createWorker(workerUrl);
  let closed = false, sequence = 0, pageCount = 0, outlineNeedsFullSource = false, outstandingRange = 0;
  /** @type {unknown} */
  let fatal = null;
  /** @type {DjvuTask | null} */
  let active = null;
  const abort = () => new DOMException('DjVu task cancelled', 'AbortError');
  /** @param {unknown} [reason] */
  function close(reason = abort()) {
    if (closed) return;
    closed = true; fatal = reason;
    worker.terminate();rangeReader?.close();
    active?.reject(reason);
    active = null;
  }
  worker.onerror = event => close(Object.assign(new Error('DJVU_WORKER_FAILED'), { cause: event.message }));
  worker.onmessageerror = () => close(new Error('DJVU_WORKER_MESSAGE_FAILED'));
  /** @param {Record<string, unknown>} data */
  function handleRange(data) {
    const reader = rangeReader;
    if (!reader || !active || data.id !== active.id || outstandingRange || !isRangeRequest(data, reader.total)) {
      close(new Error('DJVU_WORKER_PROTOCOL'));return;
    }
    const {id, rangeId, offset, length} = data;
    outstandingRange=rangeId;
    Promise.resolve().then(()=>reader.read(offset,length)).then(bytes=>{
      if (closed || active?.id !== id) return;
      const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
      outstandingRange=0;
      worker.postMessage({id,operation:'range-result',rangeId,ok:true,bytes:buffer},[buffer]);
    }).catch(error=>{
      if (closed || active?.id !== id) return;
      const code=rangeErrorCode(error);
      outstandingRange=0;
      worker.postMessage({id,operation:'range-result',rangeId,ok:false,error:code});
      if (reader.failure) close(reader.failure);
    });
  }
  worker.onmessage = event => {
    /** @type {unknown} */
    const data = event.data;
    if (!isRecord(data)) { close(new Error('DJVU_WORKER_PROTOCOL')); return; }
    if (data.operation === 'range') { handleRange(data); return; }
    if (!active || data.id !== active.id) { close(new Error('DJVU_WORKER_PROTOCOL')); return; }
    const task = active;
    active = null;
    if (data.ok === true) task.resolve(data);
    else if (data.ok === false && typeof data.error === 'string' && /^DJVU_[A-Z_]+$/.test(data.error || ''))
      task.reject(new Error(data.error));
    else { active = task; close(new Error('DJVU_WORKER_PROTOCOL')); }
  };
  /** @param {number} id */
  function clearTask(id) { if (active?.id === id) active = null; }
  /** @param {AbortSignal} [signal] */
  function checkAvailable(signal) {
    if (closed) throw fatal || abort();
    if (signal?.aborted) { const reason = signal.reason || abort(); close(reason); throw reason; }
    if (active) throw new Error('DJVU_ADAPTER_CONCURRENT_TASK');
  }
  /** @param {string} operation @param {Record<string, unknown>} [data]
   * @param {{signal?: AbortSignal | undefined, transfer?: Transferable[]}} [options] */
  async function request(operation, data = {}, options = {}) {
    const { signal, transfer = [] } = options;
    checkAvailable(signal);
    const id = ++sequence;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {(() => void) | undefined} */
    let onAbort;
    try {
      return await new Promise((resolve, reject) => {
        active = { id, resolve, reject };
        timer = setTimeout(() => close(new Error('DJVU_WORKER_TIMEOUT')), timeoutMs);
        onAbort = () => close(signal?.reason || abort());
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        try { worker.postMessage({ id, operation, ...data }, transfer); }
        catch (error) { close(Object.assign(new Error('DJVU_WORKER_FAILED'), { cause: error })); }
      });
    } finally {
      clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort);
      clearTask(id);
    }
  }
  /** @param {ArrayBuffer | undefined} bytes @param {AbortSignal} [signal] */
  async function open(bytes, signal) {
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > 512 * 1024 * 1024)
      throw new Error('DJVU_DOCUMENT_INVALID');
    try {
      const value = await request('open', { bytes, cacheBytes }, { signal, transfer: [bytes] });
      if (typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 10000)
        throw new Error('DJVU_PAGE_COUNT_INVALID');
      pageCount = value.count;
      return pageCount;
    } catch (error) { close(error); throw error; }
  }
  /** @param {AbortSignal} [signal] */
  async function prepare(signal) {
    try { await request('prepare', {}, {signal}); }
    catch (error) { close(error); throw error; }
  }
  /** @param {AbortSignal} [signal] */
  async function openRange(signal) {
    if (!rangeReader || !Number.isSafeInteger(rangeReader.total) || rangeReader.total < 16 || rangeReader.total > 512*1024*1024)
      throw new Error('DJVU_DOCUMENT_INVALID');
    try {
      const value=await request('open-range',{total:rangeReader.total,cacheBytes},{signal});
      if (typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 10000)
        throw new Error('DJVU_PAGE_COUNT_INVALID');
      outlineNeedsFullSource=value.outlineNeedsFullSource===true;
      pageCount=value.count;return pageCount;
    } catch(error){close(error);throw error;}
  }
  /** @param {number} number @param {AbortSignal} [signal] */
  async function page(number, signal) {
    if (!Number.isSafeInteger(number) || number < 1 || number > pageCount) throw new Error('DJVU_PAGE_INVALID');
    const value = await request('page', { page: number }, { signal });
    if (!isGeometry(value, 1, Number.MAX_SAFE_INTEGER, maxPixels) || !(value.pixels instanceof ArrayBuffer) ||
        value.pixels.byteLength !== value.width * value.height * 4) throw new Error('DJVU_PAGE_DECODE_INVALID');
    const {width, height, dpi, rotation, pixels} = value;
    return { image: new ImageData(new Uint8ClampedArray(pixels), width, height), width, height, dpi, rotation };
  }
  /** @param {number} number */
  async function geometry(number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > pageCount) throw new Error('DJVU_PAGE_INVALID');
    const value = await request('geometry', {page:number});
    if (!isGeometry(value, 25, 6000, maxPixels)) throw new Error('DJVU_PAGE_GEOMETRY_INVALID');
    const {width,height,dpi,rotation} = value;
    return {width,height,dpi,rotation};
  }
  /** @param {number} number */
  async function text(number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > pageCount) throw new Error('DJVU_PAGE_INVALID');
    const {text, zones} = await request('text', {page:number});
    if (typeof text !== 'string' || text.length > 2_000_000 || !Array.isArray(zones) || zones.length > 20_000 ||
        !zones.every(isTextZone)) throw new Error('DJVU_TEXT_INVALID');
    return {text,zones};
  }
  /** @param {AbortSignal} [signal] */
  async function outline(signal) {
    const { entries } = await request('outline', {}, { signal });
    if (!Array.isArray(entries) || entries.length > 2000 || !entries.every(isOutlineEntry) || entries.some((entry, index) =>
      (index === 0 ? entry.depth !== 0 : entry.depth > (entries[index - 1]?.depth ?? -2) + 1) ||
      entry.page < 0 || entry.page > pageCount)) throw new Error('DJVU_OUTLINE_INVALID');
    return entries;
  }
  async function stats() {
    const value = await request('stats');
    if (typeof value.cacheBytes !== 'number' || !Number.isSafeInteger(value.cacheBytes) || value.cacheBytes < 0) throw new Error('DJVU_WORKER_PROTOCOL');
    return { decodedCacheBytes: value.cacheBytes };
  }
  return { prepare, open, openRange, page, geometry, text, outline, stats, close,
    get outlineNeedsFullSource() {return outlineNeedsFullSource;}, get closed() { return closed; } };
}

// Serialize requests to one decoder worker. A fatal error, timeout or opening
// abort always terminates the worker and settles the outstanding operation.
export function createDjvuWorkerAdapter(workerUrl, { maxPixels = 50_000_000, timeoutMs = 60000,
  cacheBytes = 32 * 1024 * 1024, rangeReader = null, createWorker = url => new Worker(url, { type: 'module' }) } = {}) {
  const worker = createWorker(workerUrl);
  let closed = false, fatal = null, active = null, sequence = 0, pageCount = 0, outlineNeedsFullSource = false, outstandingRange = 0;
  const abort = () => new DOMException('DjVu task cancelled', 'AbortError');
  function close(reason = abort()) {
    if (closed) return;
    closed = true; fatal = reason;
    worker.terminate();rangeReader?.close();
    active?.reject(reason);
    active = null;
  }
  worker.onerror = event => close(Object.assign(new Error('DJVU_WORKER_FAILED'), { cause: event.message }));
  worker.onmessageerror = () => close(new Error('DJVU_WORKER_MESSAGE_FAILED'));
  worker.onmessage = event => {
    if (event.data?.operation === 'range') {
      const {id, rangeId, offset, length} = event.data;
      if (!rangeReader || !active || id !== active.id || outstandingRange || !Number.isSafeInteger(rangeId) || rangeId < 1 ||
          !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 ||
          length > 65536 || offset+length > rangeReader.total) {
        close(new Error('DJVU_WORKER_PROTOCOL'));return;
      }
      outstandingRange=rangeId;
      Promise.resolve().then(()=>rangeReader.read(offset,length)).then(bytes=>{
        if (closed || active?.id !== id) return;
        const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
        outstandingRange=0;
        worker.postMessage({id,operation:'range-result',rangeId,ok:true,bytes:buffer},[buffer]);
      }).catch(error=>{
        if (closed || active?.id !== id) return;
        const code=/^DJVU_[A-Z_]+$/.test(error?.code||'') ? error.code :
          /^DJVU_[A-Z_]+$/.test(error?.message||'') ? error.message : 'DJVU_RANGE_FAILED';
        outstandingRange=0;
        worker.postMessage({id,operation:'range-result',rangeId,ok:false,error:code});
        if (rangeReader?.failure) close(rangeReader.failure);
      });
      return;
    }
    if (!active || event.data?.id !== active.id) { close(new Error('DJVU_WORKER_PROTOCOL')); return; }
    const task = active;
    active = null;
    if (event.data.ok === true) task.resolve(event.data);
    else if (event.data.ok === false && /^DJVU_[A-Z_]+$/.test(event.data.error || ''))
      task.reject(new Error(event.data.error));
    else { active = task; close(new Error('DJVU_WORKER_PROTOCOL')); }
  };
  async function request(operation, data = {}, { signal, transfer = [] } = {}) {
    if (closed) throw fatal || abort();
    if (signal?.aborted) { const reason = signal.reason || abort(); close(reason); throw reason; }
    if (active) throw new Error('DJVU_ADAPTER_CONCURRENT_TASK');
    const id = ++sequence;
    let timer, onAbort;
    try {
      return await new Promise((resolve, reject) => {
        active = { id, resolve, reject };
        timer = setTimeout(() => close(new Error('DJVU_WORKER_TIMEOUT')), timeoutMs);
        onAbort = () => close(signal.reason || abort());
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        try { worker.postMessage({ id, operation, ...data }, transfer); }
        catch (error) { close(Object.assign(new Error('DJVU_WORKER_FAILED'), { cause: error })); }
      });
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (active?.id === id) active = null;
    }
  }
  async function open(bytes, signal) {
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > 512 * 1024 * 1024)
      throw new Error('DJVU_DOCUMENT_INVALID');
    try {
      const value = await request('open', { bytes, cacheBytes }, { signal, transfer: [bytes] });
      if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > 10000)
        throw new Error('DJVU_PAGE_COUNT_INVALID');
      pageCount = value.count;
      return pageCount;
    } catch (error) { close(error); throw error; }
  }
  async function prepare(signal) {
    try { await request('prepare', {}, {signal}); }
    catch (error) { close(error); throw error; }
  }
  async function openRange(signal) {
    if (!rangeReader || !Number.isSafeInteger(rangeReader.total) || rangeReader.total < 16 || rangeReader.total > 512*1024*1024)
      throw new Error('DJVU_DOCUMENT_INVALID');
    try {
      const value=await request('open-range',{total:rangeReader.total,cacheBytes},{signal});
      if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > 10000)
        throw new Error('DJVU_PAGE_COUNT_INVALID');
      outlineNeedsFullSource=value.outlineNeedsFullSource===true;
      pageCount=value.count;return pageCount;
    } catch(error){close(error);throw error;}
  }
  async function page(number, signal) {
    if (!Number.isSafeInteger(number) || number < 1 || number > pageCount) throw new Error('DJVU_PAGE_INVALID');
    const value = await request('page', { page: number }, { signal });
    const { width, height, dpi, rotation, pixels } = value;
    if (![width, height, dpi].every(Number.isSafeInteger) || width < 1 || height < 1 || dpi < 1 ||
        width * height > maxPixels || ![0, 90, 180, 270].includes(rotation) ||
        !(pixels instanceof ArrayBuffer) || pixels.byteLength !== width * height * 4)
      throw new Error('DJVU_PAGE_DECODE_INVALID');
    return { image: new ImageData(new Uint8ClampedArray(pixels), width, height), width, height, dpi, rotation };
  }
  async function geometry(number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > pageCount) throw new Error('DJVU_PAGE_INVALID');
    const {width, height, dpi, rotation} = await request('geometry', {page:number});
    if (![width,height,dpi].every(Number.isSafeInteger) || width < 1 || height < 1 || dpi < 25 || dpi > 6000 ||
        width * height > maxPixels || ![0,90,180,270].includes(rotation)) throw new Error('DJVU_PAGE_GEOMETRY_INVALID');
    return {width,height,dpi,rotation};
  }
  async function text(number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > pageCount) throw new Error('DJVU_PAGE_INVALID');
    const {text, zones} = await request('text', {page:number});
    if (typeof text !== 'string' || text.length > 2_000_000 || !Array.isArray(zones) || zones.length > 20_000 ||
        zones.some(z => !z || typeof z.t !== 'string' || z.t.length > 4000 ||
          ![z.x,z.y,z.w,z.h].every(Number.isFinite) || z.x < 0 || z.y < 0 || z.w < 0 || z.h < 0))
      throw new Error('DJVU_TEXT_INVALID');
    return {text,zones};
  }
  async function outline(signal) {
    const { entries } = await request('outline', {}, { signal });
    if (!Array.isArray(entries) || entries.length > 2000 || entries.some((entry, index) =>
      !entry || typeof entry.title !== 'string' || entry.title.length > 1000 ||
      !Number.isSafeInteger(entry.depth) || entry.depth < 0 || entry.depth > 32 ||
      (index === 0 ? entry.depth !== 0 : entry.depth > entries[index - 1].depth + 1) ||
      !Number.isSafeInteger(entry.page) || entry.page < 0 || entry.page > pageCount))
      throw new Error('DJVU_OUTLINE_INVALID');
    return entries;
  }
  async function stats() {
    const value = await request('stats');
    if (!Number.isSafeInteger(value.cacheBytes) || value.cacheBytes < 0) throw new Error('DJVU_WORKER_PROTOCOL');
    return { decodedCacheBytes: value.cacheBytes };
  }
  return { prepare, open, openRange, page, geometry, text, outline, stats, close,
    get outlineNeedsFullSource() {return outlineNeedsFullSource;}, get closed() { return closed; } };
}

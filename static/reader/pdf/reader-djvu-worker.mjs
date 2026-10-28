// Serialize requests to one decoder worker. A fatal error, timeout or opening
// abort always terminates the worker and settles the outstanding operation.
export function createDjvuWorkerAdapter(workerUrl, { maxPixels = 50_000_000, timeoutMs = 60000,
  cacheBytes = 32 * 1024 * 1024, createWorker = url => new Worker(url, { type: 'module' }) } = {}) {
  const worker = createWorker(workerUrl);
  let closed = false, fatal = null, active = null, sequence = 0, pageCount = 0;
  const abort = () => new DOMException('DjVu task cancelled', 'AbortError');
  function close(reason = abort()) {
    if (closed) return;
    closed = true; fatal = reason;
    worker.terminate();
    active?.reject(reason);
    active = null;
  }
  worker.onerror = event => close(Object.assign(new Error('DJVU_WORKER_FAILED'), { cause: event.message }));
  worker.onmessageerror = () => close(new Error('DJVU_WORKER_MESSAGE_FAILED'));
  worker.onmessage = event => {
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
  return { open, page, outline, stats, close, get closed() { return closed; } };
}

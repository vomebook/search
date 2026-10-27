// DjVu.js is distributed under GNU GPL v2; see the bundled upstream notice.
// Only this module can feed commands to the decoder worker; every source is
// caller-owned and cancellation settles promises rather than silently hanging.
export function createDjvuWorkerAdapter(DjVu, libraryUrl, { maxPixels = 50_000_000, timeoutMs = 60000 } = {}) {
  if (!DjVu?.Worker) throw new Error('DJVU_ENGINE_UNAVAILABLE');
  let worker = new DjVu.Worker(libraryUrl), closed = false, fatal = null, active = null;
  const abort = () => new DOMException('DjVu task cancelled', 'AbortError');
  function close(reason = abort()) {
    if (closed) return;
    closed = true;
    fatal = reason;
    worker.terminate();
    active?.reject(reason);
    active = null;
  }
  // Upstream logs Worker errors but otherwise leaves its Promise unresolved.
  worker.worker.onerror = event => close(Object.assign(new Error('DJVU_WORKER_FAILED'), { cause: event.message }));
  worker.worker.onmessageerror = () => close(new Error('DJVU_WORKER_MESSAGE_FAILED'));
  async function guarded(start, { signal } = {}) {
    if (closed) throw fatal || abort();
    if (signal?.aborted) throw signal.reason || abort();
    if (active) throw new Error('DJVU_ADAPTER_CONCURRENT_TASK');
    let timer, onAbort;
    const interruption = new Promise((_, reject) => {
      active = { reject };
      timer = setTimeout(() => close(new Error('DJVU_WORKER_TIMEOUT')), timeoutMs);
      onAbort = () => close(signal.reason || abort());
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(() => {
      if (closed) throw fatal || abort();
      if (signal?.aborted) throw signal.reason || abort();
      return start();
    }), interruption]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); active = null; }
  }
  async function open(bytes, signal) {
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength) throw new Error('DJVU_DOCUMENT_INVALID');
    await guarded(() => worker.createDocument(bytes), { signal });
    const [count, bundled] = await guarded(() => worker.run(worker.doc.getPagesQuantity(), worker.doc.isBundled()), { signal });
    if (!bundled) { close(new Error('DJVU_INDIRECT_UNSUPPORTED')); throw fatal; }
    if (!Number.isInteger(count) || count < 1 || count > 10000) { close(new Error('DJVU_PAGE_COUNT_INVALID')); throw fatal; }
    return count;
  }
  async function geometry(number, signal) {
    const [width, height, dpi, rotation] = await guarded(() => worker.run(
      worker.doc.getPage(number).getWidth(), worker.doc.getPage(number).getHeight(),
      worker.doc.getPage(number).getDpi(), worker.doc.getPage(number).getRotation()), { signal });
    if (![width,height,dpi].every(Number.isSafeInteger) || width < 1 || height < 1 || dpi < 1 ||
        width > maxPixels || height > maxPixels || width * height > maxPixels || ![0,90,180,270].includes(rotation))
      throw new Error('DJVU_PAGE_GEOMETRY_INVALID');
    const expected = rotation === 90 || rotation === 270 ? [height,width] : [width,height];
    return {width:expected[0],height:expected[1],dpi,rotation};
  }
  async function page(number, signal) {
    try {
      const metadata = await geometry(number, signal);
      const image = await guarded(() => worker.doc.getPage(number).getImageData().run(), { signal });
      if (!(image instanceof ImageData) || image.width !== metadata.width || image.height !== metadata.height ||
          image.data.byteLength !== image.width * image.height * 4) throw new Error('DJVU_PAGE_DECODE_INVALID');
      return { image, ...metadata };
    } catch (error) {
      if (error?.name === 'AbortError' || String(error?.message || '').startsWith('DJVU_')) throw error;
      throw Object.assign(new Error('DJVU_PAGE_DECODE_FAILED'), { cause:error });
    }
  }
  async function outline(signal) {
    const contents = await guarded(() => worker.doc.getContents().run(), { signal });
    if (contents == null) return [];
    if (!Array.isArray(contents) || contents.length > 2000) throw new Error('DJVU_OUTLINE_INVALID');
    const flat = [], queue = contents.map(item => ({item, depth:0})).reverse();
    while (queue.length) {
      const {item, depth} = queue.pop();
      if (!item || typeof item.description !== 'string' || item.description.length > 1000 || depth > 32 ||
          (item.children != null && (!Array.isArray(item.children) || item.children.length > 2000 - flat.length - queue.length - 1)) || flat.length >= 2000)
        throw new Error('DJVU_OUTLINE_INVALID');
      flat.push({title:item.description, url:typeof item.url === 'string' && item.url.length <= 1024 ? item.url : '', depth});
      if (item.children) for (let i=item.children.length-1;i>=0;i--) queue.push({item:item.children[i],depth:depth+1});
    }
    const urls = [...new Set(flat.map(item=>item.url).filter(url=>url.startsWith('#')))];
    const numbers = new Map();
    for (let start=0;start<urls.length;start+=64) {
      const part=urls.slice(start,start+64);
      const response=await guarded(() => worker.run(...part.map(url=>worker.doc.getPageNumberByUrl(url))),{signal});
      const values=part.length===1 ? [response] : response;
      if (!Array.isArray(values) || values.length!==part.length) throw new Error('DJVU_OUTLINE_INVALID');
      part.forEach((url,index)=>numbers.set(url,values[index]));
    }
    return flat.map(item=>({...item,page:numbers.get(item.url)||0}));
  }
  return { open, page, geometry, outline, close, get closed() { return closed; } };
}

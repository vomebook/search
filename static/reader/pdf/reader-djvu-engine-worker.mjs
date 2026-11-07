// Isolated decoder worker: the main thread transfers a complete, checked source
// and receives only strictly decoded, complete native pages.
const SIMD128_PROBE = new Uint8Array([
  0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,22,1,20,0,253,12,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,11
]);
/** @typedef {typeof import('../../vendor/djvu-rs-reader/release-a23e0b3e3a44-025029b02a7c/simd128/djvu_rs.js')} DjvuEngine */
/** @typedef {import('../../vendor/djvu-rs-reader/release-a23e0b3e3a44-025029b02a7c/simd128/djvu_rs.js').WasmDocument} DjvuDocument */
/** @typedef {import('../../vendor/djvu-rs-reader/release-a23e0b3e3a44-025029b02a7c/simd128/djvu_rs.js').WasmLazyDocument} DjvuLazyDocument */
/** @type {DjvuEngine | undefined} */
let engine;
/** @type {DjvuDocument | DjvuLazyDocument | undefined} */
let document;
let pageCount = 0, cacheBudget = 0, lazy = false, activeId = 0, rangeSequence = 0;
const ranges = new Map();
const MAX_PIXELS = 50_000_000;
/** @param {unknown} id @param {string} code */
const fail = (id, code) => self.postMessage({ id, ok: false, error: code });

async function prepareEngine() {
  if (engine) return;
  const simd = WebAssembly.validate(SIMD128_PROBE);
  // Both URLs are pinned components of the selected decoder, not book bytes.
  // Fetch the Wasm while importing its glue instead of waiting for the glue
  // to finish before discovering the Wasm URL. The decoder still consumes the
  // same Response and preserves its streaming/MIME fallback behavior.
  const controller = new AbortController();
  const wasmUrl = simd
    ? new URL('../../vendor/djvu-rs-reader/release-a23e0b3e3a44-025029b02a7c/simd128/djvu_rs_bg.wasm', import.meta.url)
    : new URL('../../vendor/djvu-rs-reader/release-a23e0b3e3a44-025029b02a7c/scalar/djvu_rs_bg.wasm', import.meta.url);
  /** @type {DjvuEngine | undefined} */
  let candidate;
  /** @type {Response | undefined} */
  let response;
  try {
    const [module,wasmResponse] = await Promise.all([
      simd ? import('../../vendor/djvu-rs-reader/release-a23e0b3e3a44-025029b02a7c/simd128/djvu_rs.js')
           : import('../../vendor/djvu-rs-reader/release-a23e0b3e3a44-025029b02a7c/scalar/djvu_rs.js'),
      fetch(wasmUrl, {signal:controller.signal}).then(value => {
        if (controller.signal.aborted) { value.body?.cancel().catch(() => {}); throw controller.signal.reason; }
        response = value;
        return value;
      })
    ]);
    candidate = module;
    await candidate.default({module_or_path:wasmResponse});
  } catch (error) {
    controller.abort(error);
    await response?.body?.cancel().catch(() => {});
    throw error;
  }
  engine = candidate;
}

self.onmessage = async ({ data }) => {
  const { id, operation } = data || {};
  if (operation === 'range-result') {
    const pending=ranges.get(data.rangeId);
    if (!pending || id !== activeId || pending.id !== id) return;
    ranges.delete(data.rangeId);
    if (data.ok === true && data.bytes instanceof ArrayBuffer && data.bytes.byteLength === pending.length)
      pending.resolve(new Uint8Array(data.bytes));
    else pending.reject(new Error(/^DJVU_[A-Z_]+$/.test(data.error||'') ? data.error : 'DJVU_RANGE_INVALID'));
    return;
  }
  if (activeId) { fail(id,'DJVU_WORKER_PROTOCOL');return; }
  try {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('DJVU_WORKER_PROTOCOL');
    activeId=id;
    if (operation === 'prepare') {
      await prepareEngine();
      self.postMessage({id,ok:true});
      return;
    }
    if (operation === 'open' || operation === 'open-range') {
      lazy = operation === 'open-range';
      if (document || (!lazy && (!(data.bytes instanceof ArrayBuffer) || !data.bytes.byteLength)) ||
          (lazy && (!Number.isSafeInteger(data.total) || data.total < 16 || data.total > 512*1024*1024)) ||
          !Number.isSafeInteger(data.cacheBytes) || data.cacheBytes < 1 || data.cacheBytes > 64 * 1024 * 1024)
        throw new Error('DJVU_DOCUMENT_INVALID');
      await prepareEngine();
      // prepareEngine either assigns the engine or throws.
      const ready = /** @type {DjvuEngine} */ (engine);
      const opened = lazy ? await ready.WasmLazyDocument.open(data.total,(/** @type {number} */ offset,/** @type {number} */ length)=>new Promise((resolve,reject)=>{
        const rangeId=++rangeSequence;
        ranges.set(rangeId,{id:activeId,length,resolve,reject});
        self.postMessage({id:activeId,operation:'range',rangeId,offset,length});
      }),data.cacheBytes) : ready.WasmDocument.reader_open(new Uint8Array(data.bytes), data.cacheBytes);
      document = opened;
      cacheBudget = data.cacheBytes;
      pageCount = opened.page_count();
      if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10000)
        throw new Error('DJVU_PAGE_COUNT_INVALID');
      self.postMessage({ id, ok: true, count: pageCount,
        outlineNeedsFullSource:lazy && /** @type {DjvuLazyDocument} */ (opened).reader_outline_needs_full_source() });
      return;
    }
    if (!document) throw new Error('DJVU_DOCUMENT_INVALID');
    if (operation === 'geometry' || operation === 'text') {
      const number = data.page;
      if (!Number.isSafeInteger(number) || number < 1 || number > pageCount) throw new Error('DJVU_PAGE_INVALID');
      if (lazy) {
        const lazyDocument = /** @type {DjvuLazyDocument} */ (document);
        const [width,height,dpi,rotation]=Array.from(await lazyDocument.reader_geometry(number-1));
        if (![width,height,dpi].every(Number.isSafeInteger) || width < 1 || height < 1 || dpi < 25 || dpi > 6000 ||
            width * height > MAX_PIXELS || ![0,90,180,270].includes(rotation)) throw new Error('DJVU_PAGE_GEOMETRY_INVALID');
        if (operation === 'geometry') self.postMessage({id,ok:true,width,height,dpi,rotation});
        else {
          const text=(await lazyDocument.reader_text(number-1)) || '';
          const packed=await lazyDocument.reader_text_zones_json(number-1);
          if (text.length > 2_000_000 || (packed && packed.length > 4_000_000)) throw new Error('DJVU_TEXT_SIZE_LIMIT');
          const zones=packed ? JSON.parse(packed) : [];
          if (!Array.isArray(zones) || zones.length > 20_000) throw new Error('DJVU_TEXT_SIZE_LIMIT');
          self.postMessage({id,ok:true,text,zones});
        }
        return;
      }
      const page = /** @type {DjvuDocument} */ (document).page(number - 1);
      try {
        const dpi = page.dpi(), rotation = page.reader_rotation();
        const width = page.width_at(dpi), height = page.height_at(dpi);
        if (![width, height, dpi].every(Number.isSafeInteger) || width < 1 || height < 1 || dpi < 25 || dpi > 6000 ||
            width * height > MAX_PIXELS || ![0, 90, 180, 270].includes(rotation))
          throw new Error('DJVU_PAGE_GEOMETRY_INVALID');
        if (operation === 'geometry') {
          self.postMessage({ id, ok: true, width, height, dpi, rotation });
        } else {
          const text = page.text() || '';
          if (text.length > 2_000_000) throw new Error('DJVU_TEXT_SIZE_LIMIT');
          const packed = page.text_zones_json(dpi);
          if (text.length > 2_000_000 || (packed && packed.length > 4_000_000)) throw new Error('DJVU_TEXT_SIZE_LIMIT');
          const zones = packed ? JSON.parse(packed) : [];
          if (!Array.isArray(zones) || zones.length > 20_000) throw new Error('DJVU_TEXT_SIZE_LIMIT');
          self.postMessage({ id, ok: true, text, zones });
        }
      } finally { page.free(); }
      return;
    }
    if (operation === 'page') {
      const number = data.page;
      if (!Number.isSafeInteger(number) || number < 1 || number > pageCount) throw new Error('DJVU_PAGE_INVALID');
      if (lazy) {
        const lazyDocument = /** @type {DjvuLazyDocument} */ (document);
        const [width,height,dpi,rotation]=Array.from(await lazyDocument.reader_geometry(number-1));
        if (![width,height,dpi].every(Number.isSafeInteger) || width < 1 || height < 1 || dpi < 25 || dpi > 6000 ||
            width * height > MAX_PIXELS || ![0,90,180,270].includes(rotation)) throw new Error('DJVU_PAGE_GEOMETRY_INVALID');
        /** @type {import('../../vendor/djvu-rs-reader/release-a23e0b3e3a44-025029b02a7c/simd128/djvu_rs.js').WasmPixmap | null | undefined} */
        let pixmap;
        try {
          pixmap=await lazyDocument.reader_render_strict(number-1);
          const pixels=pixmap.to_bytes();
          if (pixmap.width()!==width || pixmap.height()!==height || !(pixels instanceof Uint8ClampedArray) ||
              pixels.byteLength!==width*height*4) throw new Error('DJVU_PAGE_DECODE_INVALID');
          const buffer=pixels.buffer;
          pixmap.free();pixmap=null;
          /** @type {{postMessage(message: unknown, transfer: Transferable[]): void}} */ (/** @type {unknown} */ (self)).postMessage({id,ok:true,width,height,dpi,rotation,pixels:buffer},[buffer]);
        } finally { pixmap?.free(); }
        return;
      }
      const eagerDocument = /** @type {DjvuDocument} */ (document);
      const page = eagerDocument.page(number - 1);
      let result;
      try {
        const dpi = page.dpi(), rotation = page.reader_rotation();
        const width = page.width_at(dpi), height = page.height_at(dpi);
        if (![width, height, dpi].every(Number.isSafeInteger) || width < 1 || height < 1 || dpi < 1 ||
            width * height > MAX_PIXELS || ![0, 90, 180, 270].includes(rotation))
          throw new Error('DJVU_PAGE_GEOMETRY_INVALID');
        // The strict method rejects corrupt layers; a partially decoded or
        // progressive image is never reported as a finished reading page.
        const pixels = page.reader_render_strict();
        if (!(pixels instanceof Uint8ClampedArray) || pixels.byteLength !== width * height * 4)
          throw new Error('DJVU_PAGE_DECODE_INVALID');
        result = { id, ok: true, width, height, dpi, rotation, pixels: pixels.buffer };
      } finally { page.free(); eagerDocument.reader_trim_cache(cacheBudget); }
      // Do not publish success before cache cleanup: a cleanup failure must not
      // produce a second, contradictory response for the same operation.
      /** @type {{postMessage(message: unknown, transfer: Transferable[]): void}} */ (/** @type {unknown} */ (self)).postMessage(result, [result.pixels]);
      return;
    }
    if (operation === 'outline') {
      const entries = await document.reader_outline(), ids = document.reader_page_ids();
      if (!Array.isArray(entries) || !Array.isArray(ids) || entries.length > 2000 || ids.length > pageCount)
        throw new Error('DJVU_OUTLINE_INVALID');
      const pages = new Map(ids.map((name, index) => [name, index + 1]));
      const flat = entries.map(item => {
        if (typeof item.title !== 'string' || item.title.length > 1000 || typeof item.url !== 'string' ||
            item.url.length > 1024 || !Number.isSafeInteger(item.depth) || item.depth < 0 || item.depth > 32)
          throw new Error('DJVU_OUTLINE_INVALID');
        const ref = item.url.startsWith('#') ? item.url.slice(1) : '';
        const numeric = /^\d+$/.test(ref) ? Number(ref) : 0;
        const page = pages.get(ref) || (numeric >= 1 && numeric <= pageCount ? numeric : 0);
        return { title: item.title, depth: item.depth, page };
      });
      self.postMessage({ id, ok: true, entries: flat });
      return;
    }
    if (operation === 'stats') {
      const cacheBytes=lazy ? (await /** @type {DjvuLazyDocument} */ (document).reader_cache_stats())[2] : /** @type {DjvuDocument} */ (document).reader_cache_bytes();
      self.postMessage({ id, ok: true, cacheBytes });
      return;
    }
    throw new Error('DJVU_WORKER_PROTOCOL');
  } catch (error) {
    const message = String(/** @type {{message?: unknown} | null | undefined} */ (error)?.message || error || '');
    const known = message.match(/\bDJVU_[A-Z_]+\b/)?.[0];
    fail(id, known || (operation === 'open' || operation === 'open-range' ? 'DJVU_OPEN_FAILED' :
      operation === 'page' ? 'DJVU_PAGE_DECODE_FAILED' : operation === 'text' ? 'DJVU_TEXT_DECODE_FAILED' : 'DJVU_WORKER_FAILED'));
  } finally {
    if (activeId === id) {
      for (const [key,pending] of ranges) if (pending.id === id) { ranges.delete(key);pending.reject(new Error('DJVU_WORKER_PROTOCOL')); }
      activeId=0;
    }
  }
};

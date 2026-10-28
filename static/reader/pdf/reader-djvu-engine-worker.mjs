// Isolated decoder worker: the main thread transfers a complete, checked source
// and receives only strictly decoded, complete native pages.
const SIMD128_PROBE = new Uint8Array([
  0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,22,1,20,0,253,12,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,11
]);
let engine, document, pageCount = 0, cacheBudget = 0;
const MAX_PIXELS = 50_000_000;
const fail = (id, code) => self.postMessage({ id, ok: false, error: code });

self.onmessage = async ({ data }) => {
  const { id, operation } = data || {};
  try {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('DJVU_WORKER_PROTOCOL');
    if (operation === 'open') {
      if (document || !(data.bytes instanceof ArrayBuffer) || !data.bytes.byteLength ||
          !Number.isSafeInteger(data.cacheBytes) || data.cacheBytes < 1 || data.cacheBytes > 64 * 1024 * 1024)
        throw new Error('DJVU_DOCUMENT_INVALID');
      if (!engine) {
        const simd = WebAssembly.validate(SIMD128_PROBE);
        engine = simd ? await import('../../vendor/djvu-rs-reader/release-a03526f445b4-a99c0e299e95/simd128/djvu_rs.js')
                      : await import('../../vendor/djvu-rs-reader/release-a03526f445b4-a99c0e299e95/scalar/djvu_rs.js');
        await engine.default();
      }
      document = engine.WasmDocument.reader_open(new Uint8Array(data.bytes), data.cacheBytes);
      cacheBudget = data.cacheBytes;
      pageCount = document.page_count();
      if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10000)
        throw new Error('DJVU_PAGE_COUNT_INVALID');
      self.postMessage({ id, ok: true, count: pageCount });
      return;
    }
    if (!document) throw new Error('DJVU_DOCUMENT_INVALID');
    if (operation === 'page') {
      const number = data.page;
      if (!Number.isSafeInteger(number) || number < 1 || number > pageCount) throw new Error('DJVU_PAGE_INVALID');
      const page = document.page(number - 1);
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
      } finally { page.free(); document.reader_trim_cache(cacheBudget); }
      // Do not publish success before cache cleanup: a cleanup failure must not
      // produce a second, contradictory response for the same operation.
      self.postMessage(result, [result.pixels]);
      return;
    }
    if (operation === 'outline') {
      const entries = document.reader_outline(), ids = document.reader_page_ids();
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
      self.postMessage({ id, ok: true, cacheBytes: document.reader_cache_bytes() });
      return;
    }
    throw new Error('DJVU_WORKER_PROTOCOL');
  } catch (error) {
    const message = String(error?.message || error || '');
    const known = message.match(/\bDJVU_[A-Z_]+\b/)?.[0];
    fail(id, known || (operation === 'open' ? 'DJVU_OPEN_FAILED' :
      operation === 'page' ? 'DJVU_PAGE_DECODE_FAILED' : 'DJVU_WORKER_FAILED'));
  }
};

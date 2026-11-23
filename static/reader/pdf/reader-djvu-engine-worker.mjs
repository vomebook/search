// Isolated decoder worker: the main thread transfers a complete, checked source
// and receives only strictly decoded, complete native pages.
import '../../reader-resources.js';
/** @typedef {typeof import('../../vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/simd128/djvu_rs.js')} DjvuEngine */
/** @typedef {import('../../vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/simd128/djvu_rs.js').WasmDocument} DjvuDocument */
/** @typedef {import('../../vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/simd128/djvu_rs.js').WasmLazyDocument} DjvuLazyDocument */
/** @typedef {import('../../vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/simd128/djvu_rs.js').WasmPixmap} DjvuPixmap */
/** @typedef {'page' | 'geometry' | 'text'} PageOperation */
/** @typedef {{width: number, height: number, dpi: number, rotation: number}} Geometry */
/** @type {DjvuEngine | undefined} */
let engine;
/** @type {DjvuDocument | DjvuLazyDocument | undefined} */
let document;
let pageCount = 0, cacheBudget = 0, lazy = false, activeId = 0, rangeSequence = 0;
const ranges = new Map();
const MAX_PIXELS = 50_000_000;
const METADATA_DPI = /** @type {const} */ ([25, 6000]);
// The historical eager raster reply only requires positive, safe integer DPI.
const EAGER_RASTER_DPI = /** @type {const} */ ([1, Number.MAX_SAFE_INTEGER]);
/** @param {unknown} id @param {string} code */
const fail = (id, code) => self.postMessage({ id, ok: false, error: code });

async function prepareEngine() {
  if (engine) return;
  const simd = VoiceOfMLReaderResources.djvuSupportsSIMD();
  // Both URLs are pinned components of the selected decoder, not book bytes.
  // Fetch the Wasm while importing its glue instead of waiting for the glue
  // to finish before discovering the Wasm URL. The decoder still consumes the
  // same Response and preserves its streaming/MIME fallback behavior.
  const controller = new AbortController();
  const wasmUrl = simd
    ? new URL('../../vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/simd128/djvu_rs_bg.wasm', import.meta.url)
    : new URL('../../vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/scalar/djvu_rs_bg.wasm', import.meta.url);
  /** @type {DjvuEngine | undefined} */
  let candidate;
  /** @type {Response | undefined} */
  let response;
  try {
    const [module,wasmResponse] = await Promise.all([
      simd ? import('../../vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/simd128/djvu_rs.js')
           : import('../../vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/scalar/djvu_rs.js'),
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

/** @param {number | undefined} width @param {number | undefined} height
 * @param {number | undefined} dpi @param {number | undefined} rotation
 * @param {readonly [number, number]} dpiBounds */
function checkedGeometry(width, height, dpi, rotation, [minDpi, maxDpi]) {
  if (width === undefined || height === undefined || dpi === undefined || rotation === undefined ||
      ![width, height, dpi].every(Number.isSafeInteger) || width < 1 || height < 1 ||
      dpi < minDpi || dpi > maxDpi || width * height > MAX_PIXELS || ![0, 90, 180, 270].includes(rotation))
    throw new Error('DJVU_PAGE_GEOMETRY_INVALID');
  return {width, height, dpi, rotation};
}

/** @param {string} text */
function checkTextSize(text) {
  if (text.length > 2_000_000) throw new Error('DJVU_TEXT_SIZE_LIMIT');
}

/** @param {number} id @param {string} text @param {string | undefined} packed */
function postText(id, text, packed) {
  if (packed && packed.length > 4_000_000) throw new Error('DJVU_TEXT_SIZE_LIMIT');
  const zones = packed ? JSON.parse(packed) : [];
  if (!Array.isArray(zones) || zones.length > 20_000) throw new Error('DJVU_TEXT_SIZE_LIMIT');
  self.postMessage({id, ok:true, text, zones});
}

/** @param {unknown} pixels @param {Geometry} geometry */
function checkedPixelBuffer(pixels, {width, height}) {
  if (!(pixels instanceof Uint8ClampedArray) || pixels.byteLength !== width * height * 4)
    throw new Error('DJVU_PAGE_DECODE_INVALID');
  return pixels.buffer;
}

/** @param {number} id @param {Geometry & {pixels: ArrayBufferLike}} result */
function postPage(id, result) {
  /** @type {{postMessage(message: unknown, transfer: Transferable[]): void}} */ (/** @type {unknown} */ (self))
    .postMessage({id, ok:true, ...result}, [/** @type {ArrayBuffer} */ (result.pixels)]);
}

/** @param {number} id @param {PageOperation} operation @param {DjvuDocument} source @param {number} index */
function readEagerPage(id, operation, source, index) {
  const page = source.page(index);
  const render = operation === 'page';
  let result;
  try {
    const dpi = page.dpi(), rotation = page.reader_rotation();
    const geometry = checkedGeometry(page.width_at(dpi), page.height_at(dpi), dpi, rotation,
      render ? EAGER_RASTER_DPI : METADATA_DPI);
    if (operation === 'geometry') {
      self.postMessage({id, ok:true, ...geometry});
      return;
    }
    if (operation === 'text') {
      const text = page.text() || '';
      checkTextSize(text);
      postText(id, text, page.text_zones_json(dpi));
      return;
    }
    // Strict rendering rejects corrupt layers rather than publishing a partial page.
    result = {...geometry, pixels:checkedPixelBuffer(page.reader_render_strict(), geometry)};
  } finally {
    page.free();
    if (render) source.reader_trim_cache(cacheBudget);
  }
  // Never publish a raster before cache cleanup has succeeded.
  postPage(id, result);
}

/** @param {number} id @param {PageOperation} operation @param {DjvuLazyDocument} source @param {number} index */
async function readRangePage(id, operation, source, index) {
  const [width, height, dpi, rotation] = await source.reader_geometry(index);
  const geometry = checkedGeometry(width, height, dpi, rotation, METADATA_DPI);
  if (operation === 'geometry') {
    self.postMessage({id, ok:true, ...geometry});
    return;
  }
  if (operation === 'text') {
    const text = (await source.reader_text(index)) || '';
    const packed = await source.reader_text_zones_json(index);
    checkTextSize(text);
    postText(id, text, packed);
    return;
  }
  /** @type {DjvuPixmap | null | undefined} */
  let pixmap;
  try {
    pixmap = await source.reader_render_strict(index);
    const pixels = pixmap.to_bytes();
    if (pixmap.width() !== geometry.width || pixmap.height() !== geometry.height)
      throw new Error('DJVU_PAGE_DECODE_INVALID');
    const buffer = checkedPixelBuffer(pixels, geometry);
    pixmap.free(); pixmap = null;
    postPage(id, {...geometry, pixels:buffer});
  } finally { pixmap?.free(); }
}

/** @param {number} offset @param {number} length */
function requestRange(offset, length) {
  return new Promise((resolve, reject) => {
    const rangeId = ++rangeSequence;
    ranges.set(rangeId, {id:activeId, length, resolve, reject});
    self.postMessage({id:activeId, operation:'range', rangeId, offset, length});
  });
}

/** @param {{bytes: ArrayBuffer, total: number, cacheBytes: number}} data
 * @param {number} id @param {boolean} openRange */
async function openDocument(data, id, openRange) {
  if (document) throw new Error('DJVU_DOCUMENT_INVALID');
  const {bytes, total, cacheBytes} = data;
  const invalidSource = openRange ? !Number.isSafeInteger(total) || total < 16 || total > 512 * 1024 * 1024
                                  : !(bytes instanceof ArrayBuffer) || !bytes.byteLength;
  if (invalidSource || !Number.isSafeInteger(cacheBytes) || cacheBytes < 1 || cacheBytes > 64 * 1024 * 1024)
    throw new Error('DJVU_DOCUMENT_INVALID');
  await prepareEngine();
  // prepareEngine either assigns the engine or throws.
  const ready = /** @type {DjvuEngine} */ (engine);
  // A rejected second open must not change the existing document's mode.
  document = openRange ? await ready.WasmLazyDocument.open(total, requestRange, cacheBytes)
                       : ready.WasmDocument.reader_open(new Uint8Array(bytes), cacheBytes);
  lazy = openRange;
  cacheBudget = cacheBytes;
  pageCount = document.page_count();
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10000)
    throw new Error('DJVU_PAGE_COUNT_INVALID');
  self.postMessage({id, ok:true, count:pageCount,
    outlineNeedsFullSource:lazy && /** @type {DjvuLazyDocument} */ (document).reader_outline_needs_full_source()});
}

/** @param {DjvuDocument | DjvuLazyDocument} source */
async function readOutline(source) {
  const entries = await source.reader_outline(), ids = source.reader_page_ids();
  if (!Array.isArray(entries) || !Array.isArray(ids) || entries.length > 2000 || ids.length > pageCount)
    throw new Error('DJVU_OUTLINE_INVALID');
  const pages = new Map(ids.map((name, index) => [name, index + 1]));
  return entries.map(item => {
    if (typeof item.title !== 'string' || item.title.length > 1000 || typeof item.url !== 'string' ||
        item.url.length > 1024 || !Number.isSafeInteger(item.depth) || item.depth < 0 || item.depth > 32)
      throw new Error('DJVU_OUTLINE_INVALID');
    const ref = item.url.startsWith('#') ? item.url.slice(1) : '';
    const numeric = /^\d+$/.test(ref) ? Number(ref) : 0;
    const page = pages.get(ref) || (numeric >= 1 && numeric <= pageCount ? numeric : 0);
    return { title: item.title, depth: item.depth, page };
  });
}

/** @param {{id: number, rangeId: number, ok: boolean, bytes?: ArrayBuffer, error?: string}} data */
function settleRange(data) {
  const pending = ranges.get(data.rangeId);
  if (!pending || data.id !== activeId || pending.id !== data.id) return;
  ranges.delete(data.rangeId);
  if (data.ok === true && data.bytes instanceof ArrayBuffer && data.bytes.byteLength === pending.length)
    pending.resolve(new Uint8Array(data.bytes));
  else pending.reject(new Error(/^DJVU_[A-Z_]+$/.test(data.error || '') ? data.error : 'DJVU_RANGE_INVALID'));
}

self.onmessage = async ({ data }) => {
  const { id, operation } = data || {};
  const opening = operation === 'open' || operation === 'open-range';
  if (operation === 'range-result') {
    settleRange(data);
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
    if (opening) {
      await openDocument(data, id, operation === 'open-range');
      return;
    }
    if (!document) throw new Error('DJVU_DOCUMENT_INVALID');
    if (operation === 'geometry' || operation === 'text' || operation === 'page') {
      const number = data.page;
      if (!Number.isSafeInteger(number) || number < 1 || number > pageCount) throw new Error('DJVU_PAGE_INVALID');
      const index = number - 1;
      if (lazy) await readRangePage(id, operation, /** @type {DjvuLazyDocument} */ (document), index);
      else readEagerPage(id, operation, /** @type {DjvuDocument} */ (document), index);
      return;
    }
    if (operation === 'outline') {
      self.postMessage({id, ok:true, entries:await readOutline(document)});
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
    fail(id, known || (opening ? 'DJVU_OPEN_FAILED' :
      operation === 'page' ? 'DJVU_PAGE_DECODE_FAILED' : operation === 'text' ? 'DJVU_TEXT_DECODE_FAILED' : 'DJVU_WORKER_FAILED'));
  } finally {
    if (activeId === id) {
      for (const [key,pending] of ranges) if (pending.id === id) { ranges.delete(key);pending.reject(new Error('DJVU_WORKER_PROTOCOL')); }
      activeId=0;
    }
  }
};

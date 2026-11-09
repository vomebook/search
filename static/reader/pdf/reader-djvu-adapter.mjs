import {createDjvuWorkerAdapter} from './reader-djvu-worker.mjs';
import {createDjvuScheduler} from './reader-djvu-scheduler.mjs';

// PDF-shaped document interface, enabling the existing Reader's
// page-window, zoom, selection, search and OCR surfaces to be reused unchanged.
/** @typedef {{page: number, width: number, height: number, rotation: number,
 * djvu: {pixels: [number, number], dpi: number}}} DjvuMapPage */
/** @typedef {{title: string, dest: number[] | null, items: DjvuOutlineNode[]}} DjvuOutlineNode */
/** @typedef {{numPages: number, getOutline(): Promise<DjvuOutlineNode[]>, destroy(): void}} DjvuOutlineDocument */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && (typeof value === 'object' || typeof value === 'function'); }
/** @param {unknown} value @returns {value is number} */
function positive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
/** @param {unknown} value @returns {value is [number, number]} */
function validPixels(value) {
  return Array.isArray(value) && value.length === 2 && value.every(positiveInteger);
}
/** @param {unknown} value @param {number} index @returns {value is DjvuMapPage} */
function validMapPage(value, index) {
  if (!isRecord(value) || value.page !== index+1 || !positive(value.width) || !positive(value.height) ||
      typeof value.rotation !== 'number' || ![0,90,180,270].includes(value.rotation)) return false;
  const data=value.djvu;
  return isRecord(data) && validPixels(data.pixels) && positiveInteger(data.dpi);
}
/** @param {DjvuMapPage} page @returns {[number, number]} */
function mappedPixels(page) {
  const [width,height]=page.djvu.pixels;
  return page.rotation === 90 || page.rotation === 270 ? [height,width] : [width,height];
}
/** @param {DjvuMapPage} page */
function geometryMatchesMap(page) {
  const [width,height]=mappedPixels(page);
  return !(Math.abs(page.width - width*72/page.djvu.dpi) > .001 ||
    Math.abs(page.height - height*72/page.djvu.dpi) > .001);
}
/** @param {unknown} pageMap @param {number} count @returns {DjvuMapPage[]} */
function validateMap(pageMap, count) {
  if (!pageMap) return [];
  if (!isRecord(pageMap) || !Array.isArray(pageMap.pages) || pageMap.pages.length !== count)
    throw new Error('DJVU_PAGE_MAP_MISMATCH');
  const pages=Array.from(pageMap.pages);
  if (!pages.every((page,index)=>validMapPage(page,index)) || !pages.every(geometryMatchesMap)) throw new Error('DJVU_PAGE_MAP_INVALID');
  return pages;
}
/** @typedef {Awaited<ReturnType<ReturnType<typeof createDjvuWorkerAdapter>['geometry']>>} DjvuGeometry */
/** @typedef {Awaited<ReturnType<ReturnType<typeof createDjvuWorkerAdapter>['text']>>} DjvuText */
/** @typedef {Awaited<ReturnType<ReturnType<typeof createDjvuWorkerAdapter>['page']>>} DjvuRenderedPage */
/** @param {DjvuMapPage} map @param {DjvuGeometry} geometry */
function validateTextGeometry(map,geometry) {
  const [width,height]=mappedPixels(map);
  if (geometry.width!==width || geometry.height!==height || geometry.dpi!==map.djvu.dpi || geometry.rotation!==map.rotation)
    throw new Error('DJVU_PAGE_GEOMETRY_MISMATCH');
}
/** @param {DjvuText['zones'][number]} zone @param {number} at @param {DjvuGeometry} geometry */
function usableZone(zone,at,geometry) {
  return !!zone.t && at>=0 && zone.x+zone.w<=geometry.width && zone.y+zone.h<=geometry.height;
}
// Preserve String iteration semantics, including surrogate pairs and lone
// surrogate halves, without materializing a per-code-point array for gaps.
/** @param {string} text */
function codePointLength(text) {
  let length = 0;
  for (let unit = 0; unit < text.length; unit++, length++) {
    const high = text.charCodeAt(unit);
    if (high >= 0xd800 && high <= 0xdbff && unit + 1 < text.length) {
      const low = text.charCodeAt(unit + 1);
      if (low >= 0xdc00 && low <= 0xdfff) unit++;
    }
  }
  return length;
}
/** @param {DjvuText} result @param {DjvuGeometry} geometry @param {number} pageHeight */
function textContent({text,zones},geometry,pageHeight) {
  const size = 72/geometry.dpi, items = [], positions = [];
  let cursor = 0, codepoints = 0;
  for (const zone of zones) {
    const at = text.indexOf(zone.t,cursor);
    if (!usableZone(zone,at,geometry)) continue;
    if (at > cursor) { const gap=text.slice(cursor,at); items.push({str:gap}); codepoints+=codePointLength(gap); }
    const start=codepoints, end=start+codePointLength(zone.t);
    positions.push({text:zone.t,box:[zone.x/geometry.width,zone.y/geometry.height,
      (zone.x+zone.w)/geometry.width,(zone.y+zone.h)/geometry.height],start,end});
    const height = Math.max(zone.h*size,.01);
    items.push({str:zone.t,transform:[height,0,0,height,zone.x*size,
      pageHeight-(zone.y+zone.h*.8)*size],width:zone.w*size,height,fontName:'djvu'});
    cursor=at+zone.t.length;codepoints=end;
  }
  if (cursor < text.length) items.push({str:text.slice(cursor)});
  return {items,styles:{djvu:{fontFamily:'sans-serif',ascent:.8}},readerTextZones:positions};
}
/** @param {DjvuMapPage | undefined} map @param {DjvuGeometry | null} native
 * @returns {{pixels: number[], dpi: number, rotation: number}} */
function renderIdentity(map,native) {
  if (map) return {pixels:mappedPixels(map),dpi:map.djvu.dpi,rotation:map.rotation};
  if (native) return {pixels:[native.width,native.height],dpi:native.dpi,rotation:native.rotation};
  throw new Error('DJVU_PAGE_GEOMETRY_INVALID');
}
/** @param {DjvuRenderedPage} page @param {{width: number, height: number}} geometry
 * @param {DjvuMapPage | undefined} map @param {DjvuGeometry | null} native */
function validateRenderedPage(page,geometry,map,native) {
  const expected=renderIdentity(map,native);
  const {width,height,dpi,rotation}=page;
  if (Math.abs((width/height)/(geometry.width/geometry.height)-1)>.01 ||
      width!==expected.pixels[0] || height!==expected.pixels[1] ||
      dpi!==expected.dpi || rotation!==expected.rotation) throw new Error('DJVU_PAGE_GEOMETRY_MISMATCH');
}
/** @param {DjvuRenderedPage} page @param {CanvasRenderingContext2D} canvasContext @param {() => boolean} stopped */
function drawPage(page,canvasContext,stopped) {
  const {image,width,height}=page;
  const off=typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width,height) : document.createElement('canvas');
  off.width=width;off.height=height;
  try {
    const ctx=off.getContext('2d');
    if (!ctx || !canvasContext) throw new Error('DJVU_CANVAS_UNAVAILABLE');
    ctx.putImageData(image,0,0);
    if (stopped()) throw new DOMException('DjVu render cancelled','AbortError');
    const canvas=canvasContext.canvas;
    canvasContext.clearRect(0,0,canvas.width,canvas.height);
    canvasContext.drawImage(off,0,0,canvas.width,canvas.height);
  } finally { off.width=off.height=0; }
}
/** @param {Awaited<ReturnType<ReturnType<typeof createDjvuWorkerAdapter>['outline']>>} flat
 * @param {number} count @returns {DjvuOutlineNode[]} */
function outlineTree(flat,count) {
  /** @type {DjvuOutlineNode[]} */
  const roots=[], parents=[];
  for (const item of flat) {
    const page=Number(item.page);
    /** @type {DjvuOutlineNode} */
    const node={title:item.title, dest:Number.isInteger(page)&&page>=1&&page<=count ? [page] : null, items:[]};
    while (parents.length > item.depth) parents.pop();
    const parent=parents[parents.length-1];
    if (parent) parent.items.push(node); else roots.push(node);
    parents.push(node);
  }
  return roots;
}
/** @param {{workerUrl: URL | string, bytes?: ArrayBuffer | undefined, pageMap?: unknown, signal?: AbortSignal | undefined,
 * cacheBytes?: number | undefined, cachePages?: number | undefined, createWorker?: ((url: URL | string) => Worker) | undefined,
 * rangeReader?: import('./reader-djvu-worker.mjs').DjvuRangeReader | null | undefined,
 * outlineFallback?: (() => Promise<DjvuOutlineDocument>) | undefined, preparedWorker?: ReturnType<typeof createDjvuWorkerAdapter> | undefined}} options */
export async function openDjvuDocument({ workerUrl, bytes, pageMap, signal, cacheBytes, cachePages, createWorker, rangeReader, outlineFallback, preparedWorker }) {
  const worker=preparedWorker || createDjvuWorkerAdapter(workerUrl,{cacheBytes,createWorker,rangeReader});
  try {
    const count=rangeReader ? await worker.openRange(signal) : await worker.open(bytes,signal);
    const pages=validateMap(pageMap,count);
    const scheduler=createDjvuScheduler(worker,{maxBytes:cacheBytes,maxPages:cachePages});
    let closed=false;
    /** @type {Map<number, Awaited<ReturnType<typeof worker.geometry>>>} */
    const geometries=new Map();
    /** @type {Map<number, Promise<Awaited<ReturnType<typeof worker.geometry>>>>} */
    const geometryPending=new Map();
    /** @param {number} number @returns {Promise<Awaited<ReturnType<typeof worker.geometry>>>} */
    function getGeometry(number) {
      const cached=geometries.get(number);
      if (cached) {
        geometries.delete(number);geometries.set(number,cached);return Promise.resolve(cached);
      }
      let pending=geometryPending.get(number);
      if (!pending) {
        pending=scheduler.requestMetadata('geometry',number,2).then(value=>{
          geometries.set(number,value);
          while(geometries.size>128) {
            const oldest=geometries.keys().next().value;
            if (oldest===undefined) break;
            geometries.delete(oldest);
          }
          return value;
        }).finally(()=>geometryPending.delete(number));
        geometryPending.set(number,pending);
      }
      return pending;
    }
    /** @param {number} number */
    async function getPage(number) {
      if (closed || !Number.isInteger(number) || number<1 || number>count) throw new Error('DJVU_PAGE_INVALID');
      const map=pages[number-1];
      const native = map ? null : await getGeometry(number);
      if (closed) throw new DOMException('DjVu document closed','AbortError');
      const geometry = map ? map : native ? {width:native.width*72/native.dpi,height:native.height*72/native.dpi} : null;
      if (!geometry) throw new Error('DJVU_PAGE_GEOMETRY_INVALID');
      return {
        /** @param {{scale: number}} options */
        getViewport({scale}) {return {width:geometry.width*scale,height:geometry.height*scale,scale,
          transform:[scale,0,0,-scale,0,geometry.height*scale],
          convertToViewportPoint:(/** @type {number} */ x,/** @type {number} */ y)=>[x*scale,(geometry.height-y)*scale]};},
        async getTextContent() {
          // A page map describes geometry, not text. Fetch embedded text from
          // the original even when a separately verified page map is present.
          const textGeometry = native || await getGeometry(number);
          if (closed) throw new DOMException('DjVu document closed','AbortError');
          if (map) validateTextGeometry(map,textGeometry);
          return textContent(await scheduler.requestMetadata('text',number,-1),textGeometry,geometry.height);
        },
        /** @param {{canvasContext: CanvasRenderingContext2D, readerPriority?: number}} options */
        render({canvasContext, readerPriority=0}) {
          let cancelled=false;
          const cancellation=new AbortController();
          const promise=scheduler.request(number,readerPriority,{signal:cancellation.signal}).then(page=>{
            if (cancelled || closed) throw new DOMException('DjVu render cancelled','AbortError');
            validateRenderedPage(page,geometry,map,native);
            // Publish only after the whole original page is decoded; browser
            // raster scaling supplies the current canvas zoom without network.
            drawPage(page,canvasContext,()=>cancelled || closed);
          });
          return {promise,cancel(){cancelled=true;cancellation.abort();}};
        }
      };
    }
    async function getOutline() {
      let flat;
      try { flat=await scheduler.requestOutline(); }
      catch(error) {
        if (!isRecord(error) || error.message !== 'DJVU_LAZY_OUTLINE_UNCERTAIN' || typeof outlineFallback !== 'function') throw error;
        const full=await outlineFallback();
        try {
          if (closed || full.numPages !== count) throw new Error('DJVU_PAGE_COUNT_MISMATCH');
          const outline=await full.getOutline();
          return closed ? [] : outline;
        } finally { full.destroy(); }
      }
      return outlineTree(flat,count);
    }
    return {numPages:count,getPage, getOutline, getPageIndex:async (/** @type {number} */ page)=>page-1,
      outlineNeedsFullSource:worker.outlineNeedsFullSource,
      readerRenderScaleLimit: Infinity, readerMaxCanvasPixels: 16_000_000,
      destroy(){if(!closed){closed=true;geometries.clear();scheduler.close();}},
      scheduler};
  } catch(error) {worker.close();throw error;}
}

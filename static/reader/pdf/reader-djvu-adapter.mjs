import {createDjvuWorkerAdapter} from './reader-djvu-worker.mjs';
import {createDjvuScheduler} from './reader-djvu-scheduler.mjs';

// PDF-shaped document interface, enabling the existing Reader's
// page-window, zoom, selection, search and OCR surfaces to be reused unchanged.
export async function openDjvuDocument({ workerUrl, bytes, pageMap, signal, cacheBytes, cachePages, createWorker, rangeReader, outlineFallback, preparedWorker }) {
  const worker=preparedWorker || createDjvuWorkerAdapter(workerUrl,{cacheBytes,createWorker,rangeReader});
  try {
    const count=rangeReader ? await worker.openRange(signal) : await worker.open(bytes,signal);
    if (pageMap && (!Array.isArray(pageMap.pages) || pageMap.pages.length!==count)) throw new Error('DJVU_PAGE_MAP_MISMATCH');
    for (const [index,page] of (pageMap?.pages || []).entries())
      if (page.page!==index+1 || !Number.isFinite(page.width) || !Number.isFinite(page.height) ||
          !(page.width>0) || !(page.height>0) || ![0,90,180,270].includes(page.rotation) ||
          !Array.isArray(page.djvu?.pixels) || page.djvu.pixels.length!==2 ||
          !page.djvu.pixels.every(n=>Number.isSafeInteger(n) && n>0) ||
          !Number.isSafeInteger(page.djvu.dpi) || page.djvu.dpi<1) throw new Error('DJVU_PAGE_MAP_INVALID');
    for (const page of pageMap?.pages || []) {
      const pixels = page.rotation === 90 || page.rotation === 270
        ? [page.djvu.pixels[1],page.djvu.pixels[0]] : page.djvu.pixels;
      if (Math.abs(page.width - pixels[0]*72/page.djvu.dpi) > .001 ||
          Math.abs(page.height - pixels[1]*72/page.djvu.dpi) > .001) throw new Error('DJVU_PAGE_MAP_INVALID');
    }
    const scheduler=createDjvuScheduler(worker,{maxBytes:cacheBytes,maxPages:cachePages});
    let closed=false;
    const geometries=new Map(), geometryPending=new Map();
    function getGeometry(number) {
      if (geometries.has(number)) {
        const value=geometries.get(number);geometries.delete(number);geometries.set(number,value);return Promise.resolve(value);
      }
      if (!geometryPending.has(number)) geometryPending.set(number,scheduler.requestMetadata('geometry',number,2).then(value=>{
        geometries.set(number,value);while(geometries.size>128)geometries.delete(geometries.keys().next().value);return value;
      }).finally(()=>geometryPending.delete(number)));
      return geometryPending.get(number);
    }
    async function getPage(number) {
      if (closed || !Number.isInteger(number) || number<1 || number>count) throw new Error('DJVU_PAGE_INVALID');
      const map=pageMap?.pages[number-1];
      const native = map ? null : await getGeometry(number);
      if (closed) throw new DOMException('DjVu document closed','AbortError');
      const geometry = map || {width:native.width*72/native.dpi,height:native.height*72/native.dpi};
      return {
        getViewport({scale}) {return {width:geometry.width*scale,height:geometry.height*scale,scale,
          transform:[scale,0,0,-scale,0,geometry.height*scale],
          convertToViewportPoint:(x,y)=>[x*scale,(geometry.height-y)*scale]};},
        async getTextContent() {
          // A page map describes geometry, not text. Fetch embedded text from
          // the original even when a separately verified page map is present.
          const textGeometry = native || await getGeometry(number);
          if (closed) throw new DOMException('DjVu document closed','AbortError');
          if (map) {
            const pixels = map.rotation === 90 || map.rotation === 270
              ? [map.djvu.pixels[1],map.djvu.pixels[0]] : map.djvu.pixels;
            if (textGeometry.width!==pixels[0] || textGeometry.height!==pixels[1] ||
                textGeometry.dpi!==map.djvu.dpi || textGeometry.rotation!==map.rotation)
              throw new Error('DJVU_PAGE_GEOMETRY_MISMATCH');
          }
          const {text,zones} = await scheduler.requestMetadata('text',number,-1);
          const size = 72/textGeometry.dpi, items = [], positions = [];
          let cursor = 0, codepoints = 0;
          for (const zone of zones) {
            const at = text.indexOf(zone.t,cursor);
            if (!zone.t || at < 0 || zone.x + zone.w > textGeometry.width || zone.y + zone.h > textGeometry.height) continue;
            if (at > cursor) { const gap=text.slice(cursor,at); items.push({str:gap}); codepoints+=Array.from(gap).length; }
            const start=codepoints, end=start+Array.from(zone.t).length;
            positions.push({text:zone.t,box:[zone.x/textGeometry.width,zone.y/textGeometry.height,
              (zone.x+zone.w)/textGeometry.width,(zone.y+zone.h)/textGeometry.height],start,end});
            const height = Math.max(zone.h*size,.01);
            items.push({str:zone.t,transform:[height,0,0,height,zone.x*size,
              geometry.height-(zone.y+zone.h*.8)*size],width:zone.w*size,height,fontName:'djvu'});
            cursor=at+zone.t.length;codepoints=end;
          }
          if (cursor < text.length) items.push({str:text.slice(cursor)});
          return {items,styles:{djvu:{fontFamily:'sans-serif',ascent:.8}},readerTextZones:positions};
        },
        render({canvasContext, readerPriority=0}) {
          let cancelled=false;
          const cancellation=new AbortController();
          const promise=scheduler.request(number,readerPriority,{signal:cancellation.signal}).then(({image,width,height,dpi,rotation})=>{
            if (cancelled || closed) throw new DOMException('DjVu render cancelled','AbortError');
            const pixels = map?.djvu?.pixels;
            const expected = map ? (map.rotation === 90 || map.rotation === 270 ? [pixels?.[1],pixels?.[0]] : pixels)
              : [native.width,native.height];
            if (Math.abs((width/height)/(geometry.width/geometry.height)-1)>.01 ||
                !Array.isArray(expected) || width!==expected[0] || height!==expected[1] ||
                dpi!==(map?.djvu?.dpi ?? native.dpi) || rotation!==(map?.rotation ?? native.rotation))
              throw new Error('DJVU_PAGE_GEOMETRY_MISMATCH');
            // Publish only after the whole original page is decoded; browser
            // raster scaling supplies the current canvas zoom without network.
            const off=typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width,height) : document.createElement('canvas');
            off.width=width;off.height=height;
            try {
              const ctx=off.getContext('2d');
              if (!ctx || !canvasContext) throw new Error('DJVU_CANVAS_UNAVAILABLE');
              ctx.putImageData(image,0,0);
              if (cancelled || closed) throw new DOMException('DjVu render cancelled','AbortError');
              const canvas=canvasContext.canvas;
              canvasContext.clearRect(0,0,canvas.width,canvas.height);
              canvasContext.drawImage(off,0,0,canvas.width,canvas.height);
            } finally { off.width=off.height=0; }
          });
          return {promise,cancel(){cancelled=true;cancellation.abort();}};
        }
      };
    }
    async function getOutline() {
      let flat;
      try { flat=await scheduler.requestOutline(); }
      catch(error) {
        if (error?.message !== 'DJVU_LAZY_OUTLINE_UNCERTAIN' || typeof outlineFallback !== 'function') throw error;
        const full=await outlineFallback();
        try {
          if (closed || full.numPages !== count) throw new Error('DJVU_PAGE_COUNT_MISMATCH');
          const outline=await full.getOutline();
          return closed ? [] : outline;
        } finally { full.destroy(); }
      }
      const roots=[], parents=[];
      for (const item of flat) {
        const page=Number(item.page);
        const node={title:item.title, dest:Number.isInteger(page)&&page>=1&&page<=count ? [page] : null, items:[]};
        while (parents.length > item.depth) parents.pop();
        if (parents.length) parents[parents.length-1].items.push(node); else roots.push(node);
        parents.push(node);
      }
      return roots;
    }
    return {numPages:count,getPage, getOutline, getPageIndex:async page=>page-1,
      outlineNeedsFullSource:worker.outlineNeedsFullSource,
      readerRenderScaleLimit: Infinity, readerMaxCanvasPixels: 16_000_000,
      destroy(){if(!closed){closed=true;geometries.clear();scheduler.close();}},
      scheduler};
  } catch(error) {worker.close();throw error;}
}

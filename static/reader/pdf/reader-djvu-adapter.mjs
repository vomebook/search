import {createDjvuWorkerAdapter} from './reader-djvu-worker.mjs';
import {createDjvuScheduler} from './reader-djvu-scheduler.mjs';

// PDF-shaped document interface, enabling the existing Reader's
// page-window, zoom, selection, search and OCR surfaces to be reused unchanged.
export async function openDjvuDocument({ workerUrl, bytes, pageMap, signal, cacheBytes, cachePages, createWorker }) {
  const worker=createDjvuWorkerAdapter(workerUrl,{cacheBytes,createWorker});
  try {
    if (!pageMap) throw new Error('DJVU_VERIFIED_PAGE_MAP_REQUIRED');
    const count=await worker.open(bytes,signal);
    if (!Array.isArray(pageMap?.pages) || pageMap.pages.length!==count) throw new Error('DJVU_PAGE_MAP_MISMATCH');
    for (const [index,page] of pageMap.pages.entries())
      if (page.page!==index+1 || !Number.isFinite(page.width) || !Number.isFinite(page.height) ||
          !(page.width>0) || !(page.height>0) || ![0,90,180,270].includes(page.rotation) ||
          !Array.isArray(page.djvu?.pixels) || page.djvu.pixels.length!==2 ||
          !page.djvu.pixels.every(n=>Number.isSafeInteger(n) && n>0) ||
          !Number.isSafeInteger(page.djvu.dpi) || page.djvu.dpi<1) throw new Error('DJVU_PAGE_MAP_INVALID');
    for (const page of pageMap.pages) {
      const pixels = page.rotation === 90 || page.rotation === 270
        ? [page.djvu.pixels[1],page.djvu.pixels[0]] : page.djvu.pixels;
      if (Math.abs(page.width - pixels[0]*72/page.djvu.dpi) > .001 ||
          Math.abs(page.height - pixels[1]*72/page.djvu.dpi) > .001) throw new Error('DJVU_PAGE_MAP_INVALID');
    }
    const scheduler=createDjvuScheduler(worker,{maxBytes:cacheBytes,maxPages:cachePages});
    let closed=false;
    function getPage(number) {
      if (closed || !Number.isInteger(number) || number<1 || number>count) throw new Error('DJVU_PAGE_INVALID');
      const map=pageMap.pages[number-1];
      const geometry = map;
      return Promise.resolve({
        getViewport({scale}) {return {width:geometry.width*scale,height:geometry.height*scale,scale};},
        getTextContent:async()=>({items:[],styles:{}}),
        render({canvasContext, readerPriority=0}) {
          let cancelled=false;
          const cancellation=new AbortController();
          const promise=scheduler.request(number,readerPriority,{signal:cancellation.signal}).then(({image,width,height,dpi,rotation})=>{
            if (cancelled || closed) throw new DOMException('DjVu render cancelled','AbortError');
            const pixels = map.djvu?.pixels;
            const expected = map.rotation === 90 || map.rotation === 270 ? [pixels?.[1],pixels?.[0]] : pixels;
            if (Math.abs((width/height)/(geometry.width/geometry.height)-1)>.01 ||
                !Array.isArray(expected) || width!==expected[0] || height!==expected[1] ||
                dpi!==map.djvu?.dpi || rotation!==map.rotation) throw new Error('DJVU_PAGE_GEOMETRY_MISMATCH');
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
      });
    }
    async function getOutline() {
      const flat=await scheduler.requestOutline(), roots=[], parents=[];
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
      readerRenderScaleLimit: Infinity, readerMaxCanvasPixels: 16_000_000,
      destroy(){if(!closed){closed=true;scheduler.close();}},
      scheduler};
  } catch(error) {worker.close();throw error;}
}

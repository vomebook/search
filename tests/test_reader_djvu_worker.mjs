import assert from "node:assert/strict";
import { createDjvuWorkerAdapter } from "../static/reader/pdf/reader-djvu-worker.mjs";
import { openDjvuDocument } from "../static/reader/pdf/reader-djvu-adapter.mjs";

globalThis.ImageData = class ImageData {
  constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); }
};
function engine({ count = 2, bundled = true, geometry = [10, 20, 300, 0], hang = false, image = null, contents = null } = {}) {
  let instance;
  class Worker {
    constructor() { instance = this; this.worker = {}; this.terminated = false; this.decodeCalls = 0; this.openCalls = 0; }
    createDocument() { this.openCalls++; return hang ? new Promise(() => {}) : Promise.resolve(); }
    get doc() {
      return {
        getPagesQuantity: () => ({ property: "count" }), isBundled: () => ({ property: "bundled" }),
        getContents: () => ({run: () => Promise.resolve(contents)}),
        getPageNumberByUrl: url => ({property:'url',url}),
        getPage: () => ({ getWidth: () => ({}), getHeight: () => ({}), getDpi: () => ({}), getRotation: () => ({}),
          getImageData: () => ({ run: () => { this.decodeCalls++; return Promise.resolve(image || new ImageData(10, 20)); } }) })
      };
    }
    run(...args) {
      if (args[0]?.property === 'url') {
        const values = args.map(arg => arg.url === '#page-two' ? 2 : null);
        return Promise.resolve(values.length === 1 ? values[0] : values);
      }
      return Promise.resolve(args.length === 2 ? [count, bundled] : geometry);
    }
    terminate() { this.terminated = true; }
  }
  return { DjVu: { Worker }, get instance() { return instance; } };
}
const bytes = () => new ArrayBuffer(16);
const map = { pages: [1, 2].map(page => ({ page, width: 2.4, height: 4.8, rotation: 0,
  djvu: { pixels: [10, 20], dpi: 300 } })) };

{
  const fake = engine(); const worker = createDjvuWorkerAdapter(fake.DjVu, "/djvu.js");
  assert.equal(await worker.open(bytes()), 2);
  assert.equal((await worker.page(1)).image.data.byteLength, 800);
  worker.close(); assert.equal(fake.instance.terminated, true);
}
{
  const fake = engine({ geometry: [50000, 50000, 300, 0] });
  const worker = createDjvuWorkerAdapter(fake.DjVu, "/djvu.js"); await worker.open(bytes());
  await assert.rejects(worker.page(1), /DJVU_PAGE_GEOMETRY_INVALID/);
  assert.equal(fake.instance.decodeCalls, 0, "oversized page must be rejected before decode"); worker.close();
}
{
  const fake = engine({ image: new ImageData(9, 20) });
  const worker = createDjvuWorkerAdapter(fake.DjVu, "/djvu.js"); await worker.open(bytes());
  await assert.rejects(worker.page(1), /DJVU_PAGE_DECODE_INVALID/); worker.close();
}
{
  const fake = engine({ bundled: false }); const worker = createDjvuWorkerAdapter(fake.DjVu, "/djvu.js");
  await assert.rejects(worker.open(bytes()), /DJVU_INDIRECT_UNSUPPORTED/); assert.equal(fake.instance.terminated, true);
}
{
  const fake = engine({ hang: true }); const worker = createDjvuWorkerAdapter(fake.DjVu, "/djvu.js", { timeoutMs: 10 });
  await assert.rejects(worker.open(bytes()), /DJVU_WORKER_TIMEOUT/); assert.equal(fake.instance.terminated, true);
}
for (const type of ["error", "messageerror", "cancel"]) {
  const fake = engine({ hang: true }); const worker = createDjvuWorkerAdapter(fake.DjVu, "/djvu.js");
  const cancel = new AbortController(); const opening = worker.open(bytes(), cancel.signal);
  await Promise.resolve();
  if (type === "error") fake.instance.worker.onerror({ message: "failed" });
  else if (type === "messageerror") fake.instance.worker.onmessageerror();
  else cancel.abort();
  await assert.rejects(opening, type === "cancel" ? { name: "AbortError" } : /DJVU_WORKER_/);
  assert.equal(fake.instance.terminated, true);
}
{
  const fake = engine(); const worker = createDjvuWorkerAdapter(fake.DjVu, "/djvu.js");
  const cancel = new AbortController(); const opening = worker.open(bytes(), cancel.signal);
  cancel.abort(); await assert.rejects(opening, { name: "AbortError" });
  assert.equal(fake.instance.openCalls, 0, "abort before dispatch must not start the Worker");
  assert.equal(fake.instance.terminated, true);
}
{
  const fake = engine();
  await assert.rejects(openDjvuDocument({ DjVu: fake.DjVu, libraryUrl: "/djvu.js", bytes: bytes(),
    pageMap: { pages: map.pages.slice(0, 1) } }), /DJVU_PAGE_MAP_MISMATCH/);
  assert.equal(fake.instance.terminated, true);
}
{
  const fake = engine({contents:[{description:'第一章',url:'#page-two',children:[{description:'外部链接',url:'https://example.org/'}]}]});
  const pdf = await openDjvuDocument({ DjVu:fake.DjVu,libraryUrl:'/djvu.js',bytes:bytes(),pageMap:map });
  const outline=await pdf.getOutline();
  assert.equal(outline[0].title,'第一章');
  assert.equal(await pdf.getPageIndex(outline[0].dest[0]),1);
  assert.equal(outline[0].items[0].dest,null,'external TOC URL must not navigate');
  pdf.destroy();
}
{
  const fake=engine({contents:Array.from({length:2001},()=>({description:'x',url:'#1'}))});
  const worker=createDjvuWorkerAdapter(fake.DjVu,'/djvu.js');await worker.open(bytes());
  await assert.rejects(worker.outline(),/DJVU_OUTLINE_INVALID/);
  worker.close();
}
{
  const fake = engine();
  const pdf = await openDjvuDocument({ DjVu: fake.DjVu, libraryUrl: "/djvu.js", bytes: bytes(),
    pageMap: { pages: [{ ...map.pages[0], width: 11*72/300, djvu: { pixels: [11, 20], dpi: 300 } }, map.pages[1]] } });
  assert.equal(pdf.readerRenderScaleLimit, Infinity, 'native high-DPI pages must follow the actual zoom width');
  const page = await pdf.getPage(1);
  await assert.rejects(page.render({ canvasContext: {} }).promise, /DJVU_PAGE_GEOMETRY_MISMATCH/);
  pdf.destroy(); assert.equal(fake.instance.terminated, true);
}
console.log("DjVu Worker bounds, errors, timeout, cancellation and geometry checks passed");

import assert from 'node:assert/strict';
import {createDjvuWorkerAdapter} from '../../../static/reader/pdf/reader-djvu-worker.mjs';
import {openDjvuDocument} from '../../../static/reader/pdf/reader-djvu-adapter.mjs';

globalThis.ImageData = class ImageData {
  constructor(data,width,height) { this.data=data; this.width=width; this.height=height; }
};
function fakeEngine({count=2, width=10, height=20, dpi=300, rotation=0, hang=false,
  entries=[], badData=false, openError=null, outlineError=null} = {}) {
  let instance;
  const createWorker = () => instance = {
    terminated:false, sends:[],
    postMessage(message, transfer) {
      this.sends.push({message,transfer});
      if (hang) return;
      const result=message.operation==='prepare' ? {id:message.id,ok:true} : message.operation==='open'
        ? openError ? {id:message.id,ok:false,error:openError} : {id:message.id,ok:true,count}
        : message.operation==='outline' ? outlineError ? {id:message.id,ok:false,error:outlineError} : {id:message.id,ok:true,entries}
        : message.operation==='stats' ? {id:message.id,ok:true,cacheBytes:200}
        : message.operation==='geometry' ? {id:message.id,ok:true,width,height,dpi,rotation}
        : message.operation==='text' ? {id:message.id,ok:true,text:'Hello world\n',zones:[
            {t:'Hello',x:0,y:0,w:5,h:5},{t:'world',x:5,y:0,w:5,h:5}]}
        : {id:message.id,ok:true,width,height,dpi,rotation,
           pixels:new ArrayBuffer(badData ? 1 : width*height*4)};
      queueMicrotask(()=>this.onmessage({data:result}));
    },
    terminate() { this.terminated=true; }
  };
  return {createWorker,get instance(){return instance;}};
}
const bytes=()=>new ArrayBuffer(16);
const map={pages:[1,2].map(page=>({page,width:2.4,height:4.8,rotation:0,
  djvu:{pixels:[10,20],dpi:300}}))};
{
  const fake=fakeEngine(),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  await worker.prepare();
  assert.equal(fake.instance.sends[0].message.operation,'prepare');
  assert.equal(fake.instance.sends[0].transfer.length,0,'preparation must not transfer unverified source bytes');
  assert.equal(await worker.open(bytes()),2);
  worker.close();assert.equal(fake.instance.terminated,true);
}
{
  const fake=fakeEngine({hang:true}),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  const controller=new AbortController(),preparing=worker.prepare(controller.signal);
  controller.abort();await assert.rejects(preparing,{name:'AbortError'});
  assert.equal(fake.instance.terminated,true,'cancelled preparation terminates its worker');
}
{
  const fake=fakeEngine(),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  assert.equal(await worker.open(bytes()),2);
  assert.equal((await worker.page(1)).image.data.byteLength,800);
  assert.equal((await worker.stats()).decodedCacheBytes,200);
  assert.equal(fake.instance.sends[0].transfer.length,1,'source ownership must transfer');
  worker.close();assert.equal(fake.instance.terminated,true);
}
{
  let instance,closed=0;
  const rangeReader={total:100,close(){closed++},async read(offset,length){
    assert.equal(offset,0);assert.equal(length,8);return new Uint8Array(length).fill(42);
  }};
  const worker=createDjvuWorkerAdapter('/worker',{rangeReader,createWorker:()=>instance={
    postMessage(message){
      if(message.operation==='open-range')queueMicrotask(()=>this.onmessage({data:{id:message.id,operation:'range',rangeId:1,offset:0,length:8}}));
      else if(message.operation==='range-result'){
        assert.equal(new Uint8Array(message.bytes)[0],42);
        queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,count:2}}));
      }
    },terminate(){}
  }});
  assert.equal(await worker.openRange(),2);worker.close();assert.equal(closed,1);
}
{
  const changed=Object.assign(new Error('DJVU_SOURCE_CHANGED'),{code:'DJVU_SOURCE_CHANGED'});let instance,closed=0;
  const rangeReader={total:100,close(){closed++},get failure(){return changed},async read(){throw changed}};
  const worker=createDjvuWorkerAdapter('/worker',{rangeReader,createWorker:()=>instance={
    postMessage(message){if(message.operation==='open-range')queueMicrotask(()=>this.onmessage({data:{id:message.id,operation:'range',rangeId:1,offset:0,length:8}}));},
    terminate(){this.terminated=true}
  }});
  await assert.rejects(worker.openRange(),/DJVU_SOURCE_CHANGED/);assert.equal(instance.terminated,true);assert.equal(closed,1);
}
{
  let instance,closed=0;const rangeReader={total:100,close(){closed++},async read(){throw Error('must not read')}};
  const worker=createDjvuWorkerAdapter('/worker',{rangeReader,createWorker:()=>instance={
    postMessage(message){if(message.operation==='open-range')queueMicrotask(()=>this.onmessage({data:{id:message.id,operation:'range',rangeId:1,offset:99,length:2}}));},
    terminate(){this.terminated=true}
  }});
  await assert.rejects(worker.openRange(),/DJVU_WORKER_PROTOCOL/);assert.equal(instance.terminated,true);assert.equal(closed,1);
}
{
  const fake=fakeEngine(),pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,
    bytes:bytes(),cacheBytes:1024,cachePages:2});
  const page=await pdf.getPage(1), viewport=page.getViewport({scale:1}), text=await page.getTextContent();
  assert.equal(viewport.width,2.4);assert.equal(viewport.height,4.8);
  assert.equal(text.items.map(item=>item.str).join(''),'Hello world\n');
  assert.equal(text.readerTextZones.length,2);
  let drawn=0;
  globalThis.OffscreenCanvas=class {getContext(){return {putImageData(){}}}};
  await page.render({canvasContext:{canvas:{width:10,height:20},clearRect(){},drawImage(){drawn++;}}}).promise;
  assert.equal(drawn,1);pdf.destroy();assert.equal(fake.instance.terminated,true);
}
{
  const fake=fakeEngine(),pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,
    bytes:bytes(),pageMap:map,cacheBytes:1024,cachePages:2});
  const page=await pdf.getPage(1);
  assert.equal(fake.instance.sends.filter(({message})=>message.operation==='geometry').length,0,
    'geometry is fetched only when the embedded text is requested');
  const text=await page.getTextContent();
  assert.equal(text.items.map(item=>item.str).join(''),'Hello world\n');
  assert.deepEqual(text.readerTextZones[1].box,[.5,0,1,.25]);
  assert.equal(fake.instance.sends.filter(({message})=>message.operation==='text').length,1);
  pdf.destroy();
}
{
  const fake=fakeEngine(),pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,
    bytes:bytes(),pageMap:{pages:[{...map.pages[0],width:11*72/300,djvu:{pixels:[11,20],dpi:300}},map.pages[1]]},
    cacheBytes:1024,cachePages:2});
  await assert.rejects((await pdf.getPage(1)).getTextContent(),/DJVU_PAGE_GEOMETRY_MISMATCH/);
  assert.equal(fake.instance.sends.filter(({message})=>message.operation==='text').length,0);
  pdf.destroy();
}
{
  const fake=fakeEngine(),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  await worker.open(bytes());
  const first=worker.page(1);
  const second=first.then(()=>worker.page(2));
  await second;worker.close();
}
{
  const fake=fakeEngine({badData:true}),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  await worker.open(bytes());await assert.rejects(worker.page(1),/DJVU_PAGE_DECODE_INVALID/);worker.close();
}
{
  const fake=fakeEngine({count:10001}),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  await assert.rejects(worker.open(bytes()),/DJVU_PAGE_COUNT_INVALID/);assert.equal(fake.instance.terminated,true);
}
{
  const fake=fakeEngine({openError:'DJVU_OPEN_FAILED'}),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  await assert.rejects(worker.open(bytes()),/DJVU_OPEN_FAILED/);assert.equal(fake.instance.terminated,true);
}
{
  const fake=fakeEngine({hang:true}),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker,timeoutMs:10});
  await assert.rejects(worker.open(bytes()),/DJVU_WORKER_TIMEOUT/);assert.equal(fake.instance.terminated,true);
}
for(const type of ['error','messageerror','cancel']) {
  const fake=fakeEngine({hang:true}),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  const cancel=new AbortController(),opening=worker.open(bytes(),cancel.signal);
  if(type==='error')fake.instance.onerror({message:'failed'});
  else if(type==='messageerror')fake.instance.onmessageerror();else cancel.abort();
  await assert.rejects(opening,type==='cancel'?{name:'AbortError'}:/DJVU_WORKER_/);
  assert.equal(fake.instance.terminated,true);
}
{
  const fake=fakeEngine(),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  const cancel=new AbortController();cancel.abort();
  await assert.rejects(worker.open(bytes(),cancel.signal),{name:'AbortError'});
  assert.equal(fake.instance.sends.length,0);assert.equal(fake.instance.terminated,true);
}
{
  const fake=fakeEngine({hang:true}),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  const opening=worker.open(bytes());fake.instance.onmessage({data:{id:999,ok:true}});
  await assert.rejects(opening,/DJVU_WORKER_PROTOCOL/);assert.equal(fake.instance.terminated,true);
}
{
  const fake=fakeEngine();
  await assert.rejects(openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes(),
    pageMap:{pages:map.pages.slice(0,1)},cacheBytes:1024,cachePages:2}),/DJVU_PAGE_MAP_MISMATCH/);
  assert.equal(fake.instance.terminated,true);
}
{
  const entries=[{title:'第一章',page:2,depth:0},{title:'外部链接',page:0,depth:1}];
  const fake=fakeEngine({entries});
  const pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes(),
    pageMap:map,cacheBytes:1024,cachePages:2});
  const outline=await pdf.getOutline();
  assert.equal(outline[0].title,'第一章');assert.equal(await pdf.getPageIndex(outline[0].dest[0]),1);
  assert.equal(outline[0].items[0].dest,null);pdf.destroy();
}
{
  const fake=fakeEngine({outlineError:'DJVU_LAZY_OUTLINE_UNCERTAIN'});let destroyed=0;
  const result=[{title:'Late TOC',dest:[2],items:[]}];
  const pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes(),
    cacheBytes:1024,cachePages:2,outlineFallback:async()=>({numPages:2,getOutline:async()=>result,destroy(){destroyed++}})});
  assert.deepEqual(await pdf.getOutline(),result);assert.equal(destroyed,1);pdf.destroy();
}
{
  const fake=fakeEngine({outlineError:'DJVU_LAZY_OUTLINE_UNCERTAIN'});let destroyed=0;
  const pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes(),
    cacheBytes:1024,cachePages:2,outlineFallback:async()=>({numPages:3,getOutline:async()=>[],destroy(){destroyed++}})});
  await assert.rejects(pdf.getOutline(),/DJVU_PAGE_COUNT_MISMATCH/);assert.equal(destroyed,1);pdf.destroy();
}
{
  const fake=fakeEngine({outlineError:'DJVU_LAZY_OUTLINE_UNCERTAIN'});let release,destroyed=0;
  const pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes(),cacheBytes:1024,cachePages:2,
    outlineFallback:()=>new Promise(resolve=>release=resolve)});
  const pending=pdf.getOutline();
  await new Promise(resolve=>setTimeout(resolve,0));
  pdf.destroy();release({numPages:2,getOutline:async()=>[{title:'stale'}],destroy(){destroyed++}});
  await assert.rejects(pending,/DJVU_PAGE_COUNT_MISMATCH/);assert.equal(destroyed,1);
}
{
  const fake=fakeEngine(),pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes(),
    pageMap:{pages:[{...map.pages[0],width:11*72/300,djvu:{pixels:[11,20],dpi:300}},map.pages[1]]},
    cacheBytes:1024,cachePages:2});
  const page=await pdf.getPage(1);await assert.rejects(page.render({canvasContext:{}}).promise,/DJVU_PAGE_GEOMETRY_MISMATCH/);
  pdf.destroy();assert.equal(fake.instance.terminated,true);
}
// Untrusted worker message contracts: malformed text and outlines must fail
// closed rather than entering the PDF-shaped Reader document.
{
  async function responseFor(operation, response) {
    const createWorker=()=>({
      postMessage(message){
        const value=message.operation==='open' ? {count:2} : response;
        queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,...value}}));
      },terminate(){}
    });
    const worker=createDjvuWorkerAdapter('/worker',{createWorker});
    await worker.open(bytes());
    try { return await (operation==='text' ? worker.text(1) : worker.outline()); }
    finally { worker.close(); }
  }
  for (const zones of [[null], [{t:'a',x:NaN,y:0,w:1,h:1}], [{t:'a',x:0,y:0,w:1,h:-1}], [{t:17,x:0,y:0,w:1,h:1}]])
    await assert.rejects(responseFor('text',{text:'a',zones}),/DJVU_TEXT_INVALID/);
  for (const entries of [[null], [{title:'wrong',depth:1,page:1}],
    [{title:'one',depth:0,page:1},{title:'skipped depth',depth:2,page:2}],
    [{title:'one',depth:0,page:3}], [{title:'one',depth:0,page:'1'}]])
    await assert.rejects(responseFor('outline',{entries}),/DJVU_OUTLINE_INVALID/);
  assert.deepEqual(await responseFor('outline',{entries:[{title:'one',depth:0,page:1},{title:'two',depth:1,page:2}]}),
    [{title:'one',depth:0,page:1},{title:'two',depth:1,page:2}]);
}
{
  const fake=fakeEngine({hang:true}),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  const opening=worker.open(bytes());fake.instance.onmessage({data:null});
  await assert.rejects(opening,/DJVU_WORKER_PROTOCOL/);assert.equal(fake.instance.terminated,true);
}
{
  const fake=fakeEngine({hang:true}),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  const opening=worker.open(bytes());fake.instance.onmessage({data:{id:1,ok:'yes'}});
  await assert.rejects(opening,/DJVU_WORKER_PROTOCOL/);assert.equal(fake.instance.terminated,true);
}
{
  // Exercise invalid operation responses and serialization without relying on
  // the decoder process; ownership and fatal settlement remain observable.
  let instance;
  const createWorker=()=>instance={postMessage(message){
    const payload=message.operation==='open'?{count:2}:message.operation==='geometry'
      ? {width:0,height:10,dpi:300,rotation:0}:{cacheBytes:-1};
    queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,...payload}}));
  },terminate(){this.terminated=true}};
  const worker=createDjvuWorkerAdapter('/worker',{createWorker});
  await assert.rejects(worker.open(undefined),/DJVU_DOCUMENT_INVALID/);
  await assert.rejects(worker.openRange(),/DJVU_DOCUMENT_INVALID/);
  await worker.open(bytes());
  for (const call of [()=>worker.page(3),()=>worker.geometry(0),()=>worker.text(3)])
    await assert.rejects(call(),/DJVU_PAGE_INVALID/);
  await assert.rejects(worker.geometry(1),/DJVU_PAGE_GEOMETRY_INVALID/);
  await assert.rejects(worker.stats(),/DJVU_WORKER_PROTOCOL/);
  assert.equal(worker.closed,false);worker.close();assert.equal(worker.closed,true);
  await assert.rejects(worker.prepare(),{name:'AbortError'});assert.equal(instance.terminated,true);
}
{
  const fake=fakeEngine({hang:true}),worker=createDjvuWorkerAdapter('/worker',{createWorker:fake.createWorker});
  const opening=worker.open(bytes());
  await assert.rejects(worker.prepare(),/DJVU_ADAPTER_CONCURRENT_TASK/);
  await assert.rejects(opening,/DJVU_ADAPTER_CONCURRENT_TASK/);assert.equal(fake.instance.terminated,true);
}
{
  const worker=createDjvuWorkerAdapter('/worker',{createWorker:()=>({
    postMessage(){throw Error('message transport failed')},terminate(){this.terminated=true}
  })});
  await assert.rejects(worker.open(bytes()),/DJVU_WORKER_FAILED/);
}
{
  // Keep the browser's default Worker factory in the contract; prior tests
  // inject their own worker to control every response.
  const previous=globalThis.Worker;let instance;
  try {
    globalThis.Worker=class {
      constructor(url,options){assert.equal(url,'/worker');assert.equal(options.type,'module');instance=this;}
      postMessage(message){queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true}}));}
      terminate(){this.terminated=true;}
    };
    const worker=createDjvuWorkerAdapter('/worker');await worker.prepare();worker.close();
    assert.equal(instance.terminated,true);
  } finally { if (previous===undefined) delete globalThis.Worker; else globalThis.Worker=previous; }
}
{
  // Range error codes from the main-thread transport must stay predictable,
  // including primitive throws and unknown/malformed error messages.
  for (const [failure, expected] of [
    [new Error('DJVU_SOURCE_CHANGED'),'DJVU_SOURCE_CHANGED'],
    [new Error('transport failed'),'DJVU_RANGE_FAILED'],
    ['offline','DJVU_RANGE_FAILED'],
    [Object.assign(()=>{}, {code:'DJVU_RANGE_INVALID'}),'DJVU_RANGE_INVALID']
  ]) {
    let instance;
    const rangeReader={total:100,close(){},async read(){throw failure}};
    const createWorker=()=>instance={postMessage(message){
      if(message.operation==='open-range') queueMicrotask(()=>this.onmessage({data:{id:message.id,operation:'range',rangeId:1,offset:0,length:8}}));
      else if(message.operation==='range-result') {
        assert.equal(message.ok,false);assert.equal(message.error,expected);
        queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:false,error:message.error}}));
      }
    },terminate(){}};
    const worker=createDjvuWorkerAdapter('/worker',{rangeReader,createWorker});
    await assert.rejects(worker.openRange(),new RegExp(expected));assert.equal(worker.closed,true);
  }
}
{
  const rangeReader={total:100,close(){},async read(){return new Uint8Array(8)}};
  const createWorker=()=>({postMessage(message){
    queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,count:10001}}));
  },terminate(){this.terminated=true}});
  const worker=createDjvuWorkerAdapter('/worker',{rangeReader,createWorker});
  await assert.rejects(worker.openRange(),/DJVU_PAGE_COUNT_INVALID/);assert.equal(worker.closed,true);
}
// Document boundary: page-map integrity, rotations and caches must stay
// correct while the PDF-shaped adapter receives typed but untrusted input.
{
  const valid=()=>({pages:[1,2].map(page=>({page,width:2.4,height:4.8,rotation:0,djvu:{pixels:[10,20],dpi:300}}))});
  for(const pageMap of [{}, {pages:[]}, {pages:'bad'}]) {
    const fake=fakeEngine();await assert.rejects(openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,
      bytes:bytes(),pageMap}),/DJVU_PAGE_MAP_MISMATCH/);assert.equal(fake.instance.terminated,true);
  }
  for(const change of [page=>page.page=2,page=>page.width=NaN,page=>page.height=0,
    page=>page.rotation=45,page=>delete page.djvu,page=>page.djvu.pixels=[1],
    page=>page.djvu.pixels=[10,0],page=>page.djvu.dpi=0,page=>page.width=99]) {
    const pageMap=valid();change(pageMap.pages[0]);const fake=fakeEngine();
    await assert.rejects(openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,
      bytes:bytes(),pageMap}),/DJVU_PAGE_MAP_INVALID/);assert.equal(fake.instance.terminated,true);
  }
  const sparse=valid();delete sparse.pages[0];const fake=fakeEngine();
  await assert.rejects(openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,
    bytes:bytes(),pageMap:sparse}),/DJVU_PAGE_MAP_INVALID/);assert.equal(fake.instance.terminated,true);
}
{
  const pageMap={pages:[1,2].map(page=>({page,width:4.8,height:2.4,rotation:90,djvu:{pixels:[10,20],dpi:300}}))};
  const fake=fakeEngine({width:20,height:10,dpi:300,rotation:90});
  const pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes(),pageMap});
  const first=await pdf.getPage(1);assert.equal(first.getViewport({scale:2}).width,9.6);
  const text=await first.getTextContent();assert.equal(text.items.map(item=>item.str).join(''),'Hello world\n');
  await first.render({canvasContext:{canvas:{width:20,height:10},clearRect(){},drawImage(){}}}).promise;
  pdf.destroy();
}
{
  const fake=fakeEngine(),pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes()});
  await pdf.getPage(1);await pdf.getPage(1);
  assert.equal(fake.instance.sends.filter(({message})=>message.operation==='geometry').length,1,'second page lookup uses cached geometry');
  await assert.rejects(pdf.getPage(0),/DJVU_PAGE_INVALID/);await assert.rejects(pdf.getPage(3),/DJVU_PAGE_INVALID/);
  pdf.destroy();await assert.rejects(pdf.getPage(1),/DJVU_PAGE_INVALID/);
}
{
  const fake=fakeEngine({count:130}),pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,
    bytes:bytes(),cacheBytes:1024,cachePages:1});
  for(let page=1;page<=130;page++) await pdf.getPage(page);
  await pdf.getPage(1);
  assert.equal(fake.instance.sends.filter(({message})=>message.operation==='geometry').length,131,
    'geometry cache evicts least-recently-used pages at 128 entries');
  pdf.destroy();
}
{
  // Null canvas, cancellation and temporary raster ownership are explicit
  // document API behaviors, not just type declarations.
  const fake=fakeEngine(),pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes()});
  const page=await pdf.getPage(1),viewport=page.getViewport({scale:2});
  assert.deepEqual(viewport.convertToViewportPoint(1,2),[2,(4.8-2)*2]);
  globalThis.OffscreenCanvas=class {getContext(){return null}};
  await assert.rejects(page.render({canvasContext:{}}).promise,/DJVU_CANVAS_UNAVAILABLE/);
  globalThis.OffscreenCanvas=class {getContext(){return {putImageData(){}}}};
  const rendering=page.render({canvasContext:{canvas:{width:10,height:20},clearRect(){},drawImage(){}}});
  rendering.cancel();await assert.rejects(rendering.promise,{name:'AbortError'});pdf.destroy();
}
{
  // Real outline nesting must retain roots and correctly pop to a shallower
  // parent; a genuine decoder failure is never mistaken for fallback.
  const entries=[{title:'root',page:1,depth:0},{title:'child',page:2,depth:1},
    {title:'sibling root',page:2,depth:0}];
  const fake=fakeEngine({entries});const pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes()});
  const outline=await pdf.getOutline();assert.equal(outline.length,2);assert.equal(outline[0].items[0].title,'child');
  assert.equal(outline[1].title,'sibling root');pdf.destroy();
  const failed=fakeEngine({outlineError:'DJVU_WORKER_FAILED'});let called=false;
  const other=await openDjvuDocument({workerUrl:'/worker',createWorker:failed.createWorker,bytes:bytes(),
    outlineFallback:async()=>{called=true;return {numPages:2,getOutline:async()=>[],destroy(){}}}});
  await assert.rejects(other.getOutline(),/DJVU_WORKER_FAILED/);assert.equal(called,false);other.destroy();
}
{
  // When the full fallback resolves after destroy, do not publish stale TOC;
  // still destroy the fallback document exactly once.
  const fake=fakeEngine({outlineError:'DJVU_LAZY_OUTLINE_UNCERTAIN'});let release,destroyed=0;
  const pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes(),
    outlineFallback:async()=>({numPages:2,getOutline:()=>new Promise(resolve=>release=resolve),destroy(){destroyed++}})});
  const pending=pdf.getOutline();while(!release)await new Promise(resolve=>setTimeout(resolve,0));
  pdf.destroy();release([{title:'stale',dest:[1],items:[]}]);assert.deepEqual(await pending,[]);assert.equal(destroyed,1);
}
{
  // Exercise the HTML canvas fallback when OffscreenCanvas is absent, and
  // release its backing bitmap even when drawing fails.
  const previous=globalThis.OffscreenCanvas,oldDocument=globalThis.document;let bitmap,drawn=0;
  try {
    delete globalThis.OffscreenCanvas;
    globalThis.document={createElement(name){assert.equal(name,'canvas');return bitmap={width:0,height:0,
      getContext(){return {putImageData(){}}}}}};
    const fake=fakeEngine(),pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes()});
    await (await pdf.getPage(1)).render({canvasContext:{canvas:{width:10,height:20},clearRect(){},drawImage(){drawn++}}}).promise;
    assert.equal(drawn,1);assert.equal(bitmap.width,0);assert.equal(bitmap.height,0);pdf.destroy();
  } finally {if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;}
}
console.log('DjVu Worker bounds, errors, timeout, cancellation and geometry checks passed');

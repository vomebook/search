import assert from 'node:assert/strict';
import {createDjvuWorkerAdapter} from '../static/reader/pdf/reader-djvu-worker.mjs';
import {openDjvuDocument} from '../static/reader/pdf/reader-djvu-adapter.mjs';

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
      const result=message.operation==='open'
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
console.log('DjVu Worker bounds, errors, timeout, cancellation and geometry checks passed');

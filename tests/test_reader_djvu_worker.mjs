import assert from 'node:assert/strict';
import {createDjvuWorkerAdapter} from '../static/reader/pdf/reader-djvu-worker.mjs';
import {openDjvuDocument} from '../static/reader/pdf/reader-djvu-adapter.mjs';

globalThis.ImageData = class ImageData {
  constructor(data,width,height) { this.data=data; this.width=width; this.height=height; }
};
function fakeEngine({count=2, width=10, height=20, dpi=300, rotation=0, hang=false,
  entries=[], badData=false, openError=null} = {}) {
  let instance;
  const createWorker = () => instance = {
    terminated:false, sends:[],
    postMessage(message, transfer) {
      this.sends.push({message,transfer});
      if (hang) return;
      const result=message.operation==='open'
        ? openError ? {id:message.id,ok:false,error:openError} : {id:message.id,ok:true,count}
        : message.operation==='outline' ? {id:message.id,ok:true,entries}
        : message.operation==='stats' ? {id:message.id,ok:true,cacheBytes:200}
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
  const fake=fakeEngine(),pdf=await openDjvuDocument({workerUrl:'/worker',createWorker:fake.createWorker,bytes:bytes(),
    pageMap:{pages:[{...map.pages[0],width:11*72/300,djvu:{pixels:[11,20],dpi:300}},map.pages[1]]},
    cacheBytes:1024,cachePages:2});
  const page=await pdf.getPage(1);await assert.rejects(page.render({canvasContext:{}}).promise,/DJVU_PAGE_GEOMETRY_MISMATCH/);
  pdf.destroy();assert.equal(fake.instance.terminated,true);
}
console.log('DjVu Worker bounds, errors, timeout, cancellation and geometry checks passed');

import test from 'node:test';
import assert from 'node:assert/strict';
import {openDjvuRange} from '../../../static/reader/pdf/reader-djvu-range.mjs';
import {createDjvuWorkerAdapter} from '../../../static/reader/pdf/reader-djvu-worker.mjs';
import {openDjvuDocument} from '../../../static/reader/pdf/reader-djvu-adapter.mjs';
import {createDjvuScheduler} from '../../../static/reader/pdf/reader-djvu-scheduler.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise, resolve}; };

test('worker permits a range retry beyond inactivity timeout but bounds its lifetime', async () => {
  const originalSet=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
  let now=0, sequence=0; const timers=new Map();
  globalThis.setTimeout=(fn,ms)=>{const id=++sequence;timers.set(id,{fn,at:now+ms});return id;};
  globalThis.clearTimeout=id=>timers.delete(id);
  const advance=async ms=>{
    const target=now+ms;
    for (;;) {
      const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
      if (!next || next[1].at>target) break;
      now=next[1].at;timers.delete(next[0]);next[1].fn();await tick();
    }
    now=target;await tick();
  };
  try {
    let reads=0,closed=0;
    const reader={total:100,close(){closed++;},read(){reads++;return new Promise(resolve=>setTimeout(()=>resolve(new Uint8Array(8)),150));}};
    const createWorker=()=>({postMessage(message){
      if(message.operation==='open-range') queueMicrotask(()=>this.onmessage({data:{id:message.id,operation:'range',rangeId:1,offset:0,length:8}}));
      if(message.operation==='range-result') queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,count:1}}));
    },terminate(){}});
    const worker=createDjvuWorkerAdapter('/worker',{createWorker,rangeReader:reader,timeoutMs:100});
    const opening=worker.openRange();await tick();await advance(100);
    assert.equal(worker.closed,false);await advance(50);
    assert.equal(await opening,1);assert.equal(reads,1);worker.close();assert.equal(closed,1);

    const hanging={total:100,close(){closed++;},read(){return new Promise(()=>{});}};
    const bounded=createDjvuWorkerAdapter('/worker',{createWorker,rangeReader:hanging,timeoutMs:100});
    const stuck=bounded.openRange();stuck.catch(()=>{});await tick();await advance(5*60_000);
    await assert.rejects(stuck,/DJVU_WORKER_TIMEOUT/);assert.equal(bounded.closed,true);
    assert.equal(closed,2);assert.equal(timers.size,0);
  } finally {globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('ignored range falls back without awaiting a stalled body cancellation', async () => {
  let cancels=0;
  const response={status:200,body:{cancel(){cancels++;return new Promise(()=>{});}}};
  await assert.rejects(openDjvuRange({url:'https://example.test/book.djvu',signal:new AbortController().signal,
    fetchResponse:async()=>response}),/DJVU_RANGE_UNSUPPORTED/);
  assert.ok(cancels>=1);
});

test('concurrent uncertain outlines share one fallback and destroy it once', async () => {
  const gate=deferred();let opens=0,destroys=0;
  const createWorker=()=>({postMessage(message){queueMicrotask(()=>this.onmessage({data:message.operation==='open'
    ? {id:message.id,ok:true,count:1} : {id:message.id,ok:false,error:'DJVU_LAZY_OUTLINE_UNCERTAIN'}}));},terminate(){}});
  const doc=await openDjvuDocument({workerUrl:'/worker',bytes:new ArrayBuffer(16),createWorker,
    outlineFallback:async()=>{opens++;await gate.promise;return {numPages:1,getOutline:async()=>[],destroy(){destroys++;}};}});
  const first=doc.getOutline(),second=doc.getOutline();await tick();
  assert.equal(opens,1);gate.resolve();assert.deepEqual(await first,[]);assert.deepEqual(await second,[]);
  assert.equal(destroys,1);doc.destroy();
});

test('text cancellation is per client and removes orphaned queued demand', async () => {
  const gate=deferred(), starts=[];let closes=0;
  const scheduler=createDjvuScheduler({page:async()=>{starts.push('page');return gate.promise;},
    text:async n=>{starts.push(`text:${n}`);return {text:String(n),zones:[]};},close(){closes++;}});
  const page=scheduler.request(1);await tick();
  const cancel=new AbortController();
  const orphan=scheduler.requestMetadata('text',2,2,{signal:cancel.signal});
  const dropped=scheduler.requestMetadata('text',3,2,{signal:cancel.signal});
  const survivor=scheduler.requestMetadata('text',3,0);
  cancel.abort();await assert.rejects(orphan,{name:'AbortError'});await assert.rejects(dropped,{name:'AbortError'});
  assert.equal(scheduler.stats().queued,1);assert.equal(closes,0);
  gate.resolve({image:{data:new Uint8ClampedArray(4)}});await page;
  assert.equal((await survivor).text,'3');assert.deepEqual(starts,['page','text:3']);
  scheduler.close();assert.equal(closes,1);
});

test('adapter text signal retires only its owner across shared active text', async () => {
  const gate=deferred();let textReads=0,terminated=0;
  const createWorker=()=>({postMessage(message){
    const reply=value=>queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,...value}}));
    if(message.operation==='open') reply({count:1});
    else if(message.operation==='geometry') reply({width:10,height:10,dpi:300,rotation:0});
    else if(message.operation==='text') {textReads++;gate.promise.then(()=>reply({text:'hello',zones:[]}));}
  },terminate(){terminated++;}});
  const doc=await openDjvuDocument({workerUrl:'/worker',bytes:new ArrayBuffer(16),createWorker});
  const page=await doc.getPage(1), cancel=new AbortController();
  const first=page.getTextContent({signal:cancel.signal});await tick();
  const second=page.getTextContent();await tick();cancel.abort();
  await assert.rejects(first,{name:'AbortError'});assert.equal(terminated,0);
  gate.resolve();assert.equal((await second).items[0].str,'hello');assert.equal(textReads,1);
  doc.destroy();assert.equal(terminated,1);
});

import assert from 'node:assert/strict';
import {createPdfFetchPolicy, openPdfRangeTask, preparePdfInitialRange}
  from '../../../static/reader/pdf/reader-pdf-network.mjs';
import {createPdfRangeCache, sharedPdfRangeCache} from '../../../static/reader/pdf/reader-pdf-range-cache.mjs';
import {runInNewContext} from 'node:vm';

globalThis.location = {href:'https://reader.test/'};
const originalFetch = globalThis.fetch;
const readBytes = async response => new Uint8Array(await response.arrayBuffer());
const options = {url:'https://reader.test/book.pdf',rangeChunkSize:4};
const turn = () => new Promise(resolve=>setImmediate(resolve));
const version = {etag:'"A"',total:20};

function rangeResponse(data, begin, end, etag='"A"') {
  return new Response(data.slice(begin,end), {status:206,headers:{
    'Content-Range':`bytes ${begin}-${end-1}/${data.length}`,ETag:etag}});
}

class Transport {
  constructor(length, initialData) { Object.assign(this,{length,initialData,received:[]}); }
  onDataRange(begin,bytes) { this.received.push({begin,bytes:[...bytes]}); }
}
const pdfjs = {PDFDataRangeTransport:Transport,getDocument:opts=>({
  promise:Promise.resolve(opts),destroy:async()=>{}})};

try {
  // A full GET fallback has bytes but no range version. Do not manufacture
  // undefined metadata properties or attempt any range lookahead.
  {
    const bytes = Uint8Array.of(1,2,3,4);
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response(bytes); };
    const hooks = {signal:new AbortController().signal,readBytes,limit:64,rangeCache:null,
      canPrefetchFirstPage:() => assert.fail('complete bodies do not need range hints')};
    const first = await preparePdfInitialRange(options,hooks);
    assert.equal(first.complete,true);
    assert.equal(Object.hasOwn(first,'total'),false);
    assert.equal(Object.hasOwn(first,'etag'),false);
    const task = await openPdfRangeTask(pdfjs,options,{...hooks,initial:Promise.resolve(first)});
    const result = await task.promise;
    assert.deepEqual(result.data,bytes);
    assert.equal(result.range,undefined);
    assert.equal(requests,1);
    await task.destroy();
  }

  for (const contentRange of ['bytes 0-3/*','bytes 0-3/9007199254740992']) {
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({cancel() { cancelled = true; }}),{
      status:206,headers:{'Content-Range':contentRange,ETag:'"A"'}});
    await assert.rejects(preparePdfInitialRange(options,{signal:new AbortController().signal,
      limit:64,rangeCache:null,readBytes:() => assert.fail('invalid range must not read the body')}),/PDF_RANGE_INVALID/);
    assert.equal(cancelled,true,contentRange);
  }

  // For a two-chunk PDF, overlap the only missing chunk with the prefix body.
  for (const scenario of ['fresh','deep','save-data','slow','weak','changed','close']) {
    const chunk=262144, total=492192, data=new Uint8Array(total).fill(42), requests=[];
    const prefix=Promise.withResolvers(), tail=Promise.withResolvers(), started=Promise.withResolvers();
    const nav=Object.getOwnPropertyDescriptor(globalThis,'navigator');
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{connection:{
      saveData:scenario==='save-data',effectiveType:scenario==='slow'?'2g':'4g'}}});
    const owner=new AbortController(), cache=createPdfRangeCache(), errors=[];
    const opts={...options,rangeChunkSize:chunk};
    const hooks={signal:owner.signal,readBytes,limit:total,rangeCache:cache,
      canPrefetchFirstPage:()=>scenario!=='deep',onError:error=>errors.push(error)};
    globalThis.fetch=async (_url,init)=>{
      const range=new Headers(init.headers).get('Range');requests.push(range);
      if (range===`bytes=0-${chunk-1}`) return new Response(new ReadableStream({
        async pull(control){await prefix.promise;control.enqueue(data.slice(0,chunk));control.close();}
      }),{status:206,headers:{'Content-Range':`bytes 0-${chunk-1}/${total}`,ETag:scenario==='weak'?'W/"A"':'"A"'}});
      assert.equal(range,`bytes=${chunk}-${total-1}`);
      started.resolve();
      if (scenario==='close') await new Promise((_,reject)=>{
        init.signal.addEventListener('abort',()=>{tail.resolve();reject(init.signal.reason);},{once:true});
      });
      return rangeResponse(data,chunk,total,scenario==='changed'?'"B"':'"A"');
    };
    try {
      const pending=preparePdfInitialRange(opts,hooks);
      await turn();
      const early=['fresh','changed','close'].includes(scenario);
      assert.deepEqual(requests,[`bytes=0-${chunk-1}`,...(early?[`bytes=${chunk}-${total-1}`]:[])],scenario);
      prefix.resolve();
      const first=await pending;
      assert.equal(Boolean(first?.tail),early,scenario);
      if (early) await started.promise;
      if (scenario==='close') {
        first.cancelInitial();await tail.promise;
        assert.equal(await first.tail.promise,null);
        assert.equal(cache.get(opts.url,chunk,total,{etag:'"A"',total}),null);
      } else if (scenario==='fresh' || scenario==='changed') {
        const opened=await openPdfRangeTask(pdfjs,opts,{...hooks,initial:Promise.resolve(first)});
        const transport=(await opened.promise).range;
        transport.requestDataRange(chunk,total);await turn();await turn();
        if (scenario==='fresh') {
          assert.equal(requests.length,2,'the pending tail must supply the exact worker demand');
          assert.deepEqual(transport.received,[{begin:chunk,bytes:[...data.subarray(chunk)]}]);
          assert.deepEqual(errors,[]);
        } else {
          assert.equal(transport.received.length,0);
          assert.match(errors[0]?.message,/PDF_SOURCE_CHANGED/);
          assert.equal(cache.get(opts.url,chunk,total,{etag:'"A"',total}),null);
        }
        await opened.destroy();
      } else first?.cancelInitial();
    } finally {
      prefix.resolve();owner.abort();
      Object.defineProperty(globalThis,'navigator',nav);
    }
  }

  // A final startxref may point to the single aligned chunk before the
  // standard tail. Trust the trailer only as a bounded scheduling hint.
  for (const scenario of ['hint','demand-first','close','source-changed','malformed','deep','weak-net','save-data','older-offset','covered','linearized','suppressed-after-start']) {
    const chunk=262144, total=32*chunk+65536, tailBegin=31*chunk, adjacent=tailBegin-chunk;
    const owner=new AbortController(), tailGate=Promise.withResolvers(), requests=[];
    const nav=Object.getOwnPropertyDescriptor(globalThis,'navigator');
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{connection:{
      saveData:scenario==='save-data',effectiveType:scenario==='weak-net'?'2g':'4g'}}});
    const offset=scenario==='older-offset'?adjacent-1:scenario==='covered'?tailBegin:adjacent+27;
    const ending=new TextEncoder().encode(`\nstartxref\n${offset}\n%%EOF\n${scenario==='malformed'?'garbage':''}`);
    let fresh=scenario!=='deep';
    globalThis.fetch=async(_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range')).map(Number);
      requests.push(a);
      const data=new Uint8Array(b-a+1);
      if (!a) data.set(new TextEncoder().encode(scenario==='linearized'?'%PDF-1.7\n1 0 obj\n<< /Linearized 1 >>':'%PDF-1.6\n'));
      if (a===tailBegin) {data.set(ending,data.length-ending.length);await tailGate.promise;}
      if (a===adjacent) data[27]=42;
      return new Response(data,{status:206,headers:{'Content-Range':`bytes ${a}-${b}/${total}`,
        ETag:a===adjacent && scenario==='source-changed' && requests.filter(n=>n===adjacent).length===1?'"B"':'"A"'}});
    };
    const hooks={signal:owner.signal,readBytes,limit:total,rangeCache:null,canPrefetchFirstPage:()=>fresh};
    const input={url:options.url,rangeChunkSize:chunk};
    try {
      const first=await preparePdfInitialRange(input,hooks);
      const opening=await openPdfRangeTask(pdfjs,input,{...hooks,initial:Promise.resolve(first)});
      const transport=(await opening.promise).range;
      if (scenario==='demand-first') transport.requestDataRange(adjacent,tailBegin);
      if (scenario==='close') owner.abort(new DOMException('closed','AbortError'));
      if (scenario==='suppressed-after-start') fresh=false;
      await turn();
      assert.equal(requests.filter(n=>n===adjacent).length,Number(scenario==='demand-first'));
      tailGate.resolve(); await first.tail.promise; await turn();
      const extra=['hint','source-changed','demand-first'].includes(scenario);
      assert.equal(requests.filter(n=>n===adjacent).length,Number(extra),scenario);
      if (scenario==='hint' || scenario==='source-changed') {
        transport.requestDataRange(adjacent,tailBegin);
        await turn(); await turn();
        assert.equal(requests.filter(n=>n===adjacent).length,scenario==='hint'?1:2);
        assert.equal(transport.received.at(-1)?.bytes[27],42);
      }
      await opening.destroy();
    } finally {
      owner.abort(); tailGate.resolve();
      if (nav) Object.defineProperty(globalThis,'navigator',nav); else delete globalThis.navigator;
    }
  }

  // Large-flat policy joins only already requested chunks, at most 96 KiB of
  // aggregate gaps and 256 KiB per response. Published slices remain exact.
  {
    const total=8*1024*1024,chunk=32768,start=2*1024*1024,requests=[];
    globalThis.fetch=async(_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b)+1;requests.push([begin,end]);
      const body=Uint8Array.from({length:end-begin},(_,i)=>((begin+i)>>>8)&255);
      return new Response(body,{status:206,headers:{'Content-Range':`bytes ${begin}-${end-1}/${total}`,ETag:'"A"'}});
    };
    const initial={bytes:new Uint8Array(262144),total,etag:'"A"',rangeChunkSize:chunk,
      tail:{begin:total-262144,end:total,read:async()=>null,onFailure(){}}};
    const controller=new AbortController(), errors=[];
    const opened=await openPdfRangeTask(pdfjs,{url:options.url,rangeChunkSize:262144},{
      signal:controller.signal,readBytes,limit:total,rangeCache:null,initial:Promise.resolve(initial),
      boundedMetadata:true,onError:error=>errors.push(error)});
    const captured=await opened.promise,transport=captured.range;
    assert.equal(captured.rangeChunkSize,chunk);
    for(const index of [0,2,4,6,8])transport.requestDataRange(start+index*chunk,start+(index+1)*chunk);
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.deepEqual(requests,[[start,start+7*chunk],[start+8*chunk,start+9*chunk]]);
    assert.deepEqual(transport.received.map(row=>row.begin).sort((a,b)=>a-b),[0,2,4,6,8].map(i=>start+i*chunk));
    for(const row of transport.received){
      assert.equal(row.bytes.length,chunk);
      assert.equal(row.bytes[0],(row.begin>>>8)&255);
      assert.equal(row.bytes.at(-1),((row.begin+chunk-1)>>>8)&255);
    }
    assert.deepEqual(errors,[]);await opened.destroy();
  }

  // Foreground range joins a delayed batch immediately rather than waiting for
  // its timer. Cancellation before that timer never sends a request or result.
  {
    const total=8*1024*1024,chunk=32768,start=2*1024*1024,requests=[];
    globalThis.fetch=async(_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b)+1;requests.push([begin,end]);
      return new Response(new Uint8Array(end-begin),{status:206,headers:{'Content-Range':`bytes ${begin}-${end-1}/${total}`,ETag:'"A"'}});
    };
    const initial={bytes:new Uint8Array(262144),total,etag:'"A"',rangeChunkSize:chunk,
      tail:{begin:total-262144,end:total,read:async()=>null,onFailure(){}}};
    const controller=new AbortController(),opened=await openPdfRangeTask(pdfjs,{url:options.url,rangeChunkSize:262144},{
      signal:controller.signal,readBytes,limit:total,rangeCache:null,initial:Promise.resolve(initial),boundedMetadata:true});
    const transport=(await opened.promise).range;
    transport.requestDataRange(start,start+chunk);
    opened.prioritizeRange({begin:start+4*chunk,end:start+5*chunk});
    transport.requestDataRange(start+4*chunk,start+5*chunk);
    await turn();await turn();
    assert.ok(requests.some(([begin,end])=>begin<=start+4*chunk && end>=start+5*chunk),
      'priority must promote the queued batch without waiting for its timer');
    await opened.destroy();
    const queuedOwner=new AbortController(),queued=await openPdfRangeTask(pdfjs,{url:options.url,rangeChunkSize:262144},{
      signal:queuedOwner.signal,readBytes,limit:total,rangeCache:null,initial:Promise.resolve(initial),boundedMetadata:true});
    const queuedTransport=(await queued.promise).range, oldRequests=requests.length;
    queuedTransport.requestDataRange(start,start+chunk);
    queued.prioritizeRange({begin:start+1,end:start+2});
    await turn();await turn();
    assert.equal(requests.length,oldRequests+1,'a range already waiting for batching is promoted');
    await queued.destroy();
    const cancelled=new AbortController(),discard=await openPdfRangeTask(pdfjs,{url:options.url,rangeChunkSize:262144},{
      signal:cancelled.signal,readBytes,limit:total,rangeCache:null,initial:Promise.resolve(initial),boundedMetadata:true});
    const stale=(await discard.promise).range, before=requests.length;
    stale.requestDataRange(start,start+chunk);cancelled.abort(new DOMException('closed','AbortError'));
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(requests.length,before);assert.deepEqual(stale.received,[]);await discard.destroy();

    const closing=new AbortController(), errors=[];
    const promoted=await openPdfRangeTask(pdfjs,{url:options.url,rangeChunkSize:262144},{
      signal:closing.signal,readBytes,limit:total,rangeCache:null,initial:Promise.resolve(initial),boundedMetadata:true,
      onError:error=>errors.push(error)});
    try {
      const pending=(await promoted.promise).range;
      pending.requestDataRange(start,start+chunk);
      // Promotion moves the batch from a timer to a queued microtask. Abort
      // before it executes; cancelling only the timer is no longer enough.
      promoted.prioritizeRange({begin:start+1,end:start+2});
      closing.abort(new DOMException('closed before promoted batch','AbortError'));
      await turn();
      assert.equal(requests.length,before);
      assert.deepEqual(pending.received,[]);
      assert.deepEqual(errors,[]);
    } finally {await promoted.destroy();}
  }

  // Source identity and framing remain mandatory on a bridged response.
  for(const kind of ['changed','truncated','range-ignored']) {
    const total=8*1024*1024,chunk=32768,start=2*1024*1024,errors=[];
    globalThis.fetch=async(_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b)+1;
      if(kind==='range-ignored')return new Response(new Uint8Array(8),{status:200});
      return new Response(new Uint8Array(kind==='truncated'?end-begin-1:end-begin),{status:206,headers:{
        'Content-Range':`bytes ${begin}-${end-1}/${total}`,ETag:kind==='changed'?'"B"':'"A"'}});
    };
    const initial={bytes:new Uint8Array(262144),total,etag:'"A"',rangeChunkSize:chunk,
      tail:{begin:total-262144,end:total,read:async()=>null,onFailure(){}}};
    const opened=await openPdfRangeTask(pdfjs,{url:options.url,rangeChunkSize:262144},{
      signal:new AbortController().signal,readBytes,limit:total,rangeCache:null,initial:Promise.resolve(initial),
      boundedMetadata:true,onError:error=>errors.push(error)});
    const transport=(await opened.promise).range;
    transport.requestDataRange(start,start+chunk);transport.requestDataRange(start+2*chunk,start+3*chunk);
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(errors.length,1,kind);assert.deepEqual(transport.received,[],kind);
    assert.match(errors[0].message,kind==='changed'?/PDF_SOURCE_CHANGED/:/PDF_RANGE_INVALID/);await opened.destroy();
  }

  // A bootstrap supplied without a tail may add one bounded lookahead. If
  // that speculative request fails, PDF.js still gets its exact demand range.
  for (const hintFails of [false,true]) {
    const source=Uint8Array.from({length:20},(_,i)=>i), requests=[];
    const outcome=Promise.withResolvers();
    class ObservedTransport extends Transport {
      onDataRange(begin,bytes) {
        super.onDataRange(begin,bytes);
        outcome.resolve(this.received);
      }
    }
    globalThis.fetch=async (_url,init)=>{
      const range=new Headers(init.headers).get('Range');requests.push(range);
      if (range==='bytes=12-19') return hintFails ? new Response(null,{status:503}) : rangeResponse(source,12,20);
      assert.equal(range,'bytes=16-19');
      return rangeResponse(source,16,20);
    };
    const opened=await openPdfRangeTask({...pdfjs,PDFDataRangeTransport:ObservedTransport},options,{
      signal:new AbortController().signal,readBytes,limit:source.length,rangeCache:null,
      initial:Promise.resolve({bytes:source.slice(0,4),total:source.length,etag:'"A"'}),
      onError:outcome.reject});
    try {
      const {range}=await opened.promise;
      assert.deepEqual(requests,['bytes=12-19']);
      range.requestDataRange(16,20);
      assert.deepEqual(await outcome.promise,[{begin:16,bytes:[16,17,18,19]}]);
      assert.deepEqual(requests,hintFails ? ['bytes=12-19','bytes=16-19'] : ['bytes=12-19']);
    } finally {await opened.destroy();}
  }

  // Pages must also reuse the bounded opening chunk, but not stale bytes
  // from a speculative response whose source has changed.
  for (const prefixChanged of [false,true]) {
    const chunk=64, source=Uint8Array.from({length:640},(_,i)=>i%251), requests=[];
    source.set(new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Length 200 >>\nstream\n'));
    const outcome=Promise.withResolvers();
    class OpeningTransport extends Transport {
      onDataRange(begin,bytes) {
        super.onDataRange(begin,bytes);
        outcome.resolve(this.received);
      }
    }
    globalThis.fetch=async (_url,init)=>{
      const range=new Headers(init.headers).get('Range');requests.push(range);
      if (range==='bytes=64-127') return rangeResponse(source,64,128,prefixChanged? '"B"':'"A"');
      assert.equal(range,'bytes=80-87');
      return rangeResponse(source,80,88);
    };
    const opened=await openPdfRangeTask({...pdfjs,PDFDataRangeTransport:OpeningTransport},
      {...options,rangeChunkSize:chunk},{signal:new AbortController().signal,readBytes,limit:source.length,rangeCache:null,
        initial:Promise.resolve({bytes:source.slice(0,chunk),total:source.length,etag:'"A"',
          tail:{begin:512,end:640,read:async()=>null,onFailure(){}}}),
        canPrefetchOpening:()=>true,onError:outcome.reject});
    try {
      const {range}=await opened.promise;
      assert.deepEqual(requests,['bytes=64-127']);
      range.requestDataRange(80,88);
      assert.deepEqual(await outcome.promise,[{begin:80,bytes:[...source.slice(80,88)]}]);
      assert.deepEqual(requests,prefixChanged ? ['bytes=64-127','bytes=80-87'] : ['bytes=64-127']);
    } finally {await opened.destroy();}
  }

  // Large-flat PDFs get one bounded, version-checked tail lookahead for the
  // parser's xref; save-data and slow connections do not get that extra hint.
  {
    const total=8*1024*1024,chunk=262144,requests=[];
    const ids=[50000,...Array.from({length:1400},(_,i)=>10000+i*17)];
    const tree='%PDF-1.7\n1 0 obj<</Length 4500>>\nstream\n'+'x'.repeat(4500)+'\nendstream\nendobj\n'+
      '2 0 obj<</Type/Pages/Count '+ids.length+'/Kids['+ids.map(id=>`${id} 0 R`).join(' ')+']>>\nendobj\n';
    const first=new TextEncoder().encode(tree);assert.ok(first.length>16384);
    globalThis.fetch=async(_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b)+1;requests.push([begin,end]);
      const body=new Uint8Array(end-begin);if(!begin)body.set(first);
      return new Response(body,{status:206,headers:{'Content-Range':`bytes ${begin}-${end-1}/${total}`,ETag:'"A"'}});
    };
    const nativeNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
    try {
      for (const [connection,expected] of [[{},true],[{saveData:true},false],[{effectiveType:'2g'},false]]) {
        Object.defineProperty(globalThis,'navigator',{configurable:true,value:{connection}});
        const row=await preparePdfInitialRange({url:options.url,rangeChunkSize:chunk},{
          signal:new AbortController().signal,readBytes,limit:total,rangeCache:null,canPrefetchFirstPage:()=>false});
        assert.equal(row.rangeChunkSize,32768);assert.equal(!!row.extendedTail,expected);
        if(expected){assert.equal(row.extendedTail.end-row.extendedTail.begin,chunk);await row.extendedTail.promise;}
        row.cancelInitial();
      }
    } finally {if(nativeNavigator)Object.defineProperty(globalThis,'navigator',nativeNavigator);else delete globalThis.navigator;}
  }

  // Join the verified bytes across the two tail hints, or retry the whole
  // original demand if either hint fails before it can supply its slice.
  for (const failedHint of [null,'extendedTail','tail']) {
    const total=8*1024*1024, chunk=128, split=total-2*chunk, extendedBegin=split-3*chunk;
    const begin=split-3, end=split+5, requests=[], errors=[];
    const hintedRequests=[[0,chunk],[split,total],[extendedBegin,split]];
    // The page-first header qualifies for an extended tail; only the small
    // requested slices of the virtual source are materialized.
    const header=new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<</Type/Page/Contents 2 0 R/Parent 3232 0 R/Resources 7 0 R>>\nendobj\n');
    const sourceBytes=(from,to)=>Uint8Array.from({length:to-from},(_,i)=>1+(from+i)%251);
    const releaseHint=Promise.withResolvers(), outcome=Promise.withResolvers();
    class ObservedTransport extends Transport {
      onDataRange(begin,bytes) {
        super.onDataRange(begin,bytes);
        outcome.resolve();
      }
    }
    globalThis.fetch=async (_url,init)=>{
      const [,from,last]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range')).map(Number);
      const to=last+1;requests.push([from,to]);
      let body=sourceBytes(from,to);
      if(from===0)body.set(header);
      if((failedHint==='extendedTail' && from===extendedBegin && to===split) ||
         (failedHint==='tail' && from===split && to===total)) {
        await releaseHint.promise;
        body=body.subarray(0,1); // Shorter than even the demanded subrange.
      }
      return new Response(body,{status:206,headers:{'Content-Range':`bytes ${from}-${last}/${total}`,ETag:'"A"'}});
    };
    const rangeOptions={...options,rangeChunkSize:chunk};
    const hooks={signal:new AbortController().signal,readBytes,limit:total,rangeCache:null,canPrefetchFirstPage:()=>true};
    const initial=await preparePdfInitialRange(rangeOptions,hooks);
    let opened;
    try {
      for(const hint of ['extendedTail','tail']) {
        assert.ok(initial[hint],hint);
        if(hint!==failedHint)assert.ok(await initial[hint].promise,hint);
      }
      opened=await openPdfRangeTask({...pdfjs,PDFDataRangeTransport:ObservedTransport},rangeOptions,{
        ...hooks,initial:Promise.resolve(initial),onError:error=>{errors.push(error);outcome.reject(error);}});
      const {range}=await opened.promise;
      range.requestDataRange(begin,end);
      if(failedHint) {
        await turn();
        assert.deepEqual(range.received,[],'no partial delivery while one hint is pending');
        assert.deepEqual(requests,hintedRequests,'no fallback before the hint fails');
        releaseHint.resolve();
        assert.equal(await initial[failedHint].promise,null,failedHint);
      }
      await outcome.promise;await turn();
      assert.deepEqual(range.received,[{begin,bytes:[...sourceBytes(begin,end)]}]);
      assert.deepEqual(requests,failedHint ? [...hintedRequests,[begin,end]] : hintedRequests);
      assert.deepEqual(errors,[]);
    } finally {
      releaseHint.resolve();
      if(opened)await opened.destroy();else initial.cancelInitial();
    }
  }

  // A malformed extended tail can never be published or cached as valid.
  {
    const total=8*1024*1024,chunk=262144,errors=[];
    const ids=[50000,...Array.from({length:1400},(_,i)=>10000+i*17)];
    const tree='%PDF-1.7\n1 0 obj<</Length 4500>>\nstream\n'+'x'.repeat(4500)+'\nendstream\nendobj\n'+
      '2 0 obj<</Type/Pages/Count '+ids.length+'/Kids['+ids.map(id=>`${id} 0 R`).join(' ')+']>>\nendobj\n';
    const first=new TextEncoder().encode(tree);
    globalThis.fetch=async(_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b)+1;
      if(begin!==0 && begin<total-2*chunk)return new Response(new Uint8Array(chunk-1),{status:206,headers:{
        'Content-Range':`bytes ${begin}-${end-1}/${total}`,'Content-Length':String(chunk),ETag:'"A"'}});
      const body=new Uint8Array(end-begin);if(begin===0)body.set(first);
      return new Response(body,{status:206,headers:{'Content-Range':`bytes ${begin}-${end-1}/${total}`,ETag:'"A"'}});
    };
    const owner=new AbortController(),initial=await preparePdfInitialRange({url:options.url,rangeChunkSize:chunk},{
      signal:owner.signal,readBytes,limit:total,rangeCache:null});
    assert.ok(initial.extendedTail);await initial.extendedTail.promise;
    const opened=await openPdfRangeTask(pdfjs,{url:options.url,rangeChunkSize:chunk},{signal:owner.signal,
      readBytes,limit:total,rangeCache:null,initial:Promise.resolve(initial),onError:error=>errors.push(error)});
    const transport=(await opened.promise).range;
    transport.requestDataRange(initial.extendedTail.begin,initial.extendedTail.begin+32768);
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.deepEqual(transport.received,[]);assert.equal(errors.length,1);assert.match(errors[0].message,/PDF_RANGE_INVALID/);
    await opened.destroy();
  }

  // Many nonadjacent demands stay within the existing 24-slot limit. Closing
  // must drop both admitted and waiting work, even with the batching timer.
  {
    const total=8*1024*1024,chunk=32768,start=2*1024*1024,seen=[],releases=[];
    let active=0,peak=0;
    globalThis.fetch=async(_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b)+1;seen.push([begin,end]);active++;peak=Math.max(peak,active);
      try {await new Promise((resolve,reject)=>{
        const finish=()=>{init.signal.removeEventListener('abort',abort);resolve()};
        const abort=()=>reject(init.signal.reason);init.signal.addEventListener('abort',abort,{once:true});releases.push(finish);
      });return new Response(new Uint8Array(end-begin),{status:206,headers:{'Content-Range':`bytes ${begin}-${end-1}/${total}`,ETag:'"A"'}})}
      finally {active--}
    };
    const initial={bytes:new Uint8Array(262144),total,etag:'"A"',rangeChunkSize:chunk,
      tail:{begin:total-262144,end:total,read:async()=>null,onFailure(){}}};
    const owner=new AbortController(),opened=await openPdfRangeTask(pdfjs,{url:options.url,rangeChunkSize:262144},{
      signal:owner.signal,readBytes,limit:total,rangeCache:null,initial:Promise.resolve(initial),boundedMetadata:true});
    const transport=(await opened.promise).range;
    for(let i=0;i<30;i++)transport.requestDataRange(start+i*5*chunk,start+(i*5+1)*chunk);
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(seen.length,23);assert.equal(peak,23);
    const promoted=start+27*5*chunk;opened.prioritizeRange({begin:promoted,end:promoted+1});
    await turn();await turn();assert.equal(seen.at(-1)[0],promoted);assert.equal(peak,24);
    const before=seen.length;owner.abort(new DOMException('closed','AbortError'));
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(seen.length,before);assert.equal(active,0);assert.deepEqual(transport.received,[]);
    await opened.destroy();
  }

  // Cache entries are version-bound, copied on both ingress and egress, and
  // bounded by LRU, age and byte/entry limits. Invalid identities never enter.
  {
    let now=0;
    const cache=createPdfRangeCache({maxBytes:8,maxEntries:2,maxAgeMs:10,now:()=>now});
    const data=Uint8Array.from([1,2,3,4]);
    cache.put(options.url,0,data,version);data.fill(99);
    assert.deepEqual(cache.version(options.url,0,4),version);
    assert.equal(cache.version(options.url,0,5),null);
    assert.equal(cache.version(options.url,-1,4),null);
    const copy=cache.get(options.url,0,4,version);
    assert.deepEqual([...copy],[1,2,3,4]);
    structuredClone(copy,{transfer:[copy.buffer]});
    assert.deepEqual([...cache.get(options.url,1,3,version)],[2,3]);
    for (const other of [{etag:'"B"',total:20},{etag:'"A"',total:21},{etag:'W/"A"',total:20}])
      assert.equal(cache.get(options.url,0,4,other),null);
    cache.put(options.url,4,Uint8Array.from([5,6,7,8]),version);
    cache.put(options.url,8,Uint8Array.from([9,10,11,12]),version);
    assert.equal(cache.size,2);assert.equal(cache.byteLength,8);
    assert.equal(cache.get(options.url,0,4,version),null);
    cache.put(options.url,0,new Uint8Array(9),version);assert.equal(cache.size,2);
    now=11;assert.equal(cache.get(options.url,4,8,version),null);
    assert.equal(cache.byteLength,0);
    cache.put('x'.repeat(4097),0,new Uint8Array([1]),version);assert.equal(cache.size,0);
  }

  // Expiry follows insertion time, not LRU access order. A stale earliest
  // deadline after replacement or eviction may cause an extra scan, never a
  // premature eviction or stale byte reuse. Clocks may also move backwards.
  {
    let now=0;
    const cache=createPdfRangeCache({maxBytes:12,maxEntries:3,maxAgeMs:10,now:()=>now});
    const data=Uint8Array.from([1,2,3,4]);
    cache.put(options.url,0,data,version);
    now=5;cache.put(options.url,4,data,version);
    assert.deepEqual([...cache.get(options.url,0,4,version)],[1,2,3,4]); // older entry becomes MRU
    now=10;assert.equal(cache.get(options.url,0,4,version),null);
    assert.deepEqual([...cache.get(options.url,4,8,version)],[1,2,3,4]);
    now=8;cache.put(options.url,8,data,version); // backward clock, earliest deadline changes
    now=15;assert.equal(cache.get(options.url,4,8,version),null);
    assert.deepEqual([...cache.get(options.url,8,12,version)],[1,2,3,4]);
    now=18;assert.equal(cache.get(options.url,8,12,version),null);
    assert.equal(cache.size,0);assert.equal(cache.byteLength,0);
    now=20;cache.put(options.url,0,data,version);
    now=25;cache.put(options.url,0,Uint8Array.from([5,6,7,8]),version);
    now=30;assert.deepEqual([...cache.get(options.url,0,4,version)],[5,6,7,8]);
    now=35;assert.equal(cache.get(options.url,0,4,version),null);
    assert.equal(cache.size,0);assert.equal(cache.byteLength,0);
  }
  {
    // A later overlapping range replaces the prior range and deadline;
    // a changed strong validator must evict old bytes and retain only new.
    let now=0;
    const cache=createPdfRangeCache({maxBytes:16,maxEntries:4,maxAgeMs:10,now:()=>now});
    const first=Uint8Array.from([1,2,3,4]);
    cache.put(options.url,0,first,version);
    now=5;cache.put(options.url,0,Uint8Array.from([5,6,7,8,9,10,11,12]),version);
    now=10;assert.deepEqual([...cache.get(options.url,0,4,version)],[5,6,7,8]);
    const changed={etag:'"B"',total:20};
    now=11;cache.put(options.url,8,first,changed);
    assert.equal(cache.get(options.url,0,4,version),null);
    assert.deepEqual([...cache.get(options.url,8,12,changed)],[1,2,3,4]);
    assert.equal(cache.size,1);assert.equal(cache.byteLength,4);
    now=20;assert.deepEqual([...cache.get(options.url,8,12,changed)],[1,2,3,4]);
    now=21;assert.equal(cache.get(options.url,8,12,changed),null);
    assert.equal(cache.size,0);assert.equal(cache.byteLength,0);
  }

  // Invalid runtime validators cannot populate the cache, and accepted
  // bytes remain isolated from later changes to their caller-owned input.
  {
    const cache=createPdfRangeCache(), data=Uint8Array.from([1,2,3,4]);
    for (const invalid of [null,undefined,{}, {etag:'W/"A"',total:20}, {etag:'"A"',total:0}]) {
      assert.equal(cache.get(options.url,0,4,invalid),null);
      cache.put(options.url,0,data,invalid);
    }
    assert.equal(cache.size,0);
    cache.put(options.url,0,data,version);
    data.fill(9);
    assert.deepEqual([...cache.get(options.url,0,4,version)],[1,2,3,4]);
  }

  // Reopening validates a fresh byte before reusing an owned prefix or range;
  // a changed ETag must cause a new full prefix and new demanded bytes.
  {
    const cache=createPdfRangeCache({maxBytes:64}), requests=[];
    let etag='"A"',data=Uint8Array.from({length:20},(_,i)=>i+1);
    globalThis.fetch=async (_url,init)=>{
      const range=new Headers(init.headers).get('Range');requests.push(range);
      const [,begin,last]=/^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
      return rangeResponse(data,begin,last+1,etag);
    };
    const load=()=>openPdfRangeTask(pdfjs,options,{signal:new AbortController().signal,readBytes,limit:64,rangeCache:cache});
    const first=await load(), firstTransport=(await first.promise).range;
    firstTransport.requestDataRange(4,8);await turn();await first.destroy();
    await turn();await turn();
    requests.length=0;
    const reopened=await load(), secondTransport=(await reopened.promise).range;
    secondTransport.requestDataRange(4,8);await turn();await turn();
    assert.deepEqual(requests,['bytes=0-0']);
    assert.deepEqual(secondTransport.received,[{begin:4,bytes:[5,6,7,8]}]);
    await reopened.destroy();await turn();await turn();requests.length=0;etag='"B"';data=data.map(value=>value+20);
    const changed=await load(), changedTransport=(await changed.promise).range;
    changedTransport.requestDataRange(4,8);await turn();await turn();
    assert.deepEqual(requests,['bytes=0-0','bytes=0-3','bytes=12-19','bytes=4-7']);
    assert.deepEqual(changedTransport.received,[{begin:4,bytes:[25,26,27,28]}]);
    await changed.destroy();await turn();await turn();
  }

  // A range-ignoring one-byte revalidation must cancel its whole body, then
  // make a normal fresh prefix request rather than publishing the cache.
  {
    const cache=createPdfRangeCache(),requests=[];
    cache.put(options.url,0,Uint8Array.from([1,2,3,4]),{etag:'"A"',total:8});
    let cancelled=false;
    globalThis.fetch=async (_url,init)=>{
      const range=new Headers(init.headers).get('Range');requests.push(range);
      if(range==='bytes=0-0')return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:200});
      return rangeResponse(Uint8Array.from([5,6,7,8,9,10,11,12]),0,4,'"B"');
    };
    const row=await preparePdfInitialRange(options,{signal:new AbortController().signal,readBytes,limit:64,rangeCache:cache});
    assert.deepEqual(requests,['bytes=0-0','bytes=0-3']);
    assert.equal(cancelled,true);assert.deepEqual([...row.bytes],[5,6,7,8]);row.cancelInitial();await turn();
  }

  // Revalidation must compare ETag before asking even an optional third-party
  // cache for bytes. Do not rely on the built-in cache rejecting stale entries.
  {
    const requests=[];let reads=0;
    const oldVersion={etag:'"A"',total:8},newData=Uint8Array.from([5,6,7,8,9,10,11,12]);
    const cache={version:()=>oldVersion,get(){reads++;return Uint8Array.from([1,2,3,4]);},put(){}};
    globalThis.fetch=async (_url,init)=>{
      const range=new Headers(init.headers).get('Range');requests.push(range);
      const [,begin,last]=/^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
      return rangeResponse(newData,begin,last+1,'"B"');
    };
    const row=await preparePdfInitialRange(options,{signal:new AbortController().signal,readBytes,limit:64,rangeCache:cache});
    assert.deepEqual(requests,['bytes=0-0','bytes=0-3']);
    assert.equal(reads,0,'a changed version cannot consult or publish an old prefix');
    assert.deepEqual([...row.bytes],[5,6,7,8]);row.cancelInitial();await turn();
  }

  // A malformed prefix must fail closed and cancel a tail that started from
  // validated headers; a complete or weakly validated body stays on PDF.js's
  // ordinary document path instead of creating a partial range transport.
  {
    let tailAborted=false;
    const short=Uint8Array.from([1,2,3]);
    globalThis.fetch=async (_url,init)=>{
      if(new Headers(init.headers).get('Range')==='bytes=0-3')
        return new Response(short,{status:206,headers:{'Content-Range':'bytes 0-3/20',ETag:'"A"'}});
      return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{
        tailAborted=true;reject(init.signal.reason);
      },{once:true}));
    };
    await assert.rejects(preparePdfInitialRange(options,{signal:new AbortController().signal,readBytes,limit:64,rangeCache:null}),/PDF_RANGE_INVALID/);
    await turn();assert.equal(tailAborted,true);
    for(const kind of ['complete','weak']) {
      globalThis.fetch=async()=>new Response(Uint8Array.from([1,2,3,4]),{status:206,headers:{
        'Content-Range':`bytes 0-3/${kind==='complete'?4:8}`,ETag:kind==='complete'?'"A"':'W/"A"'}});
      const task=await openPdfRangeTask(pdfjs,options,{signal:new AbortController().signal,readBytes,limit:64,rangeCache:null});
      const result=await task.promise;
      assert.equal(result.range,undefined);
      if(kind==='complete')assert.deepEqual([...result.data],[1,2,3,4]);
      else assert.equal(result.data,undefined);
      await task.destroy();await turn();
    }
  }

  // The optional shared cache belongs to the actual same-origin overlay host;
  // unrelated, cross-origin and non-extensible windows must not share it.
  {
    const saved=Object.fromEntries(['window','parent','location'].map(name=>
      [name,Object.getOwnPropertyDescriptor(globalThis,name)]));
    const key=Symbol.for('voice-reader-pdf-ranges-v1');
    const FirstOverlayBytes=runInNewContext('Uint8Array');
    try {
      for (const kind of ['overlay','unrelated','cross-origin','non-extensible']) {
        let child=kind==='non-extensible'?Object.preventExtensions({}):{};
        const parentWindow={location:{origin:'https://reader.test'},document:{
          querySelectorAll:()=>kind==='overlay'?[{contentWindow:child}]:[]}};
        if(kind==='cross-origin')Object.defineProperty(parentWindow,'location',{get(){throw new Error('cross-origin');}});
        globalThis.window=child;globalThis.parent=parentWindow;
        globalThis.location={href:'https://reader.test/',origin:'https://reader.test'};
        const overlay=kind==='overlay', requests=[];
        const input=overlay?{...options,rangeChunkSize:262144}:options;
        const data=overlay?new Uint8Array(8*1024*1024):Uint8Array.from({length:20},(_,i)=>i+1);
        if(overlay) {
          const kids=Array.from({length:128},(_,i)=>`${2+i*3} 0 R`).join(' ');
          data.set(new TextEncoder().encode(`%PDF-1.7\n1 0 obj\n<< /Type /Pages /Count 128 /Kids [${kids}] >>\nendobj\n`));
        }
        globalThis.fetch=async (_url,init)=>{
          const range=new Headers(init.headers).get('Range');requests.push(range);
          const [,begin,last]=/^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
          return rangeResponse(data,begin,last+1);
        };
        const load=(read=readBytes)=>preparePdfInitialRange(input,{signal:new AbortController().signal,readBytes:read,limit:data.length});
        const first=await load(overlay?async response=>new FirstOverlayBytes(await response.arrayBuffer()):readBytes);
        await first.tail.promise;first.cancelInitial();await turn();
        if(overlay) {
          assert.ok(parentWindow[key]);assert.equal(child[key],undefined);
          assert.ok(first.bytes instanceof FirstOverlayBytes);
          globalThis.window=child={}; // Replace the overlay without replacing its parent's cache.
        } else {
          assert.equal(parentWindow[key],undefined);
          assert.equal(Boolean(child[key]),kind!=='non-extensible');
        }
        requests.length=0;
        const second=await load(), tail=await second.tail.promise;
        second.cancelInitial();await turn();
        assert.equal(requests[0],kind==='non-extensible'?'bytes=0-3':'bytes=0-0',kind);
        assert.ok(second.bytes instanceof Uint8Array,`${kind}: the cached prefix must pass the reader's staging guard`);
        assert.deepEqual(second.bytes.subarray(0,4),data.subarray(0,4));
        if(overlay) {
          assert.deepEqual(requests,['bytes=0-0'],'both the prefix and the tail come from the parent cache');
          assert.equal(second.rangeChunkSize,16384,'the retained prefix still enables adaptive chunks');
          assert.ok(second.bytes.buffer instanceof ArrayBuffer,'PDF.js needs the prefix buffer in this reader realm');
          assert.ok(tail.bytes instanceof Uint8Array);
          const rangeCache=sharedPdfRangeCache(), current={etag:'"A"',total:data.length};
          assert.equal(rangeCache.size,2);
          assert.equal(rangeCache.byteLength,3*input.rangeChunkSize);
          const copy=rangeCache.get(input.url,1,6,current);
          assert.deepEqual(copy,data.subarray(1,6));
          assert.ok(copy.buffer instanceof ArrayBuffer,'demanded cache bytes must also own a local transferable buffer');
          copy.fill(0);
          structuredClone(copy,{transfer:[copy.buffer]});
          assert.equal(copy.byteLength,0);
          assert.deepEqual(rangeCache.get(input.url,1,6,current),data.subarray(1,6));
        }
      }
    } finally {
      for(const [name,descriptor] of Object.entries(saved)) {
        if(descriptor)Object.defineProperty(globalThis,name,descriptor);
        else delete globalThis[name];
      }
    }
  }

  // Linearized prefetch is allowed only for a direct, bounded page-one
  // section; indirect or inconsistent metadata must retain demand-only reads.
  for(const [end,length,page,allowed] of [['400','2048','',true],['400 0 R','2048','',false],
    ['700','2048','',false],['400','2047','',false],['400','2048','/P 1',false]]) {
    const data=new Uint8Array(2048).fill(32),requests=[];
    data.set(new TextEncoder().encode(`%PDF-1.5\n1 0 obj\n<</Linearized 1/L ${length}/E ${end}${page}>>\nendobj\n`));
    globalThis.fetch=async (_url,init)=>{
      const range=new Headers(init.headers).get('Range');requests.push(range);
      const [,begin,last]=/^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
      return rangeResponse(data,begin,last+1);
    };
    const rangeOptions={...options,rangeChunkSize:128};
    const first=await preparePdfInitialRange(rangeOptions,{signal:new AbortController().signal,readBytes,
      limit:data.length,rangeCache:null,canPrefetchFirstPage:()=>true});
    assert.equal(first.openingRanges.length,allowed?2:0,`${end}/${length}/${page}`);
    await Promise.all([first.tail.promise,...first.openingRanges.map(range=>range.promise)]);
    if(allowed) {
      const task=await openPdfRangeTask(pdfjs,rangeOptions,{signal:new AbortController().signal,readBytes,
        limit:data.length,rangeCache:null,initial:Promise.resolve(first)});
      const transport=(await task.promise).range,before=requests.length;
      transport.requestDataRange(128,512);await turn();await turn();
      assert.equal(requests.length,before,'joining prepared hints cannot reread the source');
      assert.deepEqual(transport.received,[{begin:128,bytes:[...data.slice(128,512)]}]);
      await task.destroy();await turn();
    } else {first.cancelInitial();await turn();}
  }

  // Once a previously validated origin loses a strong identity, no stale
  // document version may be reported as safe for downstream reuse.
  for(const invalid of [{etag:'W/"A"'}, {etag:'"A"',encoding:'gzip'}, {etag:null}]) {
    let calls=0;
    globalThis.fetch=async()=>{
      calls++;
      const headers={'Content-Range':'bytes 0-3/4'};
      if(calls===1 || invalid.etag)headers.ETag=calls===1?'"A"':invalid.etag;
      if(calls>1 && invalid.encoding)headers['Content-Encoding']=invalid.encoding;
      return new Response(Uint8Array.from([1,2,3,4]),{status:206,headers});
    };
    const policy=createPdfFetchPolicy();policy.add(['/book.pdf']);
    await (await fetch('/book.pdf',{headers:{Range:'bytes=0-3'}})).arrayBuffer();
    assert.ok(policy.identity);
    await (await fetch('/book.pdf',{headers:{Range:'bytes=0-3'}})).arrayBuffer();
    assert.equal(policy.identity,null);policy.dispose();
  }

  // Exercise the deadline expiring immediately after a 429 body retry. A
  // controlled monotonic clock removes the race between two real timers;
  // the first byte is still delivered and the retry must not reach fetch.
  {
    const descriptor=Object.getOwnPropertyDescriptor(performance,'now');
    let now=0,calls=0,body;
    Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
    globalThis.fetch=async()=>{
      calls++;
      if(calls===1)return new Response(new ReadableStream({start(controller){body=controller;controller.enqueue(Uint8Array.of(1));}}),{
        status:206,headers:{ETag:'"A"','Content-Range':'bytes 0-3/4'}});
      now=20000;
      return new Response('',{status:429,headers:{'Retry-After':'0'}});
    };
    const policy=createPdfFetchPolicy({idleMs:20,attemptMs:500});policy.add(['/book.pdf']);
    try {
      const response=await fetch('/book.pdf',{headers:{Range:'bytes=0-3'}}),reader=response.body.getReader();
      assert.deepEqual([...((await reader.read()).value)],[1]);
      assert.equal(calls,1,'the retry starts only after the valid first byte');
      await assert.rejects(reader.read(),error=>error.name==='TimeoutError');
      assert.equal(calls,2,'an expired retry must not dispatch a third fetch');
    } finally {
      policy.dispose();
      if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete performance.now;
      try {body.close();} catch (_) {}
    }
  }

  // Abort a live response body, rather than just an admission waiter, and
  // check cancellation propagates to the upstream reader without a retry.
  {
    const started=Promise.withResolvers();let cancelled=false,calls=0;
    globalThis.fetch=async()=>{
      calls++;
      return new Response(new ReadableStream({pull(){started.resolve();},cancel(){cancelled=true;}}),{
        status:206,headers:{ETag:'"A"','Content-Range':'bytes 0-3/4'}});
    };
    const policy=createPdfFetchPolicy();policy.add(['/book.pdf']);
    const owner=new AbortController();
    const response=await fetch('/book.pdf',{headers:{Range:'bytes=0-3'},signal:owner.signal});
    const reading=response.body.getReader().read();await started.promise;
    owner.abort(new DOMException('caller closed','AbortError'));
    await assert.rejects(reading,{name:'AbortError'});await turn();
    assert.equal(cancelled,true);assert.equal(calls,1);policy.dispose();
  }
  // A consumer may cancel its stream directly without aborting its caller.
  // Wait until an upstream read is pending so this cannot pass at admission.
  for (const reason of [undefined,new Error('PDF.js no longer needs this range')]) {
    const started=Promise.withResolvers(), owner=new AbortController();
    let calls=0,cancellations=0,upstreamSignal;
    const body=new ReadableStream({pull(){started.resolve();return new Promise(()=>{});},
      cancel(){cancellations++;}},{highWaterMark:0});
    globalThis.fetch=async (_input,init)=>{
      calls++;upstreamSignal=init.signal;
      return new Response(body,{status:206,headers:{ETag:'"A"','Content-Range':'bytes 0-3/4'}});
    };
    const policy=createPdfFetchPolicy();policy.add(['/book.pdf']);
    const response=await fetch('/book.pdf',{headers:{Range:'bytes=0-3'},signal:owner.signal});
    const reader=response.body.getReader();
    try {
      const reading=reader.read();await started.promise;
      await reader.cancel(reason);
      assert.deepEqual(await reading,{value:undefined,done:true});
      await turn();
      assert.equal(cancellations,1);assert.equal(body.locked,false);
      assert.equal(calls,1);assert.equal(policy.queuedAdmissions,0);
      assert.equal(owner.signal.aborted,false);
      assert.equal(upstreamSignal.aborted,true);
      if (reason) assert.equal(upstreamSignal.reason,reason);
      else assert.equal(upstreamSignal.reason.name,'AbortError');
    } finally {reader.releaseLock();policy.dispose();}
  }
  console.log('PDF network contracts: cache identity, safe revalidation and live cancellation passed');
} finally {
  globalThis.fetch=originalFetch;
}

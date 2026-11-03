import assert from 'node:assert/strict';
import {createPdfFetchPolicy, createPdfRangeCache, openPdfRangeTask, preparePdfInitialRange}
  from '../static/reader/pdf/reader-pdf-network.mjs';

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
    try {
      for (const kind of ['overlay','unrelated','cross-origin','non-extensible']) {
        const child=kind==='non-extensible'?Object.preventExtensions({}):{};
        const parentWindow={location:{origin:'https://reader.test'},document:{
          querySelectorAll:()=>kind==='overlay'?[{contentWindow:child}]:[]}};
        if(kind==='cross-origin')Object.defineProperty(parentWindow,'location',{get(){throw new Error('cross-origin');}});
        globalThis.window=child;globalThis.parent=parentWindow;
        globalThis.location={href:'https://reader.test/',origin:'https://reader.test'};
        const requests=[],data=Uint8Array.from({length:20},(_,i)=>i+1);
        globalThis.fetch=async (_url,init)=>{
          const range=new Headers(init.headers).get('Range');requests.push(range);
          const [,begin,last]=/^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
          return rangeResponse(data,begin,last+1);
        };
        const load=()=>preparePdfInitialRange(options,{signal:new AbortController().signal,readBytes,limit:64});
        const first=await load();await first.tail.promise;first.cancelInitial();await turn();
        if(kind==='overlay') {
          assert.ok(parentWindow[key]);assert.equal(child[key],undefined);
        } else {
          assert.equal(parentWindow[key],undefined);
          assert.equal(Boolean(child[key]),kind!=='non-extensible');
        }
        requests.length=0;
        const second=await load();await second.tail.promise;second.cancelInitial();await turn();
        assert.equal(requests[0],kind==='non-extensible'?'bytes=0-3':'bytes=0-0',kind);
        assert.deepEqual([...second.bytes],[1,2,3,4]);
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
  console.log('PDF network contracts: cache identity, safe revalidation and live cancellation passed');
} finally {
  globalThis.fetch=originalFetch;
}

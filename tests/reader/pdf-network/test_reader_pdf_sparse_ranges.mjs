import assert from 'node:assert/strict';
import {choosePdfRangeChunkSize, isFirstPageCandidate, openPdfRangeTask, preparePdfInitialRange, PDF_METADATA_RANGE_CONCURRENCY}
  from '../../../static/reader/pdf/reader-pdf-network.mjs';
import '../../../static/reader/core/reader-security.js';

globalThis.location = {href: 'https://reader.test/'};
const large = 64 * 1024 * 1024;
const bytes = text => new TextEncoder().encode(text);
const pageTree = (numbers, extra = '') => bytes('%PDF-1.7\n2 0 obj\n<< /Type /Pages /Count ' + numbers.length +
  ' /Kids [' + numbers.map(n => `${n} 0 R`).join(' ') + `] ${extra} >>\nendobj\n`);
const sparse = Array.from({length: 160}, (_, i) => 4 + i * 6);
const clustered = Array.from({length: 160}, (_, i) => 5 + i);
const tailPage = bytes('%PDF-1.7\n1 0 obj\n<</Type/Page/Contents 2 0 R/Parent 3232 0 R/Resources<</XObject<</Im0 3 0 R>>>>>>\nendobj\n');
assert.equal(isFirstPageCandidate(tailPage,56806517,262144),true,'large indirect parent must permit staged parsing, not define a page');
const imageHint = '%PDF-1.7\n3 0 obj\n<</Type/Page/Resources 4 0 R>>\nendobj\n4 0 obj\n<</XObject<</Im1 2 0 R>>>>\nendobj\n1 0 obj\n<</Length 3>>\nstream\nabc\nendstream\nendobj\n'+
  '2 0 obj\n<</Type/XObject/Subtype/Image/Length 600000>>\nstream\n';

assert.equal(choosePdfRangeChunkSize(pageTree(sparse), large), 16384);
assert.equal(isFirstPageCandidate(pageTree(sparse),large,16384),true);
assert.equal(isFirstPageCandidate(pageTree(clustered),large,262144),false);
const splitRoot = bytes('%PDF-1.4\n2 0 obj\n<</Count 499/Kids[3 0 R 11 0 R]/Type/Pages>>\nendobj\n');
assert.equal(isFirstPageCandidate(splitRoot,large,262144),true);
assert.equal(isFirstPageCandidate(splitRoot,1024*1024,262144),false);
assert.equal(isFirstPageCandidate(bytes('%PDF-1.4\n1 0 obj\n<< /Length 5 >>\nstream\n'+new TextDecoder().decode(splitRoot)),large,262144),false);
assert.equal(isFirstPageCandidate(bytes('%PDF-1.4\n2 0 obj\n<</Count 499 0 R/Kids[3 0 R 11 0 R]/Type/Pages>>\nendobj\n'),large,262144),false);
assert.equal(isFirstPageCandidate(bytes('%PDF-1.4\n2 0 obj\n<</Count 499/Kids[3 0 R evil 11 0 R]/Type/Pages>>\nendobj\n'),large,262144),false);
assert.equal(isFirstPageCandidate(bytes('%PDF-1.5\n1 0 obj\n<< /Linearized 1 /L '+large+' >>\nendobj\n'),large,262144),true);
assert.equal(isFirstPageCandidate(bytes('%PDF-1.5\n1 0 obj\n<< /Linearized 1 /L '+(large+1)+' >>\nendobj\n'+new TextDecoder().decode(splitRoot).slice(9)),large,262144),false);
assert.equal(isFirstPageCandidate(bytes('%PDF-1.5\n1 0 obj\n<< /Linearized 1 /L '+(large-1)+' >>\nendobj\n'),large,262144),true);
const tailTree = bytes('%PDF-1.6\n1 0 obj\n<</Type/Page/Contents[9 0 R]/Parent 18274 0 R/Resources 7 0 R>>\nendobj\n2 0 obj\n<</Length 4>>\nstream\ntest\nendstream\nendobj');
assert.equal(isFirstPageCandidate(tailTree,large,262144),true);
assert.equal(choosePdfRangeChunkSize(tailTree,large),262144, 'late page tree is not parsed from the prefix');
assert.equal(isFirstPageCandidate(bytes(new TextDecoder().decode(tailTree).replace('18274 0 R','127 0 R')),large,262144),false);
assert.equal(isFirstPageCandidate(bytes(new TextDecoder().decode(tailTree).replace('/Type/Page','/Type/Pages')),large,262144),false);
assert.equal(isFirstPageCandidate(bytes(new TextDecoder().decode(tailTree).replace('endobj','stream')),large,262144),false);
assert.equal(isFirstPageCandidate(bytes('%PDF-1.6\n1 0 obj\n<</Length 40>>\nstream\n'+new TextDecoder().decode(tailTree)),large,262144),false);
assert.equal(isFirstPageCandidate(bytes('%PDF-1.6\nstream\n'+new TextDecoder().decode(tailTree)),large,262144),false);
assert.equal(choosePdfRangeChunkSize(pageTree(clustered), large), 262144);
assert.equal(choosePdfRangeChunkSize(pageTree(sparse.slice(0, 127)), large), 262144);
assert.equal(choosePdfRangeChunkSize(pageTree(sparse), 1024 * 1024), 262144);
assert.equal(choosePdfRangeChunkSize(bytes('%PDF-1.7\n1 0 obj <</Linearized 1>> endobj\n' +
  new TextDecoder().decode(pageTree(sparse))), large), 262144);
assert.equal(choosePdfRangeChunkSize(bytes('%PDF-1.7\nstream\n' +
  new TextDecoder().decode(pageTree(sparse)) + '\nendstream'), large), 262144);
assert.equal(choosePdfRangeChunkSize(bytes('%PDF-1.7\n1 0 obj\n<</Count 160 0 R /Type /Pages /Kids [' +
  sparse.map(n => `${n} 0 R`).join(' ') + ']>>\nendobj'), large), 262144);
assert.equal(choosePdfRangeChunkSize(bytes('%PDF-1.7\n1 0 obj\n<</Count 160 /Type /Pages /Kids [' +
  sparse.map(n => `${n} 0 R`).join(' ') + ' INVALID]>>\nendobj'), large), 262144);
const oversized = bytes('%PDF-1.7\n1 0 obj\n<<' + 'a'.repeat(16000) + '>>\nendobj\n' +
  new TextDecoder().decode(pageTree(sparse)));
const started = performance.now();
assert.equal(choosePdfRangeChunkSize(oversized, large), 262144);
assert.ok(performance.now() - started < 1000, 'bounded header detection must not stall');

// The malformed tree remains PDF.js's job: sparse mode only changes range
// granularity, never skips validation or creates page identities from /Kids.
class Transport {
  constructor(total, initial) { this.length = total; this.initialData = initial; this.delivered = []; }
  onDataRange(begin, value) { this.delivered.push({begin, value}); }
}
let captured, transport, tasks = [];
const pdfjs = {
  PDFDataRangeTransport: Transport,
  getDocument(options) {
    captured = options;
    transport = options.range;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    tasks.push({resolve});
    return {promise, destroy: async () => {}};
  }
};
let active = 0, peak = 0, calls = 0, releases = [];
const nativeFetch = globalThis.fetch;

try {
  // Large totals stay range-based and must not affect the non-PDF limit.
  {
    const security=globalThis.VoiceOfMLReaderSecurity, limit=2*1024*1024*1024;
    assert.equal(security.LIMITS.documentBytes,512*1024*1024);
    assert.equal(security.LIMITS.pdfDocumentBytes,limit);
    const fixture={PDFDataRangeTransport:Transport,getDocument:parameters=>({
      promise:Promise.resolve(parameters),destroy:async()=>{}})};
    const options={url:'https://reader.test/large.pdf',rangeChunkSize:4};
    for (const total of [1_610_000_000,limit,limit+1]) {
      globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3,4]),{status:206,headers:{
        'Content-Range':`bytes 0-3/${total}`,'Content-Length':'4',ETag:'"fixed"'}});
      const task=()=>openPdfRangeTask(fixture,options,{signal:new AbortController().signal,
        readBytes:security.readBytes,limit,rangeLimit:limit,rangeCache:null});
      if (total>limit) await assert.rejects(task(),/READER_RESOURCE_LIMIT/);
      else {const opened=await task();assert.equal((await opened.promise).range.length,total);await opened.destroy();}
    }
    let cancelled=false;
    globalThis.fetch=async()=>({ok:true,status:200,headers:new Headers({'Content-Length':String(limit+1)}),
      body:{cancel:async()=>{cancelled=true;}}});
    await assert.rejects(openPdfRangeTask(fixture,options,{signal:new AbortController().signal,
      readBytes:security.readBytes,limit,rangeLimit:limit,rangeCache:null}),/READER_RESOURCE_LIMIT/);
    assert.ok(cancelled,'oversized complete response must release its body');
  }
  // Qualified hints are bounded, source-versioned and suppressed for deep
  // restoration. This first page descriptor is not itself a page identity.
  {
    const total=10*1024*1024, requests=[];
    const first=bytes('%PDF-1.7\n1 0 obj\n<</Type/Page/Contents[9 0 R]/Parent 3232 0 R/Resources<</XObject<</Im0 3 0 R>>>>>>\nendobj\n');
    globalThis.fetch=async (_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b);requests.push([begin,end]);
      const body=new Uint8Array(end-begin+1);if(begin===0)body.set(first);
      return new Response(body,{status:206,headers:{'Content-Range':`bytes ${begin}-${end}/${total}`,ETag:'"stable"'}});
    };
    const owner=new AbortController();
    const row=await preparePdfInitialRange({url:'https://reader.test/tail.pdf',rangeChunkSize:262144},{
      signal:owner.signal,readBytes:async r=>new Uint8Array(await r.arrayBuffer()),limit:total,rangeCache:null,canPrefetchFirstPage:()=>true});
    await row.tail.promise;await row.extendedTail.promise;
    assert.equal(row.extendedTail.end-row.extendedTail.begin,3*262144);
    const opened=await openPdfRangeTask(pdfjs,{url:'https://reader.test/tail.pdf',rangeChunkSize:262144},{
      signal:owner.signal,readBytes:async r=>new Uint8Array(await r.arrayBuffer()),limit:total,rangeCache:null,
      initial:Promise.resolve(row),boundedMetadata:true});
    transport.requestDataRange(row.extendedTail.end-16384,row.tail.begin+16384);
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(transport.delivered.at(-1).value.length,32768,'an overlapping demand uses both verified hints');
    assert.equal(requests.length,3,'only prefix, original tail, and bounded extended tail');
    await opened.destroy();
    tasks.length=0;
    const noPrefetch=await preparePdfInitialRange({url:'https://reader.test/tail.pdf',rangeChunkSize:262144},{
      signal:new AbortController().signal,readBytes:async r=>new Uint8Array(await r.arrayBuffer()),limit:total,rangeCache:null,canPrefetchFirstPage:()=>false});
    assert.equal(noPrefetch.extendedTail,null);
    noPrefetch.cancelInitial();
    const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
    try {
      Object.defineProperty(globalThis,'navigator',{configurable:true,value:{connection:{saveData:true}}});
      const reduced=await preparePdfInitialRange({url:'https://reader.test/tail.pdf',rangeChunkSize:262144},{
        signal:new AbortController().signal,readBytes:async r=>new Uint8Array(await r.arrayBuffer()),limit:total,
        rangeCache:null,canPrefetchFirstPage:()=>true});
      assert.equal(reduced.extendedTail,null,'save-data must not speculate on an extended tail');reduced.cancelInitial();
    } finally {
      if (oldNavigator) Object.defineProperty(globalThis,'navigator',oldNavigator);
      else delete globalThis.navigator;
    }
  }
  {
    const total=10*1024*1024, requests=[];
    globalThis.fetch=async (_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b),body=new Uint8Array(end-begin+1);requests.push([begin,end]);
      if(begin===0)body.set(bytes(imageHint));
      return new Response(body,{status:206,headers:{'Content-Range':`bytes ${begin}-${end}/${total}`,ETag:'"stable"'}});
    };
    const no=await preparePdfInitialRange({url:'https://reader.test/image.pdf',rangeChunkSize:262144},{
      signal:new AbortController().signal,readBytes:async r=>new Uint8Array(await r.arrayBuffer()),limit:total,rangeCache:null,canPrefetchFirstPage:()=>false});
    assert.equal(no.openingRanges.length,0,'deep restoration cannot fetch opening images');no.cancelInitial();
    const yes=await preparePdfInitialRange({url:'https://reader.test/image.pdf',rangeChunkSize:262144},{
      signal:new AbortController().signal,readBytes:async r=>new Uint8Array(await r.arrayBuffer()),limit:total,rangeCache:null,canPrefetchFirstPage:()=>true});
    assert.equal(yes.openingRanges.length,1);
    assert.deepEqual([yes.openingRanges[0].begin,yes.openingRanges[0].end],[262144,786432]);
    yes.cancelInitial();
    for (const invalid of [imageHint.replace('/Length 600000','/Length 600000 0 R'),
      imageHint.replace('/Length 600000','/Length 1600000'),imageHint.replace('endstream','badstream'),
      imageHint.replace('/Subtype/Image','/Subtype/Form'),imageHint.replace('/Im1 2 0 R','/Im1 8 0 R'),
      imageHint.replace('/Length 600000','/Length 3 /Length 600000'),
      imageHint.replaceAll('2 0 R','99999999999999999999 0 R').replace('2 0 obj','99999999999999999999 0 obj')]) {
      globalThis.fetch=async (_url,init)=>{
        const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
        const begin=Number(a),end=Number(b),body=new Uint8Array(end-begin+1);if(begin===0)body.set(bytes(invalid));
        return new Response(body,{status:206,headers:{'Content-Range':`bytes ${begin}-${end}/${total}`,ETag:'"stable"'}});
      };
      const row=await preparePdfInitialRange({url:'https://reader.test/image.pdf',rangeChunkSize:262144},{
        signal:new AbortController().signal,readBytes:async r=>new Uint8Array(await r.arrayBuffer()),limit:total,
        rangeCache:null,canPrefetchFirstPage:()=>true});
      assert.equal(row.openingRanges.length,0,'ambiguous images stay on normal demand');row.cancelInitial();
    }
  }
  {
    const total=10*1024*1024;
    const first=bytes('%PDF-1.7\n1 0 obj\n<</Type/Page/Contents[9 0 R]/Parent 18274 0 R/Resources 7 0 R>>\nendobj\n');
    globalThis.fetch=async (_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b),body=new Uint8Array(end-begin+1);if(begin===0)body.set(first);
      const extended=begin===total-5*262144;
      return new Response(body,{status:206,headers:{'Content-Range':`bytes ${begin}-${end}/${total}`,ETag:extended?'"changed"':'"stable"'}});
    };
    const controller=new AbortController();
    const row=await preparePdfInitialRange({url:'https://reader.test/tail.pdf',rangeChunkSize:262144},{
      signal:controller.signal,readBytes:async r=>new Uint8Array(await r.arrayBuffer()),limit:total,rangeCache:null,canPrefetchFirstPage:()=>true});
    await row.extendedTail.promise;
    const errors=[];
    const opened=await openPdfRangeTask(pdfjs,{url:'https://reader.test/tail.pdf',rangeChunkSize:262144},{
      signal:controller.signal,readBytes:async r=>new Uint8Array(await r.arrayBuffer()),limit:total,rangeCache:null,
      initial:Promise.resolve(row),boundedMetadata:true,onError:e=>errors.push(e)});
    assert.ok(errors.length===0,'an unused speculative failure alone does not fail the document');
    // The actual demand must independently verify the current ETag. If the
    // source still has the changed version, it must not return or cache bytes.
    globalThis.fetch=async (_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b);
      return new Response(new Uint8Array(end-begin+1),{status:206,headers:{
        'Content-Range':`bytes ${begin}-${end}/${total}`,ETag:'"changed"'}});
    };
    transport.requestDataRange(row.extendedTail.begin,row.extendedTail.begin+16384);
    await assert.rejects(opened.promise,/PDF_SOURCE_CHANGED/);
    assert.equal(errors.length,1,'a demanded range from a changed source fails closed');
    assert.equal(transport.delivered.length,0,'changed bytes must never be delivered');
    await opened.destroy();tasks.length=0;
  }
  {
    // If a hint has delivered an early subrange, a truncated remaining body
    // must invalidate the document even after PDF.js has opened successfully.
    const total=10*1024*1024, chunk=262144, first=bytes('%PDF-1.7\n1 0 obj\n<</Type/Page/Contents[9 0 R]/Parent 18274 0 R/Resources 7 0 R>>\nendobj\n');
    let streamController;
    globalThis.fetch=async (_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b),length=end-begin+1;
      if(begin===total-5*chunk) return new Response(new ReadableStream({
        start(controller){streamController=controller;controller.enqueue(new Uint8Array(chunk));}
      }),{status:206,headers:{'Content-Range':`bytes ${begin}-${end}/${total}`,ETag:'"stable"'}});
      const body=new Uint8Array(length);if(begin===0)body.set(first);
      return new Response(body,{status:206,headers:{'Content-Range':`bytes ${begin}-${end}/${total}`,ETag:'"stable"'}});
    };
    const controller=new AbortController();
    const row=await preparePdfInitialRange({url:'https://reader.test/truncated.pdf',rangeChunkSize:chunk},{
      signal:controller.signal,readBytes:async r=>new Uint8Array(await r.arrayBuffer()),limit:total,rangeCache:null,canPrefetchFirstPage:()=>true});
    const errors=[];
    const opened=await openPdfRangeTask(pdfjs,{url:'https://reader.test/truncated.pdf',rangeChunkSize:chunk},{
      signal:controller.signal,readBytes:async r=>new Uint8Array(await r.arrayBuffer()),limit:total,rangeCache:null,
      initial:Promise.resolve(row),boundedMetadata:true,onError:e=>errors.push(e)});
    tasks[0].resolve({numPages:2});await opened.promise;
    transport.requestDataRange(row.extendedTail.begin,row.extendedTail.begin+16384);
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(transport.delivered.length,1,'the complete demanded subrange is usable');
    streamController.close();
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(errors.length,1,'a late truncated remainder fails the open document');
    assert.match(errors[0].message,/PDF_RANGE_INVALID/);
    await opened.destroy();tasks.length=0;
  }
  {
    // Closing while a tail-hint waiter is blocked must never schedule a
    // fallback request or deliver bytes to the disposed PDF.js document.
    const total=10*1024*1024, chunk=262144, requests=[], errors=[];
    let tailController;
    globalThis.fetch=async (_url,init)=>{
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
      const begin=Number(a),end=Number(b),length=end-begin+1;requests.push([begin,end]);
      if(begin===total-2*chunk)return new Response(new ReadableStream({
        start(controller){tailController=controller;}
      }),{status:206,headers:{'Content-Range':`bytes ${begin}-${end}/${total}`,ETag:'"stable"'}});
      return new Response(new Uint8Array(length),{status:206,headers:{
        'Content-Range':`bytes ${begin}-${end}/${total}`,ETag:'"stable"'}});
    };
    const owner=new AbortController();
    const row=await preparePdfInitialRange({url:'https://reader.test/close.pdf',rangeChunkSize:chunk},{
      signal:owner.signal,readBytes:async response=>new Uint8Array(await response.arrayBuffer()),limit:total,rangeCache:null});
    const opened=await openPdfRangeTask(pdfjs,{url:'https://reader.test/close.pdf',rangeChunkSize:chunk},{
      signal:owner.signal,readBytes:async response=>new Uint8Array(await response.arrayBuffer()),limit:total,
      rangeCache:null,initial:Promise.resolve(row),onError:error=>errors.push(error)});
    transport.requestDataRange(row.tail.begin,row.tail.begin+16384);
    await new Promise(resolve=>setTimeout(resolve,0));
    const count=requests.length;
    owner.abort(new DOMException('closed','AbortError'));
    await opened.destroy();
    try {tailController.close();} catch (_) {}
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(requests.length,count,'no fallback range may start after disposal');
    assert.equal(transport.delivered.length,0,'closed readers cannot publish hinted bytes');
    assert.deepEqual(errors,[],'normal disposal is not a transport error');
    tasks.length=0;
  }
  // A server without a strong validator must keep the original safe path;
  // metadata heuristics cannot turn an unvalidated 206 into a range source.
  globalThis.fetch = async (_url, init) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
    const begin = Number(m[1]), end = Number(m[2]);
    const first = pageTree(sparse);
    const body = new Uint8Array(end - begin + 1);
    if (begin === 0) body.set(first);
    return new Response(body, {status:206, headers:{
      'Content-Range':`bytes ${begin}-${end}/${large}`, ETag:'W/"unsafe"'}});
  };
  const noValidator = await preparePdfInitialRange({url:'https://reader.test/weak.pdf', rangeChunkSize:262144}, {
    signal:new AbortController().signal, readBytes:async response=>new Uint8Array(await response.arrayBuffer()),
    limit:large, rangeCache:null
  });
  assert.equal(noValidator, null);
  globalThis.fetch = async (_url, init) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
    assert.ok(match);
    const begin = Number(match[1]), end = Number(match[2]);
    active++;
    peak = Math.max(peak, active);
    calls++;
    await new Promise((resolve, reject) => {
      const finish = () => { init.signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => reject(init.signal.reason);
      init.signal.addEventListener('abort', abort, {once:true});
      releases.push(finish);
    });
    active--;
    return new Response(new Uint8Array(end - begin + 1), {status:206, headers:{
      'Content-Range':`bytes ${begin}-${end}/${large}`, ETag:'"fixed"'}});
  };
  const controller = new AbortController();
  const initial = {bytes:new Uint8Array(262144), total:large, etag:'"fixed"',
    rangeChunkSize:16384, tail:{begin:large - 262144, end:large,
      read:async () => null, onFailure(){}}};
  const opened = await openPdfRangeTask(pdfjs, {url:'https://reader.test/book.pdf', rangeChunkSize:262144}, {
    signal:controller.signal, readBytes:async response => new Uint8Array(await response.arrayBuffer()),
    limit:large, rangeCache:null, initial:Promise.resolve(initial)
  });
  assert.equal(captured.rangeChunkSize, 16384);
  assert.equal(captured.range, transport);
  for (let i = 0; i < PDF_METADATA_RANGE_CONCURRENCY + 6; i++)
    transport.requestDataRange(262144 + i * 32768, 262144 + i * 32768 + 16384);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, PDF_METADATA_RANGE_CONCURRENCY);
  assert.equal(peak, PDF_METADATA_RANGE_CONCURRENCY);
  while (releases.length) releases.shift()();
  await new Promise(resolve => setTimeout(resolve, 10));
  while (releases.length) releases.shift()();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(transport.delivered.length, PDF_METADATA_RANGE_CONCURRENCY + 6);
  tasks[0].resolve({numPages: 3});
  assert.equal((await opened.promise).numPages, 3);
  await opened.destroy();

  // Closing the document aborts both active and queued demand reads.
  calls = active = peak = 0; releases = [];
  const cancelled = new AbortController();
  const secondErrors = [];
  const second = await openPdfRangeTask(pdfjs, {url:'https://reader.test/book.pdf', rangeChunkSize:262144}, {
    signal:cancelled.signal, readBytes:async response => new Uint8Array(await response.arrayBuffer()),
    limit:large, rangeCache:null, initial:Promise.resolve(initial), onError:error=>secondErrors.push(error)
  });
  for (let i = 0; i < PDF_METADATA_RANGE_CONCURRENCY + 6; i++)
    transport.requestDataRange(262144 + i * 32768, 262144 + i * 32768 + 16384);
  await new Promise(resolve => setTimeout(resolve, 0));
  cancelled.abort(new DOMException('closed', 'AbortError'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, PDF_METADATA_RANGE_CONCURRENCY, 'queued ranges must not start after disposal');
  assert.equal(secondErrors.length, 0, 'disposal is not reported as a transport failure');
  await second.destroy();

  calls = active = peak = 0; releases = [];
  const third = await openPdfRangeTask(pdfjs, {url:'https://reader.test/book.pdf', rangeChunkSize:262144}, {
    signal:new AbortController().signal, readBytes:async response => new Uint8Array(await response.arrayBuffer()),
    limit:large, rangeCache:null, initial:Promise.resolve(initial)
  });
  transport.requestDataRange(262144, 278528);
  transport.requestDataRange(278528, 294912);
  transport.requestDataRange(311296, 327680);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 2, 'only adjacent requested ranges may be combined');
  while (releases.length) releases.shift()();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(transport.delivered.map(x=>[x.begin,x.value.length]).sort((a,b)=>a[0]-b[0]),
                   [[262144,16384],[278528,16384],[311296,16384]]);
  await third.destroy();

  // Foreground prefix demand may promote a range already queued by the tree
  // checker. A reserved slot serves it without exceeding the overall bound.
  calls = active = peak = 0; releases = [];
  const seenRanges = [];
  globalThis.fetch = async (_url, init) => {
    const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
    const begin=Number(a),end=Number(b);seenRanges.push(begin);active++;peak=Math.max(peak,active);calls++;
    await new Promise((resolve,reject)=>{
      const finish=()=>{init.signal.removeEventListener('abort',abort);resolve();};
      const abort=()=>reject(init.signal.reason);init.signal.addEventListener('abort',abort,{once:true});releases.push(finish);
    });
    active--;
    return new Response(new Uint8Array(end-begin+1),{status:206,headers:{
      'Content-Range':`bytes ${begin}-${end}/${large}`,ETag:'"fixed"'}});
  };
  const priorityController=new AbortController();
  const priorityTask=await openPdfRangeTask(pdfjs,{url:'https://reader.test/book.pdf',rangeChunkSize:262144},{
    signal:priorityController.signal,readBytes:async response=>new Uint8Array(await response.arrayBuffer()),
    limit:large,rangeCache:null,initial:Promise.resolve(initial),boundedMetadata:true});
  for(let i=0;i<PDF_METADATA_RANGE_CONCURRENCY+6;i++)
    transport.requestDataRange(262144+i*32768,262144+i*32768+16384);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls,PDF_METADATA_RANGE_CONCURRENCY-1,'reserve one foreground slot');
  const promoted=262144+(PDF_METADATA_RANGE_CONCURRENCY+3)*32768;
  assert.ok(!seenRanges.includes(promoted));
  priorityTask.prioritizeRange({begin:promoted+50,end:promoted+51});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(seenRanges.at(-1),promoted,'a queued requested range must be promoted');
  assert.equal(peak,PDF_METADATA_RANGE_CONCURRENCY,'no additional requests beyond the bound');
  priorityController.abort(new DOMException('closed','AbortError'));
  await new Promise(resolve=>setTimeout(resolve,10));
  await priorityTask.destroy();

  // Strong validators bind every adaptive/coalesced read to the same source.
  const changed = new AbortController(), errors = [];
  const fourth = await openPdfRangeTask(pdfjs, {url:'https://reader.test/book.pdf', rangeChunkSize:262144}, {
    signal:changed.signal, readBytes:async response => new Uint8Array(await response.arrayBuffer()),
    limit:large, rangeCache:null, initial:Promise.resolve(initial), onError:error=>errors.push(error)
  });
  globalThis.fetch = async (_url, init) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range'));
    const begin=Number(match[1]), end=Number(match[2]);
    return new Response(new Uint8Array(end-begin+1),{status:206,headers:{
      'Content-Range':`bytes ${begin}-${end}/${large}`,ETag:'"different"'}});
  };
  transport.requestDataRange(262144,278528);
  transport.requestDataRange(278528,294912);
  await assert.rejects(fourth.promise,/PDF_SOURCE_CHANGED/);
  assert.equal(errors.length,1,'a shared failure must fail the document only once');
  assert.equal(transport.delivered.length,0);
  await fourth.destroy();
} finally {
  globalThis.fetch = nativeFetch;
}
console.log('Sparse PDF detection, exact demand ranges, bounded concurrency and disposal passed');

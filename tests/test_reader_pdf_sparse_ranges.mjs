import assert from 'node:assert/strict';
import {choosePdfRangeChunkSize, openPdfRangeTask, preparePdfInitialRange, PDF_METADATA_RANGE_CONCURRENCY}
  from '../static/reader/pdf/reader-pdf-network.mjs';

globalThis.location = {href: 'https://reader.test/'};
const large = 64 * 1024 * 1024;
const bytes = text => new TextEncoder().encode(text);
const pageTree = (numbers, extra = '') => bytes('%PDF-1.7\n2 0 obj\n<< /Type /Pages /Count ' + numbers.length +
  ' /Kids [' + numbers.map(n => `${n} 0 R`).join(' ') + `] ${extra} >>\nendobj\n`);
const sparse = Array.from({length: 160}, (_, i) => 4 + i * 6);
const clustered = Array.from({length: 160}, (_, i) => 5 + i);

assert.equal(choosePdfRangeChunkSize(pageTree(sparse), large), 16384);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {createReaderPdfSearch} from '../../../static/reader/pdf/reader-pdf-search.mjs';
import {createReaderPdfTextRuntime} from '../../../static/reader/pdf/reader-pdf-text-runtime.mjs';
import * as bookSearch from '../../../static/reader/search/reader-pdf-book-search.mjs';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('scheduled idle prefetch must not cancel a pending foreground PDF search', async () => {
  const saved = new Map(['Worker', 'window', 'navigator', 'setTimeout', 'clearTimeout'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const workers = [], timers = new Map(), idle = [];
  let timerId = 0;
  const set = (key, value) => Object.defineProperty(globalThis, key, {value, configurable:true, writable:true});
  set('Worker', class {
    constructor() { this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    send(data) { this.onmessage({data}); }
    terminate() { this.terminated = true; }
  });
  set('setTimeout', (callback, delay) => { const id = ++timerId; timers.set(id, {callback, delay}); return id; });
  set('clearTimeout', id => timers.delete(id));
  set('window', {requestIdleCallback(callback, options) { idle.push({callback, options}); }});
  set('navigator', {connection: {saveData:false, effectiveType:'4g'}});
  const ctx = {
    readerAbortController: new AbortController(), capability:{mode:'pdf'}, ocrManifestUrl:'https://example.test/manifest.json',
    pdfOcrManifest:{page_count:1, source_sha256:'a'.repeat(64), book_text:{path:'book.json.gz', bytes:100, sha256:'b'.repeat(64)}},
    documentState:{pageCount:1}, PDF_BOOK_SEARCH_PREFETCH_MAX_BYTES:1000, PDF_BOOK_SEARCH_PREFETCH_DELAY:123,
    pdfBookSearchModulePromise:Promise.resolve(bookSearch), fullSearchSession:{},
    pdfOcrSource:() => ({assetUrl:path => `https://example.test/${path}`}),
    assertReaderActive() { assert.equal(this.readerAbortController.signal.aborted, false); },
    isReaderGenerationCurrent:(kind, generation) => kind === 'search' && generation === 1,
  };
  ctx.loadPdfOcrManifest = createReaderPdfTextRuntime(ctx).loadPdfOcrManifest;
  Object.assign(ctx, createReaderPdfSearch(ctx));
  try {
    // Normal ready Reader: manifest cached and the genuine client already created.
    const client = await ctx.ensurePdfBookSearchClient(await ctx.loadPdfOcrManifest());
    const worker = workers[0];
    assert.equal(workers.length, 1);
    worker.send({bookReady:true});
    ctx.schedulePdfBookSearchPrefetch();
    assert.equal(timers.size, 1);
    const [id, timer] = [...timers][0];
    assert.equal(timer.delay, 123); timers.delete(id); timer.callback();
    assert.equal(idle.length, 1); assert.equal(idle[0].options.timeout, 1500);
    let outcome = {state:'pending'};
    const search = ctx.searchConcentratedPdf('needle', 1).then(
      results => { outcome = {state:'resolved', results}; },
      error => { outcome = {state:'rejected', error}; });
    await flush();
    const searchRequest = worker.messages.at(-1);
    assert.equal(searchRequest.type, 'search'); assert.equal(outcome.state, 'pending');
    idle[0].callback();
    await flush();
    const prefetchRequest = worker.messages.find(message => message.type === 'prefetch');
    assert.equal(prefetchRequest, undefined, 'background prefetch must not replace foreground');
    assert.strictEqual(ctx.pdfBookSearchClient, client);
    // Complete both Worker requests; only client matching/cancellation determines the outcome.
    worker.send({id:searchRequest.id, session:searchRequest.id, total:0, offset:0, pageSize:50, results:[]});
    if (prefetchRequest) worker.send({id:prefetchRequest.id, ready:true, session:null});
    await ctx.pdfBookSearchPrefetchPromise;
    await flush();
    assert.equal(outcome.state, 'resolved', `foreground search was ${outcome.state}: ${outcome.error?.name}: ${outcome.error?.message}`);
    await search;
    assert.deepEqual(outcome.results, []);
  } finally {
    ctx.readerAbortController.abort();
    if (ctx.pdfBookSearchPrefetchTimer) clearTimeout(ctx.pdfBookSearchPrefetchTimer);
    ctx.pdfBookSearchClient?.dispose();
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createReaderPdfEngine} from '../../../static/reader/pdf/reader-pdf-engine.mjs';

// The fresh page-one fast path does not inspect producer or xref hints.
// Saved deep-page restoration still has to qualify through the old heuristic.
for (const [name, first, restoration, candidate, staged, inspected] of [
  ['fresh validated partial', {complete:false, total:12_000_000}, null, false, true, false],
  ['deep replay qualified by hints', {complete:false, total:12_000_000}, {page:9}, true, true, true],
  ['deep replay not qualified', {complete:false, total:12_000_000}, {page:9}, false, false, true],
  ['missing total', {complete:false}, null, true, false, false],
  ['complete response', {complete:true}, null, true, false, false]
]) {
  test(`first-page staging: ${name}`, async () => {
    globalThis.VoiceOfMLReaderSecurity = {readBytes: async () => new Uint8Array(), LIMITS:{pdfDocumentBytes:20_000_000}};
    const module = {PDFDataRangeTransport: function(){}};
    const calls = [];
    const ctx = {
      sourceUrl:'https://example.test/book.pdf', readerContentUrl: url => url,
      readerAbortController:new AbortController(), capability:{mode:'pdf'}, extension:'pdf',
      ocrManifestUrl:'', pdfV3Manifest:null, restorationFailed:false,
      readerRestorationPromise:Promise.resolve(restoration), readerRuntime:{currentGeneration:()=>1},
      assertReaderActive(){}, readerAbortError:()=>new DOMException('aborted','AbortError'),
      createPdfFetchPolicy:()=>({add(){},dispose(){}}), trackReaderResource:()=>()=>{},
      preparePdfInitialRange: async () => ({...first, bytes:new Uint8Array([37,80,68,70,45]), rangeChunkSize:262144}),
      preloadPdfEngine:async()=>module, awaitReader:async value=>value,
      isFirstPageCandidate:(bytes,total)=>{calls.push(total);return candidate;},
      preparePdfWorker:async (_module, staged)=>{calls.push(staged); return module;},
      releasePdfWorker(){}, measurePdf:value=>Promise.resolve(value), pdfWorker:null,
      loadPdfWithTimeout:async()=>({numPages:1}), retryableReaderProxyError:()=>false,
    };
    const api = createReaderPdfEngine(ctx);
    await api.loadPdfDocument();
    assert.deepEqual(calls, [...(inspected ? [first.total] : []), ...(staged ? [true] : [])]);
  });
}

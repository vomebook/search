import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { makeFirstPageWorkerSource, installFirstPageWorker } from "../static/reader/pdf/pdf-first-page-worker-adapter.mjs";

const bytes = readFileSync("static/vendor/pdf.worker.07ceb740d746.mjs");
assert.equal(createHash("sha256").update(bytes).digest("hex"),"07ceb740d746e5d9012fcf9f27d5c7dea09f7d2f5e74f5c8109e5787551a2333");
const source = bytes.toString("utf8"), patched = makeFirstPageWorkerSource(source);
assert.match(patched, /ReaderValidatePageCount/);
assert.match(patched, /readerPageCountPending/);
assert.match(patched, /ensureDoc\("checkLastPage", \[false\]\)/);
assert.match(patched, /requestLoadedStream\(\)/);
assert.match(patched, /ReaderGetPagePrefix/);
assert.throws(() => makeFirstPageWorkerSource(source.replace('const workerVersion = "6.4.299";', 'const workerVersion = "9.0.0";')),
  /PDF_PREVIEW_WORKER_VERSION_MISMATCH/);
assert.throws(() => makeFirstPageWorkerSource(source.replace('async checkLastPage(recoveryMode = false) {', '')),
  /PDF_PREVIEW_WORKER_VERSION_MISMATCH/);
// A prestarted fetch is only a scheduling change: wrong bytes are rejected
// before any worker source can be executed.
await assert.rejects(installFirstPageWorker('https://reader.test/worker.mjs','0'.repeat(64),
  {response:Promise.resolve(new Response(bytes))}), /PDF_PREVIEW_WORKER_INTEGRITY/);
const owner=new AbortController();owner.abort(new DOMException('closed','AbortError'));
await assert.rejects(installFirstPageWorker('https://reader.test/worker.mjs','0'.repeat(64),
  {signal:owner.signal,response:Promise.resolve(new Response(bytes))}), error=>error.name==='AbortError');
const during=new AbortController();let cancelled=false;
const stalled=new Response(new ReadableStream({pull(){},cancel(){cancelled=true;}}));
const pending=installFirstPageWorker('https://reader.test/worker.mjs','0'.repeat(64),
  {signal:during.signal,response:Promise.resolve(stalled)});
await new Promise(resolve=>setTimeout(resolve,0));during.abort(new DOMException('closed','AbortError'));
await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(cancelled,true);
const headersOwner=new AbortController();
const stalledHeaders=installFirstPageWorker('https://reader.test/worker.mjs','0'.repeat(64),
  {signal:headersOwner.signal,response:new Promise(()=>{})});
headersOwner.abort(new DOMException('closed','AbortError'));
await assert.rejects(stalledHeaders,error=>error.name==='AbortError');
console.log("Pinned PDF first-page worker adapter and fail-closed checks passed");

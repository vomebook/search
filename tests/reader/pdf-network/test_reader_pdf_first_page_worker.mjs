import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeFirstPageWorkerSource, installFirstPageWorker } from "../../../static/reader/pdf/pdf-first-page-worker-adapter.mjs";

const bytes = readFileSync("static/vendor/pdf.worker.43710009ea26.mjs");
assert.equal(createHash("sha256").update(bytes).digest("hex"),"43710009ea26bfbcb615524946e46e3aaf8ad927514f5e465e8ff6d18044ffe9");
const source = bytes.toString("utf8"), patched = makeFirstPageWorkerSource(source);
assert.match(patched, /ReaderValidatePageCount/);
assert.match(patched, /readerPageCountPending/);
assert.match(patched, /ensureDoc\("checkLastPage", \[false\]\)/);
assert.match(patched, /requestLoadedStream\(\)/);
assert.match(patched, /ReaderGetPagePrefix/);
const temp = mkdtempSync(join(tmpdir(), "reader-pdf-resources-"));
try {
  const file = join(temp, "worker.mjs");
  writeFileSync(file, patched + "\nexport { Page, Dict, Ref, MissingDataException };\n");
  const {Page, Dict, Ref, MissingDataException} = await import(pathToFileURL(file).href);
  const font = Ref.get(1,0), fontDescriptor = Ref.get(2,0), color = Ref.get(3,0), image = Ref.get(4,0);
  const refs = new Map([[font,100],[fontDescriptor,200],[color,300],[image,400]]);
  const gates = new Map(Array.from(refs.values(), begin => [begin,Promise.withResolvers()]));
  const loaded = new Set(), asked = new Set();
  const xref = {pdfManager:{},stream:{isDataLoaded:false,manager:{async requestRanges(ranges){
    await Promise.all(ranges.map(async ({begin}) => {
      asked.add(begin);
      await gates.get(begin).promise;
      loaded.add(begin);
    }));
  }}},fetch(ref){
    const begin = refs.get(ref);
    assert.ok(begin, "no unrelated resource requested");
    if (!loaded.has(begin)) throw new MissingDataException(begin,begin+1);
    const dict = new Dict(xref);
    if (ref === font) dict.set("FontDescriptor",fontDescriptor);
    return dict;
  }};
  const resources = new Dict(xref), pageDict = new Dict(xref);
  resources.set("Font",font); resources.set("ColorSpace",color); resources.set("XObject",image);
  pageDict.set("Resources",resources);
  const page = new Page({pageDict,xref,pageIndex:0,pdfManager:{ensure:(obj,key)=>obj[key]},globalIdFactory:class {}});
  const pending = page.readerLoadOpeningResources();
  pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(asked,new Set([100,300,400]));
  gates.get(100).resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(asked.has(200), "font child must not wait for independent color or image ranges");
  let finished = false;
  void pending.then(() => { finished = true; });
  gates.get(200).resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished,false,"painting must still wait for all resource groups");
  gates.get(300).resolve(); gates.get(400).resolve();
  await pending;
  assert.equal(finished,true);
} finally { rmSync(temp,{recursive:true,force:true}); }
assert.throws(() => makeFirstPageWorkerSource(source.replace('const workerVersion = "6.5.438";', 'const workerVersion = "9.0.0";')),
  /PDF_PREVIEW_WORKER_VERSION_MISMATCH/);
assert.throws(() => makeFirstPageWorkerSource(source.replace('async checkLastPage(recoveryMode = false) {', '')),
  /PDF_PREVIEW_WORKER_VERSION_MISMATCH/);
assert.throws(() => makeFirstPageWorkerSource(source.replace('async checkLastPage(recoveryMode = false) {\n    const {',
  'async checkLastPage(recoveryMode = false) {\n    const {\nasync checkLastPage(recoveryMode = false) {\n    const {')),
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

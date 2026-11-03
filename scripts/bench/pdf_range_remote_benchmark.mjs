// Synthetic Node-only baseline: no real PDF, network, browser or upstream data.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const [root, output] = process.argv.slice(2);
assert.ok(root && output, "expected checked-out source and output paths");
const source = path.join(root, "static/reader/pdf/reader-pdf-network.mjs");
const sourceSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
const {createPdfRangeCache, isFirstPageCandidate, choosePdfRangeChunkSize} = await import(pathToFileURL(source));
const url = "https://fixture.invalid/book.pdf", version = {etag:'"stable"',total:16*1024*1024};
const size = 16384, bytes = new Uint8Array(size);
for (let i=0;i<size;i++) bytes[i]=i%251;
const cache = createPdfRangeCache({maxBytes:8*1024*1024,maxEntries:64});
for (let i=0;i<64;i++) cache.put(url,i*size,bytes,version);
assert.equal(cache.size,64);
assert.equal(cache.byteLength,64*size);
assert.deepEqual(cache.get(url,0,4,version),bytes.slice(0,4));
assert.equal(cache.get(url,0,4,{...version,etag:'"different"'}),null);
const pinned=cache.get(url,0,4,version);pinned.fill(0);
assert.deepEqual(cache.get(url,0,4,version),bytes.slice(0,4));
const pdf = new TextEncoder().encode('%PDF-1.6\n1 0 obj\n<</Type/Page/Contents[9 0 R]/Parent 18274 0 R/Resources 7 0 R>>\nendobj\n');
assert.equal(isFirstPageCandidate(pdf,64*1024*1024,262144),true);
assert.equal(choosePdfRangeChunkSize(pdf,64*1024*1024),262144);
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
function measure(name, operation, iterations) {
  for(let i=0;i<1000;i++) operation(i);
  const samples=[];let checksum=0;
  for(let round=0;round<25;round++) {
    const start=performance.now();
    for(let i=0;i<iterations;i++) checksum+=operation(i);
    samples.push((performance.now()-start)*1000000/iterations);
  }
  return {name,unit:"ns/op",median:median(samples),min:Math.min(...samples),max:Math.max(...samples),samples,checksum};
}
const results=[
  measure("range_cache_hot_get_4k",i=>cache.get(url,(i%64)*size,(i%64)*size+4096,version)?.byteLength||0,5000),
  measure("range_cache_miss_other_version",i=>cache.get(url,(i%64)*size,(i%64)*size+4096,{...version,etag:'"other"'})===null?1:0,5000),
  measure("first_page_candidate",()=>isFirstPageCandidate(pdf,64*1024*1024,262144)?1:0,5000),
  measure("adaptive_chunk_detection",()=>choosePdfRangeChunkSize(pdf,64*1024*1024),5000)
];
const result={revision:"cdd3e97eb26977777dbad2c1b1437b9b76f20b20",source_sha256:sourceSha256,
  metadata:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,run_id:process.env.GITHUB_RUN_ID||null},
  scope:"Node.js on synthetic 64-entry range cache and tiny synthetic prefix; no browser, worker, real PDF, network or production latency; no baseline comparison in this run",
  results};
writeFileSync(output,JSON.stringify(result,null,2)+"\n",{flag:"wx"});
console.log("PDF_RANGE_BENCHMARK_SUMMARY="+JSON.stringify({metadata:result.metadata,results:results.map(({samples,...row})=>row)}));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../static/reader-pdf-book-search-worker.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function readBounded('), end=source.indexOf('\nasync function loadBook()',start);
const read=vm.runInNewContext('const limit=1024; const aborted=()=>new DOMException("cancelled","AbortError");'+
  source.slice(start,end)+';readBounded',{TextDecoder,Uint8Array,DOMException});
const stream=chunks=>new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}});
const signal=new AbortController().signal;
const text='手机 😀 كتاب';
const bytes=new TextEncoder().encode(text);
assert.equal(await read(stream([...bytes].map(byte=>Uint8Array.of(byte))),signal,null,true),text);
assert.deepEqual(Array.from(await read(stream([bytes.subarray(0,3),bytes.subarray(3)]),signal,bytes.length)),Array.from(bytes));
await assert.rejects(()=>read(stream([bytes.subarray(0,3)]),signal,bytes.length),/SIZE_MISMATCH/);
await assert.rejects(()=>read(stream([bytes]),signal,3),/RESOURCE_LIMIT/);
await assert.rejects(()=>read(stream([new Uint8Array(1025)]),signal,null,true),/RESOURCE_LIMIT/);
const controller=new AbortController();controller.abort();
await assert.rejects(()=>read(stream([bytes]),controller.signal,null,true),error=>error.name==='AbortError');
console.log('OCR transport byte bounds, split Unicode and cancellation passed');

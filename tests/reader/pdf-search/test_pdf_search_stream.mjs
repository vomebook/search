import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readPdfSearchBytes,readPdfSearchText} from '../../../static/reader/search/reader-pdf-search-stream.mjs';
const stream=chunks=>new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}});
const signal=()=>new AbortController().signal;
test('streamed UTF-8 spans chunk boundaries and flushes invalid tail',async()=>{
 const input='手机 😀 كتاب';const bytes=new TextEncoder().encode(input);
 assert.equal(await readPdfSearchText(stream([...bytes].map(byte=>Uint8Array.of(byte))),signal(),1024),input);
 assert.equal(await readPdfSearchText(stream([Uint8Array.of(0xe4,0xb8)]),signal(),1024),'�');
 assert.equal(await readPdfSearchText(stream([]),signal(),0),'');
});
test('exact binary sizes and decoded size limits are enforced',async()=>{
 const data=Uint8Array.of(1,2,3,4);
 assert.deepEqual(await readPdfSearchBytes(stream([data.slice(0,2),data.slice(2)]),signal(),4,4),data);
 assert.deepEqual(await readPdfSearchBytes(stream([]),signal(),0,0),new Uint8Array(0));
 await assert.rejects(readPdfSearchBytes(stream([data]),signal(),3,10),/READER_RESOURCE_LIMIT/);
 await assert.rejects(readPdfSearchBytes(stream([data]),signal(),5,3),/READER_RESOURCE_LIMIT/);
 await assert.rejects(readPdfSearchBytes(stream([data]),signal(),5,10),/PDF_OCR_SIZE_MISMATCH/);
 await assert.rejects(readPdfSearchText(stream([data]),signal(),3),/READER_RESOURCE_LIMIT/);
});
test('abort pending read cancels the source and releases the reader',async()=>{
 let cancelled=0,ready;const waiting=new Promise(resolve=>{ready=resolve;});
 const body=new ReadableStream({pull(){ready();return new Promise(()=>{});},cancel(){cancelled++;}});
 const owner=new AbortController();const promise=readPdfSearchBytes(body,owner.signal,1,10);
 await waiting;owner.abort();await assert.rejects(promise,{name:'AbortError',message:'Search cancelled'});
 assert.equal(cancelled,1);assert.equal(body.locked,false);
});
test('already cancelled signals and read failures are propagated without leaks',async()=>{
 const owner=new AbortController();owner.abort();const body=stream([Uint8Array.of(1)]);
 await assert.rejects(readPdfSearchBytes(body,owner.signal,1,10),{name:'AbortError'});assert.equal(body.locked,false);
 const bad=new ReadableStream({pull(controller){controller.error(new Error('stream failure'));}});
 await assert.rejects(readPdfSearchText(bad,signal(),10),/stream failure/);assert.equal(bad.locked,false);
});

test('cancellation rejection is swallowed while abort still settles',async()=>{
 let ready;const waiting=new Promise(resolve=>{ready=resolve;});
 const body=new ReadableStream({pull(){ready();return new Promise(()=>{});},cancel(){throw new Error('cancel failed');}});
 const owner=new AbortController();const pending=readPdfSearchText(body,owner.signal,10);
 await waiting;owner.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(body.locked,false);
});

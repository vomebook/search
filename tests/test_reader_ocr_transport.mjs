import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createPdfBookSearch } from '../static/reader-pdf-book-search.mjs';
import { validateBookText, searchBookText } from '../static/reader-book-text.js';

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

const workers=[];
globalThis.Worker=class {
  constructor(){this.messages=[];this.terminated=false;workers.push(this);}
  postMessage(message){this.messages.push(message);}
  terminate(){this.terminated=true;}
};
const client=createPdfBookSearch({});
const initial=client.search('first');
const rejected=assert.rejects(initial,error=>error.name==='AbortError');
client.cancel();await rejected;
assert.equal(workers[0].terminated,true);
const retry=client.search('retry');
assert.equal(workers.length,2);
workers[0].onmessage({data:{bookReady:true}});
client.cancel();await assert.rejects(retry,error=>error.name==='AbortError');
assert.equal(workers[1].terminated,true);
const ready=client.search('ready');
const owner=workers[2], id=owner.messages.at(-1).id;
owner.onmessage({data:{bookReady:true}});
owner.onmessage({data:{id,session:id,total:1,results:[]}});
assert.equal((await ready).total,1);
client.cancel();assert.equal(owner.terminated,false);
assert.equal(owner.messages.at(-1).type,'cancel');
client.dispose();assert.equal(owner.terminated,true);
await assert.rejects(client.search('closed'),error=>error.name==='AbortError');

const full={version:2,kind:'pdf-book-text',complete:true,offset_unit:'unicode-codepoint',page_count:2,
  pages:[1,2].map(page=>({page,text:'\u{1f600}needle',layout:{offset_unit:'unicode-codepoint',large:'unneeded'.repeat(1000)},
    text_spans:[{start:1,end:7,box:[0,0,1,1],block:page,precision:'block',extra:'unused'}]}))};
const packed=gzipSync(JSON.stringify(full)), posted=[];
const url='https://voiceofml-search.hf.space/api/reader-bucket-resource?path=objects/aa/'+
  'a'.repeat(64)+'/bbbbbbbbbbbbbbbb/text/book-text.json.gz';
const configuration={url,bytes:packed.length,sha256:Buffer.from(await webcrypto.subtle.digest('SHA-256',packed)).toString('hex'),pageCount:2};
const scope={self:{location:{href:'https://voiceofml-search.hf.space/static/worker.mjs',origin:'https://voiceofml-search.hf.space'},
  VoiceOfMLReaderSecurity:{LIMITS:{chapterTotalBytes:1024*1024}},postMessage:data=>posted.push(data)},
  URL,DOMException,AbortController,TextDecoder,Uint8Array,ReadableStream,DecompressionStream,
  crypto:webcrypto,performance,setTimeout,clearTimeout,fetch:async()=>new Response(packed),validateBookText,searchBookText};
const context=vm.createContext(scope);
vm.runInContext(source.replace(/^import .*;\n/gm,''),context);
await scope.self.onmessage({data:{type:'init',configuration}});
await scope.self.onmessage({data:{type:'search',id:7,query:'needle'}});
assert.equal(posted[0].bookReady,true);
const final=posted.at(-1);
assert.equal(final.total,2);
assert.deepEqual(final.results.map(result=>result.boxes[0].block),[1,2]);
assert.equal(vm.runInContext('book.pages.every(page=>!("layout" in page)&&!("extra" in page.text_spans[0]))',context),true);
console.log('OCR parsing cancellation, fresh Worker retry and compact exact search passed');

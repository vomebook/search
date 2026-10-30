import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {openDirectDjvu, openNativeDjvu} from '../static/reader/pdf/reader-djvu-loader.mjs';

Object.defineProperty(globalThis, 'crypto', {configurable: true, value: webcrypto});
globalThis.matchMedia = () => ({matches: false});
globalThis.VoiceOfMLReaderSecurity = {
  LIMITS: {documentBytes: 512 * 1024 * 1024},
  async readBytes(response, limit) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('READER_RESOURCE_LIMIT');
    return bytes;
  },
  async readText(response, limit) { return new TextDecoder().decode(await this.readBytes(response,limit)); }
};
let workers = 0;
globalThis.Worker = class { constructor() { workers++; throw new Error('unexpected decoder start'); } };
const bytes = new TextEncoder().encode('AT&TFORM fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifest = {primary: {resource: {kind: 'dataset-source', bytes: bytes.length, sha256}}};
const url = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/' + 'a'.repeat(40) + '/book.djvu';
function context(fetchReaderUrl, controller = new AbortController()) {
  return {readerAbortController: controller, v3ResourceUrl: () => url, fetchReaderUrl,
    assertReaderActive: () => controller.signal.throwIfAborted(), trackReaderResource() {}};
}
{
  const contextValue = context(async actual => {
    assert.equal(actual, url);
    const corrupt = bytes.slice(); corrupt[corrupt.length - 1] ^= 1;
    return new Response(corrupt);
  });
  await assert.rejects(openDirectDjvu(contextValue, manifest, Promise.resolve({})), /DJVU_PRIMARY_HASH_MISMATCH/);
  assert.equal(workers, 0, 'corrupt source must not reach decoder');
}
{
  const contextValue = context(async () => new Response(bytes.slice(0, -1)));
  await assert.rejects(openDirectDjvu(contextValue, manifest, Promise.resolve({})), /DJVU_PRIMARY_SIZE_MISMATCH/);
  assert.equal(workers, 0, 'truncated source must not reach decoder');
}
{
  let started, release;
  const waiting = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  const contextValue = context((_url, options) => new Promise((resolve, reject) => {
    release = resolve;
    options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true});
    started();
  }), controller);
  const opening = openDirectDjvu(contextValue, manifest, Promise.resolve({}));
  await waiting;
  controller.abort();
  await assert.rejects(opening, {name: 'AbortError'});
  release(new Response(bytes));
  assert.equal(workers, 0, 'cancelled download must not reach decoder');
}
{
  let stopped = false;
  const contextValue = context((_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { stopped = true; reject(new DOMException('aborted', 'AbortError')); }, {once: true});
  }));
  await assert.rejects(openDirectDjvu(contextValue, manifest, Promise.reject(new Error('bad page map'))), /bad page map/);
  assert.equal(stopped, true, 'failed page map cancels source download');
  assert.equal(workers, 0);
}
{
  let sourceReads=0;
  const value = context(async()=>{sourceReads++;return new Response(bytes);});
  Object.assign(value,{sourceUrl:url.replace('a'.repeat(40),'main'),readerDownloadApiUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async()=>new Response(JSON.stringify({revision:'b'.repeat(40),
      url:url.replace('/book.djvu','/different.djvu').replace('a'.repeat(40),'b'.repeat(40))}))});
  await assert.rejects(openNativeDjvu(value),/DJVU_SOURCE_REVISION_INVALID/);
  assert.equal(sourceReads,0,'changed immutable revision must not be downloaded');
  assert.equal(workers,0);
}
{
  let revisionRequests=0,sourceRequests=0;
  const value=context(async()=>{throw Error('unexpected full source')});
  Object.assign(value,{sourceUrl:url,readerDownloadApiUrl:x=>x,readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async(actual)=>{
      if(actual.startsWith('/api/reader-source-revision')){revisionRequests++;throw Error('unexpected revision request');}
      sourceRequests++;return new Response(bytes,{status:206,headers:{'ETag':'"stable"',
        'Content-Range':`bytes 0-${bytes.length-1}/${bytes.length}`,'Content-Length':String(bytes.length)}});
    }});
  const events=[];value.trackReaderResource=()=>{};
  globalThis.Worker=class {
    postMessage(message){events.push(message.operation);if(message.operation==='prepare')queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true}}));
      if(message.operation==='open-range')queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,count:1}}));}
    terminate(){}
  };
  const document=await openNativeDjvu(value);
  assert.equal(revisionRequests,0,'a canonical pinned source must not require another revision lookup');
  assert.equal(sourceRequests,1);assert.deepEqual(events,['prepare','open-range']);document.destroy();
}
{
  const encoded=url.replace('/book.djvu','/%E4%B9%A6%20%28scan%29.djvu');
  let revisionRequests=0;
  const value=context(async()=>{throw Error('unexpected full source')});
  Object.assign(value,{sourceUrl:encoded,readerDownloadApiUrl:x=>x,readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async(actual)=>{
      if(actual.startsWith('/api/reader-source-revision')){revisionRequests++;throw Error('unexpected revision request');}
      return new Response(bytes,{status:206,headers:{'ETag':'"stable"',
        'Content-Range':`bytes 0-${bytes.length-1}/${bytes.length}`,'Content-Length':String(bytes.length)}});
    }});
  const document=await openNativeDjvu(value);
  assert.equal(revisionRequests,0,'a safely encoded original filename retains the pinned fast path');document.destroy();
}
{
  const invalid=url+'?revision=other';let called=0;
  const value=context(async()=>{called++;throw Error('unexpected source')});
  Object.assign(value,{sourceUrl:invalid,readerDownloadApiUrl:x=>x,readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async()=>{called++;throw Error('unexpected request')}});
  await assert.rejects(openNativeDjvu(value),/DJVU_SOURCE_REVISION_INVALID/);
  assert.equal(called,0,'pinned source query must be rejected before any fetch');
}
for (const invalid of [
  url.replace('VoiceOfML/Test','Other/Test'),
  url.replace('/book.djvu','/book.pdf'),
  url.replace('/book.djvu','/bad%2Fbook.djvu'),
  url.replace('huggingface.co','hf-mirror.com')
]) {
  let revisionRequests=0,sourceRequests=0;
  const value=context(async()=>{sourceRequests++;throw Error('unexpected source')});
  Object.assign(value,{sourceUrl:invalid,readerDownloadApiUrl:x=>x,readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async(actual)=>{
      if(actual.startsWith('/api/reader-source-revision')){revisionRequests++;return new Response('',{status:400});}
      sourceRequests++;throw Error('unexpected source');
    }});
  await assert.rejects(openNativeDjvu(value),/DJVU_SOURCE_REVISION_HTTP_400/);
  assert.equal(revisionRequests,1,'noncanonical pinned sources retain server validation');
  assert.equal(sourceRequests,0);
}
{
  const instances=[];
  globalThis.Worker=class {
    constructor(){this.messages=[];this.terminated=false;instances.push(this);}
    postMessage(message){this.messages.push(message);if(message.operation==='prepare')
      queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true}}));}
    terminate(){this.terminated=true;}
  };
  const controller=new AbortController();let rangeStarted,rangeCancelled=false;
  const rangeWaiting=new Promise(resolve=>rangeStarted=resolve);
  const value=context(async()=>{throw Error('unexpected full source')},controller);
  Object.assign(value,{sourceUrl:url.replace('a'.repeat(40),'main'),readerDownloadApiUrl:x=>x,
    readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async(actual,timeout,options)=>actual.startsWith('/api/reader-source-revision')
      ? new Response(JSON.stringify({revision:'a'.repeat(40),url}))
      : new Promise((resolve,reject)=>{
          options.signal.addEventListener('abort',()=>{rangeCancelled=true;reject(options.signal.reason)},{once:true});rangeStarted();
        })});
  const opening=openNativeDjvu(value);await rangeWaiting;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(instances.length,1);
  assert.deepEqual(instances[0].messages.map(message=>message.operation),['prepare'],
    'prepare may overlap Range but must not open source before validation');
  controller.abort();await assert.rejects(opening,{name:'AbortError'});
  assert.equal(rangeCancelled,true);assert.equal(instances[0].terminated,true);
}
{
  let instance,rangeCancelled=false,rangeStarted;
  const rangeWaiting=new Promise(resolve=>rangeStarted=resolve);
  globalThis.Worker=class {
    constructor(){instance=this;this.terminated=false;}
    postMessage(message){if(message.operation==='prepare')setTimeout(()=>this.onmessage({data:{id:message.id,ok:false,error:'DJVU_WORKER_FAILED'}}),0);}
    terminate(){this.terminated=true;}
  };
  const value=context(async()=>{throw Error('unexpected full source')});
  Object.assign(value,{sourceUrl:url.replace('a'.repeat(40),'main'),readerDownloadApiUrl:x=>x,
    readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async(actual,timeout,options)=>actual.startsWith('/api/reader-source-revision')
      ? new Response(JSON.stringify({revision:'a'.repeat(40),url}))
      : new Promise((resolve,reject)=>{
          options.signal.addEventListener('abort',()=>{rangeCancelled=true;reject(options.signal.reason)},{once:true});rangeStarted();
        })});
  const opening=openNativeDjvu(value);await rangeWaiting;
  await assert.rejects(opening,/DJVU_WORKER_FAILED/);
  assert.equal(rangeCancelled,true);assert.equal(instance.terminated,true);
}
console.log('DjVu dataset source size, hash, cancellation and map-failure guards passed');

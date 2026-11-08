import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {openDirectDjvu, openNativeDjvu} from '../../../static/reader/pdf/reader-djvu-loader.mjs';
import {resolveDjvuSource} from '../../../static/reader/pdf/reader-djvu-identity.mjs';

Object.defineProperty(globalThis, 'crypto', {configurable: true, value: webcrypto});
globalThis.matchMedia = () => ({matches: false});
globalThis.VoiceOfMLReaderSecurity = {
  LIMITS: {documentBytes: 512 * 1024 * 1024, manifestBytes: 1024 * 1024},
  async readBytes(response, limit) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('READER_RESOURCE_LIMIT');
    return bytes;
  },
  async readText(response, limit) { return new TextDecoder().decode(await this.readBytes(response,limit)); },
  validatePdfOcrManifest(value) { if (!value || typeof value.source_sha256 !== 'string') throw Error('PDF_OCR_MANIFEST_INVALID'); return value; }
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
// Whole-original historical OCR is attached only after source hashing. A
// malformed or mismatched manifest must not block the native original or leak
// stale OCR into the Reader. All bytes and workers below are synthetic.
{
  let started=0,terminated=0;const opens=[];
  globalThis.Worker=class {
    constructor(){started++;}
    postMessage(message){opens.push(message.operation);if(message.operation==='open')
      queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,count:1}}));}
    terminate(){terminated++;}
  };
  const make=(manifestValue,controller=new AbortController())=>{
    const tracked=[],value=context(async()=>new Response(bytes),controller);
    Object.assign(value,{sourceUrl:url,ocrManifestUrl:'/historical-ocr',pdfOcrManifest:null,
      READER_PROXY_TIMEOUT_MS:1000,readerDownloadApiUrl:x=>x,readerContentUrl:x=>x,
      fetchWithReaderTimeout:async()=>{throw Error('unexpected revision fetch')},
      readPdfOcrJson:async()=>manifestValue,trackReaderResource:cleanup=>tracked.push(cleanup)});
    return {value,tracked};
  };
  const good=make({source_sha256:sha256});const document=await openNativeDjvu(good.value);
  assert.equal(document.sourceSha256,sha256);assert.equal(good.value.pdfOcrManifest.source_sha256,sha256);
  assert.equal(good.tracked.length,1);good.tracked[0]();assert.equal(terminated,1);
  const warnings=[],oldWarn=console.warn;console.warn=(...args)=>warnings.push(args);
  try {
    for(const candidate of [{source_sha256:'b'.repeat(64)},null]) {
      const invalid=make(candidate),fallback=await openNativeDjvu(invalid.value);
      assert.equal(fallback.sourceSha256,sha256);assert.equal(invalid.value.ocrManifestUrl,'');
      assert.equal(invalid.value.pdfOcrManifest,null);invalid.tracked[0]();
    }
    assert.equal(warnings.length,2);
  } finally {console.warn=oldWarn;}
  const controller=new AbortController(),aborted=make(null,controller);
  aborted.value.readPdfOcrJson=async()=>{controller.abort();throw controller.signal.reason};
  await assert.rejects(openNativeDjvu(aborted.value),{name:'AbortError'});
  assert.equal(aborted.value.ocrManifestUrl,'/historical-ocr','cancel must not erase retained OCR metadata');
  assert.equal(started,3,'aborted OCR check must not start an additional worker');
  assert.deepEqual(opens,['open','open','open']);
}
// Direct immutable primaries bind exact length, SHA-256 and page-map completion
// before the only transfer of the checked original bytes to the decoder.
{
  let worker,cleanup,transferred;
  globalThis.Worker=class {
    constructor(){worker=this;this.terminated=false;}
    postMessage(message,transfer){assert.equal(message.operation,'open');transferred=transfer;
      assert.ok(message.bytes instanceof ArrayBuffer);queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,count:1}}));}
    terminate(){this.terminated=true;}
  };
  const value=context(async()=>new Response(bytes));value.trackReaderResource=fn=>cleanup=fn;
  const map={pages:[{page:1,width:2.4,height:4.8,rotation:0,djvu:{pixels:[10,20],dpi:300}}]};
  const document=await openDirectDjvu(value,manifest,Promise.resolve(map));
  assert.equal(document.numPages,1);assert.equal(transferred.length,1);
  cleanup();assert.equal(worker.terminated,true);
  const bad=context(async()=>new Response('',{status:503}));
  await assert.rejects(openDirectDjvu(bad,manifest,Promise.resolve(map)),/DJVU_SOURCE_HTTP_503/);
  let failedCleanup;const badMap=context(async()=>new Response(bytes));badMap.trackReaderResource=fn=>failedCleanup=fn;
  await assert.rejects(openDirectDjvu(badMap,manifest,Promise.resolve({pages:[]})),/DJVU_PAGE_MAP_MISMATCH/);
  assert.equal(failedCleanup,undefined);assert.equal(worker.terminated,true);
}
// Lazy outline may read the complete original only at the same strong ETag,
// encoding and declared length as the range-backed document.
{
  for(const scenario of ['valid','changed','encoded','bad-length','short','cancel','cancel-throws']) {
    let workersStarted=0,workersClosed=0,reads=0,outlineRead=0;
    globalThis.Worker=class {
      constructor(){workersStarted++;}
      postMessage(message){
        let reply;
        if(message.operation==='prepare')reply={id:message.id,ok:true};
        else if(message.operation==='open-range')reply={id:message.id,ok:true,count:1};
        else if(message.operation==='outline')reply=workersStarted===1
          ? {id:message.id,ok:false,error:'DJVU_LAZY_OUTLINE_UNCERTAIN'}
          : {id:message.id,ok:true,entries:[{title:'verified',page:1,depth:0}]};
        else if(message.operation==='open')reply={id:message.id,ok:true,count:1};
        if(reply)queueMicrotask(()=>this.onmessage({data:reply}));
      }
      terminate(){workersClosed++;}
    };
    const controller=new AbortController(),value=context(async()=>{
      outlineRead++;
      const headers={'ETag':scenario==='changed'?'"different"':'"stable"'};
      if(scenario==='encoded')headers['Content-Encoding']='gzip';
      if(scenario==='bad-length')headers['Content-Length']='999';
      const body=scenario==='short'?bytes.slice(0,-1):bytes;
      if(scenario==='cancel')controller.abort();
      if(scenario==='cancel-throws') {
        headers.ETag='"different"';
        return new Response(new ReadableStream({cancel(){throw Error('stream already closed')}}),{status:200,headers});
      }
      return new Response(body,{status:200,headers});
    },controller);
    Object.assign(value,{sourceUrl:url,readerDownloadApiUrl:x=>x,readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
      fetchWithReaderTimeout:async()=>{reads++;return new Response(bytes,{status:206,headers:{'ETag':'"stable"',
        'Content-Range':`bytes 0-${bytes.length-1}/${bytes.length}`,'Content-Length':String(bytes.length)}})},
      trackReaderResource(){}});
    const document=await openNativeDjvu(value);
    if(scenario==='valid') {
      const outline=await document.getOutline();assert.equal(outline[0].title,'verified');assert.equal(workersStarted,2);
      assert.equal(workersClosed,1,'fallback worker is destroyed after its outline is read');
    } else {
      await assert.rejects(document.getOutline(),scenario==='cancel'?{name:'AbortError'}:/DJVU_SOURCE_CHANGED/);
      assert.equal(workersStarted,1,'unverified or cancelled complete original must never reach another worker');
    }
    document.destroy();assert.equal(workersClosed,workersStarted);assert.equal(reads,1);assert.equal(outlineRead,1);
  }
}
// A native Range session shares the exact verified first window with the
// decoder, forwards range bytes without full download, and owns cleanup.
{
  let worker,cleanup,fullReads=0,rangeReads=0;
  globalThis.Worker=class {
    constructor(){worker=this;this.terminated=false;}
    postMessage(message){
      if(message.operation==='prepare')queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true}}));
      else if(message.operation==='open-range')queueMicrotask(()=>this.onmessage({data:{id:message.id,operation:'range',rangeId:1,offset:0,length:8}}));
      else if(message.operation==='range-result'){
        assert.equal(message.ok,true);assert.deepEqual([...new Uint8Array(message.bytes)],[...bytes.slice(0,8)]);
        queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,count:1}}));
      }
    }
    terminate(){this.terminated=true;}
  };
  const value=context(async()=>{fullReads++;throw Error('must not use full source')});
  Object.assign(value,{sourceUrl:url,ocrManifestUrl:'',readerDownloadApiUrl:x=>x,readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async()=>{rangeReads++;return new Response(bytes,{status:206,headers:{'ETag':'"stable"',
      'Content-Range':`bytes 0-${bytes.length-1}/${bytes.length}`,'Content-Length':String(bytes.length)}})},
    trackReaderResource:fn=>cleanup=fn});
  const document=await openNativeDjvu(value);assert.equal(document.numPages,1);
  assert.equal(rangeReads,1);assert.equal(fullReads,0);cleanup();assert.equal(worker.terminated,true);
}
// Unsupported lazy metadata may use the complete original, while corrupt
// transport/worker failures never silently reach the full-source path.
{
  for(const [code,allow] of [['DJVU_LAZY_UNSUPPORTED',true],['DJVU_LAZY_METADATA_UNSUPPORTED',true],['DJVU_WORKER_FAILED',false]]) {
    let workerCount=0,closed=0,fullReads=0;
    globalThis.Worker=class {
      constructor(){workerCount++;}
      postMessage(message){let reply;
        if(message.operation==='prepare')reply={id:message.id,ok:true};
        else if(message.operation==='open-range')reply={id:message.id,ok:false,error:code};
        else if(message.operation==='open')reply={id:message.id,ok:true,count:1};
        if(reply)queueMicrotask(()=>this.onmessage({data:reply}));
      }
      terminate(){closed++;}
    };
    const value=context(async()=>{fullReads++;return new Response(bytes)});
    Object.assign(value,{sourceUrl:url,ocrManifestUrl:'',readerDownloadApiUrl:x=>x,readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
      fetchWithReaderTimeout:async()=>new Response(bytes,{status:206,headers:{'ETag':'"stable"',
        'Content-Range':`bytes 0-${bytes.length-1}/${bytes.length}`,'Content-Length':String(bytes.length)}}),trackReaderResource(){}});
    if(allow){const doc=await openNativeDjvu(value);assert.equal(doc.sourceSha256,sha256);doc.destroy();assert.equal(fullReads,1);assert.equal(workerCount,2);}
    else {await assert.rejects(openNativeDjvu(value),new RegExp(code));assert.equal(fullReads,0);assert.equal(workerCount,1);}
    assert.equal(closed,workerCount);
  }
}
{
  let workersStarted=0,sourceReads=0;
  globalThis.Worker=class {constructor(){workersStarted++}postMessage(message){if(message.operation==='prepare')
    queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true}}))}terminate(){}};
  const value=context(async()=>{sourceReads++;return new Response(bytes)});
  Object.assign(value,{sourceUrl:url,ocrManifestUrl:'',readerDownloadApiUrl:x=>x,readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async()=>new Response(bytes,{status:206,headers:{'ETag':'"stable"',
      'Content-Range':`bytes 1-${bytes.length-1}/${bytes.length}`}}),trackReaderResource(){}});
  await assert.rejects(openNativeDjvu(value),/DJVU_RANGE_INVALID/);assert.equal(sourceReads,0);
  assert.equal(workersStarted,1,'malformed range cancels the already prewarmed decoder');
}
{
  // A later range failure is authoritative even when the worker reports an
  // otherwise fallback-eligible lazy-format error; it must not download a
  // different complete original after transport identity was lost.
  let closed=0,fullReads=0;
  globalThis.Worker=class {
    postMessage(message){
      if(message.operation==='prepare')queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true}}));
      else if(message.operation==='open-range')queueMicrotask(()=>this.onmessage({data:{id:message.id,operation:'range',rangeId:1,offset:1024*1024,length:1}}));
      else if(message.operation==='range-result')queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:false,error:'DJVU_LAZY_UNSUPPORTED'}}));
    }
    terminate(){closed++;}
  };
  const value=context(async()=>{fullReads++;throw Error('must not fetch full source')});
  Object.assign(value,{sourceUrl:url,ocrManifestUrl:'',readerDownloadApiUrl:x=>x,readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async(actual,timeout,options)=>{
      const range=options.headers.Range;
      if(range.startsWith('bytes=0-'))return new Response(new Uint8Array(1024*1024),{status:206,headers:{'ETag':'"stable"',
        'Content-Range':'bytes 0-1048575/1048577','Content-Length':'1048576'}});
      return new Response(new Uint8Array(1),{status:206,headers:{'ETag':'"changed"',
        'Content-Range':'bytes 1048576-1048576/1048577','Content-Length':'1'}});
    },trackReaderResource(){}});
  await assert.rejects(openNativeDjvu(value),/DJVU_SOURCE_CHANGED/);assert.equal(fullReads,0);assert.equal(closed,1);
}
// A decoder asking for bytes while it is still preparing must not be sent
// unvalidated source bytes, nor leave the initial Range fetch running.
{
  let started,rangeAborted=false,closed=0;
  const waiting=new Promise(resolve=>started=resolve);
  globalThis.Worker=class {
    postMessage(message){if(message.operation==='prepare')setTimeout(()=>this.onmessage({data:{id:message.id,
      operation:'range',rangeId:1,offset:0,length:8}}),0)}
    terminate(){closed++;}
  };
  const value=context(async()=>{throw Error('unexpected full source')});
  Object.assign(value,{sourceUrl:url,readerDownloadApiUrl:x=>x,readerContentUrl:x=>x,READER_PROXY_TIMEOUT_MS:1000,
    fetchWithReaderTimeout:async(actual,timeout,options)=>new Promise((resolve,reject)=>{
      options.signal.addEventListener('abort',()=>{rangeAborted=true;reject(options.signal.reason)},{once:true});started();
    }),trackReaderResource(){}});
  const pending=openNativeDjvu(value);await waiting;
  await assert.rejects(pending,/DJVU_WORKER_PROTOCOL/);assert.equal(rangeAborted,true);assert.equal(closed,1);
}
// Source identity is independently fail-closed before range/full-source I/O.
{
  const revision='a'.repeat(40),source=url.replace(revision,'main');
  const make=(reply,status=200)=>{
    const calls=[];
    return {calls,context:{sourceUrl:source,READER_PROXY_TIMEOUT_MS:7654,readerDownloadApiUrl:path=>'/proxy'+path,
      fetchWithReaderTimeout:async(endpoint,timeout,options)=>{calls.push({endpoint,timeout,signal:options.signal});
        return new Response(typeof reply==='string'?reply:JSON.stringify(reply),{status})}}};
  };
  const signal=new AbortController().signal;
  const good=make({url,revision});const resolved=await resolveDjvuSource(good.context,source,signal);
  assert.equal(resolved.href,url);assert.equal(good.calls.length,1);assert.equal(good.calls[0].timeout,7654);
  assert.strictEqual(good.calls[0].signal,signal);assert.ok(good.calls[0].endpoint.startsWith('/proxy/api/reader-source-revision?url='));
  const failed=make({},503);await assert.rejects(resolveDjvuSource(failed.context,source,signal),/DJVU_SOURCE_REVISION_HTTP_503/);
  const malformed=make('{');await assert.rejects(resolveDjvuSource(malformed.context,source,signal),SyntaxError);
  for(const reply of [null,{}, {url:5,revision}, {url,revision:5}, {url,revision:'b'.repeat(40)},
    {url:url.replace('huggingface.co','evil.example'),revision}, {url:url+'?download=1',revision},
    {url:url+'#fragment',revision}, {url:url.replace('/book.djvu','/other.djvu'),revision},
    {url:'https://u:p@huggingface.co'+new URL(url).pathname,revision}]) {
    const check=make(reply);await assert.rejects(resolveDjvuSource(check.context,source,signal),/DJVU_SOURCE_REVISION_INVALID/);
  }
  for(const badSource of [source+'?download=1',source+'#fragment',
    source.replace('https://','https://u:p@'),source.replace('huggingface.co','evil.example')]) {
    const check=make({url,revision});await assert.rejects(resolveDjvuSource(check.context,badSource,signal),/DJVU_SOURCE_REVISION_INVALID/);
  }
  const mirrored=make({url,revision});assert.equal((await resolveDjvuSource(mirrored.context,source.replace('huggingface.co','hf-mirror.com'),signal)).href,url);
  const raw=make({url,revision});assert.equal((await resolveDjvuSource(raw.context,source.replace('/resolve/','/raw/'),signal)).href,url);
  const fast=make({url,revision});assert.equal((await resolveDjvuSource(fast.context,url,signal)).href,url);assert.equal(fast.calls.length,0);
  for(const suffix of ['bad%2Fbook.djvu','bad%5Cbook.djvu','bad%ZZbook.djvu','bad%2523book.djvu','bad%3Fbook.djvu',
    'bad%23book.djvu','bad%00book.djvu','folder//book.djvu']) {
    const bad=url.replace('book.djvu',suffix);const check=make({url,revision});
    await resolveDjvuSource(check.context,bad,signal).catch(()=>{});
    assert.equal(check.calls.length,1,`unsafe fast-path filename ${suffix} must use server validation`);
  }
  // WHATWG URL normalizes literal dot segments before this policy sees them.
  // The resulting pinned URL is the same normalized document, not a raw path.
  for (const suffix of ['folder/./book.djvu','folder/../book.djvu']) {
    const normalized=url.replace('book.djvu',suffix);const check=make({url,revision});
    assert.equal((await resolveDjvuSource(check.context,normalized,signal)).href,new URL(normalized).href);
    assert.equal(check.calls.length,0);
  }
  const wrongRevision=make({url:url.replace(revision,'b'.repeat(40)),revision:'b'.repeat(40)});
  await assert.rejects(resolveDjvuSource(wrongRevision.context,url.replace('huggingface.co','hf-mirror.com'),signal),/DJVU_SOURCE_REVISION_INVALID/);
  const relative=make({url:'/not-an-absolute-url',revision});await assert.rejects(resolveDjvuSource(relative.context,source,signal),TypeError);
  const offline=make({url,revision});offline.context.fetchWithReaderTimeout=async()=>{throw new DOMException('cancelled','AbortError')};
  await assert.rejects(resolveDjvuSource(offline.context,source,signal),{name:'AbortError'});
}
console.log('DjVu dataset source size, hash, cancellation and map-failure guards passed');

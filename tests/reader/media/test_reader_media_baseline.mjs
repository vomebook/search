// Synthetic contracts preserve the host's dynamic inputs and operation order.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createReaderMediaFormat} from '../../../static/reader/formats/reader-media-format.mjs';
import {createReaderDocumentLoader} from '../../../static/reader/core/reader-document-loader.mjs';
const fixture = () => {
  const context = {readerAbortController:new AbortController(), content:{children:[],appendChild(node){this.children.push(node);}},
    status:{textContent:''},documentState:{title:'Synthetic',restorationReady:false},mediaPanel:{querySelector:()=>({})},
    assertReaderActive(){if(this.readerAbortController.signal.aborted)throw new Error('aborted');},
    markReaderContentReady(){this.ready=(this.ready||0)+1;}, scheduleMarkerSync(){},saveProgress(){},
    trackReaderResource(cleanup){this.cleanup=cleanup;return()=>{};},readerAbortError:()=>new DOMException('cancelled','AbortError'),
    fail(){},validSource:()=>false, resolvedReaderData:null,extension:'wav',sourceUrl:'https://test/source',
    downloadUrl:'https://test/source',contentUrl:'https://test/source', READER_PROXY_TIMEOUT_MS:20000,
    awaitReader:promise=>Promise.resolve(promise)};
  Object.assign(context,createReaderMediaFormat(context));return context;
};

test('time formatting preserves nonnumeric and coercion behavior', () => {
  const {formatMediaTime:f}=fixture();
  for (const [input, expected] of [[0,'00:00'],[59.9,'00:59'],[61,'01:01'],[3661,'01:01:01'],
    [-1,'00:00'],[Infinity,'00:00'],[NaN,'00:00'],['1','00:00'],[null,'00:00']]) assert.equal(f(input),expected);
  assert.equal(f(Symbol('seconds')),'00:00');
});

test('image readiness and errors retain ordering', () => {
  const context=fixture(), image={};
  context.renderImageDocument(image);
  assert.deepEqual(context.content.children,[image]);assert.equal(context.ready,1);assert.equal(context.status.textContent,'图片');
  context.readerAbortController.abort();assert.throws(()=>context.renderImageDocument({}),/aborted/);
  assert.equal(context.content.children.length,1);
});

test('media mode reaches document.createElement unchanged before element work', async () => {
  const context=fixture(), old=globalThis.document, calls=[], marker=new Error('factory');
  globalThis.document={createElement(value){calls.push(value);throw marker;}};
  try {
    const value={toString(){throw Error('unexpected conversion');}};
    await assert.rejects(context.renderMedia(value),error=>error===marker);
    assert.strictEqual(calls[0],value);
  } finally {globalThis.document=old;}
});

test('Flash loader overlaps the bounded body and engine without rendering early', async () => {
  const context=fixture(), events=[], previous=globalThis.VoiceOfMLReaderSecurity;
  Object.assign(context,createReaderDocumentLoader(context));
  context.RUFFLE_URL='/ruffle.js';
  globalThis.VoiceOfMLReaderSecurity={LIMITS:{documentBytes:3},async readBytes(response,limit){
    events.push(['read',limit]);
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.length>limit)throw new Error('READER_RESOURCE_LIMIT');
    events.push(['body']);return bytes;
  }};
  try {
    for(const engineFirst of [false,true]) {
      events.length=0;
      let releaseEngine,releaseBody,completed=false;
      context.loadScript=url=>{events.push(['script',url]);return new Promise(resolve=>releaseEngine=resolve);};
      context.fetchReaderResponse=async()=>{events.push(['fetch']);return new Response(new ReadableStream({start(stream){
        releaseBody=()=>{stream.enqueue(Uint8Array.of(0,2,255));stream.close();};
      }}));};
      const pending=context.loadSwfDocument().then(bytes=>{completed=true;return bytes;});
      await new Promise(resolve=>setImmediate(resolve));
      assert.deepEqual(events,[['script','/ruffle.js'],['fetch'],['read',3]]);
      (engineFirst?releaseEngine:releaseBody)();
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(completed,false);
      (engineFirst?releaseBody:releaseEngine)();
      assert.deepEqual(await pending,Uint8Array.of(0,2,255));
      assert.equal(context.content.children.length,0);
    }
    const failed=new Error('engine unavailable');
    context.loadScript=()=>Promise.reject(failed);
    context.fetchReaderResponse=()=>new Promise(()=>{});
    await assert.rejects(context.loadSwfDocument(),error=>error===failed);
    context.loadScript=async()=>{};
    context.fetchReaderResponse=async()=>new Response(Uint8Array.of(0,1,2,3));
    await assert.rejects(context.loadSwfDocument(),/READER_RESOURCE_LIMIT/);
  } finally {globalThis.VoiceOfMLReaderSecurity=previous;}
});

test('Flash hands Ruffle a view of the bounded buffer without copying it before decode', async () => {
  const context=fixture(), old=globalThis.window, events=[];
  // Ruffle 0.7.1 calls new Uint8Array(data) before handing the view to WASM.
  globalThis.window={RufflePlayer:{newest:()=>({version:'0.7.1+2026-10-07',createPlayer:()=>({style:{},setAttribute(){},ruffle:()=>({load:async ({data})=>{
    events.push('load');
    const decoded=new Uint8Array(data);
    assert.deepEqual([...decoded],[70,87,83]);
    events.push(decoded.buffer===bytes.buffer?'shared buffer':'cloned buffer');
  }})})})}};
  const bytes=Uint8Array.of(70,87,83);
  context.RUFFLE_URL='/ruffle.js';
  context.loadScript=async()=>{};
  context.prepareReaderDocument=()=>({response:Promise.resolve(new Response(bytes)),engines:Promise.resolve()});
  context.readPreparedBytes=async()=>{events.push('bounded body complete');return bytes;};
  try {
    await context.renderSwf(await context.loadSwfDocument());
    assert.deepEqual(events,['bounded body complete','load','shared buffer']);
    assert.equal(context.ready,1);
  } finally {globalThis.window=old;}
});

test('Flash renderer forwards the original data and reports unavailable engine', async () => {
  const context=fixture(), old=globalThis.window, values=[];
  const factory={createPlayer:()=>({style:{},setAttribute(){},ruffle:()=>({load:async value=>values.push(value.data)})})};
  globalThis.window={RufflePlayer:{newest:()=>factory}};
  try {
    const bytes=Uint8Array.of(0,70,87,83,0);
    await context.renderSwf(bytes);
    assert.strictEqual(values.at(-1),bytes);
    factory.version='0.8.0+future';
    await context.renderSwf(bytes);
    assert.strictEqual(values.at(-1),bytes);
    factory.version='0.7.1+2026-10-07';
    const unchanged=[{custom:'uncoerced'},bytes.subarray(1,4),bytes.subarray(0,4),new Uint8Array(new SharedArrayBuffer(3))];
    for(const data of unchanged) {
      await context.renderSwf(data);
      assert.strictEqual(values.at(-1),data);
    }
    assert.equal(context.ready,unchanged.length+2);assert.equal(context.status.textContent,'Flash 内容');
    globalThis.window={};await assert.rejects(context.renderSwf(bytes),{code:'READER_SWF_ENGINE'});
  } finally {globalThis.window=old;}
});

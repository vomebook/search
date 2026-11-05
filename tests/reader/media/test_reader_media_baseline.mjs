// Synthetic contracts preserve the host's dynamic inputs and operation order.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createReaderMediaFormat} from '../../../static/reader/formats/reader-media-format.mjs';
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

test('Flash loader preserves byte values and script-before-fetch sequencing', async () => {
  const context=fixture(),events=[];context.RUFFLE_URL='/ruffle.js';
  context.loadScript=async url=>events.push(['script',url]);
  context.fetchReaderResponse=async()=>{events.push(['fetch']);return new Response(Uint8Array.of(0,2,255));};
  assert.deepEqual(await context.loadSwfDocument(),Uint8Array.of(0,2,255));
  assert.deepEqual(events,[['script','/ruffle.js'],['fetch']]);
});

test('Flash renderer forwards the original data and reports unavailable engine', async () => {
  const context=fixture(), old=globalThis.window, values=[];
  globalThis.window={RufflePlayer:{newest:()=>({createPlayer:()=>({style:{},setAttribute(){},ruffle:()=>({load:async value=>values.push(value.data)})})})}};
  try {
    const data={custom:'uncoerced'};await context.renderSwf(data);assert.strictEqual(values[0],data);
    assert.equal(context.ready,1);assert.equal(context.status.textContent,'Flash 内容');
    globalThis.window={};await assert.rejects(context.renderSwf(data),{code:'READER_SWF_ENGINE'});
  } finally {globalThis.window=old;}
});

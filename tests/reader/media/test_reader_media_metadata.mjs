// Behavioral contracts use synthetic media elements and locally controlled timers.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createReaderMediaFormat} from '../../../static/reader/formats/reader-media-format.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeMedia extends EventTarget {
  constructor(mode) {
    super();this.tagName=mode;this.src='';this.currentTime=4;this.duration=10;this.paused=true;
    this.playbackRate=1;this.readyState=0;this.error=null;this.loads=0;this.style={};this.attrs={};
  }
  setAttribute(name,value){this.attrs[name]=value;}
  load(){this.loads++;}
  play(){this.paused=false;return Promise.resolve();}
}

function fixture() {
  const previous={document:globalThis.document,contract:globalThis.VoiceOfMLReader};
  let media;const resources=new Set(),events=[],panel={textContent:''};
  globalThis.document={createElement(mode){media=new FakeMedia(mode);return media;}};
  globalThis.VoiceOfMLReader={capability:()=>({mode:'audio'})};
  const owner=new AbortController();
  const context={readerAbortController:owner,documentState:{title:'Book',restorationReady:true},
    content:{appendChild(node){events.push(['append',node]);}},status:{textContent:''},
    mediaPanel:{querySelector:()=>panel},sourceUrl:'https://test/original',downloadUrl:'https://test/original',
    contentUrl:'https://test/proxy',extension:'wav',resolvedReaderData:null,READER_PROXY_TIMEOUT_MS:20000,
    assertReaderActive(){owner.signal.throwIfAborted();},markReaderContentReady(){events.push('ready');},
    scheduleMarkerSync(){events.push('marker');},saveProgress(){events.push('save');},
    trackReaderResource(fn){resources.add(fn);return()=>resources.delete(fn);},readerAbortError:()=>new DOMException('cancelled','AbortError'),
    validSource:url=>url.startsWith('https://'),fail:(...args)=>events.push(['fail',...args]),
    awaitReader:promise=>Promise.resolve(promise)};
  Object.assign(context,createReaderMediaFormat(context));
  return {context,owner,resources,events,panel,get media(){return media;},restore(){
    for(const cleanup of resources)cleanup();globalThis.document=previous.document;globalThis.VoiceOfMLReader=previous.contract;
  }};
}

test('media readiness waits for metadata and reports player timing', async () => {
  const f=fixture();try {
    let done=false;const promise=f.context.renderMedia('audio').then(()=>{done=true;});await tick();
    assert.equal(done,false);assert.equal(f.media.src,'https://test/proxy');assert.equal(f.media.preload,'metadata');
    f.media.readyState=1;f.media.dispatchEvent(new Event('loadedmetadata'));await promise;
    assert.equal(done,true);assert.equal(f.context.status.textContent,'音频');assert.equal(f.panel.textContent,'00:04 / 00:10');
    assert.ok(f.events.includes('ready'));assert.ok(f.events.includes('marker'));
    const before=f.events.filter(value=>value==='save').length;
    for(const event of ['pause','ended','seeked'])f.media.dispatchEvent(new Event(event));
    assert.equal(f.events.filter(value=>value==='save').length,before+3);
  } finally {f.restore();}
});

test('media source retries only once and restores position on metadata', async () => {
  const f=fixture();try {
    const promise=f.context.renderMedia('audio');await tick();
    f.media.dispatchEvent(new Event('error'));assert.equal(f.media.src,'https://test/original');assert.equal(f.media.loads,1);
    f.media.currentTime=0;f.media.readyState=1;f.media.dispatchEvent(new Event('loadedmetadata'));await promise;
    assert.equal(f.media.currentTime,4);assert.equal(f.media._readerSourceRetry,false);
    f.media.dispatchEvent(new Event('error'));assert.equal(f.media.loads,1);
    assert.ok(f.events.some(value=>Array.isArray(value)&&value[0]==='fail'&&value[2]==='READER_MEDIA'));
  } finally {f.restore();}
});

test('resource cleanup rejects pending metadata and removes listeners', async () => {
  const f=fixture();try {
    const promise=f.context.renderMedia('audio');await tick();
    assert.equal(f.resources.size,1);for(const cleanup of f.resources)cleanup();
    await assert.rejects(promise,{name:'AbortError'});f.media.dispatchEvent(new Event('error'));
    assert.equal(f.media.loads,0);assert.ok(!f.events.some(value=>Array.isArray(value)&&value[0]==='fail'));
  } finally {f.restore();}
});

test('metadata hard deadline rejects and exposes media retry without another source', async () => {
  const f=fixture(), originalSet=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
  const callbacks=new Map();let next=1;
  globalThis.setTimeout=(callback,delay)=>{const id=next++;callbacks.set(id,{callback,delay});return id;};
  globalThis.clearTimeout=id=>callbacks.delete(id);
  try {
    const promise=f.context.renderMedia('audio');
    assert.deepEqual([...callbacks.values()].map(item=>item.delay).sort((a,b)=>a-b),[15000,20000]);
    const deadline=[...callbacks.values()].find(item=>item.delay===20000);deadline.callback();
    await assert.rejects(promise,{name:'AbortError'});
    assert.ok(f.events.some(value=>Array.isArray(value)&&value[0]==='fail'&&value[2]==='READER_MEDIA'));
    assert.equal(f.media.loads,0);assert.equal(callbacks.size,0);
  } finally {f.restore();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('idle deadline retries original once and rearms without changing hard deadline', async () => {
  const f=fixture(), originalSet=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
  const callbacks=new Map();let next=1;
  globalThis.setTimeout=(callback,delay)=>{const id=next++;callbacks.set(id,{callback,delay});return id;};
  globalThis.clearTimeout=id=>callbacks.delete(id);
  try {
    const promise=f.context.renderMedia('audio');
    const hard=[...callbacks].find(([,item])=>item.delay===20000)[0];
    const idle=[...callbacks].find(([,item])=>item.delay===15000)[1];idle.callback();
    assert.equal(f.media.src,'https://test/original');assert.equal(f.media.loads,1);
    assert.ok(callbacks.has(hard));assert.equal([...callbacks.values()].filter(item=>item.delay===20000).length,1);
    f.media.readyState=1;f.media.dispatchEvent(new Event('loadedmetadata'));await promise;
    assert.equal(callbacks.size,0);
  } finally {f.restore();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('video setup keeps native controls and inline playback until metadata arrives', async () => {
  const f=fixture();try {
    const promise=f.context.renderMedia('video');await tick();
    assert.equal(f.media.tagName,'video');assert.equal(f.media.className,'reader-video');
    assert.equal(f.media.controls,true);assert.equal(f.media.playsInline,true);
    assert.equal(f.media.attrs['aria-label'],'Book 视频');
    f.media.readyState=1;f.media.dispatchEvent(new Event('loadedmetadata'));await promise;
    assert.equal(f.context.status.textContent,'视频');
  } finally {f.restore();}
});

test('capability lookup receives uncoerced original extension metadata', async () => {
  const f=fixture();try {
    const extension={toString(){throw new Error('unexpected conversion');}};
    let seen;f.context.resolvedReaderData={original_extension:extension};
    globalThis.VoiceOfMLReader={capability(value){seen=value;return {mode:'audio'};}};
    const promise=f.context.renderMedia('audio');await tick();assert.strictEqual(seen,extension);
    f.media.readyState=1;f.media.dispatchEvent(new Event('loadedmetadata'));await promise;
  } finally {f.restore();}
});

test('codec error reports a recoverable failure without retrying the same source', async () => {
  const f=fixture();try {
    f.context.sourceUrl=f.context.downloadUrl=f.context.contentUrl;
    const promise=f.context.renderMedia('audio');await tick();
    f.media.error={code:3};f.media.dispatchEvent(new Event('error'));
    await assert.rejects(promise,{name:'AbortError'});assert.equal(f.media.loads,0);
    const failure=f.events.find(value=>Array.isArray(value)&&value[0]==='fail');
    assert.equal(failure[2],'READER_MEDIA');assert.match(failure[1],/浏览器可能不支持其编码/);
  } finally {f.restore();}
});

test('retry restores playing state and tolerates a rejected play promise', async () => {
  const f=fixture();try {
    const promise=f.context.renderMedia('audio');await tick();
    let calls=0;f.media.paused=false;f.media.playbackRate=1.5;
    f.media.play=()=>{calls++;return Promise.reject(new Error('autoplay blocked'));};
    f.media.dispatchEvent(new Event('error'));
    f.media.currentTime=0;f.media.duration=2;f.media.playbackRate=1;
    f.media.readyState=1;f.media.dispatchEvent(new Event('loadedmetadata'));await promise;
    await tick();assert.equal(calls,1);assert.equal(f.media.currentTime,2);assert.equal(f.media.playbackRate,1.5);
  } finally {f.restore();}
});

test('progress extends the idle deadline without extending the hard deadline', async () => {
  const f=fixture(), originalSet=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
  const callbacks=new Map();let next=1;
  globalThis.setTimeout=(callback,delay)=>{const id=next++;callbacks.set(id,{callback,delay});return id;};
  globalThis.clearTimeout=id=>callbacks.delete(id);
  try {
    const promise=f.context.renderMedia('audio');
    const hard=[...callbacks].find(([,item])=>item.delay===20000)[0];
    const first=[...callbacks].find(([,item])=>item.delay===15000)[0];
    f.media.dispatchEvent(new Event('progress'));
    const second=[...callbacks].find(([,item])=>item.delay===15000)[0];
    assert.notEqual(second,first);assert.equal(callbacks.has(first),false);assert.ok(callbacks.has(hard));
    assert.equal(callbacks.size,2);
    f.media.readyState=1;f.media.dispatchEvent(new Event('loadedmetadata'));await promise;
    assert.equal(callbacks.size,0);
  } finally {f.restore();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

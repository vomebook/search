// Behavioral contracts use synthetic media elements and locally controlled timers.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createReaderMediaFormat} from '../../../static/reader/formats/reader-media-format.mjs';
import {createReaderSource} from '../../../static/reader/core/reader-source.mjs';
const sourceUrl = 'https://huggingface.co/datasets/VoiceOfML/VOMEBOOK/resolve/main/audio.mp3';
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeMedia extends EventTarget {
  constructor(mode) {
    super();this.tagName=mode;this.src='';this.currentTime=4;this.duration=10;this.paused=true;
    this.playbackRate=1;this.readyState=0;this.error=null;this.loads=0;this.style={};this.attrs={};
  }
  get src(){return this._src;}
  set src(url){this._src=url ? new URL(url,globalThis.location.href).href : '';}
  setAttribute(name,value){this.attrs[name]=value;}
  load(){this.loads++;}
  play(){this.paused=false;return Promise.resolve();}
}

function fixture() {
  const previous={document:globalThis.document,contract:globalThis.VoiceOfMLReader,location:globalThis.location};
  let media;const resources=new Set(),events=[],panel={textContent:''};
  globalThis.document={createElement(mode){media=new FakeMedia(mode);return media;}};
  globalThis.VoiceOfMLReader={capability:()=>({mode:'audio'})};
  globalThis.location=new URL('https://reader.example.test/search/static/reader.html');
  const {validSource,readerContentUrl}=createReaderSource({}), contentUrl=readerContentUrl(sourceUrl);
  const owner=new AbortController();
  const context={readerAbortController:owner,documentState:{title:'Book',restorationReady:true},
    content:{appendChild(node){events.push(['append',node]);}},status:{textContent:''},
    mediaPanel:{querySelector:()=>panel},sourceUrl,downloadUrl:sourceUrl,
    contentUrl,extension:'wav',resolvedReaderData:null,READER_PROXY_TIMEOUT_MS:20000,
    assertReaderActive(){owner.signal.throwIfAborted();},markReaderContentReady(){events.push('ready');},
    scheduleMarkerSync(){events.push('marker');},saveProgress(){events.push('save');},
    trackReaderResource(fn){resources.add(fn);return()=>resources.delete(fn);},readerAbortError:()=>new DOMException('cancelled','AbortError'),
    validSource,readerContentUrl,fail:(...args)=>events.push(['fail',...args]),
    awaitReader:promise=>Promise.resolve(promise)};
  Object.assign(context,createReaderMediaFormat(context));
  const proxyHref=new URL(contentUrl,globalThis.location.href).href;
  return {context,owner,resources,events,panel,proxyHref,get media(){return media;},restore(){
    for(const cleanup of resources)cleanup();globalThis.document=previous.document;globalThis.VoiceOfMLReader=previous.contract;
    globalThis.location=previous.location;
  }};
}

test('media readiness waits for metadata and reports player timing', async () => {
  const f=fixture();try {
    let done=false;const promise=f.context.renderMedia('audio').then(()=>{done=true;});await tick();
    assert.equal(done,false);assert.equal(f.media.src,f.proxyHref);assert.equal(f.media.preload,'metadata');
    f.media.readyState=1;f.media.dispatchEvent(new Event('loadedmetadata'));await promise;
    assert.equal(done,true);assert.equal(f.context.status.textContent,'音频');assert.equal(f.panel.textContent,'00:04 / 00:10');
    assert.ok(f.events.includes('ready'));assert.ok(f.events.includes('marker'));
    const before=f.events.filter(value=>value==='save').length;
    for(const event of ['pause','ended','seeked'])f.media.dispatchEvent(new Event(event));
    assert.equal(f.events.filter(value=>value==='save').length,before+3);
  } finally {f.restore();}
});

test('stalled proxy retries the proxy instead of the blocked dataset host', async () => {
  for (const variant of ['generated','foreign-proxy','wrong-source','invalid-source']) {
    const f=fixture();try {
      const {context}=f, proxy=new URL(f.proxyHref);
      assert.equal(proxy.origin,'https://voiceofml-search.hf.space');
      assert.equal(proxy.pathname,'/api/reader-content');
      assert.equal(proxy.searchParams.get('url'),sourceUrl);
      assert.equal(context.validSource(sourceUrl),true);
      assert.equal(context.validSource(context.contentUrl),false);
      if(variant==='foreign-proxy')context.contentUrl=`https://elsewhere.test${proxy.pathname}${proxy.search}`;
      if(variant==='wrong-source')context.contentUrl=context.readerContentUrl(sourceUrl.replace('audio.mp3','other.mp3'));
      if(variant==='invalid-source') {
        context.sourceUrl='https://elsewhere.test/audio.mp3';
        context.contentUrl=context.readerContentUrl(context.sourceUrl);
      }
      const promise=context.renderMedia('audio');
      f.media.dispatchEvent(new Event('error'));
      if(variant==='generated') {
        assert.equal(f.media.src,f.proxyHref);
        assert.equal(f.media.loads,1);
        f.media.dispatchEvent(new Event('error'));
      }
      await assert.rejects(promise,{name:'AbortError'});
      assert.equal(f.media.loads,variant==='generated'?1:0);
      assert.ok(f.events.some(value=>Array.isArray(value)&&value[0]==='fail'&&value[2]==='READER_MEDIA'));
    } finally {f.restore();}
  }
});

test('media source retries only once and restores position on metadata', async () => {
  for(const {restorationReady,time,duration,expected} of [
    {restorationReady:true,time:4,duration:10,expected:4},
    {restorationReady:true,time:4,duration:Infinity,expected:4},
    {restorationReady:true,time:NaN,duration:10,expected:0},
    {restorationReady:false,time:4,duration:10,expected:0}
  ]) {
    const f=fixture();try {
      f.context.documentState.restorationReady=restorationReady;
      const promise=f.context.renderMedia('audio');await tick();
      f.media.currentTime=time;f.media.playbackRate=1.5;
      f.media.dispatchEvent(new Event('error'));assert.equal(f.media.src,f.proxyHref);assert.equal(f.media.loads,1);
      f.media.currentTime=0;f.media.duration=duration;f.media.playbackRate=1;
      f.media.dispatchEvent(new Event('timeupdate'));assert.equal(f.panel.textContent,'');
      f.media.readyState=1;f.media.dispatchEvent(new Event('loadedmetadata'));await promise;
      assert.equal(f.media.currentTime,expected);assert.equal(f.media._readerSourceRetry,false);
      assert.equal(f.media.playbackRate,restorationReady?1.5:1);assert.equal(f.media.paused,true);
      assert.equal(f.events.filter(value=>value==='ready').length,1);
      f.media.dispatchEvent(new Event('error'));assert.equal(f.media.loads,1);
      assert.ok(f.events.some(value=>Array.isArray(value)&&value[0]==='fail'&&value[2]==='READER_MEDIA'));
    } finally {f.restore();}
  }
});

test('resource cleanup rejects pending metadata and removes listeners', async () => {
  const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
  const callbacks=new Map();let next=1;
  globalThis.setTimeout=(callback,delay)=>{const id=next++;callbacks.set(id,{callback,delay});return id;};
  globalThis.clearTimeout=id=>callbacks.delete(id);
  try {
    for(const abort of [false,true]) {
      const f=fixture();try {
        const promise=f.context.renderMedia('audio');await tick();
        assert.equal(f.resources.size,1);assert.equal(callbacks.size,2);
        const idle=[...callbacks.values()].find(item=>item.delay===15000);
        if(abort) {
          f.owner.abort();
          const before=[...f.events];
          f.media.dispatchEvent(new Event('error'));
          f.media.dispatchEvent(new Event('timeupdate'));
          [...callbacks.values()].find(item=>item.delay===20000).callback();
          assert.deepEqual(f.events,before);assert.equal(f.panel.textContent,'');
          assert.equal(f.media.loads,0);
        }
        for(const cleanup of f.resources){cleanup();cleanup();}
        await assert.rejects(promise,{name:'AbortError'});assert.equal(callbacks.size,0);
        // A stale callback and subsequent events must not restart disposed media.
        if(abort) {
          const before=[...f.events];
          idle.callback();
          assert.deepEqual(f.events,before);
        }
        f.media._readerSourceRetry=true;
        for(const event of ['progress','error','loadedmetadata'])f.media.dispatchEvent(new Event(event));
        assert.equal(callbacks.size,0);assert.equal(f.media._readerSourceRetry,true);
        assert.equal(f.media.loads,0);assert.equal(f.context.status.textContent,'');
        assert.ok(!f.events.includes('ready'));
        assert.ok(!f.events.some(value=>Array.isArray(value)&&value[0]==='fail'));
      } finally {f.restore();}
    }
  } finally {globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
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
  const originalSet=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
  const callbacks=new Map();let next=1;
  globalThis.setTimeout=(callback,delay)=>{const id=next++;callbacks.set(id,{callback,delay});return id;};
  globalThis.clearTimeout=id=>callbacks.delete(id);
  try {
    for(const recover of [true,false]) {
      const f=fixture();try {
        const promise=f.context.renderMedia('audio');
        const hard=[...callbacks].find(([,item])=>item.delay===20000)[0];
        const [firstIdle,idle]=[...callbacks].find(([,item])=>item.delay===15000);idle.callback();
        assert.equal(f.media.src,f.proxyHref);assert.equal(f.media.loads,1);
        assert.ok(callbacks.has(hard));assert.equal([...callbacks.values()].filter(item=>item.delay===20000).length,1);
        const [secondIdle,rearmed]=[...callbacks].find(([,item])=>item.delay===15000);
        assert.notEqual(secondIdle,firstIdle);assert.equal(callbacks.has(firstIdle),false);
        if(recover) {
          f.media.currentTime=0;f.media.readyState=1;
          f.media.dispatchEvent(new Event('loadedmetadata'));await promise;
          assert.equal(f.media.currentTime,4);assert.equal(f.context.status.textContent,'音频');
          assert.equal(f.events.filter(value=>value==='ready').length,1);
          assert.ok(!f.events.some(value=>Array.isArray(value)&&value[0]==='fail'));
        } else {
          rearmed.callback();
          await assert.rejects(promise,{name:'AbortError'});
          const failures=f.events.filter(value=>Array.isArray(value)&&value[0]==='fail');
          assert.equal(failures.length,1);assert.equal(failures[0][2],'READER_MEDIA');
          assert.match(failures[0][1],/媒体信息加载停顿/);assert.ok(!f.events.includes('ready'));
        }
        assert.equal(f.media.loads,1);assert.equal(callbacks.size,0);assert.equal(f.media._readerSourceRetry,false);
      } finally {f.restore();}
    }
  } finally {globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
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
    f.context.contentUrl=f.context.sourceUrl;
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
    const before=[...f.events];
    f.media.dispatchEvent(new Event('progress'));
    assert.equal(callbacks.size,0);assert.deepEqual(f.events,before);
    f.media.currentTime=7;f.media.duration=12;
    f.media.dispatchEvent(new Event('durationchange'));
    assert.equal(f.panel.textContent,'00:07 / 00:12');
    assert.equal(f.events.filter(value=>value==='ready').length,1);
  } finally {f.restore();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

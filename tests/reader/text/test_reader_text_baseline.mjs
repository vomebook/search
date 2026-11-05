// Offline baseline for the actual text-format module; no source rewriting.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createReaderTextFormat} from '../../../static/reader/formats/reader-text-format.mjs';

class FakeText {
  constructor(value) { this.nodeType=3;this.data=value; }
  appendData(value) { this.data+=value; }
  get textContent() { return this.data; }
}
class FakeElement {
  constructor(tag) { this.tag=tag;this.children=[];this.className=''; }
  appendChild(node) { this.children.push(node);return node; }
  get lastChild() { return this.children.at(-1) ?? null; }
  get textContent() { return this.children.map(child=>child.textContent).join(''); }
  set textContent(value) { this.children=value ? [new FakeText(value)] : []; }
}
function fixture({limit=1_000_000, waits=()=>Promise.resolve()}={}) {
  const old={document:globalThis.document,Node:globalThis.Node,security:globalThis.VoiceOfMLReaderSecurity};
  globalThis.document={createElement:tag=>new FakeElement(tag),createTextNode:value=>new FakeText(value)};
  globalThis.Node={TEXT_NODE:3};
  globalThis.VoiceOfMLReaderSecurity={LIMITS:{documentBytes:limit},assertResponseSize(response,max){
    const size=Number(response.headers.get('content-length'));
    if(size>max)throw Object.assign(new Error('READER_RESOURCE_LIMIT'),{code:'READER_RESOURCE_LIMIT'});
  }};
  const events=[],context={content:new FakeElement('content'),documentState:{title:'synthetic'},
    assertReaderActive(){},markReaderContentReady(){events.push('ready');},waitForReader:waits,
    trackReaderResource(cleanup){events.push('track');this.cleanup=cleanup;return()=>events.push('untrack');},
    readerAbortError:()=>new DOMException('closed','AbortError'),awaitReader:promise=>Promise.resolve(promise),
    renderText:(mode,prepared)=>({mode,prepared})};
  Object.assign(context,createReaderTextFormat(context));
  return {context,events,restore(){globalThis.document=old.document;globalThis.Node=old.Node;
    globalThis.VoiceOfMLReaderSecurity=old.security;}};
}
function responseChunks(chunks) {
  const stream = new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}});
  return new Response(stream);
}

test('encoding detection handles BOMs, valid UTF-8, UTF-16 heuristics and legacy hints',()=>{
  const f=fixture();try {
    const detect=f.context.detectTextEncoding;
    assert.equal(detect(Uint8Array.of(0xef,0xbb,0xbf)),'utf-8');
    assert.equal(detect(Uint8Array.of(0xef,0xbb,0xbf,0xff),'中文'),'utf-8',
      'UTF-8 BOM wins even when the following payload is malformed');
    assert.equal(detect(Uint8Array.of(0xff,0xfe)),'utf-16le');
    assert.equal(detect(Uint8Array.of(0xfe,0xff)),'utf-16be');
    assert.equal(detect(Uint8Array.of(65,0,66,0,67,0)),'utf-16le');
    assert.equal(detect(Uint8Array.of(0,65,0,66,0,67)),'utf-16be');
    assert.equal(detect(new TextEncoder().encode('汉字 and emoji 😀')),'utf-8');
    assert.equal(detect(Uint8Array.of(0xff),'Русский'),'windows-1251');
    assert.equal(detect(Uint8Array.of(0xc4,0xe3,0xba,0xc3),'中文'),'gb18030');
    assert.equal(detect(Uint8Array.of(0xa4,0xa4,0xa4,0xe5),'中文'),'big5');
  } finally {f.restore();}
});

test('plain fallback preserves Unicode replacement characters and enforces actual byte limit',async()=>{
  const f=fixture({limit:64});try {
    const bytes=new TextEncoder().encode('literal � and 中文');
    await f.context.renderPlainText({headers:new Headers(),body:null,arrayBuffer:async()=>bytes.buffer});
    assert.equal(f.context.content.textContent,'literal � and 中文');assert.ok(f.events.includes('ready'));
    await assert.rejects(f.context.renderPlainText({headers:new Headers(),body:null,arrayBuffer:async()=>new Uint8Array(65).buffer}),
      {code:'READER_RESOURCE_LIMIT'});
  } finally {f.restore();}
});

test('stream handles split UTF-8 BOM and codepoints and releases its resource',async()=>{
  const f=fixture();try {
    const bytes=new TextEncoder().encode('\ufeffsplit 😀 literal � 汉字');
    const chunks=[bytes.subarray(0,1),bytes.subarray(1,2),bytes.subarray(2,8),bytes.subarray(8,11),bytes.subarray(11)];
    await f.context.renderPlainText(responseChunks(chunks));
    assert.equal(f.context.content.textContent,'split 😀 literal � 汉字');
    assert.deepEqual(f.events.filter(event=>event==='track'||event==='untrack'),['track','untrack']);
    // Even an empty stream reaches EOF with no decoder selected. The host's
    // detection callback must still be called once before the decoder is flushed.
    f.context.content.children.length=0;f.events.length=0;
    const detect=f.context.detectTextEncoding, samples=[];
    f.context.detectTextEncoding=(sample,...args)=>{samples.push([...sample]);return detect(sample,...args);};
    await f.context.renderPlainText(responseChunks([]));
    assert.deepEqual(samples,[[]]);assert.equal(f.context.content.textContent,'');
    assert.deepEqual(f.events.filter(event=>event==='track'||event==='untrack'),['track','untrack']);
  } finally {f.restore();}
});

test('stream rejects an oversized body and cancels its reader',async()=>{
  const f=fixture({limit:8});let cancelled=false;
  try {
    const stream=new ReadableStream({start(controller){
      controller.enqueue(Uint8Array.of(1,2,3,4,5,6,7,8,9));
      setImmediate(()=>{if(!cancelled)controller.close();});
    },
      cancel(){cancelled=true;}});
    await assert.rejects(f.context.renderPlainText(new Response(stream)),{code:'READER_RESOURCE_LIMIT'});
    assert.equal(cancelled,true);assert.ok(f.events.includes('untrack'));
  } finally {f.restore();}
});

test('plain and Markdown adapters forward the prepared object unchanged',()=>{
  const f=fixture();try {
    const prepared={opaque:true};
    assert.deepEqual(f.context.renderTextDocument(prepared),{mode:false,prepared});
    assert.deepEqual(f.context.renderMarkdownDocument(prepared),{mode:true,prepared});
  } finally {f.restore();}
});

test('split UTF-16 prefix clears an early ASCII preview before publishing final text',async()=>{
  const f=fixture();let controller;
  try {
    const stream=new ReadableStream({start(value){controller=value;}});
    const pending=f.context.renderPlainText(new Response(stream));
    controller.enqueue(Uint8Array.of(0x61,0x62,0x63,0x64));
    for(let i=0;i<10&&f.context.content.textContent!=='abcd';i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.context.content.textContent,'abcd');
    controller.enqueue(Uint8Array.of(0));controller.close();await pending;
    assert.notEqual(f.context.content.textContent,'abcd');
    assert.ok(!f.context.content.textContent.startsWith('abcd'));
    assert.ok(f.events.includes('untrack'));
  } finally {f.restore();}
});

test('block boundaries preserve surrogate pairs and CRLF without creating oversized blocks',async()=>{
  const f=fixture();try {
    const value='x'.repeat(32767)+'😀'+'y'.repeat(32765)+'\r\n'+'end';
    const bytes=new TextEncoder().encode(value);
    await f.context.renderPlainText({headers:new Headers(),body:null,arrayBuffer:async()=>bytes.buffer});
    assert.equal(f.context.content.textContent,value);
    assert.ok(f.events.filter(event=>event==='ready').length>0);
    const blocks=f.context.content.children[0].children;
    assert.ok(blocks.length>=2);assert.ok(blocks.every(block=>block.textContent.length<=32768));
    for(const block of blocks.slice(0,-1)) {
      const last=block.textContent.charCodeAt(block.textContent.length-1);
      assert.ok(!(last>=0xd800&&last<=0xdbff));assert.notEqual(last,13);
    }
  } finally {f.restore();}
});

test('resource cleanup cancels an outstanding stream and always releases ownership',async()=>{
  const f=fixture();let cancelled=0;
  try {
    const stream=new ReadableStream({cancel(){cancelled++;}});
    const pending=f.context.renderPlainText(new Response(stream));
    assert.equal(typeof f.context.cleanup,'function');f.context.cleanup();await pending;
    assert.equal(cancelled,1);assert.deepEqual(f.events.filter(event=>event==='track'||event==='untrack'),['track','untrack']);
  } finally {f.restore();}
});

test('large samples select the decoder before EOF and retain all streamed text',async()=>{
  const f=fixture();let controller;
  try {
    const detect=f.context.detectTextEncoding;let detections=0;const detected=[];
    f.context.detectTextEncoding=(...args)=>{detections++;const value=detect(...args);detected.push(value);return value;};
    const stream=new ReadableStream({start(value){controller=value;}});
    const pending=f.context.renderPlainText(new Response(stream));
    const first='a'.repeat(65540), bytes=new TextEncoder().encode(first+'尾');
    controller.enqueue(bytes.subarray(0,65540));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.context.content.textContent,first);assert.equal(detections,1,'decoder must be selected before EOF');
    assert.deepEqual(detected,['utf-8']);
    controller.enqueue(bytes.subarray(65540));controller.close();await pending;
    assert.equal(f.context.content.textContent,first+'尾');assert.equal(detections,1);
    assert.ok(f.events.includes('untrack'));
  } finally {f.restore();}
});

test('long text yields to the host before completing subsequent blocks',async()=>{
  let now=0,yields=0;const old=globalThis.performance;
  const f=fixture({waits:async()=>{yields++;}});
  try {
    globalThis.performance={now:()=>{now+=10;return now;}};
    const value='z'.repeat(70000), bytes=new TextEncoder().encode(value);
    await f.context.renderPlainText({headers:new Headers(),body:null,arrayBuffer:async()=>bytes.buffer});
    assert.ok(yields>=1);assert.equal(f.context.content.textContent,value);
  } finally {globalThis.performance=old;f.restore();}
});

test('host abort while yielding stops future blocks without swallowing the error',async()=>{
  let now=0;const failure=new Error('reader closed'),old=globalThis.performance;
  const f=fixture({waits:async()=>{throw failure;}});
  try {
    globalThis.performance={now:()=>{now+=10;return now;}};
    const value='q'.repeat(70000),bytes=new TextEncoder().encode(value);
    await assert.rejects(f.context.renderPlainText({headers:new Headers(),body:null,arrayBuffer:async()=>bytes.buffer}),
      error=>error===failure);
    assert.ok(f.context.content.textContent.length>0);
    assert.ok(f.context.content.textContent.length<value.length);
  } finally {globalThis.performance=old;f.restore();}
});

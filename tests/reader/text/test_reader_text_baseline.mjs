// Offline baseline for the actual text-format module; no source rewriting.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createReaderTextFormat} from '../../../static/reader/formats/reader-text-format.mjs';
import {createReaderSpeech} from '../../../static/reader/ui/reader-speech.mjs';

class FakeText {
  constructor(value) { this.nodeType=3;this.data=value; }
  appendData(value) { this.data+=value; }
  get textContent() { return this.data; }
}
class FakeElement {
  constructor(tag) { this.tag=tag;this.children=[];this.className='';this.dataset={}; }
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

const vCard = [
  'BEGIN:VCARD', 'VERSION:3.0', 'N:Example;Test;;;', 'FN:测试 Example', 'TITLE:Example role',
  'ORG:Team\\;A;Division', 'EMAIL;TYPE=WORK,INTERNET:work@example.invalid',
  'EMAIL;TYPE=HOME:home@example.invalid', 'TEL;TYPE="Work:Voice":+1-555-0100',
  'item1.ADR;TYPE=WORK:;;One Example St;Example City;;;', 'URL:https://example.invalid/',
  'NOTE:<img src="https://example.invalid/image">; folded', '\t文字\\nNew\\, line\\\\',
  'PHOTO;VALUE=URI:https://example.invalid/photo', 'END:VCARD', ''
].join('\r\n');

const encode = value => new TextEncoder().encode(value);
const buffered = value => ({headers:new Headers(),body:null,arrayBuffer:async()=>encode(value).buffer});

test('original VCF gets a text-only summary through direct and derived text paths', async t => {
  const f=fixture(); t.after(f.restore);
  const requests=[];
  t.mock.method(globalThis,'fetch',(...args)=>{requests.push(args);throw Error('unexpected fetch');});
  for (const [extension,metadata,response] of [
    ['vcf',null,responseChunks([encode(vCard.slice(0,32)),encode(vCard.slice(32))])],
    ['txt',{original_extension:'.VCF'},new Response(encode('\ufeff'+vCard))],
    ['txt',{original_extension:'vcf'},buffered(vCard)]
  ]) {
    Object.assign(f.context,{extension,resolvedReaderData:metadata});
    f.context.content.children.length=0;
    await f.context.renderPlainText(response);
    const root=f.context.content.children[0];
    assert.equal(root.className,'reader-text');
    assert.deepEqual(root.children.map(block=>[block.tag,block.className,...block.children.map(node=>node.nodeType)]),
      [['pre','reader-text-block',3]]);
    assert.equal(root.textContent,[
      '姓名：测试 Example','职务：Example role','单位：Team;A · Division',
      '电子邮箱：work@example.invalid','电子邮箱：home@example.invalid','电话：+1-555-0100',
      '地址：One Example St · Example City','网址：https://example.invalid/',
      '备注：<img src="https://example.invalid/image">; folded文字','New, line\\'
    ].join('\n'));
  }
  assert.deepEqual(requests,[]);
  await f.context.renderPlainText(new Response('begin:vcard\nversion:3.0\nn:Example;Test;;;\nfn:  \nend:vcard'));
  assert.equal(f.context.content.children.at(-1).textContent,'姓名：Example · Test');
});

test('VCF fallback and non-VCF plain text preserve the original whitespace', async t => {
  const f=fixture(); t.after(f.restore);
  for (const value of [
    '', vCard.trimEnd().replace('END:VCARD',''), vCard.replace('3.0','4.0'), vCard+vCard,
    vCard.replace('TITLE:Example role','not a field'), vCard.replace('TITLE:', 'TITLE;ENCODING=b:'),
    'BEGIN:VCARD\nVERSION:3.0\nTEL:123\nEND:VCARD', ' \tfirst\r\n  second\r\n\r\n'
  ]) {
    f.context.content.children.length=0;
    f.context.extension='vcf';
    await f.context.renderPlainText(new Response(value));
    assert.equal(f.context.content.textContent,value);
  }
  for (const [extension,original_extension] of [['txt','txt'],['ini',null],['vcf','txt'],['txt','notvcf'],
    ['txt','vcf.exe'],['txt','vcf '],['txt',{toString(){throw Error('metadata must not be coerced');}}]]) {
    f.context.content.children.length=0;
    Object.assign(f.context,{extension,resolvedReaderData:{original_extension},documentState:{title:'looks-like.vcf'}});
    await f.context.renderPlainText(new Response(vCard));
    assert.equal(f.context.content.textContent,vCard);
  }
});

test('VCF preview bounds both headers and bytes without publishing partial contact data', async t => {
  const f=fixture(); t.after(f.restore);
  f.context.extension='vcf';
  let cancelCount=0;
  const unopened=new Response(new ReadableStream({cancel(){cancelCount++;}}),{headers:{'Content-Length':65537}});
  await assert.rejects(f.context.renderPlainText(unopened),{code:'READER_RESOURCE_LIMIT'});
  assert.equal(cancelCount,1);
  const oversized=new Response(new ReadableStream({
    start(controller){controller.enqueue(encode(vCard));controller.enqueue(new Uint8Array(65536));},
    cancel(){cancelCount++;}
  }));
  await assert.rejects(f.context.renderPlainText(oversized),{code:'READER_RESOURCE_LIMIT'});
  assert.equal(cancelCount,2);
  assert.equal(oversized.body.locked,false);
  await assert.rejects(f.context.renderPlainText(buffered('x'.repeat(65537))),{code:'READER_RESOURCE_LIMIT'});
  assert.equal(f.context.content.children.length,0);
  assert.ok(!f.events.includes('ready'));
  let controller;
  const atLimit=encode(vCard.replace('END:VCARD','X-PADDING:'+'x'.repeat(65536-encode(vCard).length-12)+'\r\nEND:VCARD'));
  assert.equal(atLimit.length,65536);
  const pending=f.context.renderPlainText(new Response(new ReadableStream({start(c){controller=c;}})));
  controller.enqueue(atLimit);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.context.content.children.length,0);
  controller.close();
  await pending;
  assert.match(f.context.content.textContent,/^姓名：/);
});

test('Reader speech never loads a player or offers VCF text, including on handoff', async t => {
  const previous={window:globalThis.window,document:globalThis.document,CCRDSpeech:globalThis.CCRDSpeech};
  t.after(()=>Object.assign(globalThis,previous));
  globalThis.window={addEventListener(){}};
  let readCount=0, offers=0, loadCount=0;
  globalThis.document={querySelector(selector){if(selector!=='#back')readCount++;return null;}};
  const player={previewClosed(){},previewLoaded(){offers++;},readFrom(){offers++;}};
  for (const [extension,resolvedReaderData,existingPlayer] of [
    ['vcf',null,false],['txt',{original_extension:'.VCF'},true]
  ]) {
    globalThis.CCRDSpeech=existingPlayer ? player : undefined;
    let phase;
    const speech=createReaderSpeech({extension,resolvedReaderData,capability:{mode:'text'},
      get content(){readCount++;throw Error('unexpected text access');},
      isReaderOverlayFrame:()=>true,readerRuntime:{events:{on(name,fn){phase=fn;}}}},
    async()=>{loadCount++;},'{"unit":0,"offset":0}');
    speech.installReaderSpeech(true);
    phase({phase:'ready'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(speech.readerSpeechAdapter(),null);
  }
  assert.deepEqual([readCount,offers,loadCount],[0,0,0]);
});

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
    assert.equal(detect(Uint8Array.of(0xcf,0xf0,0xe8,0xe2,0xe5,0xf2,0x21)),'windows-1251',
      'legacy Cyrillic text can be detected without a language hint in the title');
    // Compare the original two-filter heuristic on random bytes, BOMs and
    // threshold edges. Only the zero scan is replaced; decoder scoring stays.
    const oldHeuristic=bytes=>{
      if(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)return 'utf-8';
      if(bytes[0]===0xff&&bytes[1]===0xfe)return 'utf-16le';
      if(bytes[0]===0xfe&&bytes[1]===0xff)return 'utf-16be';
      const even=bytes.filter((value,index)=>!value&&index%2===0).length;
      const odd=bytes.filter((value,index)=>!value&&index%2===1).length;
      return odd>bytes.length/8&&odd>even*4?'utf-16le':even>bytes.length/8&&even>odd*4?'utf-16be':null;
    };
    let seed=0x7621ac39;
    const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
    for(let trial=0;trial<500;trial++) {
      const bytes=new Uint8Array(random(300));
      for(let i=0;i<bytes.length;i++)bytes[i]=random(5)?random(255)+1:0;
      const expected=oldHeuristic(bytes);
      if(expected)assert.equal(detect(bytes,'中文'),expected,`zero heuristic case ${trial}`);
    }
    const savedFilter=Uint8Array.prototype.filter;
    try {
      Uint8Array.prototype.filter=function(){throw new Error('unexpected copied byte array');};
      const bytes=new TextEncoder().encode('中文 plain text\n'.repeat(10000));
      const observed=[];
      // Count indexed reads without replacing the native NUL search or decode.
      const probe=new Proxy(bytes,{get(target,key){
        if(typeof key==='string'&&/^\d+$/.test(key))observed.push(Number(key));
        return key==='indexOf'?target.indexOf.bind(target):Reflect.get(target,key,target);
      }});
      const originalDecode=TextDecoder.prototype.decode;
      try {
        TextDecoder.prototype.decode=function(input,options){return originalDecode.call(this,input===probe?bytes:input,options);};
        assert.equal(detect(probe),'utf-8');
        assert.deepEqual(observed,[0,0,0]);
      } finally {TextDecoder.prototype.decode=originalDecode;}
    } finally {Uint8Array.prototype.filter=savedFilter;}
    // Sparse NULs do not imply UTF-16; late NULs retain their original parity.
    assert.equal(detect(new TextEncoder().encode('prefix\u0000'+'ASCII tail'.repeat(20))),'utf-8');
    for(const parity of [0,1]){
      const delayed=new Uint8Array(48).fill(65);
      for(let i=16+parity;i<delayed.length;i+=2)delayed[i]=0;
      assert.equal(detect(delayed),oldHeuristic(delayed));
    }
    for(const size of [0,1,7,8,9,63,64,65,65536,65540]) {
      const sample=new Uint8Array(size).fill(65);
      for(let i=1;i<size;i+=2)sample[i]=0;
      const expected=oldHeuristic(sample);
      if(expected)assert.equal(detect(sample),expected,`UTF-16 threshold ${size}`);
    }
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

    for (const [encoding, bom, a, b] of [
      ['utf-16le', [0xff,0xfe], [0x41,0], [0x42,0]],
      ['utf-16be', [0xfe,0xff], [0,0x41], [0,0x42]]
    ]) {
      f.context.content.children.length=0;f.events.length=0;samples.length=0;
      const response=responseChunks([Uint8Array.of(bom[0]),Uint8Array.of(),Uint8Array.of(bom[1]),
        Uint8Array.of(a[0]),Uint8Array.of(a[1],b[0]),Uint8Array.of(b[1])]);
      await f.context.renderPlainText(response);
      assert.equal(f.context.content.textContent,'AB',encoding);
      assert.deepEqual(samples,[bom],`${encoding} decoder selected at the split BOM`);
      assert.equal(response.body.locked,false);
      assert.deepEqual(f.events.filter(event=>event==='track'||event==='untrack'),['track','untrack']);
    }
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

    f.context.content.children.length=0;
    const before='x'.repeat(32767), after='\r\n'+'y'.repeat(32763)+'\nend';
    const encode=text=>new TextEncoder().encode(text);
    await f.context.renderPlainText(responseChunks([encode('\ufeff'+before),encode(after)]));
    assert.equal(f.context.content.textContent,before+after);
    const streamed=f.context.content.children[0].children.map(block=>block.textContent);
    assert.deepEqual(streamed,[before,after.slice(0,-3),'end']);
  } finally {f.restore();}
});

test('long unbroken chunks never search preceding blocks for newlines',async()=>{
  const f=fixture(), original=String.prototype.lastIndexOf;
  const sizes=[];
  const size=32768, prefix='lead\n', value=prefix+'x'.repeat(size*5)+'末尾';
  const bytes=new TextEncoder().encode(value);
  try {
    String.prototype.lastIndexOf=function(search,...rest){
      if(search==='\n') sizes.push(this.length);
      return original.call(this,search,...rest);
    };
    await f.context.renderPlainText({headers:new Headers(),body:null,arrayBuffer:async()=>bytes.buffer});
  } finally { String.prototype.lastIndexOf=original;f.restore(); }
  const blocks=f.context.content.children[0].children.map(block=>block.textContent);
  assert.equal(f.context.content.textContent,value);
  assert.deepEqual(blocks,[prefix,...Array(5).fill('x'.repeat(size)),'末尾']);
  assert.ok(sizes.length>=5);
  assert.ok(sizes.every(length=>length<=size),`newline search lengths: ${sizes}`);
});

test('resource cleanup cancels an outstanding stream and always releases ownership',async()=>{
  const f=fixture();let cancelled=0;
  try {
    const stream=new ReadableStream({cancel(){cancelled++;}});
    const pending=f.context.renderPlainText(new Response(stream));
    assert.equal(typeof f.context.cleanup,'function');f.context.cleanup();await pending;
    assert.equal(cancelled,1);assert.deepEqual(f.events.filter(event=>event==='track'||event==='untrack'),['track','untrack']);
  } finally {f.restore();}
  // If stream cancellation itself rejects, cleanup still consumes the error.
  const rejected=fixture(), cancelFailure=new Error('cancel failed');
  try {
    const stream=new ReadableStream({cancel(){return Promise.reject(cancelFailure);}});
    const pending=rejected.context.renderPlainText(new Response(stream));
    rejected.context.cleanup();await pending;
    assert.deepEqual(rejected.events.filter(event=>event==='track'||event==='untrack'),['track','untrack']);
  } finally {rejected.restore();}
});

test('large samples select the decoder before EOF and retain all streamed text',async()=>{
  const f=fixture();let controller;
  try {
    const detect=f.context.detectTextEncoding;let detections=0;const detected=[];
    f.context.detectTextEncoding=(...args)=>{detections++;const value=detect(...args);detected.push(value);return value;};
    const stream=new ReadableStream({start(value){controller=value;}});
    const pending=f.context.renderPlainText(new Response(stream));
    // At the sample boundary a UTF-8 character can still be incomplete.
    // Selecting the final decoder must retain its pending bytes without
    // repeating the ASCII preview or emitting a replacement character.
    const first='a'.repeat(65538), suffix='😀尾', bytes=new TextEncoder().encode(first+suffix);
    controller.enqueue(bytes.subarray(0,65540));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.context.content.textContent,first);assert.equal(detections,1,'decoder must be selected before EOF');
    assert.deepEqual(detected,['utf-8']);
    controller.enqueue(bytes.subarray(65540));controller.close();await pending;
    assert.equal(f.context.content.textContent,first+suffix);assert.equal(detections,1);
    assert.equal(stream.locked,false);
    assert.ok(f.events.includes('untrack'));
  } finally {f.restore();}
});

test('a large single-chunk stream reuses the encoding sample and keeps every text block',async()=>{
  const f=fixture({limit:4_000_000});
  try {
    const line='中文首屏，正文 😀 �\r\n\r\n';
    const value=line.repeat(84000)+'末尾';
    // Model a buffered response whose view is not the entire backing buffer.
    const source=new TextEncoder().encode('!!'+value+'??');
    const chunk=source.subarray(2,-2);
    const samples=[], detect=f.context.detectTextEncoding;
    f.context.detectTextEncoding=(bytes,title)=>{samples.push(bytes);return detect(bytes,title);};
    const response=responseChunks([chunk]);
    await f.context.renderPlainText(response);
    assert.equal(samples.length,1);
    assert.equal(samples[0].buffer,chunk.buffer,'single-chunk sample is still zero-copy');
    assert.equal(samples[0].byteOffset,chunk.byteOffset);
    assert.equal(samples[0].byteLength,65540,'large chunk must not extend the detection window');
    const root=f.context.content.children[0];
    assert.equal(root.textContent,value);
    assert.equal(root.dataset.textPreview,undefined);
    assert.equal(response.body.locked,false);
    assert.ok(root.children.length>32);
    for(const block of root.children.slice(0,-1)){
      assert.equal(block.children.length,1);
      assert.ok(block.textContent.length<=32768);
      assert.ok(block.textContent.endsWith('\n'));
    }
  } finally {f.restore();}
});

test('long ASCII preface does not force UTF-8 and encoding is independent of packet boundaries',async()=>{
  const f=fixture();
  try {
    const lead='a'.repeat(70001)+'\n', expected=lead+'Привет, мир!';
    const bytes=Uint8Array.from([...new TextEncoder().encode(lead),
      207,240,232,226,229,242,44,32,236,232,240,33]);
    f.context.documentState.title='Русский';
    for (const cuts of [[], [65540], [1000,65539,70002,70003], [70008]]) {
      f.context.content.children.length=0;
      const chunks=[0,...cuts].map((start,i)=>bytes.subarray(start,cuts[i] ?? bytes.length));
      await f.context.renderPlainText(responseChunks(chunks));
      assert.equal(f.context.content.textContent,expected);
    }
    f.context.content.children.length=0;
    await f.context.renderPlainText({headers:new Headers(),body:null,arrayBuffer:async()=>bytes.buffer});
    assert.equal(f.context.content.textContent,expected);
  } finally {f.restore();}
});

test('Chinese UTF-8 preview is bounded and keeps authoritative stream text exact',async()=>{
  const f=fixture();
  const encode=text=>new TextEncoder().encode(text);
  try {
    const open=()=>{
      f.context.content.children.length=0;
      let controller;
      const task=f.context.renderPlainText(new Response(new ReadableStream({start(c){controller=c;}})));
      return {controller,task,pre:f.context.content.children[0]};
    };
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    const first='中文首屏😀', giant='文'.repeat(2044)+'😀';
    {
      const {controller,task,pre}=open();
      const bytes=encode(first);
      for(const byte of bytes.subarray(0,bytes.length-1)) controller.enqueue(Uint8Array.of(byte));
      await tick();
      assert.equal(pre.dataset.textPreview,'中文首屏');
      assert.equal(pre.textContent,'','provisional glyphs are not document text');
      controller.enqueue(bytes.subarray(bytes.length-1)); await tick();
      assert.equal(pre.dataset.textPreview,first);
      controller.close(); await task;
      assert.equal(pre.dataset.textPreview,undefined);
      assert.equal(pre.textContent,first);
    }
    for(const tail of [Uint8Array.of(0xc4,0xe3,0xba,0xc3), Uint8Array.of(0)]) {
      const {controller,task,pre}=open();
      const prefix=encode(first);
      const bytes=Uint8Array.from([...prefix,...tail]);
      const decoder=new TextDecoder(f.context.detectTextEncoding(bytes));
      const decoded=decoder.decode(bytes);
      controller.enqueue(prefix); await tick();
      assert.equal(pre.dataset.textPreview,first);
      controller.enqueue(tail); await tick();
      assert.equal(pre.dataset.textPreview,undefined);
      controller.close(); await task;
      assert.equal(pre.textContent,decoder.encoding.startsWith('utf-')?decoded:decoded.replace(/\ufffd/g,''));
    }
    {
      const {controller,task,pre}=open();
      // The preview cap would split the emoji after its leading surrogate.
      controller.enqueue(encode('中文首'+giant)); await tick();
      assert.equal(pre.dataset.textPreview.length,2047);
      assert.equal(pre.dataset.textPreview,'中文首'+'文'.repeat(2044));
      controller.enqueue(encode('更多')); await tick();
      assert.ok(pre.dataset.textPreview.length<=2048);
      controller.enqueue(encode('尾'.repeat(22500))); await tick();
      assert.equal(pre.dataset.textPreview,undefined);
      controller.close(); await task;
      assert.equal(pre.textContent,'中文首'+giant+'更多'+'尾'.repeat(22500));
    }
    {
      const {controller,task,pre}=open();
      const firstBytes=Uint8Array.of(0x61,0x62,0x63,0x64,0xe0,0x4e);
      const tail=Uint8Array.of(0x41,0,0x42,0,0x43,0,0x44,0,0x45,0,0x46,0);
      controller.enqueue(firstBytes); await tick();
      assert.equal(pre.textContent,'abcd');
      controller.enqueue(tail); controller.close(); await task;
      assert.equal(pre.textContent,new TextDecoder('utf-16le').decode(Uint8Array.from([...firstBytes,...tail])));
    }
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

// Preserve failure and observable property-access behavior in the original module.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createReaderTextFormat} from '../../../static/reader/formats/reader-text-format.mjs';

test('reader errors preserve the original reason and release the reader lock', async () => {
  const old={document:globalThis.document,security:globalThis.VoiceOfMLReaderSecurity};
  const failure=new Error('source failed'), events=[], reader={read:async()=>{throw failure;},
    cancel:async reason=>events.push(['cancel',reason]),releaseLock:()=>events.push('release')};
  globalThis.document={createElement:()=>({className:'',appendChild(){}})};
  globalThis.VoiceOfMLReaderSecurity={LIMITS:{documentBytes:32},assertResponseSize(){}};
  const context={content:{appendChild(){}},documentState:{title:''},assertReaderActive(){},
    trackReaderResource(){events.push('track');return()=>events.push('untrack');},
    readerAbortError:()=>new DOMException('closed','AbortError'),awaitReader:promise=>Promise.resolve(promise)};
  try {
    await assert.rejects(createReaderTextFormat(context).renderPlainText({body:{getReader:()=>reader}}), error=>error===failure);
    assert.deepEqual(events,['track',['cancel',failure],'untrack','release']);
    // startDecoder can reject both during BOM detection and after EOF; neither
    // path may flush an unassigned decoder, mask the error, or leak the lock.
    for (const chunks of [[Uint8Array.of(0xef,0xbb,0xbf)], [Uint8Array.of(0x61)], []]) {
      events.length=0;
      const reason=new Error('encoding detection failed');let index=0, detections=0;
      const failingReader={read:async()=>index<chunks.length ? {value:chunks[index++],done:false} : {done:true},
        cancel:async error=>events.push(['cancel',error]),releaseLock:()=>events.push('release')};
      context.detectTextEncoding=()=>{detections++;throw reason;};
      await assert.rejects(createReaderTextFormat(context).renderPlainText({body:{getReader:()=>failingReader}}),
        error=>error===reason);
      assert.equal(detections,1);assert.deepEqual(events,['track',['cancel',reason],'untrack','release']);
    }
  } finally {globalThis.document=old.document;globalThis.VoiceOfMLReaderSecurity=old.security;}
});

test('decoder detection preserves observable indexed getter order', () => {
  const calls=[];
  const bytes={get 0(){calls.push(0);return 0xef;},get 1(){calls.push(1);return 0xbb;},
    get 2(){calls.push(2);return 0xbf;}};
  assert.equal(createReaderTextFormat({}).detectTextEncoding(bytes),'utf-8');
  assert.deepEqual(calls,[0,1,2]);
  const error=new Error('getter failed');
  assert.throws(()=>createReaderTextFormat({}).detectTextEncoding({get 0(){throw error;}}), actual=>actual===error);
});

test('buffered header limit fails before accessing the response body', async () => {
  const old={document:globalThis.document,security:globalThis.VoiceOfMLReaderSecurity};
  const failure=new Error('header limit'),events=[];
  globalThis.document={createElement:()=>({className:'',appendChild(){}})};
  globalThis.VoiceOfMLReaderSecurity={LIMITS:{documentBytes:4},assertResponseSize(response,limit){
    events.push(['header',response,limit]);throw failure;
  }};
  const context={content:{appendChild(){}},assertReaderActive(){}};
  const response={get body(){events.push('body');throw new Error('unexpected body access');}};
  try {
    await assert.rejects(createReaderTextFormat(context).renderPlainText(response), error=>error===failure);
    assert.deepEqual(events,[['header',response,4]]);
  } finally {globalThis.document=old.document;globalThis.VoiceOfMLReaderSecurity=old.security;}
});

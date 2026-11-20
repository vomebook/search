import test from 'node:test';
import assert from 'node:assert/strict';
import {createReaderPdfScheduler} from '../../../static/reader/pdf/reader-pdf-scheduler.mjs';
import {createReaderPdfTextRuntime} from '../../../static/reader/pdf/reader-pdf-text-runtime.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function setup(budget=100000) {
  let generation=1;
  const context={readerAbortController:new AbortController(),pdfTextWaiters:[],pdfActiveTextLoads:0,
    pdfActiveSearchTextLoads:0,pdfTextContentPromises:new Map(),pdfTextContentCache:new Map(),
    pdfTextContentCacheBytes:0,PDF_TEXT_CONTENT_CACHE_BYTES:budget,pdfDocument:null,
    assertReaderActive(){},readerAbortError:()=>new DOMException('cancelled','AbortError'),
    isReaderGenerationCurrent:(_kind,value)=>value===generation,awaitReader:promise=>promise};
  Object.assign(context,createReaderPdfScheduler(context),createReaderPdfTextRuntime(context));
  return {context,next(){generation++;context.drainPdfTextWaiters();}};
}
const content=value=>({items:[{str:value}],styles:{}});

test('stale DjVu extraction is evicted before abort and a new owner survives',async()=>{
  globalThis.matchMedia=()=>({matches:false});
  const {context,next}=setup(), calls=[], gates=[];let replacement;
  const page={readerDjvuText:true,getTextContent({signal}){
    const gate=deferred();calls.push(signal);gates.push(gate);
    signal.addEventListener('abort',()=>{
      replacement=context.loadPdfTextContent(1,page,2);
      gate.resolve(content('stale'));
    },{once:true});
    return gate.promise;
  }};
  const stale=context.loadPdfTextContent(1,page,1);stale.catch(()=>{});await tick();
  next();await tick();assert.equal(calls.length,2);assert.equal(calls[0].aborted,true);
  await assert.rejects(stale,{name:'AbortError'});
  assert.strictEqual(context.pdfTextContentPromises.get(1),replacement);
  gates[1].resolve(content('fresh'));assert.equal((await replacement).items[0].str,'fresh');
  assert.equal(context.cachedPdfTextContent(1).items[0].str,'fresh');
});

test('render promotion preserves shared DjVu extraction across generation change',async()=>{
  globalThis.matchMedia=()=>({matches:false});
  const {context,next}=setup(),gate=deferred();let signal,calls=0;
  const page={readerDjvuText:true,getTextContent(options){calls++;signal=options.signal;return gate.promise;}};
  const search=context.loadPdfTextContent(1,page,1);await tick();
  const render=context.loadPdfTextContent(1,page);assert.strictEqual(search,render);
  next();assert.equal(signal.aborted,false);gate.resolve(content('shared'));
  assert.strictEqual(await search,await render);assert.equal(calls,1);
});

test('pdf.js receives no signal and active stale extraction remains shared',async()=>{
  globalThis.matchMedia=()=>({matches:false});
  const {context,next}=setup(),gate=deferred();let args,calls=0;
  const page={getTextContent(...values){args=values;calls++;return gate.promise;}};
  const stale=context.loadPdfTextContent(1,page,1);await tick();next();
  const render=context.loadPdfTextContent(1,page);assert.strictEqual(render,stale);
  assert.deepEqual(args,[]);gate.resolve(content('pdf'));await render;assert.equal(calls,1);
});

function renderSetup(budget) {
  globalThis.matchMedia=()=>({matches:false});
  const {context}=setup(budget), sized=[], rendered=[];
  const estimate=context.estimatePdfTextContentBytes;
  context.estimatePdfTextContentBytes=text=>{sized.push(text);return estimate(text);};
  context.populatePdfTextLayer=(_layer,items)=>rendered.push(items);
  context.highlightPdfText=()=>{};
  const shell=()=>({dataset:{page:'1'},isConnected:true,querySelector:()=>({})});
  const cache=context.pdfTextContentCache;
  const keys=()=>[...cache.keys()];
  return {context,sized,rendered,shell,cache,keys};
}

test('native render sizes a shared extraction once and still refreshes a cache hit after an interleaved touch',async()=>{
  const {context,sized,rendered,shell,cache,keys}=renderSetup(256);
  const text=content('shared native text'), gate=deferred();
  let reads=0;
  const page={getTextContent:()=>{reads++;return gate.promise;},getViewport:()=>({height:200})};
  const search=context.loadPdfTextContent(1,page,1);
  const first=shell(), render=context.renderPdfText(page,first);
  gate.resolve(text);
  assert.strictEqual(await search,text);
  await render;
  assert.equal(first.dataset.textReady,'1');
  assert.equal(reads,1);
  const coldSizes=sized.length;
  assert.equal(context.pdfTextContentCacheBytes,128);

  const record=cache.get(1);
  const second=content('second'), third=content('third');
  context.cachePdfTextContent(2,second);
  const remount=shell(), cachedRender=context.renderPdfText(page,remount);
  assert.strictEqual(context.cachedPdfTextContent(2),second);
  assert.deepEqual(keys(),[1,2]);
  await cachedRender;
  assert.equal(remount.dataset.textReady,'1');
  assert.deepEqual(rendered,[text.items,text.items]);
  assert.equal(reads,1);
  assert.deepEqual(keys(),[2,1]);
  context.cachePdfTextContent(3,third);
  assert.deepEqual(keys(),[1,3]);
  assert.equal(context.pdfTextContentCacheBytes,256);
  assert.equal(coldSizes,1,'shared extraction and initial render size the result once');
  assert.deepEqual(sized,[text,second,third],'remount does not size a resident result again');
  assert.strictEqual(cache.get(1),record);
});

test('native render re-accounts an evicted or replaced result and does not admit oversized text',async()=>{
  const {context,sized,rendered,shell,cache,keys}=renderSetup(128);
  const text=content('original'), other=content('other');
  const page={getTextContent:async()=>text,getViewport:()=>({height:200})};
  await context.loadPdfTextContent(1,page);
  for (const key of [2,1]) {
    const render=context.renderPdfText(page,shell());
    context.cachePdfTextContent(key,other);
    assert.strictEqual(cache.get(key).content,other);
    await render;
    assert.deepEqual(keys(),[1]);
    assert.strictEqual(cache.get(1).content,text);
    assert.equal(context.pdfTextContentCacheBytes,128);
  }
  assert.deepEqual(sized,[text,other,text,other,text]);

  const oversized=content('x'.repeat(65));
  const record=cache.get(1);
  const largeShell=shell();
  largeShell.dataset.page='2';
  await context.renderPdfText({...page,getTextContent:async()=>oversized},largeShell);
  assert.equal(largeShell.dataset.textReady,'1');
  assert.deepEqual(rendered,[text.items,text.items,oversized.items]);
  assert.deepEqual(sized.slice(-2),[oversized,oversized]);
  assert.deepEqual(keys(),[1]);
  assert.strictEqual(cache.get(1),record);
  assert.equal(context.pdfTextContentCacheBytes,128);
});

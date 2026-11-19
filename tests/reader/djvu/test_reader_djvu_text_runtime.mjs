import test from 'node:test';
import assert from 'node:assert/strict';
import {createReaderPdfScheduler} from '../../../static/reader/pdf/reader-pdf-scheduler.mjs';
import {createReaderPdfTextRuntime} from '../../../static/reader/pdf/reader-pdf-text-runtime.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function setup() {
  let generation=1;
  const context={readerAbortController:new AbortController(),pdfTextWaiters:[],pdfActiveTextLoads:0,
    pdfActiveSearchTextLoads:0,pdfTextContentPromises:new Map(),pdfTextContentCache:new Map(),
    pdfTextContentCacheBytes:0,PDF_TEXT_CONTENT_CACHE_BYTES:100000,pdfDocument:null,
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

import assert from 'node:assert/strict';
import test from 'node:test';
import {createReaderLifecycle} from '../../../static/reader/core/reader-lifecycle.mjs';

function fixture() {
  const events = [], lifecycle = {disposed:false, stage:'prepare'};
  const values = new Map();
  const context = {
    readerAbortController:new AbortController(), readerResources:new Set(), readerLifecycle:lifecycle,
    readerRuntime:{state:{lifecycle}, setPhase:phase => { events.push(['phase',phase]); return true; },
      setStage:stage => {events.push(['stage',stage]); return true;},
      nextGeneration:name => {const next=(values.get(name)||0)+1;values.set(name,next);return next;},
      isCurrent:(name,value)=>values.get(name)===value, dispose(){lifecycle.disposed=true;}, fail(code){events.push(['fail',code]);}},
    drainPdfTextWaiters(){events.push('drain');}
  };
  Object.assign(context,createReaderLifecycle(context));
  return {context,events};
}

test('resource ownership, once-only release, abort and throwing cleanup behavior', () => {
  const {context,events}=fixture();
  const untrack=context.trackReaderResource(()=>events.push('removed'));
  assert.equal(untrack(),true);assert.equal(untrack(),false);
  context.trackReaderResource(()=>{events.push('broken');throw Error('cleanup');});
  context.trackReaderResource(()=>events.push('remaining'));
  context.stopReaderWork();
  assert.equal(context.readerAbortController.signal.aborted,true);
  assert.deepEqual(events,['broken','remaining']);
  assert.equal(context.readerResources.size,0);
  const late=context.trackReaderResource(()=>events.push('late'));
  assert.equal(late(),false);assert.equal(events.at(-1),'late');
  assert.throws(()=>context.trackReaderResource(()=>{throw Error('late');}),/late/);
});

test('awaitReader supports immediate values, thenables, cancellation and original errors', async () => {
  const {context}=fixture();
  assert.equal(await context.awaitReader(4),4);
  assert.equal(await context.awaitReader({then(resolve){resolve('thenable');}}),'thenable');
  const marker=new Error('original');await assert.rejects(context.awaitReader(Promise.reject(marker)),value=>value===marker);
  const signal=new AbortController();
  let settle;
  const pending=context.awaitReader(new Promise(resolve=>{settle=resolve;}),signal.signal);
  signal.abort();settle('late');
  await assert.rejects(pending,{name:'AbortError',message:'Reader work cancelled'});
  const cancelled=fixture().context;cancelled.readerAbortController.abort();
  await assert.rejects(cancelled.awaitReader(Promise.resolve('late')),{name:'AbortError'});
});

test('generation ownership drains PDF text only for search and checks abort state', () => {
  const {context,events}=fixture();
  assert.equal(context.nextReaderGeneration('search'),1);assert.deepEqual(events,['drain']);
  assert.equal(context.nextReaderGeneration('navigation'),1);assert.equal(context.isReaderGenerationCurrent('navigation',1),true);
  assert.equal(context.isReaderGenerationCurrent('navigation',0),false);
  context.readerAbortController.abort();assert.equal(context.isReaderGenerationCurrent('navigation',1),false);
});

test('error classification preserves dynamic getter access and uncoerced matching codes', () => {
  const {context}=fixture();
  assert.equal(context.classifyReaderError(null),'READER_PARSE');
  assert.equal(context.classifyReaderError('network problem'),'READER_NETWORK');
  assert.equal(context.classifyReaderError({message:'corrupt EPUB'}),'READER_CORRUPT');
  assert.equal(context.classifyReaderError({code:'READER_PDF_RATE_LIMIT'}),'READER_PDF_TRANSPORT');
  let calls=0;
  const dynamic={get code(){calls++;return calls===1?'x':calls===2?'READER_RESTORE':42;}};
  assert.equal(context.classifyReaderError(dynamic),42);assert.equal(calls,3);
  const broken={get code(){throw Error('getter');}};
  assert.throws(()=>context.classifyReaderError(broken),/getter/);
  assert.equal(context.classifyReaderError({name:'HTTP 503',message:'corrupt'}),'READER_NETWORK');
});

test('navigation warnings require a current generation and ignore aborts', () => {
  const {context}=fixture();const messages=[],warn=console.warn;
  console.warn=(...args)=>messages.push(args);
  try {
    const generation=context.nextReaderGeneration('navigation');
    context.reportNavigationError({name:'AbortError'},generation);
    context.reportNavigationError({name:'Other'},0);
    const error={name:'Other'};context.reportNavigationError(error,generation);
    assert.equal(messages.length,1);assert.deepEqual(messages[0],['Reader navigation failed',error]);
  } finally {console.warn=warn;}
});

test('waitForReader rejects on cancellation and resolves on its timer', async () => {
  const {context}=fixture();
  await context.waitForReader(0);
  const pending=context.waitForReader(5000);
  context.readerAbortController.abort();
  await assert.rejects(pending,{name:'AbortError'});
  await assert.rejects(context.waitForReader(0),{name:'AbortError'});
});

test('reader readiness preserves Foliate anchor only when loading node is connected', () => {
  const {context,events}=fixture();
  context.loadingIndicator={isConnected:true,remove(){events.push('remove');}};
  context.loadingStatus={hidden:false};
  context.foliateScrollAnchors={preserve(callback){events.push('preserve');return callback();}};
  context.capability={mode:'foliate'};context.markReaderContentReady();
  assert.deepEqual(events,['preserve','remove']);assert.equal(context.loadingStatus.hidden,true);
  events.length=0;context.capability={mode:'pdf'};context.markReaderContentReady();
  assert.deepEqual(events,['remove']);
  events.length=0;context.capability=null;context.markReaderContentReady();assert.deepEqual(events,['remove']);
  events.length=0;context.capability={mode:'epub-chapters'};context.markReaderContentReady();
  assert.deepEqual(events,['preserve','remove']);
  events.length=0;context.loadingIndicator.isConnected=false;context.markReaderContentReady();
  assert.deepEqual(events,['remove']);
});

test('phase and stage forward return values unchanged', () => {
  const {context,events}=fixture();
  assert.equal(context.setReaderPhase('ready'),true);
  assert.equal(context.setReaderStage('prepare'),true);
  assert.deepEqual(events,[['phase','ready'],['stage','prepare']]);
});

test('dispose is idempotent, releases observer and clears all timer handles', () => {
  const {context,events}=fixture();
  const store=globalThis.VoiceOfMLReaderStore, oldClear=globalThis.clearTimeout, oldCancel=globalThis.cancelAnimationFrame;
  globalThis.VoiceOfMLReaderStore={dispose(){events.push('store');}};
  globalThis.clearTimeout=handle=>events.push(['clear',handle]);
  globalThis.cancelAnimationFrame=handle=>events.push(['cancel',handle]);
  context.updateDocumentState=value=>events.push(value);
  context.contentSanitizerObserver={disconnect(){events.push('observer');}};
  const handles=['saveTimer','themeAnimationTimer','panelAnimationTimer','markerFrame',
    'foliateScrollFrame','foliateWindowFrame','epubSeekFrame'];
  handles.forEach((key,index)=>context[key]=index+1);
  try {
    context.disposeReader();context.disposeReader();
    assert.deepEqual(events,[{restorationReady:false},'observer',['clear',1],['clear',2],['clear',3],
      ['cancel',4],['cancel',5],['cancel',6],['cancel',7],'store']);
    assert.equal(context.readerLifecycle.disposed,true);
    assert.equal(context.contentSanitizerObserver,null);
    assert.deepEqual(handles.map(key=>context[key]),[0,0,0,0,0,0,0]);
  } finally {globalThis.VoiceOfMLReaderStore=store;globalThis.clearTimeout=oldClear;globalThis.cancelAnimationFrame=oldCancel;}
});

test('failure cleanup preserves message, lifecycle stage and retry control semantics', () => {
  const {context,events}=fixture();
  const oldDocument=globalThis.document,oldWindow=globalThis.window;
  const errorNode={textContent:'',children:[],append(...nodes){this.children.push(...nodes);}};
  const element=tag=>({tag,addEventListener(type,callback){this.event={type,callback};}});
  globalThis.document={createElement:element};globalThis.window={__VOICE_PDF_PRELOAD__:{dispose(){events.push('preload');}}};
  context.updateDocumentState=value=>events.push(value);
  context.setReaderPanelOpen=open=>events.push(['panel',open]);
  context.stopReaderWork=()=>events.push('work');
  context.readerRequestManager={dispose:()=>events.push('requests')};
  context.formatAdapters={dispose:()=>events.push('adapters')};
  context.content={dataset:{},innerHTML:'',querySelector:()=>errorNode};
  context.loadingStatus={hidden:false};context.markReaderContentReady=()=>events.push('ready');
  context.status={textContent:''};
  try {
    context.fail('test','READER_MEDIA');
    assert.deepEqual(events,[{restorationReady:false},['fail','READER_MEDIA'],['panel',false],
      'work','requests','adapters','preload','ready']);
    assert.equal(context.content.dataset.errorCode,'READER_MEDIA');
    assert.equal(errorNode.textContent,'test [prepare]');
    assert.equal(errorNode.children.length,2);assert.equal(errorNode.children[1].event.type,'click');
    assert.equal(context.status.textContent,'无法打开');
    context.readerLifecycle.disposed=true;events.length=0;context.fail('ignored');assert.deepEqual(events,[]);
  } finally {globalThis.document=oldDocument;globalThis.window=oldWindow;}
});

test('retry click waits for progress and reloads only while reader remains live', async () => {
  const {context}=fixture();
  const oldDocument=globalThis.document,oldWindow=globalThis.window,oldLocation=globalThis.location;
  const errorNode={append(_br,retry){this.retry=retry;}};
  globalThis.document={createElement:tag=>({tag,addEventListener(_type,callback){this.callback=callback;}})};
  globalThis.window={};let reloads=0;
  globalThis.location={reload(){reloads++;}};
  let releaseProgress;
  Object.assign(context,{updateDocumentState(){},setReaderPanelOpen(){},stopReaderWork(){},
    readerRequestManager:{dispose(){}},formatAdapters:{dispose(){}},
    content:{dataset:{},querySelector:()=>errorNode},loadingStatus:{},status:{},markReaderContentReady(){},
    progressSaveChain:new Promise(resolve=>{releaseProgress=resolve;})});
  try {
    context.fail('message','READER_MEDIA');
    const retry=errorNode.retry.callback();await new Promise(resolve=>setImmediate(resolve));assert.equal(reloads,0);
    releaseProgress();await retry;assert.equal(reloads,1);
    context.readerLifecycle.disposed=true;
    await errorNode.retry.callback();assert.equal(reloads,1);
  } finally {globalThis.document=oldDocument;globalThis.window=oldWindow;globalThis.location=oldLocation;}
});

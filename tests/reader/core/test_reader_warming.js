const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('static/app.js', 'utf8');
const block = source.slice(source.search(/(?:var|const) warmedReaderAssets =/), source.indexOf('function isReadableRecord'));
const metadataBlock = source.slice(source.indexOf('const readerSessionEntries ='), source.indexOf('function getReaderLink'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(simd = true) {
  let now = 100000;
  const timers = new Map(), calls = [], stored = new Map(), events = {}, links = [], listeners = new Map();
  const addEventListener = (name, listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(listener);
    events[name] = (...args) => { for (const fn of [...listeners.get(name)]) fn(...args); };
  };
  const removeEventListener = (name, listener) => listeners.get(name)?.delete(listener);
  const resourceContext = {WebAssembly:{validate:()=>simd}};
  vm.runInNewContext(fs.readFileSync('static/reader-resources.js','utf8'),resourceContext);
  class Element {}
  class HTMLElement extends Element {}
  const context = {URL, Map, Set, Promise, AbortController, AbortSignal, DOMException, encodeURIComponent, Element, HTMLElement,
    VoiceOfMLReaderResources: resourceContext.VoiceOfMLReaderResources,
    Date: {now: () => now}, API_BASE: 'https://api.test', location:{origin:'https://site.test'},
    navigator:{onLine:true}, document:{hidden:false,createElement:()=>({addEventListener(){},remove(){}}),head:{appendChild:link=>links.push(link)},
      addEventListener,removeEventListener},
    window:{addEventListener,removeEventListener},
    sessionStorage:{get length(){return stored.size;},key:i=>[...stored.keys()][i],
      getItem:key=>stored.get(key)||null,removeItem:key=>stored.delete(key),
      setItem:(key,value)=>stored.set(key,value)},warmConnection(){},
    setTimeout:fn=>{const id={};timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    fetch:(url,options={})=>new Promise((resolve,reject)=>{
      calls.push({url,options,resolve,reject});
      options.signal?.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')));
    })};
  vm.createContext(context);vm.runInContext(metadataBlock+block+'\nsetupReaderIntentWarming();',context);
  return {context,calls,stored,events,timers,links,run:code=>vm.runInContext(code,context),advance:(ms=5001)=>{now+=ms;}};
}
(async()=>{
  const engineCalls = f => f.calls.filter(call=>call.url.endsWith('.wasm') || call.url.endsWith('pdf-worker-wrapper.mjs'));
  for (const simd of [true,false]) {
    const selected=fixture(simd);
    selected.run(`warmReaderIntent('/reader?ext=djvu');warmReaderIntent('/reader?ext=djv')`);
    const calls=engineCalls(selected);
    assert.strictEqual(calls.length,1,'one selected decoder per intent, aliases coalesce');
    assert.ok(calls[0].url.includes('/'+(simd?'simd128':'scalar')+'/djvu_rs_bg.wasm'));
    assert.strictEqual(calls[0].options.mode,'cors');
    assert.strictEqual(calls[0].options.credentials,'same-origin');
    assert.ok(!selected.links.some(link=>link.href.includes('/djvu-rs-reader/') || link.href.endsWith('.wasm')));
    calls[0].resolve(new Response(new Uint8Array(813837)));await tick();
    assert.strictEqual(selected.run('readerAssetWarmups.size'),0,'consume complete body before releasing ownership');
    selected.run(`warmReaderIntent('/reader?ext=djvu')`);
    assert.strictEqual(engineCalls(selected).length,1,'successful bytes deduplicate');
  }
  for (const event of ['pagehide','offline','visibilitychange','timeout']) {
    const f=fixture();f.run(`warmReaderIntent('/reader?ext=djvu')`);
    const old=engineCalls(f)[0];
    if(event==='timeout')for(const fn of [...f.timers.values()])fn();
    else {if(event==='visibilitychange')f.context.document.hidden=true;f.events[event]();}
    assert.ok(old.options.signal.aborted);
    f.context.document.hidden=false;
    f.run(`warmReaderIntent('/reader?ext=djvu')`);
    const next=engineCalls(f)[1];assert.ok(next,'cancelled bytes may immediately retry');
    await tick();assert.strictEqual(f.run('readerAssetWarmups.size'),1,'old rejection cannot release new owner');
    next.resolve(new Response('bytes'));await tick();
    assert.strictEqual(f.run('readerAssetWarmups.size'),0);
  }
  for(const response of [new Response('',{status:503}),new Response('x',{headers:{'content-length':1048577}}),new Response(new Uint8Array(1048577))]) {
    const f=fixture();f.run(`warmReaderIntent('/reader?ext=djvu')`);
    engineCalls(f)[0].resolve(response);await tick();
    assert.strictEqual(f.run('readerAssetWarmups.size'),0);
    f.run(`warmReaderIntent('/reader?ext=djvu')`);assert.strictEqual(engineCalls(f).length,2,'failed or oversized bytes retry');
    f.events.pagehide();await tick();
  }
  const pdf=fixture();pdf.run(`warmReaderIntent('/reader?ext=pdf');warmReaderIntent('/reader?ext=pdf')`);
  assert.strictEqual(engineCalls(pdf).length,2);
  assert.ok(engineCalls(pdf).every(call=>call.options.mode==='same-origin' && call.options.credentials==='same-origin'));
  assert.ok(!pdf.links.some(link=>link.href.endsWith('.wasm') || link.href.endsWith('pdf-worker-wrapper.mjs')));
  pdf.events.pagehide();await tick();
  const lean=fixture();lean.context.navigator.connection={saveData:true};lean.run(`warmReaderIntent('/reader?ext=djvu')`);
  assert.strictEqual(engineCalls(lean).length,0);
  lean.run(`warmReaderIntent('/reader?ext=pdf')`);
  assert.strictEqual(engineCalls(lean).length,1,'saveData retains PDF wrapper warming');
  assert.ok(engineCalls(lean)[0].url.endsWith('pdf-worker-wrapper.mjs'));
  lean.events.pagehide();await tick();
  const controlled=fixture();controlled.context.navigator.serviceWorker={controller:{}};
  controlled.run(`warmReaderIntent('/reader?ext=djvu')`);
  const wasm=engineCalls(controlled)[0];
  assert.strictEqual(wasm.options.cache,undefined,'ordinary fetch remains eligible for HTTP/SW cache reuse');
  const shell=controlled.calls.find(call=>call.url.endsWith('/reader.js'));
  assert.ok(shell,'controlled shell still populates the existing SW cache path');
  shell.resolve({ok:true,arrayBuffer:async()=>new ArrayBuffer(0)});await tick();
  assert.ok(controlled.links.some(link=>link.href===shell.url));
  controlled.events.pagehide();await tick();
  console.log('format warming: selected SIMD/scalar bytes, request identity, bounded reads, cancellation, retry, SW routing and deduplication passed');
  const f=fixture();f.run('warmReaderIntent("/reader?id=one&ext=txt");warmReaderIntent("/reader?id=one&ext=txt")');
  const first=f.calls.find(call=>call.url.includes('reader-resolve'));
  assert.strictEqual(first.url,'https://api.test/api/reader-resolve?id=one');
  first.resolve({ok:true,json:()=>new Promise(()=>{})});await tick();
  for(const timer of [...f.timers.values()])timer();await tick();
  assert.strictEqual(f.run('readerWarmupInFlight'),0,'stalled JSON must release the warming slot');
  assert.ok(first.options.signal.aborted);
  assert.strictEqual(f.run('warmedReaderSources.size'),0);
  f.run('warmReaderIntent("/reader?id=one&ext=txt")');
  assert.strictEqual(f.calls.filter(call=>call.url.includes('reader-resolve')).length,1,'failure must back off');
  f.advance();f.run('warmReaderIntent("/reader?id=one&ext=txt")');
  f.calls.at(-1).resolve({ok:true,json:async()=>({url:'https://source.test/book'})});await tick();
  assert.strictEqual(f.run('readerWarmupInFlight'),0);
  assert.ok(f.stored.has('reader-resolve:one'));
  assert.strictEqual(f.run('warmedReaderSources.size'),1);
  console.log('reader warming: whole-body deadline, coalescing, backoff and successful retry passed');

  for(const response of [{ok:false},{ok:true,json:async()=>({error:'bad'})}]) {
    const t=fixture();t.run('warmReaderIntent("/reader?id=bad&ext=txt")');
    t.calls.find(call=>call.url.includes('reader-resolve')).resolve(response);await tick();
    assert.strictEqual(t.run('warmedReaderSources.size'),0);assert.strictEqual(t.run('readerWarmupInFlight'),0);
  }
  for(const event of ['pagehide','offline','visibilitychange']) {
    const t=fixture();t.run('warmReaderIntent("/reader?id=old&ext=txt")');
    const pending=t.calls.find(call=>call.url.includes('reader-resolve'));
    let resolveBody;pending.resolve({ok:true,json:()=>new Promise(resolve=>resolveBody=resolve)});await tick();
    if(event==='visibilitychange')t.context.document.hidden=true;
    t.events[event]();await tick();assert.ok(pending.options.signal.aborted);
    resolveBody({url:'https://source.test/stale'});await tick();assert.strictEqual(t.stored.size,0);
    assert.strictEqual(t.run('readerWarmupInFlight'),0);
  }
  const t=fixture();t.context.document.hidden=true;t.run('warmReaderIntent("/reader?id=x")');
  t.context.document.hidden=false;t.context.navigator.onLine=false;t.run('warmReaderIntent("/reader?id=x")');
  assert.strictEqual(t.calls.length,0);
  t.context.navigator.onLine=true;
  for(let i=0;i<9;i++) {
    t.run(`warmReaderIntent('/reader?url=https://source.test/${i}')`);
    t.calls.at(-1).resolve({ok:true});await tick();
    assert.ok(t.run('warmedReaderSources.size')<=8);
  }
  const sourceCalls=t.calls.filter(call=>call.options.method==='HEAD');
  assert.strictEqual(sourceCalls.length,9);assert.ok(sourceCalls.every(call=>call.options.method==='HEAD'));
  assert.strictEqual(t.run('warmedReaderSources.size'),8);
  assert.strictEqual(t.timers.size,1,'the delayed shell warmup remains scheduled');
  console.log('reader warming: cancellation, stale responses, invalid metadata and ninth HEAD warmup passed');

  // Exercise the actual delegated events, not only the helper. Hover is
  // speculative; pointer and keyboard intent may replace a different hover.
  const emitIntent = (fixture, type, id, download = false) => {
    const target = Object.assign(new fixture.context.HTMLElement(), {dataset:{readerUrl:'/reader?id='+id+'&ext=pdf'}});
    const eventTarget = Object.assign(new fixture.context.Element(), {closest:selector =>
      selector.includes('data-download') ? (download ? target : null) : target});
    fixture.events[type]({type, target:eventTarget});
  };
  const resolverCalls = fixture => fixture.calls.filter(call=>call.url.includes('/api/reader-resolve'));
  const priority=fixture();
  priority.events.pointerover({type:'pointerover', target:{closest(){throw new Error('non-element target');}}});
  assert.strictEqual(resolverCalls(priority).length,0,'non-element events must not warm');
  emitIntent(priority,'pointerover','old');
  const old=resolverCalls(priority)[0];
  emitIntent(priority,'pointerover','other');
  emitIntent(priority,'focusin','old');
  emitIntent(priority,'pointerdown','old');
  assert.strictEqual(resolverCalls(priority).length,1,'hover changes and same-book intent coalesce');
  assert.ok(!old.options.signal.aborted);
  let finishOld;
  old.resolve({ok:true,json:()=>new Promise(resolve=>finishOld=resolve)});await tick();
  emitIntent(priority,'pointerdown','new');
  const next=resolverCalls(priority)[1];
  assert.ok(old.options.signal.aborted,'active intent must abort the previous speculative request');
  assert.ok(next.url.endsWith('id=new'));
  assert.strictEqual(priority.run('readerWarmupInFlight'),1);
  assert.strictEqual(priority.run('readerWarmupRetryAt.size'),0,'superseded work is not a failure');
  finishOld({url:'https://source.test/stale'});await tick();
  assert.strictEqual(priority.stored.has('reader-resolve:old'),false,'late old JSON cannot enter cache');
  assert.strictEqual(priority.run('readerWarmupInFlight'),1,'late completion cannot release new task');
  next.resolve({ok:true,json:async()=>({url:'https://source.test/new'})});await tick();
  assert.ok(priority.stored.has('reader-resolve:new'));
  emitIntent(priority,'pointerover','old');
  const retried=resolverCalls(priority)[2];
  assert.ok(retried.url.endsWith('id=old'),'superseded book can immediately be warmed again');
  emitIntent(priority,'focusin','keyboard');
  assert.ok(retried.options.signal.aborted);
  assert.ok(resolverCalls(priority)[3].url.endsWith('id=keyboard'),'keyboard focus is urgent');
  emitIntent(priority,'pointerdown','download',true);
  assert.strictEqual(resolverCalls(priority).length,4,'download actions never preempt');
  priority.events.offline();await tick();
  assert.strictEqual(priority.run('readerWarmupInFlight'),0);
  assert.ok(priority.run('readerWarmupRetryAt.has("id:keyboard")'),'offline cancellation retains backoff');

  const reentrant=fixture();
  emitIntent(reentrant,'pointerover','owner');
  const owner=resolverCalls(reentrant)[0];
  // Abort dispatches listeners synchronously; a different intent can claim
  // the slot before the original activation finishes handling cancellation.
  owner.options.signal.addEventListener('abort',()=>emitIntent(reentrant,'focusin','reentrant'),{once:true});
  emitIntent(reentrant,'pointerdown','outer');
  const reentrantCalls=resolverCalls(reentrant);
  assert.strictEqual(reentrantCalls.length,2,'abort listener may claim the only slot');
  assert.ok(owner.options.signal.aborted && reentrantCalls[1].url.endsWith('id=reentrant'));
  assert.strictEqual(reentrant.run('readerWarmupPending.key'),'id:reentrant');
  reentrantCalls[1].resolve({ok:true,json:async()=>({url:'https://source.test/reentrant'})});await tick();
  assert.strictEqual(reentrant.run('readerWarmupInFlight'),0);

  const rapid=fixture();
  emitIntent(rapid,'pointerover','rapid0');
  for(let i=1;i<=20;i++)emitIntent(rapid,'pointerdown','rapid'+i);
  const rapidCalls=resolverCalls(rapid);
  assert.strictEqual(rapidCalls.length,21);
  assert.ok(rapidCalls.slice(0,-1).every(call=>call.options.signal.aborted));
  assert.ok(!rapidCalls.at(-1).options.signal.aborted);
  assert.strictEqual(rapid.run('readerWarmupInFlight'),1);
  assert.strictEqual(rapid.run('readerWarmupRetryAt.size'),0);
  rapidCalls.at(-1).resolve({ok:true,json:async()=>({url:'https://source.test/final'})});
  await tick();
  assert.ok(rapid.stored.has('reader-resolve:rapid20'));
  assert.strictEqual(rapid.run('readerWarmupInFlight'),0);

  const sources=fixture();
  sources.run(`warmReaderIntent('/reader?url=https://source.test/hover');
    warmReaderIntent('/reader?url=https://source.test/activate',true)`);
  const heads=sources.calls.filter(call=>call.options.method==='HEAD');
  assert.strictEqual(heads.length,2);
  assert.ok(heads[0].options.signal.aborted);
  assert.ok(heads[1].url.includes(encodeURIComponent('https://source.test/activate')));
  heads[1].resolve({ok:true});await tick();
  assert.strictEqual(sources.run('readerWarmupInFlight'),0);
  assert.strictEqual(sources.run('warmedReaderSources.size'),1);

  const capacity=fixture();
  for(let i=0;i<8;i++) {
    emitIntent(capacity,'pointerover','done'+i);
    resolverCalls(capacity).at(-1).resolve({ok:true,json:async()=>({url:'https://source.test/'+i})});await tick();
  }
  capacity.run(`warmReaderIntent('/reader?url=https://source.test/busy')`);
  const capacityBusy=capacity.calls.find(call=>call.options.method==='HEAD');
  emitIntent(capacity,'focusin','limit');
  assert.ok(capacityBusy.options.signal.aborted);
  assert.strictEqual(resolverCalls(capacity).length,9,'full success cache must allow urgent work');
  await tick();
  assert.strictEqual(capacity.run('readerWarmupPending.key'),'id:limit','old rejection cannot release the urgent owner');
  resolverCalls(capacity).at(-1).resolve({ok:true,json:async()=>({url:'https://source.test/limit'})});await tick();
  assert.strictEqual(capacity.run('readerWarmupInFlight'),0);
  assert.strictEqual(capacity.run('warmedReaderSources.size'),8);

  const timeout=fixture();
  emitIntent(timeout,'pointerover','timed-out');
  // Browsers normally pass no argument, but timer shims may provide one.
  // Such a callback argument must not accidentally mark a timeout superseded.
  for (const timer of [...timeout.timers.values()]) timer({simulatedTimer:true});
  await tick();
  assert.strictEqual(timeout.run('readerWarmupInFlight'),0);
  assert.ok(timeout.run('readerWarmupRetryAt.has("id:timed-out")'));

  const previous=fixture();
  emitIntent(previous,'pointerover','failed');
  resolverCalls(previous)[0].resolve({ok:false});await tick();
  emitIntent(previous,'pointerover','busy');
  const busy=resolverCalls(previous)[1];
  emitIntent(previous,'pointerdown','failed');
  assert.ok(busy.options.signal.aborted,'even a backed-off target should cancel unrelated speculation');
  assert.strictEqual(resolverCalls(previous).length,2,'priority does not bypass retry backoff');
  assert.strictEqual(previous.run('readerWarmupInFlight'),0);
  previous.advance();emitIntent(previous,'focusin','failed');
  assert.strictEqual(resolverCalls(previous).length,3);
  resolverCalls(previous)[2].resolve({ok:true,json:async()=>({url:'https://source.test/failed'})});await tick();
  emitIntent(previous,'pointerover','busy-again');
  const busyAgain=resolverCalls(previous)[3];
  emitIntent(previous,'focusin','failed');
  assert.ok(busyAgain.options.signal.aborted,'a cached target still cancels unrelated speculation');
  assert.strictEqual(resolverCalls(previous).length,4,'priority does not repeat a successful warmup');
  console.log('reader warming: delegated intent preemption, stale responses, limits and backoff passed');

  const warmBook = async (fixture, id) => {
    const before=resolverCalls(fixture).length;
    emitIntent(fixture,'pointerover',id);
    assert.strictEqual(resolverCalls(fixture).length,before+1,'new warmup starts synchronously');
    resolverCalls(fixture).at(-1).resolve({ok:true,json:async()=>({url:'https://source.test/'+id})});await tick();
  };
  const lru=fixture();
  for(let i=0;i<8;i++)await warmBook(lru,'book'+i);
  emitIntent(lru,'pointerover','book0');
  assert.strictEqual(resolverCalls(lru).length,8,'successful same-book hover is deduplicated');
  await warmBook(lru,'book8');
  assert.ok(lru.run('warmedReaderSources.has("id:book0")'),'a cache hit updates recency');
  assert.ok(!lru.run('warmedReaderSources.has("id:book1")'),'ninth success evicts least recently used');
  await warmBook(lru,'book1');
  for(let i=9;i<80;i++) {
    await warmBook(lru,'book'+i);
    assert.strictEqual(lru.run('warmedReaderSources.size'),8,'success state remains bounded');
  }

  const expiry=fixture();
  await warmBook(expiry,'expires');
  expiry.advance(299999);
  emitIntent(expiry,'focusin','expires');
  assert.strictEqual(resolverCalls(expiry).length,1,'metadata stays warm before five minutes');
  expiry.advance(1);
  await warmBook(expiry,'expires');
  assert.strictEqual(expiry.run('warmedReaderSources.size'),1,'hits must not extend metadata freshness');
  expiry.advance(300000);
  await warmBook(expiry,'fresh');
  assert.ok(!expiry.run('warmedReaderSources.has("id:expires")'),'unvisited expired state is pruned');
  const headCount=()=>t.calls.filter(call=>call.options.method==='HEAD').length;
  t.run(`warmReaderIntent('/reader?url=https://source.test/8')`);
  assert.strictEqual(headCount(),9,'HEAD success also deduplicates');
  t.advance(300000);t.run(`warmReaderIntent('/reader?url=https://source.test/8')`);
  assert.strictEqual(headCount(),10,'HEAD success also expires');
  t.calls.at(-1).resolve({ok:true});await tick();

  const consumed=fixture();
  await warmBook(consumed,'consumed');
  consumed.run(fs.readFileSync('static/reader/core/reader-bindings.mjs','utf8').replace(/^export /m,''));
  const metadata=consumed.run(`(() => {
    const context={readerId:'consumed'};
    createReaderBindings(context).applySourceSessionAndCachedMetadata();
    return context.resolvedReaderData;
  })()`);
  assert.strictEqual(metadata.url,'https://source.test/consumed');
  assert.ok(!consumed.stored.has('reader-resolve:consumed'),'actual Reader binding consumes metadata');
  await warmBook(consumed,'consumed');
  assert.ok(consumed.stored.has('reader-resolve:consumed'),'returning to a consumed book refills metadata');
  emitIntent(consumed,'pointerover','consumed');
  assert.strictEqual(resolverCalls(consumed).length,2,'refilled metadata deduplicates again');

  for(const failure of ['write','read','access']) {
    const unavailable=fixture();
    if(failure==='access') Object.defineProperty(unavailable.context,'sessionStorage',{
      get(){throw new Error('Storage disabled');}
    });
    else unavailable.context.sessionStorage[failure==='write'?'setItem':'getItem']=()=>{throw new Error('Storage disabled');};
    await warmBook(unavailable,'unavailable');
    for(let i=0;i<10;i++)emitIntent(unavailable,'pointerover','unavailable');
    assert.strictEqual(resolverCalls(unavailable).length,1,'unavailable storage must retain in-memory deduplication');
    unavailable.advance(300000);
    await warmBook(unavailable,'unavailable');
  }
  const temporarilyBlocked=fixture();
  await warmBook(temporarilyBlocked,'blocked');
  const getItem=temporarilyBlocked.context.sessionStorage.getItem;
  temporarilyBlocked.context.sessionStorage.getItem=()=>{throw new Error('Storage disabled');};
  emitIntent(temporarilyBlocked,'pointerover','blocked');
  assert.strictEqual(resolverCalls(temporarilyBlocked).length,1,'read failure is not consumption');
  temporarilyBlocked.context.sessionStorage.getItem=getItem;
  temporarilyBlocked.stored.delete('reader-resolve:blocked');
  await warmBook(temporarilyBlocked,'blocked');

  const backoff=fixture();
  emitIntent(backoff,'pointerover','retry');
  resolverCalls(backoff)[0].resolve({ok:false});await tick();
  backoff.advance(4999);emitIntent(backoff,'focusin','retry');
  assert.strictEqual(resolverCalls(backoff).length,1);
  backoff.advance(1);await warmBook(backoff,'retry');
  for(let i=0;i<70;i++) {
    emitIntent(backoff,'pointerover','failure'+i);
    resolverCalls(backoff).at(-1).resolve({ok:false});await tick();
  }
  assert.strictEqual(backoff.run('readerWarmupRetryAt.size'),64,'failure state remains bounded');
  console.log('reader warming: LRU, ninth book, five-minute TTL, actual Reader consumption, storage failures and bounded backoff passed');

  const cache=fixture();
  cache.stored.set('reader-navigation-current','keep');
  for(let i=0;i<1000;i++) cache.stored.set('reader-source:legacy'+i,'x'.repeat(2000));
  cache.run(`for(let i=0;i<10000;i++) cacheReaderMetadata(String(i),{url:'https://source.test/'+i},true)`);
  assert.ok(cache.stored.size<=257);
  assert.strictEqual(cache.stored.get('reader-navigation-current'),'keep');
  assert.ok(!cache.stored.has('reader-source:legacy0'));
  assert.ok(cache.stored.has('reader-source:9999') && cache.stored.has('reader-resolve:9999'));
  cache.run(`cacheReaderMetadata('9872',{url:'recent'},true);cacheReaderMetadata('new',{url:'new'},true)`);
  assert.ok(cache.stored.has('reader-source:9872'),'revisited books must survive oldest-first eviction');
  cache.run(`for(let i=0;i<100;i++) cacheReaderMetadata('large'+i,{url:'x'.repeat(5000)},true)`);
  assert.ok([...cache.stored].reduce((n,[k,v])=>n+2*(k.length+v.length),0)<=512*1024+100);
  const setItem=cache.context.sessionStorage.setItem;
  cache.context.sessionStorage.setItem=(key,value)=>{
    if(cache.stored.size>5) throw new Error('QuotaExceededError');
    setItem(key,value);
  };
  cache.run(`cacheReaderMetadata('quota',{url:'latest'},true)`);
  assert.ok(cache.stored.has('reader-source:quota') && cache.stored.has('reader-resolve:quota'));
  assert.strictEqual(cache.stored.get('reader-navigation-current'),'keep');
  cache.context.sessionStorage.setItem=()=>{throw new Error('Storage disabled');};
  assert.doesNotThrow(()=>cache.run(`cacheReaderMetadata('disabled',{url:'latest'},true)`));
  console.log('reader metadata: legacy cleanup, count/byte bounds, recency, quota retry and unavailable storage passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

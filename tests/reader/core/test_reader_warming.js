const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('static/app.js', 'utf8');
const block = source.slice(source.search(/(?:var|const) warmedReaderAssets =/), source.indexOf('function isReadableRecord'));
const metadataBlock = source.slice(source.indexOf('const readerSessionEntries ='), source.indexOf('function getReaderLink'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let now = 100000;
  const timers = new Map(), calls = [], stored = new Map(), events = {};
  const addEventListener = (name, listener) => {
    const previous = events[name];
    events[name] = previous
      ? (...args) => { previous(...args); listener(...args); }
      : listener;
  };
  const context = {URL, Map, Set, Promise, AbortController, AbortSignal, DOMException, encodeURIComponent,
    VoiceOfMLReaderResources: require('../../../static/reader-resources.js'),
    Date: {now: () => now}, API_BASE: 'https://api.test', location:{origin:'https://site.test'},
    navigator:{onLine:true}, document:{hidden:false,createElement:()=>({addEventListener(){},remove(){}}),head:{appendChild(){}},
      addEventListener},
    window:{addEventListener},
    sessionStorage:{get length(){return stored.size;},key:i=>[...stored.keys()][i],
      getItem:key=>stored.get(key)||null,removeItem:key=>stored.delete(key),
      setItem:(key,value)=>stored.set(key,value)},warmConnection(){},
    setTimeout:fn=>{const id={};timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    fetch:(url,options={})=>new Promise((resolve,reject)=>{
      calls.push({url,options,resolve,reject});
      options.signal?.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')));
    })};
  vm.createContext(context);vm.runInContext(metadataBlock+block+'\nsetupReaderIntentWarming();',context);
  return {context,calls,stored,events,timers,run:code=>vm.runInContext(code,context),advance:()=>{now+=5001;}};
}
(async()=>{
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
    if(i<8){t.calls.at(-1).resolve({ok:true});await tick();}
  }
  const sourceCalls=t.calls.filter(call=>call.options.method==='HEAD');
  assert.strictEqual(sourceCalls.length,8);assert.ok(sourceCalls.every(call=>call.options.method==='HEAD'));
  assert.strictEqual(t.timers.size,1,'the delayed shell warmup remains scheduled');
  console.log('reader warming: cancellation, stale responses, invalid metadata, HEAD and eight-source bound passed');

  // Exercise the actual delegated events, not only the helper. Hover is
  // speculative; pointer and keyboard intent may replace a different hover.
  const emitIntent = (fixture, type, id, download = false) => {
    const target = {dataset:{readerUrl:'/reader?id='+id+'&ext=pdf'}};
    fixture.events[type]({type, target:{closest:selector =>
      selector.includes('data-download') ? (download ? target : null) : target}});
  };
  const resolverCalls = fixture => fixture.calls.filter(call=>call.url.includes('/api/reader-resolve'));
  const priority=fixture();
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
  capacity.run(`warmReaderIntent('/reader?url=https://source.test/busy')`);
  capacity.run(`for(let i=0;i<8;i++)warmedReaderSources.add('id:done'+i)`);
  emitIntent(capacity,'focusin','limit');
  assert.ok(capacity.calls.find(call=>call.options.method==='HEAD').options.signal.aborted);
  assert.strictEqual(resolverCalls(capacity).length,0,'urgent work still honors the eight-source bound');
  assert.strictEqual(capacity.run('readerWarmupInFlight'),0);

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

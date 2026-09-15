const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('static/app.js', 'utf8');
const block = source.slice(source.search(/(?:var|const) warmedReaderAssets =/), source.indexOf('function isReadableRecord'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let now = 100000;
  const timers = new Map(), calls = [], stored = new Map(), events = {};
  const context = {URL, Map, Set, Promise, AbortController, DOMException, encodeURIComponent,
    Date: {now: () => now}, API_BASE: 'https://api.test', location:{origin:'https://site.test'},
    navigator:{onLine:true}, document:{hidden:false,createElement:()=>({}),head:{appendChild(){}},
      addEventListener:(name,fn)=>events[name]=fn},
    window:{addEventListener:(name,fn)=>events[name]=fn},
    sessionStorage:{setItem:(key,value)=>stored.set(key,value)},warmConnection(){},
    setTimeout:fn=>{const id={};timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    fetch:(url,options={})=>new Promise((resolve,reject)=>{
      calls.push({url,options,resolve,reject});
      options.signal?.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')));
    })};
  vm.createContext(context);vm.runInContext(block+'\nsetupReaderIntentWarming();',context);
  return {context,calls,stored,events,timers,run:code=>vm.runInContext(code,context),advance:()=>{now+=5001;}};
}
(async()=>{
  const f=fixture();f.run('warmReaderIntent("/reader?id=one&ext=txt");warmReaderIntent("/reader?id=one&ext=txt")');
  const first=f.calls.find(call=>call.url.includes('reader-resolve'));
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
  assert.strictEqual(t.calls.length,8);assert.ok(t.calls.every(call=>call.options.method==='HEAD'));
  assert.strictEqual(t.timers.size,0);
  console.log('reader warming: cancellation, stale responses, invalid metadata, HEAD and eight-source bound passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

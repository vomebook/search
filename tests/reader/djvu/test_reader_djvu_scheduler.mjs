import assert from "node:assert/strict";
import { createDjvuScheduler } from "../../../static/reader/pdf/reader-djvu-scheduler.mjs";

const gates = new Map(), started = [], closed = [];
const decoder = {
  page(n) { started.push(n); return new Promise((resolve, reject) => gates.set(n, { resolve, reject })); },
  close() { closed.push(true); }
};
const scheduler = createDjvuScheduler(decoder, { maxBytes: 12, maxPages: 2 });
const image = n => ({ image: { data: new Uint8ClampedArray(4).fill(n) } });
const tick = () => new Promise(resolve => setImmediate(resolve));

const one = scheduler.request(1, 0); await tick();
const cancelled = new AbortController();
const stale = scheduler.request(2, 0, { signal: cancelled.signal }); stale.catch(() => {});
const demand = scheduler.request(5, 3);
const duplicate = scheduler.request(5, 1);
cancelled.abort(); await assert.rejects(stale, { name: "AbortError" });
gates.get(1).resolve(image(1)); await one; await tick();
assert.deepEqual(started, [1, 5], "canceled queued work must not delay demanded pages");
gates.get(5).resolve(image(5));
assert.strictEqual(await demand, await duplicate, "concurrent demand shares one decode");
await tick();
assert.equal((await scheduler.request(1, 3)).image.data[0], 1);
const three = scheduler.request(3, 3); await tick(); gates.get(3).resolve(image(3)); await three; await tick();
assert.deepEqual(scheduler.stats().pages, [1, 3]);
assert.equal(scheduler.stats().retainedBytes, 8);

const activeCancel = new AbortController();
const active = scheduler.request(4, 0, { signal: activeCancel.signal }); active.catch(() => {});
await tick(); activeCancel.abort(); await assert.rejects(active, { name: "AbortError" });
const queued = scheduler.request(6, 3); await tick();
gates.get(4).resolve(image(4)); await tick();
assert.deepEqual(started, [1, 5, 3, 4, 6]);
assert.ok(!scheduler.stats().pages.includes(4), "orphaned decode must not occupy cache");
scheduler.close(); await assert.rejects(queued, { name: "AbortError" });
assert.equal(closed.length, 1);
assert.equal(scheduler.stats().retainedBytes, 0);
await assert.rejects(scheduler.request(1), { name: "AbortError" });
{
  let count = 0;
  const oversized = createDjvuScheduler({ page: async n => { count++; return image(n); }, close() {} },
    { maxBytes: 1, maxPages: 1 });
  const first = oversized.request(8, 3);
  const nested = first.then(() => oversized.request(8, 3));
  assert.equal((await nested).image.data[0], 8);
  assert.equal(count, 1, 'immediate duplicate of oversized decode must settle without another decode');
  await tick();
  assert.equal(oversized.stats().retainedBytes, 0, 'oversized page is not permanently cached');
  oversized.close();
}
{
  let started = 0;
  const immediate = createDjvuScheduler({page:async()=>{started++;return image(1);},close(){}}, {maxBytes:4,maxPages:1});
  const task=immediate.request(1);task.catch(()=>{});immediate.close();
  await assert.rejects(task,{name:'AbortError'});await tick();
  assert.equal(started,0,'close before dispatch must not run a decoder command');
}
{
  const work=[], hold=deferred => new Promise(resolve=>deferred(resolve));
  let release;
  const mixed=createDjvuScheduler({page:n=>{work.push(`page:${n}`);return hold(r=>release=r);},
    geometry:async n=>{work.push(`geometry:${n}`);return {width:1};},
    text:async n=>{work.push(`text:${n}`);return {text:'text'};},close(){}},{maxBytes:4,maxPages:1});
  const page=mixed.request(1,3);await tick();
  const text=mixed.requestMetadata('text',2,-1),geometry=mixed.requestMetadata('geometry',2,2);
  mixed.cancelSpeculation();release(image(1));await page;
  assert.deepEqual(await geometry,{width:1});assert.deepEqual(await text,{text:'text'});
  assert.deepEqual(work,['page:1','geometry:2','text:2']);mixed.close();
}
{
  // Geometry shares one worker command, but cancellation is per consumer.
  const starts = [], gates = new Map();
  let closes = 0;
  const s = createDjvuScheduler({geometry: n => {
    starts.push(n);
    return new Promise(resolve => gates.set(n, resolve));
  }, close() { closes++; }});
  const request = (page, priority, signal) => s.requestMetadata('geometry', page, priority, {signal});
  const beforeDispatch = new AbortController();
  const undispatched = request(1, 3, beforeDispatch.signal);
  beforeDispatch.abort();
  await assert.rejects(undispatched, {name: 'AbortError'});
  const reason = new Error('already cancelled');
  await assert.rejects(request(1, 3, AbortSignal.abort(reason)), error => error === reason);
  await tick();
  assert.deepEqual(starts, [], 'geometry selected but not dispatched must be skipped');

  const duringRead = new AbortController();
  const running = request(2, 3, duringRead.signal);
  await tick();
  duringRead.abort();
  await assert.rejects(running, {name: 'AbortError'});
  const joined = request(2, 2);
  const cancel = new AbortController();
  const dropped = request(3, 3, cancel.signal), promoted = request(4, 3, cancel.signal);
  const survivor = request(4, 0), destination = request(5, 3);
  cancel.abort();
  await Promise.all([assert.rejects(dropped, {name: 'AbortError'}), assert.rejects(promoted, {name: 'AbortError'})]);
  assert.equal(s.stats().queued, 2, 'orphaned queued geometry is removed immediately');
  assert.deepEqual(starts, [2], 'cancel does not run a second command while the first owns the worker');
  assert.equal(closes, 0, 'cancel does not close the worker');
  gates.get(2)({width: 2});
  assert.deepEqual(await joined, {width: 2});
  await tick();
  assert.deepEqual(starts, [2, 5], 'destination outranks the surviving low-priority client');
  gates.get(5)({width: 5});
  await destination;
  await tick();
  assert.deepEqual(starts, [2, 5, 4]);
  gates.get(4)({width: 4});
  assert.deepEqual(await survivor, {width: 4});
  s.close();
  assert.equal(closes, 1);
}
// Typed scheduler contracts exercise real queue ownership: deduplicated
// metadata/outline, priority, cancellation, failures and close settlement.
{
  for (const options of [{maxBytes:0},{maxBytes:1.5},{maxPages:0},{maxPages:1.5}])
    assert.throws(()=>createDjvuScheduler(decoder,options),/DJVU_CACHE_LIMIT_INVALID/);
  const closedBefore=new AbortController();closedBefore.abort();
  const s=createDjvuScheduler({page:async n=>image(n),close(){}},{maxBytes:8,maxPages:2});
  await assert.rejects(s.request(0),/DJVU_PAGE_INVALID/);
  await assert.rejects(s.request(NaN),/DJVU_PAGE_INVALID/);
  await assert.rejects(s.request(1,0,{signal:closedBefore.signal}),{name:'AbortError'});
  await assert.rejects(s.requestMetadata('wrong',1),/DJVU_PAGE_INVALID/);
  await assert.rejects(s.requestMetadata('geometry',0),/DJVU_PAGE_INVALID/);
  s.close();s.close();
  await assert.rejects(s.requestMetadata('text',1),{name:'AbortError'});
  await assert.rejects(s.requestOutline(),{name:'AbortError'});
}
{
  let release;const events=[];
  const s=createDjvuScheduler({page:async n=>{events.push(`page:${n}`);return await new Promise(resolve=>release=resolve)},
    geometry:async n=>{events.push(`geometry:${n}`);return {width:n}},
    text:async n=>{events.push(`text:${n}`);return {text:String(n)}},
    outline:async()=>{events.push('outline');return [{title:'ok',page:1,depth:0}]},close(){}},{maxBytes:8,maxPages:2});
  const active=s.request(1,3);await tick();
  const dropped=s.request(2,0);dropped.catch(()=>{});
  const kept=s.request(3,2);
  const t1=s.requestMetadata('text',4,-1),t2=s.requestMetadata('text',4,4);
  const g1=s.requestMetadata('geometry',5,1),g2=s.requestMetadata('geometry',5,3);
  const o1=s.requestOutline(),o2=s.requestOutline();
  s.cancelSpeculation();await assert.rejects(dropped,{name:'AbortError'});
  release(image(1));await active;
  assert.deepEqual(await t1,{text:'4'});assert.deepEqual(await t2,{text:'4'});
  assert.deepEqual(await g1,{width:5});assert.deepEqual(await g2,{width:5});
  await tick();assert.deepEqual(events.slice(0,4),['page:1','text:4','geometry:5','page:3']);
  release(image(3));await kept;
  assert.deepEqual(await o1,[{title:'ok',page:1,depth:0}]);assert.deepEqual(await o2,await o1);
  assert.equal(events.filter(value=>value==='outline').length,1);s.close();
}
{
  let release;let outlines=0;
  const s=createDjvuScheduler({page:async n=>image(n),outline:()=>{outlines++;return new Promise(resolve=>release=resolve)},
    geometry:async n=>({width:n}),text:async n=>({text:String(n)}),close(){}},{maxBytes:8,maxPages:2});
  const first=s.requestOutline();await tick();const duplicate=s.requestOutline();
  release([{title:'one',page:1,depth:0}]);assert.deepEqual(await duplicate,await first);assert.equal(outlines,1);s.close();
}
{
  let release;const counts={geometry:0,text:0};
  const s=createDjvuScheduler({page:async n=>image(n),outline:async()=>[],
    geometry:n=>{counts.geometry++;return new Promise(resolve=>release=resolve)},
    text:n=>{counts.text++;return new Promise(resolve=>release=resolve)},close(){}},{maxBytes:8,maxPages:2});
  const g=s.requestMetadata('geometry',1);await tick();const g2=s.requestMetadata('geometry',1,2);
  release({width:1});assert.deepEqual(await g,await g2);await tick();
  const t=s.requestMetadata('text',2);await tick();const t2=s.requestMetadata('text',2,2);
  release({text:'2'});assert.deepEqual(await t,await t2);assert.deepEqual(counts,{geometry:1,text:1});s.close();
}
{
  let calls=0;
  const s=createDjvuScheduler({page:async()=>{calls++;if(calls===1)throw Error('decoder failed');if(calls===2)return {image:{data:'bad'}};return image(1)},close(){}},
    {maxBytes:8,maxPages:2});
  await assert.rejects(s.request(1),/decoder failed/);await tick();
  await assert.rejects(s.request(1),/DJVU_DECODE_INVALID/);await tick();
  assert.equal((await s.request(1)).image.data[0],1);s.close();
}
{
  let release;let closeCount=0;
  const s=createDjvuScheduler({page:()=>new Promise(resolve=>release=resolve),geometry:async()=>({width:1}),
    outline:async()=>[],close(){closeCount++}},{maxBytes:8,maxPages:2});
  const first=s.request(1);first.catch(()=>{});await tick();
  const queued=s.requestMetadata('geometry',2);queued.catch(()=>{});
  const outline=s.requestOutline();outline.catch(()=>{});s.close();s.close();
  await assert.rejects(first,{name:'AbortError'});await assert.rejects(queued,{name:'AbortError'});
  await assert.rejects(outline,{name:'AbortError'});release(image(1));await tick();
  assert.equal(closeCount,1);assert.equal(s.stats().retainedBytes,0);assert.deepEqual(s.stats().pages,[]);
}
{
  // Two consumers share a live decode; one cancellation cannot cancel or
  // evict the other consumer's result, and its listener is removed on settle.
  let release,calls=0;
  const s=createDjvuScheduler({page:()=>{calls++;return new Promise(resolve=>release=resolve)},close(){}},
    {maxBytes:8,maxPages:2});
  const cancelled=new AbortController(),survivor=new AbortController();
  const first=s.request(1,0,{signal:cancelled.signal});first.catch(()=>{});await tick();
  const second=s.request(1,2,{signal:survivor.signal});cancelled.abort();
  await assert.rejects(first,{name:'AbortError'});release(image(1));assert.equal((await second).image.data[0],1);
  survivor.abort();assert.equal(calls,1);assert.deepEqual(s.stats().pages,[1]);s.close();
}
{
  // Equal priorities preserve admission order rather than favoring a newer page.
  let release;const starts=[];
  const s=createDjvuScheduler({page:n=>{starts.push(n);return new Promise(resolve=>release=resolve)},close(){}},
    {maxBytes:16,maxPages:4});
  const one=s.request(1,4);await tick();const two=s.request(2,2),three=s.request(3,2);
  release(image(1));await one;await tick();assert.deepEqual(starts,[1,2]);
  release(image(2));await two;await tick();assert.deepEqual(starts,[1,2,3]);
  release(image(3));await three;s.close();
}
{
  // A rejected promise is still a failure when its reason is falsy. It must
  // never resolve as a successful undefined page/metadata, and the queue must
  // resume after every rejected task.
  for (const reason of [undefined, null, false, 0, '']) {
    let runs=0;
    const s=createDjvuScheduler({page:async n=>{if(++runs===1)throw reason;return image(n)},
      geometry:async()=>{throw reason},close(){}},{maxBytes:8,maxPages:2});
    await s.request(1).then(()=>assert.fail('falsy rejection became a success'), error=>assert.equal(error,reason));
    await tick();
    await s.requestMetadata('geometry',1).then(()=>assert.fail('falsy metadata rejection became a success'),
      error=>assert.equal(error,reason));
    await tick();assert.equal((await s.request(2)).image.data[0],2);s.close();
  }
}
{
  // Reservations drop only scheduler references, before demanded decoding.
  const gates=new Map(), starts=[];
  const s=createDjvuScheduler({page:n=>{starts.push(n);return new Promise((resolve,reject)=>gates.set(n,{resolve,reject}))},close(){}},
    {maxBytes:8,maxPages:2});
  const geo={geometry:{width:1,height:1}};
  const load=async n=>{const p=s.request(n,3,geo);await tick();gates.get(n).resolve(image(n));const v=await p;await tick();return v};
  const held=await load(1);await load(2);
  const demand=s.request(3,3,geo),duplicate=s.request(3,3,geo);await tick();
  assert.deepEqual(s.stats().pages,[2]);assert.equal(s.stats().retainedBytes,4);
  assert.equal(held.image.data[0],1,'caller reference remains valid after eviction');
  gates.get(3).resolve(image(3));assert.strictEqual(await demand,await duplicate);await tick();
  assert.equal(starts.filter(n=>n===3).length,1);
  await load(1);assert.deepEqual(s.stats().pages,[3,1],'back navigation redecodes evicted page');
  const prefetch=s.request(4,0,geo);await tick();assert.deepEqual(s.stats().pages,[3,1]);
  gates.get(4).resolve(image(4));await prefetch;await tick();
  const failure=s.request(5,3,geo);failure.catch(()=>{});await tick();
  assert.deepEqual(s.stats().pages,[4]);gates.get(5).reject(Error('failure'));await assert.rejects(failure,/failure/);await tick();
  const cancel=new AbortController();const cancelled=s.request(6,3,{...geo,signal:cancel.signal});cancelled.catch(()=>{});
  await tick();cancel.abort();await assert.rejects(cancelled,{name:'AbortError'});gates.get(6).resolve(image(6));await tick();
  assert.ok(!s.stats().pages.includes(6));
  await load(7);
  const huge=s.request(8,3,{geometry:{width:3,height:1}});await tick();
  assert.equal(s.stats().retainedBytes,0);gates.get(8).resolve({image:{data:new Uint8ClampedArray(12)}});
  assert.equal((await huge).image.data.byteLength,12);await tick();assert.equal(s.stats().retainedBytes,0);
  await load(9);
  const unknown=s.request(10,3,{geometry:{width:Infinity,height:1}});await tick();
  assert.deepEqual(s.stats().pages,[9],'invalid geometry must not reserve');
  s.close();await assert.rejects(unknown,{name:'AbortError'});gates.get(10).resolve(image(10));await tick();
  assert.equal(s.stats().retainedBytes,0);
}
{
  // A canceled foreground client must not turn remaining speculation into demand.
  let release;const s=createDjvuScheduler({page:n=>new Promise(resolve=>release=resolve),close(){}},{maxBytes:4,maxPages:1});
  const first=s.request(1,3);await tick();release(image(1));await first;await tick();
  const hold=s.request(2,0);await tick();
  const ac=new AbortController();const foreground=s.request(3,3,{signal:ac.signal,geometry:{width:1,height:1}});foreground.catch(()=>{});
  const speculative=s.request(3,0);ac.abort();await assert.rejects(foreground,{name:'AbortError'});
  release(image(2));await hold;await tick();assert.deepEqual(s.stats().pages,[2]);
  release(image(3));await speculative;s.close();
}
{
  // Retry in the rejection microtask must enqueue behind the failed task.
  for (const operation of ['page','geometry','text','outline']) {
    let calls=0;
    const work=()=>++calls===1 ? Promise.reject(Error('immediate')) : Promise.resolve(operation === 'page' ? image(1) : {});
    const s=createDjvuScheduler({page:work,geometry:work,text:work,outline:work,close(){}},{maxBytes:8,maxPages:2});
    const request=()=>operation==='page' ? s.request(1) : operation==='outline' ? s.requestOutline() : s.requestMetadata(operation,1);
    const result=request().catch(()=>request());
    const timer=AbortSignal.timeout(1000);
    await Promise.race([result,new Promise((_,reject)=>timer.addEventListener('abort',()=>reject(Error('retry timed out'))))]);
    assert.equal(calls,2);s.close();
  }
}
{
  // Queued priority is the maximum of surviving clients, not historical demand.
  const starts=[];let release;
  const s=createDjvuScheduler({page:n=>{starts.push(n);return new Promise(resolve=>release=resolve)},close(){}},{maxBytes:16,maxPages:4});
  const first=s.request(1,3);await tick();
  const ac=new AbortController();const demand=s.request(2,3,{signal:ac.signal});demand.catch(()=>{});
  const prefetch=s.request(2,0),other=s.request(3,2);ac.abort();await assert.rejects(demand,{name:'AbortError'});
  release(image(1));await first;await tick();assert.deepEqual(starts,[1,3]);
  release(image(3));await other;await tick();assert.deepEqual(starts,[1,3,2]);release(image(2));await prefetch;s.close();
}
{
  // Conflicting live demand estimates disable reservation; canceled clients are excluded.
  let release;const s=createDjvuScheduler({page:n=>new Promise(resolve=>release=resolve),close(){}},{maxBytes:12,maxPages:3});
  for (const n of [1,2,3]) {const p=s.request(n);await tick();release(image(n));await p;await tick();}
  const blocker=s.request(4,0);await tick();
  const large=s.request(5,3,{geometry:{width:2,height:1}}),small=s.request(5,2,{geometry:{width:1,height:1}});
  release(image(4));await blocker;await tick();assert.equal(s.stats().retainedBytes,12);
  release(image(5));await Promise.all([large,small]);await tick();
  const ac=new AbortController();const hold=s.request(6,0);await tick();
  const canceled=s.request(7,3,{signal:ac.signal,geometry:{width:3,height:1}});canceled.catch(()=>{});
  const remaining=s.request(7,2,{geometry:{width:1,height:1}});ac.abort();await assert.rejects(canceled,{name:'AbortError'});
  release(image(6));await hold;await tick();assert.equal(s.stats().retainedBytes,8);
  release(image(7));await remaining;s.close();
}
{
  // Aborting before dispatch neither evicts nor starts orphaned decoding.
  const starts=[];const s=createDjvuScheduler({page:async n=>{starts.push(n);return image(n)},close(){}},{maxBytes:4,maxPages:1});
  await s.request(1);await tick();const ac=new AbortController();
  const p=s.request(2,3,{signal:ac.signal,geometry:{width:1,height:1}});ac.abort();await assert.rejects(p,{name:'AbortError'});await tick();
  assert.deepEqual(starts,[1]);assert.deepEqual(s.stats().pages,[1]);s.close();
}
{
  // A demand joining an already running prefetch cannot reserve retroactively.
  let release;const s=createDjvuScheduler({page:()=>new Promise(resolve=>release=resolve),close(){}},{maxBytes:4,maxPages:1});
  const first=s.request(1);await tick();release(image(1));await first;await tick();
  const prefetch=s.request(2,0,{geometry:{width:1,height:1}});await tick();
  const demand=s.request(2,3,{geometry:{width:1,height:1}});
  assert.deepEqual(s.stats().pages,[1]);release(image(2));assert.strictEqual(await prefetch,await demand);s.close();
}
{
  // Conflicting speculation and demand do not evict, in either admission order;
  // canceling the conflicting client before dispatch makes demand safe again.
  for (const reverse of [false,true]) for (const cancel of [false,true]) {
    let release;const s=createDjvuScheduler({page:()=>new Promise(resolve=>release=resolve),close(){}},{maxBytes:4,maxPages:1});
    const cached=s.request(1);await tick();release(image(1));await cached;await tick();
    // Keep the worker occupied without replacing the completed cache entry.
    const hold=s.request(2,0);await tick();
    const ac=new AbortController();
    const spec=()=>s.request(3,0,{signal:ac.signal,geometry:{width:100,height:100}});
    const demand=()=>s.request(3,3,{geometry:{width:1,height:1}});
    let speculative,foreground;
    if (reverse) {foreground=demand();speculative=spec();} else {speculative=spec();foreground=demand();}
    speculative.catch(()=>{});
    if (cancel) {ac.abort();await assert.rejects(speculative,{name:'AbortError'});}
    release(image(2));await hold;await tick();
    assert.deepEqual(s.stats().pages,cancel?[]:[2]);
    release(image(3));await foreground;if (!cancel) await speculative;s.close();
  }
}
console.log("DjVu scheduler cancellation, ordering, deduplication, LRU and closure passed");

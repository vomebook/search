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
console.log("DjVu scheduler cancellation, ordering, deduplication, LRU and closure passed");

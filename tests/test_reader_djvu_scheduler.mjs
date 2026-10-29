import assert from "node:assert/strict";
import { createDjvuScheduler } from "../static/reader/pdf/reader-djvu-scheduler.mjs";

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
console.log("DjVu scheduler cancellation, ordering, deduplication, LRU and closure passed");

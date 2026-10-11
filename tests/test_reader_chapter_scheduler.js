const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

async function main() {
  const sandbox = { DOMException, AbortController };
  sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/reader-chapter-repository.js"), "utf8"), sandbox);
  const starts = [], held = new Map();
  const scheduler = sandbox.VoiceOfMLReaderChapters.createChapterScheduler({
    create(index, signal, priority) {
      starts.push({ index, signal, priority });
      return new Promise(resolve => held.set(index, resolve));
    }
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  scheduler.prefetch([1, 2, 3, 4, 5, 6]);
  await tick();
  assert.deepStrictEqual(starts.map(item => item.index), [1, 2]);
  const foreground = scheduler.load(20);
  await tick();
  assert.deepStrictEqual(starts.map(item => item.index), [1, 2, 20]);
  assert.strictEqual(starts[2].priority, "high");
  assert.ok(starts[0].signal.aborted && starts[1].signal.aborted);
  assert.strictEqual(scheduler.activeCount, 3, "cancelled creates retain ownership until settlement");
  held.get(20)("target");
  assert.strictEqual(await foreground, "target");
  held.get(1)("late"); held.get(2)("late");
  await tick();
  assert.strictEqual(scheduler.activeCount, 0);
  assert.strictEqual(scheduler.pendingCount, 0);
  scheduler.prefetch([30, 31, 32]);
  const promoted = scheduler.load(32);
  assert.strictEqual(scheduler.load(32), promoted);
  await tick();
  assert.strictEqual(starts[3].index, 32, "queued demand overtakes speculation");
  assert.deepStrictEqual(starts.slice(3).map(item => item.index), [32, 30, 31]);
  assert.ok(starts.slice(3).every(item => !item.signal.aborted), "promotion retains current-window peers");
  held.get(32)("promoted");
  assert.strictEqual(await promoted, "promoted");
  held.get(30)("neighbor"); held.get(31)("neighbor");
  await tick();
  const obsolete=scheduler.load(60);
  const obsoleteRejected=assert.rejects(obsolete,error=>error.name==='AbortError');
  await tick();
  const latest=scheduler.load(61,true,true);
  await obsoleteRejected;
  await tick();
  assert.ok(starts.find(item=>item.index===60).signal.aborted);
  held.get(61)('latest');
  assert.strictEqual(await latest,'latest');
  held.get(60)('obsolete');
  await tick();
  scheduler.prefetch([40, 41, 42]);
  await tick();
  scheduler.prefetch([41, 43]);
  assert.ok(starts.find(item => item.index === 40).signal.aborted);
  const closing = scheduler.load(50);
  const rejected = assert.rejects(closing, error => error.name === "AbortError");
  scheduler.dispose();
  await rejected;
  for (const resolve of held.values()) resolve("closed");
  await tick();
  assert.strictEqual(scheduler.activeCount, 0);
  assert.strictEqual(scheduler.pendingCount, 0);
  await assert.rejects(scheduler.load(1), error => error.name === "AbortError");
  console.log("reader chapter scheduler contracts passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

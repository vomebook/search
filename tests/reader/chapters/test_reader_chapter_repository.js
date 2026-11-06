const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function createRepository(options) {
  const sandbox = { self: {}, DOMException };
  sandbox.self = sandbox;
  const filename = path.join(__dirname, "../../../static/reader/formats/reader-chapter-repository.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  return sandbox.VoiceOfMLReaderChapters.createChapterRepository(options);
}

async function main() {
  const values = new Map();
  let resolveCreate;
  let creates = 0;
  const shared = createRepository({ count: 3, find: (index) => values.get(index), create: (index) => { creates += 1; return new Promise((resolve) => { resolveCreate = () => { const value = { index }; values.set(index, value); resolve(value); }; }); } });
  const first = shared.load(1), second = shared.load(1);
  assert.strictEqual(shared.disposed, false);
  assert.strictEqual(first, second);
  assert.strictEqual(shared.state(1).status, "loading");
  assert.strictEqual(shared.pending.length, 1);
  assert.strictEqual(shared.release(1), false, "an in-flight chapter cannot be released");
  await Promise.resolve();
  resolveCreate();
  assert.deepStrictEqual(await first, { index: 1 });
  assert.strictEqual(creates, 1);
  assert.strictEqual(shared.state(1).status, "ready");
  assert.strictEqual(shared.state(1).attempts, 1);
  assert.strictEqual(shared.pending.length, 0);
  values.delete(1);
  assert.strictEqual(shared.release(1), true);
  assert.strictEqual(shared.state(1).status, "idle");
  assert.strictEqual(shared.state(1).value, null);

  values.set(2, { index: 2 });
  assert.deepStrictEqual(await shared.load(2), { index: 2 });
  assert.strictEqual(shared.state(2).status, "ready");
  assert.strictEqual(shared.state(2).attempts, 0, "an existing chapter must not be recreated");
  assert.strictEqual(creates, 1);
  assert.strictEqual(Object.isFrozen(shared.state(2)), true);
  assert.strictEqual(shared.state(-1), null);
  assert.strictEqual(shared.release(99), false);

  let attempts = 0;
  const retry = createRepository({ count: 1, find: () => null, create: () => ++attempts === 1 ? Promise.reject(new Error("temporary")) : Promise.resolve("ready") });
  await assert.rejects(retry.load(0), /temporary/);
  assert.strictEqual(retry.state(0).status, "error");
  assert.strictEqual(await retry.load(0), "ready");
  assert.strictEqual(retry.state(0).attempts, 2);
  assert.strictEqual(await retry.load(-1), null);
  assert.strictEqual(await retry.load(1), null);
  for (const invalid of [NaN, Infinity, -Infinity, -1, 0.5, 1, Number.MAX_SAFE_INTEGER]) {
    assert.strictEqual(await retry.load(invalid), null);
    assert.strictEqual(retry.release(invalid), false);
    assert.strictEqual(retry.state(invalid), null);
  }

  // A replaced Array.from can break density. Preserve the existing failure and
  // find-before-error order rather than silently inventing an absent record.
  {
    const sandbox = {DOMException, AbortController};
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext('Array.from = () => new Array(1)', sandbox);
    const filename = path.join(__dirname, "../../../static/reader/formats/reader-chapter-repository.js");
    vm.runInContext(fs.readFileSync(filename, "utf8"), sandbox, {filename});
    let finds = 0;
    const sparse = sandbox.VoiceOfMLReaderChapters.createChapterRepository({count:1,
      find() { finds++; return null; }, create() { return 'created'; }});
    assert.throws(() => sparse.load(0), {name:'TypeError'});
    assert.strictEqual(finds, 1);
    assert.throws(() => sparse.release(0), {name:'TypeError'});
  }

  let finishLate;
  let commits = 0;
  const disposed = createRepository({ count: 1, find: () => null, create: () => new Promise((resolve) => { finishLate = resolve; }), commit: (_index, value) => { commits += 1; return value; } });
  const late = disposed.load(0);
  await Promise.resolve();
  disposed.dispose();
  assert.strictEqual(disposed.disposed, true);
  finishLate("late");
  assert.strictEqual(await late, null);
  assert.strictEqual(commits, 0);
  assert.strictEqual(disposed.state(0).status, "idle");
  assert.strictEqual(disposed.release(0), false);
  await assert.rejects(disposed.load(0), (error) => error.name === "AbortError");

  let called = false;
  const cancelled = createRepository({ count: 1, find: () => null, create: () => { called = true; return "late"; } });
  const beforeStart = cancelled.load(0);
  cancelled.dispose();
  cancelled.dispose();
  assert.strictEqual(await beforeStart, null);
  assert.strictEqual(called, false, "disposing before the first microtask prevents creation");
  assert.strictEqual(cancelled.pending.length, 0);

  const fallback = { DOMException, AbortController };
  const filename = path.join(__dirname, "../../../static/reader/formats/reader-chapter-repository.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), fallback, { filename });
  assert.strictEqual(typeof fallback.VoiceOfMLReaderChapters.createChapterRepository, "function");
  console.log("reader chapter repository contracts passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

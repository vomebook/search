const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function createRepository(options) {
  const sandbox = { self: {}, DOMException };
  sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/reader-chapter-repository.js"), "utf8"), sandbox);
  return sandbox.VoiceOfMLReaderChapters.createChapterRepository(options);
}

async function main() {
  const values = new Map();
  let resolveCreate;
  let creates = 0;
  const shared = createRepository({ count: 3, find: (index) => values.get(index), create: (index) => { creates += 1; return new Promise((resolve) => { resolveCreate = () => { const value = { index }; values.set(index, value); resolve(value); }; }); } });
  const first = shared.load(1), second = shared.load(1);
  assert.strictEqual(first, second);
  assert.strictEqual(shared.state(1).status, "loading");
  assert.strictEqual(shared.pending.length, 1);
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

  let attempts = 0;
  const retry = createRepository({ count: 1, find: () => null, create: () => ++attempts === 1 ? Promise.reject(new Error("temporary")) : Promise.resolve("ready") });
  await assert.rejects(retry.load(0), /temporary/);
  assert.strictEqual(retry.state(0).status, "error");
  assert.strictEqual(await retry.load(0), "ready");
  assert.strictEqual(retry.state(0).attempts, 2);
  assert.strictEqual(await retry.load(-1), null);
  assert.strictEqual(await retry.load(1), null);

  let finishLate;
  let commits = 0;
  const disposed = createRepository({ count: 1, find: () => null, create: () => new Promise((resolve) => { finishLate = resolve; }), commit: (_index, value) => { commits += 1; return value; } });
  const late = disposed.load(0);
  await Promise.resolve();
  disposed.dispose();
  finishLate("late");
  assert.strictEqual(await late, null);
  assert.strictEqual(commits, 0);
  assert.strictEqual(disposed.state(0).status, "idle");
  await assert.rejects(disposed.load(0), (error) => error.name === "AbortError");
  console.log("reader chapter repository contracts passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

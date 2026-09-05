const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadManager(fetchImpl) {
  const timers = new Map();
  let nextTimer = 1;
  class Controller {
    constructor() { this.signal = { aborted: false }; this.abortCount = 0; }
    abort() { this.abortCount += 1; this.signal.aborted = true; this.signal.onabort?.(); }
  }
  const sandbox = { self: {}, DOMException, Response, ReadableStream, AbortController: Controller, fetch: fetchImpl,
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); } };
  sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/reader-request-manager.js"), "utf8"), sandbox);
  return { manager: sandbox.VoiceOfMLReaderRequests.createReaderRequestManager(), timers };
}

async function main() {
  let resolveFetch, calls = 0;
  const shared = loadManager(() => { calls += 1; return new Promise(resolve => { resolveFetch = resolve; }); });
  const first = shared.manager.request("book", 1000), second = shared.manager.request("book", 1000);
  await Promise.resolve();
  assert.notStrictEqual(first, second);
  assert.strictEqual(calls, 1);
  assert.strictEqual(shared.timers.size, 1);
  resolveFetch(new Response("shared body", { status: 200 }));
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.notStrictEqual(firstResponse, secondResponse);
  assert.strictEqual(await firstResponse.text(), "shared body");
  assert.strictEqual(await secondResponse.text(), "shared body");
  assert.strictEqual(shared.manager.pendingCount, 0);
  assert.strictEqual(shared.timers.size, 0);

  const timedOut = loadManager((_url, { signal }) => new Promise((_resolve, reject) => { signal.onabort = () => reject(new DOMException("timed out", "AbortError")); }));
  const timedRequest = timedOut.manager.request("timeout", 25);
  await Promise.resolve();
  [...timedOut.timers.values()][0]();
  await assert.rejects(timedRequest, error => error.name === "AbortError");
  assert.strictEqual(timedOut.manager.pendingCount, 0);
  assert.strictEqual(timedOut.timers.size, 0);

  let attempts = 0;
  const retry = loadManager(() => ++attempts === 1 ? Promise.reject(new Error("temporary")) : Promise.resolve({ ok: true }));
  await assert.rejects(retry.manager.request("retry", 1000), /temporary/);
  assert.strictEqual((await retry.manager.request("retry", 1000)).ok, true);
  assert.strictEqual(attempts, 2);

  const disposed = loadManager((_url, { signal }) => new Promise((_resolve, reject) => { signal.onabort = () => reject(new DOMException("aborted", "AbortError")); }));
  const pending = disposed.manager.request("slow", 1000);
  await Promise.resolve();
  disposed.manager.dispose();
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.strictEqual(disposed.manager.pendingCount, 0);
  assert.strictEqual(disposed.timers.size, 0);
  await assert.rejects(disposed.manager.request("late", 1000), error => error.name === "AbortError");

  let streamController;
  const bodyTimeout = loadManager((_url, { signal }) => Promise.resolve(new Response(new ReadableStream({
    start(controller) {
      streamController = controller;
      signal.onabort = () => controller.error(new DOMException("timed out", "AbortError"));
    },
  }), { status: 200 })));
  const bodyRequest = bodyTimeout.manager.request("body", 25);
  const bodyResponse = await bodyRequest;
  assert.strictEqual(bodyTimeout.timers.size, 1);
  [...bodyTimeout.timers.values()][0]();
  await assert.rejects(bodyResponse.text(), error => error.name === "AbortError");
  assert.ok(streamController);
  assert.strictEqual(bodyTimeout.timers.size, 0);
  console.log("reader request manager contracts passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

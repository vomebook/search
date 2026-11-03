const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const filename = path.join(__dirname, "../static/reader/core/reader-request-manager.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(fetchImpl) {
  const timers = new Map();
  let id = 0;
  const root = {DOMException, Response, ReadableStream, AbortController, fetch: fetchImpl,
    setTimeout(callback, delay) {timers.set(++id, {callback, delay}); return id;},
    clearTimeout(key) {timers.delete(key);}};
  root.self = root;
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), root, {filename});
  return {manager: root.VoiceOfMLReaderRequests.createReaderRequestManager(), timers};
}

async function main() {
  // A missing owner cancellation must fail explicitly rather than hang a
  // fake-timer test: the delayed response is released after disposal.
  {
    let resolveFetch, cancelled = 0;
    const h = fixture(() => new Promise(resolve => {resolveFetch = resolve;}));
    const pending = h.manager.request("disposed-late", 1000);
    await tick(); h.manager.dispose();
    resolveFetch(new Response(new ReadableStream({cancel() {cancelled++;}})));
    await assert.rejects(pending, {name: "AbortError"}); await tick();
    assert.equal(cancelled, 1); assert.equal(h.manager.activeCount, 0); assert.equal(h.timers.size, 0);
  }

  // Reject invalid limits before creating timers or dispatching fetch.
  {
    let calls = 0;
    const h = fixture(() => {calls++; return Promise.resolve(new Response(""));});
    for (const limit of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2"])
      await assert.rejects(h.manager.requestBuffered("bad", 1000, limit), {name: "RangeError"});
    assert.equal(calls, 0); assert.equal(h.timers.size, 0); assert.equal(h.manager.activeCount, 0);
    const empty = await h.manager.requestBuffered("empty", 1000, 0);
    assert.equal(await empty.text(), ""); assert.equal(calls, 1);
  }

  // Different byte budgets cannot share a response even when URL and timeout match.
  {
    let calls = 0;
    const h = fixture(() => {calls++; return Promise.resolve(new Response("abc"));});
    const results = await Promise.allSettled([
      h.manager.requestBuffered("same", 1000, 2), h.manager.requestBuffered("same", 1000, 3)
    ]);
    assert.equal(calls, 2);
    assert.equal(results[0].status, "rejected");
    assert.equal(results[0].reason.code, "READER_RESOURCE_LIMIT");
    assert.equal(await results[1].value.text(), "abc");
    assert.equal(h.manager.pendingCount, 0); assert.equal(h.manager.activeCount, 0); assert.equal(h.timers.size, 0);
  }

  // Stream consumers own cancellation; it propagates the reason exactly once.
  {
    let cancels = 0, cancelReason;
    const h = fixture(() => Promise.resolve(new Response(new ReadableStream({
      cancel(reason) {cancels++; cancelReason = reason;}
    }))));
    const response = await h.manager.request("cancel", 1000);
    const reason = new Error("reader no longer needs data");
    await response.body.cancel(reason);
    assert.equal(cancels, 1); assert.equal(cancelReason, reason);
    assert.equal(h.manager.activeCount, 0); assert.equal(h.timers.size, 0);
    h.manager.dispose(); assert.equal(cancels, 1);
  }

  // A late body from a timed-out buffered attempt is discarded and cancelled.
  {
    let resolveFetch, cancelled = 0;
    const h = fixture(() => new Promise(resolve => {resolveFetch = resolve;}));
    const pending = assert.rejects(h.manager.requestBuffered("late", 1000, 10), {name: "TimeoutError"});
    await tick();
    [...h.timers.values()].find(timer => timer.delay === 1000).callback();
    resolveFetch(new Response(new ReadableStream({cancel() {cancelled++;}})));
    await pending; await tick();
    assert.equal(cancelled, 1); assert.equal(h.manager.activeCount, 0);
    assert.equal(h.manager.pendingCount, 0); assert.equal(h.timers.size, 0);
  }
  console.log("reader request manager edge contracts passed");
}
require("node:test")("reader request manager edge behavior", {timeout: 10000}, main);

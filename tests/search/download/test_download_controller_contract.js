const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Behavioral baseline against the original shared download controller.
// Only synthetic requests and a controlled clock are used; no file is downloaded.
function fixture() {
  let now = 1000, nextTimer = 0;
  const timers = new Map(), requests = [], launches = [], toasts = [];
  const sandbox = {
    AbortController, DOMException,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, {callback, delay});
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      return new Promise((resolve, reject) => requests.push({url, signal: options.signal, resolve, reject}));
    },
  };
  const filename = path.join(__dirname, "../../../static/search/download-controller.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, {filename});
  const controller = sandbox.VoiceOfMLDownloadController.createDownloadController({
    buildCheckUrl: link => "check:" + link,
    buildDownloadUrl: (name, link) => `${name}|${link}`,
    triggerDownload: url => launches.push(url),
    showToast: (...args) => toasts.push(args),
  });
  return {
    controller, requests, launches, toasts, timers, context: sandbox,
    advance(ms) { now += ms; },
    fireDelay(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `missing ${delay}ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

const response = (data, ok = true, status = 200) => ({ok, status, json: async () => data});
const flush = () => new Promise(resolve => setImmediate(resolve));

test("shared checks preserve independent cancellation, cached success and expiration", async () => {
  const {controller: c, requests, timers, advance} = fixture();
  const owner = new AbortController();
  const first = c.checkDownload("book", false, owner.signal);
  const second = c.checkDownload("book");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "check:book");
  assert.equal(c.activeDownloadChecks, 1);
  owner.abort();
  assert.equal(await first, false);
  assert.equal(requests[0].signal.aborted, false);
  requests[0].resolve(response({ok: true}));
  assert.equal(await second, true);
  assert.equal(c.activeDownloadChecks, 0);
  assert.equal(timers.size, 0);
  advance(29999);
  assert.equal(await c.checkDownload("book"), true);
  assert.equal(requests.length, 1);
  advance(1);
  const expired = c.checkDownload("book");
  assert.equal(requests.length, 2);
  requests[1].resolve(response({ok: true}));
  assert.equal(await expired, true);
});

test("two active checks bound the queue and abandoned work never starts", async () => {
  const {controller: c, requests} = fixture();
  const thirdOwner = new AbortController();
  const first = c.checkDownload("a"), second = c.checkDownload("b");
  const third = c.checkDownload("c", false, thirdOwner.signal);
  assert.equal(c.activeDownloadChecks, 2);
  assert.equal(c.downloadCheckQueue.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(await c.checkDownload("speculative", true), false);
  thirdOwner.abort();
  assert.equal(await third, false);
  assert.equal(c.downloadChecks.has("c"), false);
  requests[0].resolve(response({ok: true}));
  assert.equal(await first, true);
  assert.equal(requests.length, 2);
  assert.equal(c.downloadCheckQueue.length, 0);
  requests[1].resolve(response({ok: true}));
  assert.equal(await second, true);
  assert.equal(c.activeDownloadChecks, 0);
  const speculative = c.checkDownload("idle-speculative", true);
  assert.equal(requests.length, 3);
  requests[2].resolve(response({ok: true}));
  assert.equal(await speculative, true);
});

test("occupied queue starts the next live check only after a slot is released", async () => {
  const {controller: c, requests} = fixture();
  const first = c.checkDownload("a"), second = c.checkDownload("b"), third = c.checkDownload("c");
  assert.equal(requests.length, 2);
  assert.equal(c.downloadCheckQueue.length, 1);
  requests[0].resolve(response({ok: true}));
  assert.equal(await first, true);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, "check:c");
  assert.equal(c.activeDownloadChecks, 2);
  requests[1].resolve(response({ok: true}));
  requests[2].resolve(response({ok: true}));
  assert.equal(await second, true);
  assert.equal(await third, true);
  assert.equal(c.activeDownloadChecks, 0);
});

test("check failures report legacy messages and permit a retry", async () => {
  const {controller: c, requests} = fixture();
  const failed = c.checkDownload("retry");
  requests[0].resolve(response({error: "missing"}, false, 503));
  assert.equal(await failed, "missing");
  assert.equal(c.downloadChecks.has("retry"), false);
  const retry = c.checkDownload("retry");
  requests[1].resolve(response({ok: true}));
  assert.equal(await retry, true);
  const badJson = c.checkDownload("gateway");
  requests[2].resolve({ok: false, status: 502, json: async () => { throw new SyntaxError("html"); }});
  assert.equal(await badJson, "下载检查失败（HTTP 502），请重试");
  const httpFailure = c.checkDownload("contradictory");
  requests[3].resolve(response({ok: true}, false, 503));
  assert.equal(await httpFailure, "下载检查失败（HTTP 503），请重试");
  const applicationFailure = c.checkDownload("not-ok");
  requests[4].resolve(response({ok: false}, true));
  assert.equal(await applicationFailure, "下载检查失败，请重试");
});

test("truthy rejection messages retain their original non-string values", async () => {
  const {controller: c, requests, toasts, launches} = fixture();
  const marker = {reason: "synthetic"};
  const checked = c.checkDownload("rejected");
  requests[0].reject({name: "Other", message: marker});
  assert.equal(await checked, marker);
  const started = c.downloadFile("rejected.txt", "rejected");
  await flush();
  requests[1].reject({name: "Other", message: marker});
  assert.equal(await started, false);
  assert.equal(toasts[1][0], marker);
  assert.deepEqual(launches, []);
  assert.equal(c.activeDownloadChecks, 0);
});

test("mutated native lookups retain their existing unchecked failure behavior", async () => {
  const {controller: c, requests, timers, context} = fixture();
  for (let index = 0; index < 64; index++) {
    const result = c.checkDownload("cached" + index);
    requests[index].resolve(response({ok: true}));
    assert.equal(await result, true);
  }
  const nativeDelete = c.downloadChecks.delete;
  const trapped = [];
  const last = c.checkDownload("last");
  vm.runInNewContext("globalThis.originalShift = Array.prototype.shift; Array.prototype.shift = () => undefined", context);
  c.downloadChecks.delete = function(key) { trapped.push(key); return nativeDelete.call(this, key); };
  try {
    requests[64].resolve(response({ok: true}));
    assert.equal(typeof await last, "string");
  } finally {
    vm.runInNewContext("Array.prototype.shift = globalThis.originalShift", context);
    c.downloadChecks.delete = nativeDelete;
  }
  assert.deepEqual(trapped, ["last"]);
  assert.equal(c.activeDownloadChecks, 0);
  assert.equal(timers.size, 0);
  assert.equal(c.downloadChecks.size, 64);
});

test("generic signal option is ignored but batch abort owns cancellation", async () => {
  const {controller: c, requests, launches} = fixture();
  const unrelated = new AbortController();
  unrelated.abort();
  const result = c.downloadFile("book.txt", "book", {quiet: true, signal: unrelated.signal});
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);
  requests[0].resolve(response({ok: true}));
  assert.equal(await result, true);
  const owner = new AbortController();
  const batchResult = c.downloadFile("other.txt", "other", {quiet: true, batch: {abortController: owner}});
  await flush();
  owner.abort();
  assert.equal(await batchResult, false);
  assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve(response({ok: true}));
  await flush();
  assert.deepEqual(launches, ["book.txt|book"]);
});

test("a stalled response body times out, releases its slot and retries without caching failure", async () => {
  const {controller: c, requests, timers, fireDelay} = fixture();
  const first = c.checkDownload("stalled");
  const request = requests[0];
  request.resolve({ok: true, status: 200, json: () => new Promise((resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })});
  await flush();
  fireDelay(8000);
  assert.equal(await first, "下载检查超时，请重试");
  assert.equal(request.signal.aborted, true);
  assert.equal(c.activeDownloadChecks, 0);
  assert.equal(c.downloadChecks.has("stalled"), false);
  assert.equal(timers.size, 0);
  const retry = c.checkDownload("stalled");
  requests[1].resolve(response({ok: true}));
  assert.equal(await retry, true);
});

test("an abandoned active check cannot evict a successful retry when its body resolves late", async () => {
  const {controller: c, requests} = fixture();
  const owner = new AbortController();
  const old = c.checkDownload("retry", false, owner.signal);
  owner.abort();
  assert.equal(await old, false);
  assert.equal(requests[0].signal.aborted, true);
  const retry = c.checkDownload("retry");
  assert.equal(requests.length, 2);
  requests[1].resolve(response({ok: true}));
  assert.equal(await retry, true);
  requests[0].resolve(response({ok: true}));
  await flush();
  assert.equal(await c.checkDownload("retry"), true);
  assert.equal(requests.length, 2);
  assert.equal(c.activeDownloadChecks, 0);
});

test("successful check cache retains at most 64 entries in insertion order", async () => {
  const {controller: c, requests} = fixture();
  for (let i = 0; i < 65; i++) {
    const checked = c.checkDownload("item" + i);
    requests[i].resolve(response({ok: true}));
    assert.equal(await checked, true);
  }
  assert.equal(c.downloadChecks.size, 64);
  assert.equal(c.downloadChecks.has("item0"), false);
  assert.equal(c.downloadChecks.has("item64"), true);
});

test("shared downloads retain other owners and restore button feedback", async () => {
  const {controller: c, requests, launches, toasts} = fixture();
  const attrs = new Map();
  const button = {textContent: "下载", setAttribute(k, v) { attrs.set(k, v); }, removeAttribute(k) { attrs.delete(k); }};
  const batch = {cancelled: false, abortController: new AbortController()};
  const first = c.downloadFile("book.txt", "shared", {batch, button});
  const second = c.downloadFile("book.txt", "shared", {quiet: true});
  assert.equal(button.textContent, "准备中…");
  assert.equal(attrs.get("aria-busy"), "true");
  await flush();
  assert.equal(requests.length, 1);
  batch.abortController.abort();
  assert.equal(await first, false);
  assert.equal(requests[0].signal.aborted, false);
  requests[0].resolve(response({ok: true}));
  assert.equal(await second, true);
  assert.deepEqual(launches, ["book.txt|shared"]);
  assert.equal(button.textContent, "下载");
  assert.equal(attrs.has("aria-busy"), false);
  assert.equal(c.pendingDownloads.size, 0);
  assert.equal(toasts[0][0], "正在准备下载…");
});

test("download failures restore controls and emit the appropriate feedback", async () => {
  const {controller: c, requests, launches, toasts} = fixture();
  const attrs = new Map();
  const button = {textContent: "下载", setAttribute(k, v) { attrs.set(k, v); }, removeAttribute(k) { attrs.delete(k); }};
  const failed = c.downloadFile("missing.txt", "missing", {button});
  await flush();
  requests[0].resolve(response({error: "不存在"}, false, 404));
  assert.equal(await failed, false);
  assert.deepEqual(toasts.map(args => args[0]), ["正在准备下载…", "不存在"]);
  assert.deepEqual(launches, []);
  assert.equal(button.textContent, "下载");
  assert.equal(attrs.has("aria-busy"), false);
  assert.equal(c.pendingDownloads.size, 0);
});

test("a failed browser handoff does not strand later queued downloads", async () => {
  const {controller: c, launches, toasts} = fixture();
  const interrupted = c.downloadFile({toString() { throw new Error("handoff failed"); }}, "bad", {skipCheck: true});
  assert.equal(await interrupted, false);
  assert.equal(toasts.at(-1)[0], "下载失败，请稍后重试");
  assert.equal(c.pendingDownloads.size, 0);
  assert.equal(await c.downloadFile("next.txt", "next", {quiet: true, skipCheck: true}), true);
  assert.deepEqual(launches, ["next.txt|next"]);
});

test("handoffs are paced and a cancelled queued handoff never launches", async () => {
  const {controller: c, launches, timers, advance, fireDelay} = fixture();
  assert.equal(await c.downloadFile("one.txt", "one", {quiet: true, skipCheck: true}), true);
  const batch = {cancelled: false, abortController: new AbortController()};
  const delayed = c.downloadFile("two.txt", "two", {batch, quiet: true, skipCheck: true});
  await flush();
  assert.equal(timers.size, 1);
  batch.abortController.abort();
  assert.equal(await delayed, false);
  advance(300);
  fireDelay(300);
  await flush();
  assert.deepEqual(launches, ["one.txt|one"]);
  assert.equal(c.pendingDownloads.size, 0);
  assert.equal(timers.size, 0);
});

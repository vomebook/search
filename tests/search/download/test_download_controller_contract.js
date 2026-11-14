const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Behavioral baseline against the original shared download controller.
// Only synthetic requests and a controlled clock are used; no file is downloaded.
function fixture(overrides = {}) {
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
    ...overrides,
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

test("a throwing success toast does not turn a shared launched download into failure", async () => {
  const messages = [];
  const {controller: c, launches, timers, advance, fireDelay} = fixture({
    showToast(message) {
      messages.push(message);
      if (message === "已发起下载，请在浏览器下载列表查看") throw new Error("toast failed");
    },
  });
  const first = c.downloadFile("book.txt", "shared", {skipCheck: true});
  const second = c.downloadFile("book.txt", "shared", {quiet: true});
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(launches, ["book.txt|shared"]);
  assert.deepEqual(messages, ["正在准备下载…", "已发起下载，请在浏览器下载列表查看"]);
  assert.equal(c.pendingDownloads.size, 0);
  const next = c.downloadFile("next.txt", "next", {quiet: true, skipCheck: true});
  await flush();
  assert.equal(timers.size, 1);
  advance(300);
  fireDelay(300);
  assert.equal(await next, true);
  assert.deepEqual(launches, ["book.txt|shared", "next.txt|next"]);
});

test("a throwing triggerDownload still reports failure", async () => {
  const {controller: c, toasts} = fixture({
    triggerDownload() { throw new Error("handoff failed"); },
  });
  assert.equal(await c.downloadFile("book.txt", "book", {skipCheck: true}), false);
  assert.deepEqual(toasts.map(args => args[0]), ["正在准备下载…", "下载状态不确定，请检查浏览器下载列表后再重试"]);
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


test("detailed results distinguish pre-handoff failure, uncertain handoff and cancellation", async () => {
  const badUrl = fixture({buildDownloadUrl() { throw new Error("bad url"); }});
  assert.equal(await badUrl.controller.downloadFileDetailed("x", "x", {quiet: true, skipCheck: true}), "failed");
  const handoff = fixture({triggerDownload() { throw new Error("possibly launched"); }});
  assert.equal(await handoff.controller.downloadFileDetailed("x", "x", {quiet: true, skipCheck: true}), "uncertain");
  const owner = new AbortController();
  owner.abort();
  assert.equal(await handoff.controller.downloadFileDetailed("x", "x", {batch: {abortController: owner}, quiet: true}), "cancelled");
});

test("detailed shared callers cancel independently and handoff attempts remain paced", async () => {
  let attempts = 0;
  const f = fixture({triggerDownload() { if (++attempts === 1) throw new Error("unknown"); }});
  const owner = new AbortController();
  const cancelled = f.controller.downloadFileDetailed("x", "x", {batch: {abortController: owner}, quiet: true});
  const shared = f.controller.downloadFileDetailed("x", "x", {quiet: true});
  await flush();
  owner.abort();
  assert.equal(await cancelled, "cancelled");
  f.requests[0].resolve(response({ok: true}));
  assert.equal(await shared, "uncertain");
  const next = f.controller.downloadFileDetailed("y", "y", {quiet: true, skipCheck: true});
  await flush();
  f.advance(300);
  f.fireDelay(300);
  assert.equal(await next, "started");
});


test("batch retries only definite failures and reports uncertainty", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../static/app.js"), "utf8");
  const start = source.indexOf("function renderDownloadBatch() {");
  const end = source.indexOf("function setupDownloadIntentWarming() {", start);
  assert.ok(start >= 0 && end > start);
  const outcomes = {a: "started", b: "failed", c: "uncertain", d: "cancelled"};
  const status = {style: {}}, buttons = {cancel: {}, retry: {}, close: {}};
  let click, panelCreated = false;
  const panel = {
    style: {}, remove() { panelCreated = false; },
    setAttribute() {}, addEventListener(_name, fn) { click = fn; },
    querySelector(selector) {
      if (selector === '[role="status"]') return status;
      return buttons[selector.match(/data-queue="(.*?)"/)[1]];
    },
  };
  const sandbox = {
    AbortController, document: {getElementById: () => panelCreated ? panel : null, createElement: () => panel, body: {appendChild() { panelCreated = true; }} },
    downloadFileDetailed: async (_name, link) => outcomes[link], showToast() {},
  };
  vm.runInNewContext("let downloadBatch = null; const uncertainDownloads = [];\n" + source.slice(start, end) + "\nglobalThis.start = startDownloadBatch; globalThis.current = () => downloadBatch;", sandbox);
  sandbox.start(Object.keys(outcomes).map(link => ({filename: link, link})));
  await flush();
  const batch = sandbox.current();
  assert.equal(batch.done, true);
  assert.equal(batch.started, 1);
  assert.deepEqual(Array.from(batch.uncertain, item => item.link), ["c"]);
  assert.deepEqual(Array.from(batch.failed, item => item.link), ["b"]);
  assert.match(status.textContent, /状态不确定 1/);
  assert.match(status.textContent, /检查后再手动重试/);
  assert.equal(buttons.retry.hidden, false);
  assert.match(status.textContent, /"c"（"c"）/);
  outcomes.b = "uncertain";
  click({target: {dataset: {queue: "retry"}}});
  await flush();
  assert.deepEqual(Array.from(sandbox.current().items, item => item.link), ["b"]);
  assert.deepEqual(Array.from(sandbox.current().uncertain, item => item.link), ["c", "b"]);
  assert.match(status.textContent, /状态不确定 2/);
  assert.match(status.textContent, /"c"（"c"）/);
  assert.match(status.textContent, /"b"（"b"）/);
  assert.equal(buttons.retry.hidden, true);
  assert.equal(status.style.maxHeight, "min(40vh, 240px)");
  assert.equal(status.style.overflowY, "auto");
  assert.equal(status.style.overflowWrap, "anywhere");
  assert.equal(panel.style.overflowY, "auto");
  assert.equal(panel.style.maxHeight, "calc(100vh - 32px)");
  click({target: {dataset: {queue: "close"}}});
  const longLink = "z".repeat(4000);
  outcomes[longLink] = "uncertain";
  sandbox.start([{filename: "old", link: "c"}, {filename: "long", link: longLink}]);
  await flush();
  assert.deepEqual(Array.from(sandbox.current().uncertain, item => item.link), ["c", "b", longLink]);
  assert.match(status.textContent, /状态不确定 3/);
  assert.ok(status.textContent.includes(longLink));
  // A deliberate new selection can try c, but a later failed check must not
  // put its still-uncertain identity in the automatic retry list.
  outcomes.c = "failed";
  outcomes.a = "failed";
  sandbox.start([{filename: "c", link: "c"}, {filename: "a", link: "a"}]);
  await flush();
  assert.deepEqual(Array.from(sandbox.current().items, item => item.link), ["c", "a"]);
  assert.deepEqual(Array.from(sandbox.current().failed, item => item.link), ["a"]);
  assert.deepEqual(Array.from(sandbox.current().uncertain, item => item.link), ["c", "b", longLink]);
  outcomes.a = "started";
  click({target: {dataset: {queue: "retry"}}});
  await flush();
  assert.deepEqual(Array.from(sandbox.current().items, item => item.link), ["a"]);
  assert.deepEqual(Array.from(sandbox.current().uncertain, item => item.link), ["c", "b", longLink]);
});

test("abort during browser handoff cannot erase the shared uncertain result", async () => {
  const owner = new AbortController();
  const f = fixture({triggerDownload() { owner.abort(); throw new Error("after handoff"); }});
  assert.equal(await f.controller.downloadFileDetailed("x", "x", {batch: {abortController: owner}, quiet: true, skipCheck: true}), "uncertain");
});


test("uncertain feedback belongs to each live non-quiet shared subscriber", async () => {
  const f = fixture({triggerDownload() { throw new Error("handoff"); }});
  const owner = new AbortController();
  const batch = f.controller.downloadFileDetailed("x", "x", {quiet: true});
  const cancelled = f.controller.downloadFileDetailed("x", "x", {batch: {abortController: owner}});
  const first = f.controller.downloadFile("x", "x");
  const second = f.controller.downloadFileDetailed("x", "x");
  await flush();
  owner.abort();
  assert.equal(await cancelled, "cancelled");
  f.requests[0].resolve(response({ok: true}));
  assert.equal(await batch, "uncertain");
  assert.equal(await first, false);
  assert.equal(await second, "uncertain");
  assert.deepEqual(f.toasts.map(args => args[0]), [
    "下载状态不确定，请检查浏览器下载列表后再重试",
    "下载状态不确定，请检查浏览器下载列表后再重试",
  ]);
});


test("single uncertain handoff is retained and a later batch failure is visible but not retried", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../static/app.js"), "utf8");
  const start = source.indexOf("let downloadBatch = null;");
  const end = source.indexOf("function setupDownloadIntentWarming() {", start);
  assert.ok(start >= 0 && end > start);
  let f, click, exists = false;
  const status = {style: {}}, buttons = {cancel: {}, retry: {}, close: {}};
  const panel = {style: {}, setAttribute() {}, addEventListener(_event, fn) { click = fn; },
    querySelector(selector) { return selector === '[role="status"]' ? status : buttons[selector.match(/data-queue="(.*?)"/)[1]]; }};
  const sandbox = {
    AbortController, API_BASE: "", DOWNLOAD_CHECK_TIMEOUT: 8000, buildDownloadUrl() {}, triggerDownload() {}, showToast() {},
    document: {getElementById: () => exists ? panel : null, createElement: () => panel, body: {appendChild() { exists = true; }}},
    navigator: {onLine: true},
    VoiceOfMLDownloadController: {createDownloadController(options) {
      f = fixture({...options, triggerDownload() { throw new Error("possible handoff"); }});
      return f.controller;
    }},
  };
  vm.runInNewContext(source.slice(start, end) + "\nglobalThis.start = startDownloadBatch; globalThis.current = () => downloadBatch; globalThis.single = downloadFile;", sandbox);
  assert.equal(await sandbox.single("single.txt", "x", {quiet: true, skipCheck: true}), false);
  sandbox.start([{filename: "single.txt", link: "x"}, {filename: "other.txt", link: "y"}]);
  await flush();
  assert.equal(f.requests.length, 2);
  f.requests[0].resolve(response({ok: false}, false, 404));
  f.requests[1].resolve(response({ok: false}, false, 404));
  await flush();
  assert.deepEqual(Array.from(sandbox.current().blockedFailures, item => item.link), ["x"]);
  assert.deepEqual(Array.from(sandbox.current().failed, item => item.link), ["y"]);
  assert.match(status.textContent, /本次失败但此前状态不确定（不自动重试） 1："single.txt"（"x"）/);
  click({target: {dataset: {queue: "retry"}}});
  await flush();
  assert.deepEqual(Array.from(sandbox.current().items, item => item.link), ["y"]);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].url, "/api/download/check?link=y");
  f.requests[2].resolve(response({ok: false}, false, 404));
  await flush();
});


test("retry workers recheck uncertainty when consuming queued items, unlike explicit batches", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../static/app.js"), "utf8");
  const start = source.indexOf("let downloadBatch = null;");
  const end = source.indexOf("function setupDownloadIntentWarming() {", start);
  assert.ok(start >= 0 && end > start);
  let f, click, exists = false;
  const status = {style: {}}, buttons = {cancel: {}, retry: {}, close: {}};
  const panel = {style: {}, setAttribute() {}, addEventListener(_event, fn) { click = fn; },
    querySelector(selector) { return selector === '[role="status"]' ? status : buttons[selector.match(/data-queue="(.*?)"/)[1]]; }};
  const sandbox = {
    AbortController, API_BASE: "", DOWNLOAD_CHECK_TIMEOUT: 8000, buildDownloadUrl() {}, triggerDownload() {}, showToast() {},
    document: {getElementById: () => exists ? panel : null, createElement: () => panel, body: {appendChild() { exists = true; }}},
    navigator: {onLine: true},
    VoiceOfMLDownloadController: {createDownloadController(options) {
      f = fixture({...options, triggerDownload() { throw new Error("uncertain"); }});
      return f.controller;
    }},
  };
  vm.runInNewContext(source.slice(start, end) + "\nglobalThis.start = startDownloadBatch; globalThis.current = () => downloadBatch; globalThis.single = downloadFile;", sandbox);
  sandbox.start(["a", "b", "x"].map(link => ({filename: link, link})));
  await flush();
  f.requests[0].resolve(response({ok: false}, false, 404));
  f.requests[1].resolve(response({ok: false}, false, 404));
  await flush();
  f.requests[2].resolve(response({ok: false}, false, 404));
  await flush();
  assert.deepEqual(Array.from(sandbox.current().failed, item => item.link), ["a", "b", "x"]);
  click({target: {dataset: {queue: "retry"}}});
  await flush();
  assert.equal(f.requests.length, 5);
  assert.equal(sandbox.current().next, 2);
  assert.equal(await sandbox.single("x", "x", {quiet: true, skipCheck: true}), false);
  f.requests[3].resolve(response({ok: false}, false, 404));
  await flush();
  assert.equal(f.requests.length, 5);
  assert.deepEqual(Array.from(sandbox.current().skippedUncertain, item => item.link), ["x"]);
  assert.match(status.textContent, /因状态不确定跳过重试 1："x"（"x"）/);
  f.requests[4].resolve(response({ok: false}, false, 404));
  await flush();
  assert.equal(sandbox.current().done, true);
  assert.deepEqual(Array.from(sandbox.current().failed, item => item.link), ["a", "b"]);
  sandbox.start([{filename: "x", link: "x"}]);
  await flush();
  assert.equal(f.requests.length, 6);
  assert.equal(f.requests[5].url, "/api/download/check?link=x");
  f.requests[5].resolve(response({ok: false}, false, 404));
  await flush();
  assert.deepEqual(Array.from(sandbox.current().blockedFailures, item => item.link), ["x"]);
});


test("legacy launch scheduler preserves pacing, cancellation and recovery after throws", async () => {
  let throwNext = false;
  const f = fixture({triggerDownload(url) { if (throwNext) { throwNext = false; throw new Error("handoff"); } f.launches.push(url); }});
  assert.equal(await f.controller.scheduleDownloadLaunch("cancelled", "a", () => true), false);
  assert.equal(await f.controller.scheduleDownloadLaunch("first", "a", () => false), true);
  let cancelled = false;
  const delayed = f.controller.scheduleDownloadLaunch("cancelled", "b", () => cancelled);
  await flush();
  cancelled = true;
  f.advance(300);
  f.fireDelay(300);
  assert.equal(await delayed, false);
  throwNext = true;
  await assert.rejects(f.controller.scheduleDownloadLaunch("throw", "c", () => false), /handoff/);
  assert.equal(await f.controller.scheduleDownloadLaunch("after", "d", () => false), true);
  assert.deepEqual(f.launches, ["first|a", "after|d"]);
});

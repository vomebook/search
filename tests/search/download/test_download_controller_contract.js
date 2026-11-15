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
const makeButton = (label = "下载", busy = null) => {
  const attrs = new Map(busy === null ? [] : [["aria-busy", busy]]);
  return {textContent: label, attrs, getAttribute(k) { return attrs.get(k) ?? null; },
    setAttribute(k, v) { attrs.set(k, v); }, removeAttribute(k) { attrs.delete(k); }};
};
// Minimal DOM/storage used by the three app batch contracts. Rows and buttons
// are separate nodes so rendering and acknowledgement assertions inspect the UI.
function batchDomFixture() {
  const node = () => ({style: {}, dataset: {}, children: [], textContent: "",
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }});
  const status = node(), uncertainList = node();
  const buttons = {cancel: node(), retry: node(), close: node()};
  let exists = false, listener;
  const panel = {...node(), remove() { exists = false; }, setAttribute() {},
    addEventListener(name, callback) { assert.equal(name, "click"); listener = callback; },
    querySelector(selector) {
      if (selector === '[role="status"]') return status;
      if (selector === '[data-uncertain-list]') return uncertainList;
      const action = /^\[data-queue="(cancel|retry|close)"\]$/.exec(selector);
      assert.ok(action, `unexpected selector: ${selector}`);
      return buttons[action[1]];
    }};
  const stored = new Map();
  return {status, uncertainList, buttons, panel,
    click(event) { listener(event); },
    document: {getElementById(id) { assert.equal(id, "download-queue"); return exists ? panel : null; },
      createElement(tag) { return tag === "section" ? panel : node(); },
      body: {appendChild(child) { assert.equal(child, panel); exists = true; }}},
    sessionStorage: {getItem(key) { return stored.get(key) ?? null; },
      setItem(key, value) { stored.set(key, String(value)); }},
  };
}

async function settledWithin(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("download subscribers did not settle")), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

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

  // Both shared checks and download subscribers must settle, without caching
  // failure or blocking a third check behind the two occupied slots.
  for (const stage of ["fetch", "json"]) {
    for (const reason of [null, undefined, new Error("offline"), new DOMException("abort", "AbortError")]) {
      const f = fixture();
      const a = makeButton("A"), b = makeButton("B");
      const first = f.controller.downloadFileDetailed("bad", "bad", {button: a});
      const second = f.controller.downloadFileDetailed("bad", "bad", {button: b});
      await flush();
      const checkA = f.controller.checkDownload("bad");
      const checkB = f.controller.checkDownload("bad");
      const occupied = f.controller.checkDownload("occupied");
      const queued = f.controller.checkDownload("queued");
      assert.equal(f.requests.length, 2);
      assert.equal(f.controller.downloadCheckQueue.length, 1);
      if (stage === "fetch") f.requests[0].reject(reason);
      else f.requests[0].resolve({ok: true, status: 200, json: () => Promise.reject(reason)});
      const expected = reason?.name === "AbortError" ? "下载检查超时，请重试"
        : stage === "json" ? "下载检查失败，请重试" : reason?.message || "下载失败，请稍后重试";
      assert.deepEqual(await settledWithin(Promise.all([first, second, checkA, checkB])),
        ["failed", "failed", expected, expected]);
      assert.equal(f.requests.length, 3);
      assert.equal(f.requests[2].url, "check:queued");
      assert.equal(f.controller.downloadChecks.has("bad"), false);
      assert.equal(f.controller.pendingDownloads.size, 0);
      assert.deepEqual(f.launches, []);
      assert.deepEqual(f.toasts.map(args => args[0]), ["正在准备下载…", "正在准备下载…", expected, expected]);
      assert.equal(a.textContent, "A");
      assert.equal(b.textContent, "B");
      assert.equal(a.getAttribute("aria-busy"), null);
      assert.equal(b.getAttribute("aria-busy"), null);
      f.requests[1].resolve(response({ok: true}));
      f.requests[2].resolve(response({ok: true}));
      assert.deepEqual(await settledWithin(Promise.all([occupied, queued])), [true, true]);
      const retry = f.controller.checkDownload("bad");
      f.requests[3].resolve(response({ok: true}));
      assert.equal(await settledWithin(retry), true);
      assert.equal(f.controller.activeDownloadChecks, 0);
      assert.equal(f.controller.downloadCheckQueue.length, 0);
      assert.equal(f.timers.size, 0);
    }
  }
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

  for (const reason of [null, undefined]) {
    const f = fixture();
    const owner = new AbortController();
    const button = makeButton();
    const first = f.controller.downloadFileDetailed("x", "x", {button, batch: {abortController: owner}});
    const second = f.controller.downloadFileDetailed("x", "x");
    await flush();
    owner.abort();
    assert.equal(await settledWithin(first), "cancelled");
    assert.equal(button.textContent, "下载");
    assert.equal(button.getAttribute("aria-busy"), null);
    assert.equal(f.requests[0].signal.aborted, false);
    f.requests[0].reject(reason);
    assert.equal(await settledWithin(second), "failed");
    assert.deepEqual(f.toasts.map(args => args[0]), ["正在准备下载…", "正在准备下载…", "下载失败，请稍后重试"]);
    assert.equal(f.controller.pendingDownloads.size, 0);
    assert.equal(f.controller.activeDownloadChecks, 0);
    assert.equal(f.timers.size, 0);
  }
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
  const button = {textContent: "下载", getAttribute(k) { return attrs.get(k) ?? null; }, setAttribute(k, v) { attrs.set(k, v); }, removeAttribute(k) { attrs.delete(k); }};
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
  assert.deepEqual(toasts.map(args => args[0]), ["正在准备下载…"]);

  for (const quietFirst of [true, false]) {
    for (const success of [true, false]) {
      const f = fixture();
      const a = makeButton("A"), b = makeButton("B", "previous");
      const first = f.controller.downloadFile("x", "x", {quiet: quietFirst, button: a});
      await flush(); // Join after the first caller's check has actually started.
      const second = f.controller.downloadFile("x", "x", {quiet: !quietFirst, button: b});
      assert.equal(a.textContent, "准备中…");
      assert.equal(b.textContent, "准备中…");
      assert.equal(a.getAttribute("aria-busy"), "true");
      assert.equal(b.getAttribute("aria-busy"), "true");
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.toasts.map(args => args[0]), ["正在准备下载…"]);
      f.requests[0].resolve(success ? response({ok: true}) : response({error: "missing"}, false, 404));
      assert.deepEqual(await settledWithin(Promise.all([first, second])), [success, success]);
      assert.deepEqual(f.toasts.map(args => args[0]), ["正在准备下载…", success ? "已发起下载，请在浏览器下载列表查看" : "missing"]);
      assert.equal(a.textContent, "A");
      assert.equal(b.textContent, "B");
      assert.equal(a.getAttribute("aria-busy"), null);
      assert.equal(b.getAttribute("aria-busy"), "previous");
      assert.equal(f.launches.length, success ? 1 : 0);
    }
  }

  // Cancelling either subscription must retain the other owner of the same
  // button. Restore each property only while it still holds our busy value.
  for (const cancelFirst of [true, false]) {
    for (const external of ["none", "label", "busy", "both"]) {
      const f = fixture();
      const button = makeButton("original", "previous");
      const owner = new AbortController();
      const cancelledOptions = {button, batch: {abortController: owner}};
      const first = f.controller.downloadFile("x", "x", cancelFirst ? cancelledOptions : {button});
      const second = f.controller.downloadFile("x", "x", cancelFirst ? {button} : cancelledOptions);
      await flush();
      owner.abort();
      assert.equal(await settledWithin(cancelFirst ? first : second), false);
      assert.equal(button.textContent, "准备中…");
      assert.equal(button.getAttribute("aria-busy"), "true");
      assert.equal(f.requests[0].signal.aborted, false);
      if (external === "label" || external === "both") button.textContent = "outside";
      if (external === "busy" || external === "both") button.setAttribute("aria-busy", "outside");
      f.requests[0].resolve(response({ok: true}));
      assert.equal(await settledWithin(cancelFirst ? second : first), true);
      assert.equal(button.textContent, external === "label" || external === "both" ? "outside" : "original");
      assert.equal(button.getAttribute("aria-busy"), external === "busy" || external === "both" ? "outside" : "previous");
      assert.deepEqual(f.toasts.map(args => args[0]), ["正在准备下载…", "正在准备下载…", "已发起下载，请在浏览器下载列表查看"]);
      assert.deepEqual(f.launches, ["x|x"]);
    }
  }

  // A joining caller owns the entry before preparation feedback can cancel
  // the original subscriber synchronously.
  const owner = new AbortController();
  const reentrant = fixture({showToast() { owner.abort(); }});
  const original = reentrant.controller.downloadFile("x", "x", {quiet: true, batch: {abortController: owner}});
  await flush();
  const joined = reentrant.controller.downloadFile("x", "x");
  assert.equal(await original, false);
  assert.equal(reentrant.requests[0].signal.aborted, false);
  reentrant.requests[0].resolve(response({ok: true}));
  assert.equal(await joined, true);
});

test("download failures restore controls and emit the appropriate feedback", async () => {
  const {controller: c, requests, launches, toasts} = fixture();
  const attrs = new Map();
  const button = {textContent: "下载", getAttribute(k) { return attrs.get(k) ?? null; }, setAttribute(k, v) { attrs.set(k, v); }, removeAttribute(k) { attrs.delete(k); }};
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
  const feedback = fixture({showToast() { throw new Error("feedback unavailable"); }});
  assert.equal(await feedback.controller.downloadFile("x", "x", {skipCheck: true}), true);
  const failed = feedback.controller.downloadFileDetailed("bad", "bad");
  await flush();
  feedback.requests[0].reject(null);
  assert.equal(await settledWithin(failed), "failed");
  assert.deepEqual(feedback.launches, ["x|x"]);
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
  const dom = batchDomFixture();
  const {status, buttons, panel, uncertainList, click} = dom;
  const sandbox = {
    AbortController, document: dom.document, sessionStorage: dom.sessionStorage,
    downloadFileDetailed: async (_name, link) => outcomes[link], showToast() {},
  };
  const stateStart = source.indexOf("let downloadBatch = null;");
  const stateEnd = source.indexOf("const downloadController =", stateStart);
  assert.ok(stateStart >= 0 && stateEnd > stateStart && stateEnd < start);
  vm.runInNewContext(source.slice(stateStart, stateEnd) + source.slice(start, end) + "\nglobalThis.start = startDownloadBatch; globalThis.current = () => downloadBatch;", sandbox);
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
  assert.equal(uncertainList.children.length, 1);
  assert.equal(uncertainList.children[0].children[0].textContent, '"c"（"c"） ');
  assert.equal(uncertainList.children[0].children[1].dataset.acknowledgeLink, "c");
  assert.equal(uncertainList.children[0].children[1].disabled, false);
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
  const acknowledge = uncertainList.children[0].children[1];
  assert.equal(acknowledge.textContent, "已检查下载列表，清除此项记录");
  click({target: acknowledge});
  assert.deepEqual(Array.from(sandbox.current().uncertain, item => item.link), ["b", longLink]);
  assert.deepEqual(JSON.parse(dom.sessionStorage.getItem("uncertain-downloads")).map(item => item.link), ["b", longLink]);
  assert.equal(uncertainList.children.length, 2);
  assert.equal(uncertainList.children[0].children[1].dataset.acknowledgeLink, "b");
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
    "正在准备下载…", "正在准备下载…", "正在准备下载…",
    "下载状态不确定，请检查浏览器下载列表后再重试",
    "下载状态不确定，请检查浏览器下载列表后再重试",
  ]);

  for (const quietFirst of [true, false]) {
    let recorded = 0;
    const f = fixture({triggerDownload() { throw new Error("handoff"); }, onUncertain() { recorded++; }});
    const button = makeButton("original", "previous");
    const owner = new AbortController();
    const first = f.controller.downloadFileDetailed("x", "x", {quiet: quietFirst, button});
    await flush();
    const cancelled = f.controller.downloadFileDetailed("x", "x", {button, batch: {abortController: owner}});
    const second = f.controller.downloadFileDetailed("x", "x", {quiet: !quietFirst, button});
    owner.abort();
    assert.equal(await cancelled, "cancelled");
    assert.equal(button.textContent, "准备中…");
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.equal(f.requests[0].signal.aborted, false);
    f.requests[0].resolve(response({ok: true}));
    assert.deepEqual(await settledWithin(Promise.all([first, second])), ["uncertain", "uncertain"]);
    assert.equal(recorded, 1);
    assert.equal(button.textContent, "original");
    assert.equal(button.getAttribute("aria-busy"), "previous");
    assert.deepEqual(f.toasts.map(args => args[0]), ["正在准备下载…", "正在准备下载…", "下载状态不确定，请检查浏览器下载列表后再重试"]);
  }
});


test("single uncertain handoff is retained and a later batch failure is visible but not retried", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../static/app.js"), "utf8");
  const start = source.indexOf("let downloadBatch = null;");
  const end = source.indexOf("function setupDownloadIntentWarming() {", start);
  assert.ok(start >= 0 && end > start);
  let f;
  const dom = batchDomFixture();
  const {status, buttons, uncertainList, click} = dom;
  const sandbox = {
    AbortController, API_BASE: "", DOWNLOAD_CHECK_TIMEOUT: 8000, buildDownloadUrl() {}, triggerDownload() {}, showToast() {},
    document: dom.document, sessionStorage: dom.sessionStorage,
    navigator: {onLine: true},
    VoiceOfMLDownloadController: {createDownloadController(options) {
      f = fixture({...options, triggerDownload() { throw new Error("possible handoff"); }});
      return f.controller;
    }},
  };
  vm.runInNewContext(source.slice(start, end) + "\nglobalThis.start = startDownloadBatch; globalThis.current = () => downloadBatch; globalThis.single = downloadFile;", sandbox);
  assert.equal(await sandbox.single("single.txt", "x", {quiet: true, skipCheck: true}), false);
  assert.deepEqual(JSON.parse(dom.sessionStorage.getItem("uncertain-downloads")), [{filename: "single.txt", link: "x"}]);
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
  // Reproduce a blocked failure, then explicitly acknowledge it through its
  // rendered button. Only that acknowledgement makes it eligible for retry.
  sandbox.start([{filename: "single.txt", link: "x"}]);
  await flush();
  assert.equal(uncertainList.children[0].children[1].disabled, true);
  click({target: uncertainList.children[0].children[1]});
  assert.deepEqual(Array.from(sandbox.current().uncertain, item => item.link), ["x"]);
  f.requests[3].resolve(response({ok: false}, false, 404));
  await flush();
  assert.deepEqual(Array.from(sandbox.current().blockedFailures, item => item.link), ["x"]);
  assert.equal(buttons.retry.hidden, true);
  assert.equal(uncertainList.children[0].children[1].disabled, false);
  click({target: uncertainList.children[0].children[1]});
  assert.deepEqual(Array.from(sandbox.current().blockedFailures), []);
  assert.deepEqual(Array.from(sandbox.current().failed, item => item.link), ["x"]);
  assert.equal(buttons.retry.hidden, false);
  assert.equal(uncertainList.children.length, 0);
  assert.deepEqual(JSON.parse(dom.sessionStorage.getItem("uncertain-downloads")), []);
  click({target: {dataset: {queue: "retry"}}});
  await flush();
  assert.equal(f.requests[4].url, "/api/download/check?link=x");
  f.requests[4].resolve(response({ok: false}, false, 404));
  await flush();
  assert.deepEqual(Array.from(sandbox.current().failed, item => item.link), ["x"]);
});


test("retry workers recheck uncertainty when consuming queued items, unlike explicit batches", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../static/app.js"), "utf8");
  const start = source.indexOf("let downloadBatch = null;");
  const end = source.indexOf("function setupDownloadIntentWarming() {", start);
  assert.ok(start >= 0 && end > start);
  let f, handoffs = 0;
  const dom = batchDomFixture();
  const {status, buttons, uncertainList, click} = dom;
  const sandbox = {
    AbortController, API_BASE: "", DOWNLOAD_CHECK_TIMEOUT: 8000, buildDownloadUrl() {}, triggerDownload() {}, showToast() {},
    document: dom.document, sessionStorage: dom.sessionStorage,
    navigator: {onLine: true},
    VoiceOfMLDownloadController: {createDownloadController(options) {
      f = fixture({...options, triggerDownload() { handoffs++; throw new Error("uncertain"); }});
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
  assert.equal(uncertainList.children.length, 1);
  assert.equal(uncertainList.children[0].children[1].dataset.acknowledgeLink, "x");
  assert.equal(uncertainList.children[0].children[1].disabled, false);
  assert.deepEqual(JSON.parse(dom.sessionStorage.getItem("uncertain-downloads")), [{filename: "x", link: "x"}]);
  sandbox.start([{filename: "x", link: "x"}]);
  await flush();
  assert.equal(f.requests.length, 6);
  assert.equal(f.requests[5].url, "/api/download/check?link=x");
  f.requests[5].resolve(response({ok: false}, false, 404));
  await flush();
  assert.deepEqual(Array.from(sandbox.current().blockedFailures, item => item.link), ["x"]);

  // An all-skipped retry must regain its retry control after acknowledgement,
  // while the other file remains uncertain and no request or handoff starts.
  const other = sandbox.single("y", "y", {quiet: true, skipCheck: true});
  await flush();
  f.advance(300);
  f.fireDelay(300);
  assert.equal(await other, false);
  sandbox.start(["x", "y"].map(link => ({filename: link, link})), true);
  await flush();
  const skippedBatch = sandbox.current();
  assert.equal(skippedBatch.done, true);
  assert.deepEqual(Array.from(skippedBatch.skippedUncertain, item => item.link), ["x", "y"]);
  assert.deepEqual(Array.from(skippedBatch.failed), []);
  assert.equal(buttons.retry.hidden, true);
  assert.equal(buttons.close.hidden, false);
  assert.equal(uncertainList.children[0].children[1].disabled, false);
  const acknowledgeX = uncertainList.children[0].children[1];
  click({target: acknowledgeX});
  await flush();
  assert.equal(f.requests.length, 6);
  assert.equal(handoffs, 2);
  assert.equal(sandbox.current(), skippedBatch);
  assert.deepEqual(Array.from(skippedBatch.failed, item => item.link), ["x"]);
  assert.deepEqual(Array.from(skippedBatch.skippedUncertain, item => item.link), ["y"]);
  assert.deepEqual(Array.from(skippedBatch.uncertain, item => item.link), ["y"]);
  assert.deepEqual(JSON.parse(dom.sessionStorage.getItem("uncertain-downloads")), [{filename: "y", link: "y"}]);
  assert.equal(buttons.retry.hidden, false);
  assert.equal(buttons.close.hidden, false);
  assert.equal(uncertainList.children.length, 1);
  assert.equal(uncertainList.children[0].children[1].dataset.acknowledgeLink, "y");
  assert.equal(uncertainList.children[0].children[1].disabled, false);
  assert.match(status.textContent, /因状态不确定跳过重试 1："y"（"y"）/);
  click({target: acknowledgeX});
  assert.deepEqual(Array.from(skippedBatch.failed, item => item.link), ["x"]);

  // Duplicate identities across the two held lists become one retry entry.
  skippedBatch.skippedUncertain.push({filename: "y alias", link: "y"});
  skippedBatch.blockedFailures.push({filename: "y", link: "y"});
  click({target: uncertainList.children[0].children[1]});
  await flush();
  assert.deepEqual(Array.from(skippedBatch.failed, item => item.link), ["x", "y"]);
  assert.deepEqual(Array.from(skippedBatch.skippedUncertain), []);
  assert.deepEqual(Array.from(skippedBatch.blockedFailures), []);
  assert.deepEqual(JSON.parse(dom.sessionStorage.getItem("uncertain-downloads")), []);
  assert.equal(uncertainList.children.length, 0);
  assert.equal(buttons.retry.hidden, false);
  assert.equal(buttons.close.hidden, false);
  assert.equal(f.requests.length, 6);
  assert.equal(handoffs, 2);

  click({target: {dataset: {queue: "retry"}}});
  await flush();
  assert.deepEqual(Array.from(sandbox.current().items, item => item.link), ["x", "y"]);
  assert.deepEqual(f.requests.slice(6).map(request => request.url), ["/api/download/check?link=x", "/api/download/check?link=y"]);
  f.requests[6].resolve(response({ok: false}, false, 404));
  f.requests[7].resolve(response({ok: false}, false, 404));
  await flush();
  assert.equal(sandbox.current().done, true);
  assert.deepEqual(Array.from(sandbox.current().failed, item => item.link), ["x", "y"]);
  assert.equal(handoffs, 2);
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

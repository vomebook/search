import assert from "node:assert/strict";
import {test} from "node:test";
import {createReaderDocumentLoader} from "../../../static/reader/core/reader-document-loader.mjs";

const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const requests = [], waits = [], resources = new Set();
  let active = true;
  const context = {
    READER_PROXY_TIMEOUT_MS: 120000,
    sourceUrl: "https://books.test/book.txt",
    readerAbortController: new AbortController(),
    documentState: {title: "book"},
    MARKED_URL: "/marked.js", PURIFY_URL: "/purify.js",
    readerContentUrl: url => url.startsWith("/api/reader-bucket-resource?") ? `https://reader.test${url}`
      : `https://reader.test/api/reader-content?url=${encodeURIComponent(url)}`,
    readerDownloadApiUrl: path => `https://reader.test${path}`,
    readerAbortError: () => new DOMException("closed", "AbortError"),
    assertReaderActive() {if (!active) throw this.readerAbortError();},
    trackReaderResource(fn) {resources.add(fn); return () => resources.delete(fn);},
    async waitForReader(delay) {waits.push(delay);},
    readerRequestManager: {request: async (url, timeout, init) => {
      requests.push({url, timeout, init}); return new Response("content");
    }}
  };
  const loader = createReaderDocumentLoader(context);
  Object.assign(context, loader);
  return {context, loader, requests, waits, resources, close() {active = false;}};
}

test("retry policy keeps bounded delay and never retries rate-limited or aborted work", {timeout: 10000}, async () => {
  const h = fixture();
  for (const error of [{status: 408}, {status: 429}, {status: 503}, new TypeError("failed to fetch"),
    new DOMException("late", "TimeoutError"), new Error("network down"), new Error("HTTP 504")])
    assert.equal(h.loader.retryableReaderProxyError(error), true, String(error));
  const interrupted = Object.assign(new Error("stream timeout"), {name: "TimeoutError", code: "READER_BODY_INTERRUPTED"});
  for (const error of [{status: 404, message: "network error"}, new Error("invalid book"), new DOMException("closed", "AbortError"), interrupted])
    assert.equal(h.loader.retryableReaderProxyError(error), false, String(error));
  let calls = 0;
  assert.equal(await h.loader.retryReaderProxy(async () => {
    if (++calls < 3) throw Object.assign(new Error("temporary"), {status: 503});
    return "ok";
  }), "ok");
  assert.equal(calls, 3); assert.deepEqual(h.waits, [350, 700]);
  calls = 0; h.waits.length = 0;
  await assert.rejects(h.loader.retryReaderProxy(async () => {
    calls++; throw Object.assign(new Error("rate limited"), {status: 429, code: "READER_PDF_RATE_LIMIT"});
  }), {code: "READER_PDF_RATE_LIMIT"});
  assert.equal(calls, 1); assert.deepEqual(h.waits, []);
  for (const failure of [null, undefined, new DOMException("caller closed", "AbortError"), interrupted]) {
    calls = 0; h.waits.length = 0;
    await assert.rejects(h.loader.retryReaderProxy(async () => {calls++; throw failure;}), error => error === failure);
    assert.equal(calls, 1); assert.deepEqual(h.waits, []);
  }
  for (const rejectWait of [false, true]) {
    const closing = fixture(); calls = 0;
    closing.context.waitForReader = async delay => {
      closing.waits.push(delay); closing.close();
      if (rejectWait) throw closing.context.readerAbortError();
    };
    await assert.rejects(closing.loader.retryReaderProxy(async () => {
      calls++; throw new TypeError("failed to fetch");
    }), {name: "AbortError"});
    assert.equal(calls, 1, "closing during backoff must prevent a second request");
    assert.deepEqual(closing.waits, [350]);
  }
  const caller = new AbortController();
  const cancelled = fixture(); calls = 0;
  cancelled.context.awaitReader = async (backoff, signal) => {
    assert.equal(signal, caller.signal);
    caller.abort();
    await backoff;
    signal.throwIfAborted();
  };
  const open = async () => {calls++; throw new TypeError("failed to fetch");};
  await assert.rejects(cancelled.loader.retryReaderProxy(open, caller.signal), {name: "AbortError"});
  assert.equal(calls, 1); assert.deepEqual(cancelled.waits, [350]);
  await assert.rejects(cancelled.loader.retryReaderProxy(open, caller.signal), {name: "AbortError"});
  assert.equal(calls, 1, "a pre-aborted caller must not start a request");
  calls = 0; h.close();
  await assert.rejects(h.loader.retryReaderProxy(async () => {calls++;}), {name: "AbortError"});
  assert.equal(calls, 0);
});

test("proxy-only fetching respects response ownership, cancellation and bucket routing", {timeout: 10000}, async () => {
  const h = fixture();
  const init = {headers: {Range: "bytes=0-3"}};
  assert.equal(await (await h.loader.fetchReaderUrl("/api/reader-bucket-resource?path=x", init)).text(), "content");
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, "https://reader.test/api/reader-bucket-resource?path=x");
  assert.equal(h.requests[0].init, init);
  let cancelled = 0;
  for (const status of [403, 404]) {
    h.requests.length = 0; cancelled = 0;
    h.context.readerRequestManager.request = async (url, timeout, options) => {
      h.requests.push({url, timeout, init: options});
      if (url === "https://books.test/raw") return new Response("direct");
      return new Response(new ReadableStream({cancel() {cancelled++;}}), {status});
    };
    await assert.rejects(h.loader.fetchReaderUrl("https://books.test/raw", init), {status, message: `HTTP ${status}`});
    assert.equal(cancelled, 1);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, h.context.readerContentUrl("https://books.test/raw"));
    assert.equal(h.requests[0].init, init);
    assert.equal(h.requests[0].timeout, h.context.READER_PROXY_TIMEOUT_MS);
    assert.deepEqual(h.waits, []);
  }

  h.requests.length = 0; cancelled = 0;
  h.context.readerRequestManager.request = async (url, timeout, options) => {
    h.requests.push({url, timeout, init: options});
    return new Response(new ReadableStream({cancel() {
      cancelled++;
      throw new Error("body cleanup failed");
    }}), {status: 503});
  };
  await assert.rejects(h.loader.fetchReaderUrl("https://books.test/raw"), {status: 503});
  assert.equal(h.requests.length, 3); assert.equal(cancelled, 3); assert.deepEqual(h.waits, [350, 700]);
  assert.ok(h.requests.every(({url}) => url === h.context.readerContentUrl("https://books.test/raw")));

  h.requests.length = 0; h.waits.length = 0;
  const networkError = new TypeError("failed to fetch");
  h.context.readerRequestManager.request = async url => {h.requests.push({url}); throw networkError;};
  await assert.rejects(h.loader.fetchReaderUrl("https://books.test/raw"), error => error === networkError);
  assert.deepEqual(h.requests.map(({url}) => url), Array(3).fill(h.context.readerContentUrl("https://books.test/raw")));
  assert.deepEqual(h.waits, [350, 700]);

  const owner = new AbortController(); h.requests.length = 0;
  h.context.readerRequestManager.request = async url => {
    h.requests.push({url}); owner.abort(new DOMException("caller", "AbortError"));
    throw new Error("non-retryable");
  };
  await assert.rejects(h.loader.fetchReaderUrl("https://books.test/raw", {signal: owner.signal}), {name: "AbortError"});
  assert.equal(h.requests.length, 1, "an aborted owner cannot fall back to direct fetch");

  const invalid = fixture();
  invalid.context.readerDownloadApiUrl = () => "https://[";
  const rawUrl = "https://books.test/book.txt";
  assert.equal(await (await invalid.loader.fetchReaderUrl(rawUrl)).text(), "content");
  assert.deepEqual(invalid.requests.map(({url}) => url), [invalid.context.readerContentUrl(rawUrl)]);
});

test("trusted Bucket chapters recover on one 503 but never retry permanent errors or escape the proxy", async () => {
  const target = `https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/${'a'.repeat(64)}/${'b'.repeat(16)}/chapters/chapter-0001.xhtml`;
  for (const [statuses, expected] of [[[503, 200], 2], [[403], 1], [[404], 1], [[503, 503, 503], 3]]) {
    const h = fixture(), urls = [], owner = new AbortController();
    h.context.awaitReader = promise => promise;
    h.context.fetchWithReaderTimeout = async (url, timeout, options) => {
      assert.equal(timeout, h.context.READER_PROXY_TIMEOUT_MS);
      assert.equal(options.signal, owner.signal);
      urls.push(url);
      return new Response("chapter", {status: statuses[urls.length - 1]});
    };
    const loading = h.loader.fetchReaderUrl(target, {signal: owner.signal, priority:"high"}, {retryBucket:true});
    if (statuses.at(-1) === 200) assert.equal(await (await loading).text(), "chapter");
    else await assert.rejects(loading, {status: statuses[0]});
    assert.deepEqual(urls, Array(expected).fill(target));
    assert.deepEqual(h.waits, [350, 700].slice(0, expected - 1));
  }
  const h = fixture(), foreign = target.replace("voiceofml-search.hf.space", "untrusted.test");
  await h.loader.fetchReaderUrl(foreign);
  assert.equal(h.requests[0].url, h.context.readerContentUrl(foreign));
  const sidecar = target.replace(/path=.*/, "path=objects/aa/ocr/page-000001.json.gz");
  let attempts = 0;
  h.context.fetchWithReaderTimeout = async url => {
    assert.equal(url, sidecar);
    attempts++;
    return new Response("Unavailable", {status: 503});
  };
  assert.equal((await h.loader.fetchReaderUrl(sidecar)).status, 503);
  assert.equal(attempts, 1, "sidecars keep their own recovery policy");
});

test("preloads are single-owner and fall back on failure or mismatched identity", {timeout: 10000}, async () => {
  const oldWindow = globalThis.window, oldLocation = globalThis.location;
  const window = globalThis.window = {}; globalThis.location = {href: "https://reader.test/static/reader.html"};
  try {
    const h = fixture(), source = h.context.sourceUrl;
    window.__VOICE_PDF_PRELOAD__ = {manifestUrl: source, manifest: Promise.resolve(new Response("early"))};
    const pdf = h.loader.fetchReaderResponse();
    assert.equal(window.__VOICE_PDF_PRELOAD__.manifest, null);
    assert.equal(h.requests.length, 0);
    assert.equal(await (await pdf).text(), "early");
    assert.equal(await (await h.loader.fetchReaderResponse()).text(), "content");
    assert.equal(h.requests.length, 1);
    window.__VOICE_PDF_PRELOAD__ = {manifestUrl: source, manifest: Promise.resolve(new Response("bad", {status: 503}))};
    assert.equal(await (await h.loader.fetchReaderResponse()).text(), "content");
    const wrong = Promise.resolve(new Response("wrong"));
    window.__VOICE_PDF_PRELOAD__ = {manifestUrl: "https://books.test/other", manifest: wrong};
    assert.equal(await (await h.loader.fetchReaderResponse()).text(), "content");
    assert.equal(window.__VOICE_PDF_PRELOAD__.manifest, wrong);
    h.context.chapterManifestUrl = "./chapter.json";
    const chapterUrl = new URL(h.context.chapterManifestUrl, globalThis.location.href).href;
    window.__VOICE_READER_CHAPTER_PRELOAD__ = {manifestUrl: chapterUrl,
      manifest: Promise.resolve(new Response("chapters"))};
    assert.equal(await (await h.loader.loadChapterManifestDocument()).text(), "chapters");
    assert.equal(window.__VOICE_READER_CHAPTER_PRELOAD__.manifest, null);
    window.__VOICE_READER_CHAPTER_PRELOAD__ = {manifestUrl: chapterUrl,
      manifest: Promise.reject(new Error("preload failed"))};
    assert.equal(await (await h.loader.loadChapterManifestDocument()).text(), "content");
    assert.equal(h.requests.at(-1).url, h.context.readerContentUrl("./chapter.json"));
    window.__VOICE_READER_CHAPTER_PRELOAD__ = {manifestUrl: source, manifest: wrong};
    assert.equal(await (await h.loader.loadChapterManifestDocument()).text(), "content");
    assert.equal(h.requests.at(-1).url, h.context.readerContentUrl("./chapter.json"));
    assert.equal(window.__VOICE_READER_CHAPTER_PRELOAD__.manifest, wrong);
    h.context.chapterManifestUrl = undefined;
    let cancelled = 0;
    window.__VOICE_READER_CHAPTER_PRELOAD__ = {manifestUrl: source,
      manifest: Promise.resolve(new Response(new ReadableStream({cancel() {
        cancelled++;
        throw new Error("preload cleanup failed");
      }}), {status: 503}))};
    const beforeFallback = h.requests.length;
    assert.equal(await (await h.loader.loadChapterManifestDocument()).text(), "content");
    assert.equal(window.__VOICE_READER_CHAPTER_PRELOAD__.manifest, null);
    assert.equal(h.requests.length, beforeFallback + 1);
    assert.equal(cancelled, 1);
    assert.equal(h.requests.at(-1).url, h.context.readerContentUrl(source));
    const preload = Promise.withResolvers();
    window.__VOICE_PDF_PRELOAD__ = {manifestUrl: source, manifest: preload.promise};
    const pending = h.loader.fetchReaderResponse();
    assert.equal(window.__VOICE_PDF_PRELOAD__.manifest, null);
    assert.equal(h.requests.length, beforeFallback + 1);
    h.context.sourceUrl = "https://books.test/next";
    preload.reject(new Error("preload failed"));
    assert.equal(await (await pending).text(), "content");
    assert.equal(h.requests.length, beforeFallback + 2);
    assert.equal(h.requests.at(-1).url, h.context.readerContentUrl(source));

    const fetchError = new Error("fallback failed"), targets = [];
    h.context.fetchReaderUrl = target => {targets.push(target); throw fetchError;};
    window.__VOICE_PDF_PRELOAD__ = {manifestUrl: h.context.sourceUrl, manifest: Promise.resolve(new Response("bad", {status: 503}))};
    await assert.rejects(h.loader.fetchReaderResponse(), error => error === fetchError);
    assert.deepEqual(targets, [h.context.sourceUrl], "falling back must not catch and retry its own errors");
    delete window.__VOICE_READER_CHAPTER_PRELOAD__;
    globalThis.location = undefined;
    await assert.rejects(h.loader.loadChapterManifestDocument(), error => error === fetchError);
  } finally {globalThis.window = oldWindow; globalThis.location = oldLocation;}
});

test("Bucket CHM and EPUB opening manifests retry transient responses, not permanent preloads or cancelled loads", async () => {
  const oldWindow = globalThis.window, oldLocation = globalThis.location;
  const window = globalThis.window = {};
  globalThis.location = {href: "https://reader.test/static/reader.html"};
  try {
    for (const format of ["chm", "epub"]) {
      const url = `https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/${format}/${'a'.repeat(64)}/${'b'.repeat(16)}/chapter-manifest.json`;
      for (const [preload, statuses, expected] of [[null, [503, 200], null], [503, [503, 200], null],
        [404, [], 404], [null, [404], 404], [null, [503, 503, 503], "READER_CHAPTER_MANIFEST_TRANSIENT"]]) {
        const {loader, context, waits} = fixture();
        context.chapterManifestUrl = url;
        context.awaitReader = promise => promise;
        const calls = [];
        const early = preload && new Response("preloaded error body", {status: preload});
        window.__VOICE_READER_CHAPTER_PRELOAD__ = early && {manifestUrl: url, manifest: Promise.resolve(early)};
        context.fetchWithReaderTimeout = async (target, _timeout, options) => {
          assert.equal(options.signal, context.readerAbortController.signal);
          calls.push(target);
          return new Response("manifest", {status: statuses[calls.length - 1]});
        };
        const loading = loader.loadChapterManifestDocument();
        if (typeof expected === "number") await assert.rejects(loading, {status: expected});
        else if (expected) await assert.rejects(loading, error => error.code === expected && error.cause?.status === 503);
        else assert.equal(await (await loading).text(), "manifest");
        assert.deepEqual(calls, Array(statuses.length).fill(url));
        assert.deepEqual(waits, [350, 700].slice(0, Math.max(0, statuses.length - 1)));
        if (early) assert.equal(early.bodyUsed, true, "failed preload body must be released");
      }
      const {loader, context, requests} = fixture();
      const preload = Promise.withResolvers();
      context.chapterManifestUrl = url;
      context.assertReaderActive = () => context.readerAbortController.signal.throwIfAborted();
      window.__VOICE_READER_CHAPTER_PRELOAD__ = {manifestUrl: url, manifest: preload.promise};
      const pending = loader.loadChapterManifestDocument();
      context.readerAbortController.abort();
      const response = new Response(new ReadableStream({cancel() {throw new Error("late cleanup failed");}}));
      preload.resolve(response);
      await assert.rejects(pending, {name: "AbortError"});
      assert.equal(response.bodyUsed, true);
      await assert.rejects(loader.loadChapterManifestDocument(), {name: "AbortError"});
      assert.deepEqual(requests, []);

      const closing = fixture();
      closing.context.chapterManifestUrl = url;
      closing.context.awaitReader = async promise => {
        closing.context.readerAbortController.abort();
        await promise;
      };
      let requestsBeforeAbort = 0;
      closing.context.fetchWithReaderTimeout = async () => {
        requestsBeforeAbort++;
        return new Response("busy", {status: 503});
      };
      await assert.rejects(closing.loader.loadChapterManifestDocument(), {name: "AbortError"});
      assert.equal(requestsBeforeAbort, 1);
    }
  } finally {globalThis.window = oldWindow; globalThis.location = oldLocation;}
});

test("document preparation preserves failure and byte-limit ownership", {timeout: 10000}, async () => {
  const old = globalThis.VoiceOfMLReaderSecurity;
  const oldWindow = globalThis.window;
  globalThis.window = {};
  const limits = [];
  globalThis.VoiceOfMLReaderSecurity = {LIMITS: {documentBytes: 42},
    async readBytes(response, limit) {limits.push(limit); return new Uint8Array(await response.arrayBuffer());}};
  try {
    const h = fixture();
    const {response, engines} = h.loader.prepareReaderDocument([Promise.resolve("engine")]);
    assert.deepEqual([...await h.loader.readPreparedBytes(response, engines)], [...new TextEncoder().encode("content")]);
    assert.deepEqual(limits, [42]);
    await assert.rejects(h.loader.readPreparedBytes(Promise.resolve(new Response("bad", {status: 404})), Promise.resolve()), /HTTP 404/);
    const failed = h.loader.prepareReaderDocument([Promise.reject(new Error("engine failed"))]);
    await assert.rejects(failed.engines, /engine failed/); await assert.rejects(failed.response, /engine failed/);
    const text = await h.loader.loadTextDocument(); assert.equal(await text.response.text(), "content");
    const scripts = [];
    h.context.loadScript = async url => {scripts.push(url);};
    const markdown = h.loader.loadMarkdownDocument();
    await markdown.engines; assert.equal(await (await markdown.response).text(), "content");
    assert.deepEqual(scripts, ["/marked.js", "/purify.js"]);
    scripts.length = 0;
    const html = h.loader.loadHtmlDocument();
    await html.engine; assert.equal(await (await html.response).text(), "content");
    assert.deepEqual(scripts, ["/purify.js"]);
  } finally {globalThis.VoiceOfMLReaderSecurity = old; globalThis.window = oldWindow;}
});

test("script load releases timers, handlers and resources on success, error and close", {timeout: 10000}, async () => {
  const oldDocument = globalThis.document, oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
  let latest, timer, timerId = 0;
  const timers = new Map();
  globalThis.setTimeout = fn => {timers.set(++timerId, fn); timer = timerId; return timerId;};
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.document = {createElement() {latest = {removed: false, remove() {this.removed = true;}}; return latest;},
    head: {appendChild() {}}};
  try {
    const h = fixture();
    const success = h.loader.loadScript("/engine.js");
    assert.equal(latest.async, false); assert.equal(latest.src, "/engine.js");
    latest.onload(); await success;
    assert.equal(latest.onload, null); assert.equal(latest.onerror, null);
    assert.equal(timers.size, 0); assert.equal(h.resources.size, 0);
    const error = h.loader.loadScript("/broken.js"); latest.onerror();
    await assert.rejects(error, {code: "READER_ENGINE_NETWORK"});
    assert.equal(latest.removed, true); assert.equal(timers.size, 0); assert.equal(h.resources.size, 0);
    const timed = h.loader.loadScript("/timeout.js"); timers.get(timer)();
    await assert.rejects(timed, {code: "READER_ENGINE_NETWORK"});
    assert.equal(latest.removed, true); assert.equal(h.resources.size, 0);
    const closed = h.loader.loadScript("/closing.js"); [...h.resources][0]();
    await assert.rejects(closed, {name: "AbortError"});
    assert.equal(latest.removed, true); assert.equal(timers.size, 0); assert.equal(h.resources.size, 0);
    // A queued completion or a retained close callback may arrive after another
    // outcome has already won. Cleanup must run once and leave later work alone.
    for (const winner of ["load", "error", "timeout", "close"]) {
      const racing = fixture();
      let releases = 0;
      const track = racing.context.trackReaderResource;
      racing.context.trackReaderResource = cleanup => {
        const release = track(cleanup);
        return () => {releases++; release();};
      };
      const pending = racing.loader.loadScript(`/race-${winner}.js`);
      const script = latest;
      let removals = 0;
      script.remove = () => {removals++; script.removed = true;};
      const callbacks = {load: script.onload, error: script.onerror,
        timeout: timers.get(timer), close: [...racing.resources][0]};
      callbacks[winner]();
      if (winner === "load") await pending;
      else await assert.rejects(pending, winner === "close" ? {name: "AbortError"} : {code: "READER_ENGINE_NETWORK"});
      assert.equal(releases, 1); assert.equal(removals, winner === "load" ? 0 : 1);
      assert.equal(script.onload, null); assert.equal(script.onerror, null);
      assert.equal(timers.size, 0); assert.equal(racing.resources.size, 0);

      const next = racing.loader.loadScript("/next-engine.js");
      const nextScript = latest, nextTimer = timer;
      for (const callback of Object.values(callbacks)) callback();
      assert.equal(releases, 1, "late callbacks must not release the same resource twice");
      assert.equal(removals, winner === "load" ? 0 : 1, "late failure must not remove a loaded script");
      assert.equal(timers.has(nextTimer), true); assert.equal(timers.size, 1);
      assert.equal(racing.resources.size, 1); assert.equal(nextScript.removed, false);
      nextScript.onload(); await next;
      assert.equal(releases, 2); assert.equal(timers.size, 0); assert.equal(racing.resources.size, 0);
    }
    await turn();
  } finally {globalThis.document = oldDocument; globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear;}
});

test("image load stays on the proxy when the dataset host is unreachable", {timeout: 10000}, async () => {
  const oldImage = globalThis.Image;
  globalThis.Image = class {};
  try {
    const h = fixture(), calls = [];
    h.context.sourceUrl = "https://huggingface.co/datasets/VoiceOfML/VOMEBOOK/resolve/main/page.webp";
    h.context.imageLoader = {load: async (image, url, signal, deadline) => {
      calls.push({image, url, signal, deadline});
      if (url === h.context.sourceUrl) throw new Error("direct dataset request");
      return image;
    }};
    const image = await h.loader.loadImageDocument();
    assert.equal(image.alt, "book"); assert.equal(calls.length, 1);
    assert.notEqual(calls[0].url, h.context.sourceUrl);
    assert.equal(calls[0].url, h.context.readerContentUrl(h.context.sourceUrl));
    const networkError = new TypeError("failed to fetch");
    calls.length = 0;
    h.context.imageLoader.load = async (image, url) => {calls.push(url); throw networkError;};
    await assert.rejects(h.loader.loadImageDocument(), error => error === networkError);
    assert.deepEqual(calls, [h.context.readerContentUrl(h.context.sourceUrl)]);
    h.context.imageLoader.load = async () => {throw Object.assign(new Error("limit"), {code:"READER_RESOURCE_LIMIT"});};
    await assert.rejects(h.loader.loadImageDocument(), {code:"READER_RESOURCE_LIMIT"});
    h.close();
    await assert.rejects(h.loader.loadImageDocument(), {name:"AbortError"});
  } finally {globalThis.Image = oldImage;}
});

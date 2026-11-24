/* global window */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createReaderSource } from "../../../static/reader/core/reader-source.mjs";

const saved = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document,
  location: globalThis.location, security: globalThis.VoiceOfMLReaderSecurity, setTimeout: globalThis.setTimeout, Element: globalThis.Element };
afterEach(() => {
  Object.assign(globalThis, { fetch: saved.fetch, window: saved.window, document: saved.document,
    location: saved.location, VoiceOfMLReaderSecurity: saved.security, setTimeout: saved.setTimeout, Element: saved.Element });
});

function fixture() {
  const feedback = [], frames = [], heading = { textContent: "", scrollLeft: 0, title: "" };
  globalThis.window = { __VOICE_READER_RESOLVE__: null };
  globalThis.location = new URL("https://voiceofml-search.hf.space/search/");
  globalThis.VoiceOfMLReaderSecurity = { LIMITS: { manifestBytes: 10000 } };
  globalThis.document = {
    title: "", querySelector: selector => selector === "#title" ? heading : null,
    createElement: () => ({ setAttribute() {}, remove() { this.removed = true; },
      addEventListener(type, fn) { if (type === "load") this.onLoad = fn; } }),
    body: { appendChild: frame => frames.push(frame) }
  };
  globalThis.setTimeout = (fn, ms) => { const timer = saved.setTimeout(fn, ms); timer.unref(); return timer; };
  const context = {
    resolvedReaderData: null, downloadUrl: "https://example.test/book.pdf", readerSourcePromise: Promise.resolve(),
    documentState: { title: "Book.pdf" }, readerLifecycle: { disposed: false },
    showDownloadFeedback: message => feedback.push(message),
    readerDownloadApiUrl: path => path, readerDownloadUrl: (filename, link) => `${filename}:${link}`,
    trackReaderResource: () => () => {}, awaitReader: promise => promise, assertReaderActive() {},
    waitForReader: async () => {}, readerRequestManager: { requestBuffered: async () => { throw Error("unexpected request"); } },
    READER_PROXY_TIMEOUT_MS: 1000, ocrManifestUrl: "", params: new URLSearchParams(),
    readerRuntime: { update() {} }, sourceName: "Fallback", extension: "pdf",
    updateDocumentState(state) { this.documentState = state; }, isReaderOverlayFrame: () => false,
    readerPath: { setAttribute() {} }, readerPathLabel: "", folderReturnUrl: "", folderNavigationTarget: null
  };
  const source = createReaderSource(context);
  globalThis.Element = class { hasAttribute() { return this.busy; }
    setAttribute() { this.busy = true; } removeAttribute() { this.busy = false; } };
  const button = new globalThis.Element();
  button.busy = false;
  return { source, context, feedback, frames, heading, button,
    event: { currentTarget: button, preventDefault() {} } };
}

test("download validates unknown JSON and preserves server messages", async () => {
  for (const [data, ok, expected] of [
    [{ ok: true }, true, "已发起下载"],
    [{ ok: false, error: "denied" }, false, "denied"],
    [{ ok: false, error: { message: "bad" } }, false, "下载检查失败，请重试"],
    [null, true, "下载检查失败，请重试"],
    [[], true, "下载检查失败，请重试"],
    [{ ok: "true" }, true, "下载检查失败，请重试"]
  ]) {
    const f = fixture();
    globalThis.fetch = async () => ({ ok, json: async () => data });
    await f.source.startReaderDownload(f.event);
    assert.equal(f.feedback.at(-1), expected);
    assert.equal(f.frames.length, expected === "已发起下载" ? 1 : 0);
    assert.equal(f.button.busy, false);
    if (f.frames.length) {
      f.frames[0].onLoad();
      assert.equal(f.frames[0].removed, true);
      assert.equal(f.feedback.at(-1), "下载失败，请重试（已发起下载，未收到附件）");
    }
  }
});

test("a derived text preview still downloads the original VCF with its exact filename", async () => {
  const f = fixture();
  const original = "https://example.test/original/address-book.vcf";
  const filename = "Carnet Zoë.VCF";
  Object.assign(f.context, {
    extension: "txt", sourceUrl: "https://example.test/preview/document.txt", downloadUrl: original,
    resolvedReaderData: { filename, original_extension: ".VCF" }, documentState: { title: "Preview.vcf" },
    readerDownloadUrl: f.source.readerDownloadUrl
  });
  globalThis.fetch = async url => {
    assert.equal(new URL(url, globalThis.location.href).searchParams.get("link"), original);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await f.source.startReaderDownload(f.event);
  assert.equal(f.frames.length, 1);
  const download = new URL(f.frames[0].src, globalThis.location.href);
  assert.equal(download.pathname, "/api/download");
  assert.equal(download.searchParams.get("link"), original);
  assert.equal(download.searchParams.get("file"), filename);
  f.frames[0].onLoad();
});

test("download handles null, primitive and abort errors without losing cleanup", async () => {
  for (const [error, expected] of [[null, "下载失败，请重试"], ["failure", "下载失败，请重试"],
    [{ message: 42 }, "下载失败，请重试"],
    [{ get name() { throw Error("name getter"); }, get message() { throw Error("message getter"); } }, "下载失败，请重试"],
    [new DOMException("stalled", "AbortError"), "下载检查超时，请重试"]]) {
    const f = fixture();
    globalThis.fetch = async () => { throw error; };
    await f.source.startReaderDownload(f.event);
    assert.equal(f.feedback.at(-1), expected);
    assert.equal(f.button.busy, false);
  }
});

test("normal and early resolution validate metadata while retaining extra fields", async () => {
  const f = fixture();
  const data = { url: "https://example.test/a", title: "Title", folder: ["a", "b"], extra: 42 };
  f.context.readerRequestManager.requestBuffered = async () => ({ ok: true, json: async () => data });
  assert.deepEqual(await f.source.resolveReaderId("id"), data);
  let disposed = false;
  window.__VOICE_READER_RESOLVE__ = { id: "id", promise: Promise.resolve({ ok: true, status: 200, data }), dispose() { disposed = true; } };
  assert.deepEqual(await f.source.resolveReaderId("id"), data);
  assert.equal(disposed, true);
  f.source.applyReaderMetadata(data);
  assert.equal(f.heading.title, "Title.pdf");
  assert.equal(f.context.resolvedReaderData.extra, 42);
});

test("non-record metadata is rejected before use in both resolution paths and application", async () => {
  for (const data of [null, [], "text"]) {
    const f = fixture();
    f.context.readerRequestManager.requestBuffered = async () => ({ ok: true, json: async () => data });
    await assert.rejects(f.source.resolveReaderId("id"), /Invalid reader metadata/);
    window.__VOICE_READER_RESOLVE__ = { id: "id", promise: Promise.resolve({ ok: true, status: 200, data }), dispose() {} };
    await assert.rejects(f.source.resolveReaderId("id"), /Invalid reader metadata/);
    if (data !== null) assert.throws(() => f.source.applyReaderMetadata(data), /Invalid reader metadata/);
    assert.equal(f.context.resolvedReaderData, null);
  }
});

test("optional nulls and mixed folders survive resolution and application", async () => {
  const f = fixture();
  const data = { url: "https://example.test/a", download: null, extension: null, chapter_manifest: null,
    pdf_document: null, filename: null, title: null, original_extension: null,
    ReaderOcrManifest: null, ocr_manifest: null, path: null, repo: "repo",
    folder: ["a", null, 1, false, { x: 1 }], extra: { nested: true } };
  f.context.readerRequestManager.requestBuffered = async () => ({ ok: true, json: async () => data });
  assert.deepEqual(await f.source.resolveReaderId("id"), data);
  window.__VOICE_READER_RESOLVE__ = { id: "id", promise: Promise.resolve({ ok: true, status: 200, data }), dispose() {} };
  assert.deepEqual(await f.source.resolveReaderId("id"), data);
  f.source.applyReaderMetadata(data);
  assert.deepEqual(f.context.resolvedReaderData, data);
  assert.equal(f.heading.title, "Fallback.pdf");
  assert.equal(f.context.readerPath.textContent, "repo/a//1/false/[object Object]");
  const query = new URLSearchParams(f.context.folderNavigationTarget.hash.split("?")[1]);
  assert.equal(query.get("folder_self"), "a//1/false/[object Object]");
  f.source.applyReaderMetadata({ title: 123, filename: 7, unrelated: false });
  assert.equal(f.heading.title, "123.pdf");
  assert.equal(f.context.resolvedReaderData.unrelated, false);
});

test("reapplying committed metadata preserves its identity and refreshes OCR precedence", () => {
  const f = fixture();
  const published = [];
  f.context.readerRuntime.update = (domain, patch) => {
    assert.equal(domain, "source");
    published.push(patch.metadata);
  };
  f.context.params.set("ocr_manifest", "opening-manifest");
  f.context.resolvedReaderData = { ReaderOcrManifest: "cached-manifest", extra: 42 };
  f.source.applyReaderMetadata({ title: "Resolved", ocr_manifest: "resolved-manifest" });
  const committed = f.context.resolvedReaderData;
  assert.equal(committed.extra, 42);
  assert.equal(f.context.ocrManifestUrl, "resolved-manifest");
  f.source.applyReaderMetadata(committed);
  assert.equal(f.context.resolvedReaderData, committed);
  assert.equal(f.context.ocrManifestUrl, "cached-manifest");
  assert.equal(f.context.params.get("ocr_manifest"), "opening-manifest");
  assert.equal(f.heading.textContent, "Resolved.pdf");
  assert.equal(published.length, 2);
  assert.equal(published[0], committed);
  assert.equal(published[1], committed);
});

test("early lookup retries timeout and rethrows null rejection", async () => {
  const f = fixture();
  let calls = 0;
  f.context.readerRequestManager.requestBuffered = async () => { calls++; return { ok: true, json: async () => ({ url: "x" }) }; };
  window.__VOICE_READER_RESOLVE__ = { id: "id", promise: Promise.reject(new DOMException("", "TimeoutError")), dispose() {} };
  assert.deepEqual(await f.source.resolveReaderId("id"), { url: "x" });
  assert.equal(calls, 1);
  window.__VOICE_READER_RESOLVE__ = { id: "id", promise: Promise.reject(null), dispose() {} };
  await assert.rejects(f.source.resolveReaderId("id"), error => error === null);
});

test("lookup retries share the same delay and attempt budget after cleanup", async () => {
  const data = {url: "https://example.test/book"};
  const earlyEvents = ["track", "untrack", "dispose"];
  for (const [early, statuses, expectedError, expected] of [
    [503, [200], null, [...earlyEvents, "wait:350", "request:200", "json"]],
    [404, [], "HTTP 404", earlyEvents],
    [null, [503, 200], null, ["request:503", "cancel:503", "wait:350", "request:200", "json"]],
    [null, [408, 429], "HTTP 429", ["request:408", "cancel:408", "wait:350", "request:429", "cancel:429"]],
    [null, [403], "HTTP 403", ["request:403", "cancel:403"]],
    [500, [502], "HTTP 502", [...earlyEvents, "wait:350", "request:502", "cancel:502"]],
    [new TypeError("early network failure"), [200], null, ["track", "active", "untrack", "dispose", "request:200", "json"]],
    [new Error("early failure"), [], "early failure", ["track", "active", "untrack", "dispose"]],
  ]) {
    const events = [];
    const f = fixture();
    f.context.trackReaderResource = () => { events.push("track"); return () => events.push("untrack"); };
    f.context.assertReaderActive = () => events.push("active");
    f.context.waitForReader = async delay => { events.push(`wait:${delay}`); };
    const pending = [...statuses];
    f.context.readerRequestManager.requestBuffered = async () => {
      const status = pending.shift();
      events.push(`request:${status}`);
      return {status, ok: status === 200, body: {cancel: async () => { events.push(`cancel:${status}`); }},
        json: async () => { events.push("json"); return data; }};
    };
    if (early !== null) {
      const promise = early instanceof Error ? Promise.reject(early) : Promise.resolve({status: early, ok: false});
      window.__VOICE_READER_RESOLVE__ = {id: "id", promise, dispose: () => events.push("dispose")};
    }
    if (expectedError) await assert.rejects(f.source.resolveReaderId("id"), {message: expectedError});
    else assert.deepEqual(await f.source.resolveReaderId("id"), data);
    assert.deepEqual(events, expected);
    assert.equal(pending.length, 0);
    assert.equal(window.__VOICE_READER_RESOLVE__, null);
  }
});

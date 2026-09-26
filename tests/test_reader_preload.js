const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=objects/aa/" + "a".repeat(64) + "/" + "b".repeat(16) + "/page-manifest.json";
function loadPreload({ chunks = [], header, security = true, blockRead = false, status = 200, saveData = true, url = source } = {}) {
  const timers = new Map(), listeners = new Map(), state = { fetches: 0, reads: 0, cancels: 0, imageSrcs: [] };
  class ImageMock { set src(value) { state.imageSrcs.push(value); this.currentSrc = value; } get src() { return this.currentSrc; } }
  let readStarted;
  const reading = new Promise(resolve => { readStarted = resolve; });
  const sandbox = {
    self: {}, URL, URLSearchParams, TextDecoder, Uint8Array, DataView, Response, AbortController,
    location: { origin: "https://vomebook.github.io", search: "?url=" + encodeURIComponent(url) },
    navigator: { connection: { saveData } }, Image: ImageMock,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    setTimeout(callback, ms) { state.timeoutMs = ms; timers.set(1, callback); return 1; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      state.fetches++;
      state.url = url;
      state.signal = options.signal;
      return {
        status, statusText: status === 200 ? "OK" : "Unavailable",
        headers: new Headers(header ? { "content-length": header } : {}),
        body: {
          cancel: async () => { state.cancels++; },
          getReader: () => ({
            read: async () => {
              readStarted();
              if (blockRead) return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true }));
              const value = chunks[state.reads++];
              return value === undefined ? { done: true } : { done: false, value };
            },
            cancel: async () => { state.cancels++; },
            releaseLock() {},
          }),
        },
      };
    },
  };
  sandbox.self = sandbox;
  if (security) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/reader-security.js"), "utf8"), sandbox);
    sandbox.VoiceOfMLReaderSecurity = {
      ...sandbox.VoiceOfMLReaderSecurity,
      LIMITS: { ...sandbox.VoiceOfMLReaderSecurity.LIMITS, manifestBytes: 8 },
    };
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/reader-contract.js"), "utf8"), sandbox);
  return { sandbox, preload: sandbox.__VOICE_PDF_PRELOAD__, contract: sandbox.VoiceOfMLReader, timers, listeners, state, reading };
}

async function main() {
  const missing = loadPreload({ security: false });
  assert.strictEqual(missing.state.fetches, 0);
  assert.strictEqual(missing.preload, undefined);
  assert.strictEqual(missing.contract.capability("pdf").mode, "pdf");

  const valid = loadPreload({ chunks: [Buffer.from("1234"), Buffer.from("5678")], header: "8" });
  assert.strictEqual(valid.state.timeoutMs, 120000);
  const directUrl = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a".repeat(64) + "/1234567890abcdef/page-manifest.json";
  const direct = loadPreload({ url: directUrl, chunks: [Buffer.from("ok")] });
  assert.strictEqual(direct.state.timeoutMs, 1500);
  await direct.preload.manifest;
  assert.strictEqual(await (await valid.preload.manifest).text(), "12345678");
  assert.strictEqual(valid.state.url, source);
  assert.strictEqual(valid.state.cancels, 0);
  assert.strictEqual(valid.timers.size, 0);
  assert.strictEqual(valid.preload.image, null);

  const relative = loadPreload({ url: source.replace("https://voiceofml-search.hf.space", ""), chunks: [Buffer.from("ok")] });
  assert.strictEqual(relative.state.url, source);
  await relative.preload.manifest;

  const image = loadPreload({ chunks: [Buffer.from("ok")], saveData: false });
  image.sandbox.VoiceOfMLReader = { pdfPageSource() {}, txtRelativePath() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/reader-contract.js"), "utf8"), image.sandbox);
  assert.strictEqual(typeof image.sandbox.VoiceOfMLReader.assetFields, "function");
  assert.strictEqual(image.sandbox.__VOICE_PDF_PRELOAD__, image.preload);
  assert.strictEqual(image.state.fetches, 1);
  assert.strictEqual(image.state.imageSrcs.length, 1);
  const imageRequest = image.preload.manifest;
  image.preload.dispose();
  image.preload.dispose();
  assert.strictEqual(image.state.imageSrcs.at(-1), "");
  assert.strictEqual(image.preload.image, null);
  assert.strictEqual(image.listeners.has("pagehide"), false);
  await imageRequest;

  const bfcache = loadPreload({ chunks: [Buffer.from("ok")], saveData: false });
  const bfcacheListener = bfcache.listeners.get("pagehide");
  bfcacheListener({ persisted: true });
  assert.strictEqual(bfcache.listeners.has("pagehide"), true);
  assert.notStrictEqual(bfcache.preload.image, null);
  bfcacheListener({ persisted: false });
  assert.strictEqual(bfcache.listeners.has("pagehide"), false);
  assert.strictEqual(bfcache.preload.image, null);
  await bfcache.preload.manifest;

  const oversized = loadPreload({ header: "9" });
  await assert.rejects(oversized.preload.manifest, /READER_RESOURCE_LIMIT/);
  assert.strictEqual(oversized.state.reads, 0);
  assert.strictEqual(oversized.state.cancels, 1);
  assert.strictEqual(oversized.timers.size, 0);

  const streaming = loadPreload({ chunks: [new Uint8Array(4), new Uint8Array(5), new Uint8Array(5)] });
  await assert.rejects(streaming.preload.manifest, /READER_RESOURCE_LIMIT/);
  assert.strictEqual(streaming.state.reads, 2);
  assert.strictEqual(streaming.state.cancels, 1);
  assert.strictEqual(streaming.timers.size, 0);

  const failed = loadPreload({ status: 503, chunks: [Buffer.from("retry")] });
  const response = await failed.preload.manifest;
  assert.strictEqual(response.status, 503);
  assert.strictEqual(await response.text(), "retry");

  const timeout = loadPreload({ blockRead: true });
  await timeout.reading;
  [...timeout.timers.values()][0]();
  await assert.rejects(timeout.preload.manifest, error => error.name === "AbortError");
  assert.strictEqual(timeout.state.signal.aborted, true);
  assert.strictEqual(timeout.state.cancels, 1);
  assert.strictEqual(timeout.timers.size, 0);
  console.log("reader preload contracts passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createReaderFormatController } from "../../../static/reader/formats/reader-format-controller.mjs";
import { createReaderLifecycle } from "../../../static/reader/core/reader-lifecycle.mjs";

test("DjVu loader remains a separate module at the Pages runtime URL", async () => {
  const source = await readFile(new URL("../../../static/reader/formats/reader-format-controller.mjs", import.meta.url), "utf8");
  assert.match(source, /const loaderUrl = "\/search\/static\/reader\/pdf\/reader-djvu-loader\.mjs";/);
  assert.match(source, /import\(loaderUrl\)/);
  const loader = await readFile(new URL("../../../static/reader/pdf/reader-djvu-loader.mjs", import.meta.url), "utf8");
  assert.match(loader, /new URL\("\.\/reader-djvu-engine-worker\.mjs", import\.meta\.url\)/);
});

const savedReader = globalThis.VoiceOfMLReader;
afterEach(() => { globalThis.VoiceOfMLReader = savedReader; });

function fixture(metadata) {
  globalThis.VoiceOfMLReader = { capability: extension => ({ mode: extension }) };
  const context = {
    readerId: "id", sourceUrl: "", extension: "initial", cachedReaderData: metadata,
    setReaderStage() {}, assertReaderActive() {}, validSource: () => true,
    normalizeSourceUrl: url => url, readerContentUrl: url => url,
    readerRuntime: { negotiate: capability => capability, update() {} },
    pdfPrimarySource: () => false, applyReaderMetadata() {}
  };
  return { context, controller: createReaderFormatController(context) };
}

const hostile = { toString() { throw new Error("unexpected coercion"); } };

test("resolution ignores non-string extensions and preserves the existing extension", async () => {
  for (const value of [null, hostile]) {
    const f = fixture({ url: "https://example.test/book", original_extension: value, extension: value });
    await f.controller.resolveReaderSource();
    assert.equal(f.context.extension, "initial");
    assert.equal(f.context.sourceUrl, "https://example.test/book");
  }
  const f = fixture({ url: "https://example.test/book", original_extension: hostile, extension: "PDF-PAGES" });
  await f.controller.resolveReaderSource();
  assert.equal(f.context.extension, "pdf-pages");
});

test("resolution retains string and legacy DJVU semantics", async () => {
  const f = fixture({ url: "https://example.test/pages", download: "https://example.test/book.djvu",
    original_extension: ".DjVu", extension: "PDF-PAGES" });
  await f.controller.resolveReaderSource();
  assert.equal(f.context.sourceUrl, "https://example.test/book.djvu");
  assert.equal(f.context.extension, "djvu");
  const invalid = fixture({ url: "https://example.test/pages", original_extension: "djvu", extension: "pdf-pages" });
  await assert.rejects(invalid.controller.resolveReaderSource(), /DJVU_ORIGINAL_SOURCE_REQUIRED/);
});

test("classification is narrowed at the fail boundary without coercion", async () => {
  for (const mode of ["text", "foliate"]) {
    for (const value of ["READER_RESTORE", undefined, 42, Symbol("code"), hostile]) {
      const f = fixture({});
      let calls = 0, failure;
      const error = new Error("failure");
      Object.assign(f.context, {
        readerId: "", sourceUrl: "https://example.test/book", downloadUrl: "https://example.test/book",
        capability: { mode }, readerRuntime: { currentGeneration: () => 0 },
        measurePdf: promise => promise, resolveReaderSource: async () => {}, syncCapabilityControls() {},
        downloadButton: {}, documentState: { title: "book" }, readerDownloadUrl: () => "download",
        formatAdapters: { activate() {}, active: { open: async () => { throw error; } } },
        readerResources: new Set(), loadReaderRestoration: async () => null, awaitReader: promise => promise,
        renderFoliate: async () => { throw error; }, readerAbortController: new AbortController(),
        classifyReaderError: (received, fallback) => {
          calls++;
          assert.equal(received, error);
          assert.equal(fallback, mode === "foliate" ? "READER_CORRUPT" : "READER_PARSE");
          return value;
        },
        fail: (message, code) => { failure = [message, code]; }
      });
      globalThis.VoiceOfMLReader.ReaderMode = { UNSUPPORTED: "unsupported" };
      const savedError = console.error;
      try { console.error = () => {}; await f.controller.start(); } finally { console.error = savedError; }
      assert.equal(calls, 1);
      assert.deepEqual(failure, ["failure", typeof value === "string" ? value : mode === "foliate" ? "READER_CORRUPT" : "READER_PARSE"]);
    }
  }
});

test("dynamic lifecycle code remains uncoerced and is narrowed by the controller", async () => {
  const f = fixture({});
  let reads = 0, failure;
  const error = { message: "failure", get code() {
    reads++;
    return reads === 3 ? "READER_RESTORE" : reads === 4 ? 42 : "other";
  } };
  Object.assign(f.context, {
    readerId: "", sourceUrl: "https://example.test/book", downloadUrl: "https://example.test/book",
    capability: { mode: "text" }, readerRuntime: { currentGeneration: () => 0 },
    measurePdf: promise => promise, resolveReaderSource: async () => {}, syncCapabilityControls() {},
    downloadButton: {}, documentState: { title: "book" }, readerDownloadUrl: () => "download",
    formatAdapters: { activate() {}, active: { open: async () => { throw error; } } },
    readerResources: new Set(), loadReaderRestoration: async () => null, awaitReader: promise => promise,
    readerAbortController: new AbortController(),
    classifyReaderError: createReaderLifecycle({}).classifyReaderError,
    fail: (message, code) => { failure = [message, code]; }
  });
  globalThis.VoiceOfMLReader.ReaderMode = { UNSUPPORTED: "unsupported" };
  const savedError = console.error;
  try { console.error = () => {}; await f.controller.start(); } finally { console.error = savedError; }
  assert.equal(reads, 4);
  assert.deepEqual(failure, ["failure", "READER_PARSE"]);
});

test("image fallback only accepts a string original extension", async () => {
  for (const [original, shouldRender, mode, sameSource] of [[null, false, "image-pages", false], [hostile, false, "image-pages", false], ["JpG", true, "image-pages", false], ["jpg", true, "image", false], ["jpg", false, "image", true], ["tiff", false, "image", false]]) {
    const f = fixture({ url: "https://example.test/pages" });
    const error = new Error("page loading failed");
    let rendered = false, failure;
    Object.assign(f.context, {
      readerId: "", sourceUrl: sameSource ? "https://example.test/book.jpg" : "https://example.test/pages", downloadUrl: "https://example.test/book.jpg",
      capability: { mode }, resolvedReaderData: { original_extension: original },
      readerRuntime: { currentGeneration: () => 0, negotiate: capability => capability, update() {} },
      measurePdf: promise => promise, resolveReaderSource: async () => {}, syncCapabilityControls() {},
      downloadButton: {}, documentState: { title: "book" }, readerDownloadUrl: () => "download",
      formatAdapters: { active: { open: async () => { throw error; } }, activate() {}, dispose() {} },
      readerResources: new Set(), loadReaderRestoration: async () => null, awaitReader: promise => promise,
      content: { replaceChildren() {} }, updateDocumentState() {},
      loadImageDocument: async () => "image", renderImageDocument: async () => { rendered = true; },
      markReaderContentReady() {}, applyInitialRestoration: async () => {}, setReaderPhase: () => false,
      readerAbortController: new AbortController(), classifyReaderError: () => "parse",
      fail: message => { failure = message; }
    });
    globalThis.VoiceOfMLReader.ReaderMode = { UNSUPPORTED: "unsupported" };
    const savedError = console.error;
    try {
      console.error = () => {};
      await f.controller.start();
    } finally { console.error = savedError; }
    assert.equal(rendered, shouldRender);
    assert.equal(failure, shouldRender ? undefined : error.message);
    if (shouldRender) assert.equal(f.context.extension, "jpg");
  }
});

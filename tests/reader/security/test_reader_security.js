const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const sandbox = { self: {}, TextDecoder, Uint8Array };
sandbox.self = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../../static/reader/core/reader-security.js"), "utf8"), sandbox);
const security = sandbox.VoiceOfMLReaderSecurity;

function streamResponse(chunks, header = null) {
  const state = { reads: 0, cancels: 0, released: false };
  const response = {
    headers: { get: () => header },
    body: {
      cancel: async () => { state.cancels++; },
      getReader: () => ({
        read: async () => {
          const value = chunks[state.reads++];
          return value === undefined ? { done: true } : { value, done: false };
        },
        cancel: async () => { state.cancels++; },
        releaseLock: () => { state.released = true; },
      }),
    },
  };
  return { response, state };
}

async function main() {
  const chapterManifest = { version: 1, kind: "epub-chapters", chapters: [{ index: 1, path: "chapter.xhtml", bytes: 10 }] };
  security.validateChapterManifest(chapterManifest);
  for (const [chapter, expected] of [
    [{ index: 1, path: "chapter.xhtml", bytes: security.LIMITS.chapterBytes + 1 }, /READER_RESOURCE_LIMIT/],
    [{ index: 2, path: "chapter.xhtml" }, /EPUB_INVALID/],
    [{ index: 1, path: "../escape.xhtml" }, /EPUB_INVALID/],
  ]) assert.throws(() => security.validateChapterManifest({ ...chapterManifest, chapters: [chapter] }), expected);
  const validTocManifest = { version: 2, kind: "pdf-pages", page_count: 1, toc: [{ title: "第一章", page: 1, depth: 0 }] };
  security.validatePdfPageManifest(validTocManifest);
  security.validatePdfPageManifest({ version: 2, kind: "pdf-pages", page_count: 100, toc: [{ title: "第一章", page: 100, depth: 0 }] });
  assert.throws(() => security.validatePdfPageManifest({ version: 2, kind: "pdf-pages", page_count: 0 }), /PDF_MANIFEST_INVALID/);
  assert.throws(() => security.validatePdfPageManifest({ version: 2, kind: "pdf-pages", page_count: 1, pages: [] }), /PDF_MANIFEST_INVALID/);
  assert.throws(() => security.validatePdfPageManifest({ ...validTocManifest, toc: [{ title: "bad", page: 2, depth: 0 }] }), /PDF_MANIFEST_INVALID/);
  assert.throws(() => security.validatePdfPageManifest({ ...validTocManifest, pages: [] }), /PDF_MANIFEST_INVALID/);
  assert.throws(() => security.validatePdfPageManifest({ version: 1, kind: "pdf-pages", pages: [{ page: 1, path: "pages/page-000001.webp" }] }), /PDF_MANIFEST_INVALID/);
  const ocrRoot = "objects/aa/" + "a".repeat(64) + "/" + "b".repeat(16);
  security.validatePdfOcrManifest({ version: 1, kind: "pdf-ocr", complete: true,
    source_sha256: "a".repeat(64), profile: "test-layout-layout-v2-1234567890abcdef", page_count: 1,
    pages: [{ p: 1, o: ocrRoot + "/ocr/page-000001.json.gz" }],
    book_text: { path: ocrRoot + "/ocr/book-text.json.gz", sha256: "c".repeat(64), bytes: 1 } });

  const ocrPage = {p:1,o:ocrRoot + "/ocr/page-000001.json.gz",os:"c".repeat(64),ob:2};
  const pageWithOcr = {...validTocManifest,source_sha256:"a".repeat(64),ocr:[ocrPage]};
  assert.strictEqual(security.validatePdfPageManifest(pageWithOcr), pageWithOcr);
  for (const source_sha256 of [undefined, null, 0, "", "a".repeat(63), "g".repeat(64), ["a".repeat(64)]]) {
    assert.throws(() => security.validatePdfPageManifest({...pageWithOcr,source_sha256}),
      error => error?.code === "PDF_MANIFEST_INVALID", `bad OCR source ${source_sha256}`);
  }
  const mismatch = {p:1,o:"objects/bb/" + "b".repeat(64) + "/ocr/page-000001.json.gz",os:"c".repeat(64),ob:2};
  assert.throws(() => security.validatePdfPageManifest({...pageWithOcr,ocr:[mismatch]}),
    error => error?.code === "PDF_MANIFEST_INVALID");
  // Legacy image-only manifests have no source hash and must remain valid.
  security.validatePdfPageManifest({version:2,kind:"pdf-pages",page_count:1,codec:"webp"});

  const validOcrPage = {version:1,kind:"pdf-ocr-page",page:1,width:100,height:200,
    blocks:[{t:"text",b:[0.1,0.2,0.9,0.8]}]};
  assert.strictEqual(security.validatePdfOcrPage(validOcrPage,1),validOcrPage);
  for (const [width,height] of [[0,100],[-1,100],[100,0],[100,-1],[null,100],["100",200],
    [100,"200"],[true,200],[Infinity,200],[100,NaN]]) {
    assert.throws(() => security.validatePdfOcrPage({...validOcrPage,width,height},1),
      error => error?.code === "PDF_OCR_PAGE_INVALID", `bad size ${width},${height}`);
  }
  for (const b of [["0.1",0.2,"0.9",0.8],[false,0,1,1],[null,0,1,1],
    [0.9,0,0.1,1],[0,0.9,1,0.1],[-0.1,0,1,1],[0,0,1,Infinity]]) {
    assert.throws(() => security.validatePdfOcrPage({...validOcrPage,blocks:[{t:"text",b}]},1),
      error => error?.code === "PDF_OCR_PAGE_INVALID", `bad box ${JSON.stringify(b)}`);
  }
  // Zero-area boxes are legacy fallback text; keep them valid.
  security.validatePdfOcrPage({...validOcrPage,blocks:[{t:"text",b:[0,0,0,0]}]},1);

  const oversized = streamResponse([], "9");
  assert.throws(() => security.assertResponseSize(oversized.response, 8), /READER_RESOURCE_LIMIT/);
  await assert.rejects(security.readBytes(oversized.response, 8), /READER_RESOURCE_LIMIT/);
  assert.strictEqual(oversized.state.reads, 0);
  assert.strictEqual(oversized.state.cancels, 1);
  oversized.response.body.cancel = async () => { throw new Error("cancel failed"); };
  await assert.rejects(security.readBytes(oversized.response, 8), /READER_RESOURCE_LIMIT/);
  const overflow = streamResponse([new Uint8Array(5), new Uint8Array(5), new Uint8Array(5)]);
  await assert.rejects(security.readBytes(overflow.response, 8), /READER_RESOURCE_LIMIT/);
  assert.deepStrictEqual(overflow.state, { reads: 2, cancels: 1, released: true });
  assert.strictEqual(await security.readText(streamResponse([Buffer.from("text")]).response, 4), "text");

  const budget = security.createByteBudget(8);
  const first = streamResponse([new Uint8Array(3), new Uint8Array(3)]);
  const second = streamResponse([new Uint8Array(3), new Uint8Array(3)]);
  const results = await Promise.allSettled([security.readBytes(first.response, 8, budget), security.readBytes(second.response, 8, budget)]);
  assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.strictEqual(results.find((result) => result.status === "rejected").reason.code, "READER_RESOURCE_LIMIT");
  assert.strictEqual(budget.used, 6);
  assert.strictEqual(budget.remaining, 2);
  assert.strictEqual(first.state.cancels + second.state.cancels, 1);
  budget.release(6);
  assert.strictEqual(await security.readText(streamResponse([Buffer.from("retry")]).response, 8, "utf-8", budget), "retry");
  assert.strictEqual(budget.used, 5);
  const failed = streamResponse([new Uint8Array(2), new Uint8Array(9)]);
  await assert.rejects(security.readBytes(failed.response, 8, budget), /READER_RESOURCE_LIMIT/);
  assert.strictEqual(budget.used, 5);
  await assert.rejects(security.readBytes({ headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(4) }, 8, budget), /READER_RESOURCE_LIMIT/);
  assert.strictEqual(budget.used, 5);
  assert.throws(() => budget.release(6), /Invalid byte release/);
  assert.throws(() => budget.reserve(-1), /Invalid byte count/);
  assert.throws(() => security.createByteBudget(-1), /Invalid byte budget/);
  console.log("reader security contracts passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

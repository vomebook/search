const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const sandbox = { self: {}, TextDecoder, Uint8Array, DataView };
sandbox.self = sandbox;
vm.runInNewContext(fs.readFileSync("static/reader-security.js", "utf8"), sandbox);
const security = sandbox.VoiceOfMLReaderSecurity;

function centralDirectoryEntry(compressed, expanded) {
  const bytes = new Uint8Array(47), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint32(20, compressed, true);
  view.setUint32(24, expanded, true);
  view.setUint16(28, 1, true);
  bytes[46] = 97;
  return bytes;
}

async function main() {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(security.inspectZip(centralDirectoryEntry(100, 1000)))), { entries: 1, compressed: 100, expanded: 1000 });
  assert.throws(() => security.inspectZip(centralDirectoryEntry(1, 1000)), /READER_ARCHIVE_LIMIT/);
  assert.throws(() => security.inspectZip(new Uint8Array(50)), /READER_ARCHIVE_INVALID/);
  assert.throws(() => security.validateChapterManifest({ version: 1, kind: "epub-chapters", chapters: [{ index: 1, path: "chapter.xhtml", bytes: security.LIMITS.chapterBytes + 1 }] }), /READER_RESOURCE_LIMIT/);
  assert.throws(() => security.validateChapterManifest({ version: 1, kind: "epub-chapters", chapters: [{ index: 2, path: "chapter.xhtml" }] }), /EPUB_INVALID/);
  assert.throws(() => security.validateChapterManifest({ version: 1, kind: "epub-chapters", chapters: [{ index: 1, path: "../escape.xhtml" }] }), /EPUB_INVALID/);
  security.validateChapterManifest({ version: 1, kind: "epub-chapters", chapters: [{ index: 1, path: "chapter.xhtml", bytes: 10 }] });
  assert.throws(() => security.validatePdfPageManifest({ version: 1, kind: "pdf-pages", pages: [{ page: 1, path: "pages/page-000001.webp" }, { page: 1, path: "pages/page-000002.webp" }] }), /PDF_MANIFEST_INVALID/);
  assert.throws(() => security.validatePdfPageManifest({ version: 1, kind: "pdf-pages", pages: new Array(security.LIMITS.pdfPages + 1).fill({ page: 1, path: "pages/page-000001.webp" }) }), /READER_RESOURCE_LIMIT/);
  security.validatePdfPageManifest({ version: 1, kind: "pdf-pages", pages: [{ page: 1, path: "pages/page-000001.webp" }] });
  assert.strictEqual(security.isZipContainer("epub"), true);
  for (const extension of ["fbz", "fb2", "mobi", "azw3"]) assert.strictEqual(security.isZipContainer(extension), extension === "fbz");
  const oversized = { headers: { get: () => String(security.LIMITS.manifestBytes + 1) } };
  assert.throws(() => security.assertResponseSize(oversized, security.LIMITS.manifestBytes), /READER_RESOURCE_LIMIT/);
  let cancelled = false, reads = 0;
  const response = { headers: { get: () => null }, body: { getReader: () => ({ read: async () => reads++ ? { done: true } : { done: false, value: new Uint8Array(5) }, cancel: async () => { cancelled = true; } }) } };
  await assert.rejects(() => security.readBytes(response, 4), /READER_RESOURCE_LIMIT/);
  assert.strictEqual(cancelled, true);
  console.log("reader security contracts passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

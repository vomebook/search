const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const sandbox = { self: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../static/reader/core/reader-security.js'), 'utf8'), sandbox);
const s = sandbox.self.VoiceOfMLReaderSecurity;
const hash = 'a'.repeat(64), bad = [hash];
const root = `objects/aa/${hash}`;
const page = { p: 1, o: `${root}/ocr/page-000001.json.gz`, os: hash, ob: 1 };
const pdf = { version: 2, kind: 'pdf-pages', page_count: 1, codec: 'png', images: [{ sha256: hash, bytes: 1 }], source_format: 'djvu', source_sha256: hash, ocr: [page] };
const ocr = { version: 1, kind: 'pdf-ocr', complete: true, source_sha256: hash, profile: 'layout-v1', page_count: 1, pages: [page], book_text: { path: `${root}/ocr/book-text.json.gz`, sha256: hash, bytes: 1 } };
assert.strictEqual(s.validatePdfPageManifest(pdf), pdf);
assert.strictEqual(s.validatePdfOcrManifest(ocr), ocr);
for (const value of [bad, { toString: () => hash }, null, 123]) {
  for (const candidate of [
    { ...pdf, images: [{ sha256: value, bytes: 1 }] },
    { ...pdf, source_sha256: value },
    { ...pdf, ocr: [{ ...page, os: value }] },
  ]) assert.throws(() => s.validatePdfPageManifest(candidate), /PDF_MANIFEST_INVALID/);
  for (const candidate of [
    { ...ocr, source_sha256: value },
    { ...ocr, book_text: { ...ocr.book_text, sha256: value } },
    { ...ocr, pages: [{ ...page, r: `${root}/pages/page-000001.png`, rbucket: 'vomebook/pdf-pages-v2', rs: value, rb: 1 }], source_format: 'djvu' },
  ]) assert.throws(() => s.validatePdfOcrManifest(candidate), /PDF_OCR_MANIFEST_INVALID/);
}
for (const input of [null, [], {}, 42]) {
  assert.throws(() => s.validateChapterManifest(input), /EPUB_INVALID/);
  assert.throws(() => s.validatePdfPageManifest(input), /PDF_MANIFEST_INVALID/);
  assert.throws(() => s.validatePdfOcrManifest(input), /PDF_OCR_MANIFEST_INVALID/);
  assert.throws(() => s.validatePdfOcrPage(input, 1), /PDF_OCR_PAGE_INVALID/);
}

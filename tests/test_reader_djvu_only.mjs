import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const load = file => import(pathToFileURL(path.join(root, 'static/reader', file)).href);
const {createReaderPdfPageWindow} = await load('pdf/reader-pdf-page-window.mjs');
const {createReaderPdfRenderer} = await load('pdf/reader-pdf-renderer.mjs');
const {createReaderPdfTextRuntime} = await load('pdf/reader-pdf-text-runtime.mjs');
const {validateReadingManifest} = await load('pdf/reader-v3.mjs');
const sandbox = {self: {}, URL, URLSearchParams, TextEncoder};
vm.runInNewContext(fs.readFileSync(path.join(root, 'static/reader/core/reader-contract.js'), 'utf8'), sandbox);
globalThis.VoiceOfMLReader = sandbox.self.VoiceOfMLReader;
globalThis.location = {href: 'https://voiceofml-search.hf.space/static/reader.html', origin: 'https://voiceofml-search.hf.space'};
globalThis.VoiceOfMLReaderSecurity = {LIMITS: {manifestBytes: 1000000, pdfPages: 10000}, readText: r => r.text(),
  validatePdfPageManifest: value => value};

const source = 'a'.repeat(64), base = `objects/aa/${source}/`;
const ref = file => ({bucket: 'vomebook/pdf-pages-v2', path: base + 'b'.repeat(16) + '/' + file,
  bytes: 10, sha256: 'c'.repeat(64), role: 'runtime'});
const reading = () => ({version: 3, kind: 'pdf-reading', source_sha256: source, generation: 'd'.repeat(64),
  source_key: 'repo\0book.pdf', page_count: 2, primary: {kind: 'pdf', status: 'ready', resource: ref('document.pdf')},
  page_map: ref('page-map.json.gz'), text_layer: ref('text-layer-manifest.json'),
  preview: {page_count: 2, status: 'skipped', complete: false, ready_pages: 0, partitions: []},
  components: {document: 'ready', preview: 'skipped', text: 'ready'}});

function fixture(outcome = 'success') {
  const calls = [], pdf = {numPages: outcome === 'wrong-count' ? 3 : 2, destroy: async () => calls.push('destroy')};
  const reader = {capability: {mode: 'pdf-pages'}, sourceUrl: '/manifest', documentState: {},
    readerRuntime: {negotiate: value => value, update: () => calls.push('mode')},
    resetPdfLatencySamples() {}, assertReaderActive() {}, syncCapabilityControls() {},
    validateReadingManifest, pdfManifestSource: () => ({root: base + 'b'.repeat(16)}),
    createPdfV3Repository: () => ({read: async value => {
      assert.equal(value.path, ref('page-map.json.gz').path, 'only the page map may load, never a preview partition');
      calls.push('map');return {pages: [{width: 100, height: 200}, {width: 100, height: 200}]};
    }}), validatePageMap: value => value, v3ResourceUrl: value => value.path,
    loadPdfDocument: async value => {
      calls.push(['pdf', value]);
      if (outcome === 'failed') throw Error('PDF_RANGE_INVALID');
      return pdf;
    }, renderPdf: async value => {assert.equal(await value, pdf);calls.push('render');},
    downloadUrl: 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/book.pdf'};
  Object.assign(reader, createReaderPdfPageWindow(reader));
  reader.pdfManifestSource = () => ({root: base + 'b'.repeat(16)});
  reader.renderPdf = async value => {assert.equal(await value, pdf);calls.push('render');};
  return {reader, calls, pdf};
}

for (const legacy of [false, true]) {
  const {reader, calls} = fixture(), manifest = reading();
  if (legacy) {
    delete manifest.preview.status;manifest.preview.complete = true;manifest.preview.ready_pages = 2;
    manifest.preview.partitions = [{start: 1, end: 2, complete: true, resource: ref('preview/partition-000001-000002-manifest.json')}];
    manifest.components.preview = 'ready';
  }
  await reader.renderPdfPages(new Response(JSON.stringify(manifest)));
  assert.equal(reader.capability.mode, 'pdf');
  assert.equal(reader.pdfOcrManifest, reader.pdfV3Manifest, 'independent OCR/text remains attached to direct PDF');
  assert.equal(calls.filter(v => Array.isArray(v)).length, 1);
  assert.equal(calls.at(-1), 'render');
  assert.equal(reader.pdfPageManifest, undefined, 'never install an image-stream page URL');
}
for (const outcome of ['failed', 'wrong-count']) {
  const {reader, calls} = fixture(outcome);
  await assert.rejects(reader.renderPdfPages(new Response(JSON.stringify(reading()))),
    outcome === 'failed' ? /PDF_RANGE_INVALID/ : /PAGE_COUNT_MISMATCH/);
  assert.equal(calls.includes('render'), false, 'a bad PDF cannot fall back to an image');
}
{
  const {reader, calls} = fixture();reader.pdfPrimarySource = () => 'derived/document.pdf';
  await reader.renderPdfPages(new Response(JSON.stringify({version: 2, kind: 'pdf-pages', page_count: 2})));
  assert.equal(reader.capability.mode, 'pdf');assert.equal(calls.at(-1), 'render');
}
{
  const {reader} = fixture();reader.pdfPrimarySource = () => '';
  await assert.rejects(reader.renderPdfPages(new Response(JSON.stringify({version: 2, kind: 'pdf-pages', page_count: 2}))), /PDF_PRIMARY_REQUIRED/);
}
{
  const reader = {capability: {mode: 'pdf-pages'}, pdfV3Manifest: reading()};
  Object.assign(reader, createReaderPdfRenderer(reader));
  await assert.rejects(reader.renderPdfImageShell({}), /PDF_PRIMARY_REQUIRED/);
}
{
  let ocr = 0;
  const reader = {ocrManifestUrl: '/ocr-manifest.json', renderPdfOcrText: async () => ocr++};
  Object.assign(reader, createReaderPdfTextRuntime(reader));
  reader.renderPdfOcrText = async () => ocr++;
  await reader.renderPdfText({}, {});
  assert.equal(ocr, 1, 'direct PDF must not discard separately published OCR text');
}
for (const extension of ['pdf', 'caj', 'kdh', 'ppt', 'ps']) {
  const fields = VoiceOfMLReader.assetFields({s: 2, m: 'p', b: 'vomebook/pdf-pages-v2',
    p: base + 'b'.repeat(16) + '/page-manifest.json', pd: base + 'b'.repeat(16) + '/document.pdf',
    pdb: 'vomebook/pdf-pages-v2'}, '/api/reader-bucket-resource', extension);
  assert.equal(fields.ReaderExtension, 'pdf');assert.ok(fields.ReaderLink.includes('document.pdf'));
}
{
  const fields = VoiceOfMLReader.assetFields({s: 2, m: 'p', b: 'vomebook/pdf-pages-v2',
    p: base + 'b'.repeat(16) + '/page-manifest.json'}, '/api/reader-bucket-resource', 'djvu');
  assert.equal(fields.ReaderExtension, 'pdf-pages');
  const direct = reading();direct.primary.kind = 'djvu';direct.primary.resource = {...ref('document.djvu'), sha256: source};
  assert.ok(VoiceOfMLReader.isBucketPath(direct.primary.resource.path, true));
  assert.equal(VoiceOfMLReader.isBucketPath(direct.primary.resource.path.replace('objects/aa/', 'objects/ff/'), true), false);
  assert.equal(validateReadingManifest(direct, 10000), direct);
  const invalid = structuredClone(direct);invalid.preview = {page_count:2, complete:true, ready_pages:2,
    partitions:[{start:1,end:2,complete:true,resource:ref('preview/partition-000001-000002-manifest.json')}]};
  invalid.components.preview = 'ready';
  assert.throws(() => validateReadingManifest(invalid, 10000), /DJVU_LEGACY_READING_UNSUPPORTED/);
  const mismatch = structuredClone(direct);mismatch.primary.resource.sha256 = 'c'.repeat(64);
  assert.throws(() => validateReadingManifest(mismatch, 10000), /PDF_V3_INVALID/);
}
console.log('PDF and DjVu primary reading, no legacy image fallback, OCR retention passed', root);

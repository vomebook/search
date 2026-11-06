import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Load the actual classic-script contract, including its RegExp-based isBucketPath.
globalThis.window = globalThis;
createRequire(import.meta.url)('../../../static/reader/core/reader-contract.js');
const { validateResource, validateReadingManifest, validatePageMap, validateTextLayer, createV3Repository } =
  await import('../../../static/reader/pdf/reader-v3.mjs');
const json = value => JSON.parse(JSON.stringify(value));
const invalid = error => error?.message === 'PDF_V3_INVALID';
const s = 'a'.repeat(64), gen = 'b'.repeat(64), base = `objects/aa/${s}/${'d'.repeat(16)}`;
const ref = (path, bucket = 'vomebook/pdf-pages-v2') => ({ bucket, path, role: 'runtime', sha256: gen, bytes: 10 });
const res = path => ref(`${base}/${path}`);
const indexRef = res('text-layer-manifest.json'), partRef = res('text/partition-000001-000001-manifest.json');
const layerRef = res('text/page-000001.json.gz');
const part = { start: 1, end: 1, resource: partRef };
const entry = { page: 1, generation: gen, page_identity: s, quality: 'unreviewed', processing: 'processed', resource: layerRef };
const layer = { version: 1, kind: 'pdf-text-layer', source_sha256: s, page: 1, generation: gen,
  raw_sha256: s, page_identity: s, offset_unit: 'unicode-codepoint', text: '', revision: 'raw',
  quality: 'unreviewed', processing: 'processed', geometry: { width: 1, height: 1, coordinate_space: 'normalized-page' }, regions: [] };
const index = { version: 1, kind: 'pdf-text-layer-index', complete: true, source_sha256: s, page_count: 1,
  generation: gen, revision: 'raw', offset_unit: 'unicode-codepoint', partitions: [part],
  book_text: res('text/book-text.json.gz'), search_partitions: [{ ...part, resource: res('text/search-000001-000001.json.gz') }] };
const partition = { version: 1, kind: 'pdf-text-partition', source_sha256: s, generation: gen, start: 1, end: 1, pages: [entry] };
const manifest = { version: 3, kind: 'pdf-reading', source_sha256: s, generation: gen, page_count: 1, source_key: 'x',
  primary: { kind: 'pdf', status: 'ready', resource: res('document.pdf') }, page_map: res('page-map.json.gz'),
  preview: { complete: true, page_count: 1, ready_pages: 1, partitions: [{ ...part, complete: true }] },
  components: { document: 'ready', preview: 'ready', text: 'pending' } };
const map = { version: 1, kind: 'pdf-page-map', source_sha256: s, pages: [{ page: 1, identity: s, width: 1, height: 1, rotation: 0, crop_box: [0, 0, 1, 1], media_box: [0, 0, 1, 1] }] };
function repository(root = index, pages = partition, text = layer) {
  const payloads = new Map([[indexRef.path, JSON.stringify(root)], [partRef.path, JSON.stringify(pages)], [layerRef.path, JSON.stringify(text)]]);
  return createV3Repository({ pageCount: 1, sourceSha: s, resourceUrl: r => r.path,
    readJson: url => JSON.parse(payloads.get(url)) });
}

test('resource paths use the real contract and reject JSON coercion', () => {
  for (const r of [res('page-map.json.gz'), res('pages/page-000001.png'),
    ref(`${base}/page-manifest.json`), ref(`documents/pdf/foo/${s}/document.pdf`, 'vomebook/reader-assets-v2')]) {
    assert.deepEqual(validateResource(json(r)), r);
  }
  const path = res('page-map.json.gz').path;
  assert.equal(globalThis.VoiceOfMLReader.isBucketPath([path], true, 'vomebook/pdf-pages-v2'), true);
  for (const bad of [[path], { toString: null }, null, 42, '../x']) {
    assert.throws(() => validateResource(json({ ...indexRef, path: bad })), invalid);
  }
  assert.throws(() => validateResource(json({ ...indexRef, bucket: 'bad' })), invalid);
});
test('manifest preview null partition', () => {
  assert.deepEqual(validateReadingManifest(json(manifest), 10), manifest);
  assert.throws(() => validateReadingManifest(json({ ...manifest, preview: { ...manifest.preview, partitions: [null] } }), 10), invalid);
});
test('page map null entry', () => {
  assert.deepEqual(validatePageMap(json(map), json(manifest)), map);
  assert.throws(() => validatePageMap(json({ ...map, pages: [null] }), json(manifest)), invalid);
});
test('text index, partition and layer positive chain', async () => {
  assert.deepEqual(await repository().textPage(json(indexRef), 1), layer);
  assert.deepEqual(validateTextLayer(json(layer), json(entry), s), layer);
});
test('text layer null entry', () => {
  // Direct API boundary, not independently reachable through validated partition pages.
  assert.throws(() => validateTextLayer(json(layer), json(null), s), invalid);
});
for (const [name, root] of [
  ['root null', null], ['part null', { ...index, partitions: [null] }],
  ['search part null', { ...index, search_partitions: [null] }],
]) test(`text index ${name}`, async () => {
  await assert.rejects(repository(root).textIndex(json(indexRef)), invalid);
});
for (const [name, pages] of [['root null', null], ['entry null', { ...partition, pages: [null] }]]) {
  test(`text partition ${name}`, async () => {
    await assert.rejects(repository(index, pages).textPage(json(indexRef), 1), invalid);
  });
}
test('parse errors and unrelated repository error remain distinct', async () => {
  const repo = createV3Repository({ pageCount: 1, sourceSha: s, resourceUrl: r => r.path, readJson: () => JSON.parse('{') });
  await assert.rejects(repo.textIndex(json(indexRef)), SyntaxError);
  const other = res('text-review-manifest.json');
  await assert.rejects(repo.textIndex(json(other)), error => error.message === 'PDF_V3_GENERATION_CHANGED');
  assert.throws(() => JSON.parse('{'), SyntaxError);
});

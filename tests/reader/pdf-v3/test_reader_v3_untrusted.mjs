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
  const region = (order,start,end,text) => ({id:`r${order}`,order,start,end,text,box:[0,0,1,1],
    quad:[[0,0],[1,0],[1,1],[0,1]],writing_mode:'horizontal-ltr',direction:'ltr'});
  // The cursor treats a surrogate pair as one point and lone halves as
  // individual points, exactly as Array.from; omitted gaps are allowed.
  const sample = {...layer,text:'A😀中\ud800X\udc00Z',regions:[
    region(0,1,2,'😀'),region(1,3,4,'\ud800'),region(2,5,6,'\udc00')]};
  assert.strictEqual(validateTextLayer(sample,entry,s),sample);
  // Every field below is independent of the Unicode-offset optimization.
  for (const mutate of [
    r=>({...r,box:[0,0,0,1]}), r=>({...r,box:[0,0,NaN,1]}),
    r=>({...r,quad:[[0,0],[0,0],[0,0],[0,0]]}),
    r=>({...r,quad:[[0,0],[1,0],[1,1],[0,2]]}),
    r=>({...r,writing_mode:'invalid'}), r=>({...r,direction:'invalid'}),
    r=>({...r,id:null}), r=>({...r,start:0.5}), r=>({...r,end:Number.MAX_SAFE_INTEGER+1}),
    r=>({...r,text:null})
  ]) assert.throws(()=>validateTextLayer({...sample,regions:[mutate(sample.regions[0])]},entry,s),invalid);
  for (const mutate of [
    v=>({...v,generation:'0'.repeat(64)}), v=>({...v,page_identity:'0'.repeat(64)}),
    v=>({...v,source_sha256:'0'.repeat(64)}), v=>({...v,page:2}),
    v=>({...v,offset_unit:'utf16'}), v=>({...v,quality:'partially-reviewed'}),
    v=>({...v,processing:'pending'}), v=>({...v,geometry:{...v.geometry,width:0}}),
    v=>({...v,geometry:{...v.geometry,coordinate_space:'pixels'}}),
    v=>({...v,regions:Array(10001).fill(sample.regions[0])})
  ]) assert.throws(()=>validateTextLayer(mutate(sample),entry,s),invalid);
  const correctedEntry = {...entry,quality:'partially-reviewed'};
  const corrected = {...sample,revision:'accepted',quality:'partially-reviewed',
    parent_generation:s,acceptances:[{id:'accepted'}]};
  assert.strictEqual(validateTextLayer(corrected,correctedEntry,s),corrected);
  for (const broken of [
    {...corrected,parent_generation:'bad'}, {...corrected,acceptances:[]},
    {...corrected,quality:'unreviewed'}
  ]) assert.throws(()=>validateTextLayer(broken,correctedEntry,s),invalid);
  for (const regions of [
    [region(0,1,2,'中')], [region(0,1,2,'\ud83d')],
    [region(0,7,8,'Z')], [region(0,6,8,'Z')], [region(0,2,2,'')],
    [region(0,0,2,'A😀'),region(1,1,2,'😀')], [region(0,1,2,'😀'),region(1,3,4,'\ud800')].map(r=>({...r,id:'same'})),
    [region(0,0,1,'A'),{...region(1,1,2,'😀'),order:2}],
  ]) assert.throws(()=>validateTextLayer({...sample,regions},entry,s),invalid);

  // Differentially check the code-point/text envelope against the prior
  // Array.from semantics, including unpaired surrogates and escaped controls.
  let seed = 0x12345678;
  const random = n => {seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed % n;};
  const alphabet = ['A','中','😀','\ud800','\udc00','\u0000','\n','🦋'];
  for (let trial = 0; trial < 400; trial++) {
    let text = '';
    for (let i=0, length=random(25); i<length; i++) text += alphabet[random(alphabet.length)];
    const chars = Array.from(text), start = random(chars.length+4)-1, end = random(chars.length+5)-1;
    const pieces = [chars.slice(Math.max(0,start),Math.max(0,end)).join(''),
      text.slice(Math.max(0,start),Math.max(0,end)), '', '😀'];
    const value = {...layer,text,regions:[region(0,start,end,pieces[random(pieces.length)])]};
    const expected = start >= 0 && end > start && end <= chars.length &&
      chars.slice(start,end).join('') === value.regions[0].text;
    let accepted = true;
    try {validateTextLayer(value,entry,s);} catch (error) {if (!invalid(error)) throw error; accepted = false;}
    assert.equal(accepted,expected,JSON.stringify({text,start,end,regions:value.regions}));
  }

  // The validation path must not allocate a code-point array, including for
  // an empty region list and for a small region near a long-page tail.
  const nativeFrom = Array.from, hugeText = '😀中'.repeat(150000);
  try {
    Array.from = (...args) => {if (typeof args[0] === 'string') throw new Error('unexpected code-point array');return nativeFrom(...args);};
    assert.strictEqual(validateTextLayer({...layer,text:hugeText,regions:[]},entry,s).text,hugeText);
    const last = {...layer,text:hugeText,regions:[region(0,299998,300000,'😀中')]};
    assert.strictEqual(validateTextLayer(last,entry,s),last);
    const tooLong = {...layer,text:hugeText,regions:[region(0,299998,300001,'😀中')]};
    assert.throws(()=>validateTextLayer(tooLong,entry,s),invalid);
  } finally {Array.from = nativeFrom;}
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

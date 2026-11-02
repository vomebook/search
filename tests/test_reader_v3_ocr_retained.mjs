import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const load = name => import(pathToFileURL(path.join(root, 'static/reader', name)).href);
const sandbox = {self: {}, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, DataView};
sandbox.self = sandbox;
for (const file of ['reader-contract.js', 'reader-security.js'])
  vm.runInNewContext(fs.readFileSync(path.join(root, 'static/reader/core', file), 'utf8'), sandbox);
globalThis.VoiceOfMLReader = sandbox.VoiceOfMLReader;
globalThis.VoiceOfMLReaderSecurity = sandbox.VoiceOfMLReaderSecurity;
globalThis.location = {href: 'https://voiceofml-search.hf.space/static/reader.html'};
Object.defineProperty(globalThis, 'crypto', {configurable: true, value: webcrypto});
const {createV3Repository, validateResource} = await load('pdf/reader-v3.mjs');
const {createReaderPdfTextRuntime} = await load('pdf/reader-pdf-text-runtime.mjs');
const source = 'a'.repeat(64), generation = 'b'.repeat(64), identity = 'c'.repeat(64);
const base = `objects/aa/${source}/${'d'.repeat(16)}`;
const objects = new Map();
async function object(name, value) {
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const bytes = name.endsWith('.gz') ? gzipSync(plain) : plain;
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const ref = {bucket: 'vomebook/pdf-pages-v2', path: `${base}/${name}`, bytes: bytes.length, sha256, role: 'runtime'};
  objects.set(ref.path, bytes);
  return ref;
}
const layer = {version: 1, kind: 'pdf-text-layer', source_sha256: source, page: 1, generation,
  raw_sha256: 'e'.repeat(64), page_identity: identity, offset_unit: 'unicode-codepoint', text: '校订',
  revision: 'accepted', quality: 'partially-reviewed', processing: 'processed', parent_generation: 'f'.repeat(64),
  acceptances: [{id: 'fixture'}], geometry: {width: 600, height: 800, coordinate_space: 'normalized-page'},
  regions: [{id: 'r1', order: 0, start: 0, end: 2, text: '校订', box: [0, 0, .5, .5],
    quad: [[0, 0], [.5, 0], [.5, .5], [0, .5]], writing_mode: 'auto', direction: 'ltr'}]};
const page = await object('text/page-000001.json.gz', layer);
const partition = await object('text/partition-000001-000001-manifest.json', {
  version: 1, kind: 'pdf-text-partition', source_sha256: source, generation, start: 1, end: 1,
  pages: [{page: 1, generation, page_identity: identity, quality: layer.quality, processing: layer.processing, resource: page}]
});
const book = await object('text/book-text.json.gz', {kind: 'fixture'});
const index = await object('text-layer-manifest.json', {version: 1, kind: 'pdf-text-layer-index', complete: true,
  source_sha256: source, page_count: 1, generation, revision: 'effective', offset_unit: 'unicode-codepoint',
  partitions: [{start: 1, end: 1, resource: partition}], book_text: book});

let corrupt = false;
const requests = [];
const reader = {readerAbortController: new AbortController(), validateResource, createV3Repository,
  readerDownloadApiUrl: value => value,
  fetchReaderUrl: async url => {
    const key = new URL(url).searchParams.get('path');
    requests.push(key);
    const bytes = objects.get(key);
    if (!bytes) return new Response('', {status: 404});
    const data = bytes.slice();
    if (corrupt && key === page.path) data[data.length - 2] ^= 1;
    return new Response(data);
  }};
Object.assign(reader, createReaderPdfTextRuntime(reader));
const repository = reader.createPdfV3Repository(source, 1);
assert.equal(repository.preview, undefined);
assert.deepEqual(await repository.textPage(index, 1), layer);
assert.deepEqual(requests, [index.path, partition.path, page.path]);
repository.dispose();
await assert.rejects(repository.textPage(index, 1), {name: 'AbortError'});
corrupt = true;
const bad = reader.createPdfV3Repository(source, 1);
await assert.rejects(bad.textPage(index, 1), /PDF_OCR_HASH_MISMATCH/);
bad.dispose();
console.log('Independent OCR text, accepted corrections and SHA-256 checks remain available', root);

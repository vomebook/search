import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const load = file => import(pathToFileURL(path.join(root, 'static/reader', file)).href);
const sandbox = {self: {}, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, DataView};
sandbox.self = sandbox;
for (const file of ['reader-contract.js', 'reader-security.js'])
  vm.runInNewContext(fs.readFileSync(path.join(root, 'static/reader/core', file), 'utf8'), sandbox);
globalThis.VoiceOfMLReader = sandbox.VoiceOfMLReader;
globalThis.location = {href: 'https://vomebook.github.io/search/static/reader.html'};
Object.defineProperty(globalThis, 'crypto', {configurable: true, value: webcrypto});

const {isV3Path, validateResource} = await load('pdf/reader-v3.mjs');
const {createReaderUi} = await load('ui/reader-ui.mjs');
const source = 'a'.repeat(64), base = `objects/aa/${source}/` + 'b'.repeat(16);
const body = new TextEncoder().encode('exact lossless DjVu reading PNG');
const digest = Buffer.from(await crypto.subtle.digest('SHA-256', body)).toString('hex');
const ref = file => ({bucket: 'vomebook/pdf-pages-v2', path: `${base}/${file}`, bytes: body.length,
  sha256: digest, role: 'runtime'});
const security = sandbox.VoiceOfMLReaderSecurity;
globalThis.VoiceOfMLReaderSecurity = security;

for (const codecs of [['png', 'png'], ['png', 'jxl'], ['png', 'webp'], ['webp', 'jxl']]) {
  const manifest = {version: 2, kind: 'pdf-pages', source_sha256: source, source_format: 'djvu', page_count: 2,
    codec: codecs[0] === codecs[1] ? codecs[0] : 'mixed', images: codecs.map(codec => ({codec, sha256: digest, bytes: body.length}))};
  security.validatePdfPageManifest(manifest);
  for (const change of [{source_format: 'pdf'}, {source_format: undefined}, {images: manifest.images.slice(1)},
    {images: [{codec: 'png', bytes: 0, sha256: digest}, manifest.images[1]]}])
    assert.throws(() => security.validatePdfPageManifest({...manifest, ...change}), /PDF_MANIFEST_INVALID/);
  if (manifest.codec === 'mixed') assert.throws(() => security.validatePdfPageManifest({...manifest,
    images: [{...manifest.images[0], codec: '../png'}, manifest.images[1]]}), /PDF_MANIFEST_INVALID/);
}
assert.equal(isV3Path(ref('pages/page-000001.png').path), true);
assert.throws(() => validateResource({...ref('pages/page-000001.png'), bucket: 'vomebook/reader-assets-v2'}, source), /PDF_V3_INVALID/);
for (const mode of ['pdf', 'pdf-pages', 'image-pages']) {
  const anchor = {isConnected: true, getBoundingClientRect: () => ({top: 238, height: 577})};
  const reader = {capability: {mode}, foliateScrollAnchors: {capture: () => null, restore() {}},
    pageAtMarker: () => anchor, documentState: {zoom: 1}, content: {style: {setProperty() {}}}, zoomInput: {},
    viewport: {scrollTop: 385, scrollHeight: 1193, clientHeight: 808, scrollLeft: 0, scrollWidth: 390, clientWidth: 390,
      getBoundingClientRect: () => ({top: 36})},
    pdfShellWindow: {resize: () => {reader.viewport.scrollHeight = 1307;}},
    readerRuntime: {update: (_section, changes) => Object.assign(reader.documentState, changes)}};
  Object.assign(reader, createReaderUi(reader));reader.setZoom(110, false);
  assert.equal(reader.viewport.scrollTop, 499, mode + ' retains the short last-page anchor on zoom');
}
console.log('Pages historical PNG metadata and zoom anchor passed');

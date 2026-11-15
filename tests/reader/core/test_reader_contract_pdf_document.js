const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { self: {}, URL, URLSearchParams };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../static/reader/core/reader-contract.js'), 'utf8'), sandbox);
const { assetFields } = sandbox.self.VoiceOfMLReader;
const base = '/api/reader-bucket-resource';
const bucket = 'vomebook/pdf-pages-v2';
const root = `objects/aa/${'a'.repeat(64)}/${'b'.repeat(16)}`;
const pdf = `${root}/document.pdf`;
const asset = { s: 2, m: 'p', p: `${root}/page-manifest.json`, b: bucket, pdb: bucket };
const link = `${base}?path=${encodeURIComponent(pdf)}`;

for (const pd of [[pdf], { toString: () => pdf }, null, undefined, '', `${root}/document.txt`]) {
  assert.strictEqual(assetFields({ ...asset, pd }, base, 'epub'), null);
  assert.strictEqual(assetFields({ ...asset, pd }, base).ReaderPdfDocument, '');
}
assert.strictEqual(assetFields({ ...asset, pd: pdf }, base, 'epub').ReaderLink, link);
assert.strictEqual(assetFields({ ...asset, pd: pdf }, base, 'epub').ReaderExtension, 'pdf');
assert.strictEqual(assetFields({ ...asset, pd: pdf }, base).ReaderPdfDocument, link);
for (const pdb of ['invalid', null, undefined]) {
  assert.strictEqual(assetFields({ ...asset, pd: pdf, pdb }, base, 'epub'), null);
  assert.strictEqual(assetFields({ ...asset, pd: pdf, pdb }, base).ReaderPdfDocument, '');
}

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { self: {}, URL, URLSearchParams, TextEncoder };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../static/reader/core/reader-contract.js'), 'utf8'), sandbox);
const { assetFields, readerUrl, shortSourceId } = sandbox.self.VoiceOfMLReader;
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
const ocr = `${root}/ocr-manifest.json`;
const ocrFields = {ReaderOcrManifest: `${base}?path=${encodeURIComponent(ocr)}`, ReaderOcrMode: 'text'};
const both = {...asset, o:ocr, om:'text', pd:pdf};
assert.deepStrictEqual({...assetFields({...both, s:3}, base)}, ocrFields);
assert.deepStrictEqual({...assetFields(both, base, '.DJVU')}, ocrFields);
assert.deepStrictEqual({...assetFields(both, base, 'epub')}, {...ocrFields, ReaderLink:link, ReaderExtension:'pdf'});

const original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/book.epub';
const record = {Link:'https://example.test/book.epub', File:'书', Extension:'epub', ReaderExtension:'pdf',
  ReaderLink:link, DownloadLink:original, ReaderPdfDocument:link, ...ocrFields,
  ChapterManifest:'/chapter', ReturnUrl:'/results', Repo:'VoiceOfML/Test', Folder:['A','B'], FolderUrl:'/folder'};
const params = (value) => [...new URL(readerUrl(value, '/reader.html'), 'https://example.test').searchParams];
assert.deepStrictEqual(params(record), [['id',shortSourceId(original)],['title','书.epub'],['ext','pdf']]);
assert.deepStrictEqual(params({...record, DownloadLink:record.Link}), [
  ['url',link], ['title','书.epub'], ['ext','pdf'], ['download',record.Link], ['ocr_manifest',ocrFields.ReaderOcrManifest],
  ['pdf_document',link], ['chapter_manifest','/chapter'], ['return','/results'], ['path','Test/A/B'], ['folder_url','/folder']
]);

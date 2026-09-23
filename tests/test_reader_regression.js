const fs = require('fs')
const path = require('path')
const assert = require('assert')
const vm = require('vm')
const { TextEncoder } = require('util')
const { assertCode } = require('./reader_source_contract')

const root = path.resolve(__dirname, '..')
const reader = fs.readFileSync(path.join(root, 'static/reader.js'), 'utf8')
const contract = fs.readFileSync(path.join(root, 'static/reader-contract.js'), 'utf8')
const sandbox = { self: {}, TextEncoder, URLSearchParams, URL }
vm.runInNewContext(contract, sandbox)

const assets = sandbox.self.VoiceOfMLReader
const vectors = require('./reader-contract-vectors.json')
for (const [value, expected] of vectors.ids) assert.strictEqual(assets.shortSourceId(value), expected)
const idPrefix = 'https://huggingface.co/datasets/VoiceOfML/VOMEBOOK/resolve/main/'
for (const [value, expected] of vectors.canonicalPaths) {
  assert.strictEqual(assets.canonicalSourceUrl(idPrefix + value), idPrefix + expected)
  assert.strictEqual(assets.canonicalSourceUrl(idPrefix + expected), idPrefix + expected)
  assert.strictEqual(assets.shortSourceId(idPrefix + value), assets.shortSourceId(idPrefix + expected))
}
for (const bookPath of [vectors.reportedBook.path, vectors.reportedBook.path.split('/').map(encodeURIComponent).join('/')]) {
  const link = idPrefix + bookPath
  assert.strictEqual(assets.shortSourceId(link), vectors.reportedBook.id)
  assert.strictEqual(new URL(assets.readerUrl({ Link: link, Extension: 'pdf' }), 'https://site.test').searchParams.get('id'), vectors.reportedBook.id)
}
assert.notStrictEqual(assets.shortSourceId(idPrefix + 'a%2Fb.pdf'), assets.shortSourceId(idPrefix + 'a/b.pdf'))
assert.notStrictEqual(assets.shortSourceId(idPrefix + 'a%2528.pdf'), assets.shortSourceId(idPrefix + 'a%28.pdf'))
for (const [record, expected] of vectors.ocr) {
  const relative = [...record.Folder, record.File + (record.Extension ? '.' + record.Extension : '')].join('/')
  assert.strictEqual(assets.txtRelativePath(relative), expected)
}
const assetRoot = 'objects/aa/' + 'a'.repeat(64) + '/'
const sourcePrefix = '/datasets/vomebook/Reader-Assets/resolve/main/'
for (const directory of ['', 'converter-v1/', 'b'.repeat(16) + '/', 'b'.repeat(16) + '/converter-v1/']) {
  const path = assetRoot + directory + 'linearized.pdf'
  const fields = assets.assetFields({s: 2, m: 'p', p: path}, '/api/reader-bucket-resource')
  assert.strictEqual(fields.ReaderExtension, 'pdf')
  assert.strictEqual(assets.isAssetSourcePath(sourcePrefix + path), true)
}
for (const extension of ['epub', 'mobi', 'azw', 'azw3', 'fb2']) {
  const fields = assets.assetFields({s: 2, m: 'e', p: assetRoot + 'document.' + extension})
  assert.strictEqual(fields.ReaderExtension, extension)
}
const bucket = assetRoot + 'b'.repeat(16) + '/page-manifest.json'
for (const suffix of ['', 'b'.repeat(16) + '/']) {
  const url = 'https://hf-mirror.com' + sourcePrefix.replace('/main/', '/revision/') + assetRoot + suffix + 'page-manifest.json'
  const parsed = assets.pdfPageSource(url, 'https://site.test', 'https://api.test')
  assert.strictEqual(parsed.root, (assetRoot + suffix).slice(0, -1))
  assert.strictEqual(parsed.pageUrl(2), url.replace('page-manifest.json', 'pages/page-000002.webp'))
  assert.throws(() => parsed.pageUrl(0), /PDF_PAGE_INVALID/)
}
assert.ok(assets.pdfPageSource('https://api.test/api/reader-bucket-resource?path=' + encodeURIComponent(bucket), 'https://site.test', 'https://api.test'))
for (const url of ['https://evil.test' + sourcePrefix + bucket, 'https://api.test/api/reader-bucket-resource?path=' + encodeURIComponent(assetRoot + 'page-manifest.json')])
  assert.strictEqual(assets.pdfPageSource(url, 'https://site.test', 'https://api.test'), null)
assert.strictEqual(assets.assetFields({s: 2, m: 'p', p: bucket}, '/api/reader-bucket-resource'), null)
assert.strictEqual(assets.assetFields({s: 2, m: 'p', p: bucket, b: 'vomebook/pdf-pages'}, '/api/reader-bucket-resource').ReaderLink,
  '/api/reader-bucket-resource?path=' + encodeURIComponent(bucket))
const optimized = assetRoot + 'pdf-range-v1-document/document.pdf'
const optimizedFields = assets.assetFields(
  {s: 2, m: 'p', p: optimized, b: 'vomebook/pdf-optimized'},
  '/api/reader-bucket-resource'
)
assert.strictEqual(optimizedFields.ReaderLink,
  '/api/reader-bucket-resource?bucket=vomebook%2Fpdf-optimized&path=' + encodeURIComponent(optimized))
assert.strictEqual(assets.isAssetSourcePath(sourcePrefix + 'pdf_manifest.json'), true)
assert.strictEqual(assets.isAssetSourcePath(sourcePrefix + assetRoot + 'epub-chapters/chapters/chapter-0012.xhtml'), true)
for (const path of [assetRoot + '../linearized.pdf', assetRoot + 'private.json', 'objects/invalid/document.pdf']) {
  assert.strictEqual(assets.assetFields({s: 2, m: 'p', p: path}), null)
  assert.strictEqual(assets.isAssetSourcePath(sourcePrefix + path), false)
}

for (const extension of ['pdf', 'pdf-pages', 'txt', 'md', 'markdown', 'html', 'htm', 'docx', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'jpg', 'png', 'mp3', 'm4a', 'flac', 'mpga', 'audio', 'mp4', 'mov', 'video']) {
  assert.ok(sandbox.self.VoiceOfMLReader.capability(extension).mode, extension)
}
for (const extension of ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz']) assert.strictEqual(sandbox.self.VoiceOfMLReader.capability(extension).mode, 'foliate')
for (const extension of sandbox.self.VoiceOfMLReader.articleExtensions) assert.deepStrictEqual(Object.keys(sandbox.self.VoiceOfMLReader.capability(extension).features).sort(), ['bookmarks', 'media', 'pagination', 'search', 'toc', 'zoom'])
assert.strictEqual(sandbox.self.VoiceOfMLReader.capability('pdf-pages').mode, 'pdf-pages')
assert.strictEqual(sandbox.self.VoiceOfMLReader.capability('pdf-pages').features.toc, true)
assert.strictEqual(sandbox.self.VoiceOfMLReader.capability('epub-chapters').features.search, true)
for (const extension of ['mp3', 'm4a', 'flac', 'mpga', 'audio']) assert.strictEqual(sandbox.self.VoiceOfMLReader.capability(extension).mode, 'audio')
for (const extension of ['mp4', 'mov', 'video']) assert.strictEqual(sandbox.self.VoiceOfMLReader.capability(extension).mode, 'video')
assert.strictEqual(sandbox.self.VoiceOfMLReader.capability('zip').mode, null)
const convertedUrl = sandbox.self.VoiceOfMLReader.readerUrl({
  Link: 'https://download.example.test/books/book.mobi',
  File: '原始书名', Extension: 'mobi', ReaderExtension: 'epub',
  DownloadLink: 'https://download.example.test/books/book.mobi',
  ReaderFallback: 'https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/fallback.pdf',
  ReaderChapterManifest: 'https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/chapters.json',
}, '/static/reader.html')
const convertedParams = new URL(`https://example.test${convertedUrl}`).searchParams
assert.strictEqual(convertedParams.get('ext'), 'epub')
assert.strictEqual(convertedParams.get('title'), '原始书名.mobi')
assert.strictEqual(convertedParams.get('download'), 'https://download.example.test/books/book.mobi')
assert.strictEqual(convertedParams.get('fallback'), 'https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/fallback.pdf')
assert.strictEqual(convertedParams.get('chapter_manifest'), 'https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/chapters.json')
const pageAssetUrl = sandbox.self.VoiceOfMLReader.readerUrl({
  ReaderLink: 'https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/' + 'a'.repeat(64) + '/1234567890abcdef/page-manifest.json',
  ReaderExtension: 'pdf-pages', Extension: 'mobi', File: '原始书名',
})
const pageAssetParams = new URL(`https://example.test${pageAssetUrl}`).searchParams
assert.strictEqual(pageAssetParams.get('url'), 'https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/' + 'a'.repeat(64) + '/1234567890abcdef/page-manifest.json')
assert.strictEqual(pageAssetParams.get('ext'), 'pdf-pages')
const sharedAssetSource = 'https://huggingface.co/datasets/VoiceOfML/Teachers/resolve/main/books/shared.mobi'
const sharedAssetUrl = sandbox.self.VoiceOfMLReader.readerUrl({
  ReaderLink: 'https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/' + 'a'.repeat(64) + '/document.epub',
  Link: sharedAssetSource,
  File: '选中的原书', Extension: 'mobi', ReaderExtension: 'epub',
})
const sharedAssetParams = new URL(`https://example.test${sharedAssetUrl}`).searchParams
assert.strictEqual(sharedAssetParams.get('id'), sandbox.self.VoiceOfMLReader.shortSourceId(sharedAssetSource))
assert.notStrictEqual(sharedAssetParams.get('id'), 'aaaaaaaaaaaaaaaa')
const normalizedUrl = sandbox.self.VoiceOfMLReader.readerUrl({ Link: 'https://download.example.test/book.TXT', File: '书名', Extension: 'TXT', ReaderExtension: 'TXT' }, '/static/reader.html')
const normalizedParams = new URL(`https://example.test${normalizedUrl}`).searchParams
assert.strictEqual(normalizedParams.get('ext'), 'TXT')
assert.strictEqual(normalizedParams.get('title'), '书名.TXT')
assert.strictEqual(sandbox.self.VoiceOfMLReader.readerUrl(null, '/static/reader.html'), '')
assert.strictEqual(sandbox.self.VoiceOfMLReader.readerUrl({ Link: 'https://download.example.test/archive.zip', Extension: 'zip' }, '/static/reader.html'), '')
assert.strictEqual(sandbox.self.VoiceOfMLReader.readerUrl({ Link: 'https://download.example.test/book.txt', Extension: '.txt' }, '/static/reader.html'), '')
assert.strictEqual(sandbox.self.VoiceOfMLReader.capability('PDF').readerMode, sandbox.self.VoiceOfMLReader.ReaderMode.ORIGINAL)
assert.strictEqual(sandbox.self.VoiceOfMLReader.capability('PDF').article, true)
assert.strictEqual(sandbox.self.VoiceOfMLReader.capability('zip').readerMode, sandbox.self.VoiceOfMLReader.ReaderMode.UNSUPPORTED)
assert.strictEqual(sandbox.self.VoiceOfMLReader.capability('zip').article, false)
for (const extension of ['pdf', 'pdf-pages', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'docx', 'txt', 'md', 'html', 'jpg', 'png', 'webp', 'mp3', 'm4a', 'flac', 'mp4', 'mov']) assert.ok(sandbox.self.VoiceOfMLReader.articleExtensions.includes(extension), extension)
assert.strictEqual(Object.isFrozen(sandbox.self.VoiceOfMLReader.articleExtensions), true)
assert.strictEqual(Object.isFrozen(sandbox.self.VoiceOfMLReader.capability('pdf')), true)
const immutableRecord = { Link: 'https://download.example.test/book.txt', File: 'book', Extension: 'txt' }
const immutableBefore = JSON.stringify(immutableRecord)
const defaultReaderUrl = sandbox.self.VoiceOfMLReader.readerUrl(immutableRecord)
assert.ok(defaultReaderUrl.startsWith('/search/static/reader.html?'))
assert.strictEqual(JSON.stringify(immutableRecord), immutableBefore)
assert.strictEqual((reader.match(/function setToc\(/g) || []).length, 1)
assertCode(reader, 'const previousList = document.querySelector("#toc-list"), list = previousList.cloneNode(false)')
assertCode(reader, 'previousList.replaceWith(list)')
assert.strictEqual((reader.match(/function activateFoliateTocEntry\(/g) || []).length, 1)
assert.match(reader, /reader-source:/)
assert.match(reader, /reader-zoom/)
assert.match(reader, /readerRuntime\.track\(readerRequestManager\)/)
assert.match(reader, /readerPath[\s\S]*voice-reader-navigate/)
assert.match(reader, /title: historyTitle|title,\s*extension/)
console.log('reader regression contracts passed')

const fs = require('fs')
const path = require('path')
const assert = require('assert')
const vm = require('vm')
const { TextEncoder } = require('util')

const root = path.resolve(__dirname, '..')
const reader = fs.readFileSync(path.join(root, 'static/reader.js'), 'utf8')
const contract = fs.readFileSync(path.join(root, 'static/reader-contract.js'), 'utf8')
const sandbox = { self: {}, TextEncoder, URLSearchParams }
vm.runInNewContext(contract, sandbox)

for (const extension of ['pdf', 'pdf-pages', 'txt', 'md', 'markdown', 'html', 'htm', 'docx', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'jpg', 'png', 'mp3', 'm4a', 'flac', 'mpga', 'audio', 'mp4', 'mov', 'video']) {
  assert.ok(contract.includes(`${extension}:`) || contract.includes(`"${extension}":`), extension)
}
for (const extension of ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz']) assert.strictEqual(sandbox.self.VoiceOfMLReader.capability(extension).mode, 'foliate')
for (const extension of sandbox.self.VoiceOfMLReader.articleExtensions) assert.deepStrictEqual(Object.keys(sandbox.self.VoiceOfMLReader.capability(extension).features).sort(), ['bookmarks', 'media', 'pagination', 'search', 'toc', 'zoom'])
assert.strictEqual(sandbox.self.VoiceOfMLReader.capability('pdf-pages').mode, 'pdf-pages')
assert.strictEqual(sandbox.self.VoiceOfMLReader.capability('epub-chapters').features.search, false)
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
assert.strictEqual(new URL(`https://example.test${pageAssetUrl}`).searchParams.get('id'), 'aaaaaaaaaaaaaaaa')
assert.strictEqual(new URL(`https://example.test${pageAssetUrl}`).searchParams.get('ext'), 'pdf-pages')
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
assert.match(reader, /const previous = document\.querySelector\("#toc-list"\), list = previous\.cloneNode\(false\)/)
assert.strictEqual((reader.match(/function activateFoliateTocEntry\(/g) || []).length, 1)
assert.match(reader, /reader-source:/)
assert.match(reader, /reader-zoom/)
assert.match(reader, /readerRuntime\.track\(readerRequestManager\)/)
assert.match(reader, /readerPath.*voice-reader-navigate/)
assert.match(reader, /title: historyTitle|title,\s*extension/)
console.log('reader regression contracts passed')

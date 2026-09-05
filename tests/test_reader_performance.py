import base64
import io
import json
import pathlib
import time
import unittest
import urllib.parse
import wave
import zipfile

from tests.browser_support import local_server

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright
except ImportError:
    PlaywrightError = Exception
    sync_playwright = None


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE_URL = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/performance.pdf"
PDF_MODULE = """
export const GlobalWorkerOptions = {};
const wait = () => new Promise((resolve) => setTimeout(resolve, 15));
export function getDocument() {
  const page = {
    getViewport({ scale }) { return { width: 600 * scale, height: 800 * scale }; },
    getTextContent() { return Promise.resolve({ items: [{ str: 'Accessible PDF text', hasEOL: false }] }); },
    render() {
      window.__pdfActive = (window.__pdfActive || 0) + 1;
      window.__pdfPeak = Math.max(window.__pdfPeak || 0, window.__pdfActive);
      return { promise: wait().then(() => { window.__pdfActive -= 1; }) };
    },
  };
  return { promise: Promise.resolve({ numPages: 30, getPage: () => Promise.resolve(page), getOutline: () => Promise.resolve(window.__pdfOutlineEnabled ? [{title: '第一章', dest: [{}], items: []}] : null), getPageIndex: () => Promise.resolve(0) }) };
}
"""
STORE_SCRIPT = """
window.__storeStartedAt = performance.now();
window.__readerBookmarks = [];
window.VoiceOfMLReaderStore = Object.freeze({
  get: () => new Promise((resolve) => setTimeout(() => resolve(null), 300)),
  put: (entry) => { window.__savedReaderProgress = entry; return Promise.resolve(); }, list: () => Promise.resolve([]), remove: () => Promise.resolve(), clearHistory: () => Promise.resolve(),
  putBookmark: (entry) => { window.__readerBookmarks = window.__readerBookmarks.filter((item) => item.id !== entry.id).concat(entry); return Promise.resolve(); },
  listBookmarks: (url) => Promise.resolve(window.__readerBookmarks.filter((item) => item.url === url)),
  listAllBookmarks: () => Promise.resolve([...window.__readerBookmarks].sort((a, b) => b.createdAt - a.createdAt)),
  removeBookmark: (id) => { window.__readerBookmarks = window.__readerBookmarks.filter((item) => item.id !== id); return Promise.resolve(); }
});
"""
MARKED_SCRIPT = "window.marked = { parse: (text) => '<p>' + text + '</p>' };"
PURIFY_SCRIPT = "window.DOMPurify = { sanitize: (html) => html };"
JSZIP_SCRIPT = "window.JSZip = function() {};"
EPUB_SCRIPT = """
window.ePub = () => ({ renderTo: (frame) => ({
  on() {}, prev() {}, next() {}, themes: { register() {}, select() {}, fontSize(value) { window.__epubFontSize = value; } },
  display: () => new Promise((resolve) => setTimeout(() => {
    frame.textContent = 'EPUB readable'; resolve();
  }, 20)),
}) });
"""
DOCX_SCRIPT = """
window.docx = { renderAsync: (_bytes, body) => new Promise((resolve) => setTimeout(() => {
  body.textContent = 'DOCX readable'; resolve();
}, 20)) };
"""
PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360f8cfc000000301010018dd8db10000000049454e44ae426082"
)
IMAGE_FIXTURES = {
    "jpg": ("image/jpeg", base64.b64decode("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAAB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==")),
    "jpeg": ("image/jpeg", base64.b64decode("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAAB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==")),
    "gif": ("image/gif", base64.b64decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")),
    "bmp": ("image/bmp", bytes.fromhex("424d3a00000000000000360000002800000001000000010000000100180000000000040000000000000000000000000000000000000000000000")),
    "webp": ("image/webp", base64.b64decode("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==")),
}


def minimal_pdf():
    stream = b"BT /F1 18 Tf 20 100 Td (Reader PDF) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    payload = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(payload)); payload.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = len(payload); payload.extend(f"xref\n0 {len(objects) + 1}\n".encode()); payload.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]: payload.extend(f"{offset:010d} 00000 n \n".encode())
    payload.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(payload)


def zip_bytes(files, stored_first=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        if stored_first:
            archive.writestr(stored_first[0], stored_first[1], compress_type=zipfile.ZIP_STORED)
        for name, body in files.items(): archive.writestr(name, body)
    return output.getvalue()


def zip_bomb_metadata():
    entry = bytearray(46)
    entry[:4] = b"PK\x01\x02"
    entry[20:24] = (1).to_bytes(4, "little")
    entry[24:28] = (513 * 1024 * 1024).to_bytes(4, "little")
    entry[28:30] = (8).to_bytes(2, "little")
    entry[46:] = b"bomb.txt"
    return bytes(entry)


def minimal_epub():
    return zip_bytes({
        "META-INF/container.xml": '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        "OEBPS/content.opf": '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">reader</dc:identifier><dc:title>Reader</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
        "OEBPS/chapter.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Reader</title></head><body><p>EPUB readable</p></body></html>',
    }, ("mimetype", "application/epub+zip"))


def epub_with_navigation():
    return zip_bytes({
        "META-INF/container.xml": '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        "OEBPS/content.opf": '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">reader-e2e</dc:identifier><dc:title>Reader E2E</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="chapter-1.xhtml" media-type="application/xhtml+xml"/><item id="two" href="chapter-2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="nav"/><itemref idref="one"/><itemref idref="two"/></spine></package>',
        "OEBPS/nav.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title><style>a{color:#000} body{margin-top:900px}</style></head><body><nav epub:type="toc"><h1>目录</h1><ol><li><a href="chapter-1.xhtml#one">第一章</a></li><li><a href="chapter-2.xhtml#two">第二章</a></li></ol></nav></body></html>',
        "OEBPS/chapter-1.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="one">第一章</h1><p style="height:900px">第一章正文</p></body></html>',
        "OEBPS/chapter-2.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="two">第二章</h1><p style="height:900px">第二章正文</p></body></html>',
    }, ("mimetype", "application/epub+zip"))


def epub_with_legacy_chm_markup():
    return zip_bytes({
        "META-INF/container.xml": '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        "OEBPS/content.opf": '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">legacy-chm</dc:identifier><dc:title>Legacy CHM</dc:title><dc:language>C</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="style" href="style.css" media-type="text/css"/><item id="image" href="picture.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
        "OEBPS/style.css": "p { color: rgb(1, 2, 3); }",
        "OEBPS/picture.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="red"/></svg>',
        "OEBPS/chapter.xhtml": '<html:html xmlns:html="http://www.w3.org/1999/xhtml"><html:head><html:link rel="stylesheet" href="style.css"/></html:head><html:body><html:p id="legacy">Legacy CHM content</html:p><html:img src="picture.svg"/></html:body></html:html>',
    }, ("mimetype", "application/epub+zip"))


def epub_with_many_chapters(count=14):
    manifest = '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    spine = '<itemref idref="nav"/>'
    links = []
    files = {}
    for index in range(1, count + 1):
        manifest += f'<item id="chapter-{index}" href="chapter-{index}.xhtml" media-type="application/xhtml+xml"/>'
        spine += f'<itemref idref="chapter-{index}"/>'
        links.append(f'<li><a href="chapter-{index}.xhtml#chapter-{index}">章节 {index}</a></li>')
        files[f"OEBPS/chapter-{index}.xhtml"] = f'<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="chapter-{index}">章节 {index}</h1><p style="height:1200px">正文 {index}</p></body></html>'
    files.update({
        "META-INF/container.xml": '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        "OEBPS/content.opf": f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">reader-race</dc:identifier><dc:title>Reader Race</dc:title><dc:language>zh</dc:language></metadata><manifest>{manifest}</manifest><spine>{spine}</spine></package>',
        "OEBPS/nav.xhtml": f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>{"".join(links)}</ol></nav></body></html>',
    })
    return zip_bytes(files, ("mimetype", "application/epub+zip"))


def minimal_docx():
    return zip_bytes({
        "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX readable</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
    })


def minimal_wav():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\0\0" * 800)
    return output.getvalue()


@unittest.skipIf(sync_playwright is None, "install requirements-test.txt to run Reader performance tests")
class ReaderPerformanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = local_server()
        cls.origin, _state = cls.server.__enter__()
        cls.playwright = sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True)
        except PlaywrightError as error:
            cls.playwright.stop()
            cls.server.__exit__(None, None, None)
            raise unittest.SkipTest(f"Chromium is unavailable: {error}")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 900})
        self.page = self.context.new_page()
        self.pdf_requested_at = None
        self.page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        self.page.route("**/static/vendor/pdf.min.f80490490320.mjs", self.route_pdf)
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/pdf", body=b"pdf"))

    def tearDown(self):
        self.context.close()

    def route_pdf(self, route):
        self.pdf_requested_at = self.page.evaluate("performance.now()")
        route.fulfill(status=200, content_type="text/javascript", body=PDF_MODULE)

    def open_reader(self):
        query = json.dumps(SOURCE_URL)[1:-1]
        self.page.goto(f"{self.origin}/search/static/reader.html?url={query}&ext=pdf&title=Performance", wait_until="domcontentloaded")
        self.page.locator(".reader-page").nth(29).wait_for(state="attached")

    def test_reader_starts_with_session_metadata_before_document_load(self):
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        self.page.add_init_script("""
          sessionStorage.setItem('reader-source:metadata-probe', JSON.stringify({
            url: 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/metadata.txt',
            download: 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/metadata.txt',
            title: 'Metadata title', extension: 'txt', original_extension: 'txt',
            repo: 'Test', folder: ['Folder']
          }));
        """)
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=b"Metadata readable"))
        source = urllib.parse.quote("https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/metadata.txt", safe="")
        self.page.goto(f"{self.origin}/search/static/reader.html?id=metadata-probe&url={source}&ext=txt", wait_until="domcontentloaded")
        self.page.locator(".reader-text").wait_for(state="visible")
        self.assertEqual(self.page.locator(".reader-text").text_content(), "Metadata readable")
        self.assertEqual(self.page.locator("#title").text_content(), "Metadata title.txt")
        self.assertEqual(self.page.locator("#reader-path").text_content(), "Test/Folder")
        self.assertEqual(self.page.locator("html").get_attribute("data-reader-phase"), "ready")
        self.assertEqual(errors, [])

    def test_fetch_file_aborts_when_pagehide_disposes_reader(self):
        self.page.add_init_script(r"""
          (() => {
            const nativeFetch = window.fetch.bind(window);
            const probe = window.__fetchFileProbe = { started: false, aborted: false, result: "" };
            window.fetch = (input, init = {}) => {
              if (!String(input).includes("fetch-file-probe")) return nativeFetch(input, init);
              probe.started = true;
              return new Promise((resolve, reject) => {
                const signal = init && init.signal;
                const abort = () => {
                  probe.aborted = true;
                  probe.result = "aborted";
                  reject(new DOMException("Reader disposed", "AbortError"));
                };
                if (signal && signal.aborted) return abort();
                if (signal) signal.addEventListener("abort", abort, { once: true });
                probe.resolve = () => {
                  probe.result = "fulfilled";
                  resolve(new Response("probe", { status: 200, headers: { "content-type": "text/plain" } }));
                };
              });
            };
          })();
        """)
        self.page.unroute("https://voiceofml-search.hf.space/api/reader-content**")
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=b"Reader"))
        source = json.dumps("https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/fetch-file.txt")[1:-1]
        self.page.goto(f"{self.origin}/search/static/reader.html?url={source}&ext=txt&title=FetchFile", wait_until="domcontentloaded")
        self.page.locator(".reader-text").wait_for(state="visible")
        self.page.evaluate("""() => {
          window.__fetchFilePromise = window.fetchFile("https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/fetch-file-probe.txt")
            .then(() => { window.__fetchFileProbe.result = "fulfilled"; })
            .catch((error) => { window.__fetchFileProbe.error = error.name; });
        }""")
        self.page.wait_for_function("() => window.__fetchFileProbe.started === true")
        self.page.evaluate("""() => {
          const event = new Event("pagehide");
          Object.defineProperty(event, "persisted", { value: true });
          window.dispatchEvent(event);
        }""")
        self.page.wait_for_timeout(100)
        self.assertFalse(self.page.evaluate("() => window.__fetchFileProbe.aborted"))
        self.page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        self.page.wait_for_function("() => window.__fetchFileProbe.result === 'aborted'", timeout=2000)
        self.assertEqual(self.page.evaluate("() => window.__fetchFileProbe.error"), "AbortError")
        self.assertEqual(self.page.locator("html").get_attribute("data-reader-phase"), "disposed")

    def test_concurrent_fetch_file_callers_receive_complete_bodies(self):
        self.page.add_init_script(r"""
          (() => {
            const nativeFetch = window.fetch.bind(window);
            window.__concurrentFetchCalls = 0;
            window.fetch = (input, init = {}) => {
              if (!String(input).includes("concurrent-fetch-file")) return nativeFetch(input, init);
              window.__concurrentFetchCalls += 1;
              return Promise.resolve(new Response("complete shared body", { status: 200, headers: { "content-type": "text/plain" } }));
            };
          })();
        """)
        source = urllib.parse.quote("https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/fetch-file.txt", safe="")
        self.page.goto(f"{self.origin}/search/static/reader.html?url={source}&ext=txt&title=FetchFile", wait_until="domcontentloaded")
        self.page.locator(".reader-text").wait_for(state="visible")
        bodies = self.page.evaluate("""async () => {
          const url = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/concurrent-fetch-file.txt";
          const files = await Promise.all([window.fetchFile(url), window.fetchFile(url)]);
          return Promise.all(files.map((file) => file.text()));
        }""")
        self.assertEqual(bodies, ["complete shared body", "complete shared body"])
        self.assertEqual(self.page.evaluate("window.__concurrentFetchCalls"), 1)

    def test_id_only_resolver_is_lifecycle_managed(self):
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        self.page.add_init_script(r"""
          (() => {
            const nativeFetch = window.fetch.bind(window);
            window.__resolverProbe = { started: false, aborted: false };
            window.fetch = (input, init = {}) => {
              if (!String(input).includes("/api/reader-resolve?id=resolver-abort")) return nativeFetch(input, init);
              window.__resolverProbe.started = true;
              return new Promise((resolve, reject) => {
                const abort = () => { window.__resolverProbe.aborted = true; reject(new DOMException("Reader disposed", "AbortError")); };
                if (init.signal?.aborted) return abort();
                init.signal?.addEventListener("abort", abort, { once: true });
              });
            };
          })();
        """)
        self.page.goto(f"{self.origin}/search/static/reader.html?id=resolver-abort", wait_until="domcontentloaded")
        self.page.wait_for_function("window.__resolverProbe.started")
        self.page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        self.page.wait_for_function("window.__resolverProbe.aborted")
        self.assertEqual(self.page.locator("html").get_attribute("data-reader-phase"), "disposed")
        self.assertEqual(errors, [])

    def test_id_only_resolver_failure_uses_reader_error_ui(self):
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        self.page.route("https://voiceofml-search.hf.space/api/reader-resolve?id=resolver-failure", lambda route: route.fulfill(status=503, body="unavailable"))
        self.page.goto(f"{self.origin}/search/static/reader.html?id=resolver-failure", wait_until="domcontentloaded")
        self.page.locator(".reader-error").wait_for(state="visible")
        self.assertEqual(self.page.locator("html").get_attribute("data-reader-phase"), "failed")
        self.assertEqual(self.page.locator("#content").get_attribute("data-error-code"), "READER_NETWORK")
        self.assertEqual(errors, [])

    def test_id_only_reader_source_uses_authoritative_resolve(self):
        stored = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/stored.txt"
        authoritative = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/authoritative.txt"
        stored_data = {
            "url": stored, "download": stored, "title": "Stored title", "extension": "txt",
            "original_extension": "txt", "repo": "Test", "folder": ["Stored"],
        }
        self.page.add_init_script(
            f"sessionStorage.setItem('reader-source:id-only-authority', {json.dumps(json.dumps(stored_data))})"
        )
        self.page.route(
            "https://voiceofml-search.hf.space/api/reader-resolve?id=id-only-authority",
            lambda route: route.fulfill(
                status=200, content_type="application/json",
                body=json.dumps({"url": authoritative, "download": authoritative, "title": "Resolved title", "extension": "txt", "original_extension": "txt", "repo": "Test", "folder": "Authoritative"}),
            ),
        )
        self.page.unroute("https://voiceofml-search.hf.space/api/reader-content**")
        self.page.route(
            "https://voiceofml-search.hf.space/api/reader-content**",
            lambda route: route.fulfill(
                status=200, content_type="text/plain",
                body=b"Authoritative reader" if "authoritative.txt" in route.request.url else b"Stored reader",
            ),
        )
        self.page.goto(f"{self.origin}/search/static/reader.html?id=id-only-authority", wait_until="domcontentloaded")
        self.page.locator(".reader-text").wait_for(state="visible")
        self.assertEqual(self.page.locator(".reader-text").text_content(), "Authoritative reader")
        self.assertEqual(self.page.locator("#title").text_content(), "Resolved title.txt")
        self.assertEqual(self.page.locator("#reader-path").text_content(), "Test/Authoritative")
        self.assertNotIn("url=", self.page.url)

    def test_id_only_reader_falls_back_to_session_source_when_resolve_fails(self):
        stored = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/stored.txt"
        stored_data = {
            "url": stored, "download": stored, "title": "Stored title", "extension": "txt",
            "original_extension": "txt", "repo": "Test", "folder": ["Stored"],
        }
        self.page.add_init_script(
            f"sessionStorage.setItem('reader-source:id-only-fallback', {json.dumps(json.dumps(stored_data))})"
        )
        self.page.route("https://voiceofml-search.hf.space/api/reader-resolve?id=id-only-fallback", lambda route: route.fulfill(status=503, body="unavailable"))
        self.page.unroute("https://voiceofml-search.hf.space/api/reader-content**")
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=b"Stored reader"))
        self.page.goto(f"{self.origin}/search/static/reader.html?id=id-only-fallback", wait_until="domcontentloaded")
        self.page.locator(".reader-text").wait_for(state="visible")
        self.assertEqual(self.page.locator(".reader-text").text_content(), "Stored reader")
        self.assertEqual(self.page.locator("#title").text_content(), "Stored title.txt")

    def test_document_preparation_overlaps_delayed_history_restore(self):
        self.open_reader()
        store_started = self.page.evaluate("window.__storeStartedAt")
        self.assertIsNotNone(self.pdf_requested_at)
        self.assertLess(self.pdf_requested_at - store_started, 250)

    def test_pdf_rendering_has_bounded_concurrency_and_canvas_memory(self):
        self.open_reader()
        metrics = self.scroll_document()
        self.assertLessEqual(metrics["peak"], 2)
        self.assertLessEqual(metrics["rendered"], 11)
        self.assertGreater(metrics["pixels"], 0)

    def test_pdf_exposes_lazy_accessible_text(self):
        self.open_reader()
        first_page = self.page.locator(".reader-page").first
        self.assertEqual(first_page.get_attribute("role"), "region")
        self.assertEqual(first_page.locator("canvas").get_attribute("aria-hidden"), "true")
        self.assertEqual(first_page.locator(".reader-pdf-text").text_content(), "Accessible PDF text")

    def test_reader_panel_bookmark_search_and_theme(self):
        self.page.add_init_script("window.__pdfOutlineEnabled = true")
        self.open_reader()
        self.page.locator("#bookmark-ribbon").click()
        self.assertEqual(self.page.locator("#bookmark-popover").get_attribute("role"), "dialog")
        self.assertEqual(self.page.locator("#bookmark-ribbon").get_attribute("aria-expanded"), "true")
        self.page.locator("#bookmark-add").press("Escape")
        self.assertTrue(self.page.locator("#bookmark-popover").is_hidden())
        self.assertEqual(self.page.locator("#bookmark-ribbon").get_attribute("aria-expanded"), "false")
        self.page.locator("#bookmark-ribbon").click()
        self.assertIn("第 1 / 30 页", self.page.locator("#bookmark-prompt").text_content())
        self.page.wait_for_function("() => window.__savedReaderProgress && window.__savedReaderProgress.page === 1")
        self.page.locator("#bookmark-add").click()
        self.page.locator("#history").click()
        self.assertTrue(self.page.locator("#history-panel").evaluate("element => element.classList.contains('is-open')"))
        self.assertNotEqual(self.page.locator("#history-panel").evaluate("element => getComputedStyle(element).transitionDuration"), "0s")
        self.assertTrue(self.page.locator("#toc-tab").is_visible())
        self.assertEqual(self.page.locator('.reader-panel-tabs button[aria-selected="true"]').get_attribute("data-panel"), "toc")
        self.assertEqual(self.page.locator(".reader-panel-tabs").get_attribute("role"), "tablist")
        self.page.locator("#toc-tab").focus()
        self.page.locator("#toc-tab").press("ArrowRight")
        self.assertEqual(self.page.locator('.reader-panel-tabs button[aria-selected="true"]').get_attribute("data-panel"), "bookmarks")
        self.page.locator("#bookmarks-tab").press("ArrowLeft")
        self.assertEqual(self.page.locator("#toc-list .panel-item-main").get_attribute("role"), "link")
        self.assertEqual(self.page.locator("#toc-list .panel-item-main").evaluate("element => getComputedStyle(element).userSelect"), "text")
        self.assertEqual(self.page.locator("#toc-panel .panel-search-toggle").text_content(), "搜索")
        self.assertEqual(self.page.locator("#history-panel > footer").count(), 0)
        self.assertEqual(self.page.locator("#history-panel > header #theme-toggle").count(), 1)
        self.assertEqual(self.page.locator("#history-panel > header .icon-btn").count(), 0)
        self.assertEqual(self.page.locator("#history-clear").text_content(), "清空历史")
        self.assertLess(self.page.locator("#history-clear").evaluate("element => [...element.parentElement.children].indexOf(element)"), self.page.locator("#history-view .panel-search-toggle").evaluate("element => [...element.parentElement.children].indexOf(element)"))
        self.assertEqual(self.page.locator("#history-clear").evaluate("element => getComputedStyle(element).alignItems"), "center")
        self.assertEqual(self.page.locator("#history-view .panel-search-toggle").evaluate("element => getComputedStyle(element).transform"), "none")
        self.page.locator('.reader-panel-tabs button[data-panel="bookmarks"]').click()
        self.page.locator("#bookmarks-list .panel-item-main").filter(has_text="第 1 / 30 页").wait_for()
        self.page.locator("#bookmarks-panel .panel-search-toggle").click()
        self.assertTrue(self.page.locator("#bookmarks-panel .panel-search").evaluate("element => element.classList.contains('is-open')"))
        self.page.locator("#bookmarks-panel .panel-search").fill("不存在")
        self.assertTrue(self.page.locator("#bookmarks-list .panel-item").is_hidden())
        self.page.locator("#history").click()
        self.page.locator("#history").click()
        self.assertEqual(self.page.locator('.reader-panel-tabs button[aria-selected="true"]').get_attribute("data-panel"), "toc")
        self.page.locator('.reader-panel-tabs button[data-panel="bookmarks"]').click()
        self.page.locator("#history").click()
        self.page.locator("#history").click()
        self.assertEqual(self.page.locator('.reader-panel-tabs button[aria-selected="true"]').get_attribute("data-panel"), "toc")
        self.page.locator("#theme-toggle").click()
        self.assertEqual(self.page.locator("html").get_attribute("data-theme"), "light")
        self.assertTrue(self.page.locator("html").evaluate("element => element.classList.contains('theme-transition')"))
        self.page.wait_for_timeout(300)
        self.assertNotEqual(self.page.locator(".compact-input").first.evaluate("element => getComputedStyle(element).backgroundColor"), "rgb(37, 41, 45)")
        self.page.locator("#page-prev").hover()
        self.assertNotEqual(self.page.locator("#page-prev").evaluate("element => getComputedStyle(element).backgroundColor"), "rgb(41, 45, 49)")
        self.assertEqual(self.page.locator("#zoom").get_attribute("min"), "25")
        self.assertEqual(self.page.locator("#zoom").get_attribute("max"), "400")

    def test_reader_controls_fit_viewport_without_overlap_and_work_on_mobile(self):
        self.open_reader()

        def assert_toolbar_layout():
            layout = self.page.locator(".reader-toolbar").evaluate("""toolbar => {
              const view = {width: innerWidth, height: innerHeight};
              const selectors = ['#back', '#page-prev', '#page-number', '#page-next', '#zoom-out', '#zoom', '#zoom-in', '#history', '#download'];
              const rects = selectors.map(selector => {
                const element = document.querySelector(selector);
                const rect = element.getBoundingClientRect();
                return {selector, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, visible: !!(rect.width && rect.height)};
              }).filter(item => item.visible);
              return {toolbar: toolbar.getBoundingClientRect().toJSON(), view, rects};
            }""")
            self.assertGreaterEqual(layout["toolbar"]["height"], 36)
            for item in layout["rects"]:
                self.assertGreater(item["width"], 0, item["selector"])
                self.assertGreaterEqual(item["left"], 0, item["selector"])
                self.assertLessEqual(item["right"], layout["view"]["width"] + 1, item["selector"])
                self.assertGreaterEqual(item["top"], 0, item["selector"])
                self.assertLessEqual(item["bottom"], layout["toolbar"]["bottom"] + 1, item["selector"])
            for index, first in enumerate(layout["rects"]):
                for second in layout["rects"][index + 1:]:
                    overlap = first["left"] < second["right"] and second["left"] < first["right"] and first["top"] < second["bottom"] and second["top"] < first["bottom"]
                    self.assertFalse(overlap, f'{first["selector"]} overlaps {second["selector"]}')

        assert_toolbar_layout()
        self.page.locator("#page-next").click()
        self.assertEqual(self.page.locator("#page-number").input_value(), "2")
        self.page.locator("#page-prev").click()
        self.assertEqual(self.page.locator("#page-number").input_value(), "1")
        self.page.locator("#zoom-in").click()
        self.assertEqual(self.page.locator("#zoom").input_value(), "110")
        self.page.locator("#zoom-out").click()
        self.assertEqual(self.page.locator("#zoom").input_value(), "100")
        self.page.locator("#history").click()
        self.assertTrue(self.page.locator("#history-panel").evaluate("element => element.classList.contains('is-open')"))
        self.page.locator("#history-close").click()
        self.assertFalse(self.page.locator("#history-panel").evaluate("element => element.classList.contains('is-open')"))

        mobile_context = self.browser.new_context(viewport={"width": 390, "height": 844})
        mobile_page = mobile_context.new_page()
        mobile_page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        mobile_page.route("**/static/vendor/pdf.min.f80490490320.mjs", lambda route: route.fulfill(status=200, content_type="text/javascript", body=PDF_MODULE))
        mobile_page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/pdf", body=b"pdf"))
        query = json.dumps(SOURCE_URL)[1:-1]
        mobile_page.goto(f"{self.origin}/search/static/reader.html?url={query}&ext=pdf&title=Performance", wait_until="domcontentloaded")
        mobile_page.locator(".reader-page").nth(29).wait_for(state="attached")
        mobile_layout = mobile_page.locator(".reader-toolbar").evaluate("""toolbar => {
          const view = {width: innerWidth, height: innerHeight};
          const rects = [...toolbar.querySelectorAll('button, input, a')].map(element => {
            const rect = element.getBoundingClientRect();
            return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, visible: !!(rect.width && rect.height)};
          }).filter(item => item.visible);
          return {toolbar: toolbar.getBoundingClientRect().toJSON(), view, rects};
        }""")
        self.assertEqual(mobile_layout["view"]["width"], 390)
        self.assertGreaterEqual(mobile_layout["toolbar"]["height"], 36)
        for item in mobile_layout["rects"]:
            self.assertGreaterEqual(item["left"], 0)
            self.assertLessEqual(item["right"], 390)
            self.assertLessEqual(item["bottom"], mobile_layout["toolbar"]["bottom"] + 1)
        mobile_page.locator("#history").click()
        self.assertTrue(mobile_page.locator("#history-panel").evaluate("element => element.classList.contains('is-open')"))
        mobile_page.wait_for_timeout(300)
        panel_box = mobile_page.locator("#history-panel").bounding_box()
        self.assertIsNotNone(panel_box)
        self.assertGreaterEqual(panel_box["x"], 0)
        self.assertLessEqual(panel_box["x"] + panel_box["width"], 390)
        mobile_context.close()

    def test_reader_controls_honor_boundaries_and_keyboard_activation(self):
        self.open_reader()
        self.assertEqual(self.page.locator("#page-number").input_value(), "1")
        self.page.locator("#page-prev").click()
        self.assertEqual(self.page.locator("#page-number").input_value(), "1")
        self.page.locator("#page-next").focus()
        self.page.locator("#page-next").press("Enter")
        self.assertEqual(self.page.locator("#page-number").input_value(), "2")
        self.page.locator("#page-number").fill("999")
        self.page.locator("#page-number").press("Enter")
        self.page.wait_for_function("() => document.querySelector('#page-number').value === '30'")
        self.assertEqual(self.page.locator("#page-number").input_value(), "30")
        self.page.locator("#page-number").fill("0")
        self.page.locator("#page-number").press("Enter")
        self.page.wait_for_function("() => document.querySelector('#page-number').value === '1'")
        self.assertEqual(self.page.locator("#page-number").input_value(), "1")
        self.page.locator("#zoom").fill("999")
        self.page.locator("#zoom").press("Enter")
        self.page.wait_for_function("() => document.querySelector('#zoom').value === '400'")
        self.assertEqual(self.page.locator("#zoom").input_value(), "400")
        self.page.locator("#zoom-in").click()
        self.assertEqual(self.page.locator("#zoom").input_value(), "400")
        self.page.locator("#zoom").fill("1")
        self.page.locator("#zoom").press("Enter")
        self.page.wait_for_function("() => document.querySelector('#zoom').value === '25'")
        self.assertEqual(self.page.locator("#zoom").input_value(), "25")
        self.page.locator("#zoom-out").click()
        self.assertEqual(self.page.locator("#zoom").input_value(), "25")
        self.page.locator("#history").focus()
        self.page.locator("#history").press("Enter")
        self.assertEqual(self.page.locator("#history").get_attribute("aria-expanded"), "true")
        self.page.locator("#history-close").press("Enter")
        self.assertEqual(self.page.locator("#history").get_attribute("aria-expanded"), "false")
        self.assertTrue(self.page.locator("#download").get_attribute("href"))
        self.assertEqual(self.page.locator("#download").get_attribute("target"), "_blank")
        self.assertIn("noopener", self.page.locator("#download").get_attribute("rel"))

    def test_format_modes_expose_matching_controls_and_bookmark_ui(self):
        cases = [
            ("txt", "text", "已加载", ".reader-text", "text/plain", b"Text readable", True, False),
            ("md", "markdown", "已加载", ".reader-markdown", "text/markdown", b"# Markdown readable", True, False),
            ("html", "html", "HTML", "iframe.html-frame", "text/html", b"<p>HTML readable</p>", True, False),
            ("png", "image", "图片", ".reader-image", "image/png", PNG_BYTES, True, False),
            ("docx", "docx", "DOCX", ".docx-body", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", minimal_docx(), False, False),
        ]
        for extension, mode, status, content_selector, content_type, body, page_hidden, zoom_hidden in cases:
            with self.subTest(extension=extension):
                context = self.browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
                if extension == "md":
                    page.route("**/static/vendor/marked.min.69451c8541c9.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=MARKED_SCRIPT))
                    page.route("**/static/vendor/purify.min.c2f26ea4fc0d.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=PURIFY_SCRIPT))
                if extension == "docx":
                    page.route("**/static/vendor/jszip.min.acc7e41455a8.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=JSZIP_SCRIPT))
                    page.route("**/static/vendor/docx-preview.min.051ef503f267.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=DOCX_SCRIPT))
                page.route("**/api/reader-content**", lambda route, _request, content_type=content_type, body=body: route.fulfill(status=200, content_type=content_type, body=body))
                source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/matrix.{extension}"
                if extension == "docx":
                    source = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a" * 64 + "/docx-native-v1/document.docx"
                page.goto(f"{self.origin}/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext={extension}&title=Matrix", wait_until="domcontentloaded")
                page.wait_for_function("expected => document.querySelector('#status').textContent === expected", arg=status)
                self.assertEqual(page.locator(".reader-content").get_attribute("data-mode"), mode)
                page.locator(content_selector).wait_for(state="attached")
                self.assertTrue(page.locator("#bookmark-ribbon").is_visible())
                ribbon = page.locator("#bookmark-ribbon").bounding_box()
                self.assertIsNotNone(ribbon)
                self.assertGreaterEqual(ribbon["x"], 0)
                self.assertLessEqual(ribbon["x"] + ribbon["width"], 390)
                self.assertEqual(page.locator(".page-controls").is_hidden(), page_hidden)
                self.assertEqual(page.locator(".zoom-controls").is_hidden(), zoom_hidden)
                if not zoom_hidden:
                    page.locator("#zoom-in").click()
                    self.assertEqual(page.locator("#zoom").input_value(), "110")
                page.locator("#bookmark-ribbon").press("Enter")
                self.assertTrue(page.locator("#bookmark-popover").is_visible())
                page.locator("#bookmark-cancel").press("Escape")
                self.assertTrue(page.locator("#bookmark-popover").is_hidden())
                context.close()

    def test_video_failure_shows_recoverable_reader_error(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/api/reader-content**", lambda route: route.fulfill(status=200, content_type="video/mp4", body=b"invalid video fixture"))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/broken.mp4"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=mp4&title=Broken", wait_until="domcontentloaded")
        page.locator(".reader-error").wait_for(timeout=10000)
        self.assertIn("媒体加载失败", page.locator(".reader-error").text_content())
        self.assertEqual(page.locator("#status").text_content(), "无法打开")
        self.assertEqual(page.locator("#content").get_attribute("data-error-code"), "READER_MEDIA")
        self.assertFalse(page.locator(".reader-loading-indicator").count())
        context.close()

    def test_video_extension_aliases_report_media_errors_consistently(self):
        for extension in ("mp4", "mov", "video"):
            with self.subTest(extension=extension):
                context = self.browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                page.route("**/api/reader-content**", lambda route: route.fulfill(status=200, content_type="video/mp4", body=b"invalid video fixture"))
                source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/broken.{extension}"
                page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext={extension}&title=Broken", wait_until="domcontentloaded")
                page.locator(".reader-error").wait_for(timeout=10000)
                self.assertEqual(page.locator("#status").text_content(), "无法打开")
                context.close()

    def test_unsupported_format_hides_inapplicable_controls(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/archive.zip"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=zip&title=Archive", wait_until="domcontentloaded")
        page.locator(".reader-error").wait_for(timeout=10000)
        self.assertIn("此文件暂不支持在线阅读", page.locator(".reader-error").text_content())
        self.assertEqual(page.locator("#content").get_attribute("data-error-code"), "READER_UNSUPPORTED")
        self.assertTrue(page.locator(".page-controls").is_hidden())
        self.assertTrue(page.locator(".zoom-controls").is_hidden())
        self.assertFalse(page.locator(".reader-loading-indicator").count())
        context.close()

    def test_converted_pdf_pages_reject_invalid_manifest_and_missing_first_page(self):
        cases = [
            ("bad-manifest", {"version": 1, "kind": "pdf-pages", "pages": [{"page": 1, "path": "objects/aa/not-a-valid-page.webp"}]}),
            ("wrong-kind", {"version": 1, "kind": "pdf", "pages": [{"page": 1, "path": f"objects/aa/{'a' * 64}/pages/page-000001.webp"}]}),
            ("missing-page-number", {"version": 1, "kind": "pdf-pages", "pages": [{"page": 2, "path": f"objects/aa/{'a' * 64}/pages/page-000002.webp"}]}),
            ("duplicate-page-number", {"version": 1, "kind": "pdf-pages", "pages": [{"page": 1, "path": f"objects/aa/{'a' * 64}/pages/page-000001.webp"}, {"page": 1, "path": f"objects/aa/{'a' * 64}/pages/page-000001.webp"}]}),
            ("missing-page", {"version": 1, "kind": "pdf-pages", "pages": [{"page": 1, "path": f"objects/aa/{'a' * 64}/pages/page-000001.webp"}]}),
        ]
        for name, manifest in cases:
            with self.subTest(case=name):
                context = self.browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                source = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a" * 64 + "/page-manifest.json"
                page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
                page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route, _request, manifest=manifest: route.fulfill(status=200, content_type="application/json", body=json.dumps(manifest)))
                page.route("https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/**", lambda route: route.fulfill(status=404, body=b""))
                page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=pdf-pages&title=Converted", wait_until="domcontentloaded")
                page.locator(".reader-error").wait_for(timeout=10000)
                self.assertTrue(page.locator(".reader-error").text_content().strip())
                self.assertEqual(page.locator("#status").text_content(), "无法打开")
                self.assertFalse(page.locator(".reader-loading-indicator").count())
                context.close()

    def test_converted_pdf_pages_report_error_when_later_page_is_missing(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        source = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a" * 64 + "/page-manifest.json"
        root = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a" * 64
        manifest = {"version": 1, "kind": "pdf-pages", "pages": [{"page": index, "path": f"objects/aa/{'a' * 64}/pages/page-{index:06d}.webp"} for index in range(1, 5)]}
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(manifest)))
        def serve_page(route, _request):
            if not route.request.url.endswith("page-000004.webp"):
                route.fulfill(status=200, content_type="image/webp", body=IMAGE_FIXTURES["webp"][1])
            else:
                route.fulfill(status=404, body=b"")
        page.route(f"{root}/pages/**", serve_page)
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=pdf-pages&title=Converted", wait_until="domcontentloaded")
        page.locator(".reader-page img.ready").first.wait_for(timeout=10000)
        page.locator(".reader-page[data-page='4']").scroll_into_view_if_needed()
        page.wait_for_timeout(500)
        self.assertNotEqual(page.locator(".reader-page[data-page='4']").get_attribute("data-render-state"), "rendered")
        self.assertEqual(page.locator(".reader-page[data-page='4'] img.ready").count(), 0)
        context.close()

    def test_converted_pdf_pages_fit_wide_images_without_overlap(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        source = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a" * 64 + "/page-manifest.json"
        root = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a" * 64
        manifest = {"version": 1, "kind": "pdf-pages", "pages": [{"page": index, "path": f"objects/aa/{'a' * 64}/pages/page-{index:06d}.webp"} for index in range(1, 4)]}
        wide_page = b'<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="3200"><rect width="100%" height="100%" fill="white"/></svg>'
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-resolve?id=wide-pages", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"url": source, "download": source, "extension": "pdf-pages", "original_extension": "pdf", "title": "Converted"})))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(manifest)))
        page.route(f"{root}/pages/**", lambda route: route.fulfill(status=200, content_type="image/svg+xml", body=wide_page))
        page.goto(f"{self.origin}/search/static/reader.html?id=wide-pages&ext=pdf&title=Converted", wait_until="domcontentloaded")
        page.locator(".reader-page img.ready").first.wait_for(timeout=10000)
        self.assertEqual(page.locator("#content").get_attribute("data-mode"), "pdf-pages")
        boxes = page.locator(".reader-page").evaluate_all("""pages => pages.slice(0, 3).map(page => {
          const shell = page.getBoundingClientRect(), image = page.querySelector('img').getBoundingClientRect();
          return { shell: { top: shell.top, right: shell.right, bottom: shell.bottom, left: shell.left, width: shell.width }, image: { top: image.top, right: image.right, bottom: image.bottom, left: image.left, width: image.width } };
        })""")
        self.assertEqual(len(boxes), 3)
        for box in boxes:
            self.assertLessEqual(box["image"]["width"], box["shell"]["width"] + 1)
            self.assertGreaterEqual(box["image"]["left"], box["shell"]["left"] - 1)
            self.assertLessEqual(box["image"]["right"], box["shell"]["right"] + 1)
        for current, following in zip(boxes, boxes[1:]):
            self.assertGreaterEqual(following["shell"]["top"], current["image"]["bottom"])
        context.close()

    def test_reader_toolbar_controls_have_accessible_names_and_state(self):
        self.open_reader()
        controls = self.page.locator(".reader-toolbar button, .reader-toolbar a")
        names = self.page.locator(".reader-toolbar button:visible, .reader-toolbar a:visible").evaluate_all("""elements => elements.map(element => ({
          id: element.id,
          name: element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent.trim(),
          type: element.tagName === 'BUTTON' ? element.type : '',
          target: element.tagName === 'A' ? element.target : '',
          rel: element.tagName === 'A' ? element.rel : ''
        }))""")
        self.assertGreater(controls.count(), 0)
        for item in names:
            self.assertTrue(item["name"], item["id"])
            if item["type"]:
                self.assertEqual(item["type"], "button", item["id"])
            if item["id"] == "download":
                self.assertEqual(item["target"], "_blank")
                self.assertIn("noopener", item["rel"])
        self.page.locator("#history").click()
        self.assertEqual(self.page.locator("#history").get_attribute("aria-expanded"), "true")
        self.page.locator("#theme-toggle").click()
        self.assertIn(self.page.locator("#theme-toggle").get_attribute("aria-label"), ("切换到白天模式", "切换到夜间模式"))
        self.page.locator("#bookmark-ribbon").press("Enter")
        self.assertEqual(self.page.locator("#bookmark-ribbon").get_attribute("aria-expanded"), "true")
        self.page.locator("#bookmark-cancel").press("Escape")
        self.assertEqual(self.page.locator("#bookmark-ribbon").get_attribute("aria-expanded"), "false")

    def test_text_bookmark_uses_progress_excerpt_and_highlights_search(self):
        self.page.unroute("https://voiceofml-search.hf.space/api/reader-content**")
        text = "\n\n".join(f"第 {index} 段 searchable-{index} 这是用于书签摘要搜索的正文内容。" * 5 for index in range(120))
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain; charset=utf-8", body=text.encode()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/bookmark.txt"
        query = urllib.parse.quote(source, safe="")
        self.page.goto(f"{self.origin}/search/static/reader.html?url={query}&ext=txt&title=Bookmark", wait_until="domcontentloaded")
        self.page.locator(".reader-text").wait_for()
        self.page.locator("#viewport").evaluate("element => { element.scrollTop = element.scrollHeight * 0.5; element.dispatchEvent(new Event('scroll')); }")
        self.page.locator("#bookmark-ribbon").click()
        self.page.locator("#bookmark-label").fill("我的书签")
        self.page.locator("#bookmark-excerpt-input").fill("自定义摘要")
        self.page.locator("#viewport").evaluate("element => { element.scrollTop = element.scrollHeight * 0.35; element.dispatchEvent(new Event('scroll')); }")
        self.assertGreater(self.page.locator("#viewport").evaluate("element => element.scrollTop"), 0)
        self.assertIn("阅读进度", self.page.locator("#bookmark-prompt").text_content())
        self.assertNotIn("px", self.page.locator("#bookmark-prompt").text_content())
        self.assertRegex(self.page.locator("#bookmark-prompt").text_content(), r"阅读进度 \d+\.\d%")
        self.assertTrue(self.page.locator("#bookmark-excerpt-input").input_value())
        prompt_progress = float(self.page.locator("#bookmark-prompt").text_content().split("阅读进度 ", 1)[1].split("%", 1)[0])
        self.page.locator("#viewport").evaluate("element => { element.scrollTop = element.scrollHeight * 0.8; element.dispatchEvent(new Event('scroll')); }")
        self.page.locator("#bookmark-add").click()
        self.page.wait_for_function("() => window.__readerBookmarks.length === 1")
        bookmark = self.page.evaluate("window.__readerBookmarks[0]")
        self.assertEqual(bookmark["label"], "我的书签")
        self.assertEqual(bookmark["excerpt"], "自定义摘要")
        self.assertGreater(bookmark["progress"], 0)
        self.assertAlmostEqual(bookmark["progress"], prompt_progress, places=1)
        self.assertTrue(bookmark["excerpt"])
        self.page.evaluate("window.__readerBookmarks.push({id: 'other', url: 'https://example.test/other.txt', title: '另一本书', label: '阅读进度 12.3%', excerpt: '跨书摘要', readerUrl: location.href, createdAt: Date.now() + 1})")
        self.page.locator("#history").click()
        self.page.locator("#bookmarks-tab").click()
        self.page.locator("#bookmarks-list .bookmark-excerpt").wait_for()
        self.assertEqual(self.page.locator("#bookmarks-list .panel-item").count(), 1)
        self.page.locator("#bookmarks-all").click()
        self.page.locator("#bookmarks-list .panel-item").nth(1).wait_for()
        self.assertEqual(self.page.locator("#bookmarks-all").text_content(), "本书书签")
        self.assertIn("另一本书", self.page.locator("#bookmarks-list").text_content())
        term = bookmark["excerpt"].split()[0][:6]
        self.page.locator("#bookmarks-panel .panel-search-toggle").click()
        self.page.locator("#bookmarks-panel .panel-search").fill(term)
        self.assertGreater(self.page.locator("#bookmarks-list mark.search-match").count(), 0)
        self.page.locator("#bookmarks-panel .panel-search").fill("")
        self.page.locator("#bookmarks-list .panel-item-edit").first.click()
        self.page.locator("#bookmark-label").fill("修改后的标题")
        self.page.locator("#bookmark-excerpt-input").fill("修改后的摘要")
        self.page.locator("#bookmark-add").click()
        self.assertIn("修改后的标题", self.page.locator("#bookmarks-list").text_content())

    def test_full_text_search_lists_highlighted_snippets_and_jumps(self):
        self.page.unroute("https://voiceofml-search.hf.space/api/reader-content**")
        text = ("开头内容。" * 80) + "正文目标词出现在这里，前后都有上下文。" + ("中间内容。" * 120) + "正文目标词再次出现。"
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=text.encode()))
        source = urllib.parse.quote("https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/full-search.txt", safe="")
        self.page.goto(f"{self.origin}/search/static/reader.html?url={source}&ext=txt&title=FullSearch", wait_until="domcontentloaded")
        self.page.locator(".reader-text").wait_for()
        self.assertEqual(self.page.locator("#full-search-view").count(), 1)
        self.assertEqual(self.page.locator(".full-search-toggle").count(), 0)
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.assertFalse(self.page.locator("#full-search-view").is_hidden())
        self.page.locator("#full-search-toggle").click()
        self.page.wait_for_timeout(300)
        self.assertTrue(self.page.locator("#history-panel").is_visible())
        self.assertTrue(self.page.locator("#full-search-view").is_hidden())
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("目标词")
        self.page.locator("#full-search-status").filter(has_text="2 个结果").wait_for()
        self.assertEqual(self.page.locator("#full-search-results .full-search-result").count(), 2)
        self.assertEqual(self.page.locator("#full-search-results mark.search-match").count(), 2)
        self.assertEqual(self.page.locator(".full-search-highlight").count(), 2)
        self.assertLessEqual(len(self.page.locator("#full-search-results .full-search-result").first.text_content()), 180)
        self.page.locator("#full-search-input").fill("阅读选项")
        self.page.locator("#full-search-status").filter(has_text="未找到").wait_for()
        self.assertEqual(self.page.locator("#full-search-results .full-search-result").count(), 0)
        self.page.locator("#full-search-input").fill("目标词")
        self.page.locator("#full-search-status").filter(has_text="2 个结果").wait_for()
        self.page.locator("#full-search-results .full-search-result").nth(1).click()
        self.assertGreater(self.page.locator("#viewport").evaluate("element => element.scrollTop"), 0)

    def test_pdf_allows_two_bookmarks_on_one_page_and_restores_offsets(self):
        self.open_reader()
        self.page.locator("#bookmark-ribbon").click()
        self.page.locator("#bookmark-add").click()
        self.page.locator("#viewport").evaluate("element => { element.scrollTop = 360; element.dispatchEvent(new Event('scroll')); }")
        self.page.locator("#bookmark-ribbon").click()
        self.page.locator("#bookmark-add").click()
        bookmarks = self.page.evaluate("window.__readerBookmarks")
        self.assertEqual(len(bookmarks), 2)
        self.assertNotEqual(bookmarks[0]["id"], bookmarks[1]["id"])
        self.assertLess(bookmarks[0]["pageOffset"], bookmarks[1]["pageOffset"])
        self.page.locator("#history").click()
        self.page.locator("#bookmarks-tab").click()
        rows = self.page.locator("#bookmarks-list .panel-item-main")
        self.assertEqual(rows.count(), 2)
        self.page.locator("#viewport").evaluate("element => element.scrollTop = 0")
        rows.nth(1).click()
        self.assertGreaterEqual(self.page.locator("#viewport").evaluate("element => element.scrollTop"), 20)
        rows.nth(0).click()
        self.assertLess(self.page.locator("#viewport").evaluate("element => element.scrollTop"), 80)

    def test_pagehide_before_restoration_does_not_overwrite_progress(self):
        query = urllib.parse.quote(SOURCE_URL, safe="")
        self.page.goto(f"{self.origin}/search/static/reader.html?url={query}&ext=pdf&title=Performance", wait_until="domcontentloaded")
        self.page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        self.page.wait_for_timeout(150)
        self.assertEqual(self.page.locator("html").get_attribute("data-reader-phase"), "disposed")
        self.assertIsNone(self.page.evaluate("window.__savedReaderProgress || null"))

    def test_blocked_v1_upgrade_does_not_block_document_loading(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        blocker = context.new_page()
        blocker.goto(f"{self.origin}/search/static/reader.html", wait_until="domcontentloaded")
        blocker.evaluate("""async () => {
          await new Promise((resolve) => { const request = indexedDB.deleteDatabase('voiceofml-reader'); request.onsuccess = request.onerror = request.onblocked = resolve; });
          window.__heldDb = await new Promise((resolve, reject) => { const request = indexedDB.open('voiceofml-reader', 1); request.onupgradeneeded = () => { const store = request.result.createObjectStore('entries', {keyPath: 'url'}); store.createIndex('lastReadAt', 'lastReadAt'); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        }""")
        reader = context.new_page()
        reader.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=b"Reader"))
        source = urllib.parse.quote("https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/blocked.txt", safe="")
        reader.goto(f"{self.origin}/search/static/reader.html?url={source}&ext=txt&title=Blocked", wait_until="domcontentloaded")
        reader.locator(".reader-text").wait_for(timeout=5000)
        blocker.evaluate("window.__heldDb.close()")
        context.close()

    def test_html_bookmark_at_zero_restores_iframe_top(self):
        self.page.unroute("https://voiceofml-search.hf.space/api/reader-content**")
        document = b"<main><p style='height:1800px'>Top bookmark content</p><p>Bottom</p></main>"
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/html", body=document))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/bookmark.html"
        query = urllib.parse.quote(source, safe="")
        self.page.goto(f"{self.origin}/search/static/reader.html?url={query}&ext=html&title=HTML", wait_until="domcontentloaded")
        self.page.locator(".html-frame").wait_for()
        self.page.evaluate("url => VoiceOfMLReaderStore.putBookmark({id: url + '\\0top', url, label: '阅读进度 0.0%', htmlScrollTop: 0, scrollTop: 0, createdAt: 1})", source)
        self.page.locator("#history").click()
        self.page.locator("#bookmarks-tab").click()
        bookmark = self.page.locator("#bookmarks-list .panel-item-main")
        bookmark.wait_for()
        self.page.locator(".html-frame").evaluate("frame => frame.contentWindow.scrollTo(0, 900)")
        bookmark.click()
        self.assertEqual(self.page.locator(".html-frame").evaluate("frame => frame.contentWindow.scrollY"), 0)

    def test_stale_bookmark_query_cannot_overwrite_all_bookmarks(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        store = """window.VoiceOfMLReaderStore = Object.freeze({
          get: () => Promise.resolve(null), put: () => Promise.resolve(), list: () => Promise.resolve([]), remove: () => Promise.resolve(), clearHistory: () => Promise.resolve(),
          putBookmark: () => Promise.resolve(), removeBookmark: () => Promise.resolve(),
          listBookmarks: (url) => new Promise((resolve) => setTimeout(() => resolve([{id:'local', url, title:'Current book', label:'Current mark', createdAt:1}]), 180)),
          listAllBookmarks: () => new Promise((resolve) => setTimeout(() => resolve([{id:'all', url:'other', readerUrl:location.href, title:'All book', label:'All mark', createdAt:2}]), 10))
        });"""
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=store))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=b"Reader"))
        source = urllib.parse.quote("https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/race.txt", safe="")
        page.goto(f"{self.origin}/search/static/reader.html?url={source}&ext=txt&title=Race", wait_until="domcontentloaded")
        page.locator(".reader-text").wait_for()
        page.locator("#history").click()
        page.locator("#bookmarks-tab").click()
        page.locator("#bookmarks-all").click()
        page.locator("#bookmarks-list .panel-item-main", has_text="All book").wait_for()
        page.wait_for_timeout(220)
        self.assertEqual(page.locator("#bookmarks-list .panel-item").count(), 1)
        self.assertIn("All book", page.locator("#bookmarks-list .panel-item-main").text_content())
        context.close()

    def test_truncated_epub_reports_source_damage(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=b"PK\x03\x04truncated"))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/damaged.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=Damaged", wait_until="domcontentloaded")
        page.locator(".reader-error").wait_for(timeout=10000)
        self.assertTrue(page.locator(".reader-error").text_content().strip())
        self.assertEqual(page.locator("#content").get_attribute("data-error-code"), "READER_CORRUPT")
        context.close()

    def test_malicious_html_css_and_svg_are_inert_and_keep_safe_text(self):
        document = b'''<style>@import url("https://evil.test/style.css"); body{background:url(https://evil.test/bg)}</style>
          <p id="safe">Safe reader text</p><script>parent.__unsafe=true</script>
          <div onclick="parent.__unsafe=true"><a href="javascript:parent.__unsafe=true">safe link</a></div>
          <svg onload="parent.__unsafe=true"><image href="https://evil.test/image"></image><a xlink:href="javascript:alert(1)">svg link</a></svg>
          <link rel="stylesheet" href="https://evil.test/link.css"><img src="https://evil.test/image.png">'''
        self.page.unroute("https://voiceofml-search.hf.space/api/reader-content**")
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/html", body=document))
        external = []
        self.page.on("request", lambda request: external.append(request.url) if "evil.test" in request.url else None)
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/security.html"
        self.page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=html&title=Security", wait_until="domcontentloaded")
        self.page.wait_for_function("() => document.querySelector('#status').textContent === 'HTML'")
        frame = self.page.locator("iframe.html-frame").content_frame
        self.assertEqual(frame.locator("#safe").text_content(), "Safe reader text")
        self.assertEqual(frame.locator("body script,body link,body svg").count(), 0)
        self.assertEqual(frame.locator("body img[src], body [href^='javascript:']").count(), 0)
        self.assertEqual(frame.locator("[onclick], [href^='javascript:'], [xlink\\:href^='javascript:']").count(), 0)
        self.assertFalse(self.page.evaluate("window.__unsafe === true"))
        self.assertEqual(external, [])

    def test_oversized_chapter_manifest_and_response_use_resource_limit(self):
        digest = "a" * 64
        source = f"https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/{digest}/chapter-manifest.json"
        limit = 2 * 1024 * 1024
        cases = [("manifest", {"version": 1, "kind": "epub-chapters", "chapters": [{"index": 1, "path": "chapter.xhtml", "bytes": 10}]}, {"content-length": str(limit + 1)}, None),
                 ("chapter", {"version": 1, "kind": "epub-chapters", "chapters": [{"index": 1, "path": "chapter.xhtml", "bytes": 10}]}, {}, {"content-length": str(8 * 1024 * 1024 + 1)})]
        for name, manifest, manifest_headers, chapter_headers in cases:
            with self.subTest(case=name):
                context = self.browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
                def serve_limited(route, _request, manifest=manifest, headers=manifest_headers, chapter_headers=chapter_headers):
                    if chapter_headers and "chapter.xhtml" in route.request.url:
                        route.fulfill(status=200, content_type="text/html", headers=chapter_headers, body=b"<h1>chapter</h1>")
                    else:
                        route.fulfill(status=200, content_type="application/json", headers=headers, body=json.dumps(manifest))
                page.route("**/api/reader-content**", serve_limited)
                if chapter_headers:
                    page.route("https://huggingface.co/**", lambda route, _request, headers=chapter_headers: route.fulfill(status=200, content_type="text/html", headers=headers, body=b"<h1>chapter</h1>"))
                page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub-chapters&title=Limits", wait_until="domcontentloaded")
                page.locator(".reader-error").wait_for(timeout=10000)
                self.assertIn(page.locator("#content").get_attribute("data-error-code"), ("READER_PARSE", "READER_CORRUPT"))
                expected_limit = limit if name == "manifest" else 8 * 1024 * 1024
                self.assertEqual(page.evaluate("limit => { try { VoiceOfMLReaderSecurity.assertResponseSize({headers:{get:()=>String(limit + 1)}}, limit); return null; } catch (error) { return error.message; } }", expected_limit), "READER_RESOURCE_LIMIT")
                context.close()

    def test_zip_bomb_metadata_is_rejected_before_docx_and_foliate_parsers(self):
        for extension in ("docx", "epub"):
            with self.subTest(extension=extension):
                context = self.browser.new_context(viewport={"width": 390, "height": 844}); page = context.new_page()
                page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
                page.route("**/static/vendor/jszip.min.acc7e41455a8.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body="window.JSZip=function(){window.__archiveParserStarted=true};"))
                page.route("**/static/vendor/docx-preview.min.051ef503f267.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body="window.docx={renderAsync(){window.__archiveParserStarted=true}};"))
                page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/octet-stream", body=zip_bomb_metadata()))
                source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/bomb.epub" if extension == "epub" else f"https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/{'a' * 64}/docx-native-v1/document.docx"
                page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext={extension}&title=Bomb", wait_until="domcontentloaded")
                page.locator(".reader-error").wait_for(timeout=10000)
                self.assertEqual(page.locator("#content").get_attribute("data-error-code"), "READER_CORRUPT" if extension == "epub" else "READER_PARSE")
                self.assertFalse(page.evaluate("window.__archiveParserStarted === true")); context.close()

    def test_actual_store_broadcasts_progress_and_bookmark_updates_between_readers(self):
        self.page.unroute("**/static/reader-store.js")
        self.page.unroute("https://voiceofml-search.hf.space/api/reader-content**")
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=b"Shared reader"))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/shared.txt"
        query = urllib.parse.quote(source, safe="")
        self.page.goto(f"{self.origin}/search/static/reader.html?url={query}&ext=txt&title=Shared", wait_until="domcontentloaded")
        self.page.locator(".reader-text").wait_for()
        other = self.context.new_page()
        other.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=b"Shared reader"))
        other.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=b"Shared reader"))
        other.goto(f"{self.origin}/search/static/reader.html?url={query}&ext=txt&title=Shared", wait_until="domcontentloaded")
        other.locator(".reader-text").wait_for()
        other.locator("#history").click()
        self.page.evaluate("url => VoiceOfMLReaderStore.put({url, title:'Shared', extension:'txt', lastReadAt:Date.now(), scrollTop:321})", source)
        self.page.evaluate("url => VoiceOfMLReaderStore.putBookmark({id:'shared-bookmark', url, title:'Shared', label:'Shared mark', createdAt:Date.now()})", source)
        other.wait_for_function("() => [...document.querySelectorAll('#history-list .panel-item-main')].some(item => item.textContent.includes('Shared'))")
        other.locator("#bookmarks-tab").click()
        other.locator("#bookmarks-list .panel-item-main").filter(has_text="Shared mark").wait_for()

    def test_html_and_markdown_toc_click_navigation(self):
        html = b"<h1 id='html-one'>HTML one</h1><p style='height:1000px'>space</p><h2 id='html-two'>HTML two</h2>"
        for extension, body in (("html", html), ("md", b"# Markdown one\n\n## Markdown two")):
            with self.subTest(extension=extension):
                context = self.browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
                if extension == "md":
                    page.route("**/static/vendor/marked.min.69451c8541c9.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body="window.marked={parse:()=>'<h1>Markdown one</h1><p style=\"height:1000px\"></p><h2>Markdown two</h2>'};"))
                    page.route("**/static/vendor/purify.min.c2f26ea4fc0d.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=PURIFY_SCRIPT))
                page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route, _request, body=body: route.fulfill(status=200, content_type="text/html" if extension == "html" else "text/markdown", body=body))
                source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/toc.{extension}"
                page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext={extension}&title=TOC", wait_until="domcontentloaded")
                page.locator("#history").click(); page.locator("#toc-list .panel-item-main").nth(1).click()
                if extension == "html":
                    page.wait_for_function("() => document.querySelector('iframe').contentWindow.scrollY > 0")
                else:
                    page.wait_for_function("() => document.querySelector('#viewport').scrollTop > 0")
                context.close()

    def test_pdf_outline_click_navigates_to_declared_page(self):
        self.page.add_init_script("window.__pdfOutlineEnabled = true")
        module = PDF_MODULE.replace("[{title: '第一章', dest: [{}], items: []}]", "[{title: '第三章', dest: [{}], items: []}]").replace("getPageIndex: () => Promise.resolve(0)", "getPageIndex: () => Promise.resolve(2)")
        self.page.unroute("**/static/vendor/pdf.min.f80490490320.mjs")
        self.page.route("**/static/vendor/pdf.min.f80490490320.mjs", lambda route, _request, module=module: route.fulfill(status=200, content_type="text/javascript", body=module))
        self.open_reader()
        self.page.locator("#history").click(); self.page.locator("#toc-list .panel-item-main").click()
        self.page.wait_for_function("() => document.querySelector('#page-number').value === '3'")

    def test_epub_chapters_load_first_lazy_next_and_toc_destination(self):
        digest = "b" * 64
        source = f"https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/{digest}/chapter-manifest.json"
        manifest = {"version": 1, "kind": "epub-chapters", "chapters": [{"index": i, "path": f"chapters/chapter-{i}.xhtml", "title": f"Chapter {i}", "bytes": 100} for i in range(1, 4)]}
        requests = []
        self.page.unroute("https://voiceofml-search.hf.space/api/reader-content**")
        def serve_chapter(route, _request):
            if any(f"chapter-{i}.xhtml" in route.request.url for i in range(1, 4)):
                requests.append(route.request.url)
                image = "<img src='../resources/cover.svg' alt='cover'>" if "chapter-1.xhtml" in route.request.url else ""
                route.fulfill(status=200, content_type="text/html", body=f"<h1>Chapter {route.request.url.split('chapter-')[-1].split('.')[0]}</h1>{image}<p style='height:900px'>body</p>".encode())
            else:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(manifest))
        self.page.route("**/api/reader-content**", serve_chapter)
        self.page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub-chapters&title=Chapters", wait_until="domcontentloaded")
        self.page.locator(".reader-epub-chapter[data-chapter='1']").wait_for()
        self.assertIn("chapter-1.xhtml", requests[0])
        image = self.page.locator(".reader-epub-chapter[data-chapter='1'] img")
        image.wait_for()
        self.assertIn("/resources/cover.svg", image.get_attribute("src") or "")
        self.page.locator(".reader-chapter-sentinel[data-chapter='2']").scroll_into_view_if_needed()
        self.page.locator(".reader-epub-chapter[data-chapter='2']").wait_for()
        self.page.locator("#history").click(); self.page.locator("#toc-list .panel-item-main").nth(2).click()
        self.page.locator(".reader-epub-chapter[data-chapter='3']").wait_for()

    def test_foliate_normalizes_legacy_chm_markup_and_keeps_resources(self):
        self.page.unroute("https://voiceofml-search.hf.space/api/reader-content**")
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(
            status=200, content_type="application/epub+zip", body=epub_with_legacy_chm_markup(),
        ))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/legacy.chm"
        query = urllib.parse.quote(source, safe="")
        self.page.goto(f"{self.origin}/search/static/reader.html?url={query}&ext=epub&title=Legacy", wait_until="domcontentloaded")
        paragraph = self.page.locator(".foliate-continuous article[data-section='0'] #legacy")
        paragraph.wait_for(state="visible")
        image = self.page.locator(".foliate-continuous article[data-section='0'] img")
        image.wait_for(state="visible")
        self.page.wait_for_timeout(100)
        self.assertEqual(paragraph.evaluate("element => getComputedStyle(element).color"), "rgb(1, 2, 3)")
        self.assertTrue((image.get_attribute("src") or "").startswith("blob:"))
        self.assertGreater(image.bounding_box()["height"], 0)

    def test_foliate_navigation_path_dark_links_and_unique_sections(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.add_init_script("localStorage.setItem('theme', 'dark')")
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_navigation()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/e2e.epub"
        url = f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=E2E&path=Test%2Fbooks"
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 2")
        link = page.locator(".foliate-continuous article[data-section='0'] a").first
        link.wait_for(state="attached")
        self.assertIsNotNone(page.locator(".foliate-continuous article[data-section='0']").evaluate("article => article.shadowRoot"))
        title_display = page.locator("#title").evaluate("element => getComputedStyle(element).display")
        page.locator(".foliate-continuous article[data-section='0']").evaluate("article => { const style = document.createElement('style'); style.textContent = '#title{display:none!important} a{color:rgb(1,2,3)!important}'; article.shadowRoot.appendChild(style); }")
        self.assertEqual(page.locator("#title").evaluate("element => getComputedStyle(element).display"), title_display)
        self.assertEqual(link.evaluate("element => getComputedStyle(element).color"), "rgb(1, 2, 3)")
        self.assertEqual(page.locator("#reader-path").text_content(), "Test/books")
        self.assertIsNone(page.locator("#reader-path").get_attribute("hidden"))
        initial_url = page.url
        link.click()
        page.wait_for_function("() => document.querySelector('#viewport').scrollTop > 0")
        self.assertEqual(page.url, initial_url)
        self.assertAlmostEqual(page.locator("#one").evaluate("element => element.getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top"), 8, delta=2)
        page.locator("#history").click()
        page.locator("#toc-list .panel-item-main").nth(1).click()
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(2)').classList.contains('is-current')")
        page.wait_for_function("() => document.querySelectorAll('.foliate-continuous article[data-section]').length === 3")
        sections = page.locator(".foliate-continuous article[data-section]").evaluate_all("items => items.map(item => item.dataset.section)")
        self.assertEqual(sections, ["0", "1", "2"])
        page.locator("#viewport").evaluate("element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); }")
        page.wait_for_timeout(250)
        self.assertEqual(page.locator(".foliate-continuous article[data-section]").evaluate_all("items => items.map(item => item.dataset.section)"), ["0", "1", "2"])
        context.close()

    def test_foliate_rapid_toc_navigation_keeps_latest_destination(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/race.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=Race", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 14")
        page.evaluate("""() => {
          const sections = document.querySelector('foliate-view').book.sections.filter(section => section.linear !== 'no');
          for (const [index, delay] of [[6, 350], [10, 20]]) {
            const original = sections[index].createDocument.bind(sections[index]);
            sections[index].createDocument = () => new Promise((resolve, reject) => setTimeout(() => original().then(resolve, reject), delay));
          }
          document.querySelectorAll('#toc-list .panel-item-main')[5].click();
          document.querySelectorAll('#toc-list .panel-item-main')[9].click();
        }""")
        page.wait_for_timeout(700)
        self.assertTrue(page.locator("#toc-list .toc-item").nth(9).evaluate("item => item.classList.contains('is-current')"))
        self.assertAlmostEqual(page.locator("#chapter-10").evaluate("element => element.getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top"), 8, delta=2)
        sections = page.locator(".foliate-continuous article[data-section]").evaluate_all("items => items.map(item => Number(item.dataset.section))")
        self.assertEqual(sections, sorted(set(sections)))
        context.close()

    def test_foliate_failed_toc_section_can_retry(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/retry.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=Retry", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 14")
        page.evaluate("""() => {
          const section = document.querySelector('foliate-view').book.sections.filter(item => item.linear !== 'no')[10];
          const original = section.createDocument.bind(section); let attempts = 0;
          section.createDocument = () => ++attempts === 1 ? Promise.reject(new Error('transient section failure')) : original();
          window.__retrySection = () => document.querySelectorAll('#toc-list .panel-item-main')[9].click();
        }""")
        page.evaluate("window.__retrySection()")
        page.wait_for_timeout(100)
        page.evaluate("window.__retrySection()")
        page.locator("#chapter-10").wait_for(timeout=5000)
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(10)').classList.contains('is-current')")
        self.assertAlmostEqual(page.locator("#chapter-10").evaluate("element => element.getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top"), 8, delta=2)
        context.close()

    def test_foliate_duplicate_toc_navigation_shares_section_load(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/deduplicate.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=Deduplicate", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 14")
        page.evaluate("""() => {
          const section = document.querySelector('foliate-view').book.sections.filter(item => item.linear !== 'no')[10];
          const original = section.createDocument.bind(section); window.__sectionCreates = 0;
          section.createDocument = () => { window.__sectionCreates += 1; return new Promise((resolve, reject) => setTimeout(() => original().then(resolve, reject), 200)); };
          document.querySelectorAll('#toc-list .panel-item-main')[9].click();
          document.querySelectorAll('#toc-list .panel-item-main')[9].click();
        }""")
        page.locator("#chapter-10").wait_for(timeout=5000)
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(10)').classList.contains('is-current')")
        self.assertEqual(page.evaluate("window.__sectionCreates"), 1)
        self.assertEqual(page.locator(".foliate-continuous article[data-section='10']").count(), 1)
        self.assertTrue(page.locator("#toc-list .toc-item").nth(9).evaluate("item => item.classList.contains('is-current')"))
        context.close()

    def test_foliate_chapter_buttons_use_continuous_reader_navigation(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/chapter-buttons.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=Buttons", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 14")
        page.locator("#history").click()
        page.locator("#toc-list .panel-item-main").nth(9).click()
        page.locator("#chapter-10").wait_for(timeout=5000)
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(10)').classList.contains('is-current')")
        page.locator("#history").click()
        page.locator(".reader-chapter-next").click()
        page.locator("#chapter-11").wait_for(timeout=5000)
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(11)').classList.contains('is-current')")
        self.assertAlmostEqual(page.locator("#chapter-11").evaluate("element => element.getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top"), 8, delta=2)
        self.assertTrue(page.locator("#toc-list .toc-item").nth(10).evaluate("item => item.classList.contains('is-current')"))
        context.close()

    def test_foliate_scroll_updates_toc_on_animation_frame(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/scroll-toc.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=ScrollToc", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 14")
        page.locator("#history").click()
        page.locator("#toc-list .panel-item-main").nth(9).click()
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(10)').classList.contains('is-current')")
        page.evaluate("""() => { const viewport = document.querySelector('#viewport'), target = document.querySelector('.foliate-continuous article[data-section="11"]').shadowRoot.querySelector('#chapter-11'); viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 100; viewport.dispatchEvent(new Event('scroll')); }""")
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(11)').classList.contains('is-current')", timeout=1000)
        context.close()

    def test_foliate_resize_keeps_current_text_anchor(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/scroll-anchor.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=Anchor", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 14")
        page.locator("#history").click()
        page.locator("#toc-list .panel-item-main").nth(9).click()
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(10)').classList.contains('is-current')")
        page.evaluate("""() => { const viewport = document.querySelector('#viewport'); viewport.style.overflowAnchor = 'none'; viewport.dispatchEvent(new Event('scroll')); }""")
        page.wait_for_timeout(50)
        before = page.locator("#chapter-10").evaluate("element => element.getBoundingClientRect().top")
        page.evaluate("""() => { const spacer = document.createElement('div'); spacer.style.height = '600px'; const articles = [...document.querySelectorAll('.foliate-continuous article[data-section]:not(.foliate-section-placeholder)')].filter(article => Number(article.dataset.section) < 10); articles[articles.length - 1].shadowRoot.querySelector('.reader-section-body').appendChild(spacer); }""")
        page.wait_for_function("top => Math.abs(document.querySelector('.foliate-continuous article[data-section=\"10\"]').shadowRoot.querySelector('#chapter-10').getBoundingClientRect().top - top) < 3", arg=before, timeout=2000)
        context.close()

    def test_foliate_virtualizes_distant_sections_and_reloads_them(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/virtual.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=Virtual", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 14")
        for index in [1, 3, 5, 7, 9, 11, 13]:
            page.evaluate("i => document.querySelectorAll('#toc-list .panel-item-main')[i].click()", index)
            page.wait_for_function("i => document.querySelectorAll('#toc-list .toc-item')[i].classList.contains('is-current')", arg=index)
            page.wait_for_timeout(100)
        self.assertLessEqual(page.locator(".foliate-continuous article[data-section]:not(.foliate-section-placeholder)").count(), 9)
        self.assertGreater(page.locator(".foliate-section-placeholder").count(), 0)
        sections = page.locator(".foliate-continuous article[data-section]").evaluate_all("items => items.map(item => Number(item.dataset.section))")
        self.assertEqual(sections, sorted(set(sections)))
        page.evaluate("() => document.querySelectorAll('#toc-list .panel-item-main')[1].click()")
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(2)').classList.contains('is-current')")
        page.locator(".foliate-continuous article[data-section]:not(.foliate-section-placeholder) #chapter-2").wait_for(timeout=5000)
        page.wait_for_function("() => document.querySelectorAll('.foliate-continuous article[data-section]:not(.foliate-section-placeholder)').length <= 9")
        context.close()

    def test_foliate_full_search_uses_continuous_reader_navigation(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/search.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=Search", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 14")
        page.locator("#history").click()
        page.locator("#full-search-toggle").click()
        page.locator("#full-search-input").fill("正文 10")
        page.locator("#full-search-results .full-search-result").first.wait_for(timeout=10000)
        page.locator("#full-search-results .full-search-result").first.click()
        page.locator("#chapter-10").wait_for(timeout=5000)
        page.locator(".foliate-continuous .full-search-highlight").wait_for(timeout=5000)
        page.wait_for_function("() => !document.querySelector('#history-panel').classList.contains('is-open')")
        self.assertTrue(page.locator(".foliate-continuous .full-search-highlight").evaluate("element => { const rect = element.getBoundingClientRect(), viewport = document.querySelector('#viewport').getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.bottom; }"))
        context.close()

    def test_foliate_bookmark_restores_continuous_section_position(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/bookmark.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=Bookmark", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 14")
        page.locator("#history").click()
        page.locator("#toc-list .panel-item-main").nth(9).click()
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(10)').classList.contains('is-current')")
        page.locator("#bookmark-ribbon").click()
        page.locator("#bookmark-add").click()
        page.wait_for_function("() => window.__readerBookmarks.length === 1")
        bookmark = page.evaluate("window.__readerBookmarks[0]")
        self.assertEqual(bookmark.get("foliateSection"), 10)
        page.locator("#viewport").evaluate("element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); }")
        page.locator("#history").click()
        page.locator("#bookmarks-tab").click()
        page.locator("#bookmarks-list .panel-item-main").click()
        page.wait_for_function("() => !document.querySelector('#history-panel').classList.contains('is-open')")
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(10)').classList.contains('is-current')")
        self.assertAlmostEqual(page.locator("#chapter-10").evaluate("element => element.getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top"), 8, delta=3)
        context.close()

    def test_foliate_progress_slider_uses_continuous_viewport(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/progress.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=Progress", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 14")
        page.locator("#history").click()
        page.locator(".reader-progress-range").dispatch_event("pointerdown")
        page.locator(".reader-progress-range").fill("80")
        page.locator(".reader-progress-range").dispatch_event("pointerup")
        page.wait_for_function("() => { const article = document.querySelector('.foliate-continuous article[data-section=\"12\"]'), viewport = document.querySelector('#viewport'); if (!article) return false; const marker = viewport.getBoundingClientRect().top + 8, rect = article.getBoundingClientRect(); return rect.top <= marker && rect.bottom > marker; }")
        self.assertAlmostEqual(float(page.locator(".reader-progress-percent").text_content().rstrip("%")), 80, delta=7)
        context.close()

    def test_foliate_history_saves_structured_section_position(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/history.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=History", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelectorAll('#toc-list .toc-item').length === 14")
        page.locator("#history").click()
        page.locator("#toc-list .panel-item-main").nth(9).click()
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(10)').classList.contains('is-current')")
        page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        page.wait_for_function("() => window.__savedReaderProgress && window.__savedReaderProgress.foliateSection === 10")
        self.assertEqual(page.evaluate("window.__savedReaderProgress.foliateTocIndex"), 9)
        context.close()

    def test_foliate_history_restores_structured_section_position(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        restored_store = STORE_SCRIPT.replace("get: () => new Promise((resolve) => setTimeout(() => resolve(null), 300)),", "get: () => Promise.resolve({foliateSection: 10, foliateOffset: 0, foliateTocIndex: 9, zoom: 1}),")
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=restored_store))
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="application/epub+zip", body=epub_with_many_chapters()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/restore.epub"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=epub&title=Restore", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelector('#toc-list .toc-item:nth-child(10)')?.classList.contains('is-current')", timeout=10000)
        self.assertAlmostEqual(page.locator("#chapter-10").evaluate("element => element.getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top"), 8, delta=3)
        context.close()

    def test_reader_store_migrates_history_and_keeps_bookmarks_when_cleared(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.goto(f"{self.origin}/search/static/reader.html", wait_until="domcontentloaded")
        page.evaluate("""async () => {
          await new Promise((resolve) => { const request = indexedDB.deleteDatabase('voiceofml-reader'); request.onsuccess = request.onerror = request.onblocked = resolve; });
          await new Promise((resolve, reject) => {
            const request = indexedDB.open('voiceofml-reader', 1);
            request.onupgradeneeded = () => { const store = request.result.createObjectStore('entries', {keyPath: 'url'}); store.createIndex('lastReadAt', 'lastReadAt'); };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { const db = request.result, tx = db.transaction('entries', 'readwrite'); tx.objectStore('entries').put({url: 'legacy', lastReadAt: 1}); tx.oncomplete = () => { db.close(); resolve(); }; };
          });
        }""")
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=b"Reader"))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/store.txt"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=txt&title=Store", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelector('#status').textContent === '已加载'")
        result = page.evaluate("""async (url) => {
          const legacy = await VoiceOfMLReaderStore.get('legacy');
          await VoiceOfMLReaderStore.putBookmark({id: url + '\\0page:1', url, label: '第 1 页', createdAt: 1});
          await new Promise((resolve, reject) => { const request = indexedDB.open('voiceofml-reader', 2); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, tx = db.transaction(['entries', 'bookmarks'], 'readwrite'); tx.objectStore('entries').put({url: 42, lastReadAt: 2}); tx.objectStore('entries').put({url: 'future', lastReadAt: 3, schemaVersion: 2}); tx.objectStore('bookmarks').put({id: 42, url, createdAt: 2}); tx.objectStore('bookmarks').put({id: 'future', url, createdAt: 3, schemaVersion: 2}); tx.oncomplete = () => { db.close(); resolve(); }; }; });
          const historyBeforeClear = await VoiceOfMLReaderStore.list();
          const bookmarkEntries = await VoiceOfMLReaderStore.listBookmarks(url);
          const raw = await new Promise((resolve, reject) => { const request = indexedDB.open('voiceofml-reader', 2); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, tx = db.transaction(['entries', 'bookmarks'], 'readonly'), historyRequest = tx.objectStore('entries').getAll(), bookmarkRequest = tx.objectStore('bookmarks').getAll(); tx.oncomplete = () => { const value = {history: historyRequest.result, bookmarks: bookmarkRequest.result}; db.close(); resolve(value); }; }; });
          await VoiceOfMLReaderStore.clearHistory();
          return {legacy: !!legacy, legacySchema: legacy.schemaVersion, schema: VoiceOfMLReaderStore.SCHEMA_VERSION, validHistory: historyBeforeClear.every(entry => typeof entry.url === 'string' && entry.schemaVersion === 1), corruptDeleted: !raw.history.some(entry => typeof entry.url !== 'string') && !raw.bookmarks.some(entry => typeof entry.id !== 'string'), futureKept: raw.history.some(entry => entry.schemaVersion === 2) && raw.bookmarks.some(entry => entry.schemaVersion === 2), history: (await VoiceOfMLReaderStore.list()).length, bookmarks: bookmarkEntries.length, bookmarkSchema: bookmarkEntries[0].schemaVersion};
        }""", source)
        self.assertEqual(result, {"legacy": True, "legacySchema": 1, "schema": 1, "validHistory": True, "corruptDeleted": True, "futureKept": True, "history": 0, "bookmarks": 1, "bookmarkSchema": 1})
        context.close()

    def test_mobile_pdf_rendering_uses_one_slot_and_seven_canvases(self):
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.open_reader()
        metrics = self.scroll_document()
        self.assertLessEqual(metrics["peak"], 1)
        self.assertLessEqual(metrics["rendered"], 7)
        self.assertGreater(metrics["pixels"], 0)

    def test_mobile_zoom_enlarges_pdf_page_without_resizing_content_shell(self):
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.open_reader()
        before = self.page.evaluate("""() => ({
          content: document.querySelector('.reader-content').getBoundingClientRect().width,
          page: document.querySelector('.reader-page').getBoundingClientRect().width,
          pixels: document.querySelector('.reader-page canvas').width,
        })""")
        self.page.locator("#zoom-in").click(click_count=5)
        self.page.wait_for_function("before => document.querySelector('.reader-page canvas').width > before * 1.45", arg=before["pixels"])
        after = self.page.evaluate("""() => ({
          content: document.querySelector('.reader-content').getBoundingClientRect().width,
          page: document.querySelector('.reader-page').getBoundingClientRect().width,
          pixels: document.querySelector('.reader-page canvas').width,
        })""")
        self.assertAlmostEqual(after["content"], before["content"], delta=1)
        self.assertGreater(after["page"], before["page"] * 1.45)
        self.assertGreater(after["pixels"], before["pixels"] * 1.45)

    def test_txt_displays_before_stream_finishes_and_preserves_split_utf8(self):
        self.page.add_init_script("""
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = String(input && input.url || input);
          if (!url.includes('/api/reader-content?url=')) return nativeFetch(input, init);
          const bytes = new TextEncoder().encode('first line\\n中文末尾');
          return Promise.resolve(new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, 12));
              setTimeout(() => controller.enqueue(bytes.slice(12, 16)), 30);
              setTimeout(() => { controller.enqueue(bytes.slice(16)); controller.close(); }, 500);
            }
          }), { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
        };
        """)
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/performance.txt"
        query = json.dumps(source)[1:-1]
        self.page.goto(f"{self.origin}/search/static/reader.html?url={query}&ext=txt&title=Performance", wait_until="domcontentloaded")
        self.page.locator(".reader-text").filter(has_text="first line").wait_for(timeout=3000)
        self.assertNotEqual(self.page.locator("#status").text_content(), "已加载")
        self.page.wait_for_function("() => document.querySelector('#status').textContent === '已加载'")
        self.assertEqual(self.page.locator(".reader-text").text_content(), "first line\n中文末尾")

    def test_text_reader_uses_scroll_mode_without_pagination_controls(self):
        text = "\n\n".join(f"第 {index} 段内容。" * 120 for index in range(8))
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=text.encode()))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/scroll.txt"
        self.page.goto(f"{self.origin}/search/static/reader.html?url={json.dumps(source)[1:-1]}&ext=txt&title=Scroll", wait_until="domcontentloaded")
        self.page.locator(".reader-text").wait_for()
        self.assertEqual(self.page.locator("#reading-mode").count(), 0)
        self.assertTrue(self.page.locator(".page-controls").is_hidden())
        self.assertFalse(self.page.locator(".reader-viewport").evaluate("element => element.classList.contains('is-paginated')"))
        self.page.locator("#viewport").evaluate("element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); }")
        self.assertGreater(self.page.locator("#viewport").evaluate("element => element.scrollTop"), 0)

    def test_reader_tab_remains_visible_for_document_without_toc(self):
        self.page.route("**/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=b"No table of contents"))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/no-toc.txt"
        self.page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=txt&title=NoToc", wait_until="domcontentloaded")
        self.page.locator(".reader-text").wait_for()
        self.page.locator("#history").click()
        self.assertTrue(self.page.locator("#toc-tab").is_visible())
        self.assertEqual(self.page.locator("#toc-tab").text_content(), "阅读")

    def test_txt_detects_gb18030_and_utf16_bom(self):
        cases = [
            ("gb18030", [0xD6, 0xD0, 0xCE, 0xC4, 0xCE, 0xC4, 0xB1, 0xBE], "中文文本"),
            ("utf16", [0xFF, 0xFE, 0x2D, 0x4E, 0x87, 0x65, 0x87, 0x65, 0x2C, 0x67], "中文文本"),
            ("windows1251", list("Русский текст".encode("cp1251")), "Русский текст"),
            ("damaged-gb18030", list("中文".encode("gb18030") + b"\xff" + "文本".encode("gb18030")), "中文文本"),
        ]
        for name, encoded, expected in cases:
            with self.subTest(encoding=name):
                context = self.browser.new_context(viewport={"width": 1440, "height": 900})
                page = context.new_page()
                page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
                page.add_init_script("""
                window.__txtBytes = %s;
                const nativeFetch = window.fetch.bind(window);
                window.fetch = (input, init) => {
                  const url = String(input && input.url || input);
                  if (!url.includes('/api/reader-content?url=')) return nativeFetch(input, init);
                  return Promise.resolve(new Response(new Uint8Array(window.__txtBytes), { status: 200 }));
                };
                """ % json.dumps(encoded))
                source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/encoding.txt"
                query = json.dumps(source)[1:-1]
                title = "Русский" if name == "windows1251" else "中文" if name == "damaged-gb18030" else "Encoding"
                page.goto(f"{self.origin}/search/static/reader.html?url={query}&ext=txt&title={title}", wait_until="domcontentloaded")
                page.wait_for_function("() => document.querySelector('#status').textContent === '已加载'")
                self.assertEqual(page.locator(".reader-text").text_content(), expected)
                context.close()

    def test_txt_detects_encoding_across_tiny_initial_chunks(self):
        cases = [
            (list(b"ASCII prefix\n" + "中文文本".encode("gb18030")), [1, 4, 9], "ASCII prefix\n中文文本"),
            (list("中文文本".encode("utf-16")), [1, 2, 3], "中文文本"),
            (list("AB中文".encode("utf-16le")), [1, 2, 3], "AB中文"),
            (list(b"A" * 65535 + "中文".encode("gb18030")), [65536], "A" * 65535 + "中文"),
        ]
        for encoded, splits, expected in cases:
            with self.subTest(expected=expected):
                context = self.browser.new_context(viewport={"width": 1440, "height": 900})
                page = context.new_page()
                page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
                page.add_init_script("""
                window.__txtBytes = new Uint8Array(%s);
                window.__txtSplits = %s;
                const nativeFetch = window.fetch.bind(window);
                window.fetch = (input, init) => {
                  const url = String(input && input.url || input);
                  if (!url.includes('/api/reader-content?url=')) return nativeFetch(input, init);
                  return Promise.resolve(new Response(new ReadableStream({
                    start(controller) {
                      let offset = 0;
                      for (const end of window.__txtSplits) { controller.enqueue(window.__txtBytes.slice(offset, end)); offset = end; }
                      controller.enqueue(window.__txtBytes.slice(offset)); controller.close();
                    }
                  }), { status: 200 }));
                };
                """ % (json.dumps(encoded), json.dumps(splits)))
                source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/encoding.txt"
                page.goto(f"{self.origin}/search/static/reader.html?url={json.dumps(source)[1:-1]}&ext=txt&title=Encoding", wait_until="domcontentloaded")
                page.wait_for_function("() => document.querySelector('#status').textContent === '已加载'")
                self.assertEqual(page.locator(".reader-text").text_content(), expected)
                context.close()

    def test_html_aliases_render_safely_with_visible_text(self):
        document = b'<style>body{background:#fff;color:#fff;background-image:url(https://evil.test/css.png)}</style><p id="visible">HTML readable</p><pre id="literal">url(example) @import package;</pre><script>parent.__unsafe=true</script><iframe src="https://evil.test/frame"></iframe><img src="https://evil.test/image.png">'
        for extension in ("html", "htm"):
            with self.subTest(extension=extension):
                context = self.browser.new_context(viewport={"width": 390, "height": 844}, color_scheme="dark")
                page = context.new_page(); external = []
                page.on("request", lambda request: external.append(request.url) if "evil.test" in request.url else None)
                page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/html", body=document))
                source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/page.{extension}"
                page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext={extension}&title=HTML", wait_until="domcontentloaded")
                page.wait_for_function("() => document.querySelector('#status').textContent === 'HTML'")
                frame = page.locator("iframe.html-frame").content_frame
                self.assertEqual(frame.locator("#visible").text_content(), "HTML readable")
                self.assertEqual(frame.locator("#literal").text_content(), "url(example) @import package;")
                self.assertEqual(frame.locator("script, iframe").count(), 0)
                self.assertFalse(page.evaluate("window.__unsafe === true"))
                self.assertEqual(external, [])
                self.assertNotEqual(frame.locator("#visible").evaluate("e => getComputedStyle(e).color"), "rgb(255, 255, 255)")
                page.locator("#zoom-in").click()
                self.assertEqual(frame.locator("html").evaluate("e => e.style.zoom"), "1.1")
                context.close()

    def test_html_restores_and_saves_internal_scroll_position(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        store = """
        window.VoiceOfMLReaderStore = Object.freeze({
          get: () => Promise.resolve({ htmlScrollTop: 420, zoom: 120 }),
          put: (entry) => { window.__savedReaderProgress = entry; return Promise.resolve(); },
          list: () => Promise.resolve([]), remove: () => Promise.resolve()
        });
        """
        page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=store))
        document = ("<p>line</p>" * 300).encode()
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/html", body=document))
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/progress.html"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=html&title=Progress", wait_until="domcontentloaded")
        page.wait_for_function("() => document.querySelector('#status').textContent === 'HTML'")
        frame = page.locator("iframe.html-frame").content_frame
        page.wait_for_function("() => document.querySelector('iframe').contentWindow.scrollY >= 400")
        self.assertEqual(frame.locator("html").evaluate("e => e.style.zoom"), "1.2")
        frame.locator("body").evaluate("() => scrollTo(0, 700)")
        page.wait_for_function("() => window.__savedReaderProgress && window.__savedReaderProgress.htmlScrollTop >= 650")
        context.close()

    def test_markdown_extension_aliases_render_content(self):
        for extension in ("md", "markdown"):
            with self.subTest(extension=extension):
                context = self.browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
                page.route("**/static/vendor/marked.min.69451c8541c9.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=MARKED_SCRIPT))
                page.route("**/static/vendor/purify.min.c2f26ea4fc0d.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=PURIFY_SCRIPT))
                page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/markdown", body=b"# Markdown readable"))
                source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/readme.{extension}"
                page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext={extension}&title=Markdown", wait_until="domcontentloaded")
                page.wait_for_function("() => document.querySelector('#status').textContent === '已加载'")
                self.assertIn("Markdown readable", page.locator(".reader-markdown").inner_text())
                context.close()

    def test_image_aliases_decode_real_image_bytes(self):
        for extension, (content_type, document) in IMAGE_FIXTURES.items():
            with self.subTest(extension=extension):
                context = self.browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                def serve_image(route, _request, mime=content_type, body=document):
                    route.fulfill(status=200, content_type=mime, body=body)
                page.route("https://voiceofml-search.hf.space/api/reader-content**", serve_image)
                source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/image.{extension}"
                page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext={extension}&title=Image", wait_until="domcontentloaded")
                page.wait_for_function("() => document.querySelector('#status').textContent === '图片'")
                self.assertTrue(page.locator(".reader-image").evaluate("image => image.complete && image.naturalWidth === 1 && image.naturalHeight === 1"))
                context.close()

    def test_native_media_uses_proxy_controls_and_mobile_layout(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        requests = []
        page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: (
            requests.append(route.request.url),
            route.fulfill(status=200, content_type="audio/wav", body=minimal_wav()),
        ))
        page.add_init_script("""(() => {
          const add = EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener = function(type, listener, options) {
            if (this instanceof HTMLMediaElement && type === 'error') return;
            return add.call(this, type, listener, options);
          };
        })();""")
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/sound.wav"
        page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=wav&title=Sound", wait_until="domcontentloaded")
        page.locator(".reader-audio").wait_for(state="attached")
        media_state = page.evaluate("""() => {
          const element = document.querySelector('.reader-audio');
          return element && {controls: element.controls, preload: element.getAttribute('preload'), src: element.getAttribute('src')};
        }""")
        self.assertIsNotNone(media_state)
        self.assertTrue(media_state["controls"])
        self.assertEqual(media_state["preload"], "metadata")
        self.assertTrue(media_state["src"].startswith("https://voiceofml-search.hf.space/api/reader-content?url="))
        self.assertTrue(page.locator(".zoom-controls").is_hidden())
        page.locator("#history").click()
        self.assertTrue(page.locator("#media-tab").is_visible())
        self.assertEqual(page.locator('.reader-panel-tabs button[aria-selected="true"]').get_attribute("data-panel"), "media")
        page.locator(".media-panel-bookmark").click()
        self.assertIn("时间", page.locator("#bookmark-prompt").text_content())
        page.locator("#bookmark-add").click()
        page.locator("#bookmarks-tab").click()
        page.locator("#bookmarks-list .panel-item-main").wait_for()
        self.assertIn("时间", page.locator("#bookmarks-list").text_content())
        self.assertTrue(requests)
        context.close()

    def test_audio_extension_aliases_use_native_reader_controls(self):
        for extension in ("mp3", "m4a", "flac", "mpga", "audio"):
            with self.subTest(extension=extension):
                context = self.browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                page.route("**/api/reader-content**", lambda route: route.fulfill(status=200, content_type="audio/wav", body=minimal_wav()))
                source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/alias.{extension}"
                page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext={extension}&title=Audio", wait_until="domcontentloaded")
                page.wait_for_function("() => document.querySelector('#status').textContent === '音频'")
                audio = page.locator(".reader-audio")
                self.assertTrue(audio.evaluate("element => element.controls"))
                self.assertEqual(page.locator(".reader-content").get_attribute("data-mode"), "audio")
                self.assertTrue(page.locator(".zoom-controls").is_hidden())
                self.assertTrue(page.locator("#bookmark-ribbon").is_visible())
                context.close()

    def test_supported_formats_start_loading_while_history_restores(self):
        cases = [
            ("md", "已加载", ".reader-markdown", ["content", "marked", "purify"]),
            ("docx", "DOCX", ".docx-body", ["content", "jszip", "docx"]),
            ("png", "图片", ".reader-image", ["content"]),
        ]
        elapsed_by_format = {}
        for extension, ready_status, selector, expected_requests in cases:
            with self.subTest(extension=extension):
                context = self.browser.new_context(viewport={"width": 1440, "height": 900})
                page = context.new_page()
                requested_at = {}

                def timed(name, content_type, body):
                    def fulfill(route):
                        requested_at[name] = page.evaluate("performance.now()")
                        route.fulfill(status=200, content_type=content_type, body=body)
                    return fulfill

                page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
                page.route("**/static/vendor/marked.min.69451c8541c9.js", timed("marked", "text/javascript", MARKED_SCRIPT))
                page.route("**/static/vendor/purify.min.c2f26ea4fc0d.js", timed("purify", "text/javascript", PURIFY_SCRIPT))
                page.route("**/static/vendor/jszip.min.acc7e41455a8.js", timed("jszip", "text/javascript", JSZIP_SCRIPT))
                page.route("**/static/vendor/epub.min.06eae1574510.js", timed("epub", "text/javascript", EPUB_SCRIPT))
                page.route("**/static/vendor/docx-preview.min.051ef503f267.js", timed("docx", "text/javascript", DOCX_SCRIPT))
                content_type = "image/png" if extension == "png" else "application/octet-stream"
                body = PNG_BYTES if extension == "png" else minimal_docx() if extension == "docx" else b"Reader benchmark content"
                page.route("https://voiceofml-search.hf.space/api/reader-content**", timed("content", content_type, body))
                if extension == "docx":
                    digest = "a" * 64
                    source = f"https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/{digest}/docx-native-v1/document.docx"
                else:
                    source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/performance.{extension}"
                if extension == "png":
                    page.route(source, timed("content", content_type, body))
                started = time.perf_counter()
                page.goto(
                    f"{self.origin}/search/static/reader.html?url={json.dumps(source)[1:-1]}&ext={extension}&title=Performance",
                    wait_until="domcontentloaded",
                )
                page.wait_for_function("expected => document.querySelector('#status').textContent === expected", arg=ready_status)
                page.locator(selector).wait_for(state="attached")
                elapsed_by_format[extension] = (time.perf_counter() - started) * 1000
                store_started = page.evaluate("window.__storeStartedAt")
                self.assertEqual(set(requested_at), set(expected_requests))
                for name in expected_requests:
                    self.assertLess(requested_at[name] - store_started, 250, f"{extension} {name} waited for history restoration")
                context.close()
        print("\n  Reader format load times: " + ", ".join(
            f"{name}={elapsed_by_format[name]:.1f}ms" for name in sorted(elapsed_by_format)
        ))

    def test_cold_cache_first_read_with_real_format_engines(self):
        cases = [
            ("txt", b"Cold TXT readable", "text/plain", "已加载", ".reader-text", []),
            ("md", b"# Cold Markdown", "text/markdown", "已加载", ".reader-markdown", ["marked.min.69451c8541c9.js", "purify.min.c2f26ea4fc0d.js"]),
            ("pdf", minimal_pdf(), "application/pdf", "1 页", ".reader-page canvas.ready", ["pdf.min.f80490490320.mjs", "pdf.worker.min.8ab0e5e30031.mjs"]),
            ("docx", minimal_docx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "1 页", ".docx-body", ["jszip.min.acc7e41455a8.js", "docx-preview.min.051ef503f267.js"]),
            ("png", PNG_BYTES, "image/png", "图片", ".reader-image", []),
        ]
        results = []
        for extension, document, content_type, ready_status, selector, engines in cases:
            with self.subTest(extension=extension):
                context = self.browser.new_context(viewport={"width": 1440, "height": 900}, service_workers="block")
                try:
                    page = context.new_page(); session = context.new_cdp_session(page)
                    session.send("Network.enable"); session.send("Network.setCacheDisabled", {"cacheDisabled": True})
                    responses = []
                    page.on("response", lambda response: responses.append(response))

                    def serve_document(route):
                        route.fulfill(status=200, content_type=content_type, body=document)

                    page.route("https://voiceofml-search.hf.space/api/reader-content**", serve_document)
                    if extension == "docx":
                        digest = "a" * 64
                        source = f"https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/{digest}/docx-native-v1/document.docx"
                    else:
                        source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/cold.{extension}"
                    if extension == "png": page.route(source, serve_document)
                    started = time.perf_counter()
                    page.goto(f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext={extension}&title=Cold", wait_until="domcontentloaded")
                    page.wait_for_function("expected => document.querySelector('#status').textContent === expected", arg=ready_status, timeout=30000)
                    page.locator(selector).wait_for(state="attached", timeout=30000)
                    if extension == "docx":
                        self.assertTrue(page.locator(".page-controls").is_visible())
                        self.assertEqual(page.locator(".reader-docx-page").count(), 1)
                    if extension in {"txt", "md"}: self.assertTrue(page.locator(selector).inner_text().strip())
                    elif extension == "epub": self.assertIn("EPUB readable", page.locator(selector).content_frame.locator("body").inner_text())
                    elif extension == "docx": self.assertIn("DOCX readable", page.locator(selector).inner_text())
                    elif extension == "png": self.assertTrue(page.locator(selector).evaluate("image => image.naturalWidth > 0"))
                    elif extension == "pdf": self.assertGreater(page.locator(selector).evaluate("canvas => canvas.width * canvas.height"), 0)
                    elapsed = (time.perf_counter() - started) * 1000
                    urls = [urllib.parse.urlsplit(response.url).path.rsplit("/", 1)[-1] for response in responses]
                    for engine in engines: self.assertIn(engine, urls)
                    for response in responses: self.assertFalse(response.from_service_worker)
                    entries = page.evaluate("""() => performance.getEntriesByType('resource').map((entry) => ({ name: entry.name, transferSize: entry.transferSize }))""")
                    for engine in engines:
                        if ".worker." in engine: continue
                        entry = next((item for item in entries if item["name"].endswith(engine)), None)
                        self.assertIsNotNone(entry, engine)
                        self.assertGreater(entry["transferSize"], 0, f"{engine} was not transferred on a cold load")
                    byte_count = len(document) + sum(
                        (ROOT / "static/vendor" / engine).stat().st_size for engine in engines
                    )
                    results.append((extension, elapsed, byte_count, len(responses)))
                finally:
                    context.close()
        print("\n  Reader cold-cache first read (real engines):")
        for extension, elapsed, byte_count, request_count in results:
            print(f"    {extension:<5s} {elapsed:>7.1f}ms  {byte_count / 1024:>8.1f}KiB  {request_count:>2d} responses")

    def test_image_proxy_failure_falls_back_to_direct_source(self):
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/fallback.png"
        requests = []
        self.page.route(source, lambda route: (requests.append("source"), route.fulfill(status=200, content_type="image/png", body=PNG_BYTES)))
        self.page.route(
            "https://voiceofml-search.hf.space/api/reader-content**",
            lambda route: (requests.append("proxy"), route.fulfill(status=404, body=b"")),
        )
        self.page.goto(
            f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext=png&title=Fallback",
            wait_until="domcontentloaded",
        )
        self.page.wait_for_function("() => document.querySelector('#status').textContent === '图片'")
        self.assertEqual(requests, ["proxy", "source"])

    def test_fetch_formats_fall_back_when_proxy_request_rejects(self):
        cases = [
            ("txt", "已加载", ".reader-text"),
            ("md", "已加载", ".reader-markdown"),
            ("docx", "DOCX", ".docx-body"),
        ]
        for extension, ready_status, selector in cases:
            with self.subTest(extension=extension):
                context = self.browser.new_context(viewport={"width": 1440, "height": 900})
                page = context.new_page()
                page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
                page.route("**/static/vendor/marked.min.69451c8541c9.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=MARKED_SCRIPT))
                page.route("**/static/vendor/purify.min.c2f26ea4fc0d.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=PURIFY_SCRIPT))
                page.route("**/static/vendor/jszip.min.acc7e41455a8.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=JSZIP_SCRIPT))
                page.route("**/static/vendor/epub.min.06eae1574510.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=EPUB_SCRIPT))
                page.route("**/static/vendor/docx-preview.min.051ef503f267.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=DOCX_SCRIPT))
                page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.abort("connectionreset"))
                if extension == "docx":
                    digest = "a" * 64
                    source = f"https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/{digest}/docx-native-v1/document.docx"
                else:
                    source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/fallback.{extension}"
                direct_requests = []
                direct_body = minimal_docx() if extension == "docx" else b"Fallback readable"
                page.route(source, lambda route, _request, body=direct_body: (direct_requests.append(route.request.url), route.fulfill(status=200, content_type="application/octet-stream", body=body)))
                page.goto(
                    f"{self.origin}/search/static/reader.html?url={urllib.parse.quote(source, safe='')}&ext={extension}&title=Fallback",
                    wait_until="domcontentloaded",
                )
                page.wait_for_function(
                    "expected => document.querySelector('#status').textContent === expected",
                    arg=ready_status,
                )
                page.locator(selector).wait_for(state="attached")
                self.assertEqual(direct_requests, [source])
                context.close()

    def scroll_document(self):
        pages = self.page.locator(".reader-page")
        for index in range(30):
            page = pages.nth(index)
            page.scroll_into_view_if_needed()
            self.page.wait_for_timeout(20)
        self.page.wait_for_timeout(100)
        return self.page.locator("body").evaluate("""() => ({
          peak: window.__pdfPeak,
          rendered: document.querySelectorAll('.reader-page[data-render-state="rendered"]').length,
          pixels: [...document.querySelectorAll('.reader-page canvas')].reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
        })""")


def load_tests(_loader, _tests, _pattern):
    return unittest.TestSuite()


if __name__ == "__main__":
    unittest.main()

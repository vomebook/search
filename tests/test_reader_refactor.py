"""HF Reader regressions using GitHub's /search/ server and external API routes."""

import io
import base64
import gzip
import hashlib
import json
import os
import time
import unittest
import urllib.parse
import zipfile
import wave

from tests import test_reader_performance as support


def expose_dom_search_tools(page):
    def instrument(route):
        response = route.fetch()
        script = response.text()
        marker = "  function pruneMarks() {"
        if marker not in script:
            raise AssertionError("DOM search instrumentation boundary missing")
        route.fulfill(response=response, body=script.replace(marker, '''
          window.__domSearchTools = {
            locator: () => fullSearchDomLocator, snapshot: () => fullSearchDomSnapshot,
            textNodes: fullSearchTextNodes, headingLookup: createFullSearchHeadingLookup,
            location: fullSearchLocation
          };
        ''' + marker))
    page.route("**/static/reader/search/reader-dom-search.mjs*", instrument)


@unittest.skipIf(support.sync_playwright is None, "Playwright is unavailable")
class ReaderRefactorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = support.local_server()
        cls.origin, _state = cls.server.__enter__()
        cls.playwright = support.sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        except support.PlaywrightError as error:
            cls.playwright.stop()
            cls.server.__exit__(None, None, None)
            raise unittest.SkipTest(str(error))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1100, "height": 800})
        self.context.route("**/*", lambda route: route.continue_()
                           if route.request.url.startswith(self.origin + "/")
                           else route.abort())
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_default_timeout(int(os.environ.get("READER_TEST_TIMEOUT_MS", "6000")))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def reader_url(self, extension="txt", name="refactor", **params):
        source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/{name}.{extension}"
        values = {"url": source, "ext": extension, "title": name, **params}
        return self.origin + "/search/static/reader.html?" + urllib.parse.urlencode(values)

    def serve(self, body, mime="text/plain"):
        self.page.route("**/api/reader-content**", lambda route: route.fulfill(
            status=200, content_type=mime, body=body))

    def open(self, url):
        self.page.goto(url)
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")

    def test_zoom_changed_during_preparation_survives_late_restoration(self):
        store = support.STORE_SCRIPT.replace(
            "get: () => new Promise((resolve) => setTimeout(() => resolve(null), 300)),",
            "get: () => new Promise(resolve => { window.__releaseRestore = () => resolve({url: location.href, page: 1, zoom: 220}); }),",
        )
        self.page.route("**/static/reader/core/reader-store.js", lambda route: route.fulfill(
            content_type="text/javascript", body=store))
        self.page.route("**/api/reader-content**", lambda route: route.fulfill(
            content_type="application/pdf", body=support.minimal_pdf(),
            headers={"Access-Control-Allow-Origin": "*"}))
        self.page.goto(self.reader_url("pdf"), wait_until="domcontentloaded")
        self.page.wait_for_function("() => !!window.__releaseRestore && !!document.querySelector('.reader-page canvas.ready')")
        self.page.locator("#zoom-in").click(click_count=3)
        self.assertEqual(self.page.locator("#zoom").input_value(), "130")
        self.page.evaluate("window.__releaseRestore()")
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.assertEqual(self.page.locator("#zoom").input_value(), "130")
        self.assertEqual(self.page.locator("#content").evaluate(
            "node => node.style.getPropertyValue('--reader-zoom')"), "1.3")
        self.assertEqual(self.page.evaluate("localStorage.getItem('reader-zoom')"), "130")
        self.page.wait_for_function("() => window.__savedReaderProgress?.zoom === 130")

    def test_book_restoration_does_not_change_new_books_global_zoom(self):
        store = support.STORE_SCRIPT.replace(
            "get: () => new Promise((resolve) => setTimeout(() => resolve(null), 300)),",
            "get: (url) => Promise.resolve(url.includes('refactor.pdf') ? {url, page: 1, zoom: 175} : null),",
        )
        self.page.route("**/static/reader/core/reader-store.js", lambda route: route.fulfill(
            content_type="text/javascript", body=store))
        self.page.route("**/api/reader-content**", lambda route: route.fulfill(
            content_type="application/pdf", body=support.minimal_pdf(),
            headers={"Access-Control-Allow-Origin": "*"}))
        self.page.goto(self.reader_url("pdf"))
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.page.locator("#zoom").fill("125")
        self.page.locator("#zoom").press("Enter")
        self.page.reload()
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.assertEqual(self.page.locator("#zoom").input_value(), "175")
        self.assertEqual(self.page.locator("#content").evaluate(
            "node => node.style.getPropertyValue('--reader-zoom')"), "1.75")
        self.assertEqual(self.page.evaluate("localStorage.getItem('reader-zoom')"), "125")
        self.page.goto(self.reader_url("pdf", "another"))
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.assertEqual(self.page.locator("#zoom").input_value(), "125")
        self.assertEqual(self.page.locator("#content").evaluate(
            "node => node.style.getPropertyValue('--reader-zoom')"), "1.25")

    def search(self, query):
        support.open_reader_panel(self.page)
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill(query)
        self.page.wait_for_function("() => /^(?:\d+ 个结果|未找到正文匹配)$/.test(document.querySelector('#full-search-status').textContent)")

    def test_pdf_page_sources_preserve_version_and_navigate(self):
        manifest = {"version": 2, "kind": "pdf-pages", "page_count": 3}
        root = "https://huggingface.co/buckets/vomebook/pdf-pages-v2/resolve/objects/aa/" + "a" * 64
        self.serve(json.dumps(manifest), "application/json")
        self.page.route("**/page-manifest.json", lambda route: route.fulfill(json=manifest))
        self.page.route("**/pages/page-*.webp", lambda route: route.fulfill(
            content_type="image/webp", body=support.IMAGE_FIXTURES["webp"][1]))
        for version in ("/1234567890abcdef",):
            with self.subTest(version=version):
                source = root + version
                self.open(self.reader_url("pdf-pages", url=source + "/page-manifest.json"))
                self.page.locator(".reader-page img.ready").first.wait_for()
                self.page.locator("#page-number").fill("3")
                self.page.locator("#page-number").dispatch_event("change")
                image = self.page.locator('.reader-page[data-page="3"] img.ready')
                image.wait_for()
                self.assertEqual(image.get_attribute("src"), source + "/pages/page-000003.webp")
                self.assertTrue(image.evaluate("image => image.complete && image.naturalWidth > 0"))

    def test_unconverted_docx_is_download_only_without_loading_native_engines(self):
        requests = []
        self.page.on("request", lambda request: requests.append(request.url))
        source = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/unconverted.docx'
        self.page.goto(self.reader_url('docx', url=source), wait_until='domcontentloaded')
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'failed'")
        self.assertIn("此文件暂不支持在线阅读", self.page.locator('.reader-error').text_content())
        download = self.page.locator('#download').get_attribute('href')
        download_url = urllib.parse.urlsplit(download)
        self.assertEqual(download_url.path, '/api/download')
        self.assertEqual(urllib.parse.parse_qs(download_url.query).get('link'), [source])
        self.assertFalse(any('docx-preview' in url or 'jszip' in url.lower() for url in requests))

    def test_missing_image_manifest_or_page_recovers_original_without_changing_book_identity(self):
        prefix = 'pages/image/bmp/' + 'a' * 64 + '/'
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urllib.parse.urlencode({'path':prefix+'page-manifest.json'})
        original = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/original.bmp'
        resolved = dict(url=source, download=original, extension='image-pages', original_extension='bmp')
        self.page.route('**/api/reader-resolve?**', lambda route: route.fulfill(json=resolved))
        originals = []
        self.page.route('**/api/reader-content?**', lambda route: (
            originals.append(route.request.url), route.fulfill(content_type='image/webp', body=support.IMAGE_FIXTURES['webp'][1])))
        for fault in ('manifest', 'page'):
            with self.subTest(fault=fault):
                manifest = dict(version=1, kind='image-page-stream', page_count=1,
                                pages=[dict(path='pages/page-000001.webp', bytes=10, sha256='a'*64)])
                self.page.route('**/api/reader-bucket-resource?**', lambda route: route.fulfill(json=manifest)
                                if fault == 'page' and 'page-manifest.json' in route.request.url
                                else route.fulfill(status=404, body='missing'))
                self.open(self.origin+'/static/reader.html?id=0ym7e7wbcxau0&ext=image-pages')
                self.assertTrue(self.page.locator('img.reader-image').evaluate('image => image.naturalWidth > 0'))
                self.assertTrue(self.page.locator('#full-search-toggle').evaluate('node => node.hidden'))
                self.assertEqual(self.page.locator('.reader-page').count(), 0)
                self.assertEqual(self.page.url.split('?')[1], 'id=0ym7e7wbcxau0&ext=image-pages')
                self.page.evaluate('window.dispatchEvent(new Event("voice-reader-dispose"))')
                self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'disposed')
                self.page.unroute('**/api/reader-bucket-resource?**')
        self.assertEqual(len(originals), 2)

    def test_classic_engine_failure_timeout_and_disposal_release_scripts(self):
        self.page.add_init_script('''const timer = window.setTimeout.bind(window);
          window.setTimeout = (fn, ms, ...args) => timer(fn, ms === 20000 ? 400 : ms, ...args);''')
        for extension, fault in (('md', 'http'), ('html', 'timeout'), ('html', 'dispose')):
            with self.subTest(extension=extension, fault=fault):
                held = []
                pattern = '**/static/vendor/' + ('marked' if extension == 'md' else 'purify') + '.min.*.js'
                self.page.route(pattern, lambda route: route.fulfill(status=503, body='unavailable')
                                if fault == 'http' else held.append(route))
                self.serve('Readable document')
                self.page.goto(self.reader_url(extension), wait_until='domcontentloaded')
                if fault == 'dispose':
                    self.page.wait_for_function("() => !!document.querySelector('script[src*=\"purify.min.\"]')")
                    self.page.evaluate("window.__pendingScript = document.querySelector('script[src*=\"purify.min.\"]'); window.dispatchEvent(new Event('pagehide'))")
                    self.assertEqual(self.page.evaluate('[__pendingScript.isConnected, __pendingScript.onload, __pendingScript.onerror]'), [False, None, None])
                    self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'disposed')
                else:
                    self.page.locator('#reader-engine-retry').wait_for()
                    self.assertEqual(self.page.locator('#content').get_attribute('data-error-code'), 'READER_ENGINE_NETWORK')
                    self.assertEqual(self.page.locator('script[src*="' + ('marked' if extension == 'md' else 'purify') + '.min."]').count(), 0)
                self.page.unroute(pattern)
                for route in held:
                    route.abort()

    def test_image_wait_releases_listeners_on_success_deadline_and_disposal(self):
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + """
              window.__imageWaitProbe = async () => {
                const timers = new Set(), set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
                window.setTimeout = (fn, ms, ...args) => {
                  let handle; handle = set(() => { timers.delete(handle); fn(...args); }, ms);
                  if (ms === 1000 || ms === 10) timers.add(handle);
                  return handle;
                };
                window.clearTimeout = handle => { timers.delete(handle); clear(handle); };
                const make = () => {
                  const image = new EventTarget(), listeners = new Set();
                  image.complete = false;
                  let decodes = 0;
                  image.decode = async () => { decodes++; };
                  const add = image.addEventListener.bind(image), remove = image.removeEventListener.bind(image);
                  image.addEventListener = (type, fn, ...args) => { listeners.add(type); add(type, fn, ...args); };
                  image.removeEventListener = (type, fn, ...args) => { listeners.delete(type); remove(type, fn, ...args); };
                  return {image, root: {querySelectorAll: () => [image]},
                    metrics: () => [listeners.size, decodes, image.loading]};
                };
                const good = make(), first = settleReaderImages(good.root, 1000);
                good.image.complete = true; good.image.dispatchEvent(new Event('load')); await first;
                const expired = make(); await settleReaderImages(expired.root, 10);
                expired.image.dispatchEvent(new Event('load'));
                const cancelled = make(), pending = settleReaderImages(cancelled.root, 1000).catch(e => e.name);
                readerRuntime.dispose(); const outcome = await pending;
                cancelled.image.dispatchEvent(new Event('load')); await Promise.resolve();
                return [good.metrics(), expired.metrics(), cancelled.metrics(), outcome, timers.size];
              };
            """)
        self.page.route('**/static/reader.js*', instrument)
        self.serve('Image waiting')
        self.open(self.reader_url())
        self.assertEqual(self.page.evaluate('window.__imageWaitProbe()'),
                         [[0, 1, 'eager'], [0, 0, 'eager'], [0, 0, 'eager'], 'AbortError', 0])

    def test_epub_lazy_image_loads_while_section_is_prepared_off_dom(self):
        with zipfile.ZipFile(io.BytesIO(support.minimal_epub())) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        files['OEBPS/chapter.xhtml'] = files['OEBPS/chapter.xhtml'].replace(
            b'</body>', b'<img src="picture.webp" loading="lazy" alt="Chapter image" width="64" height="32"/></body>')
        files['OEBPS/picture.webp'] = support.IMAGE_FIXTURES['webp'][1]
        images = []
        self.page.route('**/api/reader-resource?**', lambda route: (
            images.append(route.request.url), route.fulfill(content_type='image/webp', body=files['OEBPS/picture.webp'])))
        self.serve(support.zip_bytes(files), 'application/epub+zip')
        self.open(self.reader_url('epub'))
        image = self.page.locator('article[data-section] img').first
        self.assertEqual(image.evaluate('node => node.loading'), 'eager')
        self.assertGreater(image.evaluate('node => node.naturalWidth'), 0)
        self.assertEqual(len(images), 1)

    def test_native_spreadsheet_html_keeps_cells_selectable_and_zoomable(self):
        chart = support.IMAGE_FIXTURES["webp"][1]
        chart_data = "data:image/webp;base64," + base64.b64encode(chart).decode()
        document = (
            '<!doctype html><html><head><meta charset="utf-8"><style>'
            'body{width:max-content;min-width:100%;margin:0;padding:12px}'
            '.reader-spreadsheet-sheet{width:max-content;min-width:100%}'
            '</style></head><body><section class="reader-spreadsheet-sheet">'
            '<h2>Summary</h2><table><tr><td id="cell">完整单元格文字</td>'
            f'<td><img src="{chart_data}"></td></tr></table></section></body></html>'
        )
        self.serve(document, "text/html")
        self.open(self.reader_url("html", "table"))
        frame_element = self.page.locator("iframe.spreadsheet-html-frame")
        frame_element.wait_for()
        frame = frame_element.element_handle().content_frame()
        self.assertEqual(frame.locator("#cell").text_content().strip(), "完整单元格文字")
        self.assertGreater(frame.locator("img").evaluate("image => image.naturalWidth"), 0)
        before = frame.locator("table").evaluate("node => node.getBoundingClientRect().width")
        self.page.locator("#zoom-in").click(click_count=5)
        self.assertGreater(
            frame.locator("table").evaluate("node => node.getBoundingClientRect().width"), before,
        )

    def test_saved_native_pdf_opens_target_page_first(self):
        store = support.STORE_SCRIPT.replace(
            "get: () => new Promise((resolve) => setTimeout(() => resolve(null), 300)),",
            "get: () => Promise.resolve({page: 12, pageOffset: 20, zoom: 1}),",
        )
        module = support.PDF_MODULE.replace(
            "getPage: () => Promise.resolve(page)",
            "getPage: (number) => { (window.__pdfPageRequests ||= []).push(number); return Promise.resolve(page); }",
        )
        self.page.route("**/static/reader/core/reader-store.js", lambda route: route.fulfill(content_type="text/javascript", body=store))
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(content_type="text/javascript", body=module))
        self.serve(b"pdf", "application/pdf")
        self.open(self.reader_url("pdf"))
        self.assertEqual(self.page.evaluate("window.__pdfPageRequests[0]"), 12)
        self.assertEqual(self.page.locator("#page-number").input_value(), "12")
        self.page.locator('.reader-page[data-page="12"] canvas.ready').wait_for()

    def test_saved_pdf_pages_requests_target_image_first(self):
        store = support.STORE_SCRIPT.replace(
            "get: () => new Promise((resolve) => setTimeout(() => resolve(null), 300)),",
            "get: () => Promise.resolve({page: 12, pageOffset: 0, zoom: 1}),",
        )
        manifest = {"version": 2, "kind": "pdf-pages", "page_count": 24}
        root = "https://huggingface.co/buckets/vomebook/pdf-pages-v2/resolve/objects/aa/" + "a" * 64 + "/1234567890abcdef"
        requests = []
        self.page.route("**/static/reader/core/reader-store.js", lambda route: route.fulfill(content_type="text/javascript", body=store))
        self.serve(json.dumps(manifest), "application/json")
        self.page.route("**/page-manifest.json", lambda route: route.fulfill(json=manifest))
        def image(route):
            requests.append(route.request.url)
            route.fulfill(content_type="image/webp", body=support.IMAGE_FIXTURES["webp"][1])
        self.page.route("**/pages/page-*.webp", image)
        self.open(self.reader_url("pdf-pages", url=root + "/page-manifest.json"))
        self.assertTrue(requests, "saved-page image was not requested")
        self.assertTrue(requests[0].endswith("page-000012.webp"), requests)
        self.assertEqual(self.page.locator("#page-number").input_value(), "12")

    def test_native_pdf_reuses_text_after_layer_is_cleared(self):
        module = support.PDF_MODULE.replace("numPages: 30", "numPages: 1").replace(
            "getTextContent() { return Promise.resolve",
            "getTextContent() { window.__pdfTextCalls = (window.__pdfTextCalls || 0) + 1; return Promise.resolve",
        )
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(content_type="text/javascript", body=module))
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + "\nwindow.__reloadPdfText = async () => { const shell = document.querySelector('.reader-page[data-page=\\\"1\\\"]'); shell.querySelector('.reader-pdf-text').replaceChildren(); shell.dataset.textReady = '0'; await renderPdfText(await pdfDocument.getPage(1), shell); };\n")
        self.page.route("**/static/reader.js*", instrument)
        self.serve(b"pdf", "application/pdf")
        self.open(self.reader_url("pdf"))
        self.page.wait_for_function("() => document.querySelector('.reader-page[data-page=\\\"1\\\"]')?.dataset.textReady === '1'")
        before = self.page.evaluate("window.__pdfTextCalls")
        self.page.evaluate("window.__reloadPdfText()")
        self.assertEqual(self.page.evaluate("window.__pdfTextCalls"), before)
        self.assertIn("Accessible PDF text", self.page.locator('.reader-page[data-page="1"] .reader-pdf-text').text_content())

    def test_saved_chapter_book_fetches_target_first(self):
        store = support.STORE_SCRIPT.replace(
            "get: () => new Promise((resolve) => setTimeout(() => resolve(null), 300)),",
            "get: () => Promise.resolve({chapterIndex: 8, chapterOffset: 0}),",
        )
        root = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/" + "a" * 64 + "/1234567890abcdef"
        manifest = {"version": 1, "kind": "epub-chapters", "toc": [], "chapters": [
            {"index": i, "path": f"chapters/chapter-{i:04d}.xhtml", "bytes": 100} for i in range(1, 13)
        ]}
        requested = []
        self.page.route("**/static/reader/core/reader-store.js", lambda route: route.fulfill(content_type="text/javascript", body=store))
        def resource(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query).get("path", [""])[0]
            if path.endswith(".xhtml"):
                number = int(path.rsplit("chapter-", 1)[1].split(".", 1)[0])
                requested.append(number)
                route.fulfill(content_type="text/html", body=f"<h1>Chapter {number}</h1><p>Content</p>")
            else:
                route.fulfill(json=manifest)
        self.page.route("**/api/reader-bucket-resource**", resource)
        self.page.route("**/static/reader.js*", lambda route: (
            (lambda response: route.fulfill(response=response, body=response.text() +
              "\nwindow.__testLoadChapter = index => chapterManifestLoader(index);\n"))(route.fetch())
        ))
        self.open(self.reader_url("epub-chapters", url=root + "/chapter-manifest.json"))
        self.assertEqual(requested[0], 8)
        self.assertNotIn(1, requested)
        self.assertTrue(self.page.locator('.reader-epub-chapter[data-chapter="8"]').is_visible())
        self.page.evaluate('__testLoadChapter(7)')
        self.page.locator('.reader-epub-chapter[data-chapter="7"]').wait_for(state="attached")
        self.page.wait_for_function("() => document.querySelector('.reader-chapter-sentinel[data-chapter=\\\"6\\\"]') || document.querySelector('.reader-epub-chapter[data-chapter=\\\"6\\\"]')")
        self.page.evaluate("() => document.querySelector('.reader-chapter-sentinel[data-chapter=\\\"6\\\"]')?.click()")
        self.page.locator('.reader-epub-chapter[data-chapter="6"]').wait_for(state="attached")
        self.assertNotIn(1, requested)

    def test_saved_foliate_builds_target_section_first(self):
        store = support.STORE_SCRIPT.replace(
            "get: () => new Promise((resolve) => setTimeout(() => resolve(null), 300)),",
            "get: () => Promise.resolve({foliateSection: 10, foliateOffset: 0, foliateTocIndex: 9}),",
        )
        self.page.route("**/static/reader/core/reader-store.js", lambda route: route.fulfill(content_type="text/javascript", body=store))
        def instrument(route):
            response = route.fetch()
            body = response.text().replace(
                "async function createFoliateSection(section, index) {",
                "async function createFoliateSection(section, index) { (window.__openedSections ||= []).push(index);",
            )
            route.fulfill(response=response, body=body)
        self.page.route("**/static/reader/formats/reader-foliate-format.mjs*", instrument)
        self.serve(support.epub_with_many_chapters(), "application/epub+zip")
        self.open(self.reader_url("epub"))
        self.assertEqual(self.page.evaluate("window.__openedSections[0]"), 10)
        self.assertTrue(self.page.locator('.foliate-continuous article[data-section="10"]').is_visible())

    def test_pdf_pages_retries_failed_ocr_text_without_reloading_image(self):
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + "\nwindow.__reloadPdfOcr = async () => { const shell = document.querySelector('.reader-page[data-page=\\\"1\\\"]'); shell.querySelector('.reader-pdf-text').replaceChildren(); shell.dataset.textReady = '0'; await renderPdfOcrText(shell); };\n")
        self.page.route("**/static/reader.js*", instrument)
        root = "objects/aa/" + "a" * 64 + "/" + "b" * 16
        source = "https://huggingface.co/buckets/vomebook/pdf-pages-v2/resolve/" + root
        ocr_path = root + "/ocr-manifest.json"
        manifest = {"version": 1, "kind": "pdf-ocr", "complete": True,
                    "source_sha256": "a" * 64, "profile": "test-layout-v1-retry", "page_count": 2,
                    "pages": [{"p": page, "o": root + f"/ocr/page-{page:06d}.json.gz"} for page in (1, 2)],
                    "book_text": {"path": root + "/ocr/book-text.json.gz", "bytes": 1, "sha256": "a" * 64}}
        attempts, image_requests = [], []
        self.serve(json.dumps({"version": 2, "kind": "pdf-pages", "page_count": 2}), "application/json")
        def image(route):
            image_requests.append(route.request.url)
            route.fulfill(content_type="image/webp", body=support.IMAGE_FIXTURES["webp"][1])
        def resource(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["path"][0]
            if path.endswith("/page-manifest.json"):
                route.fulfill(json={"version": 2, "kind": "pdf-pages", "page_count": 2})
                return
            if path == ocr_path:
                route.fulfill(json=manifest)
                return
            if path.endswith("page-000001.json.gz"):
                attempts.append(path)
                if len(attempts) == 1:
                    route.fulfill(status=503, body="temporarily unavailable")
                    return
            number = int(path.rsplit("page-", 1)[1][:6])
            payload = {"version": 1, "kind": "pdf-ocr-page", "page": number,
                       "width": 100, "height": 140,
                       "blocks": [{"t": "Recovered text", "b": [0.1, 0.2, 0.8, 0.3]}]}
            route.fulfill(content_type="application/gzip", body=gzip.compress(json.dumps(payload).encode()))
        self.page.route(source + "/pages/**", image)
        self.page.route("https://voiceofml-search.hf.space/api/reader-bucket-resource**", resource)
        self.open(self.reader_url("pdf-pages", url=source + "/page-manifest.json",
                                  ocr_manifest="https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + ocr_path))
        self.page.wait_for_function("() => document.querySelector('.reader-page[data-page=\"1\"]')?.dataset.renderState === 'rendered' && !document.querySelector('.reader-page[data-page=\"1\"]')._ocrPromise")
        self.assertIn(len(attempts), (1, 2))
        first_image_requests = image_requests.count(source + "/pages/page-000001.webp")
        self.page.locator("#page-number").fill("2")
        self.page.locator("#page-number").dispatch_event("change")
        self.page.wait_for_function("() => document.querySelector('#page-number').value === '2'")
        self.page.locator("#page-number").fill("1")
        self.page.locator("#page-number").dispatch_event("change")
        self.page.locator('.reader-page[data-page="1"][data-text-ready="1"]').wait_for()
        self.assertEqual(len(attempts), 2)
        self.assertEqual(image_requests.count(source + "/pages/page-000001.webp"), first_image_requests)
        self.assertIn("Recovered text", self.page.locator('.reader-page[data-page="1"] .reader-pdf-text').text_content())
        self.page.evaluate("window.__reloadPdfOcr()")
        self.assertEqual(len(attempts), 2)
        self.assertIn("Recovered text", self.page.locator('.reader-page[data-page="1"] .reader-pdf-text').text_content())

    def test_download_during_prepare_does_not_interrupt_reader(self):
        pending_content = []
        checks = []
        downloads = []
        def slow_content(route):
            pending_content.append(route)
        def check_download(route):
            checks.append(route.request.url)
            if len(checks) == 1:
                route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": "下载检查失败，请重试"}))
            else:
                route.fulfill(content_type="application/json", body=json.dumps({"ok": True}))
        def serve_download(route):
            downloads.append(route.request.url)
            route.fulfill(content_type="application/octet-stream", body=b"download",
                          headers={"Content-Disposition": "attachment; filename*=UTF-8''refactor.txt"})
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", slow_content)
        self.page.route("https://voiceofml-search.hf.space/api/download/check**", check_download)
        self.page.route("https://voiceofml-search.hf.space/api/download?**", serve_download)
        self.page.goto(self.reader_url("txt"), wait_until="domcontentloaded")
        self.page.wait_for_function("() => document.querySelector('#download').hasAttribute('href')")
        self.assertNotEqual(self.page.locator("html").get_attribute("data-reader-phase"), "ready")
        self.page.locator("#download").click()
        self.page.wait_for_function("() => document.querySelector('#download-feedback').textContent === '下载检查失败，请重试'")
        self.assertEqual(len(checks), 1)
        self.assertEqual(downloads, [])
        self.assertNotIn("原文件", self.page.locator("#status").text_content())
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.assertTrue(self.page.locator("#download-feedback").evaluate("""node => {
            const message = node.getBoundingClientRect();
            const button = document.querySelector('#download').getBoundingClientRect();
            return message.left >= 0 && message.right <= innerWidth && message.top >= button.bottom;
        }"""))
        with self.page.expect_download() as event:
            self.page.locator("#download").click()
        self.assertEqual(event.value.suggested_filename, "refactor.txt")
        self.assertEqual(self.page.locator("html").get_attribute("data-reader-phase"), "prepare")
        self.assertEqual(len(checks), 2)
        self.assertEqual(len(downloads), 1)
        pending_content[0].fulfill(content_type="text/plain", body="Reader download")
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.assertIn("Reader download", self.page.locator("#content").text_content())

    def test_id_only_download_joins_reader_resolution(self):
        resolved = []
        content = []
        checks = []
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/shared.txt"
        self.page.route("https://voiceofml-search.hf.space/api/reader-resolve?**", lambda route: resolved.append(route))
        self.page.route("https://voiceofml-search.hf.space/api/reader-content?**", lambda route: content.append(route))
        self.page.route("https://voiceofml-search.hf.space/api/download/check?**", lambda route: (
            checks.append(route.request.url), route.fulfill(json={"ok": True}, headers={"Access-Control-Allow-Origin": "*"})))
        self.page.route("https://voiceofml-search.hf.space/api/download?**", lambda route: route.fulfill(
            body=b"original", headers={"Content-Disposition": "attachment; filename=shared.txt"}))
        self.page.goto(self.origin + "/search/static/reader.html?id=" + "a" * 13 + "&ext=txt", wait_until="domcontentloaded")
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'resolve'")
        self.page.locator("#download").click()
        self.page.locator("#download").click()
        self.assertEqual(len(resolved), 1)
        self.assertEqual(checks, [])
        with self.page.expect_download() as event:
            resolved[0].fulfill(json={"url": source, "download": source, "title": "shared", "extension": "txt"},
                                headers={"Access-Control-Allow-Origin": "*"})
        self.assertEqual(event.value.suggested_filename, "shared.txt")
        self.assertEqual(len(checks), 1)
        self.assertEqual(self.page.locator("html").get_attribute("data-reader-phase"), "prepare")
        content[0].fulfill(body="Resolved text", headers={"Access-Control-Allow-Origin": "*"})
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")

    def test_pdf_can_finish_preparing_after_download_starts(self):
        pending_content = []
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**",
                        lambda route: pending_content.append(route))
        self.page.route("https://voiceofml-search.hf.space/api/download/check**",
                        lambda route: route.fulfill(json={"ok": True}, headers={"Access-Control-Allow-Origin": "*"}))
        self.page.route("https://voiceofml-search.hf.space/api/download?**", lambda route: route.fulfill(
            content_type="application/octet-stream", body=b"original",
            headers={"Content-Disposition": "attachment; filename=book.pdf"}))
        self.page.goto(self.reader_url("pdf"), wait_until="domcontentloaded")
        self.page.wait_for_function("() => document.querySelector('#download').hasAttribute('href')")
        with self.page.expect_download() as event:
            self.page.locator("#download").click()
        self.assertEqual(event.value.suggested_filename, "book.pdf")
        self.assertEqual(self.page.locator("html").get_attribute("data-reader-phase"), "prepare")
        self.page.wait_for_timeout(200)
        self.assertTrue(pending_content)
        pending_content[0].fulfill(content_type="application/pdf", body=support.minimal_pdf(),
                                   headers={"Access-Control-Allow-Origin": "*"})
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(state="attached")

    def test_pdf_retries_transient_proxy_failure_while_download_starts(self):
        requests, held = [], []
        direct = []
        def reader_content(route):
            requests.append(route)
            if len(requests) > 1:
                route.fulfill(content_type="application/pdf", body=support.minimal_pdf(),
                              headers={"Access-Control-Allow-Origin": "*"})
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**", reader_content)
        self.page.route("https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/refactor.pdf",
                        lambda route: (direct.append(route.request.url), route.abort()))
        self.page.route("https://voiceofml-search.hf.space/api/download/check**",
                        lambda route: route.fulfill(json={"ok": True}, headers={"Access-Control-Allow-Origin": "*"}))
        self.page.route("https://voiceofml-search.hf.space/api/download?**", lambda route: route.fulfill(
            body=b"original", headers={"Content-Disposition": "attachment; filename=refactor.pdf"}))
        for fault in ("http", "transport"):
            with self.subTest(fault=fault):
                requests.clear()
                with self.page.expect_request("https://voiceofml-search.hf.space/api/reader-content**"):
                    self.page.goto(self.reader_url("pdf"), wait_until="domcontentloaded")
                self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'prepare'")
                with self.page.expect_download() as event:
                    self.page.locator("#download").click()
                self.assertEqual(event.value.suggested_filename, "refactor.pdf")
                self.page.wait_for_function("() => document.querySelector('#download-feedback').textContent === '已发起下载'")
                self.assertEqual(len(requests), 1)
                if fault == "http":
                    requests[0].fulfill(status=503, body="temporary", headers={"Access-Control-Allow-Origin": "*"})
                else:
                    requests[0].abort("failed")
                self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
                self.page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(state="attached")
                self.assertEqual(len(requests), 2)
                self.assertEqual(direct, [])

    def test_failed_reader_still_allows_original_download(self):
        checks = []
        def check(route):
            checks.append(route.request.url)
            if len(checks) == 1:
                route.fulfill(status=503, json={"error": "暂时无法检查下载"})
            else:
                route.fulfill(json={"ok": True})
        self.page.route("https://voiceofml-search.hf.space/api/download/check**", check)
        self.page.route("https://voiceofml-search.hf.space/api/download?**", lambda route: route.fulfill(
            body=b"original", headers={"Content-Disposition": "attachment; filename=original.xyz"}))
        self.page.goto(self.reader_url("xyz"))
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'failed'")
        self.assertIn("请下载原文件", self.page.locator(".reader-error").text_content())
        self.page.locator("#download").click()
        self.page.wait_for_function("() => document.querySelector('#download-feedback').textContent === '暂时无法检查下载'")
        with self.page.expect_download() as event:
            self.page.locator("#download").click()
        self.assertEqual(event.value.suggested_filename, "original.xyz")
        self.assertEqual(len(checks), 2)

    def test_native_pdf_text_search_without_ocr_index(self):
        module = support.PDF_MODULE.replace("numPages: 30", "numPages: 3").replace(
            "return { width: 600 * scale, height: 800 * scale };",
            "return { width: 600 * scale, height: 800 * scale, scale, transform: [scale,0,0,-scale,0,800*scale], convertToViewportPoint:(x,y)=>[x*scale,(800-y)*scale] };")
        module = module.replace("getTextContent() { return Promise.resolve",
                                 "async getTextContent() { await new Promise(resolve => setTimeout(resolve, 150)); return Promise.resolve")
        module = module.replace("getPage: () => Promise.resolve(page)", """getPage: (number) => Promise.resolve({...page,
          async getTextContent() {
            if (number === 3 && !window.__lastPageReleased)
              await new Promise(resolve => { window.__releaseLastSearchPage = () => {
                window.__lastPageReleased = true; resolve();
              }; });
            return page.getTextContent();
          }})""")
        items = [dict(str=s, transform=[20, 0, 0, 20, x, 700], width=60, height=20, fontName="f")
                 for s, x in [("毛 ", 50), ("泽", 110), (" 东", 170), ("手。机", 230)]]
        items += [dict(str="毛 泽 东", transform=[20, 0, 0, 20, 50, 650-i*10],
                       width=80, height=20, fontName="f", hasEOL=True) for i in range(40)]
        text = json.dumps(dict(items=items, styles={"f": dict(fontFamily="sans-serif", ascent=0.8)}), ensure_ascii=False)
        module = module.replace("{ items: [{ str: 'Accessible PDF text', hasEOL: false }] }", text)
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(content_type="text/javascript", body=module))
        self.open(self.reader_url("pdf"))
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("毛泽东")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent.includes('正在搜索') && document.querySelectorAll('.full-search-result').length > 0")
        self.page.wait_for_function("() => !!window.__releaseLastSearchPage")
        self.assertTrue(self.page.locator("#full-search-page-next").is_disabled())
        self.assertTrue(self.page.locator("#full-search-page").is_disabled())
        self.page.evaluate("window.__releaseLastSearchPage()")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '123 个结果'")
        self.assertFalse(self.page.locator("#full-search-page-next").is_disabled())
        self.assertEqual(self.page.locator(".full-search-result").count(), 50)
        self.assertEqual(self.page.locator('.reader-page[data-page="1"] mark').first.text_content(), '毛 ')
        self.page.locator("#full-search-page-next").click()
        self.page.wait_for_function("() => document.querySelector('#full-search-page').value === '2'")
        self.page.locator("#full-search-page-next").click()
        self.page.wait_for_function("() => document.querySelector('#full-search-page').value === '3'")
        self.assertEqual(self.page.locator(".full-search-result").count(), 23)
        self.page.locator("#full-search-input").fill("手机")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '未找到正文匹配'")

    def test_pdf_first_query_reuses_rendered_page_text(self):
        module = support.PDF_MODULE.replace("numPages: 30", "numPages: 1").replace(
            "getTextContent() { return Promise.resolve",
            "getTextContent() { window.__pdfTextCalls = (window.__pdfTextCalls || 0) + 1; return Promise.resolve",
        )
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(
            content_type="text/javascript", body=module))
        self.open(self.reader_url("pdf"))
        self.page.wait_for_function("() => document.querySelector('.reader-page')?.dataset.textReady === '1'")
        self.search("Accessible")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "1 个结果")
        self.assertEqual(self.page.evaluate("window.__pdfTextCalls"), 1)

    def test_pdf_search_and_research_share_pending_render_text(self):
        module = support.PDF_MODULE.replace("numPages: 30", "numPages: 1").replace(
            "getTextContent() { return Promise.resolve({ items: [{ str: 'Accessible PDF text', hasEOL: false }] }); },",
            """getTextContent() {
              window.__pdfTextCalls = (window.__pdfTextCalls || 0) + 1;
              return window.__heldText ||= new Promise(resolve => {
                window.__releaseText = () => resolve({items: [{str: 'Accessible PDF text', hasEOL: false}]});
              });
            },""",
        )
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(
            content_type="text/javascript", body=module))
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + """
              const originalSearchText = loadPdfSearchText;
              loadPdfSearchText = (...args) => {
                window.__searchTextRequests = (window.__searchTextRequests || 0) + 1;
                return originalSearchText(...args);
              };
            """)
        self.page.route("**/static/reader.js*", instrument)
        self.open(self.reader_url("pdf"))
        self.page.wait_for_function("() => !!window.__releaseText")
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("Accessible")
        self.page.wait_for_function("() => window.__searchTextRequests === 1")
        self.page.locator("#full-search-input").fill("PDF")
        self.page.wait_for_function("() => window.__searchTextRequests === 2")
        self.assertEqual(self.page.evaluate("window.__pdfTextCalls"), 1)
        self.page.evaluate("window.__releaseText()")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.page.wait_for_function("() => document.querySelector('.reader-page')?.dataset.textReady === '1'")
        self.assertIn("PDF", self.page.locator(".full-search-result").text_content())

    def test_pdf_second_query_reuses_extracted_page_text(self):
        module = support.PDF_MODULE.replace(
            "getTextContent() { return Promise.resolve",
            "getTextContent() { window.__pdfTextCalls = (window.__pdfTextCalls || 0) + 1; return Promise.resolve"
        )
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(
            content_type="text/javascript", body=module))
        self.open(self.reader_url("pdf"))
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("Accessible")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '30 个结果'")
        first = self.page.evaluate("window.__pdfTextCalls")
        self.page.locator("#full-search-input").fill("PDF")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '30 个结果'")
        self.assertEqual(self.page.evaluate("window.__pdfTextCalls"), first)

    def test_pdf_text_failure_retries_and_disposal_releases_pending_work(self):
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + """
              window.__textOwnershipProbe = async () => {
                let calls = 0;
                const page = {getTextContent() {
                  calls++;
                  if (calls === 1) throw Error('extraction failed');
                  return {items: [{str: 'retry succeeded'}]};
                }};
                const failure = await loadPdfTextContent(999, page).catch(error => error.message);
                const text = await loadPdfTextContent(999, page);
                const settled = pdfTextContentPromises.size;
                let release, started;
                const startedPromise = new Promise(resolve => { started = resolve; });
                const pending = loadPdfTextContent(1000, {getTextContent: () =>
                  new Promise(resolve => { release = resolve; started(); })}).catch(error => error.name);
                await startedPromise;
                readerRuntime.dispose();
                const disposed = pdfTextContentPromises.size;
                const outcome = await pending;
                release({items: [{str: 'obsolete'}]});
                await Promise.resolve();
                return [failure, calls, text.items[0].str, settled, disposed, outcome,
                  pdfTextContentCache.size, pdfTextContentCacheBytes];
              };
            """)
        self.page.route("**/static/reader.js*", instrument)
        self.serve(support.minimal_pdf(), "application/pdf")
        self.open(self.reader_url("pdf"))
        self.page.wait_for_function("() => document.querySelector('.reader-page')?.dataset.textReady === '1'")
        self.assertEqual(self.page.evaluate("window.__textOwnershipProbe()"),
                         ["extraction failed", 2, "retry succeeded", 0, 0, "AbortError", 0, 0])

    def test_pdf_search_cache_cleanup_resets_byte_budget(self):
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + "\nwindow.__pdfCacheProbe = () => { cachePdfSearchText(1, 'cached'); readerRuntime.dispose(); return [pdfSearchTextCache.size, pdfSearchTextCacheBytes]; };\n")
        self.page.route("**/static/reader.js*", instrument)
        self.serve(support.minimal_pdf(), "application/pdf")
        self.open(self.reader_url("pdf"))
        self.assertEqual(self.page.evaluate("window.__pdfCacheProbe()"), [0, 0])

    def test_pdf_search_pages_reextract_evicted_text_and_ignore_cancelled_load(self):
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + "\nwindow.__dropPdfSearchCache = () => { pdfSearchTextCache.clear(); pdfSearchTextCacheBytes = 0; pdfTextContentCache.clear(); pdfTextContentCacheBytes = 0; };\n")
        self.page.route("**/static/reader.js*", instrument)
        module = support.PDF_MODULE.replace("numPages: 30", "numPages: 3").replace(
            "getPage: () => Promise.resolve(page)", """getPage: (number) => Promise.resolve({ ...page,
              getTextContent() {
                window.__pdfTextCalls = (window.__pdfTextCalls || 0) + 1;
                if (number === 1 && window.__holdPdfPage) {
                  window.__holdPdfPage = false;
                  return new Promise(resolve => { window.__releasePdfPage = () => resolve({ items: [{ str: 'needle '.repeat(60), hasEOL: false }] }); });
                }
                return Promise.resolve({ items: [{ str: 'needle '.repeat(60), hasEOL: false }] });
              } })""")
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(
            content_type="text/javascript", body=module))
        self.open(self.reader_url("pdf"))
        self.search("needle")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "180 个结果")
        self.assertEqual(self.page.locator(".full-search-result").count(), 50)
        self.page.evaluate("window.__dropPdfSearchCache()")
        calls = self.page.evaluate("window.__pdfTextCalls")
        self.page.locator("#full-search-page-next").click()
        self.page.wait_for_function("() => document.querySelector('.full-search-rank')?.textContent === '51.'")
        self.assertGreater(self.page.evaluate("window.__pdfTextCalls"), calls)
        self.page.locator("#full-search-page").fill("4")
        self.page.locator("#full-search-page").dispatch_event("change")
        self.page.wait_for_function("() => document.querySelector('.full-search-rank')?.textContent === '151.'")
        self.assertEqual(self.page.locator(".full-search-result").count(), 30)
        self.assertEqual(self.page.locator(".full-search-result").first.locator("small").text_content(), "第 3 页")
        self.page.evaluate("() => { window.__dropPdfSearchCache(); window.__holdPdfPage = true; }")
        self.page.locator("#full-search-page").fill("2")
        self.page.locator("#full-search-page").dispatch_event("change")
        self.page.wait_for_function("() => !!window.__releasePdfPage && document.querySelector('#full-search-status').textContent === '180 个结果'")
        self.page.locator("#full-search-cancel").click()
        self.page.evaluate("window.__releasePdfPage()")
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "搜索已取消")
        self.assertEqual(self.page.locator(".full-search-result").count(), 0)
        self.page.locator("#full-search-retry").click()
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '180 个结果'")
        self.page.locator("#full-search-page").fill("4")
        self.page.locator("#full-search-page").dispatch_event("change")
        self.page.wait_for_function("() => document.querySelector('.full-search-rank')?.textContent === '151.'")
        self.page.locator(".full-search-result").first.click()
        self.page.wait_for_function("() => document.querySelector('#page-number').value === '3'")

    def test_pdf_deep_result_page_can_cancel_while_skipping_hits(self):
        def instrument(route):
            response = route.fetch()
            script = response.text().replace(
                "function waitForReader(delay = 0, animationFrame = false) {",
                """function waitForReader(delay = 0, animationFrame = false) {
                  if (window.__holdSearchPage && delay === 0 && !animationFrame) {
                    window.__holdSearchPage = false;
                    return new Promise(resolve => { window.__releaseSearchPage = resolve; });
                  }"""
            )
            route.fulfill(response=response, body=script)
        self.page.route("**/static/reader/core/reader-lifecycle.mjs*", instrument)
        module = support.PDF_MODULE.replace("numPages: 30", "numPages: 2").replace(
            "getPage: () => Promise.resolve(page)", """getPage: () => Promise.resolve({ ...page,
              getTextContent() { return Promise.resolve({ items: [{ str: 'needle '.repeat(6000), hasEOL: false }] }); } })""")
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(
            content_type="text/javascript", body=module))
        self.open(self.reader_url("pdf"))
        self.search("needle")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "12000 个结果")
        self.page.evaluate("window.__holdSearchPage = true")
        self.page.locator("#full-search-page").fill("200")
        self.page.locator("#full-search-page").dispatch_event("change")
        self.page.wait_for_function("() => !!window.__releaseSearchPage && document.querySelector('#full-search-status').textContent === '12000 个结果'")
        self.page.locator("#full-search-cancel").click()
        self.page.evaluate("window.__releaseSearchPage()")
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "搜索已取消")
        self.assertEqual(self.page.locator(".full-search-result").count(), 0)

    def test_failed_pdf_search_page_retry_keeps_target_page(self):
        def instrument(route):
            response = route.fetch()
            needle = "async function loadPdfSearchText(pdf, page, generation) {"
            script = response.text()
            self.assertIn(needle, script)
            route.fulfill(response=response, body=script.replace(needle, needle + """
              if (page === 2 && window.__failSearchPage) {
                window.__failSearchPage = false;
                throw new Error('temporary page load');
              }"""))
        self.page.route("**/static/reader/pdf/reader-pdf-search.mjs*", instrument)
        module = support.PDF_MODULE.replace("numPages: 30", "numPages: 3").replace(
            "getPage: () => Promise.resolve(page)", """getPage: () => Promise.resolve({ ...page,
              getTextContent() { return Promise.resolve({ items: [{ str: 'needle '.repeat(60), hasEOL: false }] }); } })""")
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(
            content_type="text/javascript", body=module))
        self.open(self.reader_url("pdf"))
        self.search("needle")
        self.page.locator("#full-search-page-next").click()
        self.page.wait_for_function("() => document.querySelector('.full-search-rank')?.textContent === '51.'")
        self.page.evaluate("window.__failSearchPage = true")
        self.page.locator("#full-search-page-next").click()
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === 'temporary page load'")
        self.assertEqual(self.page.locator("#full-search-retry").text_content(), "重试本页")
        self.assertEqual(self.page.locator(".full-search-rank").first.text_content(), "51.")
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-toggle").click()
        self.assertTrue(self.page.locator("#full-search-retry").is_visible())
        self.page.locator("#full-search-retry").click()
        self.page.wait_for_function("() => document.querySelector('.full-search-rank')?.textContent === '101.'")
        self.assertEqual(self.page.locator("#full-search-page").input_value(), "3")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "180 个结果")

    def test_pending_foliate_result_does_not_close_reopened_search(self):
        self.serve(support.epub_with_many_chapters(3), "application/epub+zip")
        self.open(self.reader_url("epub"))
        self.search("正文")
        self.page.evaluate("""() => {
          const view = document.querySelector('foliate-view');
          const original = view.resolveNavigation.bind(view);
          view.resolveNavigation = cfi => new Promise(resolve => {
            window.__releaseSearchNavigation = () => resolve(original(cfi));
          });
        }""")
        self.page.locator(".full-search-result").first.click()
        self.page.wait_for_function("() => !!window.__releaseSearchNavigation")
        self.page.locator("#history").click()
        self.page.locator("#history").click()
        self.page.locator("#full-search-input").focus()
        self.page.evaluate("window.__releaseSearchNavigation()")
        self.page.locator(".foliate-continuous mark.full-search-highlight").first.wait_for()
        self.assertTrue(self.page.locator("#full-search-input").is_visible())
        self.assertTrue(self.page.locator("#history-panel").evaluate("node => node.classList.contains('is-open')"))

    def test_unresolvable_foliate_result_keeps_search_open_for_retry(self):
        self.serve(support.epub_with_many_chapters(3), "application/epub+zip")
        self.open(self.reader_url("epub"))
        self.search("正文")
        self.page.evaluate("""() => {
          const view = document.querySelector('foliate-view');
          window.__resolveSearchResult = view.resolveNavigation.bind(view);
          view.resolveNavigation = async () => null;
        }""")
        self.page.locator(".full-search-result").first.click()
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '搜索结果定位失败，请重试'")
        self.assertTrue(self.page.locator("#history-panel").evaluate("node => node.classList.contains('is-open')"))
        self.assertEqual(self.page.locator(".foliate-continuous mark.full-search-highlight").count(), 0)
        self.page.evaluate("document.querySelector('foliate-view').resolveNavigation = window.__resolveSearchResult")
        self.page.locator(".full-search-result").first.click()
        self.page.wait_for_function("() => !document.querySelector('#history-panel').classList.contains('is-open')")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "3 个结果")
        self.assertEqual(self.page.locator(".foliate-continuous mark.full-search-highlight").count(), 1)

    def test_foliate_navigation_exception_reports_failure_and_retries(self):
        self.serve(support.epub_with_many_chapters(3), "application/epub+zip")
        self.open(self.reader_url("epub"))
        self.search("正文")
        self.page.evaluate("""() => {
          const view = document.querySelector('foliate-view');
          const original = view.resolveNavigation.bind(view);
          view.resolveNavigation = async cfi => {
            view.resolveNavigation = original;
            throw new Error('temporary navigation failure');
          };
        }""")
        self.page.locator(".full-search-result").first.click()
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '搜索结果定位失败，请重试'")
        self.assertTrue(self.page.locator("#history-panel").evaluate("node => node.classList.contains('is-open')"))
        self.page.locator(".full-search-result").first.click()
        self.page.wait_for_function("() => !document.querySelector('#history-panel').classList.contains('is-open')")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "3 个结果")

    def test_stale_foliate_fallback_cannot_highlight_after_navigation(self):
        def hold_fallback(route):
            response = route.fetch()
            needle = "const nodes = cached ? [] : await fullSearchTextNodes(root, generation, Infinity, null, collect);"
            script = response.text()
            self.assertIn(needle, script)
            script = script.replace(needle, """if (occurrence !== null && !window.__fallbackHeld) {
              window.__fallbackHeld = true;
              await new Promise(resolve => { window.__releaseFallback = resolve; });
            } """ + needle)
            route.fulfill(response=response, body=script)
        def finish_fallback(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text().replace(
                "target = matches[0]?.target;", "target = matches[0]?.target; window.__fallbackDone = true;"))
        self.page.route("**/static/reader/search/reader-dom-search.mjs*", hold_fallback)
        self.page.route("**/static/reader/search/reader-search-backends.mjs*", finish_fallback)
        self.serve(support.epub_with_many_chapters(3), "application/epub+zip")
        self.open(self.reader_url("epub"))
        self.search("正文")
        self.page.evaluate("""() => {
          const view = document.querySelector('foliate-view');
          const original = view.resolveNavigation.bind(view);
          view.resolveNavigation = async cfi => ({ ...(await original(cfi)), anchor: null });
        }""")
        self.page.locator(".full-search-result").first.click()
        self.page.wait_for_function("() => !!window.__releaseFallback")
        self.page.evaluate("document.querySelector('#viewport').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))")
        self.page.evaluate("window.__releaseFallback()")
        self.page.wait_for_function("() => !!window.__fallbackDone")
        self.assertEqual(self.page.locator(".foliate-continuous mark.full-search-highlight").count(), 0)

    def test_foliate_search_reuses_rows_and_bounds_visited_pages(self):
        with zipfile.ZipFile(io.BytesIO(support.epub_with_many_chapters(6))) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        for number in range(1, 7):
            files[f'OEBPS/chapter-{number}.xhtml'] = (
                '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
                ''.join(f'<p>needle {number}-{hit}</p>' for hit in range(100)) +
                '</body></html>').encode()
        self.serve(support.zip_bytes(files), "application/epub+zip")
        self.open(self.reader_url("epub"))
        self.page.evaluate("""() => {
          window.__searchProbe = {rows: 0, calls: 0};
          const view = document.querySelector('foliate-view'), search = view.search.bind(view);
          view.search = (...args) => { __searchProbe.calls++; return search(...args); };
          new MutationObserver(records => {
            for (const record of records) __searchProbe.rows += record.addedNodes.length;
          }).observe(document.querySelector('#full-search-results'), {childList: true});
        }""")
        self.search("needle")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "600 个结果")
        self.assertEqual(self.page.evaluate("__searchProbe.rows"), 50)

        def jump(number):
            self.page.locator("#full-search-page").fill(str(number))
            self.page.locator("#full-search-page").dispatch_event("change")
            self.page.wait_for_function("rank => document.querySelector('.full-search-rank')?.textContent === rank",
                                        arg=f"{(number - 1) * 50 + 1}.")
            return self.page.locator(".full-search-result").all_text_contents()

        original = jump(2)
        jump(3)
        before = self.page.evaluate("__searchProbe.calls")
        self.assertEqual(jump(2), original)
        self.assertEqual(self.page.evaluate("__searchProbe.calls"), before)
        for number in (4, 5, 6, 7):
            jump(number)
        before = self.page.evaluate("__searchProbe.calls")
        self.assertEqual(jump(2), original)
        self.assertGreater(self.page.evaluate("__searchProbe.calls"), before)
        self.page.locator("#full-search-input").fill("absent")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '未找到正文匹配'")
        self.page.locator("#full-search-input").fill("needle")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '600 个结果'")
        before = self.page.evaluate("__searchProbe.calls")
        self.assertEqual(jump(2), original)
        self.assertGreater(self.page.evaluate("__searchProbe.calls"), before)

    def test_foliate_counting_materializes_only_requested_results(self):
        for name, needle, probe in (
            ("search.js", "const makeExcerpt = (strs, { startIndex, startOffset, endIndex, endOffset }) => {", "__excerptCalls"),
            ("text-walker.js", "const range = document.createRange()", "__rangeCalls"),
        ):
            def instrument(route, _request, needle=needle, probe=probe):
                response = route.fetch()
                self.assertIn(needle, response.text())
                route.fulfill(response=response, body=response.text().replace(needle,
                    needle + f"; window.{probe} = (window.{probe} || 0) + 1;"))
            self.page.route(f"**/foliate-reader/{name}", instrument)
        with zipfile.ZipFile(io.BytesIO(support.epub_with_many_chapters(1))) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        files['OEBPS/chapter-1.xhtml'] = (
            '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
            ''.join(f'<p>needle {hit}</p>' for hit in range(1000)) + '</body></html>'
        ).encode()
        self.serve(support.zip_bytes(files), "application/epub+zip")
        self.open(self.reader_url("epub"))
        self.page.evaluate("window.__excerptCalls = window.__rangeCalls = 0")
        self.search("needle")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "1000 个结果")
        self.assertEqual(self.page.evaluate("[window.__excerptCalls, window.__rangeCalls]"), [50, 50])
        self.page.locator("#full-search-page").fill("20")
        self.page.locator("#full-search-page").dispatch_event("change")
        self.page.wait_for_function("() => document.querySelector('.full-search-rank')?.textContent === '951.'")
        self.assertEqual(self.page.evaluate("[window.__excerptCalls, window.__rangeCalls]"), [100, 100])
        self.assertIn("999", self.page.locator(".full-search-result").last.text_content())
        self.page.locator(".full-search-result").last.click()
        self.page.wait_for_function("() => [...document.querySelectorAll('article[data-section]')].some(node => node.shadowRoot?.querySelector('mark')?.parentElement.textContent === 'needle 999')")

    def test_foliate_excerpt_preserves_all_inline_match_nodes(self):
        self.serve("Text")
        self.open(self.reader_url())
        base = urllib.parse.urlsplit(self.reader_url()).path.rsplit('/', 1)[0]
        result = self.page.evaluate("""async base => {
          const {search} = await import(base + '/foliate-reader/search.js');
          return ['variant', 'base'].map(sensitivity => {
            const result = [...search(['before ne', 'e', 'dle after'], 'needle',
              {sensitivity, granularity: 'grapheme'})][0];
            return result.excerpt;
          }).concat([...search(['ne', 'ed', 'ne'], 'needne',
            {sensitivity: 'base', granularity: 'grapheme'})][0].excerpt);
        }""", base)
        self.assertEqual(result, [{"pre": "before ", "match": "needle", "post": " after"}] * 2 +
                         [{"pre": "", "match": "needne", "post": ""}])

    def test_foliate_many_hits_paginate_and_cancel(self):
        with zipfile.ZipFile(io.BytesIO(support.epub_with_many_chapters(3))) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        for number in (1, 2, 3):
            files[f'OEBPS/chapter-{number}.xhtml'] = (
                '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
                ''.join(f'<p>needle {number}-{hit}</p>' for hit in range(70)) +
                '</body></html>'
            ).encode()
        self.serve(support.zip_bytes(files), "application/epub+zip")
        self.open(self.reader_url("epub"))
        self.search("needle")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "210 个结果")
        self.assertEqual(self.page.locator(".full-search-result").count(), 50)
        self.assertTrue(self.page.locator("#full-search-cancel").is_hidden())
        self.page.evaluate("""() => {
          window.__cancelPagingChanges = [];
          const cancel = document.querySelector('#full-search-cancel');
          new MutationObserver(() => {
            __cancelPagingChanges.push(cancel.hidden);
          }).observe(document.querySelector('#full-search-cancel'), {
            attributes: true, attributeFilter: ['hidden']
          });
        }""")
        self.page.evaluate("""() => {
          const status = document.querySelector('#full-search-status');
          window.__pagingStatuses = [status.textContent];
          window.__pagingObserver = new MutationObserver(records => {
            for (const record of records) {
              for (const node of record.removedNodes) window.__pagingStatuses.push(node.textContent);
            }
            window.__pagingStatuses.push(status.textContent);
          });
          window.__pagingObserver.observe(status, {childList: true});
          const view = document.querySelector('foliate-view');
          const original = view.search.bind(view);
          view.search = async function* (options) {
            if (options.index != null && !window.__heldResultPage) {
              window.__heldResultPage = true;
              await new Promise(resolve => { window.__releaseResultPage = resolve; });
            }
            yield* original(options);
          };
        }""")
        self.page.locator("#full-search-page-next").click()
        self.page.wait_for_function("() => !!window.__releaseResultPage")
        self.assertTrue(self.page.locator("#full-search-cancel").is_hidden())
        self.page.evaluate("window.__releaseResultPage()")
        self.page.wait_for_function("() => document.querySelector('.full-search-rank')?.textContent === '51.'")
        self.page.locator("#full-search-page").fill("3")
        self.page.locator("#full-search-page").dispatch_event("change")
        self.page.wait_for_function("() => document.querySelector('#full-search-page').value === '3' && document.querySelector('.full-search-result .full-search-rank')?.textContent === '101.'")
        self.assertIn("needle 2-30", self.page.locator(".full-search-result").first.text_content())
        self.assertTrue(self.page.locator("#full-search-cancel").is_hidden())
        self.assertNotIn(False, self.page.evaluate("__cancelPagingChanges"))
        statuses = self.page.evaluate("() => { window.__pagingObserver.disconnect(); return window.__pagingStatuses; }")
        self.assertEqual(set(statuses), {"210 个结果"})
        self.page.locator(".full-search-result").first.click()
        self.page.wait_for_function("() => !document.querySelector('#history-panel').classList.contains('is-open')")
        self.page.locator("#history").click()
        self.page.wait_for_function("() => document.querySelector('#history-panel').classList.contains('is-open') && !document.querySelector('#full-search-view').hidden")
        self.assertEqual(self.page.locator("#full-search-page").input_value(), "3")
        self.page.locator("#full-search-input").fill("missing")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '未找到正文匹配'")
        self.page.evaluate("""() => {
          const sections = document.querySelector('foliate-view').book.sections;
          for (const section of sections) if (section.createDocument) {
            const original = section.createDocument.bind(section);
            section.createDocument = async () => { await new Promise(resolve => setTimeout(resolve, 200)); return original(); };
          }
        }""")
        self.page.locator("#full-search-input").fill("needle")
        self.page.locator("#full-search-cancel").click()
        self.page.wait_for_timeout(700)
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "搜索已取消")
        self.assertEqual(self.page.locator(".full-search-result").count(), 0)
        self.page.locator("#full-search-retry").click()
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '210 个结果'")

    def test_pdf_with_unavailable_ocr_index_does_not_fall_back(self):
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(
            content_type="text/javascript", body=support.PDF_MODULE))
        manifest = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=objects/aa/" + "a" * 64 + "/" + "b" * 16 + "/ocr-manifest.json"
        self.page.route("**/api/reader-bucket-resource**", lambda route: route.fulfill(
            status=503, body="unavailable", headers={"Access-Control-Allow-Origin": "*"}))
        self.open(self.reader_url("pdf", ocr_manifest=manifest))
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("Accessible")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent.includes('503')")
        self.assertEqual(self.page.locator(".full-search-result").count(), 0)

    def test_pdf_with_valid_ocr_index_searches_index_not_native_text(self):
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(
            content_type="text/javascript", body=support.PDF_MODULE.replace("numPages: 30", "numPages: 1").replace(
                "getTextContent() { return Promise.resolve", "getTextContent() { window.__nativeTextReads=(window.__nativeTextReads||0)+1; return Promise.resolve")))
        root = "objects/aa/" + "a" * 64 + "/" + "b" * 16
        manifest_path = root + "/ocr-manifest.json"
        book_path = root + "/ocr/book-text.json.gz"
        text = "索引独有文字"
        book = gzip.compress(json.dumps({"version": 2, "kind": "pdf-book-text", "complete": True,
            "offset_unit": "unicode-codepoint", "source_sha256": "a" * 64,
            "page_count": 1, "pages": [{"page": 1, "text": text,
                "layout": {"offset_unit": "unicode-codepoint"},
                "text_spans": [{"start": 0, "end": len(text), "box": [0.1, 0.2, 0.4, 0.3]}]}]}).encode())
        manifest = {"version": 1, "kind": "pdf-ocr", "complete": True,
            "source_sha256": "a" * 64, "profile": "test-layout-v1-index",
            "page_count": 1, "pages": [{"p": 1, "o": root + "/ocr/page-000001.json.gz"}],
            "book_text": {"path": book_path, "bytes": len(book), "sha256": hashlib.sha256(book).hexdigest()}}
        requests, held = [], []
        def resource(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["path"][0]
            requests.append(path)
            headers = {"Access-Control-Allow-Origin": "*"}
            if path == manifest_path:
                route.fulfill(json=manifest, headers=headers)
            elif path == book_path:
                route.fulfill(content_type="application/gzip", body=book, headers=headers)
            else:
                route.fulfill(status=404, headers=headers)
        self.page.route("**/api/reader-bucket-resource**", resource)
        manifest_url = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + manifest_path
        self.open(self.reader_url("pdf", ocr_manifest=manifest_url))
        self.page.wait_for_timeout(7000)
        layer_path = root + "/ocr/page-000001.json.gz"
        self.assertEqual([path for path in requests if path != layer_path], [manifest_path, book_path])
        self.assertLessEqual(requests.count(layer_path), 1)
        native_reads = self.page.evaluate("window.__nativeTextReads || 0")
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("索引独有")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.assertEqual(self.page.locator(".full-search-result").count(), 1)
        self.assertEqual([path for path in requests if path != layer_path], [manifest_path, book_path])
        self.assertLessEqual(requests.count(layer_path), 1)
        self.assertEqual(self.page.evaluate("window.__nativeTextReads || 0"), native_reads)

    def test_pdf_ocr_progress_preserves_full_first_page_and_focus(self):
        def pause_after_first_page(route):
            response = route.fetch()
            script = response.text()
            pause = """
                if (scanned === 1) await new Promise(resolve => {
                  const release = event => {
                    if (event.data.type !== 'test-release') return;
                    self.removeEventListener('message', release);
                    resolve();
                  };
                  self.addEventListener('message', release);
                });"""
            legacy = "scanned, pages, ...partial.page(0) });"
            partitioned = "scanned, pages, ...page });"
            if legacy in script:
                script = script.replace("progress: (partial, scanned, pages) => {",
                    "progress: async (partial, scanned, pages) => {")
                script = script.replace(legacy, legacy + pause, 1)
            else:
                self.assertIn(partitioned, script)
                message = "self.postMessage({ id: data.id, session: session.id, progress: true,\n            " + partitioned
                script = script.replace(message, pause + "\n          " + message, 1)
            route.fulfill(response=response, body=script)
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(
            content_type="text/javascript", body=support.PDF_MODULE.replace("numPages: 30", "numPages: 3")))
        root = "objects/aa/" + "a" * 64 + "/" + "b" * 16
        manifest_path = root + "/ocr-manifest.json"
        book_path = root + "/ocr/book-text.json.gz"
        texts = ["needle " * 60, "needle", "end"]
        book = gzip.compress(json.dumps({"version": 2, "kind": "pdf-book-text", "complete": True,
            "offset_unit": "unicode-codepoint", "source_sha256": "a" * 64, "page_count": 3,
            "pages": [{"page": i + 1, "text": text, "layout": {"offset_unit": "unicode-codepoint"},
                "text_spans": []} for i, text in enumerate(texts)]}).encode())
        manifest = {"version": 1, "kind": "pdf-ocr", "complete": True,
            "source_sha256": "a" * 64, "profile": "test-layout-v1-index", "page_count": 3,
            "pages": [{"p": i + 1, "o": root + f"/ocr/page-{i + 1:06d}.json.gz"} for i in range(3)],
            "book_text": {"path": book_path, "bytes": len(book), "sha256": hashlib.sha256(book).hexdigest()}}
        def resource(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["path"][0]
            headers = {"Access-Control-Allow-Origin": "*"}
            if path == manifest_path:
                route.fulfill(json=manifest, headers=headers)
            elif path == book_path:
                route.fulfill(content_type="application/gzip", body=book, headers=headers)
            else:
                route.fulfill(status=404, headers=headers)
        self.page.route("**/api/reader-bucket-resource**", resource)
        manifest_url = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + manifest_path
        self.open(self.reader_url("pdf", ocr_manifest=manifest_url))
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("needle")
        self.page.wait_for_function("() => document.querySelectorAll('.full-search-result').length === 50")
        self.page.evaluate("() => { window.__firstOcrRow = document.querySelector('.full-search-result'); __firstOcrRow.focus(); }")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '61 个结果'")
        self.assertTrue(self.page.evaluate("() => document.querySelector('.full-search-result') === window.__firstOcrRow && document.activeElement === window.__firstOcrRow"))

    def test_pdf_ocr_worker_pages_deep_results_and_reuses_book(self):
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(
            content_type="text/javascript", body=support.PDF_MODULE.replace("numPages: 30", "numPages: 2")))
        root = "objects/aa/" + "a" * 64 + "/" + "b" * 16
        manifest_path = root + "/ocr-manifest.json"
        book_path = root + "/ocr/book-text.json.gz"
        book = gzip.compress(json.dumps({"version": 2, "kind": "pdf-book-text", "complete": True,
            "offset_unit": "unicode-codepoint", "source_sha256": "a" * 64, "page_count": 2,
            "pages": [{"page": page, "text": text, "layout": {"offset_unit": "unicode-codepoint"},
                       "text_spans": []} for page, text in ((1, "needle " * 620), (2, "tail"))]}).encode())
        manifest = {"version": 1, "kind": "pdf-ocr", "complete": True,
                    "source_sha256": "a" * 64, "profile": "test-layout-v1-index", "page_count": 2,
                    "pages": [{"p": page, "o": root + f"/ocr/page-{page:06d}.json.gz"} for page in (1, 2)],
                    "book_text": {"path": book_path, "bytes": len(book), "sha256": hashlib.sha256(book).hexdigest()}}
        book_requests = []
        def resource(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["path"][0]
            headers = {"Access-Control-Allow-Origin": "*"}
            if path == manifest_path:
                route.fulfill(json=manifest, headers=headers)
            elif path == book_path:
                book_requests.append(path)
                route.fulfill(content_type="application/gzip", body=book, headers=headers)
            else:
                route.fulfill(status=404, headers=headers)
        self.page.route("**/api/reader-bucket-resource**", resource)
        self.open(self.reader_url("pdf", ocr_manifest="https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + manifest_path))
        self.search("needle")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "620 个结果")
        self.page.locator("#full-search-page").fill("11")
        self.page.locator("#full-search-page").dispatch_event("change")
        self.page.wait_for_function("() => document.querySelector('.full-search-rank')?.textContent === '501.'")
        self.assertEqual(self.page.locator(".full-search-result").count(), 50)
        self.page.locator("#full-search-input").fill("tail")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.assertIn("第 2 页", self.page.locator(".full-search-result").first.text_content())
        self.assertEqual(book_requests, [book_path])

    def test_pdf_ocr_worker_retries_corrupt_book_and_can_cancel(self):
        self.page.route("**/static/vendor/pdf.min.*.mjs", lambda route: route.fulfill(
            content_type="text/javascript", body=support.PDF_MODULE.replace("numPages: 30", "numPages: 1")))
        root = "objects/aa/" + "a" * 64 + "/" + "b" * 16
        manifest_path, book_path = root + "/ocr-manifest.json", root + "/ocr/book-text.json.gz"
        book = gzip.compress(json.dumps({"version": 2, "kind": "pdf-book-text", "complete": True,
            "offset_unit": "unicode-codepoint", "source_sha256": "a" * 64, "page_count": 1,
            "pages": [{"page": 1, "text": "needle", "layout": {"offset_unit": "unicode-codepoint"},
                       "text_spans": []}]}).encode())
        manifest = {"version": 1, "kind": "pdf-ocr", "complete": True,
                    "source_sha256": "a" * 64, "profile": "test-layout-v1-index", "page_count": 1,
                    "pages": [{"p": 1, "o": root + "/ocr/page-000001.json.gz"}],
                    "book_text": {"path": book_path, "bytes": len(book), "sha256": hashlib.sha256(book).hexdigest()}}
        requests, held = [], []
        def resource(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["path"][0]
            headers = {"Access-Control-Allow-Origin": "*"}
            if path == manifest_path:
                route.fulfill(json=manifest, headers=headers)
            elif path == book_path:
                requests.append(path)
                if len(requests) == 1:
                    held.append(route)
                    return
                payload = b"x" * len(book) if len(requests) == 2 else book
                route.fulfill(content_type="application/gzip", body=payload, headers=headers)
            else:
                route.fulfill(status=404, headers=headers)
        self.page.route("**/api/reader-bucket-resource**", resource)
        self.open(self.reader_url("pdf", ocr_manifest="https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + manifest_path))
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        with self.page.expect_request(lambda request: urllib.parse.parse_qs(
                urllib.parse.urlsplit(request.url).query).get("path") == [book_path]):
            self.page.locator("#full-search-input").fill("needle")
        self.page.locator("#full-search-cancel").click()
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "搜索已取消")
        for route in held:
            try: route.abort()
            except support.PlaywrightError: pass
        self.page.locator("#full-search-retry").click()
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent.includes('PDF_OCR_HASH_MISMATCH')")
        self.page.locator("#full-search-retry").click()
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.assertEqual(requests, [book_path] * 3)

    def test_txt_preserves_literal_unicode_replacement_characters_and_search(self):
        text = 'prefix \ufffd needle\n' * 3
        self.serve(text.encode('utf-8'), 'text/plain; charset=utf-8')
        self.open(self.reader_url('txt'))
        self.assertEqual(self.page.locator('.reader-text').text_content(), text)
        self.page.locator('#history').click()
        self.page.locator('#full-search-toggle').click()
        self.page.locator('#full-search-input').fill('\ufffd')
        self.page.wait_for_function("()=>document.querySelector('#full-search-status').textContent==='3 个结果'")

    def test_media_waits_for_metadata_before_reporting_ready(self):
        held = []
        self.page.route('**/api/reader-content**', lambda route: held.append(route))
        self.page.goto(self.reader_url('wav'), wait_until='domcontentloaded')
        self.page.locator('audio').wait_for()
        self.assertEqual(self.page.locator('audio').evaluate('m => m.readyState'), 0)
        self.assertNotEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.assertTrue(held)
        held[0].fulfill(content_type='audio/wav', body=support.minimal_wav())
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.assertGreaterEqual(self.page.locator('audio').evaluate('m => m.readyState'), 1)

    def test_pending_media_loading_feedback_does_not_displace_player(self):
        for mode, extension in [('audio', 'wav'), ('video', 'mp4')]:
            for width in (390, 1100):
                with self.subTest(mode=mode, width=width):
                    held = []
                    self.page.set_viewport_size({'width': width, 'height': 844})
                    self.page.route('**/api/reader-content**', lambda route: held.append(route))
                    self.page.goto(self.reader_url(extension), wait_until='domcontentloaded')
                    self.page.locator(mode).wait_for()
                    self.assertNotEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
                    self.assertTrue(self.page.locator('.reader-loading-indicator').is_hidden())
                    geometry = self.page.locator(mode).evaluate('''m => {
                      const a=m.getBoundingClientRect(),v=document.querySelector('#viewport').getBoundingClientRect();
                      return {top:a.top,bottom:a.bottom,height:a.height,center:a.top+a.height/2,
                        vtop:v.top,vbottom:v.bottom,vheight:v.height,vcenter:v.top+v.height/2};
                    }''')
                    self.assertAlmostEqual(geometry['center'], geometry['vcenter'], delta=1)
                    if mode == 'video':
                        self.assertAlmostEqual(geometry['height'], geometry['vheight'], delta=1)
                    self.assertGreaterEqual(geometry['top'], geometry['vtop'] - 1)
                    self.assertLessEqual(geometry['bottom'], geometry['vbottom'] + 1)
                    self.page.evaluate("window.dispatchEvent(new Event('voice-reader-dispose'))")
                    for route in held:
                        try: route.abort()
                        except support.PlaywrightError: pass

    def test_media_metadata_stall_recovers_without_reader_reload(self):
        self.assert_media_metadata_stall(True)

    def test_media_original_retry_retains_position_and_paused_state(self):
        self.assert_media_retry_position(False)

    def test_media_original_retry_resumes_active_playback(self):
        self.assert_media_retry_position(True)

    def assert_media_retry_position(self, playing):
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as audio:
            audio.setparams((1, 2, 8000, 80000, 'NONE', 'not compressed'))
            audio.writeframes(b'\0\0' * 80000)
        data = buffer.getvalue()
        def serve_audio(route):
            start = int(route.request.headers.get('range', 'bytes=0-').split('=')[1].split('-')[0])
            route.fulfill(status=206,content_type='audio/wav',body=data[start:],headers={
                'Accept-Ranges':'bytes','Content-Range':f'bytes {start}-{len(data)-1}/{len(data)}'})
        self.page.route('**/api/reader-content**',serve_audio)
        originals = []
        self.page.route('https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/refactor.wav',
                        lambda route: (originals.append(route.request.url), serve_audio(route)))
        self.open(self.reader_url('wav'))
        self.page.locator('audio').evaluate("m => { m.muted=true; return m.play(); }")
        self.page.wait_for_function("()=>document.querySelector('audio').currentTime>.02")
        self.page.locator('audio').evaluate('m=>m.pause()')
        self.page.locator('audio').evaluate("m => { m.currentTime=.05; }")
        self.page.wait_for_function("()=>!document.querySelector('audio').seeking")
        self.assertAlmostEqual(self.page.locator('audio').evaluate('m=>m.currentTime'), .05)
        self.page.locator('audio').evaluate('m=>{m.playbackRate=1.25;}')
        if playing:
            self.page.locator('audio').evaluate('m=>m.play()')
        self.page.locator('audio').evaluate("m => m.dispatchEvent(new Event('error'))")
        self.page.wait_for_function("playing=>{const m=document.querySelector('audio');return m.readyState>=1 && (playing ? !m.paused && m.currentTime>=.05 : m.paused && m.currentTime===.05);}",arg=playing)
        self.assertEqual(len(originals), 1)
        self.assertEqual(self.page.locator('audio').evaluate('m=>m.paused'),not playing)
        self.assertEqual(self.page.locator('audio').evaluate('m=>m.playbackRate'),1.25)

    def test_media_retry_does_not_save_reset_time_on_close(self):
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as audio:
            audio.setparams((1, 2, 8000, 80000, 'NONE', 'not compressed'))
            audio.writeframes(b'\0\0' * 80000)
        data = buffer.getvalue()
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(status=206,
            content_type='audio/wav',body=data,headers={'Accept-Ranges':'bytes','Content-Range':f'bytes 0-{len(data)-1}/{len(data)}'}))
        held = []
        self.page.route('https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/refactor.wav',lambda route:held.append(route))
        self.open(self.reader_url('wav'))
        self.page.locator('audio').evaluate("m => { m.muted=true; return m.play(); }")
        self.page.wait_for_function("()=>document.querySelector('audio').currentTime>.02")
        self.page.locator('audio').evaluate('m=>m.pause()')
        self.page.locator('audio').evaluate("m => { m.currentTime=.05; }")
        self.page.wait_for_function("()=>!document.querySelector('audio').seeking")
        self.page.locator('audio').evaluate("m => m.dispatchEvent(new Event('error'))")
        self.page.evaluate("window.dispatchEvent(new Event('voice-reader-dispose'))")
        self.page.wait_for_timeout(100)
        entry = self.page.evaluate("async()=>await VoiceOfMLReaderStore.get(new URL(location.href).searchParams.get('url'))")
        self.assertEqual(entry['mediaTime'], .05)
        for route in held:
            try:route.abort()
            except support.PlaywrightError:pass

    def test_media_metadata_exhaustion_exposes_reload_and_can_recover(self):
        self.assert_media_metadata_stall(False)

    def test_disposal_cancels_pending_media_metadata_without_retry(self):
        self.page.add_init_script('''const timer=window.setTimeout.bind(window);
          window.setTimeout=(callback,delay,...args)=>timer(callback,delay===15000?200:delay,...args);''')
        held, originals = [], []
        self.page.route('**/api/reader-content**', lambda route: held.append(route))
        self.page.route('https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/refactor.wav',
                        lambda route: (originals.append(route.request.url), route.abort()))
        self.page.goto(self.reader_url('wav'),wait_until='domcontentloaded')
        self.page.locator('audio').wait_for()
        self.page.evaluate("window.dispatchEvent(new Event('voice-reader-dispose'))")
        self.page.wait_for_timeout(300)
        self.assertEqual(originals, [])
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'disposed')
        self.assertFalse(self.page.locator('audio').get_attribute('src'))
        for route in held:
            try: route.abort()
            except support.PlaywrightError: pass

    def assert_media_metadata_stall(self, recover):
        self.page.add_init_script('''const timer=window.setTimeout.bind(window);
          window.setTimeout=(callback,delay,...args)=>timer(callback,delay===15000?150:delay,...args);''')
        held, original_requests = [], []
        allow = [recover]
        self.page.route('**/api/reader-content**', lambda route:
            route.fulfill(content_type='audio/wav',body=support.minimal_wav()) if allow[0] and not recover else held.append(route))
        def original(route):
            original_requests.append(route.request.url)
            if allow[0]:
                route.fulfill(content_type='audio/wav',body=support.minimal_wav())
            else:
                held.append(route)
        self.page.route('https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/refactor.wav', original)
        self.page.goto(self.reader_url('wav'), wait_until='domcontentloaded')
        if not recover:
            self.page.locator('#reader-engine-retry').wait_for()
            self.assertEqual(self.page.locator('#content').get_attribute('data-error-code'), 'READER_MEDIA')
            self.assertEqual(len(original_requests), 1)
            allow[0] = True
            self.page.locator('#reader-engine-retry').click()
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready' && document.querySelector('audio').readyState >= 1")
        self.assertEqual(len(original_requests), 1)
        self.page.evaluate("window.dispatchEvent(new Event('voice-reader-dispose'))")
        self.assertFalse(self.page.locator('audio').get_attribute('src'))
        for route in held:
            try: route.abort()
            except support.PlaywrightError: pass

    def test_bucket_media_failure_retries_download_original_once(self):
        self.page.route('**/api/reader-bucket-resource**', lambda route: route.fulfill(status=503, body='unavailable'))
        self.assert_media_failure_retries_original_once(bucket=True)

    def test_media_proxy_failure_retries_original_once(self):
        self.assert_media_failure_retries_original_once()

    def assert_media_failure_retries_original_once(self, bucket=False):
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as audio:
            audio.setparams((1, 2, 8000, 8000, 'NONE', 'not compressed'))
            audio.writeframes(b'\0\0' * 8000)
        requests = []
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(status=503, body='unavailable'))
        def original(route):
            requests.append(route.request.url)
            data = buffer.getvalue()
            start = int(route.request.headers.get('range', 'bytes=0-').split('=')[1].split('-')[0])
            route.fulfill(status=206, content_type='audio/wav', body=data[start:],
                          headers={'Accept-Ranges': 'bytes', 'Content-Range': f'bytes {start}-{len(data)-1}/{len(data)}'})
        self.page.route('https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/refactor.wav', original)
        options = {}
        if bucket:
            options = dict(url='https://voiceofml-search.hf.space/api/reader-bucket-resource?path=media/audio/native/' + 'a' * 64 + '/audio.wav',
                           download='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/refactor.wav')
        self.open(self.reader_url('wav', **options))
        self.page.wait_for_function("() => document.querySelector('audio').readyState >= 1")
        self.assertEqual(len(requests), 1)
        self.assertEqual(self.page.locator('audio').evaluate('node => node.duration'), 1)
        self.page.evaluate("async () => { const media = document.querySelector('audio'); media.currentTime = 0.5; await VoiceOfMLReaderStore.put({url: new URL(location.href).searchParams.get('url'), mediaTime: 0.5}); }")
        self.page.reload()
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready' && document.querySelector('audio').currentTime === 0.5")
        self.assertEqual(len(requests), 2)
        self.page.locator('audio').evaluate("node => node.dispatchEvent(new Event('error'))")
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'failed'")
        self.assertEqual(len(requests), 2)

    def test_chapter_links_load_target_without_leaving_reader(self):
        prefix = 'chapters/ebook/epub/' + 'b' * 64 + '/' + 'a' * 16 + '/'
        bodies = {i: f'<h1>Chapter {i}</h1><p id="target" style="height:12000px">正文</p>' for i in range(1, 13)}
        bodies[1] = '<a href="chapter-0012.xhtml#target">跨章节跳转</a>' + bodies[1]
        manifest = dict(version=1, kind='epub-chapters', chapters=[dict(index=i, path=f'chapters/chapter-{i:04d}.xhtml', title=str(i), bytes=len(bodies[i].encode())) for i in bodies])
        def serve(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)['path'][0]
            body = json.dumps(manifest) if path.endswith('chapter-manifest.json') else bodies[int(path.rsplit('-', 1)[1].split('.')[0])]
            route.fulfill(content_type='application/json' if path.endswith('.json') else 'application/xhtml+xml', body=body)
        self.page.route('https://voiceofml-search.hf.space/api/reader-bucket-resource**', serve)
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=' + urllib.parse.quote(prefix + 'chapter-manifest.json', safe='')
        self.open(self.reader_url('epub-chapters', url=source))
        before = self.page.url
        self.page.get_by_text('跨章节跳转', exact=True).click()
        self.page.wait_for_function("() => !!document.querySelector('.reader-epub-chapter[data-chapter=\"12\"] #target')")
        self.page.wait_for_function("() => document.querySelector('#viewport').scrollTop > 1000")
        self.assertEqual(self.page.url, before)
        self.assertLess(abs(self.page.locator('.reader-epub-chapter[data-chapter="12"] #target').evaluate("node => node.getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top")), 5)

    def test_chapter_search_v2_bucket_index_keeps_checksum_retry_paging_and_highlight(self):
        documents, prefixes, requests = {}, {}, []
        for extension in ('epub', 'mobi', 'azw3', 'fb2'):
            prefix = f'chapters/ebook/{extension}/' + 'a' * 64 + '/' + 'b' * 16 + '/'
            prefixes[extension] = prefix
            bodies = {1:'<h1>First</h1><p>needle</p>', 2:'<h1>Tail</h1>' + '<p>needle</p>' * 65}
            if extension == 'fb2':
                bodies[1] = '<html><head><title>Cover</title></head><body>' + bodies[1] + '</body></html>'
            chapters = [{'index':index, 'path':f'chapters/chapter-{index:04d}.xhtml',
                         'title':f'Chapter {index}', 'bytes':len(body.encode())} for index,body in bodies.items()]
            texts = [{**chapter, 'text':'First needle' if chapter['index'] == 1 else 'Tail ' + ' '.join(['needle'] * 65)}
                     for chapter in chapters]
            if extension == 'fb2':
                texts[0]['text'] = 'Cover ' + texts[0]['text']
            packed = gzip.compress(json.dumps({'version':1, 'kind':'epub-search-index', 'chapters':texts}).encode(), mtime=0)
            manifest = {'version':1, 'kind':'epub-chapters', 'chapters':chapters,
                        'search_index':{'path':'epub-search-index.json.gz', 'bytes':len(packed),
                                        'sha256':hashlib.sha256(packed).hexdigest()}}
            documents[prefix+'chapter-manifest.json'] = ('application/json', json.dumps(manifest))
            documents[prefix+'epub-search-index.json.gz'] = ('application/gzip', packed)
            for chapter in chapters:
                documents[prefix+chapter['path']] = ('text/html', bodies[chapter['index']])

        def serve(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)['path'][0]
            requests.append(path)
            mime, body = documents[path]
            if path == prefixes['epub']+'epub-search-index.json.gz' and requests.count(path) == 1:
                body = body[:-1] + bytes([body[-1] ^ 1])
            route.fulfill(content_type=mime, body=body, headers={'Access-Control-Allow-Origin':'*'})

        self.context.route('**/api/reader-bucket-resource**', serve)
        for extension,prefix in prefixes.items():
            with self.subTest(extension=extension):
                source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urllib.parse.urlencode({'path':prefix+'chapter-manifest.json'})
                self.open(self.reader_url('epub-chapters', url=source))
                self.assertNotIn(prefix+'epub-search-index.json.gz', requests)
                support.open_reader_panel(self.page)
                self.page.locator('#full-search-toggle').click()
                self.page.locator('#full-search-input').fill('needle')
                if extension == 'epub':
                    self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent.includes('索引校验失败')")
                    self.page.locator('#full-search-retry').click()
                self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '66 个结果'")
                self.assertEqual(self.page.locator('.full-search-result').count(), 50)
                self.page.locator('#full-search-page').fill('2')
                self.page.locator('#full-search-page').dispatch_event('change')
                self.page.wait_for_function("() => document.querySelector('.full-search-rank')?.textContent === '51.'")
                self.assertEqual(self.page.locator('.full-search-result').count(), 16)
                self.page.locator('.full-search-result').last.click()
                self.page.wait_for_function("() => document.querySelector('.reader-epub-chapter[data-chapter=\"2\"] mark.full-search-highlight')?.textContent === 'needle'")
                self.assertEqual(requests.count(prefix+'epub-search-index.json.gz'), 2 if extension == 'epub' else 1)
                if extension == 'fb2':
                    support.open_reader_panel(self.page)
                    self.page.locator('#full-search-input').fill('Cover')
                    self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
                    self.page.locator('.full-search-result').first.click()
                    self.page.locator('.reader-chapter-search-heading mark').wait_for()
                    self.assertEqual(self.page.locator('.reader-chapter-search-heading mark').all_text_contents(), ['Cover'])
                    support.open_reader_panel(self.page)
                    self.page.locator('#full-search-input').fill('needle')
                    self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '66 个结果'")
                    self.page.locator('.full-search-result').first.click()
                    self.page.locator('.reader-epub-chapter[data-chapter="1"] mark').wait_for()
                    self.assertEqual(self.page.locator('.reader-epub-chapter[data-chapter="1"] mark').all_text_contents(), ['needle'])
                    self.assertEqual(self.page.locator('.reader-chapter-search-heading').count(), 0)

    def test_bucket_chapter_stream_loads_manifest_chapter_and_resource(self):
        prefix = "chapters/ebook/epub/" + "c" * 64 + "/" + "b" * 16 + "/"
        chapter = '<html><body><h1>Bucket chapter</h1><img src="../resources/shared/cover.png"></body></html>'
        chapter_path = prefix + "chapters/chapter-0001.xhtml"
        manifest_path = prefix + "chapter-manifest.json"
        resource_path = prefix + "resources/shared/cover.png"
        manifest = {"version": 1, "kind": "epub-chapters", "chapters": [
            {"index": 1, "path": "chapters/chapter-0001.xhtml", "title": "Bucket chapter",
             "bytes": len(chapter.encode()), "sha256": hashlib.sha256(chapter.encode()).hexdigest()}
        ]}
        requested = []
        def serve(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["path"][0]
            requested.append(path)
            if path == manifest_path:
                route.fulfill(content_type="application/json", body=json.dumps(manifest))
            elif path == chapter_path:
                route.fulfill(content_type="application/xhtml+xml", body=chapter)
            elif path == resource_path:
                route.fulfill(content_type="image/png", body=b"not-a-real-png")
            else:
                route.fulfill(status=404, body="missing")
        self.page.route("https://voiceofml-search.hf.space/api/reader-bucket-resource**", serve)
        url = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + urllib.parse.quote(manifest_path, safe="")
        self.open(self.reader_url("epub-chapters", url=url))
        self.assertIn("Bucket chapter", self.page.locator(".reader-epub-chapter").inner_text())
        self.page.wait_for_function("() => document.querySelector('.reader-epub-chapter img')?.src.includes('reader-bucket-resource')")
        self.assertIn(manifest_path, requested)
        self.assertIn(chapter_path, requested)
        self.assertIn(resource_path, requested)

    def test_bucket_chapter_internal_links_keep_reader_navigation(self):
        prefix = "chapters/ebook/epub/" + "d" * 64 + "/" + "c" * 16 + "/"
        bodies = {
            1: '<html><body><a href="chapter-0002.xhtml#target">跨章节目录</a><h1>目录</h1></body></html>',
            2: '<html><body><h1 id="target">目标章节</h1><p style="height:12000px">正文</p></body></html>',
        }
        chapter_paths = {index: prefix + f"chapters/chapter-{index:04d}.xhtml" for index in bodies}
        manifest_path = prefix + "chapter-manifest.json"
        manifest = {"version": 1, "kind": "epub-chapters", "chapters": [
            {"index": index, "path": f"chapters/chapter-{index:04d}.xhtml", "title": f"Chapter {index}",
             "bytes": len(body.encode()), "sha256": hashlib.sha256(body.encode()).hexdigest()}
            for index, body in bodies.items()
        ]}
        requests = []
        def serve(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["path"][0]
            requests.append(path)
            if path == manifest_path:
                route.fulfill(content_type="application/json", body=json.dumps(manifest))
            else:
                index = next((i for i, item in chapter_paths.items() if item == path), None)
                route.fulfill(content_type="application/xhtml+xml", body=bodies[index]) if index else route.fulfill(status=404)
        self.page.route("https://voiceofml-search.hf.space/api/reader-bucket-resource**", serve)
        url = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + urllib.parse.quote(manifest_path, safe="")
        self.open(self.reader_url("epub-chapters", url=url))
        before = self.page.url
        self.page.get_by_text("跨章节目录", exact=True).click()
        self.page.wait_for_function("() => !!document.querySelector('.reader-epub-chapter[data-chapter=\"2\"] #target')")
        self.assertEqual(self.page.url, before)
        self.assertIn(chapter_paths[2], requests)

    def wait_for_store(self, predicate, arg=None):
        self.page.evaluate("""async arg => {
          const check = """ + predicate + """;
          const deadline = performance.now() + 6000;
          while (performance.now() < deadline) {
            if (await check(arg)) return;
            await new Promise(resolve => setTimeout(resolve, 30));
          }
          throw new Error('Store condition did not become true');
        }""", arg)

    def test_chapter_toc_preserves_fragments_depth_and_virtual_current_mark(self):
        base = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/' + 'b' * 64 + '/1234567890abcdef/'
        body = '<h1>第一卷</h1>' + ''.join(f'<h2 id="day-{i}">日记 {i}</h2><p style="height:100px">正文 {i}</p>' for i in range(1100))
        manifest = dict(version=1, kind='epub-chapters',
                        chapters=[dict(index=1, path='chapters/chapter-0001.xhtml', title='文件标题', bytes=len(body.encode()))],
                        toc=[dict(title=f'日记 {i}', chapter=1, fragment=f'day-{i}', depth=1) for i in range(1100)])
        self.page.route('**/api/reader-bucket-resource**', lambda route: route.fulfill(
            content_type='application/json' if 'chapter-manifest.json' in route.request.url else 'text/html',
            body=json.dumps(manifest) if 'chapter-manifest.json' in route.request.url else body))
        self.open(self.reader_url('epub-chapters', url=base + 'chapter-manifest.json'))
        support.open_reader_panel(self.page)
        self.page.locator('#toc-panel').evaluate('node => {node.scrollTop=200*40; node.dispatchEvent(new Event("scroll"));}')
        target = self.page.locator('[data-toc-index="205"]')
        target.wait_for()
        self.assertEqual(target.evaluate('node => node.style.getPropertyValue("--toc-depth")'), '1')
        target.locator('[role="link"]').click()
        self.page.wait_for_function('() => Math.abs(document.querySelector("#day-205").getBoundingClientRect().top-document.querySelector("#viewport").getBoundingClientRect().top)<5')
        support.open_reader_panel(self.page)
        self.assertEqual(self.page.locator('#toc-list .is-current').get_attribute('data-toc-index'), '205')
        self.page.locator('#toc-panel').evaluate('node => {node.scrollTop=0; node.dispatchEvent(new Event("scroll"));}')
        self.page.locator('[data-toc-index="0"]').wait_for()
        self.assertEqual(self.page.locator('#toc-list .is-current').count(), 0)
        self.page.locator('#toc-panel').evaluate('node => {node.scrollTop=200*40; node.dispatchEvent(new Event("scroll"));}')
        self.page.locator('[data-toc-index="205"].is-current').wait_for()

    def serve_chapter_search(self, failure=None):
        base = "chapters/ebook/chm/" + "b" * 64 + "/1234567890abcdef/"
        source = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + base + "chapter-manifest.json"
        chapters, texts, bodies = [], [], {}
        for index in range(1, 13):
            path = f"chapters/chapter-{index:04d}.xhtml"
            title = f"Chapter {index}"
            if index == 12:
                body = ('<html:html xmlns:html="http://www.w3.org/1999/xhtml"><html:head><html:meta/>'
                        '<html:title>标题</html:title></html:head><html:body><p><span>独特</span><em>词语</em></p>'
                        + ''.join(f'<p>第{i}处needle结束</p>' for i in range(155))
                        + '<p>手机 手。机</p></html:body></html:html>')
                text = '标题 独特 词语 ' + ' '.join(f'第{i}处needle结束' for i in range(155)) + ' 手机 手。机'
            else:
                body = f'<h1>{title}</h1><p style="height:12000px">普通正文</p>'
                text = title + ' 普通正文'
            bodies[base + path] = body
            chapters.append(dict(index=index, path=path, title=title, bytes=len(body.encode())))
            texts.append(dict(index=index, path=path, text=text))
        packed = gzip.compress(json.dumps(dict(version=1, kind='epub-search-index', chapters=texts), ensure_ascii=False).encode(), mtime=0)
        manifest = dict(version=1, kind='epub-chapters', chapters=chapters,
                        search_index=dict(path='epub-search-index.json.gz', bytes=len(packed), sha256=hashlib.sha256(packed).hexdigest()))
        requests = []
        def serve(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)['path'][0]
            requests.append(path)
            if path.endswith('chapter-manifest.json'):
                route.fulfill(content_type='application/json', body=json.dumps(manifest),
                              headers={'Access-Control-Allow-Origin': '*'})
            elif path.endswith('epub-search-index.json.gz'):
                attempt = sum(item.endswith('epub-search-index.json.gz') for item in requests)
                if not failure or not failure(route, attempt, packed):
                    route.fulfill(content_type='application/gzip', body=packed,
                                  headers={'Access-Control-Allow-Origin': '*'})
            else:
                route.fulfill(content_type='text/html', body=bodies[path],
                              headers={'Access-Control-Allow-Origin': '*'})
        self.page.route('**/api/reader-bucket-resource**', serve)
        self.open(self.reader_url('epub-chapters', url=source))
        return requests, base

    def test_chapter_search_emits_partial_results_before_exact_total(self):
        self.serve_chapter_search()
        support.open_reader_panel(self.page)
        self.page.locator("#full-search-toggle").click()
        self.page.evaluate("""() => {
          window.__chapterStatuses = [];
          new MutationObserver(() => __chapterStatuses.push(document.querySelector('#full-search-status').textContent))
            .observe(document.querySelector('#full-search-status'), { childList: true, subtree: true });
        }""")
        self.page.locator("#full-search-input").fill("needle")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '155 个结果'")
        self.assertTrue(any("155 个结果（正在搜索" in status for status in
                            self.page.evaluate("window.__chapterStatuses")))

    def test_chapter_search_lazy_complete_pages_and_unloaded_highlight(self):
        requests, base = self.serve_chapter_search()
        self.assertFalse(any('epub-search-index' in url for url in requests))
        self.search('needle')
        self.assertEqual(self.page.locator('#full-search-status').text_content(), '155 个结果')
        self.assertEqual(self.page.locator('.full-search-result').count(), 50)
        self.assertTrue(self.page.locator('#full-search-cancel').is_hidden())
        self.page.evaluate("""() => {
          window.__cancelPagingChanges = [];
          const cancel = document.querySelector('#full-search-cancel');
          new MutationObserver(() => {
            __cancelPagingChanges.push(cancel.hidden);
          }).observe(document.querySelector('#full-search-cancel'), {
            attributes: true, attributeFilter: ['hidden']
          });
        }""")
        self.assertNotIn(base + 'chapters/chapter-0012.xhtml', requests)
        field = self.page.locator('#full-search-page')
        field.fill('4')
        field.press('Enter')
        field.blur()
        self.page.wait_for_function("() => document.querySelectorAll('.full-search-result').length === 5")
        self.assertTrue(self.page.locator('#full-search-cancel').is_hidden())
        self.assertNotIn(False, self.page.evaluate("__cancelPagingChanges"))
        self.page.locator('.full-search-result').last.click()
        self.page.wait_for_function("() => document.querySelector('.reader-epub-chapter mark')?.parentElement.textContent === '第154处needle结束'")
        support.open_reader_panel(self.page)
        self.assertFalse(self.page.locator('#full-search-view').is_hidden())
        self.page.locator('#full-search-input').fill('独特 词语')
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.page.locator('.full-search-result').click()
        self.page.wait_for_function("() => document.querySelectorAll('.reader-epub-chapter mark.full-search-highlight').length === 2")
        self.assertEqual(self.page.locator('.reader-epub-chapter mark').all_text_contents(), ['独特', '词语'])
        self.assertEqual(sum('epub-search-index' in url for url in requests), 1)

    def test_failed_chapter_page_restarts_worker_and_restores_target_page(self):
        def expose_worker_failure(route):
            response = route.fetch()
            needle = 'worker.postMessage({ type: "init", configuration });'
            script = response.text()
            self.assertIn(needle, script)
            route.fulfill(response=response, body=script.replace(needle,
                "window.__breakChapterWorker = () => worker.onerror({ preventDefault() {} }); " + needle))
        self.page.route("**/static/reader/search/reader-chapter-search.mjs*", expose_worker_failure)
        self.serve_chapter_search()
        self.search("needle")
        self.page.evaluate("window.__breakChapterWorker()")
        self.page.locator("#full-search-page").fill("3")
        self.page.locator("#full-search-page").dispatch_event("change")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent.includes('全文搜索组件加载失败')")
        self.page.locator("#full-search-retry").click()
        self.page.wait_for_function("() => document.querySelector('.full-search-rank')?.textContent === '101.'")
        self.assertEqual(self.page.locator("#full-search-page").input_value(), "3")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "155 个结果")

    def test_chapter_search_retry_and_corrupt_index(self):
        def failure(route, attempt, packed):
            if attempt == 1:
                route.fulfill(status=503, body='unavailable')
                return True
            if attempt == 2:
                route.fulfill(body=packed[:-1] + bytes([packed[-1] ^ 1]))
                return True
        self.serve_chapter_search(failure)
        support.open_reader_panel(self.page)
        self.page.locator('#full-search-toggle').click()
        self.page.locator('#full-search-input').fill('needle')
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent.includes('503')")
        self.page.locator('#full-search-retry').click()
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent.includes('校验失败')")
        self.page.locator('#full-search-retry').click()
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '155 个结果'")

    def test_chapter_search_cancel_cannot_publish_stale_results(self):
        held = []
        def hold(route, attempt, packed):
            if attempt == 1:
                held.append((route, packed))
                return True
        requests, _ = self.serve_chapter_search(hold)
        support.open_reader_panel(self.page)
        self.page.locator('#full-search-toggle').click()
        with self.context.expect_event('request', predicate=lambda request: 'epub-search-index' in request.url):
            self.page.locator('#full-search-input').fill('needle')
        self.page.locator('#full-search-cancel').click()
        self.page.locator('#full-search-input').fill('手机')
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        for route, packed in held:
            route.fulfill(content_type='application/gzip', body=packed)
        self.assertEqual(self.page.locator('.full-search-result').count(), 1)
        self.assertEqual(sum('epub-search-index' in url for url in requests), 2)

    def test_failed_chapter_restoration_preserves_saved_position(self):
        requests, base = self.serve_chapter_search()
        source = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + base + "chapter-manifest.json"
        self.page.evaluate("""async source => {
          window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:false}));
          await new Promise(resolve => setTimeout(resolve, 0));
          await VoiceOfMLReaderStore.put({url:source, title:'Saved chapter',
            chapterIndex:12, chapterOffset:345, lastReadAt:Date.now()+1});
        }""", source)
        self.page.route("**/api/reader-bucket-resource?path=*chapter-0012.xhtml",
                        lambda route: route.fulfill(status=503, body="temporary"))
        self.page.reload()
        self.page.wait_for_timeout(1200)
        saved = self.page.evaluate("source => VoiceOfMLReaderStore.get(source)", source)
        self.assertEqual(saved["chapterIndex"], 12)
        self.assertEqual(saved["chapterOffset"], 345)
        self.assertEqual(self.page.locator("#content").get_attribute("data-error-code"), "READER_RESTORE")
        self.assertTrue(self.page.get_by_role("button", name="重试加载").is_visible())
        self.page.unroute("**/api/reader-bucket-resource?path=*chapter-0012.xhtml")
        self.page.get_by_role("button", name="重试加载").click()
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.wait_for_store("async source => (await VoiceOfMLReaderStore.get(source))?.chapterIndex === 12", source)
        offset = self.page.locator('.reader-epub-chapter[data-chapter="12"]').evaluate(
            "node => document.querySelector('#viewport').getBoundingClientRect().top + 8 - node.getBoundingClientRect().top")
        self.assertAlmostEqual(offset, 345, delta=3)

    def test_chapter_manifest_does_not_translate_foliate_positions(self):
        _, base = self.serve_chapter_search()
        source = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + base + "chapter-manifest.json"
        self.page.evaluate("""async source => {
          window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:false}));
          await new Promise(resolve => setTimeout(resolve, 0));
          await VoiceOfMLReaderStore.put({url:source, title:'Old EPUB position',
            foliateSection:10, foliateOffset:275, lastReadAt:Date.now()+1});
        }""", source)
        self.page.reload()
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.wait_for_store("async source => (await VoiceOfMLReaderStore.get(source))?.chapterIndex === 1", source)

    def test_parent_abort_saves_last_position_before_disposal(self):
        self.serve("reading\n" * 3000)
        self.open(self.reader_url())
        self.page.wait_for_timeout(650)
        self.page.evaluate("""() => {
          const viewport=document.querySelector('#viewport');
          viewport.scrollTop=900;viewport.dispatchEvent(new Event('scroll'));
          window.dispatchEvent(new MessageEvent('message', {origin:location.origin,
            source:window.parent,data:{type:'voice-reader-abort'}}));
        }""")
        source = urllib.parse.parse_qs(urllib.parse.urlsplit(self.page.url).query)["url"][0]
        self.page.wait_for_timeout(100)
        saved = self.page.evaluate("source => VoiceOfMLReaderStore.get(source)", source)
        self.assertEqual(saved["scrollTop"], 900)

    def test_store_lists_preserve_limits_order_and_reject_noncurrent_records(self):
        self.page.goto(self.reader_url().split('?')[0])
        result = self.page.evaluate('''async () => {
          const store=VoiceOfMLReaderStore;
          await store.put({url:'book-a',lastReadAt:10});
          await store.put({url:'book-b',lastReadAt:20});
          await store.put({url:'book-c',lastReadAt:30});
          await store.put({url:'book-c',lastReadAt:1});
          const db=await new Promise((resolve,reject)=>{
            const request=indexedDB.open(store.DB_NAME,store.DB_VERSION);
            request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
          });
          await new Promise((resolve,reject)=>{
            const tx=db.transaction('bookmarks','readwrite'), bookmarks=tx.objectStore('bookmarks');
            for(const entry of [
              {id:'z',url:'book-a',createdAt:1,schemaVersion:1}, {id:'a',url:'book-a',createdAt:3,schemaVersion:1},
              {id:'b',url:'book-b',createdAt:2,schemaVersion:1}, {id:'bad',url:42,createdAt:4},
              {id:'legacy',url:'book-a',createdAt:6},
              {id:'future',url:'book-a',createdAt:5,schemaVersion:2}
            ]) bookmarks.put(entry);
            tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
          });
          const history=(await store.list(2)).map(entry=>entry.url);
          const empty=(await store.list(0)).length;
          const all=(await store.listAllBookmarks()).map(entry=>entry.id);
          const one=(await store.listBookmarks('book-a')).map(entry=>entry.id);
          const raw=await new Promise((resolve,reject)=>{
            const tx=db.transaction('bookmarks'), request=tx.objectStore('bookmarks').getAll();
            tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);
          });
          db.close();await store.removeBookmark('a');
          return {history,empty,all,one,remaining:(await store.listBookmarks('book-a')).map(entry=>entry.id),
            current:raw.every(entry=>entry.schemaVersion===1),
            legacy:raw.some(entry=>entry.id==='legacy'),
            corruptRemoved:!raw.some(entry=>entry.id==='bad')};
        }''')
        self.assertEqual(result, dict(history=['book-c', 'book-b'], empty=0, all=['a', 'b', 'z'],
                                      one=['a', 'z'], remaining=['z'], current=True, legacy=False, corruptRemoved=True))

    def test_cross_book_bookmark_restores_selected_position_and_rejects_mismatch(self):
        self.serve("start\n" + "ordinary text\n" * 3000)
        book_b = self.reader_url(name="book-b")
        source_b = urllib.parse.parse_qs(urllib.parse.urlsplit(book_b).query)["url"][0]
        self.open(book_b)
        self.page.evaluate("""async ({url, readerUrl}) => {
          await VoiceOfMLReaderStore.putBookmark({id:'selected-bookmark', url, readerUrl,
            title:'Book B', label:'Selected passage', scrollTop:900, createdAt:1});
          await VoiceOfMLReaderStore.put({url, readerUrl, title:'Book B', scrollTop:2500, lastReadAt:Date.now()});
        }""", {"url": source_b, "readerUrl": book_b})
        self.open(self.reader_url(name="book-a"))
        # Override any pagehide save from the old B page before opening its bookmark.
        self.page.evaluate("""async url => VoiceOfMLReaderStore.put({url, title:'Book B',
          scrollTop:2500, lastReadAt:Date.now()+1})""", source_b)
        self.page.locator("#history").click()
        self.page.locator("#bookmarks-tab").click()
        self.page.locator("#bookmarks-all").click()
        self.page.locator("#bookmarks-list .panel-item-main", has_text="Selected passage").click()
        self.page.wait_for_url(book_b)
        self.page.wait_for_function("() => Math.abs(document.querySelector('#viewport').scrollTop - 900) < 2")
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.page.evaluate("""() => { document.querySelector('#viewport').scrollTop = 2500;
          document.dispatchEvent(new Event('visibilitychange')); }""")
        self.page.wait_for_timeout(650)
        self.page.reload()
        self.page.wait_for_function("() => Math.abs(document.querySelector('#viewport').scrollTop - 2500) < 2")
        self.open(self.reader_url(name="book-a"))
        self.page.locator("#history").click()
        self.page.locator("#bookmarks-tab").click()
        self.page.locator("#bookmarks-all").click()
        self.page.locator("#bookmarks-list .panel-item-main", has_text="Selected passage").click()
        self.page.wait_for_url(book_b)
        self.page.wait_for_function("() => Math.abs(document.querySelector('#viewport').scrollTop - 900) < 2")
        self.page.locator("#viewport").evaluate("node => { node.scrollTop = 2500; node.dispatchEvent(new Event('scroll')); }")
        self.page.wait_for_timeout(650)
        invalid = book_b + "&bookmark=selected-bookmark&bookmark_source=wrong-source"
        self.open(invalid)
        self.page.wait_for_function("() => Math.abs(document.querySelector('#viewport').scrollTop - 2500) < 2")
        saved = self.page.evaluate("url => VoiceOfMLReaderStore.get(url)", source_b)
        self.assertNotIn("bookmark=", saved["readerUrl"])

    def test_overlay_bookmark_consumes_parent_navigation_records_and_reloads_history(self):
        self.serve("reading\n" * 3000)
        book = self.reader_url(name="overlay-book")
        source = urllib.parse.parse_qs(urllib.parse.urlsplit(book).query)["url"][0]
        self.open(book)
        self.page.evaluate("""async ({source, book}) => {
          await VoiceOfMLReaderStore.putBookmark({id:'overlay-bookmark', url:source,
            readerUrl:book, label:'Overlay', scrollTop:900, createdAt:1});
        }""", {"source": source, "book": book})
        handoff = book + "&" + urllib.parse.urlencode({
            "bookmark": "overlay-bookmark", "bookmark_source": source,
            "return": self.origin + "/search/#/Test?q=retained", "nav": "return-token"
        })
        shell = """<!doctype html><body><script>
          window.openReader = readerUrl => {
            const share = new URL(readerUrl); share.searchParams.delete('return'); share.searchParams.delete('nav');
            history.replaceState({voiceReaderOverlay:true, readerUrl, extra:'keep'}, '', share.href);
            sessionStorage.setItem('reader-navigation-current', JSON.stringify({readerUrl, shareUrl:share.href,
              returnScroll:{top:123}, extra:'keep'}));
            document.querySelector('iframe')?.remove();
            const frame = document.createElement('iframe'); frame.className='reader-overlay';
            frame.style='width:100%;height:750px'; frame.src=readerUrl; document.body.append(frame);
          };
          openReader(history.state?.readerUrl || JSON.parse(sessionStorage.getItem('reader-navigation-current') || 'null')?.readerUrl || HANDOFF);
        </script>""".replace("HANDOFF", json.dumps(handoff))
        def overlay(route):
            if route.request.is_navigation_request() and route.request.frame == self.page.main_frame:
                route.fulfill(content_type="text/html", body=shell)
            else:
                route.fallback()
        self.page.route("**/static/reader.html?**", overlay)
        self.page.goto(handoff)
        frame = self.page.frame_locator("iframe.reader-overlay")
        frame.locator("#viewport").evaluate("node => node.scrollTop")
        self.page.wait_for_function("() => !new URL(location.href).searchParams.has('bookmark')")
        state = self.page.evaluate("({state:history.state, saved:JSON.parse(sessionStorage.getItem('reader-navigation-current'))})")
        self.assertNotIn("bookmark=", state["state"]["readerUrl"])
        self.assertNotIn("bookmark=", state["saved"]["readerUrl"])
        self.assertNotIn("bookmark=", state["saved"]["shareUrl"])
        self.assertEqual(state["state"]["extra"], "keep")
        self.assertEqual(state["saved"]["returnScroll"], {"top": 123})
        self.assertIn("nav=return-token", state["state"]["readerUrl"])
        self.assertEqual(frame.locator("#viewport").evaluate("node => node.scrollTop"), 900)
        frame.locator("#viewport").evaluate("node => {node.scrollTop=2500; node.dispatchEvent(new Event('scroll'));}")
        self.wait_for_store("async source => (await document.querySelector('iframe').contentWindow.VoiceOfMLReaderStore.get(source))?.scrollTop === 2500", source)
        for session_only in (False, True):
            if session_only:
                self.page.evaluate("history.replaceState(null, '', location.href)")
            self.page.reload()
            self.page.wait_for_function("() => document.querySelector('iframe')?.contentDocument?.querySelector('#viewport')?.scrollTop === 2500")
        self.page.evaluate("url => openReader(url)", handoff)
        self.page.wait_for_function("() => document.querySelector('iframe')?.contentDocument?.querySelector('#viewport')?.scrollTop === 900 && !new URL(location.href).searchParams.has('bookmark')")

    def test_remote_history_deletion_blocks_queued_and_future_saves_until_reopen(self):
        self.serve("reading\n" * 3000)
        url = self.reader_url(name="remote-history")
        source = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["url"][0]
        peer = self.context.new_page()
        store_path = urllib.parse.urlsplit(url).path.replace("reader.html", "reader/core/reader-store.js")
        peer.route("**/store-peer", lambda route: route.fulfill(content_type="text/html", body=f'<script src="{store_path}"></script>'))
        peer.goto(self.origin + "/store-peer")
        for event_type in ("history-remove", "history-clear"):
            with self.subTest(event_type=event_type):
                self.open(url)
                self.wait_for_store("async source => !!(await VoiceOfMLReaderStore.get(source))", source)
                self.page.evaluate("""() => {
                  const store=VoiceOfMLReaderStore; window.__writes=0; window.__changes=[];
                  store.subscribe(change => { if(change.remote) window.__changes.push(change.type); });
                  window.VoiceOfMLReaderStore={...store, put:async entry => {
                    ++window.__writes; await store.put(entry);
                    if(window.__writes===1) await new Promise(resolve => window.__releaseWrite=resolve);
                  }};
                  document.querySelector('#viewport').scrollTop=900;
                }""")
                self.page.wait_for_function("() => !!window.__releaseWrite")
                self.page.locator("#viewport").evaluate("node => {node.scrollTop=1500; node.dispatchEvent(new Event('scroll'));}")
                self.page.wait_for_timeout(650)
                await_event = {"type": event_type, "source": source}
                peer.evaluate("async ({type,source}) => type==='history-clear' ? VoiceOfMLReaderStore.clearHistory() : VoiceOfMLReaderStore.remove(source)", await_event)
                self.page.wait_for_function("type => window.__changes.includes(type)", arg=event_type)
                self.page.evaluate("window.__releaseWrite()")
                self.page.locator("#viewport").evaluate("node => {node.scrollTop=2200; node.dispatchEvent(new Event('scroll'));}")
                self.page.wait_for_timeout(750)
                self.assertEqual(self.page.evaluate("window.__writes"), 1)
                self.assertIsNone(peer.evaluate("source => VoiceOfMLReaderStore.get(source)", source))
                self.page.reload()
                # Wait for startup separately, as open() does, so a slow reload
                # cannot consume the window for the reopened Reader's save.
                self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
                self.wait_for_store("async source => !!(await VoiceOfMLReaderStore.get(source))", source)
        peer.close()

    def test_bookmark_cleanup_preserves_unrelated_parent_and_session_navigation(self):
        self.serve("reading\n" * 3000)
        book = self.reader_url(name="cleanup-target")
        source = urllib.parse.parse_qs(urllib.parse.urlsplit(book).query)["url"][0]
        self.open(book)
        self.page.evaluate("async ({source,book}) => VoiceOfMLReaderStore.putBookmark({id:'cleanup-mark',url:source,readerUrl:book,label:'Target',scrollTop:900,createdAt:1})", {"source": source, "book": book})
        handoff = book + "&" + urllib.parse.urlencode({"bookmark": "cleanup-mark", "bookmark_source": source})
        unrelated = self.reader_url(name="different", bookmark="other", bookmark_source="other")
        record = {"readerUrl": unrelated, "shareUrl": unrelated, "extra": "preserve"}
        shell = """<!doctype html><body><script>
          history.replaceState({voiceReaderOverlay:true, readerUrl:OTHER}, '', OTHER);
          sessionStorage.setItem('reader-navigation-current', JSON.stringify(RECORD));
          const frame=document.createElement('iframe'); frame.className='reader-overlay';
          frame.style='height:750px;width:100%'; frame.src=HANDOFF; document.body.append(frame);
        </script>""".replace("OTHER", json.dumps(unrelated)).replace("RECORD", json.dumps(record)).replace("HANDOFF", json.dumps(handoff))
        self.page.route("**/unrelated-overlay", lambda route: route.fulfill(content_type="text/html", body=shell))
        self.page.goto(self.origin + "/unrelated-overlay")
        self.page.wait_for_function("() => {const w=document.querySelector('iframe')?.contentWindow; return w?.document.querySelector('#viewport')?.scrollTop===900 && !new URL(w.location.href).searchParams.has('bookmark');}")
        self.assertEqual(self.page.url, unrelated)
        self.assertEqual(self.page.evaluate("history.state.readerUrl"), unrelated)
        self.assertEqual(self.page.evaluate("JSON.parse(sessionStorage.getItem('reader-navigation-current'))"), record)

    def test_remote_unrelated_history_removal_does_not_suppress_current_media(self):
        self.serve(support.minimal_wav(), "audio/wav")
        self.open(self.reader_url("wav", name="remote-media"))
        self.page.wait_for_function("() => document.querySelector('audio').readyState >= 1")
        self.page.evaluate("""() => {
          window.__changes=[]; VoiceOfMLReaderStore.subscribe(change => {if(change.remote) window.__changes.push(change.type);});
          const media=document.querySelector('audio');
          Object.defineProperty(media,'currentTime',{value:45,writable:true});
        }""")
        peer = self.context.new_page()
        peer.goto(self.origin + "/search/static/reader.html?ext=unsupported")
        peer.evaluate("() => VoiceOfMLReaderStore.remove('unrelated')")
        self.page.wait_for_function("() => window.__changes.includes('history-remove')")
        self.page.locator("audio").evaluate("media => media.dispatchEvent(new Event('timeupdate'))")
        self.wait_for_store("async () => (await VoiceOfMLReaderStore.get(new URL(location.href).searchParams.get('url')))?.mediaTime===45")
        peer.evaluate("() => VoiceOfMLReaderStore.clearHistory()")
        self.page.wait_for_function("() => window.__changes.includes('history-clear')")
        self.page.locator("audio").evaluate("media => {media.currentTime=60; for(const type of ['timeupdate','pause','seeked']) media.dispatchEvent(new Event(type));}")
        self.page.wait_for_timeout(750)
        self.assertIsNone(self.page.evaluate("() => VoiceOfMLReaderStore.get(new URL(location.href).searchParams.get('url'))"))
        peer.close()

    def test_search_reopen_retains_live_targets(self):
        self.serve("prefix\n" * 500 + "needle" + "\nending" * 500)
        self.open(self.reader_url())
        self.search("needle")
        self.page.locator("#full-search-toggle").click()
        self.assertEqual(self.page.locator("#content .full-search-highlight").count(), 1)
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-results .full-search-result").click()
        self.page.wait_for_function("() => document.querySelector('#viewport').scrollTop > 1000")
        self.assertEqual(self.page.locator("#content .full-search-highlight").text_content(), "needle")

    def test_search_reopen_keeps_results_and_clear_control_state(self):
        self.serve("begin " + "middle " * 400 + "needle at the end")
        self.open(self.reader_url())
        self.page.locator("#history").click()
        self.assertTrue(self.page.locator("#full-search-clear").is_hidden())
        self.page.locator("#full-search-toggle").click()
        self.assertEqual(self.page.locator("#full-search-toggle").text_content(), "关闭全文搜索")
        self.page.locator("#full-search-input").fill("needle")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.assertEqual(self.page.locator(".full-search-rank").text_content(), "1.")
        self.assertIn("正文 ", self.page.locator(".full-search-location").text_content())
        self.assertTrue(self.page.locator("#full-search-clear").is_visible())
        self.page.locator(".full-search-result").click()
        self.page.locator("#history").click()
        self.assertFalse(self.page.locator("#full-search-view").is_hidden())
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "1 个结果")
        self.page.locator("#full-search-toggle").click()
        self.assertEqual(self.page.locator("#full-search-toggle").text_content(), "全文搜索")
        self.page.locator("#full-search-toggle").click()
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "1 个结果")
        self.page.locator("#full-search-clear").click()
        self.assertTrue(self.page.locator("#full-search-clear").is_hidden())

    def test_top_level_reader_adds_no_history_guard_and_system_back_leaves(self):
        # A standalone Reader (e.g. a restored tab) must not push a guard entry:
        # Chromium marks entries created without a user activation as skippable.
        self.serve("needle " * 300)
        url = self.reader_url()
        self.page.goto("about:blank")
        before = self.page.evaluate("history.length")
        self.page.goto(url)
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.assertEqual(self.page.evaluate("history.length"), before + 1)
        self.assertFalse(self.page.evaluate("!!history.state?.voiceReaderGuard"))
        self.page.locator("#history").click()
        self.page.wait_for_function("() => document.querySelector('#history-panel').classList.contains('is-open')")
        self.page.go_back()
        self.assertEqual(self.page.url, "about:blank")

    def test_txt_small_chunks_reuse_preview_decoder_and_visit_samples_once(self):
        def instrument(route):
            response = route.fetch()
            script = response.text()
            needle = 'for (const chunk of sampleChunks) {'
            self.assertIn(needle, script)
            route.fulfill(response=response, body=script.replace(needle,
                needle + ' window.__sampleVisits = (window.__sampleVisits || 0) + 1;'))
        self.page.route('**/static/reader/formats/reader-text-format.mjs*', instrument)
        self.page.add_init_script('''const nativeFetch = window.fetch.bind(window), Decoder = window.TextDecoder;
          window.__previewDecoders = 0;
          window.TextDecoder = class extends Decoder {
            constructor(label, ...args) { super(label, ...args); if (!label || label === 'utf-8') window.__previewDecoders++; }
          };
          window.fetch = (url, init) => String(url).includes('/api/reader-content?')
            ? Promise.resolve(new Response(new ReadableStream({start(controller) {
                controller.enqueue(new TextEncoder().encode('h'));
                controller.enqueue(new TextEncoder().encode('ea'));
                controller.enqueue(new TextEncoder().encode('d'));
                window.__finishChunks = () => {
                  for (let i = 0; i < 600; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
                  for (const byte of new TextEncoder().encode('\\n\u4e2d\u6587')) controller.enqueue(new Uint8Array([byte]));
                  controller.close();
                };
              }}), {headers:{'Content-Type':'text/plain'}})) : nativeFetch(url, init);''')
        self.page.goto(self.reader_url(), wait_until='domcontentloaded')
        self.page.locator('.reader-text').filter(has_text='head').wait_for()
        self.assertEqual(self.page.locator('.reader-text').text_content(), 'head')
        self.search('head')
        self.page.evaluate('window.__finishChunks()')
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.assertEqual(self.page.locator('.reader-text').text_content(), 'head' + 'x' * 38400 + '\n中文')
        self.assertLessEqual(self.page.evaluate('window.__sampleVisits'), 1220)
        self.assertLessEqual(self.page.evaluate('window.__previewDecoders'), 5)

    def test_txt_preview_cursor_preserves_split_legacy_encodings(self):
        self.page.add_init_script('''const nativeFetch = window.fetch.bind(window);
          window.fetch = (url, init) => String(url).includes('/api/reader-content?')
            ? Promise.resolve(new Response(new ReadableStream({start(controller) {
                const bytes = new Uint8Array(JSON.parse(new URL(location.href).searchParams.get('test_bytes')));
                for (const byte of bytes.slice(0, 4)) controller.enqueue(new Uint8Array([byte]));
                window.__finishLegacy = () => {
                  for (const byte of bytes.slice(4)) controller.enqueue(new Uint8Array([byte]));
                  controller.close();
                };
              }}))) : nativeFetch(url, init);''')
        cases = [('丠丠ABCD', 'utf-16le', 'Encoding'), ('中文文本', 'utf-16', 'Encoding'),
                 ('中文文本', 'utf-16be', 'Encoding'), ('head中文文本', 'gb18030', '中文'),
                 ('Русский текст', 'cp1251', 'Русский'), ('head中文', 'utf-8-sig', 'Encoding')]
        for text, encoding, title in cases:
            with self.subTest(encoding=encoding):
                encoded = text.encode(encoding)
                if encoding == 'utf-16be':
                    encoded = b'\xfe\xff' + encoded
                self.page.goto(self.reader_url(title=title, test_bytes=json.dumps(list(encoded))), wait_until='domcontentloaded')
                self.page.wait_for_function('() => !!window.__finishLegacy')
                if encoding == 'utf-16le':
                    self.page.wait_for_function("() => document.querySelector('.reader-text')?.textContent === ' N N'")
                self.page.evaluate('window.__finishLegacy()')
                self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
                self.assertEqual(self.page.locator('.reader-text').text_content(), text)

    def expose_toc_probe(self):
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + '''
              window.__startTocProbe = () => {
                const sourceSections = [{linear:'yes'}, {linear:'no'}, {linear:'yes'}];
                const visibleSections = [sourceSections[0], sourceSections[2], sourceSections[0]];
                const probe = window.__tocProbe = {calls:0, active:0, peak:0, scans:0, held:[]};
                visibleSections.indexOf = section => {probe.scans++; return Array.prototype.indexOf.call(visibleSections, section);};
                let hold = true;
                const children = Array.from({length:85}, (_, n) => ({label:'Chapter ' + n, href:'chapter-' + n + '#anchor%20' + n}));
                children.push({label:'Invalid', href:'invalid'});
                const view = {book:{sections:sourceSections, toc:[{label:'Volume', subitems:children}],
                  async resolveHref(href) {
                    probe.calls++; probe.active++; probe.peak = Math.max(probe.peak, probe.active);
                    try {
                      if (hold) await new Promise(resolve => probe.held.push(resolve));
                      if (probe.busy) {
                        const deadline = performance.now() + 1;
                        while (performance.now() < deadline) {}
                      }
                      if (href === 'invalid') throw Error('bad href');
                      const number = Number(href.match(/chapter-(\\d+)/)[1]);
                      return {index:number % 3, anchor:() => number};
                    } finally {probe.active--;}
                  }}, goTo(href) {probe.navigation = href;}};
                probe.release = () => {hold = false; for (const resolve of probe.held.splice(0)) resolve();};
                probe.promise = foliateTocEntries(view, visibleSections).then(entries => {
                  entries.find(e => e.href === 'chapter-84#anchor%2084').activate();
                  probe.entries = entries.map(e => ({label:e.label, section:e.sectionIndex, fragment:e.fragment,
                    anchor:typeof e.anchor === 'function' ? e.anchor() : null}));
                }, error => {probe.error = error.name;});
              };
            ''')
        self.page.route('**/static/reader.js*', instrument)
        self.serve('TOC probe')
        self.open(self.reader_url())
        self.page.evaluate('window.__startTocProbe()')

    def test_foliate_toc_bounds_resolution_and_keeps_every_entry_in_order(self):
        self.expose_toc_probe()
        self.page.wait_for_function('() => window.__tocProbe.calls >= 8')
        self.assertEqual(self.page.evaluate('__tocProbe.calls'), 8)
        self.page.evaluate('''__tocProbe.busy = true; __tocProbe.ticks = [];
          const timer = setInterval(() => __tocProbe.ticks.push(__tocProbe.calls), 0);
          __tocProbe.promise.finally(() => clearInterval(timer)); __tocProbe.release();''')
        self.page.evaluate('__tocProbe.promise')
        entries = self.page.evaluate('__tocProbe.entries')
        self.assertEqual(entries[:-1], [dict(label=f'Chapter {n}', section=(0, -1, 1)[n % 3],
                                           fragment=f'anchor {n}', anchor=n) for n in range(85)])
        self.assertEqual(entries[-1], {'label':'Invalid', 'section':-1, 'fragment':'', 'anchor':None})
        self.assertEqual(self.page.evaluate('[__tocProbe.peak, __tocProbe.scans, __tocProbe.calls]'), [8, 0, 86])
        self.assertGreaterEqual(len(self.page.evaluate('__tocProbe.ticks')), 2)
        self.assertEqual(self.page.evaluate('__tocProbe.navigation'), 'chapter-84#anchor%2084')

    def test_foliate_toc_disposal_stops_queued_resolution_and_late_publication(self):
        self.expose_toc_probe()
        self.page.wait_for_function('() => window.__tocProbe.calls >= 8')
        self.page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        self.page.wait_for_function("() => window.__tocProbe.error === 'AbortError'")
        self.assertEqual(self.page.evaluate('__tocProbe.calls'), 8)
        self.page.evaluate('__tocProbe.release()')
        self.page.wait_for_function('() => __tocProbe.active === 0')
        self.assertFalse(self.page.evaluate('!!__tocProbe.entries'))
        self.assertEqual(self.page.evaluate('__tocProbe.calls'), 8)

    def test_text_search_publishes_partial_results_before_full_scan(self):
        self.page.add_init_script("""const native = window.setTimeout.bind(window);
          window.setTimeout = (fn, ms, ...args) => native(fn, ms === 0 ? 20 : ms, ...args);""")
        self.serve("needle " + "x" * 600000 + " needle")
        self.open(self.reader_url())
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("needle")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent.includes('正在搜索') && document.querySelectorAll('.full-search-result').length === 1")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '2 个结果'")
        self.assertEqual(self.page.locator(".full-search-rank").all_text_contents(), ["1.", "2."])

    def test_typing_new_full_search_disables_old_navigation_immediately(self):
        self.serve("oldword " * 65 + "freshword")
        self.open(self.reader_url())
        self.search("oldword")
        self.assertEqual(self.page.locator("#full-search-status").text_content(), "65 个结果")
        self.assertTrue(self.page.locator(".full-search-pagination").is_visible())
        self.page.locator("#full-search-input").fill("freshword")
        self.assertEqual(self.page.locator(".full-search-result").count(), 0)
        self.assertTrue(self.page.locator(".full-search-pagination").is_hidden())
        self.assertTrue(self.page.locator("#full-search-next").is_disabled())
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")

    def test_disposal_cancels_debounced_full_search(self):
        self.page.add_init_script("""const nativeTimeout = window.setTimeout.bind(window);
          window.__searchDebounceCallbacks = 0;
          window.setTimeout = (callback, delay, ...args) => nativeTimeout(
            delay === 180 ? (...values) => {
              window.__searchDebounceCallbacks++;
              callback(...values);
            } : callback, delay, ...args);""")
        self.serve("needle " * 100)
        self.open(self.reader_url())
        self.page.evaluate("""() => {
          const input = document.querySelector('#full-search-input');
          input.value = 'needle';
          input.dispatchEvent(new Event('input', {bubbles: true}));
          window.dispatchEvent(new Event('voice-reader-dispose'));
        }""")
        self.page.wait_for_timeout(300)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'disposed')
        self.assertEqual(self.page.evaluate('window.__searchDebounceCallbacks'), 0)
        self.assertEqual(self.page.locator('.full-search-result').count(), 0)

    def test_pending_text_result_cannot_highlight_after_new_search(self):
        def hold_activation(route):
            response = route.fetch()
            needle = "let currentNodes = await fullSearchTextNodes(root, searchGeneration, end, checkpoint);"
            script = response.text()
            self.assertIn(needle, script)
            route.fulfill(response=response, body=script.replace(needle,
                "await new Promise(resolve => { window.__releaseActivation = resolve; }); " +
                needle + " window.__activationSettled = true;"))
        self.page.route("**/static/reader/search/reader-dom-search.mjs*", hold_activation)
        self.serve("oldword " * 70 + "freshword")
        self.open(self.reader_url())
        self.search("oldword")
        self.page.locator(".full-search-result").first.click()
        self.page.wait_for_function("() => !!window.__releaseActivation")
        self.page.locator("#full-search-input").fill("freshword")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.page.evaluate("window.__releaseActivation()")
        self.page.wait_for_function("() => window.__activationSettled")
        self.assertEqual(self.page.locator("#content mark.full-search-highlight").all_text_contents(), ["freshword"])

    def test_dom_search_navigation_only_walks_through_selected_match(self):
        html = '<p>before <span>nee</span><b>dl</b><i>e</i> after</p>' + '<p>ordinary</p>' * 8000 + '<p>last <span>nee</span><b>dl</b><i>e</i></p>'
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + """
              window.__probeActivationWalk = () => {
                const doc = (htmlFrame?.contentDocument?.body || content).ownerDocument;
                const native = doc.createTreeWalker.bind(doc);
                window.__activationVisited = 0;
                doc.createTreeWalker = (...args) => {
                  const walker = native(...args), next = walker.nextNode.bind(walker);
                  walker.nextNode = () => { window.__activationVisited++; return next(); };
                  return walker;
                };
              };
            """)
        self.page.route("**/static/reader.js*", instrument)
        for extension in ('html', 'md', 'txt'):
            with self.subTest(extension=extension):
                self.serve('before needle after\n' + 'ordinary\n' * 8000 + 'last needle' if extension == 'txt' else html,
                           'text/html' if extension == 'html' else 'text/plain')
                source = self.reader_url(extension)
                self.open(source)
                self.search('needle')
                self.assertEqual(self.page.locator('#full-search-status').text_content(), '2 个结果')
                self.page.evaluate('window.__probeActivationWalk()')
                self.page.locator('.full-search-result').first.click()
                target = self.page.frame_locator('.html-frame') if extension == 'html' else self.page
                self.assertEqual(''.join(target.locator('mark.full-search-highlight').all_text_contents()), 'needle')
                self.assertLessEqual(self.page.evaluate('window.__activationVisited'), 4)
                self.page.locator('#history').click()
                self.page.evaluate('window.__activationVisited = 0')
                self.page.locator('.full-search-result').last.click()
                target.locator('mark.full-search-highlight').first.wait_for()
                self.assertEqual(''.join(target.locator('mark.full-search-highlight').all_text_contents()), 'needle')
                self.assertLessEqual(self.page.evaluate('window.__activationVisited'), 130)
                self.page.locator('#history').click()
                self.page.evaluate('window.__activationVisited = 0')
                self.page.locator('.full-search-result').last.click()
                self.assertEqual(''.join(target.locator('mark.full-search-highlight').all_text_contents()), 'needle')
                self.assertLessEqual(self.page.evaluate('window.__activationVisited'), 130)

    def expose_dom_search_locator(self):
        expose_dom_search_tools(self.page)
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + '''
              window.__domLocator = () => window.__domSearchTools.locator();
              window.__activateDomResult = async index => {
                const doc = (htmlFrame?.contentDocument?.body || content).ownerDocument;
                const native = doc.createTreeWalker.bind(doc);
                let visits = 0;
                doc.createTreeWalker = (...args) => {
                  const walker = native(...args), next = walker.nextNode.bind(walker);
                  walker.nextNode = () => { visits++; return next(); };
                  return walker;
                };
                try { return {ok: await searchState.results[index].activate(), visits}; }
                finally { doc.createTreeWalker = native; }
              };
              window.__headingOracle = async entries => {
                const root = htmlFrame.contentDocument.body;
                setToc(entries.map(entry => ({label:entry.label, target:root.querySelector(entry.selector)})));
                const nodes = await window.__domSearchTools.textNodes(root, readerRuntime.currentGeneration('search'));
                let length = 0;
                const offsets = nodes.map(node => {
                  const part = {node, start:length, end:length + node.data.length};
                  length = part.end;
                  return part;
                });
                const lookup = window.__domSearchTools.headingLookup(root, offsets);
                const compare = () => offsets.map(part => {
                  const heading = [...navigationState.tocEntries].reverse().find(entry => entry.target &&
                    (entry.target === part.node.parentElement ||
                     (entry.target.compareDocumentPosition(part.node) & Node.DOCUMENT_POSITION_FOLLOWING)));
                  const page = part.node.parentElement.closest('[data-page]');
                  const expected = page ? '第 ' + page.dataset.page + ' 页' :
                    heading ? heading.label : '正文 ' + Math.min(100, Math.floor(part.start / Math.max(1,length) * 100)) + '%';
                  return [window.__domSearchTools.location(part.node, '', part.start, length, lookup), expected];
                });
                const pairs = compare();
                setToc([...navigationState.tocEntries].reverse());
                return {indexed:!!lookup, pairs:[...pairs, ...compare()]};
              };
            ''')
        self.page.route('**/static/reader.js*', instrument)

    def test_dom_search_locator_invalidates_on_mutation_and_releases_on_query_and_disposal(self):
        self.expose_dom_search_locator()
        self.serve('<p>needle</p>' + '<p>ordinary</p>' * 9000 + '<p>last needle</p>', 'text/html')
        self.open(self.reader_url('html'))
        self.search('needle')
        self.assertLessEqual(self.page.evaluate('__activateDomResult(1)')['visits'], 130)
        # No task boundary: pending observer records must invalidate synchronously too.
        result = self.page.evaluate('''() => {
          const root = document.querySelector('.html-frame').contentDocument.body;
          root.append(root.ownerDocument.createTextNode(' appended needle'));
          return __activateDomResult(1);
        }''')
        self.assertTrue(result['ok'])
        self.assertGreater(result['visits'], 9000)
        self.page.evaluate('window.__oldLocator = __domLocator()')
        self.page.locator('#full-search-input').fill('ordinary')
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '9000 个结果'")
        self.assertFalse(self.page.evaluate('__oldLocator.current()'))
        self.page.locator('#full-search-input').fill('needle')
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '3 个结果'")
        self.assertEqual(self.page.locator('#full-search-status').text_content(), '3 个结果')
        result = self.page.evaluate('__activateDomResult(2)')
        self.assertTrue(result['ok'])
        self.assertLessEqual(result['visits'], 130)
        result = self.page.evaluate('''() => {
          const root = document.querySelector('.html-frame').contentDocument.body;
          root.prepend(root.ownerDocument.createTextNode('shift prefix '));
          return __activateDomResult(2);
        }''')
        self.assertFalse(result['ok'])
        self.assertEqual(self.page.frame_locator('.html-frame').locator('mark.full-search-highlight').count(), 0)
        self.page.evaluate('window.__oldLocator = __domLocator(); window.dispatchEvent(new Event("pagehide"))')
        self.assertFalse(self.page.evaluate('__oldLocator.current()'))
        self.assertTrue(self.page.evaluate('__domLocator() === null'))

    def test_dom_search_heading_boundaries_preserve_labels_after_repeated_navigation_and_paging(self):
        self.serve('<p>needle before</p>' + ''.join(
            f'<h2 id="heading-{index}">Heading {index}</h2><p>needle</p>' for index in range(150)), 'text/html')
        self.open(self.reader_url('html'))
        self.search('needle')
        self.assertEqual(self.page.locator('#full-search-status').text_content(), '151 个结果')
        self.assertEqual(self.page.locator('.full-search-location').all_text_contents()[1:],
                         [f'Heading {index}' for index in range(49)])
        self.page.locator('.full-search-result').last.click()
        self.page.locator('#history').click()
        self.page.locator('#full-search-page').fill('3')
        self.page.locator('#full-search-page').dispatch_event('change')
        self.page.wait_for_function("() => document.querySelector('.full-search-rank')?.textContent === '101.'")
        self.assertEqual(self.page.locator('.full-search-location').all_text_contents(),
                         [f'Heading {index}' for index in range(99,149)])
        self.page.locator('.full-search-result').last.click()
        self.assertEqual(self.page.frame_locator('.html-frame').locator('mark.full-search-highlight').all_text_contents(), ['needle'])

    def test_dom_search_heading_lookup_matches_ordered_duplicate_empty_and_unordered_toc(self):
        self.expose_dom_search_locator()
        self.serve('''<p>Before</p><h2 id="one">One</h2><div>Outer<h3 id="two">Two</h3>After</div>
          <h2 id="empty"></h2><h2 id="three">Three</h2><p data-page="7">Page text</p><p>Tail</p>''', 'text/html')
        self.open(self.reader_url('html'))
        ordered = [{'selector':'#one','label':'One'}, {'selector':'#two','label':'Two'},
                   {'selector':'#two','label':'Duplicate'}, {'selector':'#empty','label':'Empty'},
                   {'selector':'#three','label':'Three'}]
        for entries, indexed in ((ordered, True), ([ordered[0]], True), (list(reversed(ordered)), False)):
            result = self.page.evaluate('__headingOracle', entries)
            self.assertEqual(result['indexed'], indexed)
            for actual, expected in result['pairs']:
                self.assertEqual(actual, expected)

    def test_search_scans_beyond_20000_nodes_and_cancels_old_query(self):
        self.serve("<main>" + "<span>ordinary </span>" * 21000 + "<p>unique-tail</p></main>", "text/html")
        self.open(self.reader_url("html"))
        self.search("unique-tail")
        self.assertEqual(self.page.locator(".full-search-result").count(), 1)
        self.page.locator("#full-search-input").evaluate("""input => {
          input.value='ordinary'; input.dispatchEvent(new Event('input'));
          input.value='unique-tail'; input.dispatchEvent(new Event('input'));
        }""")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.assertEqual(self.page.frame_locator(".html-frame").locator(".full-search-highlight").all_text_contents(), ["unique-tail"])

    def test_search_retains_matches_across_character_batches_and_pages_all_results(self):
        text = "x" * 65533 + "boundary-needle" + " y" * 100
        self.serve(text)
        self.open(self.reader_url())
        self.search("boundary-needle")
        self.assertEqual(self.page.locator(".full-search-result").count(), 1)
        self.page.locator("#full-search-input").fill("x")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '65533 个结果'")
        self.assertEqual(self.page.locator("#content mark").count(), 100)
        self.page.locator("#full-search-page").fill("3")
        self.page.locator("#full-search-page").press("Enter")
        self.page.wait_for_function("() => document.querySelector('#full-search-page').value === '3' && document.querySelector('.full-search-rank')?.textContent === '101.'")
        self.page.locator(".full-search-result").first.click()
        self.assertEqual(self.page.locator("#content mark.full-search-highlight").all_text_contents(), ["x"])

    def test_html_preparation_reuses_sanitized_dom_without_changing_safe_output(self):
        def expose(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + '''
              window.__sanitizeHtml = sanitizeOfflineHtml;
            ''')
        self.page.route('**/static/reader.js*', expose)
        self.serve('<p>Ready</p>', 'text/html')
        self.open(self.reader_url('html'))
        result = self.page.evaluate(r'''() => {
          const inputs = [
            '<meta charset="utf-8"><title>Title</title><p>中文🌼 &amp; text <b>bold</b></p>',
            '<style>@import "https://invalid.test/css";p{color:#111;background:url(https://invalid.test/bg)}</style><p style="margin:0">Text</p>',
            '<p style="background:url(javascript:bad);color:#111">Content</p><img src="https://invalid.test/img" onerror="evil()">',
            '<base href="https://invalid.test"><script>evil()</script><iframe srcdoc="evil()"></iframe><form><input formaction="x"></form><a href="javascript:bad" onclick="evil()">Link</a>',
            '<table>before<tr><td>A<td>B</tr>after</table><p>a<b>b<i>c</b>d</i><hr><p>tail',
            '<svg><foreignObject><p>Not HTML</p></foreignObject></svg><math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=evil()>">',
            '<template><p>template text</p></template><noscript><p>fallback</p></noscript><p id="__proto__">End</p>',
            '<div class="reader-spreadsheet-sheet"><table><tr><td style="color:red">Cell</td></tr></table></div>',
            '<div>' + '<p style="margin:0;color:#111">Complete <b>needle</b></p>'.repeat(500) + '</div>'
          ];
          const reference = text => {
            const clean = DOMPurify.sanitize(text, {
              USE_PROFILES:{html:true},ADD_TAGS:['style'],
              FORBID_TAGS:['base','embed','form','iframe','object','script'],
              FORBID_ATTR:['action','formaction','srcdoc'],
              ALLOWED_URI_REGEXP:/^data:image\/(?:gif|png|jpeg|webp|svg\+xml);/i
            });
            const template=document.createElement('template');template.innerHTML=clean;
            const strip=value=>value.replace(/@import[^;]+;|url\s*\([^)]*\)/gi,'');
            for(const style of template.content.querySelectorAll('style'))style.textContent=strip(style.textContent);
            for(const node of template.content.querySelectorAll('[style]'))node.setAttribute('style',strip(node.getAttribute('style')));
            return template.innerHTML;
          };
          return inputs.map(text=>{
            const actual=__sanitizeHtml(text),expected=reference(text),template=document.createElement('template');
            template.innerHTML=actual;
            const unsafe=!!template.content.querySelector('script,iframe,object,embed,base,form,[onclick],[onerror],[srcdoc],[formaction]');
            const remote=!!template.content.querySelector('[src^="http"],[href^="http"],[href^="javascript"]');
            const styles=[...template.content.querySelectorAll('style,[style]')].some(n=>/url\s*\(|@import/i.test(n.localName==='style'?n.textContent:n.getAttribute('style')));
            return {equal:actual===expected,unsafe,remote,styles};
          });
        }''')
        self.assertEqual(result, [dict(equal=True, unsafe=False, remote=False, styles=False)] * 9)

    def test_epub_svg_xlink_control_whitespace_cannot_execute_in_reader_context(self):
        with zipfile.ZipFile(io.BytesIO(support.minimal_epub())) as archive:
            files = {item.filename: archive.read(item.filename) for item in archive.infolist()}
        files["OEBPS/chapter.xhtml"] = b'''<html xmlns="http://www.w3.org/1999/xhtml"><body>
          <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
            <a id="probe" xlink:href="java&#x09;script:window.__readerSecurityMarker=17;void(0)">
              <text x="10" y="20">safe label</text>
            </a>
          </svg>
        </body></html>'''
        body = support.zip_bytes({name: value for name, value in files.items() if name != "mimetype"},
                                 ("mimetype", "application/epub+zip"))
        self.serve(body, "application/epub+zip")
        self.open(self.reader_url("epub", name="svg-xlink-security"))
        probe = self.page.locator("article[data-section] #probe")
        self.assertEqual(probe.get_attribute("xlink:href"), None)
        probe.click()
        self.assertFalse(self.page.evaluate("() => window.__readerSecurityMarker === 17"))

    def test_back_tapped_before_reader_module_binds_still_exits(self):
        held = []
        self.page.route("**/static/reader.js*", lambda route: held.append(route))
        landing = self.origin + ("/search/" if "/search/" in self.reader_url() else "/")
        self.page.route(lambda url: url == landing,
                        lambda route: route.fulfill(content_type="text/html", body="<p>search page</p>"))
        self.serve("early back\n" * 50)
        self.page.goto(self.reader_url(name="early-back"), wait_until="commit")
        self.page.locator("#back").wait_for(state="visible")
        deadline = time.time() + 10
        while not held and time.time() < deadline:
            self.page.wait_for_timeout(50)
        self.assertTrue(held, "reader module was not requested")
        self.page.locator("#back").click()
        held.pop(0).continue_()
        self.page.wait_for_url(landing, timeout=8000)

    def test_epub_prefixed_xlink_and_smil_href_cannot_execute_in_reader_context(self):
        with zipfile.ZipFile(io.BytesIO(support.minimal_epub())) as archive:
            files = {item.filename: archive.read(item.filename) for item in archive.infolist()}
        files["OEBPS/chapter.xhtml"] = b'''<html xmlns="http://www.w3.org/1999/xhtml"><body>
          <svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink" width="240" height="70">
            <a id="probe" x:href="javascript:window.__readerSecurityMarker=23;void(0)">
              <text x="10" y="20">prefixed label</text>
            </a>
            <a id="animated">
              <set attributeName="href" to="javascript:window.__readerSecurityMarker=29;void(0)"/>
              <text x="10" y="50">animated label</text>
            </a>
          </svg>
        </body></html>'''
        body = support.zip_bytes({name: value for name, value in files.items() if name != "mimetype"},
                                 ("mimetype", "application/epub+zip"))
        self.serve(body, "application/epub+zip")
        self.open(self.reader_url("epub", name="svg-prefixed-xlink-security"))
        probe = self.page.locator("article[data-section] #probe")
        self.assertIsNone(probe.evaluate("n => n.getAttributeNS('http://www.w3.org/1999/xlink', 'href')"))
        self.assertEqual(self.page.locator("article[data-section] #animated set").count(), 0)
        probe.click()
        self.page.locator("article[data-section] #animated").click()
        self.page.wait_for_timeout(200)
        self.assertIsNone(self.page.evaluate("() => window.__readerSecurityMarker ?? null"))

    def test_offline_html_keeps_layout_attributes_and_enforces_frame_csp(self):
        dot = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8"
               "/x8AAwMB/6XWbqkAAAAASUVORK5CYII=")
        document = (
            '<!doctype html><html><head><meta charset="utf-8"></head><body>'
            '<table><tr><td id="merged" colspan="2" rowspan="3" width="120" lang="zh" dir="ltr">合并</td></tr></table>'
            '<a id="remote-link" href="https://link.remote.test/x">x</a>'
            f'<img id="inline" src="{dot}"><img id="remote" src="https://img.remote.test/a.png">'
            '</body></html>'
        )
        remote = []
        self.page.on("request", lambda request: remote.append(request.url) if ".remote.test" in request.url else None)
        self.serve(document, "text/html")
        self.open(self.reader_url("html", "layout"))
        frame = self.page.locator("iframe.html-frame").element_handle().content_frame()
        cell = frame.locator("#merged")
        self.assertEqual([cell.get_attribute(name) for name in ("colspan", "rowspan", "width", "lang", "dir")],
                         ["2", "3", "120", "zh", "ltr"])
        self.assertIsNone(frame.locator("#remote-link").get_attribute("href"))
        self.assertIsNone(frame.locator("#remote").get_attribute("src"))
        self.assertTrue(frame.locator("#inline").get_attribute("src").startswith("data:image/png;"))
        # The restrictive frame CSP must be a <head> child to be enforced; a remote
        # image is then a CSP violation (Playwright still reports blocked requests).
        result = self.page.evaluate("""async () => {
          const doc = document.querySelector('iframe.html-frame').contentDocument, violations = [];
          doc.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective));
          const image = doc.createElement('img');
          image.src = 'https://img.remote.test/late.png';
          doc.body.append(image);
          await new Promise(resolve => setTimeout(resolve, 400));
          return {policy: !!doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]'), violations};
        }""")
        self.assertEqual(result, {"policy": True, "violations": ["img-src"]})
        self.assertNotIn("https://img.remote.test/a.png", remote)

    def test_epub_css_cannot_load_remote_references_but_keeps_packaged_styles(self):
        css = ("@import url(https://css.remote.test/a.css);\n"
               "@import '\\68ttps://css.remote.test/b.css';\n"
               "p.linked { letter-spacing: 3px; background-image: url(https://img.remote.test/a.png); }\n"
               "p.escaped { background-image: \\75rl(//img.remote.test/b.png); }\n"
               "p.set { background-image: image-set('https://img.remote.test/c.png' 1x); }\n"
               "p.local { background-image: url(dot.png); }\n")
        dot = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6XWbqkAAAAASUVORK5CYII=")
        body = support.zip_bytes({
            "META-INF/container.xml": '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
            "OEBPS/content.opf": '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">css-security</dc:identifier><dc:title>CSS</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="style" href="style.css" media-type="text/css"/><item id="dot" href="dot.png" media-type="image/png"/></manifest><spine><itemref idref="chapter"/></spine></package>',
            "OEBPS/style.css": css,
            "OEBPS/dot.png": dot,
            "OEBPS/chapter.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>CSS</title><link rel="stylesheet" href="style.css"/><style>p.inline { background-image: \\75 rl("https://img.remote.test/d.png"); }</style></head><body><p class="linked">linked</p><p class="escaped">escaped</p><p class="set">set</p><p class="local">local</p><p class="inline">inline</p><p class="attr" style="background-image:url(&quot;https://img.remote.test/e.png&quot;)">attr</p></body></html>',
        }, ("mimetype", "application/epub+zip"))
        remote = []
        self.page.on("request", lambda request: remote.append(request.url) if ".remote.test" in request.url else None)
        self.serve(body, "application/epub+zip")
        self.open(self.reader_url("epub", name="css-security"))
        self.page.wait_for_function("""() => {
          const root = document.querySelector('article[data-section]')?.shadowRoot;
          const p = root?.querySelector('p.linked');
          return p && getComputedStyle(p).letterSpacing === '3px';
        }""")
        styles = self.page.evaluate("""() => {
          const root = document.querySelector('article[data-section]').shadowRoot;
          return Object.fromEntries([...root.querySelectorAll('p')].map(p =>
            [p.className, getComputedStyle(p).backgroundImage]));
        }""")
        for name in ("linked", "escaped", "set", "inline", "attr"):
            self.assertEqual(styles[name], "none", name)
        self.assertRegex(styles["local"], r"^url\(\"blob:")
        self.page.wait_for_timeout(300)
        self.assertEqual(remote, [])

    def frame_host_reader(self, overlay=False, cross_origin=False):
        # The Reader must decide by its real host whether parent messages are handled.
        reader = self.reader_url(name="framed", path="Test/docs")
        base = urllib.parse.urlsplit(reader)
        prefix = base.path[:-len("/static/reader.html")]
        folder = (self.origin + prefix + "/#/Test?folder_self=docs") if prefix else (self.origin + "/Test?folder_self=docs")
        reader += "&" + urllib.parse.urlencode({"folder_url": folder})
        home = self.origin + (prefix + "/" if prefix else "/")
        host_origin = self.origin.replace("127.0.0.1", "localhost") if cross_origin else self.origin
        self.assertNotEqual(host_origin == self.origin, cross_origin)
        if cross_origin:  # localhost -> 127.0.0.1 is otherwise a blocked local-network frame
            self.context.grant_permissions(["local-network-access"], origin=host_origin)
        frame_class = 'class="reader-overlay" ' if overlay else ""
        shell = ("<!doctype html><body><script>window.__messages=[];"
                 "addEventListener('message', event => __messages.push(event.data?.type));</script>"
                 f'<iframe {frame_class}style="width:1000px;height:700px" '
                 f"src={json.dumps(reader)}></iframe></body>")
        landing = {home, folder.split("#", 1)[0]}
        self.page.route(lambda url: url == host_origin + "/frame-host",
                        lambda route: route.fulfill(content_type="text/html", body=shell))
        self.page.route(lambda url: url in landing,
                        lambda route: route.fulfill(content_type="text/html", body="<p>search page</p>"))
        self.serve("framed reading\n" * 200)
        self.page.goto(host_origin + "/frame-host")
        frame = next(item for item in self.page.frames if item.url.startswith(self.origin + base.path))
        frame.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        return frame, home, folder

    def test_non_overlay_frame_host_navigates_reader_in_place(self):
        for cross_origin in (False, True):
            for action in ("back", "folder"):
                with self.subTest(cross_origin=cross_origin, action=action):
                    frame, home, folder = self.frame_host_reader(cross_origin=cross_origin)
                    frame.locator("#back" if action == "back" else "#reader-path").click()
                    expected = home if action == "back" else folder
                    frame.wait_for_url(expected, timeout=4000)
                    if not cross_origin:
                        sent = self.page.evaluate("__messages")
                        for message in ("voice-reader-close", "voice-reader-navigate", "voice-reader-open"):
                            self.assertNotIn(message, sent)

    def test_search_overlay_frame_still_receives_reader_messages(self):
        frame, _home, _folder = self.frame_host_reader(overlay=True)
        reader = frame.url
        frame.locator("#back").click()
        self.page.wait_for_function("() => __messages.includes('voice-reader-close')")
        self.assertEqual(frame.url, reader)

    def test_blocked_or_full_local_storage_keeps_reader_theme_and_zoom(self):
        blocked = """Object.defineProperty(window, 'localStorage', {configurable: true,
          get() { throw new DOMException('The operation is insecure.', 'SecurityError'); }});"""
        full = """Storage.prototype.setItem = function () {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };"""
        for name, script in (("blocked", blocked), ("full", full)):
            with self.subTest(storage=name):
                page = self.context.new_page()
                page.set_default_timeout(int(os.environ.get("READER_TEST_TIMEOUT_MS", "6000")))
                page.on("pageerror", lambda error: self.errors.append(f"{name}: {error}"))
                page.route("**/static/reader/core/reader-store.js", lambda route: route.fulfill(
                    content_type="text/javascript", body=support.STORE_SCRIPT))
                page.route("**/api/reader-content**", lambda route: route.fulfill(
                    content_type="text/plain", body="storage reading\n" * 400))
                page.add_init_script(script)
                page.goto(self.reader_url(name="storage-" + name))
                page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'", timeout=6000)
                page.wait_for_function("() => window.__savedReaderProgress?.zoom === 100")
                page.locator("#zoom-in").click()
                self.assertEqual(page.locator("#zoom").input_value(), "110")
                self.assertEqual(page.locator("#content").evaluate(
                    "node => node.style.getPropertyValue('--reader-zoom')"), "1.1")
                page.wait_for_function("() => window.__savedReaderProgress?.zoom === 110")
                theme = page.locator("html").get_attribute("data-theme")
                support.open_reader_panel(page)
                page.locator("#theme-toggle").click()
                self.assertNotEqual(page.locator("html").get_attribute("data-theme"), theme)
                self.assertEqual(page.locator("#theme-toggle").get_attribute("aria-pressed"),
                                 str(theme == "dark").lower())
                page.close()

    def test_epub_html_and_svg_references_cannot_load_remote_resources(self):
        vectors = ('<p style="background:image-set(\'https://img.remote.test/a.png\' 1x)">a</p>'
                   '<p style="background:\\75rl(https://img.remote.test/b.png)">b</p>'
                   '<table background="https://img.remote.test/c.png"><tr>'
                   '<td id="cell" background="//img.remote.test/d.png">cell</td></tr></table>'
                   '<input type="image" src="https://img.remote.test/e.png"/>'
                   '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20">'
                   '<defs><circle id="dot" r="2"/><filter id="ff"><feImage href="https://img.remote.test/f.png"/>'
                   '<feImage xlink:href="https://img.remote.test/g.png"/></filter></defs>'
                   '<rect width="10" height="10" filter="url(#ff)"/><use id="local-use" href="#dot"/>'
                   '<use href="https://img.remote.test/h.svg#a"/></svg><p id="kept">kept text</p>')
        chapter = ('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Refs</title></head><body>'
                   + vectors + '</body></html>')
        book = support.zip_bytes({
            "META-INF/container.xml": '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
            "OEBPS/content.opf": '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">refs</dc:identifier><dc:title>Refs</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>',
            "OEBPS/c.xhtml": chapter,
        }, ("mimetype", "application/epub+zip"))
        prefix = "chapters/ebook/epub/" + "e" * 64 + "/" + "f" * 16 + "/"
        manifest = {"version": 1, "kind": "epub-chapters", "chapters": [
            {"index": 1, "path": "chapters/chapter-0001.xhtml", "title": "Refs",
             "bytes": len(chapter.encode()), "sha256": hashlib.sha256(chapter.encode()).hexdigest()}]}
        def bucket(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["path"][0]
            if path == prefix + "chapter-manifest.json":
                route.fulfill(content_type="application/json", body=json.dumps(manifest))
            elif path == prefix + "chapters/chapter-0001.xhtml":
                route.fulfill(content_type="application/xhtml+xml", body=chapter)
            else:
                route.fulfill(status=404, body="missing")
        bucket_url = ("https://voiceofml-search.hf.space/api/reader-bucket-resource?path="
                      + urllib.parse.quote(prefix + "chapter-manifest.json", safe=""))
        for mode, url, root in (
            ("foliate", self.reader_url("epub", name="remote-refs"),
             "document.querySelector('article[data-section]')?.shadowRoot"),
            ("chapters", self.reader_url("epub-chapters", url=bucket_url),
             "document.querySelector('.reader-epub-chapter')"),
        ):
            with self.subTest(mode=mode):
                page = self.context.new_page()
                page.set_default_timeout(int(os.environ.get("READER_TEST_TIMEOUT_MS", "6000")))
                page.on("pageerror", lambda error: self.errors.append(str(error)))
                remote = []
                page.on("request", lambda request: remote.append(request.url) if ".remote.test" in request.url else None)
                page.route("**/api/reader-content**", lambda route: route.fulfill(
                    content_type="application/epub+zip", body=book))
                page.route("https://voiceofml-search.hf.space/api/reader-bucket-resource**", bucket)
                page.goto(url)
                page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
                page.wait_for_function(f"() => !!({root})?.querySelector('#kept')")
                page.wait_for_timeout(400)
                self.assertEqual(remote, [])
                self.assertEqual(page.evaluate(f"() => ({root}).querySelector('#local-use').getAttribute('href')"), "#dot")
                page.close()

    def expose_html_contrast(self):
        def instrument(route):
            response = route.fetch()
            script = response.text()
            self.assertIn('readerContext.repairHtmlContrast(frame);', script)
            route.fulfill(response=response, body=script.replace('readerContext.repairHtmlContrast(frame);', ''))
        self.page.route('**/static/reader/formats/reader-html-format.mjs*', instrument)
        def expose(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + '''
              window.__repairContrast = () => repairHtmlContrast(htmlFrame);
            ''')
        self.page.route('**/static/reader.js*', expose)

    def test_html_contrast_reuses_transparent_ancestors_and_refreshes_between_passes(self):
        self.expose_html_contrast()
        self.serve('<main style="color:#111">' + '<div>' * 24 +
                   '<span>Readable text</span>' * 1200 + '</div>' * 24 + '</main>', 'text/html')
        self.open(self.reader_url('html'))
        result = self.page.evaluate('''() => {
          const frame = document.querySelector('.html-frame'), win = frame.contentWindow;
          const native = win.getComputedStyle.bind(win);
          let calls = 0;
          win.getComputedStyle = (...args) => { calls++; return native(...args); };
          __repairContrast();
          const firstCalls = calls;
          const spans = [...frame.contentDocument.querySelectorAll('span')];
          const untouched = spans.every(node => !node.style.color);
          frame.contentDocument.querySelector('main').style.color = '#fff';
          __repairContrast();
          win.getComputedStyle = native;
          return {firstCalls, untouched, repaired: spans.every(node =>
            node.style.color === 'rgb(17, 17, 17)' && node.style.getPropertyPriority('color') === 'important')};
        }''')
        self.assertLessEqual(result['firstCalls'], 1230)
        self.assertTrue(result['untouched'])
        self.assertTrue(result['repaired'])

    def test_html_contrast_keeps_sequential_currentcolor_inheritance_and_alpha_rules(self):
        self.expose_html_contrast()
        self.serve('''<div id="changing" style="color:#777;background:currentColor">
          <span id="first" style="color:white">First</span> Parent
          <span id="last" style="color:white">Last</span></div>
          <div id="inherit" style="color:white">Parent<span id="child">Child</span></div>
          <div style="background:#111"><span id="dark" style="color:#111">Dark</span></div>
          <div style="background:rgba(0,0,0,.1)"><span id="ignored" style="color:white">Ignored</span></div>
          <div style="background:rgba(0,0,0,.11)"><span id="accepted" style="color:#111">Accepted</span></div>
          <a id="link" style="color:#0645ad">Link</a>''', 'text/html')
        self.open(self.reader_url('html'))
        result = self.page.evaluate('''() => {
          __repairContrast();
          const doc = document.querySelector('.html-frame').contentDocument;
          return Object.fromEntries(['changing','first','last','inherit','child','dark','ignored','accepted','link']
            .map(id => [id, [doc.getElementById(id).style.color,
                            doc.getElementById(id).style.getPropertyPriority('color')]]));
        }''')
        self.assertEqual(result, {
            'changing': ['rgb(245, 245, 245)', 'important'], 'first': ['white', ''],
            'last': ['rgb(17, 17, 17)', 'important'], 'inherit': ['rgb(17, 17, 17)', 'important'],
            'child': ['', ''], 'dark': ['rgb(245, 245, 245)', 'important'],
            'ignored': ['rgb(17, 17, 17)', 'important'], 'accepted': ['rgb(245, 245, 245)', 'important'],
            'link': ['rgb(6, 69, 173)', ''],
        })

    def test_html_preserves_css_prose_and_tracks_progress_and_headings(self):
        html = "<p>Examples: url(icon.png) and @import theme.css;</p>" + "".join(
            f"<h1 id='chapter-{i}'>Chapter {i}</h1><p style='height:1100px'>text</p>" for i in range(4))
        self.serve(html, "text/html")
        self.open(self.reader_url("html"))
        frame = self.page.frame_locator(".html-frame")
        self.assertIn("url(icon.png) and @import theme.css;", frame.locator("body").inner_text())
        self.assertTrue(self.page.locator(".html-frame").get_attribute("title"))
        frame.locator("#chapter-2").evaluate("node => node.scrollIntoView()")
        support.open_reader_panel(self.page)
        self.page.wait_for_function("() => Number(document.querySelector('.reader-progress-range').value) > 40")
        self.page.wait_for_function("() => document.querySelectorAll('.toc-item')[2].classList.contains('is-current')")
        self.page.locator(".reader-chapter-next").click()
        self.page.wait_for_function("() => document.querySelectorAll('.toc-item')[3].classList.contains('is-current')")

    def test_discourse_html_extracts_posts_without_forum_shell(self):
        html = """<!doctype html><html><head><title>论坛标题</title></head><body>
        <header class="d-header">论坛顶部</header>
        <div id="topic-title"><a class="fancy-title">论坛标题</a></div>
        <div class="topic-timeline">时间线</div>
        <div class="post-stream">
          <article class="topic-post"><div class="cooked"><p>第一段正文</p><s>删除的文字</s></div></article>
          <article class="topic-post"><div class="cooked"><p>第二段正文</p></div></article>
        </div>
        <div class="suggested-topics">推荐主题</div>
        </body></html>"""
        self.serve(html, "text/html")
        self.open(self.reader_url("html", name="forum"))
        frame = self.page.frame_locator(".html-frame")
        self.assertEqual(frame.locator(".reader-forum-post").count(), 2)
        self.assertIn("第一段正文", frame.locator("body").inner_text())
        self.assertIn("第二段正文", frame.locator("body").inner_text())
        self.assertEqual(frame.locator("s").inner_text(), "删除的文字")
        self.assertEqual(frame.locator(".d-header, .topic-timeline, .suggested-topics").count(), 0)

    def test_html_keyboard_turns_use_iframe_and_reduced_motion(self):
        self.context.clear_permissions()
        self.page.emulate_media(reduced_motion="reduce")
        self.serve("<p style='height:8000px'>Long document</p>", "text/html")
        self.open(self.reader_url("html"))
        self.page.locator(".html-frame").evaluate("""frame => {
          const original = frame.contentWindow.scrollBy.bind(frame.contentWindow);
          frame.contentWindow.scrollBy = options => { window.__turn = options; original(options); };
        }""")
        self.page.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'PageDown', bubbles:true, cancelable:true}))")
        self.assertEqual(self.page.evaluate("window.__turn.behavior"), "instant")
        self.assertGreater(self.page.locator(".html-frame").evaluate("frame => frame.contentWindow.scrollY"), 100)
        self.page.frame_locator(".html-frame").locator("body").evaluate("node => node.dispatchEvent(new KeyboardEvent('keydown', {key:'PageUp', bubbles:true, cancelable:true}))")
        self.assertEqual(self.page.locator(".html-frame").evaluate("frame => frame.contentWindow.scrollY"), 0)

    def test_bookmark_dialog_focus_inert_and_invoker_restoration(self):
        self.serve("A document\n" * 200)
        self.open(self.reader_url())
        self.page.evaluate("document.querySelector('#download').inert = true")
        self.page.locator("#history").click()
        invoker = self.page.locator(".reader-progress-bookmark")
        invoker.click()
        self.assertEqual(self.page.locator("#bookmark-popover").get_attribute("aria-labelledby"), "bookmark-prompt")
        self.assertTrue(self.page.locator("#history-panel").evaluate("node => node.inert"))
        self.page.keyboard.press("Shift+Tab")
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "bookmark-cancel")
        self.page.keyboard.press("Tab")
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "bookmark-label")
        self.page.keyboard.press("Tab")
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "bookmark-excerpt-input")
        self.page.keyboard.press("Escape")
        self.assertTrue(invoker.evaluate("node => node === document.activeElement"))
        self.assertEqual(invoker.get_attribute("aria-expanded"), "false")
        self.assertFalse(self.page.locator("#history-panel").evaluate("node => node.inert"))
        self.assertTrue(self.page.locator("#download").evaluate("node => node.inert"))

    def test_media_updates_percentage_and_saves_during_continuous_updates(self):
        self.serve(support.minimal_wav(), "audio/wav")
        self.open(self.reader_url("wav"))
        self.page.wait_for_function("() => document.querySelector('audio').readyState >= 1")
        self.page.evaluate("""() => {
          const media = document.querySelector('audio');
          Object.defineProperty(media, 'duration', {value:100});
          Object.defineProperty(media, 'currentTime', {value:45, writable:true});
          media.dispatchEvent(new Event('timeupdate'));
          window.__tick = setInterval(() => media.dispatchEvent(new Event('timeupdate')), 100);
        }""")
        self.page.locator("#history").click()
        self.page.wait_for_function("() => document.querySelector('.reader-progress-range').value === '45'")
        self.assertEqual(self.page.locator("#media-tab").get_attribute("aria-controls"), "media-panel")
        self.assertEqual(self.page.locator("#media-panel").get_attribute("role"), "tabpanel")
        self.assertTrue(self.page.locator("audio").get_attribute("aria-label"))
        self.wait_for_store("""async () => {
          const url = new URL(location.href).searchParams.get('url');
          return (await VoiceOfMLReaderStore.get(url))?.mediaTime === 45;
        }""")
        self.page.evaluate("clearInterval(window.__tick)")

    def test_image_disposal_removes_handlers_before_fallback(self):
        self.page.add_init_script("""(() => {
          const NativeImage = window.Image;
          window.Image = function(...args) { const image = new NativeImage(...args); window.__image = image; return image; };
        })()""")
        held = []
        self.page.route("**/api/reader-content**", lambda route: held.append(route))
        self.page.goto(self.reader_url("png"), wait_until="domcontentloaded")
        self.page.wait_for_function("() => window.__image?.getAttribute('src')")
        self.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:false}))")
        self.assertEqual(self.page.evaluate("[window.__image.onload, window.__image.onerror, window.__image.getAttribute('src')]"), [None, None, None])
        for route in held:
            route.abort()
        self.assertEqual(self.page.locator("html").get_attribute("data-reader-phase"), "disposed")

    def test_folder_navigation_has_one_handler_and_preserves_explicit_target(self):
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/folder.txt"
        folder = self.origin + "/search/#/Test?folder_self=explicit"
        self.page.add_init_script("sessionStorage.setItem('reader-resolve:folder-id', " + json.dumps(json.dumps({
            "url": source, "extension": "txt", "title": "Folder", "repo": "Test", "folder": ["metadata"]
        })) + ")")
        self.serve("Folder document")
        self.page.goto(self.origin + "/search/static/reader.html?" + urllib.parse.urlencode({
            "id": "folder-id", "ext": "txt", "path": "Test/explicit", "folder_url": folder
        }))
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        # With a top-level Reader, the explicit folder URL must win after metadata resolves.
        self.page.route(self.origin + "/search/", lambda route: route.fulfill(content_type="text/html", body="Folder"))
        self.page.locator("#reader-path").click()
        self.page.wait_for_url(folder)
        self.assertEqual(self.page.url, folder)

    def test_chapter_manifest_restores_structured_history_and_bookmark(self):
        source = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/" + "a" * 64 + "/1234567890abcdef/chapter-manifest.json"
        manifest = {"version": 1, "kind": "epub-chapters", "chapters": [
            {"index": i, "path": f"chapters/chapter-{i:04d}.xhtml", "title": f"Chapter {i}", "bytes": 100} for i in range(1, 5)
        ]}
        def serve(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["path"][0]
            if path.endswith("chapter-manifest.json"):
                route.fulfill(content_type="application/json", body=json.dumps(manifest))
            else:
                number = path.rsplit("chapter-", 1)[-1].split(".")[0]
                route.fulfill(content_type="text/html", body=f"<h1>Chapter {number}</h1><p style='height:2000px'>Body</p>")
        self.page.route("**/api/reader-bucket-resource**", serve)
        url = self.reader_url("epub-chapters", url=source)
        self.open(url)
        support.open_reader_panel(self.page)
        self.page.locator("#toc-list .panel-item-main").nth(2).click()
        self.page.locator('.reader-epub-chapter[data-chapter="3"]').evaluate("node => { const v=document.querySelector('#viewport'); v.scrollTop += node.getBoundingClientRect().top - v.getBoundingClientRect().top + 250; }")
        self.page.locator("#bookmark-ribbon").click()
        self.page.locator("#bookmark-add").click()
        self.wait_for_store("async source => (await VoiceOfMLReaderStore.listBookmarks(source)).length === 1", source)
        bookmark = self.page.evaluate("async source => (await VoiceOfMLReaderStore.listBookmarks(source))[0]", source)
        self.assertEqual(bookmark["chapterIndex"], 3)
        self.page.wait_for_timeout(700)
        self.open(url)
        self.page.wait_for_function("() => document.querySelector('.reader-epub-chapter[data-chapter=\"3\"]')")
        offset = self.page.locator('.reader-epub-chapter[data-chapter="3"]').evaluate("node => document.querySelector('#viewport').getBoundingClientRect().top + 8 - node.getBoundingClientRect().top")
        self.assertAlmostEqual(offset, bookmark["chapterOffset"], delta=3)
        self.open(url + "&" + urllib.parse.urlencode({"bookmark": bookmark["id"], "bookmark_source": source}))
        self.page.wait_for_function("() => document.querySelector('.reader-epub-chapter[data-chapter=\"3\"]')")

    def test_github_bucket_source_uses_external_bucket_proxy_download_and_ocr(self):
        source = "/api/reader-bucket-resource?" + urllib.parse.urlencode({
            "path": "objects/aa/" + "a" * 64 + "/0123456789abcdef/pages/page-000001.webp"
        })
        external = "https://voiceofml-search.hf.space"
        requests = []
        self.page.on("request", lambda request: requests.append(request.url))
        self.page.route(external + "/api/reader-bucket-resource?**", lambda route: route.fulfill(
            content_type="image/png", body=support.PNG_BYTES))
        self.open(self.reader_url("png", url=source, ocr=external + "/txt/test.txt"))
        content_requests = [url for url in requests if "/api/reader-bucket-resource?" in url]
        self.assertEqual(len(content_requests), 1)
        self.assertEqual(content_requests[0], external + source)
        self.assertFalse(any("/api/reader-content?" in url for url in requests))
        download = self.page.locator("#download").get_attribute("href")
        self.assertTrue(download.startswith(external + "/api/download?"))
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(download).query)["link"], [external + source])
        self.assertEqual(self.page.locator("#ocr").get_attribute("href"), external + "/txt/test.txt")
        self.assertFalse(any(url.startswith(self.origin + "/api/") for url in requests))

    def test_github_back_preserves_hash_return_and_defaults_to_search(self):
        self.serve("Return navigation")
        self.page.route(self.origin + "/search/", lambda route: route.fulfill(content_type="text/html", body="Search"))
        for target in ("", "/", "/search/#/Test?folder_self=books"):
            with self.subTest(target=target):
                self.open(self.reader_url(**{"return": target}))
                self.page.locator("#back").click()
                expected = self.origin + (target if target.startswith("/search/") else "/search/")
                self.page.wait_for_url(expected)

    def test_github_metadata_folder_return_uses_hash_query(self):
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/folder.txt"
        self.page.add_init_script("sessionStorage.setItem('reader-resolve:folder-id', " + json.dumps(json.dumps({
            "url": source, "extension": "txt", "title": "Folder", "repo": "Test", "folder": ["books", "with spaces"]
        })) + ")")
        self.serve("Folder document")
        self.open(self.origin + "/search/static/reader.html?id=folder-id&ext=txt")
        self.page.route(self.origin + "/search/", lambda route: route.fulfill(content_type="text/html", body="Folder"))
        self.page.locator("#reader-path").click()
        self.page.wait_for_url(self.origin + "/search/#/Test?folder_self=books%2Fwith+spaces")

    def test_foliate_cfi_selects_accented_and_inline_ranges_after_repeated_search(self):
        with zipfile.ZipFile(io.BytesIO(support.epub_with_many_chapters())) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        chapter = next(name for name in files if name.endswith("chapter-1.xhtml"))
        files[chapter] = b'''<?xml version="1.0" encoding="UTF-8"?>
          <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Search</title></head><body>
          <h1>Search</h1><p style="height:1300px">Before</p>
          <p id="accent">caf&#233;</p><p style="height:1300px">Between</p>
          <p id="plain">cafe</p><p id="inline">inter<b>national</b></p><p style="height:1300px">After</p>
          </body></html>'''
        self.serve(support.zip_bytes(files), "application/epub+zip")
        self.open(self.reader_url("epub"))
        self.search("cafe")
        self.assertEqual(self.page.locator(".full-search-result").count(), 2)
        self.page.locator(".full-search-result").first.click()
        self.assertEqual(self.page.locator("#accent .full-search-highlight").text_content(), "caf\u00e9")
        self.page.locator("#history").click()
        self.assertFalse(self.page.locator("#full-search-view").is_hidden())
        self.page.locator(".full-search-result").nth(1).click()
        self.assertEqual(self.page.locator("#plain .full-search-highlight").text_content(), "cafe")
        self.page.locator("#history").click()
        self.assertFalse(self.page.locator("#full-search-view").is_hidden())
        self.page.locator("#full-search-input").fill("international")
        self.page.locator(".full-search-result").click()
        self.page.locator("#inline .full-search-highlight").first.wait_for()
        self.assertEqual("".join(self.page.locator("#inline .full-search-highlight").all_text_contents()), "international")

    def test_chapter_resources_allow_siblings_within_manifest_family_only(self):
        for extension in ("epub", "chm"):
            with self.subTest(extension=extension):
                base = "chapters/ebook/" + extension + "/" + "a" * 64 + "/1234567890abcdef/"
                source = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + base + "chapter-manifest.json"
                manifest = {"version": 1, "kind": "epub-chapters", "chapters": [
                    {"index": 1, "path": "chapters/chapter-0001.xhtml", "bytes": 100}
                ]}
                def serve(route):
                    path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["path"][0]
                    if path.endswith("chapter-manifest.json"):
                        route.fulfill(content_type="application/json", body=json.dumps(manifest))
                    elif path.endswith(".svg"):
                        route.fulfill(content_type="image/svg+xml", body="<svg xmlns='http://www.w3.org/2000/svg'/>")
                    else:
                        route.fulfill(content_type="text/html", body="""
                          <h1>Chapter</h1><img id='cover' src='../resources/cover.svg'>
                          <img id='escape' src='../../resources/outside.svg'>
                          <img id='external' src='https://evil.test/cover.svg'>
                        """)
                self.page.route("**/api/reader-bucket-resource**", serve)
                self.open(self.reader_url("epub-chapters", url=source))
                resource = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" + urllib.parse.quote(base + "resources/cover.svg", safe="")
                self.assertEqual(self.page.locator("#cover").get_attribute("src"), resource)
                self.assertIsNone(self.page.locator("#escape").get_attribute("src"))
                self.assertIsNone(self.page.locator("#external").get_attribute("src"))
                self.page.unroute("**/api/reader-bucket-resource**", serve)

    def test_bucket_chapter_manifest_loads_before_reader_module_and_is_consumed_once(self):
        held, manifests = [], []
        root = 'chapters/ebook/epub/' + 'a' * 64 + '/' + 'b' * 16
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urllib.parse.urlencode({'path':root + '/chapter-manifest.json'})
        manifest = {'version':1, 'kind':'epub-chapters', 'chapters':[
            {'index':1, 'path':'chapters/chapter-0001.xhtml', 'bytes':100}]}
        def resource(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)['path'][0]
            if path.endswith('/chapter-manifest.json'):
                manifests.append(route.request.url)
                route.fulfill(json=manifest)
            else:
                route.fulfill(content_type='text/html', body='<h1>Copyright</h1><p>Immediately readable text</p>')
        self.page.route('**/api/reader-bucket-resource?*', resource)
        self.page.route('**/static/reader.js*', lambda route: held.append((route, route.fetch())))
        self.page.goto(self.reader_url('epub-chapters', url=source), wait_until='commit')
        self.page.wait_for_function('() => !!window.__VOICE_READER_CHAPTER_PRELOAD__?.manifest')
        self.page.wait_for_function('async () => (await window.__VOICE_READER_CHAPTER_PRELOAD__.manifest).ok')
        self.assertEqual(len(manifests), 1)
        self.assertEqual(len(held), 1)
        route, response = held[0]
        route.fulfill(response=response)
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.assertEqual(len(manifests), 1)
        self.assertIsNone(self.page.evaluate('window.__VOICE_READER_CHAPTER_PRELOAD__.manifest'))
        self.assertTrue(self.page.locator('.reader-epub-chapter p').is_visible())

    def test_chapter_open_overlaps_first_page_and_prefetches_past_small_front_matter(self):
        root = "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/" + "a" * 64 + "/1234567890abcdef"
        for width, chapter_bytes, last_expected in ((390, 100, 11), (1100, 1000000, 7)):
            with self.subTest(width=width, chapter_bytes=chapter_bytes):
                self.page.set_viewport_size(dict(width=width, height=800))
                requested, first = [], []
                manifest = {"version": 1, "kind": "epub-chapters", "chapters": [
                    {"index": i, "path": f"chapters/chapter-{i:04d}.xhtml", "bytes": chapter_bytes}
                    for i in range(1, 21)
                ]}
                def resource(route):
                    path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query).get("path", [""])[0]
                    if path.endswith("chapter-manifest.json"):
                        route.fulfill(json=manifest)
                        return
                    number = int(path.rsplit("chapter-", 1)[1].split(".", 1)[0])
                    requested.append(number)
                    if number == 1:
                        first.append(route)
                    else:
                        route.fulfill(content_type="text/html", body=f'<h1>Chapter {number}</h1><p style="height:1000px">Readable {number}</p><img src="picture.png"/>')
                self.page.route("**/api/reader-bucket-resource**", resource)
                self.page.goto(self.reader_url("epub-chapters", url=root + "/chapter-manifest.json"))
                self.page.locator('.reader-epub-chapter[data-chapter="3"]').wait_for(state="attached")
                self.assertEqual(requested[0], 1)
                self.assertEqual(len(first), 1)
                self.assertEqual(self.page.locator('.reader-epub-chapter[data-chapter="1"]').count(), 0)
                first[0].fulfill(content_type="text/html", body='<h1>Copyright</h1><p style="height:1000px">Opening page</p>')
                self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
                self.page.locator(f'.reader-epub-chapter[data-chapter="{last_expected}"]').wait_for(state="attached")
                self.page.wait_for_timeout(100)
                self.assertEqual(set(requested), set(range(1, last_expected + 1)), requested)
                self.assertEqual(self.page.locator('#viewport').evaluate('node => node.scrollTop'), 0)
                image = self.page.locator('.reader-epub-chapter[data-chapter="3"] img')
                self.assertEqual(image.evaluate('node => node.loading'), 'lazy')
                self.assertEqual(image.evaluate('node => node.fetchPriority'), 'low')
                self.page.unroute("**/api/reader-bucket-resource**", resource)

    def test_chapter_navigation_during_delayed_open_keeps_user_target(self):
        root = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/' + 'a' * 64 + '/1234567890abcdef'
        manifest = {'version':1, 'kind':'epub-chapters', 'chapters':[
            {'index':i, 'path':f'chapters/chapter-{i:04d}.xhtml', 'bytes':100} for i in range(1,21)]}
        first = []
        def resource(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query).get('path',[''])[0]
            if path.endswith('chapter-manifest.json'):
                route.fulfill(json=manifest)
                return
            number = int(path.rsplit('chapter-',1)[1].split('.',1)[0])
            if number == 1:
                first.append(route)
            else:
                route.fulfill(content_type='text/html', body=f'<h1>Chapter {number}</h1><p style="height:1600px">Readable {number}</p>')
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + '\nwindow.__earlyChapter = index => navigationState.tocEntries[index-1].activate(beginReaderNavigation());\n')
        self.page.route('**/api/reader-bucket-resource**',resource)
        self.page.route('**/static/reader.js*',instrument)
        self.page.goto(self.reader_url('epub-chapters',url=root+'/chapter-manifest.json'))
        self.page.locator('.reader-epub-chapter[data-chapter="3"]').wait_for(state='attached')
        self.assertTrue(self.page.evaluate('__earlyChapter(15)'))
        target = self.page.locator('.reader-epub-chapter[data-chapter="15"]')
        before = target.evaluate('node => node.getBoundingClientRect().top')
        first[0].fulfill(content_type='text/html',body='<h1>Copyright</h1><p style="height:1600px">Opening page</p>')
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.page.wait_for_function('top => Math.abs(document.querySelector(\'.reader-epub-chapter[data-chapter="15"]\').getBoundingClientRect().top-top)<3',arg=before)
        self.assertTrue(target.is_visible())

    def test_concurrent_chapter_open_keeps_order_when_third_chapter_arrives_first(self):
        root = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/' + 'a' * 64 + '/1234567890abcdef'
        manifest = {'version':1, 'kind':'epub-chapters', 'chapters':[
            {'index':i, 'path':f'chapters/chapter-{i:04d}.xhtml', 'bytes':100} for i in range(1,5)]}
        held = {}
        def body(number):
            return f'<h1>Chapter {number}</h1><p style="height:1200px">Readable {number}</p>'
        def resource(route):
            path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query).get('path',[''])[0]
            if path.endswith('chapter-manifest.json'):
                route.fulfill(json=manifest)
                return
            number = int(path.rsplit('chapter-',1)[1].split('.',1)[0])
            if number in (1,2):
                held[number] = route
            else:
                route.fulfill(content_type='text/html',body=body(number))
        self.page.route('**/api/reader-bucket-resource**',resource)
        self.page.goto(self.reader_url('epub-chapters',url=root+'/chapter-manifest.json'))
        self.page.locator('.reader-epub-chapter[data-chapter="3"]').wait_for(state='attached')
        held[1].fulfill(content_type='text/html',body=body(1))
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.assertEqual(self.page.locator('.epub-frame > [data-chapter]').evaluate_all(
            'nodes=>nodes.map(node=>Number(node.dataset.chapter))'),[1,2,3,4])
        held[2].fulfill(content_type='text/html',body=body(2))
        self.page.locator('.reader-epub-chapter[data-chapter="2"]').wait_for(state='attached')
        self.assertEqual(self.page.locator('.reader-epub-chapter').evaluate_all(
            'nodes=>nodes.map(node=>Number(node.dataset.chapter))'),[1,2,3,4])
        self.assertEqual(self.page.locator('#viewport').evaluate('node=>node.scrollTop'),0)


if __name__ == "__main__":
    unittest.main()

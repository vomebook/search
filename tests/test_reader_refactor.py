"""HF Reader regressions using GitHub's /search/ server and external API routes."""

import io
import gzip
import hashlib
import json
import time
import unittest
import urllib.parse
import zipfile
import wave

from tests import test_reader_performance as support


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
        self.page.set_default_timeout(6000)

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
        self.page.route("**/static/reader-store.js", lambda route: route.fulfill(
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
        self.page.route("**/static/reader-store.js", lambda route: route.fulfill(
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
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill(query)
        self.page.wait_for_function("() => /^(?:\d+ 个结果|未找到正文匹配)$/.test(document.querySelector('#full-search-status').textContent)")

    def test_pdf_page_sources_preserve_version_and_navigate(self):
        manifest = {"version": 2, "kind": "pdf-pages", "page_count": 3}
        root = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a" * 64
        self.serve(json.dumps(manifest), "application/json")
        self.page.route("**/page-manifest.json", lambda route: route.fulfill(json=manifest))
        self.page.route("**/pages/page-*.webp", lambda route: route.fulfill(
            content_type="image/webp", body=support.IMAGE_FIXTURES["webp"][1]))
        for version in ("", "/1234567890abcdef"):
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
        requests = []
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
        self.assertTrue(self.page.locator("#full-search-page-next").is_disabled())
        self.assertTrue(self.page.locator("#full-search-page").is_disabled())
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

    def test_pdf_search_cache_cleanup_resets_byte_budget(self):
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + "\nwindow.__pdfCacheProbe = () => { cachePdfSearchText(1, 'cached'); readerRuntime.dispose(); return [pdfSearchTextCache.size, pdfSearchTextCacheBytes]; };\n")
        self.page.route("**/static/reader.js?*", instrument)
        self.serve(support.minimal_pdf(), "application/pdf")
        self.open(self.reader_url("pdf"))
        self.assertEqual(self.page.evaluate("window.__pdfCacheProbe()"), [0, 0])

    def test_pdf_search_pages_reextract_evicted_text_and_ignore_cancelled_load(self):
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + "\nwindow.__dropPdfSearchCache = () => { pdfSearchTextCache.clear(); pdfSearchTextCacheBytes = 0; };\n")
        self.page.route("**/static/reader.js?*", instrument)
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
        self.page.wait_for_function("() => !!window.__releasePdfPage && document.querySelector('#full-search-status').textContent === '正在加载搜索结果…'")
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
        self.page.locator(".full-search-result").first.dispatch_event("click")
        self.page.wait_for_function("() => document.querySelector('#page-number').value === '3'")

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
        self.page.locator("#full-search-page").fill("3")
        self.page.locator("#full-search-page").dispatch_event("change")
        self.page.wait_for_function("() => document.querySelector('#full-search-page').value === '3' && document.querySelector('.full-search-result .full-search-rank')?.textContent === '101.'")
        self.assertIn("needle 2-30", self.page.locator(".full-search-result").first.text_content())
        self.page.locator(".full-search-result").first.click()
        if not self.page.locator("#full-search-input").is_visible():
            self.page.locator("#history").click()
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
            content_type="text/javascript", body=support.PDF_MODULE.replace("numPages: 30", "numPages: 1")))
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
        requests = []
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
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("索引独有")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.assertEqual(self.page.locator(".full-search-result").count(), 1)
        self.assertEqual(requests, [manifest_path, book_path])

    def test_media_proxy_failure_retries_original_once(self):
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
        self.open(self.reader_url('wav'))
        self.page.wait_for_function("() => document.querySelector('audio').readyState >= 1")
        self.assertEqual(len(requests), 1)
        self.assertEqual(self.page.locator('audio').evaluate('node => node.duration'), 1)
        self.page.evaluate("async () => { const media = document.querySelector('audio'); media.currentTime = 0.5; await VoiceOfMLReaderStore.put({url: media.src, mediaTime: 0.5}); }")
        self.page.reload()
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready' && document.querySelector('audio').currentTime === 0.5")
        self.assertEqual(len(requests), 2)
        self.page.locator('audio').evaluate("node => node.dispatchEvent(new Event('error'))")
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'failed'")
        self.assertEqual(len(requests), 2)

    def test_chapter_links_load_target_without_leaving_reader(self):
        base = 'https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/' + 'b' * 64 + '/epub-chapters/'
        bodies = {i: f'<h1>Chapter {i}</h1><p id="target" style="height:12000px">正文</p>' for i in range(1, 13)}
        bodies[1] = '<a href="chapter-0012.xhtml#target">跨章节跳转</a>' + bodies[1]
        manifest = dict(version=1, kind='epub-chapters', chapters=[dict(index=i, path=f'chapters/chapter-{i:04d}.xhtml', title=str(i), bytes=len(bodies[i].encode())) for i in bodies])
        def serve(route):
            url = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)['url'][0]
            body = json.dumps(manifest) if url.endswith('chapter-manifest.json') else bodies[int(url.rsplit('-', 1)[1].split('.')[0])]
            route.fulfill(content_type='application/json' if url.endswith('.json') else 'application/xhtml+xml', body=body)
        self.page.route('**/api/reader-content**', serve)
        self.open(self.reader_url('epub-chapters', url=base + 'chapter-manifest.json'))
        before = self.page.url
        self.page.get_by_text('跨章节跳转', exact=True).click()
        self.page.wait_for_function("() => !!document.querySelector('.reader-epub-chapter[data-chapter=\"12\"] #target')")
        self.page.wait_for_function("() => document.querySelector('#viewport').scrollTop > 1000")
        self.assertEqual(self.page.url, before)
        self.assertLess(abs(self.page.locator('.reader-epub-chapter[data-chapter="12"] #target').evaluate("node => node.getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top")), 5)

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
        base = 'https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/' + 'b' * 64 + '/epub-chapters/'
        body = '<h1>第一卷</h1>' + ''.join(f'<h2 id="day-{i}">日记 {i}</h2><p style="height:100px">正文 {i}</p>' for i in range(1100))
        manifest = dict(version=1, kind='epub-chapters',
                        chapters=[dict(index=1, path='chapters/chapter-0001.xhtml', title='文件标题', bytes=len(body.encode()))],
                        toc=[dict(title=f'日记 {i}', chapter=1, fragment=f'day-{i}', depth=1) for i in range(1100)])
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='application/json' if 'chapter-manifest.json' in route.request.url else 'text/html',
            body=json.dumps(manifest) if 'chapter-manifest.json' in route.request.url else body))
        self.open(self.reader_url('epub-chapters', url=base + 'chapter-manifest.json'))
        self.page.locator('#history').click()
        self.page.locator('#toc-panel').evaluate('node => {node.scrollTop=200*40; node.dispatchEvent(new Event("scroll"));}')
        target = self.page.locator('[data-toc-index="205"]')
        target.wait_for()
        self.assertEqual(target.evaluate('node => node.style.getPropertyValue("--toc-depth")'), '1')
        target.locator('[role="link"]').click()
        self.page.wait_for_function('() => Math.abs(document.querySelector("#day-205").getBoundingClientRect().top-document.querySelector("#viewport").getBoundingClientRect().top)<5')
        self.page.locator('#history').click()
        self.assertEqual(self.page.locator('#toc-list .is-current').get_attribute('data-toc-index'), '205')
        self.page.locator('#toc-panel').evaluate('node => {node.scrollTop=0; node.dispatchEvent(new Event("scroll"));}')
        self.page.locator('[data-toc-index="0"]').wait_for()
        self.assertEqual(self.page.locator('#toc-list .is-current').count(), 0)
        self.page.locator('#toc-panel').evaluate('node => {node.scrollTop=200*40; node.dispatchEvent(new Event("scroll"));}')
        self.page.locator('[data-toc-index="205"].is-current').wait_for()

    def serve_chapter_search(self, failure=None):
        base = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "b" * 64 + "/foliate-original-v1/epub-chapters/"
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
            raw = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)['url'][0]
            requests.append(raw)
            if raw.endswith('chapter-manifest.json'):
                route.fulfill(content_type='application/json', body=json.dumps(manifest))
            elif raw.endswith('epub-search-index.json.gz'):
                attempt = sum(item.endswith('epub-search-index.json.gz') for item in requests)
                if not failure or not failure(route, attempt, packed):
                    route.fulfill(content_type='application/gzip', body=packed)
            else:
                route.fulfill(content_type='text/html', body=bodies[raw])
        self.context.route('**/api/reader-content**', serve)
        self.open(self.reader_url('epub-chapters', url=base + 'chapter-manifest.json'))
        return requests, base

    def test_chapter_search_emits_partial_results_before_exact_total(self):
        self.serve_chapter_search()
        self.page.locator("#history").click()
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
        self.assertNotIn(base + 'chapters/chapter-0012.xhtml', requests)
        field = self.page.locator('#full-search-page')
        field.fill('4')
        field.press('Enter')
        field.blur()
        self.page.wait_for_function("() => document.querySelectorAll('.full-search-result').length === 5")
        self.page.locator('.full-search-result').last.click()
        self.page.wait_for_function("() => document.querySelector('.reader-epub-chapter mark')?.parentElement.textContent === '第154处needle结束'")
        self.page.locator('#history').click()
        self.assertFalse(self.page.locator('#full-search-view').is_hidden())
        self.page.locator('#full-search-input').fill('独特 词语')
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.page.locator('.full-search-result').click()
        self.page.wait_for_function("() => document.querySelectorAll('.reader-epub-chapter mark.full-search-highlight').length === 2")
        self.assertEqual(self.page.locator('.reader-epub-chapter mark').all_text_contents(), ['独特', '词语'])
        self.assertEqual(sum('epub-search-index' in url for url in requests), 1)

    def test_chapter_search_retry_and_corrupt_index(self):
        def failure(route, attempt, packed):
            if attempt == 1:
                route.fulfill(status=503, body='unavailable')
                return True
            if attempt == 2:
                route.fulfill(body=packed[:-1] + bytes([packed[-1] ^ 1]))
                return True
        self.serve_chapter_search(failure)
        self.page.locator('#history').click()
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
        self.page.locator('#history').click()
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
        source = base + "chapter-manifest.json"
        self.page.evaluate("""async source => {
          window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:false}));
          await new Promise(resolve => setTimeout(resolve, 0));
          await VoiceOfMLReaderStore.put({url:source, title:'Saved chapter',
            chapterIndex:12, chapterOffset:345, lastReadAt:Date.now()+1});
        }""", source)
        self.context.route("**/api/reader-content**chapter-0012.xhtml*",
                           lambda route: route.fulfill(status=503, body="temporary"))
        self.page.reload()
        self.page.wait_for_timeout(1200)
        saved = self.page.evaluate("source => VoiceOfMLReaderStore.get(source)", source)
        self.assertEqual(saved["chapterIndex"], 12)
        self.assertEqual(saved["chapterOffset"], 345)
        self.assertEqual(self.page.locator("#content").get_attribute("data-error-code"), "READER_RESTORE")
        self.assertTrue(self.page.get_by_role("button", name="重试加载").is_visible())
        self.context.unroute("**/api/reader-content**chapter-0012.xhtml*")
        self.page.get_by_role("button", name="重试加载").click()
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.wait_for_store("async source => (await VoiceOfMLReaderStore.get(source))?.chapterIndex === 12", source)
        offset = self.page.locator('.reader-epub-chapter[data-chapter="12"]').evaluate(
            "node => document.querySelector('#viewport').getBoundingClientRect().top + 8 - node.getBoundingClientRect().top")
        self.assertAlmostEqual(offset, 345, delta=3)

    def test_chapter_manifest_does_not_translate_foliate_positions(self):
        _, base = self.serve_chapter_search()
        source = base + "chapter-manifest.json"
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
        store_path = urllib.parse.urlsplit(url).path.replace("reader.html", "reader-store.js")
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

    def test_top_level_system_back_steps_out_without_reopen_race(self):
        self.serve("needle " * 300)
        url = self.reader_url()
        self.open(url)
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("needle")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '300 个结果'")
        self.page.locator(".full-search-result").first.click()
        self.page.locator("#history").click()
        self.page.wait_for_function("() => !document.querySelector('#full-search-view').hidden")
        self.page.evaluate("history.back()")
        self.page.wait_for_function("() => document.querySelector('#full-search-view').hidden && document.querySelector('#history-panel').classList.contains('is-open') && history.state.voiceReaderGuard")
        self.assertEqual(self.page.url, url)
        self.page.evaluate("history.back()")
        self.page.wait_for_function("() => !document.querySelector('#history-panel').classList.contains('is-open') && history.state.voiceReaderGuard")
        self.assertEqual(self.page.url, url)

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

    def test_html_preserves_css_prose_and_tracks_progress_and_headings(self):
        html = "<p>Examples: url(icon.png) and @import theme.css;</p>" + "".join(
            f"<h1 id='chapter-{i}'>Chapter {i}</h1><p style='height:1100px'>text</p>" for i in range(4))
        self.serve(html, "text/html")
        self.open(self.reader_url("html"))
        frame = self.page.frame_locator(".html-frame")
        self.assertIn("url(icon.png) and @import theme.css;", frame.locator("body").inner_text())
        self.assertTrue(self.page.locator(".html-frame").get_attribute("title"))
        frame.locator("#chapter-2").evaluate("node => node.scrollIntoView()")
        self.page.locator("#history").click()
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
        source = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a" * 64 + "/chapter-manifest.json"
        manifest = {"version": 1, "kind": "epub-chapters", "chapters": [
            {"index": i, "path": f"chapter-{i}.xhtml", "title": f"Chapter {i}", "bytes": 100} for i in range(1, 5)
        ]}
        def serve(route):
            raw = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["url"][0]
            if raw.endswith("chapter-manifest.json"):
                route.fulfill(content_type="application/json", body=json.dumps(manifest))
            else:
                number = raw.rsplit("chapter-", 1)[-1].split(".")[0]
                route.fulfill(content_type="text/html", body=f"<h1>Chapter {number}</h1><p style='height:2000px'>Body</p>")
        self.page.route("**/api/reader-content**", serve)
        url = self.reader_url("epub-chapters", url=source)
        self.open(url)
        self.page.locator("#history").click()
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

    def test_github_bucket_source_uses_external_content_download_and_ocr(self):
        source = "/api/reader-bucket-resource?" + urllib.parse.urlencode({
            "path": "objects/aa/" + "a" * 64 + "/0123456789abcdef/pages/page-000001.webp"
        })
        external = "https://voiceofml-search.hf.space"
        requests = []
        self.page.on("request", lambda request: requests.append(request.url))
        self.serve(support.PNG_BYTES, "image/png")
        self.open(self.reader_url("png", url=source, ocr=external + "/txt/test.txt"))
        content_requests = [url for url in requests if "/api/reader-content?" in url]
        self.assertEqual(len(content_requests), 1)
        self.assertTrue(content_requests[0].startswith(external + "/api/reader-content?"))
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(content_requests[0]).query)["url"], [external + source])
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
        object_root = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a" * 64 + "/"
        for variant in ("", "epub-chapters/"):
            with self.subTest(variant=variant):
                base = object_root + variant
                source = base + "chapter-manifest.json"
                manifest = {"version": 1, "kind": "epub-chapters", "chapters": [
                    {"index": 1, "path": "chapters/chapter-1.xhtml", "bytes": 100}
                ]}
                self.page.route("**/api/reader-content**", lambda route: route.fulfill(
                    content_type="application/json" if "chapter-manifest.json" in route.request.url else "text/html",
                    body=json.dumps(manifest) if "chapter-manifest.json" in route.request.url else """
                      <h1>Chapter</h1><img id='cover' src='../resources/cover.svg'>
                      <img id='escape' src='../../resources/outside.svg'>
                      <img id='external' src='https://evil.test/cover.svg'>
                    """))
                self.open(self.reader_url("epub-chapters", url=source))
                self.assertEqual(self.page.locator("#cover").get_attribute("src"), base + "resources/cover.svg")
                self.assertIsNone(self.page.locator("#escape").get_attribute("src"))
                self.assertIsNone(self.page.locator("#external").get_attribute("src"))


if __name__ == "__main__":
    unittest.main()

import contextlib
import json
import unittest
import urllib.parse

from tests.support.browser_support import local_server
from tests.performance.test_reader_performance import (
    PNG_BYTES,
    PlaywrightError,
    minimal_wav,
    route_local_vendor_fallback,
    sync_playwright,
)


SOURCE = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/timeout.txt"
TIMEOUT_SCRIPT = """
const nativeTimeout = window.setTimeout.bind(window);
window.__requestTimeouts = [];
window.setTimeout = (callback, delay, ...args) =>
  nativeTimeout(callback, delay === 120000 ? 50 : delay, ...args);
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = new URL(String(input), location.href);
  if (!url.pathname.startsWith('/api/reader-content') &&
      !url.pathname.startsWith('/api/reader-resolve') &&
      !url.pathname.endsWith('/timeout.txt')) return nativeFetch(input, init);
  const signal = init.signal;
  signal.addEventListener('abort', () => {
    window.__requestTimeouts.push(signal.reason.name);
  }, { once: true });
  if (window.__timeoutScenario === 'body') {
    return Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason),
          { once: true });
      }
    }), { headers: { 'Content-Type': 'text/plain' } }));
  }
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
};
"""


@unittest.skipIf(sync_playwright is None, "install requirements-test.txt to run Reader timeout tests")
class ReaderTimeoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        resources = contextlib.ExitStack()
        cls.addClassCleanup(resources.close)
        cls.origin, _ = resources.enter_context(local_server())
        playwright = resources.enter_context(sync_playwright())
        try:
            cls.browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        except PlaywrightError as error:
            raise unittest.SkipTest(f"Chromium is unavailable: {error}")
        cls.addClassCleanup(cls.browser.close)

    def assert_timeout_ui(self, scenario):
        with self.browser.new_context(service_workers="block") as context:
            page = context.new_page()
            page_errors = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.add_init_script(
                f"window.__timeoutScenario = {json.dumps(scenario)};\n" + TIMEOUT_SCRIPT
            )
            query = {"ext": "txt", "title": "Timeout"}
            query.update({"id": "timeout-id"} if scenario == "resolve" else {"url": SOURCE})
            page.goto(
                f"{self.origin}/search/static/reader.html?{urllib.parse.urlencode(query)}",
                wait_until="domcontentloaded",
            )
            page.locator(".reader-error").wait_for(state="visible", timeout=10000)
            self.assertEqual(page.locator("html").get_attribute("data-reader-phase"), "failed")
            self.assertEqual(page.locator("#content").get_attribute("data-error-code"), "READER_NETWORK")
            self.assertEqual(page.locator(".reader-loading-indicator").count(), 0)
            names = page.evaluate("window.__requestTimeouts")
            self.assertTrue(names)
            self.assertEqual(set(names), {"TimeoutError"})
            self.assertEqual(page_errors, [])

    def test_txt_timeout_before_headers_shows_failure(self):
        self.assert_timeout_ui("headers")

    def test_txt_timeout_after_headers_shows_failure(self):
        self.assert_timeout_ui("body")

    def test_id_resolution_timeout_shows_failure(self):
        self.assert_timeout_ui("resolve")

    def test_interrupted_document_requires_manual_retry_without_losing_progress(self):
        for extension, selector in [('txt', '.reader-text'), ('md', '.reader-markdown'), ('html', '.html-frame')]:
            with self.subTest(extension=extension), self.browser.new_context(service_workers='block') as context:
                page = context.new_page()
                route_local_vendor_fallback(page)
                page.add_init_script(r"""
                  const fetchNative = window.fetch.bind(window);
                  if (window === top) window.fetch = (url, init) => {
                    if (!String(url).includes('/api/reader-content?')) return fetchNative(url, init);
                    sessionStorage.loadCalls = Number(sessionStorage.loadCalls || 0) + 1;
                    if (sessionStorage.allowComplete) return Promise.resolve(new Response(
                      Array.from({length:300}, () => '<p>Complete new response</p>\n\n').join('')));
                    return Promise.resolve(new Response(new ReadableStream({start(controller) {
                      controller.enqueue(new TextEncoder().encode('Partial old response '));
                      window.disconnectBody = () => controller.error(new TypeError('connection lost'));
                    }})));
                  };
                """)
                source = SOURCE.replace('.txt', '.' + extension)
                page.goto(f"{self.origin}/search/static/reader.html?" + urllib.parse.urlencode(
                    {'url': source, 'ext': extension}), wait_until='domcontentloaded')
                page.wait_for_function('() => !!window.disconnectBody && !!window.VoiceOfMLReaderStore')
                page.evaluate('source => VoiceOfMLReaderStore.put({url:source,title:"Saved",scrollTop:640,'
                              'htmlScrollTop:640,lastReadAt:Date.now()})', source)
                if extension == 'txt':
                    page.locator(selector, has_text='Partial old response').wait_for()
                page.evaluate('window.disconnectBody()')
                retry = page.get_by_role('button', name='重试加载', exact=True)
                retry.wait_for()
                self.assertIn('原阅读进度已保留', page.locator('.reader-error').inner_text())
                self.assertEqual(page.locator(selector).count(), 0)
                self.assertEqual(page.locator('#content').get_attribute('data-error-code'), 'READER_DOCUMENT_INTERRUPTED')
                self.assertEqual(page.evaluate('sessionStorage.loadCalls'), '1')
                self.assertEqual(page.evaluate('async url => (await VoiceOfMLReaderStore.get(url)).scrollTop', source), 640)
                before = page.url
                page.evaluate('sessionStorage.allowComplete = "1"')
                retry.click()
                page.locator('html[data-reader-phase="ready"]').wait_for()
                body = page.frame_locator(selector).locator('body') if extension == 'html' else page.locator(selector)
                text = body.text_content()
                self.assertIn('Complete new response', text)
                self.assertNotIn('Partial old response', text)
                self.assertEqual(page.url, before)
                self.assertEqual(page.evaluate('sessionStorage.loadCalls'), '2')

    def test_bucket_first_chapter_recovers_once_and_reports_permanent_status(self):
        root = 'chapters/ebook/epub/' + 'a' * 64 + '/' + 'b' * 16 + '/'
        chapter = '<html><body><h1>First chapter recovered</h1></body></html>'
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': 1, 'path': 'chapters/chapter-0001.xhtml', 'title': 'First chapter', 'bytes': len(chapter)}]}
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urllib.parse.urlencode(
            {'path': root + 'chapter-manifest.json'})
        for status in (503, 403, 404):
            with self.subTest(status=status), self.browser.new_context(service_workers='block') as context:
                page = context.new_page()
                attempts = []

                def bucket(route):
                    path = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)['path'][0]
                    headers = {'Access-Control-Allow-Origin': '*'}
                    if path.endswith('/chapter-manifest.json'):
                        route.fulfill(json=manifest, headers=headers)
                        return
                    attempts.append(path)
                    if len(attempts) == 1 or status != 503:
                        route.fulfill(status=status, body='unavailable', headers=headers)
                    else:
                        route.fulfill(content_type='application/xhtml+xml', body=chapter, headers=headers)

                page.route('**/api/reader-bucket-resource?**', bucket)
                page.goto(f"{self.origin}/search/static/reader.html?" + urllib.parse.urlencode(
                    {'url': source, 'ext': 'epub-chapters'}), wait_until='domcontentloaded')
                if status == 503:
                    page.locator('html[data-reader-phase="ready"]').wait_for()
                    page.locator('.reader-epub-chapter', has_text='First chapter recovered').wait_for()
                else:
                    self.assertIn(f'HTTP {status}', page.locator('.reader-error').inner_text())
                self.assertEqual(attempts, [root + 'chapters/chapter-0001.xhtml'] * (2 if status == 503 else 1))

    def test_bucket_media_with_identical_download_url_recovers_from_503(self):
        with self.browser.new_context(service_workers='block') as context:
            page = context.new_page()
            source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urllib.parse.urlencode(
                {'path': 'media/audio/native/' + 'a' * 64 + '/audio.wav'})
            attempts = []

            def media(route):
                attempts.append(route.request.url)
                if len(attempts) == 1:
                    route.fulfill(status=503, body='unavailable')
                else:
                    route.fulfill(body=minimal_wav(), content_type='audio/wav')

            page.route(source, media)
            page.goto(f"{self.origin}/search/static/reader.html?" + urllib.parse.urlencode(
                {'url': source, 'download': source, 'ext': 'wav'}), wait_until='domcontentloaded')
            page.locator('html[data-reader-phase="ready"]').wait_for()
            self.assertGreaterEqual(page.locator('audio').evaluate('media => media.readyState'), 1)
            self.assertEqual(attempts, [source, source])
            self.assertEqual(page.locator('#reader-engine-retry').count(), 0)

    def test_raw_bucket_image_manifest_derives_only_proxied_pages(self):
        with self.browser.new_context(service_workers='block') as context:
            page = context.new_page()
            root = 'pages/image/tiff/' + 'a' * 64 + '/'
            source = 'https://huggingface.co/buckets/vomebook/reader-assets-v2/resolve/' + root + 'page-manifest.json'
            raw, pages = [], []

            def bucket(route):
                url = urllib.parse.urlsplit(route.request.url)
                path = urllib.parse.parse_qs(url.query)['path'][0]
                headers = {'Access-Control-Allow-Origin': '*'}
                if path.endswith('page-manifest.json'):
                    route.fulfill(json={'version': 1, 'kind': 'image-page-stream', 'page_count': 2,
                                        'pages': [{}, {}]}, headers=headers)
                else:
                    pages.append((url.netloc, path))
                    route.fulfill(body=PNG_BYTES, content_type='image/png', headers=headers)

            page.route('https://huggingface.co/buckets/**', lambda route: (raw.append(route.request.url), route.abort()))
            page.route('**/api/reader-bucket-resource?**', bucket)
            page.goto(f"{self.origin}/search/static/reader.html?" + urllib.parse.urlencode(
                {'url': source, 'ext': 'image-pages'}), wait_until='domcontentloaded')
            page.locator('.reader-page[data-page="1"] img.ready').wait_for(state='attached')
            page.locator('#page-number').fill('2')
            page.locator('#page-number').dispatch_event('change')
            page.locator('.reader-page[data-page="2"] img.ready').wait_for(state='attached')
            self.assertEqual(raw, [])
            self.assertEqual(set(pages), {('voiceofml-search.hf.space', root + f'pages/page-{index:06}.webp')
                                          for index in (1, 2)})

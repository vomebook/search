"""Actual module imports and PDF.js with cold cache and transport faults."""
import contextlib
import json
import unittest
import urllib.parse
from unittest.mock import patch

from tests.browser_support import local_server
from tests.browser_support import SearchHandler
from tests.test_reader_performance import sync_playwright, PlaywrightError, minimal_pdf

MODULE = '**/static/vendor/pdf.min.f80490490320.mjs*'
SOURCE = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/cold-retry.pdf'


@unittest.skipIf(sync_playwright is None, 'Playwright is unavailable')
class PdfLoadingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        resources = contextlib.ExitStack()
        cls.addClassCleanup(resources.close)
        cls.origin, _ = resources.enter_context(local_server())
        playwright = resources.enter_context(sync_playwright())
        try:
            cls.browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        except PlaywrightError as error:
            raise unittest.SkipTest(str(error))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block')
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors, self.modules, self.documents = [], [], []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('request', lambda request: self.modules.append(request.url)
                     if '/vendor/pdf.min.' in request.url else None)
        self.page.route('**/api/reader-content**', self.document)
        cdp = self.context.new_cdp_session(self.page)
        cdp.send('Network.enable')
        cdp.send('Network.setCacheDisabled', {'cacheDisabled': True})

    def document(self, route):
        self.documents.append(route.request.url)
        route.fulfill(content_type='application/pdf', body=minimal_pdf())

    def open(self):
        self.page.goto(self.origin + '/search/static/reader.html?' + urllib.parse.urlencode(
            dict(url=SOURCE, ext='pdf', title='Cold retry')), wait_until='domcontentloaded')

    def ready(self):
        self.page.locator('.reader-page canvas.ready').wait_for(state='attached')
        self.assertEqual(self.page.locator('#status').text_content(), '1 页')
        self.assertEqual(self.errors, [])

    def test_cold_success_uses_one_module_request(self):
        self.open()
        self.ready()
        self.assertEqual(len(self.modules), 1)
        self.assertNotIn('reader-module-retry', self.modules[0])

    def test_pdf_engine_loads_while_id_resolution_is_pending(self):
        pending = []
        self.page.route('**/api/reader-resolve?**', lambda route: pending.append(route))
        with self.page.expect_worker() as opened:
            self.page.goto(self.origin + '/search/static/reader.html?id=398vk0yyy8m29&ext=pdf', wait_until='domcontentloaded')
        opened.value.evaluate('''() => new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(Error('Worker did not initialize')), 5000);
          const check = () => globalThis.pdfjsWorker ? (clearTimeout(deadline), resolve(true)) : setTimeout(check, 10);
          check();
        })''')
        self.assertEqual(len(pending), 1)
        self.assertEqual(self.documents, [])
        pending[0].fulfill(content_type='application/json', body=json.dumps({
            'url': SOURCE, 'download': SOURCE, 'extension': 'pdf',
        }))
        self.ready()
        self.assertEqual(len(self.modules), 1)
        self.assertEqual(len(self.page.workers), 1)
        self.assertEqual(len(pending), 1)

    def test_early_resolve_runs_before_main_module_and_retries_transient_http_once(self):
        held, lookups = [], []
        self.page.route('**/static/reader.js*', lambda route: held.append(route))
        def lookup(route):
            lookups.append(route)
            if len(lookups) == 1:
                route.fulfill(status=503, body='try again')
            else:
                route.fulfill(content_type='application/json', body=json.dumps({
                    'url': SOURCE, 'download': SOURCE, 'extension': 'pdf',
                }))
        self.page.route('**/api/reader-resolve?**', lookup)
        self.page.goto(self.origin + '/search/static/reader.html?id=398vk0yyy8m29&ext=pdf', wait_until='commit')
        self.page.wait_for_function('() => !!window.__VOICE_READER_RESOLVE__')
        self.assertEqual(self.page.evaluate('() => window.__VOICE_READER_RESOLVE__.promise.then(x => x.status)'), 503)
        self.assertEqual(self.documents, [])
        self.page.unroute('**/static/reader.js*')
        for route in held: route.continue_()
        self.ready()
        self.assertEqual(len(lookups), 2)

    def test_disposal_terminates_prepared_worker_and_pending_resolve(self):
        self.page.add_init_script('''window.__lookupAborted = false;
          const nativeFetch = window.fetch;
          window.fetch = (url, options) => String(url).includes('/api/reader-resolve?')
            ? new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
                window.__lookupAborted = true; reject(new DOMException('closed', 'AbortError'));
              }, {once:true})) : nativeFetch(url, options);''')
        with self.page.expect_worker() as opened:
            self.page.goto(self.origin + '/search/static/reader.html?id=398vk0yyy8m29&ext=pdf', wait_until='domcontentloaded')
        with opened.value.expect_event('close'):
            self.page.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
        self.assertTrue(self.page.evaluate('() => window.__lookupAborted'))
        self.assertEqual(self.documents, [])
        self.assertEqual(self.errors, [])

    def test_first_connection_failure_recovers_with_real_pdf_engine(self):
        def serve(route):
            if 'reader-module-retry' not in route.request.url:
                route.abort('connectionreset')
            else:
                route.continue_()
        self.page.route(MODULE, serve)
        self.open()
        self.ready()
        self.assertEqual(len(self.modules), 2)
        self.assertIn('reader-module-retry=1', self.modules[1])
        self.assertEqual(len(self.documents), 1)

    def test_http_failure_recovers_on_last_attempt(self):
        self.page.route(MODULE, lambda route: route.continue_()
                        if 'reader-module-retry=2' in route.request.url
                        else route.fulfill(status=503, body='temporarily unavailable'))
        self.open()
        self.ready()
        self.assertEqual(len(self.modules), 3)

    def test_exhaustion_has_bounded_requests_and_manual_reload_recovers(self):
        self.page.route(MODULE, lambda route: route.abort('connectionreset'))
        self.open()
        self.page.locator('#reader-engine-retry').wait_for()
        self.assertEqual(len(self.modules), 3)
        self.assertEqual(self.documents, [])
        self.assertEqual(self.page.locator('#content').get_attribute('data-error-code'), 'READER_ENGINE_NETWORK')
        self.assertNotIn('Failed to fetch', self.page.locator('.reader-error').inner_text())
        self.page.unroute(MODULE)
        self.page.locator('#reader-engine-retry').click()
        self.ready()
        self.assertEqual(len(self.documents), 1)

    def test_disposal_cancels_retry_backoff(self):
        self.page.route(MODULE, lambda route: route.abort('connectionreset'))
        self.open()
        self.page.wait_for_timeout(100)
        self.page.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
        self.page.wait_for_timeout(1800)
        self.assertEqual(len(self.modules), 1)
        self.assertEqual(self.documents, [])
        self.assertEqual(self.errors, [])

    def test_timed_out_import_cannot_start_document_after_disposal(self):
        held = []
        self.page.add_init_script('''const native = window.setTimeout.bind(window);
          window.setTimeout = (fn, ms, ...args) => native(fn, ms === 20000 ? 50 : ms, ...args);''')
        self.page.route(MODULE, lambda route: held.append(route))
        self.open()
        self.page.locator('#reader-engine-retry').wait_for()
        self.assertEqual(len(self.modules), 3)
        for route in held:
            route.fulfill(content_type='text/javascript', body='''
              export const GlobalWorkerOptions = {};
              export function getDocument() { window.__latePdfStarted=true; throw Error('late'); }
            ''')
        self.page.wait_for_timeout(200)
        self.assertFalse(self.page.evaluate('() => !!window.__latePdfStarted'))
        self.assertEqual(self.documents, [])
        self.assertEqual(self.errors, [])

    def test_syntax_error_is_not_retried_as_network_failure(self):
        self.page.route(MODULE, lambda route: route.fulfill(content_type='text/javascript', body='export const = ;'))
        self.open()
        self.page.locator('.reader-error').wait_for()
        self.assertEqual(len(self.modules), 1)
        self.assertEqual(self.page.locator('#reader-engine-retry').count(), 0)

    def test_first_http_failure_recovers_under_real_service_worker(self):
        original = SearchHandler.do_GET
        requests = []
        def serve(handler):
            if '/vendor/pdf.min.' in handler.path:
                requests.append(handler.path)
                if len(requests) == 1:
                    handler.send_error(503)
                    return
            original(handler)
        with patch.object(SearchHandler, 'do_GET', serve), \
                self.browser.new_context(service_workers='allow') as context:
            page = context.new_page()
            context.route('**/api/reader-content**', lambda route: route.fulfill(
                content_type='application/pdf', body=minimal_pdf()))
            page.goto(self.origin + '/search/manifest.json')
            page.evaluate('''async () => {
              await navigator.serviceWorker.register('/search/sw.js',{scope:'/search/'});
              await navigator.serviceWorker.ready;
            }''')
            page.goto(self.origin + '/search/static/reader.html?' + urllib.parse.urlencode(
                dict(url=SOURCE, ext='pdf', title='Cold SW retry')))
            page.locator('.reader-page canvas.ready').wait_for(state='attached', timeout=15000)
            self.assertTrue(page.evaluate('() => !!navigator.serviceWorker.controller'))
            self.assertEqual(len(requests), 2)
            self.assertIn('reader-module-retry=1', requests[1])

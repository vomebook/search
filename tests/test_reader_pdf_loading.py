"""Actual module imports and PDF.js with cold cache and transport faults."""
import contextlib
import json
import re
import threading
import time
import unittest
import urllib.parse
from unittest.mock import patch

from tests.browser_support import local_server
from tests.browser_support import SearchHandler
from tests.test_reader_performance import sync_playwright, PlaywrightError, minimal_pdf

MODULE = '**/static/vendor/pdf.min.*.mjs*'
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

    def test_pdf_range_policy_keeps_default_browser_cache_from_serializing_reads(self):
        payload = b''.join(bytes([index]) * 128 for index in range(16))
        metrics = {mode: {'active': 0, 'peak': 0} for mode in ('upstream', 'reader')}
        lock = threading.Lock()
        original = SearchHandler.do_GET

        def serve(handler):
            if not handler.path.startswith('/cache-lock-probe.pdf?'):
                return original(handler)
            mode = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query)['mode'][0]
            match = re.fullmatch(r'bytes=(\d+)-(\d+)', handler.headers.get('Range', ''))
            start, end = int(match[1]), int(match[2])
            headers = {'Content-Type': 'application/pdf', 'Cache-Control': 'public, max-age=31536000',
                       'ETag': '"range-cache-probe"', 'Accept-Ranges': 'bytes',
                       'Content-Range': f'bytes {start}-{end}/{len(payload)}', 'Content-Length': str(end-start+1)}
            with lock:
                metrics[mode]['active'] += 1
                metrics[mode]['peak'] = max(metrics[mode]['peak'], metrics[mode]['active'])
            try:
                time.sleep(.08)
                handler.send_response(206)
                for name, value in headers.items():
                    handler.send_header(name, value)
                handler.end_headers()
                handler.wfile.write(payload[start:end+1])
                handler.wfile.flush()
            finally:
                with lock:
                    metrics[mode]['active'] -= 1

        # Playwright routing also disables HTTP caching. Use an un-routed context.
        with patch.object(SearchHandler, 'do_GET', serve), \
                self.browser.new_context(service_workers='block') as context:
            page = context.new_page()
            page.goto(self.origin + '/search/static/manifest.json')
            page.evaluate("async () => { window.__pdfNetwork = await import('/search/static/reader-pdf-network.mjs'); }")
            for mode in ('upstream', 'reader'):
                results = page.evaluate('''async mode => {
                  const url = '/cache-lock-probe.pdf?mode=' + mode;
                  const policy = mode === 'reader' ? __pdfNetwork.createPdfFetchPolicy() : null;
                  policy?.add([url]);
                  try { return await Promise.all(Array.from({length:16}, async (_, index) => {
                    const headers = {Range:'bytes=' + index*128 + '-' + (index*128+127)};
                    const response = await fetch(url, {headers});
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    return {status:response.status, range:response.headers.get('Content-Range'),
                            exact:bytes.length === 128 && bytes.every(value => value === index)};
                  })); } finally { policy?.dispose(); }
                }''', mode)
                self.assertEqual(results, [{'status':206, 'range':f'bytes {index*128}-{index*128+127}/2048',
                                            'exact':True} for index in range(16)])
        self.assertGreater(metrics['reader']['peak'], 1, metrics)
        self.assertEqual(self.errors, [])

    def test_pdf_fetch_policy_scopes_requests_preserves_options_and_restores_owner(self):
        with self.browser.new_context(service_workers='block') as context:
            page = context.new_page()
            page.goto(self.origin + '/search/static/manifest.json')
            result = page.evaluate('''async () => {
              const {createPdfFetchPolicy} = await import('/search/static/reader-pdf-network.mjs');
              const native = fetch, calls = [], signal = new AbortController().signal;
              const init = {cache:'force-cache', signal, headers:{Range:'bytes=0-1'}};
              const spy = (input, options) => {calls.push({input, options}); return Promise.resolve(new Response('ok'));};
              globalThis.fetch = spy;
              const policy = createPdfFetchPolicy();
              try {
                policy.add(['/document.pdf']);
                await fetch('/document.pdf', init);
                await fetch('/document.pdf?other=1', init);
                policy.add(['/fallback.pdf']);
                const request = new Request(new URL('/fallback.pdf', location.href));
                await fetch(request, init);
                policy.dispose();
                const restored = fetch === spy;
                await fetch('/document.pdf', init);
                return {caches:calls.map(call => call.options.cache),
                         signals:calls[0].options.signal.aborted && calls[2].options.signal.aborted &&
                           !signal.aborted && calls[1].options.signal === signal && calls[3].options.signal === signal,
                        headers:calls.every(call => call.options.headers === init.headers),
                        request:calls[2].input === request, outside:calls[1].options === init,
                        restored, originalCache:init.cache};
              } finally { policy.dispose(); globalThis.fetch = native; }
            }''')
        self.assertEqual(result, {'caches':['no-store','force-cache','no-store','force-cache'],
                                 'signals':True, 'headers':True, 'request':True, 'outside':True,
                                 'restored':True, 'originalCache':'force-cache'})

    def test_v2_bucket_pdf_uses_external_proxy_without_nested_content_request(self):
        path = 'derived/test/' + 'a' * 32 + '/document.pdf'
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=' + path
        for width, height, opening in ((1280, 800, 'direct'), (390, 844, 'resolved')):
            with self.subTest(opening=opening, width=width):
                self.page.set_viewport_size({'width': width, 'height': height})
                held = []
                self.page.route('**/api/reader-bucket-resource?**', lambda route: held.append(route))
                self.page.route('**/api/reader-resolve?**', lambda route: route.fulfill(
                    content_type='application/json', body=json.dumps({
                        'url': source, 'download': SOURCE, 'extension': 'pdf',
                    })))
                options = dict(ext='pdf', title='Bucket PDF')
                if opening == 'direct':
                    options['url'] = '/api/reader-bucket-resource?path=' + path
                else:
                    options['id'] = '398vk0yyy8m29'
                with self.page.expect_request('**/api/reader-bucket-resource?**'):
                    self.page.goto(self.origin + '/search/static/reader.html?' + urllib.parse.urlencode(options),
                                   wait_until='domcontentloaded')
                deadline = time.monotonic() + 5
                while not held and time.monotonic() < deadline:
                    self.page.wait_for_timeout(20)
                self.assertEqual(len(held), 1)
                self.assertEqual(held[0].request.url, source)
                self.assertEqual(self.documents, [])
                self.assertEqual(self.page.locator('.reader-preparing-surface').count(), 0)
                self.assertEqual(self.page.locator('.reader-loading-indicator').count(), 1)
                held[0].fulfill(content_type='application/pdf', body=minimal_pdf())
                self.ready()
                self.assertEqual(self.page.locator('.reader-loading-indicator').count(), 0)
                self.assertGreaterEqual(self.page.evaluate("document.querySelector('.reader-page').getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top"), -1)
                self.page.unroute('**/api/reader-bucket-resource?**')

    def test_legacy_v2_bucket_pdf_links_stay_on_proxy_for_both_buckets(self):
        direct = []
        self.page.route('https://huggingface.co/**', lambda route: (direct.append(route.request.url), route.abort()))
        for bucket, path in (
            ('reader-assets-v2', 'documents/pdf/ppt/' + 'a' * 64 + '/document.pdf'),
            ('pdf-pages-v2', 'derived/test/' + 'b' * 32 + '/document.pdf'),
        ):
            with self.subTest(bucket=bucket):
                requested = []
                def proxy(route):
                    requested.append(route.request.url)
                    route.fulfill(content_type='application/pdf', body=minimal_pdf())
                self.page.route('**/api/reader-bucket-resource?**', proxy)
                source = f'https://huggingface.co/buckets/vomebook/{bucket}/resolve/{path}'
                self.page.goto(self.origin + '/search/static/reader.html?' + urllib.parse.urlencode(
                    dict(url=source, ext='pdf', title='Legacy bucket link')), wait_until='domcontentloaded')
                self.ready()
                self.assertEqual(len(requested), 1)
                self.assertTrue(requested[0].startswith('https://voiceofml-search.hf.space/api/reader-bucket-resource?'))
                self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(requested[0]).query)['path'], [path])
                self.assertEqual(self.documents, [])
                self.assertEqual(direct, [])
                self.page.unroute('**/api/reader-bucket-resource?**', proxy)

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

    def test_engine_preload_starts_while_reader_dependency_is_still_pending(self):
        held=[]
        self.page.route('**/static/reader-runtime.js',lambda route:held.append(route))
        self.page.goto(self.origin+'/static/reader.html?'+urllib.parse.urlencode(dict(url=SOURCE,ext='pdf')),wait_until='commit')
        self.page.locator('link[rel="modulepreload"][href*="pdf.min"]').wait_for(state='attached')
        for _ in range(100):
            if held: break
            self.page.wait_for_timeout(10)
        self.assertGreaterEqual(len(self.modules),1)
        self.assertEqual(len(self.documents),0)
        self.assertEqual(len(held),1)
        self.page.unroute('**/static/reader-runtime.js')
        held[0].continue_()
        self.ready()
        self.assertEqual(len(self.modules),1)

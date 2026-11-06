"""Exercise the actual browser Worker with local PDF text-index fixtures."""

from functools import partial
import gzip
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
SOURCE_SHA = 'a' * 64
GENERATION = 'c' * 64
TEXT_GENERATION = 'd' * 64
BASE = f'objects/aa/{SOURCE_SHA}/bbbbbbbbbbbbbbbb/text'


def packed(value):
    return gzip.compress(json.dumps(value).encode(), mtime=0)


def digest(value):
    return hashlib.sha256(value).hexdigest()


BOOK = packed({
    'version': 2, 'kind': 'pdf-book-text', 'complete': True,
    'offset_unit': 'unicode-codepoint', 'source_sha256': SOURCE_SHA,
    'page_count': 1, 'pages': [{
        'page': 1, 'text': 'needle ' * 120,
        'layout': {'offset_unit': 'unicode-codepoint'}, 'text_spans': [],
    }],
})
PARTITION = packed({
    'version': 1, 'kind': 'pdf-search-text-partition', 'source_sha256': SOURCE_SHA,
    'generation': GENERATION, 'offset_unit': 'unicode-codepoint', 'start': 1, 'end': 1,
    'pages': [{'page': 1, 'text': 'needle ' * 120, 'text_generation': TEXT_GENERATION}],
})
PARTITION2 = packed({
    'version': 1, 'kind': 'pdf-search-text-partition', 'source_sha256': SOURCE_SHA,
    'generation': GENERATION, 'offset_unit': 'unicode-codepoint', 'start': 2, 'end': 2,
    'pages': [{'page': 2, 'text': 'needle ' * 60, 'text_generation': TEXT_GENERATION}],
})
RESOURCES = {f'{BASE}/book-text.json.gz': BOOK, f'{BASE}/search-000001-000001.json.gz': PARTITION,
             f'{BASE}/search-000002-000002.json.gz': PARTITION2}


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == '/pdf-worker-test':
            body, content_type = b'<!doctype html><title>PDF Worker test</title>', 'text/html'
        elif parsed.path == '/api/reader-bucket-resource':
            path = parse_qs(parsed.query).get('path', [''])[0]
            parts = path.split('/')
            if len(parts) > 3:
                parts[3] = 'bbbbbbbbbbbbbbbb'
            body = RESOURCES.get('/'.join(parts))
            if body is None:
                self.send_error(404)
                return
            content_type = 'application/octet-stream'
        else:
            return super().do_GET()
        state = None
        if parsed.path == '/api/reader-bucket-resource':
            query = parse_qs(parsed.query)
            with self.server.state_lock:
                state = self.server.state
                if state is None or len(parts) <= 3 or path.split('/')[3] != state['token']:
                    self.send_error(410, 'stale test case')
                    return
                state['active'] += 1
                state['done'].clear()
        try:
            if state and '/'.join(parts) == state['block_path']:
                state['arrived'].set()
                if not state['release'].wait(state['timeout']):
                    self.server.block_timed_out.set()
                    self.send_error(503, 'test release missing')
                    return
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # A cancelled Worker request may close its connection.
        finally:
            if state:
                with self.server.state_lock:
                    state['active'] -= 1
                    if not state['active']:
                        state['done'].set()

    def log_message(self, *_args):
        pass


class PdfBookWorkerBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        cls.server.state_lock = threading.Lock()
        cls.server.state = None
        cls.server.block_timed_out = threading.Event()
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.addClassCleanup(cls.server.server_close)
        cls.addClassCleanup(cls.server_thread.join, timeout=5)
        cls.addClassCleanup(cls.server.shutdown)
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        browser = getattr(cls.playwright, os.environ.get('PDF_WORKER_TEST_BROWSER', 'chromium'))
        cls.browser = browser.launch(headless=True)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.state = {
            'token': uuid.uuid4().hex[:16], 'block_path': None, 'timeout': 10,
            'arrived': threading.Event(), 'release': threading.Event(),
            'done': threading.Event(), 'active': 0,
        }
        self.state['done'].set()
        with self.server.state_lock:
            self.assertIsNone(self.server.state)
            self.server.block_timed_out.clear()
            self.server.state = self.state
        self.addCleanup(self.cleanup_requests)

    def cleanup_requests(self):
        self.state['release'].set()
        with self.server.state_lock:
            self.server.state = None  # Reject late requests before waiting for handlers.
        self.assertTrue(self.state['done'].wait(10), 'HTTP handlers did not finish')
        self.assertFalse(self.server.block_timed_out.is_set(), 'HTTP handler release timed out')

    def resource(self, path):
        path = path.replace("/bbbbbbbbbbbbbbbb/", f"/{self.state['token']}/")
        return f"{self.origin}/api/reader-bucket-resource?path={path}"

    def make_page(self):
        page = self.browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def cleanup():
            self.state['release'].set()
            try:
                unexpected = page.evaluate('''() => {
                  if (window.client) window.client.dispose();
                  return window.unexpected || [];
                }''')
                errors.extend(unexpected)
            finally:
                try:
                    page.close()
                finally:
                    self.assertEqual(errors, [], 'unexpected browser errors')

        self.addCleanup(cleanup)
        page.goto(f'{self.origin}/pdf-worker-test', timeout=10000)
        page.evaluate('''() => {
          window.unexpected = [];
          const RealWorker = window.Worker;
          window.Worker = class extends RealWorker {
            constructor(...args) {
              super(...args);
              this.addEventListener('error', event => {
                window.unexpected.push('Worker error: ' + event.message);
              });
            }
          };
          window.addEventListener('unhandledrejection', event => window.unexpected.push(String(event.reason)));
          window.deadline = (promise, label) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              clearTimeout(timer);
              reject(new Error(label + ' deadline exceeded'));
            }, 5000);
            Promise.resolve(promise).then(
              value => { clearTimeout(timer); resolve(value); },
              error => { clearTimeout(timer); reject(error); });
          });
          window.capture = (promise, label) => window.deadline(promise, label).then(
            value => ({value}), error => ({error: error.name, message: error.message}));
        }''')
        return page

    def configuration(self):
        def part(number, body):
            path = f'{BASE}/search-{number:06d}-{number:06d}.json.gz'
            return {'start': number, 'end': number,
                    'url': self.resource(path),
                    'bytes': len(body), 'sha256': digest(body)}
        return {'url': self.resource(f'{BASE}/book-text.json.gz'),
                'bytes': len(BOOK), 'sha256': digest(BOOK), 'pageCount': 2,
                'sourceSha': SOURCE_SHA, 'generation': GENERATION,
                'partitions': [part(1, PARTITION), part(2, PARTITION2)]}

    def test_missing_release_is_detected(self):
        from urllib.error import HTTPError
        from urllib.request import urlopen

        self.state['block_path'] = f'{BASE}/book-text.json.gz'
        self.state['timeout'] = 0.05
        with self.assertRaises(HTTPError) as raised:
            urlopen(self.resource(self.state['block_path']), timeout=2)
        self.assertEqual(raised.exception.code, 503)
        self.assertTrue(self.state['done'].wait(2))
        # Exercise the same cleanup assertion, then restore the expected fixture state.
        with self.assertRaisesRegex(AssertionError, 'release timed out'):
            self.cleanup_requests()
        self.server.block_timed_out.clear()

    def test_progress_prefetch_does_not_preempt_search(self):
        self.state['block_path'] = f'{BASE}/search-000002-000002.json.gz'
        page = self.make_page()
        page.evaluate('''async config => {
          const {createPdfBookSearch} = await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'), 'import');
          const client = createPdfBookSearch(config);
          window.client = client;
          window.progressSeen = false;
          window.outcome = window.capture(client.search('needle', progress => {
            if (window.progressSeen) return;
            window.progressSeen = true;
            window.progressSession = progress.session;
            window.prefetchOutcome = window.capture(client.prefetch(), 'progress prefetch');
          }), 'search');
        }''', self.configuration())
        self.assertTrue(self.state['arrived'].wait(10), 'second partition was not requested')
        self.assertTrue(page.evaluate('window.progressSeen'))
        self.state['release'].set()
        prefetch = page.evaluate('window.prefetchOutcome')
        self.assertEqual(prefetch.get('error'), 'AbortError', f'progress prefetch unexpectedly completed: {prefetch}')
        result = page.evaluate('''async () => {
          const search = await window.outcome;
          if (!search.value) return {search};
          const after = await window.deadline(window.client.prefetch(), 'after search prefetch');
          const page = await window.deadline(window.client.page(150), 'page');
          return {search, after, page, progressSession: window.progressSession};
        }''')
        first = result['search']['value']
        self.assertEqual(first['total'], 180)
        self.assertEqual(first['session'], result['progressSession'])
        self.assertEqual(result['after']['session'], first['session'])
        self.assertIsInstance(result['after']['session'], int)
        self.assertIsInstance(result['after']['id'], int)
        self.assertEqual(result['page']['session'], first['session'])
        self.assertEqual(result['page']['offset'], 150)
        self.assertEqual(len(result['page']['results']), 30)
        self.assertEqual(result['page']['results'][0]['page'], 2)
        self.assertEqual(page.evaluate('window.unexpected'), [])

    def test_search_preempts_inflight_prefetch(self):
        self.state['block_path'] = f'{BASE}/book-text.json.gz'
        config = {'url': self.resource(self.state['block_path']),
                  'bytes': len(BOOK), 'sha256': digest(BOOK), 'pageCount': 1, 'sourceSha': SOURCE_SHA}
        page = self.make_page()
        page.evaluate('''async config => {
          const {createPdfBookSearch} = await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'), 'import');
          window.client = createPdfBookSearch(config);
          window.prefetchOutcome = window.capture(window.client.prefetch(), 'prefetch');
        }''', config)
        self.assertTrue(self.state['arrived'].wait(10), 'book prefetch was not requested')
        page.evaluate('''() => {
          window.outcome = window.capture(window.client.search('needle'), 'search');
        }''')
        prefetch = page.evaluate('window.prefetchOutcome')
        self.assertEqual(prefetch.get('error'), 'AbortError', str(prefetch))
        self.state['release'].set()
        result = page.evaluate('window.outcome')
        self.assertEqual(result['value']['total'], 120)
        self.assertEqual(page.evaluate('window.unexpected'), [])

    def check_prefetch_after_search(self, partitioned):
        resource = self.resource

        configuration = {
            'url': resource(f'{BASE}/book-text.json.gz'), 'bytes': len(BOOK),
            'sha256': digest(BOOK), 'pageCount': 1, 'sourceSha': SOURCE_SHA,
        }
        if partitioned:
            configuration.update(generation=GENERATION, partitions=[{
                'start': 1, 'end': 1, 'url': resource(f'{BASE}/search-000001-000001.json.gz'),
                'bytes': len(PARTITION), 'sha256': digest(PARTITION),
            }])
        page = self.make_page()
        result = page.evaluate('''async configuration => {
          const {createPdfBookSearch} = await window.deadline(import('/static/reader/search/reader-pdf-book-search.mjs'), 'import');
          const client = window.client = createPdfBookSearch(configuration);
          const before = await window.deadline(client.prefetch(), 'before prefetch');
          const first = await window.deadline(client.search('needle'), 'search');
          const after = await window.deadline(client.prefetch(), 'after prefetch');
          const page = await window.deadline(client.page(100), 'page');
          client.cancel();
          const cancelled = await window.deadline(client.prefetch(), 'cancelled prefetch');
          const retry = await window.deadline(client.search('needle'), 'retry');
          return {before, first, after, page, cancelled, retry};
        }''', configuration)
        self.assertEqual(result['before']['session'], None)
        first = result['first']
        self.assertEqual(first['total'], 120)
        self.assertEqual(len(first['results']), 50)
        self.assertEqual(result['after']['session'], first['session'])
        self.assertTrue(result['after']['ready'])
        self.assertEqual(result['page']['session'], first['session'])
        self.assertEqual(result['page']['offset'], 100)
        self.assertEqual(len(result['page']['results']), 20)
        if partitioned:
            self.assertEqual(result['page']['results'][0]['textGeneration'], TEXT_GENERATION)
        self.assertEqual(result['cancelled']['session'], None)
        self.assertEqual(result['retry']['total'], 120)
        self.assertNotEqual(result['retry']['session'], first['session'])
        self.assertEqual(page.evaluate('window.unexpected'), [])

    def test_book_text_prefetch_after_search(self):
        self.check_prefetch_after_search(False)

    def test_partitioned_prefetch_after_search(self):
        self.check_prefetch_after_search(True)


if __name__ == '__main__':
    unittest.main(verbosity=2)

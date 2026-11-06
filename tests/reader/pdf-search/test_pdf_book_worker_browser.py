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
RESOURCES = {f'{BASE}/book-text.json.gz': BOOK, f'{BASE}/search-000001-000001.json.gz': PARTITION}


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == '/pdf-worker-test':
            body, content_type = b'<!doctype html><title>PDF Worker test</title>', 'text/html'
        elif parsed.path == '/api/reader-bucket-resource':
            body = RESOURCES.get(parse_qs(parsed.query).get('path', [''])[0])
            if body is None:
                self.send_error(404)
                return
            content_type = 'application/octet-stream'
        else:
            return super().do_GET()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class PdfBookWorkerBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
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

    def check_prefetch_after_search(self, partitioned):
        def resource(path):
            return f'{self.origin}/api/reader-bucket-resource?path={path}'

        configuration = {
            'url': resource(f'{BASE}/book-text.json.gz'), 'bytes': len(BOOK),
            'sha256': digest(BOOK), 'pageCount': 1, 'sourceSha': SOURCE_SHA,
        }
        if partitioned:
            configuration.update(generation=GENERATION, partitions=[{
                'start': 1, 'end': 1, 'url': resource(f'{BASE}/search-000001-000001.json.gz'),
                'bytes': len(PARTITION), 'sha256': digest(PARTITION),
            }])
        page = self.browser.new_page()
        self.addCleanup(page.close)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'{self.origin}/pdf-worker-test')
        page.set_default_timeout(10000)
        result = page.evaluate('''async configuration => {
          const {createPdfBookSearch} = await import('/static/reader/search/reader-pdf-book-search.mjs');
          const client = createPdfBookSearch(configuration);
          try {
            const before = await client.prefetch();
            const first = await client.search('needle');
            const after = await client.prefetch();
            const page = await client.page(100);
            client.cancel();
            const cancelled = await client.prefetch();
            const retry = await client.search('needle');
            return {before, first, after, page, cancelled, retry};
          } finally { client.dispose(); }
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
        self.assertEqual(errors, [])

    def test_book_text_prefetch_after_search(self):
        self.check_prefetch_after_search(False)

    def test_partitioned_prefetch_after_search(self):
        self.check_prefetch_after_search(True)


if __name__ == '__main__':
    unittest.main(verbosity=2)

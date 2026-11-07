"""Real-browser, source-module Reader DOM-search contracts; all data is local."""
import contextlib
import hashlib
import http.server
import os
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[3]
MODULE_URL = '/static/reader/search/reader-dom-search.mjs'
CONTRACT_URL = '/tests/reader/dom-search/contracts.mjs'


class ReaderDomSearchContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stack = contextlib.ExitStack()
        cls.addClassCleanup(stack.close)
        routes = {MODULE_URL: ROOT / MODULE_URL.lstrip('/'), CONTRACT_URL: ROOT / CONTRACT_URL.lstrip('/')}
        cls.digests = {url: hashlib.sha256(path.read_bytes()).hexdigest() for url, path in routes.items()}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/':
                    body = b'<!doctype html><title>offline DOM-search contracts</title>'
                    content_type = 'text/html'
                elif self.path in routes:
                    body = routes[self.path].read_bytes()
                    content_type = 'text/javascript'
                    if hashlib.sha256(body).hexdigest() != cls.digests[self.path]:
                        self.send_error(500, 'source changed during run')
                        return
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        thread.start()
        cls.addClassCleanup(lambda: (cls.server.shutdown(), cls.server.server_close(), thread.join(3)))
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'
        cls.playwright = stack.enter_context(sync_playwright())
        cls.browsers = {}
        selected = os.environ.get('READER_DOM_SEARCH_BROWSER')
        if selected and selected not in ('chromium', 'firefox'):
            raise ValueError(f'unknown DOM-search browser: {selected}')
        for name in ((selected,) if selected else ('chromium', 'firefox')):
            browser = getattr(cls.playwright, name).launch(headless=True, args=['--no-sandbox'] if name == 'chromium' else [])
            cls.addClassCleanup(browser.close)
            cls.browsers[name] = browser
        if not cls.browsers:
            raise RuntimeError('no DOM-search browser selected')

    def run_contract(self, name):
        for browser_name, browser in self.browsers.items():
            with self.subTest(browser=browser_name):
                context = browser.new_context(service_workers='block')
                try:
                    # Browser contracts are offline; an unexpected remote request
                    # must fail, not quietly consume external content.
                    blocked = []
                    requested = []
                    def restrict(route):
                        if route.request.url.startswith(self.origin + '/'):
                            route.continue_()
                        else:
                            blocked.append(route.request.url)
                            route.abort()
                    context.route('**/*', restrict)
                    page = context.new_page()
                    errors, responses = [], []
                    logs = []
                    page.on('request', lambda request: requested.append(request.url))
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.on('console', lambda message: logs.append((message.type, message.text)))
                    page.on('response', lambda response: responses.append((response.url, response.status)))
                    response = page.goto(self.origin + '/', wait_until='domcontentloaded')
                    self.assertEqual(response.status, 200)
                    page.evaluate('''async ({url, name}) => {
                      const contracts = await import(url);
                      if (typeof contracts[name] !== 'function') throw new Error('missing contract: ' + name);
                      await contracts[name]();
                    }''', {'url': CONTRACT_URL, 'name': name})
                    self.assertEqual(errors, [])
                    self.assertEqual(logs, [])
                    self.assertEqual(blocked, [])
                    expected_urls = {self.origin + '/', self.origin + MODULE_URL, self.origin + CONTRACT_URL}
                    self.assertEqual(set(requested), expected_urls)
                    for url in (MODULE_URL, CONTRACT_URL):
                        self.assertEqual([status for actual, status in responses if actual == self.origin + url], [200])
                    print(f'DOM_SEARCH_CONTRACT_COMPLETED {browser_name} {name} {self.digests[MODULE_URL]}', flush=True)
                finally:
                    context.close()

    def test_literal_escape_snippets_and_pagination(self):
        self.run_contract('helpers')

    def test_cross_node_highlight_cleanup_and_stale_navigation(self):
        self.run_contract('crossNodeAndStaleNavigation')

    def test_progressive_paging_snapshot_reuse_and_activation(self):
        self.run_contract('progressivePagingAndReuse')

    def test_synchronous_mutation_invalidates_snapshot(self):
        self.run_contract('synchronousSnapshotInvalidation')

    def test_cancelled_search_cannot_publish_final_results(self):
        self.run_contract('cancellation')

    def test_heading_labels_and_excluded_text(self):
        self.run_contract('headingsAndExcludedNodes')

    def test_occurrence_selection_and_stale_navigation(self):
        self.run_contract('occurrenceSelection')

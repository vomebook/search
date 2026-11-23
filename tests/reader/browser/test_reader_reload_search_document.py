"""Real Reader reload -> Back -> search DOM, focus/scroll and Forward.

Serve the repository's actual documents/modules. Only search API data and the
text book are synthetic; no replacement Reader shell or extra search reload.
Both engines are required. Run through the task's namespace runner.
"""
import contextlib
import functools
import http.server
from pathlib import Path
import threading
import unittest
from urllib.parse import urlencode, urlsplit

from playwright.sync_api import expect, sync_playwright
from tests.search.browser.test_paging_recovery import FETCH_SCRIPT


ROOT = Path(__file__).resolve().parents[3]
PREFIX = "/search" if '/search/static/' in (ROOT / "static/reader.html").read_text() else ""
TEXT = "Reader history forward content.\n" * 80
SOURCE = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/history.txt"


@contextlib.contextmanager
def source_server():
    control = {"failures": set(), "failed_requests": [], "failure_seen": threading.Event()}

    class Handler(http.server.SimpleHTTPRequestHandler):
        def translate_path(self, path):
            clean = urlsplit(path).path
            if PREFIX and clean.startswith(PREFIX + "/"):
                clean = clean[len(PREFIX):]
            if clean in ("/", "/index.html"):
                clean = "/static/index.html"
            elif clean in ('/sw.js', '/manifest.json') or clean.startswith('/icons/'):
                clean = '/static' + clean
            return super().translate_path(clean)

        def do_GET(self):
            path = urlsplit(self.path).path
            if path in control['failures']:
                control['failed_requests'].append(path)
                control['failure_seen'].set()
                self.send_error(503, 'Controlled cache fallback')
                return
            # SW install fetches bypass Playwright page routes. Supply only the
            # synthetic corpus manifests/data; production SW/assets stay intact.
            if path.startswith(PREFIX + '/data/') and path.endswith('.json'):
                body, content_type = b'{}', 'application/json'
            elif path.startswith('/api/reader-content'):
                body, content_type = TEXT.encode(), 'text/plain; charset=utf-8'
            else:
                return super().do_GET()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def guess_type(self, path):
            if path.endswith((".mjs", ".js")):
                return "text/javascript"
            return super().guess_type(path)

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", control
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class ReaderReloadSearchDocumentCases:
    engine = None

    @classmethod
    def setUpClass(cls):
        stack = contextlib.ExitStack()
        cls.addClassCleanup(stack.close)
        cls.origin, cls.server_control = stack.enter_context(source_server())
        playwright = stack.enter_context(sync_playwright())
        cls.browser = getattr(playwright, cls.engine).launch(
            headless=True, **({"args": ["--no-sandbox"]} if cls.engine == "chromium" else {}))
        stack.callback(cls.browser.close)

    def setUp(self):
        self.server_control['failures'].clear()
        self.server_control['failed_requests'].clear()
        self.server_control['failure_seen'].clear()
        self.addCleanup(self.server_control['failures'].clear)
        self.context = self.browser.new_context(
            service_workers=('allow' if self._testMethodName ==
                             'test_controlled_worker_cache_fallback_preserves_reader_back' else 'block'),
            viewport={"width": 1280, "height": 800})
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.page.set_default_navigation_timeout(5000)
        self.page.add_init_script(FETCH_SCRIPT + """
          // Hold a real app search consumer's response only on the return load.
          // Keep the synthetic API payload unchanged and deliberately ignore abort.
          if (window === window.top && sessionStorage.getItem('test-hold-return') &&
              !location.pathname.endsWith('reader.html')) {
            sessionStorage.removeItem('test-hold-return');
            const fetchSearch = window.fetch;
            window.fetch = (input, options) => {
              let body = {};
              try { body = JSON.parse(options?.body || '{}'); } catch (_) {}
              const response = fetchSearch(input, options);
              if (String(input).includes('/api/search') && body.q === 'paging' && body.page === 1) {
                window.__returnHeld = true;
                return new Promise(resolve => {
                  window.__releaseReturn = () => Promise.resolve(response).then(value => {
                    window.__returnReleased = true; resolve(value);
                  });
                });
              }
              return response;
            };
          }
        """)
        # Observation only: capture the handoff before app startup consumes it,
        # and record whether the traversal was a real browser popstate.
        self.page.add_init_script("""(() => {
          if (window !== window.top) return;
          window.__arrivalHandoff = sessionStorage.getItem('reader-navigation-restore');
          addEventListener('popstate', event => {
            sessionStorage.setItem('test-reader-popstate', JSON.stringify({
              trusted: event.isTrusted, url: location.href
            }));
          });
        })();""")
        self.page.route('**/api/**', lambda route: route.fulfill(
            content_type='application/json',
            body='[]' if route.request.url.endswith(('/repos', '/extensions')) else '{}'))
        self.page.route('https://vomebook-hitokoto.hf.space/**', lambda route: route.fulfill(body='{}'))
        for pattern in ('**/api/reader-content**', SOURCE):
            self.page.route(pattern, lambda route: route.fulfill(
                content_type='text/plain; charset=utf-8', body=TEXT,
                headers={'Access-Control-Allow-Origin': '*'}))
        self.page.goto(self.search_url('paging'), wait_until='domcontentloaded')
        self.wait_search('paging')

    def search_url(self, query):
        route = '/search/#/?' if PREFIX else '/?'
        return self.origin + route + urlencode({'q': query, **({'local': '0'} if PREFIX else {})})

    def wait_search(self, query):
        self.page.locator('#search-input').wait_for(state='visible')
        self.page.wait_for_function('''query => typeof STATE !== 'undefined' &&
          STATE.query === query && !STATE.isLoading && STATE.results.length >= 100''', arg=query)
        self.assertEqual(self.page.locator('iframe.reader-overlay').count(), 0)
        self.assertEqual(self.page.locator('.reader-text').count(), 0)

    def open_and_reload(self):
        target = PREFIX + '/static/reader.html?' + urlencode({
            'ext': 'txt', 'url': SOURCE, 'title': 'History book'})
        self.assertTrue(self.page.evaluate('target => navigateToReader(target)', target))
        self.page.frame_locator('iframe.reader-overlay').locator('.reader-text').wait_for(state='visible')
        reader_url = self.page.url
        self.page.reload(wait_until='domcontentloaded')  # The one user Reader reload.
        self.page.locator('.reader-text').wait_for(state='visible')
        # Visibility can precede the first streamed text block.
        expect(self.page.locator('.reader-text')).to_contain_text('Reader history forward content.')
        self.assertEqual(self.page.locator('iframe.reader-overlay').count(), 0)
        return reader_url

    def test_native_back_from_reloaded_reader_hands_off_the_book_not_search(self):
        reader_url = self.open_and_reload()
        self.page.locator('[data-speech-toggle]').wait_for(timeout=10000)
        # Seed the playback cursor without contacting a speech service.
        self.page.evaluate('''() => {
          const old = window.CCRDSpeech;
          window.CCRDSpeech = {...old, state: () => ({playing:true, position:2,
            adapter:{partAt:()=>({unit:0,start:0,raw:'Fixture sentence'})}})};
          window.addEventListener('pagehide', () => {
            sessionStorage.setItem('test-speech-handoff', sessionStorage.getItem('reader-speech-handoff'));
          }, {once:true});
        }''')
        self.page.go_back(wait_until='domcontentloaded')
        self.page.locator('.reader-speech-mini').wait_for()
        handoff = self.page.evaluate("JSON.parse(sessionStorage.getItem('test-speech-handoff'))")
        self.assertEqual(handoff['readerUrl'], reader_url)
        self.assertEqual((handoff['unit'], handoff['offset']), (0, 2))

    def test_back_restores_search_focus_scroll_and_forward_book(self):
        self.page.locator('#search-input').focus()
        before = self.page.evaluate('''async () => {
          history.replaceState({...history.state, foreign: {keep: 'search-entry'}}, '', location.href);
          DOM.searchInput.setSelectionRange(1, 4, 'backward');
          setResultScrollTop(520); renderVisible();
          await new Promise(resolve => requestAnimationFrame(resolve));
          return {url: location.href, top: getResultScrollTop(), length: history.length};
        }''')
        reader_url = self.open_and_reload()
        self.assertEqual(self.page.evaluate('history.length'), before['length'] + 1)
        self.page.go_back(wait_until='domcontentloaded')
        # There is deliberately no page.reload() here: product popstate must load search.
        self.wait_search('paging')
        self.assertEqual(self.page.url, before['url'])
        self.page.wait_for_function('''top => document.activeElement === DOM.searchInput &&
          Math.abs(getResultScrollTop() - top) <= 2''', arg=before['top'])
        self.assertEqual(self.page.evaluate('history.state.foreign'), {'keep': 'search-entry'})
        self.assertEqual(self.page.evaluate('history.length'), before['length'] + 1)
        self.assertEqual(self.page.evaluate('''[DOM.searchInput.selectionStart,
          DOM.searchInput.selectionEnd, DOM.searchInput.selectionDirection]'''), [1, 4, 'backward'])
        self.assertEqual(self.page.evaluate("JSON.parse(sessionStorage.getItem('test-reader-popstate'))"),
                         {'trusted': True, 'url': before['url']})
        self.page.go_forward(wait_until='domcontentloaded')
        self.assertEqual(self.page.url, reader_url)
        # Depending on document reuse, Forward can restore the standalone Reader
        # or the host overlay; both must render the actual book.
        self.page.locator('.reader-text, iframe.reader-overlay').wait_for(state='visible')
        content = (self.page.frame_locator('iframe.reader-overlay').locator('.reader-text')
                   if self.page.locator('iframe.reader-overlay').count() else self.page.locator('.reader-text'))
        expect(content).to_contain_text('Reader history forward content.', timeout=15000)
        self.assertTrue(content.is_visible())
        self.assertEqual(self.page.evaluate('history.length'), before['length'] + 1)
        self.page.go_back(wait_until='domcontentloaded')
        self.wait_search('paging')
        self.assertEqual(self.page.url, before['url'])

    def assert_forward_book(self, reader_url, text):
        self.page.go_forward(wait_until='domcontentloaded')
        self.assertEqual(self.page.url, reader_url)
        self.page.locator('.reader-text, iframe.reader-overlay').wait_for(state='visible')
        document = (self.page.frame_locator('iframe.reader-overlay')
                    if self.page.locator('iframe.reader-overlay').count() else self.page)
        expect(document.locator('.reader-text')).to_contain_text(text)

    def test_toolbar_back_after_reload_restores_real_result_button_and_forward(self):
        search_url = self.page.url
        read = self.page.get_by_role('button', name='在线阅读：paging-4.txt', exact=True)
        read.focus()
        read.press('Enter')
        frame = self.page.frame_locator('iframe.reader-overlay')
        expect(frame.locator('.reader-text')).to_contain_text('Reader history forward content.')
        reader_url = self.page.url
        self.page.reload(wait_until='domcontentloaded')
        expect(self.page.locator('.reader-text')).to_contain_text('Reader history forward content.')
        length = self.page.evaluate('history.length')
        self.page.locator('#back').click()
        self.wait_search('paging')
        self.assertEqual(self.page.url, search_url)
        expect(read).to_be_focused()
        self.assertEqual(self.page.evaluate("JSON.parse(sessionStorage.getItem('test-reader-popstate'))"),
                         {'trusted': True, 'url': search_url})
        self.assert_forward_book(reader_url, 'Reader history forward content.')
        self.assertEqual(self.page.evaluate('history.length'), length)

    def test_overlay_fragment_scrolls_without_consuming_the_only_back(self):
        search_url = self.page.url
        base = SOURCE.rsplit('/', 1)[0] + '/'
        source = base + 'anchors.md'
        markdown = ('[Direct fragment](#section) · [Same file](anchors.md#section) · '
                    '[Missing fragment](#missing) · [Unsupported relative](../archive.chm?dl=1#ref)\n\n'
                    + 'Filler paragraph.\n\n' * 150 + '<a id="section"></a>\n\n## End\n\n' + 'More.\n\n' * 60)
        for pattern in ('**/api/reader-content**', source):
            self.page.route(pattern, lambda route: route.fulfill(
                content_type='text/markdown', body=markdown, headers={'Access-Control-Allow-Origin': '*'}))
        target = PREFIX + '/static/reader.html?' + urlencode({'ext': 'md', 'url': source})
        self.assertTrue(self.page.evaluate('target => navigateToReader(target)', target))
        reader_url = self.page.url
        frame = self.page.frame_locator('iframe.reader-overlay')
        article = frame.locator('.reader-markdown')
        self.assertEqual(article.get_by_role('link', name='Unsupported relative').get_attribute('href'),
                         base.removesuffix('main/') + 'archive.chm?dl=1#ref')
        for label in ('Direct fragment', 'Same file', 'Missing fragment'):
            link = article.get_by_role('link', name=label)
            link.press('Enter')
            self.assertEqual(link.evaluate('() => location.hash'), '')
            if label != 'Missing fragment':
                self.assertGreater(frame.locator('#viewport').evaluate('node => node.scrollTop'), 100)
        self.page.go_back(wait_until='domcontentloaded')
        self.page.locator('iframe.reader-overlay').wait_for(state='detached')
        self.wait_search('paging')
        self.assertEqual(self.page.url, search_url)
        self.page.go_forward(wait_until='domcontentloaded')
        self.assertEqual(self.page.url, reader_url)
        expect(self.page.frame_locator('iframe.reader-overlay').locator('.reader-markdown')).to_contain_text('Direct fragment')

    def test_back_then_forward_renders_book_without_consuming_forward_entry(self):
        search_url = self.page.url
        reader_url = self.open_and_reload()
        length = self.page.evaluate('history.length')
        self.page.go_back(wait_until='domcontentloaded')
        self.wait_search('paging')
        self.assertEqual(self.page.url, search_url)
        self.page.go_forward(wait_until='domcontentloaded')
        self.assertEqual(self.page.url, reader_url)
        self.page.locator('.reader-text, iframe.reader-overlay').wait_for(state='visible')
        content = (self.page.frame_locator('iframe.reader-overlay').locator('.reader-text')
                   if self.page.locator('iframe.reader-overlay').count() else self.page.locator('.reader-text'))
        expect(content).to_contain_text('Reader history forward content.', timeout=15000)
        self.assertTrue(content.is_visible())
        self.assertEqual(self.page.evaluate('history.length'), length)

    def test_two_step_back_loads_arrived_query_without_old_return_handoff(self):
        self.page.evaluate("history.replaceState({...history.state, foreign: 'older'}, '', location.href)")
        older_url = self.page.url
        # Search edits replace their current entry. Model a third-party-created
        # entry explicitly so go(-2) really lands on the older search document.
        self.page.evaluate("history.pushState({foreign: 'newer'}, '', location.href)")
        self.page.locator('#search-input').fill('paging-next')
        self.page.locator('#search-input').press('Enter')
        self.wait_search('paging-next')
        newer_url = self.page.url
        self.assertNotEqual(older_url, newer_url)
        self.open_and_reload()
        length = self.page.evaluate('history.length')
        self.page.evaluate('setTimeout(() => history.go(-2), 0)')
        self.wait_search('paging')
        self.assertEqual(self.page.url, older_url)
        self.assertEqual(self.page.evaluate('history.state.foreign'), 'older')
        self.assertIsNone(self.page.evaluate('window.__arrivalHandoff'))
        self.assertEqual(self.page.evaluate('history.length'), length)
        self.page.go_forward(wait_until='domcontentloaded')
        self.wait_search('paging-next')
        self.assertEqual(self.page.url, newer_url)

    def test_missing_return_session_still_loads_actual_arrived_document(self):
        expected_url = self.page.url
        self.open_and_reload()
        self.page.evaluate("sessionStorage.removeItem('reader-navigation-current')")
        length = self.page.evaluate('history.length')
        self.page.go_back(wait_until='domcontentloaded')
        self.wait_search('paging')
        self.assertEqual(self.page.url, expected_url)
        self.assertIsNone(self.page.evaluate('window.__arrivalHandoff'))
        self.assertEqual(self.page.evaluate('history.length'), length)

    def test_early_overlay_back_replays_once_when_module_load_fails(self):
        held = []
        self.page.route('**/static/reader.js*', lambda route: held.append(route))
        before = self.page.url
        self.page.locator('#search-input').focus()
        target = PREFIX + '/static/reader.html?' + urlencode({'ext': 'txt', 'url': SOURCE})
        self.assertTrue(self.page.evaluate('target => navigateToReader(target)', target))
        back = self.page.frame_locator('iframe.reader-overlay').locator('#back')
        back.wait_for(state='visible')
        self.page.wait_for_function('readerHost.overlay.contentDocument.readyState === "interactive"')
        self.assertTrue(held, 'reader entry request was not intercepted')
        reader_url = self.page.url
        self.page.evaluate('''() => {
          window.__backCalls = 0;
          const back = history.back.bind(history);
          history.back = () => { __backCalls++; back(); };
        }''')
        back.click()
        back.click()
        self.assertEqual(self.page.url, reader_url)
        self.assertEqual(self.page.evaluate('__backCalls'), 0)
        # Reject the module itself, not the book request. Forward must still
        # restore the original Reader entry after the one requested Back.
        for route in held:
            route.abort()
        # The search state is already ready behind the overlay. Wait for Back
        # to remove the iframe, not just for the overlay to be visually dismissed.
        self.page.locator('iframe.reader-overlay').wait_for(state='detached')
        self.wait_search('paging')
        self.assertEqual(self.page.url, before)
        self.assertEqual(self.page.evaluate('__backCalls'), 1)
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'search-input')
        self.page.unroute('**/static/reader.js*')
        self.page.go_forward(wait_until='commit')
        self.assertEqual(self.page.url, reader_url)
        expect(self.page.frame_locator('iframe.reader-overlay').locator('.reader-text')).to_contain_text(TEXT.strip().splitlines()[0])

    def test_toolbar_back_after_module_failure_on_reload_uses_saved_search_url(self):
        search_url = self.page.url
        self.open_and_reload()
        self.page.route('**/static/reader/core/reader-bindings.mjs*', lambda route: route.abort())
        self.page.reload(wait_until='load')
        self.assertEqual(self.page.locator('.reader-text').count(), 0)
        self.assertTrue(self.page.evaluate('history.state.voiceReaderOverlay && !new URL(location.href).searchParams.has("return")'))
        length = self.page.evaluate('history.length')
        self.page.locator('#back').click()
        self.wait_search('paging')
        self.assertEqual(self.page.url, search_url)
        self.assertEqual(self.page.evaluate('history.length'), length, 'toolbar return replaces the reloaded Reader entry')

    def test_failed_reader_reload_back_restores_search_document(self):
        search_url = self.page.url
        cdp = self.context.new_cdp_session(self.page) if self.engine == 'chromium' else None

        def navigation_history():
            history = cdp.send('Page.getNavigationHistory')
            return (history['currentIndex'],
                    [(entry['id'], entry['url']) for entry in history['entries']])

        # Chromium can report stale history.length in the overlay host, even
        # with service workers blocked. Baseline the search entry first and use
        # browser-owned entry IDs/URLs to reject additions or replacements.
        search_history = navigation_history() if cdp else None
        search_length = len(search_history[1]) if cdp else self.page.evaluate('history.length')
        target = PREFIX + '/static/reader.html?' + urlencode({
            'ext': 'txt', 'url': SOURCE, 'title': 'Failed history book'})
        self.assertTrue(self.page.evaluate('target => navigateToReader(target)', target))
        self.page.frame_locator('iframe.reader-overlay').locator('.reader-text').wait_for(state='visible')
        reader_url = self.page.url
        length = search_length + 1
        if cdp:
            reader_index, reader_entries = navigation_history()
            self.assertEqual(search_history[0], search_length - 1)
            self.assertEqual(search_history[1][-1][1], search_url)
            self.assertEqual(reader_index, search_history[0] + 1)
            self.assertEqual(len(reader_entries), length)
            self.assertEqual(reader_entries[:-1], search_history[1])
            self.assertEqual(reader_entries[-1][1], reader_url)
        else:
            self.assertEqual(self.page.evaluate('history.length'), length)

        def assert_preserved_history(offset):
            if cdp:
                self.assertEqual(navigation_history(), (reader_index + offset, reader_entries))
            self.assertEqual(self.page.evaluate('history.length'), length)
        # Fail the actual content transport on the user reload. Production
        # fail() cancels book work but leaves the Reader error document alive.
        for pattern in ('**/api/reader-content**', SOURCE):
            self.page.route(pattern, lambda route: route.fulfill(
                status=404, content_type='text/plain', body='Book unavailable',
                headers={'Access-Control-Allow-Origin': '*'}))
        self.page.reload(wait_until='domcontentloaded')
        self.page.locator('.reader-error').wait_for(state='visible')
        self.assertEqual(self.page.locator('iframe.reader-overlay').count(), 0)
        self.assertEqual(self.page.locator('.reader-text').count(), 0)
        assert_preserved_history(0)
        self.page.go_back(wait_until='domcontentloaded')
        # No fixture reload or direct fail() call: the error screen must keep
        # its real popstate listener until the document/runtime is disposed.
        self.page.locator('#search-input').wait_for(state='visible', timeout=5000)
        self.wait_search('paging')
        self.assertEqual(self.page.url, search_url)
        self.assertEqual(self.page.locator('.reader-error').count(), 0)
        assert_preserved_history(-1)
        self.assertEqual(self.page.evaluate("JSON.parse(sessionStorage.getItem('test-reader-popstate'))"),
                         {'trusted': True, 'url': search_url})
        # The failed Reader must remain the next entry, including its identity.
        # Forward may reuse the standalone document or mount an error overlay.
        self.page.go_forward(wait_until='domcontentloaded')
        self.assertEqual(self.page.url, reader_url)
        self.page.locator('.reader-error, iframe.reader-overlay').wait_for(state='visible')
        document = (self.page.frame_locator('iframe.reader-overlay')
                    if self.page.locator('iframe.reader-overlay').count() else self.page)
        document.locator('.reader-error').wait_for(state='visible')
        self.assertEqual(document.locator('.reader-text').count(), 0)
        assert_preserved_history(0)
        self.page.go_back(wait_until='domcontentloaded')
        self.wait_search('paging')
        self.assertEqual(self.page.url, search_url)
        assert_preserved_history(-1)

    def test_return_response_does_not_steal_new_user_focus(self):
        self.page.locator('#search-input').focus()
        # Stay at the top: scrolling saves a usable viewport preview, allowing
        # restoration to finish before the held validation response arrives.
        self.page.evaluate("DOM.searchInput.setSelectionRange(1, 4, 'backward')")
        self.open_and_reload()
        self.page.evaluate("sessionStorage.setItem('test-hold-return', '1')")
        self.page.go_back(wait_until='domcontentloaded')
        self.page.locator('#search-input').wait_for(state='visible')
        self.page.wait_for_function('window.__returnHeld === true && STATE.isLoading')
        self.assertIsNotNone(self.page.evaluate('window.__arrivalHandoff'))
        # Move focus with real keyboard input while keeping the route/view
        # unchanged: route invalidation must not hide a focus cancellation bug.
        search = self.page.locator('#search-input')
        search.click()
        search.press('Tab')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'settings-btn')
        expected_url = self.page.url
        self.page.evaluate('window.__releaseReturn()')
        self.page.wait_for_function('window.__returnReleased === true')
        self.wait_search('paging')
        self.page.evaluate('''() => new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)))''')
        self.assertEqual(search.input_value(), 'paging')
        self.assertEqual(self.page.url, expected_url)
        self.assertEqual(self.page.evaluate('STATE.query'), 'paging')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'settings-btn')
        self.assertEqual(self.page.locator('iframe.reader-overlay').count(), 0)

    def test_controlled_worker_cache_fallback_preserves_reader_back(self):
        self.page.wait_for_function('navigator.serviceWorker.controller !== null')
        controller = self.page.evaluate('navigator.serviceWorker.controller.scriptURL')
        self.assertEqual(controller, self.origin + PREFIX + '/sw.js')
        search_url = self.page.url
        self.page.locator('#search-input').click()
        search_length = self.page.evaluate('history.length')
        cdp = self.context.new_cdp_session(self.page) if self.engine == 'chromium' else None
        target = PREFIX + '/static/reader.html?' + urlencode({
            'ext': 'txt', 'url': SOURCE, 'title': 'Cached history book'})
        self.assertTrue(self.page.evaluate('target => navigateToReader(target)', target))
        self.page.frame_locator('iframe.reader-overlay').locator('.reader-text').wait_for(state='visible')
        reader_url = self.page.url
        # Chromium's renderer can report a stale history.length after the SW
        # controlled iframe opens. Inspect real entries, then verify standalone
        # length and traversal; never accept an extra entry from Reader reload.
        entries_before = cdp.send('Page.getNavigationHistory') if cdp else None
        if entries_before:
            self.assertEqual(len(entries_before['entries']), search_length + 1)
            self.assertEqual(entries_before['entries'][-2]['url'], search_url)
            self.assertEqual(entries_before['entries'][-1]['url'], reader_url)
        shell = PREFIX + '/static/reader.html'
        self.page.wait_for_function('''async shell => {
          const cached = await caches.match(shell);
          return !!cached && cached.ok && (await cached.text()).includes('reader.js');
        }''', arg=shell)
        self.server_control['failures'].add(shell)
        responses = []
        self.page.on('response', lambda response: responses.append(response)
                     if urlsplit(response.url).path == shell else None)
        self.page.reload(wait_until='domcontentloaded')
        self.page.locator('.reader-text').wait_for(state='visible')
        length = self.page.evaluate('history.length')
        self.assertEqual(length, search_length + 1)
        if cdp:
            entries_after = cdp.send('Page.getNavigationHistory')
            self.assertEqual(entries_after['currentIndex'], entries_before['currentIndex'])
            self.assertEqual([(entry['id'], entry['url']) for entry in entries_after['entries']],
                             [(entry['id'], entry['url']) for entry in entries_before['entries']])
        self.assertTrue(any(response.status == 200 and response.from_service_worker
                            for response in responses), 'Reader shell must come through the actual worker')
        # Worker cache-first still revalidates. Observe the server 503 as well as
        # the browser's cached 200, not merely an allow flag or CacheStorage key.
        self.assertTrue(self.page.evaluate('navigator.serviceWorker.controller !== null'))
        self.assertTrue(self.server_control['failure_seen'].wait(timeout=5),
                        'The worker must actually revalidate against the failing server')
        self.assertIn(shell, self.server_control['failed_requests'])
        self.page.go_back(wait_until='domcontentloaded')
        self.wait_search('paging')
        self.assertEqual(self.page.url, search_url)
        if PREFIX:
            self.assertEqual(self.page.evaluate('navigator.serviceWorker.controller.scriptURL'), controller)
        else:
            # Space intentionally bypasses search navigations. Firefox can load
            # that search document uncontrolled while registration stays active.
            active = self.page.evaluate('''async () => {
              const registration = await navigator.serviceWorker.getRegistration();
              return registration?.active?.scriptURL;
            }''')
            self.assertEqual(active, controller)
        self.assertEqual(self.page.evaluate('history.length'), length)
        if cdp:
            arrived = cdp.send('Page.getNavigationHistory')
            self.assertEqual(arrived['currentIndex'], entries_before['currentIndex'] - 1)
            self.assertEqual([(entry['id'], entry['url']) for entry in arrived['entries']],
                             [(entry['id'], entry['url']) for entry in entries_before['entries']])
        self.page.go_forward(wait_until='domcontentloaded')
        self.assertEqual(self.page.url, reader_url)
        self.page.locator('.reader-text, iframe.reader-overlay').wait_for(state='visible')
        content = (self.page.frame_locator('iframe.reader-overlay').locator('.reader-text')
                   if self.page.locator('iframe.reader-overlay').count() else self.page.locator('.reader-text'))
        # The text element can be visible before asynchronous Reader content is mounted.
        expect(content).to_contain_text('Reader history forward content.', timeout=15000)
        self.assertTrue(content.is_visible())
        # Forward may mount Reader in the uncontrolled Space search host. Check
        # the document rendering the book, not the parent host's controller.
        self.assertEqual(content.evaluate('() => navigator.serviceWorker.controller?.scriptURL'), controller)
        self.assertEqual(self.page.evaluate('history.length'), length)

    def test_reader_hash_traversal_keeps_live_reader_document(self):
        reader_url = self.open_and_reload()
        self.page.evaluate("window.__sameReader = true; location.hash = 'chapter-test'")
        self.page.go_back(wait_until='domcontentloaded')
        content = self.page.locator('.reader-text')
        expect(content).to_contain_text('Reader history forward content.')
        self.assertTrue(content.is_visible())
        self.assertEqual(self.page.url, reader_url)
        self.assertTrue(self.page.evaluate('window.__sameReader'))


class ReaderReloadSearchDocumentChromium(ReaderReloadSearchDocumentCases, unittest.TestCase):
    engine = 'chromium'


class ReaderReloadSearchDocumentFirefox(ReaderReloadSearchDocumentCases, unittest.TestCase):
    engine = 'firefox'


class ReaderTrueOfflineCases:
    """Pages reloads its cached shell and existing corpus with native fetch.

    No FETCH_SCRIPT or forced navigator.onLine. BFCache restoration alone is
    not evidence of the worker serving a document. Space has its own limited
    contract in the corresponding test file.
    """

    setUpClass = classmethod(ReaderReloadSearchDocumentCases.setUpClass.__func__)

    def setUp(self):
        self.context = self.browser.new_context(service_workers='allow')
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.page.set_default_timeout(15000)
        self.page.set_default_navigation_timeout(15000)
        # Only warm-up book bytes are synthetic. Remove every route before
        # set_offline; neither fetch nor navigator.onLine is overridden.
        for pattern in ('**/api/reader-content**', SOURCE):
            self.page.route(pattern, lambda route: route.fulfill(
                content_type='text/plain; charset=utf-8', body=TEXT,
                headers={'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'}))
        self.responses = []
        self.failed = []
        self.page.on('response', lambda response: self.responses.append(response))
        self.page.on('requestfailed', lambda request: self.failed.append(request))

    def wait_local_search(self, query):
        self.page.locator('#search-input').wait_for(state='visible')
        self.page.wait_for_function('''query => typeof STATE !== 'undefined' &&
          routeInitialized && !DOM.searchInput._earlySearchInput && STATE.query === query &&
          STATE.dataLoaded && STATE.useLocalMode && !STATE.isLoading &&
          STATE.total > 0 && STATE._resultBackend === 'local' &&
          getCorpusClient().inspect().worker instanceof Worker''', arg=query)
        self.assertEqual(self.page.locator('#search-input').input_value(), query)
        self.page.locator('#results-list .result-item').first.wait_for(state='visible')

    def assert_offline_reader_error(self):
        self.page.locator('.reader-error, iframe.reader-overlay').wait_for(state='visible')
        document = (self.page.frame_locator('iframe.reader-overlay')
                    if self.page.locator('iframe.reader-overlay').count() else self.page)
        error = document.locator('.reader-error')
        error.wait_for(state='visible')
        # Current text transport exposes the browser error (Chromium/Firefox
        # differ); recovery is the real Back control, not a fictional Retry UI.
        self.assertRegex(error.inner_text(), 'Failed to fetch|NetworkError|网络|重试|下载')
        self.assertEqual(document.locator('.reader-text').count(), 0)
        back = document.locator('#back')
        self.assertTrue(back.is_visible())
        self.assertTrue(back.is_enabled())
        self.assertFalse(error.evaluate('() => navigator.onLine'))
        return back

    def test_true_offline_reader_reload_back_forward(self):
        search_url = self.origin + PREFIX + '/#/?' + urlencode({'q': '手机'})
        self.page.goto(search_url, wait_until='domcontentloaded')
        self.page.locator('#search-input').wait_for(state='visible')
        self.page.wait_for_function('navigator.serviceWorker.controller !== null')
        self.assertEqual(self.page.evaluate('navigator.serviceWorker.controller.scriptURL'),
                         self.origin + PREFIX + '/sw.js')
        if PREFIX:
            # Reload under SW control so the initial corpus/module requests,
            # which may precede the first claim, are actually cached.
            self.page.reload(wait_until='domcontentloaded')
            # Use the repository's actual search_data.json.gz and native Worker,
            # not replace-corpus, synthetic search responses, or a saved preview.
            self.wait_local_search('手机')
            self.page.wait_for_function('''async () =>
              !!await caches.match('/search/data/search_data.json.gz')''')
        search_url = self.page.url
        target = PREFIX + '/static/reader.html?' + urlencode({
            'ext': 'txt', 'url': SOURCE, 'title': 'Offline history book'})
        self.assertTrue(self.page.evaluate('target => navigateToReader(target)', target))
        content = self.page.frame_locator('iframe.reader-overlay').locator('.reader-text')
        expect(content).to_contain_text('Reader history forward content.', timeout=15000)
        self.assertTrue(content.is_visible())
        reader_url = self.page.url
        shell = PREFIX + '/static/reader.html'
        # Await persistence of the actual loaded search/Reader dependencies;
        # warming uses real HTTP fetches through the production SW, never put().
        assets = self.page.evaluate('''() => {
          const frame = document.querySelector('iframe.reader-overlay');
          return [...new Set([performance, frame.contentWindow.performance].flatMap(p =>
            p.getEntriesByType('resource').map(entry => entry.name)).filter(url =>
              url.startsWith(location.origin + '/') && /\\.(?:m?js|css)(?:[?]|$)/.test(url)))];
        }''')
        self.page.evaluate('''async urls => {
          await Promise.all(urls.map(async url => {
            const response = await fetch(url);
            if (!response.ok) throw Error('Warm failed: ' + url);
            await response.arrayBuffer();
          }));
        }''', assets)
        self.page.wait_for_function('''async urls =>
          (await Promise.all(urls.map(url => caches.match(url)))).every(r => r?.ok)
        ''', arg=[shell, *assets])
        # Text book requests are cross-origin on Pages and API requests on
        # Space; neither production SW caches them. Expect an actionable error
        # after reload, not invented offline book persistence.
        self.page.unroute_all(behavior='wait')
        self.context.set_offline(True)
        self.failed.clear()
        self.responses.clear()
        response = self.page.reload(wait_until='domcontentloaded')
        self.assertEqual(response.status, 200)
        self.assertTrue(response.from_service_worker)
        self.assert_offline_reader_error()
        self.assertTrue(any('/api/reader-content' in request.url or request.url == SOURCE
                            for request in self.failed), 'Book transport must actually fail offline')
        length = self.page.evaluate('history.length')
        self.responses.clear()
        if PREFIX:
            self.page.go_back(wait_until='domcontentloaded')
            self.wait_local_search('手机')
            self.assertEqual(self.page.url, search_url)
            self.assertEqual(self.page.locator('.reader-error, .reader-text, iframe.reader-overlay').count(), 0)
            self.assertTrue(any(response.request.is_navigation_request() and
                                urlsplit(response.url).path == PREFIX + '/' and
                                response.status == 200 and response.from_service_worker
                                for response in self.responses),
                            'Back must load the actual cached search document, not only reuse BFCache')
            self.assertFalse(self.page.evaluate('navigator.onLine'))
            self.assertEqual(self.page.evaluate('history.length'), length)
        self.responses.clear()
        self.page.go_forward(wait_until='domcontentloaded')
        self.assertEqual(self.page.url, reader_url)
        back = self.assert_offline_reader_error()
        self.assertEqual(self.page.evaluate('history.length'), length)
        # Forward may reuse the already failed Reader document. The explicit
        # offline reload above is the SW evidence; do not mislabel reuse as fetch.
        if PREFIX:
            back.click()
            # Forward can mount Reader over an already-ready search host. Its
            # local search state can pass the readiness check before Back lands.
            self.page.wait_for_url(search_url, wait_until='commit')
            expect(self.page.locator('.reader-error, .reader-text, iframe.reader-overlay')).to_have_count(0)
            self.wait_local_search('手机')
            self.assertEqual(self.page.url, search_url)
            # A different query proves the restored native corpus can search
            # offline, beyond rendering the previous query's session preview.
            self.page.locator('#search-input').fill('电脑')
            self.page.locator('#search-input').press('Enter')
            self.wait_local_search('电脑')
            self.assertFalse(self.page.evaluate('navigator.onLine'))


class ReaderTrueOfflineChromium(ReaderTrueOfflineCases, unittest.TestCase):
    engine = 'chromium'


class ReaderTrueOfflineFirefox(ReaderTrueOfflineCases, unittest.TestCase):
    engine = 'firefox'

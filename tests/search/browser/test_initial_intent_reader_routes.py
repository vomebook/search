"""Controlled initial-response ownership and Reader history traversal regressions.

Uses the real app/router/search pipeline; only transport and Reader document are
controlled. The paging fixture supplies enough real result rows to test scroll.
"""
import os
import unittest
from unittest import mock
from urllib.parse import urlsplit

from tests.search.browser import test_paging_recovery as paging


def evaluate_bounded(page, expression, arg=None):
    """Playwright evaluate has no timeout; bound controlled async test work."""
    return page.evaluate('''async arg => {
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => (''' + expression + ''')(arg)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Controlled evaluation exceeded 5000ms')), 5000);
          })
        ]);
      } finally { clearTimeout(timer); }
    }''', arg)


class InitialIntentReaderRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # The existing CI runner executes this suite in both browser engines.
        browser = os.environ.get('SIDEBAR_PAYLOAD_TEST_BROWSER', 'chromium')
        if browser not in ('chromium', 'firefox'):
            raise ValueError(f'unknown browser {browser}')
        fixture = paging.PagingRecoveryTests
        fixture.server = paging.local_server()
        fixture.origin, fixture.server_state = fixture.server.__enter__()
        fixture.playwright = paging.sync_playwright().start()
        try:
            fixture.browser = getattr(fixture.playwright, browser).launch(headless=True)
        except Exception:
            fixture.playwright.stop()
            fixture.server.__exit__(None, None, None)
            raise

    @classmethod
    def tearDownClass(cls):
        paging.PagingRecoveryTests.tearDownClass()

    def setUp(self):
        self.fixture = paging.PagingRecoveryTests()
        new_context = self.fixture.browser.new_context

        def online_context(*args, **kwargs):
            # This fixture controls network responses; SW fetches bypass page routes.
            kwargs['service_workers'] = 'block'
            context = new_context(*args, **kwargs)
            context.add_init_script("Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => true});")
            return context

        with mock.patch.object(self.fixture.browser, 'new_context', side_effect=online_context):
            self.fixture.setUp()
        self.page = self.fixture.page
        self.reader_requests = []

        def reader_document(route):
            self.reader_requests.append(route.request.url)
            route.fulfill(content_type='text/html', body='<body>controlled reader</body>')

        self.page.route(lambda url: urlsplit(url).path.endswith('/static/reader.html'), reader_document)
        self.page.evaluate('''() => {
          window.searchUrl = query => location.pathname.startsWith('/search/')
            ? '/search/#/?q=' + query + '&local=0' : '/?q=' + query;
          window.readerUrl = location.pathname.startsWith('/search/')
            ? '/search/static/reader.html?ext=txt' : '/static/reader.html?ext=txt';
        }''')

    def tearDown(self):
        errors = list(self.fixture.errors)
        self.fixture.tearDown()
        self.assertEqual(errors, [])

    def evaluate_bounded(self, expression, arg=None):
        return evaluate_bounded(self.page, expression, arg)

    def hold_initial_and_search(self):
        self.page.evaluate('''() => {
          cancelSearchPrefetch();
          searchResponseCache.clear(); initialPayloadCache.clear(); resultSnapshots.snapshots.clear();
          STATE.query = ''; STATE.page = 1;
          if (typeof readInitialSearchPayload === 'function') readInitialSearchPayload = () => null;
          window.initialFlights = []; window.searchFlights = [];
          const nativeJson = fetchJsonWithTimeout, nativeFetch = window.fetch;
          fetchJsonWithTimeout = (url, ...args) => String(url).includes('data/initial/')
            ? new Promise((resolve, reject) => initialFlights.push({resolve, reject, url}))
            : nativeJson(url, ...args);
          window.fetch = (input, options) => {
            if (!String(input).includes('/api/search')) return nativeFetch(input, options);
            const body = JSON.parse(options?.body || '{}');
            return new Promise(resolve => searchFlights.push({body, signal:options.signal,
              release: file => resolve(new Response(JSON.stringify({page:body.page,
                page_size:body.page_size,total:1,results:[{Repo:'VoiceOfML/Test',
                File:file,Extension:'txt',Folder:[],Size:12}]}),
                {headers:{'Content-Type':'application/json'}}))}));
          };
          window.payload = file => ({mode:'global',total:1,
            results:[{Repo:'VoiceOfML/Test',File:file,Extension:'txt',Folder:[],Size:12}]});
          window.oldInitial = searchWithInitialFallbackFresh();
        }''')
        self.page.wait_for_function('initialFlights.length === 1')

    def late_same_key(self, failure):
        self.hold_initial_and_search()
        self.page.evaluate('() => { doSearch(); }')
        self.page.wait_for_function('searchFlights.length === 1')
        observed = self.evaluate_bounded('''async failure => {
          if (failure) initialFlights[0].reject(new Error('controlled initial failure'));
          else initialFlights[0].resolve(payload('obsolete initial'));
          await oldInitial;
          return {requests:searchFlights.length, aborted:searchFlights[0].signal.aborted,
            obsolete:STATE.results.some(row => row.File === 'obsolete initial'),
            cached:initialPayloadCache.has(initialFlights[0].url)};
        }''', failure)
        self.assertEqual(observed, dict(requests=1, aborted=False, obsolete=False, cached=False))
        self.page.evaluate("searchFlights[0].release('newer search')")
        self.page.wait_for_function("!STATE.isLoading && STATE.results[0]?.File === 'newer search'")
        self.assertIn('newer search', self.page.locator('#results-list').inner_text())
        self.assertEqual(self.page.evaluate("getCachedSearchResponse(getCurrentSearchCacheKey(1)).results[0].File"), 'newer search')

    def test_late_success_cannot_abort_same_key_search_or_write_cache(self):
        self.late_same_key(False)

    def test_late_failure_cannot_start_extra_same_key_search(self):
        self.late_same_key(True)

    def test_a_b_a_initial_success_keeps_newest_a(self):
        self.hold_initial_and_search()
        self.page.evaluate("() => { STATE.query = 'B'; doSearch(); }")
        self.page.wait_for_function('searchFlights.length === 1')
        self.page.evaluate("searchFlights[0].release('B result')")
        self.page.wait_for_function("!STATE.isLoading && STATE.results[0]?.File === 'B result'")
        self.page.evaluate("() => { STATE.query = ''; STATE.page = 1; window.newInitial = searchWithInitialFallbackFresh(); }")
        self.page.wait_for_function('initialFlights.length === 2')
        self.evaluate_bounded("async () => { initialFlights[1].resolve(payload('new A')); await newInitial; }")
        self.evaluate_bounded("async () => { initialFlights[0].resolve(payload('old A')); await oldInitial; }")
        self.assertEqual(self.page.evaluate('STATE.results[0].File'), 'new A')
        self.assertEqual(self.page.evaluate('initialPayloadCache.get(initialFlights[0].url).results[0].File'), 'new A')
        self.assertEqual(self.page.evaluate('searchFlights.length'), 1)

    def test_a_b_a_initial_failure_does_not_restart_latest_a(self):
        self.hold_initial_and_search()
        self.page.evaluate("() => { STATE.query = 'B'; doSearch(); }")
        self.page.wait_for_function('searchFlights.length === 1')
        self.page.evaluate("searchFlights[0].release('B result')")
        self.page.wait_for_function("!STATE.isLoading && STATE.results[0]?.File === 'B result'")
        self.page.evaluate("() => { STATE.query = ''; STATE.page = 1; window.newInitial = searchWithInitialFallbackFresh(); }")
        self.page.wait_for_function('initialFlights.length === 2')
        self.evaluate_bounded("async () => { initialFlights[0].reject(new Error('old A failed')); await oldInitial; }")
        self.assertEqual(self.page.evaluate('searchFlights.length'), 1)
        self.evaluate_bounded("async () => { initialFlights[1].resolve(payload('new A')); await newInitial; }")
        self.assertEqual(self.page.evaluate('STATE.results[0].File'), 'new A')

    def test_same_key_snapshot_restore_invalidates_initial_payload(self):
        self.hold_initial_and_search()
        self.evaluate_bounded('''async () => {
          applyInitialSearchPayload(payload('saved result'));
          const key = getSearchViewKey();
          saveSearchViewSnapshot(key);
          restoreSearchViewSnapshot(key);
          initialFlights[0].resolve(payload('obsolete initial'));
          await oldInitial;
        }''')
        self.assertEqual(self.page.evaluate('STATE.results[0].File'), 'saved result')
        self.assertEqual(self.page.evaluate('searchFlights.length'), 0)

    def test_new_search_owns_same_key_while_viewport_read_is_pending(self):
        self.hold_initial_and_search()
        self.evaluate_bounded('''async () => {
          initialFlights[0].resolve(payload('seed')); await oldInitial;
          resultSnapshots.snapshots.clear(); initialPayloadCache.clear(); searchResponseCache.clear();
          displayedSearchView = null;
          getReturnPositionTarget = () => ({index:0});
          readSearchViewport = () => new Promise(resolve => { window.releaseViewport = resolve; });
          window.restoring = searchWithInitialFallback();
        }''')
        self.page.wait_for_function("typeof releaseViewport === 'function'")
        self.page.evaluate('() => { doSearch(); }')
        self.page.wait_for_function('searchFlights.length === 1')
        self.evaluate_bounded('async () => { releaseViewport(null); await restoring; }')
        self.assertEqual(self.page.evaluate('initialFlights.length'), 1)
        self.assertEqual(self.page.evaluate('searchFlights.length'), 1)
        self.assertFalse(self.page.evaluate('searchFlights[0].signal.aborted'))
        self.page.evaluate("searchFlights[0].release('new owner')")
        self.page.wait_for_function("!STATE.isLoading && STATE.results[0]?.File === 'new owner'")

    def test_path_only_route_keeps_initial_request_ownership(self):
        self.page.evaluate('''() => {
          history.replaceState(null, '', location.pathname.startsWith('/search/')
            ? '/search/#/Test?q=paging-repo&local=0' : '/Test?q=paging-repo');
          ROUTER.apply();
        }''')
        self.page.wait_for_function("STATE.mode === 'repo' && !STATE.isLoading && STATE._loadedPage === 1")
        self.page.evaluate('''() => {
          initialPayloadCache.clear(); STATE.query = ''; STATE.page = 1;
          if (typeof readInitialSearchPayload === 'function') readInitialSearchPayload = () => null;
          const nativeJson = fetchJsonWithTimeout, initialUrl = getInitialPayloadUrl();
          window.repoInitialRequests = 0;
          fetchJsonWithTimeout = (url, ...args) => {
            if (url !== initialUrl) return nativeJson(url, ...args);
            repoInitialRequests++;
            return new Promise(resolve => { window.releaseRepo = resolve; });
          };
          window.pendingRepo = searchWithInitialFallbackFresh();
          window.repoInitialIntent = searchIntentId;
          ROUTER.navigate('repo', 'Test', 'docs');
        }''')
        self.page.wait_for_function("STATE.browserPath === 'docs'")
        self.assertEqual(self.page.evaluate('repoInitialRequests'), 1)
        self.assertTrue(self.page.evaluate('searchIntentId === repoInitialIntent'))
        self.evaluate_bounded('''async () => {
          releaseRepo({repo:'VoiceOfML/Test',total:1,results:[{Repo:'VoiceOfML/Test',
            File:'path initial',Extension:'txt',Folder:[],Size:12}]});
          await pendingRepo;
        }''')
        self.assertEqual(self.page.evaluate('STATE.results[0].File'), 'path initial')
        self.assertEqual(self.page.evaluate('STATE.browserPath'), 'docs')
        self.assertIn('path=docs', self.page.url)

    def create_search_history(self):
        self.page.evaluate("history.replaceState(null, '', searchUrl('paging-A')); ROUTER.apply()")
        self.page.wait_for_function("STATE.query === 'paging-A' && !STATE.isLoading && STATE._loadedPage === 1")
        self.page.evaluate("history.pushState(null, '', searchUrl('paging-B')); ROUTER.apply()")
        self.page.wait_for_function("STATE.query === 'paging-B' && !STATE.isLoading && STATE._loadedPage === 1")
        self.page.evaluate('''() => {
          window.routeApplications = 0;
          const apply = ROUTER.apply;
          ROUTER.apply = function(...args) { routeApplications++; return apply.apply(this, args); };
          if (!navigateToReader(readerUrl) || !readerOverlay)
            throw new Error('Controlled Reader URL was rejected: ' + readerUrl);
        }''')
        self.page.wait_for_function("readerOverlay?.contentDocument?.body?.textContent === 'controlled reader'", timeout=5000)
        self.assertTrue(self.reader_requests, 'Reader document did not reach the controlled route')

    def test_reader_go_minus_two_and_forward_reconcile_search_only_once(self):
        self.create_search_history()
        self.page.evaluate('history.go(-2)')
        self.page.wait_for_function("!readerOverlay && STATE.query === 'paging-A' && !STATE.isLoading")
        self.evaluate_bounded('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        self.assertEqual(self.page.evaluate('routeApplications'), 1)
        self.assertEqual(self.page.locator('#search-input').input_value(), 'paging-A')
        self.page.evaluate('history.forward()')
        self.page.wait_for_function("STATE.query === 'paging-B' && !STATE.isLoading")
        self.page.evaluate('history.forward()')
        self.page.wait_for_function('!!readerOverlay')
        self.assertEqual(self.page.evaluate('STATE.query'), 'paging-B')
        self.assertEqual(self.page.evaluate('routeApplications'), 2)
        self.page.evaluate('history.back()')
        self.page.wait_for_function('!readerOverlay')
        self.assertEqual(self.page.evaluate('routeApplications'), 2)

    def test_same_route_reader_back_keeps_pending_search_and_scroll(self):
        self.page.evaluate('''() => {
          DOM.searchInput.focus(); setResultScrollTop(900);
          STATE.page = 2; doSearch(true);
          window.beforeReader = {top:getResultScrollTop(),request:searchRequestId,controller:searchAbortController};
          navigateToReader(readerUrl); history.back();
        }''')
        self.page.wait_for_function('!readerOverlay')
        self.assertTrue(self.page.evaluate('searchRequestId === beforeReader.request && searchAbortController === beforeReader.controller'))
        self.assertFalse(self.page.evaluate('searchAbortController.signal.aborted'))
        self.assertTrue(self.page.evaluate('document.activeElement === DOM.searchInput'))
        self.assertLessEqual(abs(self.page.evaluate('getResultScrollTop() - beforeReader.top')), 1)

    def test_reader_timeout_reconciles_changed_return_destination(self):
        self.create_search_history()
        self.page.evaluate('''() => {
          const src = new URL(readerOverlay.src);
          src.searchParams.set('return', new URL(searchUrl('paging-A'), location.origin).href);
          readerOverlay.src = src.href;
        }''')
        self.page.wait_for_function("readerOverlay?.contentDocument?.body?.textContent === 'controlled reader'")
        self.page.evaluate('''() => {
          history.back = () => {};
          handleReaderMessage({origin:location.origin,source:readerOverlay.contentWindow,
            data:{type:'voice-reader-close'}});
        }''')
        recovery = self.page.get_by_role('link', name='直接打开搜索页')
        recovery.wait_for(state='visible', timeout=5000)
        self.assertTrue(self.page.evaluate('!!readerOverlay && history.state.voiceReaderOverlay'))
        self.assertEqual(self.page.evaluate('STATE.query'), 'paging-B')
        self.assertEqual(self.page.evaluate('routeApplications'), 0)
        with self.page.expect_navigation(wait_until='domcontentloaded'):
            recovery.click()
        self.page.wait_for_function("!readerOverlay && STATE.query === 'paging-A' && !STATE.isLoading", timeout=5000)
        self.assertEqual(self.page.locator('#search-input').input_value(), 'paging-A')

"""Focused browser regressions for resumed and stalled result pagination."""
import unittest

from tests.browser_support import local_server
from playwright.sync_api import sync_playwright


FETCH_SCRIPT = r"""(() => {
  const nativeFetch = window.fetch.bind(window);
  window.pagingMode = 'stall';
  window.pagingTotal = 301;
  window.pagingRequests = [];
  window.fetch = function(input, options) {
    let body = {};
    try { body = JSON.parse(options && options.body || '{}'); } catch (_) {}
    if (!String(input).includes('/api/search') || !String(body.q || '').startsWith('paging')) return nativeFetch(input, options);
    window.pagingRequests.push(body.page);
    const response = (stale = false) => new Response(JSON.stringify({
      page: body.page, page_size: body.page_size, total: window.pagingTotal,
      results: Array.from({length: Math.min(body.page_size, Math.max(0, window.pagingTotal - (body.page - 1) * body.page_size))}, (_, offset) => {
        const id = (body.page - 1) * body.page_size + offset;
        return {ID: String(id), Repo: 'VoiceOfML/Test', File: (stale ? 'stale-' : 'paging-') + id,
          Extension: 'txt', Folder: [], Size: id + 1, HasTxt: false};
      })
    }), {headers: {'Content-Type': 'application/json'}});
    if (body.page === 2 && window.pagingMode === 'stall') {
      // Deliberately ignore AbortSignal to verify late results cannot win.
      return new Promise(resolve => { window.releaseStalePage = () => resolve(response(true)); });
    }
    if (body.page === 2 && window.pagingMode === 'fail') return Promise.resolve(new Response('{}', {status: 503}));
    return Promise.resolve(response());
  };
})();"""


class PagingRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = local_server()
        cls.origin, cls.server_state = cls.server.__enter__()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1280, 'height': 800})
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.add_init_script(FETCH_SCRIPT)
        self.page.route('**/api/**', lambda route: route.fulfill(
            content_type='application/json', body='[]' if route.request.url.endswith(('/repos', '/extensions')) else '{}'))
        self.page.route('https://vomebook-hitokoto.hf.space/**', lambda route: route.fulfill(body='{}'))
        self.page.goto(self.origin + '/search/#/?q=paging&local=0', wait_until='domcontentloaded')
        self.page.wait_for_function('STATE._loadedPage === 1 && !STATE.isLoading && window.pagingRequests.includes(2)')

    def tearDown(self):
        self.context.close()

    def reach_bottom(self):
        self.page.evaluate('DOM.resultsContainer.scrollTop = DOM.resultsContainer.scrollHeight')
        self.page.wait_for_function('STATE.isLoading && STATE._pendingPage === 2')

    def expire_pending(self, mode):
        self.page.evaluate('''mode => {
          window.pagingMode = mode;
          pendingSearchPages.forEach(entry => { entry.deadline = Date.now() - 1; });
          document.dispatchEvent(new Event('visibilitychange'));
        }''', mode)

    def test_resume_retries_missing_page_and_discards_late_response(self):
        self.reach_bottom()
        self.page.evaluate('for (let i = 0; i < 30; i++) maybeLoadNextPage()')
        self.assertEqual(self.page.evaluate('pagingRequests.filter(page => page === 2).length'), 1)
        self.expire_pending('normal')
        self.page.wait_for_function('STATE._loadedPage === 2 && !STATE.isLoading')
        self.page.evaluate('releaseStalePage()')
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.evaluate('STATE.results.map(record => record.ID)'), [str(i) for i in range(200)])
        self.assertEqual(self.page.evaluate('STATE.page'), 2)
        self.assertFalse(self.page.evaluate('STATE.results.some(record => record.File.startsWith("stale-"))'))
        self.assertEqual(self.page.evaluate('pagingRequests.filter(page => page === 2).length'), 2)
        self.assertEqual(self.errors, [])

    def test_loading_keeps_footer_height_and_does_not_show_status_text(self):
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.evaluate('''async()=>{
          STATE.isMobile=true;applyMobileMode();
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        }''')
        before = self.page.locator('#load-info').bounding_box()
        self.reach_bottom()
        self.assertTrue(self.page.locator('#paging-status').is_hidden())
        self.assertNotIn('加载中', self.page.locator('#load-info').inner_text())
        during = self.page.locator('#load-info').bounding_box()
        self.assertEqual(during['height'], before['height'])
        self.assertEqual(during['y'], before['y'])
        self.page.evaluate("pagingMode='normal';releaseStalePage()")
        self.page.wait_for_function('STATE._loadedPage >= 2 && !STATE.isLoading')
        self.assertTrue(self.page.locator('#paging-status').is_hidden())
        after = self.page.locator('#load-info').bounding_box()
        self.assertEqual(after['height'], before['height'])
        self.assertEqual(after['y'], before['y'])
        self.assertEqual(self.errors, [])

    def test_failure_retries_once_then_button_recovers_same_page(self):
        self.reach_bottom()
        self.expire_pending('fail')
        self.page.wait_for_function('pagingFailures === 2 && !STATE.isLoading')
        count = self.page.evaluate('pagingRequests.length')
        self.page.wait_for_timeout(1000)
        self.assertEqual(self.page.evaluate('pagingRequests.length'), count)
        self.assertEqual(self.page.evaluate('[STATE.page, STATE._loadedPage, STATE.results.length]'), [1, 1, 100])
        self.page.evaluate("window.pagingMode = 'normal'")
        self.page.locator('#paging-status').click()
        self.page.wait_for_function('STATE._loadedPage === 2 && !STATE.isLoading')
        self.assertEqual(self.page.evaluate('STATE.results.map(record => record.ID)'), [str(i) for i in range(200)])
        self.assertEqual(self.errors, [])

    def test_touch_at_bottom_retries_without_scroll_position_change(self):
        self.reach_bottom()
        self.expire_pending('fail')
        self.page.wait_for_function('pagingFailures === 2 && !STATE.isLoading')
        self.page.wait_for_timeout(800)
        self.page.evaluate("window.pagingMode = 'normal'; DOM.resultsContainer.dispatchEvent(new Event('touchend'))")
        self.page.wait_for_function('STATE._loadedPage === 2 && !STATE.isLoading')
        self.assertEqual(self.errors, [])

    def test_short_pages_fill_viewport_and_stop_at_total(self):
        self.page.evaluate('''() => {
          window.pagingMode = 'normal'; window.pagingTotal = 3;
          STATE.query = 'paging-small'; STATE.pageSize = 1; STATE.page = 1;
          doSearch();
        }''')
        self.page.wait_for_function('STATE.results.length === 3 && !STATE.isLoading && !STATE.hasMore')
        self.assertEqual(self.page.evaluate('STATE.results.map(record => record.ID)'), ['0', '1', '2'])
        self.assertEqual(self.page.evaluate('[STATE.page, STATE._loadedPage]'), [3, 3])
        self.assertEqual(self.errors, [])

    def test_new_query_invalidates_pending_append_and_retry(self):
        self.reach_bottom()
        self.page.evaluate('''() => {
          window.pagingMode = 'normal'; window.pagingTotal = 1;
          STATE.query = 'paging-new'; STATE.page = 1; doSearch();
        }''')
        self.page.wait_for_function('!STATE.isLoading && STATE.results.length === 1')
        self.page.evaluate('releaseStalePage()')
        self.page.wait_for_timeout(850)
        self.assertEqual(self.page.evaluate('[STATE.query, STATE.page, STATE._loadedPage, STATE.results.length]'), ['paging-new', 1, 1, 1])
        self.assertEqual(self.errors, [])

    def test_page_finishing_during_thumb_drag_is_consumed_once_on_resume(self):
        self.reach_bottom()
        self.page.evaluate("VSCROLL.isDraggingThumb = true; window.pagingMode = 'normal'; releaseStalePage()")
        self.page.wait_for_function('STATE._deferredAppendWhileDragging && !STATE.isLoading')
        self.assertEqual(self.page.evaluate('[STATE.page, STATE._loadedPage]'), [2, 1])
        self.page.evaluate('recoverScrollState()')
        self.page.wait_for_function('STATE._loadedPage === 2')
        self.assertEqual(self.page.evaluate('STATE.results.map(record => record.ID)'), [str(i) for i in range(200)])
        self.assertEqual(self.page.evaluate('STATE.page'), 2)
        self.assertEqual(self.errors, [])

    def test_worker_pagination_tracks_last_successful_page(self):
        self.page.evaluate('''async () => {
          await ensureLocalDataLoaded(false, true);
          STATE.useLocalMode = true; STATE.query = ''; STATE.page = 1;
          window.expectedLocalIds = (await doSearchLocal({q: '', page: 1, pageSize: 200,
            sort: 'relevance', searchFolders: true, exact: true})).results.map(getResultStableId);
          doSearch();
        }''')
        self.page.wait_for_function('STATE._loadedPage === 1 && !STATE.isLoading')
        self.page.evaluate('maybeLoadNextPage(false, true)')
        self.page.wait_for_function('STATE._loadedPage === 2 && !STATE.isLoading')
        self.assertEqual(self.page.evaluate('STATE.results.map(getResultStableId)'), self.page.evaluate('expectedLocalIds'))
        self.assertEqual(self.page.evaluate('STATE.page'), 2)
        self.assertEqual(self.errors, [])

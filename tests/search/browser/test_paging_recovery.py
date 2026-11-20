"""Focused browser regressions for resumed and stalled result pagination."""
import os
import unittest

from tests.support.browser_support import local_server
from playwright.sync_api import sync_playwright


FETCH_SCRIPT = r"""(() => {
  // This fixture serves an online API through fetch interception. A loopback-only
  // test namespace can report offline despite those responses being available.
  Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => true});
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
       results: Array.from({length: body.page === 2 && window.pagingMode === 'short' ? 1 : Math.min(body.page_size, Math.max(0, window.pagingTotal - (body.page - 1) * body.page_size))}, (_, offset) => {
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
        engine = os.environ.get('SEARCH_POSITION_BROWSER', 'chromium')
        cls.browser = getattr(cls.playwright, engine).launch(
            headless=True, **({'args': ['--no-sandbox']} if engine == 'chromium' else {}))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block', viewport={'width': 1280, 'height': 800})
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

    def test_updated_generation_relocates_without_mixing_ordinary_pages(self):
        self.page.evaluate(r'''() => {
          const previous = window.fetch;
          window.currentGeneration = 'A';
          window.fetch = (input, options) => {
            const body = JSON.parse(options?.body || '{}');
            if (body.q !== 'paging-generation') return previous(input, options);
            const generation = currentGeneration;
            if (generation === 'A' && body.page > 1) return new Promise(() => {});
            const all = Array.from({length:301}, (_, i) => ({Repo:'VoiceOfML/Test',
              File: 'paging-' + (generation === 'B' ? i - 1 : i), Extension:'txt', Folder:[], Size:1}));
            const anchor_index = body.anchor_id === undefined ? undefined : all.findIndex(r => getResultStableId(r) === body.anchor_id);
            return Promise.resolve(new Response(JSON.stringify({generation, total:301, page:body.page,
              page_size:body.page_size, anchor_index,
              results:all.slice((body.page-1)*body.page_size,body.page*body.page_size)})));
          };
          STATE.query = 'paging-generation'; doSearch(false, true);
        }''')
        self.page.wait_for_function("STATE._loadedPage === 1 && !STATE.isLoading && searchPageMetadata.get(STATE.results[0])?.generation === 'A'")
        self.page.evaluate("currentGeneration='B'; cancelSearchPrefetch(); STATE.page=2; doSearch(true)")
        self.page.wait_for_function("!positionRestore && resultWindow?.generation === 'B' && !STATE.isLoading")
        names = self.page.evaluate('STATE.results.filter(Boolean).map(r => r.File)')
        self.assertGreaterEqual(len(names), 200)
        self.assertEqual(names, ['paging-' + str(i) for i in range(-1, len(names) - 1)])
        self.assertEqual(self.page.evaluate('STATE.total'), 301)
        self.assertEqual(self.page.evaluate('STATE._resultBackend'), 'api')
        self.assertEqual(self.errors, [])

    def check_initial_generation_relocation(self, prefetched, initial_generation='different', local_ready=False):
        self.page.evaluate(r'''({initialGeneration, localReady}) => {
          cancelSearchPrefetch();
          searchResponseStore.cache.clear(); initialPayloadCache.clear(); resultSnapshots.snapshots.clear();
          const previous = window.fetch;
          // Initial/API generations are opaque equality tokens, not the data
          // manifest's generation. Both versions deliberately retain total 301.
          window.initialGenerationA = 'api:' + 'a'.repeat(64);
          window.initialGenerationB = 'api:' + 'b'.repeat(64);
          window.initialContinuationShift = initialGeneration === 'same' ? 0 : 1;
          window.initialContinuationRequests = [];
          let release;
          const continuation = new Promise(resolve => { release = resolve; });
          window.releaseInitialContinuation = release;
          const rows = shift => Array.from({length:301}, (_, i) => ({
            Repo:'VoiceOfML/Test', File:'initial-paging-' + (i - shift),
            Extension:'txt', Folder:[], Size:1, HasTxt:false
          }));
          window.fetch = (input, options) => {
            const response = data => new Response(JSON.stringify(data), {
              headers:{'Content-Type':'application/json'}
            });
            if (String(input).includes('data/initial/global.json')) {
              return Promise.resolve(response({mode:'global', page:1, page_size:100,
                total:301, generation:initialGeneration === 'missing' ? undefined
                  : initialGeneration === 'empty' ? ''
                  : initialGeneration === 'same' ? initialGenerationB : initialGenerationA,
                results:rows(0).slice(0,100)}));
            }
            if (!String(input).includes('/api/search')) return previous(input, options);
            const body = JSON.parse(options?.body || '{}');
            if (body.q) return previous(input, options);
            initialContinuationRequests.push(body);
            return continuation.then(() => {
              const all = rows(initialContinuationShift);
              const anchor_index = body.anchor_id === undefined ? undefined
                : all.findIndex(record => getResultStableId(record) === body.anchor_id);
              return response({generation:initialGenerationB, total:301, page:body.page,
                page_size:body.page_size, anchor_index,
                results:all.slice((body.page-1)*body.page_size, body.page*body.page_size)});
            });
          };
          STATE.query = ''; STATE.page = 1;
          STATE.useLocalMode = localReady;
          searchWithInitialFallbackFresh();
        }''', dict(initialGeneration=initial_generation, localReady=local_ready))
        self.page.wait_for_function('''STATE._initialActive && !STATE.isLoading
          && STATE._loadedPage === 1 && initialContinuationRequests.some(body => body.page === 2)''')
        self.assertEqual(self.page.evaluate('STATE.results.map(row => row.File)'),
                         ['initial-paging-' + str(i) for i in range(100)])
        self.page.evaluate('''() => {
          window.initialAnchor = getResultStableId(STATE.results[0]);
          window.initialRows = STATE.results.slice();
          window.initialDomRow = DOM.resultsList.querySelector('.result-item[data-index="0"]');
          window.initialRoute = location.hash;
        }''')
        if initial_generation == 'empty':
            self.assertEqual(self.page.evaluate('''() => {
              const cached = getCachedSearchResponse(getCurrentSearchCacheKey(1));
              STATE.results = cached.results;
              // Simulate a cache round trip for the same displayed view.
              displayedSearchView.results = STATE.results;
              return cached.generation;
            }'''), '')
        if local_ready:
            self.page.evaluate('''() => {
              window.initialLocalReady = ensureLocalDataLoaded(false, true).then(async ok => {
                if (!ok) throw new Error('Controlled local corpus did not load');
                const data = await doSearchLocal(buildLocalSearchParams(1));
                window.initialLocalGeneration = data.generation;
                window.initialLocalTotal = data.total;
                window.initialLocalIds = (await doSearchLocal({...buildLocalSearchParams(1),
                  pageSize:200})).results.map(getResultStableId);
                return true;
              });
            }''')
            self.page.wait_for_function('window.initialLocalIds?.length === 200 && STATE.dataLoaded')
        if prefetched:
            self.page.evaluate('releaseInitialContinuation()')
            self.page.wait_for_function('searchPrefetchAbortController.active.size === 0')
            if initial_generation == 'different':
                self.assertTrue(self.page.evaluate('apiAvailable'))
                self.assertEqual(self.page.evaluate('apiFailureCount'), 0)
                self.assertIsNone(self.page.evaluate('STATE._resultBackend'))
                self.assertTrue(self.page.evaluate('initialRows.every((row, i) => STATE.results[i] === row)'))
        else:
            self.page.evaluate('cancelSearchPrefetch(); releaseInitialContinuation()')
        self.page.evaluate('() => { STATE.page = 2; doSearch(true); }')
        # The buggy append also settles here, yielding a direct row-content
        # failure instead of timing out while waiting for a restore it never starts.
        self.page.wait_for_function('STATE._loadedPage >= 2 && !STATE.isLoading && !positionRestore')
        if local_ready:
            self.assertEqual(self.page.evaluate('STATE._resultBackend'), 'local')
            self.assertTrue(self.page.evaluate('STATE.useLocalMode'))
            self.assertTrue(self.page.evaluate('resultWindow?.generation === initialLocalGeneration'))
            self.assertEqual(self.page.evaluate('STATE.total'), self.page.evaluate('initialLocalTotal'))
            self.assertEqual(self.page.evaluate('STATE.results.filter(Boolean).slice(0,200).map(getResultStableId)'),
                             self.page.evaluate('initialLocalIds'))
            self.assertFalse(self.page.evaluate('initialContinuationRequests.some(body => body.page === 1)'))
            self.assertEqual(self.errors, [])
            return
        names = self.page.evaluate('STATE.results.filter(Boolean).map(row => row.File)')
        self.assertGreaterEqual(len(names), 200)
        shift = 0 if initial_generation == 'same' else 1
        self.assertEqual(names, ['initial-paging-' + str(i) for i in range(-shift, len(names) - shift)])
        if initial_generation == 'same':
            self.assertTrue(self.page.evaluate('resultWindow === null'))
            self.assertFalse(self.page.evaluate('initialContinuationRequests.some(body => body.page === 1)'))
            self.assertTrue(self.page.evaluate('initialRows.every((row, i) => STATE.results[i] === row)'))
            self.assertTrue(self.page.evaluate('''initialDomRow !== null && initialDomRow ===
              DOM.resultsList.querySelector('.result-item[data-index="0"]')'''))
        else:
            self.assertTrue(self.page.evaluate('resultWindow?.generation === initialGenerationB'))
            self.assertTrue(self.page.evaluate('''initialContinuationRequests.some(body =>
              body.page === 1 && body.anchor_id === initialAnchor)'''))
        self.assertEqual(self.page.evaluate('STATE.results.findIndex(row => row && getResultStableId(row) === initialAnchor)'), shift)
        self.assertEqual(self.page.evaluate('STATE.total'), 301)
        self.assertEqual(self.page.evaluate('STATE._resultBackend'), 'api')
        self.assertTrue(self.page.evaluate('location.hash === initialRoute'))
        self.assertEqual(self.errors, [])

    def test_initial_generation_relocates_before_api_append(self):
        self.check_initial_generation_relocation(prefetched=False)

    def test_initial_generation_relocates_before_prefetched_append(self):
        self.check_initial_generation_relocation(prefetched=True)

    def test_initial_without_generation_relocates_before_api_append(self):
        self.check_initial_generation_relocation(prefetched=False, initial_generation='missing')

    def test_initial_without_generation_relocates_before_prefetched_append(self):
        self.check_initial_generation_relocation(prefetched=True, initial_generation='missing')

    def test_initial_same_generation_appends_without_relocation(self):
        self.check_initial_generation_relocation(prefetched=False, initial_generation='same')

    def test_initial_same_generation_prefetch_appends_without_relocation(self):
        self.check_initial_generation_relocation(prefetched=True, initial_generation='same')

    def test_initial_prefetch_mismatch_preserves_ready_local_backend(self):
        self.check_initial_generation_relocation(prefetched=True, local_ready=True)

    def test_initial_empty_generation_cache_roundtrip_relocates_before_api_append(self):
        self.check_initial_generation_relocation(prefetched=False, initial_generation='empty')

    def test_initial_empty_generation_cache_roundtrip_relocates_before_prefetched_append(self):
        self.check_initial_generation_relocation(prefetched=True, initial_generation='empty')

    def reach_bottom(self):
        self.page.evaluate('DOM.resultsContainer.scrollTop = DOM.resultsContainer.scrollHeight')
        self.page.wait_for_function('STATE.isLoading && STATE._pendingPage === 2')

    def expire_pending(self, mode):
        self.page.evaluate('''mode => {
          window.pagingMode = mode;
          getSearchTransport().pending.forEach(entry => { entry.deadline = Date.now() - 1; });
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

    def test_recovery_projection_cannot_change_controller_or_retry_presentation(self):
        result = self.page.evaluate('''() => {
          resetPagingRecovery();
          finishPagingAttempt(false, {status: 400});
          const projection = pagingController.readRecovery();
          projection.failures = 0; projection.retryAt = 0;
          pagingFailures = 0;
          updatePagingStatus();
          const button = document.getElementById('paging-status');
          const failed = [pagingFailures, button.hidden, button.textContent];
          resetPagingRecovery();
          return {failed, reset: [pagingFailures, button.hidden, button.textContent]};
        }''')
        self.assertEqual(result['failed'], [2, False, '加载失败，重试'])
        self.assertEqual(result['reset'], [0, True, '加载失败，重试'])
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

    def test_truncated_nonempty_page_is_rejected_and_retry_preserves_all_ids(self):
        self.reach_bottom()
        self.expire_pending('short')
        self.page.wait_for_function('pagingFailures === 2 && !STATE.isLoading')
        self.assertEqual(self.page.evaluate('[STATE._loadedPage,STATE.results.length,STATE.total]'), [1,100,301])
        self.page.evaluate("pagingMode='normal'")
        self.page.locator('#paging-status').click()
        self.page.wait_for_function('STATE._loadedPage === 2 && !STATE.isLoading')
        self.assertEqual(self.page.evaluate('STATE.results.map(record=>record.ID)'), [str(i) for i in range(200)])
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

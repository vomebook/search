"""Current search/Reader traversal and deterministic input ownership regressions."""
import unittest
from tests.search.browser import test_paging_recovery as paging


class ReaderHostHistoryRaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        paging.PagingRecoveryTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        paging.PagingRecoveryTests.tearDownClass()

    def setUp(self):
        self.fixture = paging.PagingRecoveryTests()
        self.fixture.setUp()
        self.page = self.fixture.page
        self.page.route('**/static/reader.html?**', lambda route: route.fulfill(
            content_type='text/html', body='<body>reader</body>'))
        self.page.evaluate('''() => {
          window.historySearchUrl = (query, extra = '') => location.pathname.startsWith('/search/')
            ? '/search/#/?q=' + query + '&local=0' + extra : '/?q=' + query + extra;
          window.historyReaderUrl = () => location.pathname.startsWith('/search/')
            ? '/search/static/reader.html?ext=txt' : '/static/reader.html?ext=txt';
        }''')

    def tearDown(self):
        errors = list(self.fixture.errors)
        self.fixture.tearDown()
        self.assertEqual(errors, [])

    def test_product_automatically_saves_and_restores_search_session(self):
        self.page.locator('#search-input').fill('paging-auto-session')
        self.page.wait_for_function("STATE.query === 'paging-auto-session' && !STATE.isLoading && STATE._loadedPage === 1")
        saved_url = self.page.url
        self.page.wait_for_function('''expected => new Promise(resolve => {
          const request = indexedDB.open('voiceofml-search-state', 1);
          request.onerror = () => resolve(false);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('session', 'readonly');
            const read = tx.objectStore('session').get('last-search');
            let saved;
            read.onsuccess = () => { saved = read.result; };
            tx.oncomplete = () => { db.close(); resolve(saved?.url === expected); };
            tx.onabort = tx.onerror = () => { db.close(); resolve(false); };
          };
        })''', arg=saved_url)
        bare = '/search/' if '/search/' in saved_url else '/'
        self.page.goto(self.fixture.origin + bare, wait_until='domcontentloaded')
        self.page.wait_for_function("STATE.query === 'paging-auto-session' && !STATE.isLoading && STATE._loadedPage === 1")
        self.assertEqual(self.page.url, saved_url)
        self.assertEqual(self.page.locator('#search-input').input_value(), 'paging-auto-session')
        self.assertGreater(self.page.locator('#results-list .result-item').count(), 0)

    def test_go_minus_two_applies_destination_before_dispose_and_held_restoration(self):
        self.page.evaluate('''() => {
          history.replaceState({foreign:'B'}, '', historySearchUrl('paging-B', '&sort=size'));
          ROUTER.apply();
        }''')
        self.page.wait_for_function("STATE.query === 'paging-B' && !STATE.isLoading && STATE._loadedPage === 1")
        self.page.evaluate('''() => {
          history.pushState({foreign:'A'}, '', historySearchUrl('paging-A', '&sort=name'));
          ROUTER.apply();
        }''')
        self.page.wait_for_function("STATE.query === 'paging-A' && !STATE.isLoading && STATE._loadedPage === 1")
        self.page.evaluate('''() => {
          // Force B through asynchronous viewport restoration, while A still has
          // a live prefetch consumer. No test-only session save is involved.
          searchViewSnapshots.clear();
          const oldRead = readSearchViewport;
          readSearchViewport = key => JSON.parse(key).query === 'paging-B'
            ? new Promise(resolve => { window.releaseBViewport = () => resolve(null); }) : oldRead(key);
          const oldTarget = getReturnPositionTarget;
          getReturnPositionTarget = key => key && JSON.parse(key).query === 'paging-B'
            ? {version:1,key,index:1,offset:0,loadedPage:1,savedAt:Date.now()} : oldTarget(key);
          DOM.searchInput.focus();
          navigateToReader(historyReaderUrl());
          window.oldSearchId = searchRequestId;
        }''')
        self.page.wait_for_function("readerOverlay && readerOverlay.contentDocument?.body?.textContent === 'reader'")
        self.page.evaluate('''() => {
          readerOverlay.contentWindow.addEventListener('voice-reader-dispose', () => {
            window.atDispose = {query:STATE.query,sort:DOM.sortSelect.value,
              retired:searchRequestId > oldSearchId,overlayReleased:readerOverlay === null};
            // Reentrant close must be harmless.
            closeReaderOverlay();
            window.releaseStalePage();
          });
          history.go(-2);
        }''')
        self.page.wait_for_function('!!window.atDispose && typeof window.releaseBViewport === "function"')
        self.assertEqual(self.page.evaluate('atDispose'), dict(query='paging-B', sort='size', retired=True, overlayReleased=True))
        self.page.evaluate('releaseBViewport()')
        self.page.wait_for_function("STATE.query === 'paging-B' && !STATE.isLoading && STATE._loadedPage === 1")
        self.assertFalse(self.page.evaluate("STATE.results.some(r => r.File.startsWith('stale-'))"))
        self.assertTrue(self.page.evaluate("document.activeElement === DOM.searchInput"))
        self.assertIn('q=paging-B', self.page.url)

    def test_same_view_route_keeps_pending_filter_debounce(self):
        self.page.evaluate('''() => {
          STATE.filterExtensions = ['txt'];
          scheduleFilterSearch(true);
          window.pendingFilter = filterSearchTimer;
          ROUTER.apply(true);
          window.filterPreserved = filterSearchTimer === pendingFilter && filterSearchTimer !== null;
        }''')
        self.assertTrue(self.page.evaluate('filterPreserved'))
        self.page.wait_for_function('!STATE.isLoading && STATE._loadedPage === 1 && filterSearchTimer === null')
        self.assertEqual(self.page.evaluate('STATE.filterExtensions'), ['txt'])

    def test_replace_and_restore_yield_to_reader_opened_during_dispose(self):
        for action in ('replace', 'restore'):
            result = self.page.evaluate('''action => {
              const path = new URL(historyReaderUrl(), location.origin).pathname;
              navigateToReader(path + '?ext=txt&id=A');
              const first = readerOverlay;
              first.contentWindow.addEventListener('voice-reader-dispose', () => {
                navigateToReader(path + '?ext=txt&id=C');
              });
              if (action === 'replace') handleReaderMessage({origin:location.origin,source:first.contentWindow,
                data:{type:'voice-reader-open',url:path+'?ext=txt&id=B'}});
              else restoreReaderOverlay({voiceReaderOverlay:true,readerUrl:path+'?ext=txt&id=B'});
              const result = {id:new URL(readerOverlay.src).searchParams.get('id'),
                connected:readerOverlay.isConnected,count:document.querySelectorAll('iframe.reader-overlay').length};
              closeReaderOverlay(false,false);
              history.replaceState(null,'',historySearchUrl('paging'));
              return result;
            }''', action)
            self.assertEqual(result, dict(id='C', connected=True, count=1))

    def test_dispose_reentry_mounts_new_reader_without_outer_cleanup(self):
        result = self.page.evaluate('''() => {
          const path = new URL(historyReaderUrl(), location.origin).pathname;
          const nav = VoiceOfMLReaderNavigation.createNavigation(path);
          const first = nav.mount(new URL(path + '?ext=txt&id=first', location.origin));
          let second;
          first.contentWindow.addEventListener('voice-reader-dispose', () => {
            nav.unmount(false);
            second = nav.mount(new URL(path + '?ext=txt&id=second', location.origin));
          });
          nav.unmount(false);
          const result = {firstRemoved:!first.isConnected,secondConnected:second.isConnected,
            accepted:nav.accepts({origin:location.origin,source:second.contentWindow}),
            shaded:document.body.classList.contains('reader-overlay-open')};
          nav.unmount(false);
          return result;
        }''')
        self.assertTrue(all(result.values()), result)

    def test_same_view_reader_back_retains_flight_scroll_and_focus(self):
        self.page.evaluate('''() => {
          DOM.searchInput.focus();
          setResultScrollTop(900);
          // Keep a live foreground subscriber to the held page-2 prefetch.
          // Capture after this scroll's append request acquires its request ID.
          STATE.page = 2; doSearch(true);
          window.beforeReader = {top:getResultScrollTop(), request:searchRequestId, controller:searchAbortController};
          navigateToReader(historyReaderUrl());
          history.back();
        }''')
        self.page.wait_for_function('!readerOverlay')
        self.assertTrue(self.page.evaluate('searchRequestId === beforeReader.request && searchAbortController === beforeReader.controller'))
        self.assertTrue(self.page.evaluate('STATE.isLoading && STATE._pendingPage === 2 && !searchAbortController.signal.aborted'))
        self.assertEqual(self.page.evaluate('pagingRequests.filter(page => page === 2).length'), 1)
        self.assertTrue(self.page.evaluate('document.activeElement === DOM.searchInput'))
        self.assertLessEqual(abs(self.page.evaluate('getResultScrollTop() - beforeReader.top')), 1)

    def test_compositionstart_cancels_preexisting_debounce(self):
        self.page.evaluate('''() => {
          DOM.searchInput.value = 'paging-draft';
          DOM.searchInput.dispatchEvent(new Event('input', {bubbles:true}));
          DOM.searchInput.dispatchEvent(new CompositionEvent('compositionstart', {data:'中'}));
          DOM.searchInput.value = 'paging-中';
        }''')
        self.page.wait_for_timeout(180)
        self.assertEqual(self.page.evaluate('STATE.query'), 'paging')
        self.page.evaluate("DOM.searchInput.dispatchEvent(new CompositionEvent('compositionend', {data:'中'}))")
        self.page.wait_for_function("STATE.query === 'paging-中' && !STATE.isLoading")

    def test_early_script_delay_preserves_latest_fill(self):
        self.check_early_script_draft('edit')

    def test_early_script_delay_distinguishes_untouched_and_cleared_empty(self):
        for mode in ('untouched', 'clear'):
            with self.subTest(mode=mode):
                self.check_early_script_draft(mode)

    def test_early_script_delay_preserves_spanning_and_completed_ime(self):
        for mode in ('spanning', 'completed'):
            with self.subTest(mode=mode):
                self.check_early_script_draft(mode)

    def test_early_script_navigation_rejects_old_edit_and_ime_tails(self):
        for mode in ('edit', 'spanning', 'completed'):
            with self.subTest(mode=mode):
                self.check_early_script_draft(mode, navigate=True)

    def test_early_script_navigation_accepts_fresh_edit_and_composition(self):
        for mode in ('edit', 'spanning', 'completed'):
            with self.subTest(mode=mode):
                self.check_early_script_draft(mode, navigate=True, renew=True)

    def test_early_script_bare_landing_draft_preempts_saved_session(self):
        for mode in ('edit', 'clear', 'spanning', 'completed', 'untouched'):
            with self.subTest(mode=mode):
                self.check_early_script_draft(mode, bare=True)

    def check_early_script_draft(self, mode, navigate=False, renew=False, bare=False):
        held = []

        def hold_app(route):
            held.append(route)

        pattern = '**/static/app.js*'
        self.page.route(pattern, hold_app)
        base = '/search/#/?q=' if '/search/' in self.page.url else '/?q='
        suffix = '&local=0' if base.startswith('/search/') else ''
        target = self.fixture.origin + base + 'paging-before-bind' + suffix
        if bare:
            saved_url = self.fixture.origin + base + 'paging-saved-session' + suffix
            self.page.evaluate('''async url => {
              history.replaceState(null, '', url);
              await persistSearchSession();
              const db = await openSearchSessionDB();
              const saved = await new Promise((resolve, reject) => {
                const request = db.transaction('session', 'readonly').objectStore('session').get('last-search');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              db.close();
              if (saved?.url !== url) throw new Error('Saved session seed did not persist');
            }''', saved_url)
            target = self.fixture.origin + ('/search/' if base.startswith('/search/') else '/')
        # A hash-only goto on Pages retains the already-bound document.
        self.page.evaluate('url => history.replaceState(null, "", url)', target)
        self.page.reload(wait_until='commit')
        self.page.wait_for_function("!!document.querySelector('#search-input')?._earlySearchInput")
        self.assertEqual(self.page.evaluate('typeof setupSearchInput'), 'undefined')
        field = self.page.locator('#search-input')
        self.assertTrue(field.is_enabled())
        if navigate:
            self.page.evaluate('''target => {
              const original = location.href;
              history.replaceState(null, '', target);
              history.pushState(null, '', original);
            }''', self.fixture.origin + base + 'paging-before-bind-B' + suffix)
        if mode in ('edit', 'clear'):
            field.fill('paging-old-fill')
            field.fill('' if mode == 'clear' else 'paging-new-fill')
        elif mode != 'untouched':
            field.evaluate('''input => {
              input.focus();
              input.dispatchEvent(new CompositionEvent('compositionstart'));
              input.value = 'paging-早期';
              input.dispatchEvent(new InputEvent('input', {
                bubbles:true, isComposing:true, inputType:'insertCompositionText'
              }));
            }''')
        if navigate:
            self.page.evaluate('''() => new Promise(resolve => {
              window.addEventListener('popstate', resolve, {once:true});
              history.back();
            })''')
            # Let the accompanying hashchange finish before a deliberate B edit.
            self.page.wait_for_timeout(50)
        if mode == 'completed' or (renew and mode == 'spanning'):
            field.evaluate('''input => {
              input.dispatchEvent(new CompositionEvent('compositionend'));
              input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertCompositionText'}));
            }''')
        if navigate:
            self.assertTrue(field.evaluate('input => input._earlySearchInput.owner.cancelled'))
        if renew:
            if mode == 'edit':
                field.fill('paging-fresh-B')
            else:
                field.evaluate('''(input, completed) => {
                  input.dispatchEvent(new CompositionEvent('compositionstart'));
                  input.value = 'paging-fresh-B';
                  input.dispatchEvent(new InputEvent('input', {
                    bubbles:true, isComposing:true, inputType:'insertCompositionText'
                  }));
                  if (completed) input.dispatchEvent(new CompositionEvent('compositionend'));
                }''', mode == 'completed')
            self.assertFalse(field.evaluate('input => input._earlySearchInput.owner.cancelled'))
        draft = field.input_value()
        field.evaluate('input => input.setSelectionRange(3, 7, "backward")')
        selection = field.evaluate('input => [input.selectionStart, input.selectionEnd, input.selectionDirection]')
        # Keep a reference solely to verify that disposal removes all early listeners.
        field.evaluate('input => { window.earlyHandoff = input._earlySearchInput; }')
        for _ in range(500):
            if held:
                break
            self.page.wait_for_timeout(10)
        self.assertEqual(len(held), 1)
        route = held.pop()
        route.fulfill(response=route.fetch())
        self.page.unroute(pattern, hold_app)
        self.page.wait_for_function('typeof searchInputReady !== "undefined" && searchInputReady')
        self.assertFalse(field.evaluate('input => "_earlySearchInput" in input'))
        self.assertEqual(self.page.evaluate('searchComposing'), mode == 'spanning')
        current_query = 'paging-before-bind-B' if navigate else 'paging-before-bind'
        if bare:
            current_query = 'paging-saved-session' if mode == 'untouched' else ''
            self.assertEqual(self.page.evaluate('STATE.sessionRestored'), mode == 'untouched')
            if mode == 'untouched':
                self.assertEqual(self.page.url, saved_url)
            else:
                self.assertNotIn('paging-saved-session', self.page.url)
        rejected = navigate and not renew
        if mode == 'spanning' or rejected or mode == 'untouched':
            self.page.wait_for_timeout(180)
            self.assertEqual(self.page.evaluate('STATE.query'), current_query)
        if mode != 'untouched':
            self.assertEqual(field.input_value(), draft)
            self.assertEqual(field.evaluate('input => [input.selectionStart, input.selectionEnd, input.selectionDirection]'), selection)
        else:
            self.assertEqual(field.input_value(), current_query)
        if mode == 'spanning':
            field.evaluate('''input => {
              input.dispatchEvent(new CompositionEvent('compositionend'));
              input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertCompositionText'}));
            }''')
        if rejected:
            self.page.wait_for_timeout(180)
            self.assertEqual(self.page.evaluate('STATE.query'), current_query)
        elif mode != 'untouched':
            self.page.wait_for_function('query => STATE.query === query && !STATE.isLoading', arg=draft)
        # Normal input after adoption must work, without mutating the disposed state.
        early = self.page.evaluate('JSON.stringify(earlyHandoff)')
        field.fill('paging-after-bind')
        self.page.wait_for_function("STATE.query === 'paging-after-bind' && !STATE.isLoading")
        self.page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        self.assertEqual(self.page.evaluate('JSON.stringify(earlyHandoff)'), early)

    def test_initial_storage_wait_preserves_draft_and_composition(self):
        self.check_initial_storage_draft(False)

    def test_initial_storage_navigation_keeps_old_draft_without_submitting_in_b(self):
        self.check_initial_storage_draft(True)

    def test_initial_storage_navigation_accepts_new_edit_and_composition_in_b(self):
        self.check_initial_storage_draft(True, renew=True)

    def check_initial_storage_draft(self, navigate, renew=False):
        self.page.add_init_script('''(() => {
          const open = indexedDB.open.bind(indexedDB);
          window.releaseInitialStorage = [];
          window.holdInitialStorage = true;
          indexedDB.open = (...args) => {
            const request = open(...args);
            return new Proxy(request, {
              get: (target, key) => target[key],
              set(target, key, value) {
                target[key] = key === 'onsuccess' ? event => {
                  if (window.holdInitialStorage) releaseInitialStorage.push(() => value(event));
                  else value(event);
                } : value;
                return true;
              }
            });
          };
        })();''')
        for composing in (False, True):
            with self.subTest(composing=composing):
                self.page.reload(wait_until='domcontentloaded')
                self.page.wait_for_function('window.releaseInitialStorage?.length > 0')
                self.assertFalse(self.page.evaluate('routeInitialized'))
                if navigate:
                    self.page.evaluate('''() => {
                      const original = location.href;
                      const target = location.pathname.startsWith('/search/')
                        ? '/search/#/?q=paging-startup-B&local=0' : '/?q=paging-startup-B';
                      history.replaceState(null, '', target);
                      history.pushState(null, '', original);
                    }''')
                self.page.evaluate('''composing => {
                  DOM.searchInput.focus();
                  if (composing) DOM.searchInput.dispatchEvent(new CompositionEvent('compositionstart'));
                  DOM.searchInput.value = composing ? 'paging-early-composing' : 'paging-early';
                  DOM.searchInput.setSelectionRange(3, 7);
                  DOM.searchInput.dispatchEvent(new InputEvent('input', {bubbles:true, isComposing:composing}));
                  window.initialRouteQuery = new URLSearchParams(location.search || location.hash.split('?')[1]).get('q');
                }''', composing)
                if navigate:
                    self.page.evaluate('''() => new Promise(resolve => {
                      window.addEventListener('popstate', resolve, {once:true});
                      history.back();
                    })''')
                if renew:
                    self.page.evaluate('''composing => {
                      if (composing) {
                        DOM.searchInput.dispatchEvent(new CompositionEvent('compositionend'));
                        DOM.searchInput.dispatchEvent(new InputEvent('input', {
                          bubbles:true, inputType:'insertCompositionText'
                        }));
                      }
                    }''', composing)
                    self.assertFalse(self.page.evaluate('initialSearchDraftIsCurrent()'))
                    self.page.evaluate('''composing => {
                      if (composing) DOM.searchInput.dispatchEvent(new CompositionEvent('compositionstart'));
                      DOM.searchInput.value = composing ? 'paging-early-composing' : 'paging-early';
                      DOM.searchInput.setSelectionRange(3, 7);
                      DOM.searchInput.dispatchEvent(new InputEvent('input', {
                        bubbles:true, isComposing:composing,
                        inputType:composing ? 'insertCompositionText' : 'insertText'
                      }));
                      window.initialRouteQuery = 'paging-startup-B';
                    }''', composing)
                    self.assertTrue(self.page.evaluate('initialSearchDraftIsCurrent()'))
                self.page.evaluate('''() => {
                  window.holdInitialStorage = false;
                  releaseInitialStorage.splice(0).forEach(release => release());
                }''')
                self.page.wait_for_function('routeInitialized')
                if navigate and not renew:
                    self.page.wait_for_timeout(180)
                    self.assertEqual(self.page.evaluate('STATE.query'), 'paging-startup-B')
                    draft = 'paging-early-composing' if composing else 'paging-early'
                    self.assertEqual(self.page.locator('#search-input').input_value(), draft)
                    if composing:
                        self.assertTrue(self.page.evaluate('searchComposing'))
                        self.page.evaluate("DOM.searchInput.dispatchEvent(new CompositionEvent('compositionend'))")
                        self.page.wait_for_timeout(180)
                        self.assertEqual(self.page.evaluate('STATE.query'), 'paging-startup-B')
                    self.page.locator('#search-input').fill('paging-new-startup-edit')
                    self.page.wait_for_function("STATE.query === 'paging-new-startup-edit' && !STATE.isLoading")
                    continue
                if composing:
                    self.assertTrue(self.page.evaluate('searchComposing'))
                    self.assertEqual(self.page.evaluate('STATE.query'), self.page.evaluate('initialRouteQuery'))
                    self.assertEqual(self.page.locator('#search-input').input_value(), 'paging-early-composing')
                    self.assertEqual(self.page.evaluate('[DOM.searchInput.selectionStart, DOM.searchInput.selectionEnd]'), [3, 7])
                    self.page.evaluate("DOM.searchInput.dispatchEvent(new CompositionEvent('compositionend'))")
                expected = 'paging-early-composing' if composing else 'paging-early'
                self.page.wait_for_function('query => STATE.query === query && !STATE.isLoading', arg=expected)
                self.assertEqual(self.page.locator('#search-input').input_value(), expected)

    def test_long_composition_waits_for_real_completion(self):
        self.page.evaluate('''() => {
          DOM.searchInput.dispatchEvent(new CompositionEvent('compositionstart'));
          DOM.searchInput.value = 'paging-long-composition';
          DOM.searchInput.dispatchEvent(new InputEvent('input', {bubbles:true, isComposing:true}));
        }''')
        self.page.wait_for_timeout(5200)
        self.assertEqual(self.page.evaluate('STATE.query'), 'paging')
        self.assertTrue(self.page.evaluate('searchComposing'))
        self.page.evaluate("DOM.searchInput.dispatchEvent(new CompositionEvent('compositionend'))")
        self.page.wait_for_function("STATE.query === 'paging-long-composition' && !STATE.isLoading")

    def test_composition_from_previous_view_cannot_submit_but_new_input_can(self):
        self.page.evaluate('''() => {
          DOM.searchInput.focus();
          DOM.searchInput.dispatchEvent(new CompositionEvent('compositionstart'));
          DOM.searchInput.value = 'paging-composing-A';
          history.pushState(null, '', historySearchUrl('paging-B'));
          ROUTER.apply();
        }''')
        self.page.wait_for_function("STATE.query === 'paging-B' && !STATE.isLoading")
        self.assertEqual(self.page.locator('#search-input').input_value(), 'paging-composing-A')
        self.page.evaluate("DOM.searchInput.dispatchEvent(new CompositionEvent('compositionend'))")
        self.page.wait_for_timeout(180)
        self.assertEqual(self.page.evaluate('STATE.query'), 'paging-B')
        input_type = self.page.evaluate('''() => {
          // Use a recognized type: an unsupported constructor value can become
          // an empty string, which is indistinguishable from ordinary input.
          const tail = new InputEvent('input', {bubbles:true, inputType:'insertCompositionText'});
          DOM.searchInput.dispatchEvent(tail);
          return tail.inputType;
        }''')
        self.assertEqual(input_type, 'insertCompositionText')
        self.page.wait_for_timeout(180)
        self.assertEqual(self.page.evaluate('STATE.query'), 'paging-B')
        self.page.locator('#search-input').press('Enter')
        self.page.wait_for_function("STATE.query === 'paging-composing-A' && !STATE.isLoading")
        self.page.locator('#search-input').fill('paging-deliberate-edit')
        self.page.wait_for_function("STATE.query === 'paging-deliberate-edit' && !STATE.isLoading")

    def test_query_debounce_is_retired_by_a_different_view(self):
        self.page.evaluate('''() => {
          DOM.searchInput.value = 'paging-obsolete-draft';
          DOM.searchInput.dispatchEvent(new Event('input', {bubbles:true}));
          history.pushState(null, '', historySearchUrl('paging-B'));
          ROUTER.apply();
        }''')
        self.page.wait_for_timeout(180)
        self.assertEqual(self.page.evaluate('STATE.query'), 'paging-B')
        self.assertEqual(self.page.locator('#search-input').input_value(), 'paging-B')

    def test_pending_query_and_filter_are_submitted_together(self):
        self.page.evaluate('''() => {
          DOM.searchInput.value = 'paging-filter-draft';
          DOM.searchInput.dispatchEvent(new Event('input', {bubbles:true}));
          DOM.sortSelect.value = 'size';
          DOM.sortSelect.dispatchEvent(new Event('change', {bubbles:true}));
        }''')
        self.page.wait_for_function("STATE.query === 'paging-filter-draft' && !STATE.isLoading")
        self.assertEqual(self.page.evaluate('DOM.searchInput.value'), 'paging-filter-draft')
        self.assertEqual(self.page.evaluate('DOM.sortSelect.value'), 'size')
        self.assertIn('q=paging-filter-draft', self.page.url)
        self.assertIn('sort=size', self.page.url)

    def test_pages_local_toggle_retires_api_and_settles_shared_load_failure(self):
        self.page.evaluate('''() => {
          STATE.dataLoaded = false;
          loadData = () => new Promise(resolve => { window.finishSharedLoad = resolve; });
          ensureLocalDataLoaded(false, true);
          const previous = window.fetch;
          window.fetch = (input, options) => {
            const body = JSON.parse(options?.body || '{}');
            if (body.q === 'paging-api-held') return new Promise(resolve => {
              window.releaseHeldAPI = () => resolve(new Response(JSON.stringify({page:1,page_size:100,total:1,
                results:[{Repo:'VoiceOfML/Test',File:'stale-api',Extension:'txt',Folder:[],Size:1}]})));
            });
            return previous(input,options);
          };
          submitSearchQuery('paging-api-held',{updateInput:true});
          window.apiOwner = searchRequestId;
          apiAvailable = false;
          DOM.localModeToggle.checked = true;
          DOM.localModeToggle.dispatchEvent(new Event('change',{bubbles:true}));
          window.apiRetired = searchRequestId > apiOwner;
          releaseHeldAPI();
          finishSharedLoad(false);
        }''')
        self.page.wait_for_function("!STATE.isLoading && DOM.resultsList.textContent.includes('搜索数据加载失败')")
        self.assertTrue(self.page.evaluate('apiRetired'))
        self.assertEqual(self.page.evaluate('STATE.results.length'), 0)
        self.assertNotIn('stale-api', self.page.locator('#results-list').inner_text())
        self.assertEqual(self.page.locator('#results-list button').inner_text(), '重试')

    def test_pages_waiting_backend_replaces_stale_dom_and_retries_current_query(self):
        self.page.evaluate('''() => {
          // Hold the API outage for this scenario, including late bootstrap
          // successes which would otherwise re-enable it before the Retry click.
          noteApiSuccess = () => {};
          apiAvailable = false; STATE.dataLoaded = false; STATE.useLocalMode = false;
          window.backendQueries = [];
          loadData = () => new Promise(resolve => { window.finishBackendLoad = resolve; });
          doSearchLocal = params => {
            backendQueries.push(params.q);
            return Promise.resolve({page:1,page_size:STATE.pageSize,total:1,
              results:[{Repo:'VoiceOfML/Test',File:params.q,Extension:'txt',Folder:[],Size:1}]});
          };
          submitSearchQuery('paging-no-backend', {updateInput:true});
        }''')
        self.assertEqual(self.page.evaluate('[STATE.results.length, STATE.total, STATE.hasMore]'), [0, 0, False])
        self.assertEqual(self.page.locator('#results-list .result-item').count(), 0)
        self.assertIn('正在加载搜索数据', self.page.locator('#results-list').inner_text())
        self.page.evaluate('finishBackendLoad(false)')
        self.page.wait_for_function("!STATE.isLoading && DOM.resultsList.textContent.includes('搜索数据加载失败')")
        self.assertNotIn('没有找到', self.page.locator('#results-list').inner_text())
        self.page.locator('#results-list button').click()
        self.page.evaluate('finishBackendLoad(true)')
        self.page.wait_for_function("!STATE.isLoading && STATE.results[0]?.File === 'paging-no-backend'")
        self.assertEqual(self.page.evaluate('backendQueries'), ['paging-no-backend'])

    def test_pages_stale_data_load_failure_cannot_change_new_query_mode_or_url(self):
        self.page.evaluate('''() => {
          apiAvailable = false; STATE.dataLoaded = false; STATE.useLocalMode = true;
          loadData = () => new Promise(resolve => { window.finishBackendLoad = resolve; });
          submitSearchQuery('paging-wait-old', {updateInput:true});
          apiAvailable = true; STATE.useLocalMode = false;
          submitSearchQuery('paging-new-api', {updateInput:true});
        }''')
        self.page.wait_for_function("!STATE.isLoading && STATE.query === 'paging-new-api' && STATE._loadedPage === 1")
        before = self.page.url
        self.page.evaluate('finishBackendLoad(false)')
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.url, before)
        self.assertEqual(self.page.evaluate('[STATE.query, STATE.useLocalMode, STATE._loadedPage]'), ['paging-new-api', False, 1])
        self.assertNotIn('搜索数据加载失败', self.page.locator('#results-list').inner_text())

    def test_abort_reentry_new_query_owns_request_and_result(self):
        self.page.evaluate('''() => {
          searchAbortController.signal.addEventListener('abort', () => {
            submitSearchQuery('paging-reentrant', {updateInput:true});
          }, {once:true});
          submitSearchQuery('paging-superseded', {updateInput:true});
        }''')
        self.page.wait_for_function("STATE.query === 'paging-reentrant' && !STATE.isLoading && STATE._loadedPage === 1")
        self.assertEqual(self.page.evaluate('DOM.searchInput.value'), 'paging-reentrant')
        self.assertIn('q=paging-reentrant', self.page.url)
        self.assertTrue(self.page.evaluate('!searchAbortController.signal.aborted'))

    def test_invalid_history_sort_uses_backend_whitelist(self):
        self.page.evaluate('''() => {
          const previous = window.fetch;
          window.seenSort = [];
          window.fetch = (input, options) => {
            const body = JSON.parse(options?.body || '{}');
            if (String(input).includes('/api/search') && body.q === 'paging-invalid-sort') {
              window.seenSort.push(body.sort);
              if (!['relevance','name','size'].includes(body.sort)) return Promise.resolve(new Response('{}',{status:422}));
            }
            return previous(input, options);
          };
          history.pushState(null, '', historySearchUrl('paging-invalid-sort', '&sort=invalid'));
          ROUTER.apply();
        }''')
        self.page.wait_for_function("STATE.query === 'paging-invalid-sort' && !STATE.isLoading && STATE._loadedPage === 1")
        self.assertEqual(self.page.evaluate('DOM.sortSelect.value'), 'relevance')
        self.assertTrue(self.page.evaluate("seenSort.length > 0 && seenSort.every(sort => sort === 'relevance')"))

"""Direct deep-position recovery and demand-loaded gaps in real Chromium."""
import unittest
from tests.search.browser import test_search_positions as positions


class PositionWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        positions.SearchPositionTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        positions.SearchPositionTests.tearDownClass()

    def setUp(self):
        self.fixture = positions.SearchPositionTests()
        self.fixture.setUp()
        self.page = self.fixture.page
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate('''() => {
          resultSnapshots.snapshots.clear();
          window.windowCalls=[];window.windowFailures=new Set();window.windowGeneration='one';
          window.windowAnchor=49850;window.windowTotal=50001;window.windowStall=0;
          window.originalWindowKey=[...positionPersistence.positions.keys()].find(key=>JSON.parse(key).query==='paging-original');
          const saved=positionPersistence.positions.get(originalWindowKey);
          Object.assign(saved,{index:49850,loadedPage:500,anchorId:'VoiceOfML/Test\\0paging-49850.txt',offset:11});
          // Isolate recovery/demand requests from the normal next-page prefetch.
          prefetchNextPage=()=>{};
          window.realMaybeLoadNextPage=maybeLoadNextPage;maybeLoadNextPage=()=>{};
          fetchPositionPage=async(query,page,signal,anchorId)=>{
            windowCalls.push(page);
            if(windowStall===page) await new Promise(resolve=>window.releaseWindow=resolve);
            if(windowFailures.has(page)) throw new Error('offline');
            await new Promise(resolve=>setTimeout(resolve,10));
            const total=windowTotal;
            return {page,page_size:query.pageSize,total,generation:windowGeneration,anchor_index:windowAnchor,
              results:Array.from({length:Math.min(query.pageSize,Math.max(0,total-(page-1)*query.pageSize))},(_,i)=>{
                const index=(page-1)*query.pageSize+i;
                const name=index===windowAnchor?'paging-49850':index===49850?'moved-away':'paging-'+index;
                return {Repo:'VoiceOfML/Test',File:name,Extension:'txt',Folder:[],Size:1,ID:String(index)};
              })};
          };
           STATE.query='paging-original';doSearch(false,false,true);
        }''')
        self.wait_anchor(49850)

    def tearDown(self):
        errors = self.fixture.fixture.errors[:]
        self.fixture.tearDown()
        self.assertEqual(errors, [])

    def wait_anchor(self, index, offset=11):
        self.page.wait_for_function('''([index,offset])=>!positionRestore && !!resultWindow &&
          findVirtualIndex(getResultScrollTop())===index && !!STATE.results[index] &&
          Math.abs(getResultScrollTop()-getVirtualOffset(index)-offset)<2''', arg=[index,offset])

    def jump(self, index):
        self.page.evaluate('index=>{setResultScrollTop(getVirtualOffset(index)+11);renderVisible()}', index)

    def test_depth_500_uses_only_anchor_neighborhood_and_real_loaded_count(self):
        self.assertEqual(self.page.evaluate('windowCalls.slice(0,4)'), [1,498,499,500])
        self.assertTrue(self.page.evaluate('windowCalls.every(page=>[1,498,499,500,501].includes(page))'))
        self.assertTrue(self.page.evaluate('''() => STATE.total === 50001 &&
          STATE.results.length >= 50000 && STATE.results.length <= 50001 &&
          resultWindow.count === Object.keys(STATE.results).length'''))
        self.assertEqual(self.page.locator('#current-result-position').input_value(), '49851')

    def test_jump_back_fills_only_visible_gap_and_keeps_anchor(self):
        self.jump(25050)
        self.wait_anchor(25050)
        self.assertEqual(self.page.evaluate('STATE.results[25050].File'), 'paging-25050')
        self.assertTrue(self.page.evaluate('windowCalls.every(page=>[1,498,499,500,501,248,249,250,251,252,253,254,255,256].includes(page))'))
        self.assertEqual(self.page.evaluate('getResultStableId(STATE.results[49850])'), 'VoiceOfML/Test\0paging-49850.txt')

    def test_gap_loading_invalidates_snapshot_bytes_and_keeps_prior_snapshot_independent(self):
        self.page.evaluate('window.beforeGap=saveSearchViewSnapshot()')
        self.jump(25050)
        self.wait_anchor(25050)
        result = self.page.evaluate('''() => {
          const after=saveSearchViewSnapshot();
          return {beforeMissing:!beforeGap.results[25050],afterPresent:!!after.results[25050],
            exact:getSearchSnapshotResultsBytes(STATE.results,true)===new TextEncoder().encode(JSON.stringify(STATE.results)).byteLength};
        }''')
        self.assertEqual(result, dict(beforeMissing=True, afterPresent=True, exact=True))

    def test_failed_gap_keeps_saved_position_and_can_retry(self):
        self.page.set_viewport_size({'width':390,'height':844})
        self.page.evaluate('windowFailures.add(251);saveSearchPosition()')
        self.jump(25050)
        self.page.locator('#search-window-status').get_by_text('重试加载', exact=True).wait_for()
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 3)
        self.page.wait_for_timeout(800)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 3)
        self.assertEqual(self.page.evaluate('positionPersistence.positions.get(originalWindowKey).index'), 49850)
        self.page.evaluate('windowFailures.clear()')
        self.page.locator('#search-window-status button').click()
        self.wait_anchor(25050)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 4)

    def test_transient_gap_failure_recovers_without_click_or_scroll(self):
        self.page.evaluate('windowFailures.add(251)')
        self.jump(25050)
        self.page.wait_for_function('windowCalls.includes(251)')
        self.assertEqual(self.page.locator('.result-window-placeholder button').count(), 0)
        self.page.evaluate('windowFailures.clear();for(let i=0;i<20;i++)renderVisible()')
        self.wait_anchor(25050)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 2)

    def test_failed_prefetch_is_bounded_and_does_not_poison_demand(self):
        self.page.evaluate('windowFailures.add(251);loadResultWindowPage(251,true)')
        self.page.wait_for_function('resultWindow.prefetchFailures?.has(251)')
        self.page.evaluate('for(let i=0;i<20;i++)loadResultWindowPage(251,true)')
        self.assertFalse(self.page.evaluate('resultWindow.failures.has(251)'))
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 1)
        self.page.evaluate('windowFailures.clear()')
        self.jump(25050)
        self.wait_anchor(25050)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 2)

    def test_demand_joins_failed_inflight_prefetch_and_owns_retries(self):
        self.page.evaluate('windowStall=251;windowFailures.add(251);loadResultWindowPage(251,true);void 0')
        self.page.wait_for_function('!!window.releaseWindow')
        self.jump(25050)
        self.page.evaluate('releaseWindow();windowStall=0')
        self.page.wait_for_timeout(100)
        self.page.evaluate('windowFailures.clear()')
        self.wait_anchor(25050)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 2)

    def test_query_change_cancels_retry_delay(self):
        self.page.evaluate('windowFailures.add(251)')
        self.jump(25050)
        self.page.wait_for_function('windowCalls.includes(251)')
        self.page.evaluate("STATE.query='paging-latest';doSearch()")
        self.page.wait_for_timeout(1000)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 1)
        self.assertTrue(self.page.evaluate('resultWindow===null'))

    def test_online_recovers_exhausted_visible_page_only(self):
        self.page.evaluate('windowFailures.add(251)')
        self.jump(25050)
        self.page.wait_for_function('resultWindow.failures.has(251)')
        self.page.evaluate("resultWindow.failures.set(101,new Error('offline'));windowFailures.clear();window.dispatchEvent(new Event('online'))")
        self.wait_anchor(25050)
        self.assertTrue(self.page.evaluate('resultWindow.failures.has(101)'))
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 4)
        self.assertFalse(self.page.evaluate('windowCalls.includes(101)'))

    def test_hidden_retry_waits_for_return_and_respects_concurrency(self):
        self.page.evaluate('windowFailures.add(251)')
        self.jump(25050)
        self.page.wait_for_function('windowCalls.includes(251)')
        self.page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:true})")
        self.page.wait_for_timeout(900)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 1)
        self.assertLessEqual(self.page.evaluate('resultWindow.pending.size'), 3)
        self.page.evaluate("windowFailures.clear();Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))")
        self.wait_anchor(25050)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 2)

    def test_restore_retries_lookup_and_missing_neighbor_without_repeating_ready_pages(self):
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("resultSnapshots.snapshots.clear();windowCalls=[];windowFailures.add(1);STATE.query='paging-original';doSearch(false,false,true)")
        self.page.wait_for_function('windowCalls.includes(1)')
        self.page.evaluate('windowFailures.delete(1);windowFailures.add(499)')
        self.page.wait_for_function('windowCalls.includes(499)')
        self.page.evaluate('windowFailures.clear()')
        self.wait_anchor(49850)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===1).length'), 2)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===499).length'), 2)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===498).length'), 1)

    def test_retry_policy_excludes_cancel_invalid_data_and_permanent_http_errors(self):
        self.assertEqual(self.page.evaluate('''() => {
          return [408,429,500,502,503,504,400,403,404].map(status=>isRecoverableSearchError({status}))
            .concat([new DOMException('Cancelled','AbortError'),new Error('RESTORE_PAGE_CHANGED'),
              new Error('INVALID_API_RESPONSE'),new Error('API_TIMEOUT'),new TypeError('Failed to fetch')].map(isRecoverableSearchError));
        }'''), [True]*6 + [False]*6 + [True,True])
        self.assertEqual(self.page.evaluate('''() => [408,429,403].map(status=>{
          resetPagingRecovery();finishPagingAttempt(false,{status});return pagingFailures;
        })'''), [1,1,2])

    def test_generation_change_relocates_without_mixing_pages(self):
        self.page.evaluate("saveSearchPosition();windowGeneration='two';windowAnchor=35050")
        self.jump(25050)
        self.page.locator('#search-window-status').get_by_text('重新定位', exact=True).wait_for()
        self.assertFalse(self.page.evaluate('!!STATE.results[25050]'))
        self.page.locator('#search-window-status button').click()
        self.wait_anchor(35050)
        self.assertEqual(self.page.evaluate('STATE.results[35050].File'), 'paging-49850')
        self.assertEqual(self.page.evaluate('resultWindow.generation'), 'two')

    def test_snapshot_save_without_displayed_view_preserves_cached_position(self):
        self.assertTrue(self.page.evaluate('''() => {
          const snapshot=saveSearchViewSnapshot(), position=positionPersistence.positions.get(originalWindowKey);
          const view=displayedSearchView, savedPosition=JSON.stringify(position);
          displayedSearchView=null;
          try {
            return saveSearchViewSnapshot()===null && !!snapshot && !!position &&
              resultSnapshots.snapshots.get(originalWindowKey)===snapshot &&
              positionPersistence.positions.get(originalWindowKey)===position && JSON.stringify(position)===savedPosition;
          } finally { displayedSearchView=view; }
        }'''))

    def invalidate_window_generation(self):
        self.page.evaluate("saveSearchPosition();windowGeneration='two';windowAnchor=35050;loadResultWindowPage(251,true)")
        self.page.wait_for_function('resultWindow?.invalid === true')
        self.assertEqual(self.page.evaluate('resultWindow.generation'), 'one')
        self.assertFalse(self.page.evaluate('!!STATE.results[25050]'))

    def test_invalid_window_snapshot_round_trip_revalidates_generation(self):
        self.page.evaluate('resultSnapshots.snapshots.delete(originalWindowKey)')
        self.invalidate_window_generation()
        self.page.evaluate('saveSearchViewSnapshot()')
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.assertEqual(self.page.evaluate('positionPersistence.positions.get(originalWindowKey).index'), 49850)
        self.page.evaluate("windowCalls=[];STATE.query='paging-original';doSearch(false,false,true)")
        self.assertTrue(self.page.evaluate("!!positionRestore || resultWindow?.generation === 'two'"),
                        'Returning must validate the invalid window instead of silently restoring generation one')
        self.wait_anchor(35050)
        self.assertIn(1, self.page.evaluate('windowCalls'))
        self.assertEqual(self.page.evaluate('resultWindow.generation'), 'two')
        self.assertFalse(self.page.evaluate('!!resultWindow.invalid'))
        self.assertEqual(self.page.evaluate('STATE.results[35050].File'), 'paging-49850')

    def test_invalid_window_cannot_reuse_cached_snapshot(self):
        self.assertTrue(self.page.evaluate('!!saveSearchViewSnapshot()'))
        self.invalidate_window_generation()
        result = self.page.evaluate('''() => {
          const saved=saveSearchViewSnapshot();
          const position=positionPersistence.positions.get(originalWindowKey);
          return {rejected:saved===null,cached:resultSnapshots.snapshots.has(originalWindowKey),
            index:position.index,anchorId:position.anchorId};
        }''')
        self.assertEqual(result, dict(rejected=True, cached=False, index=49850,
                                     anchorId='VoiceOfML/Test\0paging-49850.txt'))

    def test_restore_rejects_snapshot_marked_invalid_and_recovers_position(self):
        self.page.evaluate('window.invalidSnapshot=saveSearchViewSnapshot()')
        self.invalidate_window_generation()
        self.page.evaluate('invalidSnapshot.window.invalid=resultWindow.invalid')
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate('resultSnapshots.snapshots.set(originalWindowKey,invalidSnapshot)')
        self.assertFalse(self.page.evaluate('restoreSearchViewSnapshot(originalWindowKey,false)'),
                         'A restore without position recovery must refuse an invalid snapshot')
        self.assertFalse(self.page.evaluate('resultSnapshots.snapshots.has(originalWindowKey)'))
        self.page.evaluate("resultSnapshots.snapshots.set(originalWindowKey,invalidSnapshot);windowCalls=[];STATE.query='paging-original';doSearch(false,false,true)")
        self.wait_anchor(35050)
        self.assertIn(1, self.page.evaluate('windowCalls'))
        self.assertEqual(self.page.evaluate('resultWindow.generation'), 'two')
        self.assertEqual(self.page.evaluate('STATE.results[35050].File'), 'paging-49850')

    def test_late_gap_response_cannot_replace_a_new_query(self):
        self.page.evaluate('windowStall=251')
        self.jump(25050)
        self.page.wait_for_function('!!window.releaseWindow')
        self.page.evaluate("STATE.query='paging-latest';doSearch();releaseWindow()")
        self.page.wait_for_function("STATE.query==='paging-latest' && !STATE.isLoading")
        self.page.wait_for_timeout(50)
        self.assertTrue(self.page.evaluate('resultWindow===null && STATE.results.length<1000'))

    def test_sparse_snapshot_and_selection_keep_only_actual_records(self):
        self.page.evaluate('DOM.multiSelectToggle.checked=true;updateSelectionUI();DOM.multiSelectAll.click()')
        self.assertTrue(self.page.evaluate('''() => Object.keys(selectedIndices).length >= 400 &&
          Object.keys(selectedIndices).length <= Object.keys(STATE.results).length'''))
        self.assertTrue(self.page.evaluate('Object.keys(selectedIndices).every(index=>!!STATE.results[index])'))
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("STATE.query='paging-original';doSearch(false,false,true)")
        self.wait_anchor(49850)
        self.assertEqual(self.page.evaluate('resultWindow.count'), self.page.evaluate('Object.keys(STATE.results).length'))
        self.assertFalse(self.page.evaluate('!!STATE.results[25050]'))

    def test_forward_append_reaches_exact_end_and_earlier_pages_remain_accessible(self):
        self.page.evaluate('realMaybeLoadNextPage(false,true)')
        self.page.wait_for_function('STATE.results.length===50001 && !STATE.hasMore')
        self.assertEqual(self.page.evaluate('STATE.results[50000].ID'), '50000')
        self.jump(150)
        self.wait_anchor(150)
        self.assertEqual(self.page.evaluate('STATE.results[150].ID'), '150')
        self.assertEqual(self.page.evaluate('STATE.total'), 50001)

    def test_drag_defers_gap_application_and_reuses_response_after_release(self):
        self.page.evaluate('windowStall=251')
        self.jump(25050)
        self.page.wait_for_function('!!window.releaseWindow')
        self.page.evaluate('VSCROLL.isDraggingThumb=true;releaseWindow()')
        self.page.wait_for_function('resultWindow.prefetched?.has(251)')
        self.assertFalse(self.page.evaluate('!!STATE.results[25050]'))
        self.page.evaluate('VSCROLL.isDraggingThumb=false')
        self.jump(35050)
        self.wait_anchor(35050)
        self.jump(25050)
        self.wait_anchor(25050)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 1)

    def persist_viewport(self):
        self.page.evaluate('''async () => {
          positionPersistence.positions.get(originalWindowKey).savedAt=0;saveSearchPosition();
          await new Promise(resolve=>{const tx=positionStorage.database.transaction(['positions','viewports']);tx.oncomplete=resolve});
        }''')

    def assert_cached_viewport(self, offset=11):
        self.page.wait_for_function('positionRestore?.preview && !!window.releaseWindow')
        self.assertTrue(self.page.evaluate('''offset => {
          const box=DOM.resultsContainer.getBoundingClientRect();
          return findVirtualIndex(getResultScrollTop())===49850 &&
            Math.abs(getResultScrollTop()-getVirtualOffset(49850)-offset)<2 &&
            getComputedStyle(DOM.resultsContainer).visibility==='visible' &&
            [...DOM.resultsList.querySelectorAll('.result-window-placeholder')].every(row=>{
              const rect=row.getBoundingClientRect();return rect.bottom<=box.top || rect.top>=box.bottom;
            });
        }''', offset))
        self.assertEqual(self.page.locator('#current-result-position').input_value(), '49851')
        self.assertTrue(self.page.evaluate('Object.keys(VSCROLL.heights).length<300 && Object.keys(VSCROLL.heightTree).length<2000'))

    def test_persisted_viewport_shows_before_lookup_and_keeps_nodes_after_validation(self):
        self.persist_viewport()
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("resultSnapshots.snapshots.clear();positionPersistence.viewports.clear();windowStall=1;STATE.query='paging-original';doSearch(false,false,true)")
        self.assert_cached_viewport()
        self.page.evaluate("window.cachedRow=DOM.resultsList.querySelector('[data-index=\"49850\"]');releaseWindow()")
        self.wait_anchor(49850)
        self.assertTrue(self.page.evaluate("cachedRow===DOM.resultsList.querySelector('[data-index=\"49850\"]')"))

    def check_cached_viewport_selection(self, replace_neighbor):
        self.persist_viewport()
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate('''replaceNeighbor => {
          const original=fetchPositionPage;
          fetchPositionPage=async (...args)=>{
            const data=await original(...args);
            for(const record of data.results) {
              if(record.File==='paging-49850') record.Size=2;
              if(record.File==='paging-49851') {
                record.Size=2;
                if(replaceNeighbor) record.File='replacement-neighbor';
              }
            }
            return data;
          };
          resultSnapshots.snapshots.clear();positionPersistence.viewports.clear();
          windowGeneration='two';windowStall=1;
          STATE.query='paging-original';doSearch(false,false,true);
        }''', replace_neighbor)
        self.assert_cached_viewport()
        self.page.locator('#multi-select-toggle').check()
        anchor = self.page.locator('.result-checkbox[data-index="49850"]')
        neighbor = self.page.locator('.result-checkbox[data-index="49851"]')
        anchor.check()
        neighbor.check()
        self.assertEqual(self.page.evaluate('getSelectedFiles().map(file=>file.filename)'),
                         ['paging-49850.txt', 'paging-49851.txt'])
        self.assertTrue(self.page.evaluate('!!positionRestore.preview'))
        self.page.evaluate('releaseWindow()')
        self.wait_anchor(49850)
        self.assertEqual(self.page.evaluate('resultWindow.generation'), 'two')
        self.assertEqual(self.page.evaluate('STATE.results[49851].File'),
                         'replacement-neighbor' if replace_neighbor else 'paging-49851')
        self.assertEqual(self.page.evaluate('STATE.results[49850].Size'), 2)
        expected = ['paging-49850.txt'] if replace_neighbor else ['paging-49850.txt', 'paging-49851.txt']
        self.assertEqual(self.page.evaluate('getSelectedFiles().map(file=>file.filename)'), expected)
        self.assertTrue(anchor.is_checked())
        self.assertEqual(neighbor.is_checked(), not replace_neighbor)
        self.assertEqual(self.page.locator('#multi-selected-count').inner_text(),
                         '已选1项' if replace_neighbor else '已选2项')
        self.assertEqual(self.page.evaluate('lastSelectedIndex'), -1 if replace_neighbor else 49851)

    def test_cached_viewport_selection_drops_replaced_neighbor_after_validation(self):
        self.check_cached_viewport_selection(replace_neighbor=True)

    def test_cached_viewport_selection_keeps_same_identity_after_metadata_change(self):
        self.check_cached_viewport_selection(replace_neighbor=False)

    def test_reload_displays_saved_content_while_network_is_blocked(self):
        self.page.set_viewport_size({'width':390,'height':844})
        self.page.wait_for_timeout(100)
        self.persist_viewport()
        # Resizing can change fractional row geometry; restore the saved mobile offset.
        saved_offset = self.page.evaluate('positionPersistence.positions.get(originalWindowKey).offset')
        fetcher = self.page.evaluate('fetchPositionPage.toString()')
        self.page.add_init_script('''document.addEventListener('DOMContentLoaded',()=>{
          window.windowCalls=[];window.windowFailures=new Set();window.windowGeneration='one';
          window.windowAnchor=49850;window.windowTotal=50001;window.windowStall=1;
          prefetchNextPage=()=>{};maybeLoadNextPage=()=>{};fetchPositionPage=(''' + fetcher + ''');
        });''')
        self.page.reload(wait_until='domcontentloaded')
        self.assert_cached_viewport(saved_offset)
        self.page.evaluate('releaseWindow()')
        self.wait_anchor(49850, saved_offset)

    def test_loading_an_adjacent_page_does_not_replace_visible_rows(self):
        self.page.evaluate('window.keptRow=DOM.resultsList.querySelector(\'[data-index="49850"]\');loadResultWindowPage(497)')
        self.page.wait_for_function('resultWindow.pages.has(497)')
        self.assertTrue(self.page.evaluate('keptRow===DOM.resultsList.querySelector(\'[data-index="49850"]\')'))
        self.assertTrue(self.page.evaluate('''() => {
          const button=keptRow.querySelector('[data-action="read"]'), before=button.dataset.readerUrl;
          // The retired linearized.pdf path is deliberately rejected. Use a
          // currently accepted synthetic asset that changes the Reader mode.
          readerAssetController.state.assets={[getResultStableId(STATE.results[49850])]:{s:2,m:'h',p:'objects/00/'+'0'.repeat(64)+'/profile/document.html'}};
          refreshResultReaderActions();renderVisible();
          return keptRow===DOM.resultsList.querySelector('[data-index="49850"]') &&
            button===keptRow.querySelector('[data-action="read"]') && button.dataset.readerUrl!==before;
        }'''))

    def test_failed_validation_leaves_cached_content_visible_and_cancels_cleanly(self):
        self.persist_viewport()
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("resultSnapshots.snapshots.clear();windowFailures.add(1);STATE.query='paging-original';doSearch(false,false,true)")
        self.page.get_by_text('重试恢复', exact=True).wait_for()
        self.assertEqual(self.page.evaluate('findVirtualIndex(getResultScrollTop())'), 49850)
        self.assertEqual(self.page.evaluate('getComputedStyle(DOM.resultsContainer).visibility'), 'visible')
        for width in [1280, 390, 320]:
            self.page.set_viewport_size({'width': width, 'height': 844})
            self.page.evaluate('STATE.isMobile=innerWidth<600;applyMobileMode()')
            self.assertTrue(self.page.locator('#load-info #retry-position-btn').is_visible())
            self.assertTrue(self.page.locator('#retry-position-btn').evaluate('''button=>{
              const retry=button.getBoundingClientRect(),top=document.getElementById('restart-position-btn').getBoundingClientRect();
              const count=document.querySelector('.result-position-count').getBoundingClientRect();
              const bar=document.getElementById('load-info').getBoundingClientRect();
              return [retry,top].every(box=>box.left>=bar.left && box.right<=bar.right &&
                box.top>=bar.top && box.bottom<=bar.bottom &&
                !(box.left<count.right && box.right>count.left && box.top<count.bottom && box.bottom>count.top));
            }'''))
        self.page.locator('#restart-position-btn').click()
        self.page.wait_for_function('!positionRestore && !STATE.isLoading && !resultWindow')

    def test_saved_viewport_is_bounded_and_not_used_for_another_anchor(self):
        self.persist_viewport()
        self.assertLessEqual(self.page.evaluate('positionPersistence.viewports.get(originalWindowKey).records.length'), 80)
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("resultSnapshots.snapshots.clear();positionPersistence.positions.get(originalWindowKey).anchorId='different';windowStall=1;STATE.query='paging-original';doSearch(false,false,true)")
        self.page.wait_for_function('!!window.releaseWindow')
        self.assertFalse(self.page.evaluate('!!positionRestore.preview'))
        self.page.evaluate('releaseWindow()')
        self.wait_anchor(49850)

    def test_large_api_records_prioritize_visible_content_within_storage_budget(self):
        self.page.evaluate('''() => {
          STATE.results.forEach(record=>record.Metadata='中'.repeat(900));
          const original=fetchPositionPage;
          fetchPositionPage=async (...args)=>{
            const data=await original(...args);data.results.forEach(record=>record.Metadata='中'.repeat(900));return data;
          };
        }''')
        self.persist_viewport()
        self.assertTrue(self.page.evaluate('''() => {
          const saved=positionPersistence.viewports.get(originalWindowKey);
          return saved.records.length<80 && new TextEncoder().encode(JSON.stringify(saved)).byteLength<=VoiceOfMLPositionPolicy.VIEWPORT_BYTES_MAX;
        }'''))
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("resultSnapshots.snapshots.clear();positionPersistence.viewports.clear();windowStall=1;STATE.query='paging-original';doSearch(false,false,true)")
        self.assert_cached_viewport()
        self.page.evaluate('releaseWindow()')
        self.wait_anchor(49850)

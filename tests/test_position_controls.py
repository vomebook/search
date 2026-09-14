"""Browser contracts for explicit recovery and editable result positions."""
import unittest
from tests import test_paging_recovery as paging


class PositionControlTests(unittest.TestCase):
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
        self.page.set_default_timeout(6000)
        self.page.evaluate('''()=>{
          pagingMode='normal';pagingTotal=100000;STATE.query='paging-ui';doSearch();
        }''')
        self.page.wait_for_function('!STATE.isLoading && STATE.total===100000')
        self.page.evaluate('''()=>{
          window.positionCalls=[];window.blockPosition=false;window.failPosition=false;
          const original=fetchPositionPage;
          fetchPositionPage=async(...args)=>{
            positionCalls.push(args[1]);
            if(blockPosition) await new Promise(resolve=>window.releasePosition=resolve);
            if(failPosition) throw new Error('offline');
            return original(...args);
          };
        }''')

    def tearDown(self):
        errors = self.fixture.errors[:]
        self.fixture.tearDown()
        self.assertEqual(errors, [])

    def input_position(self, value, key='Enter'):
        self.page.locator('#current-result-position').fill(str(value))
        self.page.locator('#current-result-position').press(key)

    def wait_position(self, index):
        self.page.wait_for_function('''index=>!positionRestore && !STATE.isLoading &&
          findVirtualIndex(getResultScrollTop())===index && !!STATE.results[index]''', arg=index)

    def store_position(self, clear_viewport=False):
        self.page.evaluate('''async clearViewport=>{
          returnPositionTarget=null;saveSearchPosition();
          const tx=searchPositionDB.transaction(['positions','viewports'],'readwrite');
          if(clearViewport) tx.objectStore('viewports').clear();
          await new Promise(resolve=>tx.oncomplete=resolve);
        }''', clear_viewport)

    def test_unloaded_index_requests_only_neighborhood_and_submits_once(self):
        self.input_position(95001)
        self.wait_position(95000)
        calls = self.page.evaluate('positionCalls')
        self.assertEqual(calls[:4], [1, 950, 951, 952])
        self.assertEqual(calls.count(1), 1)
        self.assertTrue(all(page in [1, 950, 951, 952, 953] for page in calls))
        self.assertEqual(self.page.evaluate('STATE.results[95000].File'), 'paging-95000')
        self.assertEqual(self.page.locator('#current-result-position').input_value(), '95001')

    def test_escape_and_unchanged_blur_do_not_jump(self):
        self.input_position(95001, 'Escape')
        self.assertEqual(self.page.evaluate('positionCalls'), [])
        self.assertEqual(self.page.locator('#current-result-position').input_value(), '1')
        self.page.locator('#current-result-position').focus()
        self.page.locator('#current-result-position').blur()
        self.assertEqual(self.page.evaluate('positionCalls'), [])
        self.input_position('not-a-number')
        self.assertEqual(self.page.locator('#current-result-position').input_value(), '1')

    def test_fractional_row_boundary_does_not_jump_to_previous_record(self):
        result = self.page.evaluate('''()=>{
          VSCROLL.heights[0]+=0.25;VSCROLL.heightsDirty=true;
          const target=getVirtualOffset(50);
          setResultScrollTop(target);
          return {index:findVirtualIndex(getResultScrollTop()),error:getResultScrollTop()-target};
        }''')
        self.assertEqual(result['index'], 50)
        self.assertGreaterEqual(result['error'], 0)
        self.assertLess(result['error'], 1)

    def test_failed_jump_keeps_rows_and_toolbar_retry_reuses_target(self):
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.evaluate('STATE.isMobile=true;applyMobileMode();failPosition=true')
        self.input_position(95001)
        self.page.wait_for_function('positionRestore?.failed')
        self.assertTrue(self.page.locator('#status-bar #retry-position-btn').is_visible())
        self.assertTrue(self.page.locator('#status-bar #restart-position-btn').is_visible())
        self.assertEqual(self.page.locator('#results-container').evaluate('(e)=>getComputedStyle(e).visibility'), 'visible')
        self.assertGreater(self.page.locator('.result-item').count(), 0)
        self.assertTrue(self.page.locator('#search-position-status').evaluate('''el=>{
          const box=el.getBoundingClientRect(),bar=document.getElementById('status-bar').getBoundingClientRect();
          return box.left>=bar.left && box.right<=bar.right && box.bottom<=bar.bottom;
        }'''))
        self.page.evaluate('failPosition=false')
        self.page.locator('#retry-position-btn').click()
        self.wait_position(95000)
        self.assertTrue(self.page.locator('#search-position-status').is_hidden())

    def test_cancel_stalled_jump_keeps_new_top_after_late_response(self):
        self.page.evaluate('blockPosition=true')
        self.input_position(95001)
        self.page.wait_for_function('!!window.releasePosition')
        self.page.locator('#restart-position-btn').click()
        self.page.wait_for_function('!STATE.isLoading && !positionRestore')
        self.page.evaluate('blockPosition=false;releasePosition()')
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.evaluate('findVirtualIndex(getResultScrollTop())'), 0)
        self.assertTrue(self.page.locator('#return-to-position-btn').is_hidden())

    def test_normal_search_offers_fixed_position_and_scroll_dismisses_it(self):
        self.input_position(95001)
        self.wait_position(95000)
        self.store_position()
        self.page.evaluate('doSearch()')
        self.page.wait_for_function('!STATE.isLoading && !positionRestore')
        self.assertEqual(self.page.evaluate('getResultScrollTop()'), 0)
        self.assertTrue(self.page.locator('#status-bar #return-to-position-btn').is_visible())
        self.page.evaluate('saveSearchPosition()')
        self.assertEqual(self.page.evaluate('searchPositions.get(getSearchViewKey()).index'), 95000)
        self.page.locator('#return-to-position-btn').click()
        self.wait_position(95000)
        self.page.evaluate('doSearch()')
        self.page.wait_for_function('!STATE.isLoading && !positionRestore')
        self.page.evaluate('DOM.resultsContainer.scrollTop=300')
        self.page.wait_for_function('returnPositionTarget===null')
        self.page.evaluate('DOM.resultsContainer.scrollTop=0')
        self.assertTrue(self.page.locator('#return-to-position-btn').is_hidden())

    def test_query_switch_and_history_restore_do_not_leave_stale_intent(self):
        self.input_position(95001)
        self.wait_position(95000)
        self.store_position()
        self.page.evaluate("doSearch();addHistoryItem('paging-ui')")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.assertTrue(self.page.locator('#return-to-position-btn').is_hidden())
        self.page.evaluate('DOM.searchInput.focus();renderDropdown()')
        self.page.locator('.history-item[data-query="paging-ui"]').click()
        self.wait_position(95000)
        self.page.locator('#search-input').press('Enter')
        self.page.wait_for_function('!STATE.isLoading && !positionRestore')
        self.assertEqual(self.page.evaluate('getResultScrollTop()'), 0)

    def test_reload_without_viewport_starts_at_top_with_return_button(self):
        self.input_position(95001)
        self.wait_position(95000)
        self.store_position(clear_viewport=True)
        # Suppress pagehide saving so it cannot recreate the deliberately absent viewport.
        self.page.evaluate('displayedSearchView=null')
        self.page.add_init_script("pagingTotal=100000;pagingMode='normal'")
        self.page.reload(wait_until='domcontentloaded')
        self.page.wait_for_function('!STATE.isLoading && STATE.results.length>0')
        self.assertEqual(self.page.evaluate('getResultScrollTop()'), 0)
        self.assertFalse(self.page.evaluate('!!positionRestore'))
        self.assertTrue(self.page.locator('#return-to-position-btn').is_visible())

    def test_sort_round_trip_restores_each_position_then_enter_starts_at_top(self):
        self.input_position(95001)
        self.wait_position(95000)
        self.page.locator('#sort-select').select_option('name')
        self.wait_position(0)
        self.input_position(5001)
        self.wait_position(5000)
        self.page.locator('#sort-select').select_option('relevance')
        self.wait_position(95000)
        self.page.locator('#sort-select').select_option('name')
        self.wait_position(5000)
        self.page.locator('#search-input').fill('paging-ui')
        self.page.locator('#search-input').press('Enter')
        self.wait_position(0)
        self.page.wait_for_timeout(150)
        self.assertEqual(self.page.evaluate('getResultScrollTop()'), 0)

    def test_filter_round_trip_restores_saved_position_after_snapshot_eviction(self):
        self.input_position(95001)
        self.wait_position(95000)
        self.page.evaluate('''()=>{
          DOM.searchFoldersToggle.checked=false;
          DOM.searchFoldersToggle.dispatchEvent(new Event('change',{bubbles:true}));
        }''')
        self.wait_position(0)
        self.page.evaluate('searchViewSnapshots.clear();positionCalls=[]')
        self.page.evaluate('''()=>{
          DOM.searchFoldersToggle.checked=true;
          DOM.searchFoldersToggle.dispatchEvent(new Event('change',{bubbles:true}));
        }''')
        self.wait_position(95000)
        self.assertEqual(self.page.evaluate('positionCalls.slice(0,4)'), [1,950,951,952])

    def test_typing_existing_query_starts_at_top_after_filter_restore(self):
        self.input_position(95001)
        self.wait_position(95000)
        self.page.locator('#search-input').fill('paging-other')
        self.page.wait_for_function('STATE.query==="paging-other" && !STATE.isLoading')
        self.wait_position(0)
        self.page.locator('#search-input').fill('paging-ui')
        self.page.wait_for_function('STATE.query==="paging-ui" && !STATE.isLoading')
        self.wait_position(0)
        self.assertTrue(self.page.locator('#return-to-position-btn').is_visible())

    def test_typing_cancels_pending_filter_restore_and_ignores_late_response(self):
        self.input_position(95001)
        self.wait_position(95000)
        self.page.locator('#sort-select').select_option('name')
        self.wait_position(0)
        self.page.evaluate('searchViewSnapshots.clear();blockPosition=true')
        self.page.locator('#sort-select').select_option('relevance')
        self.page.wait_for_function('!!window.releasePosition')
        self.page.locator('#search-input').fill('paging-latest')
        self.page.wait_for_function('STATE.query==="paging-latest" && !STATE.isLoading && !positionRestore')
        self.page.evaluate('blockPosition=false;releasePosition()')
        self.page.wait_for_timeout(100)
        self.wait_position(0)
        self.assertEqual(self.page.evaluate('displayedSearchView.key'), self.page.evaluate('getSearchViewKey()'))

    def test_debounced_extension_filter_and_clear_all_restore_positions(self):
        self.input_position(95001)
        self.wait_position(95000)
        self.page.evaluate('''()=>{
          STATE.filterExtensions=['txt'];scheduleFilterSearch();
        }''')
        self.page.wait_for_function('!filterSearchTimer && !STATE.isLoading')
        self.wait_position(0)
        self.input_position(5001)
        self.wait_position(5000)
        self.page.locator('#clear-filters-btn').click()
        self.wait_position(95000)
        self.page.evaluate('''()=>{
          STATE.filterExtensions=['txt'];scheduleFilterSearch();
        }''')
        self.page.wait_for_function('!filterSearchTimer && !STATE.isLoading')
        self.wait_position(5000)

    def test_reload_cached_viewport_is_visible_before_blocked_validation(self):
        self.input_position(95001)
        self.wait_position(95000)
        self.store_position()
        self.page.add_init_script('''document.addEventListener('DOMContentLoaded',()=>{
          const original=fetchPositionPage;
          fetchPositionPage=async(...args)=>{
            if(args[1]===1)await new Promise(resolve=>window.releaseValidation=resolve);
            return original(...args);
          };
        })''')
        self.page.reload(wait_until='domcontentloaded')
        self.page.wait_for_function('positionRestore?.preview && !!window.releaseValidation')
        self.assertEqual(self.page.evaluate('findVirtualIndex(getResultScrollTop())'), 95000)
        self.assertEqual(self.page.locator('#results-container').evaluate('(e)=>getComputedStyle(e).visibility'), 'visible')
        self.assertEqual(self.page.evaluate('STATE.results[95000].File'), 'paging-95000')
        self.assertTrue(self.page.locator('#status-bar #restart-position-btn').is_visible())

"""Direct deep-position recovery and demand-loaded gaps in real Chromium."""
import unittest
from tests import test_search_positions as positions


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
          searchViewSnapshots.clear();
          window.windowCalls=[];window.windowFailures=new Set();window.windowGeneration='one';
          window.windowAnchor=49850;window.windowTotal=50001;window.windowStall=0;
          window.originalWindowKey=[...searchPositions.keys()].find(key=>JSON.parse(key).query==='paging-original');
          const saved=searchPositions.get(originalWindowKey);
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
          STATE.query='paging-original';doSearch();
        }''')
        self.wait_anchor(49850)

    def tearDown(self):
        errors = self.fixture.fixture.errors[:]
        self.fixture.tearDown()
        self.assertEqual(errors, [])

    def wait_anchor(self, index):
        self.page.wait_for_function('''index=>!positionRestore && !!resultWindow &&
          findVirtualIndex(DOM.resultsContainer.scrollTop)===index && !!STATE.results[index] &&
          Math.abs(DOM.resultsContainer.scrollTop-getVirtualOffset(index)-11)<2''', arg=index)

    def jump(self, index):
        self.page.evaluate('index=>{DOM.resultsContainer.scrollTop=getVirtualOffset(index)+11;renderVisible()}', index)

    def test_depth_500_uses_only_anchor_neighborhood_and_real_loaded_count(self):
        self.assertEqual(self.page.evaluate('windowCalls'), [1,498,499,500])
        self.assertEqual(self.page.evaluate('[STATE.results.length,resultWindow.count,STATE.total]'), [50000,400,50001])
        self.assertEqual(self.page.locator('#loaded-count').text_content(), '400')

    def test_jump_back_fills_only_visible_gap_and_keeps_anchor(self):
        self.jump(25050)
        self.wait_anchor(25050)
        self.assertEqual(self.page.evaluate('STATE.results[25050].File'), 'paging-25050')
        self.assertTrue(self.page.evaluate('windowCalls.every(page=>[1,498,499,500,250,251,252].includes(page))'))
        self.assertEqual(self.page.evaluate('getResultStableId(STATE.results[49850])'), 'VoiceOfML/Test\0paging-49850.txt')

    def test_failed_gap_keeps_saved_position_and_can_retry(self):
        self.page.set_viewport_size({'width':390,'height':844})
        self.page.evaluate('windowFailures.add(251);saveSearchPosition()')
        self.jump(25050)
        self.page.locator('#search-window-status').get_by_text('重试加载', exact=True).wait_for()
        self.assertEqual(self.page.evaluate('searchPositions.get(originalWindowKey).index'), 49850)
        self.page.evaluate('windowFailures.clear()')
        self.page.locator('#search-window-status button').click()
        self.wait_anchor(25050)
        self.assertEqual(self.page.evaluate('windowCalls.filter(page=>page===251).length'), 2)

    def test_generation_change_relocates_without_mixing_pages(self):
        self.page.evaluate("saveSearchPosition();windowGeneration='two';windowAnchor=35050")
        self.jump(25050)
        self.page.locator('#search-window-status').get_by_text('重新定位', exact=True).wait_for()
        self.assertFalse(self.page.evaluate('!!STATE.results[25050]'))
        self.page.locator('#search-window-status button').click()
        self.wait_anchor(35050)
        self.assertEqual(self.page.evaluate('STATE.results[35050].File'), 'paging-49850')
        self.assertEqual(self.page.evaluate('resultWindow.generation'), 'two')

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
        self.assertEqual(self.page.evaluate('Object.keys(selectedIndices).length'), 400)
        self.assertTrue(self.page.evaluate('Object.keys(selectedIndices).every(index=>!!STATE.results[index])'))
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("STATE.query='paging-original';doSearch()")
        self.wait_anchor(49850)
        self.assertEqual(self.page.evaluate('resultWindow.count'), 400)
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

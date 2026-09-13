"""Persisted visited pages and lightweight position saves in real Chromium."""
import unittest
from tests import test_position_window as windows


class RecentSearchPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        windows.PositionWindowTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        windows.PositionWindowTests.tearDownClass()

    def setUp(self):
        self.fixture = windows.PositionWindowTests()
        self.fixture.setUp()
        self.page = self.fixture.page
        self.fetcher = self.page.evaluate('fetchPositionPage.toString()')
        self.page.evaluate('''() => {
          const original=fetchPositionPage;
          fetchPositionPage=async(...args)=>{
            const data=await original(...args);
            const match=/paging-(\\d+)\\.txt$/.exec(args[3]||'');
            if(match && Number(match[1])!==49850) data.anchor_index=Number(match[1]);
            data.results.forEach(record=>record.SnapshotVersion=data.generation);
            return data;
          };
          STATE.results.forEach(record=>record.SnapshotVersion='one');
        }''')

    def tearDown(self):
        self.fixture.tearDown()

    def flush(self):
        self.page.evaluate('''() => new Promise(resolve=>{
          const tx=searchPositionDB.transaction(['positions','viewports','recent-pages']);tx.oncomplete=resolve;
        })''')

    def visit(self, index):
        self.fixture.jump(index)
        self.fixture.wait_anchor(index)
        self.page.evaluate('saveSearchPosition()')
        self.flush()

    def prepare_pages(self):
        self.visit(25050)
        self.visit(35050)
        self.visit(49850)

    def begin_restore(self):
        self.page.evaluate("STATE.query='paging-other';doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("searchViewSnapshots.clear();searchViewportSnapshots.clear();recentSearchPages.clear();windowCalls=[];windowStall=1;STATE.query='paging-original';doSearch()")
        self.page.wait_for_function('positionRestore?.preview && !!window.releaseWindow')

    def wait_cached(self, index):
        self.page.wait_for_function('''index=>!!positionRestore?.preview && !!STATE.results[index] &&
          findVirtualIndex(DOM.resultsContainer.scrollTop)===index &&
          Math.abs(DOM.resultsContainer.scrollTop-getVirtualOffset(index)-11)<2''', arg=index)

    def test_position_only_updates_do_not_encode_or_write_content_again(self):
        self.fixture.persist_viewport()
        self.flush()
        result = self.page.evaluate('''async () => {
          const counts={positions:0,viewports:0,'recent-pages':0,encodes:0};
          const put=IDBObjectStore.prototype.put,encode=TextEncoder.prototype.encode;
          IDBObjectStore.prototype.put=function(...args){if(this.name in counts)counts[this.name]++;return put.apply(this,args)};
          TextEncoder.prototype.encode=function(...args){counts.encodes++;return encode.apply(this,args)};
          try {
            for(let offset=1;offset<=20;offset++) {DOM.resultsContainer.scrollTop=getVirtualOffset(49850)+offset;saveSearchPosition()}
            await new Promise(resolve=>{const tx=searchPositionDB.transaction(['positions','viewports','recent-pages']);tx.oncomplete=resolve});
            return {...counts,offset:searchPositions.get(originalWindowKey).offset};
          } finally {IDBObjectStore.prototype.put=put;TextEncoder.prototype.encode=encode}
        }''')
        self.assertEqual(result, {'positions':20, 'viewports':0, 'recent-pages':0, 'encodes':0, 'offset':20})

    def test_new_index_reuses_covering_viewport_and_restores_latest_offset(self):
        self.fixture.persist_viewport()
        self.page.evaluate('window.keptViewport=searchViewportSnapshots.get(originalWindowKey)')
        self.visit(49855)
        self.assertTrue(self.page.evaluate('keptViewport===searchViewportSnapshots.get(originalWindowKey)'))
        self.begin_restore()
        self.wait_cached(49855)
        self.page.evaluate('releaseWindow()')
        self.fixture.wait_anchor(49855)

    def test_cached_pages_remain_visible_when_scrolling_during_validation(self):
        self.prepare_pages()
        self.begin_restore()
        self.fixture.jump(25050)
        self.wait_cached(25050)
        self.assertEqual(self.page.evaluate('STATE.results[25050].ID'), '25050')
        self.page.evaluate('window.keptRow=DOM.resultsList.querySelector(\'[data-index="25050"]\');releaseWindow()')
        self.fixture.wait_anchor(25050)
        self.assertTrue(self.page.evaluate('keptRow.isConnected && resultWindow.count===STATE.results.filter(Boolean).length'))
        self.assertNotIn(251, self.page.evaluate('windowCalls'))
        self.fixture.jump(35050)
        self.fixture.wait_anchor(35050)
        self.assertNotIn(351, self.page.evaluate('windowCalls'))

    def test_new_generation_revalidates_the_current_cached_anchor(self):
        self.prepare_pages()
        self.begin_restore()
        self.fixture.jump(25050)
        self.wait_cached(25050)
        self.page.evaluate("windowGeneration='two';windowStall=0;releaseWindow()")
        self.fixture.wait_anchor(25050)
        self.assertEqual(self.page.evaluate('resultWindow.generation'), 'two')
        self.assertTrue(self.page.evaluate("STATE.results.filter(Boolean).every(record=>record.SnapshotVersion==='two')"))
        self.assertIn(251, self.page.evaluate('windowCalls'))

    def test_reload_then_reverse_scroll_uses_persisted_pages_before_lookup(self):
        self.prepare_pages()
        self.page.set_viewport_size({'width':390,'height':844})
        self.page.wait_for_timeout(100)
        self.page.evaluate('saveSearchPosition()')
        self.flush()
        self.page.add_init_script('''document.addEventListener('DOMContentLoaded',()=>{
          window.windowCalls=[];window.windowFailures=new Set();window.windowGeneration='one';
          window.windowAnchor=49850;window.windowTotal=50001;window.windowStall=1;
          prefetchNextPage=()=>{};maybeLoadNextPage=()=>{};
          const original=(''' + self.fetcher + ''');
          fetchPositionPage=async (...args)=>{
            const data=await original(...args);
            data.results.forEach(record=>record.SnapshotVersion='one');return data;
          };
        });''')
        self.page.reload(wait_until='domcontentloaded')
        self.page.wait_for_function('positionRestore?.preview && !!window.releaseWindow')
        for index in [25050,35050,49850,35050,25050]:
            self.fixture.jump(index)
            self.wait_cached(index)
        self.assertEqual(self.page.evaluate('windowCalls'), [1])
        self.page.evaluate('releaseWindow()')
        self.fixture.wait_anchor(25050)
        self.assertNotIn(251, self.page.evaluate('windowCalls'))

    def test_regular_page_metadata_survives_snapshot_cloning(self):
        result = self.page.evaluate('''async () => {
          const data=cloneSearchData({results:STATE.results.slice(49800,49900),page:499,page_size:100,total:STATE.total,generation:'regular'});
          const results=STATE.results.map(cloneSearchResult),view={...displayedSearchView,results,window:null};
          saveRecentSearchPages(searchPositions.get(originalWindowKey),view,49850);
          recentSearchPages.clear();
          const entry=await readRecentSearchPage(originalWindowKey,499,{...resultWindow,generation:'regular'});
          return entry && {generation:entry.generation,id:entry.results[50].ID};
        }''')
        self.assertEqual(result, {'generation':'regular','id':'49850'})

    def test_late_disk_page_cannot_enter_another_query(self):
        self.prepare_pages()
        self.begin_restore()
        self.page.evaluate('''() => {
          const read=readRecentSearchPage;
          readRecentSearchPage=async (...args)=>{
            const data=await read(...args);
            if(args[1]===251)await new Promise(resolve=>window.releaseDisk=resolve);
            return data;
          };
        }''')
        self.fixture.jump(25050)
        self.page.wait_for_function('!!window.releaseDisk')
        self.page.evaluate("STATE.query='paging-latest';doSearch();releaseDisk();releaseWindow()")
        self.page.wait_for_function("!STATE.isLoading && STATE.query==='paging-latest'")
        self.assertTrue(self.page.evaluate('!resultWindow && STATE.results.length<1000'))

    def test_persistent_cache_rejects_expiry_other_queries_and_short_pages(self):
        self.prepare_pages()
        checks = self.page.evaluate('''async () => {
          const key=getSearchViewKey(),expected=resultWindow;
          recentSearchPages.clear();
          const entry=await readRecentSearchPage(key,251,expected);
          const good=entry?.results[50].ID==='25050';
          const other=await readRecentSearchPage(key+'other',251,expected);
          entry.savedAt=Date.now()-RECENT_SEARCH_PAGE_TTL-1;
          const expired=await readRecentSearchPage(key,251,expected);
          entry.savedAt=Date.now();entry.results.pop();
          const partial=await readRecentSearchPage(key,251,expected);
          return {good,other:other===null,expired:expired===null,partial:partial===null};
        }''')
        self.assertEqual(checks, {'good':True, 'other':True, 'expired':True, 'partial':True})

    def test_page_cache_is_bounded_and_oversized_pages_keep_all_live_results(self):
        self.fixture.persist_viewport()
        result = self.page.evaluate('''async () => {
          const position=searchPositions.get(originalWindowKey), view=displayedSearchView;
          for(let i=0;i<35;i++)saveRecentSearchPages(position,{...view,key:JSON.stringify({...JSON.parse(view.key),query:'bounded-'+i})},position.index);
          await new Promise(resolve=>{const tx=searchPositionDB.transaction('recent-pages');tx.oncomplete=resolve});
          const count=await new Promise(resolve=>{const request=searchPositionDB.transaction('recent-pages').objectStore('recent-pages').count();request.onsuccess=()=>resolve(request.result)});
          const oversizedKey=JSON.stringify({...JSON.parse(view.key),query:'oversized'});
          for(let i=49800;i<49900;i++)STATE.results[i]={...STATE.results[i],Metadata:'x'.repeat(4000)};
          saveRecentSearchPages(position,{...view,key:oversizedKey},position.index);
          return {count,memory:recentSearchPages.size,oversized:recentSearchPages.has(JSON.stringify([oversizedKey,499])),live:STATE.results.slice(49800,49900).length};
        }''')
        self.assertEqual(result, {'count':32, 'memory':32, 'oversized':False, 'live':100})

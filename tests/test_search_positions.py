"""Persistent positions: real IndexedDB, API paging, navigation and cancellation."""
import unittest
from tests import test_paging_recovery as paging


class SearchPositionTests(unittest.TestCase):
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
        self.page.add_init_script("window.addEventListener('DOMContentLoaded',()=>{pagingMode='normal'})")
        self.page.evaluate("pagingMode='normal'; STATE.query='paging-original'; doSearch()")
        self.page.wait_for_function("STATE.query==='paging-original' && !STATE.isLoading && STATE._pageCache[2]")
        self.page.evaluate('maybeLoadNextPage(false,true)')
        self.page.wait_for_function('STATE._loadedPage>=2 && !STATE.isLoading')
        self.page.evaluate('DOM.resultsContainer.scrollTop=getVirtualOffset(125)+17')
        self.page.wait_for_function('searchPositions.get(getSearchViewKey())?.index===125')
        self.saved = self.page.evaluate('searchPositions.get(getSearchViewKey())')
        self.page.evaluate('''() => new Promise(resolve => {
          const tx=searchPositionDB.transaction('positions');
          tx.objectStore('positions').get(getSearchViewKey()); tx.oncomplete=resolve;
        })''')

    def tearDown(self):
        self.fixture.tearDown()

    def assert_position(self):
        self.page.wait_for_function("!positionRestore && !STATE.isLoading && STATE.query==='paging-original'")
        self.page.wait_for_function('''saved => {
          const index=findVirtualIndex(DOM.resultsContainer.scrollTop);
          return getResultStableId(STATE.results[index])===saved.anchorId &&
            Math.abs(DOM.resultsContainer.scrollTop-getVirtualOffset(index)-saved.offset)<2;
        }''', arg=self.saved)
        self.assertEqual(self.fixture.errors, [])

    def test_reload_rebuilds_pages_from_indexeddb(self):
        self.page.reload(wait_until='domcontentloaded')
        self.assert_position()
        self.assertEqual(self.page.evaluate('pagingRequests.slice(0,2)'), [1, 2])
        self.assertGreaterEqual(self.page.evaluate('STATE.results.length'), 200)

    def test_evicted_results_after_filters_and_repo_round_trip(self):
        for ext in ['pdf', 'epub', 'txt']:
            self.page.evaluate('ext=>{STATE.filterExtensions=[ext]; scheduleFilterSearch()}', ext)
            self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("ROUTER.navigate('repo','Test')")
        self.page.wait_for_function("STATE.mode==='repo' && !STATE.isLoading")
        self.page.evaluate("ROUTER.navigate('global')")
        self.page.wait_for_function("STATE.mode==='global' && !STATE.isLoading")
        self.page.evaluate('''() => {
          searchViewSnapshots.clear(); searchResponseCache.clear();
          STATE.useLocalMode=false; apiAvailable=true;
          STATE.filterExtensions=[]; STATE.query='paging-original'; DOM.searchInput.value=STATE.query;
          scheduleFilterSearch();
        }''')
        self.assert_position()

    def test_history_click_recovers_evicted_position(self):
        self.page.evaluate("STATE.query='paging-other'; doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("searchViewSnapshots.clear(); addHistoryItem('paging-original'); DOM.searchInput.focus(); renderDropdown()")
        self.page.locator('.history-item[data-query="paging-original"]').click()
        self.assert_position()

    def test_cancelled_rebuild_does_not_apply_late_page(self):
        self.page.evaluate("STATE.query='paging-other'; doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate('''() => {
          searchViewSnapshots.clear();
          const fetchPage=fetchPositionPage;
          fetchPositionPage=async (...args)=>{
            const data=await fetchPage(...args);
            if(args[1]===2) await new Promise(resolve=>{window.releaseRestore=resolve});
            return data;
          };
          STATE.query='paging-original'; doSearch();
        }''')
        self.page.wait_for_function('!!window.releaseRestore')
        self.page.evaluate("STATE.query='paging-latest'; doSearch(); releaseRestore()")
        self.page.wait_for_function("STATE.query==='paging-latest' && !STATE.isLoading && !positionRestore")
        self.assertEqual(self.page.evaluate('displayedSearchView.key'), self.page.evaluate('getSearchViewKey()'))
        self.assertEqual(self.page.evaluate('searchPositions.get(' + repr(self.saved['key']) + ').anchorId'), self.saved['anchorId'])
        self.assertEqual(self.fixture.errors, [])

    def test_rebuild_failure_keeps_position_and_retry_succeeds(self):
        self.page.evaluate("STATE.query='paging-other'; doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate('''() => {
          searchViewSnapshots.clear(); window.positionFail=true;
          const fetchPage=fetchPositionPage;
          fetchPositionPage=(...args)=>window.positionFail?Promise.reject(new Error('offline')):fetchPage(...args);
          STATE.query='paging-original'; doSearch();
        }''')
        self.page.get_by_text('重试恢复', exact=True).wait_for()
        self.page.evaluate('window.positionFail=false')
        self.page.get_by_text('重试恢复', exact=True).click()
        self.assert_position()

    def test_local_worker_rebuild_restores_position_after_cache_eviction(self):
        self.page.evaluate("STATE.query=''; STATE.useLocalMode=true; doSearch()")
        self.page.wait_for_function('STATE.dataLoaded && !STATE.isLoading && STATE.results.length>=100')
        self.page.evaluate('maybeLoadNextPage(false,true)')
        self.page.wait_for_function('STATE._loadedPage>=2 && !STATE.isLoading')
        self.page.evaluate('DOM.resultsContainer.scrollTop=getVirtualOffset(120)+9')
        self.page.wait_for_function('searchPositions.get(getSearchViewKey())?.index===120')
        saved=self.page.evaluate('searchPositions.get(getSearchViewKey())')
        self.page.evaluate("STATE.query='paging-other'; doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate("searchViewSnapshots.clear(); STATE.query=''; doSearch()")
        self.page.wait_for_function('!positionRestore && !STATE.isLoading')
        self.page.wait_for_function('''saved=>{
          const index=findVirtualIndex(DOM.resultsContainer.scrollTop);
          return getResultStableId(STATE.results[index])===saved.anchorId &&
            Math.abs(DOM.resultsContainer.scrollTop-getVirtualOffset(index)-saved.offset)<2;
        }''',arg=saved)
        self.assertEqual(self.fixture.errors, [])

    def test_expiry_and_count_prune_positions_independently(self):
        result = self.page.evaluate('''async () => {
          const original=searchPositions.get(getSearchViewKey());
          await new Promise(resolve=>{
            const tx=searchPositionDB.transaction('positions','readwrite'),store=tx.objectStore('positions');
            for(let i=0;i<505;i++) store.put({...original,key:'test-'+i,savedAt:Date.now()-i*1000});
            store.put({...original,key:'expired',savedAt:Date.now()-SEARCH_POSITION_TTL-1});
            tx.oncomplete=resolve;
          });
          searchPositions.clear(); searchPositionDB.close(); await initSearchPositions();
          return {count:searchPositions.size,expired:searchPositions.has('expired'),oldest:searchPositions.has('test-504')};
        }''')
        self.assertEqual(result, {'count': 500, 'expired': False, 'oldest': False})

    def test_oversized_snapshot_does_not_evict_smaller_views(self):
        kept = self.page.evaluate('''() => {
          searchViewSnapshots.clear();
          searchViewSnapshots.set('small', {bytes: 1024});
          searchViewSnapshots.set('large', {bytes: SEARCH_VIEW_SNAPSHOT_BYTES_MAX+1});
          trimSearchViewSnapshots(); return [...searchViewSnapshots.keys()];
        }''')
        self.assertEqual(kept, ['small'])

    def test_unchanged_controls_reuse_snapshot_and_do_not_scan_storage(self):
        result = self.page.evaluate('''async () => {
          const first=saveSearchViewSnapshot(), results=first.results;
          let scans=0; const cursor=IDBIndex.prototype.openCursor;
          IDBIndex.prototype.openCursor=function(...args){scans++; return cursor.apply(this,args)};
          lastPositionPruneAt=Date.now();
          try {
            for(let i=0;i<20;i++) saveSearchViewSnapshot();
            const tx=searchPositionDB.transaction('positions');
            await new Promise(resolve=>{tx.oncomplete=resolve});
            return {same:searchViewSnapshots.get(getSearchViewKey()).results===results,scans};
          } finally {IDBIndex.prototype.openCursor=cursor;}
        }''')
        self.assertEqual(result, {'same': True, 'scans': 0})

    def begin_rebuild(self, script):
        self.page.evaluate("STATE.query='paging-other'; doSearch()")
        self.page.wait_for_function('!STATE.isLoading')
        self.page.evaluate('searchViewSnapshots.clear()')
        self.page.evaluate(script)
        self.page.evaluate("STATE.query='paging-original'; doSearch()")

    def test_retry_continues_from_failed_page(self):
        self.begin_rebuild('''() => {
          const original=fetchPositionPage; window.restoreCalls=[]; window.failPage=true;
          fetchPositionPage=async (...args)=>{
            restoreCalls.push(args[1]);
            if(args[1]===2 && failPage) throw new Error('offline');
            return original(...args);
          };
        }''')
        self.page.get_by_text('重试恢复', exact=True).wait_for()
        self.assertEqual(self.page.evaluate('positionRestore.page'), 1)
        self.page.evaluate('failPage=false')
        self.page.get_by_text('重试恢复', exact=True).click()
        self.assert_position()
        self.assertEqual(self.page.evaluate('restoreCalls.filter(page=>page<=2)'), [1, 2, 2])

    def test_same_total_generation_change_restarts_coherent_prefix(self):
        self.begin_rebuild('''() => {
          const original=fetchPositionPage; window.restoreCalls=[]; window.changed=false;
          fetchPositionPage=async (...args)=>{
            restoreCalls.push(args[1]); const data=await original(...args);
            if(args[1]===2) changed=true;
            return {...data,generation:changed?'new':'old'};
          };
        }''')
        self.page.get_by_text('搜索数据已更新，请重试恢复', exact=True).wait_for()
        self.assertEqual(self.page.evaluate('positionRestore.results.length'), 0)
        self.page.get_by_text('重试恢复', exact=True).click()
        self.assert_position()
        self.assertEqual(self.page.evaluate('restoreCalls.filter(page=>page<=2)'), [1, 2, 1, 2])

    def test_moved_anchor_loads_beyond_old_page_range(self):
        self.begin_rebuild('''() => {
          const original=fetchPositionPage;
          fetchPositionPage=async (...args)=>{
            const data=await original(...args);
            data.generation='moved';
            if(args[1]===1) data.anchor_index=250;
            if(args[1]===2) data.results[25].File='paging-250';
            if(args[1]===3) data.results[50].File='paging-125';
            return data;
          };
        }''')
        self.assert_position()
        self.assertEqual(self.page.evaluate('findVirtualIndex(DOM.resultsContainer.scrollTop)'), 250)
        self.assertGreaterEqual(self.page.evaluate('STATE._loadedPage'), 3)

    def test_parallel_rebuild_is_bounded_and_keeps_all_ids_in_order(self):
        self.begin_rebuild('''() => {
          pagingTotal=800;searchResponseCache.clear();
          const originalKey=[...searchPositions.keys()].find(key=>JSON.parse(key).query==='paging-original');
          searchPositions.get(originalKey).loadedPage=8;
          const original=fetchPositionPage;window.restoreCalls=[];window.restorePeak=0;let active=0;
          fetchPositionPage=async (...args)=>{
            restoreCalls.push(args[1]);active++;restorePeak=Math.max(restorePeak,active);
            await new Promise(resolve=>setTimeout(resolve,args[1]%3===2?60:10));
            try {return await original(...args);} finally {active--;}
          };
        }''')
        self.assert_position()
        self.assertEqual(self.page.evaluate('restorePeak'), 3)
        self.assertEqual(self.page.evaluate('restoreCalls'), list(range(1, 9)))
        self.assertEqual(self.page.evaluate('STATE.results.map(record=>record.ID)'), [str(i) for i in range(800)])

    def test_parallel_retry_reuses_completed_suffix(self):
        self.begin_rebuild('''() => {
          pagingTotal=400;searchResponseCache.clear();
          const key=[...searchPositions.keys()].find(key=>JSON.parse(key).query==='paging-original');
          searchPositions.get(key).loadedPage=4;
          const original=fetchPositionPage;window.restoreCalls=[];window.failPage=true;
          fetchPositionPage=async (...args)=>{
            restoreCalls.push(args[1]);
            if(args[1]===2 && failPage) throw new Error('offline');
            return original(...args);
          };
        }''')
        self.page.get_by_text('重试恢复', exact=True).wait_for()
        self.assertEqual(self.page.evaluate('[positionRestore.page,...positionRestore.ready.keys()]'), [1,3,4])
        self.page.evaluate('failPage=false')
        self.page.get_by_text('重试恢复', exact=True).click()
        self.assert_position()
        self.assertEqual(self.page.evaluate('restoreCalls'), [1,2,3,4,2])
        self.assertEqual(self.page.evaluate('STATE.results.length'), 400)

    def test_parallel_generation_mismatch_discards_entire_buffer(self):
        self.begin_rebuild('''() => {
          pagingTotal=400;searchResponseCache.clear();
          const key=[...searchPositions.keys()].find(key=>JSON.parse(key).query==='paging-original');
          searchPositions.get(key).loadedPage=4;
          const original=fetchPositionPage;window.coherent=false;
          fetchPositionPage=async (...args)=>({...await original(...args),generation:coherent||args[1]===3?'new':'old'});
        }''')
        self.page.get_by_text('搜索数据已更新，请重试恢复', exact=True).wait_for()
        self.assertEqual(self.page.evaluate('[positionRestore.results.length,positionRestore.ready.size,positionRestore.page]'), [0,0,0])
        self.page.evaluate('coherent=true')
        self.page.get_by_text('重试恢复', exact=True).click()
        self.assert_position()

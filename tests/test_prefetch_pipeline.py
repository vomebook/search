"""Bounded API lookahead, joining and persistent page validation in Chromium."""
import unittest
from tests import test_paging_recovery as paging


class PrefetchPipelineTests(unittest.TestCase):
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

    def tearDown(self):
        errors = self.fixture.errors[:]
        self.fixture.tearDown()
        self.assertEqual(errors, [])

    def start_pipeline(self):
        self.page.evaluate('''() => {
          const native=window.fetch;window.aheadCalls=[];window.aheadReleases={};
          window.aheadActive=0;window.aheadPeak=0;window.pagingTotal=801;window.pagingMode='normal';
          window.fetch=(url,options)=>{
            const body=JSON.parse(options?.body||'{}');
            if(!String(url).includes('/api/search') || body.q!=='paging-pipeline' || body.page===1) return native(url,options);
            aheadCalls.push(body.page);aheadActive++;aheadPeak=Math.max(aheadPeak,aheadActive);
            return new Promise(resolve=>aheadReleases[body.page]=()=>{
              aheadActive--;resolve(new Response(JSON.stringify({page:body.page,page_size:body.page_size,total:801,
                results:Array.from({length:Math.min(body.page_size,801-(body.page-1)*body.page_size)},(_,i)=>({
                  ID:String((body.page-1)*body.page_size+i),Repo:'VoiceOfML/Test',File:'ahead',Extension:'txt',Folder:[]}))
              })));
            });
          };
          STATE.query='paging-pipeline';doSearch();
        }''')
        self.page.wait_for_function('aheadCalls.length===2 && !STATE.isLoading')

    def test_three_page_lookahead_joins_foreground_and_retains_later_pages(self):
        self.start_pipeline()
        self.assertEqual(self.page.evaluate('aheadCalls'), [2,3])
        self.page.evaluate('aheadReleases[3]()')
        self.page.wait_for_function('aheadCalls.includes(4)')
        self.page.evaluate('aheadReleases[4]()')
        self.page.wait_for_function('!!STATE._pageCache[4]')
        self.assertEqual(self.page.evaluate('[STATE._loadedPage,STATE.results.length,aheadPeak]'), [1,100,2])
        self.fixture.reach_bottom()
        self.page.evaluate('aheadReleases[2]()')
        self.page.wait_for_function('STATE._loadedPage===2 && !STATE.isLoading')
        self.assertEqual(self.page.evaluate('aheadCalls.filter(p=>p<=4)'), [2,3,4])
        self.assertEqual(self.page.evaluate('Object.keys(STATE._pageCache).map(Number).filter(p=>p<=4)'), [3,4])
        self.assertEqual(self.page.evaluate('STATE.results.slice(100).map(r=>r.ID)'), [str(i) for i in range(100,200)])
        self.page.evaluate('STATE.page=3;consumeCachedAppendPage()')
        self.assertEqual(self.page.evaluate('STATE.results.slice(200).map(r=>r.ID)'), [str(i) for i in range(200,300)])

    def test_query_change_discards_all_late_lookahead_pages(self):
        self.start_pipeline()
        self.page.evaluate("STATE.query='paging-new';window.pagingTotal=1;doSearch()")
        self.page.wait_for_function('!STATE.isLoading && STATE.results.length===1')
        self.page.evaluate('aheadReleases[2]();aheadReleases[3]()')
        self.page.wait_for_timeout(50)
        self.assertEqual(self.page.evaluate('[STATE.query,STATE.results.length,Object.keys(STATE._pageCache).length]'), ['paging-new',1,0])

    def test_sparse_window_prefetch_tracks_visible_position_and_reserves_a_slot(self):
        result = self.page.evaluate('''() => {
          const previous=resultWindow,loader=loadResultWindowPage,finder=findVirtualIndex;
          const loaded=STATE._loadedPage;const calls=[];
          try {
            STATE._loadedPage=1000;resultWindow={pending:new Map()};findVirtualIndex=()=>450;
            loadResultWindowPage=(page,prefetch)=>{calls.push([page,prefetch]);resultWindow.pending.set(page,true)};
            prefetchNextPage();prefetchNextPage();return calls;
          } finally {resultWindow=previous;loadResultWindowPage=loader;findVirtualIndex=finder;STATE._loadedPage=loaded}
        }''')
        self.assertEqual(result, [[6,True],[7,True]])

    def test_matching_saved_pages_avoid_network_and_old_generation_is_rejected(self):
        result = self.page.evaluate('''async () => {
          searchPrefetchAbortController?.abort();searchPrefetchAbortController=null;
          STATE._pageCache={};searchResponseCache.clear();recentSearchPages.clear();
          const key=getSearchViewKey();const template={q:STATE.query,page:1,page_size:100};
          const metadata={generation:'stable',page:1,page_size:100,total:STATE.total,results:STATE.results};
          rememberSearchPageMetadata(metadata);
          const cached=[];
          for(let page=2;page<=4;page++) {
            const entry={key,id:[key,page],page,page_size:100,total:STATE.total,generation:'stable',savedAt:Date.now(),
              results:Array.from({length:Math.min(100,STATE.total-(page-1)*100)},(_,i)=>({ID:String((page-1)*100+i),File:'cached'}))};
            cached.push(entry);cacheRecentSearchPage(entry);
          }
          window.networkPages=[];
          const native=fetchSearchPage;
          fetchSearchPage=async(...args)=>{networkPages.push(args[2].page);return {...cached[args[2].page-2],generation:'stable'}};
          try {
            prefetchSearchPages('/api/search',template);
            while(controllerActive()) await new Promise(resolve=>setTimeout(resolve,0));
            const reused=Object.keys(STATE._pageCache).map(Number);
            const calls=networkPages.slice();
            searchPrefetchAbortController.abort();searchPrefetchAbortController=null;STATE._pageCache={};searchResponseCache.clear();
            cached.forEach(entry=>cacheRecentSearchPage({...entry,generation:'old'}));
            prefetchSearchPages('/api/search',template);
            while(controllerActive()) await new Promise(resolve=>setTimeout(resolve,0));
            return {reused,calls,revalidated:networkPages};
          } finally {fetchSearchPage=native}
          function controllerActive(){return searchPrefetchAbortController?.active.size}
        }''')
        self.assertEqual(result, {'reused':[2,3,4], 'calls':[], 'revalidated':[2,3,4]})

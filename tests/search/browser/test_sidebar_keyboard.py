"""Lazy directory UI and keyboard ownership in real Chromium."""
import unittest
from tests.search.browser import test_paging_recovery as paging


class SidebarKeyboardTests(unittest.TestCase):
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
        self.assertEqual(self.fixture.errors, [])
        self.fixture.tearDown()

    def await_initial_extension_metadata(self):
        # The fixture's first result page can finish before startup metadata.
        # A still-pending fetchExtensions() writes to the shared cache when it
        # resolves, so settle it before installing a synthetic inventory.
        self.page.wait_for_function('filterRenderDone === filterRenderToken && extensionApiPending.size === 0')

    def test_deep_sidebar_toggles_skip_full_result_snapshots(self):
        result = self.page.evaluate('''async () => {
          cancelSearchPrefetch();searchAbortController?.abort();cancelPositionRestore();
          STATE.results=Array.from({length:50000},(_,i)=>({Repo:'VoiceOfML/Test',File:'deep-'+i,
            Extension:'txt',Folder:[],Size:1}));
          STATE.total=50000;STATE._loadedPage=500;STATE.page=500;STATE.hasMore=false;STATE.isLoading=false;
          STATE.mode='repo';STATE.repo='Test';STATE.repoFull='VoiceOfML/Test';
          const style=document.createElement('style');
          style.textContent='.result-item{height:100px!important;min-height:0!important;box-sizing:border-box}';
          document.head.append(style);
          resetVirtualScrollState();renderResults();setResultScrollTop(getVirtualOffset(40000)+12);
          await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          const before={index:findVirtualIndex(getResultScrollTop()),total:STATE.total,length:STATE.results.length};
          const original=saveSearchViewSnapshot;let snapshots=0;
          saveSearchViewSnapshot=(...args)=>{snapshots++;return original(...args)};
          const timings=[];
          for(const id of ['hamburger-btn','hamburger-btn','settings-btn','settings-btn','sidebar-expand-btn','sidebar-expand-btn']) {
            const start=performance.now();document.getElementById(id).click();timings.push(performance.now()-start);
            await new Promise(r=>setTimeout(r,180));
          }
          STATE.rightSidebarOpen=true;updateSidebarVisibility();
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
          const sideSnapshots=snapshots;
          const after={index:findVirtualIndex(getResultScrollTop()),total:STATE.total,length:STATE.results.length};
          saveSearchViewSnapshot=()=>{snapshots++};
          DOM.sortSelect.dispatchEvent(new Event('change',{bubbles:true}));
          return {sideSnapshots,filterSnapshot:snapshots>sideSnapshots,before,after,timings};
        }''')
        self.assertEqual(result['sideSnapshots'], 0)
        self.assertTrue(result['filterSnapshot'])
        self.assertEqual(result['before'], result['after'])

    def test_result_repository_is_text_in_attributes_and_labels(self):
        result = self.page.evaluate('''() => {
          const repo = 'x"><img src=x onerror="window.injected=true">';
          const row = document.createElement('div');
          row.innerHTML = buildResultHTML({Repo:repo, File:'book', Extension:'txt', Folder:['docs'], Size:1}, 0);
          DOM.resultsList.append(row);
          return {images:row.querySelectorAll('img').length,
            attributes:Array.from(row.querySelectorAll('[data-repo]'), node=>node.dataset.repo),
            label:row.querySelector('.result-repo-tag').textContent, repo};
        }''')
        self.assertEqual(result['images'], 0)
        self.assertEqual(result['attributes'], [result['repo']] * 3)
        self.assertEqual(result['label'], result['repo'])

    def test_neutral_controls_skip_snapshots_but_filter_changes_capture(self):
        result = self.page.evaluate('''() => {
          const original=saveSearchViewSnapshot;let captures=0;
          saveSearchViewSnapshot=()=>{captures++};
          DOM.searchInput.click();DOM.themeBtn.click();
          DOM.historyToggle.dispatchEvent(new Event('change',{bubbles:true}));
          STATE.folderTree=[{name:'root',path:'root',count:1,selfCount:0,children:[
            {name:'child',path:'root/child',count:1,selfCount:1,children:[]}]}];
          STATE.folderTreeCollapsed={root:true};renderFilterFolderTree();
          DOM.filterFolderTree.querySelector('.tree-toggle').click();
          const neutral=captures;
          DOM.sortSelect.dispatchEvent(new Event('change',{bubbles:true}));
          saveSearchViewSnapshot=original;
          return {neutral,filter:captures>neutral};
        }''')
        self.assertEqual(result, dict(neutral=0, filter=True))

    def test_pending_size_filter_is_applied_when_sort_changes(self):
        self.page.clock.install()
        self.page.locator('#settings-btn').click()
        self.page.evaluate("pagingMode='normal';cancelSearchPrefetch()")
        self.page.evaluate('''() => {
          const previous=window.fetch;window.sizeFilterBodies=[];
          window.fetch=(input,options)=>{
            if (String(input).includes('/api/search')) {
              try { sizeFilterBodies.push(JSON.parse(options.body)); } catch (_) {}
            }
            return previous(input,options);
          };
        }''')
        self.page.locator('#filter-min-size').fill('7')
        self.page.locator('#sort-select').select_option('name')
        self.page.clock.fast_forward(1000)
        self.page.wait_for_function("sizeFilterBodies.some(body=>body.page===1 && body.sort==='name') && !STATE.isLoading")
        actual=self.page.evaluate('''() => ({value:DOM.filterMinSize.value,unit:DOM.filterMinUnit.value,
          min:STATE.filterMinSize,sort:STATE.sort,hash:location.hash,
          body:sizeFilterBodies.find(body=>body.page===1 && body.sort==='name')})''')
        self.assertEqual(actual['value'], '7')
        self.assertEqual(actual['unit'], 'MB')
        self.assertEqual(actual['min'], 7 * 1048576, actual)
        self.assertEqual(actual['body']['min_size'], 7 * 1048576, actual)

    def test_size_debounce_and_exact_saved_bytes_are_preserved(self):
        self.page.clock.install()
        self.page.locator('#settings-btn').click()
        self.page.clock.pause_at(self.page.evaluate('Date.now() + 100'))
        self.page.evaluate('''() => {
          pagingMode='normal';cancelSearchPrefetch();window.sizeFilterBodies=[];
          const previous=window.fetch;
          window.fetch=(input,options)=>{
            if (String(input).includes('/api/search')) {
              try { sizeFilterBodies.push(JSON.parse(options.body)); } catch (_) {}
            }
            return previous(input,options);
          };
        }''')
        self.page.evaluate('''() => {
          DOM.filterMinUnit.value='KB';DOM.filterMinSize.value='1.5';
          DOM.filterMinSize.dispatchEvent(new Event('input',{bubbles:true}));
        }''')
        self.page.clock.fast_forward(400)
        self.assertIsNone(self.page.evaluate('STATE.filterMinSize'))
        self.page.clock.fast_forward(101)
        self.page.wait_for_function('sizeFilterBodies.some(b=>b.page===1 && b.min_size===1536) && !STATE.isLoading')
        self.assertEqual(self.page.evaluate('STATE.filterMinSize'),1536)
        # A restored byte limit can be more precise than its displayed value.
        self.page.evaluate('''() => {
          STATE.filterMinSize=1025;const display=bytesToDisplay(1025);
          DOM.filterMinSize.value=display.value;DOM.filterMinUnit.value=display.unit;
        }''')
        self.page.locator('#sort-select').select_option('name')
        self.page.clock.fast_forward(1000)
        self.page.wait_for_function("sizeFilterBodies.some(b=>b.page===1 && b.sort==='name') && !STATE.isLoading")
        self.assertEqual(self.page.evaluate('STATE.filterMinSize'),1025)
        self.assertEqual(self.page.evaluate("sizeFilterBodies.find(b=>b.page===1 && b.sort==='name').min_size"),1025)

    def test_pending_size_filter_composes_with_extension_and_query(self):
        self.page.clock.install()
        self.page.locator('#settings-btn').click()
        self.page.evaluate('''() => {
          pagingMode='normal';cancelSearchPrefetch();window.sizeFilterBodies=[];
          const previous=window.fetch;
          window.fetch=(input,options)=>{
            if (String(input).includes('/api/search')) {
              try { sizeFilterBodies.push(JSON.parse(options.body)); } catch (_) {}
            }
            return previous(input,options);
          };
          extensionList=['txt','pdf'];extensionCounts={txt:2,pdf:3};
          STATE.filterExtensions=[];renderExtensionFilter(routeRenderId);
        }''')
        self.page.locator('#filter-min-size').fill('0')
        self.page.locator('#filter-max-size').fill('1.5')
        self.page.locator('#filter-max-unit').select_option('KB')
        self.page.locator('#filter-ext-list input[value="txt"]').check()
        self.page.clock.fast_forward(1000)
        self.page.wait_for_function("sizeFilterBodies.some(b=>b.page===1 && b.min_size===0 && b.max_size===1536 && b.extensions?.includes('txt')) && !STATE.isLoading")
        self.assertEqual(self.page.evaluate('[STATE.filterMinSize,STATE.filterMaxSize]'), [0,1536])
        self.page.locator('#filter-min-size').fill('2')
        self.page.locator('#search-input').fill('paging-combined')
        self.page.locator('#search-input').press('Enter')
        self.page.clock.fast_forward(1000)
        self.page.wait_for_function("sizeFilterBodies.some(b=>b.q==='paging-combined' && b.page===1) && !STATE.isLoading")
        result=self.page.evaluate('''() => ({body:sizeFilterBodies.find(b=>b.q==='paging-combined' && b.page===1),
          min:STATE.filterMinSize,max:STATE.filterMaxSize,hash:location.hash})''')
        self.assertEqual(result['min'],2*1048576,result)
        self.assertEqual(result['max'],1536,result)
        self.assertEqual(result['body']['min_size'],2*1048576,result)
        self.assertEqual(result['body']['max_size'],1536,result)
        self.assertEqual(result['body']['extensions'],['txt'],result)

    def test_clear_all_discards_pending_size_and_cancels_its_timer(self):
        self.page.clock.install()
        self.page.locator('#settings-btn').click()
        self.page.evaluate('''() => {
          pagingMode='normal';cancelSearchPrefetch();
          STATE.filterExtensions=['txt'];updateStatusBar();
        }''')
        self.page.locator('#filter-min-size').fill('5')
        self.page.locator('#clear-filters-btn').click()
        self.page.clock.fast_forward(1000)
        self.page.wait_for_function('!STATE.isLoading')
        result=self.page.evaluate('''() => ({min:STATE.filterMinSize,max:STATE.filterMaxSize,
          value:DOM.filterMinSize.value,timer:sizeFilterTimer,extensions:STATE.filterExtensions,
          hash:location.hash})''')
        self.assertIsNone(result['min'],result)
        self.assertIsNone(result['max'],result)
        self.assertIsNone(result['timer'],result)
        self.assertEqual(result['value'],'',result)
        self.assertEqual(result['extensions'],[],result)
        self.assertNotIn('min_size=',result['hash'],result)

    def test_pending_size_filter_composes_with_folder_and_sidebar(self):
        self.page.clock.install()
        self.page.locator('#settings-btn').click()
        self.page.evaluate('''() => {
          pagingMode='normal';cancelSearchPrefetch();window.sizeFilterBodies=[];
          STATE.useLocalMode=true;STATE.dataLoaded=true;
          doSearchLocal=async params=>{
            sizeFilterBodies.push({min:params.minSize,folder:params.folderSubtrees.slice()});
            return {results:[],total:0,page:params.page,page_size:params.pageSize};
          };
          STATE.mode='repo';STATE.repo='Test';STATE.repoFull='VoiceOfML/Test';
          STATE.folderTree=[{path:'docs',name:'docs',count:1,children:[],hasDirectFiles:true}];
          STATE.filterFolderSelfs=[];STATE.filterFolderSubtrees=[];STATE.filterFolders=[];
          DOM.filterFolderSection.style.display='';renderFilterFolderTree();
        }''')
        self.page.locator('#filter-min-size').fill('3')
        self.page.locator('#filter-folder-tree input').check()
        self.page.clock.fast_forward(1000)
        self.page.wait_for_function("sizeFilterBodies.some(b=>b.min===3*1048576 && b.folder.includes('docs')) && !STATE.isLoading")
        self.assertEqual(self.page.evaluate('STATE.filterMinSize'),3*1048576)
        self.page.locator('#filter-min-size').fill('4')
        self.page.locator('#hamburger-btn').click()
        self.page.clock.fast_forward(1000)
        self.page.wait_for_function("sizeFilterBodies.some(b=>b.min===4*1048576 && b.folder.includes('docs')) && !STATE.isLoading")
        self.assertEqual(self.page.evaluate('STATE.filterMinSize'),4*1048576)

    def test_navigation_preserves_zero_and_exact_byte_size_limits(self):
        result = self.page.evaluate('''() => {
          ROUTER.apply=()=>{};
          STATE.filterMaxSize=0;STATE.filterMinSize=null;
          ROUTER.navigate('repo','Test');
          const max=new URLSearchParams(location.hash.split('?')[1]).get('max_size');
          const sizes=[0,1,1024,1025,1048577,1073741825];
          return {max, parsed:parseSizeStr(max), display:bytesToDisplay(0),
            roundtrips:sizes.map(size=>parseSizeStr(fmtSizeUrl(size)))};
        }''')
        self.assertEqual(result, dict(max='0B', parsed=0, display=dict(value='0',unit='B'),
                                     roundtrips=[0,1,1024,1025,1048577,1073741825]))

    def test_navigation_and_folder_click_preserve_common_url_options(self):
        result = self.page.evaluate('''() => {
          ROUTER.apply=()=>{};
          Object.assign(STATE,{mode:'global',query:'phone',filterRepos:['VoiceOfML/Test'],
            filterExtensions:['txt','pdf'],filterMinSize:1024,filterMaxSize:2097152,
            sort:'name',searchFolders:false,exact:false,useLocalMode:false,
            recordHistory:false,useMirrorLinks:false,browserPath:'',
            leftSidebarOpen:false,rightSidebarOpen:true});
          DOM.sortSelect.value='name';DOM.leftSidebar.classList.add('expanded-wide');
          const params=()=>Object.fromEntries(new URLSearchParams(location.hash.split('?')[1]));
          syncStateToURL();const synced=params();
          ROUTER.navigate('repo','Test');const navigated=params();
          const link=document.createElement('button');link.className='path-folder';
          link.dataset.folder='docs/中文';link.dataset.repo='Test';
          DOM.resultsList.append(link);link.click();
          return {synced,navigated,folder:params()};
        }''')
        common = dict(ext='txt,pdf',sort='name',search_folders='false',exact='0',
                      local='0',history='0',mirror='0',sidebar='0',filters='1',wide='1')
        self.assertEqual(result, dict(
            synced=dict(common,q='phone',repo='Test',min_size='1024',max_size='2097152'),
            navigated=dict(common,min_size='1KB',max_size='2MB'),
            folder=dict(common,q='phone',min_size='1KB',max_size='2MB',path='docs/中文',folder_subtree='docs/中文')))

    def test_result_breadcrumb_opens_subtree_sidebar_and_supports_history(self):
        # Replace only the local test corpus, not the real search data. Include
        # direct files, deep descendants, a similarly named sibling and a root.
        self.page.evaluate('''async () => {
          cancelSearchPrefetch();searchAbortController?.abort();cancelPositionRestore();
          history.replaceState(null,'','#/');
          const data={v:2,rp:['VoiceOfML/Test'],fd:[[],['docs'],['docs','子'],['docs2']],rc:[
            [0,'root','txt',0,1,0],[0,'direct','txt',1,1,0],
            [0,'deep','txt',2,1,0],[0,'sibling','txt',3,1,0]]};
          await corpusWorkerRequest('replace-corpus',{data});STATE.dataLoaded=true;
          const tree=[{name:'docs',path:'docs',count:2,hasDirectFiles:true,hasChildren:true,children:[
            {name:'子',path:'docs/子',count:1,hasDirectFiles:true,hasChildren:false,children:[]}]},
            {name:'docs2',path:'docs2',count:1,hasDirectFiles:true,hasChildren:false,children:[]}];
          getFolderContents=async (_repo,path)=>({folders:[],files:[{name:(path||'ROOT')+'.txt',ext:'txt',size:1}]});
          folderTreeCache.set('VoiceOfML/Test',tree);
          fetchFolderTree=async()=>tree;
          loadSidebarInitial=async()=>null;
          apiAvailable=false;STATE.useLocalMode=true;STATE.query='';STATE.filterExtensions=[];
          STATE.filterMinSize=null;STATE.filterMaxSize=null;STATE.filterRepos=[];
          STATE.mode='global';STATE.repo=null;STATE.repoFull=null;STATE.browserPath='';
          STATE.filterFolderSelfs=[];STATE.filterFolderSubtrees=[];STATE.filterFolders=[];
          window.__breadcrumbClick=(folder)=>{
            const row=document.createElement('div');row.innerHTML=buildResultHTML({Repo:'VoiceOfML/Test',
              File:'deep',Extension:'txt',Folder:['docs','子'],Size:1},0);
            DOM.resultsList.append(row);
            Array.from(row.querySelectorAll('.path-folder')).find(link=>link.dataset.folder===folder).click();};
        }''')
        self.page.evaluate("__breadcrumbClick('docs')")
        self.page.wait_for_function("""() => STATE.repo==='Test' && STATE.browserPath==='docs' &&
          STATE.filterFolderSubtrees.join()==='docs' && !STATE.isLoading && STATE.total===2 &&
          document.querySelector('.sidebar-breadcrumb .current')?.dataset.path==='docs'""", timeout=30000)
        self.assertEqual(set(self.page.evaluate('STATE.results.map(r=>r.File)')), {'direct','deep'})
        self.assertEqual(self.page.evaluate('STATE.filterFolderSelfs'), [])
        self.page.wait_for_function("document.querySelector('#filter-folder-tree [data-path=\"docs\"] input')?.checked")
        self.assertTrue(self.page.locator('#filter-folder-tree [data-path="docs/子"] input').is_checked())
        self.page.evaluate("renderBrowser('docs2', routeRenderId)")
        self.page.wait_for_function("STATE.browserPath==='docs2'")
        self.page.evaluate("__breadcrumbClick('docs')")
        self.page.wait_for_function("STATE.browserPath==='docs' && STATE.filterFolderSubtrees.join()==='docs'")

        self.page.evaluate("__breadcrumbClick('docs/子')")
        self.page.wait_for_function("STATE.browserPath==='docs/子' && STATE.total===1 && !STATE.isLoading")
        self.assertEqual(self.page.evaluate('STATE.results.map(r=>r.File)'), ['deep'])
        self.assertEqual(self.page.locator('.sidebar-breadcrumb .current').get_attribute('data-path'), 'docs/子')
        self.page.go_back(wait_until='domcontentloaded')
        self.page.wait_for_function("STATE.browserPath==='docs' && STATE.total===2 && !STATE.isLoading")
        self.page.go_forward(wait_until='domcontentloaded')
        self.page.wait_for_function("STATE.browserPath==='docs/子' && STATE.total===1 && !STATE.isLoading")

        self.page.evaluate("__breadcrumbClick('')")
        self.page.wait_for_function("STATE.browserPath==='' && !STATE.filterFolderSubtrees.length && STATE.total===4 && !STATE.isLoading")
        self.assertEqual(self.page.locator('.sidebar-breadcrumb .current').get_attribute('data-path'), '')
        self.assertEqual(set(self.page.evaluate('STATE.results.map(r=>r.File)')), {'root','direct','deep','sibling'})

    def test_rapid_result_breadcrumbs_do_not_replace_latest_sidebar(self):
        result = self.page.evaluate('''async () => {
          cancelSearchPrefetch();searchAbortController?.abort();cancelPositionRestore();
          const pending={};STATE.mode='repo';STATE.repo='Test';STATE.repoFull='VoiceOfML/Test';
          STATE.useLocalMode=true;STATE.dataLoaded=true;STATE.filterFolderSelfs=[];STATE.filterFolderSubtrees=[];
          history.replaceState(null,'','#/Test');
          getFolderContents=(_repo,path)=>new Promise(resolve=>{pending[path]=resolve});
          renderFilters=()=>Promise.resolve();searchWithInitialFallback=()=>{};
          const click=folder=>{const link=document.createElement('span');link.className='path-folder';
            link.dataset.repo='Test';link.dataset.folder=folder;DOM.resultsList.append(link);link.click();};
          click('old');await new Promise(resolve=>setTimeout(resolve,0));
          click('new');await new Promise(resolve=>setTimeout(resolve,0));
          pending.new({folders:[],files:[{name:'NEW.txt',ext:'txt',size:1}]});
          await new Promise(resolve=>setTimeout(resolve,0));
          pending.old({folders:[],files:[{name:'OLD.txt',ext:'txt',size:1}]});
          await new Promise(resolve=>setTimeout(resolve,0));
          return {path:STATE.browserPath,selection:STATE.filterFolderSubtrees.slice(),
            visible:DOM.sidebarContent.textContent.includes('NEW.txt'),stale:DOM.sidebarContent.textContent.includes('OLD.txt')};
        }''')
        self.assertEqual(result, dict(path='new',selection=['new'],visible=True,stale=False))

    def test_result_breadcrumb_keyboard_opens_matching_path(self):
        self.page.evaluate('''() => {
          STATE.mode='repo';STATE.repo='Test';STATE.repoFull='VoiceOfML/Test';STATE.useLocalMode=true;
          getFolderContents=async()=>({folders:[],files:[]});renderFilters=()=>Promise.resolve();
          searchWithInitialFallback=()=>{};history.replaceState(null,'','#/Test');
          DOM.resultsList.innerHTML='<span role="button" tabindex="0" class="path-folder" data-repo="Test" data-folder="docs/子">子</span>';
        }''')
        link=self.page.locator('.path-folder[role="button"]')
        link.focus()
        self.page.keyboard.press('Enter')
        self.page.wait_for_function("STATE.browserPath==='docs/子' && STATE.filterFolderSubtrees.join()==='docs/子'")
        self.assertEqual(self.page.locator('.sidebar-breadcrumb .current').get_attribute('data-path'), 'docs/子')

    def test_collapsed_tree_avoids_hidden_dom_and_keeps_selection(self):
        result = self.page.evaluate('''async () => {
          STATE.folderTree=[{name:'root',path:'root',count:1000,selfCount:0,children:
            Array.from({length:1000},(_,i)=>({name:'child'+i,path:'root/'+i,count:1,selfCount:1,children:[]}))}];
          STATE.folderTreeCollapsed={root:true};
          STATE.filterFolderSubtrees=[]; STATE.filterFolderSelfs=[]; STATE.filterFolders=[];
          renderFilterFolderTree();
          const initial=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          const root=DOM.filterFolderTree.querySelector('.filter-folder-item');
          root.querySelector('input').click();
          root.querySelector('.tree-toggle').click();
          const immediate=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          while(folderTreeRenderQueue.length) await new Promise(r=>setTimeout(r,10));
          const expanded=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          const child=DOM.filterFolderTree.querySelector('[data-path="root/0"] input');
          const inherited=child.checked; child.click();
          const partial=root.querySelector('input').indeterminate;
          const excluded=!child.checked;
          root.querySelector('.tree-toggle').click(); root.querySelector('.tree-toggle').click();
          return {initial,expanded,inherited,partial,excluded,bounded:immediate>1 && immediate<=33,
            final:DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length,
            siblings:DOM.filterFolderTree.querySelector('[data-path="root/1"] input').checked};
        }''')
        self.assertEqual(result, dict(initial=1, expanded=1001, inherited=True, partial=True,bounded=True,
                                      excluded=True, final=1001, siblings=True))

    def test_tree_rerender_has_one_delegated_action_and_respects_nested_collapse(self):
        result = self.page.evaluate('''async () => {
          STATE.folderTree=[{name:'a',path:'a',count:3,selfCount:1,showSelfToggle:true,children:[
            {name:'b',path:'a/b',count:2,selfCount:1,children:[{name:'c',path:'a/b/c',count:1,selfCount:1,children:[]}]}]}];
          STATE.folderTreeCollapsed={'a':false,'a/b':true};
          STATE.filterFolderSubtrees=[];STATE.filterFolderSelfs=[];STATE.filterFolders=[];
          // Force the first batch beyond its time budget, as can happen on a
          // busy runner, to exercise the asynchronous continuation explicitly.
          const append=appendFilterTreeNode;let deferred;
          appendFilterTreeNode=(...args)=>{append(...args);const end=performance.now()+6;while(performance.now()<end) {}};
          try {renderFilterFolderTree();renderFilterFolderTree();deferred=folderTreeRenderQueue.length>0;}
          finally {appendFilterTreeNode=append;}
          while(folderTreeRenderQueue.length) await new Promise(r=>setTimeout(r,0));
          const rows=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          DOM.filterFolderTree.querySelector('.folder-self-toggle').click();
          const selected=STATE.filterFolderSelfs.includes('a');
          DOM.filterFolderTree.querySelector('[data-path="a/b"] .tree-toggle').click();
          while(folderTreeRenderQueue.length) await new Promise(r=>setTimeout(r,0));
          return {deferred,rows,selected,final:DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length,
            childChecked:DOM.filterFolderTree.querySelector('[data-path="a/b/c"] input').checked};
        }''')
        self.assertEqual(result, dict(deferred=True, rows=2, selected=True, final=3, childChecked=False))

    def test_batched_expansion_cancels_and_refreshes_selection_for_late_rows(self):
        result=self.page.evaluate('''async () => {
          STATE.folderTree=[{name:'root',path:'root',count:1000,hasChildren:true,children:
            Array.from({length:1000},(_,i)=>({name:String(i),path:'root/'+i,count:1,hasDirectFiles:true,children:[]}))}];
          STATE.folderTreeCollapsed={root:true};STATE.filterFolderSubtrees=[];STATE.filterFolderSelfs=[];
          renderFilterFolderTree();const toggle=DOM.filterFolderTree.querySelector('.tree-toggle');
          toggle.click();const partial=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          toggle.click();await new Promise(r=>setTimeout(r,30));
          const stopped=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length===partial && !folderTreeRenderQueue.length;
          STATE.filterFolderSubtrees=['root'];refreshFilterFolderSelectionState();toggle.click();
          while(folderTreeRenderQueue.length) await new Promise(r=>setTimeout(r,10));
          const final=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          const late=DOM.filterFolderTree.querySelector('[data-path="root/999"] input').checked;
          STATE.folderTree=[{name:'new',path:'new',count:1,hasDirectFiles:true,children:[]}];renderFilterFolderTree();
          await new Promise(r=>setTimeout(r,30));
          return {stopped,final,late,current:DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length===1};
        }''')
        self.assertEqual(result,dict(stopped=True,final=1001,late=True,current=True))

    def test_parent_reopen_resumes_interrupted_open_descendant(self):
        result=self.page.evaluate('''async () => {
          STATE.folderTree=[{name:'root',path:'root',count:500,hasChildren:true,children:[
            {name:'branch',path:'root/b',count:500,hasChildren:true,children:Array.from({length:500},(_,i)=>
              ({name:String(i),path:'root/b/'+i,count:1,hasDirectFiles:true,children:[]}))}]}];
          STATE.folderTreeCollapsed={root:true,'root/b':false};renderFilterFolderTree();
          const toggle=DOM.filterFolderTree.querySelector('.tree-toggle');toggle.click();toggle.click();
          const stopped=!folderTreeRenderQueue.length;toggle.click();
          while(folderTreeRenderQueue.length) await new Promise(r=>setTimeout(r,10));
          return {stopped,complete:DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length===502,
            open:STATE.folderTreeCollapsed['root/b']===false};
        }''')
        self.assertEqual(result,dict(stopped=True,complete=True,open=True))

    def test_metadata_deadline_covers_body_and_allows_retry_without_breaker_failure(self):
        self.page.clock.install()
        self.page.evaluate('''() => {
          repoApiCache=null;repoApiPending=null;extensionApiCache.clear();folderTreeCache.clear();
          apiAvailable=true;noteApiSuccess();window.metadataResults=[];window.metadataCalls=0;
          const native=window.fetch;
          window.fetch=(url,options)=>String(url).includes('/api/repos') || String(url).includes('metadata-refactor')
            ? (metadataCalls++, Promise.resolve({ok:true,json:()=>new Promise((resolve,reject)=>{
                options.signal.addEventListener('abort',()=>reject(new DOMException('timed out','AbortError')));
              })})) : native(url,options);
          fetchRepos().then(value=>metadataResults.push(value));
          fetchRepos().then(value=>metadataResults.push(value));
          fetchExtensions('metadata-refactor').then(value=>metadataResults.push(value));
          fetchFolderTree('metadata-refactor').then(value=>metadataResults.push(value));
        }''')
        self.assertEqual(self.page.evaluate('metadataCalls'), 3)
        self.page.clock.fast_forward(5001)
        self.page.wait_for_timeout(20)
        self.assertEqual(self.page.evaluate('metadataResults'), [None] * 4)
        self.assertEqual(self.page.evaluate('[apiFailureCount,repoApiPending,extensionApiPending.size]'), [0, None, 0])
        result = self.page.evaluate('''async () => {
          window.fetch=()=>Promise.resolve(new Response('[]'));
          return Promise.all([fetchRepos(),fetchExtensions('metadata-refactor'),fetchFolderTree('metadata-refactor')]);
        }''')
        self.assertEqual(result, [[], [], []])

    def test_missing_extension_renders_without_poisoning_api_cache(self):
        self.await_initial_extension_metadata()
        self.page.evaluate('''async () => {
          cancelSearchPrefetch();searchAbortController?.abort();cancelPositionRestore();
          STATE.mode='global';STATE.repo=null;STATE.repoFull=null;STATE.useLocalMode=false;
          apiAvailable=true;extensionList=[];extensionCounts={};
          window.testExtensionInventory=[{name:'txt',count:2}];
          extensionApiCache.clear();extensionApiCache.set('__global__',testExtensionInventory);
          STATE.filterExtensions=['ghost'];await renderExtensionFilter(routeRenderId);
        }''')
        self.assertEqual(self.page.evaluate('testExtensionInventory.map(x=>x.name)'),['txt'])
        self.assertEqual(self.page.locator('#filter-ext-list input[value="ghost"]').count(),1)
        self.assertTrue(self.page.locator('#filter-ext-list input[value="ghost"]').is_checked())
        self.page.evaluate('DOM.extFilterCancel.click()')
        self.page.wait_for_function("STATE.filterExtensions.length===0 && !DOM.filterExtList.querySelector('input[value=ghost]')")
        self.assertEqual(self.page.evaluate('testExtensionInventory.map(x=>x.name)'),['txt'])
        self.page.evaluate('DOM.extSelectAll.click()')
        self.assertEqual(self.page.evaluate('STATE.filterExtensions'),['txt'])

    def test_real_type_remains_available_when_extension_metadata_is_refreshed(self):
        self.await_initial_extension_metadata()
        self.page.evaluate('''async () => {
          cancelSearchPrefetch();searchAbortController?.abort();cancelPositionRestore();
          STATE.mode='global';STATE.repo=null;STATE.repoFull=null;STATE.useLocalMode=false;
          apiAvailable=true;extensionList=[];extensionCounts={};
          window.oldExtensionInventory=[{name:'txt',count:2}];
          window.newExtensionInventory=[{name:'txt',count:4},{name:'ghost',count:3}];
          extensionApiCache.clear();extensionApiCache.set('__global__',oldExtensionInventory);
          STATE.filterExtensions=['ghost'];await renderExtensionFilter(routeRenderId);
        }''')
        row=self.page.locator('#filter-ext-list input[value="ghost"]')
        self.assertTrue(row.is_checked())
        self.assertEqual(row.locator('..').locator('.folder-count').text_content(),'0')
        self.page.evaluate('''async () => {
          extensionApiCache.set('__global__',newExtensionInventory);
          await renderExtensionFilter(routeRenderId);
        }''')
        row=self.page.locator('#filter-ext-list input[value="ghost"]')
        self.assertTrue(row.is_checked())
        self.assertEqual(row.locator('..').locator('.folder-count').text_content(),'3')
        self.assertEqual(self.page.evaluate('oldExtensionInventory.map(x=>x.name)'),['txt'])
        self.assertEqual(self.page.evaluate('newExtensionInventory.map(x=>x.name)'),['txt','ghost'])
        self.page.evaluate('DOM.extFilterCancel.click()')
        self.page.wait_for_function("STATE.filterExtensions.length===0 && DOM.filterExtList.querySelector('input[value=ghost]')")
        self.assertFalse(self.page.locator('#filter-ext-list input[value="ghost"]').is_checked())
        self.page.evaluate('DOM.extSelectAll.click()')
        self.assertEqual(self.page.evaluate('STATE.filterExtensions'),['txt','ghost'])

    def test_extension_cache_retains_clean_data_with_shared_inflight_request(self):
        self.await_initial_extension_metadata()
        outcome=self.page.evaluate('''async () => {
          extensionApiCache.clear();extensionApiPending.clear();noteApiSuccess();
          const original=window.fetch;let calls=0,finish;
          try {
            window.fetch=(input,options)=>String(input).includes('repo=fresh-test')
              ? (calls++,new Promise(resolve=>{
                  finish=()=>resolve(new Response('[{"name":"txt","count":2}]'));
                })) : original(input,options);
            const a=fetchExtensions('fresh-test'),b=fetchExtensions('fresh-test');finish();
            const [first,concurrent]=await Promise.all([a,b]);
            const sameInflightResult=first===concurrent;
            first.push({name:'ghost',count:0});
            const cached=await fetchExtensions('fresh-test');
            cached.push({name:'stale',count:0});
            const later=await fetchExtensions('fresh-test');
            return {calls,sameInflightResult,concurrent:concurrent.map(x=>x.name),
              later:later.map(x=>x.name),source:extensionApiCache.get('fresh-test').map(x=>x.name)};
          } finally {window.fetch=original;}
        }''')
        self.assertEqual(outcome,dict(calls=1,sameInflightResult=True,concurrent=['txt','ghost'],
                                      later=['txt'],source=['txt']))

    def test_first_view_gates_decode_until_matching_result_has_painted(self):
        outcome = self.page.evaluate(r'''async () => {
          const old={observer:window.MutationObserver,request:window.requestAnimationFrame,cancel:window.cancelAnimationFrame,
            getSearchViewKey,loaded:STATE._loadedPage,loading:STATE.isLoading,view:displayedSearchView,
            mobile:STATE.isMobile,open:STATE.leftSidebarOpen,delay:readerAssetDelayUntilPaint,wake:readerAssetParseWake};
          const frames=new Map();let next=0,callback,disconnected=0,done=false;
          try {
            window.MutationObserver=class {constructor(fn){callback=fn}observe(){}disconnect(){disconnected++}};
            window.requestAnimationFrame=fn=>{const id=++next;frames.set(id,fn);return id};
            window.cancelAnimationFrame=id=>frames.delete(id);
            STATE.isMobile=false;STATE.leftSidebarOpen=true;STATE._loadedPage=0;STATE.isLoading=true;
            readerAssetDelayUntilPaint=true;getSearchViewKey=()=>'expected';
            const controller=new AbortController();
            const pending=waitForReaderAssetFirstPaint(controller.signal,'expected').then(()=>{done=true});
            callback();const before={done,frames:frames.size};
            STATE._loadedPage=1;STATE.isLoading=false;displayedSearchView={...displayedSearchView,key:'wrong'};callback();
            const wrong={done,frames:frames.size};
            displayedSearchView={...displayedSearchView,key:'expected'};callback();
            const ready={done,frames:frames.size};
            const tick=()=>{const [id,fn]=frames.entries().next().value;frames.delete(id);fn()};
            tick();const first={done,frames:frames.size};tick();await pending;
            return {before,wrong,ready,first,done,frames:frames.size,disconnected,
              wake:readerAssetParseWake===null,delay:readerAssetDelayUntilPaint};
          } finally {
            window.MutationObserver=old.observer;window.requestAnimationFrame=old.request;window.cancelAnimationFrame=old.cancel;
            getSearchViewKey=old.getSearchViewKey;STATE._loadedPage=old.loaded;STATE.isLoading=old.loading;
            displayedSearchView=old.view;STATE.isMobile=old.mobile;STATE.leftSidebarOpen=old.open;
            readerAssetDelayUntilPaint=old.delay;readerAssetParseWake=old.wake;
          }
        }''')
        self.assertEqual(outcome, dict(before=dict(done=False,frames=0),wrong=dict(done=False,frames=0),
            ready=dict(done=False,frames=1),first=dict(done=False,frames=1),done=True,frames=0,
            disconnected=1,wake=True,delay=False))

    def test_first_view_gate_rechecks_loading_before_releasing_frame(self):
        result = self.page.evaluate(r'''async () => {
          const old={observer:window.MutationObserver,request:window.requestAnimationFrame,cancel:window.cancelAnimationFrame,
            getSearchViewKey,loaded:STATE._loadedPage,loading:STATE.isLoading,view:displayedSearchView,
            mobile:STATE.isMobile,open:STATE.leftSidebarOpen,delay:readerAssetDelayUntilPaint,wake:readerAssetParseWake};
          const frames=new Map();let next=0,callback,disconnected=0,done=false;
          try {
            window.MutationObserver=class {constructor(fn){callback=fn}observe(){}disconnect(){disconnected++}};
            window.requestAnimationFrame=fn=>{const id=++next;frames.set(id,fn);return id};
            window.cancelAnimationFrame=id=>frames.delete(id);
            STATE.isMobile=false;STATE.leftSidebarOpen=true;STATE._loadedPage=1;STATE.isLoading=false;
            readerAssetDelayUntilPaint=true;getSearchViewKey=()=>'expected';displayedSearchView={...displayedSearchView,key:'expected'};
            const pending=waitForReaderAssetFirstPaint(new AbortController().signal,'expected').then(()=>{done=true});
            const tick=()=>{const [id,fn]=frames.entries().next().value;frames.delete(id);fn()};
            STATE.isLoading=true;tick();tick();await Promise.resolve();
            const stalled={done,frames:frames.size,disconnected};
            STATE.isLoading=false;callback();tick();tick();await pending;
            return {stalled,done,disconnected,wake:readerAssetParseWake===null};
          } finally {
            window.MutationObserver=old.observer;window.requestAnimationFrame=old.request;window.cancelAnimationFrame=old.cancel;
            getSearchViewKey=old.getSearchViewKey;STATE._loadedPage=old.loaded;STATE.isLoading=old.loading;
            displayedSearchView=old.view;STATE.isMobile=old.mobile;STATE.leftSidebarOpen=old.open;
            readerAssetDelayUntilPaint=old.delay;readerAssetParseWake=old.wake;
          }
        }''')
        self.assertEqual(result,dict(stalled=dict(done=False,frames=0,disconnected=0),done=True,disconnected=1,wake=True))

    def test_first_view_decode_gate_handles_timeout_abort_and_unsupported_context(self):
        self.page.clock.install()
        self.page.evaluate(r'''() => {
          window.__gateOld={observer:window.MutationObserver,getSearchViewKey,loaded:STATE._loadedPage,
            loading:STATE.isLoading,mobile:STATE.isMobile,open:STATE.leftSidebarOpen,
            delay:readerAssetDelayUntilPaint,wake:readerAssetParseWake};
          window.__gateObservers=[];window.__gateResults=[];
          window.MutationObserver=class {constructor(fn){this.fn=fn;this.closed=false;__gateObservers.push(this)}
            observe(){}disconnect(){this.closed=true}};
          STATE.isMobile=false;STATE.leftSidebarOpen=true;STATE._loadedPage=0;STATE.isLoading=true;
          readerAssetDelayUntilPaint=true;getSearchViewKey=()=>'expected';
          window.__gateController=new AbortController();
          waitForReaderAssetFirstPaint(__gateController.signal,'expected').then(()=>__gateResults.push('released'),
            error=>__gateResults.push(error.name));
        }''')
        self.page.clock.fast_forward(751)
        self.page.wait_for_function('__gateResults.length === 1')
        self.assertEqual(self.page.evaluate('[__gateResults[0],__gateObservers[0].closed,readerAssetParseWake,readerAssetDelayUntilPaint]'),
                         ['released', True, None, False])
        self.page.evaluate('''() => {
          readerAssetDelayUntilPaint=true;window.__gateController=new AbortController();
          waitForReaderAssetFirstPaint(__gateController.signal,'expected').then(()=>__gateResults.push('released'),
            error=>__gateResults.push(error.name));__gateController.abort();
        }''')
        self.page.wait_for_function('__gateResults.length === 2')
        self.assertEqual(self.page.evaluate('[__gateResults[1],__gateObservers[1].closed,readerAssetParseWake,readerAssetDelayUntilPaint]'),
                         ['AbortError', True, None, False])
        result = self.page.evaluate('''async () => {
          const controller=new AbortController();readerAssetDelayUntilPaint=true;STATE.isMobile=true;
          await waitForReaderAssetFirstPaint(controller.signal,'expected');
          STATE.isMobile=false;STATE.leftSidebarOpen=false;await waitForReaderAssetFirstPaint(controller.signal,'expected');
          STATE.leftSidebarOpen=true;await waitForReaderAssetFirstPaint(controller.signal,'stale');
          return {observers:__gateObservers.length,wake:readerAssetParseWake};
        }''')
        self.assertEqual(result, {'observers':2,'wake':None})
        self.page.evaluate('''() => {
          const old=__gateOld;window.MutationObserver=old.observer;getSearchViewKey=old.getSearchViewKey;
          STATE._loadedPage=old.loaded;STATE.isLoading=old.loading;STATE.isMobile=old.mobile;STATE.leftSidebarOpen=old.open;
          readerAssetDelayUntilPaint=old.delay;readerAssetParseWake=old.wake;
        }''')

    def test_sidecar_fetch_continues_before_paint_and_user_demand_unblocks_decode(self):
        result = self.page.evaluate(r'''async () => {
          const old={fetch:window.fetch,observer:window.MutationObserver,getSearchViewKey,
            loaded:STATE._loadedPage,loading:STATE.isLoading,mobile:STATE.isMobile,open:STATE.leftSidebarOpen,
            delay:readerAssetDelayUntilPaint,assets:readerAssets,pending:readerAssetsPending,
            retry:readerAssetsRetryAt,wake:readerAssetParseWake};
          let calls=0,observer;
          try {
            readerAssets=null;readerAssetsPending=null;readerAssetsRetryAt=0;readerAssetDelayUntilPaint=true;
            STATE.isMobile=false;STATE.leftSidebarOpen=true;STATE._loadedPage=0;STATE.isLoading=true;
            getSearchViewKey=()=>'expected';
            window.MutationObserver=class {constructor(){observer=this;this.closed=false}observe(){}disconnect(){this.closed=true}};
            const payload={v:1,f:{sample:{s:2,m:'p',p:'sample.pdf'}}};
            window.fetch=(url, options)=>{
              if (!String(url).endsWith('/reader_assets.json.gz')) return old.fetch(url, options);
              calls++;return Promise.resolve(new Response(new Blob([JSON.stringify(payload)]).stream()
                .pipeThrough(new CompressionStream('gzip'))));
            };
            const first=loadReaderAssetsAfterFirstPaint();
            while (!readerAssetParseWake) await new Promise(resolve=>setTimeout(resolve,1));
            const before={calls,published:readerAssets!==null,pending:readerAssetsPending===first};
            const urgent=loadReaderAssets();
            const same=urgent===first;const value=await urgent;
            return {before,same,calls,value,published:readerAssets===value,observerClosed:observer.closed,
              wake:readerAssetParseWake,delay:readerAssetDelayUntilPaint};
          } finally {
            window.fetch=old.fetch;window.MutationObserver=old.observer;getSearchViewKey=old.getSearchViewKey;
            STATE._loadedPage=old.loaded;STATE.isLoading=old.loading;STATE.isMobile=old.mobile;STATE.leftSidebarOpen=old.open;
            readerAssetDelayUntilPaint=old.delay;readerAssets=old.assets;readerAssetsPending=old.pending;
            readerAssetsRetryAt=old.retry;readerAssetParseWake=old.wake;
          }
        }''')
        self.assertEqual(result, dict(before=dict(calls=1,published=False,pending=True),same=True,calls=1,
            value={'sample':{'s':2,'m':'p','p':'sample.pdf'}},published=True,observerClosed=True,wake=None,delay=False))

    def test_sidecar_view_identity_is_captured_before_slow_transfer(self):
        result = self.page.evaluate(r'''async () => {
          const old={fetch:window.fetch,loaded:STATE._loadedPage,loading:STATE.isLoading,
            mobile:STATE.isMobile,open:STATE.leftSidebarOpen,delay:readerAssetDelayUntilPaint,
            assets:readerAssets,pending:readerAssetsPending,retry:readerAssetsRetryAt,
            wake:readerAssetParseWake,getSearchViewKey,observer:window.MutationObserver};
          let release,calls=0,observerCount=0;
          try {
            readerAssets=null;readerAssetsPending=null;readerAssetsRetryAt=0;readerAssetDelayUntilPaint=true;
            STATE.isMobile=false;STATE.leftSidebarOpen=true;STATE._loadedPage=0;STATE.isLoading=true;
            let identity='initial';getSearchViewKey=()=>identity;
            window.MutationObserver=class {constructor(){observerCount++}observe(){}disconnect(){}};
            const payload={v:1,f:{sample:{s:2}}};
            window.fetch=(url,options)=>{
              if (!String(url).endsWith('/reader_assets.json.gz')) return old.fetch(url,options);
              calls++;return new Promise(resolve=>{release=()=>resolve(new Response(new Blob([JSON.stringify(payload)]).stream()
                .pipeThrough(new CompressionStream('gzip'))))});
            };
            const pending=loadReaderAssetsAfterFirstPaint();
            await Promise.resolve();await Promise.resolve();
            identity='different-route';
            while (!release) await new Promise(resolve=>setTimeout(resolve,1));
            release();
            const result=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('stale view waited')),400))]);
            return {result,calls,observerCount,wake:readerAssetParseWake};
          } finally {
            window.fetch=old.fetch;STATE._loadedPage=old.loaded;STATE.isLoading=old.loading;
            STATE.isMobile=old.mobile;STATE.leftSidebarOpen=old.open;readerAssetDelayUntilPaint=old.delay;
            readerAssets=old.assets;readerAssetsPending=old.pending;readerAssetsRetryAt=old.retry;
            readerAssetParseWake=old.wake;getSearchViewKey=old.getSearchViewKey;window.MutationObserver=old.observer;
          }
        }''')
        self.assertEqual(result, dict(result={'sample':{'s':2}},calls=1,observerCount=0,wake=None))

    def test_initial_sidecar_completion_updates_only_current_directory(self):
        result = self.page.evaluate(r'''async () => {
          cancelSearchPrefetch();searchAbortController?.abort();cancelPositionRestore();
          const previous={loadReaderAssets,getFolderContents,assets:readerAssets,pending:readerAssetsPending,
            delay:readerAssetDelayUntilPaint,mobile:STATE.isMobile,open:STATE.leftSidebarOpen,
            loaded:STATE._loadedPage,loading:STATE.isLoading,view:displayedSearchView};
          try {
            STATE.mode='repo';STATE.repo='Test';STATE.repoFull='VoiceOfML/Test';STATE.browserPath='';
            STATE.isMobile=false;STATE.leftSidebarOpen=true;STATE.useLocalMode=true;STATE.dataLoaded=true;
            STATE._loadedPage=0;STATE.isLoading=true;readerAssets=null;readerAssetsPending=null;
            readerAssetDelayUntilPaint=true;
            let release,loads=0;const assetPromise=new Promise(resolve=>{release=resolve});
            loadReaderAssets=()=>{loads++;return assetPromise};
            getFolderContents=async(_repo,path)=>({folders:[],files:[{name:path,ext:'chm',size:1}]});
            await renderBrowser('old',++routeRenderId);
            const oldRow=DOM.sidebarContent.querySelector('[data-type="file"]');
            await renderBrowser('new',++routeRenderId);
            const current=DOM.sidebarContent.querySelector('[data-type="file"]');
            const digest='a'.repeat(64);
            readerAssets={'VoiceOfML/Test\u0000new/new.chm':
              {s:2,m:'h',p:`objects/aa/${digest}/0123456789abcdef/document.html`}};
            release(readerAssets);await new Promise(resolve=>setTimeout(resolve,0));
            return {oldConnected:oldRow.isConnected,oldAfter:oldRow.dataset.readerUrl||'',
              current:!!current.dataset.readerUrl,label:current.querySelector('.browser-name').getAttribute('aria-label'),loads};
          } finally {
            loadReaderAssets=previous.loadReaderAssets;getFolderContents=previous.getFolderContents;
            readerAssets=previous.assets;readerAssetsPending=previous.pending;readerAssetDelayUntilPaint=previous.delay;
            STATE.isMobile=previous.mobile;STATE.leftSidebarOpen=previous.open;
            STATE._loadedPage=previous.loaded;STATE.isLoading=previous.loading;displayedSearchView=previous.view;
          }
        }''')
        self.assertEqual(result, dict(oldConnected=False,oldAfter='',current=True,label='打开阅读器：new.chm',loads=2))

    def test_reader_assets_body_deadline_releases_shared_load_and_retries(self):
        self.page.clock.install()
        self.page.evaluate('''() => {
          readerAssets=null;readerAssetsPending=null;readerAssetsRetryAt=0;
          window.assetCalls=0;window.assetResults=[];window.assetAborted=false;
          const native=window.fetch;
          window.fetch=(url,options)=>String(url).endsWith('/reader_assets.json.gz')
            ? (assetCalls++,Promise.resolve(new Response(new ReadableStream({start(controller){
                options.signal.addEventListener('abort',()=>{
                  assetAborted=true;controller.error(new DOMException('timed out','AbortError'));
                });
              }})))) : native(url,options);
          loadReaderAssets().then(value=>assetResults.push(value));
          loadReaderAssets().then(value=>assetResults.push(value));
        }''')
        self.assertEqual(self.page.evaluate('assetCalls'), 1)
        self.page.clock.fast_forward(10001)
        self.page.wait_for_timeout(20)
        self.assertEqual(self.page.evaluate('assetResults'), [{}, {}])
        self.assertEqual(self.page.evaluate('[assetAborted,readerAssetsPending,readerAssets]'), [True, None, None])
        self.assertEqual(self.page.evaluate('loadReaderAssets()'), {})
        self.assertEqual(self.page.evaluate('assetCalls'), 1)
        self.page.clock.fast_forward(5001)
        recovered = self.page.evaluate('''async () => {
          const payload={v:1,f:{sample:{s:2,m:'p',p:'sample.pdf'}}};
          window.fetch=()=>{assetCalls++;return Promise.resolve(new Response(
            new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('gzip'))));};
          const value=await loadReaderAssets();
          const cached=await loadReaderAssets();
          return {value,cached,calls:assetCalls,pending:readerAssetsPending};
        }''')
        self.assertEqual(recovered, dict(value={'sample': {'s': 2, 'm': 'p', 'p': 'sample.pdf'}},
                                         cached={'sample': {'s': 2, 'm': 'p', 'p': 'sample.pdf'}}, calls=2, pending=None))

    def test_reader_assets_yields_and_timeout_discards_unpublished_map(self):
        self.page.clock.install()
        self.page.evaluate('''() => {
          readerAssets=null;readerAssetsPending=null;readerAssetsRetryAt=0;
          window.assetCalls=0;window.assetResults=[];window.releaseAssetYield=null;
          window.realAssetYield=yieldConvertedReaderBuild;
          yieldConvertedReaderBuild=()=>new Promise(resolve=>window.releaseAssetYield=resolve);
          const native=window.fetch;
          window.fetch=(url,options)=>String(url).endsWith('/reader_assets.json.gz')
            ? (assetCalls++,Promise.resolve(new Response(
              new Blob([JSON.stringify({v:1,f:{sample:{s:2,m:'p',p:assetCalls===1?'stale.pdf':'sample.pdf'}}})])
                .stream().pipeThrough(new CompressionStream('gzip')))))
            : native(url,options);
          const first=loadReaderAssets(),second=loadReaderAssets();
          window.sharedAssetPromise=first===second;
          first.then(value=>assetResults.push(value));second.then(value=>assetResults.push(value));
        }''')
        self.page.wait_for_function('!!window.releaseAssetYield')
        self.assertTrue(self.page.evaluate('sharedAssetPromise && readerAssets===null && !!readerAssetsPending'))
        self.page.clock.fast_forward(10001)
        self.page.wait_for_function('assetResults.length===2')
        self.assertEqual(self.page.evaluate('[assetResults,readerAssets,readerAssetsPending,assetCalls]'),
                         [[{}, {}], None, None, 1])
        self.assertEqual(self.page.evaluate('loadReaderAssets()'), {})
        self.assertEqual(self.page.evaluate('assetCalls'), 1)
        self.page.clock.fast_forward(5001)
        recovered = self.page.evaluate('''async()=>{
          yieldConvertedReaderBuild=realAssetYield;
          const value=await loadReaderAssets();return {value,assetCalls,published:readerAssets===value};
        }''')
        self.assertEqual(recovered, dict(value={'sample': {'s': 2, 'm': 'p', 'p': 'sample.pdf'}},
                                         assetCalls=2, published=True))
        self.page.evaluate('releaseAssetYield()')
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.evaluate('[readerAssets,readerAssetsPending,assetCalls,assetResults]'),
                         [{'sample': {'s': 2, 'm': 'p', 'p': 'sample.pdf'}}, None, 2, [{}, {}]])

    def test_reader_assets_never_publish_partial_map_between_yields(self):
        self.page.evaluate('''()=>{
          readerAssets=null;readerAssetsPending=null;readerAssetsRetryAt=0;
          window.assetYields=[];window.completedAssets=null;window.realAssetYield=yieldConvertedReaderBuild;
          yieldConvertedReaderBuild=()=>new Promise(resolve=>assetYields.push(resolve));
          const payload={v:1,f:{first:{s:2},second:{s:3}}};
          const native=window.fetch;
          window.fetch=(url,options)=>String(url).endsWith('/reader_assets.json.gz')
            ? Promise.resolve(new Response(new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('gzip'))))
            : native(url,options);
          loadReaderAssets().then(value=>window.completedAssets=value);
        }''')
        self.page.wait_for_function('assetYields.length===1')
        self.assertTrue(self.page.evaluate('readerAssets===null && completedAssets===null'))
        self.page.evaluate('assetYields.shift()()')
        self.page.wait_for_function('assetYields.length===1')
        self.assertTrue(self.page.evaluate('readerAssets===null && completedAssets===null'))
        self.page.evaluate('assetYields.shift()()')
        self.page.wait_for_function('completedAssets!==null')
        self.assertEqual(self.page.evaluate('completedAssets'), {'first': {'s': 2}, 'second': {'s': 3}})
        self.assertTrue(self.page.evaluate('readerAssets===completedAssets && readerAssetsPending===null'))
        self.page.evaluate('yieldConvertedReaderBuild=realAssetYield')

    def test_reader_assets_timeout_at_second_yield_discards_map(self):
        self.page.clock.install()
        self.page.evaluate('''()=>{
          readerAssets=null;readerAssetsPending=null;readerAssetsRetryAt=0;
          window.assetYields=[];window.assetResults=[];window.assetCalls=0;
          window.realAssetYield=yieldConvertedReaderBuild;
          yieldConvertedReaderBuild=()=>new Promise(resolve=>assetYields.push(resolve));
          const native=window.fetch;
          window.fetch=(url,options)=>String(url).endsWith('/reader_assets.json.gz')
            ? (assetCalls++,Promise.resolve(new Response(new Blob([JSON.stringify(
                {v:1,f:{sample:{s:assetCalls===1?1:2}}})])
                .stream().pipeThrough(new CompressionStream('gzip'))))) : native(url,options);
          const first=loadReaderAssets(),second=loadReaderAssets();
          window.sharedAssetPromise=first===second;
          first.then(value=>assetResults.push(value));second.then(value=>assetResults.push(value));
        }''')
        self.page.wait_for_function('assetYields.length===1')
        self.page.evaluate('assetYields.shift()()')
        self.page.wait_for_function('assetYields.length===1')
        self.page.clock.fast_forward(10001)
        self.page.wait_for_function('assetResults.length===2')
        self.assertTrue(self.page.evaluate('sharedAssetPromise'))
        self.assertEqual(self.page.evaluate('[assetResults,readerAssets,readerAssetsPending,assetCalls]'),
                         [[{}, {}], None, None, 1])
        self.page.clock.fast_forward(5001)
        recovered = self.page.evaluate('''async()=>{
          yieldConvertedReaderBuild=realAssetYield;
          const value=await loadReaderAssets();return {value,assetCalls,published:readerAssets===value};
        }''')
        self.assertEqual(recovered, dict(value={'sample': {'s': 2}}, assetCalls=2, published=True))
        self.page.evaluate('assetYields.shift()()')
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.evaluate('[readerAssets,readerAssetsPending,assetCalls,assetResults]'),
                         [{'sample': {'s': 2}}, None, 2, [{}, {}]])

    def test_reader_assets_respects_size_limits_and_retains_json_semantics(self):
        outcome = self.page.evaluate('''async()=>{
          const originalFetch=window.fetch,compressedLimit=READER_ASSETS_COMPRESSED_LIMIT,
            expandedLimit=READER_ASSETS_EXPANDED_LIMIT;
          const gzip=text=>new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')));
          const attempt=async make=>{
            window.fetch=make;
            try{return {ok:true,value:await fetchReaderAssetMap()}}catch(error){return {ok:false,name:error.name,message:error.message}}
          };
          try{
            READER_ASSETS_COMPRESSED_LIMIT=256;READER_ASSETS_EXPANDED_LIMIT=256;
            let cancelled=false;
            const header=await attempt(()=>new Response(new ReadableStream({
              start(controller){controller.enqueue(new Uint8Array([1]));},cancel(){cancelled=true}
            }),{headers:{'content-length':'257'}}));
            const compressed=await attempt(()=>new Response(new Uint8Array(257)));
            const expanded=await attempt(()=>gzip(JSON.stringify({v:1,f:{a:'x'.repeat(1024)}})));
            const malformed=await attempt(()=>gzip('{"v":1,"f":'));
            READER_ASSETS_COMPRESSED_LIMIT=compressedLimit;READER_ASSETS_EXPANDED_LIMIT=expandedLimit;
            const array=await attempt(()=>gzip('{"v":1,"f":[-0,1e400]}'));
            return {header:header.message,cancelled,compressed:compressed.message,expanded:expanded.message,
              malformed:malformed.name,array:array.ok&&Array.isArray(array.value),
              negativeZero:array.ok&&Object.is(array.value[0],-0),infinity:array.ok&&array.value[1]===Infinity};
          }finally{
            window.fetch=originalFetch;READER_ASSETS_COMPRESSED_LIMIT=compressedLimit;READER_ASSETS_EXPANDED_LIMIT=expandedLimit;
          }
        }''')
        self.assertEqual(outcome, dict(header='READER_ASSETS_LIMIT', cancelled=True,
            compressed='READER_ASSETS_LIMIT', expanded='READER_ASSETS_LIMIT', malformed='SyntaxError',
            array=True, negativeZero=True, infinity=True))

    def test_reader_assets_yield_fallback_and_hidden_document_complete(self):
        outcome = self.page.evaluate('''async()=>{
          const originalFetch=window.fetch,originalMessageChannel=window.MessageChannel;
          const hiddenDescriptor=Object.getOwnPropertyDescriptor(document,'hidden');
          const channel=convertedReaderYieldChannel;
          const payload={v:1,f:{sample:{s:2,m:'p',p:'sample.pdf'}}};
          try{
            window.fetch=()=>Promise.resolve(new Response(
              new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('gzip'))));
            Object.defineProperty(document,'hidden',{configurable:true,value:true});
            window.MessageChannel=undefined;
            const timerFallback=await fetchReaderAssetMap();
            window.MessageChannel=originalMessageChannel;
            const normal=await fetchReaderAssetMap();
            return {timerFallback,normal,hidden:document.hidden};
          }finally{
            window.fetch=originalFetch;window.MessageChannel=originalMessageChannel;
            if(hiddenDescriptor)Object.defineProperty(document,'hidden',hiddenDescriptor);else delete document.hidden;
            if(convertedReaderYieldChannel!==channel){
              convertedReaderYieldChannel?.port1.close();convertedReaderYieldChannel?.port2.close();convertedReaderYieldChannel=channel;
            }
          }
        }''')
        self.assertEqual(outcome, dict(timerFallback={'sample': {'s': 2, 'm': 'p', 'p': 'sample.pdf'}},
                                      normal={'sample': {'s': 2, 'm': 'p', 'p': 'sample.pdf'}}, hidden=True))

    def test_metadata_errors_are_not_cached_and_retain_circuit_breaker(self):
        result = self.page.evaluate('''async () => {
          repoApiCache=null;repoApiPending=null;extensionApiCache.clear();folderTreeCache.clear();
          const request=()=>Promise.all([fetchRepos(),fetchExtensions('invalid-metadata'),fetchFolderTree('invalid-metadata')]);
          const outcomes=[];
          for(const status of [503,200]) {
            noteApiSuccess();
            window.fetch=()=>Promise.resolve(new Response('{"error":"unavailable"}',{status}));
            outcomes.push({values:await request(),failures:apiFailureCount,available:apiAvailable});
          }
          noteApiSuccess();window.fetch=()=>Promise.resolve(new Response('[]'));
          return {outcomes,recovered:await request()};
        }''')
        self.assertEqual(result, dict(outcomes=[dict(values=[None] * 3, failures=3, available=False)] * 2,
                                      recovered=[[], [], []]))

    def test_directory_requests_coalesce_and_clear_failed_body_for_retry(self):
        self.page.clock.install()
        self.page.evaluate('''() => {
          window.directoryCalls=0;window.directoryResults=[];
          const native=window.fetch;
          window.fetch=(url,options)=>String(url).includes('/contents?path=refactor')
            ? (directoryCalls++, Promise.resolve({ok:true,json:()=>new Promise((resolve,reject)=>{
                window.finishDirectory=()=>resolve({folders:[],files:[]});
                options.signal.addEventListener('abort',()=>reject(new DOMException('timed out','AbortError')));
              })})) : native(url,options);
          window.requestDirectory=()=>fetchFolderContents('Test','refactor').catch(()=>null);
          requestDirectory().then(value=>directoryResults.push(value));
          requestDirectory().then(value=>directoryResults.push(value));
        }''')
        self.assertEqual(self.page.evaluate('directoryCalls'), 1)
        self.page.clock.fast_forward(12001)
        self.page.wait_for_function('directoryResults.length===2')
        self.assertEqual(self.page.evaluate('directoryResults'), [None, None])
        self.page.evaluate('() => { requestDirectory().then(value=>directoryResults.push(value)); }')
        self.page.wait_for_function('directoryCalls===2')
        self.page.evaluate('finishDirectory()')
        self.page.wait_for_function('directoryResults.length===3')
        cached = self.page.evaluate('requestDirectory()')
        self.assertEqual(cached, dict(folders=[], files=[]))
        self.assertEqual(self.page.evaluate('directoryCalls'), 2)

    def test_tree_animation_reversal_and_fallback_cleanup(self):
        result = self.page.evaluate('''async () => {
          const children=document.createElement('div');children.innerHTML='<div>child</div>';
          const toggle=document.createElement('button');toggle.innerHTML='<span class="tree-toggle-glyph"></span>';
          document.body.append(toggle,children);
          toggleFolderChildrenAnimated(children,toggle,true);
          toggleFolderChildrenAnimated(children,toggle,false);
          toggleFolderChildrenAnimated(children,toggle,true);
          children.dispatchEvent(new TransitionEvent('transitionend',{propertyName:'opacity'}));
          const pending=!!children._transitionCleanup;
          children.dispatchEvent(new TransitionEvent('transitionend',{propertyName:'height'}));
          const expanded=children.style.display==='block' && toggle.classList.contains('expanded');
          const clean=()=>!children._transitionTimer && !children._transitionCleanup &&
            ['height','opacity','transform','overflow','transition'].every(key=>children.style[key]==='');
          const afterEvent=clean();
          toggleFolderChildrenAnimated(children,toggle,false);
          await new Promise(resolve=>setTimeout(resolve,350));
          const collapsed=children.style.display==='none' && !toggle.classList.contains('expanded');
          const afterTimeout=clean();children.remove();toggle.remove();
          return {pending,expanded,afterEvent,collapsed,afterTimeout};
        }''')
        self.assertTrue(all(result.values()), result)

    def test_form_controls_and_composition_keep_their_keys(self):
        result = self.page.evaluate('''() => {
          const dispatch=(el,key,extra={})=>{
            const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});
            el.dispatchEvent(event);return event.defaultPrevented;
          };
          const editor=document.createElement('div');editor.contentEditable='true';document.body.appendChild(editor);
          keyboardResultIndex=-1;
          const blocked=[DOM.searchInput,DOM.filterMinSize,DOM.sortSelect,DOM.themeBtn,editor]
            .flatMap(el=>['ArrowDown','ArrowUp'].map(key=>dispatch(el,key)));
          DOM.searchInput.value='keep'; STATE.query='keep';
          blocked.push(dispatch(DOM.searchInput,'Escape',{isComposing:true}));
          blocked.push(dispatch(DOM.searchInput,'Enter',{isComposing:true}));
          blocked.push(dispatch(document.body,'ArrowDown',{ctrlKey:true}));
          const untouched=keyboardResultIndex===-1 && STATE.query==='keep';
          const navigated=dispatch(document.body,'ArrowDown') && keyboardResultIndex===0;
          editor.remove();return {blocked,untouched,navigated};
        }''')
        self.assertFalse(any(result['blocked']))
        self.assertTrue(result['untouched'])
        self.assertTrue(result['navigated'])

    def test_enter_submits_search_once_and_buttons_do_not_open_results(self):
        result = self.page.evaluate('''() => {
          let searches=0,opened=0;
          doSearch=()=>{searches++}; openExternalWindow=()=>{opened++};
          DOM.searchInput.value='new query'; DOM.searchInput.focus();
          DOM.searchInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
          keyboardResultIndex=0;
          DOM.themeBtn.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
          return {searches,opened,query:STATE.query};
        }''')
        self.assertEqual(result, dict(searches=1, opened=0, query='new query'))

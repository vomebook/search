"""Lazy directory UI and keyboard ownership in real Chromium."""
import unittest
from tests import test_paging_recovery as paging


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
            folder=dict(common,q='phone',min_size='1KB',max_size='2MB',folder_self='docs/中文')))

    def test_collapsed_tree_avoids_hidden_dom_and_keeps_selection(self):
        result = self.page.evaluate('''() => {
          STATE.folderTree=[{name:'root',path:'root',count:1000,selfCount:0,children:
            Array.from({length:1000},(_,i)=>({name:'child'+i,path:'root/'+i,count:1,selfCount:1,children:[]}))}];
          STATE.folderTreeCollapsed={root:true};
          STATE.filterFolderSubtrees=[]; STATE.filterFolderSelfs=[]; STATE.filterFolders=[];
          renderFilterFolderTree();
          const initial=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          const root=DOM.filterFolderTree.querySelector('.filter-folder-item');
          root.querySelector('input').click();
          root.querySelector('.tree-toggle').click();
          const expanded=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          const child=DOM.filterFolderTree.querySelector('[data-path="root/0"] input');
          const inherited=child.checked; child.click();
          const partial=root.querySelector('input').indeterminate;
          const excluded=!child.checked;
          root.querySelector('.tree-toggle').click(); root.querySelector('.tree-toggle').click();
          return {initial,expanded,inherited,partial,excluded,
            final:DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length,
            siblings:DOM.filterFolderTree.querySelector('[data-path="root/1"] input').checked};
        }''')
        self.assertEqual(result, dict(initial=1, expanded=1001, inherited=True, partial=True,
                                      excluded=True, final=1001, siblings=True))

    def test_tree_rerender_has_one_delegated_action_and_respects_nested_collapse(self):
        result = self.page.evaluate('''() => {
          STATE.folderTree=[{name:'a',path:'a',count:3,selfCount:1,showSelfToggle:true,children:[
            {name:'b',path:'a/b',count:2,selfCount:1,children:[{name:'c',path:'a/b/c',count:1,selfCount:1,children:[]}]}]}];
          STATE.folderTreeCollapsed={'a':false,'a/b':true};
          STATE.filterFolderSubtrees=[];STATE.filterFolderSelfs=[];STATE.filterFolders=[];
          renderFilterFolderTree();renderFilterFolderTree();
          const rows=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          DOM.filterFolderTree.querySelector('.folder-self-toggle').click();
          const selected=STATE.filterFolderSelfs.includes('a');
          DOM.filterFolderTree.querySelector('[data-path="a/b"] .tree-toggle').click();
          return {rows,selected,final:DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length,
            childChecked:DOM.filterFolderTree.querySelector('[data-path="a/b/c"] input').checked};
        }''')
        self.assertEqual(result, dict(rows=2, selected=True, final=3, childChecked=False))

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

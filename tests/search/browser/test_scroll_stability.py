"""Browser regressions for virtual height correction and the proxy scrollbar."""
import unittest
from tests.search.browser import test_paging_recovery as paging


class ScrollStabilityTests(unittest.TestCase):
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
        self.page.evaluate('''async () => {
          searchAbortController?.abort(); searchPrefetchAbortController?.abort(); searchRequestId++;
          STATE.results = Array.from({length:1000}, (_, i) => ({Repo:'VoiceOfML/Test', File:'row-'+i, Extension:'txt', Folder:[], Size:1}));
          STATE.total=1000; STATE.hasMore=false; STATE.isLoading=false;
          VSCROLL.heightCache.clear(); VSCROLL.estimatedHeight=160;
          window.rowStyle=document.createElement('style');
          rowStyle.textContent='.result-item {height:160px!important;min-height:0!important;box-sizing:border-box}';
          document.head.append(rowStyle);
          window.scrollFrames=async (n=6)=>{for(let i=0;i<n;i++) await new Promise(r=>requestAnimationFrame(r));};
          DOM.resultsContainer.scrollTop=0; resetVirtualScrollState(); renderResults();
          await scrollFrames();
        }''')

    def tearDown(self):
        self.fixture.tearDown()

    def test_large_multiselection_scroll_updates_only_visible_rows_and_events_keep_counts(self):
        result = self.page.evaluate('''async () => {
          cancelSearchPrefetch();searchAbortController?.abort();cancelPositionRestore();setReturnPositionTarget();
          STATE.results=Array.from({length:50000},(_,i)=>({Repo:'VoiceOfML/Test',File:'bulk-'+i,Extension:'txt',Folder:[],Size:1}));
          STATE.total=50000;STATE._loadedPage=500;STATE.page=500;STATE.hasMore=false;STATE.isLoading=false;
          resetVirtualScrollState();renderResults();
          DOM.multiSelectToggle.checked=true;updateSelectionUI();DOM.multiSelectAll.click();
          const countLabel=()=>STATE.isMobile?DOM.mobileSelectedCount.textContent:DOM.multiSelectedCount.textContent;
          const selectedCount=countLabel(),original=Object.keys;let scans=0;
          const observer=new MutationObserver(()=>{});
          for(const node of [DOM.multiSelectedCount,DOM.mobileSelectedCount,DOM.multiCopyLinks,DOM.multiDeselect])
            if(node) observer.observe(node,{childList:true,characterData:true,subtree:true});
          Object.keys=value=>{if(value===selectedIndices) scans++;return original(value)};
          let toolbarWrites;
          try {
            for(let i=0;i<20;i++) {setResultScrollTop(getVirtualOffset(1000+i*30));renderVisible();}
            toolbarWrites=observer.takeRecords().length;
          } finally {Object.keys=original;observer.disconnect();}
          const stableCount=countLabel()===selectedCount,rows=[...DOM.resultsList.querySelectorAll('.result-item')];
          const checked=rows.every(row=>row.querySelector('.result-checkbox').checked && row.classList.contains('selected'));
          rows[0].querySelector('.result-checkbox').click();
          const singleRemoved=Object.keys(selectedIndices).length===49999 && countLabel().includes('49999');
          DOM.multiDeselect.click();
          const cleared=Object.keys(selectedIndices).length===0 && countLabel()==='' && !DOM.resultsList.querySelector('.result-checkbox:checked');
          const checkbox=DOM.resultsList.querySelector('.result-checkbox');checkbox.click();
          const index=Number(checkbox.dataset.index),files=getSelectedFiles();
          const action=files.length===1 && files[0].filename==='bulk-'+index+'.txt' &&
            files[0].link===checkbox.closest('.result-item').querySelector('[data-action="download"]').dataset.link;
          STATE.query='paging-latest';const search=doSearch();
          const resetImmediately=Object.keys(selectedIndices).length===0 && countLabel()==='';await search;
          return {scans,toolbarWrites,stableCount,checked,singleRemoved,cleared,action,resetImmediately,
            complete:rows.length>0 && selectedCount.includes('50000')};
        }''')
        self.assertEqual(result, dict(scans=0,toolbarWrites=0,stableCount=True,checked=True,
                                      singleRemoved=True,cleared=True,action=True,resetImmediately=True,complete=True))
        self.assertEqual(self.fixture.errors, [])

    def test_row_batch_checks_template_key_once_and_invalidates_reused_rows(self):
        result = self.page.evaluate('''() => {
          cancelSearchPrefetch();
          if(VSCROLL.renderFrame) cancelAnimationFrame(VSCROLL.renderFrame);
          VSCROLL.renderFrame=0;
          STATE.filterFolderSelfs=Array.from({length:1000},(_,i)=>'docs/'+i);
          clearResultTemplateCache();DOM.resultsList.replaceChildren();
          const original=getResultsHTMLCacheKey;let keys=0,totalReads=0,total=STATE.total;
          getResultsHTMLCacheKey=(...args)=>{keys++;return original(...args)};
          const rowsView=VoiceOfMLVirtualRows.create(VSCROLL,{origin:0,target:null},{
            elements:DOM,total:()=>{totalReads++;return total},recordForRow:row=>resultRowRecords.get(row),
            resetKeyboardIndex:index=>{keyboardResultIndex=index},ensureResultTemplateCache,createResultRow,
            getResultScrollTop,getVirtualOffset,findVirtualIndex});
          const render=()=>rowsView.reconcileVirtualRows(STATE.results,0,60,0,getVirtualTotalHeight()-getVirtualOffset(60));
          const rows=()=>[...DOM.resultsList.querySelectorAll('.result-item')];
          try {
            render();const createdKeys=keys,first=rows(),version=VSCROLL.contentVersion;
            const observer=new MutationObserver(()=>{});
            observer.observe(DOM.resultsList,{subtree:true,attributeFilter:['role','aria-posinset','aria-setsize']});
            totalReads=keys=0;render();
            const reusedKeys=keys,reusedReads=totalReads,reusedWrites=observer.takeRecords().length;
            const stable=first.every((row,i)=>row===rows()[i]);
            total++;totalReads=0;render();
            const changedReads=totalReads,changes=observer.takeRecords();
            observer.disconnect();
            const changedOnlySize=changes.every(change=>change.attributeName==='aria-setsize');
            const updatedSize=rows().every((row,i)=>row===first[i] && row.getAttribute('role')==='listitem' &&
              row.getAttribute('aria-posinset')===String(i+1) && row.getAttribute('aria-setsize')===String(total));
            STATE.filterFolderSelfs[999]='edited';keys=0;render();
            const editedKeys=keys,updated=rows(),allReplaced=first.every(row=>!row.isConnected),
              versions=updated.every(row=>Number(row.dataset.contentVersion)===VSCROLL.contentVersion),
              invalidated=VSCROLL.contentVersion===version+1;
            STATE.query='row';keys=0;render();
            const queryKeys=keys,highlighted=rows().every(row=>row.querySelector('.result-title mark')?.textContent==='row');
            STATE.useMirrorLinks=!STATE.useMirrorLinks;keys=0;render();
            return {createdKeys,reusedKeys,editedKeys,queryKeys,mirrorKeys:keys,stable,allReplaced,
              reusedReads,reusedWrites,changedReads,changedWrites:changes.length,changedOnlySize,updatedSize,
              versions,invalidated,highlighted,count:rows().length,
              ids:rows().map(row=>Number(row.dataset.index))};
          } finally {getResultsHTMLCacheKey=original;}
        }''')
        self.assertEqual(result, dict(createdKeys=1,reusedKeys=1,editedKeys=1,queryKeys=1,
                                      mirrorKeys=1,stable=True,allReplaced=True,versions=True,
                                      reusedReads=1,reusedWrites=0,changedReads=1,changedWrites=60,
                                      changedOnlySize=True,updatedSize=True,
                                      invalidated=True,highlighted=True,count=60,ids=list(range(60))))
        self.assertEqual(self.fixture.errors, [])

    def test_short_same_window_has_no_dom_writes_and_restores_reader_position(self):
        result = self.page.evaluate('''async () => {
          cancelSearchPrefetch();STATE.results=STATE.results.slice(0,100);
          STATE.total=100;STATE.hasMore=false;resetVirtualScrollState();renderResults();await scrollFrames();
          const rows=[...DOM.resultsList.querySelectorAll('.result-item')];
          const observer=new MutationObserver(()=>{});
          observer.observe(DOM.resultsList,{attributes:true,childList:true,subtree:true});
          const updates=[];
          for(let i=0;i<8;i++) {DOM.resultsContainer.scrollTop=i*2;updates.push(renderVisible());}
          const writes=observer.takeRecords().length;observer.disconnect();
          const stable=rows.every(row=>row.isConnected);
          setResultScrollTop(getVirtualOffset(4)+11);renderVisible();
          const saved=captureReaderReturnScroll();
          setResultScrollTop(0);renderVisible();
          readerReturnPosition.setScroll(saved);restoreReaderReturnScroll();await scrollFrames();
          return {writes,stable,updates,index:findVirtualIndex(getResultScrollTop()),
            offset:getResultScrollTop()-getVirtualOffset(4)};
        }''')
        self.assertEqual(result['writes'], 0)
        self.assertTrue(result['stable'])
        self.assertEqual(result['updates'], [False] * 8)
        self.assertEqual(result['index'], 4)
        self.assertAlmostEqual(result['offset'], 11, delta=1)
        self.assertEqual(self.fixture.errors, [])

    def test_resize_remeasures_same_window_with_a_fresh_layout_key(self):
        before = self.page.evaluate('''() => {
          cancelSearchPrefetch();
          window.beforeMeasureKey=getHeightMeasurementKey();
          rowStyle.textContent='.result-item {height:80px!important;min-height:0!important;box-sizing:border-box}';
          return beforeMeasureKey;
        }''')
        self.page.set_viewport_size({'width': 1100, 'height': 800})
        self.page.wait_for_function('''getHeightMeasurementKey()!==beforeMeasureKey &&
          VSCROLL.measuredRowKeys[0]===getHeightMeasurementKey() && VSCROLL.heights[0]===80''')
        self.assertNotEqual(self.page.evaluate('getHeightMeasurementKey()'), before)
        self.assertEqual(self.fixture.errors, [])

    def test_far_append_preserves_rows_without_render_then_new_page_is_accessible(self):
        result = self.page.evaluate('''async () => {
          cancelSearchPrefetch();STATE.total=1100;STATE._loadedPage=10;
          const rows=[...DOM.resultsList.querySelectorAll('.result-item')];
          const before=getResultScrollTop();const original=renderVisible;let renders=0;
          renderVisible=()=>{renders++;return original()};
          const page=Array.from({length:100},(_,i)=>({Repo:'VoiceOfML/Test',File:'row-'+(1000+i),
            Extension:'txt',Folder:[],Size:1}));
          appendSearchResults(11,page);refreshVirtualAfterAppend();await scrollFrames(3);
          const idleRenders=renders,stable=rows.every(row=>row.isConnected),after=getResultScrollTop();
          setResultScrollTop(getVirtualOffset(1000));
          DOM.resultsContainer.dispatchEvent(new Event('scroll'));await scrollFrames(3);
          const row=DOM.resultsList.querySelector('.result-item[data-index="1000"]');
          return {idleRenders,stable,before,after,total:STATE.total,length:STATE.results.length,
            visible:!!row && row.textContent.includes('row-1000')};
        }''')
        self.assertEqual(result['idleRenders'], 0)
        self.assertTrue(result['stable'])
        self.assertEqual(result['before'], result['after'])
        self.assertEqual([result['total'], result['length']], [1100,1100])
        self.assertTrue(result['visible'])

    def test_shorter_rows_preserve_content_anchor_without_jumping_to_bottom(self):
        result = self.page.evaluate('''async () => {
          rowStyle.textContent='.result-item {height:80px!important;min-height:0!important;box-sizing:border-box}';
          VSCROLL.measuredRowKeys=[]; VSCROLL.measuredWindowKey='';
          const c=DOM.resultsContainer;
          c.scrollTop=120000;
          const index=findVirtualIndex(c.scrollTop);
          VSCROLL.renderStart=-1; VSCROLL.renderEnd=-1; renderVisible();
          const samples=[];
          for(let i=0;i<12;i++) {
            await scrollFrames(1);
            const row=DOM.resultsList.querySelector(`[data-index="${index}"]`);
            samples.push({anchorY:row?row.getBoundingClientRect().top-c.getBoundingClientRect().top:null,
              ratio:c.scrollTop/(c.scrollHeight-c.clientHeight)});
          }
          return {samples,count:STATE.results.length};
        }''')
        self.assertEqual(result['count'], 1000)
        for sample in result['samples']:
            self.assertIsNotNone(sample['anchorY'])
            self.assertLessEqual(abs(sample['anchorY']), 1)
            self.assertLess(sample['ratio'], 0.9)
        self.assertEqual(self.fixture.errors, [])

    def test_thumb_follows_pointer_and_blur_cancels_pending_drag(self):
        result = self.page.evaluate('''async () => {
          rowStyle.textContent='.result-item {height:80px!important;min-height:0!important;box-sizing:border-box}';
          const c=DOM.resultsContainer;
          updateScrollTrack();
          const rect=DOM.scrollThumb.getBoundingClientRect();
          const y=rect.top+rect.height/2, delta=(DOM.scrollTrack.clientHeight-rect.height)*0.6;
          DOM.scrollThumb.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientY:y}));
          document.dispatchEvent(new MouseEvent('mousemove',{clientY:y+delta}));
          await scrollFrames();
          const pointerError=DOM.scrollThumb.getBoundingClientRect().top-rect.top-delta;
          const settledTop=c.scrollTop;
          document.dispatchEvent(new MouseEvent('mousemove',{clientY:y+delta+100}));
          window.dispatchEvent(new Event('blur'));
          await scrollFrames();
          document.dispatchEvent(new MouseEvent('mousemove',{clientY:10000}));
          await scrollFrames();
          return {pointerError,settledTop,after:c.scrollTop,dragging:VSCROLL.isDraggingThumb};
        }''')
        self.assertLessEqual(abs(result['pointerError']), 1)
        self.assertEqual(result['after'], result['settledTop'])
        self.assertFalse(result['dragging'])
        self.assertEqual(self.fixture.errors, [])

    def test_touch_cancel_drops_queued_drag_without_late_scroll(self):
        result = self.page.evaluate('''async () => {
          const c=DOM.resultsContainer;
          c.scrollTop=40000; renderVisible(); await scrollFrames(); updateScrollTrack();
          const before=c.scrollTop;
          const y=DOM.scrollThumb.getBoundingClientRect().top+10;
          const touch=y=>new Touch({identifier:1,target:DOM.scrollThumb,clientX:10,clientY:y});
          DOM.scrollThumb.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[touch(y)]}));
          document.dispatchEvent(new TouchEvent('touchmove',{cancelable:true,touches:[touch(y+300)]}));
          document.dispatchEvent(new TouchEvent('touchcancel',{touches:[]}));
          await scrollFrames();
          document.dispatchEvent(new TouchEvent('touchmove',{cancelable:true,touches:[touch(10000)]}));
          await scrollFrames();
          return {before,after:c.scrollTop,dragging:VSCROLL.isDraggingThumb};
        }''')
        self.assertEqual(result['before'], result['after'])
        self.assertFalse(result['dragging'])
        self.assertEqual(self.fixture.errors, [])

    def test_transition_keeps_finite_height_for_all_loaded_pages(self):
        result = self.page.evaluate('''async () => {
          DOM.resultsContainer.scrollTop=120000;
          prepareRouteTransitionResults();
          await scrollFrames();
          return {height:getVirtualTotalHeight(),length:VSCROLL.heights.length,
            top:parseFloat(DOM.resultsList.querySelector('.virtual-spacer-top').style.height),
            bottom:parseFloat(DOM.resultsList.querySelector('.virtual-spacer-bottom').style.height)};
        }''')
        self.assertEqual(result['length'], 1000)
        for key in ['height', 'top', 'bottom']:
            self.assertIsNotNone(result[key])
            self.assertGreaterEqual(result[key], 0)
        self.assertEqual(self.fixture.errors, [])

    def test_current_number_uses_measured_rows_at_end_of_large_result_set(self):
        result = self.page.evaluate('''async () => {
          cancelPositionRestore();
          STATE.results=Array.from({length:99522},(_,i)=>({Repo:'VoiceOfML/Test',
            File:'row-'+i,Extension:'txt',Folder:[],Size:1}));
          STATE.total=99522;STATE.hasMore=false;STATE.isLoading=false;
          rowStyle.textContent='.result-item {height:138px!important;min-height:0!important;box-sizing:border-box}';
          resetVirtualScrollState();ensureVirtualHeights(STATE.total);
          VSCROLL.heights.fill(138);VSCROLL.heightsDirty=true;
          VSCROLL.estimateMeasurementKey=getHeightMeasurementKey();
          renderResults();
          const c=DOM.resultsContainer;setResultScrollTop(getVirtualTotalHeight());
          await scrollFrames();updateCurrentResultPosition();
          const rows=[...DOM.resultsList.querySelectorAll('.result-item')];
          const first=rows.find(row=>row.getBoundingClientRect().bottom>c.getBoundingClientRect().top);
          return {displayed:Number(document.getElementById('current-result-position').value),
            first:Number(first.dataset.index)+1,last:rows.at(-1).dataset.index,
            file:STATE.results[99521].File,total:STATE.total};
        }''')
        self.assertEqual(result['displayed'], result['first'])
        self.assertGreater(result['displayed'], 99510)
        self.assertEqual(result['last'], '99521')
        self.assertEqual(result['file'], 'row-99521')
        self.assertEqual(result['total'], 99522)
        self.assertEqual(self.fixture.errors, [])

    def test_restored_window_thumb_reaches_and_loads_last_page(self):
        self.page.evaluate('''async () => {
          cancelPositionRestore();STATE.total=99522;STATE.results=STATE.results.slice(0,100);
          STATE._loadedPage=1;STATE.hasMore=true;STATE.isLoading=false;
          const key=getSearchViewKey();window.lastPageRequests=[];
          resultWindow={key,total:STATE.total,query:JSON.parse(key),generation:'test',
            pages:new Set([1]),pending:new Map(),failures:new Map(),count:100,controller:new AbortController()};
          fetchPositionPage=async(query,page)=>{
            lastPageRequests.push(page);
            return {page,page_size:query.pageSize,total:99522,generation:'test',
              results:Array.from({length:Math.min(query.pageSize,99522-(page-1)*query.pageSize)},(_,i)=>({
                Repo:'VoiceOfML/Test',File:'last-'+((page-1)*query.pageSize+i),Extension:'txt',Folder:[],Size:1}))};
          };
          resetVirtualScrollState();renderResults();await scrollFrames();updateScrollTrack();
          const rect=DOM.scrollThumb.getBoundingClientRect();
          DOM.scrollThumb.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientY:rect.top+10}));
          document.dispatchEvent(new MouseEvent('mousemove',{clientY:rect.top+10+DOM.scrollTrack.clientHeight}));
          await scrollFrames();
          document.dispatchEvent(new MouseEvent('mouseup'));
        }''')
        self.page.wait_for_function("STATE.results[99521]?.File==='last-99521'", timeout=5000)
        self.page.evaluate('updateCurrentResultPosition()')
        self.assertGreater(int(self.page.locator('#current-result-position').input_value()), 99510)
        self.assertEqual(self.page.locator('.result-item').last.get_attribute('data-index'), '99521')
        self.assertTrue(self.page.evaluate('lastPageRequests.includes(996)'))
        self.assertFalse(self.page.evaluate('lastPageRequests.includes(500)'))
        self.assertEqual(self.fixture.errors, [])

class ReaderActionRefreshTests(unittest.TestCase):
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
          readerAssetController.state.assets = {};
          refreshResultReaderActions();
          if (VSCROLL.renderFrame) cancelAnimationFrame(VSCROLL.renderFrame);
          VSCROLL.renderFrame = 0;
          renderVisible();
        }''')

    def tearDown(self):
        try:
            self.assertEqual(self.fixture.errors, [])
        finally:
            self.fixture.tearDown()

    def test_identical_refresh_has_zero_dom_storage_and_render_work(self):
        result = self.page.evaluate('''() => {
          const row=DOM.resultsList.querySelector('.result-item[data-index]');
          const button=row.querySelector('[data-action="read"]');
          button.focus({preventScroll:true});
          const checkbox=row.querySelector('input');checkbox.checked=true;
          const title=row.querySelector('.result-title');
          const range=document.createRange();range.selectNodeContents(title);
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
          const before={start:VSCROLL.renderStart,end:VSCROLL.renderEnd,
            measured:VSCROLL.measuredWindowKey,version:VSCROLL.contentVersion,
            top:getResultScrollTop(),text:selection.toString(),revision:measuredHeightRevision};
          let storage=0,renders=0,measures=0;
          const native={set:Storage.prototype.setItem,remove:Storage.prototype.removeItem,
            schedule:scheduleVirtualRender,measure:measureHeights};
          const observer=new MutationObserver(()=>{});
          observer.observe(DOM.resultsList,{subtree:true,childList:true,attributes:true,characterData:true});
          Storage.prototype.setItem=function(...args){storage++;return native.set.apply(this,args)};
          Storage.prototype.removeItem=function(...args){storage++;return native.remove.apply(this,args)};
          scheduleVirtualRender=()=>{renders++};measureHeights=()=>{measures++};
          try {
            for(let i=0;i<5;i++) refreshResultReaderActions();
            return {writes:observer.takeRecords().length,storage,renders,measures,
              retained:row.isConnected && row.querySelector('[data-action="read"]')===button,
              focus:document.activeElement===button,selected:checkbox.checked,
              state:JSON.stringify(before)===JSON.stringify({start:VSCROLL.renderStart,end:VSCROLL.renderEnd,
                measured:VSCROLL.measuredWindowKey,version:VSCROLL.contentVersion,
                top:getResultScrollTop(),text:selection.toString(),revision:measuredHeightRevision})};
          } finally {
            observer.disconnect();Storage.prototype.setItem=native.set;Storage.prototype.removeItem=native.remove;
            scheduleVirtualRender=native.schedule;measureHeights=native.measure;
          }
        }''')
        self.assertEqual(result, dict(writes=0, storage=0, renders=0, measures=0,
                                     retained=True, focus=True, selected=True, state=True))

    def test_url_only_change_keeps_geometry_and_click_writes_fresh_metadata(self):
        result = self.page.evaluate(r'''() => {
          const row=DOM.resultsList.querySelector('.result-item[data-index]');
          const index=Number(row.dataset.index),record=STATE.results[index];
          const button=row.querySelector('[data-action="read"]'),url=button.dataset.readerUrl;
          const id=getResultStableId(record),cache=VSCROLL.heightCache.get(id);
          const measured=VSCROLL.measuredRowKeys[index],windowKey=VSCROLL.measuredWindowKey;
          const start=VSCROLL.renderStart,end=VSCROLL.renderEnd;
          const key=(record.Repo||'')+'\0'+buildRecordRelativePath(record);
          readerAssetController.state.assets={[key]:{s:2,m:'h',p:'objects/00/'+'0'.repeat(64)+'/profile/document.html'}};
          button.focus({preventScroll:true});
          let writes=0,renders=0;
          const native={set:Storage.prototype.setItem,schedule:scheduleVirtualRender};
          Storage.prototype.setItem=function(...args){writes++;return native.set.apply(this,args)};
          scheduleVirtualRender=()=>{renders++};
          try {
            refreshResultReaderActions();
            const expected=getReaderLink(applyReaderAsset(record,record.Repo||'',buildRecordRelativePath(record),getRecordLink(record)),undefined,false);
            const metadataId=new URL(expected,location.origin).searchParams.get('id');
            const zeroWrites=writes===0;
            const geometry=VSCROLL.heightCache.get(id)===cache && VSCROLL.measuredRowKeys[index]===measured &&
              VSCROLL.measuredWindowKey===windowKey && VSCROLL.renderStart===start && VSCROLL.renderEnd===end;
            const retained=document.activeElement===button && row.querySelector('[data-action="read"]')===button;
            const updated=button.dataset.readerUrl===expected && expected!==url;
            const freshTemplate=createResultRow(record,index).querySelector('[data-action="read"]').dataset.readerUrl===expected;
            button.click();
            const metadata=JSON.parse(sessionStorage.getItem('reader-source:'+metadataId));
            return {zeroWrites,geometry,retained,updated,freshTemplate,renders,
              clicked:!!readerHost.overlay && new URL(readerHost.overlay.src).searchParams.get('id')===metadataId,
              source:metadata.url,expectedSource:applyReaderAsset(record,record.Repo||'',buildRecordRelativePath(record),getRecordLink(record)).ReaderLink,
              original:metadata.download===getRecordLink(record),clickWrites:writes>0};
          } finally {Storage.prototype.setItem=native.set;scheduleVirtualRender=native.schedule;}
        }''')
        self.assertEqual(result.pop('source'), result.pop('expectedSource'))
        self.assertEqual(result.pop('renders'), 0)
        self.assertTrue(all(result.values()), result)

    def test_layout_change_remeasures_and_preserves_scrolled_anchor(self):
        self.page.evaluate(r'''() => {
          const style=document.createElement('style');
          style.textContent='.result-item[data-index="0"]:has([data-action="read"]) {min-height:400px !important}';
          document.head.append(style);
          STATE.results[0]={Repo:'VoiceOfML/Test',File:'f3-anchor',Extension:'f3unsupported',Folder:[],Size:1};
          VSCROLL.templateCache.clear();
          DOM.resultsList.querySelector('[data-index="0"]').replaceWith(createResultRow(STATE.results[0],0));
          VSCROLL.measuredRowKeys[0]=null;VSCROLL.measuredWindowKey='';
          VSCROLL.renderStart=-1;VSCROLL.renderEnd=-1;renderVisible();
          setResultScrollTop(getVirtualOffset(5)+7);renderVisible();
        }''')
        result = self.page.evaluate(r'''() => {
          const top=getResultScrollTop(),index=findVirtualIndex(top),offset=top-getVirtualOffset(index);
          const row=DOM.resultsList.querySelector('[data-index="'+index+'"]');
          const button=row.querySelector('[data-action="read"]');button.focus({preventScroll:true});
          const checkbox=row.querySelector('input');checkbox.checked=true;
          const before=VSCROLL.heights[0];
          readerAssetController.state.assets={[getResultStableId(STATE.results[0])]:{
            s:2,m:'h',p:'objects/00/'+'0'.repeat(64)+'/profile/document.html'}};
          refreshResultReaderActions();renderVisible();
          return {index,sameIndex:findVirtualIndex(getResultScrollTop())===index,
            offsetError:Math.abs(getResultScrollTop()-getVirtualOffset(index)-offset),
            remeasured:VSCROLL.heights[0]>before+100,
            cache:VSCROLL.heightCache.get(getResultStableId(STATE.results[0])).height===VSCROLL.heights[0],
            retained:row.isConnected && document.activeElement===button && checkbox.checked};
        }''')
        self.assertGreater(result['index'], 0)
        self.assertTrue(result['sameIndex'], result)
        self.assertLessEqual(result['offsetError'], 1, result)
        for key in ('remeasured', 'cache', 'retained'):
            self.assertTrue(result[key], result)

    def test_add_remove_and_label_changes_invalidate_only_affected_heights(self):
        result = self.page.evaluate(r'''() => {
          // Controlled unsupported records make removal observable without changing
          // native TXT fallback behavior. Two offscreen rows exercise both cache paths.
          const indexes=[0,1,90,91];
          for (const index of indexes) STATE.results[index]={Repo:'VoiceOfML/Test',File:'f3-'+index,
            Extension:'f3unsupported',Folder:[],Size:1};
          VSCROLL.templateCache.clear();
          for (const index of [0,1]) {
            const old=DOM.resultsList.querySelector('[data-index="'+index+'"]');
            old.replaceWith(createResultRow(STATE.results[index],index));
          }
          createResultRow(STATE.results[90],90);
          const key=getHeightMeasurementKey(),cache=new Map();
          for (const index of [...indexes,2]) {
            VSCROLL.measuredRowKeys[index]=key;
            const value={height:VSCROLL.heights[index]||60,measurementKey:key};
            VSCROLL.heightCache.set(getResultStableId(STATE.results[index]),value);cache.set(index,value);
          }
          const asset={s:2,m:'h',p:'objects/00/'+'0'.repeat(64)+'/profile/document.html'};
          readerAssetController.state.assets=Object.fromEntries([0,90,91].map(i=>[getResultStableId(STATE.results[i]),asset]));
          const row=DOM.resultsList.querySelector('[data-index="0"]'),checkbox=row.querySelector('input');
          checkbox.checked=true;
          const top=getResultScrollTop();
          let renders=0,writes=0;
          const native={schedule:scheduleVirtualRender,set:Storage.prototype.setItem};
          scheduleVirtualRender=()=>{renders++};
          Storage.prototype.setItem=function(...args){writes++;return native.set.apply(this,args)};
          try {
            refreshResultReaderActions();
            const invalidated=[0,90,91].every(i=>VSCROLL.measuredRowKeys[i]===null && !VSCROLL.heightCache.has(getResultStableId(STATE.results[i])));
            const untouched=[1,2].every(i=>VSCROLL.measuredRowKeys[i]===key && VSCROLL.heightCache.get(getResultStableId(STATE.results[i]))===cache.get(i));
            const added=!!row.querySelector('[data-action="read"]');
            const offscreen=createResultRow(STATE.results[90],90).querySelector('[data-action="read"]');
            const button=row.querySelector('[data-action="read"]');button.focus({preventScroll:true});
            // A mode/label change retains the existing button and invalidates height.
            const digest='a'.repeat(64);
            readerAssetController.state.assets={...readerAssetController.state.assets,[getResultStableId(STATE.results[0])]:{
              s:2,m:'a',b:'vomebook/reader-assets-v2',p:'media/audio/aac/'+digest+'/audio.mp3'}};
            VSCROLL.measuredRowKeys[0]=key;VSCROLL.heightCache.set(getResultStableId(STATE.results[0]),cache.get(0));
            refreshResultReaderActions();
            const label=button.textContent==='在线播放' && document.activeElement===button &&
              VSCROLL.measuredRowKeys[0]===null && !VSCROLL.heightCache.has(getResultStableId(STATE.results[0]));
            readerAssetController.state.assets={};refreshResultReaderActions();
            const removed=!row.querySelector('[data-action="read"]') && document.activeElement===row;
            const stale=!createResultRow(STATE.results[90],90).querySelector('[data-action="read"]');
            return {invalidated,untouched,added,offscreen:!!offscreen,label,removed,stale,
              selected:checkbox.checked,anchor:getResultScrollTop()===top,writes,renders};
          } finally {scheduleVirtualRender=native.schedule;Storage.prototype.setItem=native.set;}
        }''')
        self.assertEqual(result.pop('writes'), 0)
        self.assertEqual(result.pop('renders'), 3)
        self.assertTrue(all(result.values()), result)

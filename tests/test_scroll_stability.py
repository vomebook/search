"""Browser regressions for virtual height correction and the proxy scrollbar."""
import unittest
from tests import test_paging_recovery as paging


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

"""Bounded native layout with full-range search scrolling in Chromium."""
import unittest
from tests import test_scroll_stability as stability


class SegmentedScrollTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stability.ScrollStabilityTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        stability.ScrollStabilityTests.tearDownClass()

    def setUp(self):
        self.fixture = stability.ScrollStabilityTests()
        self.fixture.setUp()
        self.page = self.fixture.page
        self.page.evaluate('''async () => {
          // Emulate a WebView that silently clamps oversized CSS heights.
          // The application must reach every row without relying on them.
          for(const property of ['height','minHeight']){
            const cssName=property==='height'?'height':'min-height';
            Object.defineProperty(CSSStyleDeclaration.prototype,property,{
              configurable:true,get(){return this.getPropertyValue(cssName)},
              set(value){this.setProperty(cssName,/^[\\d.]+px$/.test(value)
                ? Math.min(1048576,parseFloat(value))+'px':value)}
            });
          }
          STATE.results=Array.from({length:100000},(_,i)=>({Repo:'VoiceOfML/Test',
            File:'row-'+i,Extension:'txt',Folder:[],Size:1}));
          STATE.total=100000;STATE.hasMore=false;STATE.isLoading=false;STATE._loadedPage=1000;
          resetVirtualScrollState();renderResults();await scrollFrames();
          window.segmentSamples=[];
          window.checkSegment=()=>{
            const c=DOM.resultsContainer, box=c.getBoundingClientRect();
            const row=[...DOM.resultsList.querySelectorAll('.result-item')]
              .find(row=>row.getBoundingClientRect().bottom>box.top);
            segmentSamples.push({native:c.scrollHeight,top:c.scrollTop,logical:getResultScrollTop(),
              number:Number(document.getElementById('current-result-position').value),
              actual:Number(row.dataset.index)+1});
          };
        }''')

    def tearDown(self):
        self.assertEqual(self.fixture.fixture.errors, [])
        self.fixture.tearDown()

    def check_samples(self, samples):
        for sample in samples:
            self.assertLessEqual(sample['native'], 1000001, sample)
            self.assertGreaterEqual(sample['top'], 0, sample)
            self.assertEqual(sample['number'], sample['actual'], sample)

    def test_native_scroll_crosses_segments_both_ways_without_skipping_distance(self):
        result = self.page.evaluate('''async()=>{
          const c=DOM.resultsContainer;
          for(let i=0;i<65;i++){
            c.scrollTop+=240000;renderVisible();checkSegment();
          }
          const deep=getResultScrollTop();
          for(let i=0;i<65;i++){
            c.scrollTop-=240000;renderVisible();checkSegment();
          }
          return {samples:segmentSamples,deep,end:getResultScrollTop()};
        }''')
        self.check_samples(result['samples'])
        self.assertEqual(result['deep'], 15600000)
        self.assertEqual(result['end'], 0)

    def test_full_range_touch_thumb_and_saved_anchor_stay_within_native_limit(self):
        result = self.page.evaluate('''async()=>{
          updateScrollTrack();
          const y=DOM.scrollThumb.getBoundingClientRect().top+10;
          const touch=y=>new Touch({identifier:1,target:DOM.scrollThumb,clientX:10,clientY:y});
          DOM.scrollThumb.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[touch(y)]}));
          document.dispatchEvent(new TouchEvent('touchmove',{cancelable:true,
            touches:[touch(y+DOM.scrollTrack.clientHeight)]}));
          await scrollFrames();
          document.dispatchEvent(new TouchEvent('touchend',{touches:[]}));
          await scrollFrames();checkSegment();
          const last=DOM.resultsList.querySelector('[data-index="99999"]');
          const lastVisible=last.getBoundingClientRect().top<DOM.resultsContainer.getBoundingClientRect().bottom;
          setResultScrollTop(getVirtualOffset(88050)+11);renderVisible();await scrollFrames();
          const saved=captureReaderReturnScroll();
          setResultScrollTop(0);renderVisible();
          readerReturnScrollState=saved;restoreReaderReturnScroll();await scrollFrames();checkSegment();
          return {samples:segmentSamples,lastVisible,anchor:findVirtualIndex(getResultScrollTop()),
            offset:getResultScrollTop()-getVirtualOffset(88050)};
        }''')
        self.check_samples(result['samples'])
        self.assertTrue(result['lastVisible'])
        self.assertGreater(result['samples'][0]['number'], 99990)
        self.assertEqual(result['anchor'], 88050)
        self.assertAlmostEqual(result['offset'], 11, delta=1)

    def test_editable_position_jumps_between_distant_segments(self):
        self.page.locator('#current-result-position').fill('95001')
        self.page.locator('#current-result-position').press('Enter')
        self.page.wait_for_function('findVirtualIndex(getResultScrollTop())===95000')
        self.page.locator('#current-result-position').fill('101')
        self.page.locator('#current-result-position').press('Enter')
        self.page.wait_for_function('findVirtualIndex(getResultScrollTop())===100')
        self.page.evaluate('checkSegment()')
        self.check_samples(self.page.evaluate('segmentSamples'))

    def test_deep_position_recovery_fetches_neighborhood_and_last_page(self):
        self.page.evaluate('''()=>{
          const key=getSearchViewKey();
          searchPositions.set(key,{version:1,key,index:88050,offset:11,loadedPage:882,
            savedAt:Date.now(),anchorId:'VoiceOfML/Test\\0row-88050.txt'});
          searchViewSnapshots.clear();searchViewportSnapshots.clear();
          window.segmentPages=[];
          fetchPositionPage=async(query,page)=>{
            segmentPages.push(page);
            return {page,page_size:query.pageSize,total:100000,generation:'segmented',anchor_index:88050,
              results:Array.from({length:100},(_,i)=>({Repo:'VoiceOfML/Test',
                File:'row-'+((page-1)*100+i),Extension:'txt',Folder:[],Size:1}))};
          };
          tryRestoreSearchPosition(key);
        }''')
        self.page.wait_for_function('!positionRestore && resultWindow && findVirtualIndex(getResultScrollTop())===88050')
        self.page.evaluate('checkSegment()')
        self.assertAlmostEqual(self.page.evaluate('getResultScrollTop()-getVirtualOffset(88050)'), 11, delta=1)
        self.page.evaluate('setResultScrollTop(getVirtualTotalHeight());renderVisible()')
        self.page.wait_for_function("STATE.results[99999]?.File==='row-99999'")
        self.page.evaluate('checkSegment()')
        self.check_samples(self.page.evaluate('segmentSamples'))
        self.assertTrue(self.page.evaluate('segmentPages.includes(1000) && !segmentPages.includes(500)'))

"""Local-only CHM restoration diagnostics using disposable browser contexts.

Only the existing first split candidate is served by the inherited loopback
fixture.  Records are synthetic; the tests neither touch a real browser profile
nor publish or modify a candidate object.  Counterexamples intentionally assert
the observed unsafe behavior; a passing counterexample is not a fix.
"""

import subprocess
import time
import unittest
from urllib.parse import parse_qs, urlencode, urlsplit

from tests import test_chm_history_retarget_diagnostic_20261105 as history
from tests import test_chm_local_search_compat_20261105 as compat


class BookmarkLandingProbe(unittest.TestCase):
    setUpClass = classmethod(compat.LocalChmSearchIntegration.setUpClass.__func__)
    tearDownClass = classmethod(compat.LocalChmSearchIntegration.tearDownClass.__func__)
    setUp = compat.LocalChmSearchIntegration.setUp
    tearDown = compat.LocalChmSearchIntegration.tearDown
    local_only = compat.LocalChmSearchIntegration.local_only
    bucket = compat.LocalChmSearchIntegration.bucket

    def seed(self):
        self.page.goto(self.origin + '/seed-synthetic', wait_until='domcontentloaded')
        self.page.add_script_tag(path=str(compat.HERE / 'static/reader/core/reader-store.js'))
        source = history.HistoryRetargetDiagnostic.bucket_url_for_test()
        key = self.page.evaluate('url=>VoiceOfMLReaderStore.localBookRecordKey("",url)', source)
        self.assertNotEqual(key, source)
        return source, key

    def open_reader(self, **params):
        target = self.origin + compat.fixture.PREFIX + '/static/reader.html?' + urlencode(params)
        self.page.goto(target, wait_until='domcontentloaded')
        self.page.wait_for_function(
            "()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)", timeout=90000)
        return self.page.locator('html').get_attribute('data-reader-phase')

    def geometry(self):
        return self.page.evaluate('''()=>{
          const viewport=document.querySelector('#viewport');
          const node=document.querySelector('.reader-epub-chapter[data-chapter="3"]');
          if(!node) return null;
          const rect=node.getBoundingClientRect(), view=viewport.getBoundingClientRect();
          return {offset:rect.top-view.top,height:rect.height,scrollTop:viewport.scrollTop,
            scrollHeight:viewport.scrollHeight,clientHeight:viewport.clientHeight,
            chapters:[...document.querySelectorAll('.reader-epub-chapter')].map(ch=>Number(ch.dataset.chapter))};
        }''')

    def test_counterexample_unreachable_history_is_automatically_replaced(self):
        """The original HEAD chapter restore consumes and overwrites this history."""
        module = 'static/reader/formats/reader-chapter-format.mjs'
        pristine = subprocess.check_output(['git', 'show', 'HEAD:' + module], cwd=compat.HERE)
        served = []
        def pristine_chapter(route):
            served.append(True)
            route.fulfill(status=200, content_type='text/javascript', body=pristine)
        self.page.route('**/' + module, pristine_chapter)
        source, key = self.seed()
        self.page.evaluate('''async ({key,source})=>VoiceOfMLReaderStore.put({url:key,
          title:'synthetic history',extension:'epub-chapters',lastReadAt:100,
          chapterManifest:source,chapterIndex:3,chapterOffset:1000000000})''',
                           {'key': key, 'source': source})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key)
        self.assertEqual(self.open_reader(url=source, ext='epub-chapters'), 'ready')
        self.page.evaluate('''key=>{
          window.__historyChanged=false;
          window.__historyCheck=setInterval(async()=>{
            const row=await VoiceOfMLReaderStore.get(key);
            if(row && row.chapterOffset!==1000000000) window.__historyChanged=true;
          },100);
        }''', key)
        try:
            self.page.wait_for_function('()=>window.__historyChanged === true', timeout=30000)
        finally:
            self.page.evaluate('()=>clearInterval(window.__historyCheck)')
        after = self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key)
        self.assertEqual(before['chapterOffset'], 1000000000)
        self.assertNotEqual(after['chapterOffset'], before['chapterOffset'])
        self.assertEqual(after['chapterManifest'], source)
        self.assertTrue(served)
        self.assertEqual(self.external, [])
        print('unreachable-history', {'beforeOffset': before['chapterOffset'],
              'afterOffset': after['chapterOffset'], 'afterChapter': after['chapterIndex'],
              'geometry': self.geometry()})

    def test_unreachable_history_remains_unchanged_while_reader_stays_usable(self):
        source, key = self.seed()
        self.page.evaluate('''async ({key,source})=>VoiceOfMLReaderStore.put({url:key,
          title:'synthetic history',extension:'epub-chapters',lastReadAt:100,
          chapterManifest:source,chapterIndex:3,chapterOffset:1000000000})''',
                           {'key': key, 'source': source})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key)
        self.assertEqual(self.open_reader(url=source, ext='epub-chapters'), 'ready')
        self.assertIn('无法在当前版式准确定位', self.page.locator('#download-feedback').inner_text())
        self.page.locator('#viewport').evaluate('''node=>{
          node.dispatchEvent(new WheelEvent('wheel',{deltaY:500,bubbles:true}));node.scrollTop+=500;
        }''')
        self.page.wait_for_timeout(1400)
        self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key), before)
        self.assertGreater(self.page.locator('#viewport').evaluate('node=>node.scrollTop'), 100)
        self.assertEqual(self.external, [])
        self.assertEqual(self.errors, [])

    def test_unreachable_bookmark_remains_and_does_not_consume_handoff_or_history(self):
        source, key = self.seed()
        self.page.evaluate('''async ({key,source})=>{
          await VoiceOfMLReaderStore.put({url:key,title:'synthetic history',extension:'epub-chapters',
            lastReadAt:100,chapterManifest:source,chapterIndex:1,chapterOffset:0});
          await VoiceOfMLReaderStore.putBookmark({id:'synthetic-unavailable',url:key,label:'synthetic mark',
            createdAt:100,chapterManifest:source,chapterIndex:3,chapterOffset:1000000000});
        }''', {'key': key, 'source': source})
        before = self.page.evaluate('''async key=>({history:await VoiceOfMLReaderStore.get(key),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(key)})''', key)
        self.assertEqual(self.open_reader(url=source, ext='epub-chapters', bookmark='synthetic-unavailable',
                                          bookmark_source=key), 'ready')
        self.assertIn('无法在当前版式准确定位', self.page.locator('#download-feedback').inner_text())
        self.assertEqual(self.page.evaluate("()=>new URL(location.href).searchParams.get('bookmark')"),
                         'synthetic-unavailable')
        self.assertEqual(self.page.evaluate("()=>new URL(location.href).searchParams.get('bookmark_source')"), key)
        self.page.locator('#viewport').evaluate('''node=>{
          node.dispatchEvent(new WheelEvent('wheel',{deltaY:500,bubbles:true}));node.scrollTop+=500;
        }''')
        self.page.wait_for_timeout(1400)
        self.assertEqual(self.page.evaluate('''async key=>({history:await VoiceOfMLReaderStore.get(key),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(key)})''', key), before)
        self.assertEqual(self.external, [])
        self.assertEqual(self.errors, [])

    def test_unreachable_negative_history_does_not_get_overwritten(self):
        """A very negative offset is different from an ordinary chapter gap."""
        source, key = self.seed()
        self.page.evaluate('''async ({key,source})=>VoiceOfMLReaderStore.put({url:key,
          title:'synthetic negative history',extension:'epub-chapters',lastReadAt:100,
          chapterManifest:source,chapterIndex:3,chapterOffset:-1000000000})''',
                           {'key': key, 'source': source})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key)
        self.assertEqual(self.open_reader(url=source, ext='epub-chapters'), 'ready')
        self.assertIn('无法在当前版式准确定位', self.page.locator('#download-feedback').inner_text())
        self.page.wait_for_timeout(1400)
        self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key), before)
        self.assertEqual(self.external, [])

    def test_small_negative_chapter_boundary_remains_readable(self):
        source, key = self.seed()
        self.page.evaluate('''async ({key,source})=>VoiceOfMLReaderStore.put({url:key,
          title:'synthetic boundary',extension:'epub-chapters',lastReadAt:100,
          chapterManifest:source,chapterIndex:1,chapterOffset:-12})''',
                           {'key': key, 'source': source})
        self.assertEqual(self.open_reader(url=source, ext='epub-chapters'), 'ready')
        self.assertNotIn('无法在当前版式准确定位', self.page.locator('#download-feedback').inner_text())
        self.assertEqual(self.page.locator('.reader-epub-chapter[data-chapter="1"]').count(), 1)
        self.assertEqual(self.external, [])

    def test_null_offset_is_not_guessed_as_zero(self):
        source, key = self.seed()
        self.page.evaluate('''async ({key,source})=>VoiceOfMLReaderStore.put({url:key,
          title:'synthetic null history',extension:'epub-chapters',lastReadAt:100,
          chapterManifest:source,chapterIndex:3,chapterOffset:null})''',
                           {'key': key, 'source': source})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key)
        self.assertEqual(self.open_reader(url=source, ext='epub-chapters'), 'ready')
        self.assertIn('无法在当前版式准确定位', self.page.locator('#download-feedback').inner_text())
        self.page.wait_for_timeout(1400)
        self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key), before)
        self.assertEqual(self.external, [])

    def test_missing_chapter_index_does_not_fall_back_to_generic_scrolltop(self):
        source, key = self.seed()
        self.page.evaluate('''async ({key,source})=>VoiceOfMLReaderStore.put({url:key,
          title:'synthetic incomplete chapter history',extension:'epub-chapters',lastReadAt:100,
          chapterManifest:source,chapterOffset:200,scrollTop:123456})''',
                           {'key': key, 'source': source})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key)
        self.assertEqual(self.open_reader(url=source, ext='epub-chapters'), 'ready')
        self.assertIn('无法在当前版式准确定位', self.page.locator('#download-feedback').inner_text())
        self.page.wait_for_timeout(1400)
        self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key), before)
        self.assertEqual(self.external, [])

    def test_unavailable_panel_bookmark_does_not_write_current_history(self):
        source, key = self.seed()
        self.page.evaluate('''async ({key,source})=>VoiceOfMLReaderStore.putBookmark({
          id:'synthetic-panel-mark',url:key,label:'synthetic unavailable panel mark',createdAt:100,
          chapterManifest:source,chapterIndex:3,chapterOffset:1000000000})''', {'key': key, 'source': source})
        self.assertEqual(self.open_reader(url=source, ext='epub-chapters'), 'ready')
        self.page.evaluate('''key=>{
          window.__initialSaved=false;
          window.__initialSaveTimer=setInterval(async()=>{
            if(await VoiceOfMLReaderStore.get(key)) window.__initialSaved=true;
          },100);
        }''', key)
        try:
            self.page.wait_for_function('()=>window.__initialSaved === true', timeout=30000)
        finally:
            self.page.evaluate('()=>clearInterval(window.__initialSaveTimer)')
        before = self.page.evaluate('''async key=>({history:await VoiceOfMLReaderStore.get(key),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(key)})''', key)
        if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
            self.page.locator('#history').evaluate('node=>node.click()')
        self.page.locator('#bookmarks-tab').evaluate('node=>node.click()')
        row = self.page.locator('#bookmarks-list .panel-item').filter(has_text='synthetic unavailable panel mark')
        row.wait_for()
        row.locator('.panel-item-main').evaluate('node=>node.click()')
        self.page.wait_for_function(
            "()=>document.querySelector('#download-feedback').textContent.includes('无法在当前版式准确定位')", timeout=30000)
        self.page.wait_for_timeout(1400)
        self.assertEqual(self.page.evaluate('''async key=>({history:await VoiceOfMLReaderStore.get(key),
          bookmarks:await VoiceOfMLReaderStore.listBookmarks(key)})''', key), before)
        self.assertEqual(self.external, [])

    def test_in_chapter_offset_clamped_by_current_scroll_range_does_not_overwrite(self):
        """Incomplete neighboring chapters can make an otherwise in-range offset unreachable."""
        source, key = self.seed()
        self.page.evaluate('''async ({key,source})=>VoiceOfMLReaderStore.put({url:key,
          title:'synthetic clamped history',extension:'epub-chapters',lastReadAt:100,
          chapterManifest:source,chapterIndex:3,chapterOffset:118900})''', {'key': key, 'source': source})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key)
        held = []
        def hold_neighbors(route):
            path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
            if '/18ba3952389e349e/chapters/' in path and not path.endswith('/chapter-0003.xhtml'):
                held.append(route)
                return
            self.bucket(route)
        self.context.unroute('**/api/reader-bucket-resource**', self.bucket)
        self.context.route('**/api/reader-bucket-resource**', hold_neighbors)
        try:
            self.assertEqual(self.open_reader(url=source, ext='epub-chapters'), 'ready')
            geometry = self.geometry()
            self.assertTrue(held, 'neighboring chapter requests were not held; experiment not exercised')
            self.assertLess(118900, geometry['height'], geometry)
            self.assertIn('无法在当前版式准确定位', self.page.locator('#download-feedback').inner_text())
            self.page.wait_for_timeout(1400)
            self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.get(key)', key), before)
            self.assertEqual(self.external, [])
        finally:
            # No late delivery after assertions; cancel only this fixture's held requests.
            self.page.evaluate("()=>window.dispatchEvent(new Event('voice-reader-dispose'))")
            for route in held:
                try:
                    route.abort()
                except Exception:
                    pass

    def test_late_preceding_chapter_keeps_valid_bookmark_on_landing(self):
        """Hold chapter 2 until a chapter-3 bookmark has initially landed."""
        source, key = self.seed()
        self.page.evaluate('''async ({key,source})=>VoiceOfMLReaderStore.putBookmark({
          id:'synthetic-late-chapter',url:key,label:'synthetic mark',createdAt:100,
          chapterManifest:source,chapterIndex:3,chapterOffset:200})''', {'key': key, 'source': source})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.listBookmarks(key)', key)
        held = []
        held_first = []

        def hold_chapter(route):
            path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
            if path.endswith('/18ba3952389e349e/chapters/chapter-0002.xhtml'):
                held.append(route)
                return
            if path.endswith('/18ba3952389e349e/chapters/chapter-0001.xhtml'):
                held_first.append(route)
                return
            self.bucket(route)

        self.context.unroute('**/api/reader-bucket-resource**', self.bucket)
        self.context.route('**/api/reader-bucket-resource**', hold_chapter)
        try:
            self.assertEqual(self.open_reader(url=source, ext='epub-chapters', bookmark='synthetic-late-chapter',
                                              bookmark_source=key), 'ready')
            deadline = time.monotonic() + 10
            while not held and time.monotonic() < deadline:
                self.page.wait_for_timeout(100)
            self.assertTrue(held, 'chapter 2 was not requested and held; experiment not exercised')
            initial = self.geometry()
            self.assertIsNotNone(initial)
            self.assertAlmostEqual(initial['offset'], -192, delta=4, msg=f'initial={initial}')
            self.bucket(held.pop(0))
            self.page.wait_for_function(
                "()=>!!document.querySelector('.reader-epub-chapter[data-chapter=\"2\"]')", timeout=30000)
            self.page.wait_for_timeout(1200)
            final = self.geometry()
            self.assertIsNotNone(final)
            self.assertNotIn(1, final['chapters'], 'chapter 1 must stay unloaded during the measurement')
            self.assertAlmostEqual(final['offset'], -192, delta=4, msg=f'initial={initial} final={final}')
            self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.listBookmarks(key)', key), before)
            self.assertEqual(self.external, [])
            self.assertEqual(self.errors, [])
            print('late-preceding-chapter', {'initial': initial, 'final': final, 'firstHeld': len(held_first)})
        finally:
            self.page.evaluate("()=>window.dispatchEvent(new Event('voice-reader-dispose'))")
            for route in held + held_first:
                try:
                    route.abort()
                except Exception:
                    pass

    def test_late_first_chapter_keeps_valid_bookmark_on_landing(self):
        """Hold chapter 1 separately to exercise a second insertion order."""
        source, key = self.seed()
        self.page.evaluate('''async ({key,source})=>VoiceOfMLReaderStore.putBookmark({
          id:'synthetic-first-late',url:key,label:'synthetic mark',createdAt:100,
          chapterManifest:source,chapterIndex:3,chapterOffset:200})''', {'key': key, 'source': source})
        before = self.page.evaluate('key=>VoiceOfMLReaderStore.listBookmarks(key)', key)
        held = []
        def hold_first(route):
            path = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
            if path.endswith('/18ba3952389e349e/chapters/chapter-0001.xhtml'):
                held.append(route)
                return
            self.bucket(route)
        self.context.unroute('**/api/reader-bucket-resource**', self.bucket)
        self.context.route('**/api/reader-bucket-resource**', hold_first)
        try:
            self.assertEqual(self.open_reader(url=source, ext='epub-chapters', bookmark='synthetic-first-late',
                                              bookmark_source=key), 'ready')
            # Trigger the real previous-chapter loader, then restore the prior
            # viewport without a wheel/touch event while its response is held.
            self.page.evaluate('''()=>{const v=document.querySelector('#viewport');const y=v.scrollTop;
              v.scrollTop=0;setTimeout(()=>{v.scrollTop=y},100)}''')
            deadline = time.monotonic() + 10
            while not held and time.monotonic() < deadline:
                self.page.wait_for_timeout(100)
            self.assertTrue(held, 'chapter 1 was not requested and held; experiment not exercised')
            self.page.wait_for_timeout(200)
            before_alignment = self.geometry()
            # Normalize the pre-existing intermittent landing error so this
            # probe measures chapter 1 insertion rather than mixing the two.
            self.page.evaluate('''()=>{const v=document.querySelector('#viewport');
              const ch=document.querySelector('.reader-epub-chapter[data-chapter="3"]');
              v.scrollTop+=ch.getBoundingClientRect().top-v.getBoundingClientRect().top+192}''')
            self.page.wait_for_timeout(200)
            initial = self.geometry()
            self.assertAlmostEqual(initial['offset'], -192, delta=4, msg=f'initial={initial}')
            self.bucket(held.pop(0))
            self.page.wait_for_function(
                "()=>!!document.querySelector('.reader-epub-chapter[data-chapter=\"1\"]')", timeout=30000)
            self.page.wait_for_timeout(1200)
            final = self.geometry()
            self.assertAlmostEqual(final['offset'], -192, delta=4,
                                   msg=f'beforeAlignment={before_alignment} initial={initial} final={final}')
            self.assertEqual(self.page.evaluate('key=>VoiceOfMLReaderStore.listBookmarks(key)', key), before)
            self.assertEqual(self.external, [])
            self.assertEqual(self.errors, [])
            print('late-first-chapter', {'beforeAlignment': before_alignment, 'initial': initial, 'final': final})
        finally:
            self.page.evaluate("()=>window.dispatchEvent(new Event('voice-reader-dispose'))")
            for route in held:
                try:
                    route.abort()
                except Exception:
                    pass


if __name__ == '__main__':
    unittest.main()

"""Shared table-of-contents navigation regressions: sidebar jumps land where the entry says.

Covers chapter bundles (`epub-chapters`): early and late entries, fragments inside
large chapters, re-jumps after window trimming, rapid successive clicks, the
virtualized directory and the opening hint. Also covers PDF and HTML navigation.

Run the offline drawer race regressions from either repository root:
    python -B -m unittest -v -k test_delayed_toc_row tests.reader.browser.test_reader_toc_navigation
"""
import re
import unittest
from urllib.parse import unquote, urlencode

from tests.reader.browser import test_reader_pdf_followup as support

BODY = '<p style="height:1400px">正文</p>'
CHAPTER_SOURCE = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                  + 'a' * 64 + '/1234567890abcdef/chapter-manifest.json')


def chapter_manifest(count, fragments=False):
    chapters = [{"index": i, "path": f"chapters/chapter-{i:04d}.xhtml", "bytes": 600}
                for i in range(1, count + 1)]
    toc = [{"title": f"第{i}章", "chapter": i, "fragment": "", "depth": 0} for i in range(1, count + 1)]
    if fragments:
        toc += [{"title": f"第{i}章 第二节", "chapter": i, "fragment": f"sec-{i}-b", "depth": 1}
                for i in range(1, count + 1)]
    return {"version": 1, "kind": "epub-chapters", "chapters": chapters, "toc": toc}


def chapter_body(index):
    return (f'<h1 id="chapter-{index}">第{index}章</h1>'
            f'<p id="sec-{index}-a">第{index}章 第一节</p>{BODY}'
            f'<h2 id="sec-{index}-b">第{index}章 第二节</h2>{BODY}')


class TocNavigationTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

    # ---- harness ----

    def expose(self):
        """Expose the internals this suite must observe; the suite fails loudly if the
        instrumentation did not take effect instead of testing an uninstrumented page."""
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + '''
              window.__replaceTocForSearch=setToc;
              window.__toc={nav:()=>navigationState, jump:i=>navigateTocEntry(i),
                set:setToc, sync:()=>syncHeadingLocation(), filter:()=>filterPanel(document.querySelector('#toc-panel')),
                setPageCount:count=>updateDocumentState({pageCount:count}),
                setPage:page=>{updateDocumentState({page});updateTocCurrentMark()},
                setCurrent:index=>{updateNavigationState({currentChapterIndex:index});updateTocCurrentMark()},
                state:()=>tocVirtualState,
                align:(selector, offset)=>alignReaderDestination(document.querySelector(selector), offset || 0),
                hold:(target, offset)=>holdReaderDestination(target, offset),
                hasHold:()=>!!activeReaderDestinationHold,
                reassert:landing=>reassertReaderDestination(landing),
                scrollTop:()=>viewport.scrollTop};
            ''')
        self.page.route('**/static/reader.js*', instrument)
        self.page.on('pageerror', lambda error: self.errors.append(f'page:{error}'))

    def assert_instrumented(self):
        self.assertEqual(self.page.evaluate("()=>typeof window.__toc"), "object",
                         "reader.js instrumentation did not load")

    def open_chapters(self, count=300, fragments=False, min_rows=4, before_open=None):
        manifest = chapter_manifest(count, fragments)
        self.expose()

        def resource(route):
            url = route.request.url
            if "chapter-manifest" in url:
                route.fulfill(json=manifest)
                return
            index = int(re.search(r"chapter-(\d+)\.xhtml", unquote(url)).group(1))
            route.fulfill(content_type="text/html", body=chapter_body(index))

        self.page.route("**/api/reader-bucket-resource**", resource)
        if before_open:
            before_open()
        self.page.goto(self.origin + support.PREFIX + "/static/reader.html?" +
                       urlencode(dict(url=CHAPTER_SOURCE, ext="epub-chapters")), wait_until="domcontentloaded")
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.page.wait_for_function(
            f"()=>document.querySelectorAll('#toc-list .toc-item').length>={min_rows}")
        self.assert_instrumented()

    def test_pdf_outline_uses_destination_page_not_title(self):
        self.expose()
        engine = support.ENGINE.replace('getOutline:async()=>null', '''getOutline:async()=>[
          {title:'封面',dest:[0,{name:'Fit'}]},
          {title:'第 1 页的旁注',dest:'named'},
          {title:'第 1 页（无目的地）',dest:null},
          {title:'引用',dest:[{num:7,gen:0},{name:'Fit'}]},
          {title:'第 1 页（无效页码）',dest:[12,{name:'Fit'}]},
        ],getDestination:async()=>[5,{name:'Fit'}],
        getPageIndex:async ref=>{if(ref?.num!==7) throw Error('Expected a page reference'); return 8;}''')
        self.page.unroute('**/static/vendor/pdf.min.*.mjs')
        self.page.route('**/static/vendor/pdf.min.*.mjs', lambda route: route.fulfill(
            content_type='text/javascript', body=engine))
        support.PdfFollowupTests.open(self)
        self.page.wait_for_function('()=>__toc.nav().tocEntries.length===5')
        self.assertEqual(self.page.evaluate('__toc.nav().tocEntries.map(entry=>entry.page)'), [1, 6, None, 9, None])
        self.assertEqual(self.page.evaluate('__toc.nav().currentChapterIndex'), 0)
        for index, target in ((1, 6), (3, 9), (0, 1)):
            self.page.locator(f'#toc-list [data-toc-index="{index}"] [role="link"]').dispatch_event('click')
            self.page.wait_for_function('p=>Number(document.querySelector("#page-number").value)===p', arg=target)
            self.assertEqual(self.page.locator('#toc-list [aria-current="location"]').evaluate(
                'link=>Number(link.parentElement.dataset.tocIndex)'), index)
        self.assertFalse(self.page.evaluate('()=>__toc.nav().tocEntries[2].activate()'))

        if not self.panel_open():
            self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        previous = self.page.locator('.reader-chapter-prev')
        following = self.page.locator('.reader-chapter-next')
        self.assertTrue(previous.is_disabled())
        for button, index, page in ((following, 1, 6), (following, 3, 9), (previous, 1, 6)):
            button.click()
            self.page.wait_for_function('i=>__toc.nav().currentChapterIndex===i', arg=index)
            self.assertEqual(self.page.locator('#page-number').input_value(), str(page))
            self.assertTrue(self.panel_open())
            if index == 3:
                self.assertTrue(following.is_disabled(), 'an invalid trailing destination is not a chapter')

    def test_body_click_does_not_discard_pending_history(self):
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='text/plain', body='可点击正文\n' * 2000))
        self.page.route('**/static/reader/core/reader-store.js*', lambda route: route.fulfill(
            content_type='text/javascript', body='''window.VoiceOfMLReaderStore={
              get:()=>new Promise(resolve=>{window.__releaseHistory=()=>resolve({scrollTop:1200});}),
              put:async(entry)=>{window.__writtenScroll=entry.scrollTop;},list:async()=>[]};'''))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/click-history.txt', ext='txt')))
        self.page.wait_for_function('()=>!!window.__releaseHistory')
        self.page.locator('.reader-text-block').first.click(position={'x': 30, 'y': 20})
        self.assertIsNone(self.page.evaluate('window.__writtenScroll'))
        self.page.evaluate('window.__releaseHistory()')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready' && window.__writtenScroll!==undefined")
        self.assertEqual(self.page.evaluate('window.__writtenScroll'), 1200)
        self.assertEqual(self.page.locator('#viewport').evaluate('node=>node.scrollTop'), 1200)

    def test_page_input_blur_refreshes_untouched_value_but_commits_an_edit(self):
        support.PdfFollowupTests.open(self)
        field = self.page.locator('#page-number')
        self.page.locator('#page-next').click()
        self.page.wait_for_function("()=>document.querySelector('#page-number').value==='2'")
        field.focus()
        self.page.wait_for_timeout(550)  # Let the explicit navigation marker lock expire.
        self.page.locator('#viewport').evaluate("""node=>{
          node.scrollTop += node.querySelector('.reader-page[data-page="4"]').getBoundingClientRect().top
            - node.getBoundingClientRect().top;
        }""")
        self.page.wait_for_function("()=>document.querySelector('.reader-progress-percent').textContent !== '0.0%'")
        self.page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        self.assertEqual(field.input_value(), '2')
        field.blur()
        self.assertEqual(field.input_value(), '4')
        field.fill('5')
        field.press('Enter')
        self.page.wait_for_function("()=>document.activeElement?.id !== 'page-number' && document.querySelector('#page-number').value==='5'")
        self.page.locator('.reader-page[data-page="5"] canvas.ready').wait_for()

    def test_large_pdf_toc_page_lookup_preserves_unsorted_labels_and_resets(self):
        self.expose()
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(content_type='text/plain',body='text'))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/large-toc.txt',ext='txt')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        result = self.page.evaluate('''() => {
          const entries = Array.from({length:3000}, (_, index) => ({
            label: `条目 ${index} · 第 ${(index * 31) % 1800 + 1} 页`,
            page: index % 31 === 0 ? null : (index * 97) % 1800 + 1,
            group: index % 31 === 0,
            activate: () => true
          }));
          // A later directory entry wins even if its page is lower, and on ties.
          entries.push({label:'第 1 页在标题内',page:1000,activate:()=>true},
            {label:'第 999 页 · 甲',page:20,activate:()=>true},
            {label:'第 999 页 · 乙',page:20,activate:()=>true},
            {label:'第 1 页无链接',page:null,activate:()=>false});
          const action = {label:'第 1 页 · 加载目录',activate:()=>true};
          const pages = [1,2,10,19,20,99,500,999,1000,1500,1800,4999];
          __toc.setPageCount(5000);
          function check(entries, pages) {
            __toc.set(entries);
            return pages.map(page => {
              const expected = entries.findLastIndex(entry => typeof entry.page === 'number' && entry.page <= page);
              __toc.setPage(page);
              return {page,expected,actual:__toc.nav().currentChapterIndex};
            });
          }
          return {
            explicit: check(entries, pages),
            withAction: check([...entries, action], pages),
            reset: check([{label:'第一章 · 第 1 页',page:10,activate:()=>true},
              {label:'第二章 · 第 999 页',page:3,activate:()=>true},
              {label:'第 1 页无链接',page:null,activate:()=>false}, action], [3,12])
          };
        }''')
        for scenario, cases in result.items():
            for case in cases:
                with self.subTest(scenario=scenario, page=case['page']):
                    self.assertEqual(case['actual'], case['expected'])

    def click_entry(self, index):
        """Click the sidebar row for a directory index, as a reader does."""
        self.page.evaluate("""() => {
            const toggle = document.querySelector('#history');
            if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
        }""")
        self.page.wait_for_timeout(100)
        clicked = self.page.evaluate("""(index) => {
            const row = document.querySelector(`#toc-list .toc-item[data-toc-index="${index}"]`);
            if (!row) return false;
            row.querySelector('.panel-item-main').click();
            return true;
        }""", index)
        self.assertTrue(clicked, f"directory row {index} is missing")
        self.page.wait_for_timeout(1500)

    def offset_of(self, selector):
        return self.page.evaluate("""(selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            return Math.round((node.getBoundingClientRect().top -
                document.querySelector('#viewport').getBoundingClientRect().top) * 10) / 10;
        }""", selector)

    def landed_chapter(self):
        return self.page.evaluate("""() => {
            const viewport = document.querySelector('#viewport').getBoundingClientRect();
            for (const article of document.querySelectorAll('.reader-epub-chapter')) {
                const box = article.getBoundingClientRect();
                if (box.top <= viewport.top + 40 && box.bottom > viewport.top + 10)
                    return Number(article.dataset.chapter);
            }
            return null;
        }""")

    def panel_open(self):
        return self.page.evaluate("()=>document.querySelector('#history').getAttribute('aria-expanded') === 'true'")

    def test_chapter_bundle_buttons_keep_directory_open_in_both_directions(self):
        self.open_chapters(12)
        for width in (390, 1280):
            with self.subTest(width=width):
                self.page.set_viewport_size({'width':width,'height':844})
                self.page.emulate_media(reduced_motion='reduce')
                self.click_entry(3)
                self.page.wait_for_function("()=>document.querySelector('#history').getAttribute('aria-expanded')==='false'")
                self.page.locator('#history').click()
                self.page.locator('#toc-tab').click()
                for selector, index, chapter in [('.reader-chapter-next',4,5),('.reader-chapter-prev',3,4)]:
                    self.page.locator(selector).click()
                    self.page.wait_for_function('index=>__toc.nav().currentChapterIndex===index',arg=index)
                    self.assertTrue(self.panel_open(), selector)
                    self.assertTrue(self.page.locator('#history-panel').evaluate("n=>n.classList.contains('is-open')&&!n.inert"))
                    self.assertEqual(self.page.locator('#toc-tab').get_attribute('aria-selected'), 'true')
                    self.assertEqual(self.page.locator('#toc-list [aria-current="location"]').get_attribute('title'), f'第{chapter}章')
                    self.assertEqual(self.landed_chapter(),chapter)
                self.page.locator('.reader-chapter-next').focus()
                self.page.locator('.reader-chapter-next').press('Enter')
                self.page.wait_for_function('()=>__toc.nav().currentChapterIndex===4')
                self.assertTrue(self.panel_open())
                self.assertEqual(self.page.evaluate('document.activeElement.className'),'reader-chapter-next')
                self.page.keyboard.press('Escape')
                self.assertFalse(self.panel_open())
                self.assertEqual(self.page.evaluate('document.activeElement.id'),'history')

    def test_chapter_buttons_boundaries_do_not_close_directory(self):
        self.open_chapters(6)
        self.click_entry(0)
        self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.assertTrue(self.page.locator('.reader-chapter-prev').is_disabled())
        self.assertTrue(self.panel_open())
        self.click_entry(5)
        self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.assertTrue(self.page.locator('.reader-chapter-next').is_disabled())
        self.assertTrue(self.panel_open())

    def test_failed_chapter_button_does_not_close_directory(self):
        failed=[]
        def install_failure():
            def resource(route):
                path=unquote(route.request.url)
                if 'chapter-0010.xhtml' in path:
                    failed.append(path)
                    route.fulfill(status=503,body='unavailable')
                elif 'chapter-manifest' in path: route.fulfill(json=chapter_manifest(12))
                else:
                    index=int(re.search(r'chapter-(\d+)\.xhtml',path).group(1))
                    route.fulfill(content_type='text/html',body=chapter_body(index))
            self.page.route('**/api/reader-bucket-resource**',resource)
        self.open_chapters(12,before_open=install_failure)
        self.click_entry(8)
        self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.page.locator('.reader-chapter-next').click()
        self.page.wait_for_function("()=>document.querySelector('.reader-chapter-sentinel[data-chapter=\"10\"]')?.classList.contains('reader-chapter-load-error')")
        self.assertTrue(failed)
        self.assertTrue(self.panel_open())
        self.assertEqual(self.page.evaluate('__toc.nav().currentChapterIndex'),8)

    def test_html_chapter_buttons_keep_directory_and_ordinary_toc_click_closes(self):
        self.expose()
        html='<p style="height:1400px">前言</p>'+''.join(
            f'<h1 id="chapter-{i}">第{i}章</h1><p style="height:1400px">正文</p>' for i in range(1,5))
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(content_type='text/html',body=html))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/chapters.html',ext='html')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready' && __toc.nav().tocEntries.length===4")
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.assertEqual(self.page.evaluate('__toc.nav().currentChapterIndex'), -1)
        self.assertTrue(self.page.locator('.reader-chapter-prev').is_disabled())
        self.page.locator('.reader-chapter-next').click()
        self.page.wait_for_function('()=>__toc.nav().currentChapterIndex===0')
        self.assertEqual(self.page.locator('#toc-list [aria-current="location"]').get_attribute('title'),'第1章')
        self.page.locator('.reader-chapter-next').click()
        self.page.wait_for_function('()=>__toc.nav().currentChapterIndex===1')
        self.assertTrue(self.panel_open())
        self.assertEqual(self.page.locator('#toc-list [aria-current="location"]').get_attribute('title'),'第2章')
        self.page.locator('.reader-chapter-prev').click()
        self.page.wait_for_function('()=>__toc.nav().currentChapterIndex===0')
        self.assertTrue(self.panel_open())
        self.page.locator('#toc-list .toc-item[data-toc-index="2"] .panel-item-main').click()
        self.page.wait_for_function('()=>__toc.nav().currentChapterIndex===2')
        self.assertFalse(self.panel_open())

    def test_delayed_chapter_completion_does_not_reopen_a_manually_closed_panel(self):
        held=[]
        def install_delay():
            def delay(route):
                path=unquote(route.request.url)
                if 'chapter-0010.xhtml' in path: held.append(route)
                elif 'chapter-manifest' in path: route.fulfill(json=chapter_manifest(12))
                else:
                    index=int(re.search(r'chapter-(\d+)\.xhtml',path).group(1))
                    route.fulfill(content_type='text/html',body=chapter_body(index))
            self.page.route('**/api/reader-bucket-resource**',delay)
        self.open_chapters(12,before_open=install_delay)
        self.click_entry(8)
        self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.page.locator('.reader-chapter-next').click()
        self.assertTrue(held,'target chapter request was not delayed')
        self.assertTrue(self.panel_open())
        self.page.locator('#history-close').click()
        self.assertFalse(self.panel_open())
        for route in held:
            try: route.fulfill(content_type='text/html',body=chapter_body(10))
            except Exception: pass
        self.page.wait_for_function('()=>__toc.nav().currentChapterIndex===9')
        self.assertFalse(self.panel_open(),'late completion must not reopen the panel')

    def click_delayed_toc_row(self):
        held = []
        target = '**/api/reader-bucket-resource?path=*chapter-0010.xhtml'

        def hold_target(route):
            held.append(route)
            self.page.evaluate('() => { window.__tocTargetHeld = true; }')

        def delay_chapter():
            self.page.route(target, hold_target)

        # The row click, not ambient prefetch, must request the target chapter.
        self.page.add_init_script("Object.defineProperty(document, 'hidden', {value:true})")
        self.open_chapters(12, before_open=delay_chapter)
        if not self.panel_open():
            self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        with self.page.expect_request(target):
            self.page.locator('#toc-list [data-toc-index="9"] [role="link"]').click()
        # Playwright's request event can precede execution of its route handler.
        self.page.wait_for_function('() => window.__tocTargetHeld === true')
        self.assertEqual(len(held), 1, 'target chapter request was not held')
        self.assertIsNone(self.offset_of('.reader-epub-chapter[data-chapter="10"]'))
        self.assertTrue(self.panel_open(), 'the drawer should remain open until the chapter lands')
        return held[0]

    def release_delayed_toc_row(self, route):
        route.fulfill(content_type='text/html', body=chapter_body(10))
        self.page.wait_for_function('()=>__toc.nav().currentChapterIndex===9')
        self.assertEqual(self.landed_chapter(), 10)
        self.assertEqual(self.page.locator('#toc-list [aria-current="location"]').get_attribute('title'), '第10章')

    def test_delayed_toc_row_closes_untouched_drawer(self):
        route = self.click_delayed_toc_row()
        self.release_delayed_toc_row(route)
        self.assertFalse(self.panel_open())
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'history')

    def test_delayed_toc_row_respects_reopened_drawer(self):
        route = self.click_delayed_toc_row()
        self.page.locator('#history-close').click()
        self.assertFalse(self.panel_open())
        self.page.locator('#history').click()
        self.page.locator('#bookmarks-tab').click()
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'bookmarks-tab')

        self.release_delayed_toc_row(route)
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'bookmarks-tab')
        self.assertTrue(self.panel_open())
        self.assertTrue(self.page.locator('#history-panel').evaluate(
            "panel=>panel.classList.contains('is-open') && !panel.inert"))
        self.assertEqual(self.page.locator('#bookmarks-tab').get_attribute('aria-selected'), 'true')
        self.assertTrue(self.page.locator('#bookmarks-panel').is_visible())

    def test_delayed_toc_row_respects_tab_switch_without_reopening(self):
        route = self.click_delayed_toc_row()
        self.page.locator('#bookmarks-tab').click()
        self.page.locator('#toc-tab').click()

        self.release_delayed_toc_row(route)
        self.assertTrue(self.panel_open(), 'switching away and back relinquishes the old click’s close')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'toc-tab')

    def test_delayed_toc_row_does_not_refocus_after_manual_close(self):
        route = self.click_delayed_toc_row()
        self.page.locator('#history-close').click()
        self.page.locator('#viewport').focus()

        self.release_delayed_toc_row(route)
        self.assertFalse(self.panel_open())
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'viewport')

    def test_rapid_chapter_switching_is_last_request_wins_and_keeps_panel(self):
        held=[]
        def install_delay():
            def delay(route):
                path=unquote(route.request.url)
                if 'chapter-0006.xhtml' in path: held.append(route)
                elif 'chapter-manifest' in path: route.fulfill(json=chapter_manifest(12))
                else:
                    index=int(re.search(r'chapter-(\d+)\.xhtml',path).group(1))
                    route.fulfill(content_type='text/html',body=chapter_body(index))
            self.page.route('**/api/reader-bucket-resource**',delay)
        self.open_chapters(12,before_open=install_delay)
        self.click_entry(4)
        self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.page.locator('.reader-chapter-next').click()
        self.assertTrue(held,'target chapter request was not delayed')
        self.page.locator('.reader-chapter-prev').click()
        self.page.wait_for_function('()=>__toc.nav().currentChapterIndex===3')
        for route in held:
            try: route.fulfill(content_type='text/html',body=chapter_body(6))
            except Exception: pass
        self.page.wait_for_timeout(300)
        self.assertEqual(self.page.evaluate('__toc.nav().currentChapterIndex'),3)
        self.assertTrue(self.panel_open())
        self.assertEqual(self.landed_chapter(),4)

    def test_virtualized_directory_tracks_current_chapter_without_jumping_scroll(self):
        self.open_chapters(1100, min_rows=4)
        self.page.wait_for_function('()=>!!__toc.state()')
        self.page.evaluate('''()=>{if(document.querySelector('#history').getAttribute('aria-expanded')!=='true')
          document.querySelector('#history').click();const s=__toc.state();s.panelView.scrollTop=700*40;
          s.panelView.dispatchEvent(new Event('scroll'));}''')
        self.page.wait_for_function('()=>!!document.querySelector(\'#toc-list [data-toc-index="700"]\')')
        self.page.locator('#toc-list [data-toc-index="700"] .panel-item-main').click()
        self.page.wait_for_function('()=>__toc.nav().currentChapterIndex===700')
        self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        before=self.page.locator('#toc-panel').evaluate('n=>n.scrollTop')
        self.page.locator('.reader-chapter-next').click()
        self.page.wait_for_function('()=>__toc.nav().currentChapterIndex===701')
        self.assertTrue(self.panel_open())
        self.assertEqual(self.page.locator('#toc-list .is-current').get_attribute('data-toc-index'),'701')
        self.assertAlmostEqual(self.page.locator('#toc-panel').evaluate('n=>n.scrollTop'),before,delta=1)

    # ---- sidebar jump accuracy ----

    def test_sidebar_click_lands_early_middle_and_late_entries(self):
        self.open_chapters(300)
        for chapter in (5, 150, 290):
            self.click_entry(chapter - 1)
            self.assertEqual(self.landed_chapter(), chapter, f"第{chapter}章 did not land")
            self.assertLess(abs(self.offset_of(f'.reader-epub-chapter[data-chapter="{chapter}"]') or 99), 2,
                            f"第{chapter}章 is not at the landing line")

    def test_sidebar_click_lands_fragment_inside_large_chapter(self):
        self.open_chapters(60, fragments=True)
        # Index 60..119 are the "第N章 第二节" sub-entries.
        for chapter in (2, 30, 58):
            self.click_entry(60 + chapter - 1)
            offset = self.offset_of(f'#sec-{chapter}-b')
            self.assertIsNotNone(offset, f"第{chapter}章 第二节 fragment is missing")
            self.assertLess(abs(offset), 2, f"第{chapter}章 第二节 fragment did not land")
            self.assertEqual(self.landed_chapter(), chapter)

    def test_large_chapter_yields_and_aborted_reader_never_mounts_partial_article(self):
        self.expose()
        body = '<html><body><h1 id="start">正文</h1>' + ''.join(
            f'<p><a href="#start">第{i}段</a> 正文</p>' for i in range(2500)) + '</body></html>'
        manifest = {'version':1,'kind':'epub-chapters',
            'chapters':[{'index':1,'path':'chapters/chapter-0001.xhtml','bytes':len(body.encode())}],
            'toc':[{'title':'正文','chapter':1,'fragment':'start','depth':0}]}
        self.page.add_init_script('''(()=>{window.__resourceSteps=0;window.__disposedAt=0;
          const original=Document.prototype.querySelectorAll;
          Document.prototype.querySelectorAll=function(selector){
            const result=original.call(this,selector);
            if(selector==='*' && result.length>2500 && !this.defaultView){
              for(const element of result){const has=element.hasAttribute.bind(element);
                element.hasAttribute=function(name){
                  if(name==='src' && ++window.__resourceSteps===300){
                    const until=performance.now()+20;while(performance.now()<until){}
                    setTimeout(()=>{window.__disposedAt=window.__resourceSteps;
                      dispatchEvent(new Event('voice-reader-dispose'));},0);
                  }
                  return has(name);
                };
              }
            }
            return result;
          }})()''')
        self.page.route('**/api/reader-bucket-resource**', lambda route: route.fulfill(
            json=manifest) if 'chapter-manifest' in route.request.url else route.fulfill(
            content_type='text/html',body=body))
        source=('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                + 'a'*64 + '/1234567890abcdef/chapter-manifest.json')
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' +
                       urlencode(dict(url=source, ext='epub-chapters')),wait_until='domcontentloaded')
        self.page.wait_for_function('()=>window.__disposedAt>0')
        self.page.wait_for_timeout(100)
        result=self.page.evaluate('''()=>({steps:__resourceSteps,disposed:__disposedAt,
          articles:document.querySelectorAll('.reader-epub-chapter').length})''')
        self.assertLess(result['disposed'],5000,result)
        self.assertEqual(result['articles'],0,result)

    def test_sanitized_chapter_import_preserves_text_links_and_blocks_scripts(self):
        self.expose()
        body = ('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>chapter head</title></head>'
                '<body id="book-body"><h1 id="start">正文</h1><p onclick="window.__unsafe=1">'
                '跨节点 <em>needle</em><a href="#start">返回</a>'
                '<script>window.__unsafe=2</script></p></body></html>')
        manifest = {'version':1,'kind':'epub-chapters',
            'chapters':[{'index':1,'path':'chapters/chapter-0001.xhtml','bytes':len(body.encode())}],
            'toc':[{'title':'正文','chapter':1,'fragment':'start','depth':0}]}
        self.page.route('**/api/reader-bucket-resource**', lambda route: route.fulfill(
            json=manifest) if 'chapter-manifest' in route.request.url else route.fulfill(
            content_type='text/html',body=body))
        source=('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                + 'a'*64 + '/1234567890abcdef/chapter-manifest.json')
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' +
                       urlencode(dict(url=source, ext='epub-chapters')),wait_until='domcontentloaded')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        result=self.page.evaluate('''()=>{const article=document.querySelector('.reader-epub-chapter');
          return {id:article.id,text:article.textContent,href:article.querySelector('a').getAttribute('href'),
            onclick:article.querySelector('p').hasAttribute('onclick'),script:!!article.querySelector('script'),
            unsafe:window.__unsafe||0,head:article._chapterSearchHead?.textContent};}''')
        self.assertEqual(result['id'],'book-body')
        self.assertIn('跨节点 needle返回',result['text'])
        self.assertEqual(result['href'],'#start')
        self.assertFalse(result['onclick'])
        self.assertFalse(result['script'])
        self.assertEqual(result['unsafe'],0)
        self.assertIn('chapter head',result['head'])

    def test_merged_chm_missing_toc_anchors_use_unique_in_book_links(self):
        self.expose()
        body = (f'<main><section id="chm-page-1"><h1>目录</h1>'
                '<a href="#chm-page-4">抗日战争胜利后的新形势和新任务[1]</a>'
                '<a href="#chm-page-5">目前党的方针及新四军的工作部署</a>'
                '<a href="#chm-page-4">有歧义的条目</a>'
                '<a href="#chm-page-5">有歧义的条目</a>'
                '<a href="#chm-page-999">不存在的目的地</a>'
                '<a href="#chm-page-6">重复锚点</a>'
                '<a href="#chm-page-4">有效与缺失冲突</a><a href="#chm-page-999">有效与缺失冲突</a></section>'
                f'<section id="chm-page-4"><h1>文章一</h1>{BODY}</section>'
                f'<section id="chm-page-5"><h1>文章二</h1>{BODY}</section>'
                '<section id="chm-page-6">甲</section><section id="chm-page-6">乙</section></main>')
        manifest = {'version':1,'kind':'epub-chapters',
            'chapters':[{'index':1,'path':'chapters/chapter-0001.xhtml','source_path':'chm-fallback.html',
                         'bytes':len(body.encode())}],
            'toc':[{'title':title,'chapter':1,'fragment':fragment,'depth':0} for title,fragment in [
                ('抗日战争胜利后的新形势和新任务[1]',''),('目前党的方针及新四军的工作部署',''),
                ('有歧义的条目',''),('不存在的目的地',''),('已有的目标','chm-page-5'),('重复锚点',''),
                ('有效与缺失冲突','')]]}
        self.page.route('**/api/reader-bucket-resource**', lambda route: route.fulfill(
            json=manifest) if 'chapter-manifest' in route.request.url else route.fulfill(
            content_type='text/html',body=body))
        source=('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/'
                + 'a'*64 + '/1234567890abcdef/chapter-manifest.json')
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' +
                       urlencode(dict(url=source, ext='epub-chapters')),wait_until='domcontentloaded')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.page.wait_for_function("()=>!!document.querySelector('#chm-page-5')")
        self.assertEqual(self.page.evaluate('()=>__toc.nav().tocEntries.map(x=>x.fragment)'),
                         ['chm-page-4','chm-page-5','','','chm-page-5','',''])
        for index, target in ((0,'chm-page-4'),(1,'chm-page-5')):
            self.click_entry(index)
            offset=self.offset_of('#'+target)
            self.assertIsNotNone(offset)
            self.assertLess(abs(offset),2,f'{target} did not land')
        self.assertFalse(self.errors)

    def test_chapter_scroll_geometry_census_with_shared_toc_targets(self):
        self.expose()

        def expose_window(route):
            response = route.fetch()
            script = response.text()
            needle = '    function scheduleChapterWindow() {'
            self.assertIn(needle, script)
            route.fulfill(response=response, body=script.replace(needle,
                '    window.__refreshChapterWindow = refreshChapterWindow;\n' + needle, 1))

        self.page.route('**/static/reader/formats/reader-chapter-format.mjs*', expose_window)
        prose = '<p>A line in the converted chapter.</p>' * 120
        body = ('<p id="lead" style="height:120px"><a href="#chm-page-1">First page</a> '
                '<a href="#chm-page-2">Second page</a></p>'
                f'<section id="chm-page-1"><h1>One</h1>{prose}</section>'
                f'<section id="chm-page-2"><h1>Two</h1>{prose}</section>')
        # A merged CHM can have many entries with no recoverable fragment. Each
        # still participates in tie-breaking even though they share the article.
        entries = [(f'Unresolved entry {i}', '') for i in range(120)] + [
            ('First page', ''), ('Second page', ''), ('Second page alias', 'chm-page-2'), ('Missing', 'missing')]
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': 1, 'path': 'chapters/chapter-0001.xhtml', 'source_path': 'chm-fallback.html', 'bytes': len(body)}
        ], 'toc': [{'title': label, 'chapter': 1, 'fragment': fragment, 'depth': 0} for label, fragment in entries]}
        self.page.route('**/api/reader-bucket-resource**', lambda route: route.fulfill(json=manifest)
                        if 'chapter-manifest' in route.request.url else route.fulfill(content_type='text/html', body=body))
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/'
                  + 'a' * 64 + '/1234567890abcdef/chapter-manifest.json')
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' +
                       urlencode(dict(url=source, ext='epub-chapters')), wait_until='domcontentloaded')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        result = self.page.evaluate('''() => {
          const viewport = document.querySelector('#viewport');
          const article = viewport.querySelector('.reader-epub-chapter');
          const second = article.querySelector('#chm-page-2');
          const placeholder = document.createElement('button');
          placeholder.className = 'reader-chapter-sentinel reader-chapter-placeholder';
          placeholder.dataset.chapter = '0';
          placeholder.style.height = '120px';
          article.before(placeholder);
          viewport.scrollTop += second.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 4;
          const entries = __toc.nav().tocEntries;
          const connected = entries.map(entry => entry.target).filter(target => target?.isConnected);
          const rect = Element.prototype.getBoundingClientRect;
          const census = run => {
            const nodes = new Set();
            let calls = 0;
            Element.prototype.getBoundingClientRect = function () {
              nodes.add(this);
              calls++;
              return rect.call(this);
            };
            try { run(); } finally { Element.prototype.getBoundingClientRect = rect; }
            return [nodes.size, calls];
          };
          const current = () => [__toc.nav().currentChapterIndex,
            Number(document.querySelector('#toc-list .is-current')?.dataset.tocIndex)];
          // Sample the real synchronous scroll listener and the two independently
          // scheduled passes in isolation, before any queued frame can run.
          const remember = census(() => viewport.dispatchEvent(new Event('scroll')));
          const windowRows = census(__refreshChapterWindow);
          const toc = census(__toc.sync);
          const before = current();
          const scroll = viewport.scrollTop;
          article.querySelector('#lead').style.height = '240px';
          viewport.scrollTop = scroll;
          const lateToc = census(__toc.sync);
          return {entries: [entries.length, connected.length, new Set(connected).size],
            remember, windowRows, toc, lateToc, before, after: current()};
        }''')
        # Counts are [unique measured nodes, rectangle reads]. The unmodified
        # reader reported [4, 124] for each TOC pass in both builds. Remember
        # (244 candidates + viewport) and window rows are unchanged.
        self.assertEqual(result, dict(entries=[124, 123, 3], remember=[245, 245], windowRows=[3, 3],
                                      toc=[4, 4], lateToc=[4, 4], before=[122, 122], after=[120, 120]))

    def test_chapter_target_updates_only_visit_the_owned_toc_once(self):
        self.expose()
        # Drive demand loads and the real virtualizer explicitly, without ambient prefetch.
        self.page.add_init_script("Object.defineProperty(document, 'hidden', {value:true})")

        def instrument(route):
            response = route.fetch()
            script = response.text()
            for needle, code in [
                ('function isChapterTocEntry(entry) {', 'window.__tocChecks = (window.__tocChecks || 0) + 1;'),
                ('function scheduleChapterWindow() {', 'return;'),
                ('    setChapterToc();', 'window.__chapterTargets = {load: chapterManifestLoader, trim: chapterVirtualizer.trim};'),
            ]:
                self.assertIn(needle, script)
                script = script.replace(needle, needle + '\n' + code, 1)
            route.fulfill(response=response, body=script)

        self.page.route('**/static/reader/formats/reader-chapter-format.mjs*', instrument)
        manifest = chapter_manifest(300, fragments=True)
        manifest['chapters'][12]['source_path'] = 'chm-fallback.html'
        manifest['toc'].reverse()  # Two disjoint runs of chapters in reverse order.
        manifest['toc'] += [dict(title=label, chapter=13, depth=1, fragment='') for label in
                            ('Exact link', 'Ambiguous', 'Inexact', 'Duplicate anchor', 'Missing anchor')]
        links = ('<a href="#chm-page-1"> Exact  link </a>'
                 '<a href="#chm-page-1">Ambiguous</a><a href="#chm-page-2">Ambiguous</a>'
                 '<a href="#chm-page-2">Inexact suffix</a><a href="#chm-page-3">Duplicate anchor</a>'
                 '<a href="#chm-page-4">Missing anchor</a>'
                 '<p id="chm-page-1"></p><p id="chm-page-2"></p>'
                 '<p id="chm-page-3"></p><p id="chm-page-3"></p>')

        def resource(route):
            url = unquote(route.request.url)
            if 'chapter-manifest' in url:
                route.fulfill(json=manifest)
            else:
                index = int(re.search(r'chapter-(\d+)\.xhtml', url).group(1))
                route.fulfill(content_type='text/html', body=chapter_body(index) + (links if index == 13 else ''))

        self.page.route('**/api/reader-bucket-resource**', resource)
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/'
                  + 'a'*64 + '/1234567890abcdef/chapter-manifest.json')
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' +
                       urlencode(dict(url=source, ext='epub-chapters')), wait_until='domcontentloaded')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        result = self.page.evaluate('''async () => {
          const {load, trim} = __chapterTargets, all = __toc.nav().tocEntries;
          const rows = all.filter(entry => entry.chapterIndex === 13);
          const first = all.find(entry => entry.chapterIndex === 1), firstTarget = first.target;
          const snapshot = entries => entries.map(entry => [entry.fragment,
            entry.target === null ? null : entry.target?.id || entry.target?.dataset.chapter || 'unset']);
          const checks = [__tocChecks];
          for (let i = 2; i < 13; i++) await load(i);
          checks.push(__tocChecks - checks[0]);
          let before = __tocChecks;
          await load(13);
          checks.push(__tocChecks - before);
          const mounted = snapshot(rows), oldTarget = rows[0].target;
          before = __tocChecks;
          const removed = trim(1).removed;
          checks.push(__tocChecks - before);
          const cleared = rows.every(entry => entry.target === null) && !oldTarget.isConnected;
          before = __tocChecks;
          await load(13);
          checks.push(__tocChecks - before);
          const rebound = rows[0].target?.isConnected && rows[0].target !== oldTarget;
          trim(1);
          __toc.set([{...rows[0]}, {...first}, {...rows[2], fragment:''}]);
          const replaced = __toc.nav().tocEntries;
          before = __tocChecks;
          await load(13);
          checks.push(__tocChecks - before);
          const replacement = snapshot(replaced);
          before = __tocChecks;
          trim(1);
          checks.push(__tocChecks - before);
          return {checks, mounted, removed, cleared, rebound, replacement,
            replacementCleared: replaced[0].target === null && replaced[2].target === null,
            untouched: first.target === firstTarget && replaced[1].target === firstTarget};
        }''')
        self.assertEqual(result['mounted'], [['sec-13-b', 'sec-13-b'], ['', '13'],
                         ['chm-page-1', 'chm-page-1']] + [['', '13']] * 4)
        self.assertEqual(result['removed'], 1)
        self.assertTrue(all(result[key] for key in ('cleared', 'rebound', 'replacementCleared', 'untouched')), result)
        self.assertEqual(result['replacement'], [['sec-13-b', 'sec-13-b'], ['sec-1-b', 'sec-1-b'],
                                                 ['chm-page-1', 'chm-page-1']])
        self.assertEqual(result['checks'], [len(manifest['toc']), 0, 0, 0, 0, 3, 3])

    def test_rejump_after_target_chapter_was_trimmed(self):
        self.open_chapters(300)
        self.click_entry(49)
        self.assertEqual(self.landed_chapter(), 50)
        self.click_entry(280 - 1)
        self.assertEqual(self.landed_chapter(), 280)
        self.click_entry(49)
        self.assertEqual(self.landed_chapter(), 50, "a trimmed chapter must reload for a re-jump")

    def test_rapid_successive_clicks_land_on_the_last_entry(self):
        # Below the virtualization threshold so every row is clickable without scrolling.
        self.open_chapters(400)
        for index in (249, 379, 119):
            self.page.evaluate("""(index) => {
                const toggle = document.querySelector('#history');
                if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
                document.querySelector(`#toc-list .toc-item[data-toc-index="${index}"] .panel-item-main`).click();
            }""", index)
            self.page.wait_for_timeout(120)
        self.page.wait_for_timeout(3000)
        self.assertEqual(self.landed_chapter(), 120, "the last clicked entry must win")
        self.assertEqual(self.page.evaluate("()=>__toc.nav().currentChapterIndex"), 119)

    def test_virtualized_directory_click_lands_late_entries(self):
        self.open_chapters(1200)
        self.assertTrue(self.page.evaluate("()=>!!__toc.state()"), "this directory must be virtualized")
        for index in (400, 900, 1150):
            self.page.evaluate("""(index) => {
                const toggle = document.querySelector('#history');
                if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
                const state = __toc.state();
                state.panelView.scrollTop = index * 40 - state.panelView.clientHeight / 2;
                state.panelView.dispatchEvent(new Event('scroll'));
            }""", index)
            self.page.wait_for_timeout(200)
            self.click_entry(index)
            self.assertEqual(self.landed_chapter(), index + 1,
                             f"virtualized row {index} landed on the wrong entry")

    def test_virtualized_directory_accounts_for_scrolling_folder_and_search(self):
        self.page.set_viewport_size({'width':390,'height':844})
        self.open_chapters(1200)
        self.page.evaluate('''()=>{const p=document.querySelector('#reader-panel-path');
          p.querySelector('.reader-panel-folder').textContent='所在目录：Test/books';
          if(document.querySelector('#history').getAttribute('aria-expanded')!=='true')document.querySelector('#history').click();}''')
        self.assertTrue(self.page.locator('#reader-panel-location').is_visible())
        self.page.locator('#toc-panel .panel-search-toggle').click()
        for index in (30, 400, 900, 1190):
            self.page.evaluate('''index=>{const s=__toc.state(),offset=s.list.getBoundingClientRect().top-
              s.panelView.getBoundingClientRect().top+s.panelView.scrollTop;
              s.panelView.scrollTop=offset+index*40;s.panelView.dispatchEvent(new Event('scroll'));}''',index)
            self.page.wait_for_function('index=>!!document.querySelector(`#toc-list [data-toc-index="${index}"]`)',arg=index)
            metrics = self.page.locator(f'#toc-list [data-toc-index="{index}"]').evaluate('''row=>{
              const rect=row.getBoundingClientRect(), range=document.createRange();
              range.selectNodeContents(row.querySelector('.panel-item-main'));
              const text=range.getBoundingClientRect();
              return {height:rect.height, stride:row.nextElementSibling.getBoundingClientRect().top-rect.top,
                above:text.top-rect.top, below:rect.bottom-text.bottom};
            }''')
            self.assertEqual((metrics['height'],metrics['stride']),(40,40))
            self.assertAlmostEqual(metrics['above'],metrics['below'],delta=3)
            self.click_entry(index)
            self.assertEqual(self.landed_chapter(), index+1)
            if not self.panel_open(): self.page.locator('#history').click()

    def test_current_mark_only_changes_rows_that_enter_or_leave_current(self):
        self.open_chapters(12)
        metrics=self.page.evaluate('''()=>{
          const list=document.querySelector('#toc-list'), rows=[...list.children];
          __toc.setCurrent(1);
          const observer=new MutationObserver(()=>{});
          observer.observe(list,{subtree:true,attributes:true,attributeFilter:['hidden','class','aria-current']});
          __toc.setCurrent(1);
          const repeated=observer.takeRecords().length;
          __toc.setCurrent(3);
          const touched=[...new Set(observer.takeRecords().map(r=>Number(r.target.closest('.toc-item').dataset.tocIndex)))].sort();
          observer.disconnect();
          const current=[...list.querySelectorAll('[aria-current="location"]')].map(link=>Number(link.parentElement.dataset.tocIndex));
          return {repeated,touched,current,sameRows:rows.every((row,i)=>row===list.children[i])};
        }''')
        self.assertEqual(metrics,dict(repeated=0,touched=[1,3],current=[3],sameRows=True))

    def test_virtualized_directory_reuses_rows_and_keeps_keyboard_focus(self):
        self.page.emulate_media(reduced_motion='reduce')
        self.page.set_viewport_size({'width':1200,'height':800})
        self.open_chapters(2100)
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.page.evaluate('''async()=>{
          const s=__toc.state(), view=s.panelView;
          const top=s.list.getBoundingClientRect().top-view.getBoundingClientRect().top+view.scrollTop;
          view.scrollTop=top+700*40+5;
          view.dispatchEvent(new Event('scroll'));
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        }''')
        self.page.locator('#toc-list [data-toc-index="705"] [role=link]').focus()
        self.page.keyboard.press('Tab')
        self.assertEqual(self.page.evaluate('document.activeElement.closest(".toc-item").dataset.tocIndex'),'706')
        results=self.page.evaluate('''async()=>{
          const s=__toc.state(), list=s.list, view=s.panelView, base=view.scrollTop;
          const focused=document.activeElement, original=[...list.children];
          const observer=new MutationObserver(records=>mutations.push(...records));
          let mutations=[];
          observer.observe(list,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class','aria-current']});
          const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          const results=[];
          try {
            for (const offset of [1,41,1]) {
              const before=[...list.children];
              mutations=[];
              view.scrollTop=base+offset;
              view.dispatchEvent(new Event('scroll'));
              await frame();
              mutations.push(...observer.takeRecords());
              const after=[...list.children], indices=after.map(row=>Number(row.dataset.tocIndex));
              results.push({
                markerWrites:mutations.filter(r=>r.type==='attributes').length,
                added:mutations.filter(r=>r.target===list).reduce((n,r)=>n+r.addedNodes.length,0),
                removed:mutations.filter(r=>r.target===list).reduce((n,r)=>n+r.removedNodes.length,0),
                fresh:after.filter(row=>!before.includes(row)).length,
                retained:before.filter(row=>indices.includes(Number(row.dataset.tocIndex)))
                  .every(row=>after.includes(row)),
                focused:document.activeElement===focused,
                indices, tops:after.map(row=>parseFloat(row.style.top)),
                originalIndices:original.map(row=>Number(row.dataset.tocIndex))
              });
            }
          } finally { observer.disconnect(); }
          return results;
        }''')
        for result, shift, changed in zip(results,(0,1,0),(0,1,1)):
            self.assertEqual(result['markerWrites'],0,result)
            self.assertEqual(result['added'],changed)
            self.assertEqual(result['removed'],changed)
            self.assertEqual(result['fresh'],changed)
            self.assertTrue(result['retained'])
            self.assertTrue(result['focused'])
            self.assertEqual(result['indices'],[i+shift for i in result['originalIndices']])
            self.assertEqual(result['tops'],[i*40 for i in result['indices']])
        # Enter must still activate the retained, keyboard-focused link.
        self.page.keyboard.press('Enter')
        self.page.wait_for_function('()=>__toc.nav().currentChapterIndex===706')
        self.assertFalse(self.errors,self.errors)

    def test_virtualized_directory_row_cache_invalidates_labels_and_highlights(self):
        self.page.emulate_media(reduced_motion='reduce')
        self.open_chapters(2100)
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.page.locator('#toc-panel .panel-search-toggle').click()
        field=self.page.locator('#toc-panel .panel-search')
        # Both queries keep the same indices, so range/index caching alone is insufficient.
        for query in ('第','章',''):
            field.fill(query)
            rows=self.page.locator('#toc-list .toc-item').evaluate_all('''rows=>rows.map(row=>({
              index:Number(row.dataset.tocIndex),label:row.querySelector('.panel-item-main').textContent,
              marks:[...row.querySelectorAll('mark.search-match')].map(mark=>mark.textContent)
            }))''')
            self.assertGreater(len(rows),1)
            for row in rows:
                self.assertEqual(row['label'],f"第{row['index']+1}章")
                self.assertEqual(row['marks'],[query] if query else [])
        # Replace entries on the same state, keeping query and indices unchanged.
        field.fill('第')
        replacement=self.page.evaluate('''()=>{
          const s=__toc.state(), old=listRows();
          function listRows(){return [...s.list.children]}
          s.entries=s.entries.map(entry=>({...entry,label:entry.label+' 新标签'}));
          s.render();
          return {fresh:listRows().every(row=>!old.includes(row)),
            labels:listRows().map(row=>row.querySelector('.panel-item-main').textContent),
            marks:listRows().map(row=>[...row.querySelectorAll('mark.search-match')].map(m=>m.textContent))};
        }''')
        self.assertTrue(replacement['fresh'])
        self.assertTrue(all(label.endswith(' 新标签') for label in replacement['labels']))
        self.assertTrue(all(marks==['第'] for marks in replacement['marks']))
        # setToc replaces the state/list; the new directory must not reuse old rows.
        replaced=self.page.evaluate('''()=>{
          const old=__toc.state();
          __toc.set(old.entries.map(entry=>({...entry,label:entry.label.replace('新标签','替换目录')})));
          return old!==__toc.state();
        }''')
        self.assertTrue(replaced)
        labels=self.page.locator('#toc-list .panel-item-main').all_text_contents()
        self.assertGreater(len(labels),1)
        self.assertTrue(all(label.endswith(' 替换目录') for label in labels))
        self.assertEqual(self.page.locator('#toc-list mark.search-match').all_text_contents(),['第']*len(labels))
        field.fill('')
        rows=self.page.locator('#toc-list .panel-item-main').all_text_contents()
        self.assertGreater(len(rows),1)
        self.assertTrue(all(label.endswith(' 替换目录') for label in rows))
        self.assertEqual(self.page.locator('#toc-list mark.search-match').count(),0)
        self.assertFalse(self.errors,self.errors)

    def test_virtualized_directory_searches_all_entries_and_clears(self):
        self.open_chapters(2100)
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.page.locator('#toc-panel .panel-search-toggle').click()
        field=self.page.locator('#toc-panel .panel-search')
        field.fill('第2099章')
        self.page.wait_for_function("()=>document.querySelector('#toc-list [data-toc-index=\"2098\"]')")
        self.assertEqual(self.page.locator('#toc-list .toc-item').count(),1)
        self.assertEqual(self.page.locator('#toc-list mark.search-match').inner_text(),'第2099章')
        self.assertLess(self.page.locator('#toc-panel').evaluate('n=>n.scrollHeight'),1500)
        self.page.locator('#toc-panel').evaluate('n=>n.scrollTop=n.scrollHeight')
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.locator('#toc-list .toc-item').count(),1)
        self.click_entry(2098)
        self.assertEqual(self.landed_chapter(),2099)
        if not self.panel_open(): self.page.locator('#history').click()
        self.assertEqual(field.input_value(),'第2099章')
        field.fill('不存在QXYZ')
        self.assertTrue(self.page.get_by_role('status').filter(has_text='没有匹配的内容').is_visible())
        self.assertEqual(self.page.locator('#toc-list .toc-item').count(),0)
        field.fill('第20')
        self.assertGreater(self.page.locator('#toc-list .toc-item').count(),1)
        self.assertTrue(all('第20' in text for text in self.page.locator('#toc-list .toc-item').all_text_contents()))
        self.page.locator('#toc-panel .panel-search-toggle').click()
        self.assertEqual(field.input_value(),'')
        self.assertTrue(self.page.get_by_role('status').filter(has_text='没有匹配的内容').is_hidden())
        self.page.wait_for_function("()=>document.querySelector('#toc-list [data-toc-index=\"0\"]')")
        self.page.locator('#toc-panel .panel-search-toggle').click()
        field.fill('第2099章')
        self.page.locator('#toc-list [role=link]').press('Enter')
        self.page.wait_for_function("()=>__toc.nav().currentChapterIndex===2098")
        self.assertEqual(field.input_value(),'第2099章')

    def test_empty_directory_filter_restores_rows_without_building_searchable_text(self):
        self.open_chapters(150)
        result=self.page.evaluate('''()=>{
          const panel=document.querySelector('#toc-panel'), input=panel.querySelector('.panel-search');
          const rows=[...panel.querySelectorAll('.toc-item')];
          input.hidden=false;input.value='not found';__toc.filter();
          const allHidden=rows.every(row=>row.hidden);
          let reads=0;
          const text=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
          for(const row of rows)Object.defineProperty(row.querySelector('.panel-item-main'),'textContent',{
            configurable:true,get(){reads++;return text.get.call(this)},set(value){text.set.call(this,value)}
          });
          input.value='';__toc.filter();
          return {reads,allHidden,nowVisible:rows.every(row=>!row.hidden),
            statusHidden:panel.querySelector('.panel-filter-empty').hidden};
        }''')
        self.assertEqual(result,dict(reads=0,allHidden=True,nowVisible=True,statusHidden=True))

    def test_small_directory_search_shows_empty_state_and_resets(self):
        self.open_chapters(12)
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.page.locator('#toc-panel .panel-search-toggle').click()
        field=self.page.locator('#toc-panel .panel-search')
        field.fill('没有这个章节')
        self.assertTrue(self.page.get_by_role('status').filter(has_text='没有匹配的内容').is_visible())
        field.fill('第2章')
        self.assertEqual(self.page.locator('#toc-list .toc-item:visible').count(),1)
        self.assertTrue(self.page.get_by_role('status').filter(has_text='没有匹配的内容').is_hidden())
        self.page.locator('#toc-panel .panel-search-toggle').click()
        self.assertEqual(self.page.locator('#toc-list .toc-item:visible').count(),12)

    def test_multiple_virtual_results_remain_after_successful_chapter_jump(self):
        self.open_chapters(2100)
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.page.locator('#toc-panel .panel-search-toggle').click()
        field=self.page.locator('#toc-panel .panel-search')
        field.fill('第20')
        first=self.page.locator('#toc-list .toc-item[data-toc-index="19"] [role=link]')
        self.assertTrue(first.is_visible())
        first.click()
        self.page.wait_for_function("()=>__toc.nav().currentChapterIndex===19")
        self.assertEqual(self.landed_chapter(),20)
        self.assertFalse(self.panel_open())
        self.page.locator('#history').click()
        self.assertEqual(field.input_value(),'第20')
        self.assertGreater(self.page.locator('#toc-list .toc-item').count(),1)
        self.assertTrue(all('第20' in text for text in self.page.locator('#toc-list .toc-item').all_text_contents()))

    def test_virtualized_directory_search_handles_groups_replacements_and_repeated_matches(self):
        self.open_chapters(2100)
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.page.locator('#toc-panel .panel-search-toggle').click()
        field=self.page.locator('#toc-panel .panel-search')
        field.fill('第20')
        expected=self.page.evaluate("()=>__toc.nav().tocEntries.filter(x=>x.label.includes('第20')).length")
        actual=[]
        for step in range(10):
            self.page.locator('#toc-panel').evaluate('(n,step)=>n.scrollTop=step*500',step)
            self.page.wait_for_timeout(40)
            actual.extend(int(x) for x in self.page.locator('#toc-list .toc-item:visible').evaluate_all('rows=>rows.map(r=>r.dataset.tocIndex)'))
        self.assertEqual(len(set(actual)),expected)
        self.assertEqual(len(set(actual)),111)
        # A grouped heading has no navigation target, but remains searchable.
        self.page.evaluate('''()=>{const entries=__toc.nav().tocEntries.slice();entries[2100-1]={label:'特殊分组',group:true,depth:0};__replaceTocForSearch(entries)}''')
        field.fill('特殊分组')
        self.assertEqual(self.page.locator('#toc-list [role=heading]').inner_text(),'特殊分组')
        field.fill('不存在')
        self.assertTrue(self.page.locator('#toc-panel .panel-filter-empty').is_visible())
        self.page.evaluate("()=>__replaceTocForSearch([{label:'不存在但新到达',activate:()=>true}])")
        self.assertTrue(self.page.locator('#toc-list .toc-item').is_visible())
        self.assertTrue(self.page.locator('#toc-panel .panel-filter-empty').is_hidden())
        self.assertFalse(self.page.locator('#toc-list').evaluate("n=>n.classList.contains('toc-list-virtualized')"))
        self.assertLess(self.page.locator('#toc-panel').evaluate('n=>n.scrollHeight'),1500)

    def test_composition_end_with_unchanged_query_keeps_directory_scroll(self):
        self.page.emulate_media(reduced_motion='reduce')
        self.open_chapters(2100)
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
        self.page.locator('#toc-panel .panel-search-toggle').click()
        field=self.page.locator('#toc-panel .panel-search')
        field.fill('第20')
        panel=self.page.locator('#toc-panel')
        panel.evaluate('n=>n.scrollTop=1600')
        self.page.wait_for_timeout(100)
        before=panel.evaluate('n=>n.scrollTop')
        field.dispatch_event('compositionend')
        self.assertAlmostEqual(panel.evaluate('n=>n.scrollTop'),before,delta=5)
        self.assertGreater(self.page.locator('#toc-list mark.search-match').count(),0)

    def test_empty_filtered_toc_refresh_removes_stale_empty_message(self):
        self.open_chapters(12)
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-panel .panel-search-toggle').click()
        field=self.page.locator('#toc-panel .panel-search')
        field.fill('missing')
        self.assertTrue(self.page.locator('#toc-panel .panel-filter-empty').is_visible())
        field.fill('')
        self.page.evaluate("()=>__replaceTocForSearch([{label:'new directory',activate:()=>true}])")
        self.assertTrue(self.page.locator('#toc-panel .panel-filter-empty').is_hidden())
        self.assertTrue(self.page.locator('#toc-list .toc-item').is_visible())

    def test_virtual_toc_search_keyboard_only_navigation(self):
        self.page.set_viewport_size({'width':1200,'height':800})
        self.open_chapters(2100)
        if self.panel_open(): self.page.locator('#history-close').click()
        self.page.locator('#history').press('Enter')
        self.page.get_by_role('button',name='搜索目录',exact=True).press('Enter')
        field=self.page.locator('#toc-panel .panel-search')
        field.fill('第2099章')
        link=self.page.locator('#toc-list [data-toc-index="2098"] [role=link]')
        link.focus()
        self.assertTrue(link.evaluate('n=>n===document.activeElement'))
        self.page.keyboard.press('Enter')
        self.page.wait_for_function("()=>__toc.nav().currentChapterIndex===2098")
        self.page.wait_for_function("()=>document.querySelector('#history').getAttribute('aria-expanded')==='false'")
        self.assertEqual(self.page.evaluate('document.activeElement.id'),'history')
        self.page.locator('#history').press('Enter')
        self.assertEqual(field.input_value(),'第2099章')
        self.assertEqual(self.page.locator('#toc-list .toc-item').count(),1)

    def test_hidden_stale_search_does_not_filter_late_directory(self):
        self.open_chapters(12)
        self.page.evaluate('''()=>{const input=document.querySelector('#toc-panel .panel-search');
          input.hidden=true;input.value='old query';
          __replaceTocForSearch([{label:'new directory',activate:()=>true}]);}''')
        self.assertEqual(self.page.locator('#toc-list .toc-item').count(),1)
        self.assertFalse(self.page.locator('#toc-list .toc-item').evaluate('n=>n.hidden'))
        self.assertTrue(self.page.locator('#toc-panel .panel-filter-empty').is_hidden())

    def test_virtual_search_renders_results_when_list_starts_at_viewport_bottom(self):
        self.open_chapters(2100)
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-panel .panel-search-toggle').click()
        field=self.page.locator('#toc-panel .panel-search')
        field.fill('第20')
        panel=self.page.locator('#toc-panel')
        # Construct the boundary from the actual viewport: toolbar and folder
        # heights differ between mobile/desktop and with accessibility scaling.
        self.page.evaluate('''()=>{const list=document.querySelector('#toc-list'),view=document.querySelector('#toc-panel');
          const spacer=document.createElement('div');spacer.id='toc-test-spacer';spacer.style.height='0px';list.before(spacer);
          const top=list.getBoundingClientRect().top-view.getBoundingClientRect().top+view.scrollTop;
          spacer.style.height=Math.max(0,view.clientHeight-top+50)+'px';}''')
        panel.evaluate('n=>{n.scrollTop=0;n.dispatchEvent(new Event("scroll"))}')
        self.page.wait_for_timeout(100)
        start=self.page.evaluate('''()=>{const v=document.querySelector('#toc-panel').getBoundingClientRect(),
          list=document.querySelector('#toc-list').getBoundingClientRect();return list.top-v.bottom}''')
        self.assertGreater(start,0, 'the list must start below the visible viewport')
        panel.evaluate('n=>{n.scrollTop=100;n.dispatchEvent(new Event("scroll"))}')
        self.page.wait_for_timeout(100)
        metrics=self.page.evaluate('''()=>{const view=document.querySelector('#toc-panel').getBoundingClientRect(),
          list=document.querySelector('#toc-list').getBoundingClientRect(),last=document.querySelector('#toc-list .toc-item:last-child').getBoundingClientRect();
          return {viewBottom:view.bottom,listTop:list.top,lastBottom:last.bottom}}''')
        self.assertLess(metrics['listTop'],metrics['viewBottom'])
        self.assertGreater(metrics['listTop'],metrics['viewBottom']-100)
        self.assertGreaterEqual(metrics['lastBottom'],metrics['viewBottom']-1)

    def test_virtual_search_covers_bottom_after_fractional_scroll(self):
        self.open_chapters(2100)
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-panel .panel-search-toggle').click()
        self.page.locator('#toc-panel .panel-search').fill('第20')
        panel=self.page.locator('#toc-panel')
        panel.evaluate('n=>{n.scrollTop=801;n.dispatchEvent(new Event("scroll"))}')
        self.page.wait_for_timeout(100)
        metrics=self.page.evaluate('''()=>{const s=__toc.state(),n=s.panelView,top=s.list.getBoundingClientRect().top-
          n.getBoundingClientRect().top+n.scrollTop, first=Math.max(0,n.scrollTop-top),
          bottom=first+n.clientHeight;const last=s.list.querySelector('.toc-item:last-child');
          return {bottom,lastEnd:parseFloat(last.style.top)+40};}''')
        self.assertGreaterEqual(metrics['lastEnd'],metrics['bottom'])

    def test_virtual_directory_filter_keeps_rendering_bounded_for_large_books(self):
        self.open_chapters(2100)
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-panel .panel-search-toggle').click()
        field=self.page.locator('#toc-panel .panel-search')
        values=self.page.evaluate('''()=>{const entries=__toc.nav().tocEntries;
          const large=Array.from({length:20000},(_,i)=>({label:'Entry '+String(i).padStart(5,'0'),activate:()=>true}));
          const started=performance.now();__replaceTocForSearch(large);return {ms:performance.now()-started};}''')
        field.fill('Entry 1')
        self.assertEqual(self.page.evaluate('()=>__toc.state().matches.length'),10000)
        for position in (0,50000,200000,399000):
            self.page.locator('#toc-panel').evaluate('(n,y)=>{n.scrollTop=y;n.dispatchEvent(new Event("scroll"))}',position)
            self.page.wait_for_timeout(40)
            self.assertLess(self.page.locator('#toc-list .toc-item').count(),100)
            self.assertTrue(all('Entry 1' in x for x in self.page.locator('#toc-list .toc-item').all_text_contents()))
        self.assertLess(values['ms'],3000)

    # ---- landing re-assertion ----

    def test_landing_holds_while_chapters_above_keep_growing(self):
        """A large book keeps inserting/flattening chapters above the destination after the
        jump. The browser's own scroll anchoring does not cover these inserts, so the landing
        must be re-aligned while the document grows."""
        self.open_chapters(120)
        self.click_entry(99)
        frames = self.page.evaluate("""async () => {
            const target = document.querySelector('.reader-epub-chapter[data-chapter="100"]');
            const viewport = document.querySelector('#viewport');
            // Scroll anchoring would hide the drift this test is about.
            viewport.style.overflowAnchor = 'none';
            const frame = document.querySelector('.epub-frame');
            frame.style.overflowAnchor = 'none';
            const offsets = [];
            for (let step = 0; step < 6; step += 1) {
                const spacer = document.createElement('div');
                spacer.style.height = '400px';
                frame.insertBefore(spacer, target);
                // Two frames give the hold loop its chance to re-align.
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                offsets.push(Math.round((target.getBoundingClientRect().top -
                    viewport.getBoundingClientRect().top) * 10) / 10);
            }
            return offsets;
        }""")
        self.assertTrue(all(abs(value) < 2 for value in frames),
                        f"landing drifted while content above grew: {frames}")

    def test_landing_releases_on_reader_scroll(self):
        self.open_chapters(60)
        self.click_entry(29)
        result = self.page.evaluate("""async () => {
            const viewport = document.querySelector('#viewport');
            const before = viewport.scrollTop;
            viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true }));
            viewport.scrollTop = before + 1500;
            await new Promise(resolve => setTimeout(resolve, 400));
            return {before, after: viewport.scrollTop};
        }""")
        self.assertGreaterEqual(result["after"] - result["before"], 1400,
                                "a reader scroll must not be pulled back by the hold")

    def test_new_navigation_supersedes_the_previous_landing_hold(self):
        held = []
        delayed_chapter = '**/api/reader-bucket-resource?path=*chapter-0012.xhtml'

        def delay_chapter():
            self.page.route(delayed_chapter, lambda route: held.append(route))

        self.open_chapters(12, fragments=True, before_open=delay_chapter)

        def wait_for_landing(index, selector):
            self.page.wait_for_function('''([index, selector]) => {
                const target = document.querySelector(selector);
                const viewport = document.querySelector('#viewport');
                return __toc.hasHold() && __toc.nav().currentChapterIndex === index && target &&
                    Math.abs(target.getBoundingClientRect().top - viewport.getBoundingClientRect().top) < 2;
            }''', arg=[index, selector])

        old_target = '.reader-epub-chapter[data-chapter="4"]'
        self.page.locator('#toc-list [data-toc-index="3"] .panel-item-main').dispatch_event('click')
        wait_for_landing(3, old_target)

        # Use the sidebar handler without sending input to the reading viewport:
        # viewport input would release the hold independently of navigation.
        new_index, new_target = 23, '#sec-12-b'
        with self.page.expect_request(delayed_chapter):
            holds = self.page.locator(f'#toc-list [data-toc-index="{new_index}"] .panel-item-main').evaluate('''row => {
                const before = __toc.hasHold();
                row.click();
                return [before, __toc.hasHold()];
            }''')
        self.assertEqual(holds, [True, False], 'the old hold must release before the new chapter arrives')
        self.assertIsNone(self.offset_of(new_target), 'the new chapter should still be loading')
        self.assertEqual(len(held), 1)
        held[0].fulfill(content_type='text/html', body=chapter_body(12))
        wait_for_landing(new_index, new_target)

        # Keep the old destination mounted, so detaching it cannot hide a stale hold.
        frames = self.page.locator(new_target).evaluate('''async target => {
            const viewport = document.querySelector('#viewport');
            const offsets = [];
            for (let frame = 0; frame < 6; frame++) {
                await new Promise(resolve => requestAnimationFrame(resolve));
                offsets.push(target.getBoundingClientRect().top - viewport.getBoundingClientRect().top);
            }
            return offsets;
        }''')
        previous_offset = self.offset_of(old_target)
        self.assertIsNotNone(previous_offset, 'the previous destination must remain mounted')
        self.assertLess(previous_offset, -100, 'the new landing must be distinct from the previous one')
        self.assertTrue(all(abs(offset) < 2 for offset in frames), f'the previous hold pulled back: {frames}')
        self.assertEqual(self.page.evaluate('()=>__toc.nav().currentChapterIndex'), new_index)

    def test_landing_hold_is_cancelled_on_disposal(self):
        self.open_chapters(40)
        self.page.evaluate("index => __toc.jump(index)", 19)
        self.page.wait_for_function("()=>__toc.hasHold()")
        self.page.evaluate("dispatchEvent(new Event('voice-reader-dispose'))")
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='disposed'")
        self.assertFalse(self.page.evaluate("()=>__toc.hasHold()"))

    def test_landing_is_reasserted_after_a_late_layout_shift(self):
        self.open_chapters(40)
        self.click_entry(19)
        result = self.page.evaluate("""() => {
            const anchor = document.querySelector('#chapter-20');
            const landing = __toc.align('#chapter-20');
            const spacer = document.createElement('p');
            spacer.style.height = '600px';
            anchor.parentElement.insertBefore(spacer, anchor);
            const shifted = document.querySelector('#chapter-20').getBoundingClientRect().top -
                document.querySelector('#viewport').getBoundingClientRect().top;
            __toc.reassert(landing);
            return {shifted: Math.round(shifted), fixed: Math.round(document.querySelector('#chapter-20')
                .getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top)};
        }""")
        self.assertGreater(abs(result["shifted"]), 400, "the fixture must actually shift the anchor")
        self.assertLess(abs(result["fixed"]), 2, "a settled layout must be re-asserted")

    def test_landing_is_not_reasserted_after_a_reader_scroll(self):
        self.open_chapters(40)
        self.click_entry(4)
        result = self.page.evaluate("""() => {
            const landing = __toc.align('#chapter-5');
            document.querySelector('#viewport').scrollTop += 2000;
            const before = __toc.scrollTop();
            __toc.reassert(landing);
            return {before, after: __toc.scrollTop()};
        }""")
        self.assertEqual(result["before"], result["after"],
                         "re-assertion must not pull a reader who scrolled away back")

    # ---- opening hint ----

    def test_directory_hint_is_once_per_document_across_reopens(self):
        source = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/toc-once.html'
        converted = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path='
                     'documents/web/html/' + 'a' * 64 + '/document.html')
        html = ''.join(f'<h1>第{i}章</h1>{BODY}' for i in range(1, 5))
        # Exercise reminder persistence independently of ordinary progress saves.
        self.context.route('**/static/reader/core/reader-store.js*', lambda route: route.fulfill(
            content_type='text/javascript', body='''window.VoiceOfMLReaderStore={
              get:async()=>null,put:async()=>{},list:async()=>[]};'''))
        self.page.unroute('**/api/reader-content**')
        self.context.route('**/api/reader-content**', lambda route: route.fulfill(content_type='text/html', body=html))
        self.context.route('**/api/reader-bucket-resource**', lambda route: route.fulfill(content_type='text/html', body=html))
        self.context.route('**/api/reader-resolve?id=0123456789abc', lambda route: route.fulfill(
            json=dict(url=converted, download=source.replace('toc-once', 'toc%2Donce'), extension='html'),
            headers={'Access-Control-Allow-Origin': '*'}))
        base = self.origin + support.PREFIX + '/static/reader.html?'

        def open_document(page, **params):
            page.goto(base + urlencode(dict(ext='html', **params)))
            page.wait_for_function("""()=>document.documentElement.dataset.readerPhase==='ready' &&
                document.querySelectorAll('#toc-list .toc-item').length===4""")
            # Allow the deferred hint (including a possible unwanted drawer open) to run.
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            return page.locator('#history').get_attribute('aria-expanded')

        self.assertEqual(open_document(self.page, url=source), 'true')
        self.assertEqual(self.page.locator('#toc-tab').get_attribute('aria-selected'), 'true')
        self.page.keyboard.press('Escape')
        self.assertFalse(self.panel_open())
        self.page.close()

        reopened = self.context.new_page()
        reopened.on('pageerror', lambda error: self.errors.append(str(error)))
        self.assertEqual(open_document(reopened, url=source), 'false')
        self.assertEqual(open_document(reopened, id='0123456789abc'), 'false', 'resolved alias reopened the hint')
        reopened.locator('#history').press('Enter')
        self.assertTrue(reopened.get_by_role('link', name='第1章').is_visible())
        self.assertEqual(reopened.evaluate('document.activeElement.id'), 'toc-tab')
        self.assertEqual(open_document(reopened, url=source.replace('toc-once', 'another-book')), 'true')

    def test_directory_hint_skips_existing_history_even_with_stale_chapter_position(self):
        # Seed real history before any Reader document (and its reminder) opens.
        static = self.origin + support.PREFIX + '/static/'
        self.page.goto(static + 'reader.css')
        self.page.add_script_tag(url=static + 'reader/core/reader-store.js')
        self.page.evaluate("""source => VoiceOfMLReaderStore.put({
          url:source, chapterIndex:4, chapterOffset:0,
          chapterManifest:source.replace('1234567890abcdef', 'fedcba0987654321')
        })""", CHAPTER_SOURCE)
        self.open_chapters(6)
        self.page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        self.assertFalse(self.panel_open())
        self.assertEqual(self.landed_chapter(), 1, 'the stale position was not restored')
        self.page.locator('#history').press('Enter')
        self.assertTrue(self.page.get_by_role('link', name='第1章').is_visible())

    def test_directory_hint_does_not_open_after_history_wait_expires(self):
        self.page.route('**/static/reader/core/reader-store.js*', lambda route: route.fulfill(
            content_type='text/javascript', body='''window.VoiceOfMLReaderStore={
              get:()=>new Promise(resolve=>{window.__releaseHistory=()=>resolve(null);}),
              put:async()=>{window.__savedNewHistory=true;},list:async()=>[]};'''))
        self.open_chapters(6)
        # Ready must not depend on the history read. Leave it unresolved past the TOC deadline.
        self.page.wait_for_timeout(250)
        self.assertFalse(self.panel_open())
        self.page.evaluate('window.__releaseHistory()')
        self.page.wait_for_function('()=>window.__savedNewHistory === true')
        self.assertFalse(self.panel_open(), 'a late result must not pop the directory')
        self.page.unroute('**/static/reader/core/reader-store.js*')
        self.page.reload()
        self.page.wait_for_function("()=>document.querySelector('#history').getAttribute('aria-expanded')==='true'")

    def test_directory_hint_preempted_by_drawer_interaction_is_not_consumed(self):
        # Isolate the one-time marker: no new history may suppress the retry.
        self.page.route('**/static/reader/core/reader-store.js*', lambda route: route.fulfill(
            content_type='text/javascript', body='''window.VoiceOfMLReaderStore={
              get:async()=>null,put:async()=>{},list:async()=>[]};'''))
        engine = support.ENGINE.replace('getOutline:async()=>null', '''getOutline:()=>new Promise(resolve=>{
          window.__releaseOutline=()=>resolve([0,1,2,3].map(page=>({title:`Chapter ${page+1}`,dest:[page]})));
        })''')
        self.page.unroute('**/static/vendor/pdf.min.*.mjs')
        self.page.route('**/static/vendor/pdf.min.*.mjs', lambda route: route.fulfill(
            content_type='text/javascript', body=engine))
        support.PdfFollowupTests.open(self)
        self.page.wait_for_function('()=>!!window.__releaseOutline')
        self.page.locator('#history').click()
        self.page.locator('#history-close').click()
        self.page.locator('#page-number').focus()
        self.page.evaluate('window.__releaseOutline()')
        self.page.locator('#toc-list .toc-item').nth(3).wait_for(state='attached')
        self.page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        self.assertFalse(self.panel_open())
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'page-number')

        self.page.reload()
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready' && !!window.__releaseOutline")
        self.page.locator('#page-number').focus()
        self.page.evaluate('window.__releaseOutline()')
        self.page.wait_for_function("()=>document.querySelector('#history').getAttribute('aria-expanded')==='true'")
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'page-number')

    def test_directory_hint_survives_unavailable_storage(self):
        self.page.add_init_script("""Object.defineProperty(window, 'localStorage', {
            get: () => { throw new DOMException('Storage disabled', 'SecurityError'); }
        });""")
        self.open_chapters(6)
        self.page.wait_for_function("()=>document.querySelector('#history').getAttribute('aria-expanded')==='true'")
        self.page.locator('#history-close').click()
        self.assertFalse(self.panel_open())
        self.page.locator('#history').press('Enter')
        self.assertTrue(self.page.get_by_role('link', name='第1章').is_visible())

    def test_directory_hint_opens_for_more_than_three_entries(self):
        self.open_chapters(6)
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.page.wait_for_timeout(400)
        self.assertTrue(self.panel_open(), "a six-entry directory shows the opening hint")

    def test_directory_hint_skips_three_or_fewer_entries(self):
        for count in (1, 3):
            with self.subTest(count=count):
                self.open_chapters(count, min_rows=1)
                self.page.wait_for_timeout(500)
                self.assertFalse(self.panel_open(),
                                 f"a {count}-entry directory must not open the panel on its own")


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""Shared table-of-contents navigation regressions: sidebar jumps land where the entry says.

Covers chapter bundles (`epub-chapters`) and the Foliate EPUB engine, early and late
entries, fragments inside large chapters, re-jumps after window trimming, rapid
successive clicks, group headings, the virtualized directory and the opening hint.
"""
import io
import json
import re
import unittest
import zipfile
from urllib.parse import unquote, urlencode

from tests import test_reader_pdf_followup as support
from tests.test_reader_performance import epub_with_many_chapters, zip_bytes

BODY = '<p style="height:1400px">正文</p>'


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


def epub_with_group_headings(count, groups=4):
    """EPUB whose navigation groups chapters under href-less headings."""
    manifest = '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    spine = '<itemref idref="nav"/>'
    files, items = {}, []
    per_group = max(1, count // groups)
    for index in range(1, count + 1):
        manifest += f'<item id="chapter-{index}" href="chapter-{index}.xhtml" media-type="application/xhtml+xml"/>'
        spine += f'<itemref idref="chapter-{index}"/>'
        files[f"OEBPS/chapter-{index}.xhtml"] = (
            f'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
            f'<h1 id="chapter-{index}">第{index}章</h1><p style="height:900px">正文</p></body></html>')
        if (index - 1) % per_group == 0:
            items.append(f'<li><span>分组 {(index - 1) // per_group + 1}</span><ol>')
        items.append(f'<li><a href="chapter-{index}.xhtml#chapter-{index}">第{index}章</a></li>')
        if index % per_group == 0 or index == count:
            items.append('</ol></li>')
    files.update({
        "META-INF/container.xml": '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        "OEBPS/content.opf": f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">reader-toc-groups</dc:identifier><dc:title>Reader Toc Groups</dc:title><dc:language>zh</dc:language></metadata><manifest>{manifest}</manifest><spine>{spine}</spine></package>',
        "OEBPS/nav.xhtml": ('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
                            f'<body><nav epub:type="toc"><ol>{"".join(items)}</ol></nav></body></html>'),
    })
    return zip_bytes(files, ("mimetype", "application/epub+zip"))


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
        source = ("https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/"
                  + "a" * 64 + "/1234567890abcdef/chapter-manifest.json")
        self.page.goto(self.origin + support.PREFIX + "/static/reader.html?" +
                       urlencode(dict(url=source, ext="epub-chapters")), wait_until="domcontentloaded")
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.page.wait_for_function(
            f"()=>document.querySelectorAll('#toc-list .toc-item').length>={min_rows}")
        self.assert_instrumented()

    def open_epub(self, body):
        self.expose()
        self.page.route("**/api/reader-content**", lambda route: route.fulfill(
            content_type="application/epub+zip", body=body,
            headers={"Access-Control-Allow-Origin": "*"}))
        self.page.goto(self.origin + support.PREFIX + "/static/reader.html?" + urlencode(
            dict(url="https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/toc.epub", ext="epub")),
            wait_until="domcontentloaded")
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.assert_instrumented()

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

    def directory_rows(self):
        return self.page.evaluate("""() => [...document.querySelectorAll('#toc-list .toc-item')].map(row => ({
            index: Number(row.dataset.tocIndex), text: row.textContent.trim().slice(0, 12),
            group: row.classList.contains('toc-group'),
            role: row.querySelector('.panel-item-main')?.getAttribute('role') || null}))""")

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

    def test_foliate_chapter_buttons_skip_group_headings_and_keep_directory_open(self):
        self.open_epub(epub_with_group_headings(6,groups=2))
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length===8")
        for width in (390, 1280):
            with self.subTest(width=width):
                self.page.set_viewport_size({'width':width,'height':844})
                self.page.emulate_media(reduced_motion='reduce')
                self.click_entry(3)
                self.page.wait_for_function("()=>document.querySelector('#history').getAttribute('aria-expanded')==='false'")
                self.page.locator('#history').click()
                self.page.locator('#toc-tab').click()
                for selector,index in [('.reader-chapter-next',5),('.reader-chapter-prev',3)]:
                    self.page.locator(selector).click()
                    self.page.wait_for_function('index=>__toc.nav().currentChapterIndex===index',arg=index)
                    self.assertTrue(self.panel_open(),selector)
                    self.assertEqual(self.page.locator('#toc-tab').get_attribute('aria-selected'),'true')
                    self.assertEqual(self.page.locator('#toc-list [aria-current="location"]').count(),1)

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
        html=''.join(f'<h1 id="chapter-{i}">第{i}章</h1><p style="height:1400px">正文</p>' for i in range(1,5))
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(content_type='text/html',body=html))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/chapters.html',ext='html')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready' && __toc.nav().tocEntries.length===4")
        if not self.panel_open(): self.page.locator('#history').click()
        self.page.locator('#toc-tab').click()
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
            self.assertLess(abs(self.offset_of(f'#sec-{chapter}-b') or 99), 2,
                            f"第{chapter}章 第二节 fragment did not land")
            self.assertEqual(self.landed_chapter(), chapter)

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
            self.click_entry(index)
            self.assertEqual(self.landed_chapter(), index+1)
            if not self.panel_open(): self.page.locator('#history').click()

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
        self.open_epub(epub_with_many_chapters())
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length===14")
        for index, chapter in [(9, 10), (4, 5), (7, 8)]:
            self.page.evaluate("index => __toc.jump(index)", index)
            self.page.wait_for_function('''chapter=>{
              const node=document.querySelector(`article[data-section="${chapter}"]`)?.shadowRoot?.querySelector(`#chapter-${chapter}`);
              return node && Math.abs(node.getBoundingClientRect().top-document.querySelector('#viewport').getBoundingClientRect().top-8)<3;
            }''', arg=chapter, timeout=1500)
            self.page.wait_for_timeout(160)
            offset = self.page.locator(f'article[data-section="{chapter}"] #chapter-{chapter}').evaluate(
                "node=>node.getBoundingClientRect().top-document.querySelector('#viewport').getBoundingClientRect().top")
            self.assertLess(abs(offset - 8), 3,
                            'the previous hold must not pull a newer jump back')

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

    # ---- group headings and the opening hint ----

    def test_group_heading_rows_are_not_links(self):
        self.open_epub(epub_with_group_headings(40, groups=4))
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length>4")
        rows = self.directory_rows()
        headings = [row for row in rows if row["group"]]
        self.assertEqual(len(headings), 4, "href-less navigation headings must still be listed")
        self.assertTrue(all(row["role"] == "heading" for row in headings))
        navigable = [row for row in rows if not row["group"]]
        self.assertTrue(all(row["role"] == "link" for row in navigable))
        before = self.page.evaluate("()=>document.querySelector('#viewport').scrollTop")
        self.page.evaluate("""(index) => {
            document.querySelector(`#toc-list .toc-item[data-toc-index="${index}"] .panel-item-main`).click();
        }""", headings[0]["index"])
        self.page.wait_for_timeout(800)
        self.assertEqual(self.page.evaluate("()=>document.querySelector('#viewport').scrollTop"), before,
                         "a group heading must not navigate anywhere")

    def test_navigation_ignores_a_group_entry_index(self):
        self.open_epub(epub_with_group_headings(20, groups=2))
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length>4")
        rows = self.directory_rows()
        group = next(row for row in rows if row["group"])
        before = self.page.evaluate("()=>__toc.nav().currentChapterIndex")
        self.page.evaluate("(index)=>__toc.jump(index)", group["index"])
        self.page.wait_for_timeout(900)
        self.assertEqual(self.page.evaluate("()=>__toc.nav().currentChapterIndex"), before,
                         "a group index must not navigate or change the current entry")

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

    def test_directory_hint_skips_a_three_entry_grouped_navigation(self):
        self.open_epub(epub_with_group_headings(2, groups=1))
        self.page.wait_for_timeout(500)
        self.assertFalse(self.panel_open(),
                         "two chapters under one heading is still a trivial directory")


if __name__ == "__main__":
    unittest.main(verbosity=2)

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
from tests.test_reader_performance import zip_bytes

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
              window.__toc={nav:()=>navigationState, jump:i=>navigateTocEntry(i),
                state:()=>tocVirtualState,
                align:(selector, offset)=>alignReaderDestination(document.querySelector(selector), offset || 0),
                reassert:landing=>reassertReaderDestination(landing),
                scrollTop:()=>viewport.scrollTop};
            ''')
        self.page.route('**/static/reader.js*', instrument)
        self.page.on('pageerror', lambda error: self.errors.append(f'page:{error}'))

    def assert_instrumented(self):
        self.assertEqual(self.page.evaluate("()=>typeof window.__toc"), "object",
                         "reader.js instrumentation did not load")

    def open_chapters(self, count=300, fragments=False, min_rows=4):
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

    # ---- landing re-assertion ----

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
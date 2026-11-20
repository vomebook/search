"""TOC UI and chapter-bundle navigation latency, using the shared two-site server."""
import unittest
from urllib.parse import parse_qs, urlencode, urlsplit

from tests.reader.browser import test_reader_pdf_followup as support
from tests.reader.browser.test_reader_toc_navigation import chapter_body, chapter_manifest


class ReaderTocLatencyTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

    def open_toc_book(self, held_chapters=None):
        manifest = chapter_manifest(14)
        for entry in manifest['toc']:
            entry['fragment'] = f"chapter-{entry['chapter']}"

        def resource(route):
            path = parse_qs(urlsplit(route.request.url).query)['path'][0]
            filename = path.rsplit('/', 1)[-1]
            if filename == 'chapter-manifest.json':
                route.fulfill(json=manifest)
                return
            index = int(filename.removeprefix('chapter-').removesuffix('.xhtml'))
            body = chapter_body(index)
            if index == 10:
                body = body.replace('</h1>', '</h1><p><a href="chapter-0008.xhtml#chapter-8">Book contents</a></p>', 1)
            if held_chapters is not None and index in held_chapters:
                held_chapters[index].append((route, body))
            else:
                route.fulfill(content_type='text/html', body=body)

        self.page.route('**/api/reader-bucket-resource**', resource)
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                  + 'a' * 64 + '/1234567890abcdef/chapter-manifest.json')
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' +
                       urlencode(dict(url=source, ext='epub-chapters')),
                       wait_until='domcontentloaded')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length===14")
        self.page.wait_for_function("()=>document.querySelector('#history-panel').classList.contains('is-open')", timeout=2500)

    def toc_link(self, chapter):
        return self.page.locator(f'#toc-list [data-toc-index="{chapter - 1}"] .panel-item-main')

    def wait_for_chapter_landing(self, chapter):
        self.page.wait_for_function('''chapter=>{
          const target=document.querySelector(`.reader-epub-chapter[data-chapter="${chapter}"] #chapter-${chapter}`);
          return target && Math.abs(target.getBoundingClientRect().top-document.querySelector('#viewport').getBoundingClientRect().top)<3;
        }''', arg=chapter, timeout=1500)

    def expose_toc(self):
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + '\nwindow.__replaceToc = setToc;')
        self.page.route('**/static/reader.js*', instrument)

    def open_text(self):
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='text/plain', body='No directory\n' * 300))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/no-directory.txt',ext='txt')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")

    def test_toc_opens_panel_as_an_opening_hint_and_keeps_it_visible(self):
        self.open_toc_book()
        self.assertEqual(self.page.locator('#toc-tab').get_attribute('aria-selected'), 'true')
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'true')
        before = self.page.evaluate('''()=>({top:document.querySelector('#viewport').scrollTop,
            focus:document.activeElement.id})''')
        self.assertNotIn(before['focus'], ('history', 'toc-tab', 'history-close'))
        self.page.wait_for_timeout(1800)
        self.assertTrue(self.page.locator('#history-panel').evaluate('node=>node.classList.contains("is-open")'))
        self.assertEqual(self.page.evaluate("document.querySelector('#viewport').scrollTop"), before['top'])
        self.page.locator('#history').click()
        self.page.wait_for_function("()=>document.querySelector('#history-panel').hidden")
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'false')

    def test_auto_open_toc_has_normal_close_and_escape(self):
        # System back exits the whole Reader (host test), not just this panel.
        self.page.set_viewport_size({'width': 1200, 'height': 800})
        self.open_toc_book()
        for action in ('close', 'escape'):
            if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
                self.page.locator('#history').click()
            if action == 'close':
                self.page.locator('#history-close').click()
            else:
                self.page.keyboard.press('Escape')
            self.page.wait_for_function("()=>document.querySelector('#history-panel').hidden")
            self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'false')
        self.page.wait_for_timeout(100)
        self.assertTrue(self.page.locator('#history-panel').evaluate('node=>node.hidden'))

    def test_panel_animation_can_reverse_and_respects_reduced_motion(self):
        self.open_text()
        self.page.locator('#history').click()
        panel = self.page.locator('#history-panel')
        self.assertTrue(panel.evaluate('n => getComputedStyle(n).transitionDuration.includes("0.18s")'))
        self.page.evaluate('''() => {document.querySelector('#history-close').click();
          document.querySelector('#history').click();}''')
        self.page.wait_for_timeout(250)
        self.assertTrue(panel.is_visible())
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'true')
        self.page.emulate_media(reduced_motion='reduce')
        self.page.locator('#history-close').click()
        self.page.wait_for_function("()=>document.querySelector('#history-panel').hidden", timeout=1000)
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'false')

    def test_no_toc_stays_closed_and_late_toc_respects_user_choice(self):
        self.expose_toc()
        self.open_text()
        self.page.wait_for_timeout(100)
        self.assertTrue(self.page.locator('#history-panel').evaluate('node=>node.hidden'))
        self.page.locator('#history').click()
        self.page.locator('#history-close').click()
        self.page.wait_for_function("()=>document.querySelector('#history-panel').hidden")
        self.page.evaluate("__replaceToc([{label:'Late directory', activate:()=>true}])")
        self.page.wait_for_timeout(100)
        self.assertTrue(self.page.locator('#history-panel').evaluate('node=>node.hidden'))

    def test_late_directory_preserves_tab_selection_and_in_progress_seek(self):
        self.page.set_viewport_size({'width':390,'height':844})
        self.expose_toc()
        self.open_text()
        self.page.locator('#history').click()
        self.page.locator('#history-tab').click()
        self.page.evaluate('''()=>{__replaceToc([{label:'First',activate:()=>true},{label:'Second',activate:()=>true}]);}''')
        self.assertEqual(self.page.locator('#history-tab').get_attribute('aria-selected'),'true')
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'),'true')
        self.assertTrue(self.page.locator('.reader-progress-tools').is_hidden())
        self.page.locator('#toc-tab').click()
        self.assertEqual(self.page.locator('#toc-panel .panel-view-header strong').inner_text(),'目录')
        self.page.locator('.reader-progress-range').dispatch_event('pointerdown')
        self.page.evaluate("__replaceToc([{label:'Updated',activate:()=>true}])")
        self.assertTrue(self.page.locator('.reader-progress-tools').evaluate("n=>n.parentElement.id==='history-panel'&&!n.classList.contains('reader-no-toc')"))
        self.assertTrue(self.page.locator('.reader-progress-summary').is_hidden())
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'),'true')
        self.page.locator('.reader-progress-range').dispatch_event('pointerup')

    def test_click_outside_closes_but_panel_content_keeps_it_open(self):
        self.open_text()
        self.page.locator('#history').click()
        self.page.locator('#history-panel > header > strong').click()
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'true')
        self.page.mouse.click(6, 200)
        self.page.wait_for_function("()=>document.querySelector('#history-panel').hidden")
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'false')

    def test_html_frame_click_and_escape_close_without_consuming_content_click(self):
        self.page.set_viewport_size({'width': 1200, 'height': 800})
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='text/html', body='<h1>Directory</h1><p id="outside" style="height:1200px">Body</p>'))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/outside.html',ext='html')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length===1")
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'false')
        self.page.locator('#history').click()
        self.page.wait_for_function("()=>document.querySelector('#history').getAttribute('aria-expanded')==='true'")
        frame = self.page.frame_locator('.html-frame')
        self.page.evaluate('''()=>document.querySelector('.html-frame').contentDocument.addEventListener(
            'click', event=>{window.__contentClickPrevented=event.defaultPrevented})''')
        frame.locator('#outside').click(position={'x': 5, 'y': 80})
        self.page.wait_for_function("()=>document.querySelector('#history-panel').hidden")
        self.assertIs(self.page.evaluate('window.__contentClickPrevented'), False)
        self.page.locator('#history').click()
        frame.locator('#outside').evaluate('node=>{node.tabIndex=0;node.focus()}')
        self.page.keyboard.press('Escape')
        self.page.wait_for_function("()=>document.querySelector('#history-panel').hidden")

    def test_escape_leaves_search_before_closing_the_panel(self):
        self.open_text()
        self.page.locator('#history').click()
        self.page.locator('#full-search-toggle').click()
        self.page.locator('#full-search-input').fill('No')
        self.page.keyboard.press('Escape')
        self.assertTrue(self.page.locator('#full-search-view').evaluate('node=>node.hidden'))
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'true')
        self.page.keyboard.press('Escape')
        self.page.wait_for_function("()=>document.querySelector('#history-panel').hidden")

    def test_directory_updates_do_not_reopen_a_manually_closed_panel(self):
        self.expose_toc()
        self.open_toc_book()
        self.page.locator('#history-close').click()
        self.page.wait_for_function("()=>document.querySelector('#history-panel').hidden")
        self.page.evaluate("__replaceToc([{label:'Updated directory', activate:()=>true}])")
        self.page.wait_for_timeout(100)
        self.assertTrue(self.page.locator('#history-panel').evaluate('node=>node.hidden'))

    def test_disposal_cancels_queued_directory_open(self):
        self.expose_toc()
        self.open_text()
        self.page.evaluate("""()=>{
            __replaceToc([{label:'Directory', activate:()=>true}]);
            dispatchEvent(new Event('voice-reader-dispose'));
        }""")
        self.page.wait_for_timeout(100)
        self.assertTrue(self.page.locator('#history-panel').evaluate('node=>node.hidden'))

    def test_unrelated_text_selection_does_not_disable_sidebar_navigation(self):
        self.open_toc_book()
        for current, chapter in ((1, 10), (10, 5)):
            if self.page.locator('#history').get_attribute('aria-expanded') != 'true':
                self.page.locator('#history').click()
            selected = self.toc_link(chapter).evaluate('''(link, current)=>{
              const range=document.createRange();
              range.selectNodeContents(document.querySelector(`#chapter-${current}`));
              const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
              const selected=selection.toString();
              link.click();
              return selected;
            }''', current)
            self.assertTrue(selected)
            self.wait_for_chapter_landing(chapter)

    def test_sidebar_and_book_links_do_not_wait_for_unrelated_prefetch(self):
        # Stall the opening prefetch, then the neighbors of the sidebar destination.
        held = {chapter: [] for chapter in (2, 3, 9, 11)}
        with (
            self.page.expect_request(lambda request: request.url.endswith('chapter-0002.xhtml'), timeout=1500),
            self.page.expect_request(lambda request: request.url.endswith('chapter-0003.xhtml'), timeout=1500),
        ):
            self.open_toc_book(held)
        with (
            self.page.expect_request(lambda request: request.url.endswith('chapter-0009.xhtml'), timeout=1500),
            self.page.expect_request(lambda request: request.url.endswith('chapter-0011.xhtml'), timeout=1500),
        ):
            self.toc_link(10).click()
            self.wait_for_chapter_landing(10)
        self.page.get_by_role('link', name='Book contents', exact=True).click()
        self.wait_for_chapter_landing(8)

        self.assertTrue(all(held.values()), 'both jumps must run with chapter responses withheld')
        responses = [response for chapter in held.values() for response in chapter]
        held.clear()
        for route, body in responses:
            route.fulfill(content_type='text/html', body=body)
        self.page.locator('.reader-epub-chapter[data-chapter="9"]').wait_for(state='attached', timeout=1500)
        self.page.wait_for_timeout(250)
        self.assertLess(abs(self.page.locator('#chapter-8').evaluate(
            "e=>e.getBoundingClientRect().top-document.querySelector('#viewport').getBoundingClientRect().top")), 3)

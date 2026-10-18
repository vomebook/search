"""Focused native EPUB TOC demand acceptance, using the shared two-site server."""
import unittest
from urllib.parse import urlencode

from tests import test_reader_pdf_followup as support
from tests.test_reader_performance import epub_with_many_chapters


class ReaderTocLatencyTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

    def open_toc_book(self):
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(
            content_type='application/epub+zip',body=epub_with_many_chapters(),
            headers={'Access-Control-Allow-Origin':'*'}))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/toc-hint.epub',ext='epub')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length===14")
        self.page.wait_for_function("()=>document.querySelector('#history-panel').classList.contains('is-open')", timeout=2500)

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
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(
            content_type='application/epub+zip',body=epub_with_many_chapters(),
            headers={'Access-Control-Allow-Origin':'*'}))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/toc-selection.epub',ext='epub')))
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length===14")
        for index,number in [(9,10),(4,5)]:
            self.page.evaluate('''index=>{
              const range=document.createRange();range.selectNodeContents(document.querySelector('#title'));
              getSelection().removeAllRanges();getSelection().addRange(range);
              document.querySelectorAll('#toc-list .panel-item-main')[index].click();
            }''',index)
            self.page.wait_for_function('''number=>{
              const a=document.querySelector('article[data-section="'+number+'"]'),target=a?.shadowRoot?.querySelector('#chapter-'+number);
              return target && Math.abs(target.getBoundingClientRect().top-document.querySelector('#viewport').getBoundingClientRect().top-8)<3;
            }''',arg=number,timeout=1500)

    def test_sidebar_and_book_links_do_not_wait_for_unrelated_prefetch(self):
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(
            content_type='application/epub+zip',body=epub_with_many_chapters(),
            headers={'Access-Control-Allow-Origin':'*'}))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/toc-latency.epub',ext='epub')))
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length===14")
        self.page.evaluate('''()=>{
          const sections=document.querySelector('foliate-view').book.sections.filter(s=>s.linear!=='no');
          for(const index of [9,11]){const original=sections[index].createDocument.bind(sections[index]);
            sections[index].createDocument=()=>new Promise(resolve=>{
              (window.__heldNeighbors||=[]).push(()=>original().then(resolve));});}
          document.querySelectorAll('#toc-list .panel-item-main')[9].click();
        }''')
        self.page.wait_for_function('''()=>{
          const a=document.querySelector('article[data-section="10"]'),target=a?.shadowRoot?.querySelector('#chapter-10');
          return target && Math.abs(target.getBoundingClientRect().top-document.querySelector('#viewport').getBoundingClientRect().top-8)<3;
        }''',timeout=1500)
        self.page.evaluate('''()=>{
          const root=document.querySelector('article[data-section="10"]').shadowRoot;
          const link=document.createElement('a');link.href='chapter-8.xhtml#chapter-8';link.textContent='Book contents';
          root.querySelector('#chapter-10').append(link);link.click();
        }''')
        self.page.wait_for_function('''()=>{
          const a=document.querySelector('article[data-section="8"]'),target=a?.shadowRoot?.querySelector('#chapter-8');
          return target && Math.abs(target.getBoundingClientRect().top-document.querySelector('#viewport').getBoundingClientRect().top-8)<3;
        }''',timeout=1500)
        self.page.evaluate('()=>{for(const release of window.__heldNeighbors||[])release();}')
        self.page.wait_for_timeout(250)
        self.assertLess(abs(self.page.locator('#chapter-8').evaluate(
            "e=>e.getBoundingClientRect().top-document.querySelector('#viewport').getBoundingClientRect().top-8")),3)

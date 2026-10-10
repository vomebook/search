"""Focused native EPUB TOC demand acceptance, using the shared two-site server."""
import unittest
from urllib.parse import urlencode

from tests import test_reader_pdf_followup as support
from tests.test_reader_performance import epub_with_many_chapters


class ReaderTocLatencyTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

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

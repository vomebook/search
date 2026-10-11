"""Shared ebook loading/navigation regressions; actual EPUB engine, bounded fixtures."""
import io
import json
import unittest
import zipfile
from urllib.parse import urlencode
from tests import test_reader_pdf_followup as support
from tests.test_reader_performance import epub_with_many_chapters


class EbookFlowTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

    def expose(self):
        def instrument(route):
            response = route.fetch()
            script=response.text().replace('foliateSectionLoader.refresh = refresh;',
                'foliateSectionLoader.refresh = refresh; window.__nativeStats=()=>({active:scheduler.activeCount,pending:scheduler.pendingCount});')
            route.fulfill(response=response, body=script+'''
              window.__ebook={restore:restoreFoliateBookmarkPosition,seek:seekFoliateProgress,
                begin:beginReaderNavigation,anchor:foliateScrollAnchors,
                load:i=>foliateSectionLoader(i),jump:i=>navigateTocEntry(i-1),
                chapter:i=>navigationState.tocEntries[i-1].activate(beginReaderNavigation()),
                progress:seekProgress,seekTask:()=>epubSeekPromise};
            ''')
        self.page.route('**/static/reader.js*', instrument)

    def native(self, short=False, image=False):
        with zipfile.ZipFile(io.BytesIO(epub_with_many_chapters())) as archive:
            files={name:archive.read(name) for name in archive.namelist()}
        for name in files:
            if name.endswith('.xhtml'):
                text=files[name].decode()
                if short:text=text.replace('height:1200px','height:20px')
                if image:text=text.replace('</body>','<img src="slow.png" width="100" height="100"/></body>')
                files[name]=text.encode()
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:
            for name,body in files.items():archive.writestr(name,body)
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(content_type='application/epub+zip',body=stream.getvalue(),headers={'Access-Control-Allow-Origin':'*'}))
        self.expose()
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/flow.epub',ext='epub')),wait_until='domcontentloaded')

    def test_native_first_text_does_not_wait_for_image_body(self):
        held=[]
        self.page.route('**/api/reader-resource?**',lambda route:held.append(route))
        self.native(image=True)
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=1200)
        self.assertTrue(self.page.locator('.reader-section-body').first.text_content())
        for route in held:route.abort()

    def test_native_restore_and_progress_do_not_wait_for_unrelated_neighbors(self):
        self.native()
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length===14")
        self.page.evaluate('''()=>{
          const sections=document.querySelector('foliate-view').book.sections.filter(s=>s.linear!=='no');
          for(const index of [9,11])sections[index].createDocument=()=>new Promise(()=>{});
          window.__result=null;
          __ebook.restore({foliateSection:10,foliateOffset:350}).then(value=>__result=value);
        }''')
        self.page.wait_for_function('()=>window.__result===true',timeout=1500)
        self.page.evaluate('''()=>{window.__seekDone=false;__ebook.seek(100*8.2/15,__ebook.begin()).then(()=>__seekDone=true);}''')
        self.page.wait_for_function('()=>window.__seekDone',timeout=1500)

    def test_native_jump_keeps_previous_chapter_reachable_and_position_stable(self):
        self.native()
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length===14")
        self.page.evaluate('__ebook.jump(13)')
        self.page.wait_for_function("()=>!!document.querySelector('article[data-section=\"12\"]:not(.foliate-section-placeholder)')",timeout=1500)
        self.page.wait_for_timeout(200)
        self.assertLess(abs(self.page.locator('#chapter-13').evaluate('n=>n.getBoundingClientRect().top-document.querySelector("#viewport").getBoundingClientRect().top-8')),3)
        self.page.locator('#chapter-12').evaluate('n=>n.scrollIntoView()')
        self.page.wait_for_timeout(250)
        self.assertTrue(self.page.locator('#chapter-12').is_visible())

    def test_superseded_native_jump_releases_slots_and_ignores_late_section(self):
        self.native()
        self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length===14")
        self.page.evaluate('''()=>{
          const sections=document.querySelector('foliate-view').book.sections.filter(s=>s.linear!=='no');
          const original=sections[10].createDocument.bind(sections[10]);
          sections[10].createDocument=()=>new Promise(resolve=>{window.__releaseOld=()=>original().then(resolve);});
          __ebook.jump(10);
        }''')
        self.page.wait_for_function('()=>!!window.__releaseOld')
        self.page.evaluate('__ebook.jump(13)')
        self.page.wait_for_function('''()=>{const n=document.querySelector('article[data-section="13"]')?.shadowRoot?.querySelector('#chapter-13');
          return n&&Math.abs(n.getBoundingClientRect().top-document.querySelector('#viewport').getBoundingClientRect().top-8)<3;}''',timeout=1500)
        self.assertLessEqual(self.page.evaluate('__nativeStats().active'),3)
        self.page.evaluate('__releaseOld()')
        self.page.wait_for_timeout(250)
        self.assertEqual(self.page.locator('article[data-section="10"]:not(.foliate-section-placeholder)').count(),0)

    def test_native_short_chapters_do_not_recursively_decode_whole_book(self):
        self.native(short=True)
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.page.wait_for_timeout(400)
        self.assertLessEqual(self.page.locator('article[data-section]:not(.foliate-section-placeholder)').count(),9)
        self.assertLessEqual(self.page.evaluate('__nativeStats().active'),3)
        self.assertTrue(self.page.evaluate("!!document.querySelector('foliate-view').renderer"))

    def test_anchor_preserves_reading_line_when_previous_chapter_arrives_mid_scroll(self):
        self.native()
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        result=self.page.evaluate('''()=>{
          const article=document.querySelector('article[data-section]');
          const root=article.shadowRoot.querySelector('.reader-section-body');
          root.innerHTML='<p style="height:800px">Before</p><p id="line">Reading line</p><p style="height:1600px">After</p>';
          const viewport=document.querySelector('#viewport'),line=root.querySelector('#line');
          viewport.scrollTop+=line.getBoundingClientRect().top-viewport.getBoundingClientRect().top-80;
          viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-1}));
          const before=line.getBoundingClientRect().top;
          __ebook.anchor.preserve(()=>{const previous=document.createElement('div');previous.style.height='700px';article.before(previous);});
          return {before,after:line.getBoundingClientRect().top};
        }''')
        self.assertAlmostEqual(result['before'],result['after'],delta=2)

    def test_chapter_jump_warms_both_sides_without_old_observer_demands(self):
        manifest={'version':1,'kind':'epub-chapters','chapters':[{'index':i,'path':f'chapter-{i}.xhtml','bytes':500} for i in range(1,41)]}
        requested=[]
        def resource(route):
            url=route.request.url
            if 'chapter-manifest' in url:route.fulfill(json=manifest);return
            import re
            index=int(re.search(r'chapter-(\d+)\.xhtml',url).group(1))
            requested.append(index)
            route.fulfill(content_type='text/html',body=f'<h1 id="chapter-{index}">Chapter {index}</h1><p style="height:1600px">Body {index}</p>')
        self.page.route('**/api/reader-content**',resource)
        self.expose()
        source='https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/'+'a'*64+'/chapter-manifest.json'
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(url=source,ext='epub-chapters')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.page.evaluate('__ebook.chapter(30)')
        self.page.wait_for_function("()=>!!document.querySelector('.reader-epub-chapter[data-chapter=\"29\"]')",timeout=1500)
        self.page.wait_for_timeout(300)
        self.assertLess(abs(self.page.locator('.reader-epub-chapter[data-chapter="30"]').evaluate('n=>n.getBoundingClientRect().top-document.querySelector("#viewport").getBoundingClientRect().top')),3)
        self.page.locator('#chapter-29').evaluate('n=>n.scrollIntoView()')
        self.page.wait_for_timeout(200)
        self.assertTrue(self.page.locator('#chapter-29').is_visible())
        self.page.evaluate('__ebook.progress(80)')
        self.page.evaluate('__ebook.seekTask()')
        self.assertTrue(self.page.locator('.reader-epub-chapter[data-chapter="33"]').count())
        self.assertTrue(self.page.locator('.reader-epub-chapter[data-chapter="33"]').is_visible())

    def test_html_text_does_not_wait_for_unrelated_image(self):
        held=[]
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(content_type='text/html',
            body='<h1>Readable body</h1><p>Complete text</p><img src="https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/slow.png" width="100" height="100"/>',
            headers={'Access-Control-Allow-Origin':'*'}))
        self.context.route('**/slow.png',lambda route:held.append(route))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/flow.html',ext='html')),wait_until='domcontentloaded')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=1500)
        self.assertIn('Complete text',self.page.frame_locator('.html-frame').locator('body').text_content())
        for route in held:route.abort()

"""Shared ebook loading/navigation regressions; actual EPUB engine, bounded fixtures."""
import io
import json
import unittest
import zipfile
from urllib.parse import unquote, urlencode
from tests.reader.browser import test_reader_pdf_followup as support
from tests.performance.test_reader_performance import epub_with_many_chapters


class EbookFlowTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

    def expose(self):
        def instrument_foliate(route):
            response = route.fetch()
            needle = 'readerContext.foliateSectionLoader.refresh = refresh;'
            script = response.text()
            self.assertIn(needle, script)
            route.fulfill(response=response, body=script.replace(needle,
                needle + ' window.__nativeStats=()=>({active:scheduler.activeCount,pending:scheduler.pendingCount});'))
        self.page.route('**/static/reader/formats/reader-foliate-format.mjs*', instrument_foliate)
        def instrument(route):
            response = route.fetch()
            script=response.text()
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

    def test_mobile_ebook_prose_stays_in_paper_and_wide_blocks_scroll(self):
        body = '''<h1>Mobile ebook</h1>
          <div id="fixed" style="width:720px;min-width:680px">
            <p id="line" style="white-space:nowrap;overflow-wrap:normal">%s</p></div>
          <table id="wide-table" style="min-width:850px"><caption>Table caption</caption>
            <tbody><tr><td>First column</td><td>Last column</td></tr></tbody></table>
          <pre id="wide-pre">%s</pre>
          <svg id="figure" xmlns="http://www.w3.org/2000/svg" width="900" height="100" viewBox="0 0 900 100"
            style="min-width:800px"><rect width="900" height="100" fill="blue"/></svg>
          <p id="after">正文仍可阅读</p>''' % ('unbroken' * 55, '0123456789 ' * 50)
        with zipfile.ZipFile(io.BytesIO(epub_with_many_chapters(count=1))) as archive:
            files = {name:archive.read(name) for name in archive.namelist()}
        files['OEBPS/nav.xhtml'] = files['OEBPS/nav.xhtml'].replace(b'</body>', body.encode() + b'</body>')
        packed = io.BytesIO()
        with zipfile.ZipFile(packed, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items(): archive.writestr(name, data)
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/' + 'a'*64 + '/1234567890abcdef/chapter-manifest.json'
        manifest = {'version':1,'kind':'epub-chapters','chapters':[{'index':1,'path':'chapters/chapter-0001.xhtml','bytes':len(body.encode())}]}
        self.page.route('**/api/reader-content**', lambda route:route.fulfill(content_type='application/epub+zip',
            body=packed.getvalue(),headers={'Access-Control-Allow-Origin':'*'}))
        self.page.route('**/api/reader-bucket-resource**', lambda route:route.fulfill(json=manifest) if 'chapter-manifest' in route.request.url
            else route.fulfill(content_type='text/html', body=body,headers={'Access-Control-Allow-Origin':'*'}))
        self.page.set_viewport_size({'width':320,'height':750})
        for mode, url in [('epub','https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/mobile.epub'), ('epub-chapters',source)]:
            with self.subTest(mode=mode):
                self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(url=url, ext=mode)))
                self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
                for width, zoom in [(320,100),(390,150)]:
                    self.page.set_viewport_size({'width':width,'height':750})
                    if zoom!=100:
                        self.page.locator('#zoom').fill(str(zoom))
                        self.page.locator('#zoom').dispatch_event('change')
                    result = self.page.locator('#line').evaluate('''line=>{
                      const root=line.getRootNode(), box=line.closest('.reader-epub-chapter,.reader-section-body');
                      const bounds=box.getBoundingClientRect(), viewport=document.querySelector('#viewport');
                      const range=document.createRange();range.selectNodeContents(line);
                      const textInside=[...range.getClientRects()].every(r=>r.left>=bounds.left-1 && r.right<=bounds.right+1);
                      const localScroll=id=>{let n=root.querySelector(id); while(n && n!==box){
                        if (getComputedStyle(n).overflowX==='auto' && n.scrollWidth>n.clientWidth+4){
                          n.scrollLeft=n.scrollWidth;return n.scrollLeft>0 && n.getBoundingClientRect().right<=bounds.right+1;
                        }n=n.parentElement;
                      }return false;};
                      return {width:viewport.clientWidth,scrollWidth:viewport.scrollWidth,textInside,
                        table:localScroll('#wide-table'),code:localScroll('#wide-pre'),
                        figure:root.querySelector('#figure').getBoundingClientRect().right<=bounds.right+1};
                    }''')
                    self.assertLessEqual(result['scrollWidth'],result['width']+1,result)
                    self.assertTrue(all(result[k] for k in ('textInside','table','code','figure')),result)
                    self.assertEqual(self.page.locator('#after').text_content(),'正文仍可阅读')
                    self.assertEqual(self.page.locator('#wide-table caption').text_content(),'Table caption')
                    self.assertEqual(self.page.locator('#wide-pre').text_content(),'0123456789 ' * 50)
                self.page.set_viewport_size({'width':1024,'height':750})
                desktop = self.page.locator('#line').evaluate('''line=>({
                  nowrap:getComputedStyle(line).whiteSpace,
                  minWidth:getComputedStyle(line.parentElement).minWidth,
                  table:getComputedStyle(line.getRootNode().querySelector('#wide-table').parentElement).display
                })''')
                self.assertEqual(desktop, {'nowrap':'nowrap','minWidth':'680px','table':'contents'})

    def test_native_first_text_does_not_wait_for_image_body(self):
        held=[]
        self.page.route('**/api/reader-resource?**',lambda route:held.append(route))
        self.native(image=True)
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=1200)
        self.assertTrue(self.page.locator('.reader-section-body').first.text_content())
        for route in held:route.abort()

    def test_native_first_chapter_reads_packaged_styles_in_parallel_and_keeps_cascade(self):
        with zipfile.ZipFile(io.BytesIO(epub_with_many_chapters(count=1))) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        links = ''.join(f'<link rel="stylesheet" href="style-{i}.css"/>' for i in range(1, 5))
        sheets = ''.join(f'<item id="style-{i}" href="style-{i}.css" media-type="text/css"/>' for i in range(1, 5))
        files['OEBPS/content.opf'] = files['OEBPS/content.opf'].replace(b'</manifest>', sheets.encode() + b'</manifest>')
        files['OEBPS/nav.xhtml'] = files['OEBPS/nav.xhtml'].replace(b'<body>', f'<head>{links}</head><body><p id="cascade-probe">styles</p>'.encode())
        for i in range(1, 5):
            files[f'OEBPS/style-{i}.css'] = f'#cascade-probe {{letter-spacing:{i}px}}'.encode()
        body = io.BytesIO()
        with zipfile.ZipFile(body, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items(): archive.writestr(name, data)

        self.page.add_init_script('''(() => {
          const fetchNative = window.fetch;
          const blobNative = Response.prototype.blob;
          window.__heldStyles = {};
          window.fetch = async (url, ...rest) => {
            const response = await fetchNative(url, ...rest);
            if (!String(url).startsWith('blob:') || !response.headers.get('content-type')?.includes('text/css')) return response;
            const blob = await blobNative.call(response);
            const marker = /letter-spacing:(\\d)px/.exec(await blob.text());
            if (!marker) return new Response(blob, {headers: response.headers});
            await new Promise(resolve => { window.__heldStyles[marker[1]] = resolve; });
            return new Response(blob, {headers: response.headers});
          };
        })()''')
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='application/epub+zip', body=body.getvalue(), headers={'Access-Control-Allow-Origin':'*'}))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/style-order.epub',ext='epub')),
            wait_until='domcontentloaded')
        self.page.wait_for_function("()=>['1','2','3'].every(key=>!!window.__heldStyles[key])")
        self.assertFalse(self.page.evaluate("()=>!!window.__heldStyles['4']"))
        # Finish out of order. The last sheet in document order must still win.
        self.page.evaluate("()=>window.__heldStyles['3']()")
        self.page.wait_for_function("()=>!!window.__heldStyles['4']")
        self.page.evaluate("()=>{for(const key of ['4','2','1']) window.__heldStyles[key]();}")
        self.page.wait_for_function('''()=>{
          const probe = document.querySelector('article[data-section="0"]')?.shadowRoot?.querySelector('#cascade-probe');
          return probe && getComputedStyle(probe).letterSpacing === '4px';
        }''')

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

    def test_initial_restore_does_not_wait_for_previous_chapter(self):
        self.page.goto(self.origin+support.PREFIX+'/static/manifest.json')
        self.page.add_script_tag(url=self.origin+support.PREFIX+'/static/reader/core/reader-store.js')
        source='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/flow.epub'
        self.page.evaluate('''async source=>{await VoiceOfMLReaderStore.clearHistory();
          await VoiceOfMLReaderStore.put({url:source,foliateSection:10,foliateOffset:0,zoom:100});}''',source)
        def hold_previous(route):
            response=route.fetch();script=response.text()
            needle='const source = await readerContext.awaitReader(section.createDocument(), signal);'
            self.assertIn(needle,script)
            route.fulfill(response=response,body=script.replace(needle,
                'if (index === 9) { window.__heldPrevious = true; await new Promise(resolve => { window.__releasePrevious = resolve; }); }\n'+needle))
        self.page.route('**/static/reader/formats/reader-foliate-format.mjs*',hold_previous)
        self.page.route('**/api/reader-content**',lambda route:route.fulfill(content_type='application/epub+zip',body=epub_with_many_chapters(),headers={'Access-Control-Allow-Origin':'*'}))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(url=source,ext='epub')),wait_until='domcontentloaded')
        self.page.wait_for_function('()=>!!window.__heldPrevious',timeout=5000)
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'",timeout=2000)
        article=self.page.locator('article[data-section="10"]')
        self.assertTrue(article.is_visible())
        self.assertIn('章节 10',article.locator('.reader-section-body').inner_text())
        before=self.page.locator('#viewport').evaluate('node=>node.scrollTop')
        self.page.evaluate('window.__releasePrevious()')
        self.page.wait_for_function('''()=>!!document.querySelector('article[data-section="9"]:not(.foliate-section-placeholder)')''',timeout=5000)
        self.page.wait_for_timeout(150)
        self.assertLess(abs(article.evaluate('node=>node.getBoundingClientRect().top-document.querySelector("#viewport").getBoundingClientRect().top')),20)
        self.assertGreaterEqual(self.page.locator('#viewport').evaluate('node=>node.scrollTop'),before)

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
        manifest={'version':1,'kind':'epub-chapters','chapters':[{'index':i,'path':f'chapters/chapter-{i:04d}.xhtml','bytes':500} for i in range(1,41)]}
        requested=[]
        def resource(route):
            url=route.request.url
            if 'chapter-manifest' in url:route.fulfill(json=manifest);return
            import re
            index=int(re.search(r'chapter-(\d+)\.xhtml',unquote(url)).group(1))
            requested.append(index)
            route.fulfill(content_type='text/html',body=f'<h1 id="chapter-{index}">Chapter {index}</h1><p style="height:1600px">Body {index}</p>')
        self.page.route('**/api/reader-bucket-resource**',resource)
        self.expose()
        source='https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/'+'a'*64+'/1234567890abcdef/chapter-manifest.json'
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

"""Shared chapter ebook loading and navigation regressions."""
import unittest
from urllib.parse import unquote, urlencode
from tests.reader.browser import test_reader_pdf_followup as support


class EbookFlowTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

    def test_successful_toc_jump_owns_open_before_old_chapter_fails(self):
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                  + 'a' * 64 + '/1234567890abcdef/chapter-manifest.json')
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': i, 'path': f'chapters/chapter-{i:04d}.xhtml', 'bytes': 100} for i in range(1, 21)
        ], 'toc': [{'title': f'Target {i}', 'chapter': i, 'depth': 0, 'fragment': ''} for i in range(1, 21)]}
        first, arriving = [], []

        def resource(route):
            if 'chapter-manifest.json' in route.request.url:
                route.fulfill(json=manifest)
                return
            index = int(unquote(route.request.url).rsplit('chapter-', 1)[1].split('.', 1)[0])
            if index == 1:
                first.append(route)
            elif index == 15:
                arriving.append(route)
            else:
                route.fulfill(content_type='text/html', body=f'<h1>Chapter {index}</h1><p style="height:1500px">Text</p>')

        self.page.route('**/api/reader-bucket-resource**', resource)
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(
            dict(url=source, ext='epub-chapters')), wait_until='domcontentloaded')
        self.page.locator('.reader-epub-chapter[data-chapter="3"]').wait_for(state='attached')
        self.page.get_by_role('link', name='Target 15', exact=True).click()
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='prepare'")
        self.assertEqual(len(first), 1)
        self.assertEqual(len(arriving), 1)
        # The obsolete request can fail even before the newer jump lands.
        first[0].fulfill(status=404)
        arriving[0].fulfill(content_type='text/html', body='<h1>Chapter 15</h1><p style="height:1500px">Readable target</p>')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        heading = self.page.locator('.reader-epub-chapter[data-chapter="15"] h1')
        self.assertEqual(heading.text_content(), 'Chapter 15')
        self.assertTrue(heading.evaluate('''node=>{
            const r=node.getBoundingClientRect(),v=document.querySelector('#viewport').getBoundingClientRect();
            return r.top<v.bottom && r.bottom>v.top;
        }'''))
        self.assertEqual(self.page.locator('.reader-error').count(), 0)

    def expose(self):
        def instrument(route):
            response = route.fetch()
            route.fulfill(response=response, body=response.text() + '''
              window.__ebook={captureChapter:captureChapterPosition,
                chapter:i=>navigationState.tocEntries[i-1].activate(beginReaderNavigation()),
                progress:seekProgress,seekTask:()=>epubSeekPromise,
                percent:readerProgressPercent,restoreProgress:restoreProgressState,save:saveProgress};
            ''')
        self.page.route('**/static/reader.js*', instrument)

    def test_ebook_prose_stays_in_paper_and_wide_blocks_scroll(self):
        body = '''<h1>Ebook layout</h1>
          <div id="fixed" style="width:720px;min-width:680px">
            <p id="line" style="white-space:nowrap;overflow-wrap:normal">%s</p></div>
          <table id="wide-table" style="min-width:1400px"><caption>Table caption</caption>
            <tbody><tr><td>First column</td><td>Last column</td></tr></tbody></table>
          <pre id="wide-pre">%s</pre>
          <svg id="figure" xmlns="http://www.w3.org/2000/svg" width="900" height="100" viewBox="0 0 900 100"
            style="min-width:800px"><rect width="900" height="100" fill="blue"/></svg>
          <p id="after">正文仍可阅读</p>''' % ('unbroken' * 55, '0123456789 ' * 50)
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/' + 'a'*64 + '/1234567890abcdef/chapter-manifest.json'
        manifest = {'version':1,'kind':'epub-chapters','chapters':[{'index':1,'path':'chapters/chapter-0001.xhtml','bytes':len(body.encode())}]}
        self.page.route('**/api/reader-bucket-resource**', lambda route:route.fulfill(json=manifest) if 'chapter-manifest' in route.request.url
            else route.fulfill(content_type='text/html', body=body,headers={'Access-Control-Allow-Origin':'*'}))
        self.page.set_viewport_size({'width':320,'height':750})
        for mode, url in [('epub-chapters',source)]:
            with self.subTest(mode=mode):
                self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(url=url, ext=mode)))
                self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
                for width, zoom in [(320,100),(390,150),(980,100),(1440,150)]:
                    self.page.set_viewport_size({'width':width,'height':750})
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
                        paperWidth:bounds.width,
                        table:localScroll('#wide-table'),code:localScroll('#wide-pre'),
                        figure:root.querySelector('#figure').getBoundingClientRect().right<=bounds.right+1};
                    }''')
                    self.assertLessEqual(result['scrollWidth'],result['width']+1,(width,zoom,result))
                    self.assertTrue(all(result[k] for k in ('textInside','table','code','figure')),(width,zoom,result))
                    if width == 1440:
                        self.assertLess(result['paperWidth'], result['width'] - 30, result)
                    self.assertEqual(self.page.locator('#after').text_content(),'正文仍可阅读')
                    self.assertEqual(self.page.locator('#wide-table caption').text_content(),'Table caption')
                    self.assertEqual(self.page.locator('#wide-pre').text_content(),'0123456789 ' * 50)

    def test_chapter_xhtml_packaged_css_cascade(self):
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                  + 'a' * 64 + '/1234567890abcdef/chapter-manifest.json')
        # The chapter renderer mounts the sanitized body, not the document head.
        chapter = '''<?xml version="1.0" encoding="utf-8"?>
          <html xmlns="http://www.w3.org/1999/xhtml"><head><title>CSS chapter</title></head>
          <body><h1>CSS chapter</h1>
          <style type="text/css">.book-text { color: rgb(10, 20, 30); letter-spacing: 2px; }
            .book-text.special { color: rgb(40, 50, 60); }</style>
          <style type="text/css">.book-text { color: rgb(70, 80, 90); word-spacing: 4px; }</style>
          <p id="css-base" class="book-text">Base</p>
          <p id="css-specific" class="book-text special">Specific</p>
          <p id="css-inline" class="book-text special" style="color: rgb(100, 110, 120)">Inline</p>
          </body></html>'''
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': 1, 'path': 'chapters/chapter-0001.xhtml', 'bytes': len(chapter.encode())}]}
        self.page.route('**/api/reader-bucket-resource**', lambda route: route.fulfill(json=manifest)
            if 'chapter-manifest.json' in route.request.url else route.fulfill(
                content_type='application/xhtml+xml', body=chapter, headers={'Access-Control-Allow-Origin': '*'}))
        # Dark mode deliberately overrides book colors; test their cascade in light mode.
        self.page.add_init_script("localStorage.setItem('theme', 'light')")
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(
            dict(url=source, ext='epub-chapters')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready' && "
                                    "document.documentElement.dataset.theme==='light'")
        for element, color in [('css-base', 'rgb(70, 80, 90)'),
                               ('css-specific', 'rgb(40, 50, 60)'),
                               ('css-inline', 'rgb(100, 110, 120)')]:
            with self.subTest(element=element):
                node = self.page.locator('.reader-epub-chapter #' + element)
                self.assertTrue(node.is_visible())
                style = node.evaluate('n => {const s = getComputedStyle(n); return [s.color, s.letterSpacing, s.wordSpacing]}')
                self.assertEqual(style, [color, '2px', '4px'])

    def test_ebook_first_content_does_not_import_pdf_hit_projection(self):
        requested = []

        def pdf_only(route):
            requested.append(route.request.url)
            route.abort()

        self.page.route('**/reader/search/reader-book-text*.js*', pdf_only)
        self.page.route('**/reader/search/reader-pdf-book-validate*.mjs*', pdf_only)
        self.page.route('**/reader/search/reader-pdf-hit-projection*.mjs*', pdf_only)
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                  + 'a' * 64 + '/1234567890abcdef/chapter-manifest.json')
        chapter = '<h1>Visible converted chapter</h1><p>Opening ebook text</p>'
        self.page.route('**/api/reader-bucket-resource**', lambda route: route.fulfill(json={
            'version': 1, 'kind': 'epub-chapters', 'chapters': [
                {'index': 1, 'path': 'chapters/chapter-0001.xhtml', 'bytes': len(chapter)}]
        }) if 'chapter-manifest.json' in route.request.url else route.fulfill(content_type='text/html', body=chapter))
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(
            dict(url=source, ext='epub-chapters')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        heading = self.page.locator('.reader-epub-chapter h1')
        self.assertTrue(heading.is_visible())
        self.assertEqual(heading.text_content(), 'Visible converted chapter')
        self.assertEqual(requested, [])


    def test_converted_position_reads_each_chapter_once_and_preserves_identity(self):
        self.expose()
        source='https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'+'a'*64+'/1234567890abcdef/chapter-manifest.json'
        body='<h1>Hello</h1><p>Text</p>'
        manifest={'version':1,'kind':'epub-chapters','chapters':[{'index':1,'path':'chapters/chapter-0001.xhtml','bytes':len(body)}]}
        self.page.route('**/api/reader-bucket-resource**',lambda route:route.fulfill(json=manifest) if 'chapter-manifest' in route.request.url
            else route.fulfill(content_type='text/html',body=body))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(url=source,ext='epub-chapters')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        result=self.page.evaluate('''()=>{
          const frame=document.querySelector('.epub-frame'), first=frame.querySelector('.reader-epub-chapter');
          const second=document.createElement('article');second.className=first.className;second.dataset.chapter='2';
          frame.append(second);
          const restore=first.getBoundingClientRect;
          const top=document.querySelector('#viewport').getBoundingClientRect().top+8;
          try {
            return [[[-20,-3],[30,40]],[[-20,-3],[-30,-10]],[[-3,6],[10,20]]].map(rects=>{
              const reads=[0,0];
              [first,second].forEach((row,i)=>{row.getBoundingClientRect=()=>{reads[i]++;return {top:top+rects[i][0],bottom:top+rects[i][1]}}});
              return [__ebook.captureChapter(),reads];
            });
          } finally { first.getBoundingClientRect=restore;second.remove(); }
        }''')
        self.assertEqual([(v['chapterIndex'],v['chapterOffset'],reads) for v,reads in result],
                         [(2,-30,[1,1]),(2,30,[1,1]),(1,3,[1,0])])
        self.assertEqual([v['chapterManifest'] for v,_ in result],[source]*3)

    def test_chapter_window_reuses_geometry_when_marker_is_in_a_gap(self):
        def expose_window(route):
            response=route.fetch()
            script=response.text()
            needle='    function scheduleChapterWindow() {'
            self.assertIn(needle,script)
            route.fulfill(response=response,body=script.replace(needle,
                '    window.__refreshChapterWindow = refreshChapterWindow;\n'+needle))
        self.page.route('**/static/reader/formats/reader-chapter-format.mjs*',expose_window)
        source='https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'+'a'*64+'/1234567890abcdef/chapter-manifest.json'
        body='<h1>Hello</h1><p>Text</p>'
        manifest={'version':1,'kind':'epub-chapters','chapters':[{'index':1,'path':'chapters/chapter-0001.xhtml','bytes':len(body)}]}
        self.page.route('**/api/reader-bucket-resource**',lambda route:route.fulfill(json=manifest) if 'chapter-manifest' in route.request.url
            else route.fulfill(content_type='text/html',body=body))
        self.page.goto(self.origin+support.PREFIX+'/static/reader.html?'+urlencode(dict(url=source,ext='epub-chapters')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        result=self.page.evaluate('''()=>{
          const frame=document.querySelector('.epub-frame'), real=frame.querySelector('.reader-epub-chapter');
          const top=document.querySelector('#viewport').getBoundingClientRect().top;
          const before=document.createElement('article');before.dataset.chapter='1';
          frame.insertBefore(before,real);
          const originals=[before.getBoundingClientRect,real.getBoundingClientRect];
          const reads=[0,0];
          before.getBoundingClientRect=()=>{reads[0]++;return {top:top-40,bottom:top-5}};
          real.getBoundingClientRect=()=>{reads[1]++;return {top:top+90,bottom:top+170}};
          try { __refreshChapterWindow(); return reads; }
          finally { before.remove();real.getBoundingClientRect=originals[1]; }
        }''')
        self.assertEqual(result,[1,1])

    def open_converted_progress(self, metadata, height=lambda i: 1200 + i * 30, hold=()):
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                  + 'b' * 64 + '/1234567890abcdef/chapter-manifest.json')
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': i, 'path': f'chapters/chapter-{i:04d}.xhtml', **fields}
            for i, fields in enumerate(metadata, 1)
        ]}
        requested, held, released = [], {}, set()

        def fulfill_chapter(route, index):
            route.fulfill(content_type='text/html', body=(
                f'<h1>Chapter {index}</h1><p style="height:{height(index)}px">Body {index}</p>'))

        def release(index):
            released.add(index)
            route = held.pop(index, None)
            if route:
                fulfill_chapter(route, index)

        def resource(route):
            if 'chapter-manifest.json' in route.request.url:
                route.fulfill(json=manifest)
                return
            index = int(unquote(route.request.url).rsplit('chapter-', 1)[1].split('.', 1)[0])
            requested.append(index)
            if index in hold and index not in released:
                held[index] = route
            else:
                fulfill_chapter(route, index)

        self.expose()
        self.page.route('**/api/reader-bucket-resource**', resource)
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(
            dict(url=source, ext='epub-chapters')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        return requested, release

    def seek_converted(self, percent, chapter):
        self.assertTrue(self.page.evaluate('value=>{__ebook.progress(value);return __ebook.seekTask()}', percent))
        self.page.wait_for_function('([i,p])=>__ebook.captureChapter()?.chapterIndex===i && '
                                    'Math.abs(__ebook.percent()-p)<0.2', arg=[chapter, percent])
        self.assertAlmostEqual(float(self.page.locator('.reader-progress-range').input_value()), percent, delta=0.2)

    def test_converted_progress_uses_manifest_weights_through_loading_and_trimming(self):
        metadata = [{'bytes': 100} for _ in range(30)]
        metadata[17] = {'size': 6000}
        metadata[-1] = {'bytes': 1200}
        requested, release = self.open_converted_progress(metadata, hold=(17,))
        self.assertEqual(self.page.evaluate('__ebook.percent()'), 0)
        self.page.locator('.reader-epub-chapter[data-chapter="8"]').wait_for(state='attached')
        self.assertNotIn(18, requested)
        self.assertNotIn(30, requested)
        # 17% before chapter 18, plus half of its 60% share.
        with self.page.expect_request(lambda request: 'chapter-0017.xhtml' in request.url):
            self.seek_converted(47, 18)
        chapter = self.page.locator('.reader-epub-chapter[data-chapter="18"]')
        height = chapter.evaluate('node=>node.getBoundingClientRect().height')
        saved = self.page.evaluate('__ebook.captureChapter()')
        self.assertAlmostEqual(saved['chapterOffset'], height * 0.5, delta=2)
        release(17)
        self.page.locator('.reader-epub-chapter[data-chapter="17"]').wait_for(state='attached')
        self.page.locator('.reader-chapter-placeholder').first.wait_for(state='attached')
        self.assertEqual(self.page.evaluate('__ebook.percent()'), 47)
        # Scroll independently of seek: move the same marker to one-quarter into chapter 18.
        self.page.locator('#viewport').evaluate('(node,delta)=>{node.scrollTop-=delta}', height / 4)
        self.page.wait_for_function("()=>document.querySelector('.reader-progress-percent').textContent==='32.0%'")
        self.seek_converted(94, 30)  # Halfway through the reachable scroll span of the final chapter.
        self.seek_converted(100, 30)
        self.assertLessEqual(self.page.locator('#viewport').evaluate(
            'node=>node.scrollHeight-node.clientHeight-node.scrollTop'), 1)
        self.seek_converted(0, 1)
        self.assertEqual(self.page.locator('#viewport').evaluate('node=>node.scrollTop'), 0)
        self.assertTrue(self.page.evaluate('state=>__ebook.restoreProgress(state)', saved))
        self.assertAlmostEqual(self.page.evaluate('__ebook.captureChapter().chapterOffset'), saved['chapterOffset'], delta=2)
        self.assertEqual(self.page.evaluate('''async()=>{
          await __ebook.save();
          const entry = await VoiceOfMLReaderStore.get(__ebook.captureChapter().chapterManifest);
          return entry && {chapterIndex:entry.chapterIndex, chapterOffset:entry.chapterOffset,
                           chapterManifest:entry.chapterManifest};
        }'''), self.page.evaluate('__ebook.captureChapter()'))

    def test_converted_progress_falls_back_and_ignores_superseded_seek(self):
        metadata = [{'bytes': 100} for _ in range(30)]
        metadata[14] = {'bytes': 6000}
        metadata[-1] = {}
        _, release = self.open_converted_progress(metadata, hold=(15,))
        # Hold the equal-weight target until the later seek owns the viewport.
        with self.page.expect_request(lambda request: 'chapter-0015.xhtml' in request.url):
            self.page.evaluate('''()=>{__ebook.progress(48); window.__obsoleteSeek = __ebook.seekTask();}''')
        self.seek_converted(85, 26)
        release(15)
        self.assertFalse(self.page.evaluate('window.__obsoleteSeek'))
        self.assertEqual(self.page.evaluate('__ebook.captureChapter().chapterIndex'), 26)
        self.assertAlmostEqual(self.page.evaluate('__ebook.percent()'), 85, delta=0.2)

    def test_converted_progress_end_with_short_last_chapter_and_delayed_previous(self):
        metadata = [{'bytes': 100} for _ in range(30)]
        _, release = self.open_converted_progress(
            metadata, height=lambda i: 20 if i == 30 else 1500, hold=(29,))
        self.page.locator('.reader-epub-chapter[data-chapter="8"]').wait_for(state='attached')
        with self.page.expect_request(lambda request: 'chapter-0029.xhtml' in request.url):
            self.assertTrue(self.page.evaluate('()=>{__ebook.progress(100);return __ebook.seekTask()}'))
        self.page.wait_for_function("()=>document.querySelector('.reader-progress-percent').textContent==='100.0%'")
        release(29)
        self.page.locator('.reader-epub-chapter[data-chapter="29"]').wait_for(state='attached')
        self.page.wait_for_function('''()=>{const v=document.querySelector('#viewport');
          const last=document.querySelector('.reader-epub-chapter[data-chapter="30"]').getBoundingClientRect();
          return v.scrollHeight-v.clientHeight-v.scrollTop<=1 && last.bottom<=v.getBoundingClientRect().bottom
            && document.querySelector('.reader-progress-percent').textContent==='100.0%';}''')
        self.page.locator('#viewport').evaluate('''node=>{
          node.dispatchEvent(new WheelEvent('wheel', {deltaY:-500}));
          node.scrollTop -= 500;
        }''')
        self.page.wait_for_function('()=>__ebook.percent()<100')

    def test_converted_progress_end_when_book_fits_in_viewport(self):
        self.open_converted_progress([{'bytes': 100}], height=lambda _: 20)
        self.assertEqual(self.page.locator('#viewport').evaluate('node=>node.scrollHeight-node.clientHeight'), 0)
        self.assertEqual(self.page.evaluate('__ebook.percent()'), 0)
        self.seek_converted(100, 1)
        self.seek_converted(0, 1)

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

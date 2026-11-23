"""Shared chapter ebook loading and navigation regressions."""
import json
import unittest
from collections import Counter
from urllib.parse import unquote, urlencode
from tests.reader.browser import test_reader_pdf_followup as support


class EbookFlowTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

    def test_generated_volume_toc_lands_on_published_fragment(self):
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/mobi/'
                  + 'b' * 64 + '/1234567890abcdef/chapter-manifest.json')
        body = ['<h1>Opening</h1><p style="height:1200px">Earlier volume</p>',
                '<p id="wrong-but-valid">Earlier anchor</p>',
                '<p style="height:1100px">Title page offset</p><h1 id="volume:2">New volume</h1>'
                '<p style="height:1400px">Later text</p>']
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': i, 'path': f'chapters/chapter-{i:04d}.xhtml', 'bytes': len(raw)}
            for i, raw in enumerate(body, 1)], 'toc': [
            dict(title='Volume II', chapter=3, fragment='volume:2', depth=0),
            dict(title='Cover', chapter=3, fragment='volume:2', depth=1),
            dict(title='Title page', chapter=3, fragment='', depth=1)]}

        def resource(route):
            path = unquote(route.request.url)
            if path.endswith('chapter-manifest.json'):
                route.fulfill(json=manifest)
            else:
                i = int(path.rsplit('chapter-', 1)[1].split('.', 1)[0])
                route.fulfill(content_type='text/html', body=body[i - 1])

        self.expose()
        self.page.route('**/api/reader-bucket-resource**', resource)
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(
            dict(url=source, ext='epub-chapters')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.assertEqual(self.page.evaluate('() => __ebook.toc().map(e => [e.chapterIndex, e.fragment, e.depth])'),
                         [[3, 'volume:2', 0], [3, 'volume:2', 1], [3, '', 1]])
        for entry in (1, 2):
            self.assertTrue(self.page.evaluate('__ebook.chapter', entry))
            self.page.wait_for_function('''() => {
              const target = document.getElementById('volume:2');
              const viewport = document.querySelector('#viewport');
              return target && Math.abs(target.getBoundingClientRect().top -
                viewport.getBoundingClientRect().top) < 12;
            }''')

    def open_with_saved_chapter(self, index, manifest_revision, bookmark=False):
        source = 'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/restore.epub'
        endpoint = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?'
        path = 'chapters/ebook/epub/' + 'a' * 64 + '/1234567890abcdef/chapter-manifest.json'
        manifest_url = endpoint + 'path=' + path
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': i, 'path': f'chapters/chapter-{i:04d}.xhtml'} for i in (1, 2)
        ]}
        requested = []

        def resource(route):
            path = unquote(route.request.url)
            if path.endswith('chapter-manifest.json'):
                route.fulfill(json=manifest)
            else:
                requested.append(int(path.rsplit('chapter-', 1)[1].split('.', 1)[0]))
                route.fulfill(content_type='text/html', body='<h1>Chapter</h1><p style="height:1600px">Text</p>')

        self.page.route('**/api/reader-bucket-resource**', resource)
        reader_url = self.origin + support.PREFIX + '/static/reader.html'
        self.page.goto(reader_url)
        entry = {'url': source, 'chapterIndex': index, 'chapterOffset': 180}
        if manifest_revision == 'old':
            entry['chapterManifest'] = endpoint + urlencode({'path': path.replace('1234567890abcdef', '0123456789abcdef')})
        elif manifest_revision == 'current':
            # Same object as the current URL, but with an encoded path query value.
            entry['chapterManifest'] = endpoint + urlencode({'path': path})
        params = dict(url=source, ext='epub-chapters', chapter_manifest=manifest_url)
        if bookmark:
            entry['id'] = 'chapter-regression'
            params.update(bookmark=entry['id'], bookmark_source=source)
        self.page.evaluate('entry => entry.id ? VoiceOfMLReaderStore.putBookmark(entry) : VoiceOfMLReaderStore.put(entry)', entry)
        self.page.goto(reader_url + '?' + urlencode(params))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready' || "
                                    "document.querySelector('.reader-error')")
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready',
                         self.page.locator('.reader-error').all_text_contents())
        self.page.unroute('**/api/reader-bucket-resource**')
        position = self.page.evaluate('__ebook.captureChapter()')
        self.assertEqual(requested[0], position['chapterIndex'], requested)
        return position

    def test_obsolete_chapter_progress_does_not_block_opening(self):
        self.expose()
        for index, revision in [(9, 'old'), (9, 'current'), (9, None), (2, 'old')]:
            with self.subTest(index=index, revision=revision):
                self.assertEqual(self.open_with_saved_chapter(index, revision)['chapterIndex'], 1)

    def test_matching_chapter_positions_keep_their_offset(self):
        self.expose()
        for revision, bookmark in [(None, False), ('current', True)]:
            with self.subTest(revision=revision, bookmark=bookmark):
                position = self.open_with_saved_chapter(2, revision, bookmark)
                self.assertEqual(position['chapterIndex'], 2)
                self.assertAlmostEqual(position['chapterOffset'], 180, delta=2)

    def test_progress_end_before_manifest_keeps_saved_chapter_offset(self):
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                  + 'a' * 64 + '/1234567890abcdef/chapter-manifest.json')
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': i, 'path': f'chapters/chapter-{i:04d}.xhtml', 'bytes': 100} for i in (1, 2, 3)
        ]}
        pending = []

        def resource(route):
            if 'chapter-manifest.json' in route.request.url:
                pending.append(route)
            else:
                route.fulfill(content_type='text/html', body='<h1>Chapter</h1><p style="height:1600px">Text</p>')

        self.expose()
        self.page.route('**/api/reader-bucket-resource**', resource)
        reader_url = self.origin + support.PREFIX + '/static/reader.html'
        self.page.goto(reader_url)
        self.page.evaluate('entry => VoiceOfMLReaderStore.put(entry)',
                           dict(url=source, chapterManifest=source, chapterIndex=2, chapterOffset=180))
        with self.page.expect_request('**/api/reader-bucket-resource**chapter-manifest.json'):
            self.page.goto(reader_url + '?' + urlencode(dict(url=source, ext='epub-chapters')),
                           wait_until='domcontentloaded')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='prepare'")
        panel = self.page.locator('#history')
        if panel.get_attribute('aria-expanded') != 'true':
            panel.click()
        slider = self.page.get_by_role('slider', name='阅读进度')
        slider.wait_for(state='visible')
        was_disabled = slider.is_disabled()
        slider.press('End')
        # A direct caller must also leave the pending restoration alone.
        accepted = self.page.evaluate('__ebook.progress(100)')
        self.assertEqual(len(pending), 1)
        pending[0].fulfill(json=manifest)

        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        position = self.page.evaluate('__ebook.captureChapter()')
        self.assertEqual(position['chapterIndex'], 2)
        self.assertAlmostEqual(position['chapterOffset'], 180, delta=2)
        self.assertTrue(was_disabled)
        self.assertFalse(accepted)

        self.assertTrue(slider.is_enabled())
        slider.press('End')
        self.page.wait_for_function('()=>__ebook.percent()===100 && __ebook.captureChapter().chapterIndex===3')

    def test_legacy_v5_bookmark_requires_exact_manifest(self):
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html')
        self.assertEqual(self.page.evaluate('''async () => {
          const {createReaderChapterFormat} = await import('./reader/formats/reader-chapter-format.mjs');
          const {createReaderProgress, matchesChapterManifest} = await import('./reader/ui/reader-progress.mjs');
          const manifest = 'https://example.test/book-epub-chapters-v5/chapter-manifest.json';
          const url = 'https://example.test/book.epub', params = new URLSearchParams({bookmark:'v5', bookmark_source:url});
          let loads = 0;
          const context = {sourceUrl:url, chapterManifestUrl:manifest, capability:{mode:'epub-chapters'}, params,
            chapterManifestLoader:Object.assign(async () => { loads++; return null; }, {count:2}),
            isReaderGenerationCurrent:() => true, trustedReaderAssetManifestUrl:() => null};
          const {restoreChapterPosition} = createReaderChapterFormat(context);
          const {loadReaderRestoration} = createReaderProgress(context);
          const rows = [];
          for (const saved of [undefined, '', manifest + '?ignored=1', manifest]) {
            const bookmark = {id:'v5', url, chapterIndex:2, chapterManifest:saved};
            await VoiceOfMLReaderStore.putBookmark(bookmark);
            rows.push([!!(await loadReaderRestoration()), await restoreChapterPosition(bookmark, 0), loads]);
          }
          // Not an admitted shape today; an absent object path is never an identity match.
          return [rows, matchesChapterManifest('old', 'new', url => 'https://example.test/' + url)];
        }'''), [[[False, False, 0], [False, False, 0], [False, False, 0], [True, False, 1]], False])

    def test_stale_chapter_bookmark_falls_back_to_matching_history(self):
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html')
        self.assertEqual(self.page.evaluate('''async () => {
          const {createReaderProgress} = await import('./reader/ui/reader-progress.mjs');
          const url='https://example.test/book.chm';
          const current='https://example.test/v2/chapter-manifest.json';
          const old='https://example.test/v1/chapter-manifest.json';
          await VoiceOfMLReaderStore.put({url,chapterIndex:5,chapterOffset:180,chapterManifest:current});
          await VoiceOfMLReaderStore.putBookmark({url,id:'old',chapterIndex:7,chapterManifest:old});
          const context={sourceUrl:url,chapterManifestUrl:current,capability:{mode:'epub-chapters'},
            params:new URLSearchParams({bookmark:'old',bookmark_source:url}),
            trustedReaderAssetManifestUrl: value => value};
          const entry=await createReaderProgress(context).loadReaderRestoration();
          return [entry?.chapterIndex,entry?.chapterOffset,entry?.chapterManifest,
            (await VoiceOfMLReaderStore.listBookmarks(url)).length];
        }'''), [5, 180, 'https://example.test/v2/chapter-manifest.json', 1])

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
                toc:()=>navigationState.tocEntries,
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
                      const root=line.getRootNode(), box=line.closest('.reader-epub-chapter');
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

    def test_long_xhtml_binds_dense_toc_in_one_anchor_scan(self):
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                  + 'a' * 64 + '/1234567890abcdef/chapter-manifest.json')
        fragments = [f'section:{i}' for i in range(500)]
        anchors = ''.join(f'<p id="{fragment}">Section</p>' for fragment in fragments)
        chapter = ('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Dense TOC</title></head>'
                   '<body id="body-anchor"><h1>Opening XHTML</h1>' + '<p>Book prose</p>' * 24000 + anchors +
                   '<a name="shared" data-winner="first-name"></a><p id="shared">Later ID</p>'
                   '<p id="reversed">First ID</p><a name="reversed">Later name</a>'
                   '<p id="CR&#13;value" data-winner="CR"></p><a name="LF&#10;value" data-winner="LF"></a>'
                   '<p id="control&#127;value" data-winner="control"></p>'
                   '<p id="&#65533;" data-winner="replacement"></p><p id="&#128515;" data-winner="astral"></p>'
                   '<p id="body-anchor">Body ID takes priority</p><p style="height:1800px">End</p></body></html>')
        fragments += ['shared', 'reversed', 'body-anchor', 'section:0', 'SECTION:0', '',
                      'CR\rvalue', 'LF\nvalue', 'control\x7fvalue', '\0', '\ud800', '\U0001f603']
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': 1, 'path': 'chapters/chapter-0001.xhtml', 'bytes': len(chapter)}],
            'toc': [{'title': f'Row {i}', 'chapter': 1, 'depth': 0, 'fragment': fragment}
                    for i, fragment in enumerate(fragments)]}
        requested = []

        def resource(route):
            if 'chapter-manifest.json' in route.request.url:
                # Escape the lone surrogate in the wire JSON, not in the parsed manifest.
                route.fulfill(content_type='application/json', body=json.dumps(manifest, ensure_ascii=True))
            else:
                requested.append(route.request.url)
                route.fulfill(content_type='application/xhtml+xml', body=chapter)

        self.expose()
        self.page.route('**/api/reader-bucket-resource**', resource)
        self.page.add_init_script('''(() => {
          window.__anchorScans = [0, 0];
          for (const [index, method] of ['querySelector', 'querySelectorAll'].entries()) {
            const native = Element.prototype[method];
            Element.prototype[method] = function (selector) {
              if (this.matches('article.reader-epub-chapter') &&
                  (selector.startsWith('[id=') || selector === '[id], [name]')) __anchorScans[index]++;
              return native.call(this, selector);
            };
          }
        })()''')
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(
            dict(url=source, ext='epub-chapters')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.assertTrue(self.page.get_by_role('heading', name='Opening XHTML').is_visible())
        self.assertEqual(len(requested), 1)
        # Count selector passes on the mounted chapter, not elapsed time.
        # Only NUL and the lone surrogate should fall back to CSS.escape.
        scans = self.page.evaluate('__anchorScans')
        targets = self.page.evaluate('''() => {
          const article = document.querySelector('.reader-epub-chapter');
          return __ebook.toc().map(({target, fragment}) => {
            const legacy = !fragment || fragment === article.id ? article :
              article.querySelector(`[id="${CSS.escape(fragment)}"], [name="${CSS.escape(fragment)}"]`);
            if (target !== legacy || (target && !target.isConnected)) return 'mismatch';
            return target === article ? 'article' : (target?.dataset.winner || target?.id || null);
          });
        }''')
        self.assertEqual(targets, fragments[:500] + ['first-name', 'reversed', 'article', 'section:0', None,
                         'article', 'CR', 'LF', 'control', 'replacement', None, 'astral'])
        self.assertEqual(scans, [2, 1])
        # On-demand fragment navigation must still land on the same first match.
        self.assertTrue(self.page.evaluate('__ebook.chapter(501)'))
        self.assertLess(abs(self.page.locator('[data-winner="first-name"]').evaluate('''node =>
            node.getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top
        ''')), 3)
        self.assertEqual(len(requested), 1)

    def test_first_chapter_row_bookkeeping_does_not_query_prose(self):
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                  + 'a' * 64 + '/1234567890abcdef/chapter-manifest.json')
        chapter = '<h1>Opening chapter</h1>' + '<p>Book prose</p>' * 24000
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': i, 'path': f'chapters/chapter-{i:04d}.xhtml', 'bytes': len(chapter)} for i in (1, 2)]}

        def resource(route):
            if 'chapter-manifest.json' in route.request.url:
                route.fulfill(json=manifest)
            elif 'chapter-0001.xhtml' in route.request.url:
                route.fulfill(content_type='text/html', body=chapter)
            # Keep chapter two pending so its sentinel remains in the frame.

        self.page.route('**/api/reader-bucket-resource**', resource)
        self.page.add_init_script('''(() => {
          window.__populatedFrameRowQueries = [];
          for (const method of ['querySelector', 'querySelectorAll']) {
            const native = Element.prototype[method];
            Element.prototype[method] = function (selector) {
              if (this.classList.contains('epub-frame') && this.childElementCount > 1 &&
                  document.documentElement.dataset.readerPhase !== 'ready' &&
                  /reader-(epub-chapter|chapter-sentinel)/.test(selector)) {
                __populatedFrameRowQueries.push([method, selector]);
              }
              return native.call(this, selector);
            };
          }
        })()''')
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(
            dict(url=source, ext='epub-chapters')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.assertTrue(self.page.get_by_role('heading', name='Opening chapter').is_visible())
        self.assertEqual(self.page.locator('.epub-frame > [data-chapter]').evaluate_all(
            'rows => rows.map(row => [row.tagName, row.dataset.chapter])'), [['ARTICLE', '1'], ['BUTTON', '2']])
        self.assertEqual(self.page.evaluate('__populatedFrameRowQueries'), [])

    def test_merged_chm_repairs_dense_toc_without_per_anchor_selectors(self):
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/chm/'
                  + 'a' * 64 + '/1234567890abcdef/chapter-manifest.json')
        count = 400
        links = ''.join(f'<a href="#chm-page-{i}">Section {i}</a>' for i in range(1, count + 1))
        anchors = ''.join(f'<p id="chm-page-{i}">Section {i}</p>' for i in range(1, count - 1))
        body = ('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Opening CHM</h1>' + links +
                '<a href="#chm-page-1">Section 1</a>' +  # Repeated links to the same page agree.
                f'<a href="#chm-page-{count + 1}">Ambiguous</a><a href="#chm-page-1">Ambiguous</a>' +
                f'<a href="#chm-page-{count + 2}">Duplicate anchor</a>' +
                '<p>Book prose</p>' * 24000 + anchors +
                f'<a name="chm-page-{count - 1}">Name only</a>' +
                f'<a id="chm-page-{count}" name="chm-page-{count}">One node with both attributes</a>' +
                f'<p id="chm-page-{count + 2}"></p><a name="chm-page-{count + 2}"></a>' +
                '<p style="height:1800px">End</p></body></html>')
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': 1, 'path': 'chapters/chapter-0001.xhtml', 'source_path': 'nested/chm-fallback.html',
             'bytes': len(body)}], 'toc': [
            {'title': label, 'chapter': 1, 'depth': 0, 'fragment': {
                'Section 1': 'stale-anchor', 'Section 2': 'chm-page-3'}.get(label, '')}
            for label in [f'Section {i}' for i in range(1, count + 1)] + ['Ambiguous', 'Duplicate anchor']]}
        self.expose()
        self.page.route('**/api/reader-bucket-resource**', lambda route: route.fulfill(json=manifest)
            if 'chapter-manifest.json' in route.request.url else route.fulfill(
                content_type='application/xhtml+xml', body=body))
        self.page.add_init_script('''(() => {
          window.__chmAnchorScans = [0, 0];
          for (const [index, method] of ['querySelector', 'querySelectorAll'].entries()) {
            const native = Element.prototype[method];
            Element.prototype[method] = function (selector) {
              if (this.matches('article.reader-epub-chapter') &&
                  (selector.startsWith('[id="chm-page-') || selector === '[id], [name]')) __chmAnchorScans[index]++;
              return native.call(this, selector);
            };
          }
        })()''')
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(
            dict(url=source, ext='epub-chapters')))
        self.page.locator('html[data-reader-phase="ready"]').wait_for()
        self.assertTrue(self.page.get_by_role('heading', name='Opening CHM').is_visible())
        scans = self.page.evaluate('__chmAnchorScans.slice()')
        expected = [[f'chm-page-{i}', f'chm-page-{i}'] for i in range(1, count + 1)] + [['', '1']] * 2
        expected[1] = ['chm-page-3', 'chm-page-3']  # Working explicit target beats the label match.
        self.assertEqual(self.page.evaluate('''() => __ebook.toc().map(({fragment, target}) =>
            [fragment, target?.isConnected && (target.id || target.getAttribute('name') || target.dataset.chapter)])
        '''), expected)
        self.page.locator('#toc-list').get_by_role('link', name=f'Section {count - 1}', exact=True).click()
        self.page.wait_for_function('''count => {
          const anchor = document.querySelector(`.reader-epub-chapter [name="chm-page-${count - 1}"]`);
          return Math.abs(anchor.getBoundingClientRect().top - document.querySelector('#viewport').getBoundingClientRect().top) < 3;
        }''', arg=count)
        # One census for fragment repair, one for dense TOC binding, and no
        # per-anchor selectors until the user deliberately navigates.
        self.assertEqual(scans, [0, 2])

    def test_chapter_rewrites_resource_attributes_without_revisiting_prose(self):
        base = 'chapters/ebook/epub/' + 'a' * 64 + '/1234567890abcdef/'
        endpoint = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?'
        source = endpoint + urlencode({'path': base + 'chapter-manifest.json'})
        prose = '<p class="rewrite-prose">Plain chapter paragraph</p>' * 500
        chapter = '''<h1 id="target">Chapter</h1>
          <a id="jump" href="#target">Jump to heading</a>
          <img id="cover" src="../resources/cover.svg" srcset="../resources/other.svg 2x" />
          <img id="only-srcset" srcset="../resources/other.svg 2x" />
          <video id="poster" poster="../resources/cover.svg"></video>
          <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
            <image id="svg-modern" href="../resources/cover.svg" width="5" height="5" />
            <image id="svg-legacy" xlink:href="../resources/cover.svg" width="5" height="5" />
          </svg><span id="legacy" xlink:href="../resources/cover.svg">Legacy link</span>''' + prose
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': 1, 'path': 'chapters/chapter-0001.xhtml', 'bytes': len(chapter.encode())}]}
        def resource(route):
            path = unquote(route.request.url)
            if path.endswith('chapter-manifest.json'):
                route.fulfill(json=manifest)
            elif path.endswith('.svg'):
                route.fulfill(content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg"/>')
            else:
                route.fulfill(content_type='text/html', body=chapter)
        self.page.route('**/api/reader-bucket-resource**', resource)
        self.page.add_init_script('''(() => {
          window.__proseRewriteChecks=0;
          const has=Element.prototype.hasAttribute;
          Element.prototype.hasAttribute=function(name){
            if(name==='src' && this.className==='rewrite-prose' && this.ownerDocument!==document)
              window.__proseRewriteChecks++;
            return has.call(this,name);
          };
        })()''')
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(
            dict(url=source, ext='epub-chapters')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        self.assertEqual(self.page.locator('.rewrite-prose').count(), 500)
        self.assertEqual(self.page.evaluate('window.__proseRewriteChecks'), 0)
        self.assertEqual(self.page.locator('#jump').get_attribute('href'), '#target')
        cover = endpoint + urlencode({'path': base + 'resources/cover.svg'})
        for selector, attr in (('#cover', 'src'), ('#poster', 'poster'), ('#svg-modern', 'href'),
                               ('#svg-legacy', 'xlink:href'), ('#legacy', 'xlink:href')):
            with self.subTest(selector=selector):
                self.assertEqual(self.page.locator(selector).get_attribute(attr), cover)
        for selector in ('#cover', '#only-srcset'):
            self.assertIsNone(self.page.locator(selector).get_attribute('srcset'))

    def test_first_chapter_reuses_trusted_asset_bases(self):
        base = 'chapters/ebook/epub/' + 'a' * 64 + '/1234567890abcdef/'
        endpoint = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?'
        source = endpoint + urlencode({'path': base + 'chapter-manifest.json'})
        chapter_path = 'chapters/chapter-0001.xhtml'
        chapter_url = endpoint + urlencode({'path': base + chapter_path})
        other_revision = '/' + base.replace('1234567890abcdef', '0123456789abcdef')
        body = ('<h1 id="start">Opening chapter</h1>' +
                '<p><a href="#start">Back to heading</a><span poster="../resources/cover.svg">Text</span></p>' * 240 +
                f'<span id="other-revision" poster="{other_revision}resources/cover.svg">Text</span>')
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': 1, 'path': chapter_path, 'bytes': len(body)}]}
        self.page.route('**/api/reader-bucket-resource**', lambda route: route.fulfill(json=manifest)
            if 'chapter-manifest.json' in route.request.url else route.fulfill(content_type='text/html', body=body))

        def count_base_parses(route):
            response = route.fetch()
            script = response.text()
            needle = 'const url = new URL(raw, location.href);'
            self.assertEqual(script.count(needle), 1)
            route.fulfill(response=response, body=script.replace(needle,
                'window.__chapterBaseParses.push(raw);\n      ' + needle))

        self.page.route('**/static/reader/core/reader-source.mjs*', count_base_parses)
        self.page.add_init_script('window.__chapterBaseParses = []')
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(
            dict(url=source, ext='epub-chapters')))
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
        article = self.page.locator('.reader-epub-chapter')
        self.assertTrue(article.locator('h1').is_visible())
        self.assertEqual(article.locator('a[href="#start"]').count(), 240)
        cover = endpoint + urlencode({'path': base + 'resources/cover.svg'})
        self.assertEqual(article.locator(f'span[poster="{cover}"]').count(), 240)
        self.assertIsNone(article.locator('#other-revision').get_attribute('poster'))
        # Count actual base parser calls, not all destination URL resolutions.
        self.assertEqual(Counter(self.page.evaluate('window.__chapterBaseParses')), {source: 1, chapter_url: 1})

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

    def open_converted_progress(self, metadata, height=lambda i: 1200 + i * 30, hold=(), *,
                                wait_for_ready=True, saved_chapter=None):
        source = ('https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/'
                  + 'b' * 64 + '/1234567890abcdef/chapter-manifest.json')
        manifest = {'version': 1, 'kind': 'epub-chapters', 'chapters': [
            {'index': i, 'path': f'chapters/chapter-{i:04d}.xhtml', **fields}
            for i, fields in enumerate(metadata, 1)
        ]}
        requested, held, released = [], {}, {}

        def fulfill_chapter(route, index):
            status = released.get(index, 200)
            route.fulfill(status=status, content_type='text/html', body=(
                f'<h1>Chapter {index}</h1><p style="height:{height(index)}px">Body {index}</p>'))

        def release(index, status=200):
            released[index] = status
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
        reader_url = self.origin + support.PREFIX + '/static/reader.html'
        if saved_chapter is not None:
            self.page.goto(reader_url)
            self.page.evaluate('entry => VoiceOfMLReaderStore.put(entry)', dict(
                url=source, chapterManifest=source, chapterIndex=saved_chapter, chapterOffset=180))
        self.page.goto(reader_url + '?' + urlencode(dict(url=source, ext='epub-chapters')),
                       wait_until='domcontentloaded')
        if wait_for_ready:
            self.page.locator('html[data-reader-phase="ready"]').wait_for()
        return requested, release

    def start_end_seek_during_opening(self, hold=(1, 20), saved_chapter=None):
        requested, release = self.open_converted_progress(
            [{'bytes': 100}] * 20, hold=hold, wait_for_ready=False, saved_chapter=saved_chapter)
        self.page.locator('.reader-epub-chapter[data-chapter="3"]').wait_for(state='attached')
        self.assertIn(saved_chapter or 1, requested)
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'prepare')
        panel = self.page.locator('#history')
        if panel.get_attribute('aria-expanded') != 'true':
            panel.click()
        slider = self.page.get_by_role('slider', name='阅读进度')
        self.assertTrue(slider.is_enabled())
        with self.page.expect_request(lambda request: 'chapter-0020.xhtml' in request.url):
            slider.press('End')
        return release

    def assert_opening_end_landing(self):
        self.assertTrue(self.page.evaluate('__ebook.seekTask()'))
        self.assertEqual(self.page.evaluate('__ebook.captureChapter().chapterIndex'), 20)
        self.assertEqual(self.page.evaluate('__ebook.percent()'), 100)

    def test_end_seek_landing_survives_late_opening_chapter_404(self):
        release = self.start_end_seek_during_opening()
        release(20)
        self.assert_opening_end_landing()
        self.page.locator('html[data-reader-phase="ready"]').wait_for()
        release(1, status=404)
        self.page.locator('.reader-chapter-load-error[data-chapter="1"], .reader-error').first.wait_for(state='attached')
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.assertEqual(self.page.locator('.reader-error').count(), 0)
        self.assert_opening_end_landing()

    def test_opening_chapter_404_waits_for_pending_end_seek_to_land(self):
        release = self.start_end_seek_during_opening()
        release(1, status=404)
        self.page.locator('.reader-chapter-load-error[data-chapter="1"]').wait_for(state='attached')
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'prepare')
        release(20)
        self.page.locator('html[data-reader-phase="ready"]').wait_for()
        self.assert_opening_end_landing()
        self.assertEqual(self.page.locator('.reader-error').count(), 0)

    def test_failed_end_seek_does_not_hide_failed_saved_chapter_or_overwrite_progress(self):
        release = self.start_end_seek_during_opening(hold=(2, 20), saved_chapter=2)
        release(20, status=404)
        self.assertFalse(self.page.evaluate('__ebook.seekTask()'))
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'prepare')
        release(2, status=404)
        self.page.locator('.reader-error').wait_for()
        self.assertEqual(self.page.locator('#content').get_attribute('data-error-code'), 'READER_RESTORE')
        self.assertEqual(self.page.evaluate('''async () => {
          const {chapterIndex, chapterOffset} = await VoiceOfMLReaderStore.get(new URL(location.href).searchParams.get('url'));
          return [chapterIndex, chapterOffset];
        }'''), [2, 180])

    def test_superseded_end_seek_cannot_keep_failed_opening_pending(self):
        release = self.start_end_seek_during_opening(hold=(1, 16, 20))
        release(1, status=404)
        self.page.locator('.reader-chapter-load-error[data-chapter="1"]').wait_for(state='attached')
        with self.page.expect_request(lambda request: 'chapter-0016.xhtml' in request.url):
            self.assertTrue(self.page.evaluate('__ebook.progress(75)'))
        release(16, status=404)
        self.assertFalse(self.page.evaluate('__ebook.seekTask()'))
        # The obsolete End request is still held, but it can no longer land.
        self.page.locator('.reader-error').wait_for()
        self.assertEqual(self.page.locator('#content').get_attribute('data-error-code'), 'READER_NETWORK')

    def test_scroll_intent_cancels_pending_end_seek_without_rescuing_opening(self):
        release = self.start_end_seek_during_opening()
        release(1, status=404)
        self.page.locator('.reader-chapter-load-error[data-chapter="1"]').wait_for(state='attached')
        self.page.locator('#viewport').dispatch_event('wheel', {'deltaY': 120})
        # No replacement chapter navigation starts; the abandoned seek must not block failure.
        self.page.locator('.reader-error').wait_for()
        self.assertFalse(self.page.evaluate('__ebook.seekTask()'))
        self.assertEqual(self.page.locator('#content').get_attribute('data-error-code'), 'READER_NETWORK')

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

    def test_chapter_history_captures_the_virtual_placeholder_under_the_marker(self):
        self.open_converted_progress([{'bytes':100}, {'bytes':100}], height=lambda _: 1300)
        state = self.page.evaluate('''async () => {
          const article = document.querySelector('.reader-epub-chapter[data-chapter="1"]');
          const next = document.querySelector('.epub-frame > [data-chapter="2"]');
          const frame = article.parentElement, viewport = document.querySelector('#viewport');
          const row = document.createElement('button');
          row.className = 'reader-chapter-sentinel reader-chapter-placeholder';
          row.dataset.chapter = '1'; row.style.height = `${article.getBoundingClientRect().height}px`;
          article.replaceWith(row);
          if (next && next.tagName !== 'ARTICLE') {
            const second=document.createElement('article');
            second.className='reader-epub-chapter'; second.dataset.chapter='2';
            second.style.height='1300px'; next.replaceWith(second);
          }
          if (!next) {
            const second=document.createElement('article');
            second.className='reader-epub-chapter'; second.dataset.chapter='2';
            second.style.height='1300px'; frame.appendChild(second);
          }
          viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 90;
          const position = __ebook.captureChapter();
          await __ebook.save();
          const entry = await VoiceOfMLReaderStore.get(position.chapterManifest);
          return [position.chapterIndex, position.chapterOffset, entry?.chapterIndex];
        }''')
        self.assertEqual(state[0], 1)
        self.assertGreaterEqual(state[1], 80)
        self.assertEqual(state[2], 1)

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

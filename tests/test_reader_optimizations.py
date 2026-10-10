"""Focused offline acceptance for Reader scheduling, retention and text reuse."""

import gzip
import hashlib
import io
import json
import unittest
import urllib.parse
import zipfile

from tests import test_reader_refactor as fixtures


@unittest.skipIf(fixtures.support.sync_playwright is None, "Playwright is unavailable")
class ReaderOptimizationTests(unittest.TestCase):
    setUpClass = classmethod(fixtures.ReaderRefactorTest.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.ReaderRefactorTest.tearDownClass.__func__)
    setUp = fixtures.ReaderRefactorTest.setUp
    tearDown = fixtures.ReaderRefactorTest.tearDown
    reader_url = fixtures.ReaderRefactorTest.reader_url
    serve = fixtures.ReaderRefactorTest.serve
    open = fixtures.ReaderRefactorTest.open
    search = fixtures.ReaderRefactorTest.search

    def expose(self):
        def instrument(route):
            response = route.fetch()
            script = response.text().replace('chapterManifestCleanup = () => {', '''
              window.__chapterStats = () => ({active: chapterScheduler.activeCount,
                pending: chapterScheduler.pendingCount, bytes: chapterBudget.used});
              chapterManifestCleanup = () => {''')
            route.fulfill(response=response, body=script + '''
              window.__snapshot = () => fullSearchDomSnapshot;
              window.__query = async query => {
                fullSearchInput.value = query;
                await runFullSearch();
                return chapterSearchPage?.total || 0;
              };
              window.__goChapter = index => navigationState.tocEntries[index-1].activate(beginReaderNavigation());
              window.__walkProbe = () => {
                const doc = (htmlFrame?.contentDocument?.body || content).ownerDocument;
                const native = doc.createTreeWalker.bind(doc);
                window.__visits = 0;
                doc.createTreeWalker = (...args) => {
                  const walker = native(...args), next = walker.nextNode.bind(walker);
                  walker.nextNode = () => { __visits++; return next(); };
                  return walker;
                };
              };
            ''')
        self.page.route('**/static/reader.js?*', instrument)

    def chapter_book(self, hold=False):
        self.expose()
        base = 'https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/' + 'a' * 64 + '/'
        chapters, texts, bodies = [], [], {}
        for index in range(1, 61):
            path = f'chapter-{index}.xhtml'
            body = f'<h1 id="heading-{index}">Chapter {index}</h1><p style="height:1600px">needle unique-{index}</p>'
            bodies[base + path] = body
            chapters.append(dict(index=index, path=path, title=f'Chapter {index}', bytes=len(body)))
            texts.append(dict(index=index, path=path, title=f'Chapter {index}', text=f'Chapter {index} needle unique-{index}'))
        packed = gzip.compress(json.dumps(dict(version=1, kind='epub-search-index', chapters=texts)).encode(), mtime=0)
        manifest = dict(version=1, kind='epub-chapters', chapters=chapters,
                        search_index=dict(path='epub-search-index.json.gz', bytes=len(packed), sha256=hashlib.sha256(packed).hexdigest()))
        requested, held = [], []
        def resource(route):
            raw = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)['url'][0]
            requested.append(raw)
            if hold and raw in (base + 'chapter-2.xhtml', base + 'chapter-3.xhtml'):
                held.append(route)
            elif raw.endswith('chapter-manifest.json'):
                route.fulfill(json=manifest, headers={'Access-Control-Allow-Origin': '*'})
            elif raw.endswith('epub-search-index.json.gz'):
                route.fulfill(body=packed, content_type='application/gzip', headers={'Access-Control-Allow-Origin': '*'})
            else:
                route.fulfill(body=bodies[raw], content_type='text/html', headers={'Access-Control-Allow-Origin': '*'})
        self.context.route('**/api/reader-content**', resource)
        self.open(self.reader_url('epub-chapters', url=base + 'chapter-manifest.json'))
        return requested, held

    def test_chapter_demand_overtakes_stalled_prefetch_and_close_cancels_queue(self):
        requested, held = self.chapter_book(hold=True)
        self.page.expose_function('__heldCount', lambda: len(held))
        self.page.wait_for_function('async () => await __heldCount() === 2')
        self.assertEqual(self.page.evaluate('__chapterStats().active'), 2)
        self.assertEqual(len(held), 2)
        self.assertTrue(self.page.evaluate('__goChapter(40)'))
        self.assertTrue(any(url.endswith('chapter-40.xhtml') for url in requested))
        self.assertEqual(self.page.locator('.reader-epub-chapter[data-chapter="2"]').count(), 0)
        self.page.evaluate('window.dispatchEvent(new Event("voice-reader-dispose"))')
        self.page.wait_for_function('() => __chapterStats().active === 0 && __chapterStats().pending === 0')
        for route in held:
            route.abort()
        self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'disposed')
        self.assertEqual(self.page.evaluate('__chapterStats().bytes'), 0)

    def test_chapter_window_preserves_geometry_selection_and_complete_search(self):
        requested, _held = self.chapter_book()
        for width in (1100, 390):
            with self.subTest(width=width):
                self.page.set_viewport_size(dict(width=width, height=800))
                for chapter in (1, 10, 20, 30, 40, 50, 60):
                    self.assertTrue(self.page.evaluate('__goChapter', chapter))
                    self.page.wait_for_function('() => document.querySelectorAll(".reader-epub-chapter").length <= 12 && __chapterStats().pending === 0')
                self.assertGreater(self.page.locator('.reader-chapter-placeholder').count(), 0)
                self.assertTrue(self.page.evaluate('__goChapter(1)'))
                self.page.wait_for_function('() => __chapterStats().pending === 0')
                self.page.evaluate('async () => {await __goChapter(3); await __goChapter(2); await __goChapter(1);}')
                self.page.evaluate('''() => {
                  window.__pinned = document.querySelector('.reader-epub-chapter[data-chapter="1"]');
                  window.__pinnedMiddle = document.querySelector('.reader-epub-chapter[data-chapter="2"]');
                  const range = document.createRange();
                  range.setStart(__pinned.querySelector('p').firstChild, 0);
                  range.setEnd(document.querySelector('.reader-epub-chapter[data-chapter="3"] p').firstChild, 3);
                  getSelection().removeAllRanges(); getSelection().addRange(range);
                }''')
                self.assertTrue(self.page.evaluate('__goChapter(60)'))
                self.page.wait_for_function('() => __chapterStats().pending === 0')
                self.assertTrue(self.page.evaluate('__pinned.isConnected'))
                self.assertTrue(self.page.evaluate('__pinnedMiddle.isConnected'))
                self.page.evaluate('getSelection().removeAllRanges(); document.querySelector("#viewport").dispatchEvent(new Event("scroll"))')
                self.assertTrue(self.page.evaluate('__goChapter(30)'))
                self.page.wait_for_function('() => __chapterStats().pending === 0')
                self.page.wait_for_function('() => !__pinned.isConnected')
                marker = self.page.locator('.reader-chapter-placeholder[data-chapter="1"]')
                self.assertGreater(marker.evaluate('node => node.getBoundingClientRect().height'), 1600)
                before = self.page.locator('#viewport').evaluate('node => node.scrollHeight')
                before_rows = self.page.locator('.epub-frame > [data-chapter]').evaluate_all('nodes => nodes.map(node => [node.dataset.chapter, node.className, node.getBoundingClientRect().height, node.offsetTop])')
                if width == 1100:
                    self.page.route('**/*chapter-1.xhtml', lambda route: route.fulfill(status=503, body='temporary fixture failure'))
                    self.assertTrue(self.page.evaluate('async () => {try {await __goChapter(1); return false;} catch (_) {return true;}}'))
                    self.assertGreater(marker.evaluate('node => node.getBoundingClientRect().height'), 1600)
                    self.page.unroute('**/*chapter-1.xhtml')
                self.assertTrue(self.page.evaluate('__goChapter(1)'))
                self.page.wait_for_function('() => __chapterStats().pending === 0')
                after = self.page.locator('#viewport').evaluate('node => node.scrollHeight')
                after_rows = self.page.locator('.epub-frame > [data-chapter]').evaluate_all('nodes => nodes.map(node => [node.dataset.chapter, node.className, node.getBoundingClientRect().height, node.offsetTop])')
                self.assertAlmostEqual(before, after, delta=3, msg=json.dumps(dict(before=before_rows, after=after_rows)))
        self.assertEqual(self.page.evaluate('__query("needle")'), 60)
        self.search('needle')
        self.page.locator('.full-search-result').first.click()
        self.page.wait_for_function('() => document.querySelector(".reader-epub-chapter[data-chapter=\\"1\\"] mark")')
        self.assertEqual(self.page.locator('mark.full-search-highlight').text_content(), 'needle')
        self.assertGreater(sum(url.endswith('chapter-1.xhtml') for url in requested), 1)

    def docx_url(self):
        return self.reader_url('docx', url='https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/' + 'a' * 64 + '/document.docx')

    def image_docx(self, image=None, repeats=3, font=None):
        support = fixtures.support
        with zipfile.ZipFile(io.BytesIO(support.minimal_docx())) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        files['[Content_Types].xml'] = files['[Content_Types].xml'].decode().replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>')
        files['word/_rels/document.xml.rels'] = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>'
        files['word/media/image.png'] = image if image is not None else support.PNG_BYTES
        drawing = '''<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1524000" cy="762000"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="image"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1524000" cy="762000"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'''
        files['word/document.xml'] = files['word/document.xml'].decode().replace('<w:sectPr/>', drawing * repeats + '<w:sectPr/>')
        if font is not None:
            files['[Content_Types].xml'] = files['[Content_Types].xml'].replace('</Types>', '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/></Types>')
            files['word/_rels/document.xml.rels'] = files['word/_rels/document.xml.rels'].replace('</Relationships>', '<Relationship Id="fontTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/></Relationships>')
            files['word/fontTable.xml'] = '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:font w:name="FixtureFont"><w:embedRegular r:id="font" w:fontKey="{00000000-0000-0000-0000-000000000000}"/></w:font></w:fonts>'
            files['word/_rels/fontTable.xml.rels'] = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="font" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font.odttf"/></Relationships>'
            files['word/fonts/font.odttf'] = font
            files['word/document.xml'] = files['word/document.xml'].replace('<w:r><w:t>', '<w:r><w:rPr><w:rFonts w:ascii="FixtureFont" w:hAnsi="FixtureFont"/></w:rPr><w:t>')
        return support.zip_bytes(files)

    def test_real_docx_images_use_owned_blob_urls_and_release_on_close(self):
        self.page.add_init_script('''window.__created = []; window.__revoked = [];
          const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
          URL.createObjectURL = blob => { const url=create(blob); __created.push(url); return url; };
          URL.revokeObjectURL = url => { __revoked.push(url); return revoke(url); };''')
        font = (fixtures.support.ROOT / 'static/vendor/standard_fonts/LiberationSans-Regular.ttf').read_bytes()
        self.serve(self.image_docx(font=font), 'application/octet-stream')
        self.open(self.docx_url())
        self.page.wait_for_function('() => document.querySelectorAll(".docx-body img").length === 3 && [...document.querySelectorAll(".docx-body img")].every(image => image.naturalWidth > 0)')
        self.assertTrue(all(url.startswith('blob:') for url in self.page.locator('.docx-body img').evaluate_all('images => images.map(image => image.src)')))
        self.assertEqual(self.page.evaluate('__revoked.length'), 0)
        self.assertEqual(self.page.evaluate('async () => (await document.fonts.load("16px FixtureFont")).length'), 1)
        self.assertTrue(self.page.evaluate('[...document.fonts].some(font => font.family === "FixtureFont" && font.status === "loaded")'))
        self.assertEqual(self.page.evaluate('__created.length'), 2)
        self.page.evaluate('window.dispatchEvent(new Event("voice-reader-dispose"))')
        self.assertEqual(self.page.evaluate('__created.slice().sort()'), self.page.evaluate('__revoked.slice().sort()'))

    def test_docx_failure_and_late_render_cannot_leak_blob_assets(self):
        script = '''window.docx = {
          parseAsync: async () => ({blobToURL: blob => URL.createObjectURL(blob)}),
          renderDocument: async doc => {
            window.__ownedUrl = doc.blobToURL(new Blob(['font']), 'font.ttf');
            window.__lateBlob = () => doc.blobToURL(new Blob(['late']), 'image.png');
            if (location.search.includes('hold=1')) await new Promise(resolve => {window.__releaseDocx = resolve;});
            throw new Error('render fixture failure');
          }
        };'''
        self.page.route('**/static/vendor/docx-preview.min.*.js', lambda route: route.fulfill(content_type='text/javascript', body=script))
        self.page.add_init_script('''window.__revoked = []; const revoke=URL.revokeObjectURL.bind(URL);
          URL.revokeObjectURL = url => {__revoked.push(url); revoke(url);};''')
        self.serve(fixtures.support.minimal_docx(), 'application/octet-stream')
        for hold in (False, True):
            with self.subTest(hold=hold):
                self.page.goto(self.docx_url() + ('&hold=1' if hold else ''))
                self.page.wait_for_function('() => !!window.__ownedUrl')
                if hold:
                    self.page.evaluate('window.dispatchEvent(new Event("voice-reader-dispose")); __releaseDocx()')
                else:
                    self.page.wait_for_function('() => document.documentElement.dataset.readerPhase === "failed"')
                self.assertEqual(self.page.evaluate('__revoked'), [self.page.evaluate('__ownedUrl')])
                self.assertIsNone(self.page.evaluate('__lateBlob()'))

    def test_dom_snapshot_reuses_text_after_highlights_and_invalidates_external_edits(self):
        self.expose()
        body = '<p><span>nee</span><b>dle</b> otherword</p>' + '<p>ordinary</p>' * 4000 + '<p>tail needle</p>'
        for extension in ('html', 'md', 'txt', 'docx'):
            with self.subTest(extension=extension):
                if extension == 'docx':
                    self.page.route('**/static/vendor/docx-preview.min.*.js', lambda route: route.fulfill(content_type='text/javascript', body='window.docx={parseAsync:async()=>({blobToURL:()=>null}),renderDocument:async()=>{const node=document.createElement("div");node.innerHTML=' + json.dumps(body) + ';return [node];}};'))
                    self.serve(fixtures.support.minimal_docx(), 'application/octet-stream')
                    self.open(self.docx_url())
                else:
                    self.serve('needle otherword\n' + 'ordinary\n' * 4000 + 'tail needle' if extension == 'txt' else body)
                    self.open(self.reader_url(extension))
                self.assertEqual(self.page.evaluate('__query("needle")'), 2)
                self.page.evaluate('window.__originalSnapshot = __snapshot(); __walkProbe()')
                self.assertEqual(self.page.evaluate('__query("otherword")'), 1)
                self.assertTrue(self.page.evaluate('__snapshot() === __originalSnapshot'))
                self.assertLess(self.page.evaluate('__visits'), 10)
                self.assertEqual(self.page.evaluate('__query("needle")'), 2)
                self.assertEqual(self.page.evaluate('''() => {
                  const root = document.querySelector('.html-frame')?.contentDocument.body || document.querySelector('#content');
                  setTimeout(() => root.prepend(root.ownerDocument.createTextNode('prefix needle ')), 0);
                  return __query('needle');
                }'''), 3)
                self.page.evaluate('''() => {
                  const root = document.querySelector('.html-frame')?.contentDocument.body || document.querySelector('#content');
                  root.append(root.ownerDocument.createTextNode(' added needle'));
                }''')
                self.assertEqual(self.page.evaluate('__query("needle")'), 4)
                self.assertFalse(self.page.evaluate('__snapshot() === __originalSnapshot'))
                self.page.evaluate('window.dispatchEvent(new Event("voice-reader-dispose"))')
                self.assertTrue(self.page.evaluate('__snapshot() === null'))

    def test_oversized_dom_snapshot_is_uncached_without_losing_matches(self):
        self.expose()
        self.serve('a' * (4 * 1024 * 1024) + ' needle')
        self.open(self.reader_url('txt'))
        self.assertEqual(self.page.evaluate('__query("needle")'), 1)
        self.assertIsNone(self.page.evaluate('__snapshot().value'))
        self.assertEqual(self.page.evaluate('__query("needle")'), 1)


if __name__ == '__main__':
    unittest.main()

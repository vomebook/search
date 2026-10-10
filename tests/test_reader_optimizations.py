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
              window.__markerPage = () => pageAtMarker()?.dataset.page;
              window.__pdfTools = {trim: trimPdfSurfaces, pixels: pdfRetainedPixels, budget: pdfPixelBudget,
                prefetch: pdfManifestPrefetches, setPage: page => updateDocumentState({page})};
              window.__startPdfProbe = () => {
                pdfTextContentCache.clear(); pdfTextContentCacheBytes = 0;
                pdfSearchTextCache.clear(); pdfSearchTextCacheBytes = 0;
                window.__extraction = {active:0, peak:0, calls:[], releases:[]};
                const page = number => ({getTextContent: async () => {
                  const state = __extraction;
                  state.calls.push(number); state.peak = Math.max(state.peak, ++state.active);
                  try {
                    if (number <= 2) await new Promise(resolve => state.releases.push(resolve));
                    else await new Promise(resolve => setTimeout(resolve, 10));
                    return {items:[{str:'needle page ' + number + ' needle'}], styles:{}};
                  } finally { state.active--; }
                }});
                pdfDocument = {numPages:30, getPage: async number => page(number)};
                window.__demandPdfProbe = () => loadPdfTextContent(100, page(100));
                window.__finishPdfProbe = () => __extraction.releases.splice(0).forEach(resolve => resolve());
                const generation = nextReaderGeneration('search');
                window.__pdfProbeTask = fullSearchPdfMatches('needle', generation);
                window.__pdfProbeTask.catch(() => {});
              };
              window.__pdfProbePage = offset => pdfSearchPageLoader(offset);
              window.__pdfProbeTotal = () => chapterSearchPage.total;
              window.__cancelPdfProbe = () => {nextReaderGeneration('search'); chapterSearchPage = {total:123};};
              window.__retryCancelledPageProbe = () => loadPdfTextContent(2, {
                getTextContent:async()=>({items:[{str:'fresh demand'}],styles:{}})});
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

    def test_pdf_pixel_budget_releases_prefetch_and_protects_selection(self):
        self.expose()
        self.serve('pixel budget fixture')
        self.open(self.reader_url('txt'))
        for width in (1100, 390):
            self.page.set_viewport_size(dict(width=width, height=800))
            result = self.page.evaluate('''() => {
              const root = document.querySelector('#content'); root.replaceChildren();
              __pdfTools.setPage(1);
              for (let page=1; page<=8; page++) {
                const shell=document.createElement('div'); shell.className='reader-page';
                shell.style.height='1200px';
                shell.dataset.page=page; shell.dataset.renderState='rendered';
                const canvas=document.createElement('canvas'); canvas.className='ready';
                canvas.width=2400; canvas.height=3400;
                const text=document.createElement('div'); text.className='reader-pdf-text'; text.textContent='page '+page;
                shell.append(canvas,text); root.append(shell);
                if (page >= 5) {
                  const image=new Image(); image.className='ready';
                  Object.defineProperties(image, {naturalWidth:{value:2400},naturalHeight:{value:3400}});
                  image.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
                  canvas.replaceWith(image);
                }
              }
              const selected=root.children[1]; const range=document.createRange();
              range.selectNodeContents(selected.querySelector('.reader-pdf-text'));
              getSelection().removeAllRanges(); getSelection().addRange(range);
              const prefetched=new Image();
              Object.defineProperties(prefetched, {naturalWidth:{value:2400},naturalHeight:{value:3400}});
              prefetched.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
              __pdfTools.prefetch.set('fixture', {image:prefetched, url:'fixture'});
              __pdfTools.trim(root.firstChild);
              const nearestRetained=!!root.children[2].querySelector('canvas.ready');
              const protectedSelection=selected.querySelector('canvas').width===2400 && getSelection().getRangeAt(0).toString()==='page 2';
              const prefetchedReleased=!prefetched.hasAttribute('src') && __pdfTools.prefetch.size===0;
              getSelection().removeAllRanges(); __pdfTools.trim(root.firstChild);
              return {protectedSelection,prefetchedReleased,nearestRetained,pixels:__pdfTools.pixels(),budget:__pdfTools.budget(),
                retained:root.firstChild.querySelector('canvas').width,
                released:[...root.children].filter(shell=>!shell.querySelector('canvas.ready, img')).length};
            }''')
            self.assertTrue(result['protectedSelection'] and result['prefetchedReleased'], result)
            self.assertLessEqual(result['pixels'], result['budget'])
            self.assertEqual(result['retained'], 2400)
            self.assertGreaterEqual(result['released'], 5)

    def test_mobile_large_page_pdf_keeps_nearby_canvases_at_display_resolution(self):
        self.context.close()
        self.context = self.browser.new_context(viewport=dict(width=390,height=844),device_scale_factor=3)
        self.page = self.context.new_page()
        self.page.add_init_script("Object.defineProperty(navigator,'deviceMemory',{value:2});window.__renderedPages=[];")
        engine = '''export const GlobalWorkerOptions={};export class PDFWorker {promise=Promise.resolve();destroy(){}}
          export function getDocument(){return {promise:Promise.resolve({numPages:40,getOutline:async()=>null,
            getPage:async number=>({getViewport:({scale})=>({width:1274*scale,height:1828*scale}),
              getTextContent:async()=>({items:[],styles:{}}),render:({canvasContext})=>{
                __renderedPages.push(number);canvasContext.fillStyle='white';canvasContext.fillRect(0,0,4000,6000);
                return {promise:Promise.resolve(),cancel(){}};}})}),destroy(){}};}'''
        self.page.route('**/static/vendor/pdf.min.*.mjs',lambda route:route.fulfill(content_type='text/javascript',body=engine))
        self.serve(b'pdf','application/pdf')
        self.open(self.reader_url('pdf'))
        self.page.wait_for_function('() => !!document.querySelector(".reader-page[data-page=\\"4\\"] canvas.ready")')
        self.page.wait_for_timeout(150)
        data = self.page.locator('.reader-page[data-page="1"]').evaluate('''shell=>{
          const canvas=shell.querySelector('canvas');return {css:shell.clientWidth,backing:canvas.width,
            next:[2,3,4].map(page=>!!document.querySelector('.reader-page[data-page="'+page+'"] canvas.ready'))};}''')
        self.assertLessEqual(data['backing'],data['css']*2+1,data)
        self.assertTrue(all(data['next']),data)
        self.page.evaluate('''()=>{const shell=document.querySelector('.reader-page[data-page="3"]'),v=document.querySelector('#viewport');
          window.__thirdCount=__renderedPages.filter(page=>page===3).length;v.scrollTop+=shell.getBoundingClientRect().top-v.getBoundingClientRect().top;}''')
        self.page.wait_for_timeout(150)
        self.assertEqual(self.page.evaluate('__renderedPages.filter(page=>page===3).length'),self.page.evaluate('__thirdCount'))
        self.page.evaluate('''()=>{const shell=document.querySelector('.reader-page[data-page="4"]'),canvas=shell.querySelector('canvas');
          canvas.width=canvas.height=0;canvas.classList.remove('ready');shell.dataset.renderState='idle';
          document.querySelector('#viewport').scrollTop+=20;}''')
        self.page.wait_for_function('() => !!document.querySelector(".reader-page[data-page=\\"4\\"] canvas.ready")')

    def test_long_txt_blocks_preserve_exact_text_cross_block_hits_and_selection(self):
        self.expose()
        text=('ordinary line\n'*2400)+'needle\n'+('tail line\n'*6000)+'needle\n'
        self.serve(text)
        self.open(self.reader_url('txt'))
        self.assertEqual(self.page.locator('.reader-text').text_content(),text)
        self.assertGreater(self.page.locator('.reader-text-block').count(),2)
        self.assertEqual(self.page.evaluate('__query("needle")'),2)
        self.search('needle')
        self.page.locator('.full-search-result').last.click()
        self.assertEqual(self.page.locator('mark.full-search-highlight').text_content(),'needle')
        self.assertEqual(self.page.locator('.reader-text').text_content(),text)
        self.assertEqual(self.page.locator('.reader-text').evaluate('''root=>{const range=document.createRange();range.selectNodeContents(root);
          getSelection().removeAllRanges();getSelection().addRange(range);return range.toString();}'''),text)

    def test_pdf_parallel_search_reserves_demand_slot_and_cancels_stale_totals(self):
        self.expose()
        self.serve('search scheduling fixture')
        self.open(self.reader_url('txt'))
        self.page.evaluate('__startPdfProbe()')
        self.page.wait_for_function('() => __extraction.calls.length === 2')
        self.page.evaluate('__demandPdfProbe()')
        self.assertEqual(self.page.evaluate('__extraction.calls'), [1, 2, 100])
        self.assertEqual(self.page.evaluate('__extraction.peak'), 3)
        self.page.evaluate('__finishPdfProbe()')
        first = self.page.evaluate('__pdfProbeTask')
        self.assertEqual(self.page.evaluate('__pdfProbeTotal()'), 60)
        self.assertEqual([hit['location'] for hit in first], [f'第 {page} 页' for page in range(1, 26) for _ in range(2)])
        tail = self.page.evaluate('__pdfProbePage(50)')
        self.assertEqual(tail['total'], 60)
        self.assertEqual([hit['location'] for hit in tail['results']], [f'第 {page} 页' for page in range(26, 31) for _ in range(2)])
        self.assertLessEqual(self.page.evaluate('__extraction.peak'), 3)
        self.page.evaluate('__startPdfProbe()')
        self.page.wait_for_function('() => __extraction.calls.length === 2')
        self.page.evaluate('__cancelPdfProbe(); __finishPdfProbe()')
        self.assertEqual(self.page.evaluate('__pdfProbeTask'), [])
        self.assertEqual(self.page.evaluate('__pdfProbeTotal()'), 123)
        self.assertEqual(self.page.evaluate('__extraction.calls'), [1, 2])

    def test_large_docx_skips_offscreen_paint_but_searches_all_pages(self):
        self.expose()
        with zipfile.ZipFile(io.BytesIO(fixtures.support.minimal_docx())) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        paragraphs = ''.join(f'<w:p><w:r><w:t>needle page {page}</w:t></w:r></w:p>' +
                             ('<w:p><w:r><w:br w:type="page"/></w:r></w:p>' if page < 20 else '')
                             for page in range(1, 21))
        files['word/document.xml'] = ('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>')
        self.serve(fixtures.support.zip_bytes(files), 'application/octet-stream')
        self.open(self.docx_url())
        pages = self.page.locator('.reader-docx-page')
        self.assertEqual(pages.count(), 20)
        marker = self.page.evaluate('''()=>{let reads=0;const pages=[...document.querySelectorAll('.reader-docx-page')];
          for(const page of pages){const native=page.getBoundingClientRect.bind(page);page.getBoundingClientRect=()=>{reads++;return native();};}
          const actual=__markerPage();return {actual,reads};}''')
        self.assertEqual(marker['actual'],'1')
        self.assertLessEqual(marker['reads'],6)
        self.assertEqual(pages.last.evaluate('e => getComputedStyle(e).contentVisibility'), 'auto')
        self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        self.assertFalse(pages.last.evaluate('e => e.firstElementChild.checkVisibility({contentVisibilityAuto:true})'))
        self.assertEqual(self.page.evaluate('__query("needle")'), 20)
        self.search('needle')
        self.page.locator('.full-search-result').last.click()
        self.page.wait_for_function('() => document.querySelector(".reader-docx-page:last-child mark")')
        self.assertEqual(pages.last.locator('mark').text_content(), 'needle')
        self.page.locator('#history').click()
        self.page.locator('#page-number').fill('1')
        self.page.locator('#page-number').press('Enter')
        self.page.wait_for_function('() => document.querySelector("#page-number").value === "1"')
        self.assertEqual(self.page.evaluate('__query("needle")'), 20)

    def test_mobile_pdf_search_keeps_one_demand_slot_and_drops_queued_cancelled_work(self):
        self.expose()
        self.serve('mobile scheduling fixture')
        self.open(self.reader_url('txt'))
        self.page.set_viewport_size(dict(width=390, height=800))
        self.page.evaluate('__startPdfProbe()')
        self.page.wait_for_function('() => __extraction.calls.length === 1')
        self.page.evaluate('__demandPdfProbe()')
        self.assertEqual(self.page.evaluate('__extraction.calls'), [1, 100])
        self.assertEqual(self.page.evaluate('__extraction.peak'), 2)
        self.page.evaluate('__cancelPdfProbe(); window.__freshDemand = __retryCancelledPageProbe(); __finishPdfProbe()')
        self.assertEqual(self.page.evaluate('__freshDemand'), {'items': [{'str': 'fresh demand'}], 'styles': {}})
        self.assertEqual(self.page.evaluate('__pdfProbeTask'), [])
        self.assertEqual(self.page.evaluate('__pdfProbeTotal()'), 123)
        self.assertEqual(self.page.evaluate('__extraction.calls'), [1, 100])

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

    def settle_chapters(self):
        for _ in range(2):
            self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            self.page.wait_for_function('() => __chapterStats().pending === 0')

    def test_chapter_window_preserves_geometry_selection_and_complete_search(self):
        requested, _held = self.chapter_book()
        for width in (1100, 390):
            with self.subTest(width=width):
                self.page.set_viewport_size(dict(width=width, height=800))
                for chapter in (*range(1, 61, 4), 60):
                    self.assertTrue(self.page.evaluate('__goChapter', chapter))
                    self.settle_chapters()
                    self.page.wait_for_function('() => document.querySelectorAll(".reader-epub-chapter").length <= 12 && __chapterStats().pending === 0')
                self.assertGreater(self.page.locator('.reader-chapter-placeholder').count(), 0)
                self.assertTrue(self.page.evaluate('__goChapter(1)'))
                self.settle_chapters()
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
                self.settle_chapters()
                self.assertTrue(self.page.evaluate('__pinned.isConnected'))
                self.assertTrue(self.page.evaluate('__pinnedMiddle.isConnected'))
                self.page.evaluate('getSelection().removeAllRanges(); document.querySelector("#viewport").dispatchEvent(new Event("scroll"))')
                for chapter in (30, 40, 50):
                    self.assertTrue(self.page.evaluate('__goChapter', chapter))
                    self.settle_chapters()
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
                self.settle_chapters()
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

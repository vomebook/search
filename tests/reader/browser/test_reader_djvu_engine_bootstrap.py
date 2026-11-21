"""Decoder bootstrap behavior; no external source or original copy is used."""
import gzip
import hashlib
import json
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import sync_playwright
from scripts.benchmarks.benchmark_djvu import local_server
from tests.support.reader_native_fixture import PINNED, RAW, REVISION, SHA256, VERSION, install

ROOT=Path(__file__).resolve().parents[3]
PREFIX='/search' if '/search/static/' in (ROOT/'static/reader.html').read_text() else ''

class DjvuEngineBootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=local_server(ROOT,PREFIX);cls.origin=cls.server.__enter__()
        cls.addClassCleanup(cls.server.__exit__,None,None,None)
        cls.playwright=sync_playwright().start();cls.addClassCleanup(cls.playwright.stop)
        cls.browser=cls.playwright.chromium.launch(headless=True);cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':390,'height':844},service_workers='block')
        self.addCleanup(self.context.close);self.page=self.context.new_page();self.errors=[];self.requests=[]
        self.page.on('pageerror',lambda error:self.errors.append(str(error)))
        self.page.on('request',lambda request:self.requests.append(request.url))

    def test_direct_djvu_prepares_decoder_before_source_and_map(self):
        source_url = self.origin + '/direct-synthetic.djvu'
        held = []
        self.page.route(source_url, lambda route: held.append(route))
        self.page.goto(self.origin + PREFIX + '/static/manifest.json')
        self.page.add_script_tag(url=self.origin + PREFIX + '/static/reader/core/reader-security.js')
        self.page.evaluate('''({moduleUrl,sourceUrl,sha256,size}) => {
          const Native = Worker;
          window.__ops = [];
          window.Worker = class extends Native {
            postMessage(message,...args) {
              window.__ops.push(message.operation);
              return super.postMessage(message,...args);
            }
          };
          const controller = new AbortController();
          const context = {
            readerAbortController: controller,
            fetchReaderUrl: (url, options) => fetch(url, options),
            v3ResourceUrl: () => sourceUrl,
            assertReaderActive: () => controller.signal.throwIfAborted(),
            trackReaderResource: cleanup => {window.__closeDirectDjvu = cleanup;}
          };
          const map = new Promise(resolve => {window.__providePageMap = resolve;});
          window.__direct = import(moduleUrl).then(({openDirectDjvu}) => openDirectDjvu(context,
            {primary:{resource:{bytes:size,sha256}}}, map));
          window.__direct.catch(() => {});
        }''', {'moduleUrl': PREFIX + '/static/reader/pdf/reader-djvu-loader.mjs',
                'sourceUrl': source_url, 'sha256': SHA256, 'size': len(RAW)})
        self.page.wait_for_function("()=>window.__ops.includes('prepare')", timeout=5000)
        self.assertEqual(self.page.evaluate('window.__ops'), ['prepare'])
        self.assertEqual(len(held), 1)
        held.pop().fulfill(status=200, content_type='image/vnd.djvu', body=RAW)
        self.page.evaluate('''()=>window.__providePageMap({pages:[1,2,3].map(page=>
          ({page,width:23.04,height:30.72,rotation:0,djvu:{pixels:[96,128],dpi:300}}))})''')
        self.assertEqual(self.page.evaluate('async()=> (await window.__direct).numPages'), 3)
        self.assertEqual(self.page.evaluate('window.__ops'), ['prepare', 'open'])
        self.page.evaluate('window.__closeDirectDjvu()')
        self.assertEqual(self.errors, [])

    def test_v3_djvu_reads_checked_map_while_loader_import_is_pending(self):
        root = f'objects/{SHA256[:2]}/{SHA256}/{VERSION}'
        manifest_path, map_path, primary_path = [
            f'{root}/{name}' for name in ('reading-manifest.json', 'page-map.json.gz', 'document.djvu')]
        pages = [dict(page=n, identity=str(n)*64, width=69.12, height=92.16, rotation=0,
                      crop_box=[0, 0, 69.12, 92.16], media_box=[0, 0, 69.12, 92.16],
                      djvu=dict(pixels=[96, 128], dpi=100)) for n in (1, 2, 3)]
        packed = gzip.compress(json.dumps(dict(version=1, kind='pdf-page-map', source_sha256=SHA256,
                                               pages=pages)).encode(), mtime=0)

        def ref(path, data):
            return dict(bucket='vomebook/pdf-pages-v2', path=path, role='runtime', bytes=len(data),
                        sha256=hashlib.sha256(data).hexdigest())

        manifest = dict(version=3, kind='pdf-reading', source_sha256=SHA256, generation='a'*64,
                        page_count=3, source_key='fixture', page_map=ref(map_path, packed),
                        primary=dict(kind='djvu', status='ready', resource=ref(primary_path, RAW)),
                        preview=dict(complete=False, status='skipped', page_count=3, ready_pages=0, partitions=[]),
                        components=dict(document='ready', preview='skipped', text='pending'))
        proxy = '/api/reader-bucket-resource'
        proxy_origin = 'https://voiceofml-search.hf.space' if PREFIX else self.origin
        url = self.origin + PREFIX + '/static/reader.html?' + urlencode({
            'ext': 'pdf-pages', 'url': proxy_origin + proxy + '?' + urlencode({'path': manifest_path})})

        for action in ('resume', 'bad-map', 'dispose'):
            with self.subTest(action=action), self.browser.new_context(service_workers='block') as context:
                page = context.new_page()
                page.set_default_timeout(10000)
                requests, loader, maps, errors = [], [], [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(self.origin + '/')
                           else route.abort())
                page.add_init_script('''(() => {
                  const fetchImpl = fetch.bind(window);
                  window.fetch = (input, init) => {
                    const url = new URL(input, location.href);
                    if (url.pathname !== '/api/reader-bucket-resource') return fetchImpl(input, init);
                    if (url.searchParams.get('path').endsWith('/page-map.json.gz'))
                      window.__mapSignal = init.signal;
                    return fetchImpl(location.origin + url.pathname + url.search, init);
                  };
                  const post = Worker.prototype.postMessage;
                  window.__ops = [];
                  Worker.prototype.postMessage = function(message, ...args) {
                    window.__ops.push(message.operation);
                    return post.call(this, message, ...args);
                  };
                  new MutationObserver(() => {
                    const canvas = document.querySelector('.reader-page canvas.ready');
                    if (canvas) window.__firstCanvasPage ??= canvas.closest('.reader-page').dataset.page;
                  }).observe(document, {subtree:true, childList:true, attributes:true, attributeFilter:['class']});
                })()''')
                page.route('**/static/reader/core/reader-store.js*', lambda route: route.fulfill(
                    content_type='text/javascript', body='''window.VoiceOfMLReaderStore={
                      get:async()=>({page:2,pageCount:3,zoom:100}),put:async()=>{},
                      list:async()=>[],listBookmarks:async()=>[],listAllBookmarks:async()=>[]};'''))
                page.route('**/static/reader/pdf/reader-djvu-loader.mjs*', lambda route: loader.append(route))

                def assets(route):
                    path = parse_qs(urlsplit(route.request.url).query)['path'][0]
                    requests.append(path)
                    if path == manifest_path:
                        route.fulfill(json=manifest)
                    elif path == map_path:
                        maps.append(route)
                    elif path == primary_path:
                        route.fulfill(body=RAW, content_type='image/vnd.djvu')
                    else:
                        route.fulfill(status=404)

                page.route(self.origin + proxy + '?*', assets)
                page.goto(url, wait_until='domcontentloaded')
                deadline = time.monotonic() + 5
                while not (loader and maps) and time.monotonic() < deadline:
                    page.wait_for_timeout(20)
                self.assertEqual(len(loader), 1)
                self.assertEqual(len(maps), 1, 'the map must be requested before the loader is released')
                self.assertEqual(requests, [manifest_path, map_path])
                self.assertEqual(page.evaluate('window.__ops'), [])

                def release_loader():
                    # Check cancellation after the late import has actually run.
                    route = loader.pop()
                    response = route.fetch()
                    route.fulfill(response=response, body=response.text() + '\nwindow.__djvuLoaderImported = true;\n')
                    page.wait_for_function('() => window.__djvuLoaderImported === true')

                if action == 'resume':
                    release_loader()
                    page.wait_for_function("() => window.__ops.includes('prepare')")
                    self.assertEqual(page.evaluate('window.__ops'), ['prepare'])
                    self.assertEqual(page.locator('canvas.ready').count(), 0)
                    maps.pop().fulfill(body=packed, content_type='application/gzip')
                    shell = page.locator('.reader-page[data-page="2"]')
                    shell.locator('canvas.ready').wait_for()
                    self.assertEqual(page.evaluate('window.__firstCanvasPage'), '2')
                    page.wait_for_function('''() => document.querySelector('.reader-page[data-page="2"] .reader-pdf-text')
                      ?.textContent.includes('Page2text')''')
                    self.assertEqual(requests, [manifest_path, map_path, primary_path])
                    self.assertEqual(page.evaluate('window.__ops.slice(0, 3)'), ['prepare', 'open', 'page'])
                else:
                    if action == 'bad-map':
                        maps.pop().fulfill(body=bytes([packed[0] ^ 1]) + packed[1:], content_type='application/gzip')
                        page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'failed'")
                        self.assertIn('PDF_OCR_HASH_MISMATCH', page.locator('.reader-error').text_content())
                    else:
                        page.evaluate("dispatchEvent(new Event('voice-reader-dispose'))")
                        page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'disposed'")
                        self.assertTrue(page.evaluate('window.__mapSignal.aborted'))
                    release_loader()
                    self.assertEqual(requests, [manifest_path, map_path])
                    self.assertEqual(page.evaluate('window.__ops'), [])
                    self.assertEqual(page.locator('canvas.ready').count(), 0)
                self.assertEqual(errors, [])

    def test_native_decoder_prepares_while_revision_is_pending(self):
        state = install(self.page, self.origin, prefix=PREFIX)
        held = []
        self.page.route('**/api/reader-source-revision?**', lambda route: held.append(route))
        self.page.add_init_script('''(() => {
          const Native = Worker;
          window.__ops = [];
          window.Worker = class extends Native {
            constructor(url, options) {
              super(url, options);
              if (!String(url).includes('reader-djvu-engine-worker')) return;
              let prepareId;
              const post = this.postMessage.bind(this);
              this.postMessage = (message, ...args) => {
                window.__ops.push(message.operation);
                if (message.operation === 'prepare') prepareId = message.id;
                return post(message, ...args);
              };
              this.addEventListener('message', ({data}) => {
                if (prepareId !== undefined && data.id === prepareId && data.ok) window.__decoderPrepared = true;
              });
            }
          };
        })()''')
        self.page.goto(state['url'], wait_until='domcontentloaded')
        self.page.wait_for_function('()=>window.__decoderPrepared === true', timeout=10000)
        self.assertEqual(len(held), 1)
        self.assertEqual(state['source'], [])
        self.assertEqual(self.page.evaluate('window.__ops'), ['prepare'])
        self.assertEqual(self.page.locator('.reader-page canvas.ready').count(), 0)
        held.pop().fulfill(json={'url': PINNED, 'revision': REVISION}, headers={'Access-Control-Allow-Origin': '*'})
        self.page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=10000)
        self.assertTrue(state['source'] and all(row['url'] == PINNED and row['range'] for row in state['source']))
        self.assertEqual(self.page.evaluate('window.__ops.slice(0, 2)'), ['prepare', 'open-range'])
        self.assertEqual(self.errors, [])

    def test_failed_wasm_does_not_show_unverified_page(self):
        state=install(self.page,self.origin,prefix=PREFIX)
        self.page.route('**/vendor/djvu-rs-reader/**/djvu_rs_bg.wasm',
                        lambda route:route.fulfill(status=503,body='unavailable'))
        self.page.goto(state['url'],wait_until='domcontentloaded')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='failed'",timeout=30000)
        self.assertEqual(self.page.locator('.reader-page canvas.ready').count(),0)
        self.assertFalse(any(row['range'] is None for row in state['source']))
        self.assertFalse([url for url in self.requests if '/pages/page-' in url or '/preview/' in url])

    def test_non_wasm_mime_preserves_decoder_buffered_fallback(self):
        state=install(self.page,self.origin,prefix=PREFIX)
        def wrong_mime(route):
            response=route.fetch()
            route.fulfill(response=response,headers={**response.headers,'content-type':'application/octet-stream'})
        self.page.route('**/vendor/djvu-rs-reader/**/djvu_rs_bg.wasm',wrong_mime)
        self.page.goto(state['url'],wait_until='domcontentloaded')
        self.page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=30000)
        self.assertEqual(self.page.locator('#page-number').get_attribute('max'),'3')
        self.assertTrue(state['source'] and all(row['range'] for row in state['source']))
        self.assertEqual(self.errors,[])

    def test_corrupt_wasm_never_publishes_a_page(self):
        state=install(self.page,self.origin,prefix=PREFIX)
        self.page.route('**/vendor/djvu-rs-reader/**/djvu_rs_bg.wasm',
                        lambda route:route.fulfill(status=200,content_type='application/wasm',body=b'not a wasm module'))
        self.page.goto(state['url'],wait_until='domcontentloaded')
        self.page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='failed'",timeout=30000)
        self.assertEqual(self.page.locator('.reader-page canvas.ready').count(),0)
        self.assertFalse(any(row['range'] is None for row in state['source']))

    def test_scalar_decoder_branch_retains_pages_and_text(self):
        state=install(self.page,self.origin,prefix=PREFIX)
        def scalar_resources(route):
            response=route.fetch();source=response.text()
            needle='function djvuSupportsSIMD() {'
            self.assertIn(needle,source)
            route.fulfill(response=response,body=source.replace(needle,needle+' return false;',1))
        # The same capability selection must govern both prewarm and decoder.
        self.page.route('**/static/reader-resources.js*',scalar_resources)
        self.page.goto(state['url'],wait_until='domcontentloaded')
        self.page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=30000)
        self.page.wait_for_function('''()=>document.querySelector('.reader-page[data-page="1"]')?.dataset.textReady==='1' ''',timeout=30000)
        self.assertEqual(self.page.locator('#page-number').get_attribute('max'),'3')
        self.assertTrue(any('/scalar/djvu_rs_bg.wasm' in url for url in self.requests))
        self.assertFalse(any('/simd128/djvu_rs_bg.wasm' in url for url in self.requests))
        self.assertTrue(state['source'] and all(row['range'] for row in state['source']))
        self.assertEqual(self.errors,[])

    def test_dispose_during_wasm_stall_never_starts_source_decode(self):
        state=install(self.page,self.origin,prefix=PREFIX)
        self.page.add_init_script('''(()=>{const Native=Worker;window.__djvuOps=[];
          window.Worker=function(url,options){const worker=new Native(url,options);
            if(String(url).includes('reader-djvu-engine-worker')){const post=worker.postMessage.bind(worker);
              worker.postMessage=(message,...rest)=>{if(message?.operation)window.__djvuOps.push(message.operation);return post(message,...rest)}}
            return worker};window.Worker.prototype=Native.prototype})()''')
        def hang(route):
            # Close the reader as soon as the Worker starts its Wasm demand.
            self.page.evaluate("()=>dispatchEvent(new Event('voice-reader-dispose'))")
            route.abort()
        self.page.route('**/vendor/djvu-rs-reader/**/djvu_rs_bg.wasm',hang)
        self.page.goto(state['url'],wait_until='domcontentloaded')
        self.page.wait_for_function("()=>window.__djvuOps.includes('prepare')",timeout=15000)
        self.page.wait_for_timeout(300)
        self.assertNotIn('open-range',self.page.evaluate('()=>window.__djvuOps'))
        self.assertNotIn('open',self.page.evaluate('()=>window.__djvuOps'))
        self.assertEqual(self.page.locator('.reader-page canvas.ready').count(),0)
        self.assertFalse(any(row['range'] is None for row in state['source']))

if __name__=='__main__':unittest.main()

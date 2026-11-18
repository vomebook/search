"""Decoder bootstrap behavior; no external source or original copy is used."""
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright
from scripts.benchmarks.benchmark_djvu import local_server
from tests.support.reader_native_fixture import PINNED, RAW, REVISION, SHA256, install

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

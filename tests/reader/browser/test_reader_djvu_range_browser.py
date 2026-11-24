"""Real DjVu Range/fallback checks with local synthetic bytes and no production calls."""
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

from scripts.benchmarks.benchmark_djvu import local_server
from tests.support.reader_native_fixture import RAW, install, separated_pages


ROOT = Path(__file__).resolve().parents[3]
PREFIX = '/search' if '/search/static/' in (ROOT / 'static/reader.html').read_text() else ''


class DjvuRangeBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = local_server(ROOT, PREFIX)
        cls.origin = cls.server.__enter__()
        cls.addClassCleanup(cls.server.__exit__, None, None, None)
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(headless=True)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.page.set_default_timeout(15000)
        self.requests = []
        self.page.on('request', lambda request: self.requests.append(request.url))

    def assert_no_page_images(self):
        self.assertFalse([url for url in self.requests if '/pages/page-' in url or '/preview/' in url])
        self.assertEqual(self.page.locator('.reader-page img').count(), 0)

    def test_native_worker_eager_and_range_page_replies_match(self):
        # Drive the actual module Worker and Wasm over the wire, independently
        # of the caller's page cache and its terminate-on-open-error behavior.
        source_url = self.origin + '/separated-synthetic.djvu'
        self.page.route(source_url, lambda route: route.fulfill(body=separated_pages()))
        self.page.goto(self.origin + PREFIX + '/static/manifest.json')
        result = self.page.evaluate(r'''async ({prefix, sourceUrl}) => {
          const source = new Uint8Array(await (await fetch(sourceUrl)).arrayBuffer());
          async function read(lazy) {
            const worker = new Worker(`${prefix}/static/reader/pdf/reader-djvu-engine-worker.mjs`, {type:'module'});
            const ranges = [];
            let id = 0;
            async function send(operation, fields = {}, transfer = []) {
              const current = ++id;
              let timer;
              try {
                return await new Promise((resolve, reject) => {
                  timer = setTimeout(() => reject(Error(`no reply for ${operation}`)), 5000);
                  worker.onerror = reject;
                  worker.onmessage = ({data}) => {
                    if (data.id !== current) { reject(Error('unexpected reply id')); return; }
                    if (data.operation !== 'range') { resolve(data); return; }
                    const {rangeId, offset, length} = data;
                    if (!(offset >= 0 && length > 0 && offset + length <= source.length)) {
                      reject(Error('unexpected range')); return;
                    }
                    ranges.push({rangeId, offset});
                    const bytes = source.slice(offset, offset + length).buffer;
                    worker.postMessage({id:current, operation:'range-result', rangeId, ok:true, bytes}, [bytes]);
                  };
                  worker.postMessage({id:current, operation, ...fields}, transfer);
                });
              } finally { clearTimeout(timer); }
            }
            try {
              const cacheBytes = 4096;
              const bytes = source.slice().buffer;
              const opened = lazy ? await send('open-range', {total:source.length, cacheBytes})
                                  : await send('open', {bytes, cacheBytes}, [bytes]);
              const invalidPages = [];
              for (const operation of ['geometry', 'text', 'page'])
                invalidPages.push(await send(operation, {page:4}));
              const geometry = await send('geometry', {page:3});
              const text = await send('text', {page:3});
              const page = await send('page', {page:3});
              const raster = page.pixels instanceof ArrayBuffer ? {
                byteLength:page.pixels.byteLength,
                digest:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', page.pixels)))
              } : null;
              delete page.pixels;
              const rejectedOpen = lazy ? await send('open', {bytes, cacheBytes}, [bytes])
                                        : await send('open-range', {total:source.length, cacheBytes});
              const afterRejectedOpen = await send('geometry', {page:3});
              return {opened, invalidPages, geometry, text, page, raster, rejectedOpen, afterRejectedOpen, ranges};
            } finally { worker.terminate(); }
          }
          return {eager:await read(false), lazy:await read(true)};
        }''', {'prefix': PREFIX, 'sourceUrl': source_url})
        eager, lazy = result['eager'], result['lazy']
        for mode in (eager, lazy):
            self.assertEqual(mode['opened']['count'], 3)
            self.assertEqual(mode['invalidPages'], [
                {'id': i, 'ok': False, 'error': 'DJVU_PAGE_INVALID'} for i in (2, 3, 4)])
            self.assertEqual(mode['geometry'], {'id': 5, 'ok': True, 'width': 96, 'height': 128,
                                                'dpi': 100, 'rotation': 0})
            self.assertEqual(mode['page'], {**mode['geometry'], 'id': 7})
            self.assertIn('Page3text', mode['text']['text'])
            self.assertTrue(mode['text']['zones'])
            self.assertEqual(mode['raster']['byteLength'], 96 * 128 * 4)
            self.assertEqual(mode['rejectedOpen'], {'id': 8, 'ok': False, 'error': 'DJVU_DOCUMENT_INVALID'})
            self.assertEqual(mode['afterRejectedOpen'], {**mode['geometry'], 'id': 9})
        self.assertEqual(eager['text'], lazy['text'])
        self.assertEqual(eager['raster'], lazy['raster'])
        self.assertEqual(eager['ranges'], [])
        self.assertEqual([row['rangeId'] for row in lazy['ranges']], list(range(1, len(lazy['ranges']) + 1)))
        self.assertEqual(lazy['ranges'][0]['offset'], 0)
        self.assertTrue(any(row['offset'] >= 2 * 1024 * 1024 for row in lazy['ranges']), lazy['ranges'])

    def test_native_djvu_canvas_matches_physical_width_across_browser_modes(self):
        cdp = self.context.new_cdp_session(self.page)
        self.page.add_init_script("Object.defineProperty(navigator, 'deviceMemory', {value: 2})")
        for width, ratio, mobile in [(360, 4, True), (980, 1440 / 980, False)]:
            with self.subTest(width=width, mobile=mobile):
                cdp.send('Emulation.setDeviceMetricsOverride', dict(
                    width=width, height=900, deviceScaleFactor=ratio, mobile=mobile))
                state = install(self.page, self.origin, prefix=PREFIX)
                try:
                    self.page.goto(state['url'], wait_until='domcontentloaded')
                    canvas = self.page.locator('.reader-page[data-page="1"] canvas.ready')
                    width_px, width_css, dpr = canvas.evaluate(
                        'node => [node.width, node.getBoundingClientRect().width, devicePixelRatio]')
                    self.assertAlmostEqual(dpr, ratio, places=4)
                    self.assertLessEqual(abs(width_px - width_css * dpr), 2)
                    self.assertGreater(width_px, 1300)
                    self.assertTrue(state['source'])
                    self.assert_no_page_images()
                finally:
                    self.page.unroute('**/api/reader-source-revision?**')
                    self.page.unroute('**/api/reader-content?**')

    def test_long_djvu_end_key_supersedes_held_first_draw(self):
        # Exercise the real reader/navigation with a virtual-sized document.
        # Only the decoder result is stubbed so the test can hold page one
        # without requiring a large binary fixture or public network traffic.
        page = self.page
        state = install(page, self.origin, prefix=PREFIX)
        page.route('**/reader-djvu-loader.mjs', lambda route: route.fulfill(
            content_type='text/javascript', body=r'''export async function openNativeDjvu() {
              let release;
              const held = new Promise(resolve => release = resolve);
              window.releaseDjvuFirst = release;
              return {
                numPages: 340, getOutline: async () => [],
                getPage: async number => ({
                  getViewport: ({scale}) => ({width: 300 * scale, height: 420 * scale}),
                  getTextContent: async () => ({items: []}),
                  render({canvasContext}) {
                    if (number === 1) window.djvuFirstDrawStarted = true;
                    const promise = (number === 1 ? held : Promise.resolve()).then(() => {
                      canvasContext.fillRect(0, 0, 10, 10);
                    });
                    return {promise, cancel: release};
                  }
                })
              };
            }'''))
        page.goto(state['url'], wait_until='domcontentloaded')
        page.wait_for_function('window.djvuFirstDrawStarted === true')
        self.assertEqual(page.locator('.reader-page').count(), 32)
        self.assertEqual(page.locator('.reader-page canvas.ready').count(), 0)
        page.locator('#viewport').press('End')
        page.locator('.reader-page[data-page="340"]').wait_for(state="attached")
        page.evaluate('window.releaseDjvuFirst()')
        page.locator('.reader-page[data-page="340"] canvas.ready').wait_for()
        self.assertTrue(page.evaluate("""() => {const el=document.querySelector('#viewport');
          return el.scrollHeight - el.clientHeight - el.scrollTop < 4;}"""))
        self.assert_no_page_images()

    def test_late_outline_loads_full_same_version_only_on_demand(self):
        state = install(self.page, self.origin, prefix=PREFIX, body=separated_pages())
        self.page.goto(state['url'], wait_until='domcontentloaded')
        self.page.locator('.reader-page[data-page="1"] canvas.ready').wait_for()
        self.assertTrue(state['source'] and all(row['range'] for row in state['source']))
        self.page.wait_for_function("() => !document.querySelector('#toc-tab').hidden")
        self.page.locator('#history').evaluate("b=>{if(b.getAttribute('aria-expanded')!=='true')b.click()}")
        self.page.locator('#toc-tab').click()
        self.page.get_by_text('加载原件目录', exact=True).click()
        self.page.get_by_text('Chapter two · 第 2 页', exact=True).wait_for()
        self.assertEqual(sum(row['range'] is None for row in state['source']), 1)
        self.assert_no_page_images()

    def test_changed_full_source_is_rejected_for_late_outline(self):
        state = None
        def source(route):
            if route.request.headers.get('range'):
                state['respond_source'](route)
            else:
                route.fulfill(status=200, body=state['raw'], headers={
                    'ETag':'"different-version"', 'Access-Control-Allow-Origin':'*',
                    'Access-Control-Expose-Headers':'ETag,Content-Range,Content-Length'})
        state = install(self.page, self.origin, prefix=PREFIX, body=separated_pages(), source_handler=source)
        self.page.goto(state['url'], wait_until='domcontentloaded')
        self.page.locator('.reader-page[data-page="1"] canvas.ready').wait_for()
        self.page.wait_for_function("() => !document.querySelector('#toc-tab').hidden")
        self.page.locator('#history').evaluate("b=>{if(b.getAttribute('aria-expanded')!=='true')b.click()}")
        self.page.locator('#toc-tab').click()
        self.page.get_by_text('加载原件目录', exact=True).click()
        self.page.get_by_text('原件目录加载失败，点击重试', exact=True).wait_for()
        self.assertEqual(self.page.get_by_text('Chapter two · 第 2 页', exact=True).count(), 0)
        self.assert_no_page_images()

    def test_corrupt_range_page_fails_instead_of_showing_partial_or_images(self):
        corrupt = bytearray(RAW)
        index = corrupt.find(b'BG44')
        self.assertGreater(index, 0)
        corrupt[index:index+4] = b'FG44'
        state = install(self.page, self.origin, prefix=PREFIX, body=bytes(corrupt))
        self.page.goto(state['url'], wait_until='domcontentloaded')
        self.page.wait_for_function("""() => document.documentElement.dataset.readerPhase === 'failed' ||
          document.querySelector('.reader-page-state[data-state="error"]')""")
        self.assertEqual(self.page.locator('.reader-page[data-page="1"] canvas.ready').count(), 0)
        self.assertTrue(state['source'] and all(row['range'] for row in state['source']))
        self.assert_no_page_images()

    def test_late_range_503_reopens_document_and_restores_current_page(self):
        hold_followup, unavailable, held, failed_ranges = True, False, [], []
        state = None

        def source(route):
            byte_range = route.request.headers.get('range')
            if byte_range and not byte_range.startswith('bytes=0-'):
                if hold_followup:
                    held.append(route)
                    return
                if unavailable:
                    failed_ranges.append((byte_range, route.request.headers.get('if-range')))
                    route.fulfill(status=503, body='temporary range failure', headers={'Access-Control-Allow-Origin': '*'})
                    return
            state['respond_source'](route)

        state = install(self.page, self.origin, prefix=PREFIX, body=separated_pages(), source_handler=source)
        reader_url = state['url'] + '&nav=fixture-nav&return=%2Fsearch%2F'
        self.page.goto(reader_url, wait_until='domcontentloaded')
        self.page.locator('.reader-page[data-page="1"] canvas.ready').wait_for()
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.page.locator('#page-number').fill('3')
        self.page.locator('#page-number').press('Enter')
        self.page.wait_for_function("() => document.querySelector('#page-number').value === '3'")
        # Hold an early speculative read so it cannot warm the byte cache.
        hold_followup, unavailable = False, True
        for route in held:
            source(route)
        retry = self.page.get_by_role('button', name='重试加载')
        retry.wait_for()
        self.assertEqual(self.page.locator('#content').get_attribute('data-error-code'), 'READER_DJVU_TRANSPORT')
        self.assertEqual(len(failed_ranges), 3)
        self.assertEqual(len(set(failed_ranges)), 1)
        self.assertEqual(failed_ranges[0][1], '"synthetic-reader"')
        self.assertEqual(self.page.locator('canvas.ready').count(), 0)
        self.assertTrue(all(row['range'] for row in state['source']))
        fresh_opens = sum(row['range'].startswith('bytes=0-') for row in state['source'])
        unavailable = False
        retry.click()
        self.page.locator('.reader-page[data-page="3"] canvas.ready').wait_for()
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.assertEqual(self.page.locator('#page-number').input_value(), '3')
        self.assertEqual(self.page.url, reader_url)
        self.assertTrue(all(row['range'] for row in state['source']))
        self.assertEqual(sum(row['range'].startswith('bytes=0-') for row in state['source']), fresh_opens + 1)
        self.assert_no_page_images()

    def test_embedded_text_remains_selectable(self):
        state = install(self.page, self.origin, prefix=PREFIX)
        self.page.goto(state['url'], wait_until='domcontentloaded')
        shell = self.page.locator('.reader-page[data-page="1"][data-text-ready="1"]')
        shell.locator('canvas.ready').wait_for()
        run = shell.locator('.reader-pdf-text-run').filter(has_text='Page1text').first
        run.dblclick()
        self.page.wait_for_function("() => getSelection().toString().includes('Page1text')")
        selected = self.page.evaluate('''() => {
          const layer=document.querySelector('.reader-page[data-page="1"] .reader-pdf-text');
          const range=document.createRange();range.selectNodeContents(layer);
          getSelection().removeAllRanges();getSelection().addRange(range);return getSelection().toString();
        }''')
        self.assertIn('Page1text',selected)
        self.assertTrue(state['source'] and all(row['range'] for row in state['source']))
        self.assert_no_page_images()

    def test_missing_range_support_falls_back_to_the_complete_original(self):
        data = separated_pages()
        state = None
        def source(route):
            state['source'].append({'range':route.request.headers.get('range')})
            route.fulfill(status=200, body=data, content_type='image/vnd.djvu', headers={
                'ETag':'"synthetic-reader"','Access-Control-Allow-Origin':'*',
                'Access-Control-Expose-Headers':'ETag,Content-Range,Content-Length'})
        state = install(self.page, self.origin, prefix=PREFIX, body=data, source_handler=source)
        self.page.goto(state['url'], wait_until='domcontentloaded')
        self.page.locator('.reader-page[data-page="1"] canvas.ready').wait_for()
        self.assertTrue(state['source'][0]['range'])
        self.assertTrue(any(row['range'] is None for row in state['source']))
        self.assertEqual(self.page.locator('#page-total').text_content().strip(), '/ 3')
        self.assert_no_page_images()


if __name__ == '__main__':
    unittest.main()

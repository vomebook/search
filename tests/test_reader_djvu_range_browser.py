"""Real DjVu Range/fallback checks with local synthetic bytes and no production calls."""
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

from scripts.benchmarks.benchmark_djvu import local_server
from tests.reader_native_fixture import RAW, install, separated_pages


ROOT = Path(__file__).resolve().parents[1]
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

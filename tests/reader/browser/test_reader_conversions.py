import unittest
from urllib.parse import parse_qs, urlencode, urlsplit

from tests.reader.browser import test_reader_refactor as fixtures
from tests.support.reader_test_selection import load_category_tests


@unittest.skipIf(fixtures.support.sync_playwright is None, "Playwright is unavailable")
class ImagePageFirstViewTests(unittest.TestCase):
    setUpClass = classmethod(fixtures.ReaderRefactorTest.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.ReaderRefactorTest.tearDownClass.__func__)
    setUp = fixtures.ReaderRefactorTest.setUp
    tearDown = fixtures.ReaderRefactorTest.tearDown
    reader_url = fixtures.ReaderRefactorTest.reader_url

    def open_with_held_trailing_shells(self, fail_saved=False):
        prefix = 'pages/image/tiff/' + 'a' * 64 + '/'
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': prefix + 'page-manifest.json'})
        requests = []

        def resource(route):
            path = parse_qs(urlsplit(route.request.url).query)['path'][0]
            if path.endswith('/page-manifest.json'):
                route.fulfill(json=dict(version=1, kind='image-page-stream', page_count=253, pages=[{}] * 253))
            else:
                name = path.rsplit('/', 1)[-1]
                requests.append(name)
                if fail_saved and name == 'page-000120.webp':
                    route.fulfill(status=404)
                else:
                    route.fulfill(content_type='image/webp', body=fixtures.support.IMAGE_FIXTURES['webp'][1])

        def hold_trailing_shells(route):
            response = route.fetch()
            script = response.text()
            anchor = 'await readerContext.waitForReader();\n    }\n  }'
            self.assertEqual(script.count(anchor), 1)
            route.fulfill(response=response, body=script.replace(anchor, '''
              if (start === 2) await readerContext.awaitReader(new Promise(resolve => {
                window.releaseTrailingShells = resolve;
              }));
            ''' + anchor))

        self.page.route('**/api/reader-bucket-resource?**', resource)
        self.page.route('**/static/reader/pdf/reader-pdf-page-window.mjs*', hold_trailing_shells)
        self.page.route('**/static/reader/core/reader-store.js*', lambda route: route.fulfill(
            content_type='text/javascript', body=fixtures.support.STORE_SCRIPT.replace(
                'new Promise((resolve) => setTimeout(() => resolve(null), 300))',
                'Promise.resolve({page:120,pageOffset:28,zoom:100})')))
        # Require the real image demand, not just a matching speculative preload.
        self.page.add_init_script("Object.defineProperty(navigator,'connection',{value:{saveData:true}})")
        self.page.goto(self.reader_url('image-pages', url=source), wait_until='domcontentloaded')
        self.page.wait_for_function('() => !!window.releaseTrailingShells')
        return requests

    def test_saved_image_paints_before_unrelated_shells_and_restores_offset(self):
        requests = self.open_with_held_trailing_shells()
        target = self.page.locator('.reader-page[data-page="120"]')
        target.locator('img.ready').wait_for(state='visible')
        self.assertEqual(requests[0], 'page-000120.webp')
        self.assertTrue(target.evaluate('''node => {
          const view = document.querySelector("#viewport").getBoundingClientRect();
          const image = node.querySelector("img").getBoundingClientRect();
          return image.bottom > view.top && image.top < view.bottom;
        }'''))
        self.assertEqual(self.page.locator('.reader-page[data-page="253"]').count(), 0)
        self.assertNotEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
        self.assertFalse(self.page.evaluate('!!window.__savedReaderProgress'))
        self.page.evaluate('window.releaseTrailingShells()')
        self.page.locator('html[data-reader-phase="ready"]').wait_for()
        self.assertEqual(self.page.locator('#page-number').input_value(), '120')
        offset = target.evaluate('node => document.querySelector("#viewport").getBoundingClientRect().top - node.getBoundingClientRect().top')
        self.assertAlmostEqual(offset, 28, delta=3)


    def test_failed_opening_image_does_not_replace_newer_page_while_batch_is_held(self):
        self.open_with_held_trailing_shells(fail_saved=True)
        # Wait for the actual failed draw to settle before changing ownership.
        self.page.wait_for_function("""() => {
          const shell = document.querySelector('.reader-page[data-page="120"]');
          return shell?.dataset.renderState === 'idle' && !shell._renderPromise;
        }""")
        field = self.page.locator('#page-number')
        field.fill('121')
        field.press('Enter')
        self.page.locator('.reader-page[data-page="121"] img.ready').wait_for(state='visible')
        self.page.evaluate('window.releaseTrailingShells()')
        self.page.locator('html[data-reader-phase="ready"]').wait_for(state='attached')
        self.assertEqual(field.input_value(), '121')
        self.assertEqual(self.page.locator('.reader-error').count(), 0)


def load_tests(loader, _tests, _pattern):
    suite = load_category_tests(loader, "conversions")
    suite.addTests(loader.loadTestsFromTestCase(ImagePageFirstViewTests))
    return suite

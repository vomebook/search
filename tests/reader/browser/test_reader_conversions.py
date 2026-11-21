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

    def test_verified_first_image_starts_before_unrelated_shell_construction(self):
        prefix = 'pages/image/tiff/' + 'b' * 64 + '/'
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': prefix + 'page-manifest.json'})
        self.page.route('**/static/reader/core/reader-store.js*', lambda route: route.fulfill(
            content_type='text/javascript', body=fixtures.support.STORE_SCRIPT.replace(
                'new Promise((resolve) => setTimeout(() => resolve(null), 300))', 'Promise.resolve(null)')))
        self.page.add_init_script('''(() => {
          // Measure demand, not the separate speculative TIFF preload.
          Object.defineProperty(navigator, 'connection', {value: {saveData: true}});
          const create = Document.prototype.createElement;
          Document.prototype.createElement = function(tag, ...args) {
            if (tag === 'section' && window.unrelatedShellStart === undefined && document.querySelector('.reader-page'))
              window.unrelatedShellStart = performance.now();
            return create.call(this, tag, ...args);
          };
          const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
          Object.defineProperty(HTMLImageElement.prototype, 'src', {...src, set(url) {
            if (!window.openingImage && url.includes('page-000001.webp')) {
              window.openingImage = this;
              window.openingImageTotal = document.querySelector('#page-total').textContent;
            }
            src.set.call(this, url);
          }});
        })()''')

        manifests, requests = [], []

        def resource(route):
            path = parse_qs(urlsplit(route.request.url).query)['path'][0]
            if path.endswith('/page-manifest.json'):
                manifests.append(route)
            else:
                requests.append(path)
                route.fulfill(content_type='image/webp', body=fixtures.support.IMAGE_FIXTURES['webp'][1],
                              headers={'Timing-Allow-Origin': '*'})

        self.page.route('**/api/reader-bucket-resource?**', resource)
        for count in (253, 257):
            with self.subTest(count=count):
                requests.clear()
                self.page.goto(self.reader_url('image-pages', url=source), wait_until='domcontentloaded')
                self.page.wait_for_function('() => window.__storeStartedAt !== undefined')
                self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
                self.assertEqual(len(manifests), 1)
                self.assertEqual(requests, [])
                self.assertFalse(self.page.evaluate('!!window.openingImage'))
                manifests.pop().fulfill(json=dict(version=1, kind='image-page-stream', page_count=count, pages=[{}] * count))
                image = self.page.locator('.reader-page[data-page="1"] img.ready')
                image.wait_for(state='visible')
                ordered = self.page.evaluate('''() => {
                  const request = performance.getEntriesByName(window.openingImage.src, 'resource')[0];
                  return {request: request?.startTime, shells: window.unrelatedShellStart};
                }''')
                self.assertLessEqual(ordered['request'], ordered['shells'], ordered)
                self.assertEqual(self.page.evaluate('window.openingImageTotal'), f'/ {count}')
                self.assertTrue(image.evaluate('img => img === window.openingImage && img.complete && img.naturalWidth > 0'))
                self.page.locator('html[data-reader-phase="ready"]').wait_for(state='attached')
                self.assertEqual(requests.count(prefix + 'pages/page-000001.webp'), 1)

    def open_with_held_trailing_shells(self, fail_saved=False, saved=120):
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
                f'Promise.resolve({{page:{saved},pageOffset:28,zoom:100}})')))
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

    def test_saved_image_fetch_does_not_wait_for_its_shell_batch(self):
        requests = self.open_with_held_trailing_shells(saved=253)
        target = self.page.locator('.reader-page[data-page="253"]')
        self.page.wait_for_function('''() => performance.getEntriesByType('resource').some(
            entry => entry.initiatorType === 'img' && entry.name.includes('page-000253.webp'))''')
        self.assertEqual(requests, ['page-000253.webp'])
        self.assertEqual(target.count(), 0)
        self.assertEqual(self.page.locator('.reader-page img.ready').count(), 0)
        self.page.evaluate('window.releaseTrailingShells()')
        target.locator('img.ready').wait_for(state='visible')
        self.page.locator('html[data-reader-phase="ready"]').wait_for(state='attached')
        self.assertEqual(self.page.locator('#page-number').input_value(), '253')
        self.assertEqual(requests.count('page-000253.webp'), 1)

    def test_last_mounted_image_page_waits_until_it_can_be_aligned(self):
        self.open_with_held_trailing_shells()
        final_mounted = self.page.locator('.reader-page').last
        index = final_mounted.get_attribute('data-page')
        self.assertLess(int(index), 253)
        self.assertTrue(final_mounted.evaluate('''node => {
          // Ensure the last mounted page leaves less than a viewport of
          // scroll room (depends on screen height and original image ratio).
          node.style.aspectRatio = 'auto'; node.style.height = '24px';
          const view = document.querySelector('#viewport');
          const top = view.scrollTop + node.getBoundingClientRect().top - view.getBoundingClientRect().top - view.clientTop;
          return top > view.scrollHeight - view.clientHeight + 1;
        }'''))
        field = self.page.locator('#page-number')
        field.fill(index)
        field.press('Enter')
        self.page.evaluate('window.releaseTrailingShells()')
        self.page.locator('html[data-reader-phase="ready"]').wait_for()
        self.page.wait_for_function('''index => {
          const shell=document.querySelector(`.reader-page[data-page="${index}"]`);
          return Math.abs(shell.getBoundingClientRect().top-document.querySelector('#viewport').getBoundingClientRect().top)<3;
        }''', arg=index)
        self.assertEqual(field.input_value(), index)

    def test_speculative_first_page_failure_can_recover_late_saved_image(self):
        prefix = 'pages/image/tiff/' + 'a' * 64 + '/'
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?' + urlencode({
            'path': prefix + 'page-manifest.json'})
        held = []
        def resource(route):
            path = parse_qs(urlsplit(route.request.url).query)['path'][0]
            if path.endswith('/page-manifest.json'):
                route.fulfill(json=dict(version=1, kind='image-page-stream', page_count=3, pages=[{}] * 3))
            elif path.endswith('/page-000001.webp'):
                held.append(route)
            else:
                route.fulfill(content_type='image/webp', body=fixtures.support.IMAGE_FIXTURES['webp'][1])
        self.page.route('**/api/reader-bucket-resource?**', resource)
        self.page.route('**/static/reader/core/reader-store.js*', lambda route: route.fulfill(
            content_type='text/javascript', body=fixtures.support.STORE_SCRIPT.replace(
                'new Promise((resolve) => setTimeout(() => resolve(null), 300))',
                'new Promise(resolve => {window.__finishHistory = resolve})')))
        self.page.goto(self.reader_url('image-pages', url=source), wait_until='domcontentloaded')
        self.page.locator('.reader-page[data-page="1"] img').wait_for(state='attached')
        self.page.evaluate('window.__finishHistory({page:2,pageOffset:0,zoom:100})')
        for route in held:
            route.fulfill(status=404)
        # Some Chromium image paths issue a separate retry after the first error.
        self.page.unroute('**/api/reader-bucket-resource?**', resource)
        self.page.route('**/api/reader-bucket-resource?**', lambda route: route.fulfill(status=404)
                        if 'page-000001.webp' in route.request.url else route.fulfill(
                            content_type='image/webp', body=fixtures.support.IMAGE_FIXTURES['webp'][1]))
        self.page.locator('.reader-page[data-page="2"] img.ready').wait_for()
        self.page.locator('html[data-reader-phase="ready"]').wait_for()
        self.assertEqual(self.page.locator('#page-number').input_value(), '2')
        self.assertEqual(self.page.locator('.reader-error').count(), 0)

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

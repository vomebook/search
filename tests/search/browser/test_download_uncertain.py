"""Uncertain handoffs survive reload and require per-file acknowledgement."""
import unittest
from tests.search.browser import test_browser_smoke as smoke


class UncertainDownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        smoke.BrowserBehaviorTest.setUpClass()

    @classmethod
    def tearDownClass(cls):
        smoke.BrowserBehaviorTest.tearDownClass()

    def setUp(self):
        self.fixture = smoke.BrowserBehaviorTest()
        self.fixture.setUp()
        self.fixture.load('#/?q=download&local=0')
        self.page = self.fixture.page
        self.page.wait_for_function('STATE._loadedPage === 1 && !STATE.isLoading')

    def tearDown(self):
        errors = self.fixture.page_errors[:]
        self.fixture.tearDown()
        self.assertEqual(errors, [])

    def test_uncertain_record_survives_reload_and_can_be_acknowledged(self):
        self.page.evaluate('''async () => {
          window.fetch = async () => new Response('{"ok":true}');
          window.triggerDownload = () => { throw new Error('handoff unknown'); };
          await downloadFileDetailed('uncertain.txt', 'uncertain-link', {quiet:true});
        }''')
        self.assertEqual(self.page.evaluate('uncertainDownloads.length'), 1)
        self.assertTrue(self.page.locator('[data-acknowledge-link="uncertain-link"]').is_visible())
        self.assertIsNone(self.page.evaluate('downloadBatch'))
        self.page.reload(wait_until='domcontentloaded')
        self.page.wait_for_function('typeof startDownloadBatch === "function"')
        self.assertEqual(self.page.evaluate('uncertainDownloads[0].link'), 'uncertain-link')
        self.assertTrue(self.page.locator('[data-acknowledge-link="uncertain-link"]').is_visible())
        self.page.evaluate('''() => {
          window.launches = [];
          window.triggerDownload = url => launches.push(url);
          startDownloadBatch([{filename:'uncertain.txt',link:'uncertain-link'}], true);
        }''')
        self.page.wait_for_function('downloadBatch.done')
        self.assertEqual(self.page.evaluate('launches.length'), 0)
        self.page.locator('[data-queue="close"]').click()
        self.assertIsNone(self.page.evaluate('downloadBatch'))
        self.page.locator('[data-acknowledge-link="uncertain-link"]').click()
        self.assertEqual(self.page.evaluate('[uncertainDownloads.length,launches.length]'), [0, 0])
        self.page.reload(wait_until='domcontentloaded')
        self.page.wait_for_function('typeof startDownloadBatch === "function"')
        self.assertEqual(self.page.evaluate('uncertainDownloads.length'), 0)

    def test_acknowledgement_only_clears_the_chosen_record(self):
        self.page.evaluate('''() => {
          window.checks = [];
          window.launches = [];
          const nativeFetch = window.fetch;
          window.fetch = async (url, options) => {
            if (!String(url).includes('/api/download/check?')) return nativeFetch(url, options);
            checks.push(String(url));
            return new Response('{"ok":true}');
          };
          window.triggerDownload = url => launches.push(url);
          uncertainDownloads.push({filename:'<b>one</b>',link:'one'}, {filename:'two',link:'two'});
          saveUncertainDownloads();
          startDownloadBatch([{filename:'one',link:'one'},{filename:'two',link:'two'}], true);
        }''')
        self.page.wait_for_function('downloadBatch.done')
        self.assertEqual(self.page.locator('[data-uncertain-list] b').count(), 0)
        self.assertFalse(self.page.locator('[data-queue="retry"]').is_visible())
        self.assertEqual(self.page.evaluate('downloadBatch.skippedUncertain.map(item=>item.link)'), ['one', 'two'])
        self.page.locator('[data-acknowledge-link="one"]').click()
        self.assertEqual(self.page.evaluate('uncertainDownloads.map(item=>item.link)'), ['two'])
        self.assertEqual(self.page.locator('[data-acknowledge-link="two"]').count(), 1)
        self.assertTrue(self.page.locator('[data-acknowledge-link="two"]').is_enabled())
        self.assertEqual(self.page.evaluate('downloadBatch.failed.map(item=>item.link)'), ['one'])
        self.assertEqual(self.page.evaluate('downloadBatch.skippedUncertain.map(item=>item.link)'), ['two'])
        self.assertEqual(self.page.evaluate('[checks.length, launches.length]'), [0, 0])
        self.assertTrue(self.page.locator('[data-queue="retry"]').is_visible())
        self.assertTrue(self.page.locator('[data-queue="close"]').is_visible())
        self.page.locator('[data-queue="retry"]').click()
        self.page.wait_for_function('downloadBatch.done')
        self.assertEqual(self.page.evaluate('downloadBatch.items.map(item=>item.link)'), ['one'])
        self.assertEqual(self.page.evaluate('[checks.length, launches.length, downloadBatch.started]'), [1, 1, 1])
        self.assertTrue(self.page.evaluate('checks[0].endsWith("/api/download/check?link=one")'))
        self.assertEqual(self.page.evaluate('uncertainDownloads.map(item=>item.link)'), ['two'])
        self.assertEqual(self.page.evaluate('JSON.parse(sessionStorage.getItem("uncertain-downloads")).map(item=>item.link)'), ['two'])
        self.assertTrue(self.page.locator('[data-acknowledge-link="two"]').is_enabled())


if __name__ == '__main__':
    unittest.main()

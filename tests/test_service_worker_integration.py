import json
import unittest

from tests.browser_support import local_server

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright
except ImportError:
    PlaywrightError = Exception
    sync_playwright = None


@unittest.skipIf(sync_playwright is None, "install requirements-test.txt to run Service Worker integration")
class ServiceWorkerIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = local_server()
        cls.origin, cls.server_state = cls.server.__enter__()
        cls.playwright = sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True)
        except PlaywrightError as error:
            cls.playwright.stop()
            cls.server.__exit__(None, None, None)
            raise unittest.SkipTest(f"Chromium is unavailable: {error}")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def setUp(self):
        self.server_state.reset()
        self.context = self.browser.new_context(service_workers="allow")
        self.page = self.context.new_page()
        self.page.goto(self.origin + "/search/manifest.json", wait_until="commit")
        self.page.evaluate(
            """async () => {
                await Promise.all((await navigator.serviceWorker.getRegistrations()).map(registration => registration.unregister()));
                await Promise.all((await caches.keys()).map(name => caches.delete(name)));
            }"""
        )
        self.page.route(
            "https://voiceofml-search.hf.space/**",
            lambda route: route.fulfill(status=200, content_type="application/json", body="[]"),
        )
        self.page.route(
            "https://vomebook-hitokoto.hf.space/**",
            lambda route: route.fulfill(status=200, content_type="application/json", body="{}"),
        )

    def tearDown(self):
        self.context.close()

    def prime(self, wait_for_data=False):
        response = self.page.goto(self.origin + "/search/", wait_until="domcontentloaded")
        self.assertEqual(response.status, 200)
        self.page.evaluate("navigator.serviceWorker.ready")
        if wait_for_data:
            self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
            self.page.wait_for_function(
                """async () => {
                    const cache = await caches.open('vomebook-search-v1.0.0');
                    const paths = ['/search/data/search_data.json.gz', '/search/data/initial/global.json', '/search/data/sidebar/global.json'];
                    return (await Promise.all(paths.map(path => cache.match(path)))).every(Boolean);
                }""",
                timeout=10000,
            )
        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_function("navigator.serviceWorker.controller !== null")

    def cache_urls(self):
        return self.page.evaluate(
            """async () => {
                const names = await caches.keys();
                const values = {};
                for (const name of names) {
                    const cache = await caches.open(name);
                    values[name] = (await cache.keys()).map(request => request.url).sort();
                }
                return values;
            }"""
        )

    def test_registration_scope_and_controller_after_reload(self):
        self.prime()
        registration = self.page.evaluate(
            """async () => {
                const reg = await navigator.serviceWorker.ready;
                return {scope: reg.scope, script: reg.active.scriptURL, controlled: !!navigator.serviceWorker.controller};
            }"""
        )
        self.assertEqual(registration["scope"], self.origin + "/search/")
        self.assertEqual(registration["script"], self.origin + "/search/sw.js")
        self.assertTrue(registration["controlled"])

    def test_fixed_cache_contains_core_and_both_manifest_payload_lists(self):
        self.prime()
        caches_by_name = self.cache_urls()
        self.assertEqual(list(caches_by_name), ["vomebook-search-v1.0.0"])
        urls = set(caches_by_name["vomebook-search-v1.0.0"])
        initial = json.loads((self.origin_path("data/initial/manifest.json")).read_text(encoding="utf-8"))
        sidebar = json.loads((self.origin_path("data/sidebar/manifest.json")).read_text(encoding="utf-8"))
        expected_paths = [
            "/search/#/",
            "/search/static/app.js",
            "/search/static/index-worker.js",
            "/search/data/initial/manifest.json",
            "/search/data/sidebar/manifest.json",
        ] + initial["urls"] + sidebar["urls"]
        for path in expected_paths:
            self.assertIn(self.origin + path, urls, path)
        self.assertFalse(any("/static/vendor/" in url for url in urls))

    def test_reader_query_navigations_keep_one_normalized_cache_entry(self):
        self.prime()
        for suffix in ("one", "two"):
            self.page.goto(
                self.origin + "/search/static/reader.html?url="
                + f"https%3A%2F%2Fhuggingface.co%2Fdatasets%2FVoiceOfML%2FTest%2Fresolve%2Fmain%2F{suffix}.txt"
                + "&ext=txt",
                wait_until="domcontentloaded",
            )
        urls = self.cache_urls()["vomebook-search-v1.0.0"]
        reader_urls = [url for url in urls if "/search/static/reader.html" in url]
        self.assertEqual(reader_urls, [self.origin + "/search/static/reader.html"])

    def origin_path(self, relative):
        from tests.browser_support import ROOT
        return ROOT / relative

    def test_offline_shell_reload_executes_app_and_renders_initial_results(self):
        self.prime(wait_for_data=True)
        self.context.set_offline(True)
        response = self.page.reload(wait_until="domcontentloaded")
        self.assertIsNotNone(response)
        self.assertEqual(response.status, 200)
        self.page.locator("#search-input").wait_for(state="visible")
        self.page.locator("#results-list .result-item").first.wait_for(timeout=15000)
        self.assertEqual(self.page.title(), "VoiceOfML Search")
        self.assertGreater(self.page.locator("#results-list .result-item").count(), 0)
        self.assertTrue(self.page.evaluate("!!navigator.serviceWorker.controller"))
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.page.locator("#search-input").fill("手机")
        self.page.wait_for_function("STATE.query === '手机' && STATE.total > 0", timeout=30000)
        self.assertGreater(self.page.evaluate("STATE.results.length"), 0)
        self.assertTrue(self.page.evaluate("STATE.useLocalMode"))

    def test_fresh_offline_without_cached_corpus_keeps_initial_and_disables_local(self):
        with self.server_state.lock:
            self.server_state.failures["/search/data/search_data.json.gz"] = 503
        self.prime(wait_for_data=False)
        self.page.wait_for_function("STATE._initialActive === true", timeout=10000)
        self.page.wait_for_function("STATE.useLocalMode === false", timeout=30000)
        self.assertGreater(self.page.locator("#results-list .result-item").count(), 0)
        self.context.set_offline(True)
        self.page.reload(wait_until="domcontentloaded")
        self.page.locator("#results-list .result-item").first.wait_for(timeout=15000)
        self.page.wait_for_function("STATE.useLocalMode === false", timeout=30000)
        self.assertFalse(self.page.evaluate("STATE.dataLoaded"))
        self.assertGreater(self.page.locator("#results-list .result-item").count(), 0)

    def test_offline_cached_gzip_initial_and_sidebar_fetches_succeed(self):
        self.prime(wait_for_data=True)
        self.context.set_offline(True)
        fetched = self.page.evaluate(
            """async () => {
                const gzip = await fetch('/search/data/search_data.json.gz');
                const bytes = new Uint8Array(await gzip.arrayBuffer());
                const initial = await fetch('/search/data/initial/global.json');
                const sidebar = await fetch('/search/data/sidebar/global.json');
                return {
                    gzip: [gzip.status, bytes[0], bytes[1], bytes.length],
                    initial: [initial.status, (await initial.json()).mode],
                    sidebar: [sidebar.status, Array.isArray((await sidebar.json()).repos)],
                };
            }"""
        )
        self.assertEqual(fetched["gzip"][:3], [200, 0x1F, 0x8B])
        self.assertGreater(fetched["gzip"][3], 100)
        self.assertEqual(fetched["initial"], [200, "global"])
        self.assertEqual(fetched["sidebar"], [200, True])

    def test_external_api_is_bypassed_and_never_added_to_cache_storage(self):
        seen = []
        self.page.unroute("https://voiceofml-search.hf.space/**")
        self.page.route(
            "https://voiceofml-search.hf.space/**",
            lambda route: (seen.append(route.request.url), route.fulfill(status=200, content_type="application/json", body='{"outside":true}')),
        )
        self.prime()
        result = self.page.evaluate("fetch('https://voiceofml-search.hf.space/api/outside').then(r => r.json())")
        self.assertEqual(result, {"outside": True})
        self.assertTrue(any(url.endswith("/api/outside") for url in seen))
        all_urls = sum(self.cache_urls().values(), [])
        self.assertFalse(any("voiceofml-search.hf.space" in url for url in all_urls))


if __name__ == "__main__":
    unittest.main(verbosity=2)

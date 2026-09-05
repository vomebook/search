import json
import unittest

from tests.browser_support import local_server

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright
except ImportError:
    PlaywrightError = Exception
    sync_playwright = None


def result(name):
    return {
        "Repo": "VoiceOfML/VOMEBOOK",
        "File": name,
        "Extension": "txt",
        "Folder": [],
        "Size": 10,
        "HasTxt": True,
    }


@unittest.skipIf(sync_playwright is None, "install requirements-test.txt to run API integration")
class ApiIntegrationTest(unittest.TestCase):
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
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 800})
        self.page = self.context.new_page()
        self.search_requests = []
        self.probe_requests = 0
        self.search_failures = False
        self.search_response_override = None
        self.page.route("https://voiceofml-search.hf.space/**", self.api_route)
        self.page.route(
            "https://vomebook-hitokoto.hf.space/**",
            lambda route: route.fulfill(status=200, content_type="application/json", body="{}"),
        )

    def tearDown(self):
        self.context.close()

    def api_route(self, route):
        path = route.request.url.split("?", 1)[0]
        if "/api/search" in path:
            body = json.loads(route.request.post_data or "{}")
            self.search_requests.append(body)
            if self.search_failures:
                route.fulfill(status=503, content_type="application/json", body='{"error":"test"}')
            elif self.search_response_override is not None:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(self.search_response_override))
            else:
                query = body.get("q", "empty")
                payload = {"page": body.get("page", 1), "page_size": body.get("page_size", 100), "total": 1, "results": [result(query + " result")]}
                route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
        elif path.endswith("/api/repos"):
            self.probe_requests += 1
            route.fulfill(status=200, content_type="application/json", body='[{"name":"VoiceOfML/VOMEBOOK","count":1}]')
        elif path.endswith("/api/extensions"):
            route.fulfill(status=200, content_type="application/json", body='[{"name":"txt","count":1}]')
        elif path.endswith("/api/random-txt/status"):
            route.fulfill(status=200, content_type="application/json", body='{"available":false}')
        else:
            route.fulfill(status=200, content_type="application/json", body="{}")

    def load(self, hash_value=""):
        response = self.page.goto(self.origin + "/search/" + hash_value, wait_until="domcontentloaded")
        self.assertEqual(response.status, 200)
        self.page.locator("#search-input").wait_for(state="visible")

    def test_initial_to_local_handoff_preserves_render_and_scroll(self):
        with self.server_state.lock:
            self.server_state.delays["/search/data/search_data.json.gz"] = 1.0
        self.load()
        self.page.wait_for_function("STATE._initialActive === true")
        self.page.locator("#results-list .result-item").first.wait_for(timeout=10000)
        before = self.page.evaluate(
            """() => {
                const container = document.querySelector('#results-container');
                container.scrollTop = 180;
                return {first: document.querySelector('#results-list .result-item').innerText, scrollTop: container.scrollTop, total: STATE.total, count: STATE.results.length};
            }"""
        )
        self.page.wait_for_function("STATE.dataLoaded === true && STATE._initialActive === false", timeout=30000)
        after = self.page.evaluate(
            """() => ({
                first: document.querySelector('#results-list .result-item').innerText,
                scrollTop: document.querySelector('#results-container').scrollTop,
                total: STATE.total,
                count: STATE.results.length,
            })"""
        )
        self.assertEqual(after["first"], before["first"])
        self.assertEqual(after["scrollTop"], before["scrollTop"])
        self.assertEqual(after["total"], before["total"])
        self.assertEqual(after["count"], before["count"])

    def test_stalled_page_two_prefetch_does_not_block_local_corpus_loading(self):
        self.page.add_init_script(
            """(() => {
                const nativeFetch = window.fetch.bind(window);
                window.fetch = function(input, options) {
                    let body = {};
                    try { body = JSON.parse(options && options.body || '{}'); } catch (_) {}
                    if (String(input).includes('/api/search') && body.page === 2) {
                        return new Promise(() => {});
                    }
                    return nativeFetch(input, options);
                };
            })();"""
        )
        self.load()
        self.page.wait_for_function("searchPrefetchPromise !== null")
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.assertGreaterEqual(self.server_state.count("/search/data/search_data.json.gz"), 1)
        self.assertTrue(self.page.evaluate("searchPrefetchPromise !== null"))

    def test_local_disabled_sends_complete_api_body_and_renders_response(self):
        self.load("#/?q=body-query&local=0&ext=pdf&sort=size&search_folders=false&exact=0&min_size=10&max_size=20")
        self.page.locator("#results-list").get_by_text("body-query result").wait_for(timeout=10000)
        body = next(item for item in self.search_requests if item.get("q") == "body-query" and item.get("page") == 1)
        self.assertEqual(body["page_size"], 100)
        self.assertEqual(body["extensions"], ["pdf"])
        self.assertEqual(body["sort"], "size")
        self.assertEqual(body["min_size"], 10)
        self.assertEqual(body["max_size"], 20)
        self.assertFalse(body["search_folders"])
        self.assertNotIn("exact", body)
        self.assertIn("local=0", self.page.evaluate("location.hash"))

    def test_delayed_stale_api_response_cannot_replace_newer_query(self):
        self.page.add_init_script(
            """(() => {
                const nativeFetch = window.fetch.bind(window);
                window.fetch = async function(input, options) {
                    const response = await nativeFetch(input, options);
                    let body = {};
                    try { body = JSON.parse(options && options.body || '{}'); } catch (_) {}
                    if (String(input).includes('/api/search') && body.q === 'old-query') {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    return response;
                };
            })();"""
        )
        self.load("#/?local=0")
        search = self.page.locator("#search-input")
        search.fill("old-query")
        self.page.wait_for_timeout(180)
        search.fill("new-query")
        self.page.locator("#results-list").get_by_text("new-query result").wait_for(timeout=10000)
        self.page.wait_for_timeout(700)
        text = self.page.locator("#results-list").inner_text()
        self.assertIn("new-query result", text)
        self.assertNotIn("old-query result", text)
        self.assertTrue(any(body.get("q") == "old-query" for body in self.search_requests))
        self.assertTrue(any(body.get("q") == "new-query" for body in self.search_requests))

    def test_stale_prefetch_failure_does_not_trip_current_api_circuit(self):
        self.page.add_init_script(
            """(() => {
                const nativeFetch = window.fetch.bind(window);
                window.__stalePrefetchSettled = false;
                window.__releaseStalePrefetch = null;
                window.fetch = function(input, options) {
                    let body = {};
                    try { body = JSON.parse(options && options.body || '{}'); } catch (_) {}
                    if (String(input).includes('/api/search') && body.page === 2) {
                        return new Promise((resolve, reject) => {
                            window.__releaseStalePrefetch = () => {
                                window.__stalePrefetchSettled = true;
                                reject(new Error('stale prefetch failure'));
                            };
                        });
                    }
                    return nativeFetch(input, options);
                };
            })();"""
        )
        self.load("#/?local=0")
        self.page.wait_for_function("searchPrefetchPromise !== null && window.__releaseStalePrefetch !== null")
        search = self.page.locator("#search-input")
        search.fill("current-query")
        self.page.locator("#results-list").get_by_text("current-query result").wait_for(timeout=10000)
        self.page.evaluate("window.__releaseStalePrefetch()")
        self.page.wait_for_function("window.__stalePrefetchSettled && apiFailureCount === 0")
        self.assertTrue(self.page.evaluate("apiAvailable"))

    def assert_invalid_search_response_falls_back(self, payload, query):
        self.load("#/?local=0")
        self.page.wait_for_function("STATE._initialActive === true")
        self.page.evaluate(
            """() => {
                window.__apiFailureCalls = 0;
                const original = noteApiFailure;
                noteApiFailure = function() {
                    window.__apiFailureCalls += 1;
                    return original();
                };
            }"""
        )
        self.search_response_override = payload
        self.page.locator("#search-input").fill(query)
        self.page.wait_for_function("window.__apiFailureCalls > 0", timeout=10000)
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.page.wait_for_function("STATE.useLocalMode === true", timeout=10000)
        self.assertIsInstance(self.page.evaluate("STATE.results"), list)
        self.assertIsInstance(self.page.evaluate("STATE.total"), int)
        self.assertTrue(self.page.evaluate(
            "Array.from(searchResponseCache.values()).every(entry => entry.data && Array.isArray(entry.data.results))"
        ))

    def test_fractional_total_uses_unified_api_failure_fallback(self):
        self.assert_invalid_search_response_falls_back(
            {"page": 1, "page_size": 100, "total": 1.5, "results": [result("fractional")]},
            "fractional-total",
        )

    def test_null_result_uses_unified_api_failure_fallback(self):
        self.assert_invalid_search_response_falls_back(
            {"page": 1, "page_size": 100, "total": 1, "results": [None]},
            "null-result",
        )

    def test_wrong_page_uses_unified_api_failure_fallback(self):
        self.assert_invalid_search_response_falls_back(
            {"page": 2, "page_size": 100, "total": 1, "results": [result("wrong-page")]},
            "wrong-page",
        )

    def test_wrong_page_size_uses_unified_api_failure_fallback(self):
        self.assert_invalid_search_response_falls_back(
            {"page": 1, "page_size": 20, "total": 1, "results": [result("wrong-page-size")]},
            "wrong-page-size",
        )

    def test_runtime_header_logo_stays_inside_search_prefix(self):
        self.load("#/?local=0")
        self.assertEqual(self.page.locator("#header-logo").get_attribute("href"), "/search/")
        self.page.evaluate("location.hash = '#/VOMEBOOK?local=0'")
        self.page.wait_for_function("STATE.mode === 'repo'")
        self.assertEqual(self.page.locator("#header-logo").get_attribute("href"), "/search/")

    def test_local_disabled_empty_query_keeps_intentional_initial_payload(self):
        self.load("#/?local=0")
        self.page.wait_for_function("STATE._initialActive === true")
        self.page.locator("#results-list .result-item").first.wait_for(timeout=10000)
        self.assertFalse(self.page.evaluate("STATE.useLocalMode"))
        self.assertGreater(self.page.evaluate("STATE.results.length"), 0)
        self.assertFalse(any(body.get("page") == 1 for body in self.search_requests))

    def test_inflight_prefetch_reuses_the_same_promise(self):
        self.load("#/?local=0")
        self.page.wait_for_function("STATE._initialActive === true")
        reused = self.page.evaluate(
            """async () => {
                if (searchPrefetchAbortController) searchPrefetchAbortController.abort();
                searchPrefetchAbortController = null;
                searchPrefetchPromise = null;
                searchPrefetchCacheKey = null;
                STATE._loadedPage = 1;
                STATE.total = Math.max(STATE.total, STATE.pageSize * 3);
                STATE._pageCache = {};
                let calls = 0;
                const nativeFetch = window.fetch;
                window.fetch = function(_input, options) {
                    calls += 1;
                    return new Promise((_resolve, reject) => {
                        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                    });
                };
                const first = prefetchNextPage();
                const second = prefetchNextPage();
                const result = first === second && calls === 1;
                searchPrefetchAbortController.abort();
                await first;
                window.fetch = nativeFetch;
                return result;
            }"""
        )
        self.assertTrue(reused)

    def test_three_failures_open_circuit_and_fast_probe_recovers(self):
        self.page.add_init_script(
            """(() => {
                const nativeSetTimeout = window.setTimeout.bind(window);
                window.setTimeout = (fn, delay, ...args) => nativeSetTimeout(fn, delay === 30000 ? 50 : delay, ...args);
            })();"""
        )
        self.load()
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.page.evaluate("apiFailureCount = 0; apiAvailable = true")
        baseline_probes = self.probe_requests
        self.search_failures = True
        search = self.page.locator("#search-input")
        for query in ["failure-one", "failure-two", "failure-three"]:
            self.page.locator("#local-mode-toggle").evaluate(
                "el => { el.checked = false; el.dispatchEvent(new Event('change', {bubbles: true})); }"
            )
            search.fill(query)
            self.page.wait_for_function("STATE.useLocalMode === true", timeout=10000)
        self.assertFalse(self.page.evaluate("apiAvailable"))
        self.search_failures = False
        self.page.wait_for_function("apiAvailable === true", timeout=5000)
        self.assertGreater(self.probe_requests, baseline_probes)
        self.assertEqual(self.page.evaluate("apiFailureCount"), 0)

    def test_worker_failure_restarts_once_then_uses_api_fallback(self):
        self.page.add_init_script(
            """(() => {
                window.Worker = class BrokenWorker {
                    constructor() { this.listeners = {}; }
                    addEventListener(type, listener) { this.listeners[type] = listener; }
                    postMessage() {
                        setTimeout(() => {
                            if (this.listeners.error) this.listeners.error({message: 'injected worker failure'});
                        }, 0);
                    }
                    terminate() {}
                };
            })();"""
        )
        self.load("#/?q=worker-failure")
        self.page.locator("#results-list").get_by_text("worker-failure result").wait_for(timeout=10000)
        self.page.wait_for_function("STATE.useLocalMode === false", timeout=30000)
        self.assertTrue(any(body.get("q") == "worker-failure" for body in self.search_requests))
        self.assertEqual(self.page.evaluate("corpusWorkerRestartCount"), 1)
        self.assertFalse(self.page.evaluate("STATE.dataLoaded"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

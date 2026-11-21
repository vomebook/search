import base64
import hashlib
import json
import time
import unittest

from tests.support.browser_support import local_server

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
        # A loopback-only runner can report offline while our HTTP server is
        # reachable. Model the scenario's signal; set_offline still blocks real
        # browser traffic, and sessionStorage carries the signal across reloads.
        self.page.add_init_script("""Object.defineProperty(navigator, 'onLine', {
            configurable: true, get: () => sessionStorage.getItem('sw-test-offline') !== 'true'
        });""")
        self.page.add_init_script("""window.findOwnedServiceWorkerCache = async () => {
            const prefix = 'vomebook-search-', metadata = prefix + 'metadata';
            if (!(await caches.has(metadata))) return null;
            const response = await (await caches.open(metadata)).match('/search/.sw-active-generation');
            if (!response) return null;
            const state = await response.json();
            const name = state && state.active;
            if (typeof name !== 'string' || !name.startsWith(prefix) || name === metadata ||
                name === prefix || !(await caches.has(name)))
                throw new Error('Invalid or missing active search cache: ' + name);
            return caches.open(name);
        };""")
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

    def go_offline(self):
        self.context.set_offline(True)
        self.page.evaluate("""() => {
            sessionStorage.setItem('sw-test-offline', 'true');
            window.dispatchEvent(new Event('offline'));
        }""")
        self.assertFalse(self.page.evaluate('navigator.onLine'))
        # Prove actual network isolation, independently of navigator.onLine and
        # the SW's cached shell. This URL is outside the worker's scope.
        path = '/sw-test-network-probe'
        before = self.server_state.count(path)
        self.assertTrue(self.page.evaluate("""async path => {
            try { await fetch(path, {cache: 'no-store'}); return false; }
            catch (error) { return error.name === 'TypeError'; }
        }""", path))
        self.assertEqual(self.server_state.count(path), before)

    def prime(self, wait_for_data=False):
        response = self.page.goto(self.origin + "/search/", wait_until="domcontentloaded")
        self.assertEqual(response.status, 200)
        self.page.evaluate("navigator.serviceWorker.ready")
        self.page.wait_for_function("navigator.serviceWorker.controller !== null")
        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_function("navigator.serviceWorker.controller !== null")
        if wait_for_data:
            # Verify persistence after the last online navigation; going offline
            # during its background corpus refresh can interrupt the cache write.
            self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
            self.page.wait_for_function(
                """async () => {
                    const cache = await window.findOwnedServiceWorkerCache();
                    const paths = ['/search/data/search_data.json.gz', '/search/data/initial/global.json', '/search/data/sidebar/global.json'];
                    return (await Promise.all(paths.map(path => cache.match(path)))).every(Boolean);
                }""",
                timeout=10000,
            )

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

    def test_real_upgrade_preserves_previous_generation_and_failed_install_isolation(self):
        source = self.origin_path('static/sw.js').read_text()
        # Actual prior release URL; the implementation now lives in reader-host.
        old_asset = '/search/static/search/reader-navigation.6739fa74e2e7.js'
        current_asset = '/search/static/search/reader-host/application/navigation.6739fa74e2e7.js'
        reader_shell = '/search/static/reader.html'
        html = self.origin_path('static/reader.html').read_bytes()
        integrity = 'sha256-' + base64.b64encode(hashlib.sha256(html).digest()).decode()
        search_html = self.origin_path('static/index.html').read_bytes()
        search_integrity = 'sha256-' + base64.b64encode(hashlib.sha256(search_html).digest()).decode()
        wrong_search_integrity = 'sha256-' + base64.b64encode(hashlib.sha256(b'other release').digest()).decode()
        prefix = 'vomebook-search-'
        names = {version: prefix + version for version in ('browser-a', 'browser-b', 'browser-c')}

        def serve_worker(version, hashed=False, wrong_shell=False):
            worker = source.replace('CACHE_VERSION = "development"',
                                    f'CACHE_VERSION = {json.dumps(version)}')
            if hashed:
                worker = worker.replace('READER_SHELL_INTEGRITY = "development"',
                                        f'READER_SHELL_INTEGRITY = {json.dumps(integrity)}')
                worker = worker.replace('SEARCH_SHELL_INTEGRITY = "development"',
                                        'SEARCH_SHELL_INTEGRITY = ' + json.dumps(
                                            wrong_search_integrity if wrong_shell else search_integrity))
                # This fixture serves unbundled modules, so retain the source
                # dependency closure while testing the production SRI rules.
                worker = worker.replace('if (READER_SHELL_INTEGRITY === "development") {', 'if (true) {', 1)
                # Stamp the inventory before the worker constructs its Set,
                # just as the production build does.
                worker = worker.replace('const currentAssetPaths = new Set(CURRENT_HASHED_ASSETS);', '')
                worker = worker.replace('readerWorkerScope.addEventListener("install"',
                                        'const currentAssetPaths = new Set([...PRECACHE_URLS, '
                                        + json.dumps(current_asset) + ']);\n'
                                        'readerWorkerScope.addEventListener("install"')
            with self.server_state.lock:
                self.server_state.worker_source = worker

        def state():
            return self.page.evaluate('''async () => {
              const name = 'vomebook-search-metadata';
              if (!(await caches.has(name))) throw Error('Missing generation metadata');
              const cache = await caches.open(name);
              return (await cache.match('/search/.sw-active-generation')).json();
            }''')

        def update(expected):
            result = self.page.evaluate('''async () => {
              const registration = await navigator.serviceWorker.ready;
              window.__previousController = navigator.serviceWorker.controller;
              let timer, onUpdate;
              const settled = new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(Error('Worker update timed out')), 20000);
                onUpdate = () => {
                  const candidate = registration.installing;
                  const changed = () => {
                    if (candidate.state === 'redundant' || candidate.state === 'activated') {
                      candidate.removeEventListener('statechange', changed);
                      resolve(candidate.state);
                    }
                  };
                  candidate.addEventListener('statechange', changed);
                  changed();
                };
                registration.addEventListener('updatefound', onUpdate, {once:true});
              });
              try {
                await registration.update();
                return await settled;
              } finally {
                clearTimeout(timer);
                registration.removeEventListener('updatefound', onUpdate);
              }
            }''')
            self.assertEqual(result, expected)

        serve_worker('browser-a')
        # Register from a neutral page in scope, without the Search app's
        # controllerchange hook warming Reader assets for either generation.
        self.page.evaluate("navigator.serviceWorker.register('/search/sw.js', {scope: '/search/'})")
        self.page.wait_for_function('navigator.serviceWorker.controller !== null')
        self.assertEqual(state(), {'active': names['browser-a'], 'previous': None, 'history': []})
        self.page.evaluate('''async ([path, shell]) => {
          const cache = await window.findOwnedServiceWorkerCache();
          await cache.put(path, new Response('old immutable bytes', {headers:{'Content-Type':'text/javascript'}}));
          await cache.put(shell, new Response('old Reader shell'));
          await cache.put('/search/data/upgrade-old.json', new Response('old mutable bytes'));
          await (await caches.open('unrelated-browser-cache')).put('/foreign', new Response('keep'));
        }''', [old_asset, reader_shell])

        serve_worker('browser-b', hashed=True)
        with self.server_state.lock:
            self.server_state.failures[reader_shell] = 503
        update('redundant')
        self.assertTrue(self.page.evaluate('navigator.serviceWorker.controller === window.__previousController'))
        self.assertEqual(state(), {'active': names['browser-a'], 'previous': None, 'history': []})
        self.assertNotIn(names['browser-b'], self.cache_urls())
        self.assertEqual(self.page.evaluate('path => fetch(path).then(r => r.text())', old_asset), 'old immutable bytes')

        with self.server_state.lock:
            self.server_state.failures.pop(reader_shell)
        # The server now returns HTTP 200 for every core URL, but the Search
        # shell belongs to the wrong release and must not replace A.
        serve_worker('browser-b', hashed=True, wrong_shell=True)
        update('redundant')
        self.assertNotIn(names['browser-b'], self.cache_urls())
        self.assertEqual(state()['active'], names['browser-a'])
        serve_worker('browser-b', hashed=True)
        update('activated')
        self.page.wait_for_function('navigator.serviceWorker.controller !== window.__previousController')
        self.assertEqual(state(), {'active': names['browser-b'], 'previous': names['browser-a'],
                                   'history': [names['browser-a']]})
        caches_by_name = self.cache_urls()
        self.assertIn(self.origin + old_asset, caches_by_name[names['browser-a']])
        self.assertNotIn(self.origin + reader_shell, caches_by_name[names['browser-a']])
        self.assertIn(self.origin + reader_shell, caches_by_name[names['browser-b']])
        self.assertNotIn(self.origin + '/search/data/upgrade-old.json', caches_by_name[names['browser-a']])
        self.assertIn('unrelated-browser-cache', caches_by_name)
        # The server has no such hash: a 404 must fall back to the actual A cache.
        self.assertEqual(self.page.evaluate('path => fetch(path).then(r => r.text())', old_asset), 'old immutable bytes')
        self.assertNotIn(self.origin + old_asset, self.cache_urls()[names['browser-b']])

        serve_worker('browser-c', hashed=True)
        update('activated')
        self.page.wait_for_function('navigator.serviceWorker.controller !== window.__previousController')
        self.assertEqual(state(), {'active': names['browser-c'], 'previous': names['browser-b'],
                                   'history': [names['browser-b'], names['browser-a']]})
        caches_by_name = self.cache_urls()
        self.assertIn(names['browser-a'], caches_by_name)
        self.assertIn(names['browser-b'], caches_by_name)
        self.assertEqual(caches_by_name['unrelated-browser-cache'], [self.origin + '/foreign'])
        self.assertIn(self.origin + reader_shell, caches_by_name[names['browser-c']])

        # No Reader navigation or online warmup under C. Simulate a saved share
        # link whose document was never cached, not just the no-document shell.
        self.page.route('**/api/reader-content?*', lambda route: route.abort('internetdisconnected'))
        self.go_offline()
        self.assertEqual(self.page.evaluate('path => fetch(path).then(r => r.text())', old_asset), 'old immutable bytes')
        share = (reader_shell + '?ext=txt&url=https%3A%2F%2Fhuggingface.co%2Fdatasets%2F'
                 'VoiceOfML%2FTest%2Fresolve%2Fmain%2Fnever-cached.txt')
        response = self.page.goto(self.origin + share, wait_until='domcontentloaded')
        self.assertTrue(response.from_service_worker)
        self.assertEqual(response.status, 200)
        self.page.locator('#back').wait_for(state='visible')
        self.page.locator('#content .reader-error').wait_for(state='visible')
        self.assertEqual(self.page.locator('#status').inner_text(), '无法打开')
        self.assertEqual(self.page.url, self.origin + share)
        self.assertEqual([url for url in self.cache_urls()[names['browser-c']] if reader_shell in url],
                         [self.origin + reader_shell])

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

    def test_hashed_reader_asset_reuses_cache_across_duplicate_origin_vary_headers(self):
        self.prime()
        result = self.page.evaluate('''async () => {
          const cache = await window.findOwnedServiceWorkerCache();
          const url = new URL('/search/static/reader.123456789abc.js', location.origin).href;
          await cache.put(new Request(url, {headers: {Origin: location.origin, 'X-Reader-Intent': 'warm'}}),
            new Response('window.__cachedReaderExecutions = (window.__cachedReaderExecutions || 0) + 1;',
              {headers: {'Content-Type': 'text/javascript',
                Vary: 'Origin, origin, access-control-request-method, access-control-request-headers, X-Reader-Intent'}}));
          const ordinary = !!await cache.match(url);
          const load = crossorigin => new Promise((resolve, reject) => {
            const script = document.createElement('script'); script.src = url;
            if (crossorigin) script.crossOrigin = 'anonymous';
            script.onload = resolve; script.onerror = reject; document.head.append(script);
          });
          await load(false); await load(true); await import(url);
          return {ordinary, executions: window.__cachedReaderExecutions};
        }''')
        self.assertEqual(result, {"ordinary": False, "executions": 3})
        self.assertEqual(self.server_state.count('/search/static/reader.123456789abc.js'), 0)

    def test_offline_cache_misses_reject_as_network_errors_and_cached_data_survives(self):
        self.prime()
        self.page.evaluate("""async () => {
            const cache = await window.findOwnedServiceWorkerCache();
            await cache.put('/search/data/offline-available.json', new Response('{"cached":true}', {
                headers: {'Content-Type': 'application/json'}
            }));
        }""")
        self.go_offline()
        result = self.page.evaluate("""async () => {
            async function outcome(path) {
                try {
                    const response = await fetch(path);
                    return {resolved: true, status: response.status, text: await response.text()};
                } catch (error) {
                    return {resolved: false, name: error.name};
                }
            }
            return {
                cached: await outcome('/search/data/offline-available.json'),
                missingData: await outcome('/search/data/offline-not-cached.json'),
                missingStatic: await outcome('/search/static/offline-not-cached.bin')
            };
        }""")
        self.assertTrue(result["cached"]["resolved"])
        self.assertEqual(result["cached"]["status"], 200)
        self.assertEqual(json.loads(result["cached"]["text"]), {"cached": True})
        for name in ("missingData", "missingStatic"):
            with self.subTest(resource=name):
                self.assertEqual(result[name], {"resolved": False, "name": "TypeError"})

    def test_existing_cache_serves_immediately_then_persists_background_refresh(self):
        self.prime()
        self.page.evaluate("""async () => {
            const cache = await window.findOwnedServiceWorkerCache();
            await cache.put('/search/manifest.json?background-test=1', new Response('{"old":true}', {
                headers: {'Content-Type': 'application/json'}
            }));
        }""")
        with self.server_state.lock:
            self.server_state.delays["/search/manifest.json"] = 0.5
        result = self.page.evaluate("fetch('/search/manifest.json?background-test=1', {cache: 'no-store'}).then(response => response.json())")
        self.assertEqual(result, {"old": True})
        self.assertTrue(self.page.evaluate("""async () => {
            const cache = await window.findOwnedServiceWorkerCache();
            for (let attempt = 0; attempt < 100; attempt++) {
                const response = await cache.match('/search/manifest.json?background-test=1');
                if ((await response.json()).name) return true;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return false;
        }"""))
        self.go_offline()
        result = self.page.evaluate("fetch('/search/manifest.json?background-test=1', {cache: 'no-store'}).then(response => response.json())")
        self.assertIn("name", result)

    def test_cache_discovery_does_not_create_a_cache_before_install(self):
        self.assertIsNone(self.page.evaluate("window.findOwnedServiceWorkerCache()"))
        self.assertEqual(self.cache_urls(), {})

    def test_owned_cache_contains_core_without_unused_repository_or_engine_payloads(self):
        self.prime()
        caches_by_name = self.cache_urls()
        self.assertEqual(caches_by_name.pop('vomebook-search-metadata'),
                         [self.origin + '/search/.sw-active-generation'])
        self.assertEqual(len(caches_by_name), 1)
        name, cached_urls = next(iter(caches_by_name.items()))
        self.assertTrue(name.startswith("vomebook-search-"), name)
        self.assertNotEqual(name, "vomebook-search-")
        urls = {url.split('#', 1)[0] for url in cached_urls}
        expected_paths = [
            "/search/",
            "/search/static/app.js",
            "/search/static/search/reader-host/application/navigation.js",
            "/search/static/search/index-worker.js",
            "/search/data/initial/manifest.json",
            "/search/data/sidebar/manifest.json",
            "/search/data/initial/global.json",
            "/search/data/sidebar/global.json",
        ]
        for path in expected_paths:
            self.assertIn(self.origin + path, urls, path)
        self.assertFalse(any("/static/vendor/" in url for url in urls))
        self.assertFalse(any("/repos/" in url for url in urls))

    def test_warmed_reader_shell_does_not_wait_for_slow_revalidation(self):
        self.prime()
        self.assertTrue(self.page.evaluate('''async () => {
          const cache = await window.findOwnedServiceWorkerCache();
          for(let i=0;i<200;i++) {
            if(await cache.match('/search/static/reader.html') && await cache.match('/search/static/reader.js')) return true;
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          return false;
        }'''))
        with self.server_state.lock:
            self.server_state.delays['/search/static/reader.html'] = 3
        started = time.monotonic()
        response = self.page.goto(self.origin + '/search/static/reader.html?ext=txt', wait_until='domcontentloaded')
        self.assertLess(time.monotonic() - started, 2, self.page.evaluate('''()=>({
          navigation:performance.getEntriesByType('navigation').map(r=>r.toJSON()),
          resources:performance.getEntriesByType('resource').map(r=>({name:r.name,start:r.startTime,ms:r.duration}))})'''))
        self.assertTrue(response.from_service_worker)
        self.assertEqual(response.status, 200)
        self.page.locator('#back').wait_for(state='visible')

    def test_warmed_reader_offline_loads_legacy_validation_dependency(self):
        self.prime()
        # The Reader eagerly imports reader-book-text.js; its validation
        # dependency must be warmed with the shell even before PDF search.
        self.assertTrue(self.page.evaluate('''async () => {
          const cache = await window.findOwnedServiceWorkerCache();
          const paths = ['/search/static/reader.html', '/search/static/reader.js',
            '/search/static/reader/search/reader-book-text.js',
            '/search/static/reader/search/reader-pdf-book-validate.mjs'];
          for (let i=0; i<200; i++) {
            if ((await Promise.all(paths.map(path=>cache.match(path,{ignoreVary:true})))).every(Boolean)) return true;
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          return false;
        }'''), 'Reader shell and validation dependency must be warmed')
        errors = []
        self.page.on('pageerror', lambda error: errors.append(str(error)))
        self.go_offline()
        response = self.page.goto(self.origin + '/search/static/reader.html?ext=txt', wait_until='domcontentloaded')
        self.assertTrue(response.from_service_worker)
        self.assertEqual(response.status, 200)
        self.page.locator('#back').wait_for(state='visible')
        self.assertFalse(self.page.locator('#error').is_visible() if self.page.locator('#error').count() else False)
        self.assertEqual(self.page.evaluate('''async () => {
          const {validateBookText} = await import('/search/static/reader/search/reader-book-text.js');
          const book = {version:2,kind:'pdf-book-text',complete:true,offset_unit:'unicode-codepoint',page_count:1,
            pages:[{page:1,text:'offline',layout:{offset_unit:'unicode-codepoint'},text_spans:[]}]};
          return validateBookText(book,1) === book;
        }'''), True)
        self.assertEqual(errors, [])

    def test_first_install_rewarms_shell_after_delayed_controller_claim(self):
        self.page.add_init_script('''(() => {
          const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
          navigator.serviceWorker.register = (...args) => new Promise(resolve => setTimeout(resolve,2500)).then(()=>register(...args));
        })();''')
        self.page.goto(self.origin + '/search/', wait_until='domcontentloaded')
        self.assertTrue(self.page.evaluate('''async()=>{
          for(let i=0;i<200;i++){
            const cache=navigator.serviceWorker.controller && await window.findOwnedServiceWorkerCache();
            if(cache && await cache.match('/search/static/reader.html'))return true;
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          return false;
        }'''))
        # A pre-control link warm is deduplicated on rewarm; classic shell
        # scripts must still reach the SW cache instead of the Reader's critical path.
        self.assertTrue(self.page.evaluate('''async()=>{
          const names=['reader/core/reader-security.js','reader/core/reader-store.js','reader/pdf/reader-engine-preload.js'];
          for(let i=0;i<200;i++){
            const cache=await window.findOwnedServiceWorkerCache();
            const hits=await Promise.all(names.map(n=>cache.match('/search/static/'+n,{ignoreVary:true})));
            if(hits.every(Boolean))return true;
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          return false;
        }'''), 'classic Reader shell scripts were not cached after delayed SW control')

    def test_reader_query_navigations_keep_one_normalized_cache_entry(self):
        self.prime()
        for suffix in ("one", "two"):
            self.page.goto(
                self.origin + "/search/static/reader.html?url="
                + f"https%3A%2F%2Fhuggingface.co%2Fdatasets%2FVoiceOfML%2FTest%2Fresolve%2Fmain%2F{suffix}.txt"
                + "&ext=txt",
                wait_until="domcontentloaded",
            )
        urls = self.page.evaluate("""async () => {
            const cache = await window.findOwnedServiceWorkerCache();
            return (await cache.keys()).map(request => request.url).sort();
        }""")
        reader_urls = [url for url in urls if "/search/static/reader.html" in url]
        self.assertEqual(reader_urls, [self.origin + "/search/static/reader.html"])

    def origin_path(self, relative):
        from tests.support.browser_support import ROOT
        return ROOT / relative

    def test_offline_shell_reload_executes_app_and_renders_initial_results(self):
        self.prime(wait_for_data=True)
        self.page.evaluate("localStorage.setItem('theme', 'light')")
        self.go_offline()
        response = self.page.reload(wait_until="domcontentloaded")
        self.assertIsNotNone(response)
        self.assertEqual(response.status, 200)
        self.page.locator("#search-input").wait_for(state="visible")
        self.page.locator("#results-list .result-item").first.wait_for(timeout=15000)
        self.assertEqual(self.page.title(), "VoiceOfML Search")
        self.assertEqual(self.page.evaluate('''() => [getComputedStyle(document.documentElement).colorScheme,
                  document.querySelector('meta[name="theme-color"]').content]'''), ['light', '#fdfbff'])
        self.assertGreater(self.page.locator("#results-list .result-item").count(), 0)
        self.assertTrue(self.page.evaluate("!!navigator.serviceWorker.controller"))
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.page.locator("#search-input").fill("手机")
        self.page.wait_for_function("STATE.query === '手机' && STATE.total > 0", timeout=30000)
        self.assertGreater(self.page.evaluate("STATE.results.length"), 0)
        self.assertTrue(self.page.evaluate("STATE.useLocalMode"))

    def test_fresh_offline_without_cached_corpus_keeps_initial_and_reports_unavailable_search(self):
        corpus = '/search/data/search_data.json.gz'
        with self.server_state.lock:
            self.server_state.failures[corpus] = 503
        self.prime(wait_for_data=False)
        self.page.wait_for_function("STATE._initialActive === true", timeout=10000)
        # Background acquisition preserves the user's mode preference; only a
        # foreground search owns backend fallback. Wait for real load failure.
        self.page.wait_for_function("""getCorpusClient().inspect().restartCount === 1 &&
            localDataPromise === null && !STATE.dataLoaded""", timeout=30000)
        self.assertGreater(self.server_state.count(corpus), 0)
        self.assertFalse(self.page.evaluate("""async path =>
            !!await (await window.findOwnedServiceWorkerCache()).match(path)""", corpus))
        initial = self.page.locator('#results-list .result-item').all_text_contents()
        self.assertGreater(len(initial), 0)
        self.assertTrue(self.page.evaluate('STATE.useLocalMode && DOM.localModeToggle.checked'))
        self.go_offline()
        response = self.page.reload(wait_until="domcontentloaded")
        self.assertEqual(response.status, 200)
        self.assertTrue(response.from_service_worker)
        self.assertFalse(self.page.evaluate('navigator.onLine'))
        self.page.locator("#results-list .result-item").first.wait_for(timeout=15000)
        self.page.wait_for_function("""getCorpusClient().inspect().restartCount === 1 &&
            localDataPromise === null && !STATE.dataLoaded""", timeout=30000)
        self.assertTrue(self.page.evaluate('STATE._initialActive && STATE.useLocalMode && DOM.localModeToggle.checked'))
        self.assertEqual(self.page.locator('#results-list .result-item').all_text_contents(), initial)
        self.assertFalse(self.page.evaluate("""async path =>
            !!await (await window.findOwnedServiceWorkerCache()).match(path)""", corpus))
        # Cached initial rows must never masquerade as results for a new query
        # when neither the corpus nor the network is available.
        self.page.locator('#search-input').fill('sw-offline-no-corpus')
        self.page.locator('#search-input').press('Enter')
        self.page.wait_for_function("STATE.query === 'sw-offline-no-corpus' && !STATE.isLoading", timeout=30000)
        self.page.locator('.search-backend-status[role="status"]').filter(has_text='搜索数据加载失败').wait_for()
        self.assertFalse(self.page.evaluate('STATE.dataLoaded'))
        self.assertEqual(self.page.evaluate('STATE.results.length'), 0)
        self.assertEqual(self.page.locator('#results-list .result-item').count(), 0)
        self.page.get_by_role('button', name='重试', exact=True).wait_for(state='visible')

    def test_offline_cached_gzip_initial_and_sidebar_fetches_succeed(self):
        self.prime(wait_for_data=True)
        self.go_offline()
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

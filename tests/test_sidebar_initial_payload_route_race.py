"""Initial payloads must not overwrite pending routes or change normal startup."""
import os
import unittest
from urllib.parse import parse_qs

from tests import test_browser_smoke as smoke


@unittest.skipIf(smoke.sync_playwright is None, "install requirements-test.txt to run browser tests")
class SidebarInitialPayloadRouteRaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        browser = os.environ.get("SIDEBAR_PAYLOAD_TEST_BROWSER", "chromium")
        if browser not in ("chromium", "firefox"):
            raise ValueError(f"unknown browser {browser}")
        cls.server = smoke.local_server()
        cls.origin, cls.server_state = cls.server.__enter__()
        cls.playwright = smoke.sync_playwright().start()
        try:
            cls.browser = getattr(cls.playwright, browser).launch(headless=True)
        except smoke.PlaywrightError as error:
            cls.playwright.stop()
            cls.server.__exit__(None, None, None)
            raise unittest.SkipTest(f"{browser} is unavailable: {error}")

    @classmethod
    def tearDownClass(cls):
        smoke.BrowserBehaviorTest.tearDownClass.__func__(cls)

    def setUp(self):
        smoke.BrowserBehaviorTest.setUp(self)

    def tearDown(self):
        smoke.BrowserBehaviorTest.tearDown(self)

    def test_route_regressions_are_discovered(self):
        tests = unittest.defaultTestLoader.getTestCaseNames(type(self))
        self.assertEqual(set(tests), {
            'test_actual_delayed_payload_survives_a_pending_folder_navigation',
            'test_first_global_payload_normalizes_and_persists_the_initial_url',
            'test_late_initial_payload_does_not_replace_pending_folder_navigation',
            'test_navigated_destination_is_persisted_before_hashchange',
            'test_payload_after_a_normal_state_write_still_normalizes_url',
            'test_pending_navigation_preserves_parameters_and_back_forward_history',
            'test_route_regressions_are_discovered',
        })

    def install_routes(self, page):
        smoke.BrowserBehaviorTest.install_routes(self, page)

    def load(self, suffix=""):
        smoke.BrowserBehaviorTest.load(self, suffix)

    def test_first_global_payload_normalizes_and_persists_the_initial_url(self):
        self.page.add_init_script('''(() => {
          const previous = window.fetch;
          window.fetch = function(url, ...options) {
            if (String(url).includes('data/initial/global.json')) {
              return new Promise(resolve => {
                window.__releaseInitialPayload = () => resolve(new Response(JSON.stringify({
                  mode:'global', total:1,
                  results:[{Repo:'VoiceOfML/VOMEBOOK',File:'first payload',Extension:'txt',Folder:[],Size:12}]
                }), {status:200,headers:{'Content-Type':'application/json'}}));
              });
            }
            return previous.call(this, url, ...options);
          };
        })();''')
        self.load()
        self.page.wait_for_function("typeof window.__releaseInitialPayload === 'function'")
        observed = self.page.evaluate('''async () => {
          const before = {hash:location.hash, length:history.length};
          const applied = new Promise(resolve => {
            const original = applyInitialSearchPayload;
            applyInitialSearchPayload = function(data) {
              const result = original(data);
              resolve({result, hash:location.hash, length:history.length,
                active:STATE._initialActive, file:STATE.results[0]?.File});
              applyInitialSearchPayload = original;
              return result;
            };
          });
          window.__releaseInitialPayload();
          return {before, after:await applied};
        }''')
        self.assertEqual(observed["before"]["hash"], "")
        self.assertEqual(observed["after"], {"result": True, "hash": "#/",
                                             "length": observed["before"]["length"],
                                             "active": True, "file": "first payload"})
        # The original URL synchronization also writes the normalized route to
        # the existing search session; wait for that actual IndexedDB write.
        self.page.wait_for_function('''async () => {
          const db = await openSearchSessionDB();
          try {
            const record = await new Promise((resolve, reject) => {
              const request = db.transaction('session', 'readonly').objectStore('session').get('last-search');
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            return record?.url === location.href;
          } finally { db.close(); }
        }''')
        self.assertEqual(self.page_errors, [])

    def test_late_initial_payload_does_not_replace_pending_folder_navigation(self):
        self.context.close()
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        self.page = self.context.new_page()
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.install_routes(self.page)
        self.load("#/VOMEBOOK")
        self.page.wait_for_function("STATE.dataLoaded && STATE.mode === 'repo' && !STATE.isLoading", timeout=30000)
        result = self.page.evaluate('''() => {
          const payload = {repo: STATE.repoFull, total: 0, results: []};
          const before = {hash:location.hash, path:STATE.browserPath};
          ROUTER.navigate('repo', STATE.repo, 'docs');
          const pending = {hash:location.hash, path:STATE.browserPath};
          const applied = applyInitialSearchPayload(payload);
          return {before, pending, applied, after:{hash:location.hash, path:STATE.browserPath}};
        }''')
        self.assertEqual(result["before"]["path"], "")
        self.assertEqual(result["pending"]["path"], "")
        self.assertEqual(parse_qs(result["pending"]["hash"].partition("?")[2]).get("path"), ["docs"])
        self.assertTrue(result["applied"])
        self.assertEqual(result["after"]["hash"], result["pending"]["hash"])
        self.page.wait_for_function("STATE.browserPath === 'docs' && !STATE.isLoading")
        self.assertEqual(self.page_errors, [])

    def test_pending_navigation_preserves_parameters_and_back_forward_history(self):
        self.load("#/VOMEBOOK?local=0&history=0&mirror=0&sidebar=0")
        self.page.wait_for_function("STATE.mode === 'repo' && !STATE.isLoading && STATE._loadedPage >= 1")
        transition = self.page.evaluate('''() => {
          const before = {hash: location.hash, length: history.length};
          const originalParams = buildSearchURLParams;
          let pending, applied, after;
          try {
            // A normal click should keep query/filter options already encoded
            // in the destination even when the old payload finishes first.
            buildSearchURLParams = () => new URLSearchParams('q=hello&ext=txt&sort=name&local=0&history=0&mirror=0&sidebar=0');
            ROUTER.navigate('repo', STATE.repo, 'docs/子');
            pending = {hash: location.hash, length: history.length, path:STATE.browserPath};
            applied = applyInitialSearchPayload({repo:STATE.repoFull,total:0,results:[]});
            after = {hash:location.hash, length:history.length};
          } finally { buildSearchURLParams = originalParams; }
          return {before, pending, applied, after};
        }''')
        self.assertTrue(transition["applied"])
        self.assertEqual(transition["pending"]["path"], "")
        self.assertEqual(transition["pending"]["length"], transition["before"]["length"] + 1)
        self.assertEqual(transition["after"]["hash"], transition["pending"]["hash"])
        self.assertEqual(transition["after"]["length"], transition["pending"]["length"])
        self.assertEqual(parse_qs(transition["pending"]["hash"].partition("?")[2]), {
            "q": ["hello"], "ext": ["txt"], "sort": ["name"], "local": ["0"],
            "history": ["0"], "mirror": ["0"], "sidebar": ["0"], "path": ["docs/子"],
        })
        self.page.wait_for_function("STATE.browserPath === 'docs/子' && STATE.query === 'hello'")
        self.assertEqual(self.page.evaluate("STATE.filterExtensions"), ["txt"])
        self.assertEqual(self.page.evaluate("STATE.sort"), "name")
        self.page.evaluate("history.back()")
        self.page.wait_for_function("STATE.browserPath === '' && STATE.query === ''")
        self.assertEqual(self.page.evaluate("location.hash"), transition["before"]["hash"])
        self.page.evaluate("history.forward()")
        self.page.wait_for_function("STATE.browserPath === 'docs/子' && STATE.query === 'hello'")
        self.assertEqual(self.page.evaluate("history.length"), transition["pending"]["length"])
        self.assertEqual(self.page_errors, [])

    def test_navigated_destination_is_persisted_before_hashchange(self):
        self.load("#/VOMEBOOK?local=0")
        self.page.wait_for_function("STATE.mode === 'repo' && !STATE.isLoading && STATE._loadedPage >= 1")
        result = self.page.evaluate('''async () => {
          // Block hashchange application to observe the payload's own session
          // write independently from ROUTER.apply's later persistence.
          const originalApply = ROUTER.apply;
          let resolvePending;
          const entered = new Promise(resolve => { resolvePending = resolve; });
          ROUTER.apply = () => { resolvePending(); };
          try {
            ROUTER.navigate('repo', STATE.repo, 'docs');
            const destination = location.href;
            const applied = applyInitialSearchPayload({repo:STATE.repoFull,total:0,results:[]});
            await entered;
            return {destination, applied, path:STATE.browserPath, hash:location.hash};
          } finally { ROUTER.apply = originalApply; }
        }''')
        self.assertTrue(result["applied"])
        self.assertEqual(result["path"], "")
        self.assertEqual(parse_qs(result["hash"].partition("?")[2]).get("path"), ["docs"])
        self.page.wait_for_function('''async expected => {
          const db = await openSearchSessionDB();
          try {
            const record = await new Promise((resolve, reject) => {
              const request = db.transaction('session', 'readonly').objectStore('session').get('last-search');
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            return record?.url === expected;
          } finally { db.close(); }
        }''', arg=result["destination"])
        self.assertEqual(self.page_errors, [])

    def test_payload_after_a_normal_state_write_still_normalizes_url(self):
        self.load("#/VOMEBOOK?local=0")
        self.page.wait_for_function("STATE.mode === 'repo' && !STATE.isLoading && STATE._loadedPage >= 1")
        observed = self.page.evaluate('''() => {
          STATE.recordHistory = false;
          syncStateToURL();
          const afterFirstSync = location.hash;
          STATE.useMirrorLinks = false;
          const applied = applyInitialSearchPayload({repo:STATE.repoFull,total:0,results:[]});
          return {afterFirstSync, applied, afterPayload:location.hash};
        }''')
        self.assertTrue(observed["applied"])
        first = parse_qs(observed["afterFirstSync"].partition("?")[2])
        last = parse_qs(observed["afterPayload"].partition("?")[2])
        self.assertEqual(first.get("history"), ["0"])
        self.assertNotIn("mirror", first)
        self.assertEqual(last.get("mirror"), ["0"])
        self.assertEqual(last.get("history"), ["0"])
        self.assertEqual(self.page_errors, [])

    def test_actual_delayed_payload_survives_a_pending_folder_navigation(self):
        self.load("#/VOMEBOOK")
        self.page.wait_for_function("STATE.dataLoaded && STATE.mode === 'repo' && !STATE.isLoading", timeout=30000)
        result = self.page.evaluate('''async () => {
          const previous = fetchJsonWithTimeout;
          let release;
          const held = new Promise(resolve => { release = resolve; });
          const originalApply = applyInitialSearchPayload;
          const originalNavigate = ROUTER.navigate;
          const path = STATE.browserPath;
          initialPayloadCache.delete(getInitialPayloadUrl());
          fetchJsonWithTimeout = () => held;
          try {
            const pending = tryInitialSearchPayload(STATE.mode, STATE.repo);
            ROUTER.navigate('repo', STATE.repo, 'docs');
            const wanted = location.hash;
            const applied = new Promise(resolve => {
              applyInitialSearchPayload = function(data) {
                const before = location.hash, result = originalApply(data);
                resolve({before, after:location.hash, result}); return result;
              };
            });
            release({repo:STATE.repoFull,total:0,results:[]});
            const state = await applied;
            return {path, wanted, applied:await pending, state};
          } finally {
            fetchJsonWithTimeout = previous;
            applyInitialSearchPayload = originalApply;
            ROUTER.navigate = originalNavigate;
          }
        }''')
        self.assertEqual(result["path"], "")
        self.assertTrue(result["applied"])
        self.assertTrue(result["state"]["result"])
        self.assertEqual(result["state"]["before"], result["wanted"])
        self.assertEqual(result["state"]["after"], result["wanted"])
        self.page.wait_for_function("STATE.browserPath === 'docs' && !STATE.isLoading")
        self.assertEqual(self.page_errors, [])

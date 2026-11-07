"""Offline regression for repository identity while a sidebar list reorders."""

import json
import unittest
from unittest.mock import patch

from tests.search.browser import test_browser_smoke as smoke

if smoke.sync_playwright is not None:
    from playwright.sync_api import Locator, TimeoutError as PlaywrightTimeout


def directory_timeout_context(page):
    """Describe state only; the caller still raises the original timeout."""
    return page.evaluate("""() => ({
      mode: STATE.mode, repo: STATE.repo, path: STATE.browserPath,
      loading: STATE.isLoading, loadedPage: STATE._loadedPage,
      dataLoaded: STATE.dataLoaded, backend: STATE._resultBackend,
      pendingPage: STATE._pendingPage, routeRenderId, searchId, searchRequestId,
      localDataPending: Boolean(localDataPromise), hash: location.hash,
      events: window.__sidebarRouteTrace || null,
      sidebarLoading: Array.from(document.querySelectorAll('#sidebar-content .sidebar-loading'),
        node => node.textContent), reorder: window.__sidebarReorder || null
    })""")


def call_with_timeout_context(callback, page_supplier):
    try:
        return callback()
    except PlaywrightTimeout as error:
        try:
            diagnostic = json.dumps(directory_timeout_context(page_supplier()), ensure_ascii=False, sort_keys=True)
        except Exception as diagnostic_error:
            diagnostic = f"diagnostic unavailable: {type(diagnostic_error).__name__}: {diagnostic_error}"
        error.add_note("sidebar reorder timeout state: " + diagnostic)
        raise


@unittest.skipIf(smoke.sync_playwright is None, "install requirements-test.txt to run browser tests")
class SidebarReorderRegressionTest(unittest.TestCase):
    """Run the existing history contract with a deterministic list reorder."""

    @classmethod
    def setUpClass(cls):
        smoke.BrowserBehaviorTest.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        smoke.BrowserBehaviorTest.tearDownClass.__func__(cls)

    def setUp(self):
        smoke.BrowserBehaviorTest.setUp(self)

    def tearDown(self):
        smoke.BrowserBehaviorTest.tearDown(self)

    def install_routes(self, page):
        smoke.BrowserBehaviorTest.install_routes(self, page)

        def block_external(route):
            if route.request.url.startswith(self.origin + "/"):
                route.continue_()
            else:
                route.abort()

        self.context.route("**/*", block_external)

    def load(self, suffix=""):
        smoke.BrowserBehaviorTest.load(self, suffix)
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.page.evaluate("""() => {
          const events = window.__sidebarRouteTrace = [];
          const snapshot = () => ({hash: location.hash, mode: STATE.mode, repo: STATE.repo,
            path: STATE.browserPath, loading: STATE.isLoading, loadedPage: STATE._loadedPage,
            routeRenderId, searchId});
          const record = entry => { if (events.length < 200) events.push(entry); };
          const replaceState = history.replaceState;
          history.replaceState = function(...args) {
            const before = snapshot();
            const result = replaceState.apply(this, args);
            if (before.hash !== location.hash) record({type: 'replace', args, before, after: snapshot(),
              stack: String(new Error().stack).split('\\n').slice(1, 5)});
            return result;
          };
          const navigate = ROUTER.navigate;
          ROUTER.navigate = function(...args) {
            const before = snapshot(), result = navigate.apply(this, args);
            record({type: 'navigate', args, before, after: snapshot()});
            return result;
          };
          const browser = renderBrowser;
          renderBrowser = function(...args) {
            const before = snapshot(), result = browser.apply(this, args);
            record({type: 'render', args, before, after: snapshot(),
              stack: String(new Error().stack).split('\\n').slice(1, 5)});
            return result;
          };
          window.addEventListener('hashchange', event => record({type: 'hashchange',
            old: event.oldURL, next: event.newURL, now: snapshot()}));
          const original = renderRepoListItems;
          const synthetic = [{name:'VoiceOfML/VOMEBOOK',count:1},
                             {name:'VoiceOfML/SyntheticB',count:2}];
          renderRepoListItems = function() { return original(synthetic); };
          original(synthetic);
          window.__sidebarReorder = {changed:false, before:null, after:null, clicked:null};
          document.addEventListener('click', event => {
            const item = event.target.closest('#sidebar-content .repo-list-item');
            if (item) window.__sidebarReorder.clicked = item.dataset.repo;
          }, true);
        }""")
        original_get_attribute = Locator.get_attribute
        page = self.page

        def get_attribute_then_reorder(locator, name, **kwargs):
            value = original_get_attribute(locator, name, **kwargs)
            if name == "data-repo" and not page.evaluate("window.__sidebarReorder.changed"):
                page.evaluate("""() => {
                  const items = document.querySelectorAll('#sidebar-content .repo-list-item');
                  if (items.length !== 2) throw new Error('synthetic sidebar list missing');
                  const diagnostic = window.__sidebarReorder;
                  diagnostic.before = items[0].dataset.repo;
                  items[0].parentElement.insertBefore(items[1], items[0]);
                  diagnostic.after = items[1].dataset.repo;
                  diagnostic.changed = true;
                }""")
            return value

        patcher = patch.object(Locator, "get_attribute", get_attribute_then_reorder)
        patcher.start()
        self.addCleanup(patcher.stop)
        original_click = Locator.click

        def click_and_check_identity(locator, **kwargs):
            result = original_click(locator, **kwargs)
            state = page.evaluate("window.__sidebarReorder")
            if state["changed"] and state["clicked"] is not None:
                self.assertEqual(state["before"], "VOMEBOOK")
                self.assertEqual(state["after"], "SyntheticB")
                self.assertEqual(state["clicked"], state["before"],
                                 "reordering must not change the clicked repository")
            return result

        click_patcher = patch.object(Locator, "click", click_and_check_identity)
        click_patcher.start()
        self.addCleanup(click_patcher.stop)

    def assert_reorder_preserved_identity(self):
        state = self.page.evaluate("window.__sidebarReorder")
        self.assertTrue(state["changed"])
        self.assertEqual(state["before"], "VOMEBOOK")
        self.assertEqual(state["after"], "SyntheticB")
        self.assertEqual(state["clicked"], state["before"])

    def test_history_targets_captured_repository_after_reorder(self):
        call_with_timeout_context(
            lambda: smoke.BrowserBehaviorTest.test_mobile_history_restores_routes_without_drawer_guards(self),
            lambda: self.page,
        )
        self.assert_reorder_preserved_identity()

    def test_directory_back_targets_captured_repository_after_reorder(self):
        call_with_timeout_context(
            lambda: smoke.BrowserBehaviorTest.test_mobile_sidebar_back_returns_by_directory_level(self),
            lambda: self.page,
        )
        self.assert_reorder_preserved_identity()


@unittest.skipIf(smoke.sync_playwright is None, "install requirements-test.txt to run browser tests")
class SidebarApiRefreshRegressionTest(unittest.TestCase):
    """Keep repository identity when the real snapshot is replaced by API metadata."""

    @classmethod
    def setUpClass(cls):
        smoke.BrowserBehaviorTest.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        smoke.BrowserBehaviorTest.tearDownClass.__func__(cls)

    def setUp(self):
        smoke.BrowserBehaviorTest.setUp(self)

    def tearDown(self):
        smoke.BrowserBehaviorTest.tearDown(self)

    def install_routes(self, page):
        smoke.BrowserBehaviorTest.install_routes(self, page)

    def load(self, suffix=""):
        self.context.add_init_script('''
          const original = window.fetch;
          const gate = new Promise(resolve => { window.__releaseRepoApi = resolve; });
          window.fetch = function(input, init) {
            const url = typeof input === "string" ? input : input.url;
            return url.includes("/api/repos") ? gate.then(() => original.call(this, input, init)) : original.call(this, input, init);
          };
          document.addEventListener('click', event => {
            const item = event.target.closest('#sidebar-content .repo-list-item');
            if (item) window.__refreshClicked = item.dataset.repo;
          }, true);
        ''')

        def block_external(route):
            if route.request.url.startswith(self.origin + "/"):
                route.continue_()
            else:
                route.abort()

        self.context.route("**/*", block_external)
        requests = []
        refreshed = [{"name": "VoiceOfML/VOMEBOOK", "count": 1},
                     {"name": "VoiceOfML/SNAPSHOT", "count": 2}]
        snapshot = [{"name": "VoiceOfML/SNAPSHOT", "count": 1},
                    {"name": "VoiceOfML/VOMEBOOK", "count": 2}]

        def fulfill(route, kind, body):
            requests.append(kind)
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

        self.page.route("**/api/repos*", lambda route: fulfill(route, "api", refreshed))
        self.page.route("**/search/data/sidebar/global.json*", lambda route: fulfill(route, "snapshot", {"repos": snapshot}))
        smoke.BrowserBehaviorTest.load(self, suffix)
        page = self.page
        self.refreshed_identity = None
        original_get_attribute = Locator.get_attribute

        def get_attribute_then_refresh(locator, name, **kwargs):
            value = original_get_attribute(locator, name, **kwargs)
            if name == "data-repo" and self.refreshed_identity is None:
                self.assertEqual(value, "SNAPSHOT")
                self.assertIn("snapshot", requests)
                self.assertNotIn("api", requests)
                page.evaluate("window.__releaseRepoApi()")
                page.wait_for_function('document.querySelector("#sidebar-content .repo-list-item")?.dataset.repo === "VOMEBOOK"')
                self.assertIn("api", requests)
                self.refreshed_identity = value
            return value

        get_patcher = patch.object(Locator, "get_attribute", get_attribute_then_refresh)
        get_patcher.start()
        self.addCleanup(get_patcher.stop)
        original_click = Locator.click

        def click_and_check_identity(locator, **kwargs):
            result = original_click(locator, **kwargs)
            clicked = page.evaluate("window.__refreshClicked")
            if self.refreshed_identity is not None and clicked is not None:
                self.assertEqual(clicked, self.refreshed_identity, "API refresh changed the clicked repository")
            return result

        click_patcher = patch.object(Locator, "click", click_and_check_identity)
        click_patcher.start()
        self.addCleanup(click_patcher.stop)

    def test_mobile_history_repository_identity_survives_api_refresh(self):
        smoke.BrowserBehaviorTest.test_mobile_history_restores_routes_without_drawer_guards(self)
        self.assertEqual(self.refreshed_identity, "SNAPSHOT")
        self.assertEqual(self.page.evaluate("window.__refreshClicked"), self.refreshed_identity)

"""Offline regression for repository identity while a sidebar list reorders."""

import unittest
from unittest.mock import patch

from tests.test_browser_smoke import BrowserBehaviorTest, sync_playwright

if sync_playwright is not None:
    from playwright.sync_api import Locator


@unittest.skipIf(sync_playwright is None, "install requirements-test.txt to run browser tests")
class SidebarReorderRegressionTest(unittest.TestCase):
    """Run the existing history contract with a deterministic list reorder."""

    @classmethod
    def setUpClass(cls):
        BrowserBehaviorTest.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        BrowserBehaviorTest.tearDownClass.__func__(cls)

    def setUp(self):
        BrowserBehaviorTest.setUp(self)

    def tearDown(self):
        BrowserBehaviorTest.tearDown(self)

    def install_routes(self, page):
        BrowserBehaviorTest.install_routes(self, page)

        def block_external(route):
            if route.request.url.startswith(self.origin + "/"):
                route.continue_()
            else:
                route.abort()

        self.context.route("**/*", block_external)

    def load(self, suffix=""):
        BrowserBehaviorTest.load(self, suffix)
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.page.evaluate("""() => {
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

    def assert_reorder_preserved_identity(self):
        state = self.page.evaluate("window.__sidebarReorder")
        self.assertTrue(state["changed"])
        self.assertEqual(state["before"], "VOMEBOOK")
        self.assertEqual(state["after"], "SyntheticB")
        self.assertEqual(state["clicked"], state["before"])

    def test_history_targets_captured_repository_after_reorder(self):
        BrowserBehaviorTest.test_mobile_history_restores_routes_without_drawer_guards(self)
        self.assert_reorder_preserved_identity()

    def test_directory_back_targets_captured_repository_after_reorder(self):
        BrowserBehaviorTest.test_mobile_sidebar_back_returns_by_directory_level(self)
        self.assert_reorder_preserved_identity()

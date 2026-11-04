"""The sidebar regression module must not collect the imported smoke suite."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tests import test_browser_sidebar_reorder


class SidebarReorderDiscoveryTests(unittest.TestCase):
    def test_only_two_sidebar_regressions_are_collected(self):
        suite = unittest.defaultTestLoader.loadTestsFromModule(test_browser_sidebar_reorder)
        self.assertEqual(suite.countTestCases(), 2)
        self.assertEqual(sum(group.countTestCases() for group in suite), 2)

    def test_timeout_context_requests_route_trace(self):
        source = test_browser_sidebar_reorder.directory_timeout_context.__code__.co_consts
        self.assertTrue(any(isinstance(value, str) and "window.__sidebarRouteTrace" in value for value in source))

    @unittest.skipIf(test_browser_sidebar_reorder.smoke.sync_playwright is None, "install requirements-test.txt")
    def test_timeout_context_preserves_the_original_failure(self):
        timeout = test_browser_sidebar_reorder.PlaywrightTimeout('synthetic timeout')
        page = SimpleNamespace(evaluate=lambda _expression: {'path': 'docs', 'loading': True,
                                                              'events': [{'type': 'navigate', 'args': ['docs']}]})

        def fail():
            raise timeout

        with self.assertRaises(test_browser_sidebar_reorder.PlaywrightTimeout) as caught:
            test_browser_sidebar_reorder.call_with_timeout_context(fail, lambda: page)
        self.assertIs(caught.exception, timeout)
        self.assertIn('"path": "docs"', timeout.__notes__[0])
        self.assertIn('"loading": true', timeout.__notes__[0])
        self.assertIn('"events": [{"args": ["docs"], "type": "navigate"}]', timeout.__notes__[0])

        with patch.object(test_browser_sidebar_reorder, 'directory_timeout_context', side_effect=ValueError('synthetic')):
            with self.assertRaises(test_browser_sidebar_reorder.PlaywrightTimeout) as caught:
                test_browser_sidebar_reorder.call_with_timeout_context(fail, lambda: page)
        self.assertIs(caught.exception, timeout)
        self.assertIn('diagnostic unavailable: ValueError: synthetic', timeout.__notes__[-1])

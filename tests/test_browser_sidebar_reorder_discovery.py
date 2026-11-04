"""The sidebar regression module must not collect the imported smoke suite."""

import unittest

from tests import test_browser_sidebar_reorder


class SidebarReorderDiscoveryTests(unittest.TestCase):
    def test_only_two_sidebar_regressions_are_collected(self):
        suite = unittest.defaultTestLoader.loadTestsFromModule(test_browser_sidebar_reorder)
        self.assertEqual(suite.countTestCases(), 2)
        self.assertEqual(sum(group.countTestCases() for group in suite), 2)

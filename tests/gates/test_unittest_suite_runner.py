"""Executable contracts for the CI unittest runner."""
import io
import importlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts.ci import run_unittest_suite as runner


class UnittestSuiteRunnerTests(unittest.TestCase):
    MODULE = 'ci_suite_runner_fixture'
    REQUIRED = MODULE + '.Cases.test_required'
    PASSING = 'import unittest\nclass Cases(unittest.TestCase):\n def test_required(self): pass\n'

    def fixture(self, source):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name, self.MODULE + '.py')
        path.write_text(source, encoding='utf-8')
        sys.modules.pop(self.MODULE, None)
        self.addCleanup(sys.modules.pop, self.MODULE, None)
        importlib.invalidate_caches()
        return path.parent

    def execute(self, source, selections=None, required=None):
        root = self.fixture(source)
        with patch.object(sys, 'path', [str(root), *sys.path]):
            return runner.run(selections or [self.MODULE], [self.REQUIRED] if required is None else required, io.StringIO())

    def test_extra_case_is_discovered_and_runs(self):
        self.assertEqual(self.execute(self.PASSING), 1)
        self.assertEqual(self.execute(self.PASSING + ' def test_extra(self): pass\n'), 2)

    def test_missing_required_cannot_be_replaced_with_same_count(self):
        with self.assertRaisesRegex(runner.SuiteError, 'missing required'):
            self.execute(self.PASSING.replace('test_required', 'test_replacement'))

    def test_reject_empty_selection_groups_import_errors_and_duplicates(self):
        with self.assertRaisesRegex(runner.SuiteError, 'no tests discovered'):
            self.execute('import unittest\n', required=[])
        with self.assertRaisesRegex(runner.SuiteError, 'discovery failed'):
            self.execute('raise ImportError("fixture import failed")\n')
        with self.assertRaisesRegex(runner.SuiteError, 'duplicate discovered'):
            self.execute(self.PASSING, selections=[self.MODULE, self.REQUIRED])
        with self.assertRaisesRegex(runner.SuiteError, 'expected unique'):
            runner.run([], [], io.StringIO())

    def test_test_subtest_and_class_skips_are_rejected(self):
        fixtures = (
            self.PASSING.replace(' def test_required', ' @unittest.skip("no browser")\n def test_required'),
            self.PASSING.replace('class Cases', '@unittest.skip("no browser")\nclass Cases'),
            self.PASSING.replace(': pass', ':\n  with self.subTest(browser="fixture"): self.skipTest("no browser")'),
        )
        for source in fixtures:
            with self.subTest(source=source), self.assertRaisesRegex(runner.SuiteError, 'skip'):
                self.execute(source)

    def test_expected_failures_failures_and_faked_dispatch_are_rejected(self):
        for source in (self.PASSING.replace('pass', 'self.fail("injected")'),
                       self.PASSING.replace(' def test_required', ' @unittest.expectedFailure\n def test_required')):
            with self.subTest(source=source), self.assertRaisesRegex(runner.SuiteError, 'failure'):
                self.execute(source)
        with self.assertRaisesRegex(runner.SuiteError, 'dispatch hook'):
            self.execute(self.PASSING + ' def _callTestMethod(self, method): pass\n')

    def test_cli_uses_target_checkout_and_reports_completion(self):
        root = self.fixture(self.PASSING)
        check = [sys.executable, '-B', str(Path(runner.__file__).resolve()), '--require', self.REQUIRED, self.MODULE]
        result = subprocess.run(check, cwd=root, capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('1 discovered, passed and completed', result.stdout)
        (root / (self.MODULE + '.py')).write_text(self.PASSING.replace('test_required', 'test_other'), encoding='utf-8')
        result = subprocess.run(check, cwd=root, capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('missing required', result.stderr)

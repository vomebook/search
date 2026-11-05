"""Offline fail-closed self-tests for browser-contract result accounting."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('reader_dom_gate', ROOT / 'scripts/check_reader_dom_search_contracts.py')
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


class ReaderDomSearchGateTests(unittest.TestCase):
    def test_rejects_missing_forged_or_ambiguous_results(self):
        digest = 'a' * 64
        tests = [f'{name} ({GATE.TEST_MODULE}.ReaderDomSearchContracts.{name}) ... ok' for name in GATE.CONTRACTS]
        markers = [f'DOM_SEARCH_CONTRACT_COMPLETED chromium {contract} {digest}' for contract in GATE.CONTRACTS.values()]
        stdout = '\n'.join(markers) + '\n'
        stderr = '\n'.join(tests + ['', '----------------------------------------------------------------------',
                                     'Ran 7 tests in 0.123s', '', 'OK']) + '\n'
        self.assertTrue(GATE.valid_output(stdout, stderr, 'chromium', digest))
        changes = [
            (stdout.replace(markers[0] + '\n', ''), stderr),
            (stdout + markers[0] + '\n', stderr),
            (stdout.replace(markers[0], markers[0].replace('chromium', 'firefox')), stderr),
            (stdout.replace(digest, 'b' * 64, 1), stderr),
            (stdout + 'unexpected output\n', stderr),
            (stdout, stderr.replace(tests[0] + '\n', '')),
            (stdout, stderr.replace(tests[0], tests[0].replace(' ... ok', " ... skipped 'fixture'"))),
            (stdout, stderr.replace(tests[0], tests[0].replace(' ... ok', ' ... FAIL'))),
            (stdout, stderr + tests[0] + '\n'),
            (stdout, stderr.replace('Ran 7 tests', 'Ran 6 tests')),
            (stdout, stderr + 'Ran 7 tests in 0.123s\n'),
            (stdout, stderr.replace('\nOK\n', '\nOK (skipped=1)\n')),
            (stdout, stderr.replace('\nOK\n', '\nOK (expected failures=1)\n')),
            (stdout, stderr.replace('\nOK\n', '\nOK (unexpected successes=1)\n')),
            (stdout, stderr + 'OK\n'),
            (stdout, stderr.replace('\nOK\n', '\nOK\nERROR: unexpected hidden error\n')),
            (stdout, stderr.replace('\nOK\n', '\nOK\nWARNING: unexpected output\n')),
        ]
        for modified_stdout, modified_stderr in changes:
            with self.subTest(stdout=modified_stdout, stderr=modified_stderr):
                self.assertFalse(GATE.valid_output(modified_stdout, modified_stderr, 'chromium', digest))
        self.assertFalse(GATE.valid_output(stdout, stderr, 'firefox', digest))
        self.assertFalse(GATE.valid_output(stdout, stderr, 'chromium', 'bad-digest'))

    def test_real_fixture_selects_both_browser_contracts(self):
        runner = (ROOT / 'tests/test_reader_dom_search_contracts.py').read_text(encoding='utf-8')
        self.assertIn("('chromium', 'firefox')", runner)
        for name in GATE.CONTRACTS:
            self.assertIn(f'def {name}(self):', runner)

    def test_gate_rejects_actual_skips_and_missing_contract(self):
        # This fixture never starts a browser: the runner is replaced by a
        # deliberately incomplete suite so the real subprocess path is tested.
        with tempfile.TemporaryDirectory(prefix='dom-gate-negative-') as directory:
            root = Path(directory)
            for name in ('scripts/check_reader_dom_search_contracts.py',
                         'static/reader/search/reader-dom-search.mjs'):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, path)
            tests = root / 'tests'
            tests.mkdir()
            (tests / '__init__.py').write_text('')
            (tests / 'test_reader_dom_search_contracts.py').write_text('''
import unittest
class ReaderDomSearchContracts(unittest.TestCase):
    @unittest.skip("synthetic unavailable browser")
    def test_literal_escape_snippets_and_pagination(self): pass
''')
            result = subprocess.run([sys.executable, '-B', str(root / 'scripts/check_reader_dom_search_contracts.py')],
                                    cwd=root, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('DOM-search browser contracts incomplete: chromium', result.stdout + result.stderr)
            self.assertIn('skipped', result.stdout + result.stderr)

    def test_gate_invokes_both_browsers_and_honours_failures(self):
        from unittest.mock import patch
        calls = []
        with patch.object(GATE, 'run_browser', side_effect=lambda browser, digest: calls.append((browser, digest))):
            GATE.main()
        self.assertEqual([browser for browser, _ in calls], ['chromium', 'firefox'])
        self.assertEqual(calls[0][1], calls[1][1])
        self.assertRegex(calls[0][1], r'^[0-9a-f]{64}$')
        with patch.object(GATE.subprocess, 'run') as run:
            run.return_value.returncode = 7
            run.return_value.stdout = run.return_value.stderr = ''
            with self.assertRaisesRegex(SystemExit, 'incomplete: chromium'):
                GATE.run_browser('chromium', 'a' * 64)
            self.assertEqual(run.call_args.kwargs['env']['READER_DOM_SEARCH_BROWSER'], 'chromium')


if __name__ == '__main__':
    unittest.main()

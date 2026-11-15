"""Full source admission is independent of ancestry and sealed debt baselines."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

from scripts.verify_hf_source_revision import LOCK, verify

ROOT = Path(__file__).resolve().parents[2]
BASELINE = 'f1c891be53696433dfb84fefc8eec3e6cab5cdfa'


class SourceRevisionTests(unittest.TestCase):
    def test_current_committed_baseline_is_explicit_and_separate(self):
        lock = json.loads(LOCK.read_text())
        self.assertRegex(lock['revision'], r'\A[0-9a-f]{40}\Z')
        verify(lock['revision'], lock)
        different = ('0' if lock['revision'][0] != '0' else '1') + lock['revision'][1:]
        with self.assertRaises(ValueError):
            verify(different, lock)
        self.assertIn('dirty HF candidate is not approved', lock['update_policy'])
        quality = json.loads((ROOT / '.github/quality-baselines/hf-source.json').read_text())
        self.assertNotEqual(LOCK, ROOT / '.github/quality-baselines/hf-source.json')
        self.assertEqual(quality['revision'], 'd6c3bea07d0005143f0a411a036b360a584bf315')
        self.assertEqual(quality['files'], {
            'backend-coverage-debt.json': '70e9311f50ba1407227de9ba42fd591d93826f92898d07873ce5f58cbebf2a29',
            'strict-inventory-debt.json': 'c864967d3d83454f5bd567c0c2d6b1f22cc253c9bd10f623df4734c5fcdafaa9',
        })

    def test_exact_equality_required_without_normalizing_capture(self):
        lock = {'repository': 'VoiceOfML/Search', 'revision': BASELINE}
        for revision in ('main', BASELINE[:12], BASELINE.upper(), BASELINE + '\n',
                         ' ' + BASELINE, 'a' * 40, ''):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                verify(revision, lock)

    def test_invalid_lock_fails_closed(self):
        for lock in (None, [], {}, {'repository': 'other', 'revision': BASELINE},
                     *({'repository': 'VoiceOfML/Search', 'revision': value}
                       for value in (None, 1, [], 'main', BASELINE[:12], BASELINE + '\n'))):
            with self.subTest(lock=lock), self.assertRaises(ValueError):
                verify(BASELINE, lock)

    def test_cli_runs_without_external_dependencies_and_reports_rejection(self):
        command = [sys.executable, '-I', '-S', '-B', str(ROOT / 'scripts/verify_hf_source_revision.py')]
        revision = json.loads(LOCK.read_text())['revision']
        different = ('0' if revision[0] != '0' else '1') + revision[1:]
        for arguments, code, message in (([revision], 0, 'Approved exact HF source revision ' + revision),
                                         ([different], 1, 'not approved'),
                                         (['main'], 1, 'full commit SHA'),
                                         ([], 2, 'usage:'),
                                         ([BASELINE, BASELINE], 2, 'usage:')):
            with self.subTest(arguments=arguments):
                result = subprocess.run(command + arguments, cwd='/', capture_output=True, text=True)
                self.assertEqual(result.returncode, code, result.stdout + result.stderr)
                self.assertIn(message, result.stdout if code == 0 else result.stderr)
                if code:
                    self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()

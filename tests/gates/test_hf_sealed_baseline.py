"""Test that gates use precisely the checked immutable baseline snapshots."""
import fcntl
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import run_hf_quality_with_verified_baseline as runner
from scripts.verify_hf_quality_baseline import read_verified_baselines


class SealedBaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        (self.repo / 'scripts').mkdir(parents=True)
        self.data = {runner.STRICT: b'{"strict": ["pinned"]}\n',
                     runner.COVERAGE: b'{"coverage": ["pinned"]}\n'}
        self.lock = {'repository': 'VoiceOfML/Search', 'revision': 'a' * 40,
                     'files': {name: hashlib.sha256(value).hexdigest() for name, value in self.data.items()}}
        for name, data in self.data.items():
            (self.root / name).write_bytes(data)
        self.report = self.root / 'coverage.json'
        self.report.write_text('{}')
        self.log = self.root / 'log'
        for script in ('check_strict_inventory.py', 'check_backend_coverage.py'):
            (self.repo / 'scripts' / script).write_text(
                'import os, sys\n'
                'from pathlib import Path\n'
                'if sys.argv[0].endswith("check_strict_inventory.py"):\n'
                '    assert len(sys.argv) == 2\n'
                'else:\n'
                '    assert len(sys.argv) == 3 and sys.argv[1] == os.environ["COVERAGE_REPORT"]\n'
                'data = Path(sys.argv[-1]).read_bytes()\n'
                'with open(os.environ["GATE_LOG"], "ab") as f: f.write(data)\n'
                'try:\n'
                '    Path(sys.argv[-1]).write_bytes(b"tamper")\n'
                'except PermissionError:\n'
                '    pass\n'
                'else:\n'
                '    raise SystemExit("sealed baseline was writable")\n'
                'if sys.argv[0].endswith("check_strict_inventory.py"):\n'
                '    Path(os.environ["BASELINE_DIR"], "backend-coverage-debt.json").write_bytes(b"changed by earlier HF gate")\n')

    def run_gate(self):
        with patch.object(runner, 'select', return_value='a' * 40), \
             patch.object(runner, 'selected_lock', return_value=self.lock), \
             patch.dict(os.environ, {'GATE_LOG': str(self.log), 'BASELINE_DIR': str(self.root),
                                     'COVERAGE_REPORT': str(self.report)}):
            runner.run(self.repo, self.root, 'b' * 40, self.report)

    def test_valid_input_reaches_both_actual_child_processes(self):
        self.run_gate()
        self.assertEqual(self.log.read_bytes(), self.data[runner.STRICT] + self.data[runner.COVERAGE])
        self.assertEqual((self.root / runner.COVERAGE).read_bytes(), b'changed by earlier HF gate')

    def test_post_verification_disk_mutation_cannot_change_gate_input(self):
        real = runner.read_verified_baselines
        def mutate_after_check(directory, lock):
            snapshots, errors = real(directory, lock)
            self.assertEqual(errors, [])
            for name in self.data:
                (self.root / name).write_bytes(b'changed after verification')
            return snapshots, errors
        with patch.object(runner, 'read_verified_baselines', side_effect=mutate_after_check):
            self.run_gate()
        self.assertEqual(self.log.read_bytes(), self.data[runner.STRICT] + self.data[runner.COVERAGE])
        self.assertNotEqual((self.root / runner.COVERAGE).read_bytes(), self.data[runner.COVERAGE])

    def test_tampering_after_prior_validation_and_wrong_data_fail_before_either_gate(self):
        _, errors = read_verified_baselines(self.root, self.lock)
        self.assertEqual(errors, [])
        for name in self.data:
            with self.subTest(name=name):
                (self.root / name).write_bytes(b'wrong')
                with self.assertRaisesRegex(ValueError, 'missing or altered baseline file: ' + name):
                    self.run_gate()
                self.assertFalse(self.log.exists())
                (self.root / name).write_bytes(self.data[name])

    def test_seals_reject_writes_and_unsealing(self):
        fd = runner.sealed_snapshot('test', b'checked')
        self.addCleanup(os.close, fd)
        for operation in (lambda: os.write(fd, b'x'), lambda: os.ftruncate(fd, 0),
                          lambda: fcntl.fcntl(fd, fcntl.F_ADD_SEALS, 0)):
            with self.assertRaises(PermissionError):
                operation()
        self.assertEqual(os.pread(fd, 7, 0), b'checked')

    def test_both_gates_receive_correct_arguments_and_descriptor_bytes(self):
        self.run_gate()
        self.assertEqual(self.log.read_bytes(), self.data[runner.STRICT] + self.data[runner.COVERAGE])

    def test_history_or_sealing_failure_never_starts_a_gate(self):
        with patch.object(runner, 'select', side_effect=ValueError('ambiguous history')):
            with self.assertRaisesRegex(ValueError, 'ambiguous history'):
                runner.run(self.repo, self.root, 'b' * 40, self.report)
        with patch.object(runner, 'sealed_snapshot', side_effect=OSError('seals unavailable')):
            with self.assertRaisesRegex(OSError, 'seals unavailable'):
                self.run_gate()
        self.assertFalse(self.log.exists())

    def test_gate_failure_stops_subsequent_gate(self):
        (self.repo / 'scripts/check_strict_inventory.py').write_text('raise SystemExit(7)\n')
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            self.run_gate()
        self.assertEqual(raised.exception.returncode, 7)
        self.assertFalse(self.log.exists())

    def test_workflow_requires_wrapper_after_coverage_and_before_mutations(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        hf = workflow.split('  huggingface-search:\n', 1)[1]
        step = hf.split('      - name: Check backend coverage and quality inventory\n', 1)[1].split('      - name:', 1)[0]
        command = 'python -B ../scripts/run_hf_quality_with_verified_baseline.py "$PWD" "$RUNNER_TEMP/hf-quality-baseline" "$CAPTURED_HF_REVISION" "$RUNNER_TEMP/backend-coverage.json"'
        self.assertEqual(step.count(command), 1)
        self.assertIn('CAPTURED_HF_REVISION: ${{ steps.hf-checkout.outputs.revision }}', step)
        self.assertLess(step.index('coverage json'), step.index(command))
        self.assertLess(step.index(command), step.index('scripts/check_search_words_mutation.py'))
        self.assertNotIn('continue-on-error:', step)
        self.assertNotIn('|| true', step)


if __name__ == '__main__':
    unittest.main()

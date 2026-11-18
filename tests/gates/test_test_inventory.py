"""Negative probes for the test-file inventory checker."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import call, patch

from scripts import check_test_inventory
from scripts.check_test_inventory import validate


class TestInventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'tests').mkdir()
        (self.root / 'tests/__init__.py').write_text('')
        (self.root / 'scripts').mkdir()
        (self.root / 'tests/test_example.py').write_text('')
        (self.root / 'scripts/gate.py').write_text('MODULE = "tests.test_example"\n')
        self.doc = {'version': 1, 'project': 'github', 'tests': {
            'tests/test_example.py': {'kind': 'script', 'source': 'scripts/gate.py'},
        }}
        self.inventory = self.root / 'inventory.json'
        self.save()

    def save(self):
        self.inventory.write_text(json.dumps(self.doc))

    def check(self):
        validate(self.root, inventory=self.inventory, project='github')

    def test_boundary_tests_are_in_executed_workflow_steps(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        pages, hf = workflow.split('  huggingface-search:\n', 1)
        reader = ('node --test tests/reader/core/test_reader_bindings_boundary.mjs '
                  'tests/reader/pdf-network/test_reader_pdf_engine_range_boundary.mjs '
                  'tests/reader/pdf-v3/test_page_window_strict_helpers.mjs')
        worker = 'node --test tests/search/worker/test_app_legacy_worker_boundary.mjs'
        app = ('node --test tests/search/app/test_dom_contract.mjs '
               'tests/search/app/test_null_projection_rows.mjs tests/search/app/test_page_cache.mjs')

        def require_command(job, command, hf_job=False):
            steps = job.split('      - name: ')
            matching = [step for step in steps if f'\n          {command}\n' in step]
            self.assertEqual(len(matching), 1)
            self.assertIn('\n        run: |\n', matching[0])
            if hf_job:
                self.assertIn('\n        working-directory: huggingface-search\n', matching[0])

        for job, command, hf_job in ((pages, reader, False), (pages, worker, False),
                                      (hf, reader, True), (hf, app, True)):
            require_command(job, command, hf_job)
            with self.assertRaises(AssertionError):
                require_command(job.replace(command, '# ' + command), command, hf_job)

    def test_exact_inventory_and_referenced_evidence_pass(self):
        self.check()

    def test_new_test_and_stale_entry_fail(self):
        (self.root / 'tests/test_new.js').write_text('')
        with self.assertRaisesRegex(ValueError, 'test inventory mismatch'):
            self.check()
        (self.root / 'tests/test_new.js').unlink()
        (self.root / 'tests/test_example.py').unlink()
        with self.assertRaisesRegex(ValueError, 'no tests found'):
            self.check()

    def test_shared_evidence_is_preprocessed_once_per_validation(self):
        (self.root / 'tests/test_other.py').write_text('')
        self.doc['tests']['tests/test_other.py'] = {'kind': 'direct', 'source': 'scripts/gate.py'}
        self.save()
        evidence = self.root / 'scripts/gate.py'
        text = 'tests.test_example tests/test_other.py\n'
        evidence.write_text(text)
        with (patch.object(Path, 'read_text', autospec=True, side_effect=Path.read_text) as read,
              patch.object(check_test_inventory, 'uncomment', wraps=check_test_inventory.uncomment) as uncomment):
            self.check()
            self.assertEqual(read.call_args_list.count(call(evidence, encoding='utf-8')), 1)
            uncomment.assert_called_once_with(text)

        evidence.write_text('tests.test_example tests/test_other.py_extra\n')
        with self.assertRaisesRegex(ValueError, 'does not reference tests/test_other.py'):
            self.check()
        (self.root / 'tests/test_other.py').unlink()
        with self.assertRaisesRegex(ValueError, r"stale=\['tests/test_other\.py'\]"):
            self.check()

    def test_missing_or_comment_only_evidence_fails(self):
        self.check()
        (self.root / 'scripts/gate.py').write_text('# tests.test_example\n')
        with self.assertRaisesRegex(ValueError, 'does not reference'):
            self.check()
        (self.root / 'scripts/gate.py').unlink()
        with self.assertRaisesRegex(ValueError, 'missing evidence'):
            self.check()

    def test_side_effect_import_accounts_for_helper_and_missing_import_fails(self):
        importer = self.root / 'tests/test_runner.mjs'
        first_import = "import './test_helper.mjs';\n"
        second_import = "import './test_other.mjs';\n"
        importer.write_text(first_import + second_import)
        (self.root / 'scripts/gate.py').write_text(
            'MODULES = "tests.test_example tests/test_runner.mjs"\n')
        self.doc['tests']['tests/test_runner.mjs'] = {'kind': 'script', 'source': 'scripts/gate.py'}
        for path in ('tests/test_helper.mjs', 'tests/test_other.mjs'):
            (self.root / path).write_text('')
            self.doc['tests'][path] = {'kind': 'helper', 'source': 'tests/test_runner.mjs'}
        self.save()
        with patch.object(Path, 'read_text', autospec=True, side_effect=Path.read_text) as read:
            self.check()
            self.assertEqual(read.call_args_list.count(call(importer, encoding='utf-8')), 1)
        for text in ('  # ' + second_import, ''):
            importer.write_text(first_import + text)
            with self.assertRaisesRegex(ValueError, 'helper importer missing: tests/test_other.mjs'):
                self.check()

    def test_manifest_evidence_is_revalidated(self):
        self.doc['tests']['tests/test_example.py'] = {'kind': 'manifest', 'source': 'manifest.json'}
        self.save()
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps({'module': 'tests.test_example', 'groups': ['example']}))
        self.check()
        for data in ({'module': 'tests.test_example', 'groups': []},
                     {'module': 'tests.test_other', 'groups': ['example']}):
            manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'invalid frozen-manifest evidence'):
                self.check()

    def test_missing_tests_package_marker_fails(self):
        (self.root / 'tests/__init__.py').unlink()
        with self.assertRaisesRegex(ValueError, 'tests package marker missing'):
            self.check()

    def test_v3_browser_component_import_does_not_change_signal_or_timer(self):
        root = Path(__file__).resolve().parents[2]
        script = '''
import importlib.util
import signal

def sentinel(*_args):
    pass
signal.signal(signal.SIGALRM, sentinel)
signal.alarm(30)
spec = importlib.util.spec_from_file_location('v3_component_probe',
    'tests/reader/pdf-v3/test_reader_v3_browser.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
remaining = signal.alarm(0)
if signal.getsignal(signal.SIGALRM) is not sentinel or not 1 <= remaining <= 30:
    raise RuntimeError(f'component import changed signal or timer: {remaining}')
'''
        result = subprocess.run([sys.executable, '-B', '-c', script], cwd=root,
                                capture_output=True, text=True, timeout=15, check=False)  # noqa: S603
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_short_exclusion_and_unsafe_paths_fail(self):
        self.doc['tests']['tests/test_example.py'] = {'kind': 'excluded', 'reason': 'skip'}
        self.save()
        with self.assertRaisesRegex(ValueError, 'exclusion needs'):
            self.check()
        self.doc['tests']['tests/test_example.py'] = {'kind': 'script', 'source': '../outside'}
        self.save()
        with self.assertRaisesRegex(ValueError, 'unsafe path'):
            self.check()

    def test_hf_external_workflow_must_reference_case_when_supplied(self):
        self.doc['project'] = 'hf'
        entry = {'kind': 'direct', 'source': '@reader-workflow'}
        self.doc['tests']['tests/test_example.py'] = entry
        self.doc['tests']['tests/test_other.py'] = entry
        (self.root / 'tests/test_other.py').write_text('')
        self.save()
        workflow = self.root / 'workflow.yml'

        def check_workflow():
            validate(self.root, inventory=self.inventory, project='hf', external_workflow=workflow)

        workflow.write_text('  huggingface-search:\n    run: python -m unittest tests.test_example tests.test_other\n')
        with (patch.object(Path, 'read_text', autospec=True, side_effect=Path.read_text) as read,
              patch.object(check_test_inventory, 'uncomment', wraps=check_test_inventory.uncomment) as uncomment):
            check_workflow()
            self.assertEqual(read.call_args_list.count(call(workflow, encoding='utf-8')), 1)
            uncomment.assert_called_once()

        workflow.write_text('  github-search:\n    run: python -m unittest tests.test_other\n'
                            '  huggingface-search:\n    run: python -m unittest tests.test_example\n'
                            '    # tests.test_other\n'
                            '  next-job:\n    run: python -m unittest tests.test_other\n')
        with self.assertRaisesRegex(ValueError, 'does not reference tests/test_other.py'):
            check_workflow()
        workflow.write_text('  github-search:\n    run: python -m unittest tests.test_example tests.test_other\n')
        with self.assertRaisesRegex(ValueError, 'missing HF job'):
            check_workflow()
        workflow.unlink()
        with self.assertRaises(FileNotFoundError):
            check_workflow()


if __name__ == '__main__':
    unittest.main()

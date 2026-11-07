"""Negative probes for the test-file inventory checker."""
import json
from pathlib import Path
import tempfile
import unittest

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

    def test_missing_or_comment_only_evidence_fails(self):
        (self.root / 'scripts/gate.py').write_text('# tests.test_example\n')
        with self.assertRaisesRegex(ValueError, 'does not reference'):
            self.check()
        (self.root / 'scripts/gate.py').unlink()
        with self.assertRaisesRegex(ValueError, 'missing evidence'):
            self.check()

    def test_missing_tests_package_marker_fails(self):
        (self.root / 'tests/__init__.py').unlink()
        with self.assertRaisesRegex(ValueError, 'tests package marker missing'):
            self.check()

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
        self.doc['tests']['tests/test_example.py'] = {'kind': 'direct', 'source': '@reader-workflow'}
        self.save()
        workflow = self.root / 'workflow.yml'
        workflow.write_text('  huggingface-search:\n    # tests.test_example\n')
        with self.assertRaisesRegex(ValueError, 'does not reference'):
            validate(self.root, inventory=self.inventory, project='hf', external_workflow=workflow)
        workflow.write_text('  github-search:\n    run: python -m unittest tests.test_example\n'
                            '  huggingface-search:\n    run: echo no-tests\n')
        with self.assertRaisesRegex(ValueError, 'does not reference'):
            validate(self.root, inventory=self.inventory, project='hf', external_workflow=workflow)
        workflow.write_text('  huggingface-search:\n    run: python -m unittest tests.test_example\n')
        validate(self.root, inventory=self.inventory, project='hf', external_workflow=workflow)


if __name__ == '__main__':
    unittest.main()

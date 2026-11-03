"""The separate immutable baseline must fail closed on malformed or changed input."""
import hashlib
from pathlib import Path
import re
import tempfile
import unittest

from scripts.verify_hf_quality_baseline import REQUIRED, validate_baselines


class HfSearchProjectionCiTests(unittest.TestCase):
    def test_full_projection_contract_and_mutations_are_required(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertIn('tests.test_search_projection_contract', workflow)
        self.assertIn('tests.test_search_projection_mutation_contract', workflow)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_projection'), 1)
        self.assertIn('merge-base --is-ancestor 72fb4b0f9ae16e26b83b3feb21d0bcee9b527c3a HEAD', workflow)

    def test_synthetic_reader_archive_boundaries_are_in_backend_coverage_gate(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.test_reader_archive_hardening'), 1)
        self.assertIn('tests.test_reader_backend tests.test_reader_archive_hardening', workflow)

    def test_reader_compression_safety_is_in_backend_coverage_gate(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.test_reader_compression_safety'), 1)
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        self.assertIn('tests.test_reader_compression_safety', selection.group(1))

    def test_full_candidates_contract_and_mutations_are_required(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.test_search_candidates_contract'), 1)
        self.assertEqual(workflow.count('tests.test_search_candidates_mutation_contract'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_candidates'), 1)

    def test_full_bootstrap_contract_and_mutations_are_required(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.test_search_bootstrap_contract'), 1)
        self.assertEqual(workflow.count('tests.test_search_bootstrap_mutation_contract'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_bootstrap'), 1)

    def test_both_sites_run_original_extension_behavior_contracts(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        gate = 'node --test tests/test_search_extension_inventory_baseline.mjs tests/test_search_extension_filter_baseline.mjs'
        self.assertEqual(workflow.count(gate), 2)
        self.assertEqual(workflow.count('node scripts/check_search_file_types_coverage.mjs'), 2)

    def test_pages_runs_search_position_and_prefetch_regressions(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        gate = 'python3 -B -m unittest -v tests.test_prefetch_pipeline tests.test_search_positions'
        self.assertEqual(workflow.count(gate), 1)

    def test_both_sites_run_search_response_validation_contract(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node --test tests/test_search_response_validation_baseline.mjs'), 2)
        self.assertEqual(workflow.count('node scripts/check_search_response_validation_coverage.mjs'), 2)


class HfQualityBaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.lock = {"repository": "VoiceOfML/Search", "revision": "a" * 40, "files": {}}
        for name in REQUIRED:
            payload = (name + "\n").encode()
            (self.root / name).write_bytes(payload)
            self.lock["files"][name] = hashlib.sha256(payload).hexdigest()

    def test_exact_pinned_bytes_pass_and_changed_bytes_fail(self):
        self.assertEqual(validate_baselines(self.root, self.lock), [])
        (self.root / "backend-coverage-debt.json").write_text("different\n")
        self.assertIn("missing or altered baseline file: backend-coverage-debt.json",
                      validate_baselines(self.root, self.lock))

    def test_missing_file_and_invalid_lock_fail(self):
        (self.root / "strict-inventory-debt.json").unlink()
        self.assertIn("missing or altered baseline file: strict-inventory-debt.json",
                      validate_baselines(self.root, self.lock))
        self.lock["repository"] = "other"
        self.lock["revision"] = "main"
        self.lock["files"]["backend-coverage-debt.json"] = "abc"
        errors = validate_baselines(self.root, self.lock)
        self.assertIn("incorrect Hugging Face baseline repository", errors)
        self.assertIn("baseline revision must be a full commit SHA", errors)
        self.assertIn("invalid baseline SHA-256: backend-coverage-debt.json", errors)

    def test_incomplete_or_extra_file_inventory_fails(self):
        del self.lock["files"]["strict-inventory-debt.json"]
        self.assertIn("baseline must list exactly the coverage and strict inventories",
                      validate_baselines(self.root, self.lock))
        self.lock["files"]["extra.json"] = "b" * 64
        self.assertIn("baseline must list exactly the coverage and strict inventories",
                      validate_baselines(self.root, self.lock))


if __name__ == "__main__":
    unittest.main()

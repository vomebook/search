"""The separate immutable baseline must fail closed on malformed or changed input."""
import hashlib
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import Mock

from scripts.check_sidebar_payload_regressions import TEST_NAMES, passed
from scripts.verify_hf_quality_baseline import REQUIRED, validate_baselines


class HfSearchProjectionCiTests(unittest.TestCase):
    def test_full_projection_contract_and_mutations_are_required(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertIn('tests.search.backend.test_search_projection_contract', workflow)
        self.assertIn('tests.search.backend.test_search_projection_mutation_contract', workflow)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_projection'), 1)
        self.assertIn('merge-base --is-ancestor 9eedf4acc921056467a6479448810c860c4d7e9e HEAD', workflow)

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

    def test_mutation_gate_hardening_runs_with_quality_inventory(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.test_quality_inventory tests.test_mutation_gate_hardening tests.test_mutation_gate_main'), 1)

    def test_full_candidates_contract_and_mutations_are_required(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.search.backend.test_search_candidates_contract'), 1)
        self.assertEqual(workflow.count('tests.search.backend.test_search_candidates_mutation_contract'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_candidates'), 1)

    def test_full_bootstrap_contract_and_mutations_are_required(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.search.backend.test_search_bootstrap_contract'), 1)
        self.assertEqual(workflow.count('tests.search.backend.test_search_bootstrap_mutation_contract'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_bootstrap'), 1)

    def test_grouped_search_filters_contract_and_mutation_gate_are_required(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.search.backend.test_search_filters_contract'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_filters'), 1)

    def test_grouped_search_order_cache_runs_in_backend_coverage(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        self.assertEqual(selection.group(1).split().count('tests.search.backend.test_search_order_cache'), 1)
        self.assertNotIn('tests.test_search_order_cache', selection.group(1).split())

    def test_grouped_folder_tree_contracts_and_mutation_gate_are_required(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        for module in ('tests.search.backend.test_folder_tree_contract',
                       'tests.search.backend.test_folder_tree_mutation_contract'):
            self.assertEqual(selection.group(1).split().count(module), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module folder_tree'), 1)

    def test_grouped_search_behaviors_are_in_backend_coverage(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        modules = selection.group(1).split()
        for module in ('tests.search.backend.test_search_behavior', 'tests.search.backend.test_search'):
            self.assertEqual(modules.count(module), 1)
        for old in ('tests.test_search_behavior', 'tests.test_search'):
            self.assertNotIn(old, modules)

    def test_grouped_search_execution_runs_in_coverage_and_responsiveness(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        module = 'tests.search.backend.test_search_execution'
        self.assertEqual(selection.group(1).split().count(module), 1)
        responsiveness = [line for line in workflow.splitlines() if line.strip().startswith('run: timeout 120s ')]
        self.assertEqual(len(responsiveness), 1)
        self.assertEqual(responsiveness[0].split().count(module), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_execution'), 1)
        self.assertNotIn('tests.test_search_execution', workflow)

    def test_grouped_search_words_and_matching_gates_are_required(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        self.assertEqual(selection.group(1).split().count('tests.search.backend.test_search_words_contract'), 1)
        self.assertNotIn('tests.test_search_words_contract', selection.group(1).split())
        self.assertEqual(workflow.splitlines().count('          python -B scripts/check_search_words_mutation.py'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_matching'), 1)

    def test_grouped_backend_cache_contracts_and_mutation_gate_are_required(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        for module in ('tests.search.backend.test_cache_and_malformed',
                       'tests.search.backend.test_cache_core_contract'):
            self.assertEqual(selection.group(1).split().count(module), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module cache_core'), 1)

    def test_grouped_record_metadata_contract_and_mutation_gate_are_required(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        self.assertEqual(selection.group(1).split().count('tests.search.backend.test_record_metadata_contract'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module record_metadata'), 1)

    def test_both_sites_run_original_extension_behavior_contracts(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        gate = 'node --test tests/search/baselines/test_search_extension_inventory_baseline.mjs tests/search/baselines/test_search_extension_filter_baseline.mjs'
        self.assertEqual(workflow.count(gate), 2)
        self.assertEqual(workflow.count('node scripts/check_search_file_types_coverage.mjs'), 2)

    def test_pages_runs_search_position_and_prefetch_regressions(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        gate = 'python3 -B -m unittest -v tests.test_prefetch_pipeline tests.test_search_positions'
        self.assertEqual(workflow.count(gate), 1)

    def test_pages_runs_initial_payload_route_regressions_in_both_browsers(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        for browser in ('chromium', 'firefox'):
            self.assertEqual(workflow.count(f'SIDEBAR_PAYLOAD_TEST_BROWSER={browser} '
                                            'python3 -B scripts/check_sidebar_payload_regressions.py'), 1)

    def test_initial_payload_gate_rejects_failures_skips_and_incomplete_runs(self):
        result = Mock(testsRun=len(TEST_NAMES), skipped=[], expectedFailures=[], unexpectedSuccesses=[])
        result.wasSuccessful.return_value = True
        self.assertTrue(passed(result))
        result.testsRun -= 1
        self.assertFalse(passed(result))
        result.testsRun += 1
        result.skipped = [(None, 'browser unavailable')]
        self.assertFalse(passed(result))
        result.skipped = []
        result.expectedFailures = [(None, 'expected failure')]
        self.assertFalse(passed(result))
        result.expectedFailures = []
        result.unexpectedSuccesses = [None]
        self.assertFalse(passed(result))
        result.unexpectedSuccesses = []
        result.wasSuccessful.return_value = False
        self.assertFalse(passed(result))

    def test_both_sites_run_search_response_validation_contract(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node --test tests/search/baselines/test_search_response_validation_baseline.mjs'), 2)
        self.assertEqual(workflow.count('node scripts/check_search_response_validation_coverage.mjs'), 2)

    def test_both_sites_run_original_search_stable_id_contract(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node --test tests/search/baselines/test_search_stable_id_baseline.mjs'), 2)
        self.assertEqual(workflow.count('node scripts/check_search_result_identity_coverage.mjs'), 2)

    def test_both_sites_run_original_filter_equality_contract(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/check_search_filter_equality_baseline.mjs'), 2)

    def test_both_sites_run_original_folder_merge_contract(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/check_search_folder_merge_baseline.mjs'), 2)

    def test_both_sites_run_original_readability_contract(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/check_search_readability_baseline.mjs'), 2)

    def test_both_sites_run_reader_image_loader_coverage(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/check_reader_image_loader_coverage.mjs'), 2)

    def test_both_sites_run_reader_lifecycle_coverage(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/check_reader_lifecycle_coverage.mjs'), 2)

    def test_both_sites_run_reader_media_coverage(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/check_reader_media_coverage.mjs'), 2)

    def test_both_sites_run_reader_text_coverage(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/check_reader_text_coverage.mjs'), 2)

    def test_both_sites_run_pdf_book_client_coverage(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/check_pdf_book_client_coverage.mjs'), 2)
        self.assertEqual(workflow.count('node tests/test_reader_ocr_transport.mjs'), 2)

    def test_both_sites_run_response_cache_gate_and_pages_legacy_test(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/check_search_response_cache_coverage.mjs'), 2)
        self.assertEqual(workflow.count('node tests/search/response-cache/test_response_cache.js'), 1)
        self.assertNotIn('node tests/test_response_cache.js', workflow)

    def test_both_sites_run_grouped_search_presentation_gates(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        for gate in ('check_search_highlight_coverage.mjs', 'check_search_size_coverage.mjs'):
            self.assertEqual(workflow.count(f'node scripts/search/{gate}'), 2)
            self.assertNotIn(f'node scripts/{gate}', workflow)

    def test_both_sites_run_grouped_record_path_and_search_build_tests(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/search/check_search_record_path_coverage.mjs'), 2)
        self.assertEqual(workflow.count('node tests/search/build/test_search_record_path_build.mjs'), 2)
        self.assertNotIn('node scripts/check_search_record_path_coverage.mjs', workflow)
        self.assertNotIn('node tests/test_search_record_path_build.mjs', workflow)

    def test_both_sites_run_dom_search_browser_contracts(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('python3 -B -m unittest -v tests.test_reader_dom_search_gate'), 2)
        self.assertEqual(workflow.count('python3 -B scripts/check_reader_dom_search_contracts.py'), 2)
        self.assertEqual(workflow.count('python3 -B -m unittest -v tests.test_reader_refactor'), 2)

    def test_both_sites_run_all_djvu_scripts_and_named_contract_gate(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        for name in ('only', 'png', 'range', 'range_fallback', 'scheduler', 'source_integrity', 'worker'):
            self.assertEqual(workflow.count(f'node tests/reader/djvu/test_reader_djvu_{name}.mjs'), 2, name)
        self.assertEqual(workflow.count('node scripts/check_reader_djvu_contracts.mjs'), 2)

    def test_both_sites_run_reader_navigation_baseline_contracts(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/check_reader_navigation_baseline.mjs'), 2)

    def test_both_sites_test_shared_tap_contract_validator(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node --test tests/test_tap_contracts.mjs'), 2)

    def test_both_sites_run_download_controller_coverage(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/check_download_controller_coverage.mjs'), 2)


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

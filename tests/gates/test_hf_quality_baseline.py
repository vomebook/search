"""The separate immutable baseline must fail closed on malformed or changed input."""
import hashlib
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import Mock

from scripts.check_sidebar_payload_regressions import TEST_NAMES, passed
from scripts.verify_hf_quality_baseline import REQUIRED, validate_baselines


class ReaderWorkflowParallelTests(unittest.TestCase):
    def test_firefox_job_is_independent_and_keeps_the_exact_gate(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        github = workflow.split('  github-search:\n', 1)[1].split('  firefox-staged-pdf:\n', 1)[0]
        firefox = workflow.split('  firefox-staged-pdf:\n', 1)[1].split('  huggingface-search:\n', 1)[0]
        gate = ('      - name: Check staged PDF opening in Firefox\n'
                '        env:\n          READER_TEST_BROWSER: firefox\n'
                '        run: python3 -B -m unittest -v tests.reader.browser.test_reader_pdf_first_page tests.reader.browser.test_reader_pdf_history_race\n')
        self.assertEqual(workflow.count(gate), 1)
        self.assertIn(gate, firefox)
        self.assertNotIn('needs:', firefox)
        self.assertNotIn('continue-on-error:', firefox)
        self.assertNotIn('if:', firefox)
        for job, browsers in ((github, 'chromium firefox'), (firefox, 'firefox')):
            for command in ('python-version: "3.11.17"', 'playwright==1.63.0', 'pypdf==6.21.4',
                            'npm ci --ignore-scripts --no-audit --no-fund', 'install -y qpdf',
                            f'playwright install-deps {browsers}', f'playwright install {browsers}',
                            'fetch_foliate_reader.mjs', 'copy_reader_vendor.mjs'):
                self.assertIn(command, job)
            for cache in ('~/.cache/pip', '~/.npm', '~/.cache/ms-playwright',
                          '${{ runner.os }}', '${{ runner.arch }}', '${{ steps.distro.outputs.version }}-1.63.0'):
                self.assertIn(cache, job)
            self.assertNotIn('path: node_modules', job)
        hf = workflow.split('  huggingface-search:\n', 1)[1]
        for command in ('python -m pip install -r requirements.txt -r config/dependencies/static-check.txt '
                        'playwright==1.63.0 Pillow==12.3.0 httpx==0.28.1',
                        'npm ci --ignore-scripts --no-audit --no-fund',
                        'playwright install-deps chromium firefox', 'playwright install chromium firefox',
                        'fetch_foliate_reader.mjs', 'copy_reader_vendor.mjs',
                        "hashFiles('huggingface-search/requirements.txt', 'huggingface-search/config/dependencies/static-check.txt')",
                        "hashFiles('huggingface-search/package-lock.json')", '${{ steps.distro.outputs.version }}-1.63.0'):
            self.assertIn(command, hf)
        for job in (github, firefox, hf):
            self.assertIn('runs-on: ubuntu-24.04', job)
            mirror = 'python3 -B scripts/ci/ci_ubuntu_mirror.py'
            self.assertLess(job.index(mirror), job.index('playwright install-deps'))
            self.assertIn('name: Install Playwright system dependencies\n        timeout-minutes: 15', job)
        for job, project, following in ((github, 'github', 'python -B -m unittest -v tests.seo.test_seo_catalog'),
                                        (hf, 'hf', None)):
            runner = f'python -B scripts/ci/run_static_gate_shards.py --project {project}'
            self.assertIn('python -B -m unittest -v tests.gates.test_static_shards_runner', job)
            self.assertEqual(job.count(runner), 1)
            self.assertNotIn('python -B -m unittest -v tests.gates.test_static_checks', job)
            if following:
                self.assertLess(job.index(runner), job.index(following))
        self.assertNotIn('path: node_modules', hf)
        self.assertNotIn('continue-on-error:', hf)
        self.assertNotIn('if:', hf)


class DependencyLayoutCiTests(unittest.TestCase):
    def test_static_and_audit_dependencies_keep_distinct_pinned_install_paths(self):
        root = Path(__file__).resolve().parents[2]
        self.assertEqual((root / "config/dependencies/static-check.txt").read_text().splitlines(), ["ruff==0.17.3"])
        audit = (root / ".github/workflows/dependency-audit.yml").read_text()
        self.assertIn('"config/dependencies/**"', audit)
        self.assertIn('python -m pip install -r config/dependencies/audit.txt', audit)
        self.assertIn('python -m pip_audit -r requirements.txt --progress-spinner off', audit)
        workflow = (root / ".github/workflows/reader-refactor.yml").read_text()
        hf = workflow.split('  huggingface-search:\n', 1)[1]
        self.assertIn('working-directory: huggingface-search', hf)
        self.assertIn('-r requirements.txt -r config/dependencies/static-check.txt', hf)
        self.assertNotIn('requirements-static-check.txt', workflow)


class CrossSiteSearchContractsCiTests(unittest.TestCase):
    def test_paging_and_snapshot_contracts_run_against_each_checkout(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        github = workflow.split('  github-search:\n', 1)[1].split('  firefox-staged-pdf:\n', 1)[0]
        hf = workflow.split('  huggingface-search:\n', 1)[1]
        commands = (
            'node tests/support/test_search_test_projects.js',
            'node tests/search/paging/test_page_generation.js',
            'node tests/search/ui/test_search_interaction_state.js',
            'node tests/search/ui/test_snapshot_clone_geometry.js',
            'node tests/performance/test_snapshot_budget.js',
            'node tests/performance/test_next_page_latency.js',
        )
        for job, name, root in ((github, 'github-Search', '${{ github.workspace }}'),
                                (hf, 'huggingface-Search', '${{ github.workspace }}/huggingface-search')):
            step = job.split('      - name: Check ' + ('GitHub' if job == github else 'Hugging Face')
                             + ' search paging and snapshot contracts\n', 1)[1].split('      - name:', 1)[0]
            self.assertIn('SEARCH_TEST_PROJECT: ' + name, step)
            self.assertIn('SEARCH_TEST_ROOT: ' + root + '\n', step)
            for command in commands:
                self.assertEqual(step.count(command), 1)
            self.assertNotIn('continue-on-error:', step)
            self.assertNotIn('working-directory:', step)
        integration = hf.split('      - name: Run real backend and browser integration\n', 1)[1].split('      - name:', 1)[0]
        for required in ('working-directory: huggingface-search',
                         "loadTestsFromName('tests.backend.test_real_integration')",
                         'not result.wasSuccessful()', 'result.testsRun != 13', 'result.skipped', 'sys.exit(1)'):
            self.assertIn(required, integration)
        self.assertNotIn('continue-on-error:', integration)


class TestInventoryCiTests(unittest.TestCase):
    def test_inventory_checks_are_required_in_both_sites_and_pages(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / '.github/workflows/reader-refactor.yml').read_text()
        pages = (root / '.github/workflows/static.yml').read_text()
        github = workflow.split('  github-search:\n', 1)[1].split('  firefox-staged-pdf:\n', 1)[0]
        hf = workflow.split('  huggingface-search:\n', 1)[1]
        for job, project, extra in ((github, 'github', ''),
                                    (hf, 'hf', ' --reader-workflow ../.github/workflows/reader-refactor.yml'),
                                    (pages, 'github', '')):
            self.assertIn('tests.gates.test_package_resolution tests.gates.test_test_inventory', job)
            self.assertIn(f'python -B scripts/check_test_inventory.py --project {project}{extra}\n', job)
            self.assertNotIn('continue-on-error:', job)


class AdditionalSuitesCiTests(unittest.TestCase):
    def test_previously_unrun_contracts_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        github = workflow.split('  github-search:\n', 1)[1].split('  firefox-staged-pdf:\n', 1)[0]
        hf = workflow.split('  huggingface-search:\n', 1)[1]
        timeout = github.split('      - name: Check Reader request timeout in Chromium\n', 1)[1].split('      - name:', 1)[0]
        for required in ("loadTestsFromName('tests.reader.browser.test_reader_timeout')",
                         'not result.wasSuccessful()', 'result.testsRun != 3', 'result.skipped', 'sys.exit(1)'):
            self.assertIn(required, timeout)
        worker = github.split('      - name: Check warmed Reader shell reuse\n', 1)[1].split('      - name:', 1)[0]
        offline = 'tests.service_worker.test_service_worker_integration.ServiceWorkerIntegrationTest.test_offline_cache_misses_reject_as_network_errors_and_cached_data_survives'
        self.assertEqual(worker.count(offline), 1)
        self.assertNotIn('continue-on-error:', worker)
        for command in ('node tests/reader/core/test_reader_store_channel.js',
                        'node tests/reader/transport/test_reader_preload.js',
                        'node tests/service_worker/test_service_worker.js'):
            self.assertEqual(hf.count(command + '\n'), 1)
        additional = hf.split('      - name: Run additional Hugging Face search and Reader regressions\n', 1)[1].split('      - name:', 1)[0]
        for required in ('working-directory: huggingface-search',
                         'tests.performance.test_folder_projection_performance',
                         'tests.performance.test_random_reader_performance',
                         'tests.reader.browser.test_reader_accessibility',
                         'tests.reader.browser.test_reader_ebook_flow',
                         'tests.reader.browser.test_reader_store_preservation',
                         'tests.search.browser.test_prefetch_pipeline',
                         'tests.search.browser.test_search_positions',
                         'tests.search.backend.test_wildcard_index_oracle',
                         'result.testsRun != 59', 'READER_STORE_TEST_BROWSER=firefox', 'result.testsRun != 12'):
            self.assertIn(required, additional)
        self.assertEqual(additional.count('result.skipped'), 2)
        self.assertEqual(additional.count('sys.exit(1)'), 2)
        self.assertNotIn('continue-on-error:', timeout)
        self.assertNotIn('continue-on-error:', additional)


class HfSearchProjectionCiTests(unittest.TestCase):
    def test_full_projection_contract_and_mutations_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertIn('tests.search.backend.test_search_projection_contract', workflow)
        self.assertIn('tests.search.backend.test_search_projection_mutation_contract', workflow)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_projection'), 1)
        self.assertIn('merge-base --is-ancestor c7424ac3e549c9edf59f302e3809268c12bfe114 HEAD', workflow)

    def test_synthetic_reader_archive_boundaries_are_in_backend_coverage_gate(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.reader.backend.test_reader_archive_hardening'), 1)
        self.assertIn('tests.reader.backend.test_reader_backend tests.reader.backend.test_reader_archive_hardening', workflow)

    def test_reader_compression_safety_is_in_backend_coverage_gate(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.reader.backend.test_reader_compression_safety'), 1)
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        self.assertIn('tests.reader.backend.test_reader_compression_safety', selection.group(1))

    def test_mutation_gate_hardening_runs_with_quality_inventory(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.gates.test_quality_inventory tests.gates.test_mutation_gate_hardening tests.gates.test_mutation_gate_main'), 1)

    def test_full_candidates_contract_and_mutations_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.search.backend.test_search_candidates_contract'), 1)
        self.assertEqual(workflow.count('tests.search.backend.test_search_candidates_mutation_contract'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_candidates'), 1)

    def test_reader_archive_contract_and_mutations_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        start = workflow.index('coverage run --branch --source=backend,app')
        end = workflow.index('coverage json', start)
        modules = workflow[start:end].replace(chr(92), ' ').split()
        for module in ('tests.reader.backend.test_reader_archive_contract',
                       'tests.reader.backend.test_reader_archive_mutation_contract'):
            self.assertEqual(modules.count(module), 1)
            self.assertEqual(workflow.count(module), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module reader_archive'), 1)

    def test_full_bootstrap_contract_and_mutations_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.search.backend.test_search_bootstrap_contract'), 1)
        self.assertEqual(workflow.count('tests.search.backend.test_search_bootstrap_mutation_contract'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_bootstrap'), 1)

    def test_grouped_search_filters_contract_and_mutation_gate_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('tests.search.backend.test_search_filters_contract'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_filters'), 1)

    def test_grouped_search_order_cache_runs_in_backend_coverage(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        self.assertEqual(selection.group(1).split().count('tests.search.backend.test_search_order_cache'), 1)
        self.assertNotIn('tests.test_search_order_cache', selection.group(1).split())

    def test_grouped_folder_tree_contracts_and_mutation_gate_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        for module in ('tests.search.backend.test_folder_tree_contract',
                       'tests.search.backend.test_folder_tree_mutation_contract'):
            self.assertEqual(selection.group(1).split().count(module), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module folder_tree'), 1)

    def test_grouped_search_behaviors_are_in_backend_coverage(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        modules = selection.group(1).split()
        for module in ('tests.search.backend.test_search_behavior', 'tests.search.backend.test_search'):
            self.assertEqual(modules.count(module), 1)
        for old in ('tests.test_search_behavior', 'tests.test_search'):
            self.assertNotIn(old, modules)

    def test_grouped_search_execution_runs_in_coverage_and_responsiveness(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
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
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        self.assertEqual(selection.group(1).split().count('tests.search.backend.test_search_words_contract'), 1)
        self.assertNotIn('tests.test_search_words_contract', selection.group(1).split())
        self.assertEqual(workflow.splitlines().count('          python -B scripts/check_search_words_mutation.py'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_matching'), 1)

    def test_grouped_backend_cache_contracts_and_mutation_gate_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        for module in ('tests.search.backend.test_cache_and_malformed',
                       'tests.search.backend.test_cache_core_contract'):
            self.assertEqual(selection.group(1).split().count(module), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module cache_core'), 1)

    def test_grouped_record_metadata_contract_and_mutation_gate_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        self.assertEqual(selection.group(1).split().count('tests.search.backend.test_record_metadata_contract'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module record_metadata'), 1)

    def test_grouped_native_index_contract_and_mutation_gate_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        self.assertEqual(selection.group(1).split().count('tests.search.backend.test_native_search_indexes'), 1)
        self.assertEqual(selection.group(1).split().count('tests.performance.test_exact_search_performance'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module search_indexes'), 1)

    def test_grouped_reader_index_contracts_retain_all_gates(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        for module in ('tests.reader.backend.test_reader_index_contract', 'tests.reader.backend.test_reader_index_warming'):
            self.assertEqual(selection.group(1).split().count(module), 1)
        responsiveness = [line for line in workflow.splitlines() if line.strip().startswith('run: timeout 120s ')]
        self.assertEqual(len(responsiveness), 1)
        self.assertEqual(responsiveness[0].split().count('tests.reader.backend.test_reader_index_warming'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module reader_index'), 1)

    def test_grouped_reader_identity_contract_and_mutation_gate_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        self.assertEqual(selection.group(1).split().count('tests.reader.backend.test_reader_identity_contract'), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module reader_identity'), 1)

    def test_grouped_proxy_contracts_retain_all_gates(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        modules = ('tests.proxy.test_proxy_ownership', 'tests.proxy.test_proxy_streams_contract')
        responsiveness = [line for line in workflow.splitlines() if line.strip().startswith('run: timeout 120s ')]
        self.assertEqual(len(responsiveness), 1)
        for module in modules:
            self.assertEqual(selection.group(1).split().count(module), 1)
            self.assertEqual(responsiveness[0].split().count(module), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module proxy_streams'), 1)

    def test_grouped_data_format_contracts_and_mutation_gate_are_required(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        selection = re.search(r'python -B -m coverage run --branch --source=backend,app -m unittest -q \\\n'
                              r'(.*?)\n\s+COVERAGE_FILE=', workflow, re.S)
        self.assertIsNotNone(selection)
        for module in ('tests.data.test_data_decoding', 'tests.data.test_data_formats_contract'):
            self.assertEqual(selection.group(1).split().count(module), 1)
        self.assertEqual(workflow.count('scripts/check_search_words_mutation.py --module data_formats'), 1)

    def test_both_sites_run_grouped_frontend_search_gates(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        for gate in ('check_search_file_types_coverage.mjs', 'check_search_response_cache_coverage.mjs',
                     'check_search_response_validation_coverage.mjs', 'check_search_result_identity_coverage.mjs',
                     'check_search_folder_selection_coverage.mjs', 'check_search_height_index_coverage.mjs',
                     'check_search_filter_equality_baseline.mjs', 'check_search_folder_merge_baseline.mjs',
                     'check_search_readability_baseline.mjs'):
            self.assertEqual(workflow.count(f'node scripts/search/{gate}'), 2)
            self.assertNotIn(f'node scripts/{gate}', workflow)

    def test_both_sites_run_original_extension_behavior_contracts(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        gate = 'node --test tests/search/baselines/test_search_extension_inventory_baseline.mjs tests/search/baselines/test_search_extension_filter_baseline.mjs'
        self.assertEqual(workflow.count(gate), 2)
        self.assertEqual(workflow.count('node scripts/search/check_search_file_types_coverage.mjs'), 2)

    def test_pages_runs_search_position_and_prefetch_regressions(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        gate = 'python3 -B -m unittest -v tests.search.browser.test_prefetch_pipeline tests.search.browser.test_search_positions'
        self.assertEqual(workflow.count(gate), 1)

    def test_pages_runs_initial_payload_route_regressions_in_both_browsers(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
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
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node --test tests/search/baselines/test_search_response_validation_baseline.mjs'), 2)
        self.assertEqual(workflow.count('node scripts/search/check_search_response_validation_coverage.mjs'), 2)

    def test_both_sites_run_original_search_stable_id_contract(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node --test tests/search/baselines/test_search_stable_id_baseline.mjs'), 2)
        self.assertEqual(workflow.count('node scripts/search/check_search_result_identity_coverage.mjs'), 2)

    def test_both_sites_run_original_folder_selection_contract(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node --test tests/search/baselines/test_search_folder_selection_baseline.mjs'), 2)
        self.assertEqual(workflow.count('node scripts/search/check_search_folder_selection_coverage.mjs'), 2)

    def test_both_sites_run_original_filter_equality_contract(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/search/check_search_filter_equality_baseline.mjs'), 2)

    def test_both_sites_run_original_folder_merge_contract(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/search/check_search_folder_merge_baseline.mjs'), 2)

    def test_both_sites_run_original_readability_contract(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/search/check_search_readability_baseline.mjs'), 2)

    def test_both_sites_run_grouped_adapter_coverage(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/reader/check_adapter_coverage.mjs'), 2)
        self.assertNotIn('node scripts/check_adapter_coverage.mjs', workflow)

    def test_both_sites_run_reader_image_loader_coverage(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/reader/check_reader_image_loader_coverage.mjs'), 2)
        self.assertEqual(workflow.count('node tests/reader/images/test_reader_image_loader.mjs'), 2)
        self.assertEqual(workflow.count('node tests/reader/images/test_reader_image_memory.mjs'), 2)
        self.assertNotIn('node scripts/check_reader_image_loader_coverage.mjs', workflow)

    def test_both_sites_run_reader_lifecycle_coverage(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/reader/check_reader_lifecycle_coverage.mjs'), 2)

    def test_both_sites_run_reader_media_coverage(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/reader/check_reader_media_coverage.mjs'), 2)

    def test_both_sites_run_reader_text_coverage(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/reader/check_reader_text_coverage.mjs'), 2)

    def test_both_sites_run_grouped_reader_transport_gates(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        for gate in ('check_request_manager_coverage.mjs', 'check_document_loader_coverage.mjs'):
            self.assertEqual(workflow.count(f'node scripts/reader/{gate}'), 2)
            self.assertNotIn(f'node scripts/{gate}', workflow)

    def test_both_sites_run_grouped_pdf_network_gates(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        for gate in ('check_pdf_network_coverage.mjs', 'check_pdf_network_mutations.mjs'):
            self.assertEqual(workflow.count(f'node scripts/reader/{gate}'), 2)
            self.assertNotIn(f'node scripts/{gate}', workflow)
        self.assertEqual(workflow.count('node --test tests/reader/pdf-network/test_pdf_range_cache_release.mjs'), 2)

    def test_both_sites_run_grouped_chapter_search_and_css_contracts(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        for contract in ('chapter-search/test_reader_chapter_search.mjs', 'security/test_reader_css_sanitizer.mjs'):
            self.assertEqual(workflow.count(f'node tests/reader/{contract}'), 2)
        self.assertNotIn('node tests/test_reader_chapter_search.mjs', workflow)
        self.assertNotIn('node tests/test_reader_css_sanitizer.mjs', workflow)

    def test_both_sites_run_grouped_reader_core_gate(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/reader/check_reader_core_coverage.mjs'), 2)
        self.assertNotIn('node scripts/check_reader_core_coverage.mjs', workflow)

    def test_both_sites_run_reader_v3_gates(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        gates = ('          node scripts/reader/check_reader_v3_coverage.mjs\n'
                 '          node scripts/reader/check_reader_v3_mutations.mjs\n'
                 '          python3 -B tests/reader/pdf-v3/test_reader_v3_browser.py --browser chromium\n'
                 '          python3 -B tests/reader/pdf-v3/test_reader_v3_browser.py --browser firefox\n')
        step = '      - name: Reader v3 gates\n{}        run: |\n' + gates

        def registered(text):
            self.assertNotIn('\n  defaults:', text)
            github = text.split('  github-search:\n', 1)[1].split('  firefox-staged-pdf:\n', 1)[0]
            hf = text.split('  huggingface-search:\n', 1)[1]
            self.assertEqual(text.count('      - name: Reader v3 gates\n'), 2)
            for job, directory in ((github, ''), (hf, '        working-directory: huggingface-search\n')):
                self.assertNotIn('\n    defaults:', job)
                self.assertNotIn('\n    if:', job)
                self.assertNotIn('\n    continue-on-error:', job)
                expected = step.format(directory)
                self.assertEqual(job.count(expected), 1)
                after = job.split(expected, 1)[1]
                self.assertTrue(after.startswith('      - name: '))
                for command in gates.strip().splitlines():
                    self.assertEqual(job.count(command.strip()), 1)

        registered(workflow)
        mutations = [
            workflow.replace('          node scripts/reader/check_reader_v3_coverage.mjs\n',
                             '          # node scripts/reader/check_reader_v3_coverage.mjs\n', 1),
            workflow.replace('          python3 -B tests/reader/pdf-v3/test_reader_v3_browser.py --browser firefox\n',
                             '          # python3 -B tests/reader/pdf-v3/test_reader_v3_browser.py --browser firefox\n', 1),
            workflow.replace('      - name: Reader v3 gates\n',
                             '      - name: Reader v3 gates\n        if: false\n', 1),
            workflow.replace('      - name: Reader v3 gates\n',
                             '      - name: Reader v3 gates\n        continue-on-error: true\n', 1),
            workflow.replace('      - name: Reader v3 gates\n        working-directory: huggingface-search\n',
                             '      - name: Reader v3 gates\n        working-directory: .\n', 1),
        ]
        for changed in mutations:
            with self.subTest(changed=changed[:100]):
                self.assertNotEqual(changed, workflow)
                with self.assertRaises((AssertionError, IndexError)):
                    registered(changed)

    def test_both_sites_run_pdf_book_client_coverage(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/reader/check_pdf_book_client_coverage.mjs'), 2)
        github = workflow.split('  github-search:\n', 1)[1].split('  firefox-staged-pdf:\n', 1)[0]
        hf = workflow.split('  huggingface-search:\n', 1)[1]
        gate = '          node scripts/reader/check_pdf_prefetch_contracts.mjs'
        for job in (github, hf):
            self.assertEqual(job.splitlines().count(gate), 1)
            step = job[:job.index(gate)].rsplit('      - name:', 1)[1]
            self.assertNotIn('if:', step)
            self.assertNotIn('continue-on-error:', step)
        self.assertNotIn('node scripts/check_pdf_book_client_coverage.mjs', workflow)
        for gate in ('check_pdf_text_store_coverage.mjs', 'check_pdf_text_store_mutations.mjs'):
            self.assertEqual(workflow.count(f'node scripts/reader/{gate}'), 2)
        store_browser = 'python3 -B tests/reader/pdf-search/test_pdf_text_store_browser.py'
        self.assertEqual(workflow.count('\n          ' + store_browser), 2)
        self.assertEqual(workflow.count('PDF_TEXT_STORE_TEST_BROWSER=firefox ' + store_browser), 2)
        for test in ('test_reader_ocr_transport.mjs', 'test_reader_book_text.mjs'):
            self.assertEqual(workflow.count(f'node tests/reader/pdf-search/{test}'), 2)
        self.assertEqual(workflow.count('node --test tests/reader/pdf-search/test_pdf_book_worker.mjs'), 2)
        browser_gate = 'python3 -B tests/reader/pdf-search/test_pdf_book_worker_browser.py'
        self.assertEqual(workflow.count('\n          ' + browser_gate), 2)
        self.assertEqual(workflow.count('PDF_WORKER_TEST_BROWSER=firefox ' + browser_gate), 2)
        self.assertNotIn('node tests/test_reader_ocr_transport.mjs', workflow)
        self.assertNotIn('node tests/test_reader_book_text.mjs', workflow)

    def test_both_sites_run_response_cache_gate_and_pages_legacy_test(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/search/check_search_response_cache_coverage.mjs'), 2)
        self.assertEqual(workflow.count('node tests/search/response-cache/test_response_cache.js'), 1)
        self.assertNotIn('node tests/test_response_cache.js', workflow)

    def test_both_sites_run_grouped_search_presentation_gates(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        for gate in ('check_search_highlight_coverage.mjs', 'check_search_size_coverage.mjs'):
            self.assertEqual(workflow.count(f'node scripts/search/{gate}'), 2)
            self.assertNotIn(f'node scripts/{gate}', workflow)

    def test_both_sites_run_grouped_record_path_and_search_build_tests(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/search/check_search_record_path_coverage.mjs'), 2)
        self.assertEqual(workflow.count('node tests/search/build/test_search_record_path_build.mjs'), 2)
        self.assertNotIn('node scripts/check_search_record_path_coverage.mjs', workflow)
        self.assertNotIn('node tests/test_search_record_path_build.mjs', workflow)

    def test_both_sites_run_dom_search_browser_contracts(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('python3 -B -m unittest -v tests.gates.test_reader_dom_search_gate'), 2)
        self.assertEqual(workflow.count('python3 -B scripts/reader/check_reader_dom_search_contracts.py'), 2)
        self.assertEqual(workflow.count('python3 -B -m unittest -v tests.reader.browser.test_reader_refactor'), 2)

    def test_both_sites_run_all_djvu_scripts_and_named_contract_gate(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        for name in ('only', 'png', 'range', 'range_fallback', 'scheduler', 'source_integrity', 'worker'):
            self.assertEqual(workflow.count(f'node tests/reader/djvu/test_reader_djvu_{name}.mjs'), 2, name)
        self.assertEqual(workflow.count('node scripts/reader/check_reader_djvu_contracts.mjs'), 2)

    def test_both_sites_run_reader_navigation_baseline_contracts(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/search/check_reader_navigation_baseline.mjs'), 2)
        self.assertNotIn('node scripts/check_reader_navigation_baseline.mjs', workflow)

    def test_both_sites_test_shared_tap_contract_validator(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node --test tests/gates/test_tap_contracts.mjs'), 2)

    def test_both_sites_run_download_controller_coverage(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/reader-refactor.yml').read_text()
        self.assertEqual(workflow.count('node scripts/search/check_download_controller_coverage.mjs'), 2)
        self.assertNotIn('node scripts/check_download_controller_coverage.mjs', workflow)


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

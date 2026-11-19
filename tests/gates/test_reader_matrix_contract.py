"""Regression and adversarial tests for the real Reader matrix gate."""
import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.ci import reader_matrix_contract as gate


class PlaywrightDependencyRetryTests(unittest.TestCase):
    def test_bounded_attempts_and_status(self):
        for statuses, wanted in (((0, 99), 0), ((100, 0), 0), ((100, 42), 42)):
            with self.subTest(statuses=statuses), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp)
                stubs = {
                    'sudo': '''#!/bin/bash
case "$*" in
  "tee /etc/apt/apt.conf.d/zzzz-reader-ci-acquire") tee "$FIXTURE/apt.conf" ;;
  "rm -f -- /etc/apt/apt.conf.d/zzzz-reader-ci-acquire") mv "$FIXTURE/apt.conf" "$FIXTURE/cleaned.conf" ;;
  *) exit 99 ;;
esac
''',
                    'python': '''#!/bin/bash
[[ -s "$FIXTURE/apt.conf" ]] || exit 99
printf '%s\\n' "$*" >> "$FIXTURE/calls"
if [[ $(wc -l < "$FIXTURE/calls") == 1 ]]; then exit "$FIRST"; fi
exit "$SECOND"
''',
                    'timeout': '#!/bin/bash\nexit 99\n',
                    'sleep': '#!/bin/bash\n[[ "$*" == 5 ]]\n',
                }
                for name, source in stubs.items():
                    command = path / name
                    command.write_text(source)
                    command.chmod(0o755)
                env = {**os.environ, 'PATH': f'{path}:{os.defpath}', 'FIXTURE': str(path),
                       'FIRST': str(statuses[0]), 'SECOND': str(statuses[1])}
                command = gate.ROOT / 'scripts/ci/install_playwright_system_deps.sh'
                result = subprocess.run(['bash', str(command), 'chromium', 'firefox'],
                                        env=env, capture_output=True, text=True, timeout=10, check=False)
                count = 2 if statuses[0] else 1
                self.assertEqual(result.returncode, wanted, result.stderr)
                self.assertEqual((path / 'calls').read_text().splitlines(), [
                    '-m playwright install-deps chromium firefox',
                ] * count)
                self.assertFalse((path / 'apt.conf').exists())
                self.assertEqual((path / 'cleaned.conf').read_text(),
                                 'Acquire::http::Timeout "10";\n'
                                 'Acquire::https::Timeout "10";\n'
                                 'Acquire::Retries "1";\n')
                self.assertEqual(result.stdout.count('retrying once'), count - 1)


class ReaderMatrixContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = gate.WORKFLOW.read_text(encoding='utf-8')
        cls.contract = json.loads(gate.CONTRACT.read_text(encoding='utf-8'))

    def setUp(self):
        self.workflow = gate.parse(self.text)

    def check(self):
        gate.validate(self.workflow, self.contract)

    def test_real_workflow(self):
        self.check()
        self.assertIn('on', self.workflow)
        self.assertNotIn(True, self.workflow)
        self.assertEqual(len(self.contract['matrix_jobs']['github-search']['steps']), 47)

    def test_playwright_setup_cannot_drop_browsers_or_mask_failure(self):
        for job in (*gate.JOBS, 'firefox-staged-pdf'):
            for mask_failure in (False, True):
                with self.subTest(job=job, mask_failure=mask_failure):
                    self.workflow = gate.parse(self.text)
                    step = next(s for s in self.workflow['jobs'][job]['steps']
                                if s.get('name') == 'Install Playwright system dependencies')
                    step['run'] = step['run'] + ' || true' if mask_failure else step['run'].rsplit(' ', 1)[0]
                    with self.assertRaisesRegex(gate.ContractError, 'setup changed|job changed'):
                        self.check()

    def test_against_git_baseline_when_available(self):
        import hashlib
        root = str(gate.ROOT)
        proc = subprocess.run(['git', '-c', f'safe.directory={root}', '-C', root, 'show', f'{gate.ORIGINAL_COMMIT}:.github/workflows/reader-refactor.yml'], capture_output=True, check=False)
        if proc.returncode:
            self.skipTest('historical git object not available (frozen baseline still enforced)')
        self.assertEqual(hashlib.sha256(proc.stdout).hexdigest(), gate.ORIGINAL_SHA256)
        self.assertEqual(proc.stdout, gate.ORIGINAL.read_bytes())
        self.assertEqual(self.contract['baseline_workflow_sha256'], gate.ORIGINAL_SHA256)
        original = gate.parse(proc.stdout.decode('utf-8'))
        for job in gate.JOBS:
            indexed = {s.get('name'): s for s in original['jobs'][job]['steps'] if s.get('name')}
            for record in self.contract['matrix_jobs'][job]['steps']:
                if 'fields' in record:
                    name = record['fields']['name']
                    self.assertEqual(gate.business_record(indexed[name], record['shard']), record)

    def test_forged_policy_and_workflow_rejected(self):
        contract = copy.deepcopy(self.contract)
        job = 'github-search'
        record = next(r for r in contract['matrix_jobs'][job]['steps'] if 'fields' in r)
        name = record['fields']['name']
        step = next(s for s in self.workflow['jobs'][job]['steps'] if s.get('name') == name)
        step['run'] = 'true'
        record['run_sha256'] = __import__('hashlib').sha256(b'true').hexdigest()
        with self.assertRaisesRegex(gate.ContractError, 'policy fingerprint'):
            gate.validate(self.workflow, contract)
        # Even with a temporarily trusted policy hash, historical derivation fails.
        from unittest.mock import patch
        with patch.object(gate, 'POLICY_SHA256', gate.digest(contract)):
            with self.assertRaisesRegex(gate.ContractError, 'historical step mismatch'):
                gate.validate(self.workflow, contract)

    def test_original_fingerprint_is_independent(self):
        forged = gate.ORIGINAL.read_bytes().replace(b'Reader Refactor Tests', b'Forged workflow')
        with self.assertRaisesRegex(gate.ContractError, 'historical workflow fingerprint'):
            gate.validate(self.workflow, self.contract, forged)
        contract = copy.deepcopy(self.contract)
        contract['baseline_workflow_sha256'] = __import__('hashlib').sha256(forged).hexdigest()
        with self.assertRaisesRegex(gate.ContractError, 'policy fingerprint'):
            gate.validate(self.workflow, contract, forged)

    def test_business_mutations(self):
        actions = [
            lambda s: s.update(run='# ' + s['run']),
            lambda s: s.update(name='renamed'),
            lambda s: s.update(env={'EVIL': 'true'}),
            lambda s: s.update({'working-directory': '.'}),
            lambda s: s.update({'timeout-minutes': 999}),
            lambda s: s.update({'continue-on-error': True}),
            lambda s: s.update({'if': 'false'}),
            lambda s: s.update({'if': "matrix.shard == 'search'"}),
            lambda s: s.update({'if': "matrix.shard == 'static' && false"}),
            lambda s: s.update(shell='true'),
        ]
        for action in actions:
            with self.subTest(action=action):
                self.setUp()
                action(self.workflow['jobs']['github-search']['steps'][18])
                with self.assertRaises(gate.ContractError):
                    self.check()

    def test_argv_recipe_ignores_layout_but_rejects_changed_execution(self):
        name = 'Run additional Hugging Face search and Reader regressions'
        def step():
            return next(s for s in self.workflow['jobs']['huggingface-search']['steps'] if s.get('name') == name)
        original = step()['run']
        commands = gate.simple_commands(original)
        step()['run'] = '\n'.join('  '.join(command) for command in commands) + '\n'
        self.check()
        for command in (
            original.replace('READER_STORE_TEST_BROWSER=firefox ', ''),
            original.replace('scripts/ci/run_unittest_suite.py', 'scripts/ci/other.py', 1),
            original.replace(' --require ', ' ', 1),
            original + 'true\n',
            original + 'true || :\n',
            original.replace('python3 -B', 'python3\\\n-B', 1),
            '# disabled\n' + original,
        ):
            with self.subTest(command=command[:80]):
                step()['run'] = command
                with self.assertRaises(gate.ContractError):
                    self.check()

    def test_backend_selection_can_grow_without_changing_coverage_policy(self):
        step = next(s for s in self.workflow['jobs']['huggingface-search']['steps']
                    if s.get('name') == 'Check backend coverage and quality inventory')
        original = step['run']
        item = 'tests.backend.test_api_contract'
        step['run'] = original.replace(item, item + '\n    tests.backend.test_added', 1)
        self.check()
        for replacement in ('', item + ' ' + item, '$(printf %s ' + item + ')', item + '\u00a0tests.backend.test_added'):
            with self.subTest(replacement=replacement):
                step['run'] = original.replace(item, replacement, 1)
                with self.assertRaises(gate.ContractError):
                    self.check()
        step['run'] = original.replace('-m coverage run --branch', '-m coverage run')
        with self.assertRaises(gate.ContractError):
            self.check()

    def test_structural_bypasses(self):
        def steps(w):
            return w['jobs']['github-search']['steps']
        actions = [
            lambda w: steps(w).pop(17),
            lambda w: steps(w).append(copy.deepcopy(steps(w)[17])),
            lambda w: steps(w).reverse(),
            lambda w: steps(w)[0].update({'if': 'false'}),
            lambda w: w['jobs']['github-search']['strategy'].update({'fail-fast': True}),
            lambda w: w['jobs']['github-search']['strategy']['matrix'].update(include=[{'shard': 'static'}]),
            lambda w: w['jobs']['github-search'].update({'if': 'false'}),
            lambda w: w['jobs']['github-search'].update({'continue-on-error': True}),
            lambda w: w['jobs'].pop('summary'),
            lambda w: w['jobs']['summary'].update(needs=['github-search']),
            lambda w: w['jobs']['summary'].update({'if': 'success()'}),
            lambda w: w['jobs']['summary']['steps'][0].update(run='true'),
            lambda w: w['jobs']['summary']['steps'][0].update({'if': 'false'}),
            lambda w: w['jobs']['firefox-staged-pdf'].update({'if': 'false'}),
            lambda w: w['jobs']['hf-capture'].update({'continue-on-error': True}),
        ]
        for action in actions:
            with self.subTest(action=action):
                self.setUp()
                action(self.workflow)
                with self.assertRaises(gate.ContractError):
                    self.check()

    def test_manifest_must_match_conditions_even_if_summary_is_reapproved(self):
        from unittest.mock import patch
        summary = self.workflow['jobs']['summary']
        summary['steps'][0]['run'] = summary['steps'][0]['run'].replace("'Test offline Pages search benchmark', ", '', 1)
        contract = copy.deepcopy(self.contract)
        contract['fixed_jobs']['summary'] = copy.deepcopy(summary)
        with patch.object(gate, 'POLICY_SHA256', gate.digest(contract)):
            with self.assertRaisesRegex(gate.ContractError, 'manifest differs'):
                gate.validate(self.workflow, contract)

    def test_scoped_setup_and_retained_browser_suites_are_required(self):
        for job in gate.JOBS:
            for name, condition in (
                ('Cache Playwright browsers', "${{ matrix.shard != 'static' }}"),
                ('Install Playwright system dependencies', "${{ matrix.shard != 'static' }}"),
                ('Install Playwright browsers', "${{ matrix.shard != 'static' }}"),
                ('Install qpdf', "${{ matrix.shard == 'loading' }}") if job == 'github-search' else
                ('Install isolated coverage dependencies', "${{ matrix.shard == 'static' }}"),
            ):
                with self.subTest(job=job, setup=name):
                    workflow = copy.deepcopy(self.workflow)
                    step = next(s for s in workflow['jobs'][job]['steps'] if s.get('name') == name)
                    self.assertEqual(step['if'], condition)
                    step['if'] = '${{ false }}'
                    with self.assertRaisesRegex(gate.ContractError, 'setup changed'):
                        gate.validate(workflow, self.contract)
            with self.subTest(job=job, suite='navigation'):
                workflow = copy.deepcopy(self.workflow)
                steps = workflow['jobs'][job]['steps']
                self.assertNotIn('Run chapter-search browser gate', [s.get('name') for s in steps])
                step = next(s for s in steps if s.get('name') == 'Run full Reader refactor suite')
                step['run'] = step['run'].replace(' tests.reader.browser.test_reader_refactor', ' --require tests.reader.browser.test_reader_refactor.Missing.test_case tests.reader.browser.test_reader_refactor')
                with self.assertRaisesRegex(gate.ContractError, 'business step changed'):
                    gate.validate(workflow, self.contract)
        omitted = {
            'Run multi-format preparation and navigation gates': ' tests.performance.test_reader_toc_latency',
            'Check warmed Reader shell reuse': 'tests.service_worker.test_service_worker_integration.'
                                               'ServiceWorkerIntegrationTest.test_warmed_reader_offline_loads_legacy_validation_dependency',
        }
        for name, argument in omitted.items():
            with self.subTest(step=name):
                workflow = copy.deepcopy(self.workflow)
                step = next(s for s in workflow['jobs']['github-search']['steps'] if s.get('name') == name)
                self.assertEqual(step['run'].count(argument), 1)
                step['run'] = step['run'].replace(argument, '')
                with self.assertRaisesRegex(gate.ContractError, 'business step changed'):
                    gate.validate(workflow, self.contract)

    def test_summary_executes_skip_policy(self):
        import os
        import subprocess
        import tempfile
        run = self.workflow['jobs']['summary']['steps'][0]['run']
        program = run[len("python3 - <<'PY'\n"):-len('\nPY\n')]
        manifest = gate.summary_manifest(self.workflow['jobs']['summary'])
        standalone = {'firefox-staged-pdf': 'Check staged PDF opening in Firefox',
                      'hf-capture': 'Capture approved Hugging Face main'}
        matrix_job = 'github-search (static)'
        for defect in ('none', 'matrix skipped', 'firefox skipped', 'capture missing', 'firefox duplicate'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as tmp:
                jobs = []
                for job, shards in manifest.items():
                    all_names = [n for names in shards.values() for n in names]
                    for shard, names in shards.items():
                        steps = [{'name': 'Mark setup complete', 'conclusion': 'success'}]
                        steps += [{'name': n, 'conclusion': 'success' if n in names else 'skipped'} for n in all_names]
                        name = f'{job} ({shard})'
                        if defect == 'matrix skipped' and name == matrix_job:
                            steps[1]['conclusion'] = 'skipped'
                        jobs.append({'name': name, 'conclusion': 'success', 'steps': steps})
                for name, required in standalone.items():
                    steps = [{'name': 'Set up job', 'conclusion': 'success'}]
                    if not (defect == 'capture missing' and name == 'hf-capture'):
                        conclusion = 'skipped' if defect == 'firefox skipped' and name == 'firefox-staged-pdf' else 'success'
                        steps.append({'name': required, 'conclusion': conclusion})
                    jobs.append({'name': name, 'conclusion': 'success', 'steps': steps})
                    if defect == 'firefox duplicate' and name == 'firefox-staged-pdf':
                        jobs.append(jobs[-1].copy())
                # Execute the actual frozen script with only its HTTP transport mocked.
                bootstrap = '''import io, json, urllib.request\nclass Response(io.BytesIO):\n    pass\ndef urlopen(request, timeout):\n    return Response(json.dumps({'jobs': JOBS}).encode())\nurllib.request.urlopen = urlopen\n'''
                env = dict(os.environ, GITHUB_RESULT='success', FIREFOX_RESULT='success', CAPTURE_RESULT='success', HF_RESULT='success', GH_TOKEN='dummy', API_URL='https://invalid', REPOSITORY='x/y', RUN_ID='1', RUN_ATTEMPT='1', REPORT_PATH=tmp+'/report', GITHUB_STEP_SUMMARY=tmp+'/summary')
                script = 'JOBS = ' + repr(jobs) + '\n' + bootstrap + program
                result = subprocess.run([__import__('sys').executable, '-c', script], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, int(defect != 'none'), result.stderr)
                report = Path(tmp, 'report').read_text()
                self.assertIn('skipped', report)
                expected = {'matrix skipped': 'REQUIRED Check source and exercise static gates: skipped',
                            'firefox skipped': f"REQUIRED {standalone['firefox-staged-pdf']}: skipped",
                            'capture missing': f"REQUIRED {standalone['hf-capture']}: missing or duplicate (0)",
                            'firefox duplicate': '| firefox-staged-pdf | 1 | missing or duplicate (2) |'}
                if defect in expected:
                    self.assertIn(expected[defect], report)
                else:
                    for name in standalone:
                        self.assertIn(f'| {name} | 1 | success |', report)

    def test_yaml_attacks_and_comments(self):
        cases = [
            self.text.replace('    strategy:\n', '    strategy:\n      fail-fast: false\n', 1),
            self.text.replace('  github-search:\n', '  github-search: &job\n', 1),
            self.text + '\nother: *job\n',
            self.text.replace('    strategy:\n', '    <<: {}\n    strategy:\n', 1),
            self.text.replace('name: Reader Refactor Tests', 'name: !evil Reader Refactor Tests', 1),
        ]
        for text in cases:
            with self.subTest(text=text[:120]):
                with self.assertRaises(gate.ContractError):
                    gate.parse(text)
        # Commenting out a complete real step cannot be mistaken for executable YAML.
        text = self.text.replace('      - name: Test offline Pages search benchmark\n        if: ${{ !cancelled() && steps.setup-complete.outputs.ready == \'true\' && matrix.shard == \'search\' }}\n        run: node --test tests/performance/test_benchmark_local_search.mjs', '      # removed test')
        self.assertNotEqual(text, self.text)
        with self.assertRaises(gate.ContractError):
            gate.validate(gate.parse(text), self.contract)


if __name__ == '__main__':
    unittest.main()

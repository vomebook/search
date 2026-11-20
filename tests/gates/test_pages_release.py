from copy import deepcopy
from hashlib import sha256
import json
import unittest

from scripts.ci.pages_release import (
    READER_INPUTS, READER_RECEIPT, RECEIPT, SEARCH_MANIFEST,
    check_search_promotion, intent, observe_live, release_receipt, wait_for_public,
)

CODE = 'a' * 40
WORKFLOW = 'b' * 40
SEARCH = 'c' * 64
GENERATION = 'd' * 64
CATALOG = 'e' * 64
REFRESH = 'f' * 32
REPO = 'vomebook/search'
FULL_PREP = ('Run production Pages source gates', 'Check content-addressed PDF opening',
             'Require exact Reader matrix and current source before deployment')
UPLOAD = ('Verify tested artifact fingerprint', 'Upload artifact', 'Verify uploaded candidate fingerprint')
DEPLOY = ('Wait for the uploaded Pages artifact', 'Check final promotion', 'Deploy to GitHub Pages',
          'Read back the public Pages release')
LEGACY_DEPLOY = ('Check content-addressed PDF opening', 'Verify tested artifact fingerprint', 'Upload artifact',
                 'Wait for the uploaded Pages artifact', 'Require exact Reader matrix and current source before deployment',
                 'Deploy to GitHub Pages')


def env(*, reader=False, event='push', attempt=1, rid=10):
    sha = WORKFLOW if reader else CODE
    values = dict(GITHUB_SHA=sha, GITHUB_WORKFLOW_SHA=sha, GITHUB_REPOSITORY=REPO, GITHUB_REF='refs/heads/main',
                  GITHUB_WORKFLOW_REF=f'{REPO}/.github/workflows/static.yml@refs/heads/main',
                  GITHUB_EVENT_NAME='workflow_dispatch' if reader else event,
                  GITHUB_RUN_ATTEMPT=str(attempt), GITHUB_RUN_ID=str(rid))
    if reader:
        values.update(zip(READER_INPUTS, (REFRESH, CODE, WORKFLOW, GENERATION, CATALOG)))
        values['SEARCH_INPUT_GENERATION'] = SEARCH
    return values


def passed(**fields):
    return dict(status='completed', conclusion='success', **fields)


def manifest(generation=SEARCH):
    return dict(version=1, kind='search-snapshot-local', generation=generation)


def pointer(desired=SEARCH):
    return dict(version=1, kind='search-publication-pointer', desired=desired, previous='1' * 64,
                transition='2' * 32)


class Fixture:
    def __init__(self):
        self.data = {SEARCH_MANIFEST: manifest()}
        self.responses = {}
        self.calls = []
        self.deployments = []
        self.responses['/deployments'] = self.deployments, False

    def require_run(self, rid, *, sha=CODE, attempt=1, event='push', legacy=False, refresh=False):
        run = self.responses[f'/actions/runs/{rid}/attempts/{attempt}'] = (passed(
            id=rid, run_attempt=attempt, head_sha=sha, head_branch='main', event=event,
            path='.github/workflows/static.yml', repository={'full_name': REPO}, head_repository={'full_name': REPO},
            display_title=f'reader-refresh/{REFRESH}' if refresh else 'Deploy static content to Pages'), False)
        self.responses[f'/actions/runs/{rid}'] = run
        groups = {'source-checks': FULL_PREP[:1], 'deploy': LEGACY_DEPLOY} if legacy else {
            'prepare': (('Prove active code and Search for Reader refresh',) if refresh else FULL_PREP) + UPLOAD,
            'deploy': DEPLOY,
        }
        jobs = {}
        for index, (name, step_names) in enumerate(groups.items(), start=1):
            job = jobs[name] = passed(id=rid * 100 + index, run_id=rid, run_attempt=attempt, name=name, head_sha=sha,
                                      steps=[passed(name=step) for step in step_names])
            self.responses[f'/actions/jobs/{job["id"]}'] = job, False
        self.responses[f'/actions/runs/{rid}/attempts/{attempt}/jobs'] = (dict(jobs=list(jobs.values()), total_count=2), False)
        return jobs

    def deployment(self, did, job, state='success'):
        self.deployments.insert(0, dict(id=did, sha=job['head_sha'], environment='github-pages'))
        log = f'https://github.com/{REPO}/actions/runs/{job["run_id"]}/job/{job["id"]}'
        status = dict(environment='github-pages', state=state, log_url=log)
        self.responses[f'/deployments/{did}/statuses'] = [status], False
        return status

    def api(self, path, params):
        self.calls.append(path)
        return self.responses[path]

    def public(self, path, missing=False):
        return self.data.get(path) if missing else self.data[path]

    def prove(self, sha=CODE, search=SEARCH):
        return observe_live(self.api, self.public, sha, search)


class PagesReleaseTests(unittest.TestCase):
    def test_reader_intent_requires_all_fields_and_exact_first_attempt_workflow(self):
        good = env(reader=True)
        self.assertEqual(intent(good), (REFRESH, CODE, WORKFLOW, GENERATION, CATALOG))
        for name in (*READER_INPUTS, 'SEARCH_INPUT_GENERATION'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                intent({**good, name: ''})
        for bad in (dict(GITHUB_SHA=CODE, GITHUB_WORKFLOW_SHA=CODE), dict(GITHUB_WORKFLOW_SHA=CODE),
                    dict(SEARCH_TRANSITION=REFRESH), dict(READER_GENERATION='X' * 64), dict(GITHUB_RUN_ATTEMPT='2'),
                    dict(GITHUB_REF='refs/heads/other'), dict(GITHUB_EVENT_NAME='push')):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                intent({**good, **bad})

    def test_full_dispatch_explicit_search_and_transition_are_not_reader_mode(self):
        normal = env(event='workflow_dispatch', attempt=2)
        self.assertIsNone(intent(normal))
        self.assertIsNone(intent({**normal, 'SEARCH_INPUT_GENERATION': SEARCH}))
        self.assertIsNone(intent({**normal, 'SEARCH_INPUT_GENERATION': SEARCH, 'SEARCH_TRANSITION': REFRESH}))
        with self.assertRaises(ValueError):
            intent({**normal, 'SEARCH_TRANSITION': REFRESH})
        with self.assertRaises(ValueError):
            intent({**normal, 'SEARCH_INPUT_GENERATION': 'Z' * 64})

    def test_unpinned_push_and_dispatch_match_current_desired_but_manual_override_is_explicit(self):
        current = pointer()

        def bucket(path):
            self.assertEqual(path, 'published/current.json')
            return json.dumps(current).encode()

        for event in ('push', 'workflow_dispatch'):
            check_search_promotion(bucket, env(event=event), SEARCH)
            with self.assertRaisesRegex(ValueError, 'stale against'):
                check_search_promotion(bucket, env(event=event), '4' * 64)
        override = {**env(event='workflow_dispatch'), 'SEARCH_INPUT_GENERATION': '4' * 64}
        check_search_promotion(None, override, '4' * 64)
        with self.assertRaisesRegex(ValueError, 'explicit dispatch'):
            check_search_promotion(None, override, SEARCH)

    def test_search_apply_and_rollback_require_exact_active_digest_bound_journal_claim(self):
        transition = '3' * 32
        head = dict(version=1, kind='search-transition-head', transition=transition, sequence=31)
        record = dict(version=1, kind='search-transition-record', transition=transition, sequence=31,
                      candidate=SEARCH, parent_pointer=pointer('4' * 64),
                      pending=dict(site='pages', operation_id=REFRESH, operation='apply',
                                   expected_revision=CODE, write_claim='5' * 32))
        values = {**env(event='workflow_dispatch'), 'SEARCH_INPUT_GENERATION': SEARCH, 'SEARCH_TRANSITION': REFRESH}

        def bucket_for(record, *, corrupt=False, newer_head=False):
            raw = json.dumps(record).encode()
            digest = sha256(raw).hexdigest()
            heads = 0

            def bucket(path):
                nonlocal heads
                if path == 'published/transition.json':
                    heads += 1
                    return json.dumps({**head, 'record': digest, 'sequence': 32 if newer_head and heads > 1 else 31}).encode()
                self.assertEqual(path, f'published/transitions/{transition}/{digest}.json')
                return raw + (b' ' if corrupt else b'')

            return bucket

        check_search_promotion(bucket_for(record), values, SEARCH)
        rollback = {**record, 'pending': {**record['pending'], 'operation': 'rollback'}}
        check_search_promotion(bucket_for(rollback), {**values, 'SEARCH_INPUT_GENERATION': '4' * 64}, '4' * 64)
        with self.assertRaisesRegex(ValueError, 'target or active journal changed'):
            check_search_promotion(bucket_for(rollback), values, SEARCH)
        for bad in (None, {**record['pending'], 'site': 'space'}, {**record['pending'], 'write_claim': None},
                    {**record['pending'], 'operation_id': '6' * 32}, {**record['pending'], 'expected_revision': WORKFLOW}):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, 'No matching claimed Pages operation'):
                check_search_promotion(bucket_for({**record, 'pending': bad}), values, SEARCH)
        with self.assertRaisesRegex(ValueError, 'journal digest'):
            check_search_promotion(bucket_for(record, corrupt=True), values, SEARCH)
        with self.assertRaisesRegex(ValueError, 'target or active journal changed'):
            check_search_promotion(bucket_for(record, newer_head=True), values, SEARCH)

    def test_bootstrap_uses_actual_legacy_deployment_not_new_main_or_candidate_ci(self):
        f = Fixture()
        older = f.require_run(9, sha='1' * 40, legacy=True)
        active = f.require_run(10, legacy=True)
        candidate = f.require_run(12, sha=WORKFLOW)
        f.deployment(4, older['deploy'])
        f.deployment(5, active['deploy'])
        f.deployment(6, candidate['deploy'], state='failure')
        self.assertEqual(f.prove(), (10, 1))
        self.assertNotIn('/git/ref/heads/main', f.calls)
        self.assertNotIn('/actions/runs/12/attempts/1', f.calls)
        with self.assertRaises(ValueError):
            f.prove(WORKFLOW)

    def test_legacy_dispatch_needs_separate_exact_first_attempt_push(self):
        f = Fixture()
        active = f.require_run(10, event='workflow_dispatch', legacy=True)
        f.deployment(5, active['deploy'])
        listing = {'total_count': 0, 'workflow_runs': []}
        f.responses['/actions/workflows/static.yml/runs'] = listing, False
        with self.assertRaisesRegex(ValueError, 'no exact successful push'):
            f.prove()
        for attempt in (1, 2):
            f.require_run(9, attempt=attempt, legacy=True)
            listing.update(total_count=1, workflow_runs=[{'id': 9, 'run_attempt': attempt}])
            if attempt == 1:
                self.assertEqual(f.prove(), (9, 1))
            else:
                with self.assertRaisesRegex(ValueError, 'first-attempt'):
                    f.prove()

    def test_active_full_release_binds_same_receipt_and_prepare_readback(self):
        for attempt in (1, 2):
            f = Fixture()
            active = f.require_run(10, attempt=attempt)
            f.deployment(5, active['deploy'])
            f.data[RECEIPT] = release_receipt(env(attempt=attempt), SEARCH, {'active': False}, None)
            if attempt == 2:
                with self.assertRaisesRegex(ValueError, 'first-attempt'):
                    f.prove()
                continue
            self.assertEqual(f.prove(), (10, 1))
            upload = active['prepare']['steps'].pop()
            active['deploy']['steps'].append(upload)
            with self.assertRaisesRegex(ValueError, 'full-code Pages gates'):
                f.prove()

    def test_post_cutover_reader_resolves_exact_original_full_code(self):
        f = Fixture()
        source = f.require_run(10)
        active = f.require_run(11, sha=WORKFLOW, event='workflow_dispatch', refresh=True)
        f.deployment(7, active['deploy'])
        receipt = release_receipt(env(reader=True, rid=11), SEARCH,
                                  dict(active=True, generation=GENERATION, catalog_sha256=CATALOG), (10, 1))
        self.assertEqual(receipt['code_sha'], CODE)
        self.assertEqual(receipt['workflow_sha'], WORKFLOW)
        f.data[RECEIPT] = receipt
        self.assertEqual(f.prove(), (10, 1))
        for bad in (dict(run_id=10), dict(workflow_sha=CODE), dict(event='push'),
                    dict(reader_refresh_id='1' * 32), dict(code_proof_run_attempt=2), dict(code_proof_run_id=11)):
            f.data[RECEIPT] = {**receipt, **bad}
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                f.prove()
        f.data[RECEIPT] = receipt
        f.data[SEARCH_MANIFEST] = manifest('a' * 64)
        with self.assertRaisesRegex(ValueError, 'Live Pages Search'):
            f.prove()
        f.data[SEARCH_MANIFEST] = manifest()
        source['prepare']['steps'][1]['conclusion'] = 'skipped'
        with self.assertRaisesRegex(ValueError, 'full-code Pages gates'):
            f.prove()

    def test_stale_or_ambiguous_deployment_does_not_fall_back(self):
        f = Fixture()
        legacy = f.require_run(10, legacy=True)
        f.deployment(5, legacy['deploy'])
        current = f.require_run(11)
        status = f.deployment(6, current['deploy'])
        f.data[RECEIPT] = release_receipt(env(), SEARCH, {'active': False}, None)
        with self.assertRaisesRegex(ValueError, 'Public receipt differs'):
            f.prove()
        status['log_url'] = f'https://github.com/{REPO}/actions/runs/11/job/{current["prepare"]["id"]}'
        with self.assertRaisesRegex(ValueError, 'deploy job'):
            f.prove()
        status['state'] = 'inactive'
        with self.assertRaisesRegex(ValueError, 'Cannot prove'):
            f.prove()

    def test_only_this_locked_promotion_may_skip_its_pending_deployment(self):
        f = Fixture()
        live = f.require_run(10, legacy=True)
        queued = f.require_run(11, sha=WORKFLOW, event='workflow_dispatch', refresh=True)
        f.deployment(5, live['deploy'])
        f.deployment(6, queued['deploy'], state='in_progress')
        with self.assertRaisesRegex(ValueError, 'Cannot prove'):
            f.prove()
        with self.assertRaisesRegex(ValueError, 'Cannot prove'):
            observe_live(f.api, f.public, CODE, SEARCH, own=(12, 1))
        self.assertEqual(observe_live(f.api, f.public, CODE, SEARCH, own=(11, 1)), (10, 1))

    def test_public_readback_retries_and_requires_all_three_identities(self):
        receipt = release_receipt(env(), SEARCH, {'active': False}, None)
        reader = dict(active=False, sidecar_sha256='1' * 64)
        correct = {RECEIPT: receipt, READER_RECEIPT: reader, SEARCH_MANIFEST: manifest()}
        manifest_sha = sha256(json.dumps(correct[SEARCH_MANIFEST]).encode()).hexdigest()
        for path, wrong in ((RECEIPT, {**receipt, 'run_id': 8}), (READER_RECEIPT, {'active': True}),
                            (SEARCH_MANIFEST, manifest('1' * 64)), (SEARCH_MANIFEST, {**manifest(), 'altered': True})):
            f = Fixture()
            f.data = deepcopy(correct)
            f.data[path] = wrong

            def raw(path):
                return json.dumps(f.public(path)).encode()

            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, 'not visible'):
                wait_for_public(raw, receipt, reader, manifest_sha, sleep=lambda _: None, attempts=2)
            wait_for_public(raw, receipt, reader, manifest_sha, sleep=lambda _: f.data.update(correct), attempts=2)

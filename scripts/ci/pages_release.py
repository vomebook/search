"""Validate Pages intent and bind Reader refreshes to the effective live release."""
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, build_opener
from uuid import uuid4

from .wait_pages_artifact import NoRedirect

REPO = 'vomebook/search'
WORKFLOW = '.github/workflows/static.yml'
API = f'https://api.github.com/repos/{REPO}'
PAGES = 'https://vomebook.github.io/search/'
SEARCH_BUCKET = 'https://huggingface.co/buckets/vomebook/search-data-v1/resolve/'
ENVIRONMENT = 'github-pages'
RECEIPT = 'data/pages_release_receipt.json'
SEARCH_MANIFEST = 'data/generation-manifest.json'
READER_RECEIPT = 'data/reader_v3_receipt.json'
RUN_URL = re.compile(rf'https://github\.com/{REPO}/actions/runs/([1-9][0-9]*)'
                     r'(?:/attempts/([1-9][0-9]*))?(?:/job/([1-9][0-9]*))?(?:\?attempt=([1-9][0-9]*))?')
IDS = ('run_id', 'run_attempt', 'code_proof_run_id', 'code_proof_run_attempt')
READER_INPUTS = ('READER_REFRESH_ID', 'READER_CODE_SHA', 'READER_WORKFLOW_SHA', 'READER_GENERATION', 'READER_CATALOG_SHA256')


def hex_id(value, length):
    return isinstance(value, str) and re.fullmatch(rf'[0-9a-f]{{{length}}}', value) and any(c != '0' for c in value)


def positive(value):
    return type(value) is int and value > 0


def intent(env):
    sha = env.get('GITHUB_SHA')
    event = env.get('GITHUB_EVENT_NAME')
    if (env.get('GITHUB_REPOSITORY') != REPO or env.get('GITHUB_REF') != 'refs/heads/main'
            or env.get('GITHUB_WORKFLOW_REF') != f'{REPO}/{WORKFLOW}@refs/heads/main'
            or not hex_id(sha, 40) or env.get('GITHUB_WORKFLOW_SHA') != sha
            or event not in ('push', 'workflow_dispatch')):
        raise ValueError('Invalid Pages workflow identity')
    reader = tuple(env.get(key, '') for key in READER_INPUTS)
    operation = env.get('SEARCH_TRANSITION', '')
    search = env.get('SEARCH_INPUT_GENERATION', '')
    if search and (event != 'workflow_dispatch' or not hex_id(search, 64)):
        raise ValueError('Invalid explicit Search generation')
    if any(reader):
        if (event != 'workflow_dispatch' or env.get('GITHUB_RUN_ATTEMPT') != '1' or operation or not search
                or not all(hex_id(value, size) for value, size in zip(reader, (32, 40, 40, 64, 64)))
                or reader[2] != sha):
            raise ValueError('Incomplete, mixed or mismatched Reader refresh intent')
        return reader
    if operation and (event != 'workflow_dispatch' or not hex_id(operation, 32) or not search):
        raise ValueError('Search transition requires an exact operation ID and explicit generation')
    return None


def success(row):
    return row.get('status') == 'completed' and row.get('conclusion') == 'success'


def jobs_for(api, rid, attempt):
    body, more = api(f'/actions/runs/{rid}/attempts/{attempt}/jobs', {'per_page': 50})
    jobs = body['jobs']
    if (more or type(body['total_count']) is not int or body['total_count'] != len(jobs)
            or len({job['name'] for job in jobs}) != len(jobs)
            or any(job.get('run_id') != rid or job.get('run_attempt') != attempt or not positive(job.get('id')) for job in jobs)):
        raise ValueError('Incomplete Actions job evidence')
    return {job['name']: job for job in jobs}


def checked_run(api, rid, attempt, sha=None):
    run, _ = api(f'/actions/runs/{rid}/attempts/{attempt}', {})
    if (run.get('id') != rid or run.get('run_attempt') != attempt or not success(run)
            or not hex_id(run.get('head_sha'), 40) or (sha is not None and run['head_sha'] != sha)
            or run.get('head_branch') != 'main' or run.get('event') not in ('push', 'workflow_dispatch')
            or run.get('path') not in (WORKFLOW, WORKFLOW + '@refs/heads/main')
            or any(run[key]['full_name'] != REPO for key in ('repository', 'head_repository'))):
        raise ValueError('Not a successful exact Pages run attempt')
    return run


def steps_passed(job, *names):
    return success(job) and all(len(matches := [s for s in job['steps'] if s['name'] == name]) == 1
                                and success(matches[0]) for name in names)


def shape(jobs):
    if set(jobs) == {'prepare', 'deploy'}:
        return 'current'
    if set(jobs) == {'source-checks', 'deploy'}:
        return 'legacy'
    raise ValueError('Unknown Pages workflow job layout')


def exact_full_proof(run, jobs, *, legacy_push=False):
    if run['run_attempt'] != 1:
        raise ValueError('Reader refresh requires a first-attempt full-code proof')
    deploy = jobs['deploy']
    pdf = 'Check content-addressed PDF opening'
    if shape(jobs) == 'legacy':
        passed = ((not legacy_push or run['event'] == 'push')
                  and steps_passed(jobs['source-checks'], 'Run production Pages source gates')
                  and steps_passed(deploy, pdf, 'Verify tested artifact fingerprint', 'Upload artifact',
                                   'Wait for the uploaded Pages artifact',
                                   'Require exact Reader matrix and current source before deployment', 'Deploy to GitHub Pages'))
    else:
        passed = (not run['display_title'].startswith('reader-refresh/')
                  and steps_passed(jobs['prepare'], 'Run production Pages source gates', pdf,
                                   'Require exact Reader matrix and current source before deployment',
                                   'Verify tested artifact fingerprint', 'Upload artifact', 'Verify uploaded candidate fingerprint')
                  and steps_passed(deploy, 'Wait for the uploaded Pages artifact', 'Check final promotion',
                                   'Deploy to GitHub Pages', 'Read back the public Pages release'))
    if not passed or any(job.get('head_sha') != run['head_sha'] for job in jobs.values()):
        raise ValueError('Missing exact full-code Pages gates')
    return run['id'], run['run_attempt']


def deployment_association(status):
    # Only accept GitHub-generated, repo-local Actions URLs. Never follow URLs
    # provided by a deployment record or send a token to an unpinned host.
    links = [match.groups() for key in ('log_url', 'target_url') if (match := RUN_URL.fullmatch(status.get(key) or ''))]
    runs = {int(rid) for rid, _, _, _ in links}
    attempts = {int(a) for _, path, _, query in links for a in (path, query) if a}
    jobs = {int(job) for _, _, job, _ in links if job}
    if len(runs) != 1 or len(attempts) > 1 or len(jobs) > 1:
        raise ValueError('Missing or ambiguous Pages deployment Actions association')
    return runs.pop(), next(iter(attempts), None), next(iter(jobs), None)


def effective_deployment(api, own=None):
    # Deployment history is newest first. The locked job's own environment
    # record may already exist, but any other in-flight promotion is unsafe.
    for page in range(1, 4):
        deployments, more = api('/deployments', {'environment': ENVIRONMENT, 'per_page': 30, 'page': page})
        for deployment in deployments:
            did = deployment.get('id')
            if (not positive(did) or deployment.get('environment') != ENVIRONMENT
                    or not hex_id(deployment.get('sha'), 40)):
                raise ValueError('Invalid GitHub Pages deployment identity')
            statuses, has_next = api(f'/deployments/{did}/statuses', {'per_page': 30})
            if statuses:
                latest = statuses[0]
                state = latest.get('state')
                if state == 'success':
                    if latest.get('environment') != ENVIRONMENT:
                        raise ValueError('Unexpected Pages deployment status environment')
                    return deployment, latest
                if not has_next and not any(s.get('state') == 'success' for s in statuses):
                    if state in ('error', 'failure'):
                        continue
                    if state in ('in_progress', 'pending', 'queued') and own:
                        rid, attempt, jid = deployment_association(latest)
                        if jid is not None:
                            job, _ = api(f'/actions/jobs/{jid}', {})
                            if (job.get('id') != jid or job.get('run_id') != rid or job.get('name') != 'deploy'
                                    or job.get('head_sha') != deployment['sha']
                                    or (attempt is not None and job.get('run_attempt') != attempt)):
                                raise ValueError('Pending deployment job does not match this promotion')
                            attempt = job.get('run_attempt')
                        if (rid, attempt) == own or (rid, attempt) == (own[0], None) and own[1] == 1:
                            continue
            raise ValueError('Cannot prove which GitHub Pages deployment is live')
        if not more:
            break
    raise ValueError('No effective GitHub Pages deployment found')


def associated_run(api, deployment, status):
    rid, attempt, jid = deployment_association(status)
    if jid is not None:
        job, _ = api(f'/actions/jobs/{jid}', {})
        observed = job.get('run_attempt')
        if (job.get('id') != jid or job.get('run_id') != rid or not positive(observed)
                or (attempt is not None and observed != attempt)):
            raise ValueError('Deployment job does not match its run attempt')
        attempt = observed
    if attempt is None:
        # A plain run URL cannot disambiguate a rerun.
        run, _ = api(f'/actions/runs/{rid}', {})
        if run.get('id') != rid or run.get('run_attempt') != 1:
            raise ValueError('Deployment URL does not identify an exact run attempt')
        attempt = 1
    run = checked_run(api, rid, attempt, deployment['sha'])
    jobs = jobs_for(api, rid, attempt)
    deploy = jobs.get('deploy')
    if (not deploy or (jid is not None and deploy['id'] != jid) or deploy.get('head_sha') != deployment['sha']
            or not steps_passed(deploy, 'Deploy to GitHub Pages')):
        raise ValueError('Deployment is not associated with the exact successful Pages deploy job')
    return run, jobs


def validate_receipt(receipt):
    if (type(receipt.get('version')) is not int or receipt['version'] != 1
            or any(not positive(receipt.get(key)) for key in IDS)
            or receipt.get('event') not in ('push', 'workflow_dispatch')
            or any(not hex_id(receipt.get(key), size) for key, size in
                   (('code_sha', 40), ('workflow_sha', 40), ('search_generation', 64)))):
        raise ValueError('Invalid Pages release receipt')
    ref = receipt['reader_refresh_id']
    reader = receipt['reader_generation'], receipt['reader_catalog_sha256']
    if (reader != (None, None) and not all(hex_id(value, 64) for value in reader)):
        raise ValueError('Invalid Pages receipt Reader data')
    if ref is None:
        if (receipt['code_sha'] != receipt['workflow_sha'] or receipt['code_proof_run_id'] != receipt['run_id']
                or receipt['code_proof_run_attempt'] != receipt['run_attempt']):
            raise ValueError('Full release must carry its own exact code proof')
    elif (not hex_id(ref, 32) or reader == (None, None) or receipt['event'] != 'workflow_dispatch'
          or receipt['run_attempt'] != 1 or receipt['code_proof_run_attempt'] != 1
          or receipt['code_proof_run_id'] == receipt['run_id']):
        raise ValueError('Invalid Reader refresh provenance')


def legacy_proof(api, sha, run, jobs):
    exact_full_proof(run, jobs)
    if run['event'] == 'push':
        return run['id'], run['run_attempt']
    # A legacy manually dispatched deployment must also have exact push proof.
    body, more = api('/actions/workflows/static.yml/runs', {
        'head_sha': sha, 'branch': 'main', 'event': 'push', 'status': 'success', 'per_page': 30})
    if more or body['total_count'] != len(body['workflow_runs']):
        raise ValueError('Incomplete legacy Pages push evidence')
    for candidate in body['workflow_runs']:
        rid, attempt = candidate['id'], candidate['run_attempt']
        if not positive(rid) or not positive(attempt):
            raise ValueError('Invalid legacy Pages push identity')
        push = checked_run(api, rid, attempt, sha)
        return exact_full_proof(push, jobs_for(api, rid, attempt), legacy_push=True)
    raise ValueError('Legacy deployed code has no exact successful push proof')


def validate_search_pointer(pointer):
    if (pointer.get('version') != 1 or pointer.get('kind') != 'search-publication-pointer'
            or not hex_id(pointer.get('desired'), 64)
            or (pointer.get('previous') is not None and not hex_id(pointer['previous'], 64))
            or not hex_id(pointer.get('transition'), 32)):
        raise ValueError('Invalid Search publication pointer')
    return pointer


def check_search_promotion(bucket_raw, env, selected):
    """Gate defaults on published intent; only actual dispatch inputs override it."""
    explicit = env.get('SEARCH_INPUT_GENERATION')
    operation = env.get('SEARCH_TRANSITION')
    if explicit and explicit != selected:
        raise ValueError('Built Search differs from the explicit dispatch generation')
    if explicit and not operation:
        # Existing manual rollback: a privileged exact-generation dispatch,
        # not the implicit repository variable or an in-flight journal claim.
        return
    if not operation:
        pointer = validate_search_pointer(json.loads(bucket_raw('published/current.json')))
        if pointer['desired'] != selected:
            raise ValueError('Built Search is stale against the published desired generation')
        return

    head_path = 'published/transition.json'
    head = json.loads(bucket_raw(head_path))
    transition, digest = head.get('transition'), head.get('record')
    if (head.get('version') != 1 or head.get('kind') != 'search-transition-head'
            or not hex_id(transition, 32) or not hex_id(digest, 64) or not positive(head.get('sequence'))):
        raise ValueError('Invalid Search transition head')
    raw = bucket_raw(f'published/transitions/{transition}/{digest}.json')
    if sha256(raw).hexdigest() != digest:
        raise ValueError('Search transition journal digest differs from its head')
    record = json.loads(raw)
    pending = record.get('pending') or {}
    action = pending.get('operation')
    if (record.get('version') != 1 or record.get('kind') != 'search-transition-record'
            or record.get('transition') != transition or record.get('sequence') != head['sequence']
            or pending.get('site') != 'pages' or pending.get('operation_id') != operation
            or pending.get('expected_revision') != env['GITHUB_SHA'] or not hex_id(pending.get('write_claim'), 32)
            or action not in ('apply', 'rollback')):
        raise ValueError('No matching claimed Pages operation in the Search transition journal')
    target = record.get('candidate') if action == 'apply' else validate_search_pointer(record['parent_pointer'])['desired']
    if not hex_id(target, 64) or target != selected or json.loads(bucket_raw(head_path)) != head:
        raise ValueError('Search transition target or active journal changed')


def check_search_manifest(manifest, search):
    if (manifest.get('version') != 1 or manifest.get('kind') != 'search-snapshot-local'
            or manifest.get('generation') != search):
        raise ValueError('Live Pages Search generation differs from the requested generation')


def observe_live(api, public, sha, search, own=None):
    deployment, status = effective_deployment(api, own)
    run, jobs = associated_run(api, deployment, status)
    if shape(jobs) == 'legacy':
        if run['head_sha'] != sha or public(RECEIPT, missing=True) is not None:
            raise ValueError('Legacy live release does not match requested code')
        proof = legacy_proof(api, sha, run, jobs)
    else:
        receipt = public(RECEIPT)
        validate_receipt(receipt)
        if (receipt['run_id'] != run['id'] or receipt['run_attempt'] != run['run_attempt']
                or receipt['workflow_sha'] != run['head_sha'] or receipt['event'] != run['event']
                or receipt['code_sha'] != sha or receipt['search_generation'] != search):
            raise ValueError('Public receipt differs from the effective deployment or requested code/Search')
        refresh_id = receipt['reader_refresh_id']
        if refresh_id is None:
            proof = exact_full_proof(run, jobs)
        else:
            if (run['display_title'] != f'reader-refresh/{refresh_id}'
                    or not steps_passed(jobs['prepare'], 'Prove active code and Search for Reader refresh',
                                        'Verify tested artifact fingerprint', 'Upload artifact', 'Verify uploaded candidate fingerprint')
                    or not steps_passed(jobs['deploy'], 'Wait for the uploaded Pages artifact', 'Check final promotion',
                                        'Read back the public Pages release')):
                raise ValueError('Incomplete deployed Reader refresh evidence')
            rid, attempt = receipt['code_proof_run_id'], receipt['code_proof_run_attempt']
            full = checked_run(api, rid, attempt, sha)
            proof = exact_full_proof(full, jobs_for(api, rid, attempt), legacy_push=True)
    check_search_manifest(public(SEARCH_MANIFEST), search)
    return proof


def wait_for_public(public_raw, release, reader, manifest_sha256, *, sleep=time.sleep, attempts=12):
    """Allow propagation lag but never report success for a different release."""
    validate_receipt(release)
    for attempt in range(attempts):
        try:
            if json.loads(public_raw(RECEIPT)) != release or json.loads(public_raw(READER_RECEIPT)) != reader:
                raise ValueError('Public Pages receipt not yet current')
            manifest = public_raw(SEARCH_MANIFEST)
            if sha256(manifest).hexdigest() != manifest_sha256:
                raise ValueError('Public Search manifest bytes not yet current')
            check_search_manifest(json.loads(manifest), release['search_generation'])
            return
        except (OSError, ValueError):
            if attempt + 1 < attempts:
                sleep(5)
    raise RuntimeError('Exact Pages release not visible after deployment')


def release_receipt(env, search, active, proof):
    reader = intent(env)
    run = int(env['GITHUB_RUN_ID']), int(env['GITHUB_RUN_ATTEMPT'])
    workflow_sha = env['GITHUB_SHA']
    if type(active.get('active')) is not bool:
        raise ValueError('Missing Reader build receipt')
    generation, catalog = (active['generation'], active['catalog_sha256']) if active['active'] else (None, None)
    if (env.get('SEARCH_INPUT_GENERATION') and search != env['SEARCH_INPUT_GENERATION']
            or reader and ((generation, catalog) != reader[3:] or proof is None)):
        raise ValueError('Built data differs from Pages dispatch intent')
    receipt = dict(version=1, workflow_sha=workflow_sha, code_sha=reader[1] if reader else workflow_sha,
                   run_id=run[0], run_attempt=run[1], event=env['GITHUB_EVENT_NAME'],
                   reader_refresh_id=reader[0] if reader else None, search_generation=search,
                   reader_generation=generation, reader_catalog_sha256=catalog,
                   code_proof_run_id=(proof or run)[0], code_proof_run_attempt=(proof or run)[1])
    validate_receipt(receipt)
    return receipt


def main():
    env = os.environ
    reader = intent(env)
    opener = build_opener(NoRedirect())
    bucket_opener = build_opener()
    headers = {'User-Agent': 'pages-release-proof', 'Cache-Control': 'no-cache', 'Accept': 'application/json'}

    def get(url, *, api=False, missing=False, bucket=False):
        request = Request(url, headers={**headers, **({'Authorization': 'Bearer ' + env['GH_TOKEN'],
                          'Accept': 'application/vnd.github+json'} if api else {})})
        try:
            with (bucket_opener if bucket else opener).open(request, timeout=8) as response:
                if not response.url.startswith('https://'):
                    raise ValueError('Insecure Pages evidence redirect')
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise ValueError('Oversized Pages evidence')
                return raw, 'rel="next"' in response.headers.get('Link', '')
        except HTTPError as error:
            if missing and error.code == 404:
                return None, False
            raise

    def api(path, params):
        raw, more = get(API + path + ('?' + urlencode(params) if params else ''), api=True)
        return json.loads(raw), more

    def public_raw(path, missing=False):
        return get(PAGES + path + '?pages_check=' + uuid4().hex, missing=missing)[0]

    def public(path, missing=False):
        raw = public_raw(path, missing)
        return None if raw is None else json.loads(raw)

    def bucket_raw(path):
        return get(SEARCH_BUCKET + path + '?pages_check=' + uuid4().hex, bucket=True)[0]

    def live(own=None):
        return observe_live(api, public, reader[1], env['SEARCH_INPUT_GENERATION'], own)

    def output(**fields):
        with open(env['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
            for key, value in fields.items():
                print(f'{key}={value}', file=out)

    command, *args = sys.argv[1:]
    if command == 'intent' and not args:
        output(reader=str(bool(reader)).lower(), code_sha=reader[1] if reader else env['GITHUB_SHA'])
    elif command == 'prove' and not args and reader:
        rid, attempt = live()
        output(run_id=rid, run_attempt=attempt)
        print(f'Exact live Pages code proved by full run {rid}, attempt {attempt}')
    elif command == 'record' and len(args) == 1:
        root = Path(args[0])
        proof = (int(env['CODE_PROOF_RUN_ID']), int(env['CODE_PROOF_RUN_ATTEMPT'])) if reader else None
        search = json.loads((root / SEARCH_MANIFEST).read_bytes())['generation']
        active = json.loads((root / READER_RECEIPT).read_bytes())
        receipt = release_receipt(env, search, active, proof)
        (root / RECEIPT).write_text(json.dumps(receipt, sort_keys=True) + '\n', encoding='utf-8')
    elif command == 'export' and len(args) == 1:
        # Read metadata from the very archive just checked against the tested
        # fingerprint. The locked job need not download that archive again.
        with tarfile.open(args[0], 'r:') as archive:
            def read(path):
                entry = archive.getmember('./' + path)
                if not entry.isreg() or entry.size > 16 * 1024:
                    raise ValueError('Invalid receipt entry in verified Pages artifact')
                with archive.extractfile(entry) as stream:
                    return json.dumps(json.load(stream), separators=(',', ':'))

            with archive.extractfile('./' + SEARCH_MANIFEST) as stream:
                manifest_sha = sha256(stream.read()).hexdigest()
            output(release=read(RECEIPT), reader_receipt=read(READER_RECEIPT), search_manifest_sha=manifest_sha)
    elif command == 'promote' and not args:
        candidate = json.loads(env['BUILT_RELEASE'])
        validate_receipt(candidate)
        proof = live((int(env['GITHUB_RUN_ID']), int(env['GITHUB_RUN_ATTEMPT']))) if reader else None
        if candidate != release_receipt(env, candidate['search_generation'], json.loads(env['BUILT_READER_RECEIPT']), proof):
            raise ValueError('Promotion proof differs from the tested candidate')
        if not reader:
            check_search_promotion(bucket_raw, env, candidate['search_generation'])
        print('Pages release receipt and promotion intent verified')
    elif command == 'readback' and not args:
        wait_for_public(public_raw, json.loads(env['BUILT_RELEASE']), json.loads(env['BUILT_READER_RECEIPT']),
                        env['BUILT_SEARCH_MANIFEST_SHA'])
        print('Exact public Pages release, Reader receipt and Search generation are visible')
    else:
        raise ValueError('Expected intent | prove | record SITE | export TAR | promote | readback')


if __name__ == '__main__':
    main()

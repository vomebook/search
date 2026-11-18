"""Reuse full Pages CI only for an exact-code, first-attempt data transition."""
from http.client import HTTPException
import json
import os
import re
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

REPO = 'vomebook/search'
WORKFLOW = '.github/workflows/static.yml'
BASE = f'https://api.github.com/repos/{REPO}'


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def observe(get, env):
    sha = env.get('GITHUB_SHA', '')
    if (env.get('GITHUB_REPOSITORY') != REPO or env.get('GITHUB_REF') != 'refs/heads/main'
            or env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or env.get('GITHUB_RUN_ATTEMPT') != '1'
            or env.get('GITHUB_WORKFLOW_SHA') != sha
            or env.get('GITHUB_WORKFLOW_REF') != f'{REPO}/{WORKFLOW}@refs/heads/main'
            or not re.fullmatch('[0-9a-f]{40}', sha) or sha == '0' * 40
            or not re.fullmatch('[0-9a-f]{64}', env.get('DATA_GENERATION', ''))
            or not re.fullmatch('[0-9a-f]{32}', env.get('DATA_OPERATION', ''))
            or env.get('DATA_GENERATION') == '0' * 64 or env.get('DATA_OPERATION') == '0' * 32):
        return None

    def rows(path, key, **params):
        body, more = get(path, dict(per_page=30, **params))
        values = body[key]
        if (more or not isinstance(values, list) or type(body['total_count']) is not int
                or body['total_count'] != len(values) or len(values) > 30
                or any(not isinstance(row, dict) for row in values)):
            raise ValueError('Incomplete Actions evidence')
        return values

    def success(row):
        return row.get('status') == 'completed' and row.get('conclusion') == 'success'

    def attempt(row):
        return type(row.get('run_attempt')) is int and row['run_attempt'] == 1 and row.get('head_sha') == sha

    def exact_run(row, run_id):
        return (type(row.get('id')) is int and row['id'] == run_id and success(row) and attempt(row)
                and row.get('head_branch') == 'main' and row.get('event') == 'push'
                and row.get('path') in (WORKFLOW, WORKFLOW + '@refs/heads/main')
                and all(row[key]['full_name'] == REPO for key in ('repository', 'head_repository')))

    def has_steps(job, names):
        steps = job['steps']
        return all(len(matches := [step for step in steps if step.get('name') == name]) == 1
                   and success(matches[0]) for name in names)

    runs = rows('/actions/workflows/static.yml/runs', 'workflow_runs', branch='main', event='push', head_sha=sha)
    # At most one preceding full code release is needed. No cache or manually
    # dispatched run can establish trust; a failed latest push falls back.
    if not runs:
        return None
    run = runs[0]
    rid = run.get('id')
    if type(rid) is not int or rid <= 0 or str(rid) == env.get('GITHUB_RUN_ID') or not exact_run(run, rid):
        return None
    jobs = rows(f'/actions/runs/{rid}/attempts/1/jobs', 'jobs')
    if (len(jobs) != 2 or {job.get('name') for job in jobs} != {'source-checks', 'deploy'}
            or not all(success(job) and attempt(job) and job.get('run_id') == rid for job in jobs)):
        return None
    source = next(job for job in jobs if job['name'] == 'source-checks')
    deploy = next(job for job in jobs if job['name'] == 'deploy')
    if (not has_steps(source, ('Run production Pages source gates',))
            or not has_steps(deploy, ('Check content-addressed PDF opening', 'Upload artifact', 'Deploy to GitHub Pages'))):
        return None
    latest, _ = get(f'/actions/runs/{rid}', {})
    if not exact_run(latest, rid):
        return None
    ref, _ = get('/git/ref/heads/main', {})
    if ref.get('ref') != 'refs/heads/main' or ref['object'].get('type') != 'commit' or ref['object'].get('sha') != sha:
        return None
    return rid


def main():
    def get(path, params):
        request = Request(BASE + path + ('?' + urlencode(params) if params else ''), headers={
            'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json',
            'Cache-Control': 'no-cache', 'User-Agent': 'pages-reuse-code-checks',
        })
        with build_opener(NoRedirect()).open(request, timeout=8) as response:
            raw = response.read(512 * 1024 + 1)
            if len(raw) > 512 * 1024:
                raise ValueError('Oversized Actions evidence')
            return json.loads(raw), bool(response.headers.get('Link') and 'rel="next"' in response.headers['Link'])

    try:
        run = observe(get, os.environ)
    except (OSError, HTTPException, ValueError, TypeError, KeyError, AttributeError):
        # Never log exception detail or credentials. An unavailable proof does
        # not waive checks and is not a reason to block normal deployment.
        run = None
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        print('reuse=' + ('true' if run is not None else 'false'), file=output)
    if run is not None:
        print(f'Reusing completed full code checks for this exact commit from push run {run}')
    else:
        print('No reusable full-code proof; running all checks')


if __name__ == '__main__':
    main()

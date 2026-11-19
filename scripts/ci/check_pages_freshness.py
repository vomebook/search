"""Fail closed if the Pages run no longer targets the current main commit."""
import json
import os
import re
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def check(env, fetch):
    sha = env.get('GITHUB_SHA', '')
    if (env.get('GITHUB_REPOSITORY') != 'vomebook/search'
            or env.get('GITHUB_REF') != 'refs/heads/main'
            or not re.fullmatch(r'[0-9a-f]{40}', sha) or sha == '0' * 40):
        raise ValueError('Invalid Pages run identity')
    ref = fetch()
    if (ref.get('ref') != 'refs/heads/main' or ref.get('object', {}).get('type') != 'commit'
            or ref['object'].get('sha') != sha):
        raise ValueError('Pages run is stale; rerun on current main')


def wait_for_matrix(sha, fetch_runs, check_main, *, clock, sleep, timeout=2700):
    """Require a completed exact-SHA launch; unrelated scheduled runs do not count."""
    deadline = clock() + timeout
    while True:
        check_main()
        runs = fetch_runs()
        matching = [run for run in runs if run.get('head_sha') == sha
                    and run.get('head_branch') == 'main' and run.get('event') in ('push', 'workflow_dispatch')]
        if any(run.get('status') == 'completed' and run.get('conclusion') == 'success' for run in matching):
            return
        if matching and all(run.get('status') == 'completed' for run in matching):
            raise ValueError('Reader matrix did not succeed for the exact Pages commit')
        if clock() >= deadline:
            raise TimeoutError('Reader matrix unavailable or incomplete for the exact Pages commit')
        sleep(min(30, max(0, deadline - clock())))


def main():
    base = 'https://api.github.com/repos/vomebook/search/'
    headers = {'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
               'Accept': 'application/vnd.github+json', 'Cache-Control': 'no-cache',
               'User-Agent': 'pages-freshness-check'}

    def fetch(path):
        with urlopen(Request(base + path, headers=headers), timeout=10) as response:
            return json.load(response)

    def check_main():
        check(os.environ, lambda: fetch('git/ref/heads/main'))

    check_main()
    if os.environ.get('REQUIRE_READER_MATRIX') == '1':
        sha = os.environ['GITHUB_SHA']
        query = urlencode({'head_sha': sha, 'branch': 'main', 'per_page': 50})
        wait_for_matrix(sha, lambda: fetch('actions/workflows/reader-refactor.yml/runs?' + query)['workflow_runs'],
                        check_main, clock=time.monotonic, sleep=time.sleep)
        check_main()
        print('Exact-source Reader matrix passed')
    print('Pages source is current main')


if __name__ == '__main__':
    main()

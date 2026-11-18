"""Wait for the just-uploaded Pages artifact to appear in the run inventory."""
import json
import os
import re
import time
from http.client import HTTPException
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def wait(get, name, artifact_id, *, sleep=time.sleep):
    for attempt in range(10):
        try:
            page, has_next = get()
        except HTTPError as error:
            if error.code not in (408, 429, 500, 502, 503, 504):
                raise RuntimeError(f'Artifact inventory unavailable: HTTP {error.code}') from None
            page = None
        except (OSError, HTTPException):
            page = None
        if page is not None:
            rows = page['artifacts']
            if has_next or type(page['total_count']) is not int or page['total_count'] != len(rows):
                raise ValueError('Incomplete Pages artifact inventory')
            matching = [item for item in rows if item['name'] == name]
            if len(matching) > 1:
                raise ValueError('Duplicate Pages artifact name in this attempt')
            if matching:
                artifact = matching[0]
                if artifact.get('expired') is not False or artifact.get('id') != artifact_id:
                    raise ValueError('Pages artifact does not match this upload')
                return
        if attempt < 9:
            sleep(3)
    raise RuntimeError('Uploaded Pages artifact not visible; no deployment requested')


def main():
    env = os.environ
    repo, run, attempt, upload = (env.get(k, '') for k in (
        'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'UPLOADED_ARTIFACT_ID'))
    if repo != 'vomebook/search' or not all(re.fullmatch('[1-9][0-9]{0,19}', x) for x in (run, attempt, upload)):
        raise ValueError('Wrong Pages repository or artifact identity')
    token = env.get('GH_TOKEN')
    if not token:
        raise ValueError('Missing artifact inventory permission')
    opener = build_opener(NoRedirect())
    url = f'https://api.github.com/repos/{repo}/actions/runs/{run}/artifacts?per_page=100'

    def get():
        request = Request(url, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                                       'Cache-Control': 'no-cache', 'User-Agent': 'pages-artifact-visibility'})
        with opener.open(request, timeout=5) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError('Pages artifact inventory is too large')
            return json.loads(raw), 'rel="next"' in response.headers.get('Link', '')

    name = f'github-pages-{run}-{attempt}'
    wait(get, name, int(upload))
    print(f'Pages artifact visible: {name} (id {upload})', flush=True)


if __name__ == '__main__':
    main()

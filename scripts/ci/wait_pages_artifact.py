"""Prove the current Pages upload by its immutable REST artifact ID."""
from hashlib import sha256
from http.client import HTTPException
import json
import os
from pathlib import Path
import re
import sys
from tempfile import TemporaryFile
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zipfile import ZipFile

ARTIFACT_LIMIT = 1024 ** 3
TRANSIENT = {404, 408, 429, 500, 502, 503, 504}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def wait(get, *, sleep=time.sleep):
    for attempt in range(10):
        try:
            return get()
        except HTTPError as error:
            if error.code not in TRANSIENT:
                raise RuntimeError(f'Artifact metadata unavailable: HTTP {error.code}') from None
        except (OSError, HTTPException):
            pass
        sleep(3)
    raise RuntimeError('Uploaded Pages artifact not visible; no deployment requested')


def seal(artifact, run, name, artifact_id):
    actual = artifact['workflow_run']['id'], artifact['name'], artifact['id'], artifact['expired']
    if actual != (run, name, artifact_id, False):
        raise ValueError('Pages artifact does not match this upload')
    size = artifact['size_in_bytes']
    digest = artifact['digest']
    if type(size) is not int or not 0 < size <= ARTIFACT_LIMIT or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
        raise ValueError('Invalid Pages artifact digest or size')
    return size, digest


def blob_url(url):
    p = urlsplit(url)
    if not re.fullmatch(r'https://[a-z0-9.-]+(?::443)?', f'{p.scheme}://{p.netloc}'):
        raise ValueError('Invalid Pages archive redirect')
    return url


def download(opener, request):
    try:
        with opener.open(request, timeout=10):
            raise ValueError('Expected a Pages archive redirect')
    except HTTPError as error:
        with error:
            if error.code != 302:
                raise RuntimeError(f'Artifact archive unavailable: HTTP {error.code}') from None
            # Do not follow HTTP redirects with the Actions token attached.
            location = blob_url(error.headers['Location'])
    try:
        return opener.open(Request(location), timeout=20)
    except (OSError, HTTPException):
        raise RuntimeError('Pages archive storage read failed') from None


def write_tar(source, expected, destination):
    size, digest = expected
    with TemporaryFile(dir=destination.parent) as copy:
        body = sha256()
        for block in iter(lambda: source.read(min(1024 * 1024, size + 1 - copy.tell())), b''):
            copy.write(block)
            body.update(block)
        if (copy.tell(), 'sha256:' + body.hexdigest()) != (size, digest):
            raise ValueError('Pages ZIP size or SHA-256 does not match the upload')
        with ZipFile(copy) as archive:
            [member] = archive.infolist()
            if member.filename != 'artifact.tar' or not 0 < member.file_size <= ARTIFACT_LIMIT:
                raise ValueError('Unexpected Pages archive member')
            with archive.open(member) as tar, destination.open('xb') as out:
                for block in iter(lambda: tar.read(1024 * 1024), b''):
                    out.write(block)


def main():
    env = os.environ
    repo, run, attempt, upload = (env[k] for k in (
        'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'UPLOADED_ARTIFACT_ID'))
    identity = f'{repo}:{run}:{attempt}:{upload}'
    if not re.fullmatch(r'vomebook/search(?::[1-9][0-9]{0,19}){3}', identity):
        raise ValueError('Wrong Pages repository or artifact identity')
    opener = build_opener(NoRedirect())
    url = f'https://api.github.com/repos/{repo}/actions/artifacts/{upload}'
    headers = {'Authorization': 'Bearer ' + env['GH_TOKEN'], 'Accept': 'application/vnd.github+json',
               'Cache-Control': 'no-cache', 'User-Agent': 'pages-exact-artifact'}
    name = f'github-pages-{run}-{attempt}'

    def get():
        with opener.open(Request(url, headers=headers), timeout=5) as response:
            return json.loads(response.read(1024 * 1024))

    expected = seal(wait(get), int(run), name, int(upload))
    if sys.argv[1:]:
        [path] = sys.argv[1:]
        try:
            with download(opener, Request(url + '/zip', headers=headers)) as source:
                write_tar(source, expected, Path(path))
        except (OSError, HTTPException):
            # Some network errors include the signed download location.
            raise RuntimeError('Pages archive readback failed') from None
    print(f'Pages artifact proved: {name} (id {upload})', flush=True)


if __name__ == '__main__':
    main()

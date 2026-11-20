"""Bind the selected generation and complete candidate tree across artifact tests."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

MANIFEST = 'data/generation-manifest.json'


def file_sha(stream):
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(block)
    return digest.digest()


def summarize(files, generation, manifest):
    if not re.fullmatch(r'[0-9a-f]{64}', generation) or generation == '0' * 64:
        raise ValueError('Invalid selected generation')
    if not manifest or json.loads(manifest).get('generation') != generation:
        raise ValueError('Candidate generation differs from selected generation')
    digest = hashlib.sha256()
    for filename, file_hash in sorted(files.items()):
        name = filename.encode('utf-8')
        digest.update(len(name).to_bytes(8, 'big'))
        digest.update(name)
        digest.update(file_hash)
    return {'generation': generation, 'files': len(files), 'sha256': digest.hexdigest()}


def fingerprint(root, generation):
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError('Invalid artifact root')
    files = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('Artifact symlinks are not allowed')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError('Unexpected artifact entry')
        with path.open('rb') as stream:
            files[path.relative_to(root).as_posix()] = file_sha(stream)
    return summarize(files, generation, (root / MANIFEST).read_bytes())


def uploaded_fingerprint(archive, generation):
    """Hash the official Pages artifact's actual files without extracting it."""
    files, seen, manifest = {}, set(), None
    with tarfile.open(archive, 'r:') as tar:
        for member in tar:
            path = member.name.removeprefix('./')
            if path == '.' and member.isdir():
                continue
            name = PurePosixPath(path)
            if (name.is_absolute() or '..' in name.parts or name.as_posix() != path
                    or path in seen or not (member.isdir() or member.isreg())):
                raise ValueError('Unexpected uploaded Pages artifact entry')
            seen.add(path)
            if member.isdir():
                continue
            with tar.extractfile(member) as stream:
                if path == MANIFEST:
                    manifest = stream.read(1024 * 1024 + 1)
                    if len(manifest) > 1024 * 1024:
                        raise ValueError('Oversized uploaded Search manifest')
                    files[path] = hashlib.sha256(manifest).digest()
                else:
                    files[path] = file_sha(stream)
    return summarize(files, generation, manifest)


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ('record', 'verify', 'verify-upload'):
        raise ValueError('Expected record|verify ROOT PROOF or verify-upload TAR PROOF')
    action, root, proof = sys.argv[1:]
    calculate = uploaded_fingerprint if action == 'verify-upload' else fingerprint
    result = calculate(root, os.environ['SELECTED_GENERATION'])
    path = Path(proof)
    if action == 'record':
        path.write_text(json.dumps(result, sort_keys=True) + '\n', encoding='utf-8')
    elif json.loads(path.read_text(encoding='utf-8')) != result:
        raise ValueError('Artifact changed after its tests')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()

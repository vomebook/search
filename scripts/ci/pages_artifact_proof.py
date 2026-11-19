"""Bind the selected generation and complete candidate tree across artifact tests."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys


def fingerprint(root, generation):
    if not re.fullmatch(r'[0-9a-f]{64}', generation) or generation == '0' * 64:
        raise ValueError('Invalid selected generation')
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError('Invalid artifact root')
    manifest = json.loads((root / 'data/generation-manifest.json').read_bytes())
    if manifest.get('generation') != generation:
        raise ValueError('Candidate generation differs from selected generation')
    digest = hashlib.sha256()
    count = 0
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('Artifact symlinks are not allowed')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError('Unexpected artifact entry')
        name = path.relative_to(root).as_posix().encode('utf-8')
        file_hash = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                file_hash.update(block)
        digest.update(len(name).to_bytes(8, 'big'))
        digest.update(name)
        digest.update(file_hash.digest())
        count += 1
    if not count:
        raise ValueError('Empty artifact')
    return {'generation': generation, 'files': count, 'sha256': digest.hexdigest()}


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ('record', 'verify'):
        raise ValueError('Expected record|verify ROOT PROOF')
    action, root, proof = sys.argv[1:]
    result = fingerprint(root, os.environ['SELECTED_GENERATION'])
    path = Path(proof)
    if action == 'record':
        path.write_text(json.dumps(result, sort_keys=True) + '\n', encoding='utf-8')
    elif json.loads(path.read_text(encoding='utf-8')) != result:
        raise ValueError('Artifact changed after its tests')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()

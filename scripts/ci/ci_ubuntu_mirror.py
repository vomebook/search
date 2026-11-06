"""Recognize a narrow GitHub-hosted Ubuntu APT layout without modifying it."""
import os
import re
import stat
import sys
from pathlib import Path

URI = 'mirror+file:/etc/apt/apt-mirrors.txt'
ALLOWED = {'http://azure.archive.ubuntu.com/ubuntu/',
           'https://archive.ubuntu.com/ubuntu/',
           'https://security.ubuntu.com/ubuntu/'}


def validate(os_release, sources, mirror):
    """Reject unknown layouts; arguments are injectable only for isolated tests."""
    os_text = os_release.read_text(encoding='utf-8')
    if not re.search(r'^ID=ubuntu$', os_text, re.M) or not re.search(
            r'^VERSION_ID="?24\.04"?$', os_text, re.M):
        raise ValueError('not Ubuntu 24.04')
    matched = False
    for paragraph in re.split(r'\n\s*\n', sources.read_text(encoding='utf-8').strip()):
        fields = {}
        for line in paragraph.splitlines():
            if line.startswith('#'):
                continue
            if not line or line[0].isspace() or ':' not in line:
                raise ValueError('unsupported sources layout')
            key, value = line.split(':', 1)
            key = key.lower()
            if key in fields:
                raise ValueError('duplicate source field')
            fields[key] = value.strip()
        if fields.get('enabled', 'yes').lower() == 'no':
            continue
        if fields.get('uris') != URI or fields.get('types') not in ('deb', 'deb deb-src'):
            raise ValueError('unsupported or mixed source URIs')
        matched = True
    if not matched:
        raise ValueError('no enabled mirror+file source')
    info = mirror.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
        raise ValueError('mirror list is not a root-owned regular file')
    seen = set()
    for line in mirror.read_text(encoding='ascii').splitlines():
        match = re.fullmatch(r'(\S+)[ \t]+priority:([0-9]+)', line)
        if not match or match.group(1) not in ALLOWED:
            raise ValueError('unsupported mirror list')
        seen.add(match.group(1))
    if not seen.intersection(ALLOWED - {'http://azure.archive.ubuntu.com/ubuntu/'}):
        raise ValueError('missing trusted HTTPS fallback')


def main():
    if len(sys.argv) != 1 or os.geteuid() == 0:
        raise ValueError('expected no arguments, run as non-root')
    validate(Path('/etc/os-release'), Path('/etc/apt/sources.list.d/ubuntu.sources'),
             Path('/etc/apt/apt-mirrors.txt'))


if __name__ == '__main__':
    try:
        main()
    except (OSError, UnicodeError, ValueError):
        sys.exit(1)

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import stat

from scripts.ci.ci_ubuntu_mirror import main, validate


class MirrorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.os = root / 'os-release'
        self.sources = root / 'ubuntu.sources'
        self.mirror = root / 'apt-mirrors.txt'
        self.os.write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
        self.sources.write_text('Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSigned-By: /key\n')
        self.mirror.write_text('http://azure.archive.ubuntu.com/ubuntu/ priority:1\n'
                               'https://archive.ubuntu.com/ubuntu/ priority:2\n'
                               'https://security.ubuntu.com/ubuntu/ priority:3\n')

    def check(self, uid=0, mode=stat.S_IFREG):
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=mode, st_uid=uid)):
            return validate(self.os, self.sources, self.mirror)

    def test_success_no_output_or_modification(self):
        before = [p.read_bytes() for p in (self.os, self.sources, self.mirror)]
        self.assertIsNone(self.check())
        self.assertEqual(before, [p.read_bytes() for p in (self.os, self.sources, self.mirror)])

    def test_main_uses_fixed_paths_and_rejects_arguments_or_root(self):
        with patch('scripts.ci.ci_ubuntu_mirror.os.geteuid', return_value=1000), \
             patch('scripts.ci.ci_ubuntu_mirror.sys.argv', ['script']), \
             patch('scripts.ci.ci_ubuntu_mirror.validate') as check:
            main()
            check.assert_called_once_with(Path('/etc/os-release'),
                                          Path('/etc/apt/sources.list.d/ubuntu.sources'),
                                          Path('/etc/apt/apt-mirrors.txt'))
        with patch('scripts.ci.ci_ubuntu_mirror.sys.argv', ['script', '/tmp/output']):
            with self.assertRaises(ValueError):
                main()
        with patch('scripts.ci.ci_ubuntu_mirror.sys.argv', ['script']), \
             patch('scripts.ci.ci_ubuntu_mirror.os.geteuid', return_value=0):
            with self.assertRaises(ValueError):
                main()

    def test_workflow_install_contract(self):
        root = Path(__file__).resolve().parents[1]
        blocks = []
        for name, count in (('reader-refactor.yml', 3), ('static.yml', 1)):
            text = (root / '.github/workflows' / name).read_text()
            parts = text.split('      - name: Configure official Ubuntu mirrors\n        run: |\n')
            self.assertEqual(len(parts) - 1, count)
            blocks.extend(part.split('      - name:', 1)[0] for part in parts[1:])
        expected = '''          set -euo pipefail
          if python3 -B scripts/ci/ci_ubuntu_mirror.py; then
            tmp=$(sudo mktemp -d /etc/apt/.ci-mirrors.XXXXXX)
            trap 'sudo rm -rf -- "$tmp"' EXIT
            sudo install -o root -g root -m 0644 /dev/null "$tmp/mirrors"
            printf '%s\\n' 'https://archive.ubuntu.com/ubuntu/ priority:1' 'https://security.ubuntu.com/ubuntu/ priority:2' | sudo tee "$tmp/mirrors" >/dev/null
            sudo mv -f -- "$tmp/mirrors" /etc/apt/apt-mirrors.txt
          else
            echo "::warning::Unrecognized runner mirror configuration; keeping default mirrors"
          fi
'''
        for block in blocks:
            self.assertEqual(block, expected)

    def test_reject_sources(self):
        for content in ('Types: deb\nURIs: https://archive.ubuntu.com/ubuntu/\n',
                        'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt https://evil/\n',
                        'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nEnabled: no\n'):
            self.sources.write_text(content)
            original = self.mirror.read_bytes()
            with self.assertRaises(ValueError):
                self.check()
            self.assertEqual(original, self.mirror.read_bytes())

    def test_reject_os_and_mirror(self):
        self.os.write_text('ID=debian\nVERSION_ID="24.04"\n')
        with self.assertRaises(ValueError):
            self.check()
        self.os.write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
        for content in ('http://azure.archive.ubuntu.com/ubuntu/ priority:1\n',
                        'https://evil.example/ubuntu/ priority:1\n',
                        'https://archive.ubuntu.com/ubuntu/ priority:1\nhttp://evil/ priority:2\n'):
            self.mirror.write_text(content)
            with self.assertRaises(ValueError):
                self.check()
            self.assertEqual(self.mirror.read_text(), content)
        for uid, mode in ((1, stat.S_IFREG), (0, stat.S_IFLNK)):
            with self.assertRaises(ValueError):
                self.check(uid, mode)

    def test_real_symlink_rejected(self):
        self.mirror.unlink()
        self.mirror.symlink_to(self.sources)
        with self.assertRaises(ValueError):
            validate(self.os, self.sources, self.mirror)


if __name__ == '__main__':
    unittest.main()

import contextlib
import io
import runpy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import stat

from scripts.ci.ci_ubuntu_mirror import main, validate

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/ci/ci_ubuntu_mirror.py'


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
        root = Path(__file__).resolve().parents[2]
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

    def cli(self, *, uid=1000, args=(), metadata_uid=0, read_error=None):
        paths = iter((self.os, self.sources, self.mirror))
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch('pathlib.Path', side_effect=lambda *unused: next(paths)), \
             patch('os.geteuid', return_value=uid), \
             patch('sys.argv', ['script', *args]), \
             patch.object(type(self.mirror), 'lstat', return_value=SimpleNamespace(
                 st_mode=stat.S_IFREG, st_uid=metadata_uid)), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            if read_error is None:
                try:
                    runpy.run_path(str(SCRIPT), run_name='__main__')
                    code = 0
                except SystemExit as error:
                    code = error.code
            else:
                with patch.object(type(self.os), 'read_text', side_effect=read_error):
                    with self.assertRaises(SystemExit) as error:
                        runpy.run_path(str(SCRIPT), run_name='__main__')
                    code = error.exception.code
        return code, stdout.getvalue(), stderr.getvalue()

    def test_cli_fixed_outputs_for_all_rejections(self):
        self.assertEqual(self.cli(), (0, 'recognized\n', ''))
        for kwargs in ({'uid': 0}, {'args': ('secret',)}):
            self.assertEqual(self.cli(**kwargs), (1, '', 'invocation_error\n'))
        cases = (
            (self.os, 'ID=secret\n', 'unsupported_os'),
            (self.sources, ' secret\n', 'sources_layout'),
            (self.sources, 'Types: deb\nTypes: secret\n', 'duplicate_field'),
            (self.sources, 'Types: deb\nURIs: secret\n', 'source_uris'),
            (self.sources, 'Enabled: no\n', 'no_enabled_source'),
            (self.mirror, 'secret priority:1\n', 'mirror_list'),
            (self.mirror, 'http://azure.archive.ubuntu.com/ubuntu/ priority:1\n', 'missing_fallback'),
        )
        for path, content, code in cases:
            with self.subTest(code=code):
                original = path.read_bytes()
                path.write_text(content)
                self.assertEqual(self.cli(), (1, '', code + '\n'))
                path.write_bytes(original)
        self.assertEqual(self.cli(metadata_uid=1), (1, '', 'mirror_metadata\n'))
        for error in (PermissionError('secret'), OSError('secret'),
                      UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'secret')):
            with self.subTest(error=type(error)):
                self.assertEqual(self.cli(read_error=error), (1, '', 'read_error\n'))
        self.assertEqual(self.cli(read_error=ValueError('secret\n::warning::secret')),
                         (1, '', 'internal_error\n'))

    def test_unknown_exceptions_and_failed_output(self):
        class BadString(ValueError):
            def __str__(self):
                raise RuntimeError('secret')

        for error in (ValueError('not Ubuntu 24.04'), BadString(),
                      RuntimeError('secret\n::warning::token')):
            with self.subTest(error=type(error)):
                self.assertEqual(self.cli(read_error=error), (1, '', 'internal_error\n'))
        from scripts.ci import ci_ubuntu_mirror as module
        with patch.object(module, 'main', side_effect=RuntimeError('secret')), \
             patch.object(module.sys, 'stderr') as stream:
            stream.write.side_effect = OSError('secret')
            self.assertEqual(module.cli(), 1)
        with patch.object(module, 'main', side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                module.cli()
        for error in (SystemExit(), SystemExit(0), SystemExit(42)):
            with self.subTest(code=error.code), patch.object(module, 'main', side_effect=error), \
                    contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.assertEqual(module.cli(), 1)
                self.assertEqual(stderr.getvalue(), 'internal_error\n')

    def test_invocation_does_not_read(self):
        for kwargs in ({'uid': 0}, {'args': ('x',)}):
            with patch.object(type(self.os), 'read_text', side_effect=AssertionError('read')) as read:
                self.assertEqual(self.cli(**kwargs), (1, '', 'invocation_error\n'))
                read.assert_not_called()

    def test_real_symlink_rejected(self):
        self.mirror.unlink()
        self.mirror.symlink_to(self.sources)
        with self.assertRaises(ValueError):
            validate(self.os, self.sources, self.mirror)


if __name__ == '__main__':
    unittest.main()

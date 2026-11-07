"""The local test package must not be shadowed by installed distributions."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class LocalTestPackageTests(unittest.TestCase):
    def test_local_tests_package_wins_over_installed_regular_package(self):
        with tempfile.TemporaryDirectory() as directory:
            other = Path(directory) / 'tests'
            other.mkdir()
            (other / '__init__.py').write_text('raise RuntimeError("wrong tests package")\n')
            env = {**os.environ, 'PYTHONPATH': directory, 'PYTHONDONTWRITEBYTECODE': '1'}
            script = (
                'from pathlib import Path; import tests; '
                'from tests.gates import test_static_shards_runner; '
                'print(Path(tests.__file__).resolve()); '
                'print(Path(test_static_shards_runner.__file__).resolve())'
            )
            result = subprocess.run([sys.executable, '-B', '-c', script], cwd=ROOT, env=env,
                                    text=True, capture_output=True, check=False, timeout=15)  # noqa: S603
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [str(ROOT / 'tests/__init__.py'),
                                                       str(ROOT / 'tests/gates/test_static_shards_runner.py')])


if __name__ == '__main__':
    unittest.main()

"""Build the exact candidate C source using the runner interpreter ABI."""
import shlex
import subprocess
import sysconfig
from pathlib import Path

root = Path(__file__).resolve().parent
target = root / ('_search_index_native' + sysconfig.get_config_var('EXT_SUFFIX'))
compiler = shlex.split(sysconfig.get_config_var('CC') or 'cc')
subprocess.run([*compiler, '-O3', '-shared', '-fPIC', '-Wall', '-Wextra', '-Wno-unused-parameter',
                '-I' + sysconfig.get_paths()['include'], str(root / 'search_index_native.c'),
                '-o', str(target)], check=True)
print('compiled', target.name)

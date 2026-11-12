"""Execute the actual workflow shell offline with deterministic Git and HTTP doubles."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/reader-refactor.yml'
OLD_ANCHOR = 'c7424ac3e549c9edf59f302e3809268c12bfe114'
OLD_BASE = '626785f1e3d9e05d2e8f3d9aec3d6ec16dc25f0b'
NEW_ANCHOR = '66d92cb401f52e9dfe78ca6026e682c7097b730b'
NEW_BASE = 'd6c3bea07d0005143f0a411a036b360a584bf315'
FILES = ('backend-coverage-debt.json', 'strict-inventory-debt.json')


def shell(name):
    text = WORKFLOW.read_text().split('  huggingface-search:\n', 1)[1]
    block = text.split('      - name: ' + name + '\n', 1)[1]
    block = block.split('      - name:', 1)[0].split('      - uses:', 1)[0]
    return '\n'.join(line[10:] for line in block.split('        run: |\n', 1)[1].splitlines()) + '\n'


class HistoryShellTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.t = Path(self.temp.name)
        self.work = self.t / 'work'
        self.work.mkdir()
        self.home = self.t / 'home'
        self.home.mkdir()
        self.bin = self.t / 'bin'
        self.bin.mkdir()
        self.runtime = self.t / 'runtime'
        self.runtime.mkdir()
        self.output = self.t / 'output'
        self.output.touch()
        self.log = self.t / 'calls'
        self.log.touch()
        self.env = dict(os.environ, HOME=str(self.home), GIT_CONFIG_NOSYSTEM='1',
                        GIT_TERMINAL_PROMPT='0', PATH=str(self.bin) + ':' + os.environ['PATH'],
                        RUNNER_TEMP=str(self.runtime), GITHUB_OUTPUT=str(self.output),
                        CALL_LOG=str(self.log))
        # Build a real, complete but small commit graph; no network and no source checkout writes.
        self.source = self.t / 'source'
        self.source.mkdir()
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        data = {name: (name + '\nfixture\n').encode() for name in FILES}
        for name, content in data.items():
            (self.source / name).write_bytes(content)
        (self.source / 'wrong.json').write_bytes(b'wrong path but HTTP 200\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'baseline')
        self.baseline = self.git('rev-parse', 'HEAD')
        self.git('commit', '--allow-empty', '-qm', 'anchor')
        self.anchor = self.git('rev-parse', 'HEAD')
        self.git('commit', '--allow-empty', '-qm', 'captured')
        self.revision = self.git('rev-parse', 'HEAD')
        self.env.update(FAKE_REPO=str(self.source), FAKE_REV=self.revision)
        # Substitute fixture pins only in private copies of the actual scripts and lock.
        (self.work / 'scripts').mkdir()
        (self.work / '.github/quality-baselines').mkdir(parents=True)
        lock = json.loads((ROOT / '.github/quality-baselines/hf-source.json').read_text())
        lock['revision'] = self.baseline
        lock['files'] = {name: hashlib.sha256(content).hexdigest() for name, content in data.items()}
        (self.work / '.github/quality-baselines/hf-source.json').write_text(json.dumps(lock))
        self.stub('python3', '#!/bin/bash\nexec ' + sys.executable + ' "$@"\n')
        (self.bin / 'python').symlink_to(sys.executable)
        self.stub('git', '''#!/bin/bash
set -euo pipefail
if [[ "$1" == ls-remote ]]; then printf 'ls-remote\\n' >> "$CALL_LOG"; printf '%s\\trefs/heads/main\\n' "$FAKE_REV"; exit; fi
if [[ "$1" == clone ]]; then printf 'clone\\n' >> "$CALL_LOG"; exec /usr/bin/git clone --single-branch --branch main --no-checkout "$FAKE_REPO" "${@: -1}"; fi
if [[ "$1" == -C && "${3:-}" == lfs ]]; then printf 'lfs %s\\n' "$4" >> "$CALL_LOG"; [[ "${FAIL_LFS:-}" != "$4" ]]; exit; fi
exec /usr/bin/git "$@"
''')
        self.stub('curl', '''#!/bin/bash
set -euo pipefail
[[ "$#" == 7 && "$1" == --fail && "$2" == --location && "$3" == --silent && "$4" == --show-error && "$6" == --output ]] || { echo 'invalid curl arguments' >&2; exit 90; }
url=$5; output=$7; rev=${url%/*}; rev=${rev##*/}; file=${url##*/}
printf 'curl %s\\n' "$url" >> "$CALL_LOG"
[[ "$url" == "https://huggingface.co/spaces/VoiceOfML/Search/resolve/$rev/$file" ]] || exit 91
[[ "${FAIL_DOWNLOAD:-0}" != 1 && "${FAIL_FILE:-}" != "$file" ]] || exit 22
if [[ "${BAD_PATH:-0}" == 1 ]]; then file=wrong.json; fi
/usr/bin/git -C "$FAKE_REPO" show "$rev:$file" > "$output"
if [[ "${BAD_HASH:-0}" == 1 ]]; then printf x >> "$output"; fi
''')
        self.stub('git-lfs', '#!/bin/bash\nexit 0\n')

    def git(self, *args):
        return subprocess.check_output(['/usr/bin/git', '-C', str(self.source), *args], env=self.env, text=True).strip()

    def stub(self, name, text):
        path = self.bin / name
        path.write_text(text)
        path.chmod(0o755)

    def run_shell(self, text):
        return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', text], cwd=self.work,
                              env=self.env, text=True, capture_output=True)

    def select_pair(self, new):
        selector = (ROOT / 'scripts/select_hf_history.py').read_text()
        anchor, baseline = (NEW_ANCHOR, NEW_BASE) if new else (OLD_ANCHOR, OLD_BASE)
        selector = selector.replace(anchor, self.anchor).replace(baseline, self.baseline)
        (self.work / 'scripts/select_hf_history.py').write_text(selector)
        verifier = (ROOT / 'scripts/verify_hf_quality_baseline.py').read_text().replace(NEW_ANCHOR, self.anchor if new else NEW_ANCHOR)
        (self.work / 'scripts/verify_hf_quality_baseline.py').write_text(verifier)
        lock_path = self.work / '.github/quality-baselines/hf-source.json'
        lock = json.loads(lock_path.read_text())
        lock['revision'] = self.baseline if new else NEW_BASE
        lock_path.write_text(json.dumps(lock))

    def checkout(self, script=None):
        self.select_pair(False)
        return self.run_shell(script if script is not None else shell('Checkout Hugging Face Search Space'))

    def verify(self, script=None):
        self.env['CAPTURED_HF_REVISION'] = self.revision
        return self.run_shell(script if script is not None else shell('Verify independent Hugging Face quality baseline'))

    def calls(self):
        return self.log.read_text().splitlines()

    def assert_checkout_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output.read_text(), 'revision=' + self.revision + '\n')
        self.assertEqual(self.calls(), ['ls-remote', 'clone', 'lfs pull', 'lfs fsck'])
        self.assertEqual(subprocess.check_output(['/usr/bin/git', '-C', str(self.work / 'huggingface-search'), 'rev-parse', 'HEAD'], text=True).strip(), self.revision)

    def curl_calls(self, files=FILES):
        return [f'curl https://huggingface.co/spaces/VoiceOfML/Search/resolve/{self.baseline}/{name}' for name in files]

    def assert_verify_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[-2:], self.curl_calls())
        self.assertIn('Verified two HF quality baselines from ' + self.baseline, result.stdout)
        for name in FILES:
            self.assertEqual((self.runtime / 'hf-quality-baseline' / name).read_bytes(), (self.source / name).read_bytes())

    def test_new_history_selection_executes_same_workflow(self):
        self.select_pair(True)
        result = self.run_shell(shell('Checkout Hugging Face Search Space'))
        self.assert_checkout_success(result)
        self.assert_verify_success(self.verify())

    def test_real_workflow_and_early_exit_mutations(self):
        # A successful exit alone is not success: assert every observable side effect.
        with self.assertRaises(AssertionError):
            self.assert_checkout_success(self.checkout('exit 0\n' + shell('Checkout Hugging Face Search Space')))
        self.assert_checkout_success(self.checkout())
        with self.assertRaises(AssertionError):
            self.assert_verify_success(self.verify('exit 0\n' + shell('Verify independent Hugging Face quality baseline')))
        self.assert_verify_success(self.verify())

    def test_download_failure_path_200_and_hash_mismatch(self):
        self.assert_checkout_success(self.checkout())
        for fault in ('FAIL_DOWNLOAD', 'BAD_HASH', 'BAD_PATH'):
            with self.subTest(fault=fault):
                self.env[fault] = '1'
                before = len(self.calls())
                result = self.verify()
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn('Verified two HF quality baselines', result.stdout)
                expected_count = 1 if fault == 'FAIL_DOWNLOAD' else 2
                self.assertEqual(self.calls()[before:], self.curl_calls(FILES[:expected_count]))
                if fault != 'FAIL_DOWNLOAD':
                    self.assertIn('missing or altered baseline file', result.stderr)
                if fault == 'BAD_PATH':
                    self.assertEqual((self.runtime / 'hf-quality-baseline' / FILES[0]).read_bytes(), b'wrong path but HTTP 200\n')
                del self.env[fault]

    def test_second_download_failure_does_not_validate_stale_files(self):
        self.assert_checkout_success(self.checkout())
        self.assert_verify_success(self.verify())
        self.env['FAIL_FILE'] = FILES[1]
        before = len(self.calls())
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls()[before:], self.curl_calls())
        self.assertNotIn('Verified two HF quality baselines', result.stdout)

    def test_lfs_failures_stop_checkout(self):
        for phase in ('pull', 'fsck'):
            with self.subTest(phase=phase):
                shutil.rmtree(self.work / 'huggingface-search', ignore_errors=True)
                self.log.write_text('')
                self.output.write_text('')
                self.env['FAIL_LFS'] = phase
                result = self.checkout()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(), ['ls-remote', 'clone', 'lfs pull'] + (['lfs fsck'] if phase == 'fsck' else []))
                self.assertEqual(self.output.read_text(), '')
                # A bypass of the LFS failure must not satisfy the failure contract.
                bypass = shell('Checkout Hugging Face Search Space').replace('git -C huggingface-search lfs ' + phase, 'git -C huggingface-search lfs ' + phase + ' || true')
                shutil.rmtree(self.work / 'huggingface-search', ignore_errors=True)
                mutated = self.checkout(bypass)
                self.assertEqual(mutated.returncode, 0, mutated.stderr)
                del self.env['FAIL_LFS']

    def test_capture_and_output_errors_stop(self):
        self.env['FAKE_REV'] = 'f' * 40
        result = self.checkout()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.output.read_text(), '')
        self.assertEqual(self.calls(), ['ls-remote', 'clone'])
        shutil.rmtree(self.work / 'huggingface-search')
        self.log.write_text('')
        self.env['FAKE_REV'] = self.revision
        self.env['GITHUB_OUTPUT'] = '/dev/full'
        result = self.checkout()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('No space left', result.stderr)
        self.assertEqual(self.calls(), ['ls-remote', 'clone', 'lfs pull', 'lfs fsck'])

    def test_baseline_short_circuit_cannot_pass_observable_contract(self):
        self.assert_checkout_success(self.checkout())
        original = shell('Verify independent Hugging Face quality baseline')
        mutations = [
            original.replace('curl --fail', 'false && curl --fail'),
            re.sub(r'(?m)^python3 -B scripts/verify_hf_quality_baseline.py (.*)$', r'true || python3 -B scripts/verify_hf_quality_baseline.py \1', original),
        ]
        for mutated in mutations:
            with self.subTest(mutated=mutated):
                self.assertNotEqual(mutated, original)
                self.log.write_text('')
                shutil.rmtree(self.runtime / 'hf-quality-baseline', ignore_errors=True)
                with self.assertRaises(AssertionError):
                    self.assert_verify_success(self.verify(mutated))

    def test_unmatched_capture_stops_before_curl(self):
        self.assert_checkout_success(self.checkout())
        self.env['CAPTURED_HF_REVISION'] = 'f' * 40
        result = self.run_shell(shell('Verify independent Hugging Face quality baseline'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('history selection failed', result.stderr)
        self.assertEqual(self.calls(), ['ls-remote', 'clone', 'lfs pull', 'lfs fsck'])


if __name__ == '__main__':
    unittest.main()

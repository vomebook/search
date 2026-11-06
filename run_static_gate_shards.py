#!/usr/bin/env python3
"""Optional fail-closed parallel runner for the static unittest gate."""
import argparse
import importlib
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
TARGET = 'tests.test_static_checks'


def validate(module_name, groups):
    """Validate before starting workers; also usable by isolated fixture tests."""
    if not isinstance(groups, list) or len(groups) != 3 or any(not isinstance(g, list) or not g for g in groups):
        raise ValueError('expected three nonempty ID lists')
    frozen = [x for group in groups for x in group]
    if any(not isinstance(x, str) or not x.startswith(module_name + '.') for x in frozen) or len(set(frozen)) != len(frozen):
        raise ValueError('invalid or duplicate IDs')
    module = importlib.import_module(module_name)
    if any(hasattr(module, n) for n in ('load_tests', 'setUpModule', 'tearDownModule')):
        raise ValueError('module hooks unsupported')
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(module)
    if loader.errors:
        raise ValueError(str(loader.errors))
    ids, classes = [], set()
    def visit(item):
        if type(item) is unittest.TestSuite:
            for child in item:
                visit(child)
        elif isinstance(item, unittest.TestSuite) or not isinstance(item, unittest.TestCase):
            raise ValueError('unsupported suite or case')
        else:
            classes.add(type(item))
            ids.append(item.id())
    visit(suite)
    if len(classes) != 1 or len(ids) != len(set(ids)) or set(ids) != set(frozen):
        raise ValueError('case class or ID mismatch')
    cls = next(iter(classes))
    if cls.__module__ != module_name:
        raise ValueError('foreign case class')
    # Check the entire inheritance chain, not just the concrete class.
    hooks = ('__init__', 'run', '__call__', 'id', 'setUpClass', 'tearDownClass',
             'doClassCleanups', 'addClassCleanup', 'countTestCases', 'debug', 'defaultTestResult')
    for base in cls.__mro__:
        if base in (unittest.TestCase, object):
            break
        if any(n in base.__dict__ for n in hooks):
            raise ValueError('custom case or class hook unsupported')
    # Validate each fully qualified name using the same loader used by workers.
    for name in frozen:
        loaded = loader.loadTestsFromName(name)
        found = []
        def collect(item):
            if type(item) is unittest.TestSuite:
                for child in item:
                    collect(child)
            elif type(item) is cls:
                found.append(item.id())
            else:
                raise ValueError('name resolves to unsupported object')
        collect(loaded)
        if found != [name] or loader.errors:
            raise ValueError('name does not resolve uniquely: ' + name)


class RecordingResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.started = []
        self.stopped = []

    def startTest(self, test):
        super().startTest(test)
        self.started.append(test.id())

    def stopTest(self, test):
        self.stopped.append(test.id())
        super().stopTest(test)


def worker(module, groups, index, result_path):
    validate(module, groups)
    loader = unittest.TestLoader()
    suite = unittest.TestSuite(loader.loadTestsFromName(name) for name in groups[index])
    result = unittest.TextTestRunner(verbosity=2, resultclass=RecordingResult).run(suite)
    data = dict(started=result.started, stopped=result.stopped,
                wasSuccessful=result.wasSuccessful(),
                skips=[{'id': getattr(test, 'test_case', test).id(),
                        'kind': 'subtest' if hasattr(test, 'test_case') else 'case',
                        'reason': reason} for test, reason in result.skipped],
                failures=len(result.failures), errors=len(result.errors),
                expectedFailures=len(result.expectedFailures),
                unexpectedSuccess=len(result.unexpectedSuccesses))
    pathlib.Path(result_path).write_text(json.dumps(data))
    return 0 if result.wasSuccessful() else 1


def check_result(path, group, allowed_skips):
    data = json.loads(pathlib.Path(path).read_text())
    if not isinstance(data, dict):
        raise ValueError('invalid result')
    for key in ('started', 'stopped'):
        ids = data.get(key)
        if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids) or sorted(ids) != sorted(group):
            raise ValueError('invalid ' + key)
    skips = data.get('skips')
    if not isinstance(skips, list):
        raise ValueError('invalid skips')
    seen = set()
    for skip in skips:
        if (not isinstance(skip, dict) or set(skip) != {'id', 'kind', 'reason'}
                or not isinstance(skip['id'], str) or skip['id'] in seen
                or skip['id'] not in group or skip['kind'] != 'case'
                or skip['id'] not in allowed_skips
                or skip['reason'] != allowed_skips[skip['id']]):
            raise ValueError('invalid skips')
        seen.add(skip['id'])
    for key in ('failures', 'errors', 'expectedFailures', 'unexpectedSuccess'):
        if type(data.get(key)) is not int or data[key] != 0:
            raise ValueError('invalid ' + key)
    if data.get('wasSuccessful') is not True:
        raise ValueError('unsuccessful result')


def run_groups(groups, timeout=1800, allowed_skips=None):
    allowed_skips = allowed_skips or {}
    processes, interrupted, old = [], [], {}
    failure = None
    started = time.monotonic()
    def handle(sig, frame):
        interrupted.append(sig)
    def note(message):
        nonlocal failure
        if failure is None:
            failure = message
        print(message, file=sys.stderr, flush=True)
    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            old[sig] = signal.signal(sig, handle)
        with tempfile.TemporaryDirectory(prefix='static-shards-') as tmp:
            try:
                for i, group in enumerate(groups):
                    if interrupted:
                        note(f'interrupted by signal {interrupted[0]}')
                        break
                    out = open(pathlib.Path(tmp) / f'{i}.out', 'w+')
                    try:
                        err = open(pathlib.Path(tmp) / f'{i}.err', 'w+')
                    except BaseException:
                        out.close()
                        raise
                    result_path = str(pathlib.Path(tmp) / f'{i}.json')
                    try:
                        module = group[0].rsplit('.', 2)[0]
                        p = subprocess.Popen([sys.executable, '-B', str(ROOT / 'run_static_gate_shards.py'),  # noqa: S603 - fixed interpreter and validated test IDs
                                              '--worker', module, json.dumps(groups), str(i), result_path],
                                             stdout=out, stderr=err, start_new_session=True, env=os.environ.copy())
                    except BaseException:
                        out.close(); err.close()
                        raise
                    processes.append((p, out, err, result_path, time.monotonic()))
                finished = set()
                while not failure and len(finished) < len(processes):
                    for i, (p, _, _, result_path, _) in enumerate(processes):
                        if i in finished:
                            continue
                        # WNOWAIT keeps the leader PID reserved until group cleanup.
                        info = os.waitid(os.P_PID, p.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                        if info is not None:
                            finished.add(i)
                            if info.si_code != os.CLD_EXITED or info.si_status != 0:
                                note(f'shard {i + 1} exited abnormally: {info.si_status}')
                            else:
                                try:
                                    check_result(result_path, groups[i], allowed_skips)
                                except (OSError, ValueError, TypeError) as exc:
                                    note(f'shard {i + 1} invalid result: {exc}')
                    if interrupted:
                        note(f'interrupted by signal {interrupted[0]}')
                    if time.monotonic() - started > timeout:
                        note('timeout')
                    if not failure and len(finished) < len(processes):
                        time.sleep(0.05)
            finally:
                # Never reap before signalling: even a zombie reserves the leader PID,
                # preventing a recycled PGID from identifying an unrelated group.
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    for p, _, _, _, _ in processes:
                        try:
                            os.killpg(p.pid, sig)
                        except ProcessLookupError:
                            pass
                        except Exception as exc:
                            note(f'cleanup signal failed for {p.pid}: {exc}')
                    if sig == signal.SIGTERM and processes:
                        time.sleep(0.2)
                for i, (p, out, err, _, start) in enumerate(processes):
                    try:
                        p.wait()
                    except Exception as exc:
                        note(f'wait failed for {p.pid}: {exc}')
                    try:
                        print(f'\n=== shard {i + 1}: exit {p.returncode}, elapsed {time.monotonic()-start:.2f}s ===', flush=True)
                        for f, dest in ((out, sys.stdout), (err, sys.stderr)):
                            f.seek(0)
                            while True:
                                chunk = f.read(65536)
                                if not chunk:
                                    break
                                print(chunk, file=dest, end='', flush=True)
                    except Exception as exc:
                        note(f'output failed for {p.pid}: {exc}')
                    finally:
                        for f in (out, err):
                            try:
                                f.close()
                            except Exception as exc:
                                note(f'close failed: {exc}')
            if interrupted:
                note(f'interrupted by signal {interrupted[0]}')
            return 1 if failure else 0
    finally:
        for sig, handler in old.items():
            signal.signal(sig, handler)


def load_project(project, root=ROOT):
    if project not in ('github', 'hf'):
        raise ValueError('invalid project')
    # This checkout marker is checked independently of manifest metadata.
    if (root / 'pyrightconfig.json').is_file() != (project == 'hf'):
        raise ValueError('project file marker mismatch')
    manifest = json.loads((root / f'static_gate_ids.{project}.json').read_text())
    if (not isinstance(manifest, dict) or set(manifest) != {'version', 'project', 'module', 'groups'}
            or type(manifest['version']) is not int or manifest['version'] != 1
            or manifest['project'] != project or manifest['module'] != TARGET):
        raise ValueError('manifest metadata mismatch')
    return manifest['groups']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', choices=('github', 'hf'), required=True)
    args = parser.parse_args()
    if pathlib.Path.cwd().resolve() != ROOT:
        raise ValueError(f'run from checkout root: {ROOT}')
    groups = load_project(args.project)
    validate(TARGET, groups)
    allowed = {} if args.project == 'hf' else {
        TARGET + '.StaticGateTests.test_backend_security_rule_is_enabled': 'HF backend security gate',
        TARGET + '.StaticGateTests.test_pyright_checks_selected_backend_modules': 'HF backend-only type gate',
    }
    return run_groups(groups, allowed_skips=allowed)


if __name__ == '__main__':
    try:
        sys.exit(worker(sys.argv[2], json.loads(sys.argv[3]), int(sys.argv[4]), sys.argv[5])
                 if len(sys.argv) == 6 and sys.argv[1] == '--worker' else main())
    except Exception as exc:
        print(f'static gate failed: {exc}', file=sys.stderr)
        sys.exit(2)

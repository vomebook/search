import contextlib
import importlib
import io
import pathlib
import sys
import tempfile
import unittest

from scripts.ci import run_static_gate_shards as runner


class ShardRunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=runner.ROOT)
        self.addCleanup(self.tmp.cleanup)
        self.directory = pathlib.Path(self.tmp.name)
        sys.path.insert(0, self.tmp.name)
        self.addCleanup(sys.path.remove, self.tmp.name)
        self.addCleanup(sys.modules.pop, 'shard_fixture', None)

    def fixture(self, source):
        (self.directory / 'shard_fixture.py').write_text(source)
        importlib.invalidate_caches()
        return [[f'shard_fixture.C.test_{x}'] for x in ('a', 'b', 'c')]

    def assert_run_failure(self, groups, timeout, message, allowed_skips=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = runner.run_groups(groups, timeout, allowed_skips)
        output = f'captured stdout:\n{stdout.getvalue()}\ncaptured stderr:\n{stderr.getvalue()}'
        self.assertEqual(code, 1, output)
        self.assertIn(message, stderr.getvalue(), output)
        return stdout.getvalue(), stderr.getvalue()

    def test_success_skips_and_subtests(self):
        groups = self.fixture('import unittest\nclass C(unittest.TestCase):\n def test_a(self):\n  with self.subTest(x=1): self.assertEqual(1, 1)\n @unittest.skip("skip")\n def test_b(self): pass\n def test_c(self): pass\n')
        runner.validate('shard_fixture', groups)
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {'PYTHONPATH': self.tmp.name}):
            self.assertEqual(runner.run_groups(groups, 5, allowed_skips={groups[1][0]: 'skip'}), 0)
            self.assert_run_failure(groups, 5, 'invalid result: invalid skips')

    def test_subtest_skip_rejected_end_to_end(self):
        import os
        from unittest.mock import patch
        groups = self.fixture('import unittest\nclass C(unittest.TestCase):\n def test_a(self):\n  with self.subTest(x=1): self.skipTest("skip")\n def test_b(self): pass\n def test_c(self): pass\n')
        with patch.dict(os.environ, {'PYTHONPATH': self.tmp.name}):
            self.assert_run_failure(groups, 5, 'invalid result: invalid skips', {groups[0][0]: 'skip'})

    def test_leader_exit_and_sigterm_cleanup(self):
        import os, signal, subprocess, time
        from unittest.mock import patch
        childfile = self.directory / 'child'
        script = self.directory / 'leader.py'
        script.write_text('import os,signal,time\np=os.fork()\nif p:\n open('+repr(str(childfile))+',"w").write(str(p))\n os._exit(0)\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nwhile True: time.sleep(1)\n')
        real = subprocess.Popen
        def launch(*args, **kwargs):
            return real([sys.executable, str(script)], **kwargs)
        with patch.object(runner.subprocess, 'Popen', side_effect=launch):
            self.assert_run_failure([['x.C.test_a']], 5, 'invalid result:')
        pid = int(childfile.read_text())
        for _ in range(100):
            status = pathlib.Path(f'/proc/{pid}/stat')
            try:
                if status.read_text().split()[2] == 'Z': break
            except (FileNotFoundError, ProcessLookupError): break
            time.sleep(.02)
        else: self.fail('same-group descendant survived cleanup')

        groups = self.fixture('import os,pathlib,unittest,time\nclass C(unittest.TestCase):\n def ready(self):\n  (pathlib.Path(os.environ["READY_DIR"]) / self._testMethodName).touch()\n  while True: time.sleep(1)\n def test_a(self): self.ready()\n def test_b(self): self.ready()\n def test_c(self): self.ready()\n')
        driver = self.directory / 'driver.py'
        driver.write_text('from scripts.ci import run_static_gate_shards as r\nraise SystemExit(r.run_groups('+repr(groups)+', 30))\n')
        env = dict(os.environ, PYTHONPATH=os.pathsep.join((str(runner.ROOT), self.tmp.name)), READY_DIR=self.tmp.name)
        p = real([sys.executable, str(driver)], cwd=runner.ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            ready = [self.directory / f'test_{name}' for name in ('a', 'b', 'c')]
            while not all(path.exists() for path in ready):
                self.assertIsNone(p.poll(), 'driver exited before workers became ready')
                if time.monotonic() >= deadline:
                    self.fail('workers did not become ready within 5 seconds')
                time.sleep(.02)
            self.assertIsNone(p.poll(), 'driver exited before SIGTERM')
            p.send_signal(signal.SIGTERM)
            self.assertNotEqual(p.wait(timeout=5), 0)
        finally:
            if p.poll() is None: p.kill(); p.wait()

    def test_skip_faults(self):
        import json
        path = self.directory / 'result.json'
        base = dict(started=['x'], stopped=['x'], wasSuccessful=True, failures=0,
                    errors=0, expectedFailures=0, unexpectedSuccess=0)
        good = {'id': 'x', 'kind': 'case', 'reason': 'ok'}
        for skips in ([dict(good, kind='subtest')], [dict(good, reason='wrong')], [good, good]):
            path.write_text(json.dumps(dict(base, skips=skips)))
            with self.assertRaises(ValueError): runner.check_result(path, ['x'], {'x': 'ok'})
        path.write_text(json.dumps(dict(base, skips=[good])))
        with self.assertRaises(ValueError): runner.check_result(path, ['x'], {})

    def test_project_and_manifests(self):
        import json
        root = self.directory
        gh = json.loads((runner.ROOT / 'tests/gates/static_gate_ids.github.json').read_text())
        hf = json.loads((runner.ROOT / 'tests/gates/static_gate_ids.hf.json').read_text())
        self.assertEqual(gh['project'], 'github')
        self.assertEqual(hf['project'], 'hf')
        g = {x for group in gh['groups'] for x in group}
        h = {x for group in hf['groups'] for x in group}
        self.assertEqual(len(g), 128)
        self.assertEqual(len(h), 128)
        for added in ('test_search_folder_selection_coverage_gate_fails_closed', 'test_search_folder_selection_declaration_matches_runtime', 'test_search_folder_selection_rejects_wrong_argument_and_return_types',
                      'test_search_height_index_coverage_gate_fails_closed', 'test_search_height_index_declaration_matches_runtime', 'test_search_height_index_rejects_wrong_argument_and_return_types',
                      'test_search_stable_stringify_coverage_gate_fails_closed', 'test_search_stable_stringify_strict_type_contract',
                      'test_search_view_key_coverage_gate_fails_closed', 'test_search_view_key_strict_type_contract',
                      'test_search_recovery_coverage_gate_fails_closed', 'test_search_recovery_strict_type_contract',
                      'test_sidebar_markup_coverage_gate_fails_closed', 'test_sidebar_markup_strict_type_contract'):
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, g)
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, h)
        for added in ('test_pdf_partition_config_coverage_gate_fails_closed',
                      'test_pdf_partition_config_exact_signature_complexity_and_build'):
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, g)
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, h)
        for added in ('test_pdf_partition_shape_coverage_gate_fails_closed',
                      'test_pdf_partition_shape_exact_signature_complexity_and_build'):
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, g)
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, h)
        for added in ('test_pdf_search_stream_coverage_gate_fails_closed',
                      'test_pdf_search_stream_exact_signature_complexity_and_build'):
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, g)
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, h)
        for added in ('test_pdf_book_url_coverage_gate_fails_closed',
                      'test_pdf_book_url_exact_signature_complexity_and_build'):
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, g)
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, h)
        for added in ('test_chapter_search_worker_coverage_gate_fails_closed',
                      'test_chapter_search_worker_strict_complexity_and_network_contract'):
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, g)
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.' + added, h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_index_coverage_gate_fails_closed', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_index_coverage_gate_fails_closed', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_index_exact_signature_and_complexity', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_index_exact_signature_and_complexity', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_proxy_coverage_gate_fails_closed', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_proxy_coverage_gate_fails_closed', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_proxy_exact_signature_and_complexity', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_proxy_exact_signature_and_complexity', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_core_coverage_gate_fails_closed', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_core_coverage_gate_fails_closed', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_core_strict_signature_complexity_and_build', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_chapter_search_core_strict_signature_complexity_and_build', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_loader_strict_signature_and_complexity', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_loader_strict_signature_and_complexity', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_source_identity_strict_complexity_and_build', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_source_identity_strict_complexity_and_build', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_document_adapter_strict_and_complexity', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_document_adapter_strict_and_complexity', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_scheduler_strict_signatures_and_complexity', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_scheduler_strict_signatures_and_complexity', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_worker_cyclomatic_complexity_cap', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_worker_cyclomatic_complexity_cap', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_worker_strict_signatures_and_message_boundary', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_djvu_worker_strict_signatures_and_message_boundary', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_strict_service_worker_project_rejects_regressions', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_strict_service_worker_project_rejects_regressions', h)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_pdf_prefetch_contract_gate_fails_closed', g)
        self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_pdf_prefetch_contract_gate_fails_closed', h)
        for manifest, ids in ((gh, g), (hf, h)):
            self.assertEqual(sum(map(len, manifest['groups'])), len(ids))
            self.assertIn('tests.gates.test_static_checks.StaticGateTests.test_pdf_text_store_targeted_mutants_fail_closed', ids)
        self.assertEqual({x.rsplit('.', 1)[1] for x in g - h}, {'test_pyright_strict_seo_gate_rejects_unknown_parameter'})
        self.assertEqual({x.rsplit('.', 1)[1] for x in h - g}, {'test_pyright_strict_gate_rejects_unknown_parameter'})
        (root / 'tests/gates').mkdir(parents=True)
        (root / 'tests/gates/static_gate_ids.github.json').write_text(json.dumps(gh))
        (root / 'tests/gates/static_gate_ids.hf.json').write_text(json.dumps(hf))
        self.assertEqual(runner.load_project('github', root), gh['groups'])
        with self.assertRaises(ValueError): runner.load_project('hf', root)
        (root / 'pyrightconfig.json').write_text('{}')
        with self.assertRaises(ValueError): runner.load_project('github', root)
        self.assertEqual(runner.load_project('hf', root), hf['groups'])
        hf['project'] = 'github'
        (root / 'tests/gates/static_gate_ids.hf.json').write_text(json.dumps(hf))
        with self.assertRaises(ValueError): runner.load_project('hf', root)

    def test_reject_duplicate_and_class_hook(self):
        groups = self.fixture('import unittest\nclass C(unittest.TestCase):\n @classmethod\n def setUpClass(cls): pass\n def test_a(self): pass\n def test_b(self): pass\n def test_c(self): pass\n')
        with self.assertRaises(ValueError): runner.validate('shard_fixture', groups)
        groups[1] = groups[0]
        with self.assertRaises(ValueError): runner.validate('shard_fixture', groups)

    def test_reject_load_tests(self):
        groups = self.fixture('import unittest\ndef load_tests(*args): return unittest.TestSuite()\n')
        with self.assertRaises(ValueError): runner.validate('shard_fixture', groups)

    def test_failure_and_duplicate_ids(self):
        groups = self.fixture('import unittest, time\nclass C(unittest.TestCase):\n def test_a(self): self.fail("injected")\n def test_b(self): time.sleep(10)\n def test_c(self): time.sleep(10)\n')
        runner.validate('shard_fixture', groups)
        # Workers inherit PYTHONPATH, not the parent's sys.path changes.
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {'PYTHONPATH': self.tmp.name}):
            self.assert_run_failure(groups, 15, 'shard 1 exited abnormally: 1')
            # Duplicate IDs fail validation; use enough time to avoid racing worker startup.
            self.assert_run_failure([groups[1], groups[1], groups[1]], 5, 'invalid or duplicate IDs')

    def test_result_validation(self):
        import json
        path = self.directory / 'result.json'
        data = dict(started=['x'], stopped=['x'], wasSuccessful=True, skips=[], failures=0,
                    errors=0, expectedFailures=0, unexpectedSuccess=0)
        with self.assertRaises(OSError): runner.check_result(path, ['x'], ())
        path.write_text('{')
        with self.assertRaises(ValueError): runner.check_result(path, ['x'], ())
        for key, value in [('started', ['x', 'x']), ('started', []), ('unexpectedSuccess', 1)]:
            bad = dict(data, **{key: value})
            path.write_text(json.dumps(bad))
            with self.assertRaises(ValueError): runner.check_result(path, ['x'], ())

    def test_exit_zero_without_result(self):
        import os
        from unittest.mock import patch
        groups = self.fixture('import unittest, os\nclass C(unittest.TestCase):\n def test_a(self): os._exit(0)\n def test_b(self): pass\n def test_c(self): pass\n')
        with patch.dict(os.environ, {'PYTHONPATH': self.tmp.name}):
            self.assert_run_failure(groups, 5, 'invalid result:')

    def test_popen_failure_preserved(self):
        from unittest.mock import patch
        real = runner.subprocess.Popen
        for n in (2, 3):
            calls = []
            def launch(*args, **kwargs):
                if len(calls) == n - 1:
                    raise OSError('injected launch failure')
                p = real(*args, **kwargs)
                calls.append(p)
                return p
            with patch.object(runner.subprocess, 'Popen', side_effect=launch):
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaisesRegex(OSError, 'injected launch failure'):
                        runner.run_groups([['missing_fixture.C.test_a']] * 3, 5)
            self.assertTrue(all(p.returncode is not None for p in calls))

    def test_unexpected_success(self):
        import os
        from unittest.mock import patch
        groups = self.fixture('import unittest\nclass C(unittest.TestCase):\n @unittest.expectedFailure\n def test_a(self): pass\n def test_b(self): pass\n def test_c(self): pass\n')
        with patch.dict(os.environ, {'PYTHONPATH': self.tmp.name}):
            self.assert_run_failure(groups, 5, 'shard 1 exited abnormally: 1')

    def test_worker_import_error(self):
        groups = [[f'missing_fixture.C.test_{name}'] for name in ('a', 'b', 'c')]
        self.assert_run_failure(groups, 5, "No module named 'missing_fixture'")

    def test_failure_message_printed_to_stderr(self):
        import subprocess
        from unittest.mock import patch
        real = subprocess.Popen
        def launch(*args, **kwargs):
            # Exercise the normal failure logging path without spawning a long-lived worker.
            return real([sys.executable, '-B', '-c', 'raise SystemExit(7)'], **kwargs)
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(runner.subprocess, 'Popen', side_effect=launch), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(runner.run_groups([['x.C.test_a']], 5), 1)
        self.assertIn('shard 1 exited abnormally: 7', stderr.getvalue())
        self.assertIn('=== shard 1: exit 7', stdout.getvalue())

import unittest

from scripts.ci.check_pages_freshness import check, wait_for_matrix


class PagesFreshnessTests(unittest.TestCase):
    def test_current_main_and_intervening_push(self):
        sha = 'a' * 40
        env = {'GITHUB_REPOSITORY': 'vomebook/search', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': sha}
        def ref(value):
            return {'ref': 'refs/heads/main', 'object': {'type': 'commit', 'sha': value}}
        check(env, lambda: ref(sha))
        with self.assertRaises(ValueError):
            check(env, lambda: ref('b' * 40))
        with self.assertRaises(ValueError):
            check({**env, 'GITHUB_REF': 'refs/heads/other'}, lambda: ref(sha))
        with self.assertRaises(OSError):
            check(env, lambda: (_ for _ in ()).throw(OSError('unavailable')))

    def test_requires_successful_exact_matrix_and_rechecks_main_while_waiting(self):
        sha = 'a' * 40
        exact = {'head_sha': sha, 'head_branch': 'main', 'event': 'push', 'status': 'completed', 'conclusion': 'success'}
        other = {**exact, 'head_sha': 'b' * 40}
        scheduled = {**exact, 'event': 'schedule'}
        current = {**exact, 'status': 'in_progress', 'conclusion': None}
        polls = iter(([other, scheduled], [current], [exact]))
        checks = []
        waited = []
        wait_for_matrix(sha, lambda: next(polls), lambda: checks.append(True), clock=lambda: 0, sleep=waited.append)
        self.assertEqual(waited, [30, 30]); self.assertEqual(len(checks), 3)
        for completion in ('cancelled', 'failure', 'skipped'):
            with self.assertRaisesRegex(ValueError, 'did not succeed'):
                wait_for_matrix(sha, lambda: [{**exact, 'conclusion': completion}], lambda: None,
                                clock=lambda: 0, sleep=self.fail)
        times = iter([0, 2])
        with self.assertRaises(TimeoutError):
            wait_for_matrix(sha, lambda: [other, scheduled], lambda: None, clock=lambda: next(times),
                            sleep=self.fail, timeout=1)

"""Run every initial-payload route regression, failing on skips or missing tests."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

PREFIX = "tests.search.browser.test_sidebar_initial_payload_route_race.SidebarInitialPayloadRouteRaceTests."
SIDEBAR_TEST_NAMES = (
    "test_actual_delayed_payload_survives_a_pending_folder_navigation",
    "test_first_global_payload_normalizes_and_persists_the_initial_url",
    "test_late_initial_payload_does_not_replace_pending_folder_navigation",
    "test_navigated_destination_is_persisted_before_hashchange",
    "test_payload_after_a_normal_state_write_still_normalizes_url",
    "test_pending_navigation_preserves_parameters_and_back_forward_history",
    "test_route_regressions_are_discovered",
)
INTENT_PREFIX = "tests.search.browser.test_initial_intent_reader_routes.InitialIntentReaderRouteTests."
INTENT_TEST_NAMES = (
    "test_a_b_a_initial_failure_does_not_restart_latest_a",
    "test_a_b_a_initial_success_keeps_newest_a",
    "test_late_failure_cannot_start_extra_same_key_search",
    "test_late_success_cannot_abort_same_key_search_or_write_cache",
    "test_new_search_owns_same_key_while_viewport_read_is_pending",
    "test_path_only_route_keeps_initial_request_ownership",
    "test_reader_go_minus_two_and_forward_reconcile_search_only_once",
    "test_reader_timeout_reconciles_changed_return_destination",
    "test_same_key_snapshot_restore_invalidates_initial_payload",
    "test_same_route_reader_back_keeps_pending_search_and_scroll",
)
TEST_NAMES = tuple(PREFIX + name for name in SIDEBAR_TEST_NAMES) + tuple(
    INTENT_PREFIX + name for name in INTENT_TEST_NAMES)


def passed(result: unittest.TestResult) -> bool:
    return (result.wasSuccessful() and result.testsRun == len(TEST_NAMES)
            and not result.skipped and not result.expectedFailures and not result.unexpectedSuccesses)


def main() -> int:
    # Executing scripts/foo.py puts scripts/, not the repository, on sys.path.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    if len(set(TEST_NAMES)) != len(TEST_NAMES):
        print("duplicate initial payload regression name", file=sys.stderr)
        return 1
    suite = unittest.defaultTestLoader.loadTestsFromNames(TEST_NAMES)
    if suite.countTestCases() != len(TEST_NAMES):
        print("incomplete initial payload regression discovery", file=sys.stderr)
        return 1
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not passed(result):
        print("initial payload regression gate requires all named tests with no skips", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

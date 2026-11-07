"""Run every initial-payload route regression, failing on skips or missing tests."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

PREFIX = "tests.search.browser.test_sidebar_initial_payload_route_race.SidebarInitialPayloadRouteRaceTests."
TEST_NAMES = (
    "test_actual_delayed_payload_survives_a_pending_folder_navigation",
    "test_first_global_payload_normalizes_and_persists_the_initial_url",
    "test_late_initial_payload_does_not_replace_pending_folder_navigation",
    "test_navigated_destination_is_persisted_before_hashchange",
    "test_payload_after_a_normal_state_write_still_normalizes_url",
    "test_pending_navigation_preserves_parameters_and_back_forward_history",
    "test_route_regressions_are_discovered",
)


def passed(result: unittest.TestResult) -> bool:
    return (result.wasSuccessful() and result.testsRun == len(TEST_NAMES)
            and not result.skipped and not result.expectedFailures and not result.unexpectedSuccesses)


def main() -> int:
    # Executing scripts/foo.py puts scripts/, not the repository, on sys.path.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    if len(set(TEST_NAMES)) != len(TEST_NAMES):
        print("duplicate initial payload regression name", file=sys.stderr)
        return 1
    suite = unittest.defaultTestLoader.loadTestsFromNames([PREFIX + name for name in TEST_NAMES])
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

"""Fail closed on named real-browser DOM-search contracts, not coverage."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / 'static/reader/search/reader-dom-search.mjs'
TEST_MODULE = 'tests.reader.browser.test_reader_dom_search_contracts'
CONTRACTS = {
    'test_literal_escape_snippets_and_pagination': 'helpers',
    'test_cross_node_highlight_cleanup_and_stale_navigation': 'crossNodeAndStaleNavigation',
    'test_progressive_paging_snapshot_reuse_and_activation': 'progressivePagingAndReuse',
    'test_synchronous_mutation_invalidates_snapshot': 'synchronousSnapshotInvalidation',
    'test_cancelled_search_cannot_publish_final_results': 'cancellation',
    'test_heading_labels_and_excluded_text': 'headingsAndExcludedNodes',
    'test_large_heading_order_snapshot_and_fallback': 'largeHeadingOrder',
    'test_occurrence_selection_and_stale_navigation': 'occurrenceSelection',
}


def valid_output(stdout, stderr, browser, digest):
    """Require exactly one success per named test and matching browser marker."""
    if browser not in ('chromium', 'firefox') or not re.fullmatch(r'[0-9a-f]{64}', digest):
        return False
    markers = stdout.splitlines()
    pattern = rf'DOM_SEARCH_CONTRACT_COMPLETED {browser} ([A-Za-z][A-Za-z0-9_]*) {digest}'
    matches = [re.fullmatch(pattern, line) for line in markers]
    if any(match is None for match in matches):
        return False
    completed = {match[1] for match in matches if match is not None}
    if len(completed) != len(markers) or not set(CONTRACTS.values()) <= completed:
        return False
    lines = stderr.splitlines()
    expected_tests = {f'{name} ({TEST_MODULE}.ReaderDomSearchContracts.{name}) ... ok' for name in CONTRACTS}
    passed_test = re.compile(rf'(test_\w+) \({re.escape(TEST_MODULE)}\.ReaderDomSearchContracts\.\1\) \.\.\. ok')
    found = [line for line in lines if passed_test.fullmatch(line)]
    if len(found) != len(set(found)) or len(found) != len(completed) or not expected_tests <= set(found):
        return False
    summaries = [line for line in lines if re.fullmatch(rf'Ran {len(found)} tests in \d+(?:\.\d+)?s', line)]
    allowed = set(found) | {'', '-' * 70, 'OK'} | set(summaries)
    return (len(summaries) == 1 and lines.count('OK') == 1 and all(line in allowed for line in lines))


def run_browser(browser, digest):
    env = {**os.environ, 'READER_DOM_SEARCH_BROWSER': browser}
    # Fixed interpreter, unittest module and test name; no shell or input arguments.
    result = subprocess.run([sys.executable, '-B', '-m', 'unittest', '-v', TEST_MODULE],  # noqa: S603
                            cwd=ROOT, env=env, text=True, capture_output=True)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode or not valid_output(result.stdout, result.stderr, browser, digest):
        raise SystemExit(f'DOM-search browser contracts incomplete: {browser}')
    print(f'DOM-search browser contracts: {browser}, {len(result.stdout.splitlines())} passed, '
          f'zero skipped, source SHA-256 {digest}', flush=True)


def main():
    digest = hashlib.sha256(MODULE.read_bytes()).hexdigest()
    for browser in ('chromium', 'firefox'):
        run_browser(browser, digest)


if __name__ == '__main__':
    main()

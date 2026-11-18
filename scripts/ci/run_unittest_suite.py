#!/usr/bin/env python3
"""Run selected unittest suites, verifying discovery and completion by ID."""
import argparse
from collections import Counter
from pathlib import Path
import sys
import unittest


class SuiteError(ValueError):
    """An incomplete or ambiguous test selection or execution."""


def case_ids(suite):
    for item in suite:
        if type(item) is unittest.TestSuite:
            yield from case_ids(item)
        elif isinstance(item, unittest.TestCase):
            for cls in type(item).__mro__:
                if cls in (unittest.TestCase, unittest.IsolatedAsyncioTestCase, object):
                    continue
                hooks = {'run', '__call__', '_callTestMethod', 'id'}
                if hooks.intersection(cls.__dict__):
                    raise SuiteError(f'{cls.__qualname__}: unsupported test dispatch hook')
            yield item.id()
        else:
            raise SuiteError('unsupported unittest suite or case')


class RecordingResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.started = Counter()
        self.passed = Counter()
        self.stopped = Counter()

    def startTest(self, test):
        super().startTest(test)
        self.started[test.id()] += 1

    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed[test.id()] += 1

    def stopTest(self, test):
        super().stopTest(test)
        self.stopped[test.id()] += 1


def run(selection, required, stream=None):
    if not selection or len(set(selection)) != len(selection):
        raise SuiteError('expected unique nonempty selectors')
    if len(set(required)) != len(required):
        raise SuiteError('duplicate required test IDs')
    loader = unittest.TestLoader()
    groups = []
    discovered = Counter()
    for selector in selection:
        group = loader.loadTestsFromName(selector)
        if loader.errors:
            raise SuiteError(f'{selector}: discovery failed: {loader.errors[-1]}')
        ids = list(case_ids(group))
        if not ids:
            raise SuiteError(f'{selector}: no tests discovered')
        discovered.update(ids)
        groups.append(group)
    duplicates = sorted(name for name, count in discovered.items() if count != 1)
    if duplicates:
        raise SuiteError(f'duplicate discovered test IDs: {duplicates}')
    missing = sorted(set(required) - discovered.keys())
    if missing:
        raise SuiteError(f'missing required test IDs: {missing}')

    suite = unittest.TestSuite(groups)
    result = unittest.TextTestRunner(stream=stream, verbosity=2, resultclass=RecordingResult).run(suite)
    if (not result.wasSuccessful() or result.skipped or result.expectedFailures or result.unexpectedSuccesses
            or result.testsRun != len(discovered)):
        raise SuiteError('test failure, skip, expected failure, or incomplete run')
    for label in ('started', 'passed', 'stopped'):
        observed = getattr(result, label)
        if observed != discovered:
            raise SuiteError(f'{label} test IDs differ: missing={list((discovered - observed).elements())}, '
                             f'extra={list((observed - discovered).elements())}')
    return len(discovered)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require', action='append', default=[], metavar='TEST_ID')
    parser.add_argument('selection', nargs='+', metavar='MODULE_OR_TEST_ID')
    args = parser.parse_args()
    # HF runs the trusted Pages runner from the checked-out HF directory.
    # Resolve test names in that checkout, never in the runner's own tree.
    sys.path.insert(0, str(Path.cwd().resolve()))
    try:
        count = run(args.selection, args.require)
    except SuiteError as exc:
        print(f'CI unittest suite failed: {exc}', file=sys.stderr)
        return 1
    print(f'CI unittest suite: {count} discovered, passed and completed')
    return 0


if __name__ == '__main__':
    sys.exit(main())

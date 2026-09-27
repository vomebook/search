# Local Worker Performance, 2026-09-27

These measurements describe this checkout's 97,560-record generated snapshot
in Node 22.23.2 on this device, not production timing or API corpus equivalence.
These measurements were collected before release; production acceptance is separate.

## Change

Wildcard matching checks for each mandatory literal before allocating dynamic
programming rows. The check uses escaped single UTF-16-unit regexes with the
same non-`u`, case-insensitive semantics as the existing matcher. The bounded
matcher still determines the final result and retains all four line-terminator
exclusions. No wildcard pattern is compiled into a backtracking regex.

## Paired Measurements

The baseline Worker was loaded from HEAD into one Node VM and the modified
Worker into another. Both loaded the same compact payload. Measurements are
three-run medians, alternating old/new, with query-order caches cleared before
each page-one request. After timing, every remaining page was requested;
complete ordered IDs and totals were identical for each query.

| Query | Before (ms) | After (ms) |
| --- | ---: | ---: |
| `手*机` | 1270.05 | 151.55 |
| `手?机` | 1305.61 | 153.84 |
| `*文*` | 1212.24 | 234.97 |
| `A?C` | 1202.37 | 301.79 |
| `*` | 415.71 | 405.66 |

The all-wildcard case is essentially unchanged. These numbers are informative
measurements, not performance thresholds or real-phone responsiveness claims.

## Verification

- Worker contracts: 41 cases passed, including deterministic comparison with
  the former regex over Unicode, UTF-16, punctuation and line terminators.
- Static contracts: 35 cases passed.
- Independent local corpus oracle: 11 cases passed, comparing IDs and totals.
- JavaScript syntax check passed.
- Real Chromium browser smoke: 40 cases passed.

Runnable project commands:

```bash
node tests/test_worker_contract.js
node tests/test_corpus_oracle.js
node tests/test_benchmark.js
python3 -B -m unittest tests.test_browser_smoke -v
```

Repeated-query medians in the standard benchmark predominantly measure cached
queries; uncached A/B is the relevant comparison for wildcard matching cost.

# Next-Page Performance

## Baseline (2026-10-09)

- Local baseline ref: `refs/baselines/next-page-20261009`.
- Commit: `2cce24511fc62153d6d16f6474004607eb92e8f9`.
- Baseline runtime source: `git show refs/baselines/next-page-20261009:static/app.js`.
- The ref preserves the committed source independently of future branch movement.
- Existing uncommitted Reader styles, Reader code and Reader tests were present;
  they are not part of this pagination baseline.

The baseline waits for the saved-page lookup before starting API prefetch, checks
only the bottom after prefetch completion, has no ordinary local Worker prefetch,
and starts scroll-triggered pagination after rendering the current window.

## Acceptance

Keep exact ordered IDs, totals, generation validation, query cancellation, the
5% append threshold, three-page/two-request API lookahead, one-page local
lookahead, and deferred application during thumb dragging. A ready-page arrival
must not repeatedly append at an unchanged non-bottom scroll position.

All timing observations below describe controlled local fixtures, not production.
The baseline ref is local and is not automatically published by a normal push.

## Implementation

- Nearest API page: allow 25 ms for an IndexedDB hit before starting transport;
  farther speculative pages and position restoration retain their 150 ms lookup.
  Memory hits and fast disk hits still avoid network requests. Timed-out reads
  cannot replace the response subsequently used for that prefetch.
- Ready-page checks use the existing 5% threshold even away from the bottom.
  Only the immediately next page may schedule this check. Repeated arrivals at
  the same non-bottom logical offset cannot drain the prefetch buffer. Short
  lists still automatically fill the viewport.
- Local Worker lookahead retains one next page and at most one speculative
  request. Foreground demand joins that task or consumes its cached result;
  failed speculation does not block a fresh demanded retry. Changed-generation
  responses go through the existing foreground relocation path, not stale cache.
- Start scroll-triggered pagination before scheduling window rendering. Multiple
  scroll events remain coalesced, and thumb dragging still defers application.

## Repeatable Regression

Run from this project's root:

```bash
node tests/test_next_page_latency.js
node tests/test_next_page_latency.js --compare-baseline
node tests/test_page_generation.js
node tests/test_response_cache.js
python3 -B -m unittest tests.test_prefetch_pipeline tests.test_paging_recovery tests.test_scroll_stability -v
python3 -B -m unittest tests.test_api_integration tests.test_search_positions tests.test_recent_search_pages -v
```

The Node latency suite exercises both projects' actual functions with a fixed
clock. Comparison reads the old source directly from the retained Git ref;
it never checks out or replaces working files. For reviewing only pagination:

```bash
git diff refs/baselines/next-page-20261009 -- static/app.js
```

Do not restore the entire baseline tree over newer Reader work. The retained
baseline is intentionally fixed; do not repoint it for subsequent comparisons.

## Observations (2026-10-09)

| Controlled fixture | Baseline | Current |
| --- | --- | --- |
| Stalled IndexedDB, next-page transport start | 150 ms | 25 ms |
| Scroll-triggered request starts before window paint | No | Yes |
| Ready next page at 5%, without another scroll event | Not appended | One page appended |
| Ordinary local page-2 prefetch | None | One shared Worker task |

The 125 ms difference is eliminated cache-wait time in a stalled-disk fixture,
not an end-to-end or production latency claim. The real Chromium case confirms
that a page arriving after drag suppression is removed applies above the
threshold without a new scroll event, and leaves later cached pages buffered.
The real Worker case compares all 200 ordered result IDs and confirms one
page-2 request shared with foreground demand.

- Fixed-clock latency regression: 16 cases passed across both projects.
- Prefetch, paging recovery and scroll stability: 22 browser cases passed.
- API integration, positions and recent-page storage: 44 browser cases passed.
- Worker contracts: 48 passed; page-generation: 6 passed; response-cache: 2 passed.
- Full static contracts: 34/35 passed. The remaining Reader case requires the
  literal `docx.renderAsync`, absent from the pre-existing dirty `static/reader.js`.
  This report does not treat that unrelated Reader contract as a pagination pass.
- Local preview: `http://127.0.0.1:8792/search/`.

## Publication

Publication requested on 2026-10-10. The release is applied to the latest remote
branch in an isolated worktree, retaining remote Reader/index changes and local
uncommitted Reader work. The deployment commit is identifiable by
`perf: reduce next-page display latency`; deployment workflow and read-only
production acceptance are verified separately after push.

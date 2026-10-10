# Next-Page Performance

## Snapshot And Anchor Follow-Up (2026-10-10, Local Only)

Implemented locally; this section is not a publication receipt.

- Global capture is restricted to result-affecting filter changes/actions. Query
  submission and route navigation retain their explicit pre-mutation saves.
  Search-input focus/click, theme/history settings and folder expansion do not
  capture complete result snapshots.
- First-page rendering seeds a weak, result-array-owned UTF-8 byte ledger.
  Ordinary append accounts for the new page only. Above the existing 8 MiB
  snapshot budget, skip complete result cloning and retain the negative size
  decision across later appends/height changes. Lightweight positions, recent
  pages and viewport previews still save independently.
- Sparse bodies count JSON null placeholders exactly; materializing a page
  invalidates their ledger. Snapshot restore transfers the known body size to
  its independently cloned active results. Positive sizes are exact; an early
  over-budget stop stores only a sufficient lower bound.
- Height snapshots use the measured-height map, not a full result-ID scan.
  Immutable height entries and encoded entry costs are weakly reused; changed
  measurements create new entries, leaving prior snapshots independent.
- Worker anchor lookups retain at most eight order-owner tokens with eight
  anchors each. Keys longer than 4,096 UTF-16 units bypass this cache without
  changing lookup results. Tokens do not retain evicted order arrays; corpus
  replacement clears ownership. Hits, misses and original first-match order
  are preserved across page/page-size changes.

Controlled local Chromium observations, three runs per site:

- In the original injected 50,000-row fixture, rejected unchanged snapshots
  previously took 73-120 ms. Current repeat saves took 0-0.3 ms; search-input
  clicks triggered zero snapshots and took 0-0.2 ms at that depth.
- Stable-ID calls during a height-only save fell from 50,001 to one (the
  lightweight position anchor). At 10,000 rows, current height-only saves took
  0-0.2 ms. Measured rows, not the reserved/loaded result depth, are inspected.
- A separate continuous-paging fixture appends 499 pages of 100 records after
  page 1. At 50,000 records/index 40,000, the size rejection is already known:
  first save took 1.5 ms in all three runs, repeat saves 0 ms, and the median
  append/geometry call took 0.2 ms. Saved index remained 40,000.
- Injecting all 50,000 rows at once bypasses first-page accounting and still
  requires a one-time size scan (69-95 ms in the final Pages run). No claim is
  made that arbitrary cold snapshots are constant-time, or that these local
  timings describe production or a physical phone.
- Measurement script: `/tmp/opencode/search_remaining_profile.py`.

Verification: shared snapshot-budget 10/10, Worker 49/49, static 35/35,
fixed-clock pagination 26/26, page-generation 6/6 and response-cache 2/2.
Focused Chromium: positions/scroll/sidebar 37/37; prefetch/footer/sparse-window/
recent-pages 62/62. UTF-8 accounting, sparse mutation invalidation, old-snapshot
independence, zero neutral-control captures, bounded anchor retention and
cross-page scan-free anchor reuse have dedicated regressions.
Current-source local preview: `http://127.0.0.1:8794/search/` (HTTP 200 checked).

```bash
node tests/test_snapshot_budget.js
node tests/test_worker_contract.js
python3 -B -m unittest tests.test_search_positions tests.test_scroll_stability tests.test_sidebar_keyboard -v
python3 -B -m unittest tests.test_prefetch_pipeline tests.test_position_controls tests.test_position_window tests.test_recent_search_pages -v
```

## Follow-Up (2026-10-10, Local)

Implemented after the first production release and published on 2026-10-10.
No dedicated old-version baseline is retained.

### Follow-Up Publication

- Local implementation commit: `3af4a68`; published commit:
  `4782ba05d6660caea88a8f7b109cc4df3a6759e9`.
- Pages workflow `38012198149`: success.
- Deployed app: `/search/static/app.6e187ed75255.js`.
- Clean release checks: static contracts 35/35, shared fixed-clock regressions
  26/26, browser pagination/scroll/sidebar regressions 37/37.
- Documented production smoke: passed. Read-only desktop Worker and mobile API
  browser checks preserve first-200 order/total and display row 101.
- Deployed-code synthetic 50,000-row fixture at index 40,000: sidebar toggles
  produce zero snapshots and preserve the current index on desktop and mobile.
  This is not a production corpus count or a real-device latency guarantee.
- Production acceptance script: `/tmp/opencode/next_page_production_acceptance.py`.
  This receipt was updated locally after successful deployment.

- A farther page promoted to the immediately next page stops its remaining
  IndexedDB wait and starts/joins transport through the existing request owner.
  API lookahead remains three pages with at most two active tasks. Late disk
  callbacks cannot overwrite the chosen response; cancellation releases waits.
- Page records become available for application before response-cache accounting.
  Deferred writes are capped at three pages, remain readable before maintenance,
  and run in a timer after an animation-frame opportunity. Shared response clones
  carry weak identity tokens so prefetch/demand encode one body once; distinct
  responses with the same first record are not mistaken for identical bodies.
  Query changes clear the queue; ordinary cache byte/TTL limits still apply.
- Appending beyond the current viewport's maximum overscan updates heights and
  the scrollbar without invalidating visible rows. Near-boundary appends and
  sparse restored windows retain rendering; newly appended rows remain reachable.
- Deep-sidebar stall: the global capture listener previously saved a full result
  snapshot before sidebar clicks. Snapshot construction scans height records,
  clones result objects and JSON-encodes content, scaling with loaded depth.
  Hamburger, filter-panel, wide-sidebar and overlay controls now skip this work;
  Escape closing an open sidebar also skips it. Filter/query/route controls retain
  their existing snapshot paths.

Verification uses current code and controlled local fixtures, not production:

- Fixed-clock regression: 26 cases passed across both projects. Promotion at
  fixture time 25 ms starts page 3 then, instead of leaving its 150 ms disk wait.
- Chromium pagination/prefetch/scroll/sidebar: 37 cases passed.
- API integration/positions/recent pages/footer controls: 65 cases passed.
- Browser checks prove rendering precedes the shared page's single cache write,
  a far append causes zero window renders and preserves nodes, and page 11 is
  still displayable afterward.
- 50,000 loaded results at a deep position: six sidebar toggles plus Escape
  produce zero full snapshots, retain index/count, and filter changes still save.
- Page-generation: 6 passed; response-cache budget: 2 passed.
- Static contracts now pass 35/35: DOCX checks the current parse/render API and
  PDF fallback checks the current committed Reader variable names.

```bash
node tests/test_next_page_latency.js
python3 -B -m unittest tests.test_prefetch_pipeline tests.test_paging_recovery tests.test_scroll_stability tests.test_sidebar_keyboard -v
python3 -B -m unittest tests.test_api_integration tests.test_search_positions tests.test_recent_search_pages tests.test_position_controls -v
```

## Baseline Retirement (2026-10-10)

After production acceptance and user confirmation, the dedicated old-version
Git reference and comparison runner were removed. Current-version regression
tests and the historical measurements below remain available. Normal Git
history is retained.

The clean temporary release worktree and its merged deployment branch were
also removed after acceptance. Published commits remain in remote history.

## Acceptance

Keep exact ordered IDs, totals, generation validation, query cancellation, the
5% append threshold, three-page/two-request API lookahead, one-page local
lookahead, and deferred application during thumb dragging. A ready-page arrival
must not repeatedly append at an unchanged non-bottom scroll position.

All timing observations below describe controlled local fixtures, not production.

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
node tests/test_page_generation.js
node tests/test_response_cache.js
python3 -B -m unittest tests.test_prefetch_pipeline tests.test_paging_recovery tests.test_scroll_stability -v
python3 -B -m unittest tests.test_api_integration tests.test_search_positions tests.test_recent_search_pages -v
```

The Node latency suite exercises both projects' current functions with a fixed
clock and does not require any retained old-version source.

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

The clean release worktree passes all 35 static contracts after aligning the
PDF fallback assertions with the committed Reader's `contentUrl/sourceUrl`.
The earlier 34/35 result above describes the local dirty development snapshot.

## Production Acceptance (2026-10-10)

- Published runtime optimization: `55b585a` (local development commit `2a74ed6`).
- Final remote revision: `5b5e579967ac2151f9f8ea07d2f31e83f9a67a6b`.
- Pages workflow: `38009390310`, completed successfully.
- Deployed app: `/search/static/app.695f6231ac90.js`.
- Clean release static contracts: 35/35 passed after correcting the PDF test's
  variable names to the committed Reader's `contentUrl/sourceUrl`.
- Clean release prefetch/paging browser regressions: 16 passed.
- Documented production page/API smoke: passed.
- Read-only Chromium: desktop local Worker and 390px mobile API mode both
  prefetch page 2, append at the existing threshold, preserve the first 200
  ordered IDs and total, and display row 101 when scrolled into page 2.
- Browser errors: none. Screenshots: `/tmp/opencode/next-page-github-local-desktop.png`
  and `/tmp/opencode/next-page-github-api-mobile.png`.
- Live check: `/tmp/opencode/next_page_production_acceptance.py` also checks the
  deployed budget and request-before-render ordering. Its wall times include
  browser observation and screenshots; they are not display-latency benchmarks.
- Deployment used a temporary worktree, removed after acceptance.
  The original local branch and unrelated Reader changes remain intact.
- This acceptance receipt was added locally after release. The published
  report contains the original baseline notes, implementation and regression commands.

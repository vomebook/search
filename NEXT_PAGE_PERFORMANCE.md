# Next-Page Performance

## Selection Scroll Follow-Up (2026-10-10, Local Only)

Prepared for publication on 2026-10-10 after the deep-restore follow-up.
This section records local implementation and measurements; production acceptance
is recorded separately after publication.

- Virtual-window updates call `updateVisibleSelection`, touching only rendered
  checkboxes/row classes. Full `updateSelectionUI` remains on selection, mode,
  query-reset and snapshot-reset events, keeping exact counts and toolbar state.
  No selection-count cache or new retained index is introduced. HF also updates
  the reset selection UI immediately when beginning a fresh query.
- In a 50,000-record synthetic fixture with all records selected, 20 window
  updates previously enumerated 1,000,000 selected keys. Current window updates
  enumerate zero selected keys and do not rewrite count/button text. All visible
  rows still reflect current membership; full selection remains accessible.

Three local Chromium samples/site, median selection-sync time for 20 updates:

| Site | Before | Current |
| --- | ---: | ---: |
| Pages | 75.4 ms | 2.8 ms |
| HF | 63.2 ms | 3.6 ms |

These timings isolate the selection function inside synchronous window updates;
they are not complete scroll/paint latency, network performance or real-phone
guarantees. Whole-window timing varies substantially with DOM/layout/JIT work.
Counts are synthetic, not production corpus sizes. Runner:
`/tmp/opencode/search_selection_profile.py`.

Verification: Pages scroll/positions/sparse-window Chromium 52/52; HF 50/50;
four additional 390px/320px selection cases pass. The new regression checks zero
key scans/toolbar text mutations during scrolling, all visible selected rows,
50,000/49,999 counts, clear, selected filename/link pairing and immediate fresh-query
reset. Existing cases retain sparse/deep selection, anchor/offset, cancellation,
generation and drag behavior. App syntax and diff checks pass. Static checks are
Pages 34/35 and HF 28/29, with the same independent Reader TXT source-assertion gap;
neither complete static suite passes. Mobile runner:
`/tmp/opencode/search_selection_mobile.py`; screenshots:
`/tmp/opencode/search-selection-{github,hf}-{390,320}.png`.

Position saving already has offset/content reuse, bounded storage and pruning.
Hidden-directory checkbox refresh remains a lower-priority measured candidate
(see rendering/filter follow-up). Publishing the accumulated local changes and
read-only production acceptance is the next useful verification layer.

## Deep Restore Follow-Up (2026-10-10, Local Only)

Prepared for publication on 2026-10-10 after the rendering/filter follow-up.
Local measurements and production acceptance remain separate.

- `renderResults` renders the restored logical target directly, without first
  reconciling an empty list. `setResultScrollTop` has an explicit restore-window
  option that seeds the target's scroll sample before rendering. A programmatic
  jump no longer creates velocity-only overscan. Ordinary scrolling/dragging keeps
  the existing direction/velocity rules and bounded native segment.
- Reader-return restoration can reuse a window rendered immediately beforehand.
  Standalone calls and subsequent retry frames retain explicit remeasurement;
  legitimate height corrections can still require another render.
- Background snapshot cloning now preserves a row/offset anchor when cached
  heights outside the initial prepared neighborhood change. Apply Fenwick deltas
  to the existing tree and compensate scroll once per batch. File actions batch
  their materialization the same way; changed result ownership cannot mutate the
  new view's geometry. Full copies, cancellation and existing budgets remain.

Local stage profiling found DOM construction/layout to dominate the synchronous
restore. For 30,000 records at index 24,000, preparing 600 independent records
took about 0.2-0.8 ms; height initialization took about 0.9-3.5 ms. The sampled
desktop window went from 60 rows and three reconciliation calls (including an
empty window) to 38 rows and one call; 390px went from 58 to 37 rows. This is
ordinary buffered rendering, not a restriction on accessible results. All 30,000
records subsequently complete, with the same index and row offset.

Three-sample current synchronous-call medians, milliseconds:

| Records | Pages Desktop | HF Desktop |
| --- | ---: | ---: |
| 1,000 | 23.2 | 26.2 |
| 10,000 | 27.8 | 16.2 |
| 30,000 | 18.8 | 25.8 |

At 30,000 records, the 390px medians were Pages 27.1 ms and HF 20.0 ms. These
are instrumented local synthetic observations, not paint/end-to-end times or
physical-phone guarantees. Scheduling/JIT/layout variation is substantial; no
production percentage improvement is claimed. The pre-edit Pages profile also
exposed offset drift and is not treated as a valid equivalent restoration oracle.
Runner: `/tmp/opencode/search_restore_stages.py` (use `--brief`, `--mobile`).

The deterministic regression caches taller rows 150/350 outside the prepared
pages, then restores row 4,000. Disabling compensation only in a disposable
desktop fixture reproduced row 3,998; current code keeps row 4,000 and its offset
within two pixels. Shared geometry tests also verify independent clones, one
batch/file-action compensation, smaller-row offset clamping, tree identity reuse,
obsolete-layout rejection and stale-owner cleanup.

Verification: shared geometry 8/8, snapshot budgets 10/10, latency 36/36 and
state/filter contracts 10/10. Focused Chromium: Pages 94/94 and HF 83/83, plus
eight explicit 390px/320px restore-window/height cases. Coverage includes complete
deep copies, selections, cancellation, sparse previews, Return controls, recent
pages, generation validation, prefetch/drag ownership and bounded-segment scrolling.
Both app syntax and diff checks pass. Static checks still have the independent
Reader TXT source assertion gap: Pages 34/35, HF 28/29; neither full suite passes.
Mobile runner: `/tmp/opencode/search_restore_mobile_acceptance.py`; screenshots:
`/tmp/opencode/search-restore-{github,hf}-{390,320}-{window,heights}.png`.

## Rendering And Filter Follow-Up (2026-10-10, Local Only)

Prepared for publication on 2026-10-10 after the interaction publication below.
This section records local measurements, not production acceptance.

- Result-template cache validation now belongs to `reconcileVirtualRows`, before
  existing rows are checked for reuse. A 60-row batch builds the complete filter
  key once rather than 60 times. Invalidated caches receive that same key instead
  of encoding it again. Unchanged rows retain their nodes; changed query, aliased
  filter contents and mirror settings invalidate all old row versions together.
- `mergeFolderFilters` uses one Set of self paths for membership. It preserves
  original self/subtree order, duplicates within each input, empty self paths and
  input ownership. Persisted normalized selection reuses that projection while
  excluding empty subtree paths. Root direct-file selection and the existing
  10,000-item per-selection limit retain their behavior.

Local Chromium, three samples/site, median synchronous time in milliseconds:

| Fixture | Pages Before | Pages After | HF Before | HF After |
| --- | ---: | ---: | ---: | ---: |
| 60 new rows, 10,000 filter paths | 38.0 | 9.6 | 55.9 | 13.5 |
| Merge 5,000 self + 5,000 subtree paths | 526.8 | 0.8 | 716.4 | 0.7 |
| Persist the same flat-path selection | 163.3 | 4.2 | 136.0 | 5.0 |

Measurements used the current checkout immediately before/after edits, not a
retained old-version source or randomized A/B. First-call/JIT variance is large;
these synthetic fixture sizes are not production counts. Row measurements include
DOM construction but exclude eventual paint. Persistence uses an empty folder tree
and suppressed search scheduling, isolating path work (HF retains URL sync). No
end-to-end network or physical-phone performance guarantee is inferred. Runner:
`/tmp/opencode/search_third_profile.py`.

Verification: shared state/selection 10/10, latency 36/36, snapshot budgets 10/10;
both folder-membership oracles pass all 2,048 combinations. Browser scroll/sidebar/
positions/prefetch: Pages 49/49, HF 48/48; four additional 390px/320px row-cache
cases pass. Ordered row indices, complete deep copies, query cancellation and
generation/prefetch guards remain covered. Both app syntax and diff checks pass.
Static checks: Pages 34/35 and HF 28/29. Each failure is the Reader TXT source
assertion for `pre.textContent = new TextDecoder(...).decode(bytes)`, absent from
the current independently edited Reader; it is not a full static-suite pass.
An initial parallel HF browser run lost its temporary server; all seven affected
scroll cases passed in a standalone rerun. Screenshots:
`/tmp/opencode/search-third-{github,hf}-{390,320}.png`.

Remaining candidates: checkbox refresh still visits already-created hidden rows;
with 5,001 nodes under a collapsed parent, three samples took Pages 6.7-8.8 ms and
HF 5.6-11.8 ms (`/tmp/opencode/search_folder_refresh_profile.py`). This is a lower
priority than the eliminated quadratic merges. Deeper restore layout/height work
needs a separate stage profile before another change. Ordinary append after a
completed dense snapshot already inspects the new range, not every old result;
the full enumeration branch is specific to sparse-window/active-clone growth.

## Interaction Publication (2026-10-10)

- Published/current remote revision: `6b7296c4c7d65f7ff9194bbb55996ca8dbc719d3`,
  based on `f4eed9cfc416da39b0e87f485e2948f85c58d9f5`.
- Pages workflow `38019258647`: completed/success. Deployed app:
  `/search/static/app.5074b38232fd.js`.
- Release merged seven scoped files in an isolated latest-remote worktree;
  the current Reader resource/inversion release and generated index are retained.
- Clean release validation: latency 36/36, state/selection 6/6, snapshot budget
  10/10, static 35/35, folder-membership oracle (2,048 combinations), and
  positions/sidebar Chromium 34/34. JavaScript syntax and diff checks passed.
- Documented page/external-API production smoke: passed. Real desktop Worker and
  mobile API queries preserve the first 200 ordered IDs/total and display row 101.
  Worker anchor hit/miss reuse and prior 50,000-row snapshot/sidebar guards pass.
- Disposable desktop/390px browser fixtures on deployed code confirm sparse
  budgets 25/150 ms, one-time promotion/shared ownership/cancellation; 100 unchanged
  view-key reads encode once, with an aliased edit causing a second encoding.
- The 5,000-record snapshot fixture initially prepares 600 records at index 4,000,
  then completes all independent records. Far jumps, full selection, file actions
  and cancellation retain the complete source. Folder admission initially creates
  32 child rows, then reaches all 1,000; collapse cancels and reopened descendants
  resume with current selection. No browser page errors.
- Acceptance scripts: `/tmp/opencode/interaction_production_acceptance.py` and
  `/tmp/opencode/next_page_production_acceptance.py`. Screenshots:
  `/tmp/opencode/interaction-production-github-{desktop,mobile}.png`.
  Synthetic fixture sizes/timings are not production counts or phone guarantees.
- This receipt was updated locally after acceptance. The published report contains
  the implementation and local measurements below.

## Interaction Follow-Up (2026-10-10, Local Only)

Implemented after the snapshot publication below and published on 2026-10-10.
Timing observations in this section remain local-only.

- Sparse visible-page demand uses a 25 ms disk budget; speculative reads retain
  150 ms. Promotion aborts the speculative disk wait exactly once, retaining the
  same request promise and slot. Repeated foreground checks leave fast disk hits
  eligible. Window cancellation releases the wait/listener; late disk data does
  not replace transport. The existing three-slot demand bound and generation
  validation are retained.
- View keys memoize canonical sorting/encoding with all existing fields. Scalar
  and filter-content equality is checked before reuse, including in-place edits
  through retained aliases; the equality check is linear, not an O(1) revision
  shortcut. Layout, paging and inactive plain-folder changes do not re-encode.
- Directory full/partial selection is computed once in iterative postorder with
  inherited subtree coverage. Normalization preserves complete file membership.
  Rendering/checkbox refresh reuse a current-tree/current-selection lookup.
  Directory DOM admission uses one queue, at most 32 rows and a 4 ms soft budget
  per batch. Collapse and route/tree replacement cancel pending rows; reopening
  resumes interrupted expanded descendants and uses the latest selection.
- Snapshots with more than 2,000 materialized records clone page 1 and the saved
  anchor's five-page neighborhood before rendering. Remaining independent copies
  use at most 256 records/4 ms per timer batch after a frame opportunity. Visible
  jumps materialize their own range immediately. Sparse height geometry avoids
  initial full-body ID/height initialization. Cancellation cannot save partial
  content over the complete source snapshot. Bulk selection sees the complete
  source, and file actions materialize their selected records. Ordinary append
  resumes after completion, retaining the 5% threshold and bounded prefetch.

Controlled local Chromium observations (three runs/site, synthetic fixtures):

| Operation | Earlier observation | Current observation |
| --- | --- | --- |
| Stalled disk, sparse demanded transport | ~150 ms | ~25-26 ms |
| 3,280-node selection normalization | 24,604 visits; 27-54 ms | 3,280 visits; 2-6 ms |
| First synchronous expansion of 1,000 children | 24-46 ms | 1.6-2.7 ms; remaining rows admitted in batches |
| 5,000 filters, 100 unchanged view-key calls | 71-114 ms | 3.7-4.5 ms |
| Restore 30,000 records, synchronous call | 30,000 clones; 43-71 ms | 600 clones; 30-42 ms |

The final restoration completes all copies asynchronously; its synchronous number
is not an end-to-end restoration benchmark. Layout still contributes to that call.
All records and exact totals remain accessible. These are local observations, not
production or physical-phone latency guarantees. Script:
`/tmp/opencode/search_second_profile.py`.

Verification: shared latency 36/36; shared state/selection 6/6; independent folder
membership oracle covers 2,048 combinations. Snapshot budget 10/10, Worker 49/49,
static 35/35, page-generation 6/6 and response-cache 2/2 also pass. Focused Chromium:
positions/windows/sidebar 57/57, controls/scroll 28/28, recent-pages/prefetch 18/18;
four explicit 390px deep-restore/directory cases pass. Screenshots:
`/tmp/opencode/search-interaction-github-mobile.png`.

```bash
node tests/test_next_page_latency.js
node tests/test_search_interaction_state.js
node tests/test_folder_selection.js
python3 -B -m unittest tests.test_search_positions tests.test_position_window tests.test_sidebar_keyboard -v
python3 -B -m unittest tests.test_position_controls tests.test_scroll_stability -v
python3 -B -m unittest tests.test_recent_search_pages tests.test_prefetch_pipeline -v
```

Current-source preview: `http://127.0.0.1:8794/search/`.

## Snapshot Publication (2026-10-10)

- Published optimization: `dcde38fa0a09233863f5a5a3ebca70c64b605652`, based on
  `4782ba0`. Pages workflow `38015369885`: completed/success.
- The automatic Reader-index-only follow-up `4d9c4c046634f44219e3197c99eaceba66bbc748`
  is a direct child of this release. Its workflow `38015385775` also succeeded;
  the final checked remote revision is that child. Search runtime is unchanged.
- Deployed app: `/search/static/app.1ec4efab6dbd.js`.
- Isolated current-remote release checks passed: shared snapshot-budget 10,
  Worker 49, static 35, page-generation 6, fixed-clock pagination 26, and
  position/sparse-window/prefetch/sidebar Chromium 60.
- Documented GitHub page/external-API production smoke: passed. Desktop local
  Worker and 390px mobile API checks preserve first-200 order/total and display
  row 101. No browser page errors.
- Actual deployed Worker: cached hit and missing-anchor requests across pages
  still succeed when its selected order's `findIndex` is made to throw inside
  the disposable browser fixture. The original method is restored afterward.
- Deployed-code 50,000-row memory fixtures at index 40,000: sidebar/search-input/
  theme controls capture zero snapshots; oversized bodies are rejected, repeated
  saves encode nothing, and the index/count stay fixed. Smaller height-only
  snapshots reuse their result body and obtain one stable ID for position saving.
  These fixtures are not production corpus counts or real-device latency claims.
- Acceptance script: `/tmp/opencode/next_page_production_acceptance.py`; screenshots
  `/tmp/opencode/next-page-github-local-desktop.png` and
  `/tmp/opencode/next-page-github-api-mobile.png`.
- Publication used an isolated latest-remote worktree. This receipt was updated
  locally after acceptance; the published report contains the implementation and
  local measurement notes below.

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

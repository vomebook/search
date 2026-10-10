# Reader Retention And Search Reuse

## Resource Followup (Released, 2026-10-10)

Both development checkouts now additionally implement:

- A shared retained-pixel budget for PDF canvases, decoded page images and decoded
  speculative images, equivalent to 32 MiB RGBA on reported low-memory devices,
  48 MiB on mobile and 96 MiB on desktop. Existing page-count limits also apply.
  Speculation and distant pages are reclaimed first. Visible/current pages and
  selection ranges may exceed this soft target. It is not a browser-heap limit.
- DOCX `content-visibility:auto` and intrinsic page size, retaining all DOM/text
  for exact search, navigation and selections. A real twenty-page fixture verified
  skipped offscreen descendant rendering, all twenty hits, last-page highlights
  and return to the first page. Parsing and retained DOM are unchanged.
- Native PDF two-page ordered text lookahead, with a shared mobile two-slot or
  desktop three-slot extraction queue and one reserved demand slot. Search totals,
  result order and pagination stay exact. Cancelled queued extractions release
  their ownership before a same-page foreground retry; active work keeps its slot
  until settlement, and obsolete searches cannot publish late totals.

Related browser acceptance passed: HF 53 and Pages 45 distinct cases across
optimization/style, native PDF search, PDF loading/closure and HF legacy hybrid
theme checks. Architecture contracts, content-hashed builds and cross-site
resource checks passed. These are local correctness checks, not production timing
or heap measurements.

Application releases: HF `7ba0c5705d955ccbe039b3f21d1916571d1c9b43` and Pages
`00e57cac8ae03ad16ec879147f017ce690110302`. The single PDF ownership-fixture
followup ended at HF `c2e62abd4951a3b0ae6974134edbb98bcf6db8f6` (RUNNING) and
Pages `c954ee1941419e85c2d0669c6c1716c4992c1c63` (deployment successful).
Reader CI `38016506982` passed both jobs, including complete HF 92 / Pages 93
Reader suites. The first run exposed a fixture that reused a now-cached page and
assumed extraction started after one microtask. It now uses an uncached page and
awaits actual extraction startup before disposal; all cleanup assertions remain.

Default-cache, active-Service-Worker production Chromium accepted four real PDF
opens (both sites at 1100/390px), exact 38-hit search against independent all-page
PyMuPDF extraction, and preserved canvas pixels and selection across inversion.
Both sites also rendered a real 42-page DOCX with the offscreen policy and exact
533-hit rendered-text search. These are selected sample counts, not corpus totals.
Both production smoke layers and deployed JavaScript/CSS hash checks passed.
Concurrent search updates and generated Reader indexes were retained; local v3
development was not included. Documentation successors contain no runtime changes.

CI: https://github.com/vomebook/search/actions/runs/38016506982

## Local Implementation (2026-10-09)

Implemented in the HF and GitHub Search development checkouts. This report
describes the pre-deployment fixtures and builds. Final release acceptance follows below.
Existing concurrent search/paging publications were retained as the new baseline.

- Chapter scheduling has three active slots, with at most two speculative loads.
  Demand is promoted ahead of queued speculation, obsolete windows are cancelled,
  and hidden-page/disposal events release speculative ownership. Cancelled creates
  retain their active slot until settlement; late completion cannot delete a newer
  request or insert discarded content.
- Chapter bundles reuse the existing section virtualizer and scroll anchors, with
  a twelve-loaded-chapter target. Visible/nearby chapters, focused content, native
  selection ranges and selected search highlights remain protected. Evicted
  chapters retain equal-height placeholders and can reload through ordinary
  navigation or complete-index search. Retained byte reservations are released
  on eviction/closure. A formatting context prevents heading/paragraph margin
  collapse from causing height drift during replacement.
- The pinned DOCX engine parses and renders through its public API. Its parsed
  document owns path-deduplicated image/font/numbering Blob URLs; failures and
  disposal revoke them, and late resource creation is suppressed. Real TTF loading
  verifies the matching same-origin/Blob font CSP policy. No global URL API is
  replaced by runtime code.
- DOM search retains one complete text snapshot across queries, accounting for
  UTF-16 text and text-part metadata within 8 MiB and 32,768 parts. It retains
  stable parent/checkpoint metadata, not text nodes invalidated by highlighting.
  External mutations, streaming appends, page-label changes and TOC replacement
  disable reuse. Edits during asynchronous cached scanning cause a fresh scan.
  Oversized documents remain fully searched without caching. Disposal clears the
  snapshot; result totals, matching rules and accessible result pages are unchanged.

## Controlled A/B Observations

The committed pre-change Reader was replayed against the working-tree Reader in
fresh Chromium contexts. DOM measurements used six alternating rounds per site,
16,000 ordinary paragraphs, an early cross-query match and a tail match. Timing
covers the actual Reader search routine, not network transfer. Both variants
returned the same exact totals and visible selected text.

| Site | First Search Before/After | Repeated Search Before/After | Repeated Text-Node Visits |
| --- | --- | --- | --- |
| HF | 153.55 / 155.10 ms | 156.75 / 1.55 ms | 16,005 / 2 |
| Pages | 157.15 / 151.65 ms | 171.45 / 1.70 ms | 16,005 / 2 |

Both sites' 60-chapter navigation fixture retained 60 loaded chapters before,
versus 12 after, with lightweight placeholders for previously loaded content.
This is a DOM retention observation, not a measured heap reduction percentage.

A real pinned-engine DOCX fixture repeated one 788,084-byte PNG three times.
Before, the three data-URL attributes contained 3,152,406 characters in total.
After, all three rendered images shared one 788,084-byte Blob URL; their attributes
totalled 192 characters. This measures resource representation and URL reuse,
not total browser memory or a production loading-speed percentage.

Desktop (1100px) and mobile (390px) screenshots confirmed all three images render
without overlapping Reader controls. Separate regressions verify embedded-font
loading, URL revocation, blocked late creation, failed chapter reload recovery,
cross-chapter selections, exact full-book totals and last/first chapter navigation.

## Verification

- Six focused optimization browser cases passed on each site, without skips.
- Existing chapter browser regressions passed: fifteen per site.
- Existing DOM search/navigation regressions passed: seven per site.
- Format preparation, mocked DOCX, ZIP admission and chapter resource/loading
  regressions passed on their corresponding site-specific fixtures.
- Scheduler ownership/promotion/cancellation contracts passed on both sites.
- Both content-hashed esbuild 0.28.2 artifacts passed their release gates; the
  shared-source cross-project gate passed. Generated artifacts stay in `/tmp/opencode`.

Detailed commands and required workflow steps are in each project's `TESTING.md`.
The local A/B measurements above remain distinct from production acceptance.

## Release Acceptance (2026-10-10)

- HF application release `0e3343ff8d013af4a5a8643f2c670e4dde07abcd` uploaded twelve
  reviewed files with matching SHA-256 checks. Test-only follow-ups ended at
  `90d147ef60c45fdb65c8968b93d13e8ff7946a05`, verified RUNNING.
- Pages application release `1df9ce9f055a09c46d87af286f1151f062a6af07` and test-only
  follow-ups ending at `3c0ee5b4d6608d1c0223faf1d95faf81141fad3e` deployed successfully.
- Required Reader CI `38011336725` passed both jobs: full Reader suites HF 92
  and Pages 93 cases; request/PDF-loading/closure/navigation gates HF 33 and
  Pages 27 cases; six optimization cases per site; PDF theme/chapter-search
  gates; and HF backend/upstream ownership gates of 34/59 cases. No failing
  assertions were removed or skipped. Earlier runs exposed a stale string-based
  Foliate pause fixture and a chapter-test race before the animation-frame
  prefetch queue started. Fixtures now use the current traversal and await both
  frames and queue settlement before creating/asserting eviction pressure.
- Default-cache, active-Service-Worker Chromium checked a real 24-chapter EPUB:
  navigation through chapters 1, 6, 12, 18, 24 and back to 1 retained at most
  twelve loaded chapters on both sites; twelve placeholders remained, and return
  navigation passed. Real EPUB/CHM complete-index searches matched independently
  verified index totals and last-hit highlights (selected EPUB 1,858/10,348 hits;
  CHM 65/132 hits). These are sample counts, not corpus totals.
- HTM, Markdown, TXT and DOCX on both sites matched independent rendered-text
  totals, all result-page labels and repeated last/first/last highlight offsets.
  All eight production opens had no page errors. EPUB/DOCX/TXT/HTML closure on
  both sites recorded zero new Reader-body requests/encoded bytes in 1.8-second
  windows after a 200 ms delivery grace; ordinary search background work is excluded.
- Both documented production smoke layers passed. Other sessions' search,
  paging, pipeline and generated-index publications were preserved.

CI: https://github.com/vomebook/search/actions/runs/38011336725

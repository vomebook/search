# Reader Retention And Search Reuse

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

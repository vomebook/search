# Reader Retention And Search Reuse

## Local Implementation (2026-10-09)

Implemented in the HF and GitHub Search development checkouts. This report
describes local fixtures and builds; this optimization set has not been deployed.
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
Production acceptance belongs to the eventual deployment, not these local results.

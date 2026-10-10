# Long-Document Followup

Date: 2026-10-10. Local implementation and measurement evidence below is followed
by two-site release acceptance. Concurrent search, paging and v3 publications
were retained through scoped merges onto the latest remote versions.

## TXT

Text blocks have a 32,768 UTF-16-unit ceiling, preferring available newline
boundaries without splitting surrogate pairs or a CRLF within the decoded chunk.
Very long lines now produce several offscreen-renderable blocks. Source text and
cross-block search offsets remain unchanged. Deep restoration measures the needed
prefix in batches of at most eight blocks or an 8 ms soft budget, yielding between
batches and checking navigation ownership before measuring or scrolling. A single
browser layout can exceed that soft budget. Cancellation cannot apply an old offset.

## PDF

The server can serve a requested closed byte range contained in a completed,
validated cached 206 response. It preserves source URL, MIME policy, size limit,
validators and total length. Conditional, suffix/open and uncovered ranges retain
the upstream path. Cache storage remains 32 MiB, with an additional 256-entry
ceiling. Browser PDF partial responses remain no-store. Server-Timing separates
cache hit/slice/miss, slot waiting and upstream header waiting; it does not measure
body transfer or split DNS/TLS/redirect stages within upstream waiting.

Background page-render failures retain three automatic retries. Exhaustion stops
automatic rescheduling, shows an explicit page failure and offers a manual retry.
Successful drawing resets retry state and hides the loading state.

Production observation before this round's deployment: Reader `3tp99trglsuw6`
resolves to a native 3,395,141-byte, 37-page PDF, with no derived preview metadata.
An un-routed 390px/DPR3 Chromium run with the active Service Worker took 5.509 s
to its first canvas. Pages 2-15, 18, 37 and return to 1 all rendered; measured
navigation-to-ready samples were 0.059-0.474 s, including test UI overhead. Initial
range header waits were approximately 258-513 ms in this run. No persistent page
stall or JavaScript page error was reproduced. Loading text remains in the DOM
but is hidden once its canvas is ready. These are selected production observations,
not evidence that this round is deployed or that every mobile network is equally fast.

## OCR

Codepoint counting no longer creates arrays containing every character. The search
Worker validates the complete original index before retaining only page text and
the exact span fields used for hit boxes. Complete totals and page mapping remain
unchanged. Cancelling before the validated index is ready terminates the Worker,
including synchronous JSON parsing; retry starts a fresh owner. Ready indexes
remain reusable. JSON parsing itself still needs the complete decoded string.

A local Node 512-page synthetic sample measured validation-stage heap growth
before GC of 10,433,968 bytes with array counting versus 1,378,480 bytes with iterator
counting; validation took 89.14 versus 77.75 ms in one paired run. This is not total
browser heap or a production memory percentage. Two local pipeline snapshots
(68/97 pages) retained compact serialized content of 564,883/453,956 bytes versus
641,280/517,972 bytes for their full indexes, with equal selected-query totals and
first result pages. These small samples do not establish maximum-index performance.
A real browser regression interrupts an injected ten-second synchronous parse and
successfully searches using a fresh Worker in under four seconds.

## DOCX

Document image, numbering image and embedded-font reads share path-keyed promises
within the parsed document; font keys remain distinct. Failure clears the failed
entry. Blob URL ownership stores content types and URL sets rather than a bound
method retaining the entire parsed document and ZIP. Parsing/render waits now
participate in Reader cancellation. The pinned library, complete DOM, images,
fonts, page order, links and exact search are retained.

A local real 6,502,981-byte DOCX rendered 46 pages, 61,425 text characters and 12
images before and after. Parse/render were 162.9/125.0 ms before and 178.3/168.6 ms
after in individual noisy runs; no real-book speedup is claimed. After forced GC,
Chromium backing storage was 7,176,048 versus 618,150 bytes, consistent with release
of the compressed source buffer. This is not total browser/GPU memory. A repeated
image fixture performed 100 ZIP image reads before and one after; rendering was
85.3 versus 13.9 ms in individual runs. Images/font loading, URL revocation and
late-disposal guards passed separate browser checks.

## Verification

- Two-site optimization cases passed: 16 cases per site, including the four new
  TXT, PDF failure and synchronous OCR cancellation regressions.
- HF full Reader/PDF loading/closure/v3: 118 cases passed.
- Pages Reader/PDF loading/closure: 110 cases passed; v3 passed three additional
  cases through the documented HF runner with READER_V3_ROOT set to Pages. An
  initial command incorrectly named a Pages-local v3 module that does not exist;
  all 110 actual cases passed and the documented shared runner passed separately.
- HF proxy/ownership/redirect: 75 cases passed; Reader backend: 35 cases passed.
- HF/Pages static contracts: 29/35 cases passed. TXT and DOCX source assertions now match
  bounded blocks and cancellation-owned engine waits instead of retired strings.
- Both OCR transport/client and book-text Node contracts passed; HF v3 Node
  contracts, two-site architecture and shared-resource gates passed.
- Both minified content-hashed builds passed their release gates. The existing
  duplicate asx app-key warning remains unrelated to this round.

Repeatable commands are recorded in TESTING.md. Temporary profiles, screenshots,
the real DOCX sample and minified artifacts are under /tmp/opencode and are not
deployment uploads. Publishing requires a fresh remote baseline and a scoped
merge of these changes, followed by independent production acceptance on each site.

The local Uvicorn preview is http://127.0.0.1:8801/. A real upstream 256 KiB
range took 3,767 ms to headers in a selected local-proxy run. A subsequent contained
4 KiB request returned cache=slice with zero upstream wait, and its bytes matched
the corresponding original slice exactly. This is local acceptance of the new
cache path, not a production speed measurement.
The new local Reader also opened the reported real PDF and rendered page 37 at
740 backing pixels for its 370 CSS-pixel page; the loading state was hidden.

## Release Acceptance

- HF application: `9364c0d930c85146ee5a61a72998e5cde12f1449`, published over
  concurrent search release `9a70f8f0a86a3c4872dbf7070e134983e2a0873a` and verified
  RUNNING with all ten uploaded source/test files checksum-matched.
- Pages application: `a20c7953bb3fe60d265a43bc4e475d2dd4de9c69`, rebased normally
  over concurrent search release `cb165718171ba07ad265589706e85282c9b7bf50`.
  Deployment `38025940732` succeeded. No generated data or temporary files were
  included in either application release.
- Full Reader CI `38025940748` passed both jobs, including the full Reader suites,
  sixteen optimization cases per site, OCR transport/cancellation, PDF loading,
  close-traffic, theme and HF upstream ownership gates. The staged acceptance also
  passed HF 140 cases and Pages static 35 cases. The additional stale Pages proxy
  source assertions now use its actual target/proxy function parameters.
- Production Reader JS/book-text/search client/search Worker bytes on both sites
  matched the corresponding content-hashed release artifacts.
- Default-cache, active-Service-Worker Chromium at 390px/DPR3 opened both reported
  PDFs on both sites and navigated to page 2/3/5/10, midpoint, last and back to 1.
  All selected canvases were ready, loading states hidden, at most seven canvases
  retained, backing width 740 for a 370 CSS-pixel page and no JavaScript page errors.
  Reader `3tp99trglsuw6` first-page samples were HF 5.914 s / Pages 5.908 s;
  Reader `0enjkf5vbd6yj` samples were HF 3.980 s / Pages 2.733 s. Deep page 174/349
  demand waits were approximately 0.81-0.85 s. These are selected network/cache
  samples, not controlled speedups or guarantees of instant page display.
- The accepted 68-page v3 book returned exactly 176 hits for the selected query on
  both sites, including last-result overlay navigation. The real 46-page DOCX
  returned exactly 212 hits against rendered-text counting, including last-hit
  highlighting. These are selected-book totals, not corpus-wide counts.
- A real 1,757,148-byte UTF-8 TXT rendered in twenty bounded blocks. Complete source
  text and all 3,075 selected-query hits matched independently on both sites;
  last-result highlighting passed. Deep history offsets restored exactly after
  reload (HF 172,735 / Pages 126,242 CSS pixels in their separate layouts).
- A real production contained 4 KiB range matched its corresponding original
  256 KiB response slice byte-for-byte and reported cache=slice, zero queue/upstream
  header wait, and PDF Cache-Control no-store.
- HF four-case live smoke and the independent Pages/API live smoke passed.

CI: https://github.com/vomebook/search/actions/runs/38025940748

# GitHub Search Testing

These tests do not change runtime search behavior. They cover deterministic Worker behavior, generated artifacts, Service Worker behavior, static contracts, an optional real-browser smoke test, and an explicitly gated read-only production smoke.

## Fast Default

Run dependency-free, browser-free behavior and contract suites from the repository root. Generated-data scans and the full corpus oracle are intentionally separate:

```bash
node tests/test_worker_contract.js
node tests/test_service_worker.js
node tests/test_static_contract.js
node tests/test_reader_runtime.js
node tests/test_reader_request_manager.js
node tests/test_reader_chapter_repository.js
node tests/test_reader_scroll_anchor.js
node tests/test_reader_section_virtualizer.js
node tests/test_reader_models.js
node --check static/app.js
node --check static/index-worker.js
node --check sw.js
```

`tests/test_harness.js` is a dependency-free Node 12-compatible runner. It reports every case separately, continues after failures, and exits nonzero if any case fails. Worker cases use fresh `node:vm` contexts and indexes except lifecycle cases that intentionally test state replacement. Service Worker cases use fresh `node:vm`, Cache Storage, fetch, and event mocks for every case.

Run this fast suite locally before deployment. The Pages workflow does not depend on `tests/`; it uses pinned esbuild `0.28.2` to generate the disposable `_site` deployment artifact and checks the generated JavaScript syntax. Source files remain readable; `_site` must not be committed or edited by hand.

`test_worker_contract.js` covers the version handshake, mismatch/errors, compact-v2 payload injection without network, metadata, generation replacement, bounded record pages and stable IDs, AND semantics, Chinese and punctuation behavior, exact and wildcard searches, lazy fuzzy indexing, empty-query precomputed orders and filtered-path fallback, random requests, folder requests, repository/extension/size edge values, prefix/exact/mixed/root folder filtering, sorting, and pagination boundaries. Static contracts prohibit main-thread corpus decode/retention and corpus-wide indexes. `test_service_worker.js` covers successful and partial installs, precache failures, activation, external bypass, gzip/initial/sidebar cache hits and misses, network failures, static caching, partial responses, and non-ok responses.

## Generated Snapshot And Oracle

Run local generated-data integrity and the independent compact-corpus oracle explicitly:

```bash
node tests/test_data_integrity.js
node tests/test_corpus_oracle.js
```

These prove consistency and Worker equivalence for the checked-out snapshot only. The snapshot may differ from both deployed GitHub Pages data and the external HF API.

## Browser And Integration

Run the optional browser smoke with Python 3. The test serves the real repository under `/search/`, uses real HTML/CSS/JS and generated local data, and deterministically mocks external API and hitokoto routes:

```bash
python3 -m pip install -r requirements-test.txt
python3 -m playwright install chromium
python3 -m unittest -v tests/test_browser_smoke.py
python3 -B -m unittest -v tests.reader_test_selection.ReaderPartitionContractTest
```

The browser cases each use a fresh browser context. They cover desktop boot with real local data, local search and URL state, virtual scrolling and append behavior, theme persistence, desktop sidebars, mobile mutually exclusive drawers, IME deferral, and deterministic API-mode search. External API and hitokoto requests are mocked; HTML, CSS, JavaScript, Worker, and generated local data are served from this repository under `/search/`. The suite skips if Playwright or Chromium is unavailable and does not require a Node browser package.

Run the real Chromium integration suites:

```bash
python3 -B -m unittest -v tests/test_service_worker_integration.py
python3 -B -m unittest -v tests/test_api_integration.py
node scripts/copy_reader_vendor.mjs static/vendor
python3 -B -m unittest -v \
  tests/test_reader_layout.py tests/test_reader_formats.py \
  tests/test_reader_conversions.py tests/test_reader_navigation.py \
  tests/test_reader_lifecycle.py
python3 -B -m unittest -v tests/test_reader_visual.py
```

These suites use fresh Chromium contexts and a test-only local `/search/` server with correct MIME types, request counters, and injectable delays/failures. The Reader additions cover inert HTML/CSS/SVG, manifest and chapter response limits, ZIP-bomb metadata before Foliate, actual IndexedDB/BroadcastChannel updates between two pages, HTML/Markdown TOC clicks, PDF outline navigation, and first/lazy/TOC `epub-chapters` navigation. The current GitHub Reader has no pre-parser DOCX ZIP inspection, so this test-only change does not claim it. CFI, MOBI filepos, FB2 fragments, and footnote roundtrips remain unclaimed because the existing deterministic fixtures do not provide real engines for them.

The five Reader modules partition every case from `ReaderPerformanceTest` by layout, formats, conversions, navigation, and lifecycle. Their shared selection contract fails on omitted, unknown, or duplicate method names. The primary Reader benchmark is the five-format cold-cache first-read matrix for PDF, TXT, Markdown, DOCX, and PNG. Every format opens in a new browser context with Service Workers blocked and the Chromium HTTP cache disabled through CDP. It uses the real pinned format engines generated by `copy_reader_vendor.mjs`, deterministic in-memory documents, and verifies that engine responses came from neither Cache Storage nor the browser HTTP cache. It reports first-readable time, required document/engine bytes, and response count. The simulated-engine cases remain as architecture regression tests for bounded PDF render concurrency and canvas memory, progressive TXT display, and overlap between format preparation and delayed history restoration. Machine-dependent elapsed times are informational; stable cache, resource, concurrency, and memory contracts have pass/fail assertions.

`test_corpus_oracle.js` independently decodes `search_data.json.gz`, implements a brute-force literal/wildcard/filter/sort/page oracle, compares IDs and totals with the real Worker, and checks generated global/repository first-page order and totals.

## Production Acceptance

Run production smoke only with the live URL explicitly set:

```bash
GITHUB_SEARCH_LIVE_BASE_URL="https://vomebook.github.io" \
GITHUB_SEARCH_API_BASE_URL="https://voiceofml-search.hf.space" \
node tests/test_live_smoke.js
GITHUB_SEARCH_LIVE_BASE_URL="https://vomebook.github.io" node tests/test_reader_live_smoke.js
GITHUB_SEARCH_LIVE_BASE_URL="https://vomebook.github.io" python3 -m unittest tests.test_reader_live_formats -v
```

With no `GITHUB_SEARCH_LIVE_BASE_URL`, the commands skip and perform no production requests. The live tests read the deployed shell, runtime static assets, manifests, one payload from each manifest, gzip responses, external API response shapes, and content-addressed Reader assets. They do not mutate production data; the Reader progress case writes only to its fresh browser context's IndexedDB. The frontend is served at `/search/`, while API calls go to `GITHUB_SEARCH_API_BASE_URL`; classify live failures as deployment/API availability before changing local Worker code.

`test_reader_live_formats.py` selects ready Reader-Assets samples dynamically from the current manifest at runtime; that revision covers converted/native assets. It records the manifest revision (or accepts `READER_ASSETS_REVISION`), uses manifest content hashes, and skips only unavailable format families with an explicit reason. PDF-pages uses `pdf_manifest` when present, otherwise the known production bucket path only after a read-only HEAD check. Raw TXT and Markdown samples are selected separately from the live search API using `GITHUB_SEARCH_API_BASE_URL`, with extension filters and validated direct Hugging Face source URLs; their failures have explicit skip reasons. It covers available PDF, EPUB, MOBI, AZW3, media, FB2, DOCX, HTML, TXT, and Markdown samples without claiming absent formats passed.

The representative layout matrix avoids a viewport/theme Cartesian product while exercising each dimension at least once:

```text
desktop  1440x900  light          normal contrast
tablet    820x1180 dark           normal contrast
mobile    390x844  dark + system  high contrast
```

Each matrix case asserts that visible toolbar controls stay within the viewport without overlapping, the Reader viewport starts below the toolbar, and the document does not overflow horizontally.

The tests intentionally document, rather than alter, current fuzzy candidate limits and exact/literal search behavior.

## Search Benchmarks

Three tiers: local (Worker in Node), API (live HTTP to external HF Search API), and browser (Playwright with local static server). Results are informational; no pass/fail thresholds.

### Local (Worker via Node)

```bash
node tests/test_benchmark.js
```

Covers normal, exact, wildcard, single-character, Latin, filtered, and sorted queries through the persistent Worker `searchLocal()` path.

### API (live HTTP to external HF API)

Requires `GITHUB_SEARCH_API_BASE_URL` environment variable (default: `https://voiceofml-search.hf.space`). Measures HTTP POST round-trip:

```bash
python3 -m unittest tests.test_benchmark_browser.ApiSearchBenchmarkTests -v
```

### Browser (Playwright)

Requires `requirements-test.txt` and `playwright install chromium`. Starts a local static-file server, opens Chromium, types queries into the search box, and measures from keystroke to results rendering:

```bash
python3 -m unittest tests.test_benchmark_browser.BrowserSearchBenchmarkTests -v
```

Results are appended to `tests/benchmark-results.json` (keeps newest 50 runs). Each tier is saved under a separate project label (`github-Search-api`, `github-Search-browser`; local is saved directly by the Node script).

Reader DOM-search source-module contracts
========================================

Run from the repository root after installing Playwright Chromium and Firefox:

  python3 -B scripts/check_reader_dom_search_contracts.py

Seven named contracts each run once in each browser against the actual
reader-dom-search.mjs source, using only synthetic local DOM. They cover literal
matching, snippets, pagination, cross-node marks, snapshot reuse and mutation,
stale navigation, cancellation, headings, excluded nodes, and occurrence
selection. The runner blocks external requests and checks exact module loads.

The browser run is not a line or branch coverage percentage. It does not
exercise the full Reader host, production bundle, Worker, network or real
documents. Existing Reader integration tests remain unchanged and separate.
The gate requires each named test and source-digest completion marker for each
browser, no browser console output, zero skipped tests and a complete success
summary. Its offline parser self-tests run as tests.test_reader_dom_search_gate.

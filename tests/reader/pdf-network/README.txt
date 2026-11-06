PDF network and range contracts — GitHub Pages
=============================================

Run from the repository root with Node 26:

  node scripts/reader/check_pdf_network_coverage.mjs
  node scripts/reader/check_pdf_network_mutations.mjs
  node --test tests/reader/pdf-network/test_pdf_range_cache_release.mjs

The coverage gate runs the backpressure, network cache/identity and sparse-range
contracts. For reader-pdf-network.mjs it requires at least 98.29% lines,
85.25% branches and 87.16% functions; for the extracted reader-pdf-range-cache.mjs
it requires 100% lines, 97.01% branches and 100% functions. These are separate
floors and do not describe the whole Reader. The extraction changed each file's
denominator; the existing contracts, plus invalid cache-input tests, are kept.
All three named tests and their completion markers are required.

The mutation gate checks six targeted safety regressions, including admission
cancellation, version changes and byte ownership. It is not an exhaustive
mutation score. The Hugging Face Space has a different range transport and
coverage baseline; its tests and thresholds are kept independently.

The release test verifies content-addressed cache/network imports and Service
Worker inventory in the Pages build. These synthetic tests do not measure the
entire Reader, the browser, or a live upstream service. Both gates and the
release test run in the GitHub Reader Refactor workflow.

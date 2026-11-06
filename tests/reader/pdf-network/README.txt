PDF network and range contracts — GitHub Pages
=============================================

Run from the repository root with Node 26:

  node scripts/reader/check_pdf_network_coverage.mjs
  node scripts/reader/check_pdf_network_mutations.mjs
  node --test tests/reader/pdf-network/test_pdf_range_cache_release.mjs

The coverage gate runs the backpressure, network cache/identity, sparse-range
and range-hints contracts. Minimum line/branch/function percentages are:

  network: 97.86 / 84.20 / 86.27
  cache:   100 / 97.01 / 100
  hints:   100 / 92.59 / 100

The network branch floor is the lower observed Node 26.11.1 CI reading;
local runs measured 84.23%. The three-module aggregate retains the previous
network gate's floors of
98.29 / 85.25 / 87.16. Extraction changes file denominators: module percentages
must not be compared directly with the old unsplit module. All four named tests
and their completion markers are required; none is a whole-Reader figure.

The mutation gate checks eight targeted safety regressions, including admission
cancellation, version changes, byte ownership, stream boundaries and the
small-file fallback. It is not an exhaustive mutation score. Hugging Face Space
has a different range transport and separately measured coverage baseline.

The release test verifies content-addressed cache/hints/network imports and
Service Worker inventory in the Pages build. These synthetic tests do not measure the
entire Reader, the browser, or a live upstream service. Both gates and the
release test run in the GitHub Reader Refactor workflow.

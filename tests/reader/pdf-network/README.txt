PDF network and range contracts — GitHub Pages
=============================================

Run from the repository root with Node 26:

  node scripts/reader/check_pdf_network_coverage.mjs
  node scripts/reader/check_pdf_network_mutations.mjs

The coverage gate runs the backpressure, network cache/identity and sparse-range
contracts against static/reader/pdf/reader-pdf-network.mjs only. It requires
at least 98.31% lines, 85.65% branches and 88.43% functions, along with all
three named tests and their completion markers.

The mutation gate checks six targeted safety regressions, including admission
cancellation, version changes and byte ownership. It is not an exhaustive
mutation score. The Hugging Face Space has a different range transport and
coverage baseline; its tests and thresholds are kept independently.

These synthetic tests do not measure the entire Reader, the browser, or a
live upstream service. Both gates run in the GitHub Reader Refactor workflow.

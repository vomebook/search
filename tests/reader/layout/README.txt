Reader layout contracts
=======================

Run from the repository root with Node 26:

  node scripts/reader/check_reader_core_coverage.mjs

The section virtualizer contracts require 100% lines, branches and functions
for reader-section-virtualizer.js. The scroll-anchor contracts require 100%
lines, 89.61% branches and 100% functions for reader-scroll-anchor.js. The gate
also independently measures the chapter repository; see ../chapters/README.txt.
All thresholds are source-specific, not whole-Reader or browser coverage.

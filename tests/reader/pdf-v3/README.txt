PDF Reader v3 contracts
=======================

Run from the repository root with Node 26.11.1:

  node scripts/reader/check_reader_v3_coverage.mjs
  node scripts/reader/check_reader_v3_mutations.mjs
  python3 -B -m unittest tests.test_static_checks.StaticGateTests.test_reader_v3_gates_fail_closed

The coverage gate combines eleven synthetic, JSON-derived contracts with three
existing dataset-primary, OCR-retention and DjVu scripts. It requires all
14 TAP tests to pass without skips or TODOs, and measures only
static/reader/pdf/reader-v3.mjs. The required line / branch / function floors
are 98.13% / 87.50% / 100%; they are not coverage for the whole Reader,
site, network stack or browser.

The mutation gate makes isolated temporary copies, first verifies the original
contract and then checks seven targeted changes to path and null guards. All
seven must fail for the expected reason; this is not an exhaustive mutation
score. The Python fault-injection test verifies that a missing coverage row,
skipped contract, insufficient coverage or invalid mutation setup fails the
gates rather than producing a pass.

These Node contracts use the repository's actual reader-contract.js but
synthesize JSON input and transport. They do not replace real HTTP, browser,
Reader UI or full-site integration tests. Both site jobs in the GitHub Reader
workflow run the gates; browser and PDF search contracts are documented in
../pdf-search/README.txt.

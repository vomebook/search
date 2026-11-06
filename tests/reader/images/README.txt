Reader image loading and memory contracts
=========================================

Run from the repository root with Node 26:

  node tests/reader/images/test_reader_image_loader.mjs
  node scripts/reader/check_reader_image_loader_coverage.mjs
  node tests/reader/images/test_reader_image_memory.mjs

The image-loader gate runs named synthetic lifecycle, fallback and cancellation
contracts for static/reader/formats/reader-image-loader.mjs only. Its V8 floors
are 100% lines, 87.18% branches and 91.67% functions. The separate memory test
exercises PDF/image rendering and eviction; it is not included in that gate.
The memory test accepts an optional repository root argument. Site-specific
expectations remain distinct. Both sites run these tests in the Reader workflow.

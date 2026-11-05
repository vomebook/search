Reader text format contracts
============================

Run from the repository root with Node 26:

  node scripts/check_reader_text_coverage.mjs

The 14 named contracts use synthetic streams, byte sequences, DOM and timers;
they cover encoding, incremental preview, byte limits, block boundaries,
cooperative yields, decoder initialization, cancellation and cleanup. The V8
coverage gate includes only static/reader/formats/reader-text-format.mjs, not
the Reader host, real browser, network, search index or whole site. Existing
browser tests remain in their Python package and are not replaced.

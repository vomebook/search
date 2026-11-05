DjVu Node regressions
=====================

These seven existing scripts cover DjVu and image-manifest contracts, range
transport and fallback, worker behavior, source integrity and scheduling.
Run them from the repository root with:

  node scripts/check_reader_djvu_contracts.mjs

The gate requires each existing script's completion marker, one passing TAP
entry per file, a complete summary and zero skipped/TODO results. It also
runs a separate named contract for range-read bounds and request admission.
Node/V8 coverage is gated only for reader-djvu-range.mjs using the original
synthetic range script and this boundary contract; it excludes the decoder,
native engine, other Reader modules, browser and real network behavior.

The only and png scripts accept an optional repository root as their first
argument, so they can also test a second site's source tree. Python browser
and benchmark tests remain in tests/ because they use the tests package.

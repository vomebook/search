Reader chapter search contracts — GitHub Pages
=============================================

Run from the repository root with Node 26:

  node tests/reader/chapter-search/test_reader_chapter_search.mjs

This synthetic contract exercises URL validation, full counts, progress,
pagination, literal and Unicode matching, cancellation, index identity and
Pages-specific bigram pruning. It is not a coverage measurement and does not
replace browser integration tests. The Space contract intentionally differs.

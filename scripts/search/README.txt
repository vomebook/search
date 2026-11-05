Search presentation quality gates
=================================

Run these from the repository root with Node 26:

  node scripts/search/check_search_highlight_coverage.mjs
  node scripts/search/check_search_size_coverage.mjs

These two gates execute contracts under tests/search/highlight/ and
tests/search/size/, respectively. Their V8 thresholds cover only the specified
extracted search module; the shared TAP helper remains in scripts/.
Other search gates remain at their existing paths pending separate migration.

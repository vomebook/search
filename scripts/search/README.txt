Search presentation quality gates
=================================

Run these from the repository root with Node 26:

  node scripts/search/check_search_highlight_coverage.mjs
  node scripts/search/check_search_size_coverage.mjs
  node scripts/search/check_search_record_path_coverage.mjs

These gates execute contracts under tests/search/highlight/, tests/search/size/
and tests/search/record-path/, respectively. Their V8 thresholds cover only the
specified extracted search module; the shared TAP helper remains in scripts/.
Other search gates remain at their existing paths pending separate migration.

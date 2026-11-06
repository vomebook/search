Frontend search quality gates
=============================

Run from the repository root with Node 26:

  node scripts/search/check_search_highlight_coverage.mjs
  node scripts/search/check_search_size_coverage.mjs
  node scripts/search/check_search_record_path_coverage.mjs
  node scripts/search/check_search_file_types_coverage.mjs
  node scripts/search/check_search_response_cache_coverage.mjs
  node scripts/search/check_search_response_validation_coverage.mjs
  node scripts/search/check_search_result_identity_coverage.mjs
  node scripts/search/check_search_filter_equality_baseline.mjs
  node scripts/search/check_search_folder_merge_baseline.mjs
  node scripts/search/check_search_readability_baseline.mjs
  node scripts/search/check_reader_navigation_baseline.mjs
  node scripts/search/check_download_controller_coverage.mjs

The presentation and extracted-module gates measure only the named module;
behavior baselines under tests/search/baselines/ preserve host-side semantics.
Reader navigation has its own partial baseline under tests/search/reader-navigation/;
download-controller contracts are documented under tests/search/download/.
The shared TAP validator remains in scripts/. Backend mutation and coverage
gates are independent and are not part of these frontend measurements.

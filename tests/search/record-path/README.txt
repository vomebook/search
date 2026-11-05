Search record path contracts
============================

Run from the repository root with Node 26:

  node scripts/search/check_search_record_path_coverage.mjs

The site's original compatibility vectors exercise filenames, separators,
encoding and app.js link helpers. The V8 100/100/100 threshold applies only
to static/search/record-path.js; it is not coverage of app.js or a whole site.
The matching cross-module build/shell contract is under tests/search/build/.

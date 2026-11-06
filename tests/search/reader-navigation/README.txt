Search-host Reader navigation baseline
======================================

From the repository root with Node 26:

  node scripts/search/check_reader_navigation_baseline.mjs

These 11 named synthetic contracts cover Reader URL validation, session and
history behavior. They are a partial baseline for static/search/reader-navigation.js,
not coverage of iframe, speech, browser integration or the whole module. The
V8 floors remain 31.96% lines, 81.82% branches and 27.27% functions.

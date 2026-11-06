Search download controller contracts
====================================

Run from the repository root with Node 26:

  node scripts/search/check_download_controller_coverage.mjs

The 14 named synthetic contracts cover concurrent checks, cancellation,
timeouts, caching, browser handoff and feedback ownership. The V8 gate covers
static/search/download-controller.js only, with floors of 100% lines, 88.89%
branches and 100% functions. It is not a browser or real-download integration
test. Both sites run the gate in their shared Reader workflow; Space also runs
it in the Docker static gate.

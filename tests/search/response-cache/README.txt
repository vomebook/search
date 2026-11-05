Search response-cache contracts
===============================

Run from the repository root with Node 26:

  node scripts/check_search_response_cache_coverage.mjs
  node tests/search/response-cache/test_response_cache.js

Six original named Node contracts cover the extracted response cache's LRU,
TTL, byte budget, replacement and serialization boundaries. The V8 gate is
restricted to static/search/response-cache.js; it does not measure the search
host, backend, network, real browser or whole site. The second command retains
the original Pages-specific cache regression. Browser regressions remain in
their existing Python modules.
The gate also requires a complete, unique zero-skip/TODO TAP summary and
coverage-report boundaries; missing or forged summaries fail closed.

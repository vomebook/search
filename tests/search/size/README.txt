Search size-format contracts
============================

From the repository root with Node 26:

  node scripts/search/check_search_size_coverage.mjs

The original formatting/parser compatibility vectors and three named display
contracts cover URL round trips, binary thresholds, coercion and caching. V8
coverage and its 100/100/100 minimum apply only to static/search/size-format.js;
they do not measure app.js, browsers, network, backend or a whole site.

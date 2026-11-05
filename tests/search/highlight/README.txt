Search result highlighting contracts
====================================

From the repository root with Node 26:

  node scripts/search/check_search_highlight_coverage.mjs

Four pinned contracts cover HTML escaping, raw-text matching, literal regex
handling, and the bounded regex cache. V8 coverage and its minimum apply only
to static/search/highlight.js, not app.js, browsers, the backend or a site.
The uncovered branch guards an empty match that escaped search terms cannot
normally generate; coverage is not a complete security or mutation audit.

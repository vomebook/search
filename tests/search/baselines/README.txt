Search behavior baselines
=========================

These tests pin observable search-host behavior, including legacy edge cases,
before implementation changes. Run them from the repository root:

    node --test tests/search/baselines/*.mjs

Some baselines also feed the individual coverage and fail-closed gates under
scripts/search/check_search_*. Update those gates and both sites' CI references when
moving or renaming a test. Do not replace a behavior baseline with an import
smoke test or weaken its assertions to make a refactor pass.

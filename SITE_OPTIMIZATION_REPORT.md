# Site optimization acceptance — 2026-09-18

Chapter books now use the existing complete text index for literal, case-insensitive
search. Index bytes, SHA-256 and all chapter identities are checked in a Worker.
Results keep exact totals with 50 entries per page; navigation loads the selected
chapter and highlights the exact occurrence, including cross-node XHTML text.
GitHub retains its `/search/` routes and external HF content API without credentials.

The static build pins the app/Worker pair and Reader module graph with content hashes,
including warmup URLs. Unversioned compatibility files remain available. The fixed
Service Worker cache reuses immutable resources without network revalidation.
Initial installation caches the search shell and global data; other repository data
and Reader resources are retained when used.

An actual Chromium install comparison served identical built resources with 25 ms
request latency in empty contexts. The previous SW requested 48 resources (690,763
bytes); the new SW requested 17 (319,472 bytes), reducing transferred bodies by 54%.
Installation took 731 ms versus 316 ms in that run. This isolates installation traffic
and does not predict public-network first paint. Old-cache upgrade, demand repository
caching, immutable reuse and offline reads passed without changing the cache name.

The Reader browser suite covers 155 complete matches, paging to the final occurrence
in an unloaded chapter, prefixed XHTML and cross-node highlights, corrupted index
retry, and cancellation preventing stale results. The Worker search semantics remain
unchanged. GitHub data generations and HF data generations are still independent.

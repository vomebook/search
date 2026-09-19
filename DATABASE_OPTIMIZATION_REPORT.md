# Browser Cache Optimization

Date: 2026-09-18

The existing IndexedDB `savedAt` index now handles expiration by key range and
capacity eviction by advancing past retained keys. Multiple recent pages saved
for the same viewport share one write transaction. Database version, schemas,
capacities, byte budgets, TTLs and search semantics remain unchanged.

In a controlled Chromium measurement of 20 saves with full stores, cursor movements
fell from 1,960 to 80 (40 `continue`, 40 `advance`), with the same 40 content writes.
A separate two-visible-page test confirms a single write transaction instead of two.
These are local operation counts, not production network or real-phone timings.

Verification: 33 cache/position browser cases and 11 cache cases against the minified
app passed. Tests include tied timestamps, strict expiry boundaries, storage limits,
generation validation, persisted page restoration, cancellation and batched writes.
Outdated test fixtures were updated to use the existing explicit restoration entry
point and logical scroll coordinates; the old fixture failure also reproduced against
the pre-optimization application.

Published asset hash and desktop/mobile IndexedDB acceptance results are recorded
under `/tmp/opencode/database-optimization/release/github-Search/`.

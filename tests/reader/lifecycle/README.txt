Reader lifecycle contracts
==========================

Run the named synthetic contracts and source-only V8 coverage gate from the
repository root using: node scripts/check_reader_lifecycle_coverage.mjs

The test exercises cancellation, resource cleanup, dynamic error getters,
generation ownership, readiness, disposal and retry behavior. Its coverage
figures apply to reader-lifecycle.mjs only, not the Reader host or all formats.

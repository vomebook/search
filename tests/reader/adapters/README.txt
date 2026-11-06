Reader format-adapter registry contracts
========================================

From the repository root with Node 26:

  node scripts/reader/check_adapter_coverage.mjs

The named contract exercises registration, validation, activation and disposal
of the adapter registry. The gate requires 100% lines, branches and functions
for static/reader/formats/reader-format-adapters.js only, and rejects missing,
renamed, skipped or unfinished contracts. It is not whole-Reader coverage.

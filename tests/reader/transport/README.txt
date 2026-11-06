Reader request and document loading contracts
=============================================

From the repository root with Node 26:

  node scripts/reader/check_request_manager_coverage.mjs
  node scripts/reader/check_document_loader_coverage.mjs

The request-manager gate runs the manager, initial-response recovery and edge
contracts. Its V8 minimum is 100% lines, 95.24% branches and 95.12% functions
for static/reader/core/reader-request-manager.js only.

The document-loader gate runs the six named loader contracts and PDF outer
rate-limit retry contract. Its V8 minimum is 100% lines, 94.20% branches and
97.22% functions for static/reader/core/reader-document-loader.mjs only.

Both gates reject missing, skipped, renamed or incomplete contracts. Their
thresholds do not describe the whole Reader or live network/browser behavior.
The GitHub Reader Refactor workflow runs both gates against both sites.

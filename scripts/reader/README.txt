Reader quality gates
====================

Run these commands from the repository root with Node 26:

  node scripts/reader/check_pdf_book_client_coverage.mjs
  node scripts/reader/check_request_manager_coverage.mjs
  node scripts/reader/check_document_loader_coverage.mjs
  node scripts/reader/check_pdf_network_coverage.mjs
  node scripts/reader/check_pdf_network_mutations.mjs
  node scripts/reader/check_reader_core_coverage.mjs
  node scripts/reader/check_reader_image_loader_coverage.mjs

The image contracts are documented in `tests/reader/images/README.txt`.
The chapter and layout gate is documented in `tests/reader/chapters/README.txt`
and `tests/reader/layout/README.txt`.
The PDF network gates are documented in `tests/reader/pdf-network/README.txt`.
The request and document loading gates are documented in
`tests/reader/transport/README.txt`.

The PDF book-search gate checks the client contracts in
`tests/reader/pdf-search/test_pdf_book_client.mjs` against V8 coverage thresholds.
Additional PDF Worker, OCR and browser regression commands are listed in
`tests/reader/pdf-search/README.txt`. The TAP helper remains in scripts/; other
Reader gates remain at their existing paths pending separate migration.

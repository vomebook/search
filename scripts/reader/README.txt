Reader quality gates
====================

Run these commands from the repository root with Node 26:

  node scripts/reader/check_reader_v3_coverage.mjs
  node scripts/reader/check_reader_v3_mutations.mjs
  node scripts/reader/check_pdf_book_client_coverage.mjs
  node scripts/reader/check_pdf_text_store_coverage.mjs
  node scripts/reader/check_pdf_text_store_mutations.mjs
  node scripts/reader/check_request_manager_coverage.mjs
  node scripts/reader/check_document_loader_coverage.mjs
  node scripts/reader/check_pdf_network_coverage.mjs
  node scripts/reader/check_pdf_network_mutations.mjs
  node scripts/reader/check_reader_core_coverage.mjs
  node scripts/reader/check_reader_image_loader_coverage.mjs
  node scripts/reader/check_adapter_coverage.mjs
  node scripts/reader/check_reader_lifecycle_coverage.mjs
  node scripts/reader/check_reader_media_coverage.mjs
  node scripts/reader/check_reader_text_coverage.mjs
  node scripts/reader/check_reader_djvu_contracts.mjs
  python3 -B scripts/reader/check_reader_dom_search_contracts.py

The adapter and image contracts are documented in `tests/reader/adapters/README.txt`
and `tests/reader/images/README.txt`.
The chapter and layout gate is documented in `tests/reader/chapters/README.txt`
and `tests/reader/layout/README.txt`.
The PDF network gates are documented in `tests/reader/pdf-network/README.txt`.
The reader-v3 gate combines synthetic and existing contracts for
`reader-v3.mjs` only; its seven targeted mutations are not exhaustive.
See `tests/reader/pdf-v3/README.txt`.
The request and document loading gates are documented in
`tests/reader/transport/README.txt`.

The PDF book-search gate checks the client contracts in
`tests/reader/pdf-search/test_pdf_book_client.mjs` against V8 coverage thresholds.
Additional PDF Worker, OCR and browser regression commands are listed in
`tests/reader/pdf-search/README.txt`. The TAP helper remains in scripts/; other
Reader gates remain at their existing paths pending separate migration.

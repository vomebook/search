Reader quality gates
====================

Run these commands from the repository root with Node 26:

  node scripts/reader/check_pdf_book_client_coverage.mjs

The PDF book-search gate checks the client contracts in
`tests/reader/pdf-search/test_pdf_book_client.mjs` against V8 coverage thresholds.
Additional PDF Worker, OCR and browser regression commands are listed in
`tests/reader/pdf-search/README.txt`. The TAP helper remains in scripts/; other
Reader gates remain at their existing paths pending separate migration.

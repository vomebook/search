PDF book-search client contracts
================================

Run from the repository root with Node 26:

  node scripts/check_pdf_book_client_coverage.mjs

Nine named tests use a synthetic Worker to verify client lifecycle, progress,
session ownership, supersession, errors, retry, cancellation and disposal.
The V8 gate includes only static/reader/search/reader-pdf-book-search.mjs. It
does not measure the actual Worker, OCR manifests, decompression, network,
browser, Reader host or the whole site. Existing OCR and browser tests remain
unchanged and continue to run separately.

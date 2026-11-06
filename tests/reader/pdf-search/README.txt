PDF full-book search contracts
==============================

Run from the repository root with Node 26:

  node scripts/reader/check_pdf_book_client_coverage.mjs
  node tests/reader/pdf-search/test_reader_ocr_transport.mjs
  node tests/reader/pdf-search/test_reader_book_text.mjs
  node --test tests/reader/pdf-search/test_pdf_book_worker.mjs
  python3 -B tests/reader/pdf-search/test_pdf_book_worker_browser.py

The client coverage gate uses nine synthetic Worker lifecycle contracts and
measures only static/reader/search/reader-pdf-book-search.mjs. The OCR test
also exercises bounded decoding and compact book-text search; the book-text
test checks Unicode offsets and pagination. The worker-thread tests run the
unchanged Worker and client across a real structured-clone boundary with local
compressed fixtures, for both book-text and partitioned indexes. They cover
prefetch before and after search, pagination, cancellation and retry. The
browser test serves local fixtures to the real browser Worker; set
PDF_WORKER_TEST_BROWSER=firefox to select Firefox. These focused tests do not
replace real network or full Reader integration tests. Both sites run them
from the GitHub Reader Refactor workflow.

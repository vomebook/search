PDF full-book search contracts
==============================

Run from the repository root with Node 26:

  node scripts/reader/check_pdf_book_client_coverage.mjs
  node scripts/reader/check_pdf_text_store_coverage.mjs
  node scripts/reader/check_pdf_text_store_mutations.mjs
  node tests/reader/pdf-search/test_reader_ocr_transport.mjs
  node tests/reader/pdf-search/test_reader_book_text.mjs
  node --test tests/reader/pdf-search/test_pdf_book_worker.mjs
  python3 -B tests/reader/pdf-search/test_pdf_book_worker_browser.py
  python3 -B tests/reader/pdf-search/test_pdf_text_store_browser.py
  PDF_TEXT_STORE_TEST_BROWSER=firefox python3 -B tests/reader/pdf-search/test_pdf_text_store_browser.py
  python3 -B -m unittest tests.test_reader_pdf_followup.PdfFollowupTests.test_disk_store_preserves_unicode_bounds_expiry_and_failure_fallback
  python3 -B -m unittest tests.test_static_checks.StaticGateTests.test_pdf_text_store_type_contract_rejects_invalid_usage

The client coverage gate uses nine synthetic Worker lifecycle contracts and
measures only static/reader/search/reader-pdf-book-search.mjs. The OCR test
also exercises bounded decoding and compact book-text search; the book-text
test checks Unicode offsets and pagination. The worker-thread tests run the
unchanged Worker and client across a real structured-clone boundary with local
compressed fixtures, for both book-text and partitioned indexes. They cover
prefetch before and after search, pagination, cancellation and retry. The
browser test serves local fixtures to the real browser Worker; set
PDF_WORKER_TEST_BROWSER=firefox to select Firefox. These focused tests do not
replace real network or full Reader integration tests. The focused IndexedDB
browser contract tests Unicode, eviction, expiry, identity and denied storage;
the separate strict type contract rejects invalid keys, pages and text values.
The text-store V8 gate exercises eight synthetic IndexedDB contracts using
fake-indexeddb (floors: 100% lines, 92.50% branches, 89.19% functions). Its
seven targeted safety mutants are not exhaustive. A separate Chromium/Firefox
contract uses native IndexedDB and two tabs with a held transaction to verify
shared budget accounting. These measurements apply only to this text-store
module, not the Reader or all browser behaviors. The Node gates also run in
the Space Docker static stage; browser contracts run in the Reader workflow.

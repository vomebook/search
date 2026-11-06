Reader CSS safety contract
==========================

Run from the repository root with Node 26:

  node tests/reader/security/test_reader_css_sanitizer.mjs

The synthetic test exercises CSS URL/reference sanitization, safe inputs,
strict mode and a bounded-time adversarial input. It is not a claim of full
HTML or CSS security coverage; browser and backend security tests remain
independent. Both sites run this contract in the Reader Refactor workflow.

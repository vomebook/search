Reader chapter repository, scheduling and preload contracts
===========================================================

Run from the repository root with Node 26:

  node scripts/reader/check_reader_core_coverage.mjs

The chapter contracts exercise shared loads, bounded demand scheduling,
cancellation, disposal, preload validation and resource ownership. The gate
measures reader-chapter-repository.js only for this group and requires 100%
lines, 98.86% branches and 100% functions. It also independently gates the
section virtualizer and scroll-anchor modules described in ../layout/README.txt.

These synthetic Node contracts do not replace Reader browser integration tests.
The chapter preload test accepts an optional repository root argument.

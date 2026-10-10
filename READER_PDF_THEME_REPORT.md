# PDF Reader Theme

## Local Change (2026-10-10)

Dark mode now filters PDF content surfaces using `invert(.9) hue-rotate(180deg)`:
native PDF.js canvases and PDF-pages images/canvases. The entire rendered PDF
page, including embedded illustrations, is adjusted. Light mode restores the
original presentation. PDF files and canvas source pixels remain unchanged;
theme switching needs no document reload or PDF rerender.

Transparent text layers, selections and search highlights remain unfiltered
above the page. Ordinary image documents, image-pages, HTML and audio/video
retain their existing presentation. No HTML theme changes were made in this task.

## Verification

- HF: three theme cases and three existing PDF selection/search cases passed.
- Pages: two theme cases and four existing PDF search cases passed.
- Native PDF screenshot pixels verify dark paper and light paper at 1100px and
  390px widths, while source canvas data, page identity and selected text remain
  unchanged. PDF-pages tests preserve the image URL and exclude image-pages.
- HF's hybrid preview-to-canvas theme handoff passed. The current Pages checkout
  has an image-only PDF-pages renderer; applying HF hybrid tests to that checkout
  was an incorrect test selection, not evidence of a Pages hybrid regression.
- Reader architecture/regression and cross-project release gates passed.

## Release Acceptance (2026-10-10)

Published with HF application revision `0e3343ff8d013af4a5a8643f2c670e4dde07abcd`
and Pages application revision `1df9ce9f055a09c46d87af286f1151f062a6af07`.
Subsequent test-only fixes passed required CI `38011336725`; Pages deployment
`38011336756` succeeded and HF test revision `90d147ef60c45fdb65c8968b93d13e8ff7946a05`
was verified RUNNING. Documentation-only closeout follows these accepted versions.

Default-cache, active-Service-Worker production Chromium checked the real six-page
`Understanding the New Terrorism` PDF on both sites at 1100px and 390px widths.
Paper pixels changed from `[26,26,26]` in dark mode to `[255,255,255]` in light mode.
Canvas identity and its original pixel data stayed unchanged; selected text and
search highlighting worked. All four opens returned exactly 38 `terrorism` hits,
matching an independent all-page PyMuPDF extraction, with no page errors. These
checks establish the selected production PDF behavior, not all-corpus equivalence.
Both documented production smoke suites passed after release.

CI: https://github.com/vomebook/search/actions/runs/38011336725

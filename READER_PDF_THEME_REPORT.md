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

This change remains local and has not been published. Commands are recorded in
each project's `TESTING.md`.

// Validate historical OCR book text without recreating OCR data or copying pages.
/** @typedef {{start: number, end: number, box: number[], block?: unknown, precision?: unknown}} SearchSpan */
/** @typedef {{page: number, text: string, layout: {offset_unit: 'unicode-codepoint'}, text_spans: unknown[]}} UncheckedPage */
/** @typedef {UncheckedPage & {text_spans: SearchSpan[]}} SearchPage */
/** @typedef {{version: 2, kind: 'pdf-book-text', complete: true, offset_unit: 'unicode-codepoint', page_count: number, source_sha256?: unknown, pages: SearchPage[]}} SearchBook */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object"; }
/** @param {unknown} book @param {number} pageCount @param {string} sourceSha
 * @returns {book is Omit<SearchBook, 'pages'> & {pages: unknown[]}} */
function validBook(book, pageCount, sourceSha) {
  return isRecord(book) && book.version === 2 && book.kind === "pdf-book-text" &&
    book.complete === true && book.offset_unit === "unicode-codepoint" &&
    book.page_count === pageCount && (!sourceSha || book.source_sha256 === sourceSha) &&
    Array.isArray(book.pages) && book.pages.length === pageCount;
}
/** @param {unknown} page @param {number} index @returns {page is UncheckedPage} */
function validPage(page, index) {
  return isRecord(page) && page.page === index + 1 && typeof page.text === "string" &&
    isRecord(page.layout) && page.layout.offset_unit === "unicode-codepoint" && Array.isArray(page.text_spans);
}
/** @param {string} text */
function codePointLength(text) {
  let length = 0;
  for (const point of text) length++;
  return length;
}
/** @param {unknown} value @returns {value is number[]} */
function validBox(value) {
  return Array.isArray(value) && value.length === 4 &&
    value.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) &&
    !(Number(value[0]) > Number(value[2])) && !(Number(value[1]) > Number(value[3]));
}
/** @param {unknown} span @param {number} previous @param {number} length @returns {span is SearchSpan} */
function validSpan(span, previous, length) {
  return isRecord(span) && typeof span.start === "number" && Number.isInteger(span.start) &&
    typeof span.end === "number" && Number.isInteger(span.end) &&
    span.start >= previous && span.end > span.start && span.end <= length && validBox(span.box);
}
/** @param {UncheckedPage} page @returns {asserts page is SearchPage} */
function validateSpans(page) {
  // Box-free pages preserve the existing no-Unicode-scan fast path.
  if (!page.text_spans.length) return;
  const length=codePointLength(page.text);
  let previous=0;
  for (const span of page.text_spans) {
    if (!validSpan(span,previous,length)) throw new Error("PDF_TEXT_MAPPING_INVALID");
    previous=span.end;
  }
}
/** @param {Omit<SearchBook, 'pages'> & {pages: unknown[]}} book @returns {asserts book is SearchBook} */
function assertPagesValid(book) {
  for (const [index,page] of book.pages.entries()) {
    if (!validPage(page,index)) throw new Error("PDF_TEXT_INDEX_INVALID");
    validateSpans(page);
  }
}
/** @param {unknown} book @param {number} pageCount @param {string} [sourceSha] @returns {SearchBook} */
export function validatePdfBookText(book, pageCount, sourceSha = "") {
  if (!validBook(book,pageCount,sourceSha)) throw new Error("PDF_TEXT_INDEX_INCOMPLETE");
  // This type predicate validates in place, preserving book and page identity.
  assertPagesValid(book);
  return book;
}

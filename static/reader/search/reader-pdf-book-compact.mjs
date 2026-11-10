// Retain only searchable text and hit geometry from a validated book page.
/** @typedef {{start: number, end: number, box: unknown, block?: unknown, precision?: unknown}} SearchSpan */
/** @typedef {{page: number, text: string, text_spans: SearchSpan[]}} SearchPage */
/** @param {SearchPage} page @returns {SearchPage} */
export function compactPdfBookPage(page) {
  return {page:page.page, text:page.text,
    text_spans:page.text_spans.map(({start,end,box,block,precision}) => ({start,end,box,block,precision}))};
}

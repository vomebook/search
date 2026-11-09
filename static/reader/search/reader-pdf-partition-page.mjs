// Page and hit projection primitives for validated PDF search partitions.
/** @param {unknown} requested @param {number} total */
export function pdfPartitionPageOffset(requested, total) {
  return Math.floor(Math.max(0, Math.min(total - 1, Number(requested) || 0)) / 50) * 50;
}
/** @template {{page: number}} T @param {T[]} results @param {{page: number, text_generation: unknown}[]} pages
 * @returns {(T & {textGeneration: unknown})[]} */
export function decoratePdfPartitionHits(results, pages) {
  return results.map(hit => {
    const first = pages[0];
    if (!first) throw new Error("PDF_TEXT_INDEX_INVALID");
    const page = pages[hit.page - first.page];
    if (!page) throw new Error("PDF_TEXT_INDEX_INVALID");
    return {...hit, textGeneration: page.text_generation};
  });
}

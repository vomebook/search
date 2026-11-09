// Validate already-decoded PDF text partitions before indexing.
/** @typedef {{page: number, text: string, text_generation: unknown}} PartitionPage */
/** @typedef {{version: 1, kind: 'pdf-search-text-partition', source_sha256: string, generation: string, offset_unit: 'unicode-codepoint', start: number, end: number, pages: PartitionPage[]}} SearchPartition */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object"; }
/** @param {unknown} page @param {number} expected @returns {page is PartitionPage} */
function validPage(page, expected) {
  return isRecord(page) && page.page === expected && typeof page.text === "string" &&
    /^[0-9a-f]{64}$/.test(String(page.text_generation)) &&
    Object.keys(page).every(key => ["page", "text", "text_generation"].includes(key));
}
/** @param {unknown} value @param {{start: number, end: number}} part
 * @param {{sourceSha: string, generation: string}} configuration
 * @returns {value is Omit<SearchPartition, "pages"> & {pages: unknown}} */
function validHeader(value, part, configuration) {
  return isRecord(value) && value.version === 1 && value.kind === "pdf-search-text-partition" &&
    value.source_sha256 === configuration.sourceSha && value.generation === configuration.generation &&
    value.offset_unit === "unicode-codepoint" && typeof value.start === "number" && typeof value.end === "number" &&
    value.start === part.start && value.end === part.end;
}
/** @param {unknown} value @param {{start: number, end: number}} part
 * @param {{sourceSha: string, generation: string}} configuration @returns {value is SearchPartition} */
function validPartition(value, part, configuration) {
  return validHeader(value, part, configuration) && Array.isArray(value.pages) &&
    value.pages.length === part.end - part.start + 1 &&
    value.pages.every((page, index) => validPage(page, part.start + index));
}
/** @param {unknown} value @param {{start: number, end: number}} part
 * @param {{sourceSha: string, generation: string}} configuration @returns {SearchPartition} */
export function validatePdfSearchPartition(value, part, configuration) {
  if (!validPartition(value, part, configuration)) throw new Error("PDF_TEXT_INDEX_INVALID");
  return value;
}

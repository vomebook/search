import {validPdfBookUrl, searchPath} from "./reader-pdf-book-url.mjs";
/** @typedef {{start: number, end: number, url: string, bytes: number, sha256: string}} PartitionReference */
/** @typedef {{generation: string, sourceSha: string, pageCount: number, partitions: PartitionReference[]}} PartitionConfiguration */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object"; }
/** @param {unknown} value @returns {value is {generation: string, sourceSha: string, pageCount: number, partitions: unknown[]}} */
function validHeader(value) {
  return isRecord(value) && typeof value.generation === "string" && /^[0-9a-f]{64}$/.test(value.generation) &&
    typeof value.sourceSha === "string" && /^[0-9a-f]{64}$/.test(value.sourceSha) &&
    typeof value.pageCount === "number" && Number.isSafeInteger(value.pageCount) && value.pageCount >= 1 &&
    Array.isArray(value.partitions);
}
/** @param {unknown} value @returns {value is PartitionReference} */
function isReference(value) {
  return isRecord(value) && typeof value.start === "number" && typeof value.end === "number" &&
    typeof value.url === "string" && typeof value.bytes === "number" && typeof value.sha256 === "string";
}
/** @param {PartitionReference} part @param {number} next @param {number} total */
function validBounds(part, next, total) {
  return Number.isSafeInteger(part.start) && Number.isSafeInteger(part.end) && part.start === next &&
    part.end >= part.start && part.end <= total && part.end - part.start < 32;
}
/** @param {PartitionReference} part @param {string} sourceSha @param {string} href @param {string} path */
function validPath(part, sourceSha, href, path) {
  const suffix = `text/search-${String(part.start).padStart(6,"0")}-${String(part.end).padStart(6,"0")}.json.gz`;
  return validPdfBookUrl(part.url, href, searchPath) && path.endsWith(suffix) &&
    path.includes(`objects/${sourceSha.slice(0,2)}/${sourceSha}/`);
}
/** @param {PartitionReference} part @param {number} limit */
function validDigest(part, limit) {
  return Number.isSafeInteger(part.bytes) && part.bytes >= 1 && part.bytes <= limit && /^[0-9a-f]{64}$/.test(part.sha256);
}
/** @param {unknown} value @param {string} href @param {number} limit @returns {void} */
export function validatePdfPartitionConfiguration(value, href, limit) {
  if (!validHeader(value)) throw new Error("PDF_TEXT_INDEX_INCOMPLETE");
  let next = 1;
  for (const part of value.partitions) {
    if (!isReference(part)) throw new Error("PDF_TEXT_INDEX_INVALID");
    // URL construction and fallback decoding precede metadata checks, as before.
    const url = new URL(part.url, href);
    const path = url.searchParams.get("path") || decodeURIComponent(url.pathname);
    if (!validBounds(part, next, value.pageCount) || !validPath(part, value.sourceSha, href, path) || !validDigest(part, limit))
      throw new Error("PDF_TEXT_INDEX_INVALID");
    next = part.end + 1;
  }
  if (next !== value.pageCount + 1) throw new Error("PDF_TEXT_INDEX_INCOMPLETE");
}

// Network and memory admission rules for PDF text-partition search.
const MAX_BYTES = 1024 * 1024;

/** @param {{saveData?: unknown, effectiveType?: unknown} | null | undefined} connection @param {number} bytes */
export function canPrefetchPdfPartition(connection, bytes) {
  return !connection?.saveData && connection?.effectiveType !== "slow-2g" && connection?.effectiveType !== "2g" &&
    Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_BYTES;
}

/** @param {{pages: {text: string}[]}} part */
export function canRetainPdfPartition(part) {
  let bytes = 0;
  for (const page of part.pages) {
    bytes += page.text.length * 2;
    if (bytes > MAX_BYTES) return false;
  }
  try { return new TextEncoder().encode(JSON.stringify(part)).byteLength <= MAX_BYTES; }
  catch (_) { return false; }
}

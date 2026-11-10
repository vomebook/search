// Verify immutable compressed search data before exposing its JSON payload.
import {readPdfSearchText} from "./reader-pdf-search-stream.mjs";

/** @param {Uint8Array<ArrayBuffer>} packed @param {string} expected
 * @param {AbortSignal} signal @param {number} limit @returns {Promise<string>} */
export async function readVerifiedPdfSearchText(packed, expected, signal, limit) {
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", packed))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
  if (digest !== expected) throw new Error("PDF_OCR_HASH_MISMATCH");
  const stream = new ReadableStream({start(owner) { owner.enqueue(packed); owner.close(); }});
  // The stream owns the bytes; clear the helper's binding before awaiting decode.
  packed = new Uint8Array(0);
  return readPdfSearchText(stream.pipeThrough(new DecompressionStream("gzip")), signal, limit);
}

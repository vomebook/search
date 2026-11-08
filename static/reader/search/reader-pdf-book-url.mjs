// Immutable Reader OCR/book search objects accepted by the PDF search Worker.
const bookPath = /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:(?:[0-9a-f]{16}\/)?ocr\/book-text\.json\.gz|[0-9a-f]{16}\/text\/book-text\.json\.gz)$/;
export const searchPath = /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/[0-9a-f]{16}\/text\/search-([0-9]{6})-([0-9]{6})\.json\.gz$/;
/** @param {string} raw @param {string} href @param {RegExp} [pathPattern] */
export function validPdfBookUrl(raw, href, pathPattern = bookPath) {
  const url = new URL(raw, href);
  if (url.username || url.password || url.hash) return false;
  if (url.pathname !== "/api/reader-bucket-resource") return false;
  const origin = new URL(href).origin;
  const path = url.searchParams.get("path");
  return (url.origin === origin || url.origin === "https://voiceofml-search.hf.space") &&
    url.searchParams.getAll("path").length === 1 &&
    [...url.searchParams.keys()].every(key => key === "path") &&
    pathPattern.test(String(path));
}

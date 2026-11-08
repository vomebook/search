// Only the Reader content proxy and immutable chapter search index endpoint
// are valid chapter-search Worker inputs. Origin is chosen by the site caller.
/** @param {URL} url @param {string} origin @returns {boolean} */
export function isSearchIndexProxyURL(url, origin) {
  if (url.origin !== origin || url.username || url.password || url.hash) return false;
  if (url.pathname === "/api/reader-content") return true;
  if (url.pathname !== "/api/reader-bucket-resource") return false;
  if (url.searchParams.getAll("path").length !== 1) return false;
  if (![...url.searchParams.keys()].every(key => key === "path")) return false;
  const path=url.searchParams.get("path");
  return typeof path === "string" &&
    /^chapters\/ebook\/(?:epub|mobi|azw3|fb2|chm)\/[0-9a-f]{64}\/[0-9a-f]{16}\/epub-search-index\.json\.gz$/.test(path);
}

// Escape before insertion and match raw text so terms never match markup or entities.
{
  const HTML_ESCAPE_MAP = /** @type {Record<string, string>} */ ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"});
  /** @param {unknown} str @returns {string | undefined} */
  function escapeSearchHTML(str) {
    // The native matcher supplies one of the five keys; preserve dynamic lookup.
    return String(str).replace(/[&<>"']/g, (ch) => /** @type {string} */ (HTML_ESCAPE_MAP[ch]));
  }

  /** @type {Map<string, RegExp | null>} */
  const highlightRegexCache = new Map();

  // One alternation over the raw text (longest term first), so a later term can
  // never match inside an earlier <mark> tag or an HTML entity.
  /** @param {string} query @returns {RegExp | null} */
  function searchHighlightRegex(query) {
    if (highlightRegexCache.has(query)) return /** @type {RegExp | null} */ (highlightRegexCache.get(query));
    const terms = [...new Set(query.split(/\s+/).filter((t) => t.length > 0))]
      .sort((a, b) => b.length - a.length)
      .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const regex = terms.length ? new RegExp(terms.join("|"), "gi") : null;
    if (highlightRegexCache.size >= 20) highlightRegexCache.delete(/** @type {string} */ (highlightRegexCache.keys().next().value));
    highlightRegexCache.set(query, regex);
    return regex;
  }

  /** @param {unknown} text @param {string | null | undefined} query @returns {string | undefined} */
  function highlightSearchText(text, query) {
    if (!query || !text) return escapeSearchHTML(text);
    const regex = searchHighlightRegex(query);
    if (!regex) return escapeSearchHTML(text);
    const source = String(text);
    let result = "", last = 0;
    for (const match of source.matchAll(regex)) {
      if (!match[0]) continue;
      const index = /** @type {number} */ (match.index);
      result += escapeSearchHTML(source.slice(last, index)) + "<mark>" + escapeSearchHTML(match[0]) + "</mark>";
      last = index + match[0].length;
    }
    return result + escapeSearchHTML(source.slice(last));
  }

  /** @type {typeof globalThis & {escapeHTML: typeof escapeHTML, getHighlightRegex: typeof getHighlightRegex, highlightText: typeof highlightText}} */
  const globals = globalThis;
  globals.escapeHTML = escapeSearchHTML;
  globals.getHighlightRegex = searchHighlightRegex;
  globals.highlightText = highlightSearchText;
}

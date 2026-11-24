// One complete, validated text file per PDF. Offsets in generated mappings are
// Unicode code points; JavaScript RegExp returns UTF-16 offsets.
import {codePointLength, hitBoxesAtOffsets} from "./reader-pdf-hit-projection.mjs";

/** @param {string} query */
function pattern(query) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

const CHECKPOINT_STRIDE = 256;
const CHECKPOINT_PROJECTION_UNITS = 256 * 1024;
const CHECKPOINT_PROJECTION_COUNT = 4096;
const SEARCH_YIELD_MS = 8;
const SEARCH_YIELD_UNITS = 256 * 1024;

/** @param {import('../../../typings/reader-book-text-strict').Book} book @param {string} query @param {import('../../../typings/reader-book-text-strict').Options} [options] @returns {Promise<import('../../../typings/reader-book-text-strict').SearchIndex>} */
export async function searchBookText(book, query, options = {}) {
  const { current = () => true, yieldTask = () => new Promise(r => setTimeout(r, 0)), progress = null } = options;
  /** @type {number[]} */
  const counts = [];
  /** @type {import('../../../typings/reader-book-text-strict').Checkpoint[]} */
  const checkpoints = [];
  const re = pattern(query);
  let total = 0, deadline = performance.now() + SEARCH_YIELD_MS, pendingUnits = 0;
  if (!query) return { total: 0, page: () => ({ total: 0, offset: 0, pageSize: 50, results: [] }) };
  /** @type {Map<string, import('../../../typings/reader-book-text-strict').ResultPage>} */
  const pageCache = new Map();
  // Materialize code-point checkpoints only for the page actually opened by
  // the reader. Never add work to the foreground full-book scan.
  /** @type {import('../../../typings/reader-book-text-strict').ProjectionPage | null} */
  let projectionPage = null;
  /** @param {import('../../../typings/reader-book-text-strict').TextPage} page @param {number} pageIndex @param {number} target @param {number} checkpointPosition */
  function projectionFor(page, pageIndex, target, checkpointPosition) {
    if (!page.text_spans?.length || page.text.length > CHECKPOINT_PROJECTION_UNITS || target < CHECKPOINT_STRIDE) return null;
    if (!projectionPage || projectionPage.text !== page.text || projectionPage.pageIndex !== pageIndex)
      projectionPage = {text:page.text, pageIndex, end:0, point:0, checkpoints:new Map()};
    const state = projectionPage;
    if (state.checkpoints.has(target)) return state.checkpoints.get(target);
    if (state.end > target || state.checkpoints.size >= CHECKPOINT_PROJECTION_COUNT) return null;
    // Scan only gaps between *existing* match checkpoints; do not rerun the
    // query or alter its Unicode matching semantics.
    // Checkpoints are sorted by page. Visit only this page's prefix, never the
    // full book's checkpoint list when jumping to a late mapped page.
    let low = 0, high = checkpointPosition + 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      const candidate = checkpoints[middle];
      if (candidate && candidate.pageIndex < pageIndex) low = middle + 1;
      else high = middle;
    }
    for (let position = low; position <= checkpointPosition; position++) {
      const candidate = checkpoints[position];
      if (!candidate || candidate.start < state.end) continue;
      const end = candidate.end;
      state.point += codePointLength(page.text.slice(state.end,end));
      state.end = end;
      state.checkpoints.set(candidate.start,{end,point:state.point});
      if (state.checkpoints.size >= CHECKPOINT_PROJECTION_COUNT) break;
    }
    return state.checkpoints.get(target) || null;
  }
  /** @type {import('../../../typings/reader-book-text-strict').SearchIndex} */
  const indexResult = { get total() { return total; }, page(offset = 0, pageSize = 50) {
    offset = Math.max(0, Math.min(Math.max(0, total - 1), Math.floor(offset)));
    offset = Math.floor(offset / pageSize) * pageSize;
    const key = `${offset}:${pageSize}`;
    const cached = pageCache.get(key);
    if (cached?.total === total) {
      pageCache.delete(key);
      pageCache.set(key, cached);
      return cached;
    }
    const results = [];
    let checkpoint = null, checkpointPosition = -1;
    for (let low = 0, high = checkpoints.length - 1; low <= high;) {
      const middle = (low + high) >> 1;
      const candidate = checkpoints[middle];
      if (candidate && candidate.ordinal <= offset) {
        checkpoint = candidate;
        checkpointPosition = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    let passed = checkpoint?.ordinal || 0;
    const firstPage = checkpoint?.pageIndex || 0;
    for (let index = firstPage; index < counts.length && results.length < pageSize; index++) {
      // A global checkpoint's ordinal is already inside its page. Do not add
      // that page's full count again; only whole subsequent pages can skip.
      const count = counts[index], page = book.pages[index];
      if (count === undefined || !page) break;
      const pageCheckpoint = index === firstPage ? checkpoint : null;
      if (!pageCheckpoint && passed + count <= offset) { passed += count; continue; }
      const start = pageCheckpoint?.start ?? 0;
      // Partitioned v3 text carries no boxes; computing code-point offsets
      // from the beginning of a large page cannot affect those results.
      const hasBoxes = !!page.text_spans?.length;
      const projection = pageCheckpoint ? projectionFor(page,index,start,checkpointPosition) : null;
      let previousUnitEnd = projection?.end ?? 0, previousPointEnd = projection?.point ?? 0;
      for (const match of page.text.slice(start).matchAll(re)) {
        const matchIndex = start + match.index;
        if (passed++ < offset) continue;
        const begin = Math.max(0, matchIndex - 72), end = Math.min(page.text.length, matchIndex + match[0].length + 88);
        /** @type {import('../../../typings/reader-book-text-strict').Box[]} */
        let boxes = [];
        if (hasBoxes) {
          // If the checkpoint already counted this match, recover its start
          // with the same independent code-point count used by hitBoxes.
          const matchPoints = codePointLength(match[0]);
          const pointEnd = matchIndex < previousUnitEnd ? previousPointEnd :
            previousPointEnd + codePointLength(page.text.slice(previousUnitEnd, matchIndex)) + matchPoints;
          const pointStart = pointEnd - matchPoints;
          previousUnitEnd = matchIndex + match[0].length;
          previousPointEnd = pointEnd;
          boxes = hitBoxesAtOffsets(page, pointStart, pointEnd);
        }
        results.push({ page: page.page, start: matchIndex, length: match[0].length,
          boxes,
          snippet: { text: page.text.slice(begin, end), matchStart: matchIndex - begin,
            matchLength: match[0].length, prefix: begin ? "…" : "", suffix: end < page.text.length ? "…" : "" } });
        if (results.length === pageSize) break;
      }
    }
    const page = { total, offset, pageSize, results };
    if (pageSize <= 50) {
      pageCache.delete(key);
      pageCache.set(key, page);
      if (pageCache.size > 4) {
        const oldest = pageCache.keys().next();
        if (!oldest.done) pageCache.delete(oldest.value);
      }
    }
    return page;
  } };
  for (const [index, page] of book.pages.entries()) {
    if (!current()) throw new DOMException("Search cancelled", "AbortError");
    let count = 0;
    const text = page.text;
    for (const match of text.matchAll(re)) {
      if ((total + count) % CHECKPOINT_STRIDE === 0)
        checkpoints.push({ ordinal: total + count, pageIndex: index, start: match.index, end: match.index + match[0].length });
      count++;
      if (count % 2048 === 0) {
        await yieldTask();
        deadline = performance.now() + SEARCH_YIELD_MS;
        pendingUnits = 0;
        if (!current()) throw new DOMException("Search cancelled", "AbortError");
      }
    }
    pendingUnits += text.length;
    counts.push(count);
    total += count;
    if (progress && (index === 0 || (count && total <= 50) || index % 16 === 15 || index === book.pages.length - 1))
      await progress(indexResult, index + 1, book.pages.length);
    // Check at the existing 16-page boundaries. The time budget avoids
    // gratuitous timer clamping on short pages; the volume guard still yields
    // when a background tab's clock has coarse resolution or is paused.
    if (index % 16 === 0 && (performance.now() >= deadline || pendingUnits >= SEARCH_YIELD_UNITS)) {
      await yieldTask();
      if (!current()) throw new DOMException("Search cancelled", "AbortError");
      deadline = performance.now() + SEARCH_YIELD_MS;
      pendingUnits = 0;
    }
  }
  return indexResult;
}

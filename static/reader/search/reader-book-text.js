// One complete, validated text file per PDF. Offsets in generated mappings are
// Unicode code points; JavaScript RegExp returns UTF-16 offsets.
import {validatePdfBookText} from "./reader-pdf-book-validate.mjs";
// Keep the public legacy export and argument order while validation is isolated.
export {validatePdfBookText as validateBookText};

function pattern(query) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

const CHECKPOINT_STRIDE = 256;
const CHECKPOINT_PROJECTION_UNITS = 256 * 1024;
const CHECKPOINT_PROJECTION_COUNT = 4096;
const SEARCH_YIELD_MS = 8;
const SEARCH_YIELD_UNITS = 256 * 1024;

export function hitBoxes(page, start, length) {
  const begin = codePointLength(page.text.slice(0, start));
  const end = begin + codePointLength(page.text.slice(start, start + length));
  return hitBoxesAtOffsets(page, begin, end);
}

function hitBoxesAtOffsets(page, begin, end) {
  const spans = page.text_spans || [], boxes = [];
  let low = 0, high = spans.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (spans[mid].end <= begin) low = mid + 1;
    else high = mid;
  }
  for (let index = low; index < spans.length && spans[index].start < end; index++) {
    const span = spans[index];
    boxes.push({ box: span.box, block: span.block, precision: span.precision || "block" });
  }
  return boxes;
}

/** @param {{current?: () => boolean, yieldTask?: () => Promise<unknown>, progress?: ((index: any, scanned: number, total: number) => Promise<unknown> | void) | null}} [options] */
export async function searchBookText(book, query, options = {}) {
  const { current = () => true, yieldTask = () => new Promise(r => setTimeout(r, 0)), progress = null } = options;
  const counts = [], checkpoints = [], re = pattern(query);
  let total = 0, deadline = performance.now() + SEARCH_YIELD_MS, pendingUnits = 0;
  if (!query) return { total: 0, page: () => ({ total: 0, offset: 0, pageSize: 50, results: [] }) };
  const pageCache = new Map();
  // Materialize code-point checkpoints only for the page actually opened by
  // the reader. Never add work to the foreground full-book scan.
  let projectionPage = null;
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
      if (checkpoints[middle].pageIndex < pageIndex) low = middle + 1;
      else high = middle;
    }
    for (let position = low; position <= checkpointPosition; position++) {
      const candidate = checkpoints[position];
      if (candidate.start < state.end) continue;
      const end = candidate.end;
      state.point += codePointLength(page.text.slice(state.end,end));
      state.end = end;
      state.checkpoints.set(candidate.start,{end,point:state.point});
      if (state.checkpoints.size >= CHECKPOINT_PROJECTION_COUNT) break;
    }
    return state.checkpoints.get(target) || null;
  }
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
      if (checkpoints[middle].ordinal <= offset) {
        checkpoint = checkpoints[middle];
        checkpointPosition = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    let passed = checkpoint?.ordinal || 0;
    const firstPage = checkpoint?.pageIndex || 0;
    for (let index = firstPage; index < counts.length && results.length < pageSize; index++) {
      // A global checkpoint's ordinal is already inside its page. Do not add
      // that page's full count again; only whole subsequent pages can skip.
      if (!(checkpoint && index === firstPage) && passed + counts[index] <= offset) { passed += counts[index]; continue; }
      const page = book.pages[index];
      const start = checkpoint && index === firstPage ? checkpoint.start : 0;
      // Partitioned v3 text carries no boxes; computing code-point offsets
      // from the beginning of a large page cannot affect those results.
      const hasBoxes = !!page.text_spans?.length;
      const projection = checkpoint && index === firstPage ? projectionFor(page,index,start,checkpointPosition) : null;
      let previousUnitEnd = projection?.end ?? 0, previousPointEnd = projection?.point ?? 0;
      for (const match of page.text.slice(start).matchAll(re)) {
        const matchIndex = start + match.index;
        if (passed++ < offset) continue;
        const begin = Math.max(0, matchIndex - 72), end = Math.min(page.text.length, matchIndex + match[0].length + 88);
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
      if (pageCache.size > 4) pageCache.delete(pageCache.keys().next().value);
    }
    return page;
  } };
  for (let index = 0; index < book.pages.length; index++) {
    if (!current()) throw new DOMException("Search cancelled", "AbortError");
    let count = 0;
    const text = book.pages[index].text;
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

export function createBookTextCache(load) {
  let value = null, pending = null;
  return { async get() {
    if (value) return value;
    if (!pending) pending = Promise.resolve().then(load).then(book => (value = book)).finally(() => { pending = null; });
    return pending;
  }, clear() { value = null; pending = null; } };
}

export function paintTextHit(shell, boxes, hit = null) {
  shell.querySelectorAll(".reader-text-hit-box").forEach(node => node.remove());
  const positioned = positionedHitBoxes(shell, hit);
  for (const { box, precision } of positioned?.length ? positioned : boxes) {
    const mark = shell.ownerDocument.createElement("span");
    mark.className = "reader-text-hit-box";
    mark.setAttribute("aria-hidden", "true");
    mark.dataset.mappingPrecision = precision || 'block';
    Object.assign(mark.style, { position: "absolute", pointerEvents: "none", zIndex: "4",
      left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`,
      height: `${(box[3] - box[1]) * 100}%`, background: "rgb(240 199 94 / 45%)" });
    shell.appendChild(mark);
  }
}

function codePointLength(text) {
  let length = 0;
  for (const point of text) length++;
  return length;
}


function positionedHitBoxes(shell, hit) {
  const layer = shell.querySelector('.reader-pdf-text[data-text-generation]');
  if (!layer || !Number.isSafeInteger(hit?.start) || hit.start < 0 ||
      !Number.isSafeInteger(hit?.length) || hit.length < 1) return null;
  const walker = layer.ownerDocument.createTreeWalker(layer, 4);
  let offset = 0, start = null, end = null;
  while (walker.nextNode()) {
    const node = walker.currentNode, next = offset + node.data.length;
    if (!start && hit.start < next) start = [node, hit.start - offset];
    if (start && hit.start + hit.length <= next) {
      end = [node, hit.start + hit.length - offset];
      break;
    }
    offset = next;
  }
  if (!end) return null;
  const range = layer.ownerDocument.createRange();
  range.setStart(...start); range.setEnd(...end);
  const bounds = shell.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
  if (!rects.length || rects.length > 256) return null;
  return rects.map(rect => ({ precision: 'text-range', box: [
    Math.max(0, (rect.left - bounds.left) / bounds.width), Math.max(0, (rect.top - bounds.top) / bounds.height),
    Math.min(1, (rect.right - bounds.left) / bounds.width), Math.min(1, (rect.bottom - bounds.top) / bounds.height)
  ] })).filter(({ box }) => box[2] > box[0] && box[3] > box[1]);
}

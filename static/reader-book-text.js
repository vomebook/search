// One complete, validated text file per PDF. Offsets in generated mappings are
// Unicode code points; JavaScript RegExp returns UTF-16 offsets.
export function validateBookText(book, pageCount, sourceSha = "") {
  if (!book || book.version !== 2 || book.kind !== "pdf-book-text" ||
      book.complete !== true || book.offset_unit !== "unicode-codepoint" ||
      book.page_count !== pageCount || (sourceSha && book.source_sha256 !== sourceSha) ||
      !Array.isArray(book.pages) || book.pages.length !== pageCount)
    throw new Error("PDF_TEXT_INDEX_INCOMPLETE");
  for (const [index, page] of book.pages.entries()) {
    if (page.page !== index + 1 || typeof page.text !== "string" ||
        !page.layout || page.layout.offset_unit !== "unicode-codepoint" ||
        !Array.isArray(page.text_spans))
      throw new Error("PDF_TEXT_INDEX_INVALID");
    const length = codePointLength(page.text);
    let previousEnd = 0;
    for (const span of page.text_spans) {
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end) ||
          span.start < previousEnd || span.end <= span.start || span.end > length ||
          !Array.isArray(span.box) || span.box.length !== 4 ||
          span.box.some(v => !Number.isFinite(v) || v < 0 || v > 1) ||
          span.box[0] > span.box[2] || span.box[1] > span.box[3])
        throw new Error("PDF_TEXT_MAPPING_INVALID");
      previousEnd = span.end;
    }
  }
  return book;
}

function pattern(query) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

const CHECKPOINT_STRIDE = 256;

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

export async function searchBookText(book, query, { current = () => true, yieldTask = () => new Promise(r => setTimeout(r, 0)), progress = null } = {}) {
  const counts = [], checkpoints = [], re = pattern(query);
  let total = 0;
  if (!query) return { total: 0, page: () => ({ total: 0, offset: 0, pageSize: 50, results: [] }) };
  const pageCache = new Map();
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
    let checkpoint = null;
    for (let low = 0, high = checkpoints.length - 1; low <= high;) {
      const middle = (low + high) >> 1;
      if (checkpoints[middle].ordinal <= offset) {
        checkpoint = checkpoints[middle];
        low = middle + 1;
      } else high = middle - 1;
    }
    let passed = checkpoint?.ordinal || 0;
    const firstPage = checkpoint?.pageIndex || 0;
    for (let index = firstPage; index < counts.length && results.length < pageSize; index++) {
      if (passed + counts[index] <= offset) { passed += counts[index]; continue; }
      const page = book.pages[index];
      const start = checkpoint && index === firstPage ? checkpoint.start : 0;
      let previousUnitEnd = 0, previousPointEnd = 0;
      for (const match of page.text.slice(start).matchAll(re)) {
        const matchIndex = start + match.index;
        if (passed++ < offset) continue;
        const begin = Math.max(0, matchIndex - 72), end = Math.min(page.text.length, matchIndex + match[0].length + 88);
        const pointStart = previousPointEnd + codePointLength(page.text.slice(previousUnitEnd, matchIndex));
        const pointEnd = pointStart + codePointLength(match[0]);
        previousUnitEnd = matchIndex + match[0].length;
        previousPointEnd = pointEnd;
        results.push({ page: page.page, start: matchIndex, length: match[0].length,
          boxes: hitBoxesAtOffsets(page, pointStart, pointEnd),
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
    for (const match of book.pages[index].text.matchAll(re)) {
      if ((total + count) % CHECKPOINT_STRIDE === 0)
        checkpoints.push({ ordinal: total + count, pageIndex: index, start: match.index });
      count++;
      if (count % 2048 === 0) {
        await yieldTask();
        if (!current()) throw new DOMException("Search cancelled", "AbortError");
      }
    }
    counts.push(count);
    total += count;
    if (progress && (index === 0 || (count && total <= 50) || index % 16 === 15 || index === book.pages.length - 1))
      await progress(indexResult, index + 1, book.pages.length);
    if (index % 16 === 0) await yieldTask();
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

export function paintTextHit(shell, boxes) {
  shell.querySelectorAll(".reader-text-hit-box").forEach(node => node.remove());
  for (const { box } of boxes) {
    const mark = shell.ownerDocument.createElement("span");
    mark.className = "reader-text-hit-box";
    mark.setAttribute("aria-hidden", "true");
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

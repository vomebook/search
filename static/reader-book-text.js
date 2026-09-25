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
    const length = Array.from(page.text).length;
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

export function hitBoxes(page, start, length) {
  const begin = Array.from(page.text.slice(0, start)).length;
  const end = begin + Array.from(page.text.slice(start, start + length)).length;
  return (page.text_spans || []).filter(s => s.end > begin && s.start < end)
    .map(s => ({ box: s.box, block: s.block, precision: s.precision || "block" }));
}

export async function searchBookText(book, query, { current = () => true, yieldTask = () => new Promise(r => setTimeout(r, 0)) } = {}) {
  const counts = [], re = pattern(query);
  let total = 0;
  if (!query) return { total: 0, page: () => ({ total: 0, offset: 0, pageSize: 50, results: [] }) };
  for (let index = 0; index < book.pages.length; index++) {
    if (!current()) throw new DOMException("Search cancelled", "AbortError");
    let count = 0;
    for (const match of book.pages[index].text.matchAll(re)) {
      count++;
      if (count % 2048 === 0) {
        await yieldTask();
        if (!current()) throw new DOMException("Search cancelled", "AbortError");
      }
    }
    counts.push(count);
    total += count;
    if (index % 16 === 0) await yieldTask();
  }
  return { total, page(offset = 0, pageSize = 50) {
    offset = Math.max(0, Math.min(Math.max(0, total - 1), Math.floor(offset)));
    offset = Math.floor(offset / pageSize) * pageSize;
    const results = [];
    let passed = 0;
    for (let index = 0; index < book.pages.length && results.length < pageSize; index++) {
      if (passed + counts[index] <= offset) { passed += counts[index]; continue; }
      const page = book.pages[index];
      for (const match of page.text.matchAll(re)) {
        if (passed++ < offset) continue;
        const begin = Math.max(0, match.index - 72), end = Math.min(page.text.length, match.index + match[0].length + 88);
        results.push({ page: page.page, start: match.index, length: match[0].length,
          boxes: hitBoxes(page, match.index, match[0].length),
          snippet: { text: page.text.slice(begin, end), matchStart: match.index - begin,
            matchLength: match[0].length, prefix: begin ? "…" : "", suffix: end < page.text.length ? "…" : "" } });
        if (results.length === pageSize) break;
      }
    }
    return { total, offset, pageSize, results };
  } };
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

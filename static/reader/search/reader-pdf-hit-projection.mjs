// Keep this module free of runtime imports so a retry URL can recover the
// entire projection. Validation stays in the book-text/Worker graph.

/** @param {string} text */
export function codePointLength(text) {
  let length = 0;
  for (const point of text) length++;
  return length;
}

/** @param {import('../../../typings/reader-book-text-strict').TextMapping} page @param {number} start @param {number} length */
export function hitBoxes(page, start, length) {
  const begin = codePointLength(page.text.slice(0, start));
  const end = begin + codePointLength(page.text.slice(start, start + length));
  return hitBoxesAtOffsets(page, begin, end);
}

/** @param {import('../../../typings/reader-book-text-strict').TextMapping} page @param {number} begin @param {number} end */
export function hitBoxesAtOffsets(page, begin, end) {
  const spans = page.text_spans || [], boxes = [];
  let low = 0, high = spans.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((spans[mid]?.end ?? Infinity) <= begin) low = mid + 1;
    else high = mid;
  }
  for (let index = low; index < spans.length; index++) {
    const span = spans[index];
    if (!span || span.start >= end) break;
    boxes.push({ box: span.box, block: span.block, precision: typeof span.precision === "string" && span.precision ? span.precision : "block" });
  }
  return boxes;
}

/** @param {import('../../../typings/reader-book-text-strict').Shell} shell @param {import('../../../typings/reader-book-text-strict').Box[]} boxes @param {{start: number, length: number} | null} [hit] */
export function paintTextHit(shell, boxes, hit = null) {
  shell.querySelectorAll(".reader-text-hit-box").forEach(node => node.remove());
  const positioned = positionedHitBoxes(shell, hit);
  for (const { box: [left, top, right, bottom], precision } of positioned?.length ? positioned : boxes) {
    if (left === undefined || top === undefined || right === undefined || bottom === undefined) continue;
    const mark = shell.ownerDocument.createElement("span");
    mark.className = "reader-text-hit-box";
    mark.setAttribute("aria-hidden", "true");
    mark.dataset.mappingPrecision = /** @type {string} */ (precision || 'block');
    Object.assign(mark.style, { position: "absolute", pointerEvents: "none", zIndex: "4",
      left: `${left * 100}%`, top: `${top * 100}%`, width: `${(right - left) * 100}%`,
      height: `${(bottom - top) * 100}%`, background: "rgb(240 199 94 / 45%)" });
    shell.appendChild(mark);
  }
}

/** @param {import('../../../typings/reader-book-text-strict').Shell} shell @param {{start: number, length: number} | null} hit @returns {import('../../../typings/reader-book-text-strict').Box[] | null} */
function positionedHitBoxes(shell, hit) {
  const layer = shell.querySelector('.reader-pdf-text[data-text-generation]');
  if (!layer || !hit || !Number.isSafeInteger(hit.start) || hit.start < 0 ||
      !Number.isSafeInteger(hit.length) || hit.length < 1) return null;
  const walker = layer.ownerDocument.createTreeWalker(layer, 4);
  let offset = 0;
  /** @type {[import('../../../typings/reader-book-text-strict').TextNode, number] | null} */
  let start = null;
  /** @type {[import('../../../typings/reader-book-text-strict').TextNode, number] | null} */
  let end = null;
  while (walker.nextNode()) {
    // SHOW_TEXT restricts this walker to Text nodes.
    const textNode = /** @type {import('../../../typings/reader-book-text-strict').TextNode} */ (walker.currentNode), next = offset + textNode.data.length;
    if (!start && hit.start < next) start = [textNode, hit.start - offset];
    if (start && hit.start + hit.length <= next) {
      end = [textNode, hit.start + hit.length - offset];
      break;
    }
    offset = next;
  }
  if (!start || !end) return null;
  const range = layer.ownerDocument.createRange();
  range.setStart(...start); range.setEnd(...end);
  const bounds = shell.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
  if (!rects.length || rects.length > 256) return null;
  return rects.map(rect => ({ precision: 'text-range', box: [
    Math.max(0, (rect.left - bounds.left) / bounds.width), Math.max(0, (rect.top - bounds.top) / bounds.height),
    Math.min(1, (rect.right - bounds.left) / bounds.width), Math.min(1, (rect.bottom - bounds.top) / bounds.height)
  ] })).filter(({ box: [left, top, right, bottom] }) => left !== undefined && top !== undefined &&
    right !== undefined && bottom !== undefined && right > left && bottom > top);
}

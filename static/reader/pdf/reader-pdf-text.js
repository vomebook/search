// PDF.js already emits word spaces. Adding a space after every item breaks
// Chinese words and words split across fonts. Keep the source's explicit spaces.
/** @param {import('../../../typings/reader-pdf-part-strict').PdfTextItem[]} items */
export function pdfTextContent(items) {
  return items.filter((item) => typeof item.str === "string")
    .map((item) => item.str + (item.hasEOL ? "\n" : "")).join("");
}

// Embedded OCR often spaces individual Han characters, including vertical text.
// Keep punctuation and Latin word boundaries, and map hits back to source offsets.
const hanWordSpacing = /(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu;
/** @param {string} raw */
export function normalizePdfSearchText(raw) {
  return raw.replace(hanWordSpacing, "");
}
/** @param {{offsets: Uint32Array | null}} mapping @param {number} index */
export function pdfSourceOffset(mapping, index) {
  const offsets = mapping.offsets;
  if (!offsets) return index;
  let low = 0, high = offsets.length / 2;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((offsets[middle * 2] ?? Infinity) <= index) low = middle + 1;
    else high = middle;
  }
  return index + (low ? (offsets[(low - 1) * 2 + 1] ?? 0) : 0);
}
/** @param {string} raw */
export function pdfSearchText(raw) {
  const offsets = [], chunks = [];
  let start = 0, removed = 0;
  for (const match of raw.matchAll(hanWordSpacing)) {
    chunks.push(raw.slice(start, match.index));
    const boundary = match.index - removed;
    removed += match[0].length;
    offsets.push(boundary, removed);
    start = match.index + match[0].length;
  }
  if (!offsets.length) return { text: raw, offsets: null };
  chunks.push(raw.slice(start));
  return { text: chunks.join(""), offsets: new Uint32Array(offsets) };
}

/** @param {HTMLElement} layer @param {string} text @returns {import('../../../typings/reader-pdf-part-strict').VerticalRun} */
function textRun(layer, text) {
  const run = layer.ownerDocument.createElement("span");
  run.className = "reader-pdf-text-run";
  run.textContent = text;
  return run;
}

/** @type {WeakMap<Document, CanvasRenderingContext2D | null>} */
const measurements = new WeakMap();
/** @param {number} value */
function normalizeBox(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
/** @typedef {{family: string | null, widths: Map<string, number>}} RunMeasurements */
/** @param {CanvasRenderingContext2D | null} context @param {string} text @param {string} family @param {number} targetWidth
 * @param {RunMeasurements | null} session */
function measureRunScale(context, text, family, targetWidth, session) {
  if (!context) return 1;
  // A text layer is built synchronously. Share widths within a run of the
  // same font, but never retain them across pages or font-load events.
  if (!session || session.family !== family) {
    context.font = `100px ${family}`;
    if (session) { session.family = family; session.widths.clear(); }
  }
  const widths = session && text.length <= 80 ? session.widths : null;
  let measured = widths?.get(text);
  if (measured === undefined) {
    measured = context.measureText(text).width / 100;
    if (widths && widths.size < 128) widths.set(text, measured);
  }
  return measured > 0 && targetWidth > 0 ? targetWidth / measured : 1;
}
/** @param {HTMLElement} layer @param {string} text @param {number} x @param {number} y @param {number} height @param {number} width @param {string} family
 * @param {RunMeasurements | null} [session] */
function positionedRun(layer, text, x, y, height, width, family, angle = 0, vertical = false, session = null) {
  const box = layer.ownerDocument.createElement("span");
  box.className = "reader-pdf-text-position reader-pdf-text-block";
  box.style.left = `${x * 100}%`;
  box.style.top = `${y * 100}%`;
  // cqw uses the page width, so text scales with zoom and responsive layout.
  box.style.fontSize = `${height * 100}cqw`;
  box.style.fontFamily = family;
  if (angle) box.style.transform = `rotate(${angle}rad)`;
  const run = textRun(layer, text);
  let context = measurements.get(layer.ownerDocument);
  if (!context) {
    context = layer.ownerDocument.createElement("canvas").getContext("2d");
    measurements.set(layer.ownerDocument, context);
  }
  if (vertical) {
    run.style.writingMode = "vertical-rl";
    run.style.textOrientation = "upright";
    // Estimate the scale until native PDF text is attached for measurement.
    const measured = Array.from(text).length;
    run._readerVerticalAdvance = width / height;
    if (width > 0 && measured) run.style.transform = `scaleY(${width / (height * measured)})`;
  } else {
    const scaleX = measureRunScale(context, text, family, width / height, session);
    run.style.setProperty("--reader-pdf-run-scale-x", String(scaleX));
    run.style.transform = "scaleX(var(--reader-pdf-run-scale-x))";
  }
  box.appendChild(run);
  return box;
}

/** @param {HTMLElement} layer @param {import('../../../typings/reader-pdf-part-strict').PdfTextItem[]} items @param {import('../../../typings/reader-pdf-part-strict').PdfTextViewport} viewport @param {Record<string, import('../../../typings/reader-pdf-part-strict').PdfTextStyle>} styles */
export function populatePdfTextLayer(layer, items, viewport, styles = {}) {
  const fragment = layer.ownerDocument.createDocumentFragment();
  const w = Math.max(1, viewport.width), h = Math.max(1, viewport.height);
  const session = items.length >= 32 ? {family: null, widths: new Map()} : null;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    if (item.str) {
      const [a, b, c, d, tx, ty] = item.transform || [];
      const [v0, v1, v2, v3] = viewport.transform || [];
      const [pointX, pointY] = tx !== undefined && ty !== undefined
        ? viewport.convertToViewportPoint?.(tx, ty) || [] : [];
      if (pointX !== undefined && pointY !== undefined &&
          a !== undefined && b !== undefined && c !== undefined && d !== undefined &&
          [a, b, c, d, tx, ty, pointX, pointY].every(Number.isFinite)) {
        const style = styles[item.fontName] || {};
        const family = style.fontFamily || "sans-serif";
        const vertical = style.vertical || item.dir === "ttb";
        const scale = viewport.scale || 1;
        const height = Math.hypot(c, d) * scale || 12;
        const angle = v0 !== undefined && v1 !== undefined && v2 !== undefined && v3 !== undefined
          ? Math.atan2(v1 * a + v3 * b, v0 * a + v2 * b) : 0;
        const ascent = height * (Number.isFinite(style.ascent) ? /** @type {number} */ (style.ascent) : 0.8);
        const x = vertical ? pointX - height / 2 : pointX + ascent * Math.sin(angle);
        const y = vertical ? pointY : pointY - ascent * Math.cos(angle);
        fragment.appendChild(positionedRun(layer, item.str, x / w, y / h, height / w,
          (vertical ? item.height : item.width) * scale / w, family, angle, vertical, session));
      } else {
        // Text without coordinates remains accessible, but never forms a visible
        // second text panel beneath the page image.
        fragment.appendChild(textRun(layer, item.str));
      }
    }
    if (item.hasEOL) fragment.appendChild(layer.ownerDocument.createTextNode("\n"));
  }
  layer.replaceChildren(fragment);
  // Read attached glyph geometry before writing transforms, avoiding a layout
  // flush for each vertical run on text-heavy pages.
  scaleVerticalRuns(layer);
}

/** @param {HTMLElement} layer @param {import('../../../typings/reader-pdf-part-strict').OcrBlock[]} blocks @param {{writing_mode?: 'vertical-rl' | 'vertical-lr' | 'horizontal-tb'}} layout */
export function populateOcrTextLayer(layer, blocks, layout = {}) {
  const fragment = layer.ownerDocument.createDocumentFragment();
  const ratio = /** @type {HTMLElement} */ (layer.parentElement).getBoundingClientRect();
  const vertical = layout?.writing_mode === "vertical-rl" || layout?.writing_mode === "vertical-lr";
  let positioned = 0;
  const fallback = [];
  for (const block of blocks || []) {
    const text = String(block?.t || ""), b = block?.b;
    if (!text) continue;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) {
      fallback.push(text);
      continue;
    }
    const [left, top, right, bottom] = b;
    if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
      fallback.push(text);
      continue;
    }
    const x1 = normalizeBox(left), y1 = normalizeBox(top), x2 = normalizeBox(right), y2 = normalizeBox(bottom);
    const width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
    if (!width || !height) {
      fallback.push(text);
      continue;
    }
    fragment.appendChild(positionedRun(layer, text, Math.min(x1, x2), Math.min(y1, y2),
      height * ratio.height / Math.max(1, ratio.width), width, "sans-serif", 0, vertical));
    fragment.appendChild(layer.ownerDocument.createTextNode("\n"));
    positioned++;
  }
  if (!positioned && fallback.length) {
    // Native-text extraction can provide correct text without coordinates.
    // Keep it selectable instead of dropping the entire page text layer.
    const box = layer.ownerDocument.createElement("div");
    box.className = "reader-pdf-text-fallback";
    if (vertical) {
      box.style.writingMode = /** @type {string} */ (layout.writing_mode);
      box.style.textOrientation = "upright";
    }
    box.appendChild(textRun(layer, fallback.join("\n")));
    fragment.appendChild(box);
  }
  layer.replaceChildren(fragment);
}

/** @param {HTMLElement} layer @param {import('../../../typings/reader-pdf-part-strict').IndependentTextPayload} payload */
export function populateIndependentTextLayer(layer, payload) {
  const fragment = layer.ownerDocument.createDocumentFragment();
  const text = payload.text, bounds = /** @type {HTMLElement} */ (layer.parentElement).getBoundingClientRect();
  const ratio = bounds.height / Math.max(1, bounds.width);
  let previous = 0;
  const ordered = payload.regions.every(region => {
    if (!Number.isSafeInteger(region.start) || !Number.isSafeInteger(region.end) ||
        region.start < previous || region.end <= region.start) return false;
    previous = region.end;
    return true;
  });
  // V3 validates ordered offsets, and native DjVu zones usually have them.
  // If a legacy/native sequence is irregular, retain the exact former slicing
  // behavior rather than silently changing text or selection.
  const chars = ordered ? null : Array.from(text);
  let point = 0, unit = 0, end = 0;
  /** @param {number} target */
  const advance = target => {
    while (point < target && unit < text.length) {
      const high = text.charCodeAt(unit++);
      if (high >= 0xd800 && high <= 0xdbff && unit < text.length) {
        const low = text.charCodeAt(unit);
        if (low >= 0xdc00 && low <= 0xdfff) unit++;
      }
      point++;
    }
    return unit;
  };
  for (const region of payload.regions) {
    const gap = unit;
    const separator = chars ? chars.slice(end, region.start).join("") : text.slice(gap, advance(region.start));
    fragment.appendChild(layer.ownerDocument.createTextNode(separator));
    const vertical = region.writing_mode.startsWith("vertical");
    const [origin, right, , bottom] = region.quad;
    const [x, y] = origin || [], [rx, ry] = right || [], [bx, by] = bottom || [];
    if (x === undefined || y === undefined || rx === undefined || ry === undefined || bx === undefined || by === undefined) {
      fragment.appendChild(textRun(layer, region.text));
      end = region.end;
      if (!chars) advance(end);
      continue;
    }
    const dx = rx - x, dy = (ry - y) * ratio;
    const angle = Math.atan2(dy, dx);
    const across = Math.hypot(dx, dy);
    const down = Math.hypot(bx - x, (by - y) * ratio);
    const height = vertical ? across : down;
    const width = vertical ? down : across;
    const positioned = positionedRun(layer, region.text, x,
      y, Math.max(height, .0001), width, "sans-serif", angle, vertical);
    const run = /** @type {HTMLSpanElement} */ (positioned.querySelector(".reader-pdf-text-run"));
    run.dir = ["rtl", "ltr"].includes(region.direction) ? region.direction : "auto";
    run.style.unicodeBidi = "plaintext";
    run.dataset.regionId = region.id;
    run.dataset.mappingPrecision = region.mapping_precision;
    if (vertical) run.style.writingMode = region.writing_mode === "vertical-lr" ? "vertical-lr" : "vertical-rl";
    fragment.appendChild(positioned);
    end = region.end;
    if (!chars) advance(end);
  }
  fragment.appendChild(layer.ownerDocument.createTextNode(chars ? chars.slice(end).join("") : text.slice(unit)));
  layer.replaceChildren(fragment);
  // Page surfaces disable selection; separators must be selectable along with runs.
  layer.style.userSelect = "text";
  layer.style.webkitUserSelect = "text";
  layer.dataset.textGeneration = payload.generation;
  // Mixed-script advances need attached native glyph metrics too.
  scaleVerticalRuns(layer);
}

/** @param {HTMLElement} layer */
function scaleVerticalRuns(layer) {
  /** @type {Array<[import('../../../typings/reader-pdf-part-strict').VerticalRun, number]>} */
  const scales = [];
  for (const run of /** @type {NodeListOf<import('../../../typings/reader-pdf-part-strict').VerticalRun>} */ (layer.querySelectorAll('.reader-pdf-text-run'))) {
    if (!(/** @type {number} */ (run._readerVerticalAdvance) > 0)) continue;
    const height = run.offsetHeight;
    if (!height) continue;
    const em = parseFloat(/** @type {Window} */ (layer.ownerDocument.defaultView).getComputedStyle(run).fontSize);
    scales.push([run, /** @type {number} */ (run._readerVerticalAdvance) * em / height]);
  }
  for (const [run, scale] of scales) run.style.transform = `scaleY(${scale})`;
}

/** @param {Element} run @param {number} x @param {number} y */
export function pdfTextRunCaret(run, x, y) {
  const doc = run.ownerDocument;
  const walker = doc.createTreeWalker(run, NodeFilter.SHOW_TEXT);
  /** @type {{node: Text, start: number, end: number}[]} */
  const parts = [];
  let length = 0;
  while (walker.nextNode()) {
    const node = /** @type {Text} */ (walker.currentNode);
    if (!node.length) continue;
    parts.push({ node, start: length, end: length + node.length });
    length += node.length;
  }
  if (!length) return null;
  /** @param {number} offset */
  const caretAt = offset => {
    let low = 0, high = parts.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((parts[mid]?.end ?? Infinity) <= offset) low = mid + 1;
      else high = mid;
    }
    const part = /** @type {{node: Text, start: number, end: number}} */ (parts[low]);
    return { node: part.node, offset: offset - part.start };
  };
  const rect = run.getBoundingClientRect();
  if (y < rect.top) return caretAt(0);
  if (y > rect.bottom) return caretAt(length);
  const range = doc.createRange();
  const style = doc.defaultView?.getComputedStyle(run);
  const vertical = style?.writingMode.startsWith("vertical");
  const reverse = !vertical && style?.direction === "rtl";
  const position = vertical ? y : x;
  let low = 0, high = length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const caret = caretAt(mid);
    range.setStart(caret.node, caret.offset);
    range.setEnd(caret.node, caret.offset + 1);
    const glyph = range.getBoundingClientRect();
    const center = vertical ? (glyph.top + glyph.bottom) / 2 : (glyph.left + glyph.right) / 2;
    if (reverse ? center > position : center < position) low = mid + 1;
    else high = mid;
  }
  const caret = caretAt(low);
  caret.offset = codePointBoundary(caret.node, caret.offset);
  return caret;
}

/** @param {Text} node @param {number} offset */
function codePointBoundary(node, offset) {
  if (offset > 0 && offset < node.length && /[\uDC00-\uDFFF]/.test(node.data.charAt(offset)) &&
      /[\uD800-\uDBFF]/.test(node.data.charAt(offset - 1))) return offset - 1;
  return offset;
}

/** @param {Document} doc @param {number} x @param {number} y */
export function independentTextCaret(doc, x, y) {
  const position = doc.caretPositionFromPoint?.(x, y);
  const range = position ? null : doc.caretRangeFromPoint?.(x, y);
  const node = /** @type {Text | undefined} */ (position?.offsetNode || range?.startContainer);
  const offset = /** @type {number} */ (position?.offset ?? range?.startOffset);
  if (node?.nodeType !== 3 || !node.parentElement?.closest(
      '.reader-pdf-text[data-text-generation] .reader-pdf-text-run[data-region-id]')) return null;
  return { node, offset: codePointBoundary(node, offset) };
}

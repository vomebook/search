// PDF.js already emits word spaces. Adding a space after every item breaks
// Chinese words and words split across fonts. Keep the source's explicit spaces.
export function pdfTextContent(items) {
  return items.filter((item) => typeof item.str === "string")
    .map((item) => item.str + (item.hasEOL ? "\n" : "")).join("");
}

// Embedded OCR often spaces individual Han characters, including vertical text.
// Keep punctuation and Latin word boundaries, and map hits back to source offsets.
export function pdfSearchText(raw) {
  const removed = /(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu;
  const offsets = [], chunks = [];
  let start = 0;
  for (const match of raw.matchAll(removed)) {
    chunks.push(raw.slice(start, match.index));
    for (let i = start; i < match.index; i++) offsets.push(i);
    start = match.index + match[0].length;
  }
  chunks.push(raw.slice(start));
  for (let i = start; i < raw.length; i++) offsets.push(i);
  return { text: chunks.join(""), offsets };
}

function textRun(layer, text) {
  const run = layer.ownerDocument.createElement("span");
  run.className = "reader-pdf-text-run";
  run.textContent = text;
  return run;
}

const measurements = new WeakMap();
function normalizeBox(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
function measureRunScale(context, text, family, targetWidth) {
  context.font = `100px ${family}`;
  const measured = context.measureText(text).width / 100;
  return measured > 0 && targetWidth > 0 ? targetWidth / measured : 1;
}
function positionedRun(layer, text, x, y, height, width, family, angle = 0, vertical = false) {
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
    // Upright vertical layout advances one em for spaces as well as Han glyphs.
    const measured = Array.from(text).length;
    if (width > 0 && measured) run.style.transform = `scaleY(${width / (height * measured)})`;
  } else {
    const scaleX = measureRunScale(context, text, family, width / height);
    run.style.setProperty("--reader-pdf-run-scale-x", String(scaleX));
    run.style.transform = "scaleX(var(--reader-pdf-run-scale-x))";
  }
  box.appendChild(run);
  return box;
}

export function populatePdfTextLayer(layer, items, viewport, styles = {}) {
  const fragment = layer.ownerDocument.createDocumentFragment();
  const w = Math.max(1, viewport.width), h = Math.max(1, viewport.height);
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    if (item.str) {
      const t = item.transform, v = viewport.transform;
      const point = t && viewport.convertToViewportPoint?.(t[4], t[5]);
      if (point && t.every(Number.isFinite)) {
        const style = styles[item.fontName] || {};
        const family = style.fontFamily || "sans-serif";
        const vertical = style.vertical || item.dir === "ttb";
        const scale = viewport.scale || 1;
        const height = Math.hypot(t[2], t[3]) * scale || 12;
        const angle = v ? Math.atan2(v[1] * t[0] + v[3] * t[1], v[0] * t[0] + v[2] * t[1]) : 0;
        const ascent = height * (Number.isFinite(style.ascent) ? style.ascent : 0.8);
        const x = vertical ? point[0] - height / 2 : point[0] + ascent * Math.sin(angle);
        const y = vertical ? point[1] : point[1] - ascent * Math.cos(angle);
        fragment.appendChild(positionedRun(layer, item.str, x / w, y / h, height / w,
          (vertical ? item.height : item.width) * scale / w, family, angle, vertical));
      } else {
        // Text without coordinates remains accessible, but never forms a visible
        // second text panel beneath the page image.
        fragment.appendChild(textRun(layer, item.str));
      }
    }
    if (item.hasEOL) fragment.appendChild(layer.ownerDocument.createTextNode("\n"));
  }
  layer.replaceChildren(fragment);
}

export function populateOcrTextLayer(layer, blocks) {
  const fragment = layer.ownerDocument.createDocumentFragment();
  const ratio = layer.parentElement.getBoundingClientRect();
  for (const block of blocks || []) {
    const text = String(block?.t || ""), b = block?.b;
    if (!text || !Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) continue;
    const [x1, y1, x2, y2] = b.map(normalizeBox);
    const width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
    if (!width || !height) continue;
    fragment.appendChild(positionedRun(layer, text, Math.min(x1, x2), Math.min(y1, y2),
      height * ratio.height / Math.max(1, ratio.width), width, "sans-serif"));
    fragment.appendChild(layer.ownerDocument.createTextNode("\n"));
  }
  layer.replaceChildren(fragment);
}

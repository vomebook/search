const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pdf = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../static/reader/pdf/reader-pdf-text.js'), 'utf8')
  .replace(/^export /gm, ''), pdf);

function makeLayer(context) {
  const doc = {
    createElement(tag) {
      if (tag === 'canvas') return { getContext: () => context };
      return element();
    },
    createDocumentFragment: () => element(),
    createTextNode: text => ({ textContent: text })
  };
  function element() {
    return {
      ownerDocument: doc, children: [], style: { setProperty(key, value) { this[key] = value; } },
      appendChild(node) { this.children.push(node); },
      replaceChildren(fragment) { this.children = fragment.children; },
      querySelectorAll() { return []; }
    };
  }
  const layer = element();
  layer.parentElement = { getBoundingClientRect: () => ({ width: 100, height: 100 }) };
  return layer;
}

const viewport = { width: 100, height: 100, scale: 1, convertToViewportPoint: (x, y) => [x, y] };
const item = { str: 'test', fontName: 'f', transform: [10, 0, 0, 10, 20, 40], width: 30, height: 10 };
for (const [context, expected] of [
  [null, 1],
  [{ measureText: () => ({ width: 200 }) }, 1.5],
  [{ measureText: () => ({ width: 0 }) }, 1]
]) {
  const layer = makeLayer(context);
  pdf.populatePdfTextLayer(layer, [item], viewport, { f: { fontFamily: 'serif' } });
  const run = layer.children[0].children[0];
  assert.strictEqual(run.textContent, 'test');
  assert.ok(Math.abs(Number(run.style['--reader-pdf-run-scale-x']) - expected) < 1e-12);
  assert.strictEqual(run.style.transform, 'scaleX(var(--reader-pdf-run-scale-x))');
  if (context) assert.strictEqual(context.font, '100px serif');
}

const ocr = makeLayer(null);
pdf.populateOcrTextLayer(ocr, [{ t: 'OCR', b: [0, 0, 0.3, 0.1] }]);
assert.strictEqual(ocr.children[0].children[0].style['--reader-pdf-run-scale-x'], '1');

for (const [textItem, view] of [
  [{ ...item, transform: [10, 0, 0, 10], hasEOL: true }, viewport],
  [{ ...item, hasEOL: true }, { ...viewport, convertToViewportPoint: () => [20] }]
]) {
  const layer = makeLayer(null);
  pdf.populatePdfTextLayer(layer, [textItem], view);
  assert.deepEqual(layer.children.map(child => child.textContent), ['test', '\n']);
  assert.strictEqual(layer.children[0].className, 'reader-pdf-text-run');
}

// Repeated short runs can share a font measurement, never their positions or
// target widths. Font switches and later layer construction measure afresh.
{
  let count = 0;
  const context = { measureText() { count++; return { width: this.font.includes('mono') ? 100 : 200 }; } };
  const layer = makeLayer(context), styles = { f: { fontFamily: 'serif' }, g: { fontFamily: 'monospace' } };
  const rows = Array.from({ length: 40 }, (_, i) => ({ ...item, fontName: i < 20 ? 'f' : 'g', width: i % 2 ? 40 : 30 }));
  pdf.populatePdfTextLayer(layer, rows, viewport, styles);
  assert.strictEqual(count, 2);
  assert.deepStrictEqual(layer.children.map(box => Number(Number(box.children[0].style['--reader-pdf-run-scale-x']).toFixed(12))),
    rows.map(row => row.width / (row.fontName === 'f' ? 20 : 10)));
  pdf.populatePdfTextLayer(layer, rows, viewport, styles);
  assert.strictEqual(count, 4);
}

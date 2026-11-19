import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReaderPdfPageWindow } from '../../../static/reader/pdf/reader-pdf-page-window.mjs';

test('outline traversal preserves order, depth and navigation', async () => {
  const calls = [];
  const reader = {
    awaitReader: promise => promise,
    assertReaderActive() {},
    goToPage: (page, generation) => { calls.push([page, generation]); return true; },
    readerAbortController: new AbortController()
  };
  const window = createReaderPdfPageWindow(reader);
  const entries = await window.loadPdfOutline({
    numPages: 8,
    getOutline: async () => [{ title: '章节 ☑', dest: 'chapter', items: [{ title: '', dest: null }] }],
    getDestination: async () => [{ id: 1 }],
    getPageIndex: async () => 2
  });
  assert.deepEqual(entries.map(({ label, depth, page }) => [label, depth, page]),
    [['章节 · 第 3 页', 0, 3], ['未命名章节', 1, null]]);
  assert.equal(entries[0].activate(7), true);
  assert.equal(entries[1].activate(7), false);
  assert.deepEqual(calls, [[3, 7]]);
});

test('small page counts do not create a virtual window', () => {
  const window = createReaderPdfPageWindow({});
  assert.equal(window.createPdfShellWindow(256, {}, () => ({}), () => {}, 1.414), null);
});


test('DjVu numeric outline destinations are forwarded unchanged', async () => {
  const seen = [];
  const reader = {awaitReader: p => p, assertReaderActive() {}, goToPage: () => true,
    readerAbortController: new AbortController()};
  const entries = await createReaderPdfPageWindow(reader).loadPdfOutline({
    numPages: 3,
    getOutline: async () => [{title: 'DjVu', dest: [3], items: []}],
    getPageIndex: async ref => { seen.push(ref); return ref - 1; }
  }, true);
  assert.deepEqual(seen, [3]);
  assert.equal(entries[0].page, 3);
  assert.equal(entries[0].label, 'DjVu · 第 3 页');
});

test('virtual ensure preserves valid, out-of-range and disposed behavior', () => {
  const original = {document: globalThis.document, getComputedStyle: globalThis.getComputedStyle,
    ResizeObserver: globalThis.ResizeObserver};
  class Element {
    constructor() { this.children = []; this.style = {}; this.dataset = {}; this.isConnected = false; }
    appendChild(child) {
      if (child.fragment) { for (const node of [...child.children]) this.appendChild(node); child.children = []; }
      else { this.children.push(child); child.isConnected = true; }
      return child;
    }
    setAttribute() {} removeAttribute() {} contains() { return false; }
    replaceChildren() { this.children = []; }
    querySelector(selector) { const page = selector.match(/data-page="(\d+)"/)?.[1];
      return this.children.find(child => child.dataset.page === page) || null; }
    getBoundingClientRect() { return {top: 0, width: 100, height: 140}; }
  }
  globalThis.document = {createElement: () => new Element(),
    createDocumentFragment: () => Object.assign(new Element(), {fragment: true}), activeElement: null};
  globalThis.getComputedStyle = () => ({paddingLeft: '0', paddingRight: '0'});
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    const content = new Element(); content.clientWidth = 100;
    const reader = {content, viewport: {scrollTop: 0, clientHeight: 100}, documentState: {zoom: 1},
      pageAtMarker: () => null, isPdfPageVisible: () => false, pdfSelectionIntersects: () => false,
      pdfManifestShells: [], trackReaderResource: () => () => {}};
    const shell = page => { const node = new Element(); node.dataset.page = String(page); return node; };
    const window = createReaderPdfPageWindow(reader).createPdfShellWindow(257, shell(1), shell, () => {}, 1.4);
    assert.equal(window.ensure(1).dataset.page, '1');
    assert.equal(window.ensure(257).dataset.page, '257');
    assert.equal(window.ensure(258), null); // Inside the last allocated chunk.
    assert.throws(() => window.ensure(0), TypeError);
    assert.throws(() => window.ensure(289), TypeError); // No chunk at this index.
    window.dispose();
    assert.throws(() => window.ensure(1), TypeError);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

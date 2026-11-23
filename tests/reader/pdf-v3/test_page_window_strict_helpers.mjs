import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReaderPdfPageWindow } from '../../../static/reader/pdf/reader-pdf-page-window.mjs';
import { createReaderProgress } from '../../../static/reader/ui/reader-progress.mjs';

test('image page entries use the manifest bounds', () => {
  const reader = {pdfPageManifest: null};
  const {pdfPageEntry} = createReaderPdfPageWindow(reader);
  assert.equal(pdfPageEntry(1), null);
  reader.pdfPageManifest = {pageCount: 3};
  assert.equal(pdfPageEntry(0), null);
  assert.deepEqual(pdfPageEntry(1), {page: 1});
  assert.deepEqual(pdfPageEntry(3), {page: 3});
  assert.equal(pdfPageEntry(4), null);
});

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

test('PDF outline bounds concurrent requests and keeps preorder despite out-of-order completion', async () => {
  const started = [], pending = new Map();
  const reader = {awaitReader: p => p, assertReaderActive() {}, readerAbortController: new AbortController()};
  const outline = Array.from({length: 9}, (_, i) => ({title: `Entry ${i}`, dest: `entry-${i}`}));
  outline[0].items = [outline[1], outline[2]];
  const loading = createReaderPdfPageWindow(reader).loadPdfOutline({
    numPages: 9,
    getOutline: async () => [outline[0], ...outline.slice(3)],
    getDestination: name => {
      const index = Number(name.slice(6));
      started.push(index);
      const latch = Promise.withResolvers();
      pending.set(index, latch);
      return latch.promise;
    },
    getPageIndex: async ref => ref.num
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const release = (i, ref) => { pending.get(i).resolve([ref]); pending.delete(i); };
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  pending.get(3).reject(Error('Broken destination')); pending.delete(3);
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  release(4, {num:4});
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  release(5, 8); release(2, -1); release(1, 1);
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  release(8, 0); release(7, 9); release(6, 3); release(0, 0);
  const entries = await loading;
  assert.deepEqual(entries.map(({label}) => label.split(' · ')[0]), outline.map(item => item.title));
  assert.deepEqual(entries.map(({depth, page}) => [depth, page]),
    [[0,1], [1,2], [1,null], [0,null], [0,5], [0,9], [0,4], [0,null], [0,1]]);
});

test('disposing a PDF outline prevents queued lookups and discards late destinations', async () => {
  const controller = new AbortController(), reads = [], refReads = [];
  const blocked = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  controller.signal.addEventListener('abort', () => stopped.resolve(), {once: true});
  const reader = {
    readerAbortController: controller,
    awaitReader: result => Promise.race([result, stopped.promise.then(() => controller.signal.throwIfAborted())]),
    assertReaderActive: () => controller.signal.throwIfAborted()
  };
  const loading = createReaderPdfPageWindow(reader).loadPdfOutline({
    numPages: 8,
    getOutline: async () => Array.from({length: 8}, (_, i) => ({title: `${i}`, dest: `${i}`})),
    getDestination: name => { reads.push(name); return blocked.promise; },
    getPageIndex: async ref => { refReads.push(ref); return 0; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, ['0', '1', '2', '3']);
  controller.abort();
  assert.equal(await loading, undefined);
  blocked.resolve([{num: 6}]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, ['0', '1', '2', '3']);
  assert.deepEqual(refReads, []);
});

test('small page counts do not create a virtual window', () => {
  const window = createReaderPdfPageWindow({});
  assert.equal(window.createPdfShellWindow(256, {}, () => ({}), () => {}, 1.414), null);
});


test('DjVu numeric destinations are forwarded unchanged and missing destinations are skipped by chapter controls', async () => {
  const seen = [];
  const reader = {awaitReader: p => p, assertReaderActive() {}, goToPage: () => true,
    readerAbortController: new AbortController(), capability: {mode: 'pdf'}};
  const entries = await createReaderPdfPageWindow(reader).loadPdfOutline({
    numPages: 3,
    getOutline: async () => [{title: 'Cover', dest: [1]}, {title: 'No destination', dest: null,
      items: [{title: 'DjVu', dest: [3]}]}],
    getPageIndex: async ref => { seen.push(ref); return ref - 1; }
  }, true);
  assert.deepEqual(seen, [1, 3]);
  assert.deepEqual(entries.map(({page}) => page), [1, null, 3]);
  assert.equal(entries[2].label, 'DjVu · 第 3 页');
  reader.navigationState = {tocEntries: entries, currentChapterIndex: 0};
  const {adjacentTocIndex} = createReaderProgress(reader);
  assert.equal(adjacentTocIndex(1), 2);
  reader.navigationState.currentChapterIndex = 2;
  assert.equal(adjacentTocIndex(-1), 0);
});

test('virtual ensure preserves valid, out-of-range and disposed behavior', () => {
  const original = {document: globalThis.document, getComputedStyle: globalThis.getComputedStyle,
    ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame};
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
  const frames = new Map(); let frameId = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const tick = () => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback());
  };
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

    const open = page => {
      content.replaceChildren();
      const first = content.appendChild(shell(page)), created = [];
      const window = createReaderPdfPageWindow(reader).createPdfShellWindow(340, first, page => {
        created.push(page); return shell(page);
      }, () => {}, 1.4, null, page);
      assert.equal(created.length, 31);
      assert.ok(created.every(value => value >= 193 && value <= 224));
      assert.ok(content.children.some(chunk => chunk.children.includes(first)));
      return {window, created};
    };
    const picked = open(210);
    picked.window.resize(); picked.window.schedule();
    assert.equal(frames.size, 0, 'opening resize and programmatic scroll do not expand early');
    picked.window.finishOpening();
    assert.equal(picked.window.ensure(210).dataset.page, '210');
    assert.ok(picked.window.opening);
    assert.equal(picked.created.length, 31, 'reapplying the saved page does not expand');
    tick();
    assert.equal(picked.created.length, 31, 'one frame for the opening paint');
    tick();
    assert.ok(picked.created.length > 31, 'ordinary viewport window is restored');
    picked.window.dispose();

    const manual = open(210); manual.window.finishOpening();
    assert.equal(manual.window.ensure(340).dataset.page, '340');
    assert.equal(frames.size, 0, 'a later jump supersedes the queued expansion');
    manual.window.dispose();

    const scroll = open(210);
    reader.pdfUserHasScrolled = true; scroll.window.schedule();
    assert.equal(frames.size, 1);
    tick(); assert.ok(scroll.created.length > 31);
    scroll.window.dispose(); reader.pdfUserHasScrolled = false;

    const closed = open(210); closed.window.finishOpening(); tick();
    closed.window.dispose();
    assert.equal(frames.size, 0, 'disposal removes the second frame');
    assert.equal(closed.created.length, 31);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

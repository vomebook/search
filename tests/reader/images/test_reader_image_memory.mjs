import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const load = name => import(pathToFileURL(path.join(root, 'static/reader', name)).href);
const {createReaderLifecycle} = await load('core/reader-lifecycle.mjs');
const {createReaderPdfScheduler} = await load('pdf/reader-pdf-scheduler.mjs');
const {createReaderPdfRenderer, pdfOutputScale} = await load('pdf/reader-pdf-renderer.mjs');

globalThis.window = {devicePixelRatio: 1};
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {connection: {saveData: true}}});
globalThis.matchMedia = () => ({matches: false});

// Batch trims preserve oldest-inactive eviction and do not rescan mounted
// canvases for each detached image. An active-only pool cannot be trimmed.
{
  let scans = 0;
  const removed = [];
  const reader = {
    content: {querySelectorAll() { scans++; return [{tagName:'CANVAS', width:20, height:10}]; }},
    PDF_MANIFEST_PREFETCH_LIMIT: 5,
    pdfManifestPrefetches: new Map(), pdfManifestPrefetchActive: new Set(),
    pdfPixelBudget: () => 450
  };
  Object.assign(reader, createReaderPdfScheduler(reader));
  reader.pdfPixelBudget = () => 450;
  const add = (url, width, active = false) => {
    const image = {tagName:'IMG', naturalWidth:width, naturalHeight:1, onload() {}, onerror() {},
      removeAttribute(name) {
        assert.equal(name,'src');assert.equal(this.onload,null);assert.equal(this.onerror,null);
        assert.equal(reader.pdfManifestPrefetches.has(url),false);
        removed.push(url);
      }};
    const record = {url,image};
    reader.pdfManifestPrefetches.set(url,record);
    if (active) reader.pdfManifestPrefetchActive.add(record);
  };
  reader.trimPdfManifestPrefetches();
  assert.equal(scans,0,'empty prefetch pool needs no DOM accounting');
  add('active',240,true);
  add('count',1);
  add('zero',0);
  add('first',35);
  add('second',60);
  add('reusable',10);
  reader.trimPdfManifestPrefetches();
  assert.deepEqual(removed,['count','zero','first','second']);
  assert.deepEqual([...reader.pdfManifestPrefetches.keys()],['active','reusable']);
  assert.equal(scans,1);
  assert.equal(reader.pdfRetainedPixels(),450);
  reader.pdfPixelBudget = () => 100;
  reader.trimPdfManifestPrefetches();
  assert.equal(removed.at(-1),'reusable');
  assert.deepEqual([...reader.pdfManifestPrefetches.keys()],['active']);
  scans = 0;
  reader.trimPdfManifestPrefetches();
  assert.equal(scans,0,'active images must not be evicted even above budget');
}

// An anonymous preview holder cannot be inspected or preempted as a page shell.
{
  const abort = new AbortController();
  let cancelled = 0;
  const low = {_renderCancel() { cancelled++; }};
  const demanded = {};
  const reader = {readerAbortController: abort, normalizePdfPriority: Number,
    readerAbortError: () => new DOMException('closed', 'AbortError'),
    isPdfPageVisible: () => false,
    pdfSelectionIntersects: shell => { assert.ok(shell); return false; },
    pdfPagePriority: shell => shell ? 1 : 0};
  const scheduler = createReaderPdfScheduler(reader);
  await scheduler.acquirePdfPreviewSlot(0, null);
  await scheduler.acquirePdfPreviewSlot(0, low);
  const pending = scheduler.acquirePdfPreviewSlot(2, demanded);
  assert.equal(cancelled, 1);
  abort.abort();
  await assert.rejects(pending, {name: 'AbortError'});
}

// The sharper high-density mobile canvas is bounded, while low-memory,
// desktop, and already-large pages retain the previous baseline.
{
  globalThis.matchMedia = () => ({matches: true});
  window.devicePixelRatio = 3;
  assert.equal(pdfOutputScale({width: 370, height: 520}), 3);
  const limited = pdfOutputScale({width: 1000, height: 800});
  assert.ok(limited > 2 && limited < 3);
  assert.ok(Math.ceil(1000 * limited) * Math.ceil(800 * limited) <= 6_000_000);
  assert.equal(pdfOutputScale({width: 1600, height: 1200}), 2);
  assert.equal(pdfOutputScale({width: Infinity, height: 100}), 2);
  navigator.deviceMemory = 2;
  assert.equal(pdfOutputScale({width: 370, height: 520}), 2);
  delete navigator.deviceMemory;
  globalThis.matchMedia = () => ({matches: false});
  assert.equal(pdfOutputScale({width: 370, height: 520}), 2);
  window.devicePixelRatio = 1;
}

// Preempt a draw only after it has allocated pixels. The underlying engine
// may acknowledge cancellation after the Reader has already reused the canvas.
{
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const makeShell = (page, top) => ({dataset: {page: String(page)}, clientWidth: 100, style: {}, isConnected: true,
    getBoundingClientRect: () => ({top, bottom: top + 120}),
    prepend(canvas) {this.canvas = canvas;},
    querySelector(selector) {
      if (selector === 'canvas' || (selector.includes('canvas.ready') && this.canvas?.classList.contains('ready')))
        return this.canvas ?? null;
      return null;
    }});
  const shown = makeShell(1, 0), speculative = makeShell(2, 900), destination = makeShell(3, 120);
  const shells = [shown, speculative, destination], draws = new Map();
  let pageRead = null;
  const reader = {
    capability: {mode: 'pdf'}, documentState: {page: 1}, PDF_PREFETCH_MARGIN: 2400,
    readerAbortController: new AbortController(), readerResources: new Set(),
    readerRuntime: {state: {lifecycle: {}}, currentGeneration: () => 1, isCurrent: () => true},
    pdfActiveRenders: 0, pdfRenderWaiters: [], pdfManifestPrefetches: new Map(), pdfScrollDirection: 1,
    viewport: {getBoundingClientRect: () => ({top: 0, bottom: 800})},
    content: {querySelectorAll(selector) {
      if (selector === '.reader-page') return shells;
      if (selector.includes('[data-render-state')) return shells.filter(shell => shell.dataset.renderState === 'rendered');
      return shells.flatMap(shell => shell.canvas ? [shell.canvas] : []);
    }},
    pageAtMarker: () => shown, pdfSelectionIntersects: () => false, domSearch: {pruneMarks() {}},
    measurePdf: promise => promise, renderPdfText: async () => {},
    pdfDocument: {async getPage(page) {
      if (pageRead) await pageRead.promise;
      return {
        getViewport: ({scale}) => ({width: 100 * scale, height: 120 * scale}),
        render({canvasContext: {canvas}}) {
          const done = Promise.withResolvers();
          const draw = {promise: done.promise, cancelled: false, cancel() {this.cancelled = true;},
            finish() {assert.equal(this.cancelled, false); canvas.frame = this; done.resolve();},
            acknowledgeCancel() {assert.equal(this.cancelled, true); done.reject(reader.readerAbortError());}};
          draws.set(page, draw);
          return draw;
        }
      };
    }}
  };
  Object.assign(reader, createReaderLifecycle(reader), createReaderPdfScheduler(reader), createReaderPdfRenderer(reader));
  globalThis.matchMedia = () => ({matches: true}); // one canvas draw slot
  globalThis.document = {createElement(tag) {
    assert.equal(tag, 'canvas');
    const classes = new Set();
    let width = 300, height = 150;
    return {tagName: 'CANVAS', style: {}, setAttribute() {}, getContext() {return {canvas: this};},
      classList: {add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value)},
      get width() {return width;}, set width(value) {width = value; this.frame = null;},
      get height() {return height;}, set height(value) {height = value; this.frame = null;}};
  }};
  try {
    const first = reader.renderPdfInBackground(shown, false, 3);
    await tick(); draws.get(1).finish(); await first;
    const frame = shown.canvas.frame;
    // A cancelled forced redraw waiting for getPage never owns the displayed frame.
    pageRead = Promise.withResolvers();
    const waiting = reader.renderPdfShell(shown, true, 3);
    await tick(); shown._renderCancel();
    await assert.rejects(waiting, {name: 'AbortError'});
    pageRead.resolve(); pageRead = null;
    assert.equal(shown.querySelector('canvas.ready')?.frame, frame, 'cancellation before allocation preserves the displayed frame');

    const pending = reader.renderPdfInBackground(speculative, false, 1);
    await tick();
    const cancelled = draws.get(2), canvas = speculative.canvas;
    assert.equal(reader.pdfSurfacePixels(canvas), 12000, 'held draw has allocated a valid canvas');
    const demand = reader.renderPdfInBackground(destination, false, 3);
    await assert.rejects(pending, {name: 'AbortError'});
    assert.equal(cancelled.cancelled, true);
    assert.equal(speculative.dataset.renderState, 'idle');
    assert.deepEqual([canvas.width, canvas.height], [0, 0], 'preempted owner must release both backing dimensions');
    await tick(); draws.get(3).finish(); await demand;
    assert.equal(destination.querySelector('canvas.ready')?.frame, draws.get(3));
    assert.equal(reader.pdfRetainedPixels(), 24000, 'only the two completed frames retain pixels');

    const replacement = reader.renderPdfInBackground(speculative, false, 3);
    await tick();
    const current = draws.get(2);
    assert.notEqual(current, cancelled);
    assert.equal(speculative.canvas, canvas);
    cancelled.acknowledgeCancel(); await tick();
    assert.equal(reader.pdfSurfacePixels(canvas), 12000, 'late cancellation must not resize the replacement draw');
    current.finish(); await replacement;
    assert.equal(speculative.querySelector('canvas.ready')?.frame, current);
    assert.equal(shown.querySelector('canvas.ready')?.frame, frame);
    assert.equal(reader.pdfActiveRenders, 0);
    assert.equal(reader.readerResources.size, 0);
  } finally {
    reader.stopReaderWork();
    globalThis.matchMedia = () => ({matches: false});
    delete globalThis.document;
  }
}

function fixture() {
  let visible = false, loads = 0, released = 0, epoch = 0, readyLookups = 0, markerReads = 0;
  const classes = new Set(['ready']);
  const image = {tagName: 'IMG', naturalWidth: 3295, naturalHeight: 2539,
    classList: {add: value => classes.add(value), contains: value => classes.has(value)},
    removeAttribute() {}, remove() {shell.image = null;}, decode: async () => {}};
  const textLayer = {replaceChildren: () => epoch++};
  const shell = {dataset: {page: '54', renderState: 'rendered', textReady: '1'},
    style: {}, isConnected: true, image,
    querySelector(selector) {
      if (selector.endsWith('.ready')) readyLookups++;
      if (selector === '.reader-pdf-text') return textLayer;
      if (selector === '.reader-page-state') return null;
      if (selector.includes('img')) return shell.image;
      return null;
    }, appendChild(value) {shell.image = value;}};
  const marker = {dataset: {page: '55'}};
  const abort = new AbortController();
  const reader = {readerAbortController: abort, documentState: {page: 55, zoom: 1},
    pdfScrollDirection: 1, capability: {mode: 'image-pages'},
    pdfManifestPrefetches: new Map(), pdfManifestPrefetchActive: new Set(),
    content: {
      querySelector: () => null,
      querySelectorAll(selector) {
        if (selector.includes('[data-render-state="rendered"]')) return shell.dataset.renderState === 'rendered' ? [shell] : [];
        if (selector.includes('canvas') || selector.includes('img')) return shell.image ? [shell.image] : [];
        return [shell];
      }},
    pageAtMarker: () => {markerReads++; return marker;}, isPdfPageVisible: () => visible, pdfSelectionIntersects: () => false,
    domSearch: {pruneMarks() {}},
    pdfPageManifest: {codec: 'png', pageUrl: () => 'https://fixture.test/page.png'},
    pdfPageEntry: page => ({page}), pdfPagePriority: () => visible ? 2 : 1,
    normalizePdfPriority: value => Number(value), assertReaderActive: () => abort.signal.throwIfAborted(),
    readerAbortError: () => new DOMException('closed', 'AbortError'), measurePdf: value => value,
    awaitReader: value => value, takePdfManifestPrefetch: () => image,
    imageLoader: {load: async () => loads++},
    acquirePdfPreviewSlot: async () => {}, releasePdfPreviewSlot: () => released++,
    viewport: {scrollTop: 0, getBoundingClientRect: () => ({top: 0, bottom: 800})},
    schedulePdfManifestPrefetch() {}, queuePdfManifestPrefetch() {},
    trimPdfManifestImages() {}, scheduleMarkerSync() {}};
  Object.assign(reader, createReaderPdfScheduler(reader), createReaderPdfRenderer(reader));
  // Simulate a budget occupied by visible images. The evictable neighbor is
  // larger than the remaining budget, so keeping it would exceed the cap.
  reader.pdfPixelBudget = () => 1;
  reader.trimPdfManifestPrefetches = () => {};
  reader.isPdfPageVisible = () => visible;
  reader.acquirePdfPreviewSlot = async () => {};
  reader.releasePdfPreviewSlot = () => released++;
  reader.takePdfManifestPrefetch = () => image;
  reader.trimPdfManifestImages = () => {};
  return {reader, shell, marker, classes,
    visible: value => {visible = value;},
    stats: () => ({loads, released, epoch, readyLookups, markerReads})};
}

{
  const value = fixture();
  value.reader.pdfPixelBudget = () => 20_000_000;
  value.reader.trimPdfSurfaces(null);
  assert.equal(value.stats().markerReads, 0, 'within budget needs no eviction priority');
  assert.equal(value.stats().readyLookups, 2, 'inspect each ready surface once');
  assert.notEqual(value.shell.image, null);
  value.reader.pdfPixelBudget = () => 1;
  value.reader.trimPdfSurfaces(null);
  assert.equal(value.stats().readyLookups, 4, 'the eviction reuses the inspected surfaces');
  assert.equal(value.stats().markerReads, 1);
  assert.equal(value.shell.image, null);
}

{
  const value = fixture();
  value.shell.dataset.nativeTextFallback = '1';
  value.reader.trimPdfSurfaces(null);
  assert.equal(value.shell.image, null);
  assert.equal(value.shell.dataset.renderState, 'idle');
  assert.equal(value.shell.dataset.textReady, '0');
  assert.equal(value.shell.dataset.nativeTextFallback, undefined);
  for (let i = 0; i < 100; i++) {
    await value.reader.renderPdfImageShell(value.shell, false, 1);
    value.reader.trimPdfSurfaces(null);
  }
  assert.equal(value.stats().loads, 0, 'a budget-evicted neighbor must not redownload on every render/marker completion');
  assert.equal(value.stats().released, 0, 'suppressed speculation must not occupy a preview slot');
  value.visible(true);
  await value.reader.renderPdfImageShell(value.shell, false, 2);
  assert.equal(value.stats().loads, 1, 'becoming visible always bypasses speculative suppression');
  assert.equal(value.stats().released, 1);
  assert.equal(value.shell.dataset.renderState, 'rendered');
}
for (const change of ['page', 'zoom', 'direction', 'budget', 'viewport', 'explicit-demand', 'force']) {
  const value = fixture();
  value.reader.trimPdfSurfaces(null);
  let force = false, priority = 1;
  if (change === 'page') {value.marker.dataset.page = '56';value.reader.documentState.page = 56;}
  if (change === 'zoom') value.reader.documentState.zoom = 1.1;
  if (change === 'direction') value.reader.pdfScrollDirection = -1;
  if (change === 'budget') value.reader.pdfPixelBudget = () => 20_000_000;
  if (change === 'viewport') value.reader.viewport.clientWidth = 800;
  if (change === 'explicit-demand') priority = 3;
  if (change === 'force') force = true;
  await value.reader.renderPdfImageShell(value.shell, force, priority);
  assert.equal(value.stats().loads, 1, change + ' permits a new page load after memory eviction');
  assert.equal(value.stats().released, 1);
}
{
  const value = fixture();
  value.reader.pdfSelectionIntersects = () => true;
  value.reader.trimPdfSurfaces(null);
  assert.notEqual(value.shell.image, null, 'selected offscreen text/images remain protected');
  assert.equal(value.shell.dataset.textReady, '1');
}
{
  const value = fixture();value.visible(true);
  value.reader.trimPdfSurfaces(null);
  assert.notEqual(value.shell.image, null, 'visible surfaces may exceed a soft pixel cap and are never dropped');
}
console.log('PDF draw cancellation and image memory eviction preserve live surfaces and demand', root);

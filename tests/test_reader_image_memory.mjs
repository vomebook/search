import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const load = name => import(pathToFileURL(path.join(root, 'static/reader', name)).href);
const {createReaderPdfScheduler} = await load('pdf/reader-pdf-scheduler.mjs');
const {createReaderPdfRenderer} = await load('pdf/reader-pdf-renderer.mjs');

globalThis.window = {devicePixelRatio: 1};
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {connection: {saveData: true}}});
globalThis.matchMedia = () => ({matches: false});

function fixture() {
  let visible = false, loads = 0, released = 0, epoch = 0;
  const classes = new Set(['ready']);
  const image = {tagName: 'IMG', naturalWidth: 3295, naturalHeight: 2539,
    classList: {add: value => classes.add(value), contains: value => classes.has(value)},
    removeAttribute() {}, remove() {shell.image = null;}, decode: async () => {}};
  const textLayer = {replaceChildren: () => epoch++};
  const shell = {dataset: {page: '54', renderState: 'rendered', textReady: '1'},
    style: {}, isConnected: true, image,
    querySelector(selector) {
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
    pageAtMarker: () => marker, isPdfPageVisible: () => visible, pdfSelectionIntersects: () => false,
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
    stats: () => ({loads, released, epoch})};
}

{
  const value = fixture();
  value.reader.trimPdfSurfaces(null);
  assert.equal(value.shell.image, null);
  assert.equal(value.shell.dataset.renderState, 'idle');
  assert.equal(value.shell.dataset.textReady, '0');
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
console.log('Image memory eviction suppresses static refetch loops, preserves selection/visible demand, and reopens on changed page/zoom/direction', root);

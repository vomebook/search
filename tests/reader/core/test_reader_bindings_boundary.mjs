import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindReaderScrollIntent, createReaderBindings } from '../../../static/reader/core/reader-bindings.mjs';
import { createReaderProgress } from '../../../static/reader/ui/reader-progress.mjs';
import { createReaderBookmarks } from '../../../static/reader/ui/reader-bookmarks.mjs';

function storage(values = {}) {
  const data = new Map(Object.entries(values));
  return { getItem: key => data.get(key) ?? null, removeItem: key => data.delete(key), data };
}

test('session JSON accepts records only, keeps metadata fields, and ignores malformed JSON', () => {
  for (const value of ['null', '7', '"text"', '[]', '{broken']) {
    globalThis.sessionStorage = storage({ 'reader-source:id': value, 'reader-resolve:id': value });
    const context = { readerId: 'id', localReaderData: null, cachedReaderData: null, resolvedReaderData: null, params: new URLSearchParams() };
    const bindings = createReaderBindings(context);
    bindings.readSelectedSourceSession();
    bindings.applySourceSessionAndCachedMetadata();
    assert.equal(context.localReaderData, null);
    assert.equal(context.cachedReaderData, null);
    assert.equal(context.resolvedReaderData, null);
  }
  globalThis.sessionStorage = storage({ 'reader-source:id': JSON.stringify({ title: 'Book', repo: 'r', folder: ['a', 'b'] }), 'reader-resolve:id': JSON.stringify({ url: 'https://example.test', extra: 3 }) });
  const context = { readerId: 'id', localReaderData: null, cachedReaderData: null, resolvedReaderData: null, params: new URLSearchParams() };
  const bindings = createReaderBindings(context);
  bindings.readSelectedSourceSession(); bindings.applySourceSessionAndCachedMetadata();
  assert.equal(context.params.get('path'), 'r/a/b');
  assert.equal(context.params.get('title'), 'Book');
  assert.deepEqual(context.resolvedReaderData, { url: 'https://example.test', extra: 3 });
  assert.equal(sessionStorage.data.size, 0);
});

test('phase events ignore unknown payloads and accept string phases', () => {
  let phase;
  globalThis.window = {};
  globalThis.document = { documentElement: { dataset: {} } };
  globalThis.VoiceOfMLReaderStore = {};
  const context = { readerRuntime: { update() {}, track() {}, events: { on(_type, callback) { phase = callback; } } }, setReaderPhase() {} };
  createReaderBindings(context).publishSourceAndSubscribeToStore();
  for (const value of [null, 2, 'ready', {}, { phase: null }]) phase(value);
  assert.equal(globalThis.document.documentElement.dataset.readerPhase, undefined);
  phase({ phase: 'ready' });
  assert.equal(globalThis.document.documentElement.dataset.readerPhase, 'ready');
});

test('startup failures use a safe code when classification is not a string', async () => {
  const failures = [];
  const original = console.error;
  console.error = () => {};
  try {
    for (const code of ['READER_NETWORK', 42]) {
      const context = { trackReaderResource() {}, registerReaderFormatAdapters() {}, syncCapabilityControls() {}, updateProgressTools() {},
        start: () => Promise.reject(new Error('failed')), readerAbortController: new AbortController(),
        classifyReaderError: () => code, fail: (_message, value) => failures.push(value) };
      createReaderBindings(context).ownPdfSearchStorageAndStart();
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { console.error = original; }
  assert.deepEqual(failures, ['READER_NETWORK', 'READER_PARSE']);
});

test('pointer movement never passes undefined coordinates to selection correction', () => {
  const listeners = {};
  globalThis.document = { addEventListener(type, cb) { listeners[type] = cb; }, getSelection() { return null; } };
  let callback, coordinates;
  globalThis.requestAnimationFrame = cb => { callback = cb; return 1; };
  const context = { viewport: { addEventListener() {} }, installReaderTapSelectionClear() {}, pdfSelectionPointer: { id: 1, x: 1, y: 2, frame: 0, anchorNode: {} }, correctPdfCrossPageSelection(x, y) { coordinates = [x, y]; } };
  createReaderBindings(context).bindPdfPointerSelection();
  listeners.pointermove({ pointerType: 'mouse', pointerId: 1, clientX: 10, clientY: 20 });
  delete context.pdfSelectionPointer.endX; delete context.pdfSelectionPointer.endY;
  callback();
  assert.deepEqual(coordinates, [1, 2]);
});

test('pressing End on the progress slider at 100% preserves the previous seek for Undo', async (t) => {
  if (!globalThis.document) {
    globalThis.document = {};
    t.after(() => { delete globalThis.document; });
  }
  const range = Object.assign(new EventTarget(), { value: '0', setAttribute() {} });
  let generation = 0;
  const context = {
    capability: { mode: 'markdown' }, viewport: { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 },
    progressRange: range, progressPercent: {}, progressUndo: new EventTarget(),
    chapterPrev: new EventTarget(), chapterNext: new EventTarget(),
    progressSeeking: false, previousProgressState: null, epubSeekPromise: Promise.resolve(),
    beginReaderNavigation() { return ++generation; },
    readerRuntime: { currentGeneration: () => generation },
    isReaderGenerationCurrent: (_, value) => value === generation,
    scheduleSave() {}, updateProgressTools() {}
  };
  const { seekProgress, captureProgressState, restoreProgressState, flushEpubSeek } = createReaderProgress(context);
  Object.assign(context, { seekProgress, captureProgressState, restoreProgressState, flushEpubSeek });
  createReaderBindings(context).bindProgressActions();
  const key = type => range.dispatchEvent(Object.assign(new Event(type), { key: 'End' }));
  const drag = (...values) => {
    range.dispatchEvent(new Event('pointerdown'));
    for (const value of values) {
      range.value = value;
      range.dispatchEvent(new Event('input'));
    }
    range.dispatchEvent(new Event('pointerup'));
  };
  drag('20');
  assert.deepEqual(context.previousProgressState, { scrollTop: 0 });
  drag('90', '100');
  assert.equal(context.viewport.scrollTop, 900);
  assert.deepEqual(context.previousProgressState, { scrollTop: 180 }, 'keep one undo point across drag events');

  // At the upper limit the browser emits key events, but no input event.
  const before = generation;
  key('keydown');
  key('keyup');
  context.progressUndo.dispatchEvent(new Event('click'));
  assert.equal(context.viewport.scrollTop, 180);
  assert.equal(generation, before + 1, 'only Undo should start a navigation');
  await context.epubSeekPromise;
});

test('body clicks and taps leave an outstanding restore current; a swipe or wheel takes over', () => {
  const viewport = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0 }) });
  let navigation = 0;
  bindReaderScrollIntent(viewport, () => { navigation++; });
  const dispatch = (type, properties) => viewport.dispatchEvent(Object.assign(new Event(type), properties));
  const touch = clientY => ({ touches: [{ identifier: 1, clientY }] });
  dispatch('pointerdown', { pointerType: 'mouse', button: 0, clientX: 20 });
  dispatch('touchstart', touch(40));
  dispatch('touchmove', touch(44));
  dispatch('touchend', {});
  assert.equal(navigation, 0);
  dispatch('touchstart', touch(40));
  dispatch('touchmove', touch(60));
  dispatch('touchmove', touch(80));
  assert.equal(navigation, 1);
  dispatch('wheel', { deltaY: 60, ctrlKey: true });
  dispatch('wheel', { deltaY: 60 });
  assert.equal(navigation, 2);
});

test('media without a finite positive duration cannot supersede restoration or save a seek', () => {
  const context = {
    capability: { mode: 'video' }, viewport: { scrollTop: 55 }, previousProgressState: { mediaTime: 12 },
    beginReaderNavigation() { assert.fail('must not invalidate pending restoration'); },
    scheduleSave() { assert.fail('must not save'); },
    captureProgressState() { assert.fail('must not overwrite Undo'); }
  };
  const { seekProgress, readerProgressPercent } = createReaderProgress(context);
  assert.equal(seekProgress(50), false, 'media element not mounted');
  for (const duration of [NaN, 0, Infinity]) {
    context.mediaElement = { currentTime: 42, duration };
    assert.equal(seekProgress(50), false);
    assert.equal(readerProgressPercent(), 0);
    assert.equal(context.mediaElement.currentTime, 42);
  }
  assert.equal(context.viewport.scrollTop, 55);
  assert.deepEqual(context.previousProgressState, { mediaTime: 12 });
});

test('PDF bookmarks follow page height and legacy offsets stay inside the bookmarked page', async () => {
  for (const mode of ['pdf', 'pdf-pages']) {
    let height = 800, target;
    const shell = { dataset: { page: '3' }, getBoundingClientRect: () => ({ height }) };
    const context = {
      capability: { mode }, documentState: { page: 2, pageCount: 10 },
      viewport: { scrollTop: 1400, getBoundingClientRect: () => ({ top: 10 }) },
      bookmarkRibbon: { getBoundingClientRect: () => ({ bottom: 30 }) },
      pageAtMarker: () => shell, readerPageScrollTop: () => 1000, syncCurrentPageFromMarker() {},
      captureChapterPosition: () => null, readerProgressPercent: () => 42, bookmarkExcerpt: () => '',
      isReaderGenerationCurrent: () => true, goToPage: async page => { target = page; return true; },
      content: { querySelector: () => shell }, updateProgressTools() {}, scheduleSave() {}, consumeBookmarkHandoff() {}
    };
    const bookmark = createReaderBookmarks(context).captureBookmarkSnapshot();
    assert.equal(bookmark.page, 3);
    assert.equal(bookmark.pageOffset, 400);
    assert.equal(bookmark.pageOffsetFraction, 0.5);
    const { restoreFormat } = createReaderProgress(context);
    height = 1200;
    assert.equal(await restoreFormat(mode, bookmark, 0), true);
    assert.equal(target, 3);
    assert.equal(context.viewport.scrollTop, 1600);
    assert.equal(await restoreFormat(mode, { page: 3, pageOffset: 400 }, 0), true);
    assert.equal(context.viewport.scrollTop, 1400);
    height = 300;
    assert.equal(await restoreFormat(mode, { page: 3, pageOffset: 400 }, 0), true);
    assert.equal(context.viewport.scrollTop, 1278);
  }
});

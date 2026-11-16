import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReaderBindings } from '../../../static/reader/core/reader-bindings.mjs';

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

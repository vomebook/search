import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

// Fault-inject the native boundary while running the production worker handler.
// Real Wasm and transport parity are exercised by test_reader_djvu_range_browser.py.
const hooks = registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/djvu_rs.js')) return {url: 'data:text/javascript,' + encodeURIComponent(`
    export default async () => {};
    export const WasmDocument = {reader_open: () => globalThis.djvuNative};
    export const WasmLazyDocument = {open: async () => globalThis.djvuNative};
  `), shortCircuit: true};
  return nextResolve(specifier, context);
}});

async function openWorker(t, native, range = false) {
  const replies = [], calls = [];
  t.mock.method(globalThis, 'fetch', async () => new Response());
  globalThis.djvuNative = native(calls);
  globalThis.VoiceOfMLReaderResources = {djvuSupportsSIMD: () => true};
  globalThis.self = {postMessage(reply, transfer = []) {
    calls.push('reply');
    if (reply.ok && reply.pixels) assert.deepEqual(transfer, [reply.pixels]);
    replies.push(structuredClone(reply, {transfer}));
  }};
  await import(`../../../static/reader/pdf/reader-djvu-engine-worker.mjs?${encodeURIComponent(t.name)}`);
  let id = 0;
  const send = async (operation, fields) => {
    const start = replies.length;
    await globalThis.self.onmessage({data: {id: ++id, operation, ...fields}});
    assert.equal(replies.length, start + 1, 'the operation must publish exactly one reply');
    assert.equal(replies[start].id, id);
    return replies[start];
  };
  const opened = await send(range ? 'open-range' : 'open', {bytes: new ArrayBuffer(16), total: 16, cacheBytes: 4096});
  assert.deepEqual(opened, {id: 1, ok: true, count: 2, outlineNeedsFullSource: range});
  calls.length = 0;
  return {send, calls};
}

test('eager render frees and trims before replying, including validation and trim errors', async t => {
  let pixels = new Uint8ClampedArray(8), trimError = false, dpi = 1;
  const {send, calls} = await openWorker(t, calls => ({
    page_count: () => 2,
    page(index) {
      assert.equal(index, 1);
      return {dpi: () => dpi, reader_rotation: () => 90, width_at: () => 1, height_at: () => 2,
        reader_render_strict() { calls.push('render'); return pixels; },
        text() { return 'a'.repeat(2_000_001); },
        text_zones_json() { assert.fail('oversized eager text must not fetch zones'); },
        free() { calls.push('free'); }};
    },
    reader_trim_cache(budget) {
      assert.equal(budget, 4096);
      calls.push('trim');
      if (trimError) throw Error('trim failed');
    }
  }));
  const geometry = {width: 1, height: 2, dpi: 1, rotation: 90};
  assert.deepEqual(await send('page', {page: 2}), {id: 2, ok: true, ...geometry, pixels: new ArrayBuffer(8)});
  assert.deepEqual(calls.splice(0), ['render', 'free', 'trim', 'reply']);
  assert.equal(pixels.byteLength, 0, 'the raster backing buffer was transferred');
  assert.equal((await send('geometry', {page: 2})).error, 'DJVU_PAGE_GEOMETRY_INVALID');
  assert.deepEqual(calls.splice(0), ['free', 'reply']);
  dpi = 25;
  assert.equal((await send('text', {page: 2})).error, 'DJVU_TEXT_SIZE_LIMIT');
  assert.deepEqual(calls.splice(0), ['free', 'reply']);
  pixels = new Uint8ClampedArray(4);
  assert.equal((await send('page', {page: 2})).error, 'DJVU_PAGE_DECODE_INVALID');
  assert.deepEqual(calls.splice(0), ['render', 'free', 'trim', 'reply']);
  trimError = true;
  pixels = new Uint8ClampedArray(8);
  assert.equal((await send('page', {page: 2})).error, 'DJVU_PAGE_DECODE_FAILED');
  assert.deepEqual(calls.splice(0), ['render', 'free', 'trim', 'reply']);
  assert.equal(pixels.byteLength, 8, 'failed cleanup must not transfer the raster');
});

test('range operations share geometry checks and free each actual pixmap before replying', async t => {
  let tuple = new Uint32Array([1, 2, 6000, 270]), pixmapWidth = 1;
  const {send, calls} = await openWorker(t, calls => ({
    page_count: () => 2,
    reader_outline_needs_full_source: () => true,
    async reader_geometry(index) { assert.equal(index, 1); calls.push('geometry'); return tuple; },
    async reader_render_strict(index) {
      assert.equal(index, 1);
      calls.push('render');
      return {width: () => pixmapWidth, height: () => 2, to_bytes: () => new Uint8ClampedArray(8),
        free() { calls.push('free'); }};
    },
    async reader_text(index) { assert.equal(index, 1); calls.push('text'); return 'synthetic'; },
    async reader_text_zones_json(index) { assert.equal(index, 1); calls.push('zones'); return '{}'; }
  }), true);
  assert.equal((await send('page', {page: 2})).ok, true);
  assert.deepEqual(calls.splice(0), ['geometry', 'render', 'free', 'reply']);
  pixmapWidth = 2;
  assert.equal((await send('page', {page: 2})).error, 'DJVU_PAGE_DECODE_INVALID');
  assert.deepEqual(calls.splice(0), ['geometry', 'render', 'free', 'reply']);
  assert.equal((await send('text', {page: 2})).error, 'DJVU_TEXT_SIZE_LIMIT');
  assert.deepEqual(calls.splice(0), ['geometry', 'text', 'zones', 'reply']);
  for (const invalid of [[1, 2, 6001, 270], [1, 2, 6000], [10_000, 10_000, 6000, 270]]) {
    tuple = new Uint32Array(invalid);
    for (const operation of ['page', 'geometry', 'text']) {
      assert.equal((await send(operation, {page: 2})).error, 'DJVU_PAGE_GEOMETRY_INVALID');
      assert.deepEqual(calls.splice(0), ['geometry', 'reply']);
    }
  }
});

test.after(() => {
  hooks.deregister();
  delete globalThis.djvuNative;
  delete globalThis.VoiceOfMLReaderResources;
  delete globalThis.self;
});

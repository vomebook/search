import assert from 'node:assert/strict';
import test from 'node:test';
import {createReaderImageLoader} from '../../../static/reader/formats/reader-image-loader.mjs';

function fixture() {
  const controller = new AbortController(), tracked = new Set(), requests = [];
  const image = {src: '', naturalWidth: 0, complete: false, fetchPriority: 'high', onload: null, onerror: null,
    removeAttribute(name) { if (name === 'src') this.src = ''; }};
  const loader = createReaderImageLoader({
    assertActive() {}, abortError: () => new DOMException('closed', 'AbortError'),
    trackResource(callback) { tracked.add(callback); return () => tracked.delete(callback); },
    async request(url, timeout, options) { requests.push({url, timeout, options}); return new Response('offline', {status: 503}); },
    async readBytes(response) { return new Uint8Array(await response.arrayBuffer()); },
    timeoutMs: 30
  });
  return {image, loader, controller, tracked, requests};
}

const oldLocation = globalThis.location;
const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
globalThis.location = new URL('https://reader.test/static/reader.html');
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {onLine: true}});
test.after(() => {
  if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
});

test('direct image success clears handlers and the tracked resource', async () => {
  const f = fixture();
  const pending = f.loader.load(f.image, 'blob:original', f.controller.signal);
  assert.equal(f.tracked.size, 1);
  assert.equal(typeof f.image.onload, 'function');
  f.image.onload();
  assert.equal(await pending, f.image);
  assert.equal(f.image.onload, null);
  assert.equal(f.image.onerror, null);
  assert.equal(f.tracked.size, 0);
  assert.deepEqual(f.requests, []);
});

test('image cancellation settles immediately even when the reader stays active', async () => {
  const f = fixture();
  const pending = f.loader.load(f.image, 'blob:original', f.controller.signal);
  const cancellation = assert.rejects(pending, {name: 'AbortError'});
  f.controller.abort();
  assert.equal(f.image.src, '');
  assert.equal(f.image.onload, null);
  assert.equal(f.image.onerror, null);
  assert.equal(f.tracked.size, 0);
  await cancellation;
  assert.deepEqual(f.requests, []);
});

test('resource disposal settles without retaining handlers or starting fallback', async () => {
  const f = fixture();
  const pending = f.loader.load(f.image, 'blob:original', f.controller.signal);
  const cancellation = assert.rejects(pending, {name: 'AbortError'});
  for (const dispose of [...f.tracked]) dispose();
  assert.equal(f.tracked.size, 0);
  assert.equal(f.image.src, '');
  assert.equal(f.image.onload, null);
  assert.equal(f.image.onerror, null);
  await cancellation;
  assert.deepEqual(f.requests, []);
});

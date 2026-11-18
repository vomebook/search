import assert from 'node:assert/strict';
import test from 'node:test';
import {createReaderImageLoader} from '../../../static/reader/formats/reader-image-loader.mjs';

function fixture({response = () => new Response('offline', {status: 503}), readBytes = async r => new Uint8Array(await r.arrayBuffer())} = {}) {
  const controller = new AbortController(), tracked = new Set(), requests = [], sources = [];
  let src = '';
  const image = {get src() { return src; }, set src(value) { src = value; sources.push(value); },
    naturalWidth: 0, complete: false, fetchPriority: 'high', onload: null, onerror: null,
    removeAttribute(name) { if (name === 'src') src = ''; }};
  const loader = createReaderImageLoader({
    assertActive() {}, abortError: () => new DOMException('closed', 'AbortError'),
    trackResource(callback) { tracked.add(callback); return () => tracked.delete(callback); },
    async request(url, timeout, options) { requests.push({url, timeout, options}); return response(); },
    readBytes,
    timeoutMs: 30
  });
  return {image, loader, controller, tracked, requests, sources};
}

function clock(t) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({apis: ['setTimeout']});
  return ms => { now += ms; t.mock.timers.tick(ms); };
}

function assertCleared(f) {
  assert.equal(f.image.src, '');
  assert.equal(f.image.onload, null);
  assert.equal(f.image.onerror, null);
  assert.equal(f.tracked.size, 0);
}

const target = 'https://reader.test/converted.webp';

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
  assertCleared(f);
  await cancellation;
  assert.deepEqual(f.requests, []);
});

test('pre-aborted image never starts a request', async () => {
  const f = fixture();
  f.controller.abort();
  await assert.rejects(f.loader.load(f.image, target, f.controller.signal), {name: 'AbortError'});
  assertCleared(f);
  assert.deepEqual(f.sources, []);
  assert.deepEqual(f.requests, []);
});

test('a complete image reuses its canonical source', async () => {
  const f = fixture();
  f.image.src = target;
  f.image.complete = true;
  f.image.naturalWidth = 1;
  assert.equal(await f.loader.load(f.image, '/converted.webp', f.controller.signal), f.image);
  assert.deepEqual(f.sources, [target]);
  assert.deepEqual(f.requests, []);
  assert.equal(f.tracked.size, 0);
});

test('offline image failures never retry or fetch', async t => {
  const tick = clock(t);
  t.after(() => { navigator.onLine = true; });
  navigator.onLine = false;
  const broken = fixture();
  const rejected = assert.rejects(broken.loader.load(broken.image, target, broken.controller.signal), {code: 'READER_IMAGE_LOAD'});
  broken.image.onerror();
  await rejected;
  const stalled = fixture();
  const timedOut = assert.rejects(stalled.loader.load(stalled.image, target, stalled.controller.signal), {name: 'TimeoutError'});
  tick(30);
  await timedOut;
  for (const f of [broken, stalled]) {
    assertCleared(f);
    assert.deepEqual(f.sources, [target]);
    assert.deepEqual(f.requests, []);
  }
});

test('image retry honors the original deadline', async t => {
  const tick = clock(t);
  const expired = fixture();
  const expiredResult = assert.rejects(expired.loader.load(expired.image, target, expired.controller.signal, 0), {code: 'READER_IMAGE_LOAD'});
  expired.image.onerror();
  await expiredResult;
  assertCleared(expired);
  assert.deepEqual(expired.sources, [target]);
  assert.deepEqual(expired.requests, []);

  const f = fixture();
  const pending = assert.rejects(f.loader.load(f.image, target, f.controller.signal, 100), {name: 'TimeoutError'});
  tick(90);
  const staleError = f.image.onerror;
  staleError();
  await Promise.resolve();
  staleError(); // An event from the old attempt must not clear the new one.
  tick(9);
  assert.deepEqual(f.sources, [target, target]);
  assert.equal(f.image.src, target);
  tick(1);
  await pending;
  assertCleared(f);
  assert.deepEqual(f.requests, []);
});

test('cancelling a retry stops without a third attempt', async t => {
  clock(t);
  const f = fixture();
  const cancelled = assert.rejects(f.loader.load(f.image, target, f.controller.signal), {name: 'AbortError'});
  f.image.onerror();
  await Promise.resolve();
  assert.deepEqual(f.sources, [target, target]);
  f.controller.abort();
  await cancelled;
  assertCleared(f);
  assert.deepEqual(f.requests, []);
});

test('timed-out image fetch preserves the signal and cancels a failed response body', async t => {
  const tick = clock(t);
  let cancellations = 0;
  const f = fixture({response: () => new Response(new ReadableStream({cancel() { cancellations++; }}), {status: 503}),
    readBytes: () => assert.fail('failed response must not be read')});
  f.image.fetchPriority = '';
  const failed = assert.rejects(f.loader.load(f.image, target, f.controller.signal, 60_000), {status: 503});
  tick(14_999);
  assert.deepEqual(f.requests, []);
  tick(1);
  await failed;
  assert.equal(cancellations, 1);
  assert.deepEqual(f.requests, [{url: target, timeout: 45_000, options: {signal: f.controller.signal, priority: 'auto'}}]);
  assertCleared(f);
});

test('cancelling a fallback image revokes its blob URL', async t => {
  const tick = clock(t);
  const blob = 'blob:converted', f = fixture({response: () => new Response(new Uint8Array([1]))});
  const create = t.mock.method(URL, 'createObjectURL', () => blob);
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
  const cancelled = assert.rejects(f.loader.load(f.image, target, f.controller.signal, 60_000), {name: 'AbortError'});
  tick(15_000);
  // Wait for the fetch and response body before cancelling the pending image.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sources, [target, blob]);
  assert.equal(create.mock.calls.length, 1);
  assert.equal(create.mock.calls[0].arguments[0].type, '');
  f.controller.abort();
  await cancelled;
  assert.equal(revoke.mock.calls.length, 1);
  assert.deepEqual(revoke.mock.calls[0].arguments, [blob]);
  assertCleared(f);
});

test('bytes arriving after cancellation never create an image', async t => {
  const tick = clock(t);
  let startRead, finishRead;
  const readStarted = new Promise(resolve => { startRead = resolve; });
  const bytes = new Promise(resolve => { finishRead = resolve; });
  const f = fixture({response: () => new Response(), readBytes: () => { startRead(); return bytes; }});
  const create = t.mock.method(URL, 'createObjectURL', () => assert.fail('late bytes must not become a blob URL'));
  const reason = new Error('page no longer visible');
  const cancelled = assert.rejects(f.loader.load(f.image, target, f.controller.signal, 60_000), error => error === reason);
  tick(15_000);
  await readStarted;
  f.controller.abort(reason);
  finishRead(new Uint8Array([1]));
  await cancelled;
  assert.equal(create.mock.calls.length, 0);
  assert.deepEqual(f.sources, [target]);
  assertCleared(f);
});

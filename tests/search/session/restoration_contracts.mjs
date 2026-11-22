import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {installClassicSearchModules} from '../../support/classic_search_modules.js';

const source = fs.readFileSync('static/app.js', 'utf8');
const key = JSON.stringify({pageSize: 2});
const position = {version: 1, key, index: 4, offset: 7, anchorId: 'r4', loadedPage: 3, savedAt: Date.now()};
const preview = (saved = position) => ({key, savedAt: Date.now(), total: 12, generation: 'A', resultBackend: 'api',
  estimatedHeight: 40, measurementKey: 'layout', records: [[saved.index, {File: 'saved', id: saved.anchorId}, 40]]});
const page = (number, generation = 'A', total = 12) => ({page: number, page_size: 2, total, generation,
  results: Array.from({length: Math.min(2, Math.max(0, total - (number - 1) * 2))}, (_, i) => ({id: 'r' + ((number - 1) * 2 + i)}))});
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const flush = () => new Promise(resolve => setImmediate(resolve));

// Run the real host composition as well as the coordinator. All geometry stays
// behind the same ports as production; tests can replace the live page hook.
function fixture() {
  const calls = [], events = [], encoded = [], timers = [];
  const c = vm.createContext({AbortController, TextEncoder: class extends TextEncoder {
    encode(value) {encoded.push(value); return super.encode(value);}
  }, setTimeout(fn, ms) {assert.equal(ms, 30); timers.push(fn);},
    resultWindow: null, searchIntentId: 0, searchId: 0,
    STATE: {isLoading: false, results: []}, VSCROLL: {isDraggingThumb: false, estimatedHeight: 40},
    readerHost: {overlay: null}, getSearchViewKey: () => key,
    positionPersistence: {getPosition: () => position},
    cancelActiveSearch() {events.push('active'); c.searchId++; return true;},
    updateResultWindowStatus() {events.push('window');},
    setReturnPositionTarget() {events.push('target');}, resetPagingRecovery() {events.push('paging');},
    showPositionRestoreStatus(message, retry) {events.push(['status', message, retry]);},
    readSearchViewport: async () => null,
    fetchPositionPageWithRecovery: async (query, number, signal, anchorId) => {
      calls.push({query, number, signal, anchorId}); return {...page(number), ...(anchorId ? {anchor_index: 4} : {})};
    },
    captureReaderReturnScroll: () => ({index: 4, offset: 7}), getResultStableId: record => record?.id || '',
    applyValidatedSearchViewport(snapshot) {events.push('apply'); c.snapshot = snapshot; c.STATE.isLoading = false;},
    restoreSearchViewSnapshot(k, scroll, options) {
      assert.equal(scroll, true);
      if (options.preserveRestore) {
        assert.equal(restoration.current.preview, true);
        events.push('preview'); c.preview = store.snapshots.get(k);
      } else {
        assert.equal(restoration.current, null);
        assert.equal(options.preserveQueryDraft, true);
        events.push('restore'); c.snapshot = store.snapshots.get(k);
      }
      c.STATE.isLoading = false;
    },
    showToast(message) {events.push(['toast', message]);}
  });
  installClassicSearchModules(process.cwd(), c);
  const store = c.VoiceOfMLResultSnapshots.create({});
  c.resultSnapshots = {...store,
    cancelClone() {store.cancelClone(); events.push('clone');},
    putRestored(k, snapshot) {store.putRestored(k, snapshot); events.push('put');},
    trim() {store.trim(); events.push('trim');}
  };
  c.validatePositionWindowPage = (...args) => c.VoiceOfMLSearchWindowPage.validate(...args);
  c.apiAvailable = true;
  c.navigator = {onLine: true};
  vm.runInContext(source.match(/^const positionRestoration = VoiceOfMLPositionRestoration.create\(\{[^]*?^\}\);/m)[0], c);
  for (const name of ['preferredPositionBackend', 'lookupPositionPage'])
    vm.runInContext(source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'))[0], c);
  const restoration = vm.runInContext('positionRestoration', c);
  vm.runInContext(source.match(/^const \{ cancel: cancelPositionRestore, start: tryRestoreSearchPosition \} = positionRestoration;$/m)[0], c);
  const start = (options = {viewport: null}) => {
    assert.equal(restoration.start(key, options), true);
    return restoration.current;
  };
  return {c, calls, events, encoded, timers, restoration, start, store};
}

test('authoritative restore trims the exact sparse budget without serializing the holes', async () => {
  const f = fixture(), index = 49_994;
  f.c.fetchPositionPageWithRecovery = vm.runInContext(`async (query, page) => ({page, page_size: 2,
    total: 50_000, generation: '版本', anchor_index: ${index}, results: [0, 1].map(offset => ({
      id: 'r' + ((page - 1) * 2 + offset), File: '书📚', Folder: ['路径']
    }))})`, f.c);
  f.start({viewport: null, position: {...position, index, anchorId: 'r' + index, loadedPage: 25_000}}); await flush();
  const {bytes, ...envelope} = f.c.snapshot;
  assert.equal(bytes, new TextEncoder().encode(JSON.stringify(envelope)).length + 256);
  assert.equal(envelope.results.length, 50_000);
  assert.equal(2 in envelope.results, false);
  assert.equal(envelope.results[index].id, 'r' + index);
  assert.ok(f.encoded.some(text => text.includes('"results":[]')));
  assert.ok(f.encoded.every(text => text.length < 1024));
  assert.deepEqual(f.events.filter(event => ['put', 'restore', 'trim'].includes(event)), ['put', 'restore', 'trim']);
});

test('restoration retries retain lookup and partial-neighbor buffer identity without duplicate rendering', async () => {
  const f = fixture(), original = f.c.fetchPositionPageWithRecovery;
  f.c.fetchPositionPageWithRecovery = (...args) => args[1] === 3 ? Promise.reject(new Error('offline')) : original(...args);
  const first = f.start(); await flush();
  assert.equal(first.failed, true); assert.deepEqual([...first.ready.keys()], [1, 2, 4]);
  assert.equal(f.c.snapshot, undefined); assert.equal(f.events.includes('restore'), false);
  f.c.apiAvailable = false;
  f.calls.length = 0; f.c.fetchPositionPageWithRecovery = original;
  const retry = f.start();
  assert.equal(retry.ready, first.ready); assert.equal(retry.lookup, first.lookup);
  assert.equal(retry.backend, 'api');
  await flush();
  assert.deepEqual(f.calls.map(call => [call.query.resultBackend, call.number]), [['api', 3]]);
  assert.equal(f.c.snapshot.scroll.index, 4); assert.equal(f.c.snapshot.scroll.offset, 7);
  assert.equal(f.events.filter(event => event === 'restore').length, 1);
  assert.equal(f.events.includes('apply'), false); assert.equal(f.restoration.current, null);
});

test('generation mismatch clears the shared retry buffer and restarts lookup through the live validation hook', async () => {
  const f = fixture(), original = f.c.fetchPositionPageWithRecovery;
  f.c.fetchPositionPageWithRecovery = (...args) => args[1] === 3 ? Promise.resolve(page(3, 'B')) : original(...args);
  let validations = 0;
  f.c.validatePositionWindowPage = (...args) => {validations++; f.c.VoiceOfMLSearchWindowPage.validate(...args);};
  const first = f.start(), buffer = first.ready; buffer.set(2, page(2));
  await flush();
  assert.ok(validations >= 2); assert.equal(first.error.message, 'RESTORE_PAGE_CHANGED');
  assert.equal(first.ready, buffer); assert.equal(buffer.size, 0); assert.equal(first.lookup, null); assert.equal(f.c.snapshot, undefined);
  f.calls.length = 0; f.c.fetchPositionPageWithRecovery = original;
  const retry = f.start(); assert.equal(retry.ready, buffer);
  await flush(); assert.deepEqual(f.calls.map(call => call.number), [1, 2, 3, 4]);
});

test('stale viewport, lookup and neighbor completions cannot publish or mark a newer task failed', async () => {
  for (const stage of ['viewport', 'lookup', 'neighbors']) for (const rejection of [false, true]) {
    const f = fixture(), gate = deferred(), original = f.c.fetchPositionPageWithRecovery;
    if (stage === 'viewport') f.c.readSearchViewport = () => gate.promise;
    else f.c.fetchPositionPageWithRecovery = (...args) => (stage === 'lookup' ? args[1] === 1 : args[1] === 3) ? gate.promise : original(...args);
    const first = f.start({viewport: stage === 'viewport' ? undefined : null});
    await flush();
    f.c.readSearchViewport = () => deferred().promise;
    const newer = f.start({position});
    if (rejection) gate.reject(new Error('late')); else gate.resolve(stage === 'viewport' ? null : page(stage === 'lookup' ? 1 : 3));
    await flush();
    assert.equal(first.controller.signal.aborted, true);
    assert.equal(f.restoration.current, newer); assert.equal(f.c.STATE.isLoading, true);
    assert.equal(first.failed, undefined); assert.equal(newer.failed, undefined); assert.equal(f.c.snapshot, undefined);
  }
});

test('preview waits for drag release, accepts only matching cached pages and applies once', async () => {
  const f = fixture();
  f.c.STATE.results[4] = {id: 'r4'}; f.c.VSCROLL.isDraggingThumb = true;
  f.c.captureReaderReturnScroll = () => ({index: 4, offset: 19});
  const task = f.start({viewport: preview()});
  for (const [number, data] of [[3, page(3)], [5, {...page(5), resultBackend: 'api'}],
    [6, {...page(6, 'old'), resultBackend: 'api'}], [7, {...page(7), resultBackend: 'local'}]])
    f.restoration.rememberPreviewPage(number, data);
  await flush();
  assert.equal(f.timers.length, 1); assert.equal(f.c.snapshot, undefined);
  assert.equal(f.c.preview.window.preview, true); assert.equal(f.c.preview.resultBackend, 'api');
  assert.equal(f.c.preview.results[4].id, 'r4'); assert.equal(f.store.snapshots.has(key), false);
  f.c.VSCROLL.isDraggingThumb = false; f.timers.shift()(); await flush();
  assert.equal(task.ready.has(5), true); assert.equal(task.ready.has(6), false); assert.equal(task.ready.has(7), false);
  assert.equal(f.c.snapshot.scroll.offset, 19); assert.equal(f.c.snapshot.results[8].id, 'r8');
  assert.equal(f.events.filter(event => event === 'apply').length, 1);
  assert.equal(f.events.includes('restore'), false); assert.equal(f.events.includes('put'), false);
});

test('abort during drag wait leaves the task and snapshot untouched', async () => {
  const f = fixture(); f.c.VSCROLL.isDraggingThumb = true;
  const task = f.start({viewport: preview()}); await flush(); task.controller.abort(); f.timers.shift()(); await flush();
  assert.equal(f.c.snapshot, undefined); assert.equal(task.failed, undefined); assert.equal(f.restoration.current, task);
});

test('moving preview anchor outside ready pages restarts lookup without replacing the shared map', async () => {
  const f = fixture(), original = f.c.fetchPositionPageWithRecovery;
  f.c.STATE.results[10] = {id: 'r10'}; f.c.captureReaderReturnScroll = () => ({index: 10, offset: 23});
  f.c.fetchPositionPageWithRecovery = async (...args) => ({...await original(...args), ...(args[3] ? {anchor_index: args[3] === 'r10' ? 10 : 4} : {})});
  const task = f.start({viewport: preview()}), buffer = task.ready; await flush();
  assert.equal(task.ready, buffer); assert.deepEqual(f.calls.filter(call => call.anchorId).map(call => call.anchorId), ['r4', 'r10']);
  assert.deepEqual([...buffer.keys()], [1, 5, 6]); assert.equal(f.c.snapshot.scroll.index, 10);
  assert.equal(f.c.snapshot.scroll.offset, 23); assert.equal(task.position.anchorId, 'r10');
  assert.equal(f.events.filter(event => event === 'apply').length, 1);
});

test('a failed neighbor retry preserves the moved anchor and its offset', async () => {
  const f = fixture(), original = f.c.fetchPositionPageWithRecovery;
  f.c.STATE.results[10] = {id: 'r10'};
  f.c.captureReaderReturnScroll = () => ({index:10, offset:23});
  let fail = true;
  f.c.fetchPositionPageWithRecovery = async (...args) => {
    if (fail && args[1] === 6) throw new Error('offline');
    return {...await original(...args), ...(args[3] === 'r10' ? {anchor_index:10} : {})};
  };
  const first = f.start({viewport: preview()}); await flush();
  assert.ok(first.failed); assert.equal(first.position.anchorId, 'r10');
  fail = false; f.calls.length = 0;
  f.c.readSearchViewport = async () => preview(first.position);
  const rejected = [];
  assert.equal(f.restoration.resume((k, backend) => {rejected.push([k, backend]); return false;}), true);
  assert.deepEqual(rejected, [[key, 'api']]);
  assert.equal(f.restoration.current, first); assert.equal(f.calls.length, 0);
  assert.equal(f.restoration.resume(() => true), true); await flush();
  assert.deepEqual(f.calls.map(call => call.number), [6]);
  assert.equal(f.c.snapshot.scroll.index, 10); assert.equal(f.c.snapshot.scroll.offset, 23);
});

test('Reader overlay retains the saved anchor and missing anchor uses the nearby snapshot path', async () => {
  const f = fixture(); f.c.readerHost.overlay = {};
  f.c.captureReaderReturnScroll = () => {throw new Error('Reader must retain the saved anchor');};
  f.start({viewport: preview()}); await flush();
  assert.equal(f.c.snapshot.scroll.index, 4); assert.equal(f.events.includes('apply'), true);
  const missing = fixture(), saved = {...position, anchorId: 'gone'};
  missing.start({position: saved, viewport: preview(saved)}); await flush();
  assert.equal(missing.c.snapshot.scroll.index, 4); assert.equal(missing.events.includes('restore'), true);
  assert.equal(missing.events.includes('apply'), false); assert.equal(missing.events.filter(event => event[0] === 'toast').length, 1);
});

test('preview keeps a user-moved hole instead of a vanished saved anchor', async () => {
  const f = fixture();
  f.c.captureReaderReturnScroll = () => ({index: 11, offset: 17});
  const saved = {...position, anchorId: 'gone'};
  f.start({position: saved, viewport: preview(saved)}); await flush();
  assert.equal(f.c.snapshot.scroll.index, 11);
  assert.equal(f.c.snapshot.scroll.offset, 17);
  assert.equal(f.events.includes('apply'), true);
  assert.equal(f.events.includes('restore'), false);
  assert.equal(f.events.some(event => event[0] === 'toast'), false);
});

test('synchronous prologue retains ordering, duplicate handling and abort reentry ownership', () => {
  const f = fixture();
  f.c.readSearchViewport = () => deferred().promise;
  const active = f.start({}), entry = f.restoration.entry;
  f.events.length = 0;
  assert.equal(f.restoration.start(key), true); assert.deepEqual(f.events, []);
  assert.equal(f.c.searchIntentId, 2); assert.equal(f.restoration.entry, entry);
  let newer;
  active.controller.signal.addEventListener('abort', () => {newer = f.start({position});});
  assert.equal(f.restoration.start(key, {position}), false);
  assert.deepEqual(f.events.slice(0, 3), ['active', 'clone', 'window']);
  assert.equal(f.restoration.entry, entry + 2); assert.equal(f.restoration.current, newer);
  assert.equal(f.c.STATE.isLoading, true); assert.equal(f.events.filter(event => event === 'target').length, 1);
});

test('active-search abort reentry exits before restoration cancellation', () => {
  const f = fixture(), active = f.start(), entry = f.restoration.entry;
  f.c.cancelActiveSearch = () => false;
  assert.equal(f.restoration.start(key, {position}), false);
  assert.equal(f.restoration.entry, entry); assert.equal(active.controller.signal.aborted, false);
  assert.equal(f.restoration.current, active);
});

test('window abort sees both owners cleared and retains the replacement window and restore', () => {
  const f = fixture();
  f.c.readSearchViewport = () => deferred().promise;
  const active = f.start({}), old = new AbortController(), replacement = {controller: new AbortController()};
  f.c.resultWindow = {controller: old};
  let newer, observed;
  old.signal.addEventListener('abort', () => {
    observed = [f.c.resultWindow, f.restoration.current, f.c.STATE.isLoading, active.controller.signal.aborted];
    newer = f.start({position});
    f.c.resultWindow = replacement;
  });
  f.restoration.cancel();
  assert.deepEqual(observed, [null, null, false, false]);
  assert.equal(active.controller.signal.aborted, true);
  assert.equal(f.c.resultWindow, replacement);
  assert.equal(f.restoration.current, newer);
  assert.equal(replacement.controller.signal.aborted, false);
  assert.equal(newer.controller.signal.aborted, false);
});

test('cancelling the position entry alone invalidates an initial viewport read', async () => {
  const f = fixture(), gate = deferred();
  vm.runInContext(source.match(/^async function searchWithInitialFallback\([^]*?^}/m)[0], f.c);
  let reads = 0, validations = 0, fallback = 0;
  Object.assign(f.c, {saveSearchViewSnapshot() {}, prepareReturnPosition() {}, getReturnPositionTarget: () => position,
    validSearchViewport() {validations++; return true;}, searchWithInitialFallbackFresh() {fallback++;},
    readSearchViewport() {reads++; return gate.promise;}});
  const pending = f.c.searchWithInitialFallback();
  assert.equal(reads, 1); assert.equal(f.restoration.current, null);
  const intent = f.c.searchIntentId, owner = f.c.searchId, entry = f.restoration.entry;
  f.restoration.cancel();
  assert.equal(f.restoration.entry, entry + 1);
  assert.equal(f.c.getSearchViewKey(), key);
  assert.equal(f.c.searchIntentId, intent); assert.equal(f.c.searchId, owner);
  gate.resolve(preview());
  assert.equal(await pending, false);
  assert.equal(validations, 0); assert.equal(fallback, 0); assert.equal(f.restoration.current, null);
});

test('API recovery after a Worker lookup cannot change its neighbor or snapshot backend', async () => {
  const f = fixture(), original = f.c.fetchPositionPageWithRecovery;
  f.c.apiAvailable = false;
  f.c.fetchPositionPageWithRecovery = async (...args) => {
    const data = await original(...args);
    if (args[3]) f.c.apiAvailable = true;
    return data;
  };
  const task = f.start(); await flush();
  assert.deepEqual(f.calls.map(call => [call.number, call.query.resultBackend]), [[1, 'local'], [2, 'local'], [3, 'local'], [4, 'local']]);
  assert.equal(task.backend, 'local');
  assert.equal(f.c.snapshot.resultBackend, 'local');
});

test('only an unpinned Worker lookup can fall back to API, and neighbors retain that API backend', async () => {
  for (const scenario of ['fallback', 'pinned', 'aborted']) {
    const f = fixture(), original = f.c.fetchPositionPageWithRecovery;
    f.c.apiAvailable = false;
    f.c.fetchPositionPageWithRecovery = async (...args) => {
      if (args[0].resultBackend === 'local') {
        f.calls.push({query: args[0], number: args[1]});
        f.c.apiAvailable = true;
        if (scenario === 'aborted') f.restoration.current.controller.abort();
        throw new Error('WORKER_UNAVAILABLE');
      }
      return original(...args);
    };
    const task = f.start({viewport: null, backend: scenario === 'pinned' ? 'local' : undefined}); await flush();
    const calls = f.calls.map(call => [call.number, call.query.resultBackend]);
    if (scenario === 'fallback') {
      assert.deepEqual(calls, [[1, 'local'], [1, 'api'], [2, 'api'], [3, 'api'], [4, 'api']]);
      assert.equal(f.c.snapshot.resultBackend, 'api');
    } else {
      assert.deepEqual(calls, [[1, 'local']]);
      assert.equal(f.c.snapshot, undefined);
      assert.equal(task.failed, scenario === 'pinned' ? true : undefined);
    }
  }
});

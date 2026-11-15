import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';
import {createRequire} from 'node:module';

test('positions modules are composed once and synchronized across shell, resources and worker', () => {
  const read = name => readFileSync(new URL('../../../' + name, import.meta.url), 'utf8');
  const html = read('static/index.html'), worker = read('static/sw.js');
  const resources = createRequire(import.meta.url)('../../../static/reader-resources.js');
  for (const name of ['search/positions/domain/policy.js', 'search/positions/infrastructure/indexed-db.js',
    'search/positions/application/persistence.js']) {
    assert.equal(APP_DEPENDENCIES.filter(path => path === name).length, 1);
    assert.equal(html.split(name).length - 1, 1);
    assert.ok(html.indexOf(name) < html.lastIndexOf('app.js'));
    assert.equal(stripBundledScripts(html).includes(name), false);
    assert.equal(worker.split(name).length - 1, 1);
    for (const site of ['github', 'hf']) assert.equal(resources.buildFiles(site).filter(path => path === name).length, 1);
  }
});

function fixture(overrides = {}) {
  const context = vm.createContext({indexedDB, IDBKeyRange, setTimeout, clearTimeout,
    TextEncoder, AbortController, ...overrides});
  for (const file of ['search-session.js', 'domain/search-window-page.js',
    'positions/domain/policy.js', 'positions/infrastructure/indexed-db.js', 'positions/application/persistence.js']) {
    vm.runInContext(readFileSync(new URL('../../../static/search/' + file, import.meta.url), 'utf8'), context);
  }
  const storage = context.VoiceOfMLPositionStorage.create();
  const controller = context.VoiceOfMLSearchPositions.create({storage, cloneResult: structuredClone, metadata: () => undefined});
  return {context, storage, controller};
}
function fakeDatabase() {
  let transaction;
  const db = {close() {}, objectStoreNames: {contains: () => true}, transaction() {
    const request = {};
    transaction = {objectStore: () => ({get: () => request, getAll: () => request}), request, abort() {}};
    return transaction;
  }};
  const opening = {};
  const f = fixture({indexedDB: {open: () => opening}});
  const initializing = f.storage.init(() => {});
  opening.result = db; opening.onsuccess();
  transaction.request.result = []; transaction.request.onsuccess(); transaction.oncomplete();
  return {...f, initializing, transaction: () => transaction};
}

test('read success remains provisional until transaction completes; abort and timeout discard it', async () => {
  const f = fakeDatabase(); await f.initializing;
  let settled = false;
  const read = f.storage.read('viewports', 'key').then(value => {settled = true; return value;});
  let tx = f.transaction(); tx.request.result = {key: 'key'}; tx.request.onsuccess();
  await Promise.resolve(); assert.equal(settled, false);
  tx.onabort(); assert.equal(await read, null);
  const completed = f.storage.read('viewports', 'key');
  tx = f.transaction(); tx.request.result = {key: 'key'}; tx.request.onsuccess(); tx.oncomplete();
  assert.deepEqual(await completed, {key: 'key'});
  const timedOut = f.storage.read('viewports', 'key', 1);
  tx = f.transaction(); assert.equal(await timedOut, null);
  tx.request.result = {key: 'late'}; tx.request.onsuccess(); tx.oncomplete();
  assert.equal(await timedOut, null);
  const controller = new AbortController();
  const aborted = f.storage.read('recent-pages', ['key', 1], 100, controller.signal);
  tx = f.transaction(); controller.abort(); assert.equal(await aborted, null);
  tx.request.result = {key: 'late'}; tx.request.onsuccess(); tx.oncomplete();
  assert.equal(await aborted, null);
  f.storage.close();
});

test('initialization publishes only committed data and retains a newer in-memory save', async () => {
  const f = fixture(); await f.controller.init();
  const key = JSON.stringify({pageSize: 100});
  const old = {version: 1, key, index: 1, offset: 3, anchorId: 'old', loadedPage: 1, savedAt: Date.now()};
  const tx = f.storage.database.transaction('positions', 'readwrite');
  tx.objectStore('positions').put(old);
  await new Promise(resolve => {tx.oncomplete = resolve;});
  const loading = f.controller.init();
  const fresh = {...old, index: 2, anchorId: 'fresh', savedAt: Date.now() + 1};
  f.controller.save(fresh, () => {});
  await loading;
  assert.equal(f.controller.getPosition(key), fresh);
  f.storage.close();
});

test('startup deadline releases at 1500ms while current connection hydrates on commit at 1600ms', async () => {
  let clock = 0, timerId = 0;
  const timers = new Map(), opening = {}, read = {};
  const transaction = {objectStore: () => ({getAll: () => read}), abort() {}};
  const db = {close() {}, transaction: () => transaction};
  const f = fixture({indexedDB: {open: () => opening},
    setTimeout(fn, delay) {timers.set(++timerId, {fn, at: clock + delay}); return timerId;},
    clearTimeout(id) {timers.delete(id);}});
  let released = false;
  const loading = f.controller.init().then(() => {released = true;});
  clock = 1000; opening.result = db; opening.onsuccess();
  const saved = key => ({version: 1, key, index: 1, offset: 0, anchorId: 'disk', loadedPage: 1, savedAt: Date.now()});
  clock = 1100; read.result = [saved('late'), saved('newer')]; read.onsuccess();
  assert.equal(f.controller.getPosition('late'), undefined);
  clock = 1500;
  for (const [id, timer] of timers) if (timer.at <= clock) {timers.delete(id); timer.fn();}
  await loading; assert.equal(released, true);
  // Memory changes while the startup caller proceeds must win over hydration.
  const fresh = {...saved('newer'), index: 2, anchorId: 'memory'};
  f.controller.save(fresh, () => {});
  clock = 1600; transaction.oncomplete(); await Promise.resolve();
  assert.equal(f.controller.getPosition('late').anchorId, 'disk');
  assert.equal(f.controller.getPosition('newer'), fresh);
  f.storage.close();
});

test('malformed viewport rows and recent-page holes fail validation without throwing', () => {
  const {context} = fixture();
  const policy = context.VoiceOfMLPositionPolicy;
  const position = {key: 'key', index: 0, anchorId: 'anchor'};
  for (const records of [null, [null], [{}], [[0, null, 50]], [[0, {id: 'anchor'}, -1]]]) {
    assert.equal(policy.validViewport({key: 'key', total: 1, savedAt: Date.now(), records}, position, record => record.id), false);
  }
  const expected = {generation: 'A', total: 1, query: {pageSize: 100}};
  const page = {key: 'key', page: 1, page_size: 100, generation: 'A', total: 1, savedAt: Date.now(), results: [{File: 'a'}]};
  assert.equal(policy.validRecentPage(page, 'key', 1, expected), true);
  assert.equal(policy.validRecentPage({...page, results: new Array(1)}, 'key', 1, expected), false);
  assert.equal(policy.validRecentPage({...page, generation: 'B'}, 'key', 1, expected), false);
  assert.equal(policy.validRecentPage({...page, savedAt: undefined}, 'key', 1, expected), false);
});

test('scheduled saves coalesce and cancellation leaves no delayed flush', () => {
  const timers = new Map(); let id = 0, calls = 0;
  const f = fixture({setTimeout: fn => {timers.set(++id, fn); return id;}, clearTimeout: id => timers.delete(id)});
  f.controller.scheduleSave(() => calls++); f.controller.scheduleSave(() => calls++);
  assert.equal(timers.size, 1);
  f.controller.cancelSave(); assert.equal(timers.size, 0);
  f.controller.scheduleSave(() => calls++);
  for (const callback of timers.values()) callback();
  assert.equal(calls, 1);
});

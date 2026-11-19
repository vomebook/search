import './restoration_contracts.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';
import {createRequire} from 'node:module';
import {installPrecachePaths, shellScriptPaths} from '../../support/shell_assets.mjs';

test('positions modules are composed once and synchronized across shell, resources and worker', async () => {
  const read = name => readFileSync(new URL('../../../' + name, import.meta.url), 'utf8');
  const html = read('static/index.html'), worker = read('static/sw.js');
  const resources = createRequire(import.meta.url)('../../../static/reader-resources.js');
  const staticBase = '/search/static/';
  const scripts = shellScriptPaths(html, staticBase);
  const bundled = shellScriptPaths(stripBundledScripts(html), staticBase);
  const precache = await installPrecachePaths(worker, resources, staticBase);
  assert.equal(scripts.filter(path => path === 'app.js').length, 1);
  for (const name of ['search/positions/domain/policy.js', 'search/positions/infrastructure/indexed-db.js',
    'search/positions/application/persistence.js', 'search/positions/application/restoration.js']) {
    assert.equal(APP_DEPENDENCIES.filter(path => path === name).length, 1);
    assert.equal(scripts.filter(path => path === name).length, 1, name);
    assert.ok(scripts.indexOf(name) < scripts.indexOf('app.js'), name);
    assert.ok(!bundled.includes(name), name);
    assert.equal(precache.filter(path => path === name).length, 1, name);
    for (const site of ['github', 'hf']) assert.equal(resources.buildFiles(site).filter(path => path === name).length, 1);
  }
});

function fixture(overrides = {}) {
  const context = vm.createContext({indexedDB, IDBKeyRange, setTimeout, clearTimeout,
    TextEncoder, AbortController, ...overrides});
  for (const file of ['execution/application/session.js', 'results/window/domain/page.js',
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
  transaction.request.result = []; transaction.oncomplete();
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
  clock = 1100; read.result = [saved('late'), saved('newer')];
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

test('startup publishes only the committed readonly snapshot and does not wait for cleanup', async () => {
  const opening = {}, timers = new Map(), transactions = [], deleted = [];
  let timerId = 0;
  const f = fixture({indexedDB: {open: () => opening},
    setTimeout(fn, delay) {timers.set(++timerId, {fn, delay}); return timerId;},
    clearTimeout(id) {timers.delete(id);}});
  const disk = (key, savedAt = Date.now()) => ({version: 1, key, index: 3, offset: 0, anchorId: key, loadedPage: 1, savedAt});
  const valid = disk('valid'), refreshed = disk('refreshed'), expired = disk('expired', 0);
  const db = {close() {}, transaction(name, mode) {
    const request = {}, tx = {mode, request, objectStore: () => ({getAll: () => request,
      delete: key => deleted.push(key)})};
    assert.equal(name, 'positions'); transactions.push(tx); return tx;
  }};
  const loading = f.controller.init();
  opening.result = db; opening.onsuccess();
  const read = transactions[0];
  assert.equal(read.mode, 'readonly');
  read.request.result = [valid, expired, {...refreshed, savedAt: 0}, {key: 'malformed'}];
  await Promise.resolve();
  assert.equal(f.controller.getPosition('valid'), undefined);
  read.oncomplete(); await loading;
  assert.equal(f.controller.getPosition('valid').index, 3);
  assert.equal(f.controller.getPosition('expired'), undefined);
  assert.equal(transactions.length, 1, 'startup promise must not need a write transaction');
  assert.deepEqual(deleted, []);
  const cleanup = [...timers.values()].find(timer => timer.delay === 0);
  assert.ok(cleanup);
  cleanup.fn();
  const write = transactions[1]; assert.equal(write.mode, 'readwrite');
  write.request.result = [valid, expired, refreshed, {key: 'malformed'}]; write.request.onsuccess();
  assert.deepEqual(deleted.sort(), ['expired', 'malformed']);
  f.storage.close(); cleanup.fn();
  assert.equal(transactions.length, 2, 'closed connection must not start queued cleanup');
});

test('malformed viewport rows and recent-page holes fail validation without throwing', () => {
  const {context} = fixture();
  const policy = context.VoiceOfMLPositionPolicy;
  const position = {key: 'key', index: 0, anchorId: 'anchor'};
  for (const records of [null, [null], [{}], [[0, null, 50]], [[0, {id: 'anchor'}, -1]]]) {
    assert.equal(policy.validViewport({key: 'key', total: 1, savedAt: Date.now(), records}, position, record => record.id), false);
  }
  const expected = {generation: 'A', total: 1, query: {pageSize: 100}};
  const page = {id: ['key', 1], key: 'key', page: 1, page_size: 100, generation: 'A', total: 1, savedAt: Date.now(), results: [{File: 'a'}]};
  assert.equal(policy.validRecentPage(page, 'key', 1, expected), true);
  assert.equal(policy.validRecentPage({...page, results: new Array(1)}, 'key', 1, expected), false);
  assert.equal(policy.validRecentPage({...page, generation: 'B'}, 'key', 1, expected), false);
  assert.equal(policy.validRecentPage({...page, savedAt: undefined}, 'key', 1, expected), false);
  for (const id of [undefined, ['other', 1], ['key', 2], ['key', 1, 2]]) {
    assert.equal(policy.validRecentPage({...page, id}, 'key', 1, expected), false);
  }
  for (const record of [null, [], {File: 1}, {File: 'a', Folder: ['ok', null]}, {File: 'a', Size: -1}]) {
    assert.equal(policy.validRecentPage({...page, results: [record]}, 'key', 1, expected), false);
  }
  const anchor = [0, {File: 'anchor'}, 50];
  const viewport = {key: 'key', total: 2, savedAt: Date.now(), records: [anchor]};
  assert.equal(policy.validViewport(viewport, position, record => record.File), true);
  for (const tuple of [null, anchor, [2, {File: 'outside'}, 50], [1, {File: 'bad', Repo: {}}, 50], [1, {File: 'huge'}, 1000001]]) {
    assert.equal(policy.validViewport({...viewport, records: [anchor, tuple]}, position, record => record.File), false);
  }
  assert.equal(policy.validViewport({...viewport, estimatedHeight: Infinity}, position, record => record.File), false);
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


test('upgrade preserves compatible saved data and rejects malformed and incompatible entries', async () => {
  await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase('voice-search-positions'); r.onsuccess = resolve; r.onerror = reject; });
  const key = JSON.stringify({pageSize: 2});
  const position = {version: 1, key, index: 0, offset: 0, anchorId: 'book', loadedPage: 1, savedAt: Date.now()};
  const viewport = {key, savedAt: Date.now(), total: 1, records: [[0, {File: 'book'}, 20]]};
  const page = {id: [key, 1], key, page: 1, page_size: 2, total: 1, generation: 'gen', results: [{File: 'book'}], savedAt: Date.now()};
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('voice-search-positions', 3);
    r.onupgradeneeded = () => {
      const positions = r.result.createObjectStore('positions', {keyPath: 'key'});
      positions.put(position); positions.put({...position, key: 'bad', version: 99});
      const views = r.result.createObjectStore('viewports', {keyPath: 'key'}); views.put(viewport);
      const pages = r.result.createObjectStore('recent-pages', {keyPath: 'id'}); pages.put(page);
    };
    r.onsuccess = () => resolve(r.result); r.onerror = reject;
  });
  db.close();
  const f = fixture(); await f.controller.init();
  assert.equal(f.controller.getPosition(key).anchorId, 'book');
  assert.equal(f.controller.getPosition('bad'), undefined);
  const savedViewport = await f.storage.read('viewports', key);
  const savedPage = await f.storage.read('recent-pages', [key, 1]);
  assert.equal(savedViewport.records[0][1].File, 'book');
  assert.equal(savedPage.results[0].File, 'book');
  assert.equal(f.context.VoiceOfMLPositionPolicy.validViewport(savedViewport, position, r => r.File), true);
  assert.equal(f.context.VoiceOfMLPositionPolicy.validViewport({...savedViewport, records: [[0, {}, 20]]}, position, r => r.File), false);
  const expected = {generation: 'gen', total: 1, query: {pageSize: 2}};
  assert.equal(f.context.VoiceOfMLPositionPolicy.validRecentPage(savedPage, key, 1, expected), true);
  assert.equal((await f.controller.readRecentPage(key, 1, expected)).generation, 'gen');
  assert.equal(await f.controller.readRecentPage(key, 1, {...expected, generation: 'wrong'}), null);
  assert.equal(f.context.VoiceOfMLPositionPolicy.validRecentPage({...savedPage, results: [{}]}, key, 1, expected), false);
  f.storage.close();
  await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase('voice-search-positions'); r.onsuccess = resolve; r.onerror = reject; });
  const incompatible = await new Promise((resolve, reject) => {
    const r = indexedDB.open('voice-search-positions', 3);
    r.onupgradeneeded = () => { r.result.createObjectStore('positions', {keyPath: 'wrong'}).put({wrong: 'x'}); };
    r.onsuccess = () => resolve(r.result); r.onerror = reject;
  });
  incompatible.close();
  const g = fixture(); await g.controller.init();
  assert.equal(g.storage.database.transaction('positions').objectStore('positions').keyPath, 'key');
  assert.equal(g.controller.positions.size, 0);
  g.storage.close();
});

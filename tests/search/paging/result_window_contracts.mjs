import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {installClassicSearchModules} from '../../support/classic_search_modules.js';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';
import {installSourcePrecachePaths} from '../../support/shell_assets.mjs';

const source = fs.readFileSync('static/app.js', 'utf8');
function fixture(names, values = {}) {
  const c = vm.createContext({AbortController, DOMException, ...values});
  installClassicSearchModules(process.cwd(), c);
  for (const name of names) {
    const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], c);
  }
  return c;
}

function target() {
  const listeners = new Map();
  return {listeners, addEventListener(name, fn) {listeners.set(name, fn);},
    removeEventListener(name, fn) {if (listeners.get(name) === fn) listeners.delete(name);},
    emit(name) {listeners.get(name)?.();}};
}

test('recovery wait requires elapsed delay, visibility and connectivity, and cleans every listener', async () => {
  for (const mode of ['online', 'local', 'abort', 'already-aborted']) {
    const document = Object.assign(target(), {hidden: true}), window = target(), signal = target();
    const timers = new Map();
    signal.aborted = mode === 'already-aborted';
    const c = fixture(['waitForSearchRecovery'], {document, window, navigator: {onLine: false},
      setTimeout(fn, delay) {timers.set(1, {fn, delay});return 1;}, clearTimeout(id) {timers.delete(id);}});
    let settled = false;
    const pending = c.waitForSearchRecovery(signal, 750, mode === 'local').then(() => {settled = true;}, error => error.name);
    if (mode === 'already-aborted') assert.equal(await pending, 'AbortError');
    else {
      assert.equal(timers.get(1).delay, 750);
      window.emit('online'); await Promise.resolve(); assert.equal(settled, false);
      timers.get(1).fn(); await Promise.resolve(); assert.equal(settled, false);
      document.hidden = false;
      document.emit('visibilitychange'); await Promise.resolve();
      assert.equal(settled, mode === 'local');
      if (mode === 'abort') {signal.aborted = true; signal.emit('abort'); assert.equal(await pending, 'AbortError');}
      else {c.navigator.onLine = true; window.emit('pageshow'); await pending; assert.equal(settled, true);}
    }
    assert.equal(timers.size, 0); assert.equal(signal.listeners.size, 0);
    assert.equal(document.listeners.size, 0); assert.equal(window.listeners.size, 0);
  }
});

test('recovery waits use the pinned backend, not preferences, mixed filters or current API health', async () => {
  for (const scenario of ['remote', 'local', 'self', 'subtree', 'unavailable', 'prefetch', 'fatal', 'aborted']) {
    const owner = new AbortController(), error = new Error('temporary'), waits = [], calls = [];
    const query = {resultBackend: scenario === 'local' ? 'local' : 'api', useLocalMode: scenario === 'remote',
      folders: {self: scenario === 'self' ? ['a'] : [], subtree: scenario === 'subtree' ? ['a'] : []}};
    const c = fixture(['fetchPositionPageWithRecovery'], {apiAvailable: scenario !== 'unavailable',
      fetchPositionPage(...args) {calls.push(args); throw error;},
      isRecoverableSearchError: () => scenario !== 'fatal',
      waitForSearchRecovery(signal, delay, local) {assert.equal(signal, owner.signal);waits.push([delay, !!local]);}});
    if (scenario === 'aborted') owner.abort();
    await assert.rejects(c.fetchPositionPageWithRecovery(query, 7, owner.signal, 'anchor', () => scenario !== 'prefetch'),
      scenario === 'aborted' ? {name: 'AbortError'} : value => value === error);
    const retry = !['prefetch', 'fatal', 'aborted'].includes(scenario);
    assert.equal(calls.length, scenario === 'aborted' ? 0 : retry ? 3 : 1);
    for (const args of calls) assert.deepEqual(args, [query, 7, owner.signal, 'anchor']);
    const local = scenario === 'local';
    assert.deepEqual(waits, retry ? [[750, local], [1500, local]] : []);
  }
});

test('promotion during an in-flight fetch enables recovery and abort during wait prevents another fetch', async () => {
  const owner = new AbortController(); let demanded = false, rejectFetch, calls = 0;
  const c = fixture(['fetchPositionPageWithRecovery'], {apiAvailable: true,
    fetchPositionPage() {calls++;return new Promise((resolve, reject) => {rejectFetch = reject;});},
    isRecoverableSearchError: () => true,
    waitForSearchRecovery() {owner.abort();}});
  const pending = c.fetchPositionPageWithRecovery({folders: {self: [], subtree: []}}, 2, owner.signal, undefined, () => demanded);
  demanded = true; rejectFetch(new Error('temporary'));
  await assert.rejects(pending, {name: 'AbortError'}); assert.equal(calls, 1);
});

test('foreground demand joins a preview read without promoting it to transport', async () => {
  let resolve;
  const disk = new Promise(done => { resolve = done; });
  const owner = new AbortController();
  const window = {key: 'query', query: {pageSize: 100}, pending: new Map([[2, disk]]), failures: new Map(), controller: owner};
  const c = fixture([]), deps = {
    readRecent: async () => null, isCurrent: () => true,
    fetchPage() { throw new Error('must reuse preview'); },
    validate() {}, scheduleRender() {},
  };
  const requestPage = (window, page, prefetch) => c.VoiceOfMLResultWindowLoader.requestPage(deps, window, page, prefetch);
  const returned = requestPage(window, 2, false);
  assert.strictEqual(returned, disk);
  assert.equal(Object.hasOwn(disk, 'demanded'), false);
  assert.equal(owner.signal.aborted, false);
  const payload = {results: [], page: 2};
  resolve(payload);
  assert.strictEqual(await returned, payload);
  assert.strictEqual(window.pending.get(2), disk);
});

test('request gates, validation failures and stale completion preserve pending cleanup', async () => {
  const owner = new AbortController(), data = {results: [], page: 2};
  let current = true, reads = 0, renders = 0, rejectValidation = false;
  const window = {key: 'query', query: {pageSize: 100}, pending: new Map(), failures: new Map(), controller: owner};
  const c = fixture([]), deps = {
    readRecent: async () => {reads++;return data;}, isCurrent: () => current,
    fetchPage() {assert.fail('cache hit must avoid transport');},
    validate() {if (rejectValidation) throw new Error('RESTORE_PAGE_CHANGED');},
    scheduleRender() {renders++;}};
  const requestPage = (window, page, prefetch) => c.VoiceOfMLResultWindowLoader.requestPage(deps, window, page, prefetch);
  window.prefetched = new Map([[2, data]]);
  assert.equal(await requestPage(window, 2), data); assert.equal(reads, 0);
  window.prefetched.clear(); window.prefetchFailures = new Set([2]);
  assert.equal(await requestPage(window, 2, true), null); assert.equal(reads, 0);
  assert.equal(await requestPage(window, 2), data); assert.equal(reads, 1);
  for (const blocked of ['failure', 'invalid']) {
    window.failures.clear(); window.invalid = blocked === 'invalid';
    if (blocked === 'failure') window.failures.set(2, new Error());
    assert.equal(await requestPage(window, 2), null); assert.equal(reads, 1);
  }
  window.invalid = false; window.failures.clear(); rejectValidation = true;
  await assert.rejects(requestPage(window, 2), /RESTORE_PAGE_CHANGED/);
  assert.equal(window.pending.size, 0); assert.equal(renders, 2);
  current = false;
  assert.equal(await requestPage(window, 2), null);
  assert.equal(window.pending.size, 0); assert.equal(renders, 2);
});

const flushWindow = () => new Promise(resolve => setImmediate(resolve));

function managedFixture({readRecent = async () => null, fetchPage = async () => null, ...ports} = {}) {
  const c = fixture([], ports), accepted = [], failed = [];
  let key = 'query', results = new Array(1000), restoring = false, dragging = false;
  const windows = c.VoiceOfMLResultWindowLoader.create({
    currentKey: () => key, results: () => results, isRestoring: () => restoring,
    isPreview: () => restoring, isDragging: () => dragging,
    readRecent, fetchPage, validate: () => {}, scheduleRender: () => {}, isRecoverable: () => true,
    accepted: event => accepted.push(event), failed: (key, changed) => failed.push({key, changed}), ...ports,
  });
  const open = (generation = 'A', pageSize = 1) => windows.open({generation, pages: [], count: 0, preview: restoring}, key, 1000, {pageSize});
  return {c, windows, accepted, failed, open, get results() {return results;}, set results(value) {results = value;},
    restore(value) {restoring = value;}, drag(value) {dragging = value;}, route(value) {key = value;}};
}

test('same-key replacement rejects late network responses and does not mutate the new rows', async () => {
  let release, signal;
  const f = managedFixture({fetchPage(query, page, abort) {
    signal = abort; return new Promise(resolve => {release = resolve;});
  }});
  assert.equal(f.open(), true);
  const old = f.windows.current, pending = f.windows.load(2);
  await flushWindow(); assert.equal(old.pending.size, 1);
  f.results = new Array(1000);
  assert.equal(f.open('B'), true);
  assert.equal(signal.aborted, true);
  release({results: [{File: 'old'}]});
  assert.equal(await pending, false);
  assert.equal(old.pending.size, 0);
  assert.equal(f.windows.current.generation, 'B');
  assert.equal(f.windows.current.count, 0);
  assert.equal(f.results[1], undefined);
  assert.deepEqual(f.accepted, []); assert.deepEqual(f.failed, []);
});

test('opening publishes the new owner before abort and does not overwrite a reentrant replacement', () => {
  const f = managedFixture();
  assert.equal(f.open('A'), true);
  let observed;
  f.windows.current.controller.signal.addEventListener('abort', () => {
    observed = f.windows.current.generation;
    f.results = new Array(1000);
    f.open('C');
  });
  assert.equal(f.open('B'), false);
  assert.equal(observed, 'B');
  assert.equal(f.windows.current.generation, 'C');
  assert.equal(f.windows.current.results, f.results);
  assert.equal(f.windows.current.controller.signal.aborted, false);
});

test('a late result is ignored if the route or displayed row array changes before window detachment', async () => {
  for (const replace of [f => {f.results = [];}, f => f.route('next')]) {
    let release;
    const f = managedFixture({fetchPage() {return new Promise(resolve => {release = resolve;});}});
    f.open();
    const pending = f.windows.load(2);
    await flushWindow(); replace(f);
    release({results: [{}]});
    assert.equal(await pending, false);
    assert.equal(f.windows.current.count, 0);
    assert.deepEqual(f.accepted, []);
  }
});

test('preview disk requests deduplicate, fill holes only and cannot publish after replacement', async () => {
  const waits = [];
  const f = managedFixture({readRecent(key, page, owner, delay, signal) {
    return new Promise(resolve => waits.push({page, delay, signal, resolve}));
  }, fetchPage() {assert.fail('preview must not use transport');}});
  f.restore(true); f.open('A', 2);
  const row = {File: 'already visible'};
  f.results[2] = row; f.windows.current.count = 1;
  f.results.length = 6;
  const range = (start, end) => f.windows.demandRange(start, end, start, end, 1);
  range(2, 4); range(2, 4);
  assert.deepEqual(waits.map(w => w.page), [2]); assert.equal(waits[0].delay, 150);
  let request = f.windows.current.pending.get(2);
  const preview = {results: [{File: 'stale'}, {File: 'hole'}]};
  waits[0].resolve(preview); await request; await flushWindow();
  assert.equal(f.results[2], row); assert.equal(f.results[3].File, 'hole');
  assert.equal(f.windows.current.count, 2); assert.equal(f.accepted.length, 1);
  assert.deepEqual([...f.accepted[0].indices], [3]); assert.equal(f.accepted[0].preview, preview);
  range(2, 4); range(6, 8); assert.deepEqual(waits.map(w => w.page), [2, 4]);
  waits[1].resolve({results: [{File: 'outside preview'}]}); await flushWindow();
  assert.equal(f.results.length, 6); assert.equal(f.windows.current.pages.has(4), false);
  assert.equal(f.windows.current.count, 2); assert.equal(f.accepted.length, 1);
  range(4, 6); assert.deepEqual(waits.map(w => w.page), [2, 4, 3]);
  request = f.windows.current.pending.get(3);
  f.restore(false); f.results = new Array(1000); f.open('B', 2);
  assert.equal(waits[2].signal.aborted, true);
  waits[2].resolve({results: [{File: 'late'}]}); await request; await flushWindow();
  assert.equal(f.results[4], undefined); assert.equal(f.accepted.length, 1);
});

test('joined foreground demand publishes a prefetched page only once', async () => {
  let calls = 0;
  const f = managedFixture({fetchPage: async () => {calls++; return {results: [{File: 'r2'}]};}});
  f.open();
  await f.windows.load(2, true);
  assert.equal(f.results[1], undefined);
  f.results[1] = {File: 'unverified'};
  await Promise.all([f.windows.load(2), f.windows.load(2)]);
  await f.windows.load(2, true);
  assert.equal(f.results[1].File, 'r2'); assert.equal(f.accepted.length, 1);
  assert.deepEqual([...f.accepted[0].indices], [1]); assert.equal(Object.hasOwn(f.accepted[0], 'preview'), false);
  assert.equal(f.windows.current.count, 1); assert.equal(calls, 1);
});

test('prefetch failure tracking stays bounded and generation changes invalidate even prefetch', async () => {
  let error = new Error('temporary'), renders = 0, statuses = 0;
  const cache = new Map([['old-page', {}]]), stale = new Map([['query', {}]]);
  const state = {_pageCache: {1:[{}]}};
  const f = managedFixture({fetchPage: async () => {throw error;}, STATE: state,
    searchResponseStore: {cache}, resultSnapshots: {remove: key => stale.delete(key)},
    updateResultWindowStatus() {statuses++;}, scheduleVirtualRender() {renders++;},
    DOM: {resultsList: {querySelectorAll: () => []}}, VSCROLL: {},
    failed: (...args) => f.c.presentResultWindowFailure(...args)});
  for (const name of ['refreshResultWindowPlaceholders', 'presentResultWindowFailure']) {
    vm.runInContext(source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'))[0], f.c);
  }
  f.open();
  const window = f.windows.current;
  for (let page = 1; page <= 65; page++) assert.equal(await f.windows.load(page, true), false);
  assert.equal(window.prefetchFailures.size, 64); assert.equal(window.prefetchFailures.has(1), false);
  assert.equal(window.failures.size, 0); assert.equal(statuses, 0); assert.equal(renders, 0);
  error = new Error('RESTORE_PAGE_CHANGED');
  assert.equal(await f.windows.load(66, true), false);
  assert.equal(window.invalid, true); assert.equal(window.failures.get(66), error);
  assert.equal(cache.size, 0); assert.equal(stale.size, 0);
  assert.equal(Object.keys(state._pageCache).length, 0);
  assert.equal(statuses, 1); assert.equal(renders, 1);
});

function documentFixture() {
  const elements = [];
  function element(tag) {
    const node = {tag, dataset: {}, style: {}, children: [], attributes: {},
      appendChild(child) {this.children.push(child);}, setAttribute(key, value) {this.attributes[key] = value;},
      querySelector(tag) {return this.children.find(child => child.tag === tag);}};
    Object.defineProperty(node, 'innerHTML', {set(value) {
      this.markup = value;
      if (value.includes('<span>')) this.children = [element('span'), element('button')];
    }});
    elements.push(node); return node;
  }
  return {createElement: element, getElementById: id => elements.find(node => node.id === id)};
}

test('status action reads the current window and placeholders retain loading, retry and invalid markup', async () => {
  const document = documentFixture(), host = document.createElement('div'), loaded = [];
  let restarted = 0;
  const c = fixture(['updateResultWindowStatus', 'createResultWindowPlaceholder'], {document,
    DOM: {resultsContainer: {parentElement: host}},
    resultWindows: {current: null, retry: update => {
      const window = c.resultWindows.current;
      if (window) return c.VoiceOfMLResultWindowLoader.retryFailed(window, () => true, async page => {loaded.push(page); return true;}, update);
    }},
    STATE: {pageSize: 100}, VSCROLL: {contentVersion: 9, heights: [72], estimatedHeight: 60},
    restartResultWindow() {restarted++;}});
  c.updateResultWindowStatus(); assert.equal(host.children.length, 0);
  const loading = c.createResultWindowPlaceholder(0);
  assert.equal(loading.style.height, '72px'); assert.equal(loading.dataset.contentVersion, '9');
  assert.equal(loading.attributes['aria-label'], '正在加载结果'); assert.ok(loading.markup.includes('aria-hidden="true"'));
  c.resultWindows.current = {failures: new Map([[2, new Error()]])}; c.updateResultWindowStatus();
  const status = host.children[0], button = status.querySelector('button');
  assert.equal(status.attributes.role, 'status'); assert.equal(button.textContent, '重试加载');
  const failed = c.createResultWindowPlaceholder(100);
  assert.equal(failed.style.height, '60px'); assert.equal(failed.dataset.index, '100');
  assert.equal(failed.children[0].dataset.windowPage, '2'); assert.equal(failed.children[0].textContent, '加载失败，点击重试');
  c.resultWindows.current = {failures: new Map([[3, new Error()]]), pending: new Map()}; button.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(loaded, [3]); assert.equal(status.hidden, true);
  c.resultWindows.current.invalid = true; c.updateResultWindowStatus(); button.onclick();
  assert.equal(restarted, 1); assert.equal(status.querySelector('span').textContent, '搜索数据已更新');
  assert.equal(button.textContent, '重新定位');
  assert.equal(c.createResultWindowPlaceholder(100).children[0].textContent, '数据已更新，点击重新定位');
  c.resultWindows.current = null; button.onclick(); c.updateResultWindowStatus(); assert.equal(status.hidden, true);
  assert.equal(host.children.length, 1);
});

test('window modules load once in source, composition, resources, SW and all three type projects', async () => {
  const precache = await installSourcePrecachePaths('/search/static/');
  const html = fs.readFileSync('static/index.html', 'utf8');
  const c = vm.createContext({}); vm.runInContext(fs.readFileSync('static/reader-resources.js', 'utf8'), c);
  for (const name of ['search/results/window/application/page-loader.js', 'search/results/window/presentation/status.js']) {
    assert.equal(APP_DEPENDENCIES.filter(path => path === name).length, 1);
    assert.equal(html.split(name).length - 1, 1); assert.ok(html.indexOf(name) < html.indexOf('static/app.js'));
    assert.equal(stripBundledScripts(html).includes(name), false);
    assert.equal(precache.filter(file => file === name).length, 1, name);
    for (const site of ['github', 'huggingface']) assert.equal(c.VoiceOfMLReaderResources.buildFiles(site).filter(path => path === name).length, 1);
    for (const config of ['check', 'strict', 'search-exact'])
      assert.equal(JSON.parse(fs.readFileSync(`config/types/jsconfig.${config}.json`, 'utf8')).files.filter(path => path === '../../static/' + name).length, 1);
  }
});

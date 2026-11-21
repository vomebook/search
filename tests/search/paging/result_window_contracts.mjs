import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {installClassicSearchModules} from '../../support/classic_search_modules.js';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';

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

test('a plain preview disk promise is reused and marked demanded', async () => {
  let resolve;
  const disk = new Promise(done => { resolve = done; });
  const owner = new AbortController();
  const window = {key: 'query', query: {pageSize: 100}, pending: new Map([[2, disk]]), failures: new Map(), controller: owner};
  const c = fixture(['requestResultWindowPage'], {
    readRecentSearchPage: async () => null, resultWindowCurrent: () => true,
    fetchPositionPageWithRecovery() { throw new Error('must reuse preview'); },
    validatePositionWindowPage() {}, scheduleVirtualRender() {},
  });
  const returned = c.requestResultWindowPage(window, 2, false);
  assert.strictEqual(returned, disk);
  assert.equal(disk.demanded, true);
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
  const c = fixture(['requestResultWindowPage'], {
    readRecentSearchPage: async () => {reads++;return data;}, resultWindowCurrent: () => current,
    fetchPositionPageWithRecovery() {assert.fail('cache hit must avoid transport');},
    validatePositionWindowPage() {if (rejectValidation) throw new Error('RESTORE_PAGE_CHANGED');},
    scheduleVirtualRender() {renders++;}});
  window.prefetched = new Map([[2, data]]);
  assert.equal(await c.requestResultWindowPage(window, 2), data); assert.equal(reads, 0);
  window.prefetched.clear(); window.prefetchFailures = new Set([2]);
  assert.equal(await c.requestResultWindowPage(window, 2, true), null); assert.equal(reads, 0);
  assert.equal(await c.requestResultWindowPage(window, 2), data); assert.equal(reads, 1);
  for (const blocked of ['failure', 'invalid']) {
    window.failures.clear(); window.invalid = blocked === 'invalid';
    if (blocked === 'failure') window.failures.set(2, new Error());
    assert.equal(await c.requestResultWindowPage(window, 2), null); assert.equal(reads, 1);
  }
  window.invalid = false; window.failures.clear(); rejectValidation = true;
  await assert.rejects(c.requestResultWindowPage(window, 2), /RESTORE_PAGE_CHANGED/);
  assert.equal(window.pending.size, 0); assert.equal(renders, 2);
  current = false;
  assert.equal(await c.requestResultWindowPage(window, 2), null);
  assert.equal(window.pending.size, 0); assert.equal(renders, 2);
});

test('host keeps prefetch failures bounded and generation changes invalidate even prefetch', async () => {
  const window = {key: 'query', total: 1000, query: {pageSize: 1}, controller: new AbortController(), pages: new Set(), failures: new Map()};
  let error = new Error('temporary'), renders = 0, statuses = 0;
  const cache = new Map([['old-page', {}]]), stale = new Map([['query', {}]]);
  const c = fixture(['loadResultWindowPage'], {resultWindow: window, positionRestore: null,
    searchResponseStore: {cache}, resultSnapshots: {remove: key => stale.delete(key)}, STATE: {_pageCache: {1:[{}]} },
    resultWindowCurrent: () => true, requestResultWindowPage: async () => {throw error;},
    updateResultWindowStatus() {statuses++;}, scheduleVirtualRender() {renders++;},
    DOM: {resultsList: {querySelectorAll: () => []}}, VSCROLL: {}});
  for (let page = 1; page <= 65; page++) assert.equal(await c.loadResultWindowPage(page, true), false);
  assert.equal(window.prefetchFailures.size, 64); assert.equal(window.prefetchFailures.has(1), false);
  assert.equal(window.failures.size, 0); assert.equal(statuses, 0); assert.equal(renders, 0);
  error = new Error('RESTORE_PAGE_CHANGED');
  assert.equal(await c.loadResultWindowPage(66, true), false);
  assert.equal(window.invalid, true); assert.equal(window.failures.get(66), error);
  assert.equal(cache.size, 0); assert.equal(stale.size, 0);
  assert.equal(Object.keys(c.STATE._pageCache).length, 0);
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
    DOM: {resultsContainer: {parentElement: host}}, resultWindow: null,
    STATE: {pageSize: 100}, VSCROLL: {contentVersion: 9, heights: [72], estimatedHeight: 60},
    restartResultWindow() {restarted++;}, resultWindowCurrent: () => true,
    async loadResultWindowPage(page) {loaded.push(page); return true;}});
  c.updateResultWindowStatus(); assert.equal(host.children.length, 0);
  const loading = c.createResultWindowPlaceholder(0);
  assert.equal(loading.style.height, '72px'); assert.equal(loading.dataset.contentVersion, '9');
  assert.equal(loading.attributes['aria-label'], '正在加载结果'); assert.ok(loading.markup.includes('aria-hidden="true"'));
  c.resultWindow = {failures: new Map([[2, new Error()]])}; c.updateResultWindowStatus();
  const status = host.children[0], button = status.querySelector('button');
  assert.equal(status.attributes.role, 'status'); assert.equal(button.textContent, '重试加载');
  const failed = c.createResultWindowPlaceholder(100);
  assert.equal(failed.style.height, '60px'); assert.equal(failed.dataset.index, '100');
  assert.equal(failed.children[0].dataset.windowPage, '2'); assert.equal(failed.children[0].textContent, '加载失败，点击重试');
  c.resultWindow = {failures: new Map([[3, new Error()]]), pending: new Map()}; button.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(loaded, [3]); assert.equal(status.hidden, true);
  c.resultWindow.invalid = true; c.updateResultWindowStatus(); button.onclick();
  assert.equal(restarted, 1); assert.equal(status.querySelector('span').textContent, '搜索数据已更新');
  assert.equal(button.textContent, '重新定位');
  assert.equal(c.createResultWindowPlaceholder(100).children[0].textContent, '数据已更新，点击重新定位');
  c.resultWindow = null; button.onclick(); c.updateResultWindowStatus(); assert.equal(status.hidden, true);
  assert.equal(host.children.length, 1);
});

test('window modules load once in source, composition, resources, SW and all three type projects', () => {
  const html = fs.readFileSync('static/index.html', 'utf8'), worker = fs.readFileSync('static/sw.js', 'utf8');
  const c = vm.createContext({}); vm.runInContext(fs.readFileSync('static/reader-resources.js', 'utf8'), c);
  for (const name of ['search/results/window/application/page-loader.js', 'search/results/window/presentation/status.js']) {
    assert.equal(APP_DEPENDENCIES.filter(path => path === name).length, 1);
    assert.equal(html.split(name).length - 1, 1); assert.ok(html.indexOf(name) < html.indexOf('static/app.js'));
    assert.equal(stripBundledScripts(html).includes(name), false);
    assert.equal(worker.split('/static/' + name).length - 1, 1);
    for (const site of ['github', 'huggingface']) assert.equal(c.VoiceOfMLReaderResources.buildFiles(site).filter(path => path === name).length, 1);
    for (const config of ['check', 'strict', 'search-exact'])
      assert.equal(JSON.parse(fs.readFileSync(`config/types/jsconfig.${config}.json`, 'utf8')).files.filter(path => path === '../../static/' + name).length, 1);
  }
});

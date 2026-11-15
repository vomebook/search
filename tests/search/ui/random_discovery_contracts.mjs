import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {createRequire} from 'node:module';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';
const space = fs.existsSync('pyrightconfig.json');
const name = 'search/discovery/application/random.js';
const app = fs.readFileSync('static/app.js', 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const record = {File: 'book', Extension: 'txt', Link: 'https://example.test/book.txt'};
function fixture() {
  const opened = [], downloads = [], messages = [], requests = [], timers = new Set(), loads = [], localCalls = [];
  const c = vm.createContext({
    randomDiscovery: null, randomReaderRequestId: 0,
    STATE: {repo: 'A & B', repoFull: 'VoiceOfML/A & B', mode: 'repo', dataLoaded: false},
    DOM: {randomTxtBtn: {style: {display: ''}, disabled: true}},
    API_BASE: 'https://api.test', WORKER_REQUEST_TIMEOUT: 1234,
    readerMetadata: {count: 3, byRepo: {'VoiceOfML/A & B': 3}}, readerAssets: {},
    location: {href: 'https://site.test/?q=book'}, navigator: {onLine: true},
    AbortController, SyntaxError, console: {error() {}}, Math: Object.create(Math),
    setTimeout(fn, delay) { const timer = {fn, delay}; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    fetch: async (url, options) => { requests.push({url, options}); return {ok: true, json: async () => record}; },
    fetchJsonWithTimeout: async () => ({available: true}),
    loadReaderAssets: async () => { loads.push('assets'); },
    getConvertedReaderRecords: async () => [],
    corpusWorkerRequest: async (...args) => { localCalls.push(args); return {record}; },
    ensureLocalDataLoaded: async (...args) => { loads.push(args); c.STATE.dataLoaded = true; return true; },
    getRecordLink: rec => rec.Link,
    getReaderLink: (rec, returnUrl) => rec.Link ? 'reader:' + returnUrl : '',
    navigateToReader: (...args) => { opened.push(args); return true; },
    downloadFile: async (...args) => { downloads.push(args); return true; },
    showToast: message => messages.push(message),
    API: {getRandom: async repo => { requests.push({repo}); return record; }},
  });
  vm.runInContext(fs.readFileSync('static/' + name, 'utf8'), c);
  for (const fn of ['getRandomDiscovery', 'randomBook', 'randomTxt', 'fetchRandomReaderRecord', 'openReaderRecord', 'updateRandomTxtVisibility', ...(space ? [] : ['getRandomLocal'])]) {
    const match = app.match(new RegExp('^(?:async )?function ' + fn + '\\([^]*?^}', 'm'));
    assert.ok(match, fn); vm.runInContext(match[0], c);
  }
  return {c, opened, downloads, messages, requests, timers, loads, localCalls};
}

test('discovery is registered once in source, composed bundle, resources, offline and strict projects', () => {
  const html = fs.readFileSync('static/index.html', 'utf8');
  const resources = createRequire(import.meta.url)('../../../static/reader-resources.js');
  assert.equal(APP_DEPENDENCIES.filter(item => item === name).length, 1);
  assert.equal(html.split(name).length - 1, 1);
  assert.ok(html.indexOf(name) < html.lastIndexOf('app.js'));
  assert.ok(!stripBundledScripts(html).includes(name));
  for (const project of ['github', 'hf']) assert.equal(resources.buildFiles(project).filter(item => item === name).length, 1);
  assert.equal(fs.readFileSync('static/sw.js', 'utf8').split('/static/' + name).length - 1, 1);
  for (const project of ['check', 'strict', 'search-exact']) {
    const files = JSON.parse(fs.readFileSync(`config/types/jsconfig.${project}.json`, 'utf8')).files;
    assert.ok(files.includes('../../static/' + name));
    assert.ok(files.includes('../../typings/search-discovery.d.ts'));
  }
  assert.doesNotMatch(fs.readFileSync('static/' + name, 'utf8'), /\bSTATE\b|\bDOM\b|warmReader|refreshResultReaderActions|\.disabled\s*=/);
});

test('random API selection preserves site routing, filename, download options and captured return URL', async () => {
  const f = fixture();
  await f.c.randomBook(); await turn();
  assert.equal(f.downloads.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.downloads[0])), ['book.txt', record.Link, {skipCheck: true}]);
  if (space) assert.equal(f.requests[0].repo, 'A & B');
  else assert.equal(f.requests[0].url, 'https://api.test/api/random?repo=A%20%26%20B');
  await f.c.randomTxt();
  assert.deepEqual(f.opened, [['reader:https://site.test/?q=book', 'https://site.test/?q=book']]);
  assert.ok(f.requests.at(-1).url.endsWith('/api/random-reader?repo=A%20%26%20B'));
  assert.equal(f.requests.at(-1).options.cache, 'no-store');
  assert.equal(f.timers.size, 0);
  assert.equal(f.c.DOM.randomTxtBtn.disabled, true);
});

test('superseded reader success and failure, and navigation away, cannot open or report stale errors', async () => {
  for (const reject of [false, true]) {
    const f = fixture(), old = deferred(); let calls = 0;
    f.c.fetch = async () => ++calls === 1 ? old.promise : {ok: true, json: async () => record};
    const first = f.c.randomTxt(); await f.c.randomTxt();
    if (reject) old.reject(new TypeError('obsolete')); else old.resolve({ok: true, json: async () => record});
    await first; await turn();
    assert.equal(f.opened.length, 1); assert.equal(calls, 2);
    assert.deepEqual(f.messages, ['正在随机打开书籍...', '正在随机打开书籍...']);
  }
  const f = fixture(), pending = deferred();
  f.c.fetch = () => pending.promise;
  const first = f.c.randomTxt(); f.c.location.href = 'https://site.test/other';
  pending.resolve({ok: true, json: async () => record}); await first;
  assert.equal(f.opened.length, 0);
  assert.equal(f.c.openReaderRecord(record, 'https://site.test/?q=book'), false);
});

test('status generation and button identity reject old success/failure without touching disabled state', async () => {
  for (const reject of [false, true]) {
    const f = fixture(), old = deferred(); let calls = 0;
    f.c.fetchJsonWithTimeout = (url, timeout) => {
      assert.ok(url.endsWith('/api/random-reader/status?repo=A%20%26%20B')); assert.equal(timeout, 4000);
      return ++calls === 1 ? old.promise : Promise.resolve({available: false});
    };
    const first = f.c.updateRandomTxtVisibility(); await f.c.updateRandomTxtVisibility();
    if (reject) old.reject(new Error('old')); else old.resolve({available: true});
    await first; assert.equal(f.c.DOM.randomTxtBtn.style.display, 'none');
    assert.equal(f.c.DOM.randomTxtBtn.disabled, true);
  }
  const f = fixture(), pending = deferred(), oldButton = f.c.DOM.randomTxtBtn;
  f.c.fetchJsonWithTimeout = () => pending.promise;
  const first = f.c.updateRandomTxtVisibility();
  f.c.DOM.randomTxtBtn = {style: {display: 'replacement'}, disabled: true};
  pending.resolve({available: true}); await first;
  assert.equal(oldButton.style.display, 'none');
  assert.equal(f.c.DOM.randomTxtBtn.style.display, 'replacement');
});

test('Reader transport retries only transient errors, cancels HTTP bodies, and clears every timeout', async () => {
  for (const status of [503, 408, 429, 404]) {
    const f = fixture(); let calls = 0, cancelled = 0;
    f.c.randomReaderRequestId = 7;
    f.c.fetch = async () => ++calls === 1
      ? {ok: false, status, body: {cancel: async () => { cancelled++; }}}
      : {ok: true, json: async () => record};
    const result = f.c.fetchRandomReaderRecord('/random', 7, f.c.location.href);
    if (status === 404) await assert.rejects(result, /HTTP 404/); else assert.equal(await result, record);
    assert.equal(calls, status === 404 ? 1 : 2); assert.equal(cancelled, 1); assert.equal(f.timers.size, 0);
  }
  for (const offline of [false, true]) {
    const f = fixture(); let calls = 0;
    f.c.navigator.onLine = !offline;
    f.c.fetch = async () => { calls++; throw offline ? new TypeError('offline') : new SyntaxError('bad JSON'); };
    await assert.rejects(f.c.fetchRandomReaderRecord('/random', 0, f.c.location.href));
    assert.equal(calls, 1); assert.equal(f.timers.size, 0);
  }
  const f = fixture(); let calls = 0, aborted = 0;
  f.c.fetch = async (_url, options) => ++calls === 1 ? {ok: true, json: () => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => { aborted++; reject(new Error('timeout')); });
  })} : {ok: true, json: async () => record};
  const result = f.c.fetchRandomReaderRecord('/random', 0, f.c.location.href); await turn();
  const timer = [...f.timers][0]; assert.equal(timer.delay, 10000); timer.fn();
  assert.equal(await result, record); assert.equal(aborted, 1); assert.equal(calls, 2); assert.equal(f.timers.size, 0);
});

test('invalid Reader records preserve site-specific errors and Pages fallback', async () => {
  const f = fixture();
  f.c.fetch = async () => ({ok: true, json: async () => null});
  f.c.ensureLocalDataLoaded = async () => false;
  await f.c.randomTxt(); await turn();
  assert.equal(f.opened.length, 0);
  assert.equal(f.messages.at(-1), space ? '随机打开失败' : '暂无可读书籍');
  assert.equal(f.c.openReaderRecord({File: 'unreadable'}, f.c.location.href), false);
});

if (!space) {
  test('Pages samples converted/native weights and preserves Worker scope and local load flags', async () => {
    for (const random of [0, 0.9]) {
      const f = fixture(); f.c.STATE.dataLoaded = true;
      f.c.Math.random = () => random;
      const converted = {...record, File: 'converted', Link: 'converted'};
      f.c.getConvertedReaderRecords = async repo => { assert.equal(repo, 'VoiceOfML/A & B'); return [converted]; };
      f.c.getReaderLink = rec => rec.Link;
      await f.c.randomTxt();
      assert.equal(f.opened[0][0], random ? 'converted' : record.Link);
      assert.equal(f.localCalls.length, random ? 0 : 1);
      if (!random) assert.deepEqual(JSON.parse(JSON.stringify(f.localCalls[0])), ['random-record', {repo: 'VoiceOfML/A & B', readerOnly: true}, 1234]);
    }
    const f = fixture(); f.c.fetch = async () => { throw new SyntaxError('broken API'); };
    await f.c.randomTxt(); await turn();
    assert.equal(f.opened.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.loads.find(Array.isArray))), [false, true]);
    const book = fixture(); book.c.fetch = async () => { throw new Error('offline'); };
    await book.c.randomBook(); await turn();
    assert.equal(book.downloads.length, 1);
    assert.equal(book.localCalls[0][1].readerOnly, false);
  });

  test('Pages stale converted pool stops before native selection and stale local failure stays silent', async () => {
    const f = fixture(), pool = deferred(); f.c.STATE.dataLoaded = true;
    f.c.getConvertedReaderRecords = () => pool.promise;
    const first = f.c.randomTxt(); f.c.randomReaderRequestId++; pool.resolve([]); await first;
    assert.equal(f.localCalls.length, 0); assert.equal(f.opened.length, 0);
    const g = fixture(), old = deferred(); g.c.STATE.dataLoaded = true; let calls = 0;
    g.c.getRandomLocal = () => ++calls === 1 ? old.promise : Promise.resolve(record);
    const stale = g.c.randomTxt(); await turn(); await g.c.randomTxt(); old.reject(new Error('stale'));
    await stale; assert.equal(g.opened.length, 1); assert.equal(g.messages.length, 2);
  });

  test('Pages native availability is immediate and converted visibility respects newer status intent', async () => {
    const f = fixture(), assets = deferred(); f.c.STATE.dataLoaded = true;
    f.c.loadReaderAssets = () => assets.promise;
    await f.c.updateRandomTxtVisibility(); assert.equal(f.c.DOM.randomTxtBtn.style.display, '');
    f.c.readerMetadata = {count: 0, byRepo: {}};
    const old = f.c.updateRandomTxtVisibility();
    f.c.STATE.dataLoaded = false; f.c.fetchJsonWithTimeout = async () => ({available: false});
    await f.c.updateRandomTxtVisibility(); assets.resolve(); await old;
    assert.equal(f.c.DOM.randomTxtBtn.style.display, 'none');
  });
}

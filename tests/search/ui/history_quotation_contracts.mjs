import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {createRequire} from 'node:module';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';
const names = ['search/history/infrastructure/store.js', 'search/history/application/controller.js', 'search/ambient/application/quotation.js'];
const app = fs.readFileSync('static/app.js', 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
function environment() {
  const timers = new Map(), listeners = [];
  let serial = 0, now = 100000;
  const target = name => ({
    handlers: {}, style: {}, dataset: {}, name,
    addEventListener(type, fn, options) { (this.handlers[type] ||= []).push(fn); listeners.push([name, type, options]); },
    fire(type, event = {}) { for (const fn of this.handlers[type] || []) fn(event); },
  });
  const document = target('document'), window = target('window');
  document.hidden = false;
  const c = vm.createContext({document, window, AbortController,
    Date: {now: () => now}, matchMedia: () => ({matches: false}),
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, {fn, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  for (const name of names) vm.runInContext(fs.readFileSync('static/' + name, 'utf8'), c);
  async function fire(delay) {
    const entry = [...timers].find(([, value]) => value.delay === delay);
    assert.ok(entry, `timer ${delay}`); timers.delete(entry[0]);
    now += delay; entry[1].fn(); await turn();
  }
  return {c, target, timers, listeners, fire};
}
function historyFixture() {
  const f = environment(), {c, target} = f;
  let stored = null;
  const storage = {getItem(key) { assert.equal(key, 'voml_search_history'); return stored; }, setItem(key, value) { assert.equal(key, 'voml_search_history'); stored = value; }};
  c.sessionStorage = storage;
  const dropdown = target('dropdown'), input = target('input'), box = target('box'), results = target('results');
  const rows = [];
  function button(row, kind) {
    const b = target(kind); b.row = row;
    b.dataset = kind === 'del' ? {del: row.dataset.query} : {};
    b.matches = selector => selector === '.history-' + kind;
    b.closest = selector => selector === '.history-item' ? row : selector.includes('.history-' + kind) ? b : null;
    b.focus = () => { c.document.activeElement = b; }; return b;
  }
  dropdown.contains = el => !!el && rows.includes(el.row);
  dropdown.querySelectorAll = selector => selector === '.history-item' ? rows : rows.map(row => row.text);
  Object.defineProperty(dropdown, 'innerHTML', {get() { return this.html; }, set(html) {
    this.html = html; rows.length = 0;
    for (const match of html.matchAll(/data-query="([^"]*)"/g)) {
      const row = {dataset: {query: match[1]}};
      row.text = button(row, 'text'); row.del = button(row, 'del');
      row.querySelector = selector => selector === '.history-del' ? row.del : row.text;
      rows.push(row);
    }
  }});
  input.closest = () => null;
  input.focus = () => { c.document.activeElement = input; input.fire('focus'); };
  results.focus = () => { c.document.activeElement = results; };
  box.contains = el => el === input || dropdown.contains(el);
  c.DOM = {searchInput: input, searchBox: box, historyDropdown: dropdown, resultsContainer: results};
  c.STATE = {recordHistory: true}; c.searchComposing = false; c.searchHistory = null;
  c.escapeHTML = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const submissions = [];
  c.submitSearchQuery = (...args) => { submissions.push(plain(args)); };
  c.searchHistoryStore = c.VoiceOfMLSearchHistoryStore.create(() => c.sessionStorage);
  for (const name of ['getSearchHistoryController', 'getHistory', 'saveHistory', 'addHistoryItem', 'renderDropdown', 'hideSearchHistory', 'setupSearchHistory', 'removeHistoryItem']) {
    const source = app.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
    // Single-line host wrappers end on their declaration line.
    const line = app.split('\n').find(line => line.startsWith('function ' + name + '('));
    vm.runInContext(line.endsWith('}') ? line : source[0], c);
  }
  c.setupSearchHistory();
  function key(key, target = input, extra = {}) {
    const event = {key, target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra};
    box.fire('keydown', event); return event;
  }
  return {...f, storage, rows, input, dropdown, box, results, submissions, key, setStored(value) { stored = value; }};
}

test('history and quotation are registered in HTML, composition, resources, offline and strict projects', () => {
  const html = fs.readFileSync('static/index.html', 'utf8');
  const resources = createRequire(import.meta.url)('../../../static/reader-resources.js');
  for (const name of names) {
    assert.equal(APP_DEPENDENCIES.filter(item => item === name).length, 1);
    assert.equal(html.split(name).length - 1, 1);
    assert.ok(html.indexOf(name) < html.lastIndexOf('app.js'));
    assert.ok(!stripBundledScripts(html).includes(name));
    for (const site of ['github', 'hf']) assert.equal(resources.buildFiles(site).filter(item => item === name).length, 1);
    assert.equal(fs.readFileSync('static/sw.js', 'utf8').split('/static/' + name).length - 1, 1);
    for (const project of ['check', 'strict', 'search-exact']) {
      const files = JSON.parse(fs.readFileSync(`config/types/jsconfig.${project}.json`, 'utf8')).files;
      assert.ok(files.includes('../../static/' + name));
      assert.ok(files.includes('../../typings/search-history-ambient.d.ts'));
    }
    assert.doesNotMatch(fs.readFileSync('static/' + name, 'utf8'), /\bSTATE\b|\bDOM\b|\bsearchComposing\b/);
  }
});

test('history rejects corrupt session JSON, storage failures, live preference, empty query and capped deduplication', () => {
  const f = historyFixture(), {c} = f;
  for (const value of [null, '{bad', 'false', '0', 'null']) { f.setStored(value); assert.deepEqual(plain(c.getHistory()), []); }
  f.setStored('{"unexpected":true}');
  assert.deepEqual(plain(c.getHistory()), []);
  f.setStored(JSON.stringify([null, {}, 1, "valid", ...Array.from({length:25}, (_, i)=>String(i))]));
  assert.deepEqual(plain(c.getHistory()), ["valid", ...Array.from({length:19}, (_, i)=>String(i))]);
  c.renderDropdown(); assert.equal(f.rows.length, 20); assert.match(f.dropdown.innerHTML, /history-clear-all/);
  c.saveHistory([]);
  for (let i = 0; i < 25; i++) c.addHistoryItem('q' + i);
  assert.equal(c.getHistory().length, 20); assert.equal(c.getHistory()[19], 'q5');
  c.addHistoryItem('q12'); assert.equal(c.getHistory()[0], 'q12'); assert.equal(c.getHistory().length, 20);
  c.addHistoryItem(''); c.STATE.recordHistory = false; c.addHistoryItem('disabled'); assert.equal(c.getHistory()[0], 'q12');
  c.STATE.recordHistory = true; c.addHistoryItem('live'); assert.equal(c.getHistory()[0], 'live');
  c.sessionStorage = {getItem() { throw Error('denied'); }, setItem() { throw Error('full'); }};
  assert.deepEqual(plain(c.getHistory()), []); assert.doesNotThrow(() => c.addHistoryItem('safe'));
});

test('history keyboard, delete focus, native activation, clear and submission ownership survive extraction', () => {
  const f = historyFixture(), {c} = f;
  c.saveHistory(['one', 'two', 'three']); f.input.focus();
  assert.match(f.dropdown.innerHTML, /button type="button" class="history-text"/);
  assert.ok(f.key('ArrowDown').prevented); assert.equal(c.document.activeElement, f.rows[0].text);
  f.key('ArrowDown', f.rows[0].text); assert.equal(c.document.activeElement, f.rows[1].text);
  f.rows[1].del.focus(); c.renderDropdown(); assert.equal(c.document.activeElement, f.rows[1].del);
  f.dropdown.fire('click', {target: f.rows[1].del, detail: 0});
  assert.deepEqual(plain(c.getHistory()), ['one', 'three']); assert.equal(c.document.activeElement, f.rows[1].text);
  f.dropdown.fire('click', {target: f.rows[1].text, detail: 0});
  assert.deepEqual(f.submissions, [['three', {restore: true, blur: true}]]); assert.equal(c.document.activeElement, f.results);
  f.input.focus(); assert.ok(f.key('Escape').stopped); assert.equal(c.document.activeElement, f.input); assert.equal(f.dropdown.style.display, 'none');
  f.input.focus(); f.key('ArrowUp'); assert.equal(c.document.activeElement, f.input);
  const clear = {closest: selector => selector === '.history-clear-all' ? clear : null};
  f.dropdown.fire('click', {target: clear, detail: 0});
  assert.deepEqual(plain(c.getHistory()), []); assert.equal(f.dropdown.style.display, 'none'); assert.equal(c.document.activeElement, f.input);
});

test('history preserves listener order, live IME guards, hover/blur delay and long-press cancellation', async () => {
  const f = historyFixture(), {c} = f;
  assert.deepEqual(f.listeners.slice(0, 6).map(item => item.slice(0, 2)), [['input', 'focus'], ['box', 'focusout'], ['dropdown', 'mouseenter'], ['dropdown', 'mouseleave'], ['document', 'pointerdown'], ['box', 'keydown']]);
  c.saveHistory(['one', 'two']); f.input.focus();
  for (const extra of [{isComposing: true}, {keyCode: 229}, {ctrlKey: true}, {metaKey: true}, {altKey: true}]) assert.equal(f.key('ArrowDown', f.input, extra).prevented, false);
  c.searchComposing = true; assert.equal(f.key('Escape').prevented, false); c.searchComposing = false;
  assert.equal(f.key('Enter').prevented, false); assert.equal(f.submissions.length, 0);
  f.rows[0].text.focus(); f.box.fire('focusout'); await f.fire(150); assert.equal(f.dropdown.style.display, '');
  c.document.activeElement = f.results; f.dropdown.fire('mouseenter'); f.box.fire('focusout'); await f.fire(150); assert.equal(f.dropdown.style.display, '');
  f.dropdown.fire('mouseleave'); await f.fire(150); assert.equal(f.dropdown.style.display, 'none');
  f.input.focus(); f.dropdown.fire('touchstart', {target: f.rows[0].text}); f.dropdown.fire('touchcancel'); assert.equal([...f.timers.values()].some(t => t.delay === 600), false);
  const old = f.rows[0].text; f.dropdown.fire('mousedown', {target: old}); await f.fire(600);
  f.dropdown.fire('click', {target: old, detail: 1}); assert.equal(f.submissions.length, 0); assert.deepEqual(plain(c.getHistory()), ['two']);
  f.dropdown.fire('click', {target: f.rows[0].text, detail: 0}); assert.equal(f.submissions.length, 1);
  f.input.focus(); c.document.fire('pointerdown', {target: f.results}); assert.equal(f.dropdown.style.display, 'none');
});

function quoteFixture() {
  const f = environment(), el = {style: {}, textContent: 'previous'}, requests = [];
  f.c.fetch = (url, options) => new Promise((resolve, reject) => { requests.push({url, options, resolve, reject}); });
  f.c.quotation = f.c.VoiceOfMLQuotation.create({element: () => el});
  vm.runInContext(app.split('\n').find(line => line.startsWith('function setupHitokoto(')), f.c);
  f.c.setupHitokoto();
  return {...f, el, requests};
}

test('quotation owns refresh, body timeout, single flight and stale response rejection across visibility and page lifecycle', async () => {
  const f = quoteFixture(), {c} = f;
  assert.deepEqual(f.listeners.map(item => item.slice(0, 2)), [['document', 'visibilitychange'], ['window', 'pagehide'], ['window', 'pageshow']]);
  await f.fire(0); assert.equal(f.requests.length, 1);
  c.document.fire('visibilitychange'); assert.equal(f.requests.length, 1);
  const old = f.requests[0]; assert.equal(old.url, 'https://vomebook-hitokoto.hf.space/');
  c.window.fire('pagehide'); assert.ok(old.options.signal.aborted); c.document.fire('visibilitychange'); assert.equal(f.timers.size, 1);
  c.window.fire('pageshow'); await f.fire(0); assert.equal(f.requests.length, 2);
  let bodyResolve;
  f.requests[1].resolve({ok: true, json: () => new Promise(resolve => { bodyResolve = resolve; })}); await turn();
  await f.fire(8000); // Old request timeout can still settle independently.
  await f.fire(8000); assert.ok(f.requests[1].options.signal.aborted);
  bodyResolve({hitokoto: 'timed out'}); await turn(); assert.equal(f.el.textContent, 'previous');
  old.resolve({ok: true, json: async () => ({hitokoto: 'stale'})}); await turn(); assert.equal(f.el.textContent, 'previous');
  assert.deepEqual([...f.timers.values()].map(t => t.delay), [30000]);
  await f.fire(30000); c.matchMedia = () => ({matches: true});
  f.requests[2].resolve({ok: true, json: async () => ({sentence: 'current'})}); await turn();
  assert.equal(f.el.textContent, 'current'); assert.deepEqual([...f.timers.values()].map(t => t.delay), [30000]);
});

test('quotation animation uses Unicode characters, pauses without catchup, resumes and honors reduced motion', async () => {
  const f = quoteFixture(), {c} = f;
  await f.fire(0); f.requests[0].resolve({ok: true, json: async () => ({text: '你🌟好'})}); await turn();
  await f.fire(60); assert.equal(f.el.textContent, '你');
  c.document.hidden = true; c.document.fire('visibilitychange'); assert.equal(f.timers.size, 0);
  assert.equal(f.el.textContent, '你'); c.document.hidden = false; c.document.fire('visibilitychange');
  await f.fire(60); assert.equal(f.el.textContent, '你🌟');
  c.window.fire('pagehide'); c.matchMedia = () => ({matches: true}); c.window.fire('pageshow');
  assert.equal(f.el.textContent, '你🌟好'); assert.equal(f.el.style.opacity, '0.55');
  await f.fire(29880); f.requests[1].reject(Error('offline')); await turn(); assert.equal(f.el.textContent, '你🌟好');
  assert.deepEqual([...f.timers.values()].map(t => t.delay), [30000]);
});

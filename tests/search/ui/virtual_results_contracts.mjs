import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';

const modules = ['domain/heights.js', 'presentation/rows.js', 'application/controller.js'];
const current = fs.readFileSync('static/app.js', 'utf8');
const source = process.env.VIRTUAL_BASELINE_SOURCE ? fs.readFileSync(process.env.VIRTUAL_BASELINE_SOURCE, 'utf8') : current;
const pages = current.includes('appliedRouteHash');
const names = ['getResultScrollTop', 'setResultScrollTop', 'layoutResultScrollSegment', 'reconcileVirtualRows',
  'scheduleVirtualRender', 'renderVisible', 'ensureHeightTree', 'getVirtualTotalHeight', 'getVirtualOffset',
  'findVirtualIndex', 'resetVirtualScrollState', 'ensureVirtualHeights', 'refreshVirtualAfterAppend',
  'ensureVirtualViewportCovered', 'measureHeights'];

function fixture(count = 100) {
  const events = [], frames = new Map(), records = new WeakMap();
  let serial = 0, clock = 16;
  const document = {activeElement: null, createElement: () => node()};
  function node(className = '', height = 60) {
    const n = {className, height, style: {}, dataset: {}, children: [], parent: null, attrs: {},
      get isConnected() { return this === list || this === container || !!this.parent?.isConnected; },
      get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null; },
      get lastElementChild() { return this.children.at(-1) || null; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
      append(child) { child.remove(); this.children.push(child); child.parent = this; },
      prepend(child) { child.remove(); this.children.unshift(child); child.parent = this; },
      insertBefore(child, cursor) { child.remove(); this.children.splice(this.children.indexOf(cursor), 0, child); child.parent = this; },
      contains(child) { return child === this || this.children.some(n => n.contains(child)); },
      closest(selector) { return selector === '.result-item' && this.className === 'result-item' ? this : this.parent?.closest(selector) || null; },
      querySelectorAll(selector) {
        if (selector === 'button,a,input,[role="button"]') return this.children;
        return this.children.filter(n => selector.startsWith('.result-item') ? n.className === 'result-item' : n.className.split(' ').includes(selector.slice(1)));
      },
      querySelector(selector) {
        const index = selector.match(/data-index="(\d+)"/);
        return this.querySelectorAll(selector).find(n => !index || n.dataset.index === index[1]) || null;
      },
      getBoundingClientRect() { events.push(['measure', this.dataset.index]); return {height: this.height}; },
      focus(options) { document.activeElement = this; events.push(['focus', this.dataset.index ?? 'container', options.preventScroll]); },
    };
    return n;
  }
  const list = node(), container = node();
  Object.assign(container, {clientHeight: 300, scrollHeight: 1000000, scrollTop: 0});
  document.activeElement = container;
  const STATE = {results: Array.from({length: count}, (_, index) => ({File: 'row-' + index})), total: count, _loadedPage: 1};
  const c = vm.createContext({STATE, DOM: {resultsList: list, resultsContainer: container, multiSelectToggle: {checked: false}},
    document, performance: {now: () => clock += 16}, resultWindow: null, resultSnapshots: {cloneTask: null},
    positionRestore: null, pendingResultEntrance: false, measuredHeightRevision: 0, keyboardResultIndex: -1,
    resultRowRecords: records, virtualResults: undefined,
    requestAnimationFrame(fn) { const id = ++serial; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); events.push(['cancel', id]); },
    getHeightMeasurementKey: () => 'width:300', getResultStableId: record => record?.File || '',
    createResultRow(record, index) {
      const row = node('result-item', record?.height || 60); row.dataset = {index: String(index), contentVersion: String(c.VSCROLL.contentVersion)};
      records.set(row, record);
      const button = node('action'); button.dataset.action = 'read'; button.setAttribute('aria-label', record?.File); row.append(button);
      events.push(['create', index]); return row;
    },
    ensureResultTemplateCache() {}, clearResultTemplateCache() { c.VSCROLL.measuredWindowKey = ''; c.VSCROLL.measuredRowKeys = []; events.push(['clear']); },
    updateCurrentResultPosition: () => events.push(['position']), maybeLoadNextPage: () => events.push(['load']),
    updateScrollThumb: () => events.push(['thumb']), updateScrollTrack: () => events.push(['track']),
    ensureResultWindowPages: (start, end) => events.push(['pages', start, end]),
    updateVisibleSelection: () => events.push(['selection']), animateVisibleResultRows: () => events.push(['entrance']),
    rememberDisplayedSearchView: () => events.push(['remember']), cancelQuickScroll: () => events.push(['quick']),
    activateSearchView: () => events.push(['activate']),
  });
  vm.runInContext(fs.readFileSync('static/search/domain/height-index.js', 'utf8'), c);
  for (const file of modules) vm.runInContext(fs.readFileSync('static/search/results/virtual/' + file, 'utf8'), c);
  if (process.env.VIRTUAL_BASELINE_SOURCE) {
    vm.runInContext(source.match(/const VSCROLL = \{[^]*?^};/m)[0].replace('const VSCROLL', 'var VSCROLL'), c);
    vm.runInContext('const RESULT_SCROLL_SEGMENT_HEIGHT = 1000000; let resultScrollOrigin = 0; let resultScrollTarget = null;', c);
    for (const name of names) vm.runInContext(source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'))[0], c);
  } else {
    c.VSCROLL = c.VoiceOfMLVirtualHeights.createState();
    vm.runInContext(source.match(/^function getVirtualResults\([^]*?^}/m)[0], c);
    for (const name of names.filter(n => !['layoutResultScrollSegment', 'reconcileVirtualRows'].includes(n))) {
      const match = source.match(new RegExp('^function ' + name + '\\([^\\n]*', 'm'));
      vm.runInContext(match[0], c);
    }
  }
  return {c, STATE, list, container, events, frames, document,
    flush() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); },
  };
}

test('virtual modules are registered in every runtime and type entry point', () => {
  const html = fs.readFileSync('static/index.html', 'utf8'), c = vm.createContext({});
  vm.runInContext(fs.readFileSync('static/reader-resources.js', 'utf8'), c);
  for (const file of modules.map(name => 'search/results/virtual/' + name)) {
    assert.equal(APP_DEPENDENCIES.filter(name => name === file).length, 1);
    assert.equal(html.split(file).length - 1, 1); assert.ok(html.indexOf(file) < html.indexOf('static/app.js'));
    assert.ok(!stripBundledScripts(html).includes(file));
    assert.equal(fs.readFileSync('static/sw.js', 'utf8').split('/static/' + file).length - 1, 1);
    for (const site of ['github', 'hf']) assert.equal(c.VoiceOfMLReaderResources.buildFiles(site).filter(name => name === file).length, 1);
    for (const kind of ['check', 'strict', 'search-exact']) assert.ok(fs.readFileSync('config/types/jsconfig.' + kind + '.json', 'utf8').includes(file));
    assert.doesNotMatch(fs.readFileSync('static/' + file, 'utf8'), /\bSTATE\b|new Proxy/);
  }
});

test('height growth retains cached keys, dense tree identity and sparse holes', () => {
  const {c, STATE} = fixture(20), s = c.VSCROLL;
  s.heightCache.set('row-1', {height: 75.5, measurementKey: 'width:300'});
  s.heightCache.set('row-2', {height: 99, measurementKey: 'old'});
  c.ensureVirtualHeights(10); assert.equal(c.getVirtualTotalHeight(), 615.5);
  const tree = s.heightTree; c.ensureVirtualHeights(20); assert.equal(s.heightTree, tree);
  assert.equal(c.getVirtualOffset(2), 135.5); assert.equal(c.findVirtualIndex(135.5), 2);
  assert.equal(c.getVirtualTotalHeight(), 1215.5);
  c.resultWindow = {total: 100000}; STATE.results = []; STATE.results.length = 100000; STATE.results[1] = {File: 'row-1'};
  c.resetVirtualScrollState(); c.ensureVirtualHeights(100000);
  assert.equal(s.sparseHeights, true); assert.equal(Object.keys(s.heights).length, 1);
  assert.equal(c.getVirtualTotalHeight(), 6000015.5);
});

test('scroll RAF coalesces intent, freezes drag measurements and reset cancels stale work', () => {
  const f = fixture(0), {c, events, frames} = f;
  c.scheduleVirtualRender(true); c.scheduleVirtualRender(true);
  assert.equal(frames.size, 1); assert.equal(events.filter(e => e[0] === 'load').length, 1);
  f.flush(); assert.equal(c.VSCROLL.renderAfterScroll, false); assert.equal(events.filter(e => e[0] === 'track').length, 1);
  c.VSCROLL.isDraggingThumb = true; c.scheduleVirtualRender(true);
  assert.equal(events.filter(e => e[0] === 'load').length, 1); assert.equal(c.measureHeights(), false);
  f.container.scrollTop = 21; c.resetVirtualScrollState(); assert.equal(frames.size, 0);
  assert.equal(c.VSCROLL.renderFrame, 0); assert.equal(c.VSCROLL.renderAfterScroll, false);
  assert.equal(f.container.scrollTop, pages ? 21 : 0);
  assert.deepEqual(events.slice(-5).map(e => e[0]), ['quick', 'cancel', 'activate', 'clear', 'track']);
});

test('render reuses rows and restores the same focused control after content invalidation', () => {
  const f = fixture(), {c, list, events, document} = f;
  c.renderVisible(); const row = list.querySelector('.result-item[data-index="2"]');
  document.activeElement = row.children[0]; c.VSCROLL.renderStart = -1; c.VSCROLL.renderEnd = -1; c.renderVisible();
  assert.equal(list.querySelector('.result-item[data-index="2"]'), row);
  assert.equal(events.filter(e => e[0] === 'measure').length, 26);
  c.VSCROLL.contentVersion++; c.VSCROLL.renderStart = -1; c.VSCROLL.renderEnd = -1; c.renderVisible();
  const replacement = list.querySelector('.result-item[data-index="2"]');
  assert.notEqual(replacement, row); assert.equal(document.activeElement, replacement.children[0]);
  assert.equal(replacement.attrs['aria-posinset'], '3'); assert.equal(replacement.attrs['aria-setsize'], '100');
  c.STATE.results[2] = {File: 'different'}; c.VSCROLL.renderStart = -1; c.VSCROLL.renderEnd = -1; c.renderVisible();
  assert.equal(document.activeElement, f.container); assert.equal(c.keyboardResultIndex, -1);
});

test('measured heights compensate one anchor and drag keeps geometry frozen', () => {
  const f = fixture(), {c, list, container} = f;
  c.renderVisible(); container.scrollTop = 125;
  list.querySelector('.result-item[data-index="0"]').height = 80;
  c.VSCROLL.measuredWindowKey = ''; c.VSCROLL.measuredRowKeys[0] = null;
  assert.equal(c.measureHeights(), true); assert.equal(c.getResultScrollTop(), 145);
  assert.equal(c.findVirtualIndex(c.getResultScrollTop()), 2); assert.equal(c.getVirtualOffset(2), 140);
  c.VSCROLL.isDraggingThumb = true;
  list.querySelector('.result-item[data-index="0"]').height = 120;
  c.VSCROLL.measuredWindowKey = ''; c.VSCROLL.measuredRowKeys[0] = null;
  assert.equal(c.measureHeights(), false); assert.equal(c.VSCROLL.heights[0], 80);
});

test('logical segmentation, restored velocity and append coverage retain exact bounds', () => {
  const f = fixture(100000), {c, container, list} = f;
  c.resultWindow = {total: 100000}; c.resetVirtualScrollState(); c.ensureVirtualHeights(100000);
  c.VSCROLL.isDraggingThumb = true; c.setResultScrollTop(5700000.25, true);
  assert.equal(c.findVirtualIndex(c.getResultScrollTop()), 95000);
  assert.equal(c.VSCROLL.scrollVelocity, 0); assert.ok(container.scrollTop < 1000000);
  assert.equal(c.VSCROLL.renderEnd - c.VSCROLL.renderStart, 30);
  assert.ok(parseFloat(list.querySelector('.virtual-spacer-top').style.height) < 1000000);
  c.setResultScrollTop(6000, true); assert.equal(c.getResultScrollTop(), 6000);
  assert.equal(c.findVirtualIndex(6000), 100);
  const start = c.VSCROLL.renderStart; c.ensureVirtualViewportCovered(); assert.equal(c.VSCROLL.renderStart, start);
  container.scrollTop += 10000; c.ensureVirtualViewportCovered(); assert.equal(c.VSCROLL.renderStart, -1);
});

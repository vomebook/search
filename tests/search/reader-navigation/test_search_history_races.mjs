// Focused host contracts. Browser traversal and DOM ownership are covered in
// test_reader_navigation_host.py; these isolate synchronous abort/input edges.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import './host_contracts.mjs';
import './routing_contracts.mjs';
import './bootstrap_contracts.mjs';
import '../paging/result_window_contracts.mjs';
import '../session/test_positions_persistence.mjs';
import '../session/test_result_snapshots.mjs';
import '../ui/test_sidebar_directory.mjs';
import '../ui/virtual_results_contracts.mjs';
import { installClassicSearchModules } from '../../support/classic_search_modules.js';
import { APP_DEPENDENCIES, stripBundledScripts } from '../../../scripts/build/compose_app.mjs';

const source = fs.readFileSync('static/app.js', 'utf8');
function fixture(names, values = {}) {
  const context = vm.createContext({AbortController, searchTransport:undefined, searchPagePrefetch:undefined, ...values});
  installClassicSearchModules(process.cwd(), context);
  context.readerHost = {overlay: null};
  context.readerReturnPosition = context.VoiceOfMLReaderReturn.create({
    readView: () => ({loading: context.STATE.isLoading, loadedPage: context.STATE._loadedPage,
      resultCount: context.STATE.results.length, total: context.STATE.total, positionRestore: context.positionRestore}),
    hasResult: index => !!context.STATE.results[index]
  });
  for (const name of names) {
    const match = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  return context;
}

function transportFixture() {
  let now = 0, timerId = 0;
  const timers = new Map(), calls = [];
  const names = ['getSearchTransport', 'createSearchPageRequest', 'fetchSearchPage', 'expireSearchRequests'];
  if (source.includes('function normalizeSearchError(')) names.push('normalizeSearchError', 'suspendSearchRequests', 'resumeSearchRequests');
  const c = fixture(names, {DOMException, document:{hidden:false}, APPEND_REQUEST_TIMEOUT:50,
    Date:{now:()=>now}, getCorpusClient:()=>({expireRequests(){}}), scheduleScrollRecovery(){},
    setTimeout(fn, delay){timers.set(++timerId,{fn,delay});return timerId;},
    clearTimeout(id){timers.delete(id);},
    isValidSearchResponse:()=>true,
    fetch(url, options){return new Promise((resolve,reject)=>calls.push({url,...options,resolve,reject}));}});
  c.pendingSearchPages = c.getSearchTransport().pending;
  const body = {page:2,page_size:1};
  return {c,calls,timers,body, now(value){now=value;},
    fetch(signal, timeout=100){return c.fetchSearchPage('shared','/search',body,signal,timeout);},
    reply(index, value){calls[index].resolve({ok:true,json:async()=>value});},
    async flush(){for(let i=0;i<12;i++) await Promise.resolve();}};
}

test('real transport joins subscribers, preserves signal-less ownership and cancels the final owner', async () => {
  const f=transportFixture(), owner=new AbortController();
  const first=f.fetch(owner.signal).catch(error=>error.name), remaining=f.fetch();
  const entry=f.c.pendingSearchPages.get('shared');
  assert.equal(f.calls.length,1);assert.equal(entry.listeners.size,2);
  owner.abort();assert.equal(await first,'AbortError');assert.equal(f.calls[0].signal.aborted,false);
  const data={page:2};f.reply(0,data);assert.equal(await remaining,data);
  assert.equal(entry.listeners.size,0);assert.equal(f.c.pendingSearchPages.size,0);assert.equal(f.timers.size,0);
  const last=new AbortController(), abandoned=f.fetch(last.signal).catch(error=>error.name);
  last.abort();assert.equal(await abandoned,'AbortError');await f.flush();
  assert.equal(f.calls[1].signal.aborted,true);assert.equal(f.c.pendingSearchPages.size,0);
  const cancelled=new AbortController();cancelled.abort();
  assert.equal(await f.fetch(cancelled.signal).catch(error=>error.name),'AbortError');assert.equal(f.calls.length,2);
});

test('deadline mutation expires all joiners and stale cleanup cannot delete the replacement', async () => {
  const f=transportFixture(), owner=new AbortController();
  const first=f.fetch().catch(error=>error.message), joined=f.fetch(owner.signal).catch(error=>error.message);
  const old=f.c.pendingSearchPages.get('shared');old.deadline=-1;
  const replacement=f.fetch();
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].signal.aborted,true);
  const current=f.c.pendingSearchPages.get('shared');assert.notEqual(current,old);
  assert.equal(await first,'API_TIMEOUT');assert.equal(await joined,'API_TIMEOUT');
  assert.equal(f.c.pendingSearchPages.get('shared'),current);assert.equal(old.listeners.size,0);
  f.reply(0,{stale:true});await f.flush();assert.equal(f.c.pendingSearchPages.get('shared'),current);
  const data={fresh:true};f.reply(1,data);assert.equal(await replacement,data);assert.equal(f.timers.size,0);
});

test('deadline timer and explicit expiry settle a stalled body and retain the first deadline for joiners', async () => {
  for(const explicit of [false,true]) {
    const f=transportFixture(), pending=f.fetch().catch(error=>error.message);
    const joined=f.fetch(undefined,1000).catch(error=>error.message);
    let release;f.calls[0].resolve({ok:true,json:()=>new Promise(resolve=>{release=resolve;})});await f.flush();
    assert.equal(f.c.pendingSearchPages.get('shared').deadline,100);assert.equal(f.timers.size,1);
    if(explicit){f.now(100);f.c.expireSearchRequests();}else [...f.timers.values()][0].fn();
    assert.equal(await pending,'API_TIMEOUT');assert.equal(await joined,'API_TIMEOUT');
    release({late:true});await f.flush();assert.equal(f.c.pendingSearchPages.size,0);assert.equal(f.timers.size,0);
  }
});

if (source.includes('function suspendSearchRequests(')) test('resume retains joined ownership and ignores the previous connection body', async () => {
  const f=transportFixture(), first=f.fetch(), joined=f.fetch();
  let release;f.calls[0].resolve({ok:true,json:()=>new Promise(resolve=>{release=resolve;})});await f.flush();
  const entry=f.c.pendingSearchPages.get('shared');f.c.suspendSearchRequests();f.now(20);f.c.resumeSearchRequests();
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].signal.aborted,true);
  assert.equal(f.c.pendingSearchPages.get('shared'),entry);assert.equal(entry.deadline,70);assert.equal(entry.listeners.size,2);
  let settled=false;first.then(()=>{settled=true;});release({stale:true});await f.flush();assert.equal(settled,false);
  const fresh={fresh:true};f.reply(1,fresh);assert.equal(await first,fresh);assert.equal(await joined,fresh);
  assert.equal(f.timers.size,0);assert.equal(entry.listeners.size,0);
});

function inputFixture({submit = () => {}, schedule = () => {}, early} = {}) {
  const context = vm.createContext({});
  for (const file of ['domain/ownership.js', 'application/controller.js'])
    vm.runInContext(fs.readFileSync('static/search/input/' + file, 'utf8'), context);
  const input = new EventTarget(), navigation = new EventTarget(), callbacks = new Map(), cancelled = [];
  input.value = 'old draft';
  if (early) input._earlySearchInput = early;
  const c = {input, navigation, callbacks, cancelled, href: 'https://example.test/A', entry: 'entry-A', key: 'A', syncs: 0};
  let next = 0;
  c.controller = context.VoiceOfMLSearchInput.create({input, navigation,
    ownership: context.VoiceOfMLSearchInputOwnership,
    clock: {setTimeout(fn, delay) { assert.equal(delay, 100); callbacks.set(++next, fn); schedule(); return next; },
      clearTimeout(id) { cancelled.push(id); }},
    getHref: () => c.href, getEntryKey: () => c.entry, getViewKey: () => c.key,
    syncInput: () => c.syncs++, submit, onState: state => {
      c.state = {...state};
      c.onState?.(state);
    }
  });
  c.emit = (type, values = {}) => input.dispatchEvent(Object.assign(new Event(type), values));
  c.flush = () => callbacks.get(c.state.timer)();
  c.controller.mount();
  return c;
}

test('reader handoff waits for usable target rows but not preview validation of adjacent pages', () => {
  const saved = {viewKey:'B',index:1};
  const c = fixture(['readerSearchHandoffReady'], {STATE:{isLoading:true,_loadedPage:0,total:3,results:[]},positionRestore:null});
  assert.equal(c.readerSearchHandoffReady(saved), false);
  c.STATE = {isLoading:false,_loadedPage:1,total:3,results:[{},{}]};
  c.positionRestore = {key:'B',preview:false};
  assert.equal(c.readerSearchHandoffReady(saved), false);
  c.positionRestore.preview = true;
  assert.equal(c.readerSearchHandoffReady(saved), true);
  assert.equal(c.positionRestore.preview, true, 'validation remains owned and active');
  c.positionRestore.key = 'A';
  assert.equal(c.readerSearchHandoffReady(saved), false);
  c.positionRestore.key = 'B';
  delete c.STATE.results[1];
  assert.equal(c.readerSearchHandoffReady(saved), false, 'sparse geometry alone is not a usable target');
  c.positionRestore = null;
  c.STATE.results[1] = {};
  assert.equal(c.readerSearchHandoffReady(saved), true);
});

test('sort normalization uses the real backend whitelist, including empty and unknown URL values', () => {
  const c = fixture(['normalizeSearchSort']);
  for (const input of ['', null, undefined, 'custom', 'NAME', ' relevance '])
    assert.equal(c.normalizeSearchSort(input), 'relevance');
  for (const input of ['relevance', 'name', 'size']) assert.equal(c.normalizeSearchSort(input), input);
});

test('abort synchronously starting another search retains its controller and retires the outer owner', () => {
  const old = new AbortController();
  const c = fixture(['cancelActiveSearch'], {searchId: 4, searchRequestId: 8,
    searchAbortController: old, cancelSearchPrefetch() {}});
  let newer;
  old.signal.addEventListener('abort', () => {
    assert.equal(c.searchId, 5);
    assert.equal(c.searchRequestId, 9);
    assert.notEqual(c.searchAbortController, old);
    assert.equal(c.cancelActiveSearch(), true);
    newer = c.searchAbortController;
  });
  assert.equal(c.cancelActiveSearch(), false);
  assert.equal(c.searchAbortController, newer);
  assert.equal(newer.signal.aborted, false);
});

test('prefetch abort reentry cannot clear the replacement group', () => {
  const old = new AbortController(), newer = new AbortController();
  const c = fixture(['cancelSearchPrefetch'], {searchPrefetchAbortController: old,
    cancelPendingSearchCacheWrites() {}});
  old.signal.addEventListener('abort', () => { c.searchPrefetchAbortController = newer; });
  c.cancelSearchPrefetch();
  assert.equal(c.searchPrefetchAbortController, newer);
});

test('online first page prefetch starts pages two and three and path-only reuses the group', () => {
  const requests = [];
  const c = fixture(['prefetchSearchPages'], {searchPrefetchAbortController:null,
    STATE:{_loadedPage:1,total:301,pageSize:100,_pageCache:{},results:[{}]},
    document:{hidden:false},navigator:{onLine:true},searchPageMetadata:new WeakMap(),
    getSearchViewKey:() => 'same-view',stableSearchStringify:JSON.stringify,
    getCachedSearchResponse:() => null,
    fetchSearchPage(key, base, body, signal) { requests.push({page:body.page,signal}); return new Promise(() => {}); },
    APPEND_REQUEST_TIMEOUT:10000});
  c.prefetchSearchPages('/api/search',{q:'paging',page:1,page_size:100});
  assert.deepEqual(requests.map(r => r.page), [2,3]);
  const group = c.searchPrefetchAbortController;
  c.STATE.browserPath = 'path-only';
  c.prefetchSearchPages('/api/search',{q:'paging',page:1,page_size:100});
  assert.equal(c.searchPrefetchAbortController, group);
  assert.equal(requests.length, 2);
  assert.equal(group.signal.aborted, false);
});

test('position abort reentry retains the replacement window and restoration', () => {
  const old = new AbortController(), newer = {controller: new AbortController()};
  const c = fixture(['cancelPositionRestore'], {positionEntryId: 0,
    resultWindow: {controller: old}, positionRestore: {controller: new AbortController()},
    STATE: {isLoading: true}, cancelSnapshotClone() {}, updateResultWindowStatus() {}, showPositionRestoreStatus() {}});
  old.signal.addEventListener('abort', () => { c.resultWindow = newer; c.positionRestore = newer; });
  c.cancelPositionRestore();
  assert.equal(c.resultWindow, newer);
  assert.equal(c.positionRestore, newer);
  assert.equal(newer.controller.signal.aborted, false);
});

test('filter change incorporates the pending completed query before cancelling debounce', () => {
  const c = fixture(['prepareFilterChange'], {searchTimer: 1, searchComposing: false,
    DOM: {searchInput: {value: '  current draft  '}}, STATE: {query: 'old', page: 3, results: [1]},
    applyPendingSizeFilters() {}, cancelPendingSearchControls() { c.searchTimer = null; },
    saveSearchViewSnapshot() { assert.equal(c.STATE.query, 'old'); }});
  c.prepareFilterChange(true);
  assert.equal(c.STATE.query, 'current draft');
  assert.equal(c.STATE.page, 1);
  assert.equal(c.STATE.results.length, 0);
});

test('filter change preserves composing and overlong drafts without submitting them', () => {
  for (const [composing, value] of [[true, 'composition'], [false, 'x'.repeat(257)]]) {
    const c = fixture(['prepareFilterChange'], {searchTimer: 1, searchComposing: composing,
      DOM: {searchInput: {value}}, STATE: {query: 'old'}, applyPendingSizeFilters() {},
      cancelPendingSearchControls() {}, saveSearchViewSnapshot() {}});
    c.prepareFilterChange(false);
    assert.equal(c.STATE.query, 'old');
    assert.equal(c.DOM.searchInput.value, value);
  }
});

test('composition start cannot revive state disposed by a synchronous notification', () => {
  for (const ready of [false, true]) {
    const c = inputFixture();
    if (ready) c.controller.finishStartup(true);
    c.onState = () => { c.onState = null; c.controller.dispose(); };
    c.emit('compositionstart');
    assert.equal(c.state.composing, false);
    assert.equal(c.state.timer, null);
    c.emit('compositionend');
    assert.equal(c.callbacks.size, 0);
  }
});

test('composition completion checks both visit generation and search view ownership', () => {
  for (const change of ['generation', 'view', 'neither']) {
    let scheduled = 0;
    const c = inputFixture({schedule() { scheduled++; }});
    c.controller.finishStartup(true);
    c.emit('compositionstart');
    if (change === 'generation') c.controller.invalidateVisit();
    if (change === 'view') c.key = 'B';
    c.emit('compositionend');
    assert.equal(c.state.composing, false);
    assert.equal(scheduled, change === 'neither' ? 1 : 0, change);
    const before = scheduled;
    c.emit('input', {isComposing: false, inputType: 'insertCompositionText'});
    assert.equal(scheduled, before);
    c.emit('input', {isComposing: false, inputType: 'insertText'});
    assert.equal(scheduled, before + 1, 'a deliberate edit remains usable');
  }
});

test('startup drafts require their original URL, entry and uninterrupted visit', () => {
  for (const change of ['href', 'entry', 'event', 'none']) {
    let submits = 0;
    const c = inputFixture({submit() { submits++; }});
    c.controller.captureDraft();
    c.emit('compositionstart');
    if (change === 'href') c.href = 'https://example.test/B';
    if (change === 'entry') c.entry = 'entry-B';
    if (change === 'event') c.navigation.dispatchEvent(new Event('popstate'));
    c.controller.finishStartup(c.controller.draftIsCurrent());
    assert.equal(c.state.timer, null, 'startup never submits a composing draft');
    c.emit('compositionend');
    if (c.state.timer !== null) c.flush();
    assert.equal(submits, change === 'none' ? 1 : 0, 'startup invalidates old composition generations: ' + change);
    assert.equal(c.state.ready, true);
    c.href = 'https://example.test/after-startup';
    assert.equal(c.controller.draftIsCurrent(), true, 'startup releases the draft owner');
  }
});

test('a queued debounce cannot submit after its search view changes', () => {
  let submits = 0;
  const c = inputFixture({submit() { submits++; }});
  c.controller.finishStartup(true);
  c.controller.debounce();
  const callback = c.callbacks.get(c.state.timer);
  c.controller.invalidateVisit();
  callback();
  assert.equal(submits, 0);
  c.controller.debounce();
  c.flush();
  assert.equal(submits, 1);
});

test('controller adopts early IME, submits the latest draft once and releases the producer', () => {
  for (const composing of [false, true]) {
    let released = 0;
    const queries = [];
    const c = inputFixture({submit: query => queries.push(query), early: {dirty: true, composing,
      owner: {href: 'https://example.test/A', key: 'entry-A', cancelled: false}, dispose() { released++; }}});
    c.controller.mount();
    assert.equal(released, 1);
    assert.equal(c.state.dirty, true);
    assert.equal(c.state.composing, composing);
    c.controller.finishStartup(c.controller.draftIsCurrent());
    c.input.value = '  latest 中  ';
    if (composing) {
      assert.equal(c.state.timer, null);
      c.emit('compositionend');
    }
    c.emit('input', {inputType: 'insertFromComposition'});
    c.flush();
    assert.deepEqual(queries, ['latest 中']);
    assert.equal(c.state.dirty, false);
    c.href = 'https://example.test/after-startup';
    assert.equal(c.controller.draftIsCurrent(), true, 'adopted owner is released');
  }
});

test('cancelled early visit rejects IME tails after A-B-A but accepts a deliberate edit', () => {
  const queries = [];
  const c = inputFixture({submit: query => queries.push(query), early: {dirty: true, composing: true,
    owner: {href: 'https://example.test/A', key: undefined, cancelled: true}, dispose() {}}});
  assert.equal(c.controller.draftIsCurrent(), false);
  c.controller.finishStartup(false);
  c.emit('compositionend');
  c.emit('input', {inputType: 'insertFromComposition'});
  assert.equal(c.state.timer, null);
  c.input.value = 'fresh';
  c.emit('input', {inputType: 'insertText'});
  c.flush();
  assert.deepEqual(queries, ['fresh']);
});

test('startup navigation cancellation can renew for a new edit or composition', () => {
  for (const event of ['popstate', 'hashchange', 'pagehide']) {
    const c = inputFixture();
    c.emit('input');
    c.navigation.dispatchEvent(new Event(event));
    assert.equal(c.controller.draftIsCurrent(), false);
    c.href = 'https://example.test/B';
    c.entry = 'entry-B';
    c.emit('input', {inputType: 'insertCompositionText'});
    assert.equal(c.controller.draftIsCurrent(), false);
    c.emit('compositionstart');
    assert.equal(c.controller.draftIsCurrent(), true);
    c.navigation.dispatchEvent(new Event(event));
    c.emit('compositionend');
    c.emit('input', {inputType: 'insertText'});
    assert.equal(c.controller.draftIsCurrent(), true);
  }
});

test('replaced timers and disposed controllers cannot submit or clear a newer timer', () => {
  const queries = [];
  const c = inputFixture({submit: query => queries.push(query)});
  c.controller.finishStartup(true);
  c.emit('input');
  const first = c.state.timer, stale = c.callbacks.get(first);
  c.emit('input');
  const second = c.state.timer;
  assert.ok(c.cancelled.includes(first));
  stale();
  assert.equal(c.state.timer, second);
  assert.deepEqual(queries, []);
  const queued = c.callbacks.get(second), syncs = c.syncs;
  c.controller.dispose();
  c.controller.dispose();
  assert.ok(c.cancelled.includes(second));
  c.controller.mount();
  c.controller.debounce();
  c.emit('input');
  c.emit('compositionstart');
  c.emit('compositionend');
  queued();
  assert.equal(c.syncs, syncs, 'disposed listeners are removed');
  assert.equal(c.state.composing, false);
  assert.equal(c.state.timer, null);
  assert.deepEqual(queries, []);
});

test('debounce publication yields to one-shot reentrant cancellation, replacement and disposal', () => {
  for (const phase of ['before-schedule', 'before-submit']) {
    for (const action of ['cancelTimer', 'debounce', 'dispose']) {
      const queries = [];
      const c = inputFixture({submit: query => queries.push(query)});
      c.controller.finishStartup(true);
      if (phase === 'before-submit') c.controller.debounce();
      const pending = c.state.timer;
      let calls = 0;
      c.onState = state => {
        if (state.timer !== null) return;
        c.onState = null;
        calls++;
        c.controller[action]();
      };
      if (phase === 'before-schedule') c.controller.debounce();
      else c.callbacks.get(pending)();
      assert.equal(calls, 1, phase + '/' + action);
      assert.deepEqual(queries, [], 'outer operation must yield after publication');
      const active = [...c.callbacks.keys()].filter(id => id !== pending && !c.cancelled.includes(id));
      if (action === 'debounce') {
        assert.deepEqual(active, [c.state.timer], 'only the reentrant replacement is scheduled');
        c.flush();
        assert.deepEqual(queries, ['old draft']);
      } else {
        assert.equal(c.state.timer, null);
        assert.deepEqual(active, []);
      }
    }
  }
});

test('published state is a detached narrow projection without mutable ownership', () => {
  const queries = [], snapshots = [];
  const c = inputFixture({submit: query => queries.push(query)});
  c.onState = state => {
    assert.deepEqual(Object.keys(state).sort(), ['composing', 'dirty', 'ready', 'timer']);
    snapshots.push(state);
  };
  c.controller.captureDraft();
  const captured = snapshots.at(-1);
  c.controller.cancelDraft();
  captured.owner = {cancelled: false};
  captured.generation = 100;
  captured.ready = true;
  captured.composing = true;
  captured.timer = 999;
  captured.dirty = false;
  assert.equal(c.controller.draftIsCurrent(), false, 'snapshot mutation cannot revive a cancelled owner');
  c.controller.debounce();
  assert.equal(c.callbacks.size, 0, 'snapshot mutation cannot complete startup');
  c.controller.captureDraft(true);
  assert.equal(c.controller.draftIsCurrent(), true);
  const renewed = snapshots.at(-1);
  assert.notEqual(renewed, captured);
  assert.equal(renewed.dirty, true);
  assert.equal(renewed.ready, false);
  assert.equal(renewed.composing, false);
  assert.equal(renewed.timer, null);
  c.controller.finishStartup(true);
  assert.equal(renewed.ready, false, 'previous notifications do not change with internal state');
  c.flush();
  assert.deepEqual(queries, ['old draft']);
  assert.equal(c.state.ready, true);
});

test('app adapter publishes readable input state and delegates submit with history options', () => {
  const modules = vm.createContext({});
  for (const path of ['domain/ownership.js', 'application/controller.js'])
    vm.runInContext(fs.readFileSync('static/search/input/' + path, 'utf8'), modules);
  const input = new EventTarget(), navigation = new EventTarget(), queries = [];
  input.value = '  adapter draft  ';
  let callback;
  navigation.setTimeout = fn => { callback = fn; return 42; };
  navigation.clearTimeout = () => {};
  const c = fixture(['setupSearchInput', 'initialSearchDraftIsCurrent', 'finishInitialSearchInput', 'cancelPendingSearchControls'], {
    VoiceOfMLSearchInput: modules.VoiceOfMLSearchInput, VoiceOfMLSearchInputOwnership: modules.VoiceOfMLSearchInputOwnership,
    DOM: {searchInput: input}, window: navigation, location: {href: 'https://example.test/A'},
    routeInitialized: true, getSearchViewKey: () => 'A', syncSearchInputState() {}, clearTimeout() {},
    filterSearchTimer: null, sizeFilterTimer: null,
    submitSearchQuery(query, options) { queries.push([query, {...options}]); }
  });
  c.setupSearchInput();
  assert.equal(c.searchInputReady, false, 'mounting alone does not complete startup');
  input.dispatchEvent(new Event('input'));
  assert.equal(c.searchInputReady, false, 'early input waits for route initialization');
  assert.equal(c.searchTimer, null);
  assert.equal(callback, undefined);
  c.finishInitialSearchInput(c.initialSearchDraftIsCurrent());
  assert.equal(c.searchInputReady, true, 'the controller publishes completed startup');
  input.dispatchEvent(new Event('input'));
  assert.equal(c.searchTimer, 42);
  callback();
  assert.equal(c.searchTimer, null);
  assert.deepEqual(queries, [['adapter draft', {record: true, refreshHistory: true}]]);
  input.dispatchEvent(new Event('compositionstart'));
  assert.equal(c.searchComposing, true);
  input.dispatchEvent(new Event('compositionend'));
  assert.equal(c.searchComposing, false);
  c.cancelPendingSearchControls();
  callback();
  assert.equal(c.searchTimer, null);
  assert.equal(queries.length, 1);
});

test('input dependency order, source shell, build resources and SW agree without delaying inline capture', () => {
  const paths = ['search/input/domain/ownership.js', 'search/input/application/controller.js'];
  const html = fs.readFileSync('static/index.html', 'utf8');
  assert.ok(APP_DEPENDENCIES.indexOf(paths[0]) < APP_DEPENDENCIES.indexOf(paths[1]));
  const modules = vm.createContext({});
  for (const path of APP_DEPENDENCIES.filter(path => paths.includes(path)))
    vm.runInContext(fs.readFileSync('static/' + path, 'utf8'), modules);
  assert.equal(typeof modules.VoiceOfMLSearchInput.create, 'function');
  vm.runInContext(fs.readFileSync('static/reader-resources.js', 'utf8'), modules);
  for (const path of paths) {
    assert.ok(html.indexOf('input._earlySearchInput = handoff') < html.indexOf(path));
    assert.ok(html.indexOf(path) < html.indexOf('static/app.js'));
    assert.ok(!stripBundledScripts(html).includes(path));
    for (const site of ['github', 'huggingface']) assert.ok(modules.VoiceOfMLReaderResources.buildFiles(site).includes(path));
    assert.ok(fs.readFileSync('static/sw.js', 'utf8').includes('/static/' + path));
  }
});

test('a queued debounce cannot submit after composition starts', () => {
  let submits = 0;
  const c = inputFixture({submit() { submits++; }});
  c.input.value = 'intermediate';
  c.controller.finishStartup(true);
  c.controller.debounce();
  const callback = c.callbacks.get(c.state.timer);
  c.emit('compositionstart');
  callback();
  assert.equal(submits, 0);
  assert.equal(c.state.timer, null);
});

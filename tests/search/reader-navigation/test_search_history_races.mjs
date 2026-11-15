// Focused host contracts. Browser traversal and DOM ownership are covered in
// test_reader_navigation_host.py; these isolate synchronous abort/input edges.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync('static/app.js', 'utf8');
function fixture(names, values = {}) {
  const context = vm.createContext({AbortController, ...values});
  for (const name of names) {
    const match = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  return context;
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

test('composition completion checks both visit generation and search view ownership', () => {
  for (const change of ['generation', 'view', 'neither']) {
    const handlers = new Map();
    let scheduled = 0, key = 'A';
    const c = fixture(['setupSearchInput'], {
      DOM: {searchInput: {addEventListener(type, handler) { handlers.set(type, handler); }}},
      searchInputReady: true, initialSearchDraft: false, searchTimer: null,
      searchComposing: false, searchInputGeneration: 0, searchCompositionGeneration: 0,
      searchCompositionViewKey: null, routeInitialized: true,
      getSearchViewKey: () => key, clearTimeout() {}, syncSearchInputState() {},
      window: {addEventListener() {}}, cancelInitialSearchDraft() {}, captureInitialSearchDraft() {},
      debouncedSearch() { scheduled++; }
    });
    c.setupSearchInput();
    handlers.get('compositionstart')();
    if (change === 'generation') c.searchInputGeneration++;
    if (change === 'view') key = 'B';
    handlers.get('compositionend')();
    assert.equal(c.searchComposing, false);
    assert.equal(scheduled, change === 'neither' ? 1 : 0, change);
    const before = scheduled;
    handlers.get('input')({isComposing: false, inputType: 'insertCompositionText'});
    assert.equal(scheduled, before);
    handlers.get('input')({isComposing: false, inputType: 'insertText'});
    assert.equal(scheduled, before + 1, 'a deliberate edit remains usable');
  }
});

test('startup drafts require their original URL, entry and uninterrupted visit', () => {
  for (const change of ['href', 'entry', 'event', 'none']) {
    let key = 'entry-A', submits = 0;
    const c = fixture(['captureInitialSearchDraft', 'cancelInitialSearchDraft',
      'initialSearchDraftIsCurrent', 'finishInitialSearchInput'], {
      location: {href: 'https://example.test/A'}, currentSearchEntryKey: () => key,
      initialSearchDraftOwner: null, initialSearchDraft: false, searchInputReady: false,
      searchInputGeneration: 0, window: {removeEventListener() {}},
      debouncedSearch() { submits++; }
    });
    c.captureInitialSearchDraft();
    if (change === 'href') c.location.href = 'https://example.test/B';
    if (change === 'entry') key = 'entry-B';
    if (change === 'event') c.cancelInitialSearchDraft();
    c.finishInitialSearchInput(c.initialSearchDraftIsCurrent());
    assert.equal(submits, change === 'none' ? 1 : 0, change);
    assert.equal(c.searchInputGeneration, change === 'none' ? 0 : 1, change);
    assert.equal(c.searchInputReady, true);
    assert.equal(c.initialSearchDraftOwner, null);
  }
});

test('a queued debounce cannot submit after its search view changes', () => {
  let callback, submits = 0;
  const c = fixture(['debouncedSearch'], {searchTimer: null, searchComposing: false,
    searchInputReady: true, searchInputGeneration: 0,
    DOM: {searchInput: {value: 'old draft'}}, clearTimeout() {},
    setTimeout(fn) { callback = fn; return 1; }, submitSearchQuery() { submits++; }});
  c.debouncedSearch();
  c.searchInputGeneration++;
  callback();
  assert.equal(submits, 0);
  c.debouncedSearch();
  callback();
  assert.equal(submits, 1);
});

test('a queued debounce cannot submit after composition starts', () => {
  let callback, submits = 0;
  const c = fixture(['debouncedSearch'], {searchTimer: null, searchComposing: false,
    searchInputReady: true, searchInputGeneration: 0,
    DOM: {searchInput: {value: 'intermediate'}}, clearTimeout() {},
    setTimeout(fn) { callback = fn; return 1; }, submitSearchQuery() { submits++; }});
  c.debouncedSearch();
  c.searchComposing = true;
  callback();
  assert.equal(submits, 0);
  assert.equal(c.searchTimer, null);
});

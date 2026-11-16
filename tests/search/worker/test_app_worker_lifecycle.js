// Deterministic application-side Worker lifecycle tests. No server or real timers.
// Run from the repository root: node --test tests/search/worker/test_app_worker_lifecycle.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const {installClassicSearchModules} = require('../../support/classic_search_modules');
const source = fs.readFileSync('static/app.js', 'utf8');
function section(from, to) {
  return source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
}
function harness() {
  const workers = [], timers = new Map();
  let timerId = 0, now = 1000;
  class Worker {
    constructor() { this.listeners = {}; this.sent = []; this.terminated = 0; workers.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    postMessage(message) {
      if (this.throwPost) throw new Error('injected post failure');
      this.sent.push(message);
    }
    terminate() { this.terminated++; }
    respond(message, result = {}, error = null) {
      this.listeners.message({ data: { protocol: 1, type: 'response', id: message.id,
        ok: !error, result, error } });
    }
    fail() { this.listeners.error({ message: 'injected failure' }); }
    request(type) { return this.sent.find(message => message.type === type); }
  }
  const context = vm.createContext({
    Worker, window: { Worker }, URL, DOMException, AbortController, Date: {now: () => now},
    document: { baseURI: 'https://test.invalid/search/' }, console: { error() {}, warn() {} },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  installClassicSearchModules(process.cwd(), context);
  vm.runInContext(`
    const WORKER_PROTOCOL_VERSION = 1, WORKER_REQUEST_TIMEOUT = 100, WORKER_LOAD_TIMEOUT = 200;
    const DATA_URL = 'data/search_data.json.gz';
    ${section('let extensionCounts =', 'let keepalivePending =')}
    ${section('async function loadData()', 'function toMirrorURL(')}
    let localDataPromise = null, searchId = 0, searchIntentId = 1, routeRenderId = 1;
    const STATE = { dataLoaded: false, filterExtensions: [], mode: 'all', useLocalMode: true, results: [] };
    const DOM = { emptyState: { style: {} }, localModeToggle: { checked: true } };
    let key = 'same', searches = 0, renders = 0, toasts = 0, syncs = 0;
    function getSearchViewKey() { return key; }
    function doSearch() { searches++; searchIntentId++; }
    function showToast() { toasts++; }
    function syncStateToURL() { syncs++; }
    function renderFilters() { renders++; }
    function renderExtensionFilter() { renders++; }
    function renderRepoFilter() { renders++; }
    function setSearchVisualLoading() {}
    function renderResultsSkeleton() {}
    function updateStatusBar() {}
    function updateLoadInfo() {}
    function updateRandomTxtVisibility() {}
    function setExactSearchSectionVisible() {}
    ${section('function ensureLocalDataLoaded(', 'function submitSearchQuery(')}
  `, context);
  // Legacy assertion expressions are translated to the owned client's public
  // operations and detached diagnostics; no mutable state is installed globally.
  const run = code => vm.runInContext(code
    .replace(/corpusWorkerPending\.size/g, 'getCorpusClient().inspect().pending.length')
    .replace(/corpusWorkerRestartCount/g, 'getCorpusClient().inspect().restartCount')
    .replace(/corpusWorkerConsecutiveRestarts/g, 'getCorpusClient().inspect().consecutiveRestarts')
    .replace(/corpusWorkerStartPromise/g, '(getCorpusClient().inspect().starting ? true : null)')
    .replace(/corpusWorkerEpoch\.bootstrap/g, '(getCorpusClient().inspect().bootstrapping ? true : null)')
    .replace(/\bcorpusWorker\b/g, 'getCorpusClient().inspect().worker')
    .replace(/ensureCorpusWorker\(/g, 'getCorpusClient().ensure(')
    .replace(/postCorpusWorkerRequest\(/g, 'getCorpusClient().post('), context);
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const ready = async () => {
    const pending = run('ensureCorpusWorker()');
    await flush();
    workers.at(-1).respond(workers.at(-1).request('handshake'), { protocol: 1 });
    await pending;
    return workers.at(-1);
  };
  return { workers, timers, run, flush, ready, advance(ms) { now += ms; } };
}

// Exercise the actual callers, including their promise continuations, without
// loading the page shell. Only rendering/network dependencies are substituted.
function callerHarness() {
  const h = harness();
  h.run(`
    let searchRequestId = 0, searchAbortController = null;
    let resultWindow = null, filterSearchTimer = null, scrollLoadTimer = null;
    let selectedIndices = {}, lastSelectedIndex = -1, apiAvailable = true;
    let finishLoad, finishApi, failApi, loadCalls = 0, pagingFailures = 0, filterSearches = 0;
    let toggleChange, restoring = false;
    const backendStates = [];
    STATE.page = 1; STATE._pageCache = {}; STATE._loadedPage = 0;
    DOM.resultsList = { innerHTML: '' };
    DOM.localModeToggle.addEventListener = (_type, listener) => { toggleChange = listener; };
    function prepareSearchPositionNavigation() { return restoring; }
    function buildLocalSearchParams() { return { folderMatchMode: null }; }
    function updatePagingStatus() {}
    function resetPagingRecovery() {}
    function canUseInitialSearchPayload() { return false; }
    function cancelSearchPrefetch() {}
    function clearResultsSkeleton() {}
    function prepareFilterChange() { filterSearches++; }
    ${section('function doFilterSearch(', 'function sizeInputToBytes(')}
    function finishPagingAttempt() { pagingFailures++; }
    function doSearchAPI() { return new Promise((resolve, reject) => { finishApi = resolve; failApi = reject; }); }
    function renderSearchPage() { renders++; }
    function prefetchNextPage() {}
    function warmConnection() {}
    ensureLocalDataLoaded = () => { loadCalls++; return new Promise(resolve => { finishLoad = resolve; }); };
    clearUnavailableSearchResults = () => {};
    renderSearchBackendUnavailable = waiting => { backendStates.push(waiting); STATE.isLoading = waiting; };
    ${section('function cancelActiveSearch()', 'function prefetchSearchPages(')}
    ${section('function doSearch(append,', 'function renderSearchPage(')}
    ${section('  DOM.localModeToggle.addEventListener("change",', '  DOM.sortSelect.addEventListener(')}
    const startSearch = doSearch;
    doSearch = () => { searches++; };
    // Enter through the real toggle -> doFilterSearch -> doSearch chain. Observe
    // only subsequent async searches, without starting unrelated network work.
    function runToggle() {
      const observeSearch = doSearch;
      doSearch = startSearch;
      try { toggleChange(); }
      finally { doSearch = observeSearch; }
    }
  `);
  return h;
}

test('synchronous abort reentry owns the only attempt and outer search cannot replace it', async () => {
  const h = callerHarness();
  h.run(`searchAbortController = new AbortController();
    const retired = searchAbortController;
    retired.signal.addEventListener('abort', () => startSearch(false), {once:true});
    startSearch(false);`);
  assert.equal(h.run('loadCalls'), 1);
  assert.equal(h.run('searchId'), 3);
  assert.equal(h.run('searchRequestId'), 2);
  assert.equal(h.run('searchIntentId'), 3);
  assert.equal(h.run('retired.signal.aborted'), true);
  assert.equal(h.run('searchAbortController.signal.aborted'), false);
  h.run('finishLoad(true);');
  await h.flush();
  assert.equal(h.run('searches'), 1);
});

for (const dragging of [false, true]) {
  test(`cached append checks drag before consuming and never starts transport (${dragging})`, () => {
    const h = callerHarness();
    h.run(`STATE._loadedPage=1;STATE.page=2;STATE._pageCache[2]=[];
      let consumed=0, deferred=0;
      function deferSearchAppend() { deferred++; return ${dragging}; }
      function consumeCachedAppendPage() { consumed++; }
      startSearch(true);`);
    assert.equal(h.run('deferred'), 1);
    assert.equal(h.run('consumed'), dragging ? 0 : 1);
    assert.equal(h.run('loadCalls'), 0);
    assert.equal(h.run('searchRequestId'), 0);
    assert.equal(h.run('searchIntentId'), 1);
    assert.equal(h.run('searchId'), 1);
    assert.equal(h.run('STATE.isLoading'), undefined);
  });
}

for (const ok of [true, false]) {
  for (const stale of [true, false]) {
    test(`local search caller respects intent while searchId/view stay unchanged (ok=${ok}, stale=${stale})`, async () => {
      const h = callerHarness();
      h.run('startSearch(false); const originalId = searchId;');
      assert.equal(h.run('loadCalls'), 1);
      // Isolate intent ownership: request identity and view deliberately stay fixed.
      if (stale) h.run('searchIntentId++;');
      h.run(`finishLoad(${ok});`);
      await h.flush();
      assert.equal(h.run('searchId'), h.run('originalId'));
      assert.equal(h.run('key'), 'same');
      assert.equal(h.run('searches'), stale ? 0 : 1);
      assert.equal(h.run('STATE.isLoading'), stale);
    });

    test(`local-mode toggle completion respects intent on success and failure (ok=${ok}, stale=${stale})`, async () => {
      const h = callerHarness();
      const intent = h.run('searchIntentId');
      h.run(`searchAbortController = new AbortController();
        const previousController = searchAbortController;
        runToggle(); const originalId = searchId;`);
      assert.equal(h.run('searchIntentId'), intent + 1);
      assert.equal(h.run('previousController.signal.aborted'), true);
      assert.equal(h.run('searchAbortController.signal.aborted'), false);
      assert.equal(h.run('filterSearches'), 1);
      assert.equal(h.run('loadCalls'), 1);
      assert.equal(h.run('STATE.isLoading'), true);
      if (stale) h.run('searchIntentId++;');
      const syncs = h.run('syncs');
      h.run(`finishLoad(${ok});`);
      await h.flush();
      assert.equal(h.run('searchId'), h.run('originalId'));
      assert.equal(h.run('key'), 'same');
      assert.equal(h.run('filterSearches'), 1, 'completion must not re-enter the toggle/filter path');
      assert.equal(h.run('searches'), stale ? 0 : 1);
      assert.equal(h.run('syncs'), syncs);
      assert.equal(h.run('STATE.isLoading'), stale);
      assert.equal(h.run('STATE.useLocalMode'), stale || ok);
      assert.equal(h.run('DOM.localModeToggle.checked'), stale || ok);
      assert.deepEqual(Array.from(h.run('backendStates')), [true]);
    });
  }
}

for (const stale of [true, false]) {
  test(`API fallback completion preserves newer intent and loading state (stale=${stale})`, async () => {
    const h = callerHarness();
    h.run(`STATE.useLocalMode = false; DOM.localModeToggle.checked = false;
      startSearch(false); const originalId = searchId;
      failApi(new Error('API_TIMEOUT'));`);
    await h.flush();
    assert.equal(h.run('loadCalls'), 1);
    if (stale) h.run('searchIntentId++;');
    h.run('finishLoad(true);');
    await h.flush();
    assert.equal(h.run('searchId'), h.run('originalId'));
    assert.equal(h.run('STATE.useLocalMode'), !stale);
    assert.equal(h.run('DOM.localModeToggle.checked'), !stale);
    assert.equal(h.run('searches'), stale ? 0 : 1);
    assert.equal(h.run('syncs'), stale ? 0 : 1);
    assert.equal(h.run('STATE.isLoading'), stale);
  });
}

test('API failure arriving after an intent change never starts local fallback', async () => {
  const h = callerHarness();
  h.run(`STATE.useLocalMode = false; startSearch(false);
    searchIntentId++; failApi(new Error('API_TIMEOUT'));`);
  await h.flush();
  assert.equal(h.run('loadCalls + searches + toasts + syncs'), 0);
  assert.equal(h.run('STATE.isLoading'), true);
  assert.equal(h.run('STATE.useLocalMode'), false);
});

for (const backend of ['local', 'api']) {
  test(`restoration preempts a pending ${backend} caller without settling its replacement`, async () => {
    const h = callerHarness();
    h.run(`STATE.useLocalMode = ${backend === 'local'};
      startSearch(false); const originalId = searchId;
      const originalRequest = searchRequestId, originalIntent = searchIntentId;
      const originalController = searchAbortController;
      restoring = true; startSearch(false);
      const replacementId = searchId, replacementController = searchAbortController;`);
    assert.equal(h.run('searchId'), h.run('originalId + 1'));
    assert.equal(h.run('searchRequestId'), h.run('originalRequest + 1'));
    assert.equal(h.run('searchIntentId'), h.run('originalIntent + 1'));
    assert.equal(h.run('originalController.signal.aborted'), true);
    assert.equal(h.run('replacementController.signal.aborted'), false);
    assert.equal(h.run('key'), 'same');
    const effects = h.run('searches + renders + toasts + syncs');
    h.run(backend === 'local' ? 'finishLoad(false);' : "failApi(new Error('API_TIMEOUT'));");
    await h.flush();
    assert.equal(h.run('searchId'), h.run('replacementId'));
    assert.equal(h.run('searchAbortController === replacementController'), true);
    assert.equal(h.run('replacementController.signal.aborted'), false);
    assert.equal(h.run('searches + renders + toasts + syncs'), effects);
    assert.equal(h.run('STATE.isLoading'), true);
    assert.equal(h.run('STATE.useLocalMode'), backend === 'local');
    assert.equal(h.run('loadCalls'), backend === 'local' ? 1 : 0);
  });
}

for (const ok of [true, false]) {
  for (const change of ['request', 'view']) {
    test(`shared local-load completion respects ${change} ownership independently of intent (${ok})`, async () => {
      const h = harness();
      h.run(`let finishLoad, loads = 0;
        loadData = () => { loads++; return new Promise(resolve => { finishLoad = resolve; }); };
        const originalIntent = searchIntentId;`);
      const stale = h.run('ensureLocalDataLoaded(true, false)');
      h.run(change === 'request' ? 'searchId++;' : "key = 'new-view';");
      // Only the stale caller requested a follow-up search. The current caller
      // still owns rendering and foreground failure cleanup.
      const current = h.run('ensureLocalDataLoaded(false, false)');
      assert.equal(h.run('searchIntentId'), h.run('originalIntent'));
      const toasts = h.run('toasts');
      h.run(`finishLoad(${ok});`);
      assert.deepEqual(await Promise.all([stale, current]), [ok, ok]);
      assert.equal(h.run('loads'), 1);
      assert.equal(h.run('searches'), 0);
      assert.equal(h.run('renders'), ok ? 2 : 0);
      assert.equal(h.run('toasts'), toasts);
      assert.equal(h.run('syncs'), 0);
      assert.equal(h.run('STATE.useLocalMode'), true);
      assert.equal(h.run('DOM.localModeToggle.checked'), true);
      assert.equal(h.run('STATE.dataLoaded'), ok);
      assert.equal(h.run('localDataPromise'), null);
      if (!ok) assert.equal(h.run('STATE.isLoading'), false);
    });
  }
}

test('client registration and host boundary preserve raw and composed Worker URLs', async () => {
  const {APP_DEPENDENCIES, stripBundledScripts} = await import('../../../scripts/build/compose_app.mjs');
  const modulePath = 'search/corpus/application/client.js';
  assert.equal(APP_DEPENDENCIES.filter(path => path === modulePath).length, 1);
  const html = fs.readFileSync('static/index.html', 'utf8');
  assert.ok(html.indexOf('static/' + modulePath) < html.indexOf('src="static/app.js"'));
  assert.ok(!stripBundledScripts(html).includes('src="static/' + modulePath + '"'));
  for (const path of ['static/sw.js', 'static/reader-resources.js', 'scripts/build/check_reader_release.mjs']) {
    assert.ok(fs.readFileSync(path, 'utf8').includes(modulePath), path);
  }
  assert.match(source, /new Worker\("static\/search\/index-worker\.js"\)/);
  assert.match(source, /getCorpusClient\(\)\.expireRequests\(\)/);
  assert.doesNotMatch(source, /corpusWorkerPending|corpusWorkerEpoch|corpusWorkerRequestId/);
  const client = fs.readFileSync('static/' + modulePath, 'utf8');
  assert.doesNotMatch(client, /\b(?:document|window|STATE|loadData|ensureLocalDataLoaded)\b/);
});

test('explicit expiry respects original deadlines and detached diagnostics cannot change them', async () => {
  const h = harness(), worker = await h.ready();
  const first = h.run("getCorpusClient().post('metadata', {}, 100)");
  const second = h.run("getCorpusClient().post('folder-tree', {}, 200)");
  const settled = Promise.allSettled([first, second]);
  const snapshot = h.run('getCorpusClient().inspect()');
  assert.deepEqual(Array.from(snapshot.pending, entry => entry.id), [2, 3]);
  assert.deepEqual(Array.from(snapshot.pending, entry => entry.deadline), [1100, 1200]);
  snapshot.pending[0].deadline = 0;
  snapshot.pending.length = 0;
  snapshot.restartCount = 99;
  h.advance(99);
  h.run('getCorpusClient().expireRequests()');
  assert.equal(h.run('getCorpusClient().inspect().pending.length'), 2);
  assert.equal(h.run('getCorpusClient().inspect().restartCount'), 0);
  h.advance(1);
  h.run('getCorpusClient().expireRequests()');
  const results = await settled;
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.deepEqual(results.map(result => result.reason.code), ['WORKER_TIMEOUT', 'WORKER_TIMEOUT']);
  assert.equal(worker.terminated, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.run('getCorpusClient().inspect().pending.length'), 0);
});

test('cancellation consumes an ID and late results cannot settle a subsequent request', async () => {
  const h = harness(), worker = await h.ready();
  h.run('const owner = new AbortController();');
  const cancelled = h.run("getCorpusClient().post('local-search', {}, 100, owner.signal)");
  const retired = worker.request('local-search');
  h.run('owner.abort()');
  await assert.rejects(cancelled, {name: 'AbortError'});
  const cancel = worker.request('cancel-search');
  assert.equal(cancel.id, retired.id + 1);
  assert.equal(cancel.payload.requestId, retired.id);
  const current = h.run("getCorpusClient().post('metadata', {})");
  assert.equal(worker.request('metadata').id, cancel.id + 1);
  worker.respond(retired, {stale: true});
  assert.equal(h.run('getCorpusClient().inspect().pending.length'), 1);
  worker.respond(worker.request('metadata'), {current: true});
  assert.equal((await current).current, true);
  assert.equal(h.timers.size, 0);
});

test('response envelope protocol mismatch cannot automatically restart a live Worker', async () => {
  const h = harness(), worker = await h.ready();
  const pending = h.run("corpusWorkerRequest('metadata', {})");
  await h.flush();
  worker.listeners.message({data: {protocol: 2, type: 'response', id: worker.request('metadata').id, ok: true}});
  await assert.rejects(pending, {code: 'PROTOCOL_MISMATCH'});
  assert.equal(h.workers.length, 1);
  assert.equal(worker.terminated, 0);
  assert.equal(h.run('getCorpusClient().inspect().restartCount'), 0);
  assert.equal(h.timers.size, 0);
});

test('missing Worker support settles with the same bounded recovery budget', async () => {
  const h = harness();
  h.run('window.Worker = null;');
  await assert.rejects(h.run("corpusWorkerRequest('metadata', {})"), {code: 'WORKER_UNAVAILABLE'});
  assert.equal(h.run('getCorpusClient().inspect().restartCount'), 1);
  assert.equal(h.workers.length, 0);
  assert.equal(h.timers.size, 0);
});

test('concurrent startup waits for a single handshake', async () => {
  const h = harness();
  const first = h.run("corpusWorkerRequest('metadata', {})");
  const second = h.run("corpusWorkerRequest('folder-tree', {})");
  await h.flush();
  assert.equal(h.workers.length, 1);
  const worker = h.workers[0];
  assert.deepEqual(worker.sent.map(m => m.type), ['handshake']);
  worker.respond(worker.request('handshake'), { protocol: 1 });
  await h.flush();
  worker.respond(worker.request('metadata'), { count: 3 });
  worker.respond(worker.request('folder-tree'), { tree: [] });
  await Promise.all([first, second]);
  assert.equal(h.timers.size, 0);
});

test('failed concurrent waiters share recovery and bootstrap; stale events cannot touch replacement', async () => {
  const h = harness(), old = await h.ready();
  const first = h.run("corpusWorkerRequest('metadata', {})");
  const second = h.run("corpusWorkerRequest('folder-tree', {})");
  await h.flush();
  old.fail();
  await h.flush();
  assert.equal(h.workers.length, 2);
  const replacement = h.workers[1];
  const third = h.run("corpusWorkerRequest('random-record', {})");
  await h.flush();
  old.fail();
  old.listeners.messageerror({ message: 'late decode failure' });
  old.respond(replacement.request('handshake'), { protocol: 999 });
  assert.equal(replacement.terminated, 0);
  replacement.respond(replacement.request('handshake'), { protocol: 1 });
  await h.flush();
  assert.deepEqual(replacement.sent.map(m => m.type), ['handshake', 'load-corpus']);
  replacement.respond(replacement.request('load-corpus'), { count: 4 });
  await h.flush();
  for (const type of ['metadata', 'folder-tree', 'random-record']) replacement.respond(replacement.request(type), { count: 4 });
  await Promise.all([first, second, third]);
  assert.equal(h.run('corpusWorkerRestartCount'), 1);
  assert.equal(h.run('corpusWorkerConsecutiveRestarts'), 0);
  assert.equal(h.run('corpusWorkerPending.size'), 0);
  assert.equal(h.timers.size, 0);
});

test('synchronous post failure removes timer, pending request and abort listener', async () => {
  const h = harness(), worker = await h.ready();
  h.run(`let removes = 0; const controller = new AbortController();
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = (...args) => { removes++; remove(...args); };`);
  worker.throwPost = true;
  await assert.rejects(h.run("postCorpusWorkerRequest('metadata', {}, 100, controller.signal)"), /injected post failure/);
  assert.equal(h.run('corpusWorkerPending.size'), 0);
  assert.equal(h.run('removes'), 1);
  assert.equal(h.timers.size, 0);
  assert.equal(worker.terminated, 0);
});

test('cancel posting failure still settles AbortError and releases resources', async () => {
  const h = harness(), worker = await h.ready();
  h.run('const controller = new AbortController();');
  const pending = h.run("postCorpusWorkerRequest('local-search', {}, 100, controller.signal)");
  worker.throwPost = true;
  h.run('controller.abort()');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.run('corpusWorkerPending.size'), 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.run('corpusWorkerRestartCount'), 0);
});

test('pre-abort does not create a Worker; abort during handshake never posts search', async () => {
  const h = harness();
  h.run('const controller = new AbortController(); controller.abort();');
  await assert.rejects(h.run("corpusWorkerRequest('local-search', {}, 100, controller.signal)"), { name: 'AbortError' });
  assert.equal(h.workers.length, 0);
  h.run('const next = new AbortController();');
  const pending = h.run("corpusWorkerRequest('local-search', {}, 100, next.signal)");
  await h.flush();
  h.run('next.abort()');
  const worker = h.workers[0];
  worker.respond(worker.request('handshake'), { protocol: 1 });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(worker.sent.map(m => m.type), ['handshake']);
});

test('abort during recovery bootstrap cannot cancel other waiters or retry stale search', async () => {
  const h = harness(), old = await h.ready();
  h.run('const controller = new AbortController();');
  const stale = h.run("corpusWorkerRequest('local-search', {}, 100, controller.signal)");
  const current = h.run("corpusWorkerRequest('metadata', {})");
  await h.flush();
  // Exercise timeout termination as well as error-event termination.
  h.advance(100);
  h.run('getCorpusClient().expireRequests()');
  await h.flush();
  const replacement = h.workers[1];
  replacement.respond(replacement.request('handshake'), { protocol: 1 });
  await h.flush();
  h.run('controller.abort()');
  replacement.respond(replacement.request('load-corpus'), { count: 4 });
  await h.flush();
  await assert.rejects(stale, { name: 'AbortError' });
  assert.equal(replacement.request('local-search'), undefined);
  replacement.respond(replacement.request('metadata'), { count: 4 });
  assert.equal((await current).count, 4);
  assert.equal(old.terminated, 1);
  assert.equal(replacement.terminated, 0);
  assert.equal(h.timers.size, 0);
});

test('cancellation remains AbortError when shared recovery itself fails', async () => {
  const h = harness(), old = await h.ready();
  h.run('const controller = new AbortController();');
  const stale = h.run("corpusWorkerRequest('local-search', {}, 100, controller.signal)");
  const observed = stale.then(() => 'completed', error => error.name);
  await h.flush();
  old.fail();
  await h.flush();
  h.run('controller.abort()');
  h.workers[1].fail();
  assert.equal(await observed, 'AbortError');
  assert.equal(h.timers.size, 0);
});

test('protocol mismatch fails without restarting or leaking pending requests', async () => {
  const h = harness();
  const pending = h.run("corpusWorkerRequest('metadata', {})");
  await h.flush();
  const worker = h.workers[0];
  worker.respond(worker.request('handshake'), { protocol: 2 });
  await assert.rejects(pending, { code: 'PROTOCOL_MISMATCH' });
  assert.equal(h.workers.length, 1);
  assert.equal(h.run('corpusWorkerRestartCount'), 0);
  assert.equal(h.timers.size, 0);
});

test('synchronous handshake post failure does not retain a poisoned startup promise', async () => {
  const h = harness();
  const pending = h.run('ensureCorpusWorker()');
  h.workers[0].throwPost = true;
  await assert.rejects(pending, /injected post failure/);
  assert.equal(h.run('corpusWorkerStartPromise'), null);
  assert.equal(h.run('corpusWorker'), null);
  assert.equal(h.timers.size, 0);
  await h.ready();
  assert.equal(h.workers.length, 2);
});

test('constructor failures clear startup state and remain retryable', async () => {
  const h = harness();
  h.run('const NativeWorker = Worker; Worker = class { constructor() { throw new Error("constructor failure"); } };');
  await assert.rejects(h.run('ensureCorpusWorker()'), /constructor failure/);
  assert.equal(h.run('corpusWorkerStartPromise'), null);
  h.run('Worker = NativeWorker;');
  await h.ready();
  assert.equal(h.workers.length, 1);
});

test('load waiters reuse replacement bootstrap metadata without a duplicate install', async () => {
  const h = harness(), old = await h.ready();
  const first = h.run('loadData()');
  const second = h.run('loadData()');
  await h.flush();
  old.fail();
  await h.flush();
  const replacement = h.workers[1];
  // A new load joins while the replacement is still handshaking.
  const third = h.run('loadData()');
  replacement.respond(replacement.request('handshake'), { protocol: 1 });
  await h.flush();
  replacement.respond(replacement.request('load-corpus'), {
    repos: [{name: 'R', count: 4}], extensions: [{ name: 'txt', count: 4 }], count: 4,
    extensionsByRepo: {}, reader: {available: false, count: 0, byRepo: {}},
  });
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.deepEqual(replacement.sent.map(m => m.type), ['handshake', 'load-corpus']);
  assert.equal(h.run('extensionCounts.txt'), 4);
  assert.equal(h.timers.size, 0);
});

test('failed replacement bootstrap releases ownership for shared explicit local-load retry', async () => {
  const h = harness(), old = await h.ready();
  const first = h.run('ensureLocalDataLoaded(false, true)');
  const second = h.run('ensureLocalDataLoaded(false, true)');
  const metadata = h.run("corpusWorkerRequest('metadata', {})");
  const metadataResult = Promise.allSettled([metadata]);
  await h.flush();
  assert.equal(old.sent.filter(m => m.type === 'load-corpus').length, 1);
  old.fail();
  await h.flush();
  const replacement = h.workers[1];
  replacement.respond(replacement.request('handshake'), { protocol: 1 });
  await h.flush();
  // Include a request that joined the replacement while its bootstrap was pending.
  const joined = Promise.allSettled([h.run("corpusWorkerRequest('folder-tree', {})")]);
  await h.flush();
  replacement.respond(replacement.request('load-corpus'), null,
    { code: 'CORPUS_FETCH_FAILED', message: 'temporary transport failure' });
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  for (const outcome of [...await metadataResult, ...await joined]) {
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.reason.code, 'CORPUS_FETCH_FAILED');
  }
  assert.equal(h.run('corpusWorkerEpoch.bootstrap'), null);
  assert.equal(h.run('localDataPromise'), null);
  assert.equal(h.run('STATE.dataLoaded'), false);
  assert.equal(h.run('corpusWorkerConsecutiveRestarts'), 1);
  assert.equal(h.run('corpusWorkerRestartCount'), 1);
  assert.equal(h.workers.length, 2);
  assert.equal(replacement.terminated, 0);
  assert.deepEqual(replacement.sent.map(m => m.type), ['handshake', 'load-corpus']);
  assert.equal(h.timers.size, 0);

  // A later user retry reuses this live Worker and shares one fresh load.
  const retry = h.run('ensureLocalDataLoaded(false, true)');
  const retryJoined = h.run('ensureLocalDataLoaded(false, true)');
  await h.flush();
  const loads = replacement.sent.filter(m => m.type === 'load-corpus');
  assert.equal(loads.length, 2);
  replacement.respond(loads[1], { repos: [{name: 'Recovered', count: 7}], extensions: [{ name: 'txt', count: 7 }],
    extensionsByRepo: {}, reader: {available: false, count: 0, byRepo: {}} });
  assert.deepEqual(await Promise.all([retry, retryJoined]), [true, true]);
  assert.equal(h.run('STATE.dataLoaded'), true);
  assert.equal(h.run('extensionCounts.txt'), 7);
  assert.equal(h.run('localDataPromise'), null);
  assert.equal(h.run('corpusWorkerConsecutiveRestarts'), 0);
  assert.equal(h.run('corpusWorkerRestartCount'), 1);
  assert.equal(h.workers.length, 2);
  assert.equal(h.run('corpusWorkerPending.size'), 0);
  assert.equal(h.timers.size, 0);
});

test('persistent startup failure has one shared bounded restart', async () => {
  const h = harness();
  const requests = [h.run("corpusWorkerRequest('metadata', {})"), h.run("corpusWorkerRequest('folder-tree', {})")];
  const settled = Promise.allSettled(requests);
  await h.flush();
  h.workers[0].fail();
  await h.flush();
  h.workers[1].fail();
  const results = await settled;
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
  assert.equal(h.workers.length, 2);
  assert.equal(h.run('corpusWorkerRestartCount'), 1);
  assert.equal(h.timers.size, 0);
});

for (const ok of [true, false]) {
  test(`newer local-load caller gets its own completion after stale first caller (${ok})`, async () => {
    const h = harness();
    h.run(`let finishLoad, loads = 0;
      loadData = () => { loads++; return new Promise(resolve => { finishLoad = resolve; }); };`);
    const stale = h.run('ensureLocalDataLoaded(true, true)');
    h.run('searchIntentId++;'); // Same view key, different search intent.
    const current = h.run('ensureLocalDataLoaded(true, true)');
    h.run(`finishLoad(${ok});`);
    assert.deepEqual(await Promise.all([stale, current]), [ok, ok]);
    assert.equal(h.run('loads'), 1);
    // Acquisition reports failure to callers; doSearch now owns backend fallback.
    assert.equal(h.run('searches'), ok ? 1 : 0);
    assert.equal(h.run('renders'), ok ? 2 : 0, 'only the current caller may render filters');
    assert.equal(h.run('STATE.dataLoaded'), ok);
    assert.equal(h.run('localDataPromise'), null);
    assert.equal(h.run('syncs'), 0);
    assert.equal(h.run('STATE.useLocalMode'), true);
    assert.equal(h.run('DOM.localModeToggle.checked'), true);
  });
  test(`obsolete local-load completion has no caller UI/search effects (${ok})`, async () => {
    const h = harness();
    h.run('let finishLoad; loadData = () => new Promise(resolve => { finishLoad = resolve; });');
    const stale = h.run('ensureLocalDataLoaded(true, true)');
    h.run(`searchIntentId++; STATE.isLoading = true; finishLoad(${ok});`);
    assert.equal(await stale, ok);
    assert.equal(h.run('searches + renders + toasts + syncs'), 0);
    assert.equal(h.run('STATE.useLocalMode'), true);
    assert.equal(h.run('STATE.isLoading'), true);
  });
}

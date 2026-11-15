// Deterministic application-side Worker lifecycle tests. No server or real timers.
// Run from the repository root: node --test tests/search/worker/test_app_worker_lifecycle.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/app.js', 'utf8');
function section(from, to) {
  return source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
}
function harness() {
  const workers = [], timers = new Map();
  let timerId = 0;
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
    Worker, window: { Worker }, URL, DOMException, AbortController,
    document: { baseURI: 'https://test.invalid/search/' }, console: { error() {}, warn() {} },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(`
    const WORKER_PROTOCOL_VERSION = 1, WORKER_REQUEST_TIMEOUT = 100, WORKER_LOAD_TIMEOUT = 200;
    const DATA_URL = 'data/search_data.json.gz';
    ${section('let extensionCounts =', 'let keepalivePending =')}
    ${section('async function loadData()', 'function toMirrorURL(')}
    let localDataPromise = null, searchIntentId = 1, routeRenderId = 1;
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
  const run = code => vm.runInContext(code, context);
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const ready = async () => {
    const pending = run('ensureCorpusWorker()');
    await flush();
    workers.at(-1).respond(workers.at(-1).request('handshake'), { protocol: 1 });
    await pending;
    return workers.at(-1);
  };
  return { workers, timers, run, flush, ready };
}

// Exercise the actual callers, including their promise continuations, without
// loading the page shell. Only rendering/network dependencies are substituted.
function callerHarness() {
  const h = harness();
  h.run(`
    let searchId = 0, searchRequestId = 0, searchAbortController = null;
    let resultWindow = null, filterSearchTimer = null, scrollLoadTimer = null;
    let selectedIndices = {}, lastSelectedIndex = -1, apiAvailable = true;
    let finishLoad, finishApi, failApi, loadCalls = 0, pagingFailures = 0, filterSearches = 0;
    let toggleChange, restoring = false;
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
    function prepareFilterChange() {}
    function doFilterSearch() { filterSearches++; }
    function finishPagingAttempt() { pagingFailures++; }
    function doSearchAPI() { return new Promise((resolve, reject) => { finishApi = resolve; failApi = reject; }); }
    function renderSearchPage() { renders++; }
    function prefetchNextPage() {}
    function warmConnection() {}
    ensureLocalDataLoaded = () => { loadCalls++; return new Promise(resolve => { finishLoad = resolve; }); };
    ${section('function doSearch(append,', 'function doSearchFallbackLocal(')}
    ${section('  DOM.localModeToggle.addEventListener("change",', '  DOM.sortSelect.addEventListener(')}
    const startSearch = doSearch;
    doSearch = () => { searches++; };
  `);
  return h;
}

for (const ok of [true, false]) {
  for (const stale of [true, false]) {
    test(`local search caller respects intent while searchId/view stay unchanged (ok=${ok}, stale=${stale})`, async () => {
      const h = callerHarness();
      h.run('startSearch(false); const originalId = searchId;');
      assert.equal(h.run('loadCalls'), 1);
      if (stale) h.run('restoring = true; startSearch(false);');
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
      h.run('toggleChange(); const originalId = searchId; STATE.isLoading = true;');
      assert.equal(h.run('searchIntentId'), intent + 1);
      if (stale) h.run('restoring = true; startSearch(false);');
      const syncs = h.run('syncs');
      h.run(`finishLoad(${ok});`);
      await h.flush();
      assert.equal(h.run('searchId'), h.run('originalId'));
      assert.equal(h.run('key'), 'same');
      assert.equal(h.run('filterSearches'), !stale && ok ? 1 : 0);
      assert.equal(h.run('searches'), !stale && !ok ? 1 : 0);
      assert.equal(h.run('syncs'), syncs);
      assert.equal(h.run('STATE.isLoading'), true);
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
    if (stale) h.run('restoring = true; startSearch(false);');
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
    restoring = true; startSearch(false); failApi(new Error('API_TIMEOUT'));`);
  await h.flush();
  assert.equal(h.run('loadCalls + searches + toasts + syncs'), 0);
  assert.equal(h.run('STATE.isLoading'), true);
  assert.equal(h.run('STATE.useLocalMode'), false);
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
  h.run("[...corpusWorkerPending.values()][0].expire()");
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
    repos: ['R'], extensions: [{ name: 'txt', count: 4 }], count: 4,
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
  replacement.respond(loads[1], { repos: ['Recovered'], extensions: [{ name: 'txt', count: 7 }] });
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
    assert.equal(h.run('searches'), 1);
    assert.equal(h.run('STATE.dataLoaded'), ok);
    assert.equal(h.run('localDataPromise'), null);
    assert.equal(h.run('syncs'), ok ? 0 : 1);
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

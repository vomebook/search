import gzip
import json
import unittest

from tests.support.browser_support import local_server

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright
except ImportError:
    PlaywrightError = Exception
    sync_playwright = None


def result(name):
    return {
        "Repo": "VoiceOfML/VOMEBOOK",
        "File": name,
        "Extension": "txt",
        "Folder": [],
        "Size": 10,
        "HasTxt": True,
    }


@unittest.skipIf(sync_playwright is None, "install requirements-test.txt to run API integration")
class ApiIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = local_server()
        cls.origin, cls.server_state = cls.server.__enter__()
        cls.playwright = sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True)
        except PlaywrightError as error:
            cls.playwright.stop()
            cls.server.__exit__(None, None, None)
            raise unittest.SkipTest(f"Chromium is unavailable: {error}")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def setUp(self):
        self.server_state.reset()
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 800})
        # API responses are routed locally; OS network isolation must not disable prefetch.
        self.context.add_init_script("Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => true});")
        self.page = self.context.new_page()
        self.search_requests = []
        self.probe_requests = 0
        self.search_failures = False
        self.search_response_override = None
        self.page.route("https://voiceofml-search.hf.space/**", self.api_route)
        self.page.route(
            "https://vomebook-hitokoto.hf.space/**",
            lambda route: route.fulfill(status=200, content_type="application/json", body="{}"),
        )

    def tearDown(self):
        self.context.close()

    def api_route(self, route):
        path = route.request.url.split("?", 1)[0]
        if "/api/search" in path:
            body = json.loads(route.request.post_data or "{}")
            self.search_requests.append(body)
            if self.search_failures:
                route.fulfill(status=503, content_type="application/json", body='{"error":"test"}')
            elif self.search_response_override is not None:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(self.search_response_override))
            else:
                query = body.get("q", "empty")
                payload = {"page": body.get("page", 1), "page_size": body.get("page_size", 100), "total": 1, "results": [result(query + " result")]}
                route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
        elif path.endswith("/api/repos"):
            self.probe_requests += 1
            route.fulfill(status=200, content_type="application/json", body='[{"name":"VoiceOfML/VOMEBOOK","count":1}]')
        elif path.endswith("/api/extensions"):
            route.fulfill(status=200, content_type="application/json", body='[{"name":"txt","count":1}]')
        elif path.endswith("/api/random-txt/status"):
            route.fulfill(status=200, content_type="application/json", body='{"available":false}')
        else:
            route.fulfill(status=200, content_type="application/json", body="{}")

    def load(self, hash_value=""):
        response = self.page.goto(self.origin + "/search/" + hash_value, wait_until="domcontentloaded")
        self.assertEqual(response.status, 200)
        self.page.locator("#search-input").wait_for(state="visible")

    def test_real_worker_demand_index_cancels_without_restart_and_reuses_partial_work(self):
        self.load()
        self.page.wait_for_function("STATE.dataLoaded", timeout=30000)
        observed = self.page.evaluate('''async () => {
          const count = 4000;
          await corpusWorkerRequest('replace-corpus', {data:{v:2,rp:['VoiceOfML/Test'],fd:[['directory']],
            rc:Array.from({length:count},(_,i)=>[0,'alpha guide '+i,'txt',0,1,0])}});
          const {worker, restartCount: restarts} = getCorpusClient().inspect();
          const controller = new AbortController();
          const pending = doSearchLocal({q:'alpha',page:1,pageSize:100,signal:controller.signal})
            .then(()=>'completed', error=>error.name);
          const metadata = await corpusWorkerRequest('metadata', {});
          controller.abort();
          const cancelled = await pending;
          const current = await doSearchLocal({q:'alpha',page:1,pageSize:100});
          return {cancelled,count:metadata.count,total:current.total,rows:current.results.length,
            sameWorker:worker===getCorpusClient().inspect().worker,restarts:getCorpusClient().inspect().restartCount-restarts};
        }''')
        self.assertEqual(observed, {'cancelled':'AbortError', 'count':4000, 'total':4000,
                                    'rows':100, 'sameWorker':True, 'restarts':0})

    def test_special_unicode_boundary_wildcard_matches_ascii_file(self):
        self.load()
        self.page.wait_for_function('STATE.dataLoaded', timeout=30000)
        result = self.page.evaluate('''async () => {
          await corpusWorkerRequest('replace-corpus', {data:{v:2,rp:['VoiceOfML/Repo'],fd:[[]],
            rc:[[0,'book','txt',0,1,0],[0,'loss','txt',0,1,0]]}});
          const options={page:1,pageSize:10,searchFolders:false,exact:true};
          const kelvin=await doSearchLocal({...options,q:'K*'});
          const longS=await doSearchLocal({...options,q:'ſ*'});
          return {kelvin:kelvin.results.map(row=>row.File),longS:longS.results.map(row=>row.File)};
        }''')
        self.assertEqual(result, {'kelvin':['book'], 'longS':['loss']})

    def test_ascii_separator_search_uses_fuzzy_matching_in_local_mode(self):
        self.load()
        self.page.wait_for_function('STATE.dataLoaded', timeout=30000)
        result = self.page.evaluate('''async () => {
          await corpusWorkerRequest('replace-corpus', {data:{v:2,rp:['VoiceOfML/Test'],fd:[[]],
            rc:[[0,'alpha guide','txt',0,1,0]]}});
          const options={page:1,pageSize:10,searchFolders:false};
          const fuzzy=await doSearchLocal({...options,q:'alpha-guied',exact:false});
          const exact=await doSearchLocal({...options,q:'alpha-guied',exact:true});
          return {fuzzy:fuzzy.results.map(row=>row.File),exact:exact.results.length};
        }''')
        self.assertEqual(result, {'fuzzy':['alpha guide'], 'exact':0})

    def test_single_character_search_cancels_without_restarting_or_blocking_metadata(self):
        self.load()
        self.page.wait_for_function('STATE.dataLoaded', timeout=30000)
        result = self.page.evaluate('''async () => {
          await corpusWorkerRequest('replace-corpus', {data:{v:2,rp:['VoiceOfML/Test'],fd:[[]],
            rc:Array.from({length:40000},(_,i)=>[0,'alpha '+i,'txt',0,1,0])}});
          const {worker, restartCount: restarts}=getCorpusClient().inspect(), controller=new AbortController();
          const pending=doSearchLocal({q:'a',page:1,pageSize:100,signal:controller.signal})
            .then(()=> 'completed', error=>error.name);
          const metadata=await corpusWorkerRequest('metadata', {});
          controller.abort();
          const cancelled=await pending;
          const current=await doSearchLocal({q:'a',page:1,pageSize:100});
          return {cancelled,count:metadata.count,total:current.total,rows:current.results.length,
            sameWorker:worker===getCorpusClient().inspect().worker,restarts:getCorpusClient().inspect().restartCount-restarts};
        }''')
        self.assertEqual(result, {'cancelled':'AbortError', 'count':40000, 'total':40000, 'rows':100,
                                  'sameWorker':True, 'restarts':0})

    def test_single_character_cached_pages_match_cold_pages_and_replace_corpus(self):
        self.load()
        self.page.wait_for_function('STATE.dataLoaded', timeout=30000)
        result = self.page.evaluate('''async () => {
          const corpus = {v:2,rp:['VoiceOfML/Test'],fd:[['folder']],
            rc:Array.from({length:5000},(_,i)=>[0,'alpha '+i,'txt',0,i,0])};
          const search = async (page, anchor) => corpusWorkerRequest('local-search', {
            q:'a',exact:false,page,pageSize:50,searchFolders:true,anchorId:anchor});
          const anchor='VoiceOfML/Test\\0folder/alpha 4999.txt';
          await corpusWorkerRequest('replace-corpus', {data:corpus});
          const first=await search(1,anchor), cached=await search(2,anchor);
          await corpusWorkerRequest('replace-corpus', {data:corpus});
          const cold=await search(2,anchor);
          await corpusWorkerRequest('replace-corpus', {data:{v:2,rp:['VoiceOfML/Test'],fd:[[]],
            rc:[[0,'other','txt',0,1,0]]}});
          const replaced=await search(2,anchor);
          return {total:first.total, firstAnchor:first.anchor_index, cachedAnchor:cached.anchor_index,
            coldAnchor:cold.anchor_index, sameIds:JSON.stringify(cached.ids)===JSON.stringify(cold.ids),
            sameSnapshot:cached.snapshot_generation===cold.snapshot_generation,
            replacedTotal:replaced.total, replacedAnchor:replaced.anchor_index,
            changedSnapshot:replaced.snapshot_generation!==cold.snapshot_generation};
        }''')
        self.assertEqual(result, {'total':5000, 'firstAnchor':4999, 'cachedAnchor':4999,
                                  'coldAnchor':4999, 'sameIds':True, 'sameSnapshot':True,
                                  'replacedTotal':0, 'replacedAnchor':-1, 'changedSnapshot':True})

    def test_real_worker_long_wildcard_can_be_cancelled_without_restart(self):
        self.load()
        self.page.wait_for_function("STATE.dataLoaded", timeout=30000)
        observed = self.page.evaluate('''async () => {
          await corpusWorkerRequest('replace-corpus', {data:{v:2,rp:['R'],fd:[[]],
            rc:Array.from({length:8000},(_,i)=>[0,'a'.repeat(150)+i,'txt',0,1,0])}});
          const {worker, restartCount: restarts}=getCorpusClient().inspect(), controller=new AbortController();
          const pending=doSearchLocal({q:'a?*'.repeat(60),exact:true,page:1,pageSize:100,signal:controller.signal})
            .then(()=> 'completed', error=>error.name);
          const metadata=await corpusWorkerRequest('metadata', {});
          controller.abort();
          return {cancelled:await pending,count:metadata.count,same:worker===getCorpusClient().inspect().worker,
            restarts:getCorpusClient().inspect().restartCount-restarts};
        }''')
        self.assertEqual(observed, {'cancelled':'AbortError', 'count':8000, 'same':True, 'restarts':0})

    def test_actual_worker_preserves_snapshot_after_rejected_corpus_load(self):
        self.context.close()
        self.context = self.browser.new_context(viewport={'width':1280,'height':800}, service_workers='block')
        self.page = self.context.new_page()
        self.page.route('https://voiceofml-search.hf.space/**', self.api_route)
        self.page.route('https://vomebook-hitokoto.hf.space/**',
            lambda route: route.fulfill(status=200, content_type='application/json', body='{}'))
        self.load()
        self.page.wait_for_function('STATE.dataLoaded', timeout=30000)
        corpus = {'v':2, 'rp':['VoiceOfML/Test'], 'fd':[[], [{'toString':None,'valueOf':None}]],
                  'rc':[[0,'new','txt',0,1,0], [0,'broken','txt',1,1,0]]}
        body = gzip.compress(json.dumps(corpus).encode(), mtime=0)
        self.page.route('**/search/bad-corpus.json.gz', lambda route: route.fulfill(
            status=200, content_type='application/gzip', body=body))
        observed = self.page.evaluate('''async () => {
          const before=await corpusWorkerRequest('local-search',{q:'',page:1,pageSize:2});
          const failed=await getCorpusClient().post('load-corpus',{url:new URL('bad-corpus.json.gz',location.href).href},10000)
            .then(()=>null,error=>error.code);
          const after=await corpusWorkerRequest('local-search',{q:'',page:1,pageSize:2});
          return {failed,before:before.snapshot_generation,after:after.snapshot_generation,
            beforeIds:before.ids,afterIds:after.ids,totalBefore:before.total,totalAfter:after.total};
        }''')
        self.assertEqual(observed['failed'], 'WORKER_ERROR')
        self.assertEqual(observed['before'], observed['after'])
        self.assertEqual(observed['beforeIds'], observed['afterIds'])
        self.assertEqual(observed['totalBefore'], observed['totalAfter'])

    def test_initial_to_local_handoff_preserves_render_and_scroll(self):
        with self.server_state.lock:
            self.server_state.delays["/search/data/search_data.json.gz"] = 1.0
        self.load()
        self.page.wait_for_function("STATE._initialActive === true")
        self.page.locator("#results-list .result-item").first.wait_for(timeout=10000)
        before = self.page.evaluate(
            """() => {
                const container = document.querySelector('#results-container');
                container.scrollTop = 180;
                return {first: document.querySelector('#results-list .result-item').innerText, scrollTop: container.scrollTop, total: STATE.total, count: STATE.results.length};
            }"""
        )
        self.page.wait_for_function("STATE.dataLoaded === true && STATE._initialActive === false", timeout=30000)
        after = self.page.evaluate(
            """() => ({
                first: document.querySelector('#results-list .result-item').innerText,
                scrollTop: document.querySelector('#results-container').scrollTop,
                total: STATE.total,
                count: STATE.results.length,
            })"""
        )
        self.assertEqual(after["first"], before["first"])
        self.assertEqual(after["scrollTop"], before["scrollTop"])
        self.assertEqual(after["total"], before["total"])
        self.assertEqual(after["count"], before["count"])

    def test_nonempty_local_startup_waits_for_worker_and_keeps_pages_local(self):
        with self.server_state.lock:
            self.server_state.delays["/search/data/search_data.json.gz"] = 1.0
        self.load("#/?q=手机")
        self.page.wait_for_function("STATE.dataLoaded && !STATE.isLoading && STATE._loadedPage === 1", timeout=30000)
        self.assertFalse(any(item.get("q") == "手机" for item in self.search_requests))
        self.assertTrue(self.page.evaluate("STATE.useLocalMode"))
        self.assertEqual(self.page.evaluate("STATE._resultBackend"), "local")
        expected = self.page.evaluate("async () => (await doSearchLocal({q:'手机', exact:STATE.exact, searchFolders:STATE.searchFolders, page:1, pageSize:STATE.pageSize})).results.map(getResultStableId)")
        self.assertEqual(self.page.evaluate("STATE.results.map(getResultStableId)"), expected)
        self.page.evaluate('''() => {
          // The paging controller owns its scheduling; suppress automatic
          // appends at the execution boundary while this test requests page 2.
          window.localStartupSearch = doSearch;
          doSearch = (...args) => { if (!args[0]) return localStartupSearch(...args); };
          STATE.pageSize = 2; doSearch();
        }''')
        self.page.wait_for_function("STATE._loadedPage === 1 && !STATE.isLoading")
        expected = self.page.evaluate("async () => (await doSearchLocal({q:'手机', exact:STATE.exact, searchFolders:STATE.searchFolders, page:1, pageSize:500})).results.map(getResultStableId)")
        self.page.evaluate('''() => {
          // Exercise the pinned backend independently of a UI toggle, which
          // starts a fresh view. Keep the current rows owned by this test view.
          STATE.useLocalMode = false;
          displayedSearchView.key = getSearchViewKey();
          STATE.page = 2; localStartupSearch(true);
        }''')
        self.page.wait_for_function("STATE._loadedPage >= 2 && !STATE.isLoading")
        actual = self.page.evaluate("STATE.results.map(getResultStableId)")
        self.assertEqual(self.page.evaluate('STATE._loadedPage'), 2)
        self.assertEqual(len(actual), 4)
        self.assertEqual(actual, expected[:len(actual)])
        # Also force an uncached append: page-two prefetch can otherwise bypass
        # the backend-choice branch after the local-mode preference changes.
        self.page.evaluate('''() => {
          cancelSearchPrefetch(); STATE._pageCache = {};
          STATE.page = 3; localStartupSearch(true);
        }''')
        self.page.wait_for_function("STATE._loadedPage === 3 && !STATE.isLoading")
        self.assertEqual(self.page.evaluate("STATE._resultBackend"), "local")
        self.assertEqual(self.page.evaluate("STATE.results.map(getResultStableId)"), expected[:6])
        self.assertFalse(any(item.get("q") == "手机" for item in self.search_requests))

    def test_api_pagination_stays_on_api_after_local_corpus_is_ready(self):
        self.search_response_override = {"page": 1, "page_size": 100, "total": 200,
                                         "results": [result(f"API-{i}") for i in range(100)]}
        self.load("#/?q=pin-test&local=0")
        self.page.wait_for_function("STATE._loadedPage === 1 && !STATE.isLoading")
        self.page.evaluate('''async () => {
          await ensureLocalDataLoaded(false, true);
          // Simulate a changed preference without starting a new search, so
          // page 2 must still use the backend that supplied these rows.
          STATE.useLocalMode = true;
          displayedSearchView.key = getSearchViewKey();
          cancelSearchPrefetch(); STATE._pageCache = {}; searchResponseStore.cache.clear();
        }''')
        self.search_response_override = {"page": 2, "page_size": 100, "total": 200,
                                         "results": [result(f"API-{i}") for i in range(100, 200)]}
        self.page.evaluate("STATE.page = 2; doSearch(true)")
        self.page.wait_for_function("STATE._loadedPage === 2 && !STATE.isLoading")
        self.assertEqual(self.page.evaluate("STATE.results.map(r => r.File)"), [f"API-{i}" for i in range(200)])

    def test_stalled_page_two_prefetch_does_not_block_local_corpus_loading(self):
        self.page.add_init_script(
            """(() => {
                const nativeFetch = window.fetch.bind(window);
                window.fetch = function(input, options) {
                    let body = {};
                    try { body = JSON.parse(options && options.body || '{}'); } catch (_) {}
                    if (String(input).includes('/api/search') && body.page === 2) {
                        return new Promise(() => {});
                    }
                    return nativeFetch(input, options);
                };
            })();"""
        )
        self.load()
        self.page.wait_for_function("searchPrefetchAbortController?.active.has(2)")
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.assertGreaterEqual(self.server_state.count("/search/data/search_data.json.gz"), 1)
        self.assertTrue(self.page.evaluate("searchPrefetchAbortController?.active.has(2)"))

    def hold_startup_positions(self):
        self.page.add_init_script('''(() => {
          const open = indexedDB.open.bind(indexedDB);
          const set = window.setTimeout;
          window.setTimeout = (callback, delay, ...args) => set(callback, delay === 1500 ? 5000 : delay, ...args);
          indexedDB.open = function(name, ...args) {
            const request = open(name, ...args);
            if (name !== 'voice-search-positions') return request;
            const proxy = {};
            for (const field of ['result','error','transaction','readyState'])
              Object.defineProperty(proxy, field, {get: () => request[field]});
            for (const field of ['onupgradeneeded','onerror','onblocked'])
              Object.defineProperty(proxy, field, {set: handler => { request[field] = handler; }});
            Object.defineProperty(proxy, 'onsuccess', {set: handler => {
              request.onsuccess = event => { window.__releasePositionOpen = () => handler(event); };
            }});
            return proxy;
          };
        })()''')

    def trace_startup_worker_messages(self):
        self.page.add_init_script('''(() => {
          window.__corpusMessages = [];
          const post = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function(message, ...rest) {
            if (message?.protocol === 1) window.__corpusMessages.push(message.type);
            return post.call(this, message, ...rest);
          };
        })()''')

    def test_local_startup_reuses_worker_without_loading_corpus_before_positions(self):
        self.hold_startup_positions()
        self.trace_startup_worker_messages()
        self.load('#/?q=手机&local=1')
        self.page.wait_for_function('typeof window.__releasePositionOpen === "function"')
        self.page.wait_for_function('''() => {
          const state = getCorpusClient().inspect();
          return state.worker && !state.starting;
        }''')
        self.assertEqual(self.page.evaluate('window.__corpusMessages'), ['handshake'])
        self.assertEqual(self.server_state.count('/search/data/search_data.json.gz'), 0)
        self.assertFalse(self.page.evaluate('routeInitialized'))
        self.assertEqual(self.page.locator('#results-list .result-item').count(), 0)
        self.page.evaluate('window.__startupCorpusWorker = getCorpusClient().inspect().worker; window.__releasePositionOpen()')
        self.page.locator('#results-list .result-item').first.wait_for()
        self.assertEqual(self.page.evaluate('STATE._resultBackend'), 'local')
        self.assertTrue(self.page.evaluate('window.__startupCorpusWorker === getCorpusClient().inspect().worker'))
        messages = self.page.evaluate('window.__corpusMessages')
        self.assertEqual(messages[:3], ['handshake', 'load-corpus', 'local-search'])
        self.assertEqual(messages.count('handshake'), 1)
        self.assertEqual(messages.count('load-corpus'), 1)
        self.assertEqual(self.search_requests, [])

    def test_local_startup_waits_to_start_worker_with_save_data(self):
        self.hold_startup_positions()
        self.trace_startup_worker_messages()
        self.page.add_init_script("Object.defineProperty(navigator, 'connection', {value:{saveData:true}})")
        self.load('#/?q=手机')
        self.page.wait_for_function('typeof window.__releasePositionOpen === "function"')
        self.assertEqual(self.page.evaluate('window.__corpusMessages'), [])
        self.page.evaluate('window.__releasePositionOpen()')
        self.page.locator('#results-list .result-item').first.wait_for()
        self.assertEqual(self.page.evaluate('STATE._resultBackend'), 'local')

    def test_local_startup_worker_failure_retains_normal_loading_path(self):
        self.hold_startup_positions()
        self.page.add_init_script('''(() => {
          const NativeWorker = window.Worker;
          window.__corpusWorkerAttempts = 0;
          window.Worker = class extends NativeWorker {
            constructor(url, options) {
              if (String(url).endsWith('/index-worker.js') && ++window.__corpusWorkerAttempts === 1)
                throw new Error('Transient Worker construction failure');
              super(url, options);
            }
          };
        })()''')
        self.load('#/?q=手机')
        self.page.wait_for_function('typeof window.__releasePositionOpen === "function" && window.__corpusWorkerAttempts === 1')
        self.assertFalse(self.page.evaluate('!!getCorpusClient().inspect().worker'))
        self.page.evaluate('window.__releasePositionOpen()')
        self.page.locator('#results-list .result-item').first.wait_for()
        self.assertEqual(self.page.evaluate('window.__corpusWorkerAttempts'), 2)
        self.assertEqual(self.page.evaluate('STATE._resultBackend'), 'local')

    def test_local_startup_worker_does_not_own_new_url(self):
        self.hold_startup_positions()
        self.trace_startup_worker_messages()
        self.load('#/?q=old')
        self.page.wait_for_function('typeof window.__releasePositionOpen === "function" && window.__corpusMessages.includes("handshake")')
        self.page.evaluate('''() => {
          location.hash = '#/?q=new-api&local=0';
          addEventListener('hashchange', () => window.__releasePositionOpen(), {once:true});
        }''')
        self.page.locator('#results-list').get_by_text('new-api result').wait_for()
        self.assertEqual([body.get('q') for body in self.search_requests], ['new-api'])
        self.assertNotIn('local-search', self.page.evaluate('window.__corpusMessages'))

    def test_explicit_search_acquires_page_one_before_positions_without_rendering_early(self):
        self.hold_startup_positions()
        self.page.add_init_script("sessionStorage.setItem('voml_ext_filter:global', JSON.stringify({values:['pdf']}))")
        with self.page.expect_response(lambda response: response.request.method == 'POST' and
                                       '/api/search' in response.url) as fetched:
            self.load('#/?q=first&local=0&max_size=20')
        self.assertIsNone(fetched.value.finished())
        self.page.wait_for_function('typeof window.__releasePositionOpen === "function"')
        self.assertFalse(self.page.evaluate('routeInitialized'))
        self.assertEqual(self.page.locator('#results-list .result-item').count(), 0)
        self.page.evaluate('window.__releasePositionOpen()')
        self.page.locator('#results-list').get_by_text('first result').wait_for()
        self.assertEqual(self.search_requests, [{'page':1, 'page_size':100, 'q':'first', 'extensions':['pdf'],
                                                 'max_size':20, 'sort':'relevance', 'exact':True}])

    def test_startup_search_does_not_speculate_with_save_data(self):
        self.hold_startup_positions()
        self.page.add_init_script("Object.defineProperty(navigator,'connection',{value:{saveData:true}})")
        self.load('#/?q=save-data&local=0')
        self.page.wait_for_function('typeof window.__releasePositionOpen === "function"')
        self.assertEqual(self.search_requests, [])
        self.page.evaluate('window.__releasePositionOpen()')
        self.page.locator('#results-list').get_by_text('save-data result').wait_for()
        self.assertEqual([body.get('q') for body in self.search_requests], ['save-data'])

    def test_pending_startup_search_is_adopted_without_another_post(self):
        self.hold_startup_positions()
        held = []
        self.page.route('**/api/search', lambda route: held.append(route))
        with self.page.expect_request(lambda request: request.method == 'POST' and '/api/search' in request.url):
            self.load('#/?q=pending&local=0')
        self.page.wait_for_function('typeof window.__releasePositionOpen === "function"')
        self.page.evaluate('window.__releasePositionOpen()')
        self.page.wait_for_function('routeInitialized && STATE.isLoading')
        self.assertEqual(len(held), 1)
        self.api_route(held[0])
        self.page.locator('#results-list').get_by_text('pending result').wait_for()
        self.assertEqual(len(held), 1)

    def test_startup_search_does_not_reuse_response_after_url_changes_away_and_back(self):
        self.hold_startup_positions()
        with self.page.expect_response(lambda response: response.request.method == 'POST' and
                                       '/api/search' in response.url) as fetched:
            self.load('#/?q=first&local=0')
        self.assertIsNone(fetched.value.finished())
        self.page.wait_for_function('typeof window.__releasePositionOpen === "function"')
        self.page.evaluate('''async () => {
          const original = location.hash;
          for (const hash of ['#/?q=next&local=0', original]) {
            const changed = new Promise(resolve => addEventListener('hashchange', resolve, {once:true}));
            location.hash = hash;
            await changed;
          }
        }''')
        self.search_response_override = {"page":1, "page_size":100, "total":1, "results":[result('fresh first')]}
        self.page.evaluate('window.__releasePositionOpen()')
        self.page.locator('#results-list').get_by_text('fresh first').wait_for()
        self.assertEqual([body.get('q') for body in self.search_requests], ['first', 'first'])

    def test_local_disabled_sends_complete_api_body_and_renders_response(self):
        self.load("#/?q=body-query&local=0&ext=pdf&sort=size&search_folders=false&exact=0&min_size=10&max_size=20")
        self.page.locator("#results-list").get_by_text("body-query result").wait_for(timeout=10000)
        body = next(item for item in self.search_requests if item.get("q") == "body-query" and item.get("page") == 1)
        self.assertEqual(body["page_size"], 100)
        self.assertEqual(body["extensions"], ["pdf"])
        self.assertEqual(body["sort"], "size")
        self.assertEqual(body["min_size"], 10)
        self.assertEqual(body["max_size"], 20)
        self.assertFalse(body["search_folders"])
        self.assertNotIn("exact", body)
        self.assertIn("local=0", self.page.evaluate("location.hash"))

    def test_delayed_stale_api_response_cannot_replace_newer_query(self):
        self.page.add_init_script(
            """(() => {
                const nativeFetch = window.fetch.bind(window);
                window.fetch = async function(input, options) {
                    const response = await nativeFetch(input, options);
                    let body = {};
                    try { body = JSON.parse(options && options.body || '{}'); } catch (_) {}
                    if (String(input).includes('/api/search') && body.q === 'old-query') {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    return response;
                };
            })();"""
        )
        self.load("#/?local=0")
        search = self.page.locator("#search-input")
        search.fill("old-query")
        self.page.wait_for_timeout(180)
        search.fill("new-query")
        self.page.locator("#results-list").get_by_text("new-query result").wait_for(timeout=10000)
        self.page.wait_for_timeout(700)
        text = self.page.locator("#results-list").inner_text()
        self.assertIn("new-query result", text)
        self.assertNotIn("old-query result", text)
        self.assertTrue(any(body.get("q") == "old-query" for body in self.search_requests))
        self.assertTrue(any(body.get("q") == "new-query" for body in self.search_requests))

    def test_stale_prefetch_failure_does_not_trip_current_api_circuit(self):
        self.page.add_init_script(
            """(() => {
                const nativeFetch = window.fetch.bind(window);
                window.__stalePrefetchSettled = false;
                window.__releaseStalePrefetch = null;
                window.fetch = function(input, options) {
                    let body = {};
                    try { body = JSON.parse(options && options.body || '{}'); } catch (_) {}
                    if (String(input).includes('/api/search') && body.page === 2) {
                        return new Promise((resolve, reject) => {
                            window.__releaseStalePrefetch = () => {
                                window.__stalePrefetchSettled = true;
                                reject(new Error('stale prefetch failure'));
                            };
                        });
                    }
                    return nativeFetch(input, options);
                };
            })();"""
        )
        self.load("#/?local=0")
        self.page.wait_for_function("searchPrefetchAbortController?.active.has(2) && window.__releaseStalePrefetch !== null")
        search = self.page.locator("#search-input")
        search.fill("current-query")
        self.page.locator("#results-list").get_by_text("current-query result").wait_for(timeout=10000)
        self.page.evaluate("window.__releaseStalePrefetch()")
        self.page.wait_for_function("window.__stalePrefetchSettled && apiFailureCount === 0")
        self.assertTrue(self.page.evaluate("apiAvailable"))

    def assert_invalid_search_response_falls_back(self, payload, query):
        self.load("#/?local=0")
        self.page.wait_for_function("STATE._initialActive === true")
        self.page.evaluate(
            """() => {
                window.__apiFailureCalls = 0;
                const original = noteApiFailure;
                noteApiFailure = function() {
                    window.__apiFailureCalls += 1;
                    return original();
                };
            }"""
        )
        self.search_response_override = payload
        self.page.locator("#search-input").fill(query)
        self.page.wait_for_function("window.__apiFailureCalls > 0", timeout=10000)
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.page.wait_for_function("STATE.useLocalMode === true", timeout=10000)
        self.assertIsInstance(self.page.evaluate("STATE.results"), list)
        self.assertIsInstance(self.page.evaluate("STATE.total"), int)
        self.assertTrue(self.page.evaluate(
            "Array.from(searchResponseStore.cache.values()).every(entry => entry.data && Array.isArray(entry.data.results))"
        ))

    def test_fractional_total_uses_unified_api_failure_fallback(self):
        self.assert_invalid_search_response_falls_back(
            {"page": 1, "page_size": 100, "total": 1.5, "results": [result("fractional")]},
            "fractional-total",
        )

    def test_null_result_uses_unified_api_failure_fallback(self):
        self.assert_invalid_search_response_falls_back(
            {"page": 1, "page_size": 100, "total": 1, "results": [None]},
            "null-result",
        )

    def test_wrong_page_uses_unified_api_failure_fallback(self):
        self.assert_invalid_search_response_falls_back(
            {"page": 2, "page_size": 100, "total": 1, "results": [result("wrong-page")]},
            "wrong-page",
        )

    def test_wrong_page_size_uses_unified_api_failure_fallback(self):
        self.assert_invalid_search_response_falls_back(
            {"page": 1, "page_size": 20, "total": 1, "results": [result("wrong-page-size")]},
            "wrong-page-size",
        )

    def test_runtime_header_logo_stays_inside_search_prefix(self):
        self.load("#/?local=0")
        self.assertEqual(self.page.locator("#header-logo").get_attribute("href"), "/search/")
        self.page.evaluate("location.hash = '#/VOMEBOOK?local=0'")
        self.page.wait_for_function("STATE.mode === 'repo'")
        self.assertEqual(self.page.locator("#header-logo").get_attribute("href"), "/search/")

    def test_local_disabled_empty_query_keeps_intentional_initial_payload(self):
        self.load("#/?local=0")
        self.page.wait_for_function("STATE._initialActive === true")
        self.page.locator("#results-list .result-item").first.wait_for(timeout=10000)
        self.assertFalse(self.page.evaluate("STATE.useLocalMode"))
        self.assertGreater(self.page.evaluate("STATE.results.length"), 0)
        self.assertFalse(any(body.get("page") == 1 for body in self.search_requests))

    def test_inflight_prefetch_reuses_the_same_promise(self):
        self.load("#/?local=0")
        self.page.wait_for_function("STATE._initialActive === true")
        reused = self.page.evaluate(
            """async () => {
                if (searchPrefetchAbortController) searchPrefetchAbortController.abort();
                searchPrefetchAbortController = null;
                STATE._loadedPage = 1;
                STATE.total = Math.max(STATE.total, STATE.pageSize * 3);
                STATE._pageCache = {};
                searchResponseStore.cache.clear();
                let calls = 0;
                const nativeFetch = window.fetch;
                window.fetch = function(_input, options) {
                    calls += 1;
                    return new Promise((_resolve, reject) => {
                        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                    });
                };
                const first = prefetchNextPage();
                const second = prefetchNextPage();
                const result = first === second && calls === 2;
                searchPrefetchAbortController.abort();
                await first;
                window.fetch = nativeFetch;
                return result;
            }"""
        )
        self.assertTrue(reused)

    def test_three_failures_open_circuit_and_fast_probe_recovers(self):
        self.page.add_init_script(
            """(() => {
                const nativeSetTimeout = window.setTimeout.bind(window);
                window.setTimeout = (fn, delay, ...args) => {
                    if (delay !== 30000) return nativeSetTimeout(fn, delay, ...args);
                    const id = nativeSetTimeout(fn, delay, ...args);
                    window.releaseApiProbe = () => { clearTimeout(id); fn(...args); };
                    return id;
                };
            })();"""
        )
        self.load()
        self.page.wait_for_function("STATE.dataLoaded && STATE.useLocalMode && !STATE.isLoading && STATE._loadedPage > 0", timeout=30000)
        self.page.wait_for_load_state("networkidle")
        self.page.evaluate("apiFailureCount = 0; apiAvailable = true")
        baseline_probes = self.probe_requests
        self.search_failures = True
        search = self.page.locator("#search-input")
        for count, query in enumerate(["failure-one", "failure-two", "failure-three"], 1):
            # Finish the local query first: a mode change can cancel a pending input debounce.
            search.fill(query)
            self.page.wait_for_function(
                "query => STATE.query === query && STATE.useLocalMode && STATE._resultBackend === 'local' && !STATE.isLoading",
                arg=query, timeout=30000)
            with self.page.expect_response(
                lambda response: response.request.method == "POST" and "/api/search" in response.url
                and (response.request.post_data_json or {}).get("q") == query, timeout=30000
            ) as response_info:
                self.page.locator("#local-mode-toggle").evaluate(
                    "el => { el.checked = false; el.dispatchEvent(new Event('change', {bubbles: true})); }"
                )
            self.assertEqual(response_info.value.status, 503)
            self.page.wait_for_function(
                "query => STATE.query === query && STATE.useLocalMode && !STATE.isLoading", arg=query, timeout=30000)
            self.assertEqual(self.page.evaluate("apiFailureCount"), count)
        self.assertFalse(self.page.evaluate("apiAvailable"))
        self.page.wait_for_function("typeof window.releaseApiProbe === 'function'")
        self.search_failures = False
        self.page.evaluate("window.releaseApiProbe()")
        self.page.wait_for_function("apiAvailable === true", timeout=10000)
        self.assertGreater(self.probe_requests, baseline_probes)
        self.assertEqual(self.page.evaluate("apiFailureCount"), 0)

    def test_failed_waiters_share_real_bootstrap_and_ignore_retired_worker_events(self):
        self.load()
        self.page.wait_for_function("STATE.dataLoaded", timeout=30000)
        observed = self.page.evaluate("""async () => {
          const {worker: old, restartCount: before} = getCorpusClient().inspect();
          old.postMessage = () => {};
          const a = corpusWorkerRequest('metadata', {});
          const b = corpusWorkerRequest('folder-tree', {repo:'VoiceOfML/VOMEBOOK'});
          await Promise.resolve();
          old.dispatchEvent(new ErrorEvent('error', {message:'controlled failure'}));
          for (let i=0;i<5;i++) await Promise.resolve();
          const replacement = getCorpusClient().inspect().worker;
          old.dispatchEvent(new MessageEvent('messageerror'));
          const [metadata, tree] = await Promise.all([a,b]);
          return {count:metadata.count, hasTree:!!tree.tree,
            same:replacement===getCorpusClient().inspect().worker, replaced:old!==replacement,
            restarts:getCorpusClient().inspect().restartCount-before, pending:getCorpusClient().inspect().pending.length};
        }""")
        self.assertGreater(observed.pop('count'), 0)
        self.assertEqual(observed, {'hasTree': True, 'same': True, 'replaced': True,
                                    'restarts': 1, 'pending': 0})

    def test_abort_while_real_replacement_bootstrap_waits_does_not_retry_search(self):
        self.load()
        self.page.wait_for_function("STATE.dataLoaded", timeout=30000)
        observed = self.page.evaluate("""async () => {
          const NativeWorker = window.Worker, old = getCorpusClient().inspect().worker;
          let release, entered;
          const bootstrapEntered = new Promise(resolve => { entered = resolve; });
          const posted = [];
          window.Worker = class extends NativeWorker {
            postMessage(message) {
              posted.push(message.type);
              if (message.type === 'load-corpus') {
                release = () => super.postMessage(message);
                entered();
              } else super.postMessage(message);
            }
          };
          try {
            old.postMessage = () => {};
            const controller = new AbortController();
            const stale = corpusWorkerRequest('local-search', {q:'alpha'}, 10000, controller.signal)
              .then(()=>'unexpected success', error=>error.name);
            const current = corpusWorkerRequest('metadata', {});
            await Promise.resolve();
            old.dispatchEvent(new ErrorEvent('error', {message:'controlled failure'}));
            await bootstrapEntered;
            controller.abort();
            release();
            const [cancelled, metadata] = await Promise.all([stale, current]);
            return {cancelled, count:metadata.count,
              bootstraps:posted.filter(type=>type==='load-corpus').length,
              searches:posted.filter(type=>type==='local-search').length,
              pending:getCorpusClient().inspect().pending.length};
          } finally { window.Worker = NativeWorker; }
        }""")
        self.assertGreater(observed.pop('count'), 0)
        self.assertEqual(observed, {'cancelled':'AbortError', 'bootstraps':1,
                                    'searches':0, 'pending':0})

    def test_separate_worker_failures_each_get_one_bounded_restart(self):
        self.load()
        self.page.wait_for_function('STATE.dataLoaded', timeout=30000)
        result = self.page.evaluate('''async () => {
          const {worker: first, restartCount: before}=getCorpusClient().inspect();
          getCorpusClient().terminate(VoiceOfMLCorpusClient.makeWorkerError('WORKER_TERMINATED','injected'));
          const a=await corpusWorkerRequest('metadata', {});
          const second=getCorpusClient().inspect().worker;
          getCorpusClient().terminate(VoiceOfMLCorpusClient.makeWorkerError('WORKER_TERMINATED','injected'));
          const b=await corpusWorkerRequest('metadata', {});
          return {counts:[a.count,b.count], restarts:getCorpusClient().inspect().restartCount-before,
            workersDistinct:first!==second && second!==getCorpusClient().inspect().worker,
            consecutive:getCorpusClient().inspect().consecutiveRestarts};
        }''')
        self.assertGreater(result['counts'][0], 0)
        self.assertEqual(result['counts'][0], result['counts'][1])
        self.assertEqual(result['restarts'], 2)
        self.assertTrue(result['workersDistinct'])
        self.assertEqual(result['consecutive'], 0)

    def test_worker_failure_restarts_once_then_uses_api_fallback(self):
        self.page.add_init_script(
            """(() => {
                window.Worker = class BrokenWorker {
                    constructor() { this.listeners = {}; }
                    addEventListener(type, listener) { this.listeners[type] = listener; }
                    postMessage() {
                        setTimeout(() => {
                            if (this.listeners.error) this.listeners.error({message: 'injected worker failure'});
                        }, 0);
                    }
                    terminate() {}
                };
            })();"""
        )
        self.load("#/?q=worker-failure")
        self.page.locator("#results-list").get_by_text("worker-failure result").wait_for(timeout=10000)
        self.page.wait_for_function("STATE.useLocalMode === false", timeout=30000)
        self.assertTrue(any(body.get("q") == "worker-failure" for body in self.search_requests))
        self.assertEqual(self.page.evaluate("getCorpusClient().inspect().restartCount"), 1)
        self.assertFalse(self.page.evaluate("STATE.dataLoaded"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

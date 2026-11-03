"""Worker choice when a bounded history wait expires before the prefix arrives."""
import json
import unittest

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from tests import test_reader_pdf_first_page as support


class PdfHistoryRaceTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFirstPageTests.setUpClass.__func__)
    open = support.PdfFirstPageTests.open

    def suppress_ordinary_worker_handshake(self, page, include_staged=False):
        # Hold the first range until the real ordinary Worker has emitted its
        # ready message. PDF.js never receives that message, deterministically
        # reproducing a stalled preloader without changing PDF.js or the worker.
        page.add_init_script("""(()=>{
          const Native=window.Worker, nativeFetch=window.fetch;
          window.__ordinaryWorkers=[]; window.__stagedWorkers=[];
          let release;
          const ready=new Promise(resolve=>release=resolve);
          window.Worker=class extends Native {
            constructor(url,options) {
              super(url,options);
              const staged=new URL(String(url),location.href).searchParams.has('reader-first-page');
              if (!String(url).includes('pdf-worker-wrapper') || (staged && !INCLUDE_STAGED)) return;
              const info={url:String(url),messages:0,terminated:0};
              (staged ? window.__stagedWorkers : window.__ordinaryWorkers).push(info);
              const add=this.addEventListener.bind(this), terminate=this.terminate.bind(this);
              this.addEventListener=(type,listener,options)=>type==='message'
                ? add(type,event=>{info.messages++; if(!staged && event.data?.action==='ready') release();},options)
                : add(type,listener,options);
              this.terminate=()=>{info.terminated++; return terminate();};
            }
          };
          window.fetch=async (input,init)=>{
            if (String(input).includes('/api/reader-content?')) await ready;
            return nativeFetch(input,init);
          };
        })();""".replace('INCLUDE_STAGED', 'true' if include_staged else 'false'))

    def fail_first_range_once(self, page):
        # Keep the route installed while retries begin. Removing a times=1
        # interceptor concurrently with a fast retry can strand that retry in
        # the test harness before it reaches the local server.
        attempts = []
        def handle(route):
            attempts.append(route.request.headers.get('range'))
            if len(attempts) == 1:
                route.fulfill(status=503, body='temporary')
            else:
                route.continue_()
        page.route('**/api/reader-content?**', handle)
        return attempts

    def test_stalled_ordinary_worker_does_not_block_verified_first_page(self):
        with support.range_source(support.sparse_pdf(root_at_end=True)) as (source, state, lock):
            state['block_from'] = 1024 * 1024
            context = self.browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
            try:
                page = context.new_page()
                self.suppress_ordinary_worker_handshake(page)
                workers, responses, errors = [], [], []
                page.on('request', lambda request: workers.append(request.url)
                        if 'pdf-worker-wrapper' in request.url else None)
                page.on('response', lambda response: responses.append(response.status)
                        if '/api/reader-content?' in response.url else None)
                page.on('pageerror', lambda error: errors.append(str(error)))
                attempts = self.fail_first_range_once(page)
                self.open(page, source)
                try:
                    page.wait_for_function('()=>window.__ordinaryWorkers?.[0]?.messages >= 1', timeout=10000)
                    page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=10000)
                except PlaywrightTimeoutError as error:
                    # Preserve the original timeout and enough synthetic fixture
                    # state to distinguish a Worker, range, or rendering stall.
                    try:
                        snapshot = page.evaluate('''() => ({phase:document.documentElement.dataset.readerPhase,
                          status:document.querySelector('#status')?.textContent,
                          code:document.querySelector('#content')?.dataset.errorCode,
                          ordinary:window.__ordinaryWorkers, staged:window.__stagedWorkers,
                          previews:document.querySelectorAll('.reader-page[data-preview-ready="1"]').length,
                          canvases:document.querySelectorAll('.reader-page canvas.ready').length})''')
                        with lock:
                            ranges = list(state['requests'])
                        error.add_note('PDF race diagnostics: ' + json.dumps(dict(
                            snapshot=snapshot, workers=workers, responses=responses,
                            attempts=attempts, ranges=ranges, page_errors=errors), ensure_ascii=False))
                    except Exception as diagnostic_error:
                        error.add_note(f'PDF race diagnostics unavailable: {diagnostic_error!r}')
                    raise
                ordinary = page.evaluate('window.__ordinaryWorkers')
                self.assertEqual(len(ordinary), 1, ordinary)
                self.assertGreaterEqual(ordinary[0]['messages'], 1, ordinary)
                self.assertEqual(ordinary[0]['terminated'], 1, ordinary)
                self.assertTrue(any('reader-first-page=1' in url for url in workers), workers)
                self.assertEqual(responses[:2], [503, 206], responses)
                self.assertGreaterEqual(len(attempts), 2, attempts)
                self.assertNotEqual(page.locator('html').get_attribute('data-reader-phase'), 'ready')
                state['block'].set()
                page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'", timeout=30000)
                self.assertEqual(page.locator('#page-number').get_attribute('max'), '130')
                self.assertEqual(errors, [])
            finally:
                state['block'].set()
                context.close()

    def test_unresolved_history_and_stalled_worker_fail_without_preview(self):
        with support.range_source(support.sparse_pdf(root_at_end=True)) as (source, state, _lock):
            state['block'].set()
            context = self.browser.new_context(service_workers='block')
            try:
                page = context.new_page()
                self.suppress_ordinary_worker_handshake(page)
                page.add_init_script("""(()=>{const native=window.setTimeout.bind(window);
                  window.__releaseWorkerDeadline = null;
                  window.setTimeout=(fn,ms,...args)=>{
                    if (ms===20000 && !window.__releaseWorkerDeadline) {
                      const handle=native(fn,ms,...args);
                      window.__releaseWorkerDeadline=()=>{clearTimeout(handle);native(fn,0,...args);};
                      return handle;
                    }
                    return native(fn,ms===5000?100:ms===20000?350:ms===500?10:ms===1000?20:ms,...args);
                  };
                })();""")
                page.route('**/static/reader/core/reader-store.js*', lambda route: route.fulfill(
                    content_type='text/javascript', body="""
                      window.VoiceOfMLReaderStore={get:()=>new Promise(()=>{}),put:async()=>{},list:async()=>[],
                        listBookmarks:async()=>[],listAllBookmarks:async()=>[],removeBookmark:async()=>{}};
                    """))
                workers = []
                page.on('request', lambda request: workers.append(request.url)
                        if 'pdf-worker-wrapper' in request.url else None)
                self.open(page, source)
                page.wait_for_function('''()=>window.__ordinaryWorkers?.[0]?.messages >= 1 &&
                  typeof window.__releaseWorkerDeadline === 'function' ''', timeout=15000)
                page.evaluate('window.__releaseWorkerDeadline()')
                page.locator('#reader-engine-retry').wait_for(timeout=10000)
                self.assertEqual(page.locator('#content').get_attribute('data-error-code'), 'READER_ENGINE_NETWORK')
                self.assertEqual(page.locator('.reader-page[data-preview-ready="1"]').count(), 0)
                self.assertFalse(any('reader-first-page=1' in url for url in workers), workers)
                ordinary = page.evaluate('window.__ordinaryWorkers')
                self.assertEqual(len(ordinary), 3, ordinary)
                self.assertTrue(any(item['messages'] for item in ordinary), ordinary)
                self.assertTrue(all(item['terminated'] == 1 for item in ordinary), ordinary)
            finally:
                context.close()

    def test_stalled_staged_worker_still_reports_engine_failure(self):
        with support.range_source(support.sparse_pdf(root_at_end=True)) as (source, state, _lock):
            state['block_from'] = 1024 * 1024
            context = self.browser.new_context(service_workers='block')
            try:
                page = context.new_page()
                self.suppress_ordinary_worker_handshake(page, include_staged=True)
                page.add_init_script("""(()=>{const native=window.setTimeout.bind(window);
                  window.setTimeout=(fn,ms,...args)=>native(fn,ms===20000?3000:ms,...args);
                })();""")
                self.open(page, source)
                page.locator('#reader-engine-retry').wait_for(timeout=20000)
                self.assertEqual(page.locator('#content').get_attribute('data-error-code'), 'READER_ENGINE_NETWORK')
                self.assertEqual(page.locator('.reader-page[data-preview-ready="1"]').count(), 0)
                ordinary, staged = page.evaluate('[window.__ordinaryWorkers,window.__stagedWorkers]')
                self.assertEqual(len(ordinary), 3, ordinary)
                self.assertEqual(len(staged), 1, staged)
                self.assertTrue(any(item['messages'] for item in ordinary), ordinary)
                self.assertGreaterEqual(staged[0]['messages'], 1, staged)
                self.assertTrue(all(item['terminated'] == 1 for item in ordinary + staged), (ordinary, staged))
            finally:
                state['block'].set()
                context.close()

    def test_deep_history_retries_the_stalled_ordinary_worker(self):
        with support.range_source(support.sparse_pdf(count=30, stride=310000, root_at_end=True,
                                                     parent_id=200, inline_resources=True)) as (source, state, _lock):
            state['block'].set()
            context = self.browser.new_context(service_workers='block')
            try:
                page = context.new_page()
                self.suppress_ordinary_worker_handshake(page)
                page.add_init_script("""(()=>{const native=window.setTimeout.bind(window);
                  window.setTimeout=(fn,ms,...args)=>native(fn,
                    ms===20000?500:ms===500?10:ms===1000?20:ms,...args);
                })();""")
                page.route('**/static/reader/core/reader-store.js*', lambda route: route.fulfill(
                    content_type='text/javascript', body="""
                      window.VoiceOfMLReaderStore={get:async()=>({page:20,pageCount:30,zoom:100}),
                        put:async()=>{},list:async()=>[],listBookmarks:async()=>[],
                        listAllBookmarks:async()=>[],removeBookmark:async()=>{}};
                    """))
                workers = []
                page.on('request', lambda request: workers.append(request.url)
                        if 'pdf-worker-wrapper' in request.url else None)
                self.open(page, source)
                page.locator('#reader-engine-retry').wait_for(timeout=10000)
                self.assertEqual(page.locator('#content').get_attribute('data-error-code'), 'READER_ENGINE_NETWORK')
                self.assertEqual(page.locator('.reader-page[data-preview-ready="1"]').count(), 0)
                self.assertFalse(any('reader-first-page=1' in url for url in workers), workers)
                ordinary = page.evaluate('window.__ordinaryWorkers')
                self.assertEqual(len(ordinary), 3, ordinary)
                self.assertTrue(any(item['messages'] for item in ordinary), ordinary)
                self.assertTrue(all(item['terminated'] == 1 for item in ordinary), ordinary)
            finally:
                context.close()

    def test_disposal_terminates_stalled_preload_before_range_selection(self):
        with support.range_source(support.sparse_pdf(root_at_end=True)) as (source, state, _lock):
            context = self.browser.new_context(service_workers='block')
            try:
                page = context.new_page()
                self.suppress_ordinary_worker_handshake(page)
                held = []
                page.route('**/api/reader-content?**', lambda route: held.append(route))
                self.open(page, source)
                page.wait_for_function('()=>window.__ordinaryWorkers?.[0]?.messages >= 1', timeout=10000)
                page.evaluate("()=>window.dispatchEvent(new Event('voice-reader-dispose'))")
                page.wait_for_function('()=>window.__ordinaryWorkers?.[0]?.terminated === 1', timeout=5000)
                self.assertEqual(len(page.evaluate('window.__ordinaryWorkers')), 1)
                self.assertEqual(page.locator('.reader-page[data-preview-ready="1"]').count(), 0)
                for route in held:
                    route.abort()
            finally:
                state['block'].set()
                context.close()

    def hold_ordinary_worker_and_history(self, page):
        # Pause the real ready event, rather than using elapsed time as proof of
        # a stalled Worker. The ordinary Worker can later resume unchanged.
        page.add_init_script('''(() => {
          const Native=window.Worker, nativeFetch=window.fetch;
          window.__ordinaryWorkers=[];
          let releaseRange;
          const ready=new Promise(resolve=>releaseRange=resolve);
          window.Worker=class extends Native {
            constructor(url, options) {
              super(url, options);
              if (!String(url).includes('pdf-worker-wrapper')) return;
              if (new URL(String(url),location.href).searchParams.has('reader-first-page')) {
                window.__stagedWorkerStarted=true;
                return;
              }
              const info={messages:0,terminated:0,held:true};
              window.__ordinaryWorkers.push(info);
              const add=this.addEventListener.bind(this), terminate=this.terminate.bind(this), pending=[];
              this.addEventListener=(type,listener,opts)=>type==='message'
                ? add(type,event=>{
                    info.messages++;
                    if (event.data?.action==='ready') releaseRange();
                    if (info.held) pending.push(()=>listener.call(this,event));
                    else listener.call(this,event);
                  },opts) : add(type,listener,opts);
              this.terminate=()=>{info.terminated++;return terminate();};
              window.__resumeOrdinary=()=>{info.held=false;for (const forward of pending.splice(0)) forward();};
            }
          };
          window.fetch=async (input,init)=>{
            if (String(input).includes('/api/reader-content?')) await ready;
            return nativeFetch(input,init);
          };
        })();''')
        page.route('**/static/reader/core/reader-store.js*', lambda route: route.fulfill(
            content_type='text/javascript', body='''
              window.VoiceOfMLReaderStore={
                get:()=>new Promise((resolve,reject)=>{
                  window.__finishHistory=resolve;window.__failHistory=reject;
                }),put:async()=>{},list:async()=>[],listBookmarks:async()=>[],
                listAllBookmarks:async()=>[],removeBookmark:async()=>{}
              };
            '''))

        def instrument_engine(route):
            script = route.fetch().text()
            hooks = {
                'timer = setTimeout(() => resolve(null), 5000)':
                    'timer = setTimeout(() => {window.__historyExpired=true;resolve(null);}, 50)',
                'saved ||= settledRestoration;':
                    'saved ||= settledRestoration;window.__selectionReached=true;',
                'return workerPreload;':
                    'window.__ordinarySelected=true;return workerPreload;',
            }
            for before, after in hooks.items():
                if script.count(before) != 1:
                    raise AssertionError(f'expected one PDF selection hook: {before}')
                script = script.replace(before, after)
            route.fulfill(content_type='text/javascript', body=script)

        page.route('**/static/reader/pdf/reader-pdf-engine.mjs*', instrument_engine)
        return self.fail_first_range_once(page)

    def test_late_fresh_history_can_supersede_stalled_ordinary_worker(self):
        with support.range_source(support.sparse_pdf(root_at_end=True)) as (source, state, _lock):
            state['block_from'] = 1024 * 1024
            context = self.browser.new_context(viewport={'width':390,'height':844}, service_workers='block')
            try:
                page = context.new_page(); errors = []; workers = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('request', lambda request: workers.append(request.url)
                        if 'pdf-worker-wrapper' in request.url else None)
                attempts = self.hold_ordinary_worker_and_history(page)
                self.open(page, source)
                page.wait_for_function('''()=>window.__historyExpired && window.__selectionReached &&
                  window.__ordinaryWorkers?.[0]?.messages && window.__finishHistory''', timeout=15000)
                self.assertGreaterEqual(len(attempts), 2, attempts)
                self.assertEqual(page.locator('.reader-page[data-preview-ready="1"]').count(), 0)
                page.evaluate('window.__finishHistory(null)')
                page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=10000)
                self.assertEqual(page.evaluate('window.__ordinaryWorkers[0].terminated'), 1)
                self.assertTrue(any('reader-first-page=1' in url for url in workers), workers)
                self.assertEqual(page.locator('#page-total').text_content(), '')
                self.assertNotEqual(page.locator('html').get_attribute('data-reader-phase'), 'ready')
                self.assertTrue(page.locator('#bookmark-ribbon').is_disabled())
                page.wait_for_function('''()=>document.querySelector('.reader-pdf-opening .reader-pdf-text')?.textContent.includes('Page 1')''')
                state['block'].set()
                page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'", timeout=30000)
                self.assertEqual(page.locator('#page-number').get_attribute('max'), '130')
                self.assertEqual(errors, [])
            finally:
                state['block'].set()
                context.close()

    def test_late_non_candidate_history_resumes_ordinary_worker(self):
        for history in ({'page':20,'pageCount':30,'zoom':100}, 'failed'):
            payload = support.sparse_pdf(count=30, stride=310000, root_at_end=True,
                                         parent_id=200, inline_resources=True)
            with self.subTest(history=history), support.range_source(payload) as (source, state, _lock):
                state['block'].set()
                context = self.browser.new_context(service_workers='block')
                try:
                    page = context.new_page(); workers = []
                    page.on('request', lambda request: workers.append(request.url)
                            if 'pdf-worker-wrapper' in request.url else None)
                    self.hold_ordinary_worker_and_history(page)
                    self.open(page, source)
                    page.wait_for_function('''()=>window.__historyExpired && window.__selectionReached &&
                      window.__ordinaryWorkers?.[0]?.messages && window.__finishHistory''', timeout=15000)
                    if history == 'failed':
                        page.evaluate("window.__failHistory(new Error('history unavailable'))")
                    else:
                        page.evaluate('history=>window.__finishHistory(history)', history)
                    page.wait_for_function('()=>window.__ordinarySelected === true', timeout=10000)
                    self.assertFalse(any('reader-first-page=1' in url for url in workers), workers)
                    self.assertEqual(page.locator('.reader-page[data-preview-ready="1"]').count(), 0)
                    page.evaluate('window.__resumeOrdinary()')
                    target = '1' if history == 'failed' else '20'
                    page.locator(f'.reader-page[data-page="{target}"] canvas.ready').wait_for(timeout=30000)
                    page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'", timeout=30000)
                    self.assertEqual(page.locator('#page-number').input_value(), target)
                    self.assertEqual(page.locator('#page-number').get_attribute('max'), '30')
                    self.assertFalse(any('reader-first-page=1' in url for url in workers), workers)
                finally:
                    context.close()

    def test_unresolved_history_does_not_hold_a_ready_ordinary_worker(self):
        with support.range_source(support.sparse_pdf(root_at_end=True)) as (source, state, _lock):
            state['block'].set()
            context = self.browser.new_context(service_workers='block')
            try:
                page = context.new_page(); workers = []
                page.on('request', lambda request: workers.append(request.url)
                        if 'pdf-worker-wrapper' in request.url else None)
                self.hold_ordinary_worker_and_history(page)
                self.open(page, source)
                page.wait_for_function('''()=>window.__historyExpired && window.__selectionReached &&
                  window.__ordinaryWorkers?.[0]?.messages && window.__finishHistory''', timeout=15000)
                page.evaluate('window.__resumeOrdinary()')
                page.locator('.reader-page[data-page="1"] canvas.ready').wait_for(timeout=30000)
                self.assertEqual(page.locator('.reader-page[data-preview-ready="1"]').count(), 0)
                self.assertFalse(any('reader-first-page=1' in url for url in workers), workers)
                self.assertNotEqual(page.locator('html').get_attribute('data-reader-phase'), 'ready')
                page.evaluate('window.__finishHistory(null)')
                page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'", timeout=30000)
                self.assertEqual(page.locator('#page-number').get_attribute('max'), '130')
            finally:
                context.close()

    def test_late_deep_history_staged_worker_does_not_preview_first_page(self):
        with support.range_source(support.sparse_pdf(root_at_end=True)) as (source, state, _lock):
            state['block_from'] = 1024 * 1024
            context = self.browser.new_context(service_workers='block')
            try:
                page = context.new_page(); errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                self.hold_ordinary_worker_and_history(page)
                self.open(page, source)
                page.wait_for_function('''()=>window.__historyExpired && window.__selectionReached &&
                  window.__ordinaryWorkers?.[0]?.messages && window.__finishHistory''', timeout=15000)
                page.evaluate("window.__finishHistory({page:20,pageCount:130,zoom:100})")
                page.wait_for_function('''()=>window.__stagedWorkerStarted &&
                  document.querySelector('#status')?.textContent === '正在检查文档' ''', timeout=15000)
                self.assertEqual(page.evaluate('window.__ordinaryWorkers[0].terminated'), 1)
                self.assertEqual(page.locator('.reader-page[data-preview-ready="1"]').count(), 0)
                self.assertEqual(page.locator('#page-total').text_content(), '')
                self.assertNotEqual(page.locator('html').get_attribute('data-reader-phase'), 'ready')
                state['block'].set()
                page.locator('.reader-page[data-page="20"] canvas.ready').wait_for(timeout=30000)
                page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'", timeout=30000)
                self.assertEqual(page.locator('#page-number').input_value(), '20')
                self.assertEqual(page.locator('#page-number').get_attribute('max'), '130')
                self.assertEqual(errors, [])
            finally:
                state['block'].set()
                context.close()

    def test_disposal_while_waiting_for_late_history_cancels_the_race(self):
        with support.range_source(support.sparse_pdf(root_at_end=True)) as (source, state, _lock):
            state['block'].set()
            context = self.browser.new_context(service_workers='block')
            try:
                page = context.new_page(); workers = []; errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('request', lambda request: workers.append(request.url)
                        if 'pdf-worker-wrapper' in request.url else None)
                self.hold_ordinary_worker_and_history(page)
                self.open(page, source)
                page.wait_for_function('''()=>window.__historyExpired && window.__selectionReached &&
                  window.__ordinaryWorkers?.[0]?.messages && window.__finishHistory''', timeout=15000)
                page.evaluate("window.dispatchEvent(new Event('voice-reader-dispose'))")
                page.wait_for_function('()=>window.__ordinaryWorkers[0].terminated === 1', timeout=5000)
                before = list(workers)
                page.evaluate('window.__finishHistory(null)')
                page.wait_for_timeout(300)
                self.assertEqual(workers, before)
                self.assertFalse(any('reader-first-page=1' in url for url in workers), workers)
                self.assertEqual(page.locator('.reader-page[data-preview-ready="1"]').count(), 0)
                self.assertEqual(errors, [])
            finally:
                context.close()

    def test_history_settling_after_timeout_uses_its_actual_value(self):
        # None means a settled fresh session; "pending" means no verified
        # history at worker selection and must retain the conservative path.
        for history in (None, {"page": 20, "pageCount": 30, "zoom": 100}, "pending"):
            payload = (support.sparse_pdf(root_at_end=True) if history in (None, "pending") else
                       support.sparse_pdf(count=30, stride=310000, root_at_end=True, parent_id=200, inline_resources=True))
            with self.subTest(history=history), support.range_source(payload) as (source, state, _lock):
                state["block_from"] = 1024 * 1024
                context = self.browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
                try:
                    page = context.new_page()
                    workers, failures = [], []
                    page.on("request", lambda request: workers.append(request.url)
                            if "pdf-worker-wrapper" in request.url else None)
                    page.add_init_script("""(()=>{
                      window.__prefixGate = new Promise(resolve=>window.__releasePrefix=resolve);
                    })();""")
                    page.route("**/static/reader/core/reader-store.js*", lambda route: route.fulfill(
                        content_type="text/javascript", body="""
                          window.VoiceOfMLReaderStore={
                            get:()=>new Promise(resolve=>window.__completeHistory=resolve),
                            put:async()=>{},list:async()=>[],listBookmarks:async()=>[],
                            listAllBookmarks:async()=>[],removeBookmark:async()=>{}
                          };
                        """))

                    def instrument_engine(route):
                        script = route.fetch().text()
                        old = 'timer = setTimeout(() => resolve(null), 5000)'
                        selection = 'const stagedCandidate = first && !first.complete'
                        if old not in script:
                            failures.append("opening history timeout hook missing")
                        if selection not in script:
                            failures.append("worker selection hook missing")
                        script = script.replace(old, 'timer = setTimeout(() => { window.__historyTimedOut=true; resolve(null); }, 50)')
                        route.fulfill(content_type="text/javascript", body=script.replace(
                            selection, 'window.__workerSelectionReached=true; '+selection))

                    def instrument_network(route):
                        script = route.fetch().text()
                        old = 'return {bytes, total, etag, complete:bytes.byteLength === total};'
                        if old not in script:
                            failures.append("prefix completion hook missing")
                        route.fulfill(content_type="text/javascript", body=script.replace(old,
                            'if (begin===0) {window.__prefixWaiting=true; await window.__prefixGate;} '+old))

                    page.route("**/static/reader/pdf/reader-pdf-engine.mjs*", instrument_engine)
                    page.route("**/static/reader/pdf/reader-pdf-network.mjs*", instrument_network)
                    attempts = self.fail_first_range_once(page)
                    self.open(page, source)
                    page.wait_for_function("""()=>window.__prefixWaiting && window.__historyTimedOut &&
                        typeof window.__completeHistory==='function'""", timeout=15000)
                    self.assertEqual(failures, [])
                    self.assertGreaterEqual(len(attempts), 2, attempts)
                    page.evaluate("""async history=>{
                      if (history !== 'pending') window.__completeHistory(history);
                      await Promise.resolve(); await Promise.resolve();
                      window.__releasePrefix();
                    }""", history)
                    if history is None:
                        page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=15000)
                        self.assertTrue(any("reader-first-page=1" in url for url in workers), workers)
                        self.assertNotEqual(page.locator("html").get_attribute("data-reader-phase"), "ready")
                    elif history == "pending":
                        # A genuinely unresolved lookup must not be interpreted
                        # as an empty history or start an unverified preview.
                        page.wait_for_function("() => window.__workerSelectionReached === true", timeout=15000)
                        self.assertEqual(page.locator('.reader-page[data-preview-ready="1"]').count(), 0)
                        self.assertFalse(any("reader-first-page=1" in url for url in workers), workers)
                        page.evaluate("window.__completeHistory(null)")
                        state["block"].set()
                    else:
                        page.wait_for_function("() => document.querySelector('#content')?.dataset.mode === 'pdf'")
                        state["block"].set()
                        page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'", timeout=30000)
                        self.assertFalse(any("reader-first-page=1" in url for url in workers), workers)
                        self.assertEqual(page.locator("#page-number").input_value(), "20")
                    state["block"].set()
                    page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'", timeout=30000)
                    self.assertEqual(page.locator("#page-number").get_attribute("max"), "30" if isinstance(history, dict) else "130")
                finally:
                    state["block"].set()
                    context.close()


if __name__ == "__main__":
    unittest.main()

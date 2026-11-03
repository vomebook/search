"""Worker choice when a bounded history wait expires before the prefix arrives."""
import unittest

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
        with support.range_source(support.sparse_pdf(root_at_end=True)) as (source, state, _lock):
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
                page.wait_for_function('()=>window.__ordinaryWorkers?.[0]?.messages >= 1', timeout=10000)
                page.locator('.reader-page[data-preview-ready="1"] canvas.ready').wait_for(timeout=10000)
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

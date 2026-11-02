"""Worker choice when a bounded history wait expires before the prefix arrives."""
import unittest

from tests import test_reader_pdf_first_page as support


class PdfHistoryRaceTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFirstPageTests.setUpClass.__func__)
    open = support.PdfFirstPageTests.open

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
                    page.route("**/api/reader-content?**", lambda route: route.fulfill(status=503, body="temporary"), times=1)
                    self.open(page, source)
                    page.wait_for_function("""()=>window.__prefixWaiting && window.__historyTimedOut &&
                        typeof window.__completeHistory==='function'""", timeout=15000)
                    self.assertEqual(failures, [])
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

"""Exercise the actual early engine preloader in Chromium."""
import contextlib
import unittest

from playwright.sync_api import sync_playwright
from tests import test_reader_pdf_first_page as support


class ReaderEnginePreloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stack = contextlib.ExitStack()
        cls.addClassCleanup(stack.close)
        cls.playwright = stack.enter_context(sync_playwright())
        cls.browser = cls.playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        cls.addClassCleanup(cls.browser.close)

    def test_only_engine_assets_are_warmed_and_pending_fetches_are_cancelled(self):
        payload = b"%PDF-1.7\n"
        with support.range_source(payload) as (origin, _state, _lock):
            prefix = "/search" if "/search/static/" in (support.ROOT / "static/reader.html").read_text() else ""
            for mode in ("extension", "source", "save-data", "other", "missing"):
                with self.subTest(mode=mode):
                    context = self.browser.new_context(service_workers="block")
                    try:
                        page = context.new_page()
                        page.route("**/engine-preload-fixture*", lambda route: route.fulfill(
                            status=200, content_type="text/html", body="<!doctype html><title>engine fixture</title>"))
                        page.route("**/static/engine.mjs", lambda route: route.fulfill(content_type="text/javascript", body="export {}"))
                        page.route("**/static/classic.js", lambda route: route.fulfill(content_type="text/javascript", body=""))
                        page.route("**/static/reader/pdf/pdf-worker-wrapper.mjs", lambda route: route.fulfill(
                            content_type="text/javascript", body="export {}"))
                        query = {"extension": "?ext=pdf", "source": "?url=https%3A%2F%2Fexample.test%2Fa.PDF",
                                 "save-data": "?ext=pdf", "other": "?ext=txt", "missing": ""}[mode]
                        page.goto(origin + "/engine-preload-fixture" + query)
                        page.evaluate("""saveData=>{
                          Object.defineProperty(navigator,'connection',{configurable:true,value:{saveData}});
                          window.__warmRequests=[];window.__bodyReads=0;
                          window.VoiceOfMLReaderResources={
                            engineAssets:(ext,base,suffix,worker)=>{
                              window.__engineArgs={ext,base,suffix,worker};
                              return [worker,base+'engine.mjs',base+'classic.js'];
                            },
                            pdfSupportAssets:base=>[base+'support.bin']
                          };
                          window.VoiceOfMLReaderSecurity={readBytes:async()=>{window.__bodyReads++;}};
                          window.fetch=(url,options)=>{
                            window.__warmRequests.push({url,options});
                            return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
                          };
                        }""", mode == "save-data")
                        page.add_script_tag(url=origin + prefix + "/static/reader/pdf/reader-engine-preload.js")
                        result = page.evaluate("""()=>({args:window.__engineArgs,requests:window.__warmRequests.map(x=>({
                          url:x.url,mode:x.options.mode,credentials:x.options.credentials,aborted:x.options.signal.aborted})),
                          links:[...document.querySelectorAll('link')].map(x=>({href:x.href,rel:x.rel,as:x.as})),
                          reads:window.__bodyReads})""")
                        is_pdf = mode in ("extension", "source", "save-data")
                        self.assertEqual(result["args"]["ext"], "pdf" if is_pdf else ("txt" if mode == "other" else ""))
                        base = origin + prefix + "/static/"
                        worker = base + "reader/pdf/pdf-worker-wrapper.mjs"
                        self.assertEqual(result["args"]["base"], base)
                        self.assertEqual(result["args"]["worker"], worker)
                        self.assertEqual(result["args"]["suffix"], "?reader-v1" if prefix else "")
                        expected_requests = [worker] if is_pdf else []
                        if is_pdf and mode != "save-data":
                            expected_requests.append(base + "support.bin")
                        self.assertEqual([item["url"] for item in result["requests"]], expected_requests)
                        self.assertEqual(result["reads"], 0)
                        for request in result["requests"]:
                            self.assertEqual((request["mode"], request["credentials"]), ("same-origin", "same-origin"))
                            self.assertFalse(request["aborted"])
                            self.assertFalse("reader-content" in request["url"] or "example.test/a.PDF" in request["url"])
                        link_types = {link["href"].rsplit("/", 1)[-1]: (link["rel"], link["as"]) for link in result["links"]}
                        self.assertEqual(link_types["engine.mjs"][0], "modulepreload")
                        self.assertEqual(link_types["classic.js"], ("preload", "script"))
                        if is_pdf:
                            self.assertNotIn("pdf-worker-wrapper.mjs", link_types)
                            page.evaluate("dispatchEvent(new Event('voice-reader-dispose'))")
                            self.assertTrue(page.evaluate("window.__warmRequests.every(item=>item.options.signal.aborted)"))
                        else:
                            self.assertEqual(link_types["pdf-worker-wrapper.mjs"][0], "modulepreload")
                    finally:
                        context.close()

    def test_warm_fetch_success_http_failure_and_rejection_are_settled(self):
        with support.range_source(b"%PDF-1.7\n") as (origin, _state, _lock):
            prefix = "/search" if "/search/static/" in (support.ROOT / "static/reader.html").read_text() else ""
            context = self.browser.new_context(service_workers="block")
            try:
                page = context.new_page()
                page.route("**/engine-preload-fixture*", lambda route: route.fulfill(
                    content_type="text/html", body="<!doctype html><title>engine fixture</title>"))
                page.goto(origin + "/engine-preload-fixture?ext=pdf")
                page.evaluate("""()=>{
                  window.__reads=[];window.__cancels=0;window.__removed=[];
                  const remove=window.removeEventListener.bind(window);
                  window.removeEventListener=(type,...rest)=>{window.__removed.push(type);return remove(type,...rest);};
                  window.VoiceOfMLReaderResources={
                    engineAssets:()=>[],pdfSupportAssets:base=>[base+'failure.bin',base+'reject.bin']
                  };
                  window.VoiceOfMLReaderSecurity={readBytes:async(response,limit)=>window.__reads.push({url:response.url,limit})};
                  window.fetch=(url)=>{
                    if(url.endsWith('/reject.bin')) return Promise.reject(new Error('network failure'));
                    if(url.endsWith('/failure.bin')) return Promise.resolve({ok:false,body:{cancel:async()=>{window.__cancels++;}}});
                    return Promise.resolve({ok:true,url});
                  };
                }""")
                page.add_script_tag(url=origin + prefix + "/static/reader/pdf/reader-engine-preload.js")
                page.wait_for_function("()=>window.__removed.includes('voice-reader-dispose')")
                result = page.evaluate("()=>({reads:window.__reads,cancels:window.__cancels,removed:window.__removed})")
                self.assertEqual(result["reads"], [{"url": origin + prefix + "/static/reader/pdf/pdf-worker-wrapper.mjs",
                                                     "limit": 1024 * 1024}])
                self.assertEqual(result["cancels"], 1)
                self.assertIn("pagehide", result["removed"])
                self.assertIn("voice-reader-dispose", result["removed"])
            finally:
                context.close()


if __name__ == "__main__":
    unittest.main()

import contextlib
import json
import unittest
import urllib.parse

from tests.browser_support import local_server
from tests.test_reader_performance import PlaywrightError, sync_playwright


SOURCE = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/timeout.txt"
TIMEOUT_SCRIPT = """
const nativeTimeout = window.setTimeout.bind(window);
window.__requestTimeouts = [];
window.setTimeout = (callback, delay, ...args) =>
  nativeTimeout(callback, delay === 120000 ? 50 : delay, ...args);
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = new URL(String(input), location.href);
  if (!url.pathname.startsWith('/api/reader-content') &&
      !url.pathname.startsWith('/api/reader-resolve') &&
      !url.pathname.endsWith('/timeout.txt')) return nativeFetch(input, init);
  const signal = init.signal;
  signal.addEventListener('abort', () => {
    window.__requestTimeouts.push(signal.reason.name);
  }, { once: true });
  if (window.__timeoutScenario === 'body') {
    return Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason),
          { once: true });
      }
    }), { headers: { 'Content-Type': 'text/plain' } }));
  }
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
};
"""


@unittest.skipIf(sync_playwright is None, "install requirements-test.txt to run Reader timeout tests")
class ReaderTimeoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        resources = contextlib.ExitStack()
        cls.addClassCleanup(resources.close)
        cls.origin, _ = resources.enter_context(local_server())
        playwright = resources.enter_context(sync_playwright())
        try:
            cls.browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        except PlaywrightError as error:
            raise unittest.SkipTest(f"Chromium is unavailable: {error}")
        cls.addClassCleanup(cls.browser.close)

    def assert_timeout_ui(self, scenario):
        with self.browser.new_context(service_workers="block") as context:
            page = context.new_page()
            page_errors = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.add_init_script(
                f"window.__timeoutScenario = {json.dumps(scenario)};\n" + TIMEOUT_SCRIPT
            )
            query = {"ext": "txt", "title": "Timeout"}
            query.update({"id": "timeout-id"} if scenario == "resolve" else {"url": SOURCE})
            page.goto(
                f"{self.origin}/search/static/reader.html?{urllib.parse.urlencode(query)}",
                wait_until="domcontentloaded",
            )
            page.locator(".reader-error").wait_for(state="visible", timeout=10000)
            self.assertEqual(page.locator("html").get_attribute("data-reader-phase"), "failed")
            self.assertEqual(page.locator("#content").get_attribute("data-error-code"), "READER_NETWORK")
            self.assertEqual(page.locator(".reader-loading-indicator").count(), 0)
            names = page.evaluate("window.__requestTimeouts")
            self.assertTrue(names)
            self.assertEqual(set(names), {"TimeoutError"})
            self.assertEqual(page_errors, [])

    def test_txt_timeout_before_headers_shows_failure(self):
        self.assert_timeout_ui("headers")

    def test_txt_timeout_after_headers_shows_failure(self):
        self.assert_timeout_ui("body")

    def test_id_resolution_timeout_shows_failure(self):
        self.assert_timeout_ui("resolve")

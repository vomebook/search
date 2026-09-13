import os
import pathlib
import unittest
import urllib.parse

from tests.browser_support import local_server
from tests.test_reader_performance import STORE_SCRIPT, sync_playwright, PlaywrightError

ROOT = pathlib.Path(__file__).parents[1]
SNAPSHOTS = ROOT / "tests/snapshots/reader/chromium-linux"
MATRIX = (("desktop", 1440, 900), ("tablet", 820, 1180), ("mobile", 390, 844))

@unittest.skipIf(sync_playwright is None, "install requirements-test.txt to run Reader visual tests")
class ReaderVisualTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = local_server(); cls.origin, _ = cls.server.__enter__(); cls.playwright = sync_playwright().start()
        try: cls.browser = cls.playwright.chromium.launch(headless=True)
        except PlaywrightError as error: cls.playwright.stop(); cls.server.__exit__(None, None, None); raise unittest.SkipTest(str(error))

    @classmethod
    def tearDownClass(cls): cls.browser.close(); cls.playwright.stop(); cls.server.__exit__(None, None, None)

    def test_reader_visual_matrix(self):
        source = urllib.parse.quote("https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/visual.txt", safe="")
        for name, width, height in MATRIX:
            for theme in ("light", "dark"):
                with self.subTest(viewport=name, theme=theme):
                    context = self.browser.new_context(viewport={"width": width, "height": height}, color_scheme=theme)
                    page = context.new_page(); page.add_init_script(f"localStorage.setItem('theme', '{theme}')")
                    page.route("**/static/reader-store.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=STORE_SCRIPT))
                    page.route("https://voiceofml-search.hf.space/api/reader-content**", lambda route: route.fulfill(status=200, content_type="text/plain", body=("Reader visual fixture\n" * 80).encode()))
                    page.goto(f"{self.origin}/search/static/reader.html?url={source}&ext=txt&title=Visual", wait_until="domcontentloaded")
                    page.locator(".reader-text").wait_for(); page.add_style_tag(content="*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}")
                    image = page.screenshot(animations="disabled"); baseline = SNAPSHOTS / f"{name}-{theme}.png"
                    if os.environ.get("UPDATE_READER_SNAPSHOTS") == "1": baseline.parent.mkdir(parents=True, exist_ok=True); baseline.write_bytes(image)
                    self.assertTrue(baseline.exists(), f"missing baseline {baseline}"); self.assertEqual(image, baseline.read_bytes())
                    context.close()

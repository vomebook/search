import os
import io
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
        if os.environ.get("UPDATE_READER_SNAPSHOTS") != "1" and not all(
            (SNAPSHOTS / f"{name}-{theme}.png").exists()
            for name, _, _ in MATRIX for theme in ("light", "dark")
        ):
            self.skipTest("Reader visual baselines are not installed")
        from PIL import Image, ImageChops
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
                    page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
                    page.evaluate("async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }")
                    image = page.screenshot(animations="disabled"); baseline = SNAPSHOTS / f"{name}-{theme}.png"
                    if os.environ.get("UPDATE_READER_SNAPSHOTS") == "1": baseline.parent.mkdir(parents=True, exist_ok=True); baseline.write_bytes(image)
                    self.assertTrue(baseline.exists(), f"missing baseline {baseline}")
                    with Image.open(io.BytesIO(image)) as actual, Image.open(baseline) as expected:
                        self.assertEqual(actual.size, expected.size)
                        diff = ImageChops.difference(actual.convert("RGB"), expected.convert("RGB"))
                        # Chromium occasionally rounds a control-border channel by 1/255.
                        self.assertLessEqual(max(high for _, high in diff.getextrema()), 1)
                        self.assertLessEqual(sum(pixel != (0, 0, 0) for pixel in diff.get_flattened_data()), 8)
                    context.close()

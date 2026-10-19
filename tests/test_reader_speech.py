"""Explicit Chromium tier: native reading in the Reader for text-bearing formats.

The TTS backend is routed offline (no model/network); playback is muted.
"""
import json
import unittest
import urllib.parse
from pathlib import Path
from urllib.parse import urlparse

from tests import test_reader_performance as perf

PlaywrightError, epub_with_navigation, minimal_pdf, sync_playwright = perf.PlaywrightError, perf.epub_with_navigation, perf.minimal_pdf, perf.sync_playwright

ROOT = Path(__file__).resolve().parents[1]
perf.local_server  # GitHub Pages harness serves /search/*
SPEECH = "https://vomebook-hitokoto.hf.space"
MP3 = (bytes.fromhex("fffb9064") + bytes(413)) * 58  # ~1.5 s of silent MPEG-1 Layer III
SOURCE = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/sample"
def wait(page, expression, timeout=20000, arg=None):
    """CSP-safe polling: the Reader forbids string eval used by wait_for_function."""
    import time
    deadline = time.monotonic() + timeout / 1000
    while True:
        try:
            if page.evaluate(expression, arg) if arg is not None else page.evaluate(expression):
                return
        except Exception:
            pass
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out: {expression[:120]}")
        page.wait_for_timeout(100)


TEXT = "".join(f"第{index}段，这是阅读器朗读测试的正文。手机和文化都要读出来。\n" for index in range(60))


@unittest.skipIf(sync_playwright is None, "install requirements-test.txt to run Reader speech tests")
class ReaderSpeechTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = perf.local_server()
        cls.origin, _state = cls.server.__enter__()
        cls.playwright = sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True, args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
        except PlaywrightError as error:
            cls.playwright.stop()
            cls.server.__exit__(None, None, None)
            raise unittest.SkipTest(f"Chromium is unavailable: {error}")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def open(self, ext, body, content_type, viewport=None):
        context = self.browser.new_context(viewport=viewport or {"width": 1280, "height": 860})
        page = context.new_page()
        posts, errors = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script("new MutationObserver(()=>{const a=document.querySelector('#speech-audio');if(a)a.muted=true;}).observe(document,{childList:true,subtree:true});")
        jobs = {}
        headers = {"Access-Control-Allow-Origin": self.origin, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS"}

        def speech(route, request):
            path = urlparse(request.url).path
            if request.method == "OPTIONS":
                return route.fulfill(status=200, headers=headers)
            if path == "/tts/jobs" and request.method == "POST":
                data = request.post_data_json
                posts.append(data)
                job = f"{len(posts):032d}"
                spans = list(zip([0] + data["segment_ends"][:-1], data["segment_ends"]))
                jobs[job] = {"id": job, "state": "ready", "result": {"pitch_semitones": data["pitch_semitones"]},
                             "progress": {"total_parts": len(spans), "parts": [
                                 {"index": i, "start": a, "end": b, "bytes": len(MP3), "pitch_semitones": data["pitch_semitones"],
                                  "audio_url": f"/tts/audio/{job}/parts/{i}.mp3"} for i, (a, b) in enumerate(spans)]}}
                return route.fulfill(status=202, content_type="application/json", body=json.dumps(jobs[job]), headers=headers)
            if path.startswith("/tts/jobs/"):
                return route.fulfill(status=200, content_type="application/json", body=json.dumps(jobs.get(path.rsplit("/", 1)[-1], {})), headers=headers)
            if path.startswith("/tts/audio/"):
                return route.fulfill(status=200, content_type="audio/mpeg", body=MP3, headers=headers)
            return route.fulfill(status=404, body="{}", headers=headers)

        page.route(SPEECH + "/**", speech)
        page.route("**/api/reader-content**", lambda route: route.fulfill(status=200, content_type=content_type, body=body, headers={"Access-Control-Allow-Origin": "*"}))
        perf.route_local_vendor_fallback(page)
        query = urllib.parse.quote(f"{SOURCE}.{ext}", safe="")
        page.goto(f"{self.origin}/search/static/reader.html?url={query}&ext={ext}&title=Speech", wait_until="domcontentloaded")
        wait(page, "() => document.documentElement.dataset.readerPhase === 'ready'", 30000)
        return context, page, posts, errors

    def play(self, page, posts):
        button = page.locator(".reader-actions [data-speech-toggle]")
        button.wait_for(timeout=10000)
        before = len(posts)
        button.click()
        wait(page, "()=>{const a=document.querySelector('#speech-audio');return !!a&&!a.paused&&a.currentTime>0.05}", 20000)
        self.assertGreater(len(posts), before)
        self.assertTrue(page.locator("#speech-panel").is_visible())
        return posts[before]

    def stop(self, page):
        page.locator("#speech-stop").click()
        self.assertTrue(page.locator("#speech-audio").evaluate("n=>n.paused"))

    def test_text_markdown_and_html_read_rendered_text(self):
        cases = (("txt", TEXT.encode(), "text/plain; charset=utf-8", "第0段"),
                 ("md", ("# 标题\n\n" + TEXT).encode(), "text/markdown; charset=utf-8", "标题"),
                 ("html", ("<html><body><h1>网页标题</h1>" + "".join(f"<p>第{i}段，网页正文要朗读。</p>" for i in range(40)) + "</body></html>").encode(),
                  "text/html; charset=utf-8", "网页标题"))
        for ext, body, content_type, first in cases:
            with self.subTest(ext=ext):
                context, page, posts, errors = self.open(ext, body, content_type)
                try:
                    job = self.play(page, posts)
                    self.assertTrue(job["text"].lstrip().startswith(first), job["text"][:40])
                    self.assertEqual(job["unsupported_policy"], "pause")
                    # Next sentence plays from browser memory without new synthesis.
                    count = len(posts)
                    page.locator("#speech-next").click()
                    wait(page, "()=>!document.querySelector('#speech-audio').paused")
                    self.assertEqual(len(posts), count)
                    # The CSS highlight lives in the realm owning the text.
                    realm = "document.querySelector('iframe.html-frame').contentWindow" if ext == "html" else "window"
                    wait(page, f"()=>{realm}.CSS.highlights.has('ccrd-speech')", 5000)
                    self.stop(page)
                    self.assertFalse(errors, errors)
                finally:
                    context.close()

    def test_native_pdf_text_layer_is_read_and_image_is_not_offered(self):
        context, page, posts, errors = self.open("pdf", minimal_pdf(), "application/pdf")
        try:
            job = self.play(page, posts)
            self.assertIn("Reader PDF", job["text"])
            self.stop(page)
            self.assertFalse(errors, errors)
        finally:
            context.close()
        context, page, posts, errors = self.open("gif", (ROOT / "static/icons/icon-192.png").read_bytes() if (ROOT / "static/icons/icon-192.png").exists() else b"GIF89a", "image/png")
        try:
            page.wait_for_timeout(500)
            self.assertEqual(page.locator("[data-speech-toggle]").count(), 0)
        finally:
            context.close()

    def test_foliate_epub_reads_sections_in_order(self):
        if not (ROOT / "static/foliate-reader/view.js").exists():
            self.skipTest("fetch Foliate first: node scripts/build/fetch_foliate_reader.mjs")
        context, page, posts, errors = self.open("epub", epub_with_navigation(), "application/epub+zip")
        try:
            job = self.play(page, posts)
            self.assertTrue(any(word in job["text"] for word in ("目录", "第一章")), job["text"][:60])
            self.stop(page)
            self.assertFalse(errors, errors)
        finally:
            context.close()


if __name__ == "__main__":
    unittest.main()

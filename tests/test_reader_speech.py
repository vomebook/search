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
            cls.browser = cls.playwright.chromium.launch(headless=True, args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--disable-audio-output"])
        except PlaywrightError as error:
            cls.playwright.stop()
            cls.server.__exit__(None, None, None)
            raise unittest.SkipTest(f"Chromium is unavailable: {error}")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def open(self, ext, body, content_type, viewport=None, host=False, name="sample"):
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
                                 # As the real server: each ~1.52 s clip ends with 0.6 s of guard/pause silence.
                                 {"index": i, "start": a, "end": b, "bytes": len(MP3), "pitch_semitones": data["pitch_semitones"],
                                  "pause_kind": "comma", "pause_after_seconds": 0.6, "audio_seconds": 1.515,
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
        reader = self.reader_url(ext, name)
        if not host:
            page.goto(reader, wait_until="domcontentloaded")
            wait(page, "() => document.documentElement.dataset.readerPhase === 'ready'", 30000)
            return context, page, posts, errors
        # A same-origin host page owning the Reader overlay through the shared navigation module.
        base = reader.split("reader.html")[0]
        page.goto(base + "search/reader-navigation.js", wait_until="domcontentloaded")
        # Inject as content: this host document has no charset, so a src= script would decode as Latin-1.
        page.add_style_tag(content=(ROOT / "static/style.css").read_text(encoding="utf-8"))
        page.add_script_tag(content=(ROOT / "static/search/reader-navigation.js").read_text(encoding="utf-8"))
        page.evaluate("""url => {
          window.__nav = VoiceOfMLReaderNavigation.createNavigation(new URL(url).pathname, { resume: next => __nav.mount(new URL(next)) });
          window.__reader = __nav.mount(new URL(url));
        }""", reader)
        frame = page.wait_for_selector("iframe.reader-overlay").content_frame()
        wait(frame, "() => document.documentElement.dataset.readerPhase === 'ready'", 30000)
        return context, page, posts, errors, frame

    def reader_url(self, ext, name="sample"):
        query = urllib.parse.quote(f"{SOURCE.rsplit('/', 1)[0]}/{name}.{ext}", safe="")
        return f"{self.origin}/search/static/reader.html?url={query}&ext={ext}&title=Speech"

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
                    # Only the speculative following batch may be queued (its
                    # context is this batch's end), never a resynthesis.
                    for later in posts[count:]:
                        self.assertTrue(later["context_before"] and job["text"].endswith(later["context_before"]), later["text"][:40])
                    # The CSS highlight lives in the realm owning the text.
                    realm = "document.querySelector('iframe.html-frame').contentWindow" if ext == "html" else "window"
                    wait(page, f"()=>{realm}.CSS.highlights.has('ccrd-speech')", 5000)
                    self.stop(page)
                    self.assertFalse(errors, errors)
                finally:
                    context.close()

    def test_scrolling_away_is_not_undone_by_the_next_sentence(self):
        body = "".join(f"第{index}句。\n" for index in range(400)).encode()
        context, page, posts, errors = self.open("txt", body, "text/plain; charset=utf-8")
        try:
            self.play(page, posts)
            viewport = page.locator("#viewport")
            box = viewport.bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            page.mouse.wheel(0, 6000)
            page.wait_for_timeout(700)
            away = viewport.evaluate("n => n.scrollTop")
            self.assertGreater(away, 2000)
            clip = page.locator("#speech-audio").evaluate("n => n.src")
            for _ in range(2):  # Two sentence changes must leave the reader where they scrolled.
                page.locator("#speech-next").click()
                wait(page, f"() => document.querySelector('#speech-audio').src !== {json.dumps(clip)}")
                clip = page.locator("#speech-audio").evaluate("n => n.src")
                page.wait_for_timeout(900)
                self.assertEqual(viewport.evaluate("n => n.scrollTop"), away)
            locate = page.locator("#speech-locate")
            self.assertEqual(locate.inner_text(), "回到播放位置")
            locate.click()
            wait(page, f"() => document.querySelector('#viewport').scrollTop < {away - 2000}", 5000)
            # After jumping, the same button returns to where the reader was.
            wait(page, "() => document.querySelector('#speech-locate').textContent === '回到原位置'", 3000)
            locate.click()
            wait(page, f"() => document.querySelector('#viewport').scrollTop === {away}", 3000)
            wait(page, "() => document.querySelector('#speech-locate').textContent === '回到播放位置'", 3000)
            locate.click()
            wait(page, f"() => document.querySelector('#viewport').scrollTop < {away - 2000}", 5000)
            # The sentence being read is on screen, not merely its 32 KiB text block.
            self.assertTrue(page.evaluate("""() => { const range = [...CSS.highlights.get('ccrd-speech')][0], rect = range.getBoundingClientRect();
              const box = document.querySelector('#viewport').getBoundingClientRect(); return rect.top >= box.top && rect.bottom <= box.bottom; }"""))
            # Following resumes after returning to the playback position.
            top = viewport.evaluate("n => n.scrollTop")
            page.locator("#speech-next").click()
            page.wait_for_timeout(900)
            self.assertLess(abs(viewport.evaluate("n => n.scrollTop") - top), 400)
            self.stop(page)
            self.assertFalse(errors, errors)
        finally:
            context.close()

    def test_next_clip_starts_when_speech_ends_not_after_the_silent_tail(self):
        # Gapless handoff: a cached next clip starts at speech end + its comma
        # pause (1.515 - 0.6 + 0.14 = 1.055 s), in a second player, in order.
        body = "".join(f"第{index}句话。" for index in range(300)).encode()
        context, page, posts, errors = self.open("txt", body, "text/plain; charset=utf-8")
        try:
            page.evaluate("""() => { window.__starts = []; window.__seen = new Set();
              new MutationObserver(() => { for (const a of document.querySelectorAll('audio')) if (!__seen.has(a)) { __seen.add(a);
                a.addEventListener('playing', () => __starts.push([performance.now() / 1000, a.getAttribute('src'),
                  String([...(CSS.highlights.get('ccrd-speech') || [])][0] || '')])); } }).observe(document.body, {childList: true, subtree: true}); }""")
            self.play(page, posts)
            wait(page, "() => __starts.length >= 6", 20000)
            starts = page.evaluate("() => __starts")
            intervals = [round(b[0] - a[0], 2) for a, b in zip(starts[1:], starts[2:])]
            self.assertTrue(intervals and max(intervals) < 1.35, intervals)  # not >= 1.52 s (whole clip)
            self.assertEqual(len({row[1] for row in starts}), len(starts))  # every start is a new clip
            texts = [row[2] for row in starts[1:]]
            joined = page.evaluate("() => document.querySelector('.reader-text').textContent")
            positions = [joined.find(text) for text in texts if text]
            self.assertEqual(positions, sorted(positions))  # highlighted in reading order, nothing skipped twice
            # Pausing during a pending handoff stops everything.
            page.locator("#speech-play").click()
            page.wait_for_timeout(1600)
            self.assertTrue(page.evaluate("() => [...document.querySelectorAll('audio')].every(a => a.paused)"))
            self.stop(page)
            self.assertFalse(errors, errors)
        finally:
            context.close()

    def test_a_small_scroll_while_listening_is_never_undone(self):
        # The reader nudges the page while the sentence is still on screen; later
        # sentences must not pull it back (only 回到播放位置 resumes following).
        body = "".join(f"第{index}句。\n" for index in range(400)).encode()
        context, page, posts, errors = self.open("txt", body, "text/plain; charset=utf-8", viewport={"width": 1280, "height": 420})
        try:
            self.play(page, posts)
            viewport = page.locator("#viewport")
            on_screen = """() => { const range = [...(CSS.highlights.get('ccrd-speech') || [])][0];
              const box = document.querySelector('#viewport').getBoundingClientRect(), rect = range && range.getBoundingClientRect();
              return !!rect && rect.top >= box.top && rect.bottom <= box.bottom; }"""
            clip = page.locator("#speech-audio").evaluate("n => n.src")
            for _ in range(4):  # the playing sentence moves to the middle of the screen
                page.locator("#speech-next").click()
                wait(page, f"() => document.querySelector('#speech-audio').src !== {json.dumps(clip)}")
                clip = page.locator("#speech-audio").evaluate("n => n.src")
            box = viewport.bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            page.mouse.wheel(0, 40)
            page.wait_for_timeout(500)
            self.assertTrue(page.evaluate(on_screen))  # still visible after the nudge
            moved = viewport.evaluate("n => n.scrollTop")
            self.assertGreater(moved, 0)
            below = """() => { const range = [...(CSS.highlights.get('ccrd-speech') || [])][0];
              const box = document.querySelector('#viewport').getBoundingClientRect();
              return !!range && range.getBoundingClientRect().top > box.bottom; }"""
            passed = 0
            for _ in range(40):  # walk the sentence past the bottom of the viewport, then two more
                page.locator("#speech-next").click()
                wait(page, f"() => document.querySelector('#speech-audio').src !== {json.dumps(clip)}")
                clip = page.locator("#speech-audio").evaluate("n => n.src")
                page.wait_for_timeout(250)
                self.assertEqual(viewport.evaluate("n => n.scrollTop"), moved)
                passed += page.evaluate(below)
                if passed >= 2:
                    break
            self.assertGreaterEqual(passed, 2)
            page.wait_for_timeout(900)
            self.assertEqual(viewport.evaluate("n => n.scrollTop"), moved)
            self.stop(page)
            self.assertFalse(errors, errors)
        finally:
            context.close()

    def test_listening_starts_where_the_reader_is_looking(self):
        body = "".join(f"第{index}句。\n" for index in range(400)).encode()
        context, page, posts, errors = self.open("txt", body, "text/plain; charset=utf-8")
        try:
            page.locator("#viewport").evaluate("n => { n.scrollTop = 4000; }")
            page.wait_for_timeout(400)
            # The first line at the top of the viewport, measured independently.
            first = page.evaluate("""() => { const box = document.querySelector('#viewport').getBoundingClientRect();
              const node = document.querySelector('.reader-text-block').firstChild, range = document.createRange();
              for (let i = 0; i < node.length; i++) { range.setStart(node, i); range.setEnd(node, i + 1);
                const r = range.getClientRects()[0]; if (r && r.height && r.bottom > box.top + 4) return node.data.slice(i).match(/第(\\d+)句/)[1]; } }""")
            self.assertGreater(int(first), 50)
            job = self.play(page, posts)
            self.assertTrue(job["text"].lstrip().startswith(f"第{first}句") or job["text"].lstrip().startswith(f"{first}句"), (first, job["text"][:30]))
            self.stop(page)
            self.assertFalse(errors, errors)
        finally:
            context.close()

    def test_closing_the_reader_keeps_reading_in_the_background(self):
        context, page, posts, errors, frame = self.open("txt", TEXT.encode(), "text/plain; charset=utf-8", host=True)
        try:
            self.play(frame, posts)
            page.evaluate("() => __nav.unmount()")
            bar = page.locator(".reader-speech-mini")
            bar.wait_for(timeout=3000)
            self.assertTrue(page.evaluate("() => __reader.isConnected && __nav.backgroundReader === __reader"))
            self.assertEqual(page.evaluate("getComputedStyle(__reader).visibility"), "hidden")
            before = frame.evaluate("() => [document.querySelector('#speech-audio').src, document.querySelector('#speech-audio').currentTime]")
            page.wait_for_timeout(1500)
            after = frame.evaluate("() => [document.querySelector('#speech-audio').src, document.querySelector('#speech-audio').currentTime]")
            self.assertNotEqual(before, after)  # still reading while hidden
            # Pause / continue from the search page.
            bar.get_by_role("button", name="暂停").click()
            wait(frame, "() => document.querySelector('#speech-audio').paused", 5000)
            bar.get_by_role("button", name="继续").wait_for(timeout=3000)
            bar.get_by_role("button", name="继续").click()
            wait(frame, "() => !document.querySelector('#speech-audio').paused", 5000)
            # Back to the same Reader (not a reload), still reading.
            bar.get_by_role("button", name="返回阅读").click()
            self.assertEqual(page.locator(".reader-speech-mini").count(), 0)
            self.assertTrue(page.evaluate("() => document.querySelector('iframe.reader-overlay') === __reader && !__nav.backgroundReader && getComputedStyle(__reader).visibility === 'visible'"))
            self.assertFalse(frame.evaluate("() => document.querySelector('#speech-audio').paused"))
            # Opening another book leaves the background reading untouched.
            page.evaluate("() => __nav.unmount()")
            bar.wait_for(timeout=3000)
            page.evaluate("url => { window.__next = __nav.mount(new URL(url)); }", self.reader_url("txt", "other"))
            self.assertTrue(page.evaluate("() => __reader.isConnected && __next !== __reader && __nav.backgroundReader === __reader"))
            self.assertEqual(page.locator(".reader-speech-mini").count(), 1)
            next_frame = page.wait_for_selector("iframe.reader-overlay:not(.reader-overlay-parked)").content_frame()
            # Starting the new book's speech is the explicit takeover.
            self.play(next_frame, posts)
            wait(page, "() => !__reader.isConnected && !__nav.backgroundReader", 5000)
            self.assertEqual(page.locator(".reader-speech-mini").count(), 0)
            # Closing the new reading Reader parks it as the background Reader.
            page.evaluate("() => __nav.unmount()")
            bar.wait_for(timeout=3000)
            self.assertTrue(page.evaluate("() => __next.isConnected && __nav.backgroundReader === __next"))
            bar.get_by_role("button", name="停止").click()
            wait(page, "() => !__next.isConnected && !__nav.backgroundReader", 5000)
            self.assertEqual(page.locator(".reader-speech-mini").count(), 0)
            self.assertFalse(errors, errors)
        finally:
            context.close()

    def test_leaving_a_standalone_reader_keeps_reading_on_the_search_page(self):
        # A Reader opened directly (not as an overlay) cannot keep its audio when
        # ← navigates to the search page; that page resumes it at the same sentence.
        context, page, posts, errors = self.open("txt", TEXT.encode(), "text/plain; charset=utf-8")
        try:
            self.play(page, posts)
            for _ in range(3):
                clip = page.locator("#speech-audio").evaluate("n => n.src")
                page.locator("#speech-next").click()
                wait(page, f"() => document.querySelector('#speech-audio').src !== {json.dumps(clip)}")
            # The sentence being read (the resumed job starts at its beginning).
            playing = page.evaluate("""() => { const s = CCRDSpeech.state(), t = s.adapter.text; let i = s.position;
              while (i > 0 && !/[。！？\\n]/.test(t[i - 1])) i--; return t.slice(i, i + 8).trim(); }""")
            self.assertTrue(playing and not playing.startswith("第0段"), playing)
            before = len(posts)
            reader = page.url
            base = reader.split("reader.html")[0]
            page.goto(base + "search/reader-navigation.js", wait_until="domcontentloaded")  # leaving fires pagehide
            page.add_style_tag(content=(ROOT / "static/style.css").read_text(encoding="utf-8"))
            page.add_script_tag(content=(ROOT / "static/search/reader-navigation.js").read_text(encoding="utf-8"))
            page.evaluate("url => { window.__nav = VoiceOfMLReaderNavigation.createNavigation(new URL(url).pathname, { resume: next => __nav.mount(new URL(next)) }); }", reader)
            bar = page.locator(".reader-speech-mini")
            bar.wait_for(timeout=5000)
            kept = page.wait_for_selector("iframe.reader-overlay-parked", state="attached")
            self.assertEqual(page.evaluate("() => getComputedStyle(document.querySelector('iframe.reader-overlay-parked')).visibility"), "hidden")
            frame = kept.content_frame()
            wait(frame, "()=>{const a=document.querySelector('#speech-audio');return !!a&&!a.paused&&a.currentTime>0.05}", 30000)
            self.assertTrue(posts[before]["text"].lstrip().startswith(playing), (playing, posts[before]["text"][:30]))
            self.assertEqual(frame.evaluate("() => window.name"), "")
            self.assertEqual(page.evaluate("() => sessionStorage.getItem('reader-speech-handoff')"), None)
            bar.get_by_role("button", name="返回阅读").click()
            self.assertEqual(page.locator(".reader-speech-mini").count(), 0)
            self.assertFalse(frame.evaluate("() => document.querySelector('#speech-audio').paused"))
            # A Reader left without reading aloud (or reloaded) leaves nothing to resume.
            frame.locator("#speech-stop").click()
            page.goto(reader, wait_until="domcontentloaded")
            wait(page, "() => document.documentElement.dataset.readerPhase === 'ready'", 30000)
            page.goto(base + "search/reader-navigation.js", wait_until="domcontentloaded")
            self.assertEqual(page.evaluate("() => sessionStorage.getItem('reader-speech-handoff')"), None)
            self.assertFalse(errors, errors)
        finally:
            context.close()

    def test_first_search_load_resumes_a_handoff_without_session_storage(self):
        # A Reader opened as the first page writes both stores. A search document
        # that was never loaded has no sessionStorage handoff; the localStorage
        # fallback still lets it show the background bar and resume.
        context, page, posts, errors = self.open("txt", TEXT.encode(), "text/plain; charset=utf-8")
        try:
            self.play(page, posts)
            reader = page.url
            base = reader.split("reader.html")[0]
            page.goto(base + "empty", wait_until="domcontentloaded")  # pagehide writes the handoff
            page.evaluate("() => sessionStorage.removeItem('reader-speech-handoff')")
            page.goto(base + "search/reader-navigation.js", wait_until="domcontentloaded")
            page.add_style_tag(content=(ROOT / "static/style.css").read_text(encoding="utf-8"))
            page.add_script_tag(content=(ROOT / "static/search/reader-navigation.js").read_text(encoding="utf-8"))
            page.evaluate("url => { window.__nav = VoiceOfMLReaderNavigation.createNavigation(new URL(url).pathname, { resume: next => __nav.mount(new URL(next)) }); }", reader)
            bar = page.locator(".reader-speech-mini")
            bar.wait_for(timeout=5000)
            kept = page.wait_for_selector("iframe.reader-overlay-parked", state="attached")
            frame = kept.content_frame()
            wait(frame, "()=>{const a=document.querySelector('#speech-audio');return !!a&&!a.paused&&a.currentTime>0.05}", 30000)
            self.assertEqual(page.evaluate("() => sessionStorage.getItem('reader-speech-handoff')"), None)
            self.assertEqual(page.evaluate("() => localStorage.getItem('reader-speech-handoff')"), None)
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

    def test_sparse_pdf_reads_distant_text_page_and_follows_there(self):
        # Like scanned books with an appended information page: only page 30 has text.
        count = 30
        stream = b"BT /F1 18 Tf 20 100 Td (Information Page Text.) Tj ET"
        kids = " ".join(f"{3 + index} 0 R" for index in range(count)).encode()
        objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [" + kids + b"] /Count " + str(count).encode() + b" >>"]
        for index in range(count):
            contents = f" /Contents {3 + count} 0 R" if index == count - 1 else ""
            objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 {4 + count} 0 R >> >>{contents} >>".encode())
        objects += [b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
                    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
        payload = bytearray(b"%PDF-1.4\n"); offsets = []
        for number, body in enumerate(objects, 1):
            offsets.append(len(payload)); payload.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
        xref = len(payload); payload.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
        for offset in offsets: payload.extend(f"{offset:010d} 00000 n \n".encode())
        payload.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
        context, page, posts, errors = self.open("pdf", bytes(payload), "application/pdf")
        try:
            # No text near page 1: no button. It appears once the text page is in view.
            page.wait_for_timeout(2500)
            self.assertEqual(page.locator("[data-speech-toggle]").count(), 0)
            page.locator("#viewport").evaluate("n => { n.scrollTop = n.scrollHeight; }")
            job = self.play(page, posts)
            self.assertIn("Information Page Text", job["text"])
            wait(page, "() => CSS.highlights.has('ccrd-speech')", 15000)
            self.assertTrue(page.evaluate("""() => { const r = document.querySelector('.reader-page[data-page="30"]').getBoundingClientRect();
              const v = document.querySelector('#viewport').getBoundingClientRect(); return r.bottom > v.top && r.top < v.bottom; }"""))
            self.stop(page)
            self.assertFalse(errors, errors)
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

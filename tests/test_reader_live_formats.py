import gzip
import hashlib
import json
import os
import re
import time
import unittest
import urllib.parse
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


BASE = os.environ.get("GITHUB_SEARCH_LIVE_BASE_URL", "").rstrip("/")
API_BASE = os.environ.get("GITHUB_SEARCH_API_BASE_URL", "").rstrip("/")
READER_PATH = "/search/static/reader.html"
# The Reader-Assets index both sites consume (HF backend refresh, Pages build). The former
# `vomebook/Reader-Assets` dataset and its manifest.json have been deleted.
READER_ASSETS_INDEX_URL = "https://huggingface.co/buckets/vomebook/reader-assets-v2/resolve/reader-index/reader_assets.json.gz"
SAMPLE_ORDER = ("pdf", "pdf-pages", "epub", "mobi", "azw3", "audio", "video", "fb2", "html", "odt", "rtf", "mht", "txt", "md")
SAMPLES = ()
SAMPLE_BY_NAME = {}
SAMPLE_FILTER = os.environ.get("READER_LIVE_SAMPLE", "")
RAW_SAMPLE_NAMES = ("txt", "md")
RESPONSIVE_THEME_MATRIX = (
    ("desktop-light", {"width": 1440, "height": 900}, "light", "no-preference"),
    ("tablet-dark", {"width": 820, "height": 1180}, "dark", "no-preference"),
    ("mobile-high-contrast", {"width": 390, "height": 844}, "dark", "more"),
)


HTML_SOURCES = {"html": ("html", "htm"), "odt": ("odt",), "rtf": ("rtf",), "mht": ("mht", "mhtml")}


def _index_sample(entry):
    """Map one Reader-Assets index entry to (name, bucket path, ext, mode), as assetFields does."""
    if not isinstance(entry, dict) or entry.get("s") != 2:
        return None  # 3 = OCR-only manifest, not a readable primary asset
    mode, path, bucket = entry.get("m"), str(entry.get("p") or ""), entry.get("b")
    if mode == "e" and entry.get("cb") == "vomebook/reader-assets-v2":
        parts = str(entry.get("c") or "").split("/")
        if len(parts) == 6 and parts[:2] == ["chapters", "ebook"] and parts[-1] == "chapter-manifest.json":
            return parts[2], entry["c"], "epub-chapters", "epub-chapters"
    if mode == "p" and bucket == "vomebook/pdf-pages-v2":
        if path.endswith("/page-manifest.json") and not entry.get("o") and not entry.get("pd"):
            return "pdf-pages", path, "pdf-pages", "pdf-pages"
        if path.endswith("/document.pdf") and not entry.get("o"):
            return "pdf", path, "pdf", "pdf"
    if bucket != "vomebook/reader-assets-v2":
        return None
    if mode == "a" and path.startswith("media/audio/mp3/"):
        return "audio", path, "audio", "audio"
    if mode == "v" and path.startswith("media/video/mp4/"):
        return "video", path, "video", "video"
    if mode == "h":
        for name, sources in HTML_SOURCES.items():
            if any(path.startswith(f"documents/web/{source}/") for source in sources):
                return name, path, "html", "html"
    return None


class ReaderIndexSampleTests(unittest.TestCase):
    def test_index_entries_map_like_reader_asset_fields(self):
        chapters = "chapters/ebook/mobi/" + "a" * 64 + "/" + "b" * 16 + "/chapter-manifest.json"
        cases = (
            ({"b": "vomebook/pdf-pages-v2", "m": "p", "s": 2, "p": "derived/m/" + "c" * 32 + "/document.pdf"}, ("pdf", "pdf")),
            ({"b": "vomebook/pdf-pages-v2", "m": "p", "s": 2, "p": "objects/40/" + "d" * 64 + "/" + "e" * 16 + "/page-manifest.json"}, ("pdf-pages", "pdf-pages")),
            ({"b": "vomebook/reader-assets-v2", "m": "e", "s": 2, "p": chapters, "c": chapters, "cb": "vomebook/reader-assets-v2"}, ("mobi", "epub-chapters")),
            ({"b": "vomebook/reader-assets-v2", "m": "a", "s": 2, "p": "media/audio/mp3/" + "f" * 64 + "/audio.mp3"}, ("audio", "audio")),
            ({"b": "vomebook/reader-assets-v2", "m": "v", "s": 2, "p": "media/video/mp4/" + "f" * 64 + "/video.mp4"}, ("video", "video")),
            ({"b": "vomebook/reader-assets-v2", "m": "h", "s": 2, "p": "documents/web/htm/" + "f" * 64 + "/document.html"}, ("html", "html")),
            ({"b": "vomebook/reader-assets-v2", "m": "h", "s": 2, "p": "documents/web/mht/" + "f" * 64 + "/document.html"}, ("mht", "html")),
        )
        for entry, (name, mode) in cases:
            with self.subTest(entry=entry):
                sample = _index_sample(entry)
                self.assertEqual((sample[0], sample[3]), (name, mode))
                self.assertEqual(sample[1], entry.get("c") or entry["p"])

    def test_ocr_hybrid_and_unreadable_entries_are_not_samples(self):
        base = {"b": "vomebook/pdf-pages-v2", "m": "p", "s": 2, "p": "objects/40/" + "d" * 64 + "/" + "e" * 16 + "/page-manifest.json"}
        for entry in ({**base, "s": 3}, {**base, "o": "x/ocr-manifest.json"}, {**base, "pd": "derived/x/document.pdf"},
                      {"b": "vomebook/reader-assets-v2", "m": "a", "s": 2, "p": "media/audio/wav/" + "f" * 64 + "/audio.wav"},
                      {"b": "vomebook/reader-assets-v2", "m": "h", "s": 2, "p": "documents/spreadsheet/xlsx/" + "f" * 64 + "/document.html"}):
            with self.subTest(entry=entry):
                self.assertIsNone(_index_sample(entry))


def _await_value(page, expression, arg, timeout):
    """Poll an expression whose value may be a Promise; wait_for_function does not await it."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if page.evaluate(expression, arg):
            return True
        page.wait_for_timeout(200)
    return False


def _raw_source_url(record):
    for field in ("ReaderLink", "readerLink", "Link", "link", "source_url", "SourceUrl", "sourceUrl", "DownloadLink", "DownloadURL", "download_link", "download_url"):
        value = record.get(field)
        if not isinstance(value, str) or not value:
            continue
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme != "https" or parsed.hostname not in {"huggingface.co", "hf-mirror.com"}:
            continue
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) >= 6 and parts[0] == "datasets" and parts[3] in {"resolve", "raw"} and parts[4] and parts[5:]:
            return value
    return None


def _select_raw_sample(name, extensions):
    if not API_BASE:
        return None, "GITHUB_SEARCH_API_BASE_URL is not set"
    payload = json.dumps({"q": "", "extensions": list(extensions), "page": 1, "page_size": 5}).encode()
    request = urllib.request.Request(API_BASE + "/api/search", data=payload, headers={"Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=45) as response:
        body = json.load(response)
    records = body.get("results") if isinstance(body, dict) else None
    if not isinstance(records, list):
        raise RuntimeError("API response has no results list")
    for record in records:
        if not isinstance(record, dict):
            continue
        extension = str(record.get("Extension") or record.get("extension") or "").lower().lstrip(".")
        filename = str(record.get("File") or record.get("file") or "")
        suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if extension not in extensions and suffix not in extensions:
            continue
        source = _raw_source_url(record)
        if source:
            return (name, source, name, "text" if name == "txt" else "markdown", None if name == "txt" else True), None
    return None, "API returned no safe direct raw source in the first 5 results"


def _select_samples():
    with urllib.request.urlopen(READER_ASSETS_INDEX_URL, timeout=60) as response:
        payload = response.read()
    index = json.loads(gzip.decompress(payload))
    if not isinstance(index, dict) or index.get("v") != 1 or not isinstance(index.get("f"), dict):
        raise RuntimeError("unexpected Reader-Assets index format")
    revision = "sha256:" + hashlib.sha256(payload).hexdigest()
    print("Reader-Assets index:", revision, "v3 generation:", (index.get("v3") or {}).get("generation"))
    resource = (API_BASE or "https://voiceofml-search.hf.space") + "/api/reader-bucket-resource?path="
    selected = {}
    for key in sorted(index["f"]):
        sample = _index_sample(index["f"][key])
        if sample and sample[0] in SAMPLE_ORDER and sample[0] not in selected:
            name, path, extension, mode = sample
            selected[name] = (name, resource + urllib.parse.quote(path, safe=""), extension, mode, None)
    raw_skips = {}
    for name, extensions in (("txt", ("txt",)), ("md", ("md", "markdown"))):
        try:
            sample, reason = _select_raw_sample(name, extensions)
            if sample:
                selected[name] = sample
            elif reason:
                raw_skips[name] = reason
        except Exception as error:
            raw_skips[name] = f"raw API selector failed: {error}"
    for name, reason in raw_skips.items():
        print(f"Raw {name} sample skipped: {reason}")
    return tuple(selected[name] for name in SAMPLE_ORDER if name in selected), revision, raw_skips


@unittest.skipUnless(BASE and sync_playwright, "set GITHUB_SEARCH_LIVE_BASE_URL and install Playwright")
class ReaderLiveFormatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        global SAMPLES, SAMPLE_BY_NAME
        try:
            SAMPLES, cls.reader_assets_revision, cls.raw_sample_skips = _select_samples()
        except Exception as error:
            raise unittest.SkipTest(f"Reader-Assets/raw sample selection unavailable: {error}")
        SAMPLE_BY_NAME = {sample[0]: sample for sample in SAMPLES}

    def sample_or_skip(self, name):
        sample = SAMPLE_BY_NAME.get(name)
        if sample is None:
            reason = getattr(self, "raw_sample_skips", {}).get(name)
            source = "raw API" if name in RAW_SAMPLE_NAMES else "Reader-Assets"
            self.skipTest(f"{source} has no readable sample for {name}: {reason or 'no matching sample'}")
        return sample

    def reader_url(self, source, extension, title):
        query = urllib.parse.urlencode({"url": source, "ext": extension, "title": title})
        return f"{BASE}{READER_PATH}?{query}"

    def open_reader(self, context, sample):
        name, source, extension, mode, _expected_toc = sample
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(self.reader_url(source, extension, name), wait_until="domcontentloaded", timeout=120000)
        page.wait_for_function(
            "() => ['ready', 'failed'].includes(document.documentElement.dataset.readerPhase)",
            timeout=120000,
        )
        phase = page.locator("html").get_attribute("data-reader-phase")
        if phase == "failed" and name == "video" and page.locator("#content").get_attribute("data-error-code") == "READER_MEDIA":
            return page, errors
        if phase != "ready":
            self.fail(f"{name}: phase={phase} code={page.locator('#content').get_attribute('data-error-code')} text={page.locator('#content').inner_text()[:300]}")
        self.assertEqual(page.locator("#content").get_attribute("data-mode"), mode, name)
        return page, errors

    def assert_content_ready(self, page, name, mode):
        if mode == "pdf":
            page.locator(".reader-page[data-page='1'] canvas.ready").wait_for(timeout=120000)
            self.assertGreater(int(page.locator(".reader-page[data-page='1'] canvas").get_attribute("width")), 0, name)
        elif mode == "pdf-pages":
            page.locator(".reader-page[data-page='1'] img.ready").wait_for(timeout=120000)
            self.assertTrue(page.locator(".reader-page[data-page='1'] img").evaluate("image => image.complete && image.naturalWidth > 0"), name)
        elif mode == "foliate":
            article = page.locator(".foliate-continuous article").first
            article.wait_for(state="attached", timeout=120000)
            self.assertGreater(article.evaluate("node => (node.shadowRoot || node).textContent.trim().length"), 0, name)
        elif mode == "epub-chapters":
            chapter = page.locator(".reader-epub-chapter").filter(has_text=re.compile(r"\S")).first
            chapter.wait_for(state="attached", timeout=120000)
        elif mode == "html":
            frame = page.frame_locator(".html-frame")
            self.assertGreater(len(frame.locator("body").inner_text(timeout=120000).strip()), 0, name)
            if name == "mht":
                page.wait_for_function("""() => {
                  const frame = document.querySelector('.html-frame');
                  const images = [...(frame?.contentDocument?.images || [])];
                  return images.every(image => image.complete);
                }""", timeout=30000)
                broken = frame.locator("img").evaluate_all("images => images.filter(image => !image.complete || image.naturalWidth === 0).map(image => image.src)")
                self.assertEqual(broken, [], name)
        elif mode in {"text", "markdown"}:
            selector = ".reader-text" if mode == "text" else ".reader-markdown"
            content = page.locator(selector)
            content.wait_for(state="attached", timeout=120000)
            self.assertGreater(len(content.inner_text().strip()), 0, name)
        else:
            media = page.locator(".reader-audio" if mode == "audio" else ".reader-video")
            selector = ".reader-audio" if mode == "audio" else ".reader-video"
            page.wait_for_function("selector => document.querySelector(selector)?.readyState >= 1 || document.documentElement.dataset.readerPhase === 'failed'", arg=selector, timeout=120000)
            if page.locator("html").get_attribute("data-reader-phase") == "failed":
                self.assertEqual(page.locator("#content").get_attribute("data-error-code"), "READER_MEDIA", name)
                return
            metadata = media.evaluate("element => ({controls: element.controls, preload: element.preload, paused: element.paused, autoplay: element.autoplay, duration: element.duration, width: element.videoWidth || 0, height: element.videoHeight || 0})")
            self.assertTrue(metadata["controls"], name)
            self.assertEqual(metadata["preload"], "metadata", name)
            self.assertTrue(metadata["paused"], name)
            self.assertFalse(metadata["autoplay"], name)
            self.assertGreater(metadata["duration"], 0, name)
            if mode == "video":
                self.assertGreater(metadata["width"], 0, name)
                self.assertGreater(metadata["height"], 0, name)

    def activate_toc_when_available(self, page, expected_toc, name):
        count = page.locator("#toc-list .toc-item").count()
        if expected_toc is True and name != "md":
            self.assertGreater(count, 0, name)
        elif expected_toc is False:
            self.assertEqual(count, 0, name)
        if not count:
            return
        # The Reader opens the directory itself once a TOC is known (since 2026-10-17),
        # so toggle the drawer only while it is closed.
        for _ in range(3):
            if page.locator("#history").get_attribute("aria-expanded") == "true":
                break
            page.locator("#history").click()
            page.wait_for_timeout(300)
        self.assertEqual(page.locator("#history").get_attribute("aria-expanded"), "true", name)
        page.locator("#toc-tab").click()
        target = 1 if count > 1 else 0
        page.locator("#toc-list .toc-item .panel-item-main").nth(target).click()
        page.wait_for_timeout(500)
        self.assertEqual(page.locator("html").get_attribute("data-reader-phase"), "ready", name)

    def test_commit_pinned_format_matrix(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for name in (item for item in SAMPLE_ORDER if not SAMPLE_FILTER or item == SAMPLE_FILTER):
                with self.subTest(sample=name):
                    # A family missing from the index is reported as a skip, not dropped.
                    sample = self.sample_or_skip(name)
                    _name, _source, _extension, mode, expected_toc = sample
                    context = browser.new_context(viewport={"width": 1440, "height": 900}, service_workers="block")
                    page, errors = self.open_reader(context, sample)
                    self.assert_content_ready(page, name, mode)
                    self.activate_toc_when_available(page, expected_toc, name)
                    self.assertEqual(errors, [], name)
                    context.close()
            browser.close()

    def test_pdf_and_pdf_pages_next_page_navigation(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for name in ("pdf", "pdf-pages"):
                with self.subTest(sample=name):
                    sample = self.sample_or_skip(name)
                    context = browser.new_context(viewport={"width": 1440, "height": 900}, service_workers="block")
                    page, errors = self.open_reader(context, sample)
                    self.assertGreaterEqual(int(page.locator("#page-number").get_attribute("max")), 2, name)
                    page.locator("#page-next").evaluate("button => button.click()")
                    page.wait_for_function("() => document.querySelector('#page-number').value === '2'", timeout=120000)
                    ready_selector = ".reader-page[data-page='2'] canvas.ready" if name == "pdf" else ".reader-page[data-page='2'] img.ready"
                    page.locator(ready_selector).wait_for(timeout=120000)
                    self.assertEqual(errors, [], name)
                    context.close()
            browser.close()

    def test_representative_responsive_theme_matrix(self):
        html_sample = self.sample_or_skip("html")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for name, viewport, theme, contrast in RESPONSIVE_THEME_MATRIX:
                with self.subTest(matrix=name):
                    context = browser.new_context(viewport=viewport, color_scheme=theme, contrast=contrast, service_workers="block")
                    context.add_init_script(f"localStorage.setItem('theme', '{theme}')")
                    page, errors = self.open_reader(context, html_sample)
                    self.assertEqual(page.locator("html").get_attribute("data-theme"), theme, name)
                    self.assertEqual(page.evaluate("matchMedia('(prefers-contrast: more)').matches"), contrast == "more", name)
                    layout = page.evaluate("""() => {
                      const toolbar = document.querySelector('.reader-toolbar').getBoundingClientRect();
                      const viewport = document.querySelector('#viewport').getBoundingClientRect();
                      const controls = [...document.querySelectorAll('.reader-toolbar button, .reader-toolbar input, .reader-toolbar a')]
                        .filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })
                        .map(element => { const rect = element.getBoundingClientRect(); return {id: element.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}; });
                      const overlaps = [];
                      controls.forEach((first, index) => controls.slice(index + 1).forEach(second => {
                        if (first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom) overlaps.push(`${first.id}/${second.id}`);
                      }));
                      return {toolbar: toolbar.toJSON(), viewport: viewport.toJSON(), controls, overlaps, documentWidth: document.documentElement.scrollWidth, windowWidth: innerWidth};
                    }""")
                    self.assertEqual(layout["overlaps"], [], name)
                    self.assertLessEqual(layout["documentWidth"], layout["windowWidth"] + 1, name)
                    self.assertGreaterEqual(layout["viewport"]["top"], layout["toolbar"]["bottom"] - 1, name)
                    self.assertGreaterEqual(layout["viewport"]["left"], 0, name)
                    self.assertLessEqual(layout["viewport"]["right"], layout["windowWidth"] + 1, name)
                    for control in layout["controls"]:
                        self.assertGreaterEqual(control["left"], 0, f"{name}: {control['id']}")
                        self.assertLessEqual(control["right"], layout["windowWidth"] + 1, f"{name}: {control['id']}")
                    self.assertEqual(errors, [], name)
                    context.close()
            browser.close()

    def test_client_local_pdf_pages_progress_restore(self):
        sample = self.sample_or_skip("pdf-pages")
        source = sample[1]
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 900}, service_workers="block")
            first, first_errors = self.open_reader(context, sample)
            first.locator("#page-next").evaluate("button => button.click()")
            first.wait_for_function("() => document.querySelector('#page-number').value === '2'", timeout=120000)
            first.wait_for_timeout(1000)
            self.assertEqual(first.locator("#page-number").input_value(), "2")
            # Closing before the debounced save lands would lose it.
            self.assertTrue(_await_value(first, "url => VoiceOfMLReaderStore.get(url).then(entry => entry?.page === 2)", source, 30), "page 2 not saved")
            first.close()
            second, second_errors = self.open_reader(context, sample)
            second.wait_for_timeout(1000)
            restored = second.evaluate("url => VoiceOfMLReaderStore.get(url).then(entry => ({entry, page: document.querySelector('#page-number').value}))", source)
            self.assertEqual(restored["page"], "2", restored)
            self.assertEqual(first_errors + second_errors, [])
            context.close()
            browser.close()

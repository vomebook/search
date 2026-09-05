import json
import os
import unittest
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


BASE = os.environ.get("GITHUB_SEARCH_LIVE_BASE_URL", "").rstrip("/")
API_BASE = os.environ.get("GITHUB_SEARCH_API_BASE_URL", "").rstrip("/")
READER_PATH = "/search/static/reader.html"
MANIFEST_URL = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/manifest.json"
REPO_API_URL = "https://huggingface.co/api/datasets/vomebook/Reader-Assets"
KNOWN_PDF_PAGES_PATH = "objects/40/400fab592d48d49dfbf90c1be75e0fc964557ff044b0df2ebcab35c586ed7f71/4b5e1b60723476d4/page-manifest.json"
ASSET_ROOT = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main"
SAMPLES = ()
"""
    ("mobi", f"{ASSET_ROOT}/objects/a9/a920bb7db749a5d74bd899a3392fc7c3740f655f3730e3128b23a9fe1eb78563/foliate-original-v1/document.mobi", "mobi", "foliate", None),
    ("azw3", f"{ASSET_ROOT}/objects/65/6563fed9b66427417ef9c9c44f9fcc189979cded190a9de7cd445b1cb6c9d14f/foliate-original-v1/document.azw3", "azw3", "foliate", True),
    ("audio", f"{ASSET_ROOT}/objects/36/3679a0ead0d3d72bacf71b392dbba708107f767a7bee4382909469d519259120/ffmpeg-audio-mp3-v1/audio.mp3", "mp3", "audio", False),
    ("video", f"{ASSET_ROOT}/objects/9b/9bd4e16a28936dbf9f0bf9dbcdb09b0dc9889743c5f314c0720019175181ca91/ffmpeg-video-mp4-h264-aac-v1/video.mp4", "mp4", "video", False),
    ("fb2", f"{ASSET_ROOT}/objects/79/794a61d8a31327c495e56313bdf19895b94885e9fcd2e2b8bd5f9fc5057b8608/foliate-original-v1/document.fb2", "fb2", "foliate", True),
    ("fb2-cn", f"{ASSET_ROOT}/objects/ab/ab658eeefdcfedf881cc93cff87d10a06d902af497328315460875038c769381/foliate-original-v1/document.fb2", "fb2", "foliate", True),
    ("docx", f"{ASSET_ROOT}/objects/37/3795cbd583cbb49d3cef6e4518e7cde21b2de9295f8387327f10e44de3fa8a24/docx-native-v2/document.docx", "docx", "docx", False),
    ("html", f"{ASSET_ROOT}/objects/23/23e3eb7e0d93e496ce57e6c0a44d977a42b91991409b516b087e6a79b10bb4a7/sanitized-html-v5-e2f98d3c6dd02d16/document.html", "html", "html", True),
)
"""
SAMPLE_BY_NAME = {}
SAMPLE_FILTER = os.environ.get("READER_LIVE_SAMPLE", "")
RAW_SAMPLE_NAMES = ("txt", "md")
RESPONSIVE_THEME_MATRIX = (
    ("desktop-light", {"width": 1440, "height": 900}, "light", "no-preference"),
    ("tablet-dark", {"width": 820, "height": 1180}, "dark", "no-preference"),
    ("mobile-high-contrast", {"width": 390, "height": 844}, "dark", "more"),
)


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
    request = urllib.request.Request(MANIFEST_URL, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        manifest = json.load(response)
        revision = os.environ.get("READER_ASSETS_REVISION") or response.headers.get("X-Repo-Commit")
    if not revision:
        try:
            with urllib.request.urlopen(REPO_API_URL, timeout=30) as response:
                revision = json.load(response).get("sha")
        except (HTTPError, URLError, OSError, ValueError):
            revision = None
    if not revision:
        raise RuntimeError("Reader-Assets revision unavailable; set READER_ASSETS_REVISION")
    print("Reader-Assets revision:", revision)
    root = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main"
    ready = [v for v in manifest.get("files", {}).values() if v.get("status") == "ready" and v.get("path") and v.get("sha256")]
    wanted = {"pdf": ("pdf",), "epub": ("epub",), "mobi": ("mobi",), "azw3": ("azw3",), "fb2": ("fb2",), "docx": ("docx", "doc"), "html": ("html", "htm")}
    selected = {}
    for name, extensions in wanted.items():
        candidates = [v for v in ready if v.get("source_extension", "").lower() in extensions]
        if name == "pdf":
            candidates = [v for v in candidates if v.get("reader_mode") == "pdf"] or candidates
        if candidates:
            item = candidates[0]
            selected[name] = (name, f"{root}/{item['path']}", item.get("source_extension", name), item.get("reader_mode", name), None)
    for mode in ("audio", "video"):
        candidates = [v for v in ready if v.get("reader_mode") == mode or (mode == "audio" and v.get("source_extension", "").lower() == "mp3")]
        if candidates:
            item = candidates[0]
            selected[mode] = (mode, f"{root}/{item['path']}", item.get("source_extension", mode), mode, False)
    page = manifest.get("pdf_manifest")
    page_path = page.get("path") if isinstance(page, dict) else KNOWN_PDF_PAGES_PATH
    page_url = f"https://voiceofml-search.hf.space/api/reader-bucket-resource?path={urllib.parse.quote(page_path, safe='')}"
    try:
        with urllib.request.urlopen(urllib.request.Request(page_url, method="HEAD"), timeout=30) as response:
            if 200 <= response.status < 400:
                selected["pdf-pages"] = ("pdf-pages", page_url, "pdf-pages", "pdf-pages", False)
    except (HTTPError, URLError, OSError):
        pass
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
    order = ("pdf", "pdf-pages", "epub", "mobi", "azw3", "audio", "video", "fb2", "docx", "html", "txt", "md")
    return tuple(selected[name] for name in order if name in selected), revision, raw_skips


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
        elif mode == "html":
            self.assertGreater(len(page.frame_locator(".html-frame").locator("body").inner_text(timeout=120000).strip()), 0, name)
        elif mode == "docx":
            self.assertGreater(len(page.locator("#content").inner_text().strip()), 0, name)
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
        page.locator("#history").click()
        page.locator("#toc-tab").click()
        target = 1 if count > 1 else 0
        page.locator("#toc-list .toc-item .panel-item-main").nth(target).click()
        page.wait_for_timeout(500)
        self.assertEqual(page.locator("html").get_attribute("data-reader-phase"), "ready", name)

    def test_commit_pinned_format_matrix(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for sample in (item for item in SAMPLES if not SAMPLE_FILTER or item[0] == SAMPLE_FILTER):
                name, _source, _extension, mode, expected_toc = sample
                with self.subTest(sample=name):
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
            first.wait_for_function("url => VoiceOfMLReaderStore.get(url).then(entry => entry?.page === 2)", arg=source, timeout=30000)
            first.close()
            second, second_errors = self.open_reader(context, sample)
            second.wait_for_timeout(1000)
            restored = second.evaluate("url => VoiceOfMLReaderStore.get(url).then(entry => ({entry, page: document.querySelector('#page-number').value}))", source)
            self.assertEqual(restored["page"], "2", restored)
            self.assertEqual(first_errors + second_errors, [])
            context.close()
            browser.close()

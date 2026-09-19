"""Focused browser checks for reader CSS, independent of format-engine suites."""

import io
import unittest
import urllib.parse
import zipfile

from tests.browser_support import local_server
from tests.test_reader_performance import (
    STORE_SCRIPT,
    PlaywrightError,
    epub_with_navigation,
    minimal_docx,
    sync_playwright,
    zip_bytes,
)


@unittest.skipIf(sync_playwright is None, "install requirements-test.txt for reader style tests")
class ReaderStyleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = local_server()
        cls.origin, _ = cls.server.__enter__()
        cls.addClassCleanup(cls.server.__exit__, None, None, None)
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True)
        except PlaywrightError as error:
            raise unittest.SkipTest(str(error))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        context = self.browser.new_context(viewport={"width": 1440, "height": 900})
        self.addCleanup(context.close)
        self.page = context.new_page()
        self.page.add_init_script("localStorage.setItem('theme', 'dark')")
        self.page.route("**/static/reader-store.js", lambda route: route.fulfill(
            content_type="text/javascript", body=STORE_SCRIPT
        ))
        self.page.route("**/api/reader-content**", lambda route: route.fulfill(
            content_type="text/plain", body="Reader style fixture\n" * 80
        ))
        source = urllib.parse.quote(
            "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/style.txt", safe=""
        )
        self.page.goto(
            f"{self.origin}/search/static/reader.html?url={source}&ext=txt&title=Style&path=Test",
            wait_until="domcontentloaded",
        )
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")

    def settle(self):
        self.page.wait_for_function("""() =>
            !document.documentElement.classList.contains('theme-transition') &&
            !document.getAnimations().some(animation => animation.playState === 'running')
        """)

    def assert_contrast(self, selector):
        result = self.page.locator(selector).first.evaluate("""element => {
            const rgb = value => value.match(/[\\d.]+/g).map(Number);
            const luminance = color => rgb(color).slice(0, 3).reduce((sum, value, index) => {
                const channel = value / 255;
                return sum + [0.2126, 0.7152, 0.0722][index] *
                    (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
            }, 0);
            const foreground = getComputedStyle(element).color;
            let background = getComputedStyle(element).backgroundColor;
            for (let parent = element.parentElement; rgb(background)[3] === 0 && parent;
                 parent = parent.parentElement) background = getComputedStyle(parent).backgroundColor;
            const a = luminance(foreground), b = luminance(background);
            return {foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)};
        }""")
        self.assertGreaterEqual(result["ratio"], 4.5, (selector, result))

    def test_light_contrast_after_theme_transition(self):
        self.page.locator("#history").click()
        self.page.locator("#theme-toggle").click()
        self.settle()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("Reader")
        self.page.locator(".full-search-result").first.wait_for()
        for selector in ("#full-search-input", ".full-search-status", ".full-search-location",
                         ".full-search-snippet", "#full-search-toggle", "#reader-path"):
            self.assert_contrast(selector)
        self.page.locator("#reader-path").hover()
        self.assert_contrast("#reader-path")
        # Exercise document surfaces without loading external conversion engines.
        self.page.locator("#content").evaluate("""content => content.insertAdjacentHTML('beforeend', `
            <div class="reader-error">Failed to load</div>
            <div class="epub-frame"><article class="reader-markdown">Chapter text</article></div>
            <article class="reader-markdown"><a href="#test">Document link</a></article>`)
        """)
        for selector in (".reader-error", ".epub-frame .reader-markdown", ".reader-markdown a"):
            self.assert_contrast(selector)

    def open_theme_fixture(self, extension, data):
        self.page.route("**/api/reader-content**", lambda route: route.fulfill(body=data))
        source = urllib.parse.quote(
            f"https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/{'a' * 64}/docx-native-v2/document.docx"
            if extension == "docx" else "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/theme.epub", safe=""
        )
        self.page.goto(f"{self.origin}/search/static/reader.html?url={source}&ext={extension}&title=Theme")
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")

    def check_document_theme_round_trip(self, selector):
        target = self.page.locator(selector).first
        initial = target.bounding_box()
        for theme in ("dark", "light", "dark"):
            if self.page.locator("html").get_attribute("data-theme") != theme:
                self.page.locator("#history").click()
                self.page.locator("#theme-toggle").click()
                self.page.locator("#history").click()
                self.settle()
            colors = target.evaluate("e=>[getComputedStyle(e).color,getComputedStyle(e).backgroundColor]")
            self.assertEqual(colors, ["rgb(231, 233, 235)", "rgba(0, 0, 0, 0)"] if theme == "dark"
                             else ["rgb(0, 0, 0)", "rgb(255, 255, 255)"])
            self.assertEqual(target.bounding_box(), initial)

    def test_docx_shaded_runs_and_paragraphs_follow_theme(self):
        with zipfile.ZipFile(io.BytesIO(minimal_docx())) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        files["word/document.xml"] = files["word/document.xml"].decode().replace(
            "<w:p><w:r>", '<w:p><w:pPr><w:shd w:fill="FFFFFF"/></w:pPr><w:r>'
            '<w:rPr><w:color w:val="000000"/><w:shd w:fill="FFFFFF"/></w:rPr>'
        )
        self.open_theme_fixture("docx", zip_bytes(files))
        self.check_document_theme_round_trip(".reader-docx p span")
        self.assertEqual(self.page.locator(".reader-docx p").first.evaluate(
            "e=>getComputedStyle(e).backgroundColor"), "rgba(0, 0, 0, 0)")

    def test_epub_legacy_font_colors_and_shading_follow_shadow_theme(self):
        with zipfile.ZipFile(io.BytesIO(epub_with_navigation())) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        files["OEBPS/nav.xhtml"] = files["OEBPS/nav.xhtml"].decode().replace(
            "</body>", '<p style="background-color:white"><font color="black" id="night-text" '
            'style="background-color:white">Night text</font></p>'
            '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">'
            '<rect id="night-art" width="16" height="16" fill="red"/></svg></body>'
        )
        self.open_theme_fixture("epub", zip_bytes(files))
        self.check_document_theme_round_trip("#night-text")
        self.assertEqual(self.page.locator("#night-art").evaluate("e=>getComputedStyle(e).fill"), "rgb(255, 0, 0)")
        self.assertEqual(self.page.locator("#night-art").evaluate("e=>getComputedStyle(e.ownerSVGElement).filter"), "none")

    def test_numeric_controls_have_visible_keyboard_focus_in_both_themes(self):
        self.page.locator(".page-controls").evaluate("element => element.hidden = false")
        for theme in ("dark", "light"):
            self.page.locator("html").evaluate("(element, theme) => element.dataset.theme = theme", theme)
            self.page.keyboard.press("Tab")
            for selector in ("#page-number", "#zoom"):
                control = self.page.locator(selector)
                control.focus()
                style = control.evaluate("""element => ({
                    visible: element.matches(':focus-visible'),
                    width: parseFloat(getComputedStyle(element).outlineWidth),
                    style: getComputedStyle(element).outlineStyle
                })""")
                self.assertTrue(style["visible"])
                self.assertGreaterEqual(style["width"], 2)
                self.assertEqual(style["style"], "solid")

    def test_short_dialog_scrolls_to_actions_and_retains_editor_grid(self):
        self.page.set_viewport_size({"width": 390, "height": 240})
        self.page.locator("#bookmark-ribbon").click()
        dialog = self.page.locator("#bookmark-popover")
        self.page.locator("#bookmark-excerpt-input").evaluate("element => element.style.height = '500px'")
        metrics = dialog.evaluate("""element => ({
            bottom: element.getBoundingClientRect().bottom,
            overflow: getComputedStyle(element).overflowY,
            scrollable: element.scrollHeight > element.clientHeight,
            editor: getComputedStyle(element.querySelector('.bookmark-edit-fields')).display
        })""")
        self.assertLessEqual(metrics["bottom"], 230)
        self.assertEqual(metrics["overflow"], "auto")
        self.assertTrue(metrics["scrollable"])
        self.assertEqual(metrics["editor"], "grid")
        cancel = self.page.locator("#bookmark-cancel")
        cancel.scroll_into_view_if_needed()
        rect = cancel.bounding_box()
        self.assertGreaterEqual(rect["y"], 78)
        self.assertLessEqual(rect["y"] + rect["height"], 230)
        cancel.click()
        self.assertTrue(dialog.is_hidden())

    def test_foliate_and_video_follow_toolbar_across_breakpoint_and_resize(self):
        for width, height in ((390, 844), (390, 360), (600, 500), (601, 500), (1440, 900)):
            with self.subTest(width=width, height=height):
                self.page.set_viewport_size({"width": width, "height": height})
                for mode in ("foliate", "video"):
                    metrics = self.page.locator("#content").evaluate("""(content, mode) => {
                        content.dataset.mode = mode;
                        content.innerHTML = mode === 'video' ? '<video class="reader-video"></video>' : '';
                        const toolbar = document.querySelector('.reader-toolbar').getBoundingClientRect();
                        const style = getComputedStyle(content);
                        return {toolbar: toolbar.height, height: parseFloat(style.height),
                            minHeight: parseFloat(style.minHeight), padding: style.padding,
                            video: content.firstChild?.getBoundingClientRect().height};
                    }""", mode)
                    expected_toolbar = 36 if width <= 600 else 44
                    self.assertEqual(metrics["toolbar"], expected_toolbar)
                    self.assertAlmostEqual(metrics["height"], height - expected_toolbar, delta=1)
                    self.assertEqual(metrics["padding"], "0px")
                    if mode == "foliate":
                        self.assertAlmostEqual(metrics["minHeight"], height - expected_toolbar, delta=1)
                    else:
                        self.assertAlmostEqual(metrics["video"], height - expected_toolbar, delta=1)

    def test_theme_transition_preserves_drawer_and_filter_motion(self):
        self.page.locator("#history").click()
        self.page.locator("#bookmarks-tab").click()
        self.page.locator("#bookmarks-panel .panel-search-toggle").click()
        self.settle()
        transitions = self.page.evaluate("""() => {
            document.documentElement.classList.add('theme-transition');
            document.documentElement.dataset.theme = 'light';
            return ['#history-panel', '#bookmarks-panel .panel-search'].map(selector => {
                const style = getComputedStyle(document.querySelector(selector));
                return style.transitionProperty.split(',').map(value => value.trim());
            });
        }""")
        for properties in transitions:
            self.assertIn("transform", properties)
            self.assertIn("opacity", properties)
            self.assertIn("background-color", properties)
        self.assertIn("visibility", transitions[0])
        self.assertIn("max-height", transitions[1])
        delay = self.page.locator("#history-panel").evaluate("""element => {
            element.classList.remove('is-open');
            const style = getComputedStyle(element);
            return style.transitionDelay.split(',')[style.transitionProperty.split(',')
                .findIndex(value => value.trim() === 'visibility')].trim();
        }""")
        self.assertEqual(delay, "0.24s")
        self.page.emulate_media(reduced_motion="reduce")
        for selector in ("#history-panel", "#bookmarks-panel .panel-search"):
            values = self.page.locator(selector).evaluate("""element => {
                const style = getComputedStyle(element);
                return [style.transitionDuration, style.transitionDelay];
            }""")
            self.assertTrue(all(float(value.strip().removesuffix('s')) == 0
                                for group in values for value in group.split(',')), values)

    def test_high_contrast_overrides_light_borders_and_internal_link_reset(self):
        self.page.emulate_media(contrast="more")
        self.page.locator("#content").evaluate("""content => content.insertAdjacentHTML('beforeend',
            '<div class="foliate-continuous"><a href="#internal">Internal link</a></div>')""")
        for theme in ("dark", "light"):
            self.page.locator("html").evaluate("(element, theme) => element.dataset.theme = theme", theme)
            for selector, border in ((".reader-toolbar", "borderBottomColor"),
                                     (".reader-panel", "borderLeftColor"),
                                     (".reader-panel-tabs", "borderBottomColor"),
                                     (".reader-panel > header", "borderBottomColor"),
                                     (".reader-progress-tools", "borderTopColor")):
                colors = self.page.locator(selector).evaluate("""(element, border) => {
                    const style = getComputedStyle(element);
                    return [style[border], style.color];
                }""", border)
                self.assertEqual(colors[0], colors[1], (selector, theme, colors))
            self.assertIn("underline", self.page.locator(".foliate-continuous a").evaluate(
                "element => getComputedStyle(element).textDecorationLine"
            ))

    def test_rendered_foliate_shadow_tracks_contrast_without_layout_changes(self):
        with zipfile.ZipFile(io.BytesIO(epub_with_navigation())) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        # A book rule makes normal and high-contrast underlining distinguishable.
        files["OEBPS/nav.xhtml"] = files["OEBPS/nav.xhtml"].decode().replace(
            "a{color:#000}", "a{color:#000;text-decoration:none!important}"
        ).replace("</a>", " ContrastTarget</a>", 1)
        book = zip_bytes(files)
        self.page.route("**/api/reader-content**", lambda route: route.fulfill(
            content_type="application/epub+zip", body=book
        ))
        source = urllib.parse.quote(
            "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/contrast.epub", safe=""
        )
        self.page.emulate_media(contrast="no-preference")
        self.page.goto(
            f"{self.origin}/search/static/reader.html?url={source}&ext=epub&title=Contrast",
            wait_until="domcontentloaded",
        )
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("ContrastTarget")
        self.page.locator("#full-search-results .full-search-result").first.click()
        highlight = self.page.locator(".foliate-continuous mark.full-search-highlight").first
        highlight.wait_for()
        self.settle()
        measure = """mark => {
            const root = mark.getRootNode(), link = mark.closest('a[href]');
            const style = getComputedStyle(mark);
            const rect = element => {
                const box = element.getBoundingClientRect();
                return [box.x, box.y, box.width, box.height];
            };
            const viewport = document.querySelector('#viewport');
            return {
                shadow: root instanceof ShadowRoot && root.host.matches('article[data-section]'),
                text: mark.textContent,
                decoration: getComputedStyle(link).textDecorationLine,
                outline: style.outlineStyle,
                width: parseFloat(style.outlineWidth),
                outlineColor: style.outlineColor,
                color: style.color,
                layout: [rect(document.querySelector('.reader-toolbar')), rect(viewport),
                    rect(root.host), rect(link), rect(mark),
                    [viewport.scrollWidth, viewport.scrollHeight, viewport.scrollTop]]
            };
        }"""
        for theme in ("dark", "light"):
            with self.subTest(theme=theme):
                self.page.locator("html").evaluate(
                    "(element, theme) => element.dataset.theme = theme", theme
                )
                before = highlight.evaluate(measure)
                self.assertTrue(before["shadow"])
                self.assertEqual(before["text"], "ContrastTarget")
                self.assertEqual(before["decoration"], "none")
                self.assertEqual(before["outline"], "none")
                self.page.emulate_media(contrast="more")
                high = highlight.evaluate(measure)
                self.assertIn("underline", high["decoration"])
                self.assertEqual(high["outline"], "solid")
                self.assertEqual(high["width"], 2)
                self.assertEqual(high["outlineColor"], high["color"])
                self.assertEqual(high["layout"], before["layout"])
                self.page.emulate_media(contrast="no-preference")
                self.assertEqual(highlight.evaluate(measure), before)

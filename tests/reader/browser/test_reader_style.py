"""Focused browser checks for reader CSS, independent of format-engine suites."""

import io
import os
import unittest
import urllib.parse
from PIL import Image

from tests.support.browser_support import local_server
from tests.performance.test_reader_performance import STORE_SCRIPT, PlaywrightError, sync_playwright
from tests.performance import test_reader_performance as support
from tests.support.reader_native_fixture import install as install_native_djvu


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
            cls.browser = getattr(cls.playwright, os.environ.get("READER_STYLE_BROWSER", "chromium")).launch(headless=True)
        except PlaywrightError as error:
            raise unittest.SkipTest(str(error))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        context = self.browser.new_context(viewport={"width": 1440, "height": 900})
        self.addCleanup(context.close)
        self.page = context.new_page()
        self.page.add_init_script("localStorage.setItem('theme', 'dark')")
        self.page.route("**/static/reader/core/reader-store.js", lambda route: route.fulfill(
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

    def test_default_paper_follows_theme_and_mobile_prose_scales_with_zoom(self):
        viewport = self.page.locator('#viewport')
        text = self.page.locator('.reader-text').first
        self.assertEqual(text.evaluate('e=>getComputedStyle(e).fontSize'), '17px')
        self.page.set_viewport_size({'width':390,'height':740})
        self.assertEqual(text.evaluate('e=>getComputedStyle(e).fontSize'), '14px')
        self.page.locator('#zoom').fill('150')
        self.page.locator('#zoom').dispatch_event('change')
        self.assertEqual(text.evaluate('e=>getComputedStyle(e).fontSize'), '21px')
        dark = viewport.evaluate('e=>getComputedStyle(e).backgroundColor')
        self.assertEqual(dark, 'rgb(32, 34, 36)')
        self.assertEqual(viewport.evaluate('e=>getComputedStyle(e).backgroundImage'), 'none')
        self.assert_contrast('.reader-text')
        self.page.locator('#history').click()
        self.page.locator('#theme-toggle').click()
        self.settle()
        light = viewport.evaluate('e=>getComputedStyle(e).backgroundColor')
        self.assertEqual(light, 'rgb(247, 243, 235)')
        self.assertEqual(viewport.evaluate('e=>getComputedStyle(e).backgroundImage'), 'none')
        self.assert_contrast('.reader-text')
        for media in ({'contrast':'more'}, {'contrast':'no-preference','forced_colors':'active'}):
            self.page.emulate_media(**media)
            self.assertNotEqual(viewport.evaluate('e=>getComputedStyle(e).backgroundColor'), light)
        self.page.emulate_media(contrast='no-preference', forced_colors='none')
        for mode, markup, surface in (
            ('markdown','<article class="reader-markdown">Markdown</article>','#viewport'),
            ('epub-chapters','<div class="epub-frame"><article class="reader-markdown">Chapter</article></div>','.epub-frame'),
        ):
            with self.subTest(mode=mode):
                self.page.locator('#content').evaluate('''(e,[mode,markup])=>{
                  e.dataset.mode=mode;e.innerHTML=markup;
                }''', [mode,markup])
                self.assertEqual(self.page.locator(surface).evaluate('e=>getComputedStyle(e).backgroundColor'), light)
                self.assertEqual(self.page.locator('#content article').evaluate('e=>getComputedStyle(e).fontSize'), '21px')
        for mode in ('pdf','pdf-pages','image','html','video'):
            self.page.locator('#content').evaluate('(e,mode)=>e.dataset.mode=mode', mode)
            self.assertEqual(viewport.evaluate('e=>getComputedStyle(e).backgroundColor'), 'rgb(233, 236, 239)', mode)

    def test_back_and_download_icons_have_stable_browser_independent_geometry(self):
        self.page.evaluate("""() => {
          document.querySelector('.page-controls').hidden = false;
          document.querySelector('.zoom-controls').hidden = false;
        }""")
        for theme in ("dark", "light"):
            self.page.evaluate("theme => document.documentElement.dataset.theme = theme", theme)
            for width in (1100, 390, 320):
                self.page.set_viewport_size({"width": width, "height": 900})
                for selector in ("#back", "#download"):
                    with self.subTest(theme=theme, width=width, selector=selector):
                        button = self.page.locator(selector)
                        geometry = button.evaluate("""button => {
                          const icon = button.querySelector('svg');
                          if (!icon) return null;
                          const b = button.getBoundingClientRect(), i = icon.getBoundingClientRect();
                          const toolbar = button.closest('header').getBoundingClientRect();
                          const style = getComputedStyle(button);
                          return {width: b.width, height: b.height, iconWidth: i.width, iconHeight: i.height,
                            dx: i.x + i.width / 2 - b.x - b.width / 2,
                            dy: i.y + i.height / 2 - b.y - b.height / 2,
                            fits: b.left >= 0 && b.right <= innerWidth && b.top >= toolbar.top && b.bottom <= toolbar.bottom,
                            padding: style.padding, appearance: style.appearance,
                            stroke: getComputedStyle(icon).stroke, color: style.color,
                            hiddenIcon: icon.getAttribute('aria-hidden'), focusable: icon.getAttribute('focusable')};
                        }""")
                        self.assertIsNotNone(geometry)
                        self.assertEqual((geometry["width"], geometry["height"]), (32, 32) if width > 600 else (26, 30))
                        self.assertEqual((geometry["iconWidth"], geometry["iconHeight"]), (18, 18))
                        self.assertAlmostEqual(geometry["dx"], 0, delta=0.5)
                        self.assertAlmostEqual(geometry["dy"], 0, delta=0.5)
                        self.assertTrue(geometry["fits"], geometry)
                        self.assertEqual((geometry["padding"], geometry["appearance"]), ("0px", "none"))
                        self.assertEqual(geometry["stroke"], geometry["color"])
                        self.assertEqual((geometry["hiddenIcon"], geometry["focusable"]), ("true", "false"))
                        self.assertTrue(button.get_attribute("title"))
                        self.assertTrue(button.get_attribute("aria-label"))
                        before = button.bounding_box()
                        button.hover()
                        button.focus()
                        self.assertEqual(button.bounding_box(), before)
                        self.assertEqual(button.evaluate("e => getComputedStyle(e).outlineStyle"), "solid")

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

    def test_search_result_uses_full_width_five_line_excerpt(self):
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("Reader")
        row = self.page.locator(".full-search-result").first
        row.wait_for()
        page_input = self.page.locator("#full-search-page")
        page_input.wait_for()
        before = page_input.bounding_box()
        self.assertEqual(page_input.evaluate("e => getComputedStyle(e).borderTopColor"), "rgba(0, 0, 0, 0)")
        page_input.click()
        self.assertEqual(page_input.evaluate("e => getComputedStyle(e).outlineStyle"), "solid")
        self.assertEqual(page_input.bounding_box()["width"], before["width"])
        page_input.press("Tab")
        self.assertEqual(page_input.evaluate("e => getComputedStyle(e).outlineStyle"), "none")
        for width in (1440, 390, 320):
            self.page.set_viewport_size({"width": width, "height": 900})
            for rank in ("1.", "123456."):
                with self.subTest(width=width, rank=rank):
                    metrics = row.evaluate("""(row, rank) => {
                      const number = row.querySelector('.full-search-rank');
                      const location = row.querySelector('.full-search-location');
                      const snippet = row.querySelector('.full-search-snippet');
                      number.textContent = rank;
                      location.textContent = 'Chapter location '.repeat(12);
                      snippet.textContent = 'Reader excerpt '.repeat(100);
                      const n = number.getBoundingClientRect(), l = location.getBoundingClientRect();
                      const s = snippet.getBoundingClientRect(), r = row.getBoundingClientRect();
                      return {gap: l.left - n.right, indent: s.left - n.left,
                        right: s.right - l.right, below: s.top >= l.bottom,
                        lines: s.height / parseFloat(getComputedStyle(snippet).lineHeight),
                        overflow: row.scrollWidth > row.clientWidth,
                        fits: r.right <= innerWidth};
                    }""", rank)
                    self.assertAlmostEqual(metrics["gap"], 4, delta=1)
                    self.assertAlmostEqual(metrics["indent"], 0, delta=1)
                    self.assertAlmostEqual(metrics["right"], 0, delta=1)
                    self.assertAlmostEqual(metrics["lines"], 5, delta=0.1)
                    self.assertTrue(metrics["below"] and metrics["fits"], metrics)
                    self.assertFalse(metrics["overflow"], metrics)

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

    def test_pdf_page_surface_follows_dark_theme_without_touching_text_layer(self):
        self.page.route("**/api/reader-content**", lambda route: route.fulfill(
            content_type="application/pdf", body=support.minimal_pdf()
        ))
        source = urllib.parse.quote(
            "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/theme.pdf", safe=""
        )
        self.page.goto(
            f"{self.origin}/search/static/reader.html?url={source}&ext=pdf&title=Theme PDF",
            wait_until="domcontentloaded",
        )
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        canvas = self.page.locator('.reader-content[data-mode="pdf"] .reader-page canvas').first
        self.page.locator('.reader-page canvas.ready').first.wait_for()
        self.page.wait_for_function("() => document.querySelector('.reader-page')?.dataset.textReady === '1'")
        self.page.locator('.reader-page').first.evaluate("node => window.__themePage = node")
        text_layer = self.page.locator('.reader-pdf-text').first
        self.assertEqual(text_layer.evaluate("e => getComputedStyle(e).filter"), "none")
        self.assertEqual(canvas.evaluate("e => getComputedStyle(e).filter"), "none")
        self.page.locator("#history").click()
        self.page.locator("#page-invert-toggle").click()
        for theme in ('light', 'dark'):
            self.page.locator("#theme-toggle").click()
            self.settle()
            self.assertEqual(canvas.evaluate("e => getComputedStyle(e).filter"), 'invert(0.9) hue-rotate(180deg)')
        self.page.locator("#history").click()
        for width in (1100, 390):
            self.page.set_viewport_size({"width": width, "height": 844})
            self.page.locator('.reader-pdf-text-run').first.evaluate("node => {const range=document.createRange(); range.selectNodeContents(node); getSelection().removeAllRanges(); getSelection().addRange(range);}")
            selected = self.page.evaluate("getSelection().toString()")
            self.assertEqual(selected, 'Reader PDF')
            original_pixels = canvas.evaluate("c => c.toDataURL()")
            for theme in ("dark", "light", "dark"):
                self.page.evaluate("theme => {document.documentElement.dataset.theme = theme; document.documentElement.dataset.pageInverted = String(theme === 'dark');}", theme)
                self.settle()
                bounds = self.page.locator('.reader-page').first.bounding_box()
                png = Image.open(io.BytesIO(self.page.screenshot())).convert("RGB")
                pixel = png.getpixel((round(bounds['x'] + bounds['width'] * .85), round(bounds['y'] + 30)))
                self.assertTrue(max(pixel) < 50 if theme == "dark" else min(pixel) > 240, (theme, pixel))
                self.assertEqual(canvas.evaluate("c => c.toDataURL()"), original_pixels)
                self.assertTrue(self.page.evaluate("document.querySelector('.reader-page') === __themePage"))
                self.assertEqual(self.page.evaluate("getSelection().toString()"), selected)
        self.page.evaluate("getSelection().removeAllRanges()")
        self.page.locator('#history').click()
        self.page.locator('#full-search-toggle').click()
        self.page.locator('#full-search-input').fill('Reader')
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        mark = self.page.locator('.reader-page mark.full-search-highlight').first
        self.assertEqual(mark.text_content(), 'Reader')
        self.assertEqual(mark.evaluate("e => getComputedStyle(e).filter"), 'none')
        self.assertNotEqual(mark.evaluate("e => getComputedStyle(e).backgroundColor"), 'rgba(0, 0, 0, 0)')
        self.page.locator('#content').evaluate("node => node.dataset.mode = 'image-pages'")
        self.assertEqual(self.page.locator('.reader-page canvas').first.evaluate("e => getComputedStyle(e).filter"), 'none')

    def test_pdf_page_djvu_canvas_inverts_without_affecting_original_images(self):
        state = install_native_djvu(self.page, self.origin, prefix='/search')
        self.page.goto(state['url'])
        canvas = self.page.locator('.reader-page canvas.ready').first
        canvas.wait_for()
        original = canvas.evaluate('c => c.toDataURL()')
        self.assertEqual(canvas.evaluate('e => getComputedStyle(e).filter'), 'none')
        self.page.locator('#history').click()
        self.page.locator('#page-invert-toggle').click()
        self.page.locator('#history').click()
        for width in (1100, 390):
            self.page.set_viewport_size({'width': width, 'height': 844})
            for theme in ('dark', 'light', 'dark'):
                self.page.evaluate("theme => {document.documentElement.dataset.theme = theme; document.documentElement.dataset.pageInverted = String(theme === 'dark');}", theme)
                self.settle()
                bounds = canvas.bounding_box()
                png = Image.open(io.BytesIO(self.page.screenshot())).convert('RGB')
                pixel = png.getpixel((round(bounds['x'] + bounds['width'] * .8), round(bounds['y'] + 30)))
                self.assertTrue(max(pixel) < 50 if theme == 'dark' else min(pixel) > 240, (theme, pixel))
                self.assertEqual(canvas.evaluate('c => c.toDataURL()'), original)
        self.assertEqual(self.page.locator('.reader-page img').count(), 0)
        self.page.route('**/api/reader-content?**', lambda route: route.fulfill(
            content_type='image/webp', body=support.IMAGE_FIXTURES['webp'][1],
            headers={'Access-Control-Allow-Origin': '*'}))
        source = urllib.parse.quote('https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/style.webp', safe='')
        self.page.goto(f'{self.origin}/search/static/reader.html?url={source}&ext=webp')
        image = self.page.locator('img.reader-image')
        image.wait_for()
        self.page.evaluate("document.documentElement.dataset.pageInverted='true'")
        self.assertEqual(image.evaluate('e => getComputedStyle(e).filter'), 'none')

    def test_page_inversion_remembers_explicit_choice_and_fits_sidebar(self):
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='application/pdf', body=support.minimal_pdf()))
        source = urllib.parse.quote('https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/inversion.pdf', safe='')
        self.page.goto(f'{self.origin}/static/reader.html?url={source}&ext=pdf')
        self.page.locator('.reader-page canvas.ready').first.wait_for()
        button = self.page.locator('#page-invert-toggle')
        self.assertEqual(button.get_attribute('aria-pressed'), 'false')
        self.assertEqual(button.text_content(), '页面反色')
        self.page.locator('#history').click()
        button.click()
        self.assertEqual(button.text_content(), '关闭页面反色')
        self.assertEqual(self.page.evaluate("localStorage.getItem('reader-page-inversion')"), 'true')
        for width in (1100, 390, 320):
            self.page.set_viewport_size(dict(width=width, height=844))
            self.page.locator('#full-search-toggle').click()
            self.settle()
            metrics = self.page.locator('#history-panel > header').evaluate('''header => {
              const buttons = [...header.querySelectorAll('button')].filter(node => !node.hidden && getComputedStyle(node).display !== 'none');
              const bounds = header.getBoundingClientRect();
              const boxes = buttons.map(node => node.getBoundingClientRect());
              return {ids: buttons.map(node => node.id), fits: boxes.every(rect => rect.left >= bounds.left && rect.right <= bounds.right),
                gaps: boxes.slice(1).map((rect, index) => rect.left - boxes[index].right), overflow: header.scrollWidth > header.clientWidth};
            }''')
            expected=['full-search-toggle', 'page-invert-toggle', 'theme-toggle', 'history-close']
            self.assertEqual(metrics['ids'], expected)
            self.assertTrue(metrics['fits'], metrics)
            self.assertFalse(metrics['overflow'], metrics)
            self.assertTrue(all(gap >= 0 for gap in metrics['gaps']), metrics)
        self.page.reload()
        self.page.locator('.reader-page canvas.ready').first.wait_for()
        self.assertEqual(button.get_attribute('aria-pressed'), 'true')
        self.assertEqual(button.text_content(), '关闭页面反色')
        self.page.locator('#history').click()
        self.page.locator('#theme-toggle').click()
        self.settle()
        self.assert_contrast('#page-invert-toggle')
        self.assertEqual(self.page.locator('canvas.ready').first.evaluate('e => getComputedStyle(e).filter'), 'invert(0.9) hue-rotate(180deg)')
        button.click()
        self.page.reload()
        self.page.locator('.reader-page canvas.ready').first.wait_for()
        self.assertEqual(button.get_attribute('aria-pressed'), 'false')
        self.assertEqual(self.page.locator('canvas.ready').first.evaluate('e => getComputedStyle(e).filter'), 'none')

    def test_converted_xhtml_chapter_theme_preserves_svg_and_layout(self):
        source = ("https://voiceofml-search.hf.space/api/reader-bucket-resource?path=chapters/ebook/epub/"
                  + "a" * 64 + "/1234567890abcdef/chapter-manifest.json")
        xhtml = """<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Theme</title></head>
          <body><p id="chapter-text" style="color:black; background-color:white">Chapter text</p>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
            <rect width="16" height="16" style="color:red" fill="currentColor"/>
          </svg></body></html>"""
        manifest = {"version": 1, "kind": "epub-chapters", "chapters": [
            {"index": 1, "path": "chapters/chapter-0001.xhtml", "bytes": len(xhtml.encode("utf-8"))}
        ]}
        self.page.route("**/api/reader-bucket-resource**", lambda route: route.fulfill(json=manifest)
                        if "chapter-manifest.json" in route.request.url else route.fulfill(
                            content_type="application/xhtml+xml", body=xhtml,
                            headers={"Access-Control-Allow-Origin": "*"}))
        params = urllib.parse.urlencode(dict(url=source, ext="epub-chapters", title="Theme"))
        self.page.goto(f"{self.origin}/search/static/reader.html?{params}")
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")

        chapter = self.page.locator('#content[data-mode="epub-chapters"] .reader-epub-chapter')
        text = chapter.locator("#chapter-text")
        svg = chapter.locator("svg")
        for node in (chapter, text, svg):
            node.wait_for()
        initial = [node.bounding_box() for node in (chapter, text, svg)]
        for step, theme in enumerate(("dark", "light", "dark")):
            with self.subTest(step=step, theme=theme):
                if step:
                    self.page.locator("#history").click()
                    self.page.locator("#theme-toggle").click()
                    self.page.locator("#history-close").click()
                    self.page.locator("#history-panel").wait_for(state="hidden")
                self.settle()
                self.assertEqual(self.page.locator("html").get_attribute("data-theme"), theme)
                colors = text.evaluate("e => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]")
                self.assertEqual(colors, ["rgb(236, 239, 241)", "rgba(0, 0, 0, 0)"] if theme == "dark"
                                 else ["rgb(0, 0, 0)", "rgb(255, 255, 255)"])
                self.assertEqual(svg.locator("rect").evaluate("e => getComputedStyle(e).fill"), "rgb(255, 0, 0)")
                self.assertEqual(svg.evaluate("e => getComputedStyle(e).filter"), "none")
                self.assertEqual([node.bounding_box() for node in (chapter, text, svg)], initial)

    def test_numeric_controls_have_visible_keyboard_focus_in_both_themes(self):
        self.page.locator(".page-controls").evaluate("element => element.hidden = false")
        for theme in ("dark", "light"):
            self.page.locator("html").evaluate("(element, theme) => element.dataset.theme = theme", theme)
            self.page.keyboard.press("Tab")
            for selector in ("#page-number", "#zoom"):
                control = self.page.locator(selector)
                control.focus()
                style = control.evaluate("""element => {
                    const style = getComputedStyle(element.closest('.compact-input'));
                    return {visible: element.matches(':focus-visible'),
                            width: parseFloat(style.outlineWidth), style: style.outlineStyle};
                }""")
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

    def test_video_follows_toolbar_across_breakpoint_and_resize(self):
        for width, height in ((390, 844), (390, 360), (600, 500), (601, 500), (1440, 900)):
            with self.subTest(width=width, height=height):
                self.page.set_viewport_size({"width": width, "height": height})
                for mode in ("video",):
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
                    self.assertAlmostEqual(metrics["video"], height - expected_toolbar, delta=1)

    def test_mobile_folder_action_and_title_follow_breakpoint(self):
        self.page.emulate_media(reduced_motion='reduce')
        for width, height in ((320, 568), (390, 844), (600, 500), (601, 500)):
            with self.subTest(width=width, height=height):
                self.page.set_viewport_size({'width': width, 'height': height})
                self.assertEqual(self.page.locator('.reader-toolbar').bounding_box()['height'], 36 if width <= 600 else 44)
                self.assertEqual(self.page.locator('#reader-path').is_visible(), width > 600)
                self.assertEqual(self.page.locator('#title').is_visible(), width > 600)
                self.page.locator('#history').click()
                self.page.wait_for_function("()=>document.querySelector('#history').getAttribute('aria-expanded') === 'true'")
                info=self.page.locator('#reader-panel-location')
                self.assertEqual(self.page.locator('#reader-location-toggle').count(), 0)
                self.assertEqual(info.is_visible(), width <= 600)
                if width <= 600:
                    header=self.page.locator('#history-panel > header')
                    self.page.evaluate("()=>document.querySelector('#page-invert-toggle').hidden=false")
                    for search_open in (False,True):
                        if search_open: self.page.locator('#full-search-toggle').click()
                        buttons=header.locator('button:visible')
                        boxes=[buttons.nth(i).bounding_box() for i in range(buttons.count())]
                        self.assertTrue(all(boxes[i]['x']+boxes[i]['width']<=boxes[i+1]['x']+.5 for i in range(len(boxes)-1)),boxes)
                        self.assertLessEqual(boxes[-1]['x']+boxes[-1]['width'],width)
                self.page.locator('#history-close').click()
                self.page.wait_for_function("()=>document.querySelector('#history').getAttribute('aria-expanded') === 'false'")
                self.assertTrue(info.is_hidden())
                self.page.evaluate("()=>document.querySelector('#page-invert-toggle').hidden=true")

    def test_mobile_title_and_controls_fit_all_formats(self):
        self.page.emulate_media(reduced_motion='reduce')
        actions = self.page.locator('.reader-actions')
        # The speech button loads asynchronously, even after the Reader is ready.
        actions.locator('[data-speech-toggle]').wait_for()
        self.page.evaluate("""() => {
          document.querySelector('#title').textContent = '标题很长的书名'.repeat(15);
          document.querySelector('#page-total').textContent = '/ 12345';
          const ocr = document.createElement('a');
          ocr.id = 'ocr'; ocr.className = 'text-button'; ocr.textContent = 'OCR'; ocr.href = '#ocr-fixture';
          document.querySelector('.reader-actions [data-speech-toggle]').after(ocr);
        }""")
        cases = [(width, pagination, zoom) for width in (320, 390, 600)
                 for pagination, zoom in ((False, False), (False, True), (True, True))]
        # At 280px, even the fixed-width controls alone are wider than the strip.
        for width, pagination, zoom in [*cases, (280, True, True)]:
            with self.subTest(width=width, pagination=pagination, zoom=zoom):
                self.page.set_viewport_size({'width': width, 'height': 700})
                self.page.evaluate('''([pagination, zoom]) => {
                  document.querySelector('.page-controls').hidden = !pagination;
                  document.querySelector('.zoom-controls').hidden = !zoom;
                  document.querySelector('.reader-actions').scrollLeft = 0;
                }''', [pagination, zoom])
                layout = actions.evaluate('''actions => {
                  const rect = node => node.getBoundingClientRect().toJSON();
                  const controls = [...actions.querySelectorAll('button, input, a')]
                    .filter(node => node.getClientRects().length)
                    .map(node => ({selector: node.id ? '#' + node.id : '[data-speech-toggle]', ...rect(node)}));
                  return {controls, toolbar: rect(actions.closest('header')), strip: rect(actions),
                    back: rect(document.querySelector('#back')), menu: rect(document.querySelector('#history')),
                    scroll: actions.scrollWidth > actions.clientWidth};
                }''')
                toolbar, strip, back, menu = (layout[key] for key in ('toolbar', 'strip', 'back', 'menu'))
                self.assertEqual(toolbar['height'], 36)
                self.assertTrue(self.page.locator('#title').is_hidden())
                self.assertGreaterEqual(back['left'], toolbar['left'])
                self.assertGreaterEqual(strip['left'], back['right'])
                self.assertLessEqual(strip['right'], menu['left'])
                self.assertLessEqual(menu['right'], toolbar['right'])
                expected = ['[data-speech-toggle]', '#ocr']
                if pagination:
                    expected += ['#page-prev', '#page-number', '#page-next']
                if zoom:
                    expected += ['#zoom-out', '#zoom', '#zoom-in']
                expected += ['#download']
                controls = layout['controls']
                self.assertEqual([box['selector'] for box in controls], expected)
                for box in (back, strip, *controls, menu):
                    self.assertGreaterEqual(box['top'], toolbar['top'], box)
                    self.assertLessEqual(box['bottom'], toolbar['bottom'], box)
                for previous, following in zip(controls, controls[1:]):
                    self.assertLessEqual(previous['right'], following['left'] + 0.5, (previous, following))
                if width == 280:
                    self.assertTrue(layout['scroll'], layout)
                if not layout['scroll']:
                    for box in controls:
                        self.assertGreaterEqual(box['left'], strip['left'], box)
                        self.assertLessEqual(box['right'], strip['right'], box)

                # Tab must reach every control, including those clipped by the scrolling strip.
                self.page.locator('#back').focus()
                self.page.keyboard.press('Tab')
                # Some browsers give the scroll container its own tab stop.
                if actions.evaluate('node => node === document.activeElement'):
                    self.page.keyboard.press('Tab')
                for selector in expected:
                    focus = actions.locator(selector).evaluate('''node => {
                      const box = node.getBoundingClientRect();
                      const strip = node.closest('.reader-actions').getBoundingClientRect();
                      const focusTarget = node.matches('#zoom, #page-number') ? node.closest('.compact-input') : node;
                      return {focused: node.matches(':focus-visible'), outline: getComputedStyle(focusTarget).outlineStyle,
                        left: box.left - strip.left, right: strip.right - box.right};
                    }''')
                    self.assertTrue(focus['focused'], (selector, focus))
                    self.assertEqual(focus['outline'], 'solid', (selector, focus))
                    self.assertGreaterEqual(focus['left'], -0.5, (selector, focus))
                    self.assertGreaterEqual(focus['right'], -0.5, (selector, focus))
                    self.page.keyboard.press('Tab')
                if layout['scroll']:
                    self.assertGreater(actions.evaluate('node => node.scrollLeft'), 0)
                self.assertTrue(self.page.locator('#history').evaluate("node => node.matches(':focus-visible')"))
                self.assertEqual(self.page.locator('#back').bounding_box()['x'], back['left'])
                self.assertEqual(self.page.locator('#history').bounding_box()['x'], menu['left'])

    def test_mobile_overflowing_toolbar_supports_touch_swipe(self):
        context=self.browser.new_context(viewport={'width':280,'height':700},is_mobile=True,has_touch=True)
        try:
            page=context.new_page()
            page.route('**/api/reader-content**',lambda route:route.fulfill(content_type='text/plain',body='Readable text'))
            source=urllib.parse.quote('https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/touch.txt',safe='')
            page.goto(f'{self.origin}/search/static/reader.html?url={source}&ext=txt&title=Touch')
            page.wait_for_function("()=>document.documentElement.dataset.readerPhase==='ready'")
            page.evaluate('''()=>{document.querySelector('.page-controls').hidden=false;
              const ocr=document.createElement('a');ocr.className='text-button';ocr.textContent='OCR';
              document.querySelector('.reader-actions').prepend(ocr)}''')
            actions=page.locator('.reader-actions')
            self.assertGreater(actions.evaluate('n=>n.scrollWidth'),actions.evaluate('n=>n.clientWidth'))
            box=actions.bounding_box();session=context.new_cdp_session(page)
            x,y=box['x']+box['width']-15,box['y']+box['height']/2
            session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
            for delta in (25,50,75,100):
                session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x-delta,'y':y}]})
                page.wait_for_timeout(25)
            session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
            page.wait_for_function("()=>document.querySelector('.reader-actions').scrollLeft>0")
            self.assertEqual(page.locator('.reader-toolbar').bounding_box()['height'],36)
        finally:
            context.close()

    def test_mobile_folder_action_has_contrast_and_stays_out_of_header(self):
        self.page.set_viewport_size({'width': 320, 'height': 568})
        self.page.emulate_media(reduced_motion='reduce')
        # Exceed the panel width even with a narrow CI fallback font.
        self.page.evaluate("()=>document.querySelector('.reader-panel-folder').textContent='所在目录：Test/'+ '一个非常长的目录/子目录/'.repeat(8)+'文件所在位置'")
        self.page.locator('#history').click()
        action = self.page.locator('#reader-panel-path')
        action.wait_for(state='visible')
        for theme in ('dark', 'light'):
            with self.subTest(theme=theme):
                self.page.evaluate('theme=>document.documentElement.dataset.theme=theme', theme)
                self.assert_contrast('#reader-panel-path')
                action.hover()
                self.assert_contrast('#reader-panel-path')
                geometry = action.evaluate('''node=>{
                  const a=node.getBoundingClientRect(),h=document.querySelector('#history-panel > header').getBoundingClientRect();
                  const tabs=document.querySelector('.reader-panel-tabs').getBoundingClientRect();
                  const text=node.querySelector('.reader-panel-folder');
                  return {belowHeader:a.top>=h.bottom,aboveTabs:a.bottom<=tabs.top,ellipsized:text.scrollWidth>text.clientWidth};
                }''')
                self.assertTrue(all(geometry.values()), geometry)

    def test_mobile_file_info_works_without_a_folder_target(self):
        self.page.set_viewport_size({'width':320,'height':568})
        self.page.emulate_media(reduced_motion='reduce')
        self.page.locator('#history').click()
        self.assertEqual(self.page.get_by_role('button',name='文件信息',exact=True).count(), 0)
        self.assertTrue(self.page.locator('#reader-panel-path').is_disabled())
        self.assertTrue(self.page.locator('#title').is_hidden())
        self.assertTrue(self.page.locator('#reader-panel-location').is_visible())
        self.page.locator('#history-tab').click()
        self.assertTrue(self.page.locator('#reader-panel-location').is_visible())
        self.page.locator('#history-close').click()
        self.page.wait_for_function("()=>document.querySelector('#history-panel').hidden")
        self.assertTrue(self.page.locator('#reader-panel-location').is_hidden())
        self.page.locator('#history').click()
        self.assertTrue(self.page.locator('#reader-panel-location').is_visible())

    def test_mobile_panel_is_compact_and_folder_scrolls_with_directory(self):
        self.page.emulate_media(reduced_motion='reduce')
        self.page.evaluate('''()=>{
          document.querySelector('.reader-panel-folder').textContent='所在目录：Test/docs';
          document.querySelector('#toc-list').innerHTML=Array.from({length:40},(_,i)=>
            `<div class="panel-item toc-item"><div class="panel-item-main">${i===1?'长标题可以换行'.repeat(16):`目录第${i+1}项`}</div>${i===0?'<span class="toc-current-mark">✓</span>':''}</div>`).join('');
          document.querySelector('#history-list').innerHTML='<div class="panel-item"><button class="panel-item-main">历史</button></div>';
        }''')
        for width in (320, 390, 600):
            with self.subTest(width=width):
                self.page.set_viewport_size({'width':width,'height':700})
                self.page.locator('#history').click()
                info=self.page.locator('#reader-panel-location')
                self.assertTrue(info.is_visible())
                self.page.evaluate('''()=>{if(!document.querySelector('#history-list .panel-item-main'))
                  document.querySelector('#history-list').innerHTML='<div class="panel-item"><button class="panel-item-main">历史</button></div>'}''')
                metrics=self.page.evaluate('''()=>{const panel=document.querySelector('#history-panel'),
                  toc=document.querySelector('#toc-panel'),path=document.querySelector('#reader-panel-location'),
                  a=document.querySelector('#toc-list .panel-item-main'),b=document.querySelector('#history-list .panel-item-main');
                  const row=a.parentElement.getBoundingClientRect(), text=document.createRange();
                  text.selectNodeContents(a);
                  const bounds=text.getBoundingClientRect();
                  text.selectNodeContents(a.parentElement.nextElementSibling.firstElementChild);
                  return {width:panel.getBoundingClientRect().width, tocFont:getComputedStyle(a).fontSize,
                    historyFont:getComputedStyle(b).fontSize, pathInToc:toc.contains(path),
                    rowHeight:row.height, topGap:bounds.top-row.top,
                    bottomGap:row.bottom-bounds.bottom, longLines:text.getClientRects().length};}''')
                self.assertAlmostEqual(metrics['width'],width*.85,delta=1)
                self.assertEqual(metrics['tocFont'],metrics['historyFont'])
                self.assertEqual(metrics['tocFont'],'13px')
                self.assertFalse(metrics['pathInToc'])
                self.assertLessEqual(metrics['rowHeight'],33,metrics)
                self.assertAlmostEqual(metrics['topGap'],metrics['bottomGap'],delta=3)
                self.assertGreater(metrics['longLines'],1,metrics)
                for tab in ('bookmarks-tab','history-tab'):
                    self.page.locator('#'+tab).click()
                    self.assertTrue(info.is_visible(),tab)
                    self.assertEqual(self.page.locator('#'+tab).get_attribute('aria-selected'),'true')
                self.page.locator('#history-close').click()
                self.page.wait_for_function("()=>document.querySelector('#history-panel').hidden")
                self.assertTrue(info.is_hidden())

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
        self.assertEqual(delay, "0.18s")
        self.page.emulate_media(reduced_motion="reduce")
        for selector in ("#history-panel", "#bookmarks-panel .panel-search"):
            values = self.page.locator(selector).evaluate("""element => {
                const style = getComputedStyle(element);
                return [style.transitionDuration, style.transitionDelay];
            }""")
            self.assertTrue(all(float(value.strip().removesuffix('s')) == 0
                                for group in values for value in group.split(',')), values)

    def test_high_contrast_overrides_light_borders(self):
        self.page.emulate_media(contrast="more")
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

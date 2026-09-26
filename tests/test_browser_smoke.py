import json
import time
import unittest

from tests.browser_support import local_server

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright
except ImportError:
    PlaywrightError = Exception
    sync_playwright = None


@unittest.skipIf(sync_playwright is None, "install requirements-test.txt to run browser tests")
class BrowserBehaviorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = local_server()
        cls.origin, cls.server_state = cls.server.__enter__()
        cls.playwright = sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True)
        except PlaywrightError as error:
            cls.playwright.stop()
            cls.server.__exit__(None, None, None)
            raise unittest.SkipTest(f"Chromium is unavailable: {error}")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 800})
        self.page = self.context.new_page()
        self.page_errors = []
        self.api_requests = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))

        self.install_routes(self.page)

    def install_routes(self, page):

        def api(route):
            url = route.request.url
            self.api_requests.append((route.request.method, url, route.request.post_data))
            path = url.split("?", 1)[0]
            if path.endswith("/api/repos"):
                body = [{"name": "VoiceOfML/VOMEBOOK", "count": 1}]
            elif path.endswith("/api/extensions"):
                body = [{"name": "txt", "count": 1}]
            elif "/api/search" in path:
                body = {
                    "page": 1,
                    "page_size": 100,
                    "total": 1,
                    "results": [{
                        "Repo": "VoiceOfML/VOMEBOOK",
                        "File": "API deterministic result",
                        "Extension": "txt",
                        "Folder": [],
                        "Size": 12,
                        "HasTxt": True,
                    }],
                }
            elif path.endswith("/api/random-txt/status"):
                body = {"available": False}
            else:
                body = {}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

        page.route("https://voiceofml-search.hf.space/**", api)
        page.route(
            "https://vomebook-hitokoto.hf.space/**",
            lambda route: route.fulfill(status=200, content_type="application/json", body='{"hitokoto":"test"}'),
        )

    def tearDown(self):
        self.context.close()

    def load(self, suffix=""):
        response = self.page.goto(self.origin + "/search/" + suffix, wait_until="domcontentloaded")
        self.assertEqual(response.status, 200)
        self.page.locator("#search-input").wait_for(state="visible")

    def wait_for_local_results(self):
        self.page.locator("#results-list .result-item").first.wait_for(timeout=30000)

    def test_desktop_loads_real_assets_and_local_initial_data(self):
        self.load()
        self.wait_for_local_results()
        self.assertEqual(self.page.title(), "VoiceOfML Search")
        self.assertGreater(self.page.locator("#results-list .result-item").count(), 0)
        self.assertEqual(self.page.locator("link[href='static/style.css']").count(), 1)
        self.assertFalse(self.page.locator("body").evaluate("el => el.classList.contains('mobile')"))
        self.assertEqual(self.page_errors, [])

    def test_system_back_steps_out_of_reader_search_and_panel(self):
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**",
                        lambda route: route.fulfill(content_type="text/plain", body="find-me in the book",
                                                  headers={"Access-Control-Allow-Origin": "*"}))
        self.load()
        url = "/search/static/reader.html?url=https%3A%2F%2Fhuggingface.co%2Fdatasets%2FVoiceOfML%2FTest%2Fresolve%2Fmain%2Fback.txt&ext=txt"
        self.page.evaluate("url => navigateToReader(url)", url)
        reader = self.page.frame_locator("iframe.reader-overlay")
        reader.locator(".reader-text").wait_for()
        reader.locator("#history").click()
        reader.locator("#full-search-toggle").click()
        reader.locator("#full-search-input").fill("find-me")
        reader.locator(".full-search-result").wait_for()
        self.page.wait_for_function("() => readerUiState === 'full-search'")
        self.page.evaluate("history.back()")
        self.page.wait_for_function("() => readerUiState === 'panel'")
        self.assertEqual(self.page.locator("iframe.reader-overlay").count(), 1)
        self.assertTrue(reader.locator("#full-search-view").is_hidden())
        self.page.evaluate("history.back()")
        self.page.wait_for_function("() => readerUiState === 'base'")
        self.assertEqual(self.page.locator("iframe.reader-overlay").count(), 1)
        self.page.evaluate("history.back()")
        self.page.locator("iframe.reader-overlay").wait_for(state="detached")
        self.assertEqual(self.page_errors, [])

    def test_global_filters_recover_from_unavailable_api_after_local_metadata_loads(self):
        self.page.unroute("https://voiceofml-search.hf.space/**")
        self.page.route("https://voiceofml-search.hf.space/**", lambda route: route.abort())
        self.load()
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.page.locator("#filter-repo-list input").first.wait_for(state="attached", timeout=10000)
        self.page.locator("#filter-ext-list input").first.wait_for(state="attached", timeout=10000)
        self.assertEqual(self.page.locator("#filter-repo-list").get_by_text("暂无").count(), 0)
        self.assertEqual(self.page.locator("#filter-ext-list").get_by_text("暂无").count(), 0)
        self.assertEqual(self.page_errors, [])

    def test_repository_filter_tree_loads_nested_api_folders(self):
        self.page.unroute("https://voiceofml-search.hf.space/**")

        def api(route):
            path = route.request.url.split("?", 1)[0]
            if path.endswith("/api/folders/VOMEBOOK"):
                body = [{
                    "name": "VOMEBOOK", "path": "", "count": 1,
                    "hasDirectFiles": False, "hasChildren": True,
                    "children": [{
                        "name": "一级", "path": "一级", "count": 1,
                        "hasDirectFiles": False, "hasChildren": True,
                        "children": [{
                            "name": "二级", "path": "一级/二级", "count": 1,
                            "hasDirectFiles": True, "hasChildren": False,
                            "children": []
                        }]
                    }]
                }]
            elif path.endswith("/api/extensions"):
                body = [{"name": "txt", "count": 1}]
            elif "/api/search" in path:
                body = {"page": 1, "page_size": 100, "total": 0, "results": []}
            elif path.endswith("/api/random-reader/status"):
                body = {"available": False}
            else:
                body = {}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

        self.page.route("https://voiceofml-search.hf.space/**", api)
        self.load("#/VOMEBOOK")
        self.page.locator("#settings-btn").click()
        self.page.wait_for_function("STATE.folderTree && STATE.folderTree.length > 0", timeout=10000)
        self.assertIn("一级/二级", self.page.evaluate("STATE.folderTree.flatMap(root => root.children || []).flatMap(node => node.children || []).map(node => node.path)"))
        self.page.locator('[data-path="一级/二级"]').wait_for(state="visible", timeout=10000)
        self.assertEqual(self.page_errors, [])

    def test_repository_filter_tree_uses_nested_worker_fallback_when_api_is_unavailable(self):
        self.page.unroute("https://voiceofml-search.hf.space/**")
        self.page.route("https://voiceofml-search.hf.space/**", lambda route: route.abort())
        self.load("#/VOMEBOOK?filters=1")
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.page.wait_for_function("""() => STATE.folderTree && STATE.folderTree.some(root =>
            (root.children || []).some(node => (node.children || []).length > 0)
        )""", timeout=30000)
        self.assertGreater(self.page.locator("#filter-folder-tree .filter-folder-item").count(), 1)
        self.assertEqual(self.page_errors, [])

    def test_late_extension_api_response_cannot_overwrite_local_metadata(self):
        self.page.unroute("https://voiceofml-search.hf.space/**")
        def delayed_api(route):
            if route.request.url.split("?", 1)[0].endswith("/api/extensions"):
                time.sleep(2.0)
                body = [{"name": "stale-api-only", "count": 1}]
            else:
                body = {}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
        self.page.route("https://voiceofml-search.hf.space/**", delayed_api)
        self.load()
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.page.wait_for_function("STATE.extensionList.includes('txt')", timeout=10000)
        self.page.wait_for_timeout(2500)
        self.assertIn("txt", self.page.evaluate("STATE.extensionList"))
        self.assertNotIn("stale-api-only", self.page.evaluate("STATE.extensionList"))
        self.assertEqual(self.page_errors, [])

    def test_desktop_result_path_uses_space_below_actions(self):
        self.load()
        self.wait_for_local_results()
        layout = self.page.locator("#results-list .result-item").first.evaluate("""row => {
          const title = row.querySelector('.result-title').getBoundingClientRect();
          const actions = row.querySelector('.result-actions').getBoundingClientRect();
          const meta = row.querySelector('.result-meta').getBoundingClientRect();
          const path = row.querySelector('.result-path').getBoundingClientRect();
          return {
            titleTop: title.top,
            actionsLeft: actions.left,
            actionsTop: actions.top,
            actionsBottom: actions.bottom,
            metaTop: meta.top,
            metaBottom: meta.bottom,
            pathTop: path.top,
            pathBottom: path.bottom,
            pathRight: path.right,
          };
        }""")
        self.assertAlmostEqual(layout["titleTop"], layout["actionsTop"], delta=1)
        self.assertGreaterEqual(layout["pathTop"], layout["actionsBottom"] - 1)
        self.assertGreaterEqual(layout["metaTop"], layout["pathBottom"])
        self.assertGreater(layout["pathRight"], layout["actionsLeft"])
        self.assertEqual(self.page_errors, [])

    def test_mobile_result_actions_use_compact_column(self):
        self.context.close()
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        self.page = self.context.new_page()
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.install_routes(self.page)
        self.load()
        self.wait_for_local_results()
        layout = self.page.locator("#results-list .result-item").first.evaluate("""row => {
          const actions = row.querySelector('.result-actions').getBoundingClientRect();
          const buttons = [...row.querySelectorAll('.result-action-btn')].map(item => {
            const rect = item.getBoundingClientRect();
            return {height: rect.height, top: rect.top};
          });
          return {height: actions.height, buttons};
        }""")
        self.assertEqual(len(layout["buttons"]), 4)
        self.assertTrue(all(abs(button["height"] - 20) < 0.1 for button in layout["buttons"]))
        self.assertLessEqual(layout["height"], 83)
        self.assertEqual(len({round(button["top"], 1) for button in layout["buttons"]}), 4)
        self.assertEqual(self.page_errors, [])

    def test_mobile_long_folder_uses_remaining_path_line(self):
        self.context.close()
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        self.page = self.context.new_page()
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.install_routes(self.page)
        self.load()
        layout = self.page.evaluate("""async () => {
          STATE.results = [{
            Repo: "VoiceOfML/VOMEBOOK", File: "路径换行测试", Extension: "pdf",
            Folder: [
              "马列之声ebook小组第七批成果集成(2018.8.17)",
              "马列之声ebook小组第七批成果集成(2018.8.17)part 1a",
              "2018.8 part 1",
            ], Size: 1,
          }];
          STATE.total = 1; STATE.hasMore = false;
          resetVirtualScrollState(); renderResults();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const path = document.querySelector('.result-path');
          const folders = [...path.querySelectorAll('.path-folder')];
          const first = document.createRange(); first.selectNodeContents(folders[1]);
          const repo = folders[0].getBoundingClientRect(), firstRect = first.getClientRects()[0];
          return {
            repoTop: repo.top, firstTop: firstRect.top, firstLeft: firstRect.left,
            separatorsNested: [...path.querySelectorAll('.path-sep')].every(sep => sep.parentElement.classList.contains('path-folder')),
          };
        }""")
        self.assertAlmostEqual(layout["firstTop"], layout["repoTop"], delta=1)
        self.assertGreater(layout["firstLeft"], 0)
        self.assertTrue(layout["separatorsNested"])
        self.assertEqual(self.page_errors, [])

    def test_repository_browser_does_not_wait_for_reader_assets(self):
        asset_path = "/search/data/reader_assets.json.gz"
        self.server_state.delays[asset_path] = 3
        try:
            started = time.perf_counter()
            self.load("#/VOMEBOOK")
            self.page.locator("#sidebar-back-btn").wait_for(state="visible", timeout=1000)
            self.assertLess(time.perf_counter() - started, 2)
            self.assertEqual(self.page_errors, [])
        finally:
            self.server_state.delays.pop(asset_path, None)

    def test_sidebar_header_back_and_expanded_global_state(self):
        self.load()
        heights = self.page.evaluate("[document.querySelector('.sidebar-header').getBoundingClientRect().height, document.querySelector('.status-bar').getBoundingClientRect().height]")
        self.assertEqual(heights[0], heights[1])
        self.page.locator("#sidebar-content .repo-list-item").first.wait_for(state="visible")
        self.page.locator("#sidebar-content .repo-list-item").first.click()
        self.page.locator("#sidebar-back-btn").wait_for(state="visible")
        self.assertEqual(self.page.locator("#sidebar-title").inner_text(), "VOMEBOOK")
        self.assertEqual(self.page.locator(".sidebar-breadcrumb").inner_text(), "根目录")

        self.page.evaluate("ROUTER.navigate('repo', 'VOMEBOOK', 'docs')")
        self.page.wait_for_function("STATE.browserPath === 'docs'")
        self.page.locator("#sidebar-back-btn").click()
        self.page.wait_for_function("STATE.browserPath === ''")
        self.assertEqual(self.page.locator(".sidebar-breadcrumb").inner_text(), "根目录")

        self.page.locator("#sidebar-expand-btn").click()
        self.assertTrue(self.page.locator("#left-sidebar").evaluate("el => el.classList.contains('expanded-wide')"))
        self.page.locator("#sidebar-back-btn").click()
        self.page.wait_for_function("STATE.mode === 'global'")
        self.assertTrue(self.page.locator("#sidebar-expand-btn").is_visible())
        self.assertTrue(self.page.locator("#left-sidebar").evaluate("el => el.classList.contains('expanded-wide')"))
        self.page.locator("#sidebar-expand-btn").click()
        self.assertFalse(self.page.locator("#left-sidebar").evaluate("el => el.classList.contains('expanded-wide')"))
        self.assertEqual(self.page_errors, [])

    def test_local_search_updates_hash_and_visible_results(self):
        self.load()
        self.wait_for_local_results()
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        self.api_requests.clear()
        search = self.page.locator("#search-input")
        search.fill("目录")
        self.page.wait_for_function("location.hash.includes('q=%E7%9B%AE%E5%BD%95')", timeout=10000)
        self.page.locator("#results-list .result-item").first.wait_for(timeout=30000)
        self.assertGreater(self.page.locator("#results-list .result-item").count(), 0)
        self.assertIn("目录", self.page.locator("#results-list").inner_text())
        self.assertFalse(any("/api/search" in request[1] for request in self.api_requests))
        self.assertEqual(self.page_errors, [])

    def test_search_clear_control_tracks_query_state(self):
        self.load()
        search = self.page.locator("#search-input")
        self.assertEqual(search.get_attribute("data-has-query"), "false")
        self.assertFalse(self.page.locator("#search-box").evaluate("el => el.classList.contains('has-query')"))
        search.fill("目录")
        self.page.wait_for_function("document.getElementById('search-input').dataset.hasQuery === 'true'")
        self.assertTrue(self.page.locator("#search-box").evaluate("el => el.classList.contains('has-query')"))
        search.fill("")
        self.page.wait_for_function("document.getElementById('search-input').dataset.hasQuery === 'false'")
        self.assertFalse(self.page.locator("#search-box").evaluate("el => el.classList.contains('has-query')"))
        self.assertEqual(self.page_errors, [])

    def test_virtual_scroll_settles_after_jumps_and_preserves_append(self):
        self.load()
        result = self.page.evaluate("""async () => {
            const repeat = (value, count) => Array(count).fill(value).join("");
            STATE.results = Array.from({length: 800}, (_, index) => ({
                Repo: "VoiceOfML/Test",
                File: index % 4 === 1 ? `virtual-${index}-` + repeat("长标题", 45) : `virtual-${index}`,
                Extension: "txt",
                Folder: index % 4 >= 2 ? Array.from({length: 10}, (_, part) => `很长的目录-${index}-${part}`) : [],
                Size: index + 1,
                HasTxt: index % 4 === 3,
            }));
            STATE.total = STATE.results.length;
            STATE.hasMore = false;
            STATE.isLoading = false;
            DOM.resultsContainer.scrollTop = 0;
            resetVirtualScrollState();
            renderResultsSkeleton();
            renderResults();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const skeletonCount = DOM.resultsList.querySelectorAll(".result-skeleton-item").length;
            DOM.resultsContainer.scrollTop = 0.88 * (DOM.resultsContainer.scrollHeight - DOM.resultsContainer.clientHeight);
            DOM.resultsContainer.dispatchEvent(new Event("scroll"));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const settledRect = DOM.resultsContainer.getBoundingClientRect();
            const settledHit = document.elementFromPoint(
                settledRect.left + settledRect.width / 2,
                settledRect.top + settledRect.height / 2,
            );
            const domVisibleAfterJump = !!(settledHit && settledHit.closest(".result-item"));

            const samples = [];
            updateScrollTrack();
            const trackTopBeforeScroll = DOM.scrollTrack.style.top;
            const trackHeightBeforeScroll = DOM.scrollTrack.style.height;
            const thumbHeightBeforeScroll = DOM.scrollThumb.style.height;
            for (const ratio of [0.82, 0.17, 0.94, 0.33, 0.7, 0.05, 1]) {
                const container = DOM.resultsContainer;
                container.scrollTop = ratio * (container.scrollHeight - container.clientHeight);
                container.dispatchEvent(new Event("scroll"));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const rect = container.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                samples.push(hit && hit.closest(".result-item") ? Number(hit.closest(".result-item").dataset.index) : null);
            }

            const container = DOM.resultsContainer;
            container.scrollTop = 0.4 * (container.scrollHeight - container.clientHeight);
            container.dispatchEvent(new Event("scroll"));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const appendRect = container.getBoundingClientRect();
            const preservedRow = document.elementFromPoint(
                appendRect.left + appendRect.width / 2,
                appendRect.top + appendRect.height / 2,
            ).closest(".result-item");
            const preservedIndex = preservedRow.dataset.index;
            const heightBeforeAppend = container.scrollHeight;
            const oldLength = STATE.results.length;
            ensureHeightTree();
            const heightTreeBeforeAppend = VSCROLL.heightTree;
            STATE.results = STATE.results.concat(Array.from({length: 100}, (_, index) => ({
                Repo: "VoiceOfML/Test", File: `appended-${index}`, Extension: "txt", Folder: [], Size: oldLength + index,
            })));
            refreshVirtualAfterAppend();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            let naiveHeight = 0;
            let prefixMatches = true;
            for (let index = 0; index < VSCROLL.heights.length; index++) {
                naiveHeight += VSCROLL.heights[index];
                if (Math.abs(fenwickSum(VSCROLL.heightTree, index + 1) - naiveHeight) > 0.01) prefixMatches = false;
            }
            const measuredRow = DOM.resultsList.querySelector(`.result-item[data-index="${preservedIndex}"]`);
            let repeatedReads = 0;
            const originalRect = measuredRow.getBoundingClientRect.bind(measuredRow);
            measuredRow.getBoundingClientRect = () => { repeatedReads++; return originalRect(); };
            VSCROLL.measuredWindowKey = "";
            measureHeights(VSCROLL.renderStart, VSCROLL.renderEnd);
            const readsAtSameWidth = repeatedReads;
            const originalWidth = DOM.resultsContainer.style.width;
            DOM.resultsContainer.style.width = Math.max(200, container.clientWidth - 1) + "px";
            VSCROLL.measuredWindowKey = "";
            measureHeights(VSCROLL.renderStart, VSCROLL.renderEnd);
            DOM.resultsContainer.style.width = originalWidth;
            const preservedAfterAppend = preservedRow === DOM.resultsList.querySelector(`.result-item[data-index="${preservedIndex}"]`);
            const treeExtendedInPlace = heightTreeBeforeAppend === VSCROLL.heightTree;
            const heightAfterAppend = container.scrollHeight;

            updateScrollTrack();
            container.scrollTop = 0;
            renderVisible();
            const thumbRect = DOM.scrollThumb.getBoundingClientRect();
            const trackRect = DOM.scrollTrack.getBoundingClientRect();
            DOM.scrollThumb.dispatchEvent(new MouseEvent("mousedown", {
                bubbles: true,
                clientY: thumbRect.top + thumbRect.height / 2,
            }));
            for (let step = 1; step <= 40; step++) {
                document.dispatchEvent(new MouseEvent("mousemove", {
                    bubbles: true,
                    clientY: thumbRect.top + thumbRect.height / 2 + (trackRect.height - thumbRect.height) * step / 40,
                }));
            }
            const scrollTopBeforeDragFrame = container.scrollTop;
            await new Promise(resolve => requestAnimationFrame(resolve));
            const scrollTopAfterDragFrame = container.scrollTop;
            const dragRect = container.getBoundingClientRect();
            const dragHit = document.elementFromPoint(
                dragRect.left + dragRect.width / 2,
                dragRect.top + dragRect.height / 2,
            );
            const dragHitIndex = dragHit && dragHit.closest(".result-item")
                ? Number(dragHit.closest(".result-item").dataset.index)
                : null;
            const dragDomCount = DOM.resultsList.querySelectorAll(".result-item").length;
            document.dispatchEvent(new MouseEvent("mouseup", {bubbles: true}));
            const scrollTopAfterMouseUp = container.scrollTop;
            return {
                samples,
                trackTopStable: trackTopBeforeScroll === DOM.scrollTrack.style.top,
                trackHeightStable: trackHeightBeforeScroll === DOM.scrollTrack.style.height,
                thumbHeightStable: thumbHeightBeforeScroll === DOM.scrollThumb.style.height,
                skeletonCount,
                domVisibleAfterJump,
                preservedAfterAppend,
                heightBeforeAppend,
                heightAfterAppend,
                treeExtendedInPlace,
                prefixMatches,
                readsAtSameWidth,
                readsAfterWidthChange: repeatedReads,
                scrollTopBeforeDragFrame,
                scrollTopAfterDragFrame,
                scrollTopAfterMouseUp,
                clientHeight: container.clientHeight,
                dragHitIndex,
                dragDomCount,
                draggingAfterMouseUp: VSCROLL.isDraggingThumb,
            };
        }""")
        self.assertTrue(all(index is not None for index in result["samples"]))
        self.assertTrue(result["trackTopStable"])
        self.assertTrue(result["trackHeightStable"])
        self.assertTrue(result["thumbHeightStable"])
        self.assertEqual(result["skeletonCount"], 0)
        self.assertTrue(result["domVisibleAfterJump"])
        self.assertTrue(result["preservedAfterAppend"])
        self.assertGreater(result["heightAfterAppend"], result["heightBeforeAppend"])
        self.assertTrue(result["treeExtendedInPlace"])
        self.assertTrue(result["prefixMatches"])
        self.assertEqual(result["readsAtSameWidth"], 0)
        self.assertGreater(result["readsAfterWidthChange"], result["readsAtSameWidth"])
        self.assertEqual(result["scrollTopBeforeDragFrame"], 0)
        self.assertGreater(result["scrollTopAfterDragFrame"], result["scrollTopBeforeDragFrame"])
        self.assertIsNotNone(result["dragHitIndex"])
        self.assertLess(result["dragDomCount"], 50)
        self.assertLess(abs(result["scrollTopAfterMouseUp"] - result["scrollTopAfterDragFrame"]), result["clientHeight"])
        self.assertFalse(result["draggingAfterMouseUp"])
        self.assertEqual(self.page_errors, [])

    def test_theme_toggle_changes_body_and_persists_in_new_page(self):
        self.load()
        self.assertFalse(self.page.locator("body").evaluate("el => el.classList.contains('light')"))
        self.page.locator("#theme-btn").click()
        self.assertTrue(self.page.locator("body").evaluate("el => el.classList.contains('light')"))
        self.assertEqual(self.page.evaluate("localStorage.getItem('theme')"), "light")
        second = self.context.new_page()
        second.goto(self.origin + "/search/", wait_until="domcontentloaded")
        second.locator("#search-input").wait_for(state="visible")
        self.assertTrue(second.locator("body").evaluate("el => el.classList.contains('light')"))
        self.assertEqual(self.page_errors, [])

    def test_desktop_sidebar_and_filter_buttons_update_state_and_url(self):
        self.load()
        left = self.page.locator("#left-sidebar")
        right = self.page.locator("#right-sidebar")
        self.assertFalse(left.evaluate("el => el.classList.contains('collapsed')"))
        self.page.locator("#hamburger-btn").click()
        self.assertTrue(left.evaluate("el => el.classList.contains('collapsed')"))
        self.assertIn("sidebar=0", self.page.evaluate("location.hash"))
        self.page.locator("#settings-btn").click()
        self.assertTrue(right.evaluate("el => el.classList.contains('open')"))
        self.assertIn("filters=1", self.page.evaluate("location.hash"))
        self.page.locator("#close-filters-btn").click()
        self.assertTrue(right.evaluate("el => el.classList.contains('collapsed')"))

    def test_root_folder_select_all_includes_direct_files_and_updates_local_search(self):
        self.load("#/VOMEBOOK?filters=1")
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        result = self.page.evaluate("""async () => {
            const data = {
              v: 2,
              rp: ["VoiceOfML/VOMEBOOK"],
              fd: [[], ["child"], ["child", "deep"]],
              rc: [
                [0, "root-file", "txt", 0, 1, 1],
                [0, "nested-file", "txt", 1, 2, 0],
                [0, "deep-file", "txt", 2, 3, 0],
              ],
            };
            await corpusWorkerRequest("replace-corpus", {data});
            const treeResult = await corpusWorkerRequest("folder-tree", {repo: "VoiceOfML/VOMEBOOK"});
            STATE.folderTree = treeResult.tree;
            STATE.filterFolderSelfs = [];
            STATE.filterFolderSubtrees = [];
            STATE.filterFolders = [];
            STATE.query = "";
            STATE.results = [];
            STATE.total = 0;
            STATE.page = 1;
            renderFilterFolderTree();
            document.querySelector("#folder-select-all").click();
            await new Promise(resolve => {
              const check = () => STATE.total === 3 && STATE.results.length === 3 && !STATE.isLoading
                ? resolve() : setTimeout(check, 10);
              check();
            });
            const rootRow = DOM.filterFolderTree.querySelector('[data-path=""]');
            const rootCheckbox = rootRow.querySelector('input[type="checkbox"]');
            const selected = {
              self: STATE.filterFolderSelfs.slice(),
              subtrees: STATE.filterFolderSubtrees.slice(),
              folders: STATE.filterFolders.slice(),
              rootChecked: rootCheckbox.checked,
              rootPartial: rootCheckbox.indeterminate,
            };
            document.querySelector("#folder-select-all").click();
            return {
              files: STATE.results.map(record => record.File),
              total: STATE.total,
              ...selected,
              clearedSelf: STATE.filterFolderSelfs,
              clearedSubtrees: STATE.filterFolderSubtrees,
            };
        }""")
        self.assertEqual(result["files"], ["root-file", "nested-file", "deep-file"])
        self.assertEqual(result["total"], 3)
        self.assertIn("", result["self"])
        self.assertEqual(result["subtrees"], ["child"])
        self.assertIn("child", result["folders"])
        self.assertTrue(result["rootChecked"])
        self.assertFalse(result["rootPartial"])
        self.assertEqual(result["clearedSelf"], [])
        self.assertEqual(result["clearedSubtrees"], [])
        self.assertEqual(self.page_errors, [])

    def test_nested_folder_filter_updates_local_results(self):
        self.load("#/VOMEBOOK?filters=1")
        self.page.wait_for_function("STATE.dataLoaded === true", timeout=30000)
        result = self.page.evaluate("""async () => {
            const data = {
              v: 2,
              rp: ["VoiceOfML/VOMEBOOK"],
              fd: [[], ["child"], ["child", "deep"]],
              rc: [
                [0, "root-file", "txt", 0, 1, 1],
                [0, "nested-file", "txt", 1, 2, 0],
                [0, "deep-file", "txt", 2, 3, 0],
              ],
            };
            await corpusWorkerRequest("replace-corpus", {data});
            const treeResult = await corpusWorkerRequest("folder-tree", {repo: "VoiceOfML/VOMEBOOK"});
            STATE.folderTree = treeResult.tree;
            STATE.filterFolderSelfs = [];
            STATE.filterFolderSubtrees = [];
            STATE.filterFolders = [];
            STATE.query = "";
            STATE.results = [];
            STATE.total = 0;
            STATE.page = 1;
            renderFilterFolderTree();
            const childCheckbox = DOM.filterFolderTree.querySelector('[data-path="child"] input');
            childCheckbox.click();
            await new Promise(resolve => {
              const check = () => STATE.total === 2 && STATE.results.length === 2 && !STATE.isLoading
                ? resolve() : setTimeout(check, 10);
              check();
            });
            return {
              files: STATE.results.map(record => record.File),
              total: STATE.total,
              checked: childCheckbox.checked,
              self: STATE.filterFolderSelfs,
              subtrees: STATE.filterFolderSubtrees,
            };
        }""")
        self.assertEqual(result["files"], ["nested-file", "deep-file"])
        self.assertEqual(result["total"], 2)
        self.assertTrue(result["checked"])
        self.assertEqual(result["self"], [])
        self.assertEqual(result["subtrees"], ["child"])
        self.assertEqual(self.page_errors, [])

    def test_repository_directory_navigation_keeps_path_filters(self):
        self.load("#/VOMEBOOK?folder_self=docs&folder_subtree=archive%2F2026")
        self.page.wait_for_function("() => STATE.mode === 'repo' && STATE.filterFolderSelfs.includes('docs')")
        for path in ("docs/nested", "docs", ""):
            self.page.evaluate("path => ROUTER.navigate('repo', STATE.repo, path)", path)
            self.page.wait_for_function("path => STATE.browserPath === path", arg=path)
            params = self.page.evaluate("() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1]))")
            self.assertEqual(params.get("path", ""), path)
            self.assertEqual(params.get("folder_self"), "docs")
            self.assertEqual(params.get("folder_subtree"), "archive/2026")
            self.assertEqual(self.page.evaluate("STATE.filterFolderSelfs"), ["docs"])
            self.assertEqual(self.page.evaluate("STATE.filterFolderSubtrees"), ["archive/2026"])
        self.page.evaluate("ROUTER.navigate('repo', 'MLMRL-Hub', '')")
        self.page.wait_for_function("() => STATE.repo === 'MLMRL-Hub'")
        self.assertEqual(self.page.evaluate("STATE.filterFolderSelfs"), [])
        self.assertNotIn("folder_self=", self.page.evaluate("location.hash"))
        self.assertEqual(self.page_errors, [])

    def test_large_directory_navigation_keeps_search_and_filter_tree(self):
        self.load("#/VOMEBOOK?filters=1")
        self.page.wait_for_function("() => STATE.mode === 'repo' && STATE.dataLoaded && !!STATE.folderTree", timeout=30000)
        self.page.locator("#filter-ext-list input").first.wait_for(state="attached")
        self.page.wait_for_timeout(150)
        self.page.evaluate("""() => {
            const tree = Array.from({length: 600}, (_, i) => ({
                name: `folder-${i}`, path: `folder-${i}`, count: 1,
                hasDirectFiles: true, hasChildren: false, children: []
            }));
            STATE.folderTree = tree;
            folderTreeCache.set(STATE.repoFull, tree);
            renderFilterFolderTree();
            window.__originalFilterRow = DOM.filterFolderTree.firstElementChild;
            window.__filterRuns = 0;
            window.__searchRuns = 0;
            const render = renderFilters, search = searchWithInitialFallback;
            renderFilters = (...args) => { window.__filterRuns++; return render(...args); };
            searchWithInitialFallback = (...args) => { window.__searchRuns++; return search(...args); };
            ROUTER.navigate('repo', STATE.repo, 'folder-300');
        }""")
        self.page.wait_for_function("() => STATE.browserPath === 'folder-300'")
        self.assertTrue(self.page.evaluate("window.__originalFilterRow.isConnected"))
        self.assertEqual(self.page.evaluate("[window.__searchRuns, window.__filterRuns]"), [0, 0])
        self.page.evaluate("""() => {
            const params = new URLSearchParams(location.hash.split('?')[1]);
            params.set('q', 'different query');
            location.hash = '#/VOMEBOOK?' + params;
            ROUTER.apply();
        }""")
        self.assertFalse(self.page.evaluate("window.__originalFilterRow.isConnected"))
        self.assertGreater(self.page.evaluate("window.__searchRuns"), 0)
        self.assertGreater(self.page.evaluate("window.__filterRuns"), 0)
        self.assertEqual(self.page_errors, [])

    def test_large_browser_listing_keeps_all_rows_and_folder_navigation(self):
        self.load("#/VOMEBOOK")
        listing = self.page.evaluate("""() => {
            const list = document.createElement('div');
            list.className = 'browser-list';
            DOM.sidebarContent.appendChild(list);
            renderBrowserListItems(list, {
                folders: [{name:'nested', path:'nested', count:1000}],
                files: Array.from({length:1000}, (_, i) => ({
                    name:`file-${i}.txt`, ext:'txt', size:100, hasTxt:true
                }))
            }, STATE.repoFull, '');
            const result = {
                count: list.children.length,
                first: list.children[1]?.querySelector('.browser-name')?.textContent,
                last: list.lastElementChild?.querySelector('.browser-name')?.textContent
            };
            list.firstElementChild.click();
            return result;
        }""")
        self.assertEqual(listing, {"count": 1001, "first": "file-0.txt", "last": "file-999.txt"})
        self.page.wait_for_function("() => STATE.browserPath === 'nested'")
        self.assertEqual(self.page_errors, [])

    def test_deselected_self_files_button_has_neutral_hover_border(self):
        self.load("#/VOMEBOOK?filters=1")
        self.page.wait_for_function("() => STATE.mode === 'repo'")
        self.page.evaluate("""() => {
            STATE.folderTree = [{name:'根', path:'', count:2, isRoot:true,
                showSelfToggle:true, hasDirectFiles:true, hasChildren:true,
                children:[{name:'docs', path:'docs', count:1, hasDirectFiles:true, hasChildren:false, children:[]}]}];
            STATE.folderTreeCollapsed = {};
            renderFilterFolderTree();
        }""")
        button = self.page.locator("#filter-folder-tree .folder-self-toggle")
        button.click()
        self.assertEqual(button.get_attribute("aria-pressed"), "true")
        self.page.wait_for_timeout(220)
        selected_border = button.evaluate("node => getComputedStyle(node).borderTopColor")
        button.click()
        self.assertEqual(button.get_attribute("aria-pressed"), "false")
        self.page.wait_for_function("selected => getComputedStyle(document.querySelector('#filter-folder-tree .folder-self-toggle')).borderTopColor !== selected", arg=selected_border)
        self.assertFalse(button.evaluate("node => node.classList.contains('active')"))
        self.assertEqual(self.page_errors, [])

    def test_section_filter_cancel_buttons_follow_selected_state(self):
        self.load()
        self.page.locator("#settings-btn").click()
        self.assertTrue(self.page.locator("#repo-filter-cancel").is_hidden())
        self.assertTrue(self.page.locator("#ext-filter-cancel").is_hidden())
        self.page.locator("#filter-ext-list input").first.check()
        self.page.locator("#ext-filter-cancel").wait_for(state="visible")
        stale_reader_url = self.page.evaluate("""() => getReaderLink({
          Repo: "VoiceOfML/VOMEBOOK", File: "路径测试", Extension: "txt", Folder: ["docs"], HasTxt: true,
          Link: "https://huggingface.co/datasets/VoiceOfML/VOMEBOOK/resolve/main/path.txt"
        })""")
        self.page.locator("#filter-repo-list input").first.check()
        self.page.locator("#repo-filter-cancel").wait_for(state="visible")
        self.page.locator("#repo-filter-cancel").click()
        self.assertEqual(self.page.evaluate("STATE.filterRepos"), [])
        self.assertNotEqual(self.page.evaluate("STATE.filterExtensions"), [])
        self.page.locator("#ext-filter-cancel").click()
        self.assertEqual(self.page.evaluate("STATE.filterExtensions"), [])
        self.assertNotIn("ext=", self.page.evaluate("url => new URL(syncReaderFolderFilter(url), location.origin).searchParams.get('folder_url') || ''", stale_reader_url))
        self.page.locator("#sidebar-content .repo-list-item").first.click()
        self.page.locator("#filter-folder-section").wait_for(state="visible")
        if not self.page.locator("#right-sidebar").evaluate("el => el.classList.contains('open')"):
            self.page.locator("#settings-btn").click()
        self.page.evaluate("STATE.filterFolderSelfs = ['docs']; updateFilterCancelButtons()")
        self.page.locator("#folder-filter-cancel").click()
        self.assertEqual(self.page.evaluate("[STATE.filterFolderSelfs, STATE.filterFolderSubtrees]"), [[], []])
        self.assertNotIn("folder_self=", self.page.evaluate("location.hash"))
        self.assertEqual(self.page_errors, [])

    def test_result_folder_filter_does_not_survive_repository_mode_round_trip(self):
        self.load()
        self.page.evaluate("""() => {
          location.hash = '#/VOMEBOOK?folder_self=docs';
          ROUTER.apply();
        }""")
        self.page.wait_for_function("STATE.mode === 'repo' && STATE.filterFolderSelfs.includes('docs')")
        self.page.evaluate("ROUTER.navigate('global')")
        self.page.wait_for_function("STATE.mode === 'global' && STATE.filterFolderSelfs.length === 0")
        self.page.evaluate("ROUTER.navigate('repo', 'VOMEBOOK')")
        self.page.wait_for_function("STATE.mode === 'repo' && STATE.filterFolderSelfs.length === 0")
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('voml_folder_filter:VOMEBOOK')"))
        self.assertEqual(self.page_errors, [])

    def test_mobile_drawers_are_mutually_exclusive_and_overlay_closes_them(self):
        self.context.close()
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        self.page = self.context.new_page()
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.install_routes(self.page)
        self.load("#/?sidebar=0")
        self.assertTrue(self.page.locator("body").evaluate("el => el.classList.contains('mobile')"))
        self.page.locator("#hamburger-btn").click()
        self.assertTrue(self.page.locator("#left-sidebar").evaluate("el => el.classList.contains('open')"))
        self.assertTrue(self.page.locator("#overlay").evaluate("el => el.classList.contains('open')"))
        self.page.locator("#settings-btn").click()
        self.assertFalse(self.page.locator("#left-sidebar").evaluate("el => el.classList.contains('open')"))
        self.assertTrue(self.page.locator("#right-sidebar").evaluate("el => el.classList.contains('open')"))
        self.page.locator("#overlay").dispatch_event("click")
        self.assertFalse(self.page.locator("#right-sidebar").evaluate("el => el.classList.contains('open')"))
        self.assertEqual(self.page_errors, [])

    def test_mobile_sidebar_history_back_keeps_the_drawer_open(self):
        self.context.close()
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        self.page = self.context.new_page()
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.install_routes(self.page)
        self.load("#/?sidebar=0")
        self.page.locator("#hamburger-btn").click()
        self.page.locator("#sidebar-content .repo-list-item").first.wait_for(state="visible")
        self.page.locator("#sidebar-content .repo-list-item").first.click()
        self.page.wait_for_function("STATE.mode === 'repo'")
        self.page.evaluate("history.back()")
        self.page.wait_for_function("STATE.mode === 'global'")
        self.assertTrue(self.page.locator("#left-sidebar").evaluate("el => el.classList.contains('open')"))
        self.assertTrue(self.page.locator("#overlay").evaluate("el => el.classList.contains('open')"))
        self.assertEqual(self.page_errors, [])

    def test_mobile_back_closes_visible_drawer_before_leaving_search(self):
        self.context.close()
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        self.page = self.context.new_page()
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.install_routes(self.page)
        self.load()
        self.page.wait_for_function("() => STATE.isMobile && STATE.leftSidebarOpen && history.state?.voiceSidebarGuard")
        self.page.evaluate("history.back()")
        self.page.wait_for_function("() => !STATE.leftSidebarOpen && !STATE.rightSidebarOpen && !history.state?.voiceSidebarGuard")
        self.assertTrue(self.page.url.startswith(self.origin + "/search/"))

        self.page.evaluate("history.forward()")
        self.page.wait_for_function("() => STATE.leftSidebarOpen && history.state?.voiceSidebarOverlay")
        self.page.evaluate("history.back()")
        self.page.wait_for_function("() => !STATE.leftSidebarOpen && !history.state?.voiceSidebarGuard")

        self.page.locator("#settings-btn").click()
        self.page.wait_for_function("() => STATE.rightSidebarOpen && history.state?.voiceSidebarGuard")
        self.page.evaluate("history.back()")
        self.page.wait_for_function("() => !STATE.leftSidebarOpen && !STATE.rightSidebarOpen && !history.state?.voiceSidebarGuard")
        self.assertTrue(self.page.url.startswith(self.origin + "/search/"))

        self.page.locator("#hamburger-btn").click()
        self.page.wait_for_function("() => STATE.leftSidebarOpen && history.state?.voiceSidebarGuard")
        self.page.locator("#settings-btn").click()
        self.page.wait_for_function("() => STATE.rightSidebarOpen && !STATE.leftSidebarOpen && history.state?.voiceSidebarGuard")
        self.page.evaluate("history.back()")
        self.page.wait_for_function("() => !STATE.leftSidebarOpen && !STATE.rightSidebarOpen && !history.state?.voiceSidebarGuard")

        self.page.locator("#settings-btn").click()
        self.page.wait_for_function("() => STATE.rightSidebarOpen && history.state?.voiceSidebarGuard")
        self.page.locator("#close-filters-btn").click()
        self.page.wait_for_function("() => !STATE.rightSidebarOpen && !history.state?.voiceSidebarGuard")

        self.page.locator("#hamburger-btn").click()
        self.page.wait_for_function("() => STATE.leftSidebarOpen && history.state?.voiceSidebarOverlay")
        self.page.evaluate("ROUTER.navigate('repo', 'VOMEBOOK', 'docs')")
        self.page.wait_for_function("() => STATE.browserPath === 'docs'")
        self.page.locator("#hamburger-btn").click()
        self.page.wait_for_function("() => !STATE.leftSidebarOpen")
        self.assertEqual(self.page.evaluate("STATE.browserPath"), "docs")
        self.assertIn("path=docs", self.page.url)

        self.load("?direct=1#/VOMEBOOK")
        self.page.wait_for_function("() => typeof STATE !== 'undefined' && STATE.mode === 'repo' && STATE.leftSidebarOpen && history.state?.voiceSidebarOverlay")
        self.page.evaluate("history.back()")
        self.page.wait_for_function("() => STATE.mode === 'repo' && !STATE.leftSidebarOpen && !history.state?.voiceSidebarGuard")
        self.assertEqual(self.page.evaluate("location.hash.split('?')[0]"), "#/VOMEBOOK")
        self.assertEqual(self.page_errors, [])

    def test_mobile_reader_return_does_not_restore_closed_sidebar(self):
        self.context.close()
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        self.page = self.context.new_page()
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.install_routes(self.page)
        self.page.route("https://voiceofml-search.hf.space/api/reader-content**",
                        lambda route: route.fulfill(content_type="text/plain", body="Reader navigation",
                                                  headers={"Access-Control-Allow-Origin": "*"}))
        self.load()
        self.page.wait_for_function("() => STATE.leftSidebarOpen && history.state?.voiceSidebarGuard")
        url = "/search/static/reader.html?url=https%3A%2F%2Fhuggingface.co%2Fdatasets%2FVoiceOfML%2FTest%2Fresolve%2Fmain%2Fback.txt&ext=txt"
        self.assertTrue(self.page.evaluate("url => navigateToReader(url)", url))
        self.page.frame_locator("iframe.reader-overlay").locator(".reader-text").wait_for()
        self.page.evaluate("history.back()")
        self.page.locator("iframe.reader-overlay").wait_for(state="detached")
        self.assertFalse(self.page.evaluate("STATE.leftSidebarOpen || STATE.rightSidebarOpen || !!history.state?.voiceSidebarGuard"))
        self.assertIn("sidebar=0", self.page.url)
        self.assertEqual(self.page_errors, [])

    def test_mobile_sidebar_back_returns_by_directory_level(self):
        self.context.close()
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        self.page = self.context.new_page()
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.install_routes(self.page)
        self.load("#/?sidebar=0")
        self.page.locator("#hamburger-btn").click()
        self.page.locator("#sidebar-content .repo-list-item").first.wait_for(state="visible")
        self.page.locator("#sidebar-content .repo-list-item").first.click()
        self.page.wait_for_function("STATE.mode === 'repo' && STATE.browserPath === ''")
        self.page.evaluate("ROUTER.navigate('repo', 'VOMEBOOK', 'docs')")
        self.page.wait_for_function("STATE.browserPath === 'docs'")
        self.page.evaluate("ROUTER.navigate('repo', 'VOMEBOOK', 'docs/part')")
        self.page.wait_for_function("STATE.browserPath === 'docs/part'")
        self.page.evaluate("history.back()")
        self.page.wait_for_function("STATE.browserPath === 'docs'")
        self.assertTrue(self.page.locator("#left-sidebar").evaluate("el => el.classList.contains('open')"))
        self.page.evaluate("history.back()")
        self.page.wait_for_function("STATE.browserPath === ''")
        self.assertTrue(self.page.locator("#left-sidebar").evaluate("el => el.classList.contains('open')"))
        self.assertEqual(self.page_errors, [])

    def test_ime_defers_search_then_api_mode_uses_mocked_search(self):
        self.load()
        search = self.page.locator("#search-input")
        search.dispatch_event("compositionstart")
        search.evaluate("el => { el.value = '目录'; el.dispatchEvent(new Event('input', {bubbles: true})); }")
        self.page.wait_for_timeout(450)
        self.assertNotIn("q=", self.page.evaluate("location.hash"))
        search.dispatch_event("compositionend")
        self.page.wait_for_function("location.hash.includes('q=%E7%9B%AE%E5%BD%95')", timeout=10000)
        self.page.locator("#settings-btn").click()
        self.page.locator("#local-mode-toggle").evaluate(
            "el => { el.checked = false; el.dispatchEvent(new Event('change', {bubbles: true})); }"
        )
        search.fill("api-only-query")
        self.page.locator("#results-list").get_by_text("API deterministic result").wait_for(timeout=10000)
        self.assertTrue(any("/api/search" in request[1] for request in self.api_requests))
        self.assertIn("local=0", self.page.evaluate("location.hash"))
        self.assertEqual(self.page_errors, [])

    def test_reader_path_returns_to_matching_folder_filter(self):
        self.load()
        reader_url = self.page.evaluate("""() => getReaderLink({
          Repo: "VoiceOfML/VOMEBOOK", File: "路径测试", Extension: "txt",
          Folder: ["一级目录", "二级目录"], HasTxt: true,
          Link: "https://huggingface.co/datasets/VoiceOfML/VOMEBOOK/resolve/main/reader.txt",
        })""")
        self.page.goto(self.origin + reader_url, wait_until="domcontentloaded")
        path = self.page.locator("#reader-path")
        path.wait_for(state="visible", timeout=10000)
        self.assertEqual(path.text_content(), "VOMEBOOK/一级目录/二级目录")
        self.assertTrue(self.page.locator("#status").is_hidden())
        path.click()
        self.page.wait_for_function("location.hash.includes('folder_self=')", timeout=10000)
        target = self.page.evaluate("""() => {
          const query = location.hash.split('?', 2)[1] || '';
          return {hash: location.hash, folders: new URLSearchParams(query).getAll('folder_self')};
        }""")
        self.assertTrue(target["hash"].startswith("#/VOMEBOOK?"))
        self.assertEqual(target["folders"], ["一级目录/二级目录"])
        self.assertEqual(self.page_errors, [])

    def test_reader_back_closes_overlay_without_reloading_search(self):
        self.load("#/?q=目录&ext=txt&filters=1")
        self.page.wait_for_function("() => STATE.query === '目录' && STATE.filterExtensions.includes('txt') && STATE.rightSidebarOpen")
        marker = self.page.evaluate("() => { window.__readerReturnMarker = Math.random(); return window.__readerReturnMarker; }")
        reader_url = self.page.evaluate("""() => getReaderLink({
          Repo: "VoiceOfML/VOMEBOOK", File: "返回测试", Extension: "txt", Folder: [], HasTxt: true,
          Link: "https://huggingface.co/datasets/VoiceOfML/VOMEBOOK/resolve/main/return.txt"
        })""")
        search_url = self.page.url
        self.page.locator("#search-input").focus()
        self.page.evaluate("""() => {
          const stale = new URL('/search/static/reader.html?nav=stale', location.origin).href;
          sessionStorage.setItem('reader-return:stale', location.href);
          sessionStorage.setItem('reader-navigation-current', JSON.stringify({readerUrl: stale, shareUrl: stale}));
        }""")
        self.page.evaluate("url => navigateToReader(url)", reader_url)
        self.assertEqual(self.page.evaluate("() => location.pathname"), "/search/static/reader.html")
        self.assertNotIn("return=", self.page.url)
        self.assertNotIn("nav=", self.page.url)
        self.assertIsNone(self.page.evaluate("() => sessionStorage.getItem('reader-return:stale')"))
        self.assertEqual(self.page.evaluate("() => Object.keys(sessionStorage).filter(key => key.startsWith('reader-return:')).length"), 1)
        reader = self.page.frame_locator("iframe.reader-overlay")
        reader.locator("#back").wait_for(state="visible")
        reader.locator("html[data-reader-phase]").wait_for(state="attached")
        initial_dark = self.page.evaluate("() => STATE.isDark")
        reader.locator("#history").click()
        reader.locator("#history-panel.is-open").wait_for(state="visible")
        reader.locator("#theme-toggle").click()
        self.page.wait_for_function("initial => STATE.isDark !== initial", arg=initial_dark)
        self.assertEqual(reader.locator("html").get_attribute("data-theme"), "light" if initial_dark else "dark")
        reader.locator("#theme-toggle").click()
        self.page.wait_for_function("initial => STATE.isDark === initial", arg=initial_dark)
        reader.locator("#history-close").click()
        self.page.wait_for_function("() => document.activeElement === document.querySelector('iframe.reader-overlay')")
        self.assertGreater(self.page.locator("body > [inert]").count(), 0)
        reader.locator("#back").click()
        self.page.locator("iframe.reader-overlay").wait_for(state="detached")
        self.assertEqual(self.page.url, search_url)
        self.assertEqual(self.page.evaluate("() => window.__readerReturnMarker"), marker)
        self.assertTrue(self.page.locator("#search-input").evaluate("el => el === document.activeElement"))
        self.assertEqual(self.page.locator("body > [inert]").count(), 0)
        self.assertEqual(self.page.evaluate("() => performance.getEntriesByType('navigation')[0].type"), "navigate")
        self.page.go_forward(wait_until="commit")
        self.page.locator("iframe.reader-overlay").wait_for(state="attached")
        self.assertEqual(self.page.evaluate("() => location.pathname"), "/search/static/reader.html")
        self.page.evaluate("() => history.replaceState(null, '', location.href)")
        self.page.reload(wait_until="domcontentloaded")
        self.page.locator("#back").click()
        self.page.locator("#search-input").wait_for(state="visible")
        self.assertEqual(self.page.url, search_url)
        self.page.wait_for_function("() => STATE.query === '目录' && STATE.filterExtensions.includes('txt') && STATE.rightSidebarOpen")
        self.assertEqual(self.page.evaluate("() => Object.keys(sessionStorage).filter(key => key.startsWith('reader-return:')).length"), 0)
        self.assertIsNone(self.page.evaluate("() => sessionStorage.getItem('reader-navigation-current')"))
        self.assertEqual(self.page_errors, [])

    def test_reader_back_restores_virtual_search_scroll(self):
        self.load()
        before = self.page.evaluate("""async () => {
            STATE.results = Array.from({length: 240}, (_, index) => ({
                Repo: "VoiceOfML/VOMEBOOK",
                File: `返回滚动-${index}`,
                Extension: "txt",
                Folder: index % 3 === 0 ? ["目录", `分组-${index}`] : [],
                Size: index + 1,
                HasTxt: true,
            }));
            STATE.total = STATE.results.length;
            STATE.hasMore = false;
            STATE.isLoading = false;
            resetVirtualScrollState();
            renderResults();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            DOM.resultsContainer.scrollTop = 520;
            DOM.resultsContainer.dispatchEvent(new Event("scroll"));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return DOM.resultsContainer.scrollTop;
        }""")
        self.assertGreater(before, 0)
        self.page.evaluate("url => navigateToReader(url)", "/search/static/reader.html?title=返回滚动")
        self.page.locator("iframe.reader-overlay").wait_for(state="attached")
        self.page.evaluate("history.back()")
        self.page.locator("iframe.reader-overlay").wait_for(state="detached")
        self.page.wait_for_function(
            "expected => Math.abs(DOM.resultsContainer.scrollTop - expected) <= 1",
            arg=before,
            timeout=10000,
        )
        self.assertEqual(self.page.evaluate("DOM.resultsContainer.scrollTop"), before)
        self.assertEqual(self.page_errors, [])

    def test_search_snapshot_restores_results_and_page_cache(self):
        self.load()
        restored = self.page.evaluate("""async () => {
            const first = [
                {Repo: "VoiceOfML/VOMEBOOK", File: "快照一", Extension: "txt", Folder: ["目录"], Size: 1},
                {Repo: "VoiceOfML/VOMEBOOK", File: "快照二", Extension: "txt", Folder: [], Size: 2},
            ];
            STATE.query = "快照查询";
            DOM.searchInput.value = STATE.query;
            STATE.results = first;
            STATE.total = 2;
            STATE.page = 2;
            STATE._loadedPage = 2;
            STATE._pageCache = {1: first.slice(0, 1), 2: first.slice(1)};
            STATE.hasMore = true;
            STATE.isLoading = false;
            resetVirtualScrollState();
            renderResults();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const key = getSearchViewKey();
            saveSearchViewSnapshot(key);
            STATE.query = "另一个查询";
            DOM.searchInput.value = STATE.query;
            STATE.results = [];
            STATE.total = 0;
            STATE.page = 1;
            STATE._loadedPage = 0;
            STATE._pageCache = {};
            renderResults();
            STATE.query = "快照查询";
            DOM.searchInput.value = STATE.query;
            const didRestore = restoreSearchViewSnapshot(getSearchViewKey(), false);
            return {
                didRestore,
                files: STATE.results.map(result => result.File),
                total: STATE.total,
                page: STATE.page,
                loadedPage: STATE._loadedPage,
                cachedPages: Object.keys(STATE._pageCache).sort(),
            };
        }""")
        self.assertTrue(restored["didRestore"])
        self.assertEqual(restored["files"], ["快照一", "快照二"])
        self.assertEqual(restored["total"], 2)
        self.assertEqual(restored["page"], 2)
        self.assertEqual(restored["loadedPage"], 2)
        self.assertEqual(restored["cachedPages"], ["1", "2"])
        self.assertEqual(self.page_errors, [])

    def test_reader_root_return_url_is_normalized_to_search(self):
        self.load()
        reader_url = self.page.evaluate("""() => getReaderLink({
          Repo: "VoiceOfML/VOMEBOOK", File: "根路径返回", Extension: "txt", Folder: [], HasTxt: true,
          Link: "https://huggingface.co/datasets/VoiceOfML/VOMEBOOK/resolve/main/root.txt"
        })""")
        self.page.evaluate("url => navigateToReader(url, location.origin + '/')", reader_url)
        self.page.frame_locator("iframe.reader-overlay").locator("#back").click()
        self.page.locator("#search-input").wait_for(state="visible")
        self.assertEqual(self.page.evaluate("() => location.pathname"), "/search/")

    def test_reader_history_switch_updates_parent_url_and_state(self):
        self.load("#/?q=历史切书")
        first_url = self.page.evaluate("""() => getReaderLink({
          Repo: "VoiceOfML/VOMEBOOK", File: "第一本", Extension: "txt", Folder: [], HasTxt: true,
          Link: "https://huggingface.co/datasets/VoiceOfML/VOMEBOOK/resolve/main/first.txt"
        })""")
        second_url = self.page.evaluate("""() => new URL(getReaderLink({
          Repo: "VoiceOfML/VOMEBOOK", File: "第二本", Extension: "txt", Folder: [], HasTxt: true,
          Link: "https://huggingface.co/datasets/VoiceOfML/VOMEBOOK/resolve/main/second.txt"
        }), location.origin).href""")
        search_url = self.page.url
        self.page.evaluate("url => navigateToReader(url)", first_url)
        self.page.frame_locator("iframe.reader-overlay").locator("#back").wait_for()
        reader_frame = next(frame for frame in self.page.frames if frame.parent_frame is not None and "/search/static/reader.html" in frame.url)
        reader_frame.evaluate("""async (readerUrl) => VoiceOfMLReaderStore.put({
          url: 'https://huggingface.co/datasets/VoiceOfML/VOMEBOOK/resolve/main/second.txt',
          title: '第二本.txt', extension: 'txt', readerUrl, page: 1, pageCount: 0, lastReadAt: Date.now()
        })""", second_url)
        reader_frame.locator("#history").click()
        reader_frame.locator('.reader-panel-tabs button[data-panel="history"]').click()
        reader_frame.locator("#history-list .panel-item-main").filter(has_text="第二本.txt").click()
        self.page.wait_for_function("() => new URL(location.href).searchParams.get('title') === '第二本.txt'")
        self.assertEqual(self.page.evaluate("() => new URL(history.state.readerUrl).searchParams.get('title')"), "第二本.txt")
        self.page.frame_locator("iframe.reader-overlay").locator("#title").filter(has_text="第二本.txt").wait_for()
        self.page.frame_locator("iframe.reader-overlay").locator("#back").click()
        self.page.locator("iframe.reader-overlay").wait_for(state="detached")
        self.assertEqual(self.page.url, search_url)
        self.assertEqual(self.page_errors, [])

    def test_indexeddb_restores_last_search_but_explicit_url_wins(self):
        self.load("#/?q=持久搜索&ext=pdf&filters=1")
        self.page.wait_for_function("() => STATE.query === '持久搜索' && STATE.filterExtensions.includes('pdf')")
        self.page.wait_for_function("""async () => {
          const db = await openSearchSessionDB();
          const tx = db.transaction('session', 'readonly');
          const request = tx.objectStore('session').get('last-search');
          const saved = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = reject; });
          db.close();
          return saved && saved.url.includes(encodeURIComponent('持久搜索'));
        }""")
        self.page.close()
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.install_routes(self.page)
        self.load()
        self.page.wait_for_function("() => STATE.query === '持久搜索' && STATE.filterExtensions.includes('pdf') && STATE.rightSidebarOpen")
        self.page.goto(self.origin + "/search/#/?q=显式搜索&ext=txt", wait_until="domcontentloaded")
        self.page.locator("#search-input").wait_for(state="visible")
        self.page.wait_for_function("() => STATE.query === '显式搜索' && STATE.filterExtensions.length === 1 && STATE.filterExtensions[0] === 'txt'")
        self.assertEqual(self.page_errors, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

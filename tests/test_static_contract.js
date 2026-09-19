const fs = require("fs");
const assert = require("assert");
const vm = require("vm");
const { assertCode } = require("./reader_source_contract");
const { test, run } = require("./test_harness");

const app = fs.readFileSync("static/app.js", "utf8");
const reader = fs.readFileSync("static/reader.js", "utf8");
const worker = fs.readFileSync("static/index-worker.js", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("static/style.css", "utf8");
const readerCss = fs.readFileSync("static/reader.css", "utf8");
const readerHtml = fs.readFileSync("static/reader.html", "utf8");
const workflow = fs.readFileSync(".github/workflows/static.yml", "utf8");

test("Reader-Assets preserves native Foliate extensions from asset filenames", () => {
  assert.match(app, /VoiceOfMLReader\.assetFields\(asset, API_BASE/);
});
test("legacy URL and sidebar field compatibility are retired", () => {
  assert.doesNotMatch(app, /route\.params\.folder\b|legacyFolders/);
  assert.doesNotMatch(app, /data\.folders \|\| data\.d|data\.files \|\| data\.f|item\.name == null/);
});
test("main thread retains stale-search and cancellation controls", () => {
  assert.match(app, /searchRequestId/);
  assert.match(app, /AbortController/);
});
test("section filter cancel buttons clear only their selected state", () => {
  for (const id of ["repo-filter-cancel", "folder-filter-cancel", "ext-filter-cancel"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*hidden>取消<`));
  }
  assert.match(app, /DOM\.repoFilterCancel\.hidden = STATE\.filterRepos\.length === 0/);
  assert.match(app, /DOM\.folderFilterCancel\.hidden = STATE\.filterFolderSelfs\.length === 0 && STATE\.filterFolderSubtrees\.length === 0/);
  assert.match(app, /DOM\.extFilterCancel\.hidden = STATE\.filterExtensions\.length === 0/);
  assert.match(app, /DOM\.folderFilterCancel\.addEventListener\("click", function\(\) \{\s*persistFolderSelection\(new Set\(\), new Set\(\)\)/);
  assert.match(app, /DOM\.extFilterCancel\.addEventListener[\s\S]*?STATE\.filterExtensions = \[\][\s\S]*?saveStoredExtensionFilters\(\)/);
  assert.match(css, /\.filter-title-leading \{[\s\S]*?display: flex/);
});
test("main thread has warm-connection keepalive", () => {
  assert.match(app, /function warmConnection/);
  assert.match(app, /keepalivePending/);
  assert.match(app, /KEEPALIVE_INTERVAL_MS|KEEPALIVE_MIN_GAP_MS/);
  assert.match(app, /document\.hidden \|\| !navigator\.onLine/);
  assert.match(app, /apiAvailable/);
  assert.match(app, /API_BASE.*\/api\/ping/);
  assert.match(html, /fetch\("https:\/\/voiceofml-search\.hf\.space\/api\/ping", \{ cache: "no-store" \}\)\.catch/);
  assert.ok(html.indexOf("/api/ping") < html.indexOf('href="static/style.css"'));
});
test("startup metadata requests are deduplicated without repository-wide folder prefetch", () => {
  assert.match(app, /if \(repoApiPending\) return repoApiPending/);
  assert.match(app, /if \(sidebarInitialPending\.has\(key\)\) return sidebarInitialPending\.get\(key\)/);
  assert.strictEqual(/fetchFolderContents\(shortName, ""\)/.test(app), false);
});
test("local metadata completion refreshes global repository and extension filters", () => {
  assert.match(app, /STATE\.extensionList = extensionList;/);
  assert.match(app, /if \(STATE\.mode === "repo"\) \{[\s\S]*?renderFilters\(routeRenderId\);/);
  assert.match(app, /renderExtensionFilter\(routeRenderId\);/);
  assert.match(app, /renderRepoFilter\(routeRenderId\);/);
  assert.match(app, /async function renderRepoFilter[\s\S]*?await loadSidebarInitial\(null\)/);
});
test("filter metadata rejects stale requests and uses static sidebar fallback", () => {
  assert.match(app, /const extensionApiCache = new Map\(\)/);
  assert.match(app, /const extensionApiPending = new Map\(\)/);
  assert.match(app, /if \(extensionApiPending\.has\(key\)\) return extensionApiPending\.get\(key\)/);
  assert.match(app, /let extensionFilterRenderId = 0/);
  assert.match(app, /if \(renderId !== extensionFilterRenderId\) return/);
  assert.match(app, /if \(STATE\.mode !== renderMode \|\| STATE\.repo !== renderRepo \|\| STATE\.repoFull !== renderRepoFull\) return/);
  assert.match(app, /async function renderRepoList\(routeId\) \{[\s\S]*?var initial = await loadSidebarInitial\(null\)/);
  assert.doesNotMatch(app, /if \(!currentExtNames\.length && STATE\.mode === "repo"\) currentExtNames = extensionList\.slice\(\)\.sort\(\)/);
});
test("background corpus loading uses idle scheduling independently of API prefetch", () => {
  const scheduler = app.match(/function scheduleBackgroundLocalDataLoad\(\) \{([\s\S]*?)\n\}/);
  assert.ok(scheduler);
  assert.doesNotMatch(scheduler[1], /searchPrefetchPromise/);
  assert.match(app, /function scheduleBackgroundLocalDataLoad/);
  assert.match(app, /requestIdleCallback/);
  assert.doesNotMatch(app, /mozConnection|webkitConnection/);
});
test("HTML preloads the default first-page payload before styles and application startup", () => {
  assert.match(html, /<link rel="preload" href="\/search\/data\/initial\/global\.json" as="fetch" crossorigin="anonymous">/);
  assert.ok(html.indexOf("/api/ping") < html.indexOf('rel="preload"'));
  assert.ok(html.indexOf('rel="preload"') < html.indexOf('href="static/style.css"'));
});
test("static header logo stays inside the Pages search prefix before startup", () => {
  assert.match(html, /id="header-logo"[^>]*href="\/search\/"/);
});

test("reader intent prefetches the shell and format engines", () => {
  assertCode(app, 'VoiceOfMLReaderResources.shellAssets("/search/static/")');
  assertCode(app, 'VoiceOfMLReaderResources.engineAssets(extension, "/search/static/", "?reader-v1")');
  assertCode(sw, 'VoiceOfMLReaderResources.runtimePaths("/search/static/")');
  assert.ok(workflow.includes('.buildFiles("github")'));
  assert.match(app, /var warmedReaderSources = new Set\(\)/);
  assert.match(app, /warmedReaderSources\.size >= 8/);
  assert.match(app, /method: readerId \? "GET" : "HEAD", cache: "no-store"/);
  assertCode(reader, 'if (!fallback) { fallback = true; image.src = sourceUrl; } else finish(new Error("image load failed"))');
  assert.match(reader, /image\.src = contentUrl/);
  assert.match(reader, /disableStream: true/);
  assert.match(reader, /capability = readerRuntime\.negotiate\(VoiceOfMLReader\.capability\(extension\)\)/);
  assert.match(reader, /resolved\.extension[\s\S]*content\.dataset\.mode = capability\.mode/);
  const imageRule = readerCss.match(/\.reader-content\[data-mode="pdf-pages"\]\s+\.reader-page\s*>\s*img\s*\{([^}]+)\}/);
  assert.ok(imageRule, 'PDF image sizing rule');
  for (const [property, value] of [['display', 'block'], ['width', '100%'], ['max-width', '100%'], ['height', 'auto']]) {
    assert.match(imageRule[1], new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*${value}\\s*(?:;|$)`));
  }
  assert.match(readerCss, /prefers-contrast\s*:\s*more/);
  assertCode(fs.readFileSync("static/reader-store.js", "utf8"), 'Number(existing.result.lastReadAt) > Number(entry.lastReadAt)');
  assert.match(fs.readFileSync("static/reader-store.js", "utf8"), /BroadcastChannel/);
  assert.match(reader, /VoiceOfMLReaderStore\.subscribe/);
  assert.match(reader, /VoiceOfMLReaderStore\.dispose/);
  assert.match(reader, /VoiceOfMLReaderSecurity\.readBytes/);
  assert.ok(require('../static/reader-resources.js').runtimePaths('/search/static/').includes('/search/static/reader-security.js'));
  assert.match(fs.readFileSync("static/reader-store.js", "utf8"), /function dispose\(\)/);
});
test("desktop random actions match their labels and empty-state behavior", () => {
  assert.match(html, /id="random-book-btn" class="random-txt-btn" title="随机下本书"/);
  assert.match(html, /id="random-txt-btn" class="random-book-btn" title="随机来本书"/);
  assert.match(app, /DOM\.randomBookBtn\.addEventListener\("click", randomBook\)/);
  assert.match(app, /DOM\.randomTxtBtn\.addEventListener\("click", randomTxt\)/);
  assert.match(app, /DOM\.emptyRandomBtn\.addEventListener\("click", randomTxt\)/);
  assert.match(app, /正在随机下载书籍/);
  assert.match(app, /正在随机打开书籍/);
  assert.doesNotMatch(html, /随机来一篇/);
  assert.doesNotMatch(app, /随机打开文章|暂无可读文章/);
});
test("fresh first-page results use bounded entrance motion", () => {
  assert.match(app, /function animateVisibleResultRows/);
  assert.match(app, /Number\(row\.dataset\.index\) >= 30/);
  assert.match(app, /renderResults\(true\)/);
  // API and Worker results now enter through the same rendering function.
  assert.match(app, /function renderSearchPage\(append\)/);
  assert.match(css, /\.result-item\.result-enter/);
  assert.match(css, /animation: result-item-enter 180ms/);
  assert.match(css, /opacity: 0\.82/);
  assert.strictEqual(/opacity: 0\.45/.test(css), false);
  assert.strictEqual(/transform: translateY\(3px\)/.test(css), false);
  assert.match(css, /prefers-reduced-motion/);
});
test("result actions use equal desktop heights and compact mobile column", () => {
  assert.doesNotMatch(app, /class="result-summary"/);
  assert.match(app, /class="result-title"[\s\S]*class="result-path"[\s\S]*class="result-meta"/);
  assert.match(css, /body:not\(\.mobile\) \.result-title \{ grid-column: 3; grid-row: 1;/);
  assert.match(css, /body:not\(\.mobile\) \.result-path \{ grid-column: 3 \/ 5; grid-row: 2;/);
  assert.match(css, /body:not\(\.mobile\) \.result-meta \{ grid-column: 3 \/ 5; grid-row: 3;/);
  assert.match(css, /\.result-action-btn \{\s*height: 24px;\s*display: inline-flex;/);
  assert.match(css, /body\.mobile \.result-actions \{\s*flex-direction: column;\s*gap: 1px;/);
  assert.match(css, /body\.mobile \.result-action-btn \{ height: 20px;/);
  assert.match(css, /body\.mobile \.result-path \{\s*display: block;\s*white-space: normal;\s*word-break: break-all;\s*overflow-wrap: normal;/);
  assert.match(app, /folderDisplay \+ separator \+ '<\/span>'/);
  assert.doesNotMatch(app, /'<span class="path-sep">\/<\/span><span class="path-folder"/);
});
test("virtual results use bounded buffering", () => {
  assert.match(app, /const extraScreens = VSCROLL\.isDraggingThumb \? 0 : Math\.min\(3/);
  assert.match(app, /const velocityOverscanPx = extraScreens \* viewH/);
  assert.match(app, /VSCROLL\.renderStart <= safeStart && VSCROLL\.renderEnd >= safeEnd/);
  assert.match(app, /function ensureVirtualViewportCovered/);
  assert.match(app, /function renderVisible\(\)/);
  assert.match(app, /const scrollingDown = scrollTop >= VSCROLL\.lastScrollTop/);
  assert.match(app, /function refreshVirtualAfterAppend/);
  assert.match(app, /function reconcileVirtualRows/);
  assert.match(app, /virtual-spacer-bottom/);
  assert.match(app, /Number\(row\.dataset\.contentVersion\) !== VSCROLL\.contentVersion/);
  assert.match(app, /VSCROLL\.templateCache\.size > 240/);
  assert.match(app, /function scheduleVirtualRender/);
  assert.match(app, /scheduleVirtualRender\(\)/);
  assert.match(app, /if \(!dragFrame\) dragFrame = requestAnimationFrame\(applyPendingScrollTop\)/);
  assert.match(app, /setResultScrollTop\(pendingScrollTop\);\s*pendingScrollTop = null;\s*renderVisible\(\);/);
  assert.match(app, /VSCROLL\.isDraggingThumb\s*\? viewH \* 0\.35/);
  assert.match(app, /if \(!VSCROLL\.isDraggingThumb && measureHeights\(start, end, anchor\)\)/);
  assert.match(app, /VSCROLL\.dragMetrics = null/);
  assert.match(css, /overflow-anchor: none/);
  assert.strictEqual(/function finishDrag\(\)[\s\S]*?measureHeights/.test(app), false);
  assert.match(app, /dragRange = Math\.max\(1, DOM\.scrollTrack\.clientHeight - DOM\.scrollThumb\.clientHeight\)/);
  assert.match(app, /applyPendingScrollTop\(\);\s*VSCROLL\.isDraggingThumb = false/);
  assert.strictEqual(/VSCROLL\.renderStart = -1;\s*VSCROLL\.renderEnd = -1;\s*renderVisible\(\);\s*if \(STATE\._deferredAppendWhileDragging\)/.test(app), false);
  assert.match(app, /VSCROLL\.measuredWindowKey === measureKey/);
  assert.match(app, /VSCROLL\.measuredRowKeys\[idx\] === rowMeasureKey/);
  assert.match(app, /const rowMeasureKey = getHeightMeasurementKey\(\)/);
  assert.match(css, /contain: paint/);
  assert.match(app, /function ensureHeightTree/);
  assert.match(app, /const parent = i \+ \(i & -i\)/);
  assert.match(app, /const canExtendTree = !VSCROLL\.heightsDirty/);
  assert.match(app, /querySelectorAll\("\.result-skeleton-item"\)\.forEach/);
});

test("Reader return and search snapshot state is preserved", () => {
  for (const value of [
    "SEARCH_VIEW_SNAPSHOT_VERSION",
    "SEARCH_VIEW_SNAPSHOT_MAX",
    "function getSearchViewKey",
    "function saveSearchViewSnapshot",
    "function restoreSearchViewSnapshot",
    "function captureReaderReturnScroll",
    "function restoreReaderReturnScroll",
    "viewKey: \"\"",
    "heightCache: new Map()",
    "readerNavigation.remember(url, readerReturnScrollState)",
    "if (saved.viewKey && saved.viewKey !== getSearchViewKey())",
    "if (readerReturnScrollState && !readerReturnRestoreActive)",
  ]) assert.ok(app.includes(value), value);
  assert.match(app, /searchWithInitialFallback\(\);/);
  assert.doesNotMatch(app, /if \(!restoreSearchViewSnapshot\(getSearchViewKey\(\)\)\) searchWithInitialFallback\(\);/);
});

test("Worker retains tokenizer and fuzzy edit distance", () => {
  assert.match(worker, /function tokenize/);
  assert.match(worker, /function editDistance/);
});
test("Worker retains wildcard conversion", () => {
  assert.match(worker, /function wildcardPatternToRegExp/);
});
test("Worker exclusively owns compact corpus loading and derived search indexes", () => {
  assert.match(worker, /fetchGzipJSON/);
  assert.match(worker, /new DecompressionStream\("gzip"\)/);
  assert.match(worker, /function decodeSearchPayload/);
  assert.match(worker, /function buildFulltext/);
  assert.match(worker, /type === "load-corpus"/);
  assert.match(worker, /state: "corpus-ready"/);
  assert.strictEqual(/\bRECORDS\b|decodeSearchPayload|function buildIndex|wordIndex|vocabSorted|repoRecordIndices/.test(app), false);
});
test("versioned Worker dispatcher returns bounded records and supports lifecycle fallbacks", () => {
  assert.match(app, /const WORKER_PROTOCOL_VERSION = 1/);
  assert.match(app, /function corpusWorkerRequest/);
  assert.match(app, /corpusWorkerPending/);
  assert.match(app, /addEventListener\("messageerror"/);
  assert.match(app, /corpusWorkerRestartCount >= 1/);
  assert.match(worker, /MAX_PAGE_SIZE/);
  assert.match(worker, /records: pageItems\.map/);
  assert.match(worker, /ids: pageItems\.map/);
  assert.strictEqual(/indices: scored/.test(worker), false);
});
test("random and folder corpus fallbacks use Worker requests", () => {
  assert.match(app, /corpusWorkerRequest\("random-record"/);
  assert.match(app, /corpusWorkerRequest\("folder-contents"/);
  assert.match(app, /corpusWorkerRequest\("folder-tree"/);
  assert.strictEqual(/RECORDS\.filter|buildFilterFolderTree|getRandomTxtLocal/.test(app), false);
});
test("reader uses original files and lazy PDF canvas rendering", () => {
  const contract = fs.readFileSync("static/reader-contract.js", "utf8");
  const reader = fs.readFileSync("static/reader.js", "utf8");
  const readerCss = fs.readFileSync("static/reader.css", "utf8");
  const readerHtml = fs.readFileSync("static/reader.html", "utf8");
  const readerStore = fs.readFileSync("static/reader-store.js", "utf8");
  assert.strictEqual((reader.match(/dataset\.panelView = "full-search"/g) || []).length, 1);
  assert.doesNotMatch(reader, /window\.find/);
  assert.match(reader, /id="full-search-input"/);
  assert.match(reader, /id="full-search-status"/);
  assert.match(reader, /id="full-search-results"/);
  assert.match(reader, /id="full-search-prev"/);
  assert.match(reader, /id="full-search-next"/);
  assert.match(reader, /fullSearchSnippetDom/);
  assert.match(reader, /textContent = "全文搜索"/);
  assert.match(reader, /circle cx="12" cy="12"/);
  assert.match(reader, /async function activateChapter/);
  assert.match(reader, /progressUndo\.hidden = !previousProgressState/);
  assertCode(reader, 'result.activate(generation)');
  const contractContext = { self: {} };
  vm.runInNewContext(contract, contractContext);
  for (const [extension, mode] of Object.entries({ pdf: 'pdf', 'pdf-pages': 'pdf-pages', epub: 'foliate', mp3: 'audio', mp4: 'video', docx: 'docx' })) {
    assert.strictEqual(contractContext.self.VoiceOfMLReader.capability(extension).mode, mode, extension);
  }
  assert.match(app, /VoiceOfMLReader\.readerUrl/);
  assert.match(app, /VoiceOfMLReader\.readerUrl/);
  assert.match(app, /OcrUrl/);
  assert.match(app, /api\/random-reader/);
  assert.doesNotMatch(app, /TXT_BASE/);
  assertCode(reader, 'VoiceOfMLReaderResources.vendorUrl("pdf", "/search/static/")');
  assert.match(reader, /const PDFJS_WASM_URL = "\/search\/static\/vendor\/wasm\/"/);
  assert.match(reader, /wasmUrl: PDFJS_WASM_URL/);
  assert.match(reader, /\/search\/static\/foliate-reader\/view\.js/);
  for (const value of ["epubSearchIndex", "epubSearchIndexReady", "epubZipPath", "buildEpubSearchIndex", "activateIndexedEpubResult", "runIndexedEpubSearch"]) {
    assert.doesNotMatch(reader, new RegExp(value));
  }
  assertCode(reader, 'foliate: [loadMediaDocument, renderFoliate]');
  assert.match(reader, /async function renderFoliate/);
  assert.match(reader, /foliate-view/);
  assert.match(reader, /foliate-continuous/);
  assert.doesNotMatch(reader, /renderFoliateClean|foliate-reader\/reader\.html/);
  assertCode(reader, 'VoiceOfMLReaderResources.vendorUrl("purify", "/search/static/")');
  assert.doesNotMatch(reader, /cdn\.jsdelivr\.net/);
  assert.match(reader, /IntersectionObserver/);
  assert.match(reader, /Map\.prototype\.getOrInsertComputed/);
  assert.match(reader, /Math\.sumPrecise/);
  const workerWrapper = fs.readFileSync("static/pdf-worker-wrapper.mjs", "utf8");
  assert.match(workerWrapper, /Map\.prototype\.getOrInsertComputed/);
  assert.match(workerWrapper, /Math\.sumPrecise/);
  assertCode(workerWrapper, 'import(VoiceOfMLReaderResources.vendorUrl("pdfWorker", "./"))');
  assert.match(workerWrapper, /pendingMessages/);
  assert.match(reader, /document\.createElement\("canvas"\)/);
  assert.doesNotMatch(reader, /previewUrls/);
  assert.doesNotMatch(contract, /ReaderPreview/);
  assert.match(readerHtml, /\/search\/static\/reader-contract\.js/);
  assert.match(readerHtml, /id="download"/);
  assert.match(readerHtml, /id="download"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.doesNotMatch(readerHtml, /id=["']ocr["']/i);
  assert.match(readerHtml, /id="download"[^>]*aria-label="下载原文件"/);
  assert.match(readerHtml, /role="tablist"/);
  assert.match(readerHtml, /aria-controls="toc-panel"/);
  assert.match(readerHtml, /role="tabpanel"/);
  assert.match(readerHtml, /https:\/\/hf-mirror\.com/);
  assert.match(reader, /validOcr/);
  assert.match(reader, /api\/download\?file=/);
  assert.match(reader, /api\/reader-content\?url=/);
  assert.match(reader, /const requestUrl = String\(url\) === sourceUrl \? contentUrl : url/);
  assert.match(reader, /new URL\(url, location\.href\)\.pathname\.split\("\/"\)\.pop\(\)/);
  assert.match(reader, /document\.createDocumentFragment\(\)/);
  assertCode(reader, 'VoiceOfMLReaderSecurity.readBytes(response, VoiceOfMLReaderSecurity.LIMITS.documentBytes)');
  assert.match(reader, /new TextDecoder\(detectTextEncoding\(bytes, documentState\.title\)\)/);
  assert.match(reader, /function detectTextEncoding/);
  assert.match(reader, /new TextDecoder\("utf-8", \{ fatal: true \}\)\.decode\(bytes, \{ stream: true \}\)/);
  assertCode(reader, 'const bytes = await VoiceOfMLReaderSecurity.readBytes(response, VoiceOfMLReaderSecurity.LIMITS.documentBytes)');
  assert.match(reader, /cMapUrl: PDFJS_CMAP_URL/);
  assert.match(reader, /standardFontDataUrl: PDFJS_STANDARD_FONT_URL/);
  assert.match(readerHtml, /'wasm-unsafe-eval'/);
  assert.match(reader, /"gb18030", "big5", "windows-1251", "windows-1252"/);
  assertCode(reader, 'pre.textContent = new TextDecoder(detectTextEncoding(bytes, documentState.title)).decode(bytes)');
  assertCode(reader, 'docx: [loadDocxDocument, renderDocx]');
  assert.match(reader, /docx\.renderAsync/);
  assert.match(reader, /renderAltChunks: false/);
  assertCode(reader, 'VoiceOfMLReaderResources.vendorUrl("jszip", "/search/static/")');
  assertCode(reader, 'VoiceOfMLReaderResources.vendorUrl("docx", "/search/static/")');
  assert.match(app, /&& !rec\.ReaderLink\) return false/);
  assert.match(reader, /if \(extension === "docx"\) return readerAsset/);
  assert.match(reader, /function fetchReaderResponse\(\)/);
  assertCode(reader, 'const READER_PROXY_TIMEOUT_MS = 120000;');
  assertCode(reader, '}, READER_PROXY_TIMEOUT_MS)');
  assert.match(reader, /function fetchWithReaderTimeout/);
  assertCode(reader, 'loadPdfTaskWithTimeout(pdfjs, options, contentUrl)');
  assertCode(reader, 'loadPdfTaskWithTimeout(pdfjs, options, sourceUrl)');
  assert.match(reader, /function loadPdfWithTimeout/);
  assertCode(reader, 'trackReaderResource(destroy)');
  assertCode(reader, 'task.destroy()?.catch?.(() => {})');
  assert.match(app, /function warmReaderIntent/);
  assert.match(reader, /validatePdfPageManifest/);
   assert.match(reader, /chapterManifestObserver/);
   assert.match(reader, /TOC_VIRTUALIZATION_THRESHOLD/);
   assert.match(reader, /renderVirtualToc/);
   assert.match(readerCss, /toc-list-virtualized/);
  assert.match(contract, /params\.set\("ocr"/);
  assert.match(contract, /params\.set\("download"/);
  assert.match(contract, /ReaderExtension/);
  assert.match(contract, /pdf-pages/);
  assert.match(reader, /Reader-Assets/);
  assertCode(reader, 'if (Array.isArray(manifest.toc) && manifest.toc.length) setToc(manifest.toc.map');
  assert.match(reader, /tab\.hidden = !navigationState\.tocEntries\.length/);
  assert.match(reader, /PDF_MANIFEST_INVALID/);
   assert.match(contract, /page-manifest\.json/);
  assert.match(app, /reader_assets\.json\.gz/);
  assert.match(app, /fetchReaderAssetMap\(\)/);
  assert.match(app, /readerAssetsRetryAt = Date\.now\(\) \+ 5000/);
  assert.doesNotMatch(app, /readerAssets = \{\};\s*convertedReaderRecords = \[\];/);
  assert.doesNotMatch(app, /var currentRepo = STATE\.repoFull;\s*await loadReaderAssets\(\)/);
  assert.match(app, /convertedReaderRecords = null/);
  assert.match(app, /applyReaderAsset/);
  assert.match(app, /applyReaderAsset\(rec, rec\.Repo \|\| "", buildRecordRelativePath\(rec\), recordLink\)/);
  assert.match(app, /isReadableRecord\(readerRecord\)/);
  assert.match(app, /getReaderLink\(readerRecord\)/);
  assert.match(app, /navigateToReader\(actionBtn\.dataset\.readerUrl\)/);
  assert.match(app, /navigateToReader\(readerLink\)/);
  const navigation = fs.readFileSync('static/reader-navigation.js', 'utf8');
  assert.match(navigation, /url\.searchParams\.set\("return", returnUrl\)/);
  assert.match(navigation, /sessionStorage\.setItem\("reader-return:" \+ token/);
  assert.match(navigation, /crypto\.getRandomValues\(new Uint32Array\(4\)\)/);
  assert.match(html, /reader-navigation\.js/);
  assert.match(sw, /reader-navigation\.js/);
  assert.doesNotMatch(app, /openPendingWindow/);
  assert.match(reader, /new URL\(returnUrl, location\.origin\)/);
  assert.match(reader, /sessionStorage\.removeItem\(returnHistoryKey\)/);
  assert.match(reader, /canReturnWithHistory = !!returnHistoryKey && storedReturnUrl === target\.href/);
  assert.match(reader, /if \(canReturnWithHistory && history\.length > 1\)[\s\S]*history\.back\(\)/);
  assert.match(reader, /returnNeedsReload[\s\S]*location\.replace\(target\.href\)/);
  assert.match(reader, /canReturnWithHistory && history\.length > 1/);
  assert.match(reader, /location\.assign\("\/search\/"\)/);
  assert.match(app, /requestId !== randomReaderRequestId \|\| location\.href !== returnUrl/);
  assert.match(app, /rec\.ReaderExtension \|\| rec\.Extension/);
  assert.match(app, /function getConvertedReaderRecords\(repo\)/);
  assert.match(app, /originalCount \+ getConvertedReaderRecords/);
  assert.match(app, /useConverted \? converted\[Math\.floor\(Math\.random\(\) \* converted\.length\)\] : await getRandomLocal\(true\)/);
  const randomReaderBlock = app.slice(app.indexOf("async function randomTxt"), app.indexOf("let toastTimer"));
  assert.match(randomReaderBlock, /if \(!originalCount && !readerAssets\) await loadReaderAssets\(\);\s*else loadReaderAssets\(\);/);
  assert.doesNotMatch(randomReaderBlock, /try \{\s*await loadReaderAssets\(\)/);
  assert.match(app, /loadReaderAssets\(\)\.then\(function\(\) \{\s*refreshResultReaderActions\(\);/);
  assert.match(readerHtml, /id="page-number"/);
  assert.match(reader, /document\.querySelector\("\.page-controls"\)\.hidden = !capability\.features\.pagination/);
  assert.match(reader, /document\.createElement\(mode\)/);
  assert.match(reader, /media\.preload = "metadata"/);
  assert.match(reader, /media\.playsInline = true/);
  assert.match(reader, /media\.src = contentUrl/);
  assert.match(readerHtml, /media-src 'self' https:\/\/voiceofml-search\.hf\.space/);
  assert.match(readerCss, /\.reader-video/);
  assert.match(app, /"在线播放" : "在线阅读"/);
  assert.match(readerHtml, /id="zoom" type="number"/);
  assert.match(readerHtml, /id="history-panel"/);
  assert.match(readerHtml, /id="reader-path"/);
  assert.match(contract, /params\.set\("path"/);
  assert.match(contract, /params\.set\("folder_url"/);
  assert.match(app, /FolderUrl: getReaderFolderUrl\(rec\)/);
  assert.match(reader, /status\.hidden = true/);
  assertCode(reader, 'location.assign(folderNavigationTarget.href)');
  assert.match(readerStore, /indexedDB\.open\(DB_NAME, 2\)/);
  assert.match(readerStore, /BOOKMARK_STORE_NAME = "bookmarks"/);
  assert.match(readerStore, /SCHEMA_VERSION = 1/);
  assert.match(readerStore, /normalizeHistoryEntry/);
  assert.match(readerStore, /normalizeBookmarkEntry/);
  assert.match(readerStore, /schemaVersion/);
  assert.match(readerStore, /clearHistory/);
  assert.match(readerStore, /listBookmarks/);
  assert.match(readerStore, /MAX_ENTRIES = 200/);
  assert.match(reader, /VoiceOfMLReaderStore\.put/);
  assert.match(reader, /VoiceOfMLReaderStore\.get/);
  assert.match(reader, /function goToPage/);
  assert.match(reader, /foliateContinuous/);
  assert.match(reader, /viewport\.scrollTop/);
  assert.match(readerHtml, /base-uri 'self' blob:/);
  assert.match(readerHtml, /style-src 'self' 'unsafe-inline' blob:/);
  assert.match(reader, /function renderPdfShell/);
  assert.match(reader, /content\.dataset\.mode = capability\.mode/);
  assert.match(reader, /detectHtmlEncoding\(bytes, documentState\.title\)/);
  assert.match(reader, /content="only light"/);
  assert.match(reader, /repairHtmlContrast\(frame\)/);
  assert.match(reader, /shell\.clientWidth \/ base\.width/);
  assert.doesNotMatch(reader, /epubRendition\.themes\.fontSize/);
  assert.doesNotMatch(reader, /epubRendition\.setReaderTheme\(readerTheme\)/);
  assert.match(reader, /function applyReaderTheme/);
  assert.match(reader, /readerThemeToggle\.innerHTML/);
  assert.match(reader, /body\.classList\.toggle\("reader-document-dark"/);
  assert.match(readerHtml, /id="bookmark-ribbon"/);
  assert.match(readerHtml, /id="toc-tab"/);
  assert.match(readerHtml, /id="history-clear"/);
  assert.match(readerHtml, /id="theme-toggle"/);
  assert.match(readerCss, /\.reader-panel-tabs/);
  assert.match(reader, /function syncCurrentPageFromMarker/);
  assert.match(reader, /\.reader-docx-page/);
  assert.match(app, /message\.type === "voice-reader-open"/);
  assert.match(readerCss, /\.docx-body\.reader-document-dark \.reader-docx/);
  assert.match(reader, /function acquirePdfRenderSlot/);
  assert.match(reader, /function trimPdfCanvases/);
  assert.match(reader, /canvas\.width = 0/);
  assert.match(reader, /Promise\.all\(\[/);
  assert.match(reader, /lastSavedProgress/);
  assert.match(reader, /progressSaveChain/);
  assert.match(readerStore, /store\.count\(\)/);
  assert.match(reader, /renderRetries/);
  assert.match(reader, /pageOffset/);
  assert.doesNotMatch(reader, /pages\.reduce/);
  assert.doesNotMatch(reader, /content\.style\.width/);
  assert.match(readerHtml, /Content-Security-Policy/);
  assert.match(readerHtml, /script-src 'self'/);
  const vendorScript = fs.readFileSync("scripts/copy_reader_vendor.mjs", "utf8") + fs.readFileSync("static/reader-resources.js", "utf8");
  assert.match(vendorScript, /pdfjs-dist@6\.3\.289/);
  assert.match(vendorScript, /standard_fonts\//);
  assert.match(vendorScript, /cmaps\//);
  assert.match(vendorScript, /relative\.startsWith\("wasm\/"\)/);
  assert.match(vendorScript, /06f25e887adc6489f04c9fcb14198c77e4e5623a59a0bba5c4cea5838a4f1241/);
  assert.match(vendorScript, /f80490490320511e5df18c580b9edd6b5db8058dceebaf6f161992e0a964b9e2/);
  assert.match(vendorScript, /marked@18\.0\.13\/lib\/marked\.umd\.js/);
  assert.match(vendorScript, /dompurify@3\.4\.15/);
  assert.doesNotMatch(vendorScript, /writeFileSync\(join\(output, target\)\)/);
  for (const path of ["pdf.min.mjs", "pdf.worker.min.mjs", "marked.min.js", "purify.min.js"]) assert.ok(!sw.includes("static/vendor/" + path));
  assert.match(sw, /url\.pathname === "\/search\/static\/reader\.html"/);
  assert.match(sw, /READER_RUNTIME_PATHS\.has\(url\.pathname\)/);
  assertCode(sw, 'VoiceOfMLReaderResources.runtimePaths("/search/static/")');
  assert.match(sw, /readerNavigation = event\.request\.mode === "navigate" && url\.pathname === "\/search\/static\/reader\.html"/);
  assert.match(sw, /cacheKey = readerNavigation \? "\/search\/static\/reader\.html" : event\.request/);
  assert.match(sw, /fetch\(event\.request\)[\s\S]*cache\.put\(cacheKey/);
});
test("mobile shell hides sidebars before application startup", () => {
  assert.match(html, /document\.documentElement\.classList\.add\("mobile-boot"\)/);
  assert.match(css, /html\.mobile-boot \.left-sidebar/);
  assert.match(app, /document\.documentElement\.classList\.remove\("mobile-boot"\)/);
});
test("Service Worker cache name remains fixed", () => {
  assert.match(sw, /vomebook-search-v1\.0\.0/);
});
test("Service Worker precaches the search Worker", () => {
  assert.match(sw, /search\/static\/index-worker\.js/);
});
test("HTML registers Service Worker under search scope", () => {
  assert.match(html, /register\("\/search\/sw\.js", \{ scope: "\/search\/" \}\)/);
});
test("HTML loads the real application and stylesheet", () => {
  assert.match(html, /href="static\/style\.css"/);
  assert.match(html, /src="static\/app\.js"/);
});
test("deployment workflow runs for main pushes and manual dispatch", () => {
  assert.match(workflow, /push:\s*\n\s*branches: \["main"\]/);
  assert.match(workflow, /workflow_dispatch:/);
});
test("deployment workflow grants required Pages permissions", () => {
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
});
test("deployment workflow uses official checkout configure upload and deploy actions", () => {
  const actions = Array.from(workflow.matchAll(/uses: ([^\s]+)/g), (match) => match[1]);
  assert.deepStrictEqual(actions, [
    "actions/checkout@v7",
    "actions/setup-node@v7",
    "actions/configure-pages@v6",
    "actions/upload-pages-artifact@v5",
    "actions/deploy-pages@v5",
  ]);
});
test("deployment workflow builds and uploads minified static artifacts", () => {
  assert.doesNotMatch(workflow, /node tests\//);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /node scripts\/compose_app\.mjs/);
  assert.match(workflow, /esbuild@0\.28\.2 "\$RUNNER_TEMP\/app-composed\.js" --minify/);
  assert.ok(workflow.includes('esbuild@0.28.2 "static/$file" --minify'));
  assert.match(workflow, /node scripts\/fetch_reader_assets\.mjs _site\/data\/reader_assets\.json\.gz/);
  assert.match(workflow, /node scripts\/copy_reader_vendor\.mjs _site\/static\/vendor/);
  assert.ok(workflow.includes('.buildFiles("github")'));
  assert.match(workflow, /esbuild@0\.28\.2 sw\.js --minify/);
  assert.match(workflow, /uses: actions\/upload-pages-artifact@v5\s*\n\s*with:\s*[\s\S]*?path: '_site'/);
});
test("deployment workflow exposes deployment URL through github-pages environment", () => {
  assert.match(workflow, /environment:\s*\n\s*name: github-pages\s*\n\s*url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  assert.match(workflow, /id: deployment/);
});

run("static contracts");

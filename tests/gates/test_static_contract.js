const fs = require("fs");
const assert = require("assert");
const vm = require("vm");
const { assertCode, readReaderSource } = require("../support/reader_source_contract");
const { test, run } = require("../support/test_harness");

const app = fs.readFileSync("static/app.js", "utf8");
const catalog = fs.readFileSync("static/search/catalog/application/client.js", "utf8");
const readerAssetSnapshot = fs.readFileSync("static/search/reader-assets/application/snapshot.js", "utf8");
const readerAssetTransport = fs.readFileSync("static/search/reader-assets/infrastructure/sidecar.js", "utf8");
const resultRows = fs.readFileSync("static/search/results/presentation/row.js", "utf8");
const resultInteractions = fs.readFileSync("static/search/results/application/interactions.js", "utf8");
const randomDiscovery = fs.readFileSync("static/search/discovery/application/random.js", "utf8");
const shellView = fs.readFileSync("static/search/shell/presentation/view.js", "utf8");
const filters = fs.readFileSync("static/search/sidebar/application/filters.js", "utf8");
const reader = readReaderSource(require("path").resolve("."));
const worker = fs.readFileSync("static/search/index-worker.js", "utf8");
const sw = fs.readFileSync("static/sw.js", "utf8");
const html = fs.readFileSync("static/index.html", "utf8");
const css = fs.readFileSync("static/style.css", "utf8");
const readerCss = fs.readFileSync("static/reader.css", "utf8");
const readerHtml = fs.readFileSync("static/reader.html", "utf8");
const workflow = fs.readFileSync(".github/workflows/static.yml", "utf8");

test("Reader-Assets preserves native Foliate extensions from asset filenames", () => {
  assert.match(readerAssetSnapshot, /VoiceOfMLReader\.assetFields\(asset, deps\.bucketBase/);
  assert.match(app, /bucketBase: API_BASE \+ "\/api\/reader-bucket-resource"/);
});
test("legacy URL and sidebar field compatibility are retired", () => {
  assert.doesNotMatch(app, /route\.params\.folder\b|legacyFolders/);
  assert.doesNotMatch(app, /data\.folders \|\| data\.d|data\.files \|\| data\.f|item\.name == null/);
});
test("main thread retains stale-search and cancellation controls", () => {
  assert.match(app, /searchRequestId/);
  assert.match(app, /AbortController/);
});
test("Worker URL is static-root relative so the Pages build can hash it", () => {
  assert.match(app, /new Worker\("static\/search\/index-worker\.js"\)/);
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
  assert.match(catalog, /if \(repoApiPending\) return repoApiPending/);
  assert.match(catalog, /if \(sidebarInitialPending\.has\(key\)\) return sidebarInitialPending\.get\(key\)/);
  assert.strictEqual(/fetchFolderContents\(shortName, ""\)/.test(app), false);
});
test("local metadata completion refreshes global repository and extension filters", () => {
  assert.match(app, /STATE\.extensionList = extensionList;/);
  assert.match(app, /if \(STATE\.mode === "repo"\) \{[\s\S]*?renderFilters\(routeRenderId\);/);
  assert.match(app, /renderExtensionFilter\(routeRenderId\);/);
  assert.match(app, /renderRepoFilter\(routeRenderId\);/);
  assert.match(filters, /async function renderRepoFilter[\s\S]*?await deps\.initial\(null\)/);
  assert.match(app, /initial: repo => loadSidebarInitial\(repo\)/);
});
test("filter metadata rejects stale requests and uses static sidebar fallback", () => {
  assert.match(catalog, /const extensionApiCache = new Map\(\)/);
  assert.match(catalog, /const extensionApiPending = new Map\(\)/);
  assert.match(catalog, /if \(extensionApiPending\.has\(key\)\) return extensionApiPending\.get\(key\)/);
  assert.match(filters, /let extensionFilterRenderId = 0/);
  assert.match(filters, /if \(renderId !== extensionFilterRenderId\) return/);
  assert.match(filters, /if \(deps\.readView\(\)\.mode !== renderMode \|\| deps\.readView\(\)\.repo !== renderRepo \|\| deps\.readView\(\)\.repoFull !== renderRepoFull\) return/);
  const directory = fs.readFileSync("static/search/sidebar/application/directory.js", "utf8");
  assert.match(directory, /async function renderRepoList\(routeId\) \{[\s\S]*?var initial = await deps\.initial\(null\)/);
  assert.match(app, /function renderRepoList\(routeId\) \{\s*return getSidebarDirectory\(\)\.repos\(routeId\)/);
  assert.doesNotMatch(app, /if \(!currentExtNames\.length && STATE\.mode === "repo"\) currentExtNames = extensionList\.slice\(\)\.sort\(\)/);
});
test("background corpus loading uses idle scheduling independently of API prefetch", () => {
  const scheduler = app.match(/function scheduleBackgroundLocalDataLoad\(\) \{([\s\S]*?)\n\}/);
  assert.ok(scheduler);
  assert.doesNotMatch(scheduler[1], /searchPrefetchPromise/);
  assert.match(app, /function scheduleBackgroundLocalDataLoad/);
  assert.match(app, /requestIdleCallback/);
  assert.doesNotMatch(app, /mozConnection|webkitConnection/);

  function runScheduler(connection, useIdle = true) {
    const timers = new Map(), idle = new Map(), calls = [];
    let next = 0;
    const context = vm.createContext({
      navigator: { connection }, STATE: { dataLoaded: false },
      setTimeout: (fn, delay) => (timers.set(++next, { fn, delay }), next),
      clearTimeout: id => timers.delete(id),
      window: useIdle ? {
        requestIdleCallback: (fn, options) => (idle.set(++next, { fn, delay: options.timeout }), next),
        cancelIdleCallback: id => idle.delete(id),
      } : {},
      ensureLocalDataLoaded: (...args) => calls.push(args),
    });
    vm.runInContext(`let localDataLoadTimer = null, localDataIdleCallback = null;\n${scheduler[0]}`, context);
    context.scheduleBackgroundLocalDataLoad();
    return { context, timers, idle, calls, fire(queue, delay) {
      assert.strictEqual(queue.size, 1);
      const [id, task] = queue.entries().next().value;
      assert.strictEqual(task.delay, delay);
      queue.delete(id);
      task.fn();
    } };
  }
  for (const connection of [{ saveData: true, effectiveType: "4g" }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
    const f = runScheduler(connection);
    assert.strictEqual(f.timers.size + f.idle.size, 0);
    assert.deepStrictEqual(f.calls, []);
  }
  const normal = runScheduler(undefined);
  normal.fire(normal.timers, 100);
  normal.fire(normal.idle, 2500);
  assert.deepStrictEqual(normal.calls, [[false, true]]);
  const changed = runScheduler({ effectiveType: "4g" });
  changed.fire(changed.timers, 100);
  changed.context.navigator.connection.saveData = true;
  changed.fire(changed.idle, 2500);
  assert.deepStrictEqual(changed.calls, []);
  const canceled = runScheduler({ effectiveType: "4g" });
  canceled.fire(canceled.timers, 100);
  canceled.context.navigator.connection.effectiveType = "2g";
  canceled.context.scheduleBackgroundLocalDataLoad();
  assert.strictEqual(canceled.timers.size + canceled.idle.size, 0);
  const fallback = runScheduler({ effectiveType: "3g" }, false);
  fallback.fire(fallback.timers, 100);
  fallback.fire(fallback.timers, 1000);
  assert.deepStrictEqual(fallback.calls, [[false, true]]);
});
test("HTML preloads the default first-page payload before styles and application startup", () => {
  assert.match(html, /<link rel="preload" href="\/search\/data\/initial\/global\.json" as="fetch" crossorigin="anonymous">/);
  assert.ok(!html.includes('reader_assets.json.gz" as="fetch"'));
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
  assertCode(app, 'var warmedReaderSources = new Map()');
  assertCode(app, 'const READER_WARMUP_TTL = 5 * 60 * 1000');
  assertCode(app, 'const READER_WARMUP_MAX = 8');
  const warmup = app.match(/^function startReaderSourceWarmup\([^]*?^}/m)[0];
  // Bound successful entries, not the number of books warmed in this session.
  for (const snippet of [
    'if (now >= entry.expiresAt) warmedReaderSources.delete(sourceKey)',
    'const warmed = warmedReaderSources.get(key)',
    'if (readerId && warmed.metadataStored)',
    'consumed = !sessionStorage.getItem(`reader-resolve:${readerId}`)',
    'warmedReaderSources.delete(key); if (!consumed) { warmedReaderSources.set(key, warmed); return; }',
    'if (now < (readerWarmupRetryAt.get(key) || 0)) return',
    'if (readerWarmupPending !== task) return',
    'warmedReaderSources.set(key, { expiresAt: Date.now() + READER_WARMUP_TTL, metadataStored })',
    'while (warmedReaderSources.size > READER_WARMUP_MAX) { const oldest = warmedReaderSources.keys().next(); if (oldest.done) break; warmedReaderSources.delete(oldest.value); }',
    'if (readerWarmupPending !== task || controller.signal.aborted) return',
    'if (readerId) cacheReaderMetadata(readerId, data); finish(true)',
  ]) assertCode(warmup, snippet);
  assert.match(app, /method: readerId \? "GET" : "HEAD", cache: "no-store"/);
  assertCode(reader, 'return imageLoader.load(image, readerContentUrl(target), readerAbortController.signal, deadline)');
  assert.equal(reader.includes('return imageLoader.load(image, target, readerAbortController.signal, deadline)'), false);
  assert.match(reader, /disableStream: true/);
  assert.match(reader, /capability = readerRuntime\.negotiate\(VoiceOfMLReader\.capability\(extension\)\)/);
  assert.match(reader, /resolved\.extension[\s\S]*content\.dataset\.mode = capability\.mode/);
  const imageRule = readerCss.match(/\.reader-content\[data-mode="image-pages"\]\s+\.reader-page\s*>\s*img\s*\{([^}]+)\}/);
  assert.ok(imageRule, 'ordinary image-page sizing rule');
  assert.doesNotMatch(readerCss, /\.reader-content\[data-mode="pdf-pages"\]\s+\.reader-page\s*>\s*img\.ready/);
  assert.doesNotMatch(reader, /renderHybridPdfCanvas|renderPdfManifestShell/);
  for (const [property, value] of [['display', 'block'], ['width', '100%'], ['max-width', '100%'], ['height', 'auto']]) {
    assert.match(imageRule[1], new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*${value}\\s*(?:;|$)`));
  }
  assert.match(readerCss, /prefers-contrast\s*:\s*more/);
  assertCode(fs.readFileSync("static/reader/core/reader-store.js", "utf8"), 'Number(previous.lastReadAt) > Number(entry.lastReadAt)');
  assert.match(fs.readFileSync("static/reader/core/reader-store.js", "utf8"), /BroadcastChannel/);
  assert.match(reader, /VoiceOfMLReaderStore\.subscribe/);
  assert.match(reader, /VoiceOfMLReaderStore\.dispose/);
  assert.match(reader, /VoiceOfMLReaderSecurity\.readBytes/);
  const pdfText = fs.readFileSync("static/reader/pdf/reader-pdf-text.js", "utf8");
  assert.match(pdfText, /reader-pdf-text-block/);
  assert.match(pdfText, /reader-pdf-text-run/);
  assert.match(pdfText, /reader-pdf-text-fallback/);
  assert.match(pdfText, /writing_mode/);
  assert.match(reader, /populateOcrTextLayer\(layer, payload\.blocks, payload\.layout\)/);
  assert.match(reader, /const pdfOcrPagePromises = new Map\(\)/);
  assert.match(reader, /loadPdfOcrPage\(initialPage\)/);
  assert.match(pdfText, /normalizeBox/);
  assert.match(pdfText, /measureRunScale/);
  assert.match(pdfText, /--reader-pdf-run-scale-x/);
  assert.doesNotMatch(pdfText, /fontSize = `\$\{\(fontHeight \/ Math\.max\(1, pdfViewport\.height\)\) \* 100\}%`/);
  assert.match(readerCss, /container-type:\s*size/);
  assert.match(readerCss, /font-size:\s*calc\(var\(--reader-pdf-font-ratio/);
  assert.match(readerCss, /\.reader-pdf-text-run::selection/);
  assert.match(readerCss, /\.reader-pdf-text-fallback/);
  assert.match(readerCss, /\.reader-pdf-text-run\.full-search-highlight/);
  assert.ok(require('../../static/reader-resources.js').runtimePaths('/search/static/').includes('/search/static/reader/core/reader-security.js'));
  assert.match(fs.readFileSync("static/reader/core/reader-store.js", "utf8"), /function dispose\(\)/);
});
test("desktop random actions match their labels and empty-state behavior", () => {
  assert.match(html, /id="random-book-btn" class="random-txt-btn" title="随机下本书"/);
  assert.match(html, /id="random-txt-btn" class="random-book-btn" title="随机来本书"/);
  assert.match(app, /DOM\.randomBookBtn\.addEventListener\("click", randomBook\)/);
  assert.match(app, /DOM\.randomTxtBtn\.addEventListener\("click", randomTxt\)/);
  assert.match(app, /DOM\.emptyRandomBtn\.addEventListener\("click", randomTxt\)/);
  assert.match(randomDiscovery, /正在随机下载书籍/);
  assert.match(randomDiscovery, /正在随机打开书籍/);
  assert.doesNotMatch(html, /随机来一篇/);
  assert.doesNotMatch(app + randomDiscovery, /随机打开文章|暂无可读文章/);
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
test("search clear control follows the query state", () => {
  assert.match(app, /function syncSearchInputState\(\)/);
  assert.match(app, /DOM\.searchBox\?\.classList\.toggle\("has-query", hasQuery\)/);
  assert.match(css, /\.search-input::\-webkit-search-cancel-button \{ opacity: 0 !important; pointer-events: none !important;/);
  assert.match(css, /\.search-box\.has-query \.search-input::\-webkit-search-cancel-button \{ opacity: 1 !important; pointer-events: auto !important;/);
});
test("result actions use equal desktop heights and compact mobile column", () => {
  assert.doesNotMatch(resultRows, /class="result-summary"/);
  assert.match(resultRows, /class="result-title"[\s\S]*class="result-path"[\s\S]*class="result-meta"/);
  assert.match(app, /function buildResultHTML\(rec, idx\) \{ return getResultRows\(\)\.buildHTML\(rec, idx\); \}/);
  assert.match(css, /body:not\(\.mobile\) \.result-title \{ grid-column: 3; grid-row: 1;/);
  assert.match(css, /body:not\(\.mobile\) \.result-path \{ grid-column: 3 \/ 5; grid-row: 2;/);
  assert.match(css, /body:not\(\.mobile\) \.result-meta \{ grid-column: 3 \/ 5; grid-row: 3;/);
  assert.match(css, /\.result-action-btn \{\s*height: 24px;\s*display: inline-flex;/);
  assert.match(css, /body\.mobile \.result-actions \{\s*flex-direction: column;\s*gap: 1px;/);
  assert.match(css, /body\.mobile \.result-action-btn \{ height: 20px;/);
  assert.match(css, /body\.mobile \.result-path \{\s*display: block;\s*white-space: normal;\s*word-break: break-all;\s*overflow-wrap: normal;/);
  const { create } = vm.runInNewContext(`${resultRows}\nVoiceOfMLResultRows`);
  const rows = create({
    readView: () => ({ mode: "global", searchFolders: true, query: "outer" }),
    escapeHTML: String,
    highlightText: text => text === "outer" ? "<mark>outer</mark>" : text,
    getFileIconType: () => "file", icons: { file: "" }, formatSize: () => "",
    getRecordLink: () => "/book", getCopyableLink: link => link,
    getRecordPath: () => "book", getPreviewLink: () => "/preview",
    readerAction: () => ({ url: "" }),
  });
  const row = rows.buildHTML({ File: "book", Repo: "VoiceOfML/Repo", Folder: ["outer", "inner"] }, 0);
  const breadcrumb = row.match(/<div class="result-path">([\s\S]*?)<\/div>/)?.[1];
  const button = '<span role="button" tabindex="0" class="path-folder"';
  const slash = '<span class="path-sep">/</span>';
  assert.equal(breadcrumb,
    `${button} aria-label="筛选仓库路径：Repo" data-folder="" data-repo="Repo">Repo${slash}</span>` +
    `${button} aria-label="筛选路径：outer" data-folder="outer" data-repo="Repo"><mark>outer</mark>${slash}</span>` +
    `${button} aria-label="筛选路径：outer/inner" data-folder="outer/inner" data-repo="Repo">inner</span>`);
});
test("virtual results use bounded buffering", () => {
  const virtual = ["domain/heights.js", "presentation/rows.js", "application/controller.js"]
    .map(file => fs.readFileSync("static/search/results/virtual/" + file, "utf8")).join("\n");
  assert.match(app, /const VSCROLL = VoiceOfMLVirtualHeights\.createState\(\)/);
  assert.match(app, /VoiceOfMLVirtualResults\.create\(VSCROLL,/);
  assert.match(virtual, /const extraScreens = tightWindow \? 0 : Math\.min\(3/);
  assert.match(virtual, /const velocityOverscanPx = extraScreens \* viewH/);
  assert.match(app, /const visibleFirst = Math\.floor\(findVirtualIndex\(scrollTop\) \/ size\) \+ 1/);
  assert.match(app, /const direction = VSCROLL\.scrollDirection \|\| 1/);
  assert.match(app, /Demand the page under the viewport before the surrounding overscan/);
  assert.match(virtual, /VSCROLL\.renderStart <= safeStart && VSCROLL\.renderEnd >= safeEnd/);
  assert.match(virtual, /function ensureVirtualViewportCovered/);
  assert.match(virtual, /function ensureVirtualViewportCovered\(\)[\s\S]*?VSCROLL\.renderStart = -1;[\s\S]*?VSCROLL\.renderEnd = -1;/);
  assert.match(virtual, /function renderVisible\(\)/);
  assert.match(virtual, /const scrollingDown = scrollTop >= previousScrollTop/);
  assert.match(virtual, /const previousScrollTop = VSCROLL\.lastScrollTop/);
  const render = virtual.match(/^function renderVisible\([^]*?^}/m)[0];
  // Both early returns must allow segment recentering and pending scroll targets.
  for (const snippet of [
    'const segmentNeedsRecenter = getResultScrollOrigin(totalH, scrollTop, viewH) !== scroll.origin',
    'const needsLayout = segmentNeedsRecenter || scroll.target !== null',
    'if (!deps.pendingEntrance() && !needsLayout && VSCROLL.renderStart <= safeStart && VSCROLL.renderEnd >= safeEnd) return false',
    'if (start === VSCROLL.renderStart && end === VSCROLL.renderEnd && !needsLayout) return false',
  ]) assertCode(render, snippet);
  assert.match(virtual, /function refreshVirtualAfterAppend/);
  assert.match(virtual, /if \(updateView\) \{[\s\S]*?VSCROLL\.renderStart = -1;[\s\S]*?scheduleVirtualRender\(\);/);
  assert.match(virtual, /function reconcileVirtualRows/);
  assert.match(virtual, /virtual-spacer-bottom/);
  assert.match(virtual, /Number\(row\.dataset\.contentVersion\) !== VSCROLL\.contentVersion/);
  assert.match(app, /templates: VSCROLL\.templateCache/);
  assert.match(app, /function createResultRow\(rec, idx\) \{ return getResultRows\(\)\.createRow\(rec, idx\); \}/);
  assert.match(resultRows, /const cache = deps\.templates/);
  // tests/search/ui/result_interactions_contracts.mjs exercises the 240-entry LRU limit and eviction order.
  assert.match(app, /function scheduleVirtualRender/);
  assert.match(app, /scheduleVirtualRender\(\)/);
  assert.match(app, /scheduleVirtualRender\(true\)/);
  assert.match(virtual, /renderAfterScroll: false/);
  assert.doesNotMatch(app + virtual, /let scrollTicking = false/);
  assert.match(virtual, /const scrollTrackUpdated = renderVisible\(\);/);
  const scheduler = virtual.match(/^function scheduleVirtualRender\([^]*?^}/m)[0];
  assert.match(scheduler, /if \(afterScroll && !VSCROLL\.renderAfterScroll\) \{[\s\S]*?if \(!VSCROLL\.isDraggingThumb\) maybeLoadNextPage\(\);[\s\S]*?requestAnimationFrame/);
  assert.match(scheduler, /if \(VSCROLL\.renderAfterScroll\)[\s\S]*?if \(!scrollTrackUpdated\) \{[\s\S]*?if \(VSCROLL\.isDraggingThumb\) updateScrollThumb\(\);[\s\S]*?else updateScrollTrack\(\);/);
  assert.match(virtual, /updateScrollTrack\(\);[\s\S]*?return true;/);
  assert.match(virtual, /if \(updateView\) \{[\s\S]*?scheduleVirtualRender\(\);/);
  assert.match(app, /if \(!dragFrame\) dragFrame = requestAnimationFrame\(applyPendingScrollTop\)/);
  const applyDrag = app.match(/function applyPendingScrollTop\(\) \{[^]*?^  }/m)?.[0] || '';
  assert.match(applyDrag, /setResultScrollTop\([^;]+\);\s*pendingScrollTop = null;\s*renderVisible\(\);/);
  assert.match(virtual, /const tightWindow = VSCROLL\.isDraggingThumb \|\| !!VSCROLL\.dragMetrics/);
  assert.match(virtual, /tightWindow\s*\? viewH \* 0\.35/);
  assert.match(virtual, /if \(!VSCROLL\.isDraggingThumb && measureHeights\(start, end, anchor\)\)/);
  assert.match(app, /VSCROLL\.dragMetrics = null/);
  assert.match(css, /overflow-anchor: none/);
  assert.strictEqual(/function finishDrag\(\)[\s\S]*?measureHeights/.test(app), false);
  assert.match(app, /dragRange = Math\.max\(1, DOM\.scrollTrack\.clientHeight - DOM\.scrollThumb\.clientHeight\)/);
  const release = app.match(/function finishDrag\(\) \{[^]*?^  }/m)?.[0] || '';
  assert.match(release, /applyPendingScrollTop\(\);[\s\S]*?VSCROLL\.isDraggingThumb = false;[\s\S]*?setResultScrollTop\(finalScrollTop, true\);[\s\S]*?VSCROLL\.dragMetrics = null;/);
  assert.match(virtual, /if \(restoreWindow\) \{[^}]*VSCROLL\.scrollVelocity = 0;/);
  assert.match(virtual, /try \{ renderVisible\(\); \} finally \{ scroll\.target = null; \}/);
  // Release-frame movement and final anchoring are covered by the virtual
  // scroll browser regression; the pending coordinate need not be a raw px value.
  assert.strictEqual(/VSCROLL\.renderStart = -1;\s*VSCROLL\.renderEnd = -1;\s*renderVisible\(\);\s*if \(STATE\._deferredAppendWhileDragging\)/.test(app), false);
  assert.match(virtual, /VSCROLL\.measuredWindowKey === measureKey/);
  assert.match(virtual, /VSCROLL\.measuredRowKeys\[idx\] === rowMeasureKey/);
  assert.match(virtual, /const rowMeasureKey = getHeightMeasurementKey\(\)/);
  assert.match(css, /contain: paint/);
  assert.match(app, /function ensureHeightTree/);
  const heightIndex = fs.readFileSync("static/search/results/virtual/domain/height-index.js", "utf8");
  assert.match(heightIndex, /const parent = i \+ \(i & -i\)/);
  assert.match(virtual, /VoiceOfMLSearchHeightIndex\.extendTree\(VSCROLL, oldLen\)/);
  assert.match(virtual, /const canExtendTree = !VSCROLL\.heightsDirty/);
  assert.match(app, /querySelectorAll\("\.result-skeleton-item"\)\.forEach/);
});

test("Reader return and search snapshot state is preserved", () => {
  for (const value of [
    "SEARCH_VIEW_SNAPSHOT_VERSION",
    "const SEARCH_VIEW_SNAPSHOT_VERSION = VoiceOfMLSnapshotPolicy.VERSION",
    "const resultSnapshots = VoiceOfMLResultSnapshots.create(",
    "function getSearchViewKey",
    "function saveSearchViewSnapshot",
    "function restoreSearchViewSnapshot",
    "function captureReaderReturnScroll",
    "function restoreReaderReturnScroll",
    "readerReturnPosition.cancelOnScroll()",
  ]) assert.ok(app.includes(value), value);
  const virtualState = fs.readFileSync("static/search/results/virtual/domain/heights.js", "utf8");
  for (const value of ['viewKey: ""', 'heightCache: new Map()']) assert.ok(virtualState.includes(value), value);
  const policy = fs.readFileSync("static/search/results/snapshots/domain/copy-budget.js", "utf8");
  const snapshots = fs.readFileSync("static/search/results/snapshots/application/store.js", "utf8");
  assert.match(policy, /VERSION = 1, MAX = 20, BYTES_MAX = 8 \* 1024 \* 1024/);
  assert.match(snapshots, /snapshots\.size > policy\.MAX/);
  assert.match(snapshots, /bytes \+ snapshot\.bytes > policy\.BYTES_MAX/);
  assert.match(app, /return resultSnapshots\.save\(view, position,/);
  assertCode(app, 'STATE.results = /** @type {(PagesSearchRecord | null | undefined)[]} */ (resultSnapshots.restoreResults(snapshot, key, STATE.pageSize, restoreScroll, preserveRestore));');
  const host = fs.readFileSync("static/search/reader-host/application/host.js", "utf8");
  const position = fs.readFileSync("static/search/reader-host/presentation/return-position.js", "utf8");
  assertCode(host, "navigation.remember(url, /** @type {object} */ (position.scroll))");
  assert.ok(position.includes("if (saved.viewKey && saved.viewKey !== deps.getViewKey())"));
  assert.ok(position.includes("if (scroll && !active) { generation++; scroll = null; }"));
  assert.match(app, /searchWithInitialFallback\(\);/);
  assert.doesNotMatch(app, /if \(!restoreSearchViewSnapshot\(getSearchViewKey\(\)\)\) searchWithInitialFallback\(\);/);
});

test("warmup eviction and snapshot restoration source proofs reject regressions", () => {
  const eviction = 'while (warmedReaderSources.size > READER_WARMUP_MAX) { const oldest = warmedReaderSources.keys().next(); if (oldest.done) break; warmedReaderSources.delete(oldest.value); }';
  assert.throws(() => assertCode(eviction.replace('if (oldest.done) break;', ''), eviction));
  assert.throws(() => assertCode(eviction.replace('delete(oldest.value)', 'delete(key)'), eviction));
  const restore = 'STATE.results = /** @type {(PagesSearchRecord | null | undefined)[]} */ (resultSnapshots.restoreResults(snapshot, key, STATE.pageSize, restoreScroll, preserveRestore));';
  assert.throws(() => assertCode(restore.replace('STATE.results =', 'other.results ='), restore));
  assert.throws(() => assertCode(restore.replace('restoreScroll, preserveRestore', 'false, preserveRestore'), restore));
});

test("Worker retains tokenizer and fuzzy edit distance", () => {
  assert.match(worker, /importScripts\("\.\/worker\/domain\/text\.js"\)/);
  const text = fs.readFileSync("static/search/worker/domain/text.js", "utf8");
  assert.match(text, /function tokenize/);
  assert.match(worker, /function editDistance/);
});
test("Worker retains bounded wildcard matching", () => {
  assert.match(worker, /function compileWildcardMatcher/);
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
  const client = fs.readFileSync('static/search/corpus/application/client.js', 'utf8');
  assert.match(app, /getCorpusClient\(\)\.request\(type, payload, timeoutMs, signal\)/);
  assert.doesNotMatch(app, /corpusWorkerPending|corpusWorkerConsecutiveRestarts/);
  assert.match(client, /corpusWorkerPending/);
  assert.match(client, /addEventListener\("messageerror"/);
  assert.match(client, /const CORPUS_WORKER_MAX_CONSECUTIVE_RESTARTS = 1/);
  assert.match(client, /corpusWorkerConsecutiveRestarts >= CORPUS_WORKER_MAX_CONSECUTIVE_RESTARTS/);
  assert.match(client, /corpusWorkerConsecutiveRestarts\+\+/);
  assert.match(client, /corpusWorkerRestartCount\+\+/);
  assert.strictEqual((client.match(/corpusWorkerConsecutiveRestarts = 0;/g) || []).length, 3);
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
  const contract = fs.readFileSync("static/reader/core/reader-contract.js", "utf8");
  const reader = readReaderSource(require("path").resolve("."));
  const readerCss = fs.readFileSync("static/reader.css", "utf8");
  const readerHtml = fs.readFileSync("static/reader.html", "utf8");
  const readerStore = fs.readFileSync("static/reader/core/reader-store.js", "utf8");
  const searchController = fs.readFileSync("static/reader/search/reader-search-controller.mjs", "utf8");
  assertCode(reader, 'import { createReaderSearchController } from "./reader/search/reader-search-controller.mjs"');
  assert.strictEqual((searchController.match(/dataset\.panelView = "full-search"/g) || []).length, 1);
  assert.doesNotMatch(reader, /window\.find/);
  assert.match(searchController, /id="full-search-input"/);
  assert.match(searchController, /id="full-search-status"/);
  assert.match(searchController, /id="full-search-results"/);
  assert.match(searchController, /id="full-search-prev"/);
  assert.match(searchController, /id="full-search-next"/);
  assert.match(searchController, /snippetDom/);
  assert.match(searchController, /textContent = "全文搜索"/);
  assert.match(reader, /circle cx="12" cy="12"/);
  assert.match(reader, /async function activateChapter/);
  assert.match(reader, /progressUndo\.hidden = !previousProgressState/);
  assertCode(reader, 'result.activate(generation)');
  const contractContext = { self: {} };
  vm.runInNewContext(contract, contractContext);
  for (const [extension, mode] of Object.entries({ pdf: 'pdf', 'pdf-pages': 'pdf-pages', epub: 'foliate', mp3: 'audio', mp4: 'video', 'epub-chapters': 'epub-chapters' })) {
    assert.strictEqual(contractContext.self.VoiceOfMLReader.capability(extension).mode, mode, extension);
  }
  assert.strictEqual(contractContext.self.VoiceOfMLReader.capability('docx').mode, null);
  assert.match(app, /VoiceOfMLReader\.readerUrl/);
  assert.match(app, /VoiceOfMLReader\.readerUrl/);
  assert.doesNotMatch(app, /OcrUrl/);
  assert.match(randomDiscovery, /api\/random-reader/);
  assert.doesNotMatch(app, /TXT_BASE/);
  assertCode(reader, 'VoiceOfMLReaderResources.vendorUrl("pdf", "/search/static/")');
  assert.match(reader, /const PDFJS_WASM_URL = "\/search\/static\/vendor\/wasm\/"/);
  assert.match(reader, /wasmUrl: PDFJS_WASM_URL/);
  assert.match(reader, /\/search\/static\/foliate-reader\/view\.js/);
  for (const value of ["epubSearchIndex", "epubSearchIndexReady", "epubZipPath", "buildEpubSearchIndex", "activateIndexedEpubResult", "runIndexedEpubSearch"]) {
    assert.doesNotMatch(reader, new RegExp(value));
  }
  assertCode(reader, 'foliate: pair(loadMediaDocument, renderFoliate)');
  assert.match(reader, /async function renderFoliate/);
  assert.match(reader, /foliate-view/);
  assert.match(reader, /foliate-continuous/);
  assert.doesNotMatch(reader, /renderFoliateClean|foliate-reader\/reader\.html/);
  assertCode(reader, 'VoiceOfMLReaderResources.vendorUrl("purify", "/search/static/")');
  assert.doesNotMatch(reader, /cdn\.jsdelivr\.net/);
  assert.match(reader, /IntersectionObserver/);
  assert.match(reader, /Map\.prototype\.getOrInsertComputed/);
  assert.match(reader, /Math\.sumPrecise/);
  const workerWrapper = fs.readFileSync("static/reader/pdf/pdf-worker-wrapper.mjs", "utf8");
  assert.match(workerWrapper, /Map\.prototype\.getOrInsertComputed/);
  assert.match(workerWrapper, /Math\.sumPrecise/);
  assertCode(workerWrapper, 'import(VoiceOfMLReaderResources.vendorUrl("pdfWorker", "../../"))');
  assert.match(workerWrapper, /pendingMessages/);
  assert.match(reader, /document\.createElement\("canvas"\)/);
  assert.doesNotMatch(reader, /previewUrls/);
  assert.doesNotMatch(contract, /ReaderPreview/);
  assert.match(readerHtml, /\/search\/static\/reader\/core\/reader-contract\.js/);
  assert.match(readerHtml, /id="download"/);
  assert.match(readerHtml, /id="download"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.doesNotMatch(readerHtml, /id=["']ocr["']/i);
  assert.match(readerHtml, /id="download"[^>]*aria-label="下载原文件"/);
  assert.match(readerHtml, /role="tablist"/);
  assert.match(readerHtml, /aria-controls="toc-panel"/);
  assert.match(readerHtml, /role="tabpanel"/);
  assert.match(readerHtml, /https:\/\/hf-mirror\.com/);
  assert.doesNotMatch(reader, /validOcr/);
  assert.match(reader, /api\/download\?file=/);
  assert.match(reader, /api\/reader-content\?url=/);
  assert.match(reader, /const requestUrl = String\(url\) === sourceUrl \? contentUrl : url/);
  assert.match(reader, /new URL\(url, location\.href\)\.pathname\.split\("\/"\)\.pop\(\)/);
  assert.match(reader, /document\.createDocumentFragment\(\)/);
  assertCode(reader, 'limit = VoiceOfMLReaderSecurity.LIMITS.documentBytes');
  assertCode(reader, 'VoiceOfMLReaderSecurity.readBytes(response, limit)');
  assert.match(reader, /new TextDecoder\(detectTextEncoding\(bytes, documentState\.title\)\)/);
  assert.match(reader, /function detectTextEncoding/);
  assert.match(reader, /new TextDecoder\("utf-8", \{ fatal: true \}\)\.decode\(bytes, \{ stream: true \}\)/);
  assert.match(reader, /readPreparedBytes\(/);
  assert.match(reader, /cMapUrl: PDFJS_CMAP_URL/);
  assert.match(reader, /standardFontDataUrl: PDFJS_STANDARD_FONT_URL/);
  assert.match(readerHtml, /'wasm-unsafe-eval'/);
  assert.match(reader, /"gb18030", "big5", "windows-1251", "windows-1252"/);
  assertCode(reader, 'appendDecoded(decoder.decode(bytes), decoder.encoding)');
  assert.doesNotMatch(reader, /docx-preview|JSZip|renderDocx/);
  assert.match(app, /&& !rec\.ReaderLink\) return false/);
  assert.match(contract, /asset\?\.b && bucketName !== "vomebook\/pdf-pages-v2" && bucketName !== "vomebook\/reader-assets-v2"/);
  assert.doesNotMatch(reader, /extension === "docx"/);
  assert.match(reader, /function fetchReaderResponse\(\)/);
  assertCode(reader, 'const READER_PROXY_TIMEOUT_MS = 120000;');
  assertCode(reader, '}, READER_PROXY_TIMEOUT_MS)');
  assert.match(reader, /function fetchWithReaderTimeout/);
  assertCode(reader, 'retryReaderProxy(() => loadPdfTaskWithTimeout(pdfjs, options, proxy, takeInitial(proxy)))');
  assert.equal(reader.includes('return loadPdfTaskWithTimeout(pdfjs, options, target)'), false);
  assert.match(reader, /function loadPdfWithTimeout/);
  assertCode(reader, 'trackReaderResource(destroy)');
  assertCode(reader, 'Promise.resolve(task.destroy()).catch(() => {})');
  assert.match(app, /function warmReaderIntent/);
  assert.match(reader, /validatePdfPageManifest/);
  assert.doesNotMatch(readerCss, /docx-body|reader-docx-wrapper/);
  assert.match(reader, /pageState\.hidden = true/);
  assert.match(reader, /reader-spreadsheet-sheet/);
  assert.match(readerCss, /spreadsheet-html-frame/);
  assert.match(reader, /loadPdfOcrManifest\(\)\.then\(\s*(?:\/\*\*[\s\S]*?\*\/\s*)?\(manifest\)/);
  assert.match(reader, /manifest\?\.pages\?\.\[page - 1\]/);
  assert.match(reader, /reader-page-state/);
   assert.match(reader, /chapterManifestObserver/);
   assert.match(reader, /TOC_VIRTUALIZATION_THRESHOLD/);
   assert.match(reader, /renderVirtualToc/);
   assert.match(readerCss, /toc-list-virtualized/);
  assert.doesNotMatch(contract, /params\.set\("ocr"/);
  assert.match(contract, /params\.set\("download"/);
  assert.match(contract, /ReaderExtension/);
  assert.match(contract, /pdf-pages/);
  assert.doesNotMatch(reader, /Reader-Assets/);
  assertCode(reader, 'return renderImagePageWindow(manifest.page_count, book, manifest.toc)');
  assertCode(reader, 'if (Array.isArray(toc) && toc.length) setToc(toc.map');
  assert.match(reader, /tab\.hidden = !navigationState\.tocEntries\.length/);
  assert.match(reader, /PDF_MANIFEST_INVALID/);
   assert.match(contract, /page-manifest\.json/);
  assert.match(readerAssetTransport, /reader_assets\.json\.gz/);
  // The shared load must use the same bounded fetcher and explicitly pass
  // the first-paint decode policy; other Reader safety assertions remain.
  assert.match(readerAssetSnapshot, /state\.pending\s*=\s*transport\.fetchReaderAssetMap\(deferDecode === true\)\.then\(/);
  assert.match(readerAssetTransport, /if \(firstView\) await scheduling\.waitForReaderAssetFirstPaint\(controller\.signal, firstViewKey\)/);
  assert.match(readerAssetSnapshot, /if \(scheduling\.state\.parseWake\) scheduling\.state\.parseWake\(\)/);
  assert.match(readerAssetSnapshot, /state\.retryAt = Date\.now\(\) \+ 5000/);
  assert.doesNotMatch(readerAssetSnapshot, /state\.assets = \{\};\s*state\.converted = \[\];/);
  assert.doesNotMatch(app, /var currentRepo = STATE\.repoFull;\s*await loadReaderAssets\(\)/);
  assert.match(readerAssetSnapshot, /state\.converted = null/);
  assert.match(app, /applyReaderAsset/);
  assert.match(app, /function getReaderLink\(rec, returnUrl, cacheMetadata = true\)/);
  assert.match(app, /if \(cacheMetadata\) try/);
  assert.match(app, /url: record \? getReaderLink\(record, undefined, false\) : ""/);
  assert.match(resultRows, /const action = readerAction\(rec, recordLink\)/);
  assert.match(resultRows, /const readerActionUrl = action\.url/);
  const refresh = app.match(/^function refreshResultReaderActions\([^]*?^}/m)[0];
  // Remove only unavailable actions, retain focus, and avoid writes for unchanged metadata.
  for (const snippet of [
    'if (!action.record) { if (button) { const focused = document.activeElement === button; button.remove(); if (focused) row.focus({ preventScroll: true }); } continue; }',
    'if ((button ? button.textContent : "") !== action.label) invalidateHeight(index, record)',
    'if (!visible.has(index)) continue',
    'const url = getReaderLink(action.record, undefined, false)',
    'if (button.dataset.readerUrl !== url) button.dataset.readerUrl = url',
    'if (button.textContent !== action.label) button.textContent = action.label',
    "if (button.getAttribute('aria-label') !== ariaLabel) button.setAttribute('aria-label', ariaLabel)",
    'if (heightsInvalidated) measuredHeightRevision++',
    'if (layoutChanged) { VSCROLL.measuredWindowKey = ""; VSCROLL.renderStart = -1; VSCROLL.renderEnd = -1; scheduleVirtualRender(); }',
  ]) assertCode(refresh, snippet);

  assert.match(app, /applyReaderAsset\(rec, rec\.Repo \|\| "", buildRecordRelativePath\(rec\), recordLink\)/);
  assert.match(app, /isReadableRecord\(readerRecord\)/);
  assertCode(refresh, 'const action = readerActionForRefresh(record)');
  assert.match(app, /freshReaderLink: record => getReaderLink\(applyReaderAsset\(/);
  assert.match(app, /recordForRow: row => resultRowRecords\.get\(row\)/);
  assert.match(resultInteractions, /const record = deps\.recordForRow\(actionBtn\.closest\("\.result-item"\)\)/);
  // tests/search/ui/result_interactions_contracts.mjs clicks the result and verifies that it refreshes and opens the current Reader link.
  assert.match(resultInteractions, /const readerLink = browserItem\.dataset\.readerUrl/);
  assert.match(resultInteractions, /deps\.navigateToReader\(readerLink\)/);
  const navigation = fs.readFileSync('static/search/reader-host/application/navigation.js', 'utf8');
  assert.match(navigation, /url\.searchParams\.set\("return", returnUrl\)/);
  assert.match(navigation, /sessionStorage\.setItem\("reader-return:" \+ token/);
  assert.match(navigation, /crypto\.getRandomValues\(new Uint32Array\(4\)\)/);
  assert.match(html, /search\/reader-host\/application\/navigation\.js/);
  assert.match(sw, /search\/reader-host\/application\/navigation\.js/);
  assert.doesNotMatch(app, /openPendingWindow/);
  assert.match(reader, /new URL\(returnUrl, location\.origin\)/);
  assert.match(reader, /sessionStorage\.removeItem\(returnHistoryKey\)/);
  assert.match(reader, /canReturnWithHistory = !!returnHistoryKey && storedReturnUrl === target\.href/);
  // No guard entry is pushed, so a verified return is one history step.
  assert.match(reader, /canReturnWithHistory && history\.length > 1\) history\.back\(\)/);
  assert.match(reader, /returnNeedsReload[\s\S]*location\.replace\(target\.href\)/);
  assert.doesNotMatch(reader, /history\.go\(-2\)|voiceReaderGuard|voice-reader-system-back/);
  assert.match(reader, /location\.assign\("\/search\/"\)/);
  assert.match(randomDiscovery, /id === deps\.requests\.id && location\.href === returnUrl/);
  assert.match(app, /get id\(\) \{ return randomReaderRequestId; \}/);
  assert.match(app, /fetchRandomReaderRecord: \(url, id, returnUrl\) => fetchRandomReaderRecord\(url, id, returnUrl\)/);
  assert.match(app, /rec\.ReaderExtension \|\| rec\.Extension/);
  assert.match(readerAssetSnapshot, /async function getConvertedReaderRecords\(repo\)/);
  assert.match(randomDiscovery, /await deps\.getConvertedReaderRecords\(deps\.readView\(\)\.repoFull \|\| ""\)\)\.length/);
  assert.match(randomDiscovery, /useConverted \? converted\[Math\.floor\(Math\.random\(\) \* converted\.length\)\] : await deps\.getRandomLocal\(true\)/);
  const randomReaderBlock = randomDiscovery.slice(randomDiscovery.indexOf("async function randomTxt"));
  assert.match(randomReaderBlock, /if \(!originalCount && !deps\.assetsLoaded\(\)\) await deps\.loadReaderAssets\(\);\s*else deps\.loadReaderAssets\(\);/);
  assert.doesNotMatch(randomReaderBlock, /try \{\s*await deps\.loadReaderAssets\(\)/);
  assert.match(app, /const scheduleReaderAssetsLoad = function\(\) \{[\s\S]*?pointerdown/);
  assert.match(app, /setTimeout\(load, 6000\)/);
  assert.match(readerHtml, /id="page-number"/);
  assert.match(reader, /document\.querySelector\("\.page-controls"\)\)\.hidden = !capability\.features\.pagination/);
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
  assert.match(readerStore, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(readerStore, /DB_VERSION = 3/);
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
  assert.match(readerHtml, /id="bookmark-ribbon"/);
  assert.match(readerHtml, /id="toc-tab"/);
  assert.match(readerHtml, /id="history-clear"/);
  assert.match(readerHtml, /id="theme-toggle"/);
  assert.match(readerCss, /\.reader-panel-tabs/);
  assert.match(reader, /function syncCurrentPageFromMarker/);
  assert.match(fs.readFileSync("static/search/reader-host/application/host.js", "utf8"), /message\.type === "voice-reader-open"/);
  assert.match(app, /readerHost\.handleReaderMessage\(event\)/);
  assert.doesNotMatch(readerCss, /docx-body|reader-docx/);
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
  assert.match(readerHtml, /connect-src[^\"]*https:\/\/\*\.hf\.co/);
  assert.match(readerHtml, /script-src 'self'/);
  const vendorScript = fs.readFileSync("scripts/build/copy_reader_vendor.mjs", "utf8") + fs.readFileSync("static/reader-resources.js", "utf8");
  assert.match(vendorScript, /pdfjs-dist@6\.5\.438/);
  assert.match(vendorScript, /pdfGroups = new Set\(\["cmaps", "standard_fonts", "wasm"\]\)/);
  assert.match(vendorScript, /7461aefcd27c4ef0dd76f9ca5760f09466eb6b3f934432670c12132e7b3d6faa/);
  assert.match(vendorScript, /3a88402882cfa3e7e72c2c9b5149f52f0f88baf1c5b62aa11a41abdbc2072440/);
  assert.match(vendorScript, /marked@18\.2\.1\/lib\/marked\.umd\.js/);
  assert.match(vendorScript, /bb95d4c15f1289f78486eaacebf3bb18688475ed58a040ef762ed49337090542/);
  assert.match(vendorScript, /dompurify@3\.4\.18/);
  assert.match(vendorScript, /8053ee2a6a09f9d50f7fcd6fb7f07072f52c7f3fa9aa12147cab4feaf65ee970/);
  assert.match(vendorScript, /@zip\.js\/zip\.js@2\.25\.0\/index\.min\.js/);
  assert.match(vendorScript, /715a4067bb71d750d4af8e60390e48894072f65501e0442e53f252cbfc45cfbc/);
  assert.doesNotMatch(vendorScript, /writeFileSync\(join\(output, target\)\)/);
  for (const path of ["pdf.min.mjs", "pdf.worker.min.mjs", "marked.min.js", "purify.min.js"]) assert.ok(!sw.includes("static/vendor/" + path));
  assert.match(sw, /url\.pathname === "\/search\/static\/reader\.html"/);
  assert.match(sw, /READER_RUNTIME_PATHS\.has\(url\.pathname\)/);
  assertCode(sw, 'VoiceOfMLReaderResources.runtimePaths("/search/static/")');
  assert.match(sw, /readerShell = url\.pathname === "\/search\/static\/reader\.html"/);
  assert.match(sw, /networkFirst = !readerShell &&/);
  assert.match(sw, /cacheKey = readerShell \? "\/search\/static\/reader\.html" : searchNavigation \? "\/search\/" : event\.request/);
  assert.match(sw, /fetch\(revalidatedRequest\(event\.request\)\)[\s\S]*cache\.put\(cacheKey/);
});
test("mobile shell hides sidebars before application startup", () => {
  assert.match(html, /document\.documentElement\.classList\.add\("mobile-boot"\)/);
  assert.match(css, /html\.mobile-boot \.left-sidebar/);
  assert.match(shellView, /document\.documentElement\.classList\.remove\("mobile-boot"\)/);
  assert.match(app, /function applyMobileMode\(\) \{ getShell\(\)\.applyMobileMode\(\); \}/);
  assert.match(app, /view: VoiceOfMLShellView\.create\(/);
  const shellController = fs.readFileSync("static/search/shell/application/controller.js", "utf8");
  assert.match(shellController, /updateSidebarVisibility\(\);\s*view\.finishMobileMode\(\);\s*deps\.updateSidebarHeader\(\);\s*deps\.updateSelectionUI\(\);\s*deps\.scheduleScrollTrack\(\);/);
});
test("Service Worker cache name combines site namespace and build version", () => {
  assertCode(sw, 'const CACHE_PREFIX = "vomebook-search-"');
  assertCode(sw, 'const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION');
});
test("Service Worker precaches the search Worker", () => {
  assert.match(sw, /search\/static\/search\/index-worker\.js/);
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
test("manual search promotion has an exact, validated operation identity", () => {
  assert.match(workflow, /run-name:.*search-transition\/\{0\}.*inputs\.search_transition/);
  assert.match(workflow, /search_transition:\s*\n\s*description:.*\n\s*required: false\s*\n\s*type: string/);
  assert.match(workflow, /SEARCH_TRANSITION: \$\{\{ inputs\.search_transition \}\}/);
  assert.match(workflow, /SEARCH_INPUT_GENERATION: \$\{\{ inputs\.search_generation \}\}/);
  assert.ok(workflow.includes('[[ "$SEARCH_TRANSITION" =~ ^[0-9a-f]{32}$ ]]'));
  assert.ok(workflow.includes('[[ "$SEARCH_INPUT_GENERATION" =~ ^[0-9a-f]{64}$ ]]'));
  assert.ok(workflow.includes('[[ "$SEARCH_GENERATION" == "$SEARCH_INPUT_GENERATION" ]]'));
  assert.match(workflow, /group: "pages"\s*\n\s*cancel-in-progress: false/);
});
test("deployment workflow grants required Pages permissions", () => {
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
});
test("Pages waits for the exact uploaded artifact before attempting deployment", () => {
  const upload = workflow.indexOf('name: Upload artifact');
  const wait = workflow.indexOf('name: Wait for the uploaded Pages artifact');
  const deploy = workflow.indexOf('name: Deploy to GitHub Pages');
  assert.ok(0 < upload && upload < wait && wait < deploy);
  assert.match(workflow.slice(upload, wait), /id: upload/);
  assert.match(workflow.slice(wait, deploy), /UPLOADED_ARTIFACT_ID: \$\{\{ steps\.upload\.outputs\.artifact_id \}\}/);
  assert.match(workflow.slice(wait, deploy), /run: python3 -B scripts\/ci\/wait_pages_artifact\.py/);
  assert.match(workflow, /^permissions:\n  contents: read\n  actions: read\n  pages: write$/m);
});
test("deployment workflow uses official checkout configure upload and deploy actions", () => {
  const actions = Array.from(workflow.matchAll(/uses: ([^\s]+)/g), (match) => match[1]);
  assert.deepStrictEqual(actions, [
    "actions/checkout@v7",
    "actions/setup-node@v7",
    "actions/setup-python@v7",
    "actions/checkout@v7",
    "actions/setup-node@v7",
    "actions/setup-python@v7",
    "actions/cache@v6",
    "actions/cache@v6",
    "actions/configure-pages@v6",
    "actions/upload-pages-artifact@v5",
    "actions/deploy-pages@v5",
  ]);
});
test("Pages jobs pin the Ubuntu release and configure mirrors before apt", () => {
  const source = workflow.slice(workflow.indexOf("\n  source-checks:"), workflow.indexOf("\n  deploy:"));
  const deploy = workflow.slice(workflow.indexOf("\n  deploy:"));
  assert.match(source, /runs-on: ubuntu-24\.04/);
  assert.match(source, /^\s*run: bash scripts\/ci\/check_pages_source\.sh$/m);
  assert.match(fs.readFileSync('scripts/ci/check_pages_source.sh', 'utf8'), /tests\.gates\.test_ci_ubuntu_mirror/);
  assert.match(deploy, /runs-on: ubuntu-24\.04/);
  assert.match(deploy, /python3 -B scripts\/ci\/ci_ubuntu_mirror\.py[\s\S]*sudo apt-get update[\s\S]*playwright install-deps chromium/);
});
test("deployment workflow builds and uploads minified static artifacts", () => {
  const source = workflow.slice(workflow.indexOf('\n  source-checks:'), workflow.indexOf('\n  deploy:'));
  const sourceGates = fs.readFileSync('scripts/ci/check_pages_source.sh', 'utf8');
  assert.match(source, /^\s*run: bash scripts\/ci\/check_pages_source\.sh$/m);
  assert.match(sourceGates, /^set -euo pipefail$/m);
  assert.match(sourceGates, /^npm run check:static$[\s\S]*^python -B scripts\/check_python_static\.py$/m);
  assert.match(sourceGates, /python -B -m unittest -v tests\.gates\.test_static_shards_runner[\s\S]*python -B scripts\/ci\/run_static_gate_shards\.py --project github[\s\S]*python -B -m unittest -v tests\.gates\.test_ci_ubuntu_mirror/);
  assert.match(workflow, /deploy:\s*\n\s*needs: source-checks/);
  const deployJob = workflow.slice(workflow.indexOf("\n  deploy:\n"));
  assert.deepStrictEqual(Array.from(deployJob.matchAll(/node (tests\/\S+)/g), match => match[1]), [
    "tests/search/data/test_data_integrity.js", "tests/search/data/test_corpus_oracle.js",
  ]);
  assert.match(deployJob, /fetch_reader_assets\.mjs _site\/data\/reader_assets\.json\.gz\s+SEARCH_TEST_DATA_DIR=_site\/data node tests\/search\/data\/test_data_integrity\.js\s+SEARCH_TEST_DATA_DIR=_site\/data node tests\/search\/data\/test_corpus_oracle\.js/);
  assert.ok(deployJob.indexOf("node tests/search/data/test_corpus_oracle.js") < deployJob.indexOf("uses: actions/upload-pages-artifact"));
  assert.match(sourceGates, /^node tests\/reader\/pdf-v3\/test_dataset_primary_policy\.mjs$/m);
  assert.match(workflow, /node-version: '26\.13\.1'/);
  assert.match(deployJob, /uses: actions\/setup-python@v7\s*\n\s*with:\s*\n\s*python-version: '3\.15\.2'/);
  assert.ok(deployJob.indexOf("uses: actions/setup-python@v7") < deployJob.indexOf("python3 scripts/build/seo.py"));
  assert.match(workflow, /name: Validate source JavaScript syntax[\s\S]*node --check static\/reader\/pdf\/reader-pdf-text\.js/);
  assert.match(workflow, /node scripts\/build\/compose_app\.mjs/);
  assert.match(workflow, /esbuild@0\.28\.2 "\$RUNNER_TEMP\/app-composed\.js" --minify --target=es2020/);
  assert.ok(workflow.includes('bundleArguments(process.argv[1])'));
  assert.ok(workflow.includes('esbuild@0.28.2 "static/$file" $flags --minify'));
  assert.match(workflow, /node scripts\/data\/fetch_reader_assets\.mjs _site\/data\/reader_assets\.json\.gz/);
  assert.match(workflow, /node scripts\/data\/fetch_search_generation\.mjs "\$SEARCH_GENERATION" pages _site\/data/);
  assert.match(workflow, /SEARCH_GENERATION: \$\{\{ inputs\.search_generation \|\| vars\.SEARCH_DATA_GENERATION \}\}/);
  assert.ok(workflow.includes('SEARCH_GENERATION="${SEARCH_GENERATION:-$(node -p \'require("./config/search-data.json").generation\')}"'));
  const baseline = JSON.parse(fs.readFileSync("config/search-data.json", "utf8"));
  assert.match(baseline.generation, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(workflow, /cp -a data _site\//);
  assert.match(workflow, /python3 scripts\/build\/seo\.py --project pages --corpus _site\/data\/search_data\.json\.gz --output _site/);
  assert.match(workflow, /node scripts\/build\/fetch_foliate_reader\.mjs _site\/static\/foliate-reader/);
  assert.match(workflow, /node scripts\/build\/copy_reader_vendor\.mjs _site\/static\/vendor/);
  assert.match(workflow, /cp -a static\/vendor\/djvu-rs-reader _site\/static\/vendor\//);
  assert.match(workflow, /--foliate-output _site\/static\/foliate-reader\/vendor/);
  assert.doesNotMatch(workflow, /cp -a static\/foliate-reader/);
  assert.ok(workflow.includes('.buildFiles("github")'));
  assert.match(workflow, /esbuild@0\.28\.2 static\/sw\.js --minify/);
  assert.match(workflow, /uses: actions\/upload-pages-artifact@v5\s*\n\s*with:\s*[\s\S]*?path: '_site'/);
});
test("Pages test jobs materialize pinned data before consumers and preserve independent Reader downloads", () => {
  const readerWorkflow = fs.readFileSync(".github/workflows/reader-refactor.yml", "utf8");
  for (const [job, next] of [["github-search", "firefox-staged-pdf"], ["firefox-staged-pdf", "huggingface-search"]]) {
    const source = readerWorkflow.slice(readerWorkflow.indexOf(`\n  ${job}:`), readerWorkflow.indexOf(`\n  ${next}:`));
    assert.match(source, /run: npm run data:prepare/);
    assert.ok(source.indexOf("run: npm run data:prepare") < source.indexOf(job === "github-search" ? "name: Check source" : "name: Check staged PDF"));
  }
  const push = readerWorkflow.split('  push:\n')[1].split(/\n[^ \n]/, 1)[0];
  assert.match(push, /^    branches: \["main"\]$/m);
  // No path filter: even metadata-only and arbitrary production changes trigger.
  assert.doesNotMatch(push, /^    paths(?:-ignore)?:/m);
  assert.match(readerWorkflow, /node --test tests\/search\/data\/test_search_generation_fetch\.mjs/);
  assert.equal(JSON.parse(fs.readFileSync("package.json", "utf8")).scripts["data:prepare"], "node scripts/data/prepare_test_data.mjs");
  assert.match(fs.readFileSync(".gitignore", "utf8"), /^\/data\/$/m);
});
test("Pages cross-site cache gates receive the reviewed HF worker before any static or browser tests", () => {
  const readerWorkflow = fs.readFileSync(".github/workflows/reader-refactor.yml", "utf8");
  const pages = readerWorkflow.split("\n  github-search:\n")[1].split("\n  firefox-staged-pdf:\n")[0];
  const fetchStep = pages.split("      - name: Fetch reviewed HF worker for cross-site cache tests\n")[1].split("      - name:")[0];
  assert.match(pages, /env:\s*\n\s*READER_TEST_TIMEOUT_MS: "15000"/);
  assert.ok(fetchStep.includes('HF_SW_SOURCE="$RUNNER_TEMP/hf-service-worker/sw.js"'));
  assert.ok(fetchStep.includes('printf \'HF_SW_SOURCE=%s\\n\' "$HF_SW_SOURCE" >> "$GITHUB_ENV"'));
  assert.doesNotMatch(pages.split("    steps:")[0], /runner\.temp/);
  assert.match(fetchStep, /set -euo pipefail/);
  assert.ok(fetchStep.includes('json.load(open(".github/hf-source-revision.json"))["revision"]'));
  assert.ok(fetchStep.indexOf('scripts/verify_hf_source_revision.py "$revision"') < fetchStep.indexOf('curl --fail'));
  assert.match(fetchStep, /python3 -I -B scripts\/verify_hf_source_revision\.py "\$revision"/);
  assert.match(fetchStep, /curl --fail --location --silent --show-error --max-time 60/);
  assert.ok(fetchStep.includes('https://huggingface.co/spaces/VoiceOfML/Search/resolve/$revision/static/sw.js'));
  assert.ok(fetchStep.includes('--output "$HF_SW_SOURCE"'));
  assert.ok(fetchStep.includes('test -s "$HF_SW_SOURCE"'));
  assert.doesNotMatch(fetchStep, /continue-on-error:|\bif:|\|\| true|resolve\/main/);
  assert.ok(pages.indexOf("name: Fetch reviewed HF worker") < pages.indexOf("name: Check source and exercise static gates"));
  assert.match(pages, /node tests\/service_worker\/test_service_worker\.js/);
  const hf = readerWorkflow.split("\n  huggingface-search:\n")[1];
  assert.match(hf, /node tests\/service_worker\/test_service_worker\.js\s+node tests\/service_worker\/test_service_worker_pruning\.js/);
  const suite = fs.readFileSync("tests/service_worker/test_service_worker.js", "utf8");
  assertCode(suite, 'const hfSource = fs.readFileSync(process.env.HF_SW_SOURCE ?? "../hf-search/static/sw.js", "utf8")');
  assertCode(suite, "['HF', hfSource, '/static/']");
  assertCode(suite, "[hfSource, '/static/', cacheName(hfSource)]");
  assert.equal((suite.match(/\.\.\/hf-search\/static\/sw\.js/g) || []).length, 1);
  assert.doesNotMatch(suite, /existsSync|test\.skip/);
});
test("PDF release gate requires all named artifact tests unless exact full-code proof is reused", () => {
  const deploy = workflow.slice(workflow.indexOf("\n  deploy:\n"));
  for (const [name, timeout] of [
    ["Install PDF Python dependencies", 10], ["Install qpdf system dependency", 10],
    ["Install Playwright Chromium system libraries", 15], ["Install Playwright Chromium browser", 15],
    ["Check content-addressed PDF opening", 30],
  ]) assert.ok(deploy.includes(`- name: ${name}\n        if: needs.source-checks.outputs.reuse != 'true'\n        timeout-minutes: ${timeout}`), name);
  assert.match(deploy, /key: \$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ steps\.pdf-distro\.outputs\.version \}\}-playwright-1\.65\.2-chromium/);
  assert.match(deploy, /python3 -m pip install playwright==1\.65\.2 pypdf==7\.1\.1/);
  assert.match(deploy, /python3 -m playwright install-deps chromium/);
  assert.match(deploy, /python3 -m playwright install chromium/);
  const pdfChecks = [
    'test_first_page_reused_and_wrong_count_corrected',
    'test_nested_tree_first_page_does_not_wait_for_other_pages',
    'test_incremental_linearized_preview_uses_current_first_page',
    'test_understated_page_count_is_rebuilt_before_navigation',
    'test_sequential_second_page_before_full_validation',
    'test_scroll_to_second_page_before_full_validation',
    'test_unknown_or_missing_child_never_commits_count',
    'test_full_text_search_waits_for_verified_count',
    'test_progress_panel_cannot_add_bookmark_during_validation',
  ].map(name => `tests.reader.browser.test_reader_pdf_first_page.PdfFirstPageTests.${name}`);
  assert.match(deploy, /READER_BUILT_SITE="\$GITHUB_WORKSPACE\/_site" READER_BUILT_PROJECT=github python3 -B scripts\/ci\/run_unittest_suite\.py/);
  assert.deepStrictEqual(deploy.match(/tests\.reader\.browser\.test_reader_pdf_first_page\.PdfFirstPageTests\.test_\w+/g), pdfChecks);
  assert.ok(deploy.indexOf('name: Check content-addressed PDF opening') < deploy.indexOf('uses: actions/upload-pages-artifact@v5'));
  assert.doesNotMatch(workflow, /continue-on-error:/);
  const conditions = workflow.match(/^\s*if: .+$/gm).map(line => line.trim());
  assert.equal(conditions.filter(line => line === "if: steps.code-proof.outputs.reuse != 'true'").length, 4);
  assert.equal(conditions.filter(line => line === "if: needs.source-checks.outputs.reuse != 'true'").length, 9);
  assert.deepStrictEqual(conditions.filter(line => !line.includes('outputs.reuse')), [
    "if: github.event_name == 'workflow_dispatch' && inputs.search_transition != '' && inputs.search_generation != ''",
  ]);
  assert.match(workflow, /id: code-proof[\s\S]*?run: python3 -B scripts\/ci\/reuse_pages_code_checks\.py/);
  assert.match(workflow, /\n  deploy:\n    needs: source-checks/);
  assert.match(workflow, /cache: npm/);
  assert.match(workflow, /cache-dependency-path: config\/dependencies\/static-check\.txt/);
  assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.doesNotMatch(workflow, /path:.*node_modules/);
});
test("deployment workflow exposes deployment URL through github-pages environment", () => {
  assert.match(workflow, /environment:\s*\n\s*name: github-pages\s*\n\s*url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  assert.match(workflow, /id: deployment/);
});

run("static contracts");

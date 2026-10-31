import { createReaderDomSearch, fullSearchEscape, fullSearchSnippet, fullSearchPageOffset } from "./reader/search/reader-dom-search.mjs";
import { createReaderSearchController } from "./reader/search/reader-search-controller.mjs";
import { createReaderImageLoader } from "./reader/formats/reader-image-loader.mjs";
import "/search/static/reader-resources.js";
import "/search/static/reader/core/reader-contract.js";
import "/search/static/reader/core/reader-request-manager.js";
import "/search/static/reader/formats/reader-chapter-repository.js";
import "/search/static/reader/ui/reader-scroll-anchor.js";
import "/search/static/reader/formats/reader-section-virtualizer.js";
import "/search/static/reader/core/reader-runtime.js";
import "/search/static/reader/formats/reader-format-adapters.js";
import "/search/static/reader/core/reader-security.js";
import { paintTextHit, hitBoxes } from "/search/static/reader/search/reader-book-text.js";
import { createPdfFetchPolicy, openPdfRangeTask, preparePdfInitialRange, isFirstPageCandidate } from "./reader/pdf/reader-pdf-network.mjs";
import { createV3Repository, validateResource, validateReadingManifest, validatePageMap, datasetPrimaryUrl } from "./reader/pdf/reader-v3.mjs";
import { populateIndependentTextLayer, independentTextCaret } from "./reader/pdf/reader-pdf-text.js";
let pdfFetchPolicy = null;
import { populatePdfTextLayer, populateOcrTextLayer, pdfTextContent, pdfSearchText, normalizePdfSearchText, pdfSourceOffset } from "/search/static/reader/pdf/reader-pdf-text.js";
import {
  EPUB_HTML_TAGS,
  EPUB_HTML_VOID_TAGS,
  HTML_FRAME_STYLE,
  DISCOURSE_POST_SELECTOR,
  DISCOURSE_TITLE_SELECTOR,
  DISCOURSE_HTML_STYLE,
  SPREADSHEET_HTML_STYLE,
  createReaderBindings,
  createReaderDiagnostics,
  createReaderLifecycle,
  createReaderSource,
  createReaderUi,
  createReaderToc,
  createReaderSearchBackends,
  createReaderPdfScheduler,
  createReaderNavigation,
  createReaderFoliateFormat,
  createReaderProgress,
  createReaderBookmarks,
  createReaderMediaFormat,
  createReaderDocumentLoader,
  createReaderPdfPageWindow,
  createReaderPdfTextRuntime,
  createReaderHtmlFormat,
  createReaderPdfRenderer,
  createReaderTextFormat,
  createReaderChapterFormat,
  createReaderFormatController,
  createReaderPdfEngine,
  createReaderPdfSearch,
  createReaderSpeech
} from "./reader/reader-components.mjs";

const readerContext = {
  get openPdfRangeTask() { return openPdfRangeTask; },
  get preparePdfInitialRange() { return preparePdfInitialRange; },
  get isFirstPageCandidate() { return isFirstPageCandidate; },
  get DISCOURSE_HTML_STYLE() { return DISCOURSE_HTML_STYLE; },
  get DISCOURSE_POST_SELECTOR() { return DISCOURSE_POST_SELECTOR; },
  get DISCOURSE_TITLE_SELECTOR() { return DISCOURSE_TITLE_SELECTOR; },
  get EPUB_HTML_TAGS() { return EPUB_HTML_TAGS; },
  get EPUB_HTML_VOID_TAGS() { return EPUB_HTML_VOID_TAGS; },
  get FOLIATE_LOADED_SECTION_LIMIT() { return FOLIATE_LOADED_SECTION_LIMIT; },
  get FOLIATE_PREFETCH_MARGIN() { return FOLIATE_PREFETCH_MARGIN; },
  get HTML_FRAME_STYLE() { return HTML_FRAME_STYLE; },
  get MARKED_URL() { return MARKED_URL; },
  get PDFJS_CMAP_URL() { return PDFJS_CMAP_URL; },
  get PDFJS_STANDARD_FONT_URL() { return PDFJS_STANDARD_FONT_URL; },
  get PDFJS_URL() { return PDFJS_URL; },
  get PDFJS_WASM_URL() { return PDFJS_WASM_URL; },
  get PDFJS_WORKER_URL() { return PDFJS_WORKER_URL; },
  get PDF_BOOK_SEARCH_PREFETCH_DELAY() { return PDF_BOOK_SEARCH_PREFETCH_DELAY; },
  get PDF_BOOK_SEARCH_PREFETCH_MAX_BYTES() { return PDF_BOOK_SEARCH_PREFETCH_MAX_BYTES; },
  get PDF_MANIFEST_PREFETCH_CONCURRENCY() { return PDF_MANIFEST_PREFETCH_CONCURRENCY; },
  get PDF_MANIFEST_PREFETCH_LIMIT() { return PDF_MANIFEST_PREFETCH_LIMIT; },
  get PDF_MANIFEST_PREFETCH_MAX_PAGES() { return PDF_MANIFEST_PREFETCH_MAX_PAGES; },
  get PDF_HYBRID_DOCUMENT_GRACE_MS() { return PDF_HYBRID_DOCUMENT_GRACE_MS; },
  get PDF_OCR_PAGE_CACHE_BYTES() { return PDF_OCR_PAGE_CACHE_BYTES; },
  get PDF_PREFETCH_MARGIN() { return PDF_PREFETCH_MARGIN; },
  get PDF_SEARCH_TEXT_CACHE_BYTES() { return PDF_SEARCH_TEXT_CACHE_BYTES; },
  get PDF_TEXT_CONTENT_CACHE_BYTES() { return PDF_TEXT_CONTENT_CACHE_BYTES; },
  get PURIFY_URL() { return PURIFY_URL; },
  get READER_PROXY_TIMEOUT_MS() { return READER_PROXY_TIMEOUT_MS; },
  get RUFFLE_URL() { return RUFFLE_URL; },
  get SPREADSHEET_HTML_STYLE() { return SPREADSHEET_HTML_STYLE; },
  get THEME_MOON_ICON() { return THEME_MOON_ICON; },
  get THEME_SUN_ICON() { return THEME_SUN_ICON; },
  get TOC_VIRTUALIZATION_THRESHOLD() { return TOC_VIRTUALIZATION_THRESHOLD; },
  get TOC_VIRTUAL_ROW_HEIGHT() { return TOC_VIRTUAL_ROW_HEIGHT; },
  get acquirePdfPreviewSlot() { return acquirePdfPreviewSlot; }, set acquirePdfPreviewSlot(value) { acquirePdfPreviewSlot = value; },
  get releasePdfPreviewSlot() { return releasePdfPreviewSlot; }, set releasePdfPreviewSlot(value) { releasePdfPreviewSlot = value; },
  get pdfPreviewLoads() { return pdfPreviewLoads; }, set pdfPreviewLoads(value) { pdfPreviewLoads = value; },
  get resetPdfLatencySamples() { return resetPdfLatencySamples; }, set resetPdfLatencySamples(value) { resetPdfLatencySamples = value; },
  get notePdfLatency() { return notePdfLatency; }, set notePdfLatency(value) { notePdfLatency = value; },
  get pdfHybridPreviewGrace() { return pdfHybridPreviewGrace; }, set pdfHybridPreviewGrace(value) { pdfHybridPreviewGrace = value; },
  get applyPdfShellGeometry() { return applyPdfShellGeometry; }, set applyPdfShellGeometry(value) { applyPdfShellGeometry = value; },
  get pdfHybridLookahead() { return pdfHybridLookahead; }, set pdfHybridLookahead(value) { pdfHybridLookahead = value; },
  get admitPdfRange() { return admitPdfRange; }, set admitPdfRange(value) { admitPdfRange = value; },
  get drainPdfRangeWaiters() { return drainPdfRangeWaiters; }, set drainPdfRangeWaiters(value) { drainPdfRangeWaiters = value; },
  get startPdfHybridDocument() { return startPdfHybridDocument; }, set startPdfHybridDocument(value) { startPdfHybridDocument = value; },
  get leavePdfHybridMode() { return leavePdfHybridMode; }, set leavePdfHybridMode(value) { leavePdfHybridMode = value; },
  get loadPdfOutline() { return loadPdfOutline; }, set loadPdfOutline(value) { loadPdfOutline = value; },
  get seedPdfPageGeometry() { return seedPdfPageGeometry; }, set seedPdfPageGeometry(value) { seedPdfPageGeometry = value; },
  get acquirePdfRenderSlot() { return acquirePdfRenderSlot; }, set acquirePdfRenderSlot(value) { acquirePdfRenderSlot = value; },
  get acquirePdfTextSlot() { return acquirePdfTextSlot; }, set acquirePdfTextSlot(value) { acquirePdfTextSlot = value; },
  get activateFoliateTocEntry() { return activateFoliateTocEntry; }, set activateFoliateTocEntry(value) { activateFoliateTocEntry = value; },
  get applyChapterSearchPage() { return applyChapterSearchPage; },
  get applyInitialRestoration() { return applyInitialRestoration; }, set applyInitialRestoration(value) { applyInitialRestoration = value; },
  get applyReaderMetadata() { return applyReaderMetadata; }, set applyReaderMetadata(value) { applyReaderMetadata = value; },
  get assertReaderActive() { return assertReaderActive; }, set assertReaderActive(value) { assertReaderActive = value; },
  get awaitReader() { return awaitReader; }, set awaitReader(value) { awaitReader = value; },
  get beginReaderNavigation() { return beginReaderNavigation; }, set beginReaderNavigation(value) { beginReaderNavigation = value; },
  get bookmarkExcerptInput() { return bookmarkExcerptInput; },
  get bookmarkInertSiblings() { return bookmarkInertSiblings; },
  get bookmarkInvoker() { return bookmarkInvoker; }, set bookmarkInvoker(value) { bookmarkInvoker = value; },
  get bookmarkLabelInput() { return bookmarkLabelInput; },
  get bookmarkPopover() { return bookmarkPopover; },
  get bookmarkRibbon() { return bookmarkRibbon; },
  get cachedReaderData() { return cachedReaderData; }, set cachedReaderData(value) { cachedReaderData = value; },
  get cancelSpeculativePdfRenders() { return cancelSpeculativePdfRenders; }, set cancelSpeculativePdfRenders(value) { cancelSpeculativePdfRenders = value; },
  get capability() { return capability; }, set capability(value) { capability = value; },
  get captureChapterPosition() { return captureChapterPosition; }, set captureChapterPosition(value) { captureChapterPosition = value; },
  get captureFoliateBookmarkPosition() { return captureFoliateBookmarkPosition; }, set captureFoliateBookmarkPosition(value) { captureFoliateBookmarkPosition = value; },
  get chapterManifestCleanup() { return chapterManifestCleanup; }, set chapterManifestCleanup(value) { chapterManifestCleanup = value; },
  get chapterManifestLoader() { return chapterManifestLoader; }, set chapterManifestLoader(value) { chapterManifestLoader = value; },
  get chapterManifestObserver() { return chapterManifestObserver; }, set chapterManifestObserver(value) { chapterManifestObserver = value; },
  get chapterManifestUrl() { return chapterManifestUrl; }, set chapterManifestUrl(value) { chapterManifestUrl = value; },
  get chapterNext() { return chapterNext; },
  get chapterPrev() { return chapterPrev; },
  get chapterSearchClient() { return chapterSearchClient; }, set chapterSearchClient(value) { chapterSearchClient = value; },
  get chapterSearchConfiguration() { return chapterSearchConfiguration; }, set chapterSearchConfiguration(value) { chapterSearchConfiguration = value; },
  get chapterSearchModulePromise() { return chapterSearchModulePromise; }, set chapterSearchModulePromise(value) { chapterSearchModulePromise = value; },
  get classifyReaderError() { return classifyReaderError; }, set classifyReaderError(value) { classifyReaderError = value; },
  get clearFullSearchMarks() { return clearFullSearchMarks; },
  get clearPdfManifestPrefetches() { return clearPdfManifestPrefetches; }, set clearPdfManifestPrefetches(value) { clearPdfManifestPrefetches = value; },
  get clearSearchHighlights() { return clearSearchHighlights; }, set clearSearchHighlights(value) { clearSearchHighlights = value; },
  get consumeBookmarkHandoff() { return consumeBookmarkHandoff; }, set consumeBookmarkHandoff(value) { consumeBookmarkHandoff = value; },
  get content() { return content; },
  get contentSanitizerObserver() { return contentSanitizerObserver; }, set contentSanitizerObserver(value) { contentSanitizerObserver = value; },
  get contentUrl() { return contentUrl; }, set contentUrl(value) { contentUrl = value; },
  get createPdfFetchPolicy() { return createPdfFetchPolicy; },
  get createPdfV3Repository() { return createPdfV3Repository; }, set createPdfV3Repository(value) { createPdfV3Repository = value; },
  get createV3Repository() { return createV3Repository; },
  get detectTextEncoding() { return detectTextEncoding; }, set detectTextEncoding(value) { detectTextEncoding = value; },
  get documentState() { return documentState; },
  get domSearch() { return domSearch; },
  get downloadButton() { return downloadButton; },
  get downloadFeedback() { return downloadFeedback; },
  get downloadFeedbackTimer() { return downloadFeedbackTimer; }, set downloadFeedbackTimer(value) { downloadFeedbackTimer = value; },
  get downloadUrl() { return downloadUrl; }, set downloadUrl(value) { downloadUrl = value; },
  get drainPdfTextWaiters() { return drainPdfTextWaiters; }, set drainPdfTextWaiters(value) { drainPdfTextWaiters = value; },
  get emptyPanel() { return emptyPanel; }, set emptyPanel(value) { emptyPanel = value; },
  get epubBook() { return epubBook; }, set epubBook(value) { epubBook = value; },
  get epubContentBody() { return epubContentBody; }, set epubContentBody(value) { epubContentBody = value; },
  get epubRendition() { return epubRendition; }, set epubRendition(value) { epubRendition = value; },
  get epubSeekFrame() { return epubSeekFrame; }, set epubSeekFrame(value) { epubSeekFrame = value; },
  get epubSeekPromise() { return epubSeekPromise; }, set epubSeekPromise(value) { epubSeekPromise = value; },
  get epubSeekTarget() { return epubSeekTarget; }, set epubSeekTarget(value) { epubSeekTarget = value; },
  get extension() { return extension; }, set extension(value) { extension = value; },
  get fail() { return fail; }, set fail(value) { fail = value; },
  get fetchReaderResponse() { return fetchReaderResponse; }, set fetchReaderResponse(value) { fetchReaderResponse = value; },
  get fetchReaderUrl() { return fetchReaderUrl; }, set fetchReaderUrl(value) { fetchReaderUrl = value; },
  get filterPanel() { return filterPanel; }, set filterPanel(value) { filterPanel = value; },
  get folderNavigationTarget() { return folderNavigationTarget; }, set folderNavigationTarget(value) { folderNavigationTarget = value; },
  get folderReturnUrl() { return folderReturnUrl; },
  get foliateChapterRepository() { return foliateChapterRepository; }, set foliateChapterRepository(value) { foliateChapterRepository = value; },
  get foliateContinuous() { return foliateContinuous; }, set foliateContinuous(value) { foliateContinuous = value; },
  get foliateScrollAnchors() { return foliateScrollAnchors; },
  get foliateScrollFrame() { return foliateScrollFrame; }, set foliateScrollFrame(value) { foliateScrollFrame = value; },
  get foliateSectionLoader() { return foliateSectionLoader; }, set foliateSectionLoader(value) { foliateSectionLoader = value; },
  get foliateSectionObserver() { return foliateSectionObserver; }, set foliateSectionObserver(value) { foliateSectionObserver = value; },
  get foliateSectionRoot() { return foliateSectionRoot; }, set foliateSectionRoot(value) { foliateSectionRoot = value; },
  get foliateSectionSettler() { return foliateSectionSettler; }, set foliateSectionSettler(value) { foliateSectionSettler = value; },
  get foliateSectionVirtualizer() { return foliateSectionVirtualizer; }, set foliateSectionVirtualizer(value) { foliateSectionVirtualizer = value; },
  get foliateWindowFrame() { return foliateWindowFrame; }, set foliateWindowFrame(value) { foliateWindowFrame = value; },
  get formatAdapters() { return formatAdapters; },
  get formatMediaTime() { return formatMediaTime; }, set formatMediaTime(value) { formatMediaTime = value; },
  get fullSearchButton() { return fullSearchButton; },
  get fullSearchDomMatches() { return fullSearchDomMatches; },
  get fullSearchEscape() { return fullSearchEscape; },
  get fullSearchInput() { return fullSearchInput; },
  get fullSearchPageOffset() { return fullSearchPageOffset; },
  get fullSearchPdfMatches() { return fullSearchPdfMatches; }, set fullSearchPdfMatches(value) { fullSearchPdfMatches = value; },
  get fullSearchSession() { return fullSearchSession; },
  get fullSearchSnippet() { return fullSearchSnippet; },
  get fullSearchStatus() { return fullSearchStatus; },
  get getInitialReaderRestoration() { return getInitialReaderRestoration; }, set getInitialReaderRestoration(value) { getInitialReaderRestoration = value; },
  get goToPage() { return goToPage; }, set goToPage(value) { goToPage = value; },
  get handlePageNavigationFailure() { return handlePageNavigationFailure; },
  get handleReaderKeydown() { return handleReaderKeydown; }, set handleReaderKeydown(value) { handleReaderKeydown = value; },
  get handleReaderOutsideClick() { return handleReaderOutsideClick; },
  get handleReaderPositionChange() { return handleReaderPositionChange; }, set handleReaderPositionChange(value) { handleReaderPositionChange = value; },
  get headingLocationCache() { return headingLocationCache; }, set headingLocationCache(value) { headingLocationCache = value; },
  get headingTocEntries() { return headingTocEntries; }, set headingTocEntries(value) { headingTocEntries = value; },
  get highlightPdfText() { return highlightPdfText; }, set highlightPdfText(value) { highlightPdfText = value; },
  get highlightTextParts() { return highlightTextParts; },
  get historySuppressed() { return historySuppressed; }, set historySuppressed(value) { historySuppressed = value; },
  get hitBoxes() { return hitBoxes; },
  get htmlFrame() { return htmlFrame; }, set htmlFrame(value) { htmlFrame = value; },
  get imageLoader() { return imageLoader; },
  get independentTextCaret() { return independentTextCaret; },
  get initialReaderPage() { return initialReaderPage; }, set initialReaderPage(value) { initialReaderPage = value; },
  get initialReaderTargetSection() { return initialReaderTargetSection; }, set initialReaderTargetSection(value) { initialReaderTargetSection = value; },
  get installReaderTapSelectionClear() { return installReaderTapSelectionClear; }, set installReaderTapSelectionClear(value) { installReaderTapSelectionClear = value; },
  get isPdfPageVisible() { return isPdfPageVisible; }, set isPdfPageVisible(value) { isPdfPageVisible = value; },
  get isReaderGenerationCurrent() { return isReaderGenerationCurrent; }, set isReaderGenerationCurrent(value) { isReaderGenerationCurrent = value; },
  get lastSavedProgress() { return lastSavedProgress; }, set lastSavedProgress(value) { lastSavedProgress = value; },
  get loadChapterManifestDocument() { return loadChapterManifestDocument; }, set loadChapterManifestDocument(value) { loadChapterManifestDocument = value; },
  get loadHtmlDocument() { return loadHtmlDocument; }, set loadHtmlDocument(value) { loadHtmlDocument = value; },
  get loadImageDocument() { return loadImageDocument; }, set loadImageDocument(value) { loadImageDocument = value; },
  get loadMarkdownDocument() { return loadMarkdownDocument; }, set loadMarkdownDocument(value) { loadMarkdownDocument = value; },
  get loadMediaDocument() { return loadMediaDocument; }, set loadMediaDocument(value) { loadMediaDocument = value; },
  get loadPdfDocument() { return loadPdfDocument; }, set loadPdfDocument(value) { loadPdfDocument = value; },
  get loadPdfOcrManifest() { return loadPdfOcrManifest; }, set loadPdfOcrManifest(value) { loadPdfOcrManifest = value; },
  get loadPdfOcrPage() { return loadPdfOcrPage; }, set loadPdfOcrPage(value) { loadPdfOcrPage = value; },
  get loadPdfTextContent() { return loadPdfTextContent; }, set loadPdfTextContent(value) { loadPdfTextContent = value; },
  get loadReaderRestoration() { return loadReaderRestoration; }, set loadReaderRestoration(value) { loadReaderRestoration = value; },
  get loadScript() { return loadScript; }, set loadScript(value) { loadScript = value; },
  get loadSwfDocument() { return loadSwfDocument; }, set loadSwfDocument(value) { loadSwfDocument = value; },
  get loadTextDocument() { return loadTextDocument; }, set loadTextDocument(value) { loadTextDocument = value; },
  get loadingIndicator() { return loadingIndicator; },
  get loadingStatus() { return loadingStatus; },
  get localReaderData() { return localReaderData; }, set localReaderData(value) { localReaderData = value; },
  get markReaderContentReady() { return markReaderContentReady; }, set markReaderContentReady(value) { markReaderContentReady = value; },
  get markerFrame() { return markerFrame; }, set markerFrame(value) { markerFrame = value; },
  get measurePdf() { return measurePdf; }, set measurePdf(value) { measurePdf = value; },
  get mediaElement() { return mediaElement; }, set mediaElement(value) { mediaElement = value; },
  get mediaPanel() { return mediaPanel; },
  get mediaTab() { return mediaTab; },
  get navigateReader() { return navigateReader; }, set navigateReader(value) { navigateReader = value; },
  get navigateTocEntry() { return navigateTocEntry; }, set navigateTocEntry(value) { navigateTocEntry = value; },
  get navigationState() { return navigationState; },
  get nextReaderGeneration() { return nextReaderGeneration; }, set nextReaderGeneration(value) { nextReaderGeneration = value; },
  get normalizePdfPriority() { return normalizePdfPriority; }, set normalizePdfPriority(value) { normalizePdfPriority = value; },
  get normalizePdfSearchText() { return normalizePdfSearchText; },
  get normalizeSourceUrl() { return normalizeSourceUrl; }, set normalizeSourceUrl(value) { normalizeSourceUrl = value; },
  get ocrManifestUrl() { return ocrManifestUrl; }, set ocrManifestUrl(value) { ocrManifestUrl = value; },
  get ocrUrl() { return ocrUrl; },
  get pageAtMarker() { return pageAtMarker; }, set pageAtMarker(value) { pageAtMarker = value; },
  get pageInput() { return pageInput; },
  get pageInvertToggle() { return pageInvertToggle; },
  get pageInverted() { return pageInverted; }, set pageInverted(value) { pageInverted = value; },
  get pageNavigationLockUntil() { return pageNavigationLockUntil; }, set pageNavigationLockUntil(value) { pageNavigationLockUntil = value; },
  get paintTextHit() { return paintTextHit; },
  get panelAnimationTimer() { return panelAnimationTimer; }, set panelAnimationTimer(value) { panelAnimationTimer = value; },
  get panelState() { return panelState; },
  get params() { return params; },
  get parseChapterDocument() { return parseChapterDocument; }, set parseChapterDocument(value) { parseChapterDocument = value; },
  get pdfActiveRenders() { return pdfActiveRenders; }, set pdfActiveRenders(value) { pdfActiveRenders = value; },
  get pdfActiveSearchTextLoads() { return pdfActiveSearchTextLoads; }, set pdfActiveSearchTextLoads(value) { pdfActiveSearchTextLoads = value; },
  get pdfActiveTextLoads() { return pdfActiveTextLoads; }, set pdfActiveTextLoads(value) { pdfActiveTextLoads = value; },
  get pdfBookSearchClient() { return pdfBookSearchClient; }, set pdfBookSearchClient(value) { pdfBookSearchClient = value; },
  get pdfBookSearchModulePromise() { return pdfBookSearchModulePromise; }, set pdfBookSearchModulePromise(value) { pdfBookSearchModulePromise = value; },
  get pdfBookSearchPrefetchPromise() { return pdfBookSearchPrefetchPromise; }, set pdfBookSearchPrefetchPromise(value) { pdfBookSearchPrefetchPromise = value; },
  get pdfBookSearchPrefetchTimer() { return pdfBookSearchPrefetchTimer; }, set pdfBookSearchPrefetchTimer(value) { pdfBookSearchPrefetchTimer = value; },
  get pdfDocument() { return pdfDocument; }, set pdfDocument(value) { pdfDocument = value; },
  get pdfEnginePreload() { return pdfEnginePreload; }, set pdfEnginePreload(value) { pdfEnginePreload = value; },
  get pdfFetchPolicy() { return pdfFetchPolicy; }, set pdfFetchPolicy(value) { pdfFetchPolicy = value; },
  get pdfFirstPagePreload() { return pdfFirstPagePreload; }, set pdfFirstPagePreload(value) { pdfFirstPagePreload = value; },
  get pdfFirstPagePreloadPage() { return pdfFirstPagePreloadPage; }, set pdfFirstPagePreloadPage(value) { pdfFirstPagePreloadPage = value; },
  get pdfHybridDocumentPromise() { return pdfHybridDocumentPromise; }, set pdfHybridDocumentPromise(value) { pdfHybridDocumentPromise = value; },
  get pdfHybridSearchUnavailable() { return pdfHybridSearchUnavailable; }, set pdfHybridSearchUnavailable(value) { pdfHybridSearchUnavailable = value; },
  get pdfHybridUrl() { return pdfHybridUrl; }, set pdfHybridUrl(value) { pdfHybridUrl = value; },
  get pdfLastScrollTop() { return pdfLastScrollTop; }, set pdfLastScrollTop(value) { pdfLastScrollTop = value; },
  get pdfManifestPrefetchActive() { return pdfManifestPrefetchActive; },
  get pdfManifestPrefetchCount() { return pdfManifestPrefetchCount; }, set pdfManifestPrefetchCount(value) { pdfManifestPrefetchCount = value; },
  get pdfManifestPrefetchNext() { return pdfManifestPrefetchNext; }, set pdfManifestPrefetchNext(value) { pdfManifestPrefetchNext = value; },
  get pdfManifestPrefetchOrigin() { return pdfManifestPrefetchOrigin; }, set pdfManifestPrefetchOrigin(value) { pdfManifestPrefetchOrigin = value; },
  get pdfManifestPrefetchTimer() { return pdfManifestPrefetchTimer; }, set pdfManifestPrefetchTimer(value) { pdfManifestPrefetchTimer = value; },
  get pdfManifestPrefetchWrapped() { return pdfManifestPrefetchWrapped; }, set pdfManifestPrefetchWrapped(value) { pdfManifestPrefetchWrapped = value; },
  get pdfManifestPrefetches() { return pdfManifestPrefetches; },
  get pdfManifestShells() { return pdfManifestShells; },
  get pdfOcrManifest() { return pdfOcrManifest; }, set pdfOcrManifest(value) { pdfOcrManifest = value; },
  get pdfOcrManifestPromise() { return pdfOcrManifestPromise; }, set pdfOcrManifestPromise(value) { pdfOcrManifestPromise = value; },
  get pdfOcrPageCache() { return pdfOcrPageCache; },
  get pdfOcrPageCacheBytes() { return pdfOcrPageCacheBytes; }, set pdfOcrPageCacheBytes(value) { pdfOcrPageCacheBytes = value; },
  get pdfOcrPagePromises() { return pdfOcrPagePromises; },
  get pdfOcrSource() { return pdfOcrSource; }, set pdfOcrSource(value) { pdfOcrSource = value; },
  get pdfPageEntry() { return pdfPageEntry; }, set pdfPageEntry(value) { pdfPageEntry = value; },
  get pdfPageManifest() { return pdfPageManifest; }, set pdfPageManifest(value) { pdfPageManifest = value; },
  get pdfPagePriority() { return pdfPagePriority; }, set pdfPagePriority(value) { pdfPagePriority = value; },
  get pdfPageTimings() { return pdfPageTimings; },
  get pdfPersistentTextOpening() { return pdfPersistentTextOpening; }, set pdfPersistentTextOpening(value) { pdfPersistentTextOpening = value; },
  get pdfPersistentTextStore() { return pdfPersistentTextStore; }, set pdfPersistentTextStore(value) { pdfPersistentTextStore = value; },
  get pdfPersistentTextVersion() { return pdfPersistentTextVersion; }, set pdfPersistentTextVersion(value) { pdfPersistentTextVersion = value; },
  get pdfPrimarySource() { return pdfPrimarySource; }, set pdfPrimarySource(value) { pdfPrimarySource = value; },
  get pdfRenderWaiters() { return pdfRenderWaiters; },
  get pdfScrollDirection() { return pdfScrollDirection; }, set pdfScrollDirection(value) { pdfScrollDirection = value; },
  get pdfSearchText() { return pdfSearchText; },
  get pdfSearchTextCache() { return pdfSearchTextCache; },
  get pdfSearchTextCacheBytes() { return pdfSearchTextCacheBytes; }, set pdfSearchTextCacheBytes(value) { pdfSearchTextCacheBytes = value; },
  get pdfSelectionIntersects() { return pdfSelectionIntersects; }, set pdfSelectionIntersects(value) { pdfSelectionIntersects = value; },
  get pdfShellWindow() { return pdfShellWindow; }, set pdfShellWindow(value) { pdfShellWindow = value; },
  get pdfShellsReady() { return pdfShellsReady; }, set pdfShellsReady(value) { pdfShellsReady = value; },
  get pdfSourceOffset() { return pdfSourceOffset; },
  get pdfTextContent() { return pdfTextContent; },
  get pdfTextContentCache() { return pdfTextContentCache; },
  get pdfTextContentCacheBytes() { return pdfTextContentCacheBytes; }, set pdfTextContentCacheBytes(value) { pdfTextContentCacheBytes = value; },
  get pdfTextContentPromises() { return pdfTextContentPromises; },
  get pdfTextLayerRepository() { return pdfTextLayerRepository; }, set pdfTextLayerRepository(value) { pdfTextLayerRepository = value; },
  get pdfTextWaiters() { return pdfTextWaiters; },
  get pdfUserHasScrolled() { return pdfUserHasScrolled; }, set pdfUserHasScrolled(value) { pdfUserHasScrolled = value; },
  get pdfV3BlobReleases() { return pdfV3BlobReleases; },
  get pdfV3Manifest() { return pdfV3Manifest; }, set pdfV3Manifest(value) { pdfV3Manifest = value; },
  get pdfV3Map() { return pdfV3Map; }, set pdfV3Map(value) { pdfV3Map = value; },
  get pdfV3Repository() { return pdfV3Repository; }, set pdfV3Repository(value) { pdfV3Repository = value; },
  get pdfWorker() { return pdfWorker; }, set pdfWorker(value) { pdfWorker = value; },
  get pendingBookmarkSnapshot() { return pendingBookmarkSnapshot; }, set pendingBookmarkSnapshot(value) { pendingBookmarkSnapshot = value; },
  get populateIndependentTextLayer() { return populateIndependentTextLayer; },
  get populateOcrTextLayer() { return populateOcrTextLayer; },
  get populatePdfTextLayer() { return populatePdfTextLayer; },
  get preloadPdfEngine() { return preloadPdfEngine; }, set preloadPdfEngine(value) { preloadPdfEngine = value; },
  get prepareReaderDocument() { return prepareReaderDocument; }, set prepareReaderDocument(value) { prepareReaderDocument = value; },
  get previousProgressState() { return previousProgressState; }, set previousProgressState(value) { previousProgressState = value; },
  get prioritizePdfManifestPrefetch() { return prioritizePdfManifestPrefetch; }, set prioritizePdfManifestPrefetch(value) { prioritizePdfManifestPrefetch = value; },
  get progressPercent() { return progressPercent; },
  get progressRange() { return progressRange; },
  get progressSaveChain() { return progressSaveChain; }, set progressSaveChain(value) { progressSaveChain = value; },
  get progressSeeking() { return progressSeeking; }, set progressSeeking(value) { progressSeeking = value; },
  get progressTools() { return progressTools; },
  get progressUndo() { return progressUndo; },
  get promotePdfRenderWaiter() { return promotePdfRenderWaiter; }, set promotePdfRenderWaiter(value) { promotePdfRenderWaiter = value; },
  get notePdfViewportMotion() { return notePdfViewportMotion; },
  get pdfScrollActivity() { return pdfScrollActivity; },
  get queuePdfManifestPrefetch() { return queuePdfManifestPrefetch; }, set queuePdfManifestPrefetch(value) { queuePdfManifestPrefetch = value; },
  get readPreparedBytes() { return readPreparedBytes; }, set readPreparedBytes(value) { readPreparedBytes = value; },
  get readerAbortController() { return readerAbortController; },
  get readerAbortError() { return readerAbortError; }, set readerAbortError(value) { readerAbortError = value; },
  get readerContentUrl() { return readerContentUrl; }, set readerContentUrl(value) { readerContentUrl = value; },
  get readerDownloadApiUrl() { return readerDownloadApiUrl; }, set readerDownloadApiUrl(value) { readerDownloadApiUrl = value; },
  get readerDownloadUrl() { return readerDownloadUrl; }, set readerDownloadUrl(value) { readerDownloadUrl = value; },
  get readerId() { return readerId; },
  get readerLifecycle() { return readerLifecycle; },
  get readerPageScrollTop() { return readerPageScrollTop; }, set readerPageScrollTop(value) { readerPageScrollTop = value; },
  get readerPanelInteractionSerial() { return readerPanelInteractionSerial; }, set readerPanelInteractionSerial(value) { readerPanelInteractionSerial = value; },
  get readerPath() { return readerPath; },
  get readerPathLabel() { return readerPathLabel; },
  get readerProgressPercent() { return readerProgressPercent; }, set readerProgressPercent(value) { readerProgressPercent = value; },
  get readerRequestManager() { return readerRequestManager; },
  get readerResources() { return readerResources; },
  get readerRestorationEntry() { return readerRestorationEntry; }, set readerRestorationEntry(value) { readerRestorationEntry = value; },
  get readerRestorationLoaded() { return readerRestorationLoaded; }, set readerRestorationLoaded(value) { readerRestorationLoaded = value; },
  get readerRestorationPromise() { return readerRestorationPromise; }, set readerRestorationPromise(value) { readerRestorationPromise = value; },
  get readerRuntime() { return readerRuntime; },
  get readerSourcePromise() { return readerSourcePromise; }, set readerSourcePromise(value) { readerSourcePromise = value; },
  get readerTheme() { return readerTheme; }, set readerTheme(value) { readerTheme = value; },
  get readerThemeToggle() { return readerThemeToggle; },
  get readerUiHistoryState() { return readerUiHistoryState; }, set readerUiHistoryState(value) { readerUiHistoryState = value; },
  get readingProgressSummary() { return readingProgressSummary; },
  get refreshNearbyPdfPages() { return refreshNearbyPdfPages; }, set refreshNearbyPdfPages(value) { refreshNearbyPdfPages = value; },
  get releasePdfRenderSlot() { return releasePdfRenderSlot; }, set releasePdfRenderSlot(value) { releasePdfRenderSlot = value; },
  get releasePdfTextSlot() { return releasePdfTextSlot; }, set releasePdfTextSlot(value) { releasePdfTextSlot = value; },
  get releasePdfWorker() { return releasePdfWorker; }, set releasePdfWorker(value) { releasePdfWorker = value; },
  get renderBookmarks() { return renderBookmarks; }, set renderBookmarks(value) { renderBookmarks = value; },
  get renderChapterManifest() { return renderChapterManifest; }, set renderChapterManifest(value) { renderChapterManifest = value; },
  get renderFoliate() { return renderFoliate; }, set renderFoliate(value) { renderFoliate = value; },
  get renderFullSearchResults() { return renderFullSearchResults; },
  get renderHtml() { return renderHtml; }, set renderHtml(value) { renderHtml = value; },
  get renderImageDocument() { return renderImageDocument; }, set renderImageDocument(value) { renderImageDocument = value; },
  get renderImagePages() { return renderImagePages; }, set renderImagePages(value) { renderImagePages = value; },
  get renderMarkdownDocument() { return renderMarkdownDocument; }, set renderMarkdownDocument(value) { renderMarkdownDocument = value; },
  get renderMedia() { return renderMedia; }, set renderMedia(value) { renderMedia = value; },
  get renderPdf() { return renderPdf; }, set renderPdf(value) { renderPdf = value; },
  get renderPdfInBackground() { return renderPdfInBackground; }, set renderPdfInBackground(value) { renderPdfInBackground = value; },
  get renderPdfManifestShell() { return renderPdfManifestShell; }, set renderPdfManifestShell(value) { renderPdfManifestShell = value; },
  get renderPdfOcrText() { return renderPdfOcrText; }, set renderPdfOcrText(value) { renderPdfOcrText = value; },
  get renderPdfPages() { return renderPdfPages; }, set renderPdfPages(value) { renderPdfPages = value; },
  get renderPdfShell() { return renderPdfShell; }, set renderPdfShell(value) { renderPdfShell = value; },
  get renderPdfText() { return renderPdfText; }, set renderPdfText(value) { renderPdfText = value; },
  get renderPlainText() { return renderPlainText; }, set renderPlainText(value) { renderPlainText = value; },
  get renderSwf() { return renderSwf; }, set renderSwf(value) { renderSwf = value; },
  get renderText() { return renderText; }, set renderText(value) { renderText = value; },
  get renderTextDocument() { return renderTextDocument; }, set renderTextDocument(value) { renderTextDocument = value; },
  get reportNavigationError() { return reportNavigationError; }, set reportNavigationError(value) { reportNavigationError = value; },
  get rerenderVisiblePdfPages() { return rerenderVisiblePdfPages; }, set rerenderVisiblePdfPages(value) { rerenderVisiblePdfPages = value; },
  get resolveReaderId() { return resolveReaderId; }, set resolveReaderId(value) { resolveReaderId = value; },
  get resolvedReaderData() { return resolvedReaderData; }, set resolvedReaderData(value) { resolvedReaderData = value; },
  get restorationFailed() { return restorationFailed; }, set restorationFailed(value) { restorationFailed = value; },
  get restoreChapterPosition() { return restoreChapterPosition; }, set restoreChapterPosition(value) { restoreChapterPosition = value; },
  get restoreFoliateBookmarkPosition() { return restoreFoliateBookmarkPosition; }, set restoreFoliateBookmarkPosition(value) { restoreFoliateBookmarkPosition = value; },
  get restoreFormat() { return restoreFormat; }, set restoreFormat(value) { restoreFormat = value; },
  get retryReaderProxy() { return retryReaderProxy; }, set retryReaderProxy(value) { retryReaderProxy = value; },
  get retryableReaderProxyError() { return retryableReaderProxyError; }, set retryableReaderProxyError(value) { retryableReaderProxyError = value; },
  get returnHistoryKey() { return returnHistoryKey; },
  get runFullSearch() { return runFullSearch; },
  get sanitizeEpubDocument() { return sanitizeEpubDocument; }, set sanitizeEpubDocument(value) { sanitizeEpubDocument = value; },
  get sanitizeFoliateStyles() { return sanitizeFoliateStyles; }, set sanitizeFoliateStyles(value) { sanitizeFoliateStyles = value; },
  get saveDeadline() { return saveDeadline; }, set saveDeadline(value) { saveDeadline = value; },
  get saveProgress() { return saveProgress; }, set saveProgress(value) { saveProgress = value; },
  get saveTimer() { return saveTimer; }, set saveTimer(value) { saveTimer = value; },
  get scheduleFoliateScrollSync() { return scheduleFoliateScrollSync; }, set scheduleFoliateScrollSync(value) { scheduleFoliateScrollSync = value; },
  get scheduleMarkerSync() { return scheduleMarkerSync; }, set scheduleMarkerSync(value) { scheduleMarkerSync = value; },
  get schedulePdfBookSearchPrefetch() { return schedulePdfBookSearchPrefetch; }, set schedulePdfBookSearchPrefetch(value) { schedulePdfBookSearchPrefetch = value; },
  get schedulePdfManifestPrefetch() { return schedulePdfManifestPrefetch; }, set schedulePdfManifestPrefetch(value) { schedulePdfManifestPrefetch = value; },
  get scheduleVisiblePdfRenderReconciliation() { return scheduleVisiblePdfRenderReconciliation; }, set scheduleVisiblePdfRenderReconciliation(value) { scheduleVisiblePdfRenderReconciliation = value; },
  get scheduleSave() { return scheduleSave; }, set scheduleSave(value) { scheduleSave = value; },
  get searchConcentratedPdf() { return searchConcentratedPdf; }, set searchConcentratedPdf(value) { searchConcentratedPdf = value; },
  get searchState() { return searchState; },
  get seekFoliateProgress() { return seekFoliateProgress; }, set seekFoliateProgress(value) { seekFoliateProgress = value; },
  get selectPanel() { return selectPanel; }, set selectPanel(value) { selectPanel = value; },
  get setPdfPageLoadingState() { return setPdfPageLoadingState; }, set setPdfPageLoadingState(value) { setPdfPageLoadingState = value; },
  get setReaderPanelOpen() { return setReaderPanelOpen; }, set setReaderPanelOpen(value) { setReaderPanelOpen = value; },
  get setReaderPhase() { return setReaderPhase; }, set setReaderPhase(value) { setReaderPhase = value; },
  get setReaderStage() { return setReaderStage; }, set setReaderStage(value) { setReaderStage = value; },
  get setToc() { return setToc; }, set setToc(value) { setToc = value; },
  get setZoom() { return setZoom; }, set setZoom(value) { setZoom = value; },
  get settleReaderImages() { return settleReaderImages; }, set settleReaderImages(value) { settleReaderImages = value; },
  get alignReaderDestination() { return alignReaderDestination; },
  get holdReaderDestination() { return holdReaderDestination; },
  get cancelReaderDestinationHold() { return cancelReaderDestinationHold; },
  get reassertReaderDestination() { return reassertReaderDestination; },
  get showDownloadFeedback() { return showDownloadFeedback; }, set showDownloadFeedback(value) { showDownloadFeedback = value; },
  get sourceName() { return sourceName; },
  get sourceUrl() { return sourceUrl; }, set sourceUrl(value) { sourceUrl = value; },
  get status() { return status; },
  get swfPlayer() { return swfPlayer; }, set swfPlayer(value) { swfPlayer = value; },
  get syncCurrentPageFromMarker() { return syncCurrentPageFromMarker; }, set syncCurrentPageFromMarker(value) { syncCurrentPageFromMarker = value; },
  get syncFoliateScrollLocation() { return syncFoliateScrollLocation; }, set syncFoliateScrollLocation(value) { syncFoliateScrollLocation = value; },
  get syncHeadingLocation() { return syncHeadingLocation; }, set syncHeadingLocation(value) { syncHeadingLocation = value; },
  get takePdfManifestPrefetch() { return takePdfManifestPrefetch; }, set takePdfManifestPrefetch(value) { takePdfManifestPrefetch = value; },
  get themeAnimationTimer() { return themeAnimationTimer; }, set themeAnimationTimer(value) { themeAnimationTimer = value; },
  get tocVirtualState() { return tocVirtualState; }, set tocVirtualState(value) { tocVirtualState = value; },
  get trackReaderResource() { return trackReaderResource; }, set trackReaderResource(value) { trackReaderResource = value; },
  get trimPdfCanvases() { return trimPdfCanvases; }, set trimPdfCanvases(value) { trimPdfCanvases = value; },
  get trimPdfManifestImages() { return trimPdfManifestImages; }, set trimPdfManifestImages(value) { trimPdfManifestImages = value; },
  get trustedChapterReferenceUrl() { return trustedChapterReferenceUrl; }, set trustedChapterReferenceUrl(value) { trustedChapterReferenceUrl = value; },
  get trustedChapterResourceUrl() { return trustedChapterResourceUrl; }, set trustedChapterResourceUrl(value) { trustedChapterResourceUrl = value; },
  get trustedChapterUrl() { return trustedChapterUrl; }, set trustedChapterUrl(value) { trustedChapterUrl = value; },
  get trustedReaderAssetManifestUrl() { return trustedReaderAssetManifestUrl; }, set trustedReaderAssetManifestUrl(value) { trustedReaderAssetManifestUrl = value; },
  get updateDocumentState() { return updateDocumentState; }, set updateDocumentState(value) { updateDocumentState = value; },
  get updateNavigationState() { return updateNavigationState; }, set updateNavigationState(value) { updateNavigationState = value; },
  get updatePanelState() { return updatePanelState; }, set updatePanelState(value) { updatePanelState = value; },
  get updateProgressTools() { return updateProgressTools; }, set updateProgressTools(value) { updateProgressTools = value; },
  get updateSearchState() { return updateSearchState; }, set updateSearchState(value) { updateSearchState = value; },
  get updateTocCurrentMark() { return updateTocCurrentMark; }, set updateTocCurrentMark(value) { updateTocCurrentMark = value; },
  get v3ResourceUrl() { return v3ResourceUrl; }, set v3ResourceUrl(value) { v3ResourceUrl = value; },
  get validOcr() { return validOcr; }, set validOcr(value) { validOcr = value; },
  get validSource() { return validSource; }, set validSource(value) { validSource = value; },
  get validatePageMap() { return validatePageMap; },
  get validateReadingManifest() { return validateReadingManifest; },
  get validateResource() { return validateResource; },
  get datasetPrimaryUrl() { return datasetPrimaryUrl; },
  get viewport() { return viewport; },
  get waitForReader() { return waitForReader; }, set waitForReader(value) { waitForReader = value; },
  get zoomChangedByUser() { return zoomChangedByUser; }, set zoomChangedByUser(value) { zoomChangedByUser = value; },
  get zoomInput() { return zoomInput; },
  get activateChapter() { return activateChapter; }, set activateChapter(value) { activateChapter = value; },
  get adjacentTocIndex() { return adjacentTocIndex; },
  get applyPageInversion() { return applyPageInversion; }, set applyPageInversion(value) { applyPageInversion = value; },
  get applyReaderTheme() { return applyReaderTheme; }, set applyReaderTheme(value) { applyReaderTheme = value; },
  get bookmarkEditFields() { return bookmarkEditFields; },
  get bookmarksAllButton() { return bookmarksAllButton; },
  get bookmarksHeader() { return bookmarksHeader; },
  get bookmarksHeaderActions() { return bookmarksHeaderActions; },
  get bookmarksSearchButton() { return bookmarksSearchButton; },
  get canReturnWithHistory() { return canReturnWithHistory; }, set canReturnWithHistory(value) { canReturnWithHistory = value; },
  get captureBookmarkSnapshot() { return captureBookmarkSnapshot; }, set captureBookmarkSnapshot(value) { captureBookmarkSnapshot = value; },
  get captureProgressState() { return captureProgressState; }, set captureProgressState(value) { captureProgressState = value; },
  get clearReturnNavigation() { return clearReturnNavigation; }, set clearReturnNavigation(value) { clearReturnNavigation = value; },
  get closeBookmarkPopover() { return closeBookmarkPopover; }, set closeBookmarkPopover(value) { closeBookmarkPopover = value; },
  get closeFullSearchView() { return closeFullSearchView; },
  get correctPdfCrossPageSelection() { return correctPdfCrossPageSelection; }, set correctPdfCrossPageSelection(value) { correctPdfCrossPageSelection = value; },
  get currentReaderUrl() { return currentReaderUrl; }, set currentReaderUrl(value) { currentReaderUrl = value; },
  get disposeReader() { return disposeReader; }, set disposeReader(value) { disposeReader = value; },
  get flushEpubSeek() { return flushEpubSeek; }, set flushEpubSeek(value) { flushEpubSeek = value; },
  get fullSearchController() { return fullSearchController; },
  get fullSearchView() { return fullSearchView; },
  get isReaderOverlayFrame() { return isReaderOverlayFrame; }, set isReaderOverlayFrame(value) { isReaderOverlayFrame = value; },
  get navigateReaderFolder() { return navigateReaderFolder; }, set navigateReaderFolder(value) { navigateReaderFolder = value; },
  get normalizeReaderReturnUrl() { return normalizeReaderReturnUrl; }, set normalizeReaderReturnUrl(value) { normalizeReaderReturnUrl = value; },
  get notePdfScrollIntent() { return notePdfScrollIntent; }, set notePdfScrollIntent(value) { notePdfScrollIntent = value; },
  get openBookmarkPopover() { return openBookmarkPopover; }, set openBookmarkPopover(value) { openBookmarkPopover = value; },
  get pdfDiagnostics() { return pdfDiagnostics; },
  get pdfSelectionBoundaryUpdate() { return pdfSelectionBoundaryUpdate; }, set pdfSelectionBoundaryUpdate(value) { pdfSelectionBoundaryUpdate = value; },
  get pdfSelectionPointer() { return pdfSelectionPointer; }, set pdfSelectionPointer(value) { pdfSelectionPointer = value; },
  get registerReaderFormatAdapters() { return registerReaderFormatAdapters; }, set registerReaderFormatAdapters(value) { registerReaderFormatAdapters = value; },
  get renderHistory() { return renderHistory; }, set renderHistory(value) { renderHistory = value; },
  get restoreProgressState() { return restoreProgressState; }, set restoreProgressState(value) { restoreProgressState = value; },
  get returnNavigationToken() { return returnNavigationToken; }, set returnNavigationToken(value) { returnNavigationToken = value; },
  get returnNeedsReload() { return returnNeedsReload; }, set returnNeedsReload(value) { returnNeedsReload = value; },
  get returnUrl() { return returnUrl; }, set returnUrl(value) { returnUrl = value; },
  get seekProgress() { return seekProgress; }, set seekProgress(value) { seekProgress = value; },
  get setPanelSearchOpen() { return setPanelSearchOpen; }, set setPanelSearchOpen(value) { setPanelSearchOpen = value; },
  get start() { return start; }, set start(value) { start = value; },
  get startReaderDownload() { return startReaderDownload; }, set startReaderDownload(value) { startReaderDownload = value; },
  get stopPdfManifestPrefetch() { return stopPdfManifestPrefetch; }, set stopPdfManifestPrefetch(value) { stopPdfManifestPrefetch = value; },
  get stopReaderWork() { return stopReaderWork; }, set stopReaderWork(value) { stopReaderWork = value; },
  get syncCapabilityControls() { return syncCapabilityControls; }, set syncCapabilityControls(value) { syncCapabilityControls = value; },
  get syncTocTab() { return syncTocTab; }, set syncTocTab(value) { syncTocTab = value; },
  get turnViewport() { return turnViewport; }, set turnViewport(value) { turnViewport = value; },
  get updateReadingProgressSummary() { return updateReadingProgressSummary; }, set updateReadingProgressSummary(value) { updateReadingProgressSummary = value; },
  get appendShellsBatched() { return appendShellsBatched; }, set appendShellsBatched(value) { appendShellsBatched = value; },
  get applyReaderPathMetadata() { return applyReaderPathMetadata; }, set applyReaderPathMetadata(value) { applyReaderPathMetadata = value; },
  get bookmarkExcerpt() { return bookmarkExcerpt; }, set bookmarkExcerpt(value) { bookmarkExcerpt = value; },
  get buildDiscourseDocument() { return buildDiscourseDocument; }, set buildDiscourseDocument(value) { buildDiscourseDocument = value; },
  get buildHtmlFrameSource() { return buildHtmlFrameSource; }, set buildHtmlFrameSource(value) { buildHtmlFrameSource = value; },
  get cachePdfOcrPage() { return cachePdfOcrPage; }, set cachePdfOcrPage(value) { cachePdfOcrPage = value; },
  get cachePdfSearchText() { return cachePdfSearchText; }, set cachePdfSearchText(value) { cachePdfSearchText = value; },
  get cachePdfTextContent() { return cachePdfTextContent; }, set cachePdfTextContent(value) { cachePdfTextContent = value; },
  get cachedPdfOcrPage() { return cachedPdfOcrPage; }, set cachedPdfOcrPage(value) { cachedPdfOcrPage = value; },
  get cachedPdfTextContent() { return cachedPdfTextContent; }, set cachedPdfTextContent(value) { cachedPdfTextContent = value; },
  get canPrefetchPdfImages() { return canPrefetchPdfImages; }, set canPrefetchPdfImages(value) { canPrefetchPdfImages = value; },
  get cancelPdfManifestPrefetch() { return cancelPdfManifestPrefetch; }, set cancelPdfManifestPrefetch(value) { cancelPdfManifestPrefetch = value; },
  get chapterSearchModule() { return chapterSearchModule; }, set chapterSearchModule(value) { chapterSearchModule = value; },
  get cleanTocLabel() { return cleanTocLabel; }, set cleanTocLabel(value) { cleanTocLabel = value; },
  get cloneFoliateDocument() { return cloneFoliateDocument; }, set cloneFoliateDocument(value) { cloneFoliateDocument = value; },
  get createFoliateSection() { return createFoliateSection; }, set createFoliateSection(value) { createFoliateSection = value; },
  get createHeadingLocationCache() { return createHeadingLocationCache; }, set createHeadingLocationCache(value) { createHeadingLocationCache = value; },
  get createPdfShellWindow() { return createPdfShellWindow; }, set createPdfShellWindow(value) { createPdfShellWindow = value; },
  get createTocRow() { return createTocRow; }, set createTocRow(value) { createTocRow = value; },
  get detectHtmlEncoding() { return detectHtmlEncoding; }, set detectHtmlEncoding(value) { detectHtmlEncoding = value; },
  get disposeFormatResources() { return disposeFormatResources; }, set disposeFormatResources(value) { disposeFormatResources = value; },
  get ensurePdfBookSearchClient() { return ensurePdfBookSearchClient; }, set ensurePdfBookSearchClient(value) { ensurePdfBookSearchClient = value; },
  get estimatePdfOcrPageBytes() { return estimatePdfOcrPageBytes; }, set estimatePdfOcrPageBytes(value) { estimatePdfOcrPageBytes = value; },
  get estimatePdfTextContentBytes() { return estimatePdfTextContentBytes; }, set estimatePdfTextContentBytes(value) { estimatePdfTextContentBytes = value; },
  get excerptFromCaret() { return excerptFromCaret; }, set excerptFromCaret(value) { excerptFromCaret = value; },
  get fetchWithReaderTimeout() { return fetchWithReaderTimeout; }, set fetchWithReaderTimeout(value) { fetchWithReaderTimeout = value; },
  get foliateSearchAnchor() { return foliateSearchAnchor; }, set foliateSearchAnchor(value) { foliateSearchAnchor = value; },
  get foliateSectionQuery() { return foliateSectionQuery; }, set foliateSectionQuery(value) { foliateSectionQuery = value; },
  get foliateTocEntries() { return foliateTocEntries; }, set foliateTocEntries(value) { foliateTocEntries = value; },
  get fullSearchFoliateMatches() { return fullSearchFoliateMatches; }, set fullSearchFoliateMatches(value) { fullSearchFoliateMatches = value; },
  get getPdfPersistentTextStore() { return getPdfPersistentTextStore; }, set getPdfPersistentTextStore(value) { getPdfPersistentTextStore = value; },
  get highlightPanelItem() { return highlightPanelItem; }, set highlightPanelItem(value) { highlightPanelItem = value; },
  get loadPdfEngine() { return loadPdfEngine; }, set loadPdfEngine(value) { loadPdfEngine = value; },
  get loadPdfSearchText() { return loadPdfSearchText; }, set loadPdfSearchText(value) { loadPdfSearchText = value; },
  get loadPdfTaskWithTimeout() { return loadPdfTaskWithTimeout; }, set loadPdfTaskWithTimeout(value) { loadPdfTaskWithTimeout = value; },
  get loadPdfWithTimeout() { return loadPdfWithTimeout; }, set loadPdfWithTimeout(value) { loadPdfWithTimeout = value; },
  get makePdfSearchPageLoader() { return makePdfSearchPageLoader; }, set makePdfSearchPageLoader(value) { makePdfSearchPageLoader = value; },
  get normalizeEpubDocument() { return normalizeEpubDocument; }, set normalizeEpubDocument(value) { normalizeEpubDocument = value; },
  get notifyReaderUiState() { return notifyReaderUiState; }, set notifyReaderUiState(value) { notifyReaderUiState = value; },
  get pdfManifestPrefetchConcurrency() { return pdfManifestPrefetchConcurrency; }, set pdfManifestPrefetchConcurrency(value) { pdfManifestPrefetchConcurrency = value; },
  get pdfManifestPrefetchMaxPages() { return pdfManifestPrefetchMaxPages; }, set pdfManifestPrefetchMaxPages(value) { pdfManifestPrefetchMaxPages = value; },
  get pdfManifestSource() { return pdfManifestSource; }, set pdfManifestSource(value) { pdfManifestSource = value; },
  get pdfPixelBudget() { return pdfPixelBudget; }, set pdfPixelBudget(value) { pdfPixelBudget = value; },
  get pdfRetainedPixels() { return pdfRetainedPixels; }, set pdfRetainedPixels(value) { pdfRetainedPixels = value; },
  get pdfStage() { return pdfStage; }, set pdfStage(value) { pdfStage = value; },
  get pdfSurfacePixels() { return pdfSurfacePixels; }, set pdfSurfacePixels(value) { pdfSurfacePixels = value; },
  get placeReadingProgress() { return placeReadingProgress; }, set placeReadingProgress(value) { placeReadingProgress = value; },
  get prefetchPdfBookSearch() { return prefetchPdfBookSearch; }, set prefetchPdfBookSearch(value) { prefetchPdfBookSearch = value; },
  get preloadPdfFirstPage() { return preloadPdfFirstPage; }, set preloadPdfFirstPage(value) { preloadPdfFirstPage = value; },
  get prepareHtmlDocument() { return prepareHtmlDocument; }, set prepareHtmlDocument(value) { prepareHtmlDocument = value; },
  get preparePdfWorker() { return preparePdfWorker; }, set preparePdfWorker(value) { preparePdfWorker = value; },
  get preparePdfWorkerAttempt() { return preparePdfWorkerAttempt; }, set preparePdfWorkerAttempt(value) { preparePdfWorkerAttempt = value; },
  get publishPdfSearchProgress() { return publishPdfSearchProgress; }, set publishPdfSearchProgress(value) { publishPdfSearchProgress = value; },
  get publishSearchResults() { return publishSearchResults; }, set publishSearchResults(value) { publishSearchResults = value; },
  get readPdfOcrJson() { return readPdfOcrJson; }, set readPdfOcrJson(value) { readPdfOcrJson = value; },
  get readerAssetObjectFamily() { return readerAssetObjectFamily; }, set readerAssetObjectFamily(value) { readerAssetObjectFamily = value; },
  get refreshFoliateWindow() { return refreshFoliateWindow; }, set refreshFoliateWindow(value) { refreshFoliateWindow = value; },
  get renderHybridPdfCanvas() { return renderHybridPdfCanvas; }, set renderHybridPdfCanvas(value) { renderHybridPdfCanvas = value; },
  get renderPdfImageShell() { return renderPdfImageShell; }, set renderPdfImageShell(value) { renderPdfImageShell = value; },
  get renderVirtualToc() { return renderVirtualToc; }, set renderVirtualToc(value) { renderVirtualToc = value; },
  get repairHtmlContrast() { return repairHtmlContrast; }, set repairHtmlContrast(value) { repairHtmlContrast = value; },
  get resolveReaderSource() { return resolveReaderSource; }, set resolveReaderSource(value) { resolveReaderSource = value; },
  get restoreInitialPosition() { return restoreInitialPosition; }, set restoreInitialPosition(value) { restoreInitialPosition = value; },
  get rewriteFoliateResources() { return rewriteFoliateResources; }, set rewriteFoliateResources(value) { rewriteFoliateResources = value; },
  get sanitizeOfflineHtml() { return sanitizeOfflineHtml; }, set sanitizeOfflineHtml(value) { sanitizeOfflineHtml = value; },
  get sanitizeReaderDocument() { return sanitizeReaderDocument; }, set sanitizeReaderDocument(value) { sanitizeReaderDocument = value; },
  get scheduleFoliateWindowRefresh() { return scheduleFoliateWindowRefresh; }, set scheduleFoliateWindowRefresh(value) { scheduleFoliateWindowRefresh = value; },
  get searchChapterBook() { return searchChapterBook; }, set searchChapterBook(value) { searchChapterBook = value; },
  get setBookmarkDialogModal() { return setBookmarkDialogModal; }, set setBookmarkDialogModal(value) { setBookmarkDialogModal = value; },
  get setupFoliateWindow() { return setupFoliateWindow; }, set setupFoliateWindow(value) { setupFoliateWindow = value; },
  get trimFoliateSections() { return trimFoliateSections; }, set trimFoliateSections(value) { trimFoliateSections = value; },
  get trimPdfManifestPrefetches() { return trimPdfManifestPrefetches; }, set trimPdfManifestPrefetches(value) { trimPdfManifestPrefetches = value; },
  get trimPdfSurfaces() { return trimPdfSurfaces; }, set trimPdfSurfaces(value) { trimPdfSurfaces = value; },
  get waitForSpreadsheetImages() { return waitForSpreadsheetImages; }, set waitForSpreadsheetImages(value) { waitForSpreadsheetImages = value; }
};
const readerBindings = createReaderBindings(readerContext);

let {
  pdfStage, measurePdf
} = createReaderDiagnostics(readerContext);

let {
  readerAbortError, assertReaderActive, trackReaderResource, stopReaderWork,
  awaitReader, waitForReader, setReaderPhase, setReaderStage,
  classifyReaderError, markReaderContentReady, nextReaderGeneration, isReaderGenerationCurrent,
  reportNavigationError, disposeReader, fail
} = createReaderLifecycle(readerContext);

let {
  readerContentUrl, readerDownloadApiUrl, readerDownloadUrl, startReaderDownload,
  normalizeSourceUrl, resolveReaderId, applyReaderMetadata, normalizeReaderReturnUrl,
  applyReaderPathMetadata, validSource, validOcr,
  readerAssetObjectFamily, trustedReaderAssetManifestUrl, trustedChapterUrl, trustedChapterReferenceUrl,
  trustedChapterResourceUrl
} = createReaderSource(readerContext);

let {
  showDownloadFeedback, updateDocumentState, updatePanelState, applyPageInversion,
  applyReaderTheme, setZoom, emptyPanel, highlightPanelItem,
  filterPanel, notifyReaderUiState, setReaderPanelOpen, setPanelSearchOpen,
  selectPanel, renderHistory
} = createReaderUi(readerContext);

let {
  updateNavigationState, headingTocEntries, createHeadingLocationCache, syncHeadingLocation,
  navigateTocEntry, createTocRow, renderVirtualToc, setToc,
  cleanTocLabel, updateTocCurrentMark, syncTocTab
} = createReaderToc(readerContext);

let {
  updateSearchState, publishSearchResults, clearSearchHighlights, chapterSearchModule,
  searchChapterBook, navigateChapterSearchResult, fullSearchFoliateMatches, navigateFoliateSearchResult,
  searchReaderText
} = createReaderSearchBackends(readerContext);

let {
  pdfManifestPrefetchConcurrency, pdfManifestPrefetchMaxPages, canPrefetchPdfImages, cancelPdfManifestPrefetch,
  stopPdfManifestPrefetch, trimPdfManifestPrefetches, pdfPixelBudget, pdfSurfacePixels,
  pdfRetainedPixels, trimPdfSurfaces, clearPdfManifestPrefetches, takePdfManifestPrefetch,
  queuePdfManifestPrefetch, prioritizePdfManifestPrefetch, schedulePdfManifestPrefetch, trimPdfManifestImages,
  refreshNearbyPdfPages, scheduleVisiblePdfRenderReconciliation, cancelSpeculativePdfRenders, promotePdfRenderWaiter, acquirePdfPreviewSlot, releasePdfPreviewSlot, pdfPreviewLoads, acquirePdfRenderSlot,
  admitPdfRange, drainPdfRangeWaiters,
  releasePdfRenderSlot, acquirePdfTextSlot, drainPdfTextWaiters, releasePdfTextSlot,
  trimPdfCanvases, rerenderVisiblePdfPages, notePdfViewportMotion, pdfScrollActivity
} = createReaderPdfScheduler(readerContext);

let {
  beginReaderNavigation, clearReturnNavigation, isReaderOverlayFrame, navigateReaderFolder, turnViewport,
  handleReaderKeydown, handleReaderOutsideClick, readerPageScrollTop, goToPage, handleReaderPositionChange,
  navigateReader, notePdfScrollIntent, installReaderTapSelectionClear
} = createReaderNavigation(readerContext);

let {
  foliateSectionRoot, foliateSectionQuery, foliateSectionCandidates, syncFoliateScrollLocation,
  refreshFoliateWindow, scheduleFoliateWindowRefresh, trimFoliateSections, scheduleFoliateScrollSync,
  activateFoliateTocEntry, cloneFoliateDocument, foliateSearchAnchor, settleReaderImages,
  rewriteFoliateResources, createFoliateSection, setupFoliateWindow, foliateTocEntries,
  renderFoliate
} = createReaderFoliateFormat(readerContext);

let {
  scheduleSave, saveProgress, placeReadingProgress, currentReaderUrl,
  loadReaderRestoration, getInitialReaderRestoration, initialReaderPage, readerProgressPercent,
  pageAtMarker, syncCurrentPageFromMarker, scheduleMarkerSync, restoreFormat,
  restoreInitialPosition, applyInitialRestoration, updateReadingProgressSummary, updateProgressTools,
  captureProgressState, restoreProgressState, flushEpubSeek, seekProgress,
  activateChapter, adjacentTocIndex
} = createReaderProgress(readerContext);

let {
  consumeBookmarkHandoff, excerptFromCaret, bookmarkExcerpt, captureFoliateBookmarkPosition,
  restoreFoliateBookmarkPosition, seekFoliateProgress, renderBookmarks, captureBookmarkSnapshot,
  setBookmarkDialogModal, openBookmarkPopover, closeBookmarkPopover
} = createReaderBookmarks(readerContext);

let {
  formatMediaTime, renderImageDocument, renderMedia, loadSwfDocument,
  renderSwf
} = createReaderMediaFormat(readerContext);

let {
  loadScript, fetchWithReaderTimeout, retryableReaderProxyError, retryReaderProxy,
  fetchReaderUrl, fetchReaderResponse, prepareReaderDocument, readPreparedBytes,
  loadTextDocument, loadMarkdownDocument, loadHtmlDocument,
  loadMediaDocument, loadImageDocument, loadChapterManifestDocument
} = createReaderDocumentLoader(readerContext);

let {
  preloadPdfFirstPage, pdfManifestSource, pdfPageEntry, appendShellsBatched,
  pdfSelectionIntersects, correctPdfCrossPageSelection, createPdfShellWindow, startPdfHybridDocument,
  leavePdfHybridMode, loadPdfOutline, seedPdfPageGeometry, renderPdfPages, renderImagePages, renderPdf
} = createReaderPdfPageWindow(readerContext);

let {
  pdfOcrSource, v3ResourceUrl, createPdfV3Repository, readPdfOcrJson,
  loadPdfOcrManifest, loadPdfOcrPage, estimatePdfTextContentBytes, cachePdfTextContent,
  cachedPdfTextContent, loadPdfTextContent, estimatePdfOcrPageBytes, cachePdfOcrPage,
  cachedPdfOcrPage, renderPdfOcrText, renderPdfText, highlightPdfText
} = createReaderPdfTextRuntime(readerContext);

let {
  normalizeEpubDocument, sanitizeReaderDocument, sanitizeEpubDocument, sanitizeFoliateStyles, parseChapterDocument,
  epubContentBody, renderText, sanitizeOfflineHtml, buildDiscourseDocument,
  prepareHtmlDocument, buildHtmlFrameSource, waitForSpreadsheetImages, renderHtml,
  detectHtmlEncoding, repairHtmlContrast
} = createReaderHtmlFormat(readerContext);

let {
  setPdfPageLoadingState, isPdfPageVisible, pdfPagePriority, normalizePdfPriority,
  renderPdfInBackground, pdfPrimarySource, renderPdfManifestShell, renderHybridPdfCanvas,
  renderPdfImageShell, renderPdfShell, resetPdfLatencySamples, notePdfLatency, pdfHybridPreviewGrace,
  applyPdfShellGeometry, pdfHybridLookahead
} = createReaderPdfRenderer(readerContext);

let {
  renderPlainText, detectTextEncoding, renderTextDocument, renderMarkdownDocument
} = createReaderTextFormat(readerContext);

let {
  renderChapterManifest, captureChapterPosition, restoreChapterPosition
} = createReaderChapterFormat(readerContext);

let {
  disposeFormatResources, registerReaderFormatAdapters, resolveReaderSource, start,
  syncCapabilityControls
} = createReaderFormatController(readerContext);

let {
  loadPdfTaskWithTimeout, loadPdfWithTimeout, preloadPdfEngine, preparePdfWorker,
  preparePdfWorkerAttempt, loadPdfEngine, loadPdfDocument
} = createReaderPdfEngine(readerContext);

let {
  ensurePdfBookSearchClient, prefetchPdfBookSearch, schedulePdfBookSearchPrefetch, searchConcentratedPdf,
  makePdfSearchPageLoader, publishPdfSearchProgress, getPdfPersistentTextStore, cachePdfSearchText,
  loadPdfSearchText, fullSearchPdfMatches
} = createReaderPdfSearch(readerContext);
// Native reading (shared player in reader.html); installed once runtime exists.
const { installReaderSpeech } = createReaderSpeech(readerContext);

const pdfPageTimings = [];

// Engines and Reader lifecycle.
const PDFJS_URL = VoiceOfMLReaderResources.vendorUrl("pdf", "/search/static/");
const PDFJS_WORKER_URL = "/search/static/reader/pdf/pdf-worker-wrapper.mjs";
const PDFJS_WASM_URL = "/search/static/vendor/wasm/";
const PDFJS_CMAP_URL = "/search/static/vendor/cmaps/";
const PDFJS_STANDARD_FONT_URL = "/search/static/vendor/standard_fonts/";
const MARKED_URL = VoiceOfMLReaderResources.vendorUrl("marked", "/search/static/");
const PURIFY_URL = VoiceOfMLReaderResources.vendorUrl("purify", "/search/static/");
const RUFFLE_URL = VoiceOfMLReaderResources.vendors.ruffle.url;
const READER_PROXY_TIMEOUT_MS = 120000;
const readerRequestManager = VoiceOfMLReaderRequests.createReaderRequestManager();
const readerRuntime = VoiceOfMLReaderRuntime.createReaderRuntime();
const formatAdapters = VoiceOfMLReaderAdapters.createAdapterRegistry();
readerBindings.trackStartupOwners();
const readerAbortController = new AbortController();
const readerResources = new Set();

readerBindings.trackWorkCancellation();
const imageLoader = createReaderImageLoader({
  assertActive: assertReaderActive, abortError: readerAbortError, trackResource: trackReaderResource,
  request: fetchWithReaderTimeout, readBytes: response => VoiceOfMLReaderSecurity.readBytes(response),
  timeoutMs: READER_PROXY_TIMEOUT_MS
});
readerBindings.trackEarlySourceResolution();
const pdfDiagnostics = Object.freeze({snapshot:() => ({pages:pdfPageTimings.map(row=>({...row})), requests:pdfFetchPolicy?.timings || [], cache:pdfPersistentTextStore?.stats || null})});
readerBindings.publishDiagnosticsAndInstallCompatibility();
installReaderSpeech();
// Source metadata and session navigation.
// GitHub Pages serves assets under /search/ and delegates document requests to HF.
// Folder returns use hash routes; explicit folder URLs take precedence over resolved metadata.

const params = new URLSearchParams(location.search);
const readerId = params.get("id") || "";
let localReaderData = null;
readerBindings.readSelectedSourceSession();
let sourceUrl = normalizeSourceUrl(
  params.get("url") || (!readerId && localReaderData && localReaderData.url) || ""
);
let contentUrl = readerContentUrl(sourceUrl);
let downloadUrl =
  params.get("download") || (localReaderData && localReaderData.download) || sourceUrl;
let extension = (params.get("ext") || "").toLowerCase();
let chapterManifestUrl = params.get("chapter_manifest") || "";
let capability = readerRuntime.negotiate(VoiceOfMLReader.capability(extension));
readerBindings.normalizeConvertedPdfMode();
let resolvedReaderData = localReaderData;
let cachedReaderData = null;
let pdfFirstPagePreload = null;
let pdfFirstPagePreloadPage = 1;
let pdfEnginePreload = null;
let pdfWorker = null;
let releasePdfWorker = null;
readerBindings.applySourceSessionAndCachedMetadata();
const readerLifecycle = readerRuntime.state.lifecycle;
readerBindings.publishSourceAndSubscribeToStore();
const content = document.querySelector("#content");
readerBindings.initializePanelAccessibility();
const loadingIndicator = document.createElement("div");
readerBindings.mountInitialLoadingFeedback();
const status = document.querySelector("#status");
const loadingStatus = document.querySelector("#loading-status");

const downloadButton = document.querySelector("#download");
const downloadFeedback = document.querySelector("#download-feedback");
let readerSourcePromise = null;
let readerRestorationPromise = null;
let readerRestorationEntry = null;
let readerRestorationLoaded = false;
let downloadFeedbackTimer = 0;

readerBindings.bindDownloadAction();
const sourceName = (() => {
  try {
    const name = decodeURIComponent(
      new URL(sourceUrl, location.href).pathname.split("/").pop() || ""
    );
    return name.replace(/\.[^.]+$/, "") || "在线阅读";
  } catch (_) {
    return "在线阅读";
  }
})();
let chapterManifestObserver = null;
let contentSanitizerObserver = null;
const documentState = readerRuntime.state.document,
  navigationState = readerRuntime.state.navigation,
  searchState = readerRuntime.state.search,
  panelState = readerRuntime.state.panel;

readerBindings.initializeDocumentTitle();

const ocrUrl = params.get("ocr") || "";
let ocrManifestUrl = params.get("ocr_manifest") || "";

let returnUrl = params.get("return") || "";
const readerPathLabel = params.get("path") || "";
const folderReturnUrl = params.get("folder_url") || "";
let returnNavigationToken = params.get("nav") || "";
let returnNeedsReload = false;
readerBindings.restoreReturnNavigation();
const returnHistoryKey = returnNavigationToken ? `reader-return:${returnNavigationToken}` : "";
let canReturnWithHistory = false;
readerBindings.validateReturnHistory();
let saveTimer = 0;
let saveDeadline = 0;
let chapterManifestLoader = null;
let chapterSearchConfiguration = null;
let chapterSearchModulePromise = null;
let chapterSearchClient = null;

readerBindings.ownChapterSearchClient();
let folderNavigationTarget = null;
let bookmarkInvoker = null;
const bookmarkInertSiblings = new Map();
let pdfDocument = null;
let pdfPageManifest = null;
let pdfOcrManifest = null;
let pdfOcrManifestPromise = null;
let pdfV3Manifest = null, pdfV3Map = null, pdfV3Repository = null, pdfTextLayerRepository = null;
const pdfV3BlobReleases = new Set();
readerBindings.ownIndependentPdfResources();
let pdfHybridUrl = "", pdfHybridDocumentPromise = null, pdfHybridSearchUnavailable = false;
const pdfOcrPagePromises = new Map();
const pdfTextContentCache = new Map();
const pdfTextContentPromises = new Map();
const PDF_TEXT_CONTENT_CACHE_BYTES = 4 * 1024 * 1024;
let pdfTextContentCacheBytes = 0;
const pdfOcrPageCache = new Map();
const PDF_OCR_PAGE_CACHE_BYTES = 4 * 1024 * 1024;
let pdfOcrPageCacheBytes = 0;

let pdfBookSearchModulePromise = null;
let pdfBookSearchClient = null;
let pdfBookSearchPrefetchTimer = 0;
let pdfBookSearchPrefetchPromise = null;
// Do not silently download large full-book indexes just because a reader opened.
const PDF_BOOK_SEARCH_PREFETCH_MAX_BYTES = 8 * 1024 * 1024;
const PDF_BOOK_SEARCH_PREFETCH_DELAY = 6000;
readerBindings.ownPdfBookSearchClient();
let pdfActiveRenders = 0;
let pdfShellsReady = Promise.resolve();
let pdfShellWindow = null;
const pdfRenderWaiters = [];
let pdfActiveTextLoads = 0;
let pdfActiveSearchTextLoads = 0;
const pdfTextWaiters = [];
let pdfUserHasScrolled = false;
let pdfScrollDirection = 1;
let pdfLastScrollTop = 0;
const pdfManifestPrefetches = new Map();
const pdfManifestShells = [];
const PDF_MANIFEST_PREFETCH_LIMIT = 12;
const PDF_MANIFEST_PREFETCH_CONCURRENCY = 3;
// Keep the 12-page render cache; background prefetch stays a nearby window.
const PDF_MANIFEST_PREFETCH_MAX_PAGES = 48;
// Let a primary PDF win speculative pages before starting image-stream I/O.
// The visible page keeps its immediate image fallback.
const PDF_HYBRID_DOCUMENT_GRACE_MS = 5000;
let pdfManifestPrefetchTimer = 0;
let pdfManifestPrefetchNext = 0;
let pdfManifestPrefetchOrigin = 0;
const pdfManifestPrefetchActive = new Set();
let pdfManifestPrefetchCount = 0;
let pdfManifestPrefetchWrapped = false;

readerBindings.ownPdfPrefetchAndQueues();
let epubRendition = null;
let epubBook = null;
let foliateContinuous = false,
  foliateChapterRepository = null,
  foliateSectionVirtualizer = null,
  foliateSectionLoader = null,
  foliateSectionSettler = null,
  foliateSectionObserver = null,
  foliateScrollFrame = 0,
  foliateWindowFrame = 0;
let initialReaderTargetSection = null;
let chapterManifestCleanup = null;
const FOLIATE_PREFETCH_SECTIONS = 6;
const FOLIATE_PREFETCH_MARGIN = 4000;
const FOLIATE_LOADED_SECTION_LIMIT = 12;
const PDF_PREFETCH_MARGIN = 2400;
const TOC_VIRTUALIZATION_THRESHOLD = 500;
const TOC_VIRTUAL_ROW_HEIGHT = 40;
let tocVirtualState = null;
let htmlFrame = null;
let lastSavedProgress = "";
let progressSaveChain = Promise.resolve();
let historySuppressed = false;
let restorationFailed = false;
let markerFrame = 0;
let pageNavigationLockUntil = 0;
let pendingBookmarkSnapshot = null;
let mediaElement = null;
let swfPlayer = null;

readerBindings.initializeGenerations();

const viewport = document.querySelector("#viewport");
const zoomInput = document.querySelector("#zoom");
const pageInput = document.querySelector("#page-number");
const readerPath = document.querySelector("#reader-path");
const bookmarkRibbon = document.querySelector("#bookmark-ribbon");
const bookmarkPopover = document.querySelector("#bookmark-popover");
readerBindings.labelToolbarControls();

// A demanded TOC/search destination lands on the viewport's top edge. Measuring the
// element keeps that landing exact (scrollIntoView can also move ancestor scrollers),
// and it can be re-asserted once for a late layout shift.
const alignReaderDestination = (target, offset = 0) => {
  if (!target?.isConnected) return null;
  const delta = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset;
  if (Math.abs(delta) > 0.5) viewport.scrollTop += delta;
  return { target, offset, scrollTop: viewport.scrollTop };
};
const READER_REASSERT_SCROLL_LIMIT = 200;
const reassertReaderDestination = (landing) => {
  if (!landing?.target?.isConnected) return;
  if (Math.abs(viewport.scrollTop - landing.scrollTop) > READER_REASSERT_SCROLL_LIMIT) return;
  alignReaderDestination(landing.target, landing.offset);
};
// Chapters, images and placeholders above the destination keep changing height for a
// moment after a jump (a large book can double its height), so one correction is not
// enough: hold the destination on the landing line until the layout settles, a short
// budget ends, or the reader scrolls. User input is the only release signal: the browser
// adjusts scrollTop by itself while content above grows, so a scrollTop delta cannot
// distinguish that from a reader scroll.
// A jump has to survive slow layout: chapter images and lazy placeholders can take
// seconds to change height above the destination. Keep the destination on the landing
// line until the content box stops changing for a real pause, a hold budget ends, or the
// reader scrolls. Only real input releases early: the browser moves scrollTop itself while
// content above grows, so a scrollTop delta cannot distinguish that from a reader scroll.
const READER_HOLD_BUDGET_MS = 15000;
// Images and inserted chapters arrive in bursts seconds apart, so wait out a long gap
// before deciding the layout is final. Reader input still releases immediately.
const READER_HOLD_QUIET_MS = 2000;
let activeReaderDestinationHold = null;
const cancelReaderDestinationHold = () => activeReaderDestinationHold?.();
const holdReaderDestination = (target, offset = 0) => {
  // A newer navigation owns the viewport. Never let an older landing loop
  // pull the new destination back while it is still loading or settling.
  cancelReaderDestinationHold();
  if (!target?.isConnected) return () => {};
  const viewport = (target.ownerDocument === document
    ? document
    : target.ownerDocument.defaultView?.document)?.querySelector("#viewport");
  // Scroll the actual reading viewport; the landing line is its top edge.
  const scope = viewport || target.parentElement || document.body;
  const scopeTop = () => (viewport || scope).getBoundingClientRect().top;
  let frame = 0, released = false, lastChange = performance.now(), deadline = lastChange + READER_HOLD_BUDGET_MS;
  let lastScrollTop = scope.scrollTop;
  const listeners = [];
  const observers = [];
  const cleanupImages = [];
  const detach = () => {
    readerAbortController.signal.removeEventListener("abort", release);
    for (const [name, handler] of listeners) if (name) scope.removeEventListener?.(name, handler);
    for (const cleanup of cleanupImages) cleanup();
    listeners.length = 0;
    for (const observer of observers) observer.disconnect?.();
    observers.length = 0;
  };
  const release = () => {
    if (released) return;
    released = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    detach();
    if (activeReaderDestinationHold === release) activeReaderDestinationHold = null;
  };
  activeReaderDestinationHold = release;
  if (readerAbortController.signal.aborted) {
    release();
    return release;
  }
  readerAbortController.signal.addEventListener("abort", release, { once: true });
  for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    const handler = () => release();
    listeners.push([name, handler]);
    scope.addEventListener?.(name, handler, { passive: true });
  }
  const bump = () => { lastChange = performance.now(); };
  if (typeof ResizeObserver === "function") {
    const sizes = new ResizeObserver(bump);
    // Watch the scrolling content (the box that actually grows), not the viewport.
    const observed = new Set();
    const watch = (node) => {
      if (!node || observed.has(node) || observed.size >= 24) return;
      observed.add(node);
      sizes.observe(node);
    };
    watch(scope.firstElementChild);
    watch(scope);
    for (let node = target.parentElement; node && node !== scope; node = node.parentElement) watch(node);
    observers.push(sizes);
  }
  if (typeof MutationObserver === "function") {
    const mutations = new MutationObserver(bump);
    mutations.observe(scope, { childList: true, subtree: true, attributes: true });
    observers.push(mutations);
  }
  // A chapter image finishing changes the document position without resizing the
  // viewport element, so follow load/error on every image currently in the reader.
  for (const image of target.parentElement?.querySelectorAll("img") || []) {
    if (image.complete) continue;
    const handler = () => bump();
    image.addEventListener("load", handler, { once: true });
    image.addEventListener("error", handler, { once: true });
    cleanupImages.push(() => {
      image.removeEventListener("load", handler);
      image.removeEventListener("error", handler);
    });
  }
  if (cleanupImages.length) listeners.push([], []);
  const loop = () => {
    frame = 0;
    if (released) return;
    const now = performance.now();
    if (!target.isConnected || now >= deadline) return release();
    const delta = target.getBoundingClientRect().top - scopeTop() - offset;
    if (Math.abs(delta) > 0.5) {
      scope.scrollTop += delta;
      bump();
    } else if (now - lastChange >= READER_HOLD_QUIET_MS) {
      return release();
    } else if (Math.abs(scope.scrollTop - lastScrollTop) > 1) {
      // The browser re-anchored the view or a late insert moved it: keep holding.
      lastScrollTop = scope.scrollTop;
      bump();
    }
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);
  return release;
};

const foliateScrollAnchors = readerRuntime.track(
  VoiceOfMLReaderScroll.createScrollAnchorManager({
    viewport,
    candidates: foliateSectionCandidates
  })
);

readerBindings.applyMetadataAndWatchSanitizedContent();
const bookmarkLabelInput = document.createElement("input"),
  bookmarkExcerptInput = document.createElement("textarea"),
  bookmarkEditFields = document.createElement("div");
readerBindings.initializeBookmarkEditor();
const bookmarksAllButton = document.createElement("button");
readerBindings.initializeBookmarkSearchControls();
const bookmarksHeader = document.querySelector("#bookmarks-panel .panel-view-header"),
  bookmarksSearchButton = bookmarksHeader.querySelector(".panel-search-toggle"),
  bookmarksHeaderActions = document.createElement("span");
readerBindings.mountBookmarkHeaderActions();
const mediaTab = document.createElement("button"),
  mediaPanel = document.createElement("section");
readerBindings.mountMediaPanel();
// Theme, toolbar, and document navigation.
let readerTheme = "dark";
try { if (localStorage.getItem("theme") === "light") readerTheme = "light"; } catch (_) {}
const THEME_SUN_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
const THEME_MOON_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const readerThemeToggle = document.querySelector("#theme-toggle");
const pageInvertToggle = document.querySelector("#page-invert-toggle");
let pageInverted = false;
readerBindings.restoreAndBindPageInversion();
let themeAnimationTimer = 0;
readerBindings.restoreReaderThemeAndBindReturn();
let zoomChangedByUser = false;

const handlePageNavigationFailure = (error, generation) => {
  if (isReaderGenerationCurrent("navigation", generation) && error?.name !== "AbortError")
    fail("原文件加载失败，请检查网络后重试，或下载原文件。", "READER_NAVIGATION");
};
readerBindings.bindZoomAndPageControls();

let panelAnimationTimer = 0;
let readerPanelInteractionSerial = 0;
let readerUiHistoryState = "base";
readerBindings.bindReaderUiHistory();

let headingLocationCache = null;
readerBindings.bindPanelBookmarkAndLifecycleControls();
let pdfSelectionPointer = null;

readerBindings.bindPdfPointerSelection();
let pdfSelectionBoundaryUpdate = false;
readerBindings.bindSelectionAndPageLifecycle();

// HTML documents retain an isolated, script-free scroll window.

// Resolve once, then keep source URLs, capability, and presentation in sync.

// Foliate keeps a source-to-rendered text mapping because CFI addresses the
// original document, before sanitization and insertion into a shadow root.

// Reading progress controls and undo.
const progressTools = document.createElement("div");
readerBindings.mountProgressControls();
const readingProgressSummary = document.createElement("div");
readerBindings.mountProgressSummary();
const progressRange = progressTools.querySelector(".reader-progress-range"),
  progressPercent = progressTools.querySelector(".reader-progress-percent"),
  progressUndo = progressTools.querySelector(".reader-progress-undo"),
  chapterPrev = progressTools.querySelector(".reader-chapter-prev"),
  chapterNext = progressTools.querySelector(".reader-chapter-next");
let previousProgressState = null,
  progressSeeking = false,
  epubSeekFrame = 0,
  epubSeekTarget = null,
  epubSeekPromise = Promise.resolve();

readerBindings.bindProgressActions();
const domSearch = createReaderDomSearch({
  content, runtime: readerRuntime, isCurrent: isReaderGenerationCurrent,
  yieldTask: waitForReader, getTocEntries: () => navigationState.tocEntries,
  unwrapRoot: foliateSectionRoot,
  publishPage: (page, loader, partial) => {
    fullSearchSession.pageLoader = loader;
    fullSearchSession.page = page;
    if (partial) {
      updateSearchState({ results: page.results, index: -1 });
      renderFullSearchResults();
      fullSearchStatus.textContent = `${page.total} 个结果（正在搜索…）`;
    }
  }
});
readerBindings.ownDomSearchController();
const {
  search: fullSearchDomMatches, clearMarks: clearFullSearchMarks,
  highlight: highlightTextParts
} = domSearch;
const fullSearchController = createReaderSearchController({
  document, runtime: readerRuntime, signal: readerAbortController.signal,
  nextGeneration: () => nextReaderGeneration("search"),
  isCurrent: generation => isReaderGenerationCurrent("search", generation),
  updateSearch: updateSearchState,
  backend: {
    mode: () => capability.mode,
    search: searchReaderText,
    clearMarks: clearFullSearchMarks,
    chapterClient: () => chapterSearchClient,
    pdfClient: () => pdfBookSearchClient,
    chapterResult: result => ({ ...result,
      activate: generation => navigateChapterSearchResult(result, generation) }),
    activate: (result, generation) => result.cfi
      ? navigateFoliateSearchResult(result, generation) : result.activate(generation)
  },
  navigation: {
    begin: beginReaderNavigation,
    current: generation => isReaderGenerationCurrent("navigation", generation),
    reportError: reportNavigationError
  },
  panel: {
    isOpen: () => document.querySelector("#history-panel").classList.contains("is-open"),
    serial: () => readerPanelInteractionSerial,
    show: () => { setReaderPanelOpen(true); selectPanel("full-search"); },
    hide: () => selectPanel(mediaElement ? "media" : "toc"),
    close: () => setReaderPanelOpen(false, true),
    focus: () => { readerPanelInteractionSerial++; }
  }
});
readerBindings.ownSearchViewController();
const fullSearchSession = fullSearchController.state;
const {
  render: renderFullSearchResults, applyChapterPage: applyChapterSearchPage,
  run: runFullSearch, close: closeFullSearchView
} = fullSearchController;
const {
  view: fullSearchView, button: fullSearchButton, input: fullSearchInput,
  status: fullSearchStatus
} = fullSearchController.elements;
// Format-specific search backends publish through the shared controller.

const pdfSearchTextCache = new Map();
let pdfPersistentTextStore = null, pdfPersistentTextOpening = null, pdfPersistentTextVersion = null;

const PDF_SEARCH_TEXT_CACHE_BYTES = 8 * 1024 * 1024;
let pdfSearchTextCacheBytes = 0;

readerBindings.ownPdfSearchStorageAndStart();

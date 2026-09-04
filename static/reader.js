import "/search/static/reader-request-manager.js";
import "/search/static/reader-chapter-repository.js";
import "/search/static/reader-scroll-anchor.js";
import "/search/static/reader-section-virtualizer.js";
import "/search/static/reader-runtime.js";
import "/search/static/reader-format-adapters.js";
const PDFJS_URL = "/search/static/vendor/pdf.min.f80490490320.mjs";
const PDFJS_WORKER_URL = "/search/static/pdf-worker-wrapper.mjs";
const PDFJS_WASM_URL = "/search/static/vendor/wasm/";
const PDFJS_CMAP_URL = "/search/static/vendor/cmaps/";
const PDFJS_STANDARD_FONT_URL = "/search/static/vendor/standard_fonts/";
const MARKED_URL = "/search/static/vendor/marked.min.69451c8541c9.js";
const PURIFY_URL = "/search/static/vendor/purify.min.c2f26ea4fc0d.js";
const JSZIP_URL = "/search/static/vendor/jszip.min.acc7e41455a8.js";
const DOCX_PREVIEW_URL = "/search/static/vendor/docx-preview.min.051ef503f267.js";
const READER_PROXY_TIMEOUT_MS = 120000;
const readerRequestManager = VoiceOfMLReaderRequests.createReaderRequestManager();
const readerRuntime = VoiceOfMLReaderRuntime.createReaderRuntime();
const formatAdapters = VoiceOfMLReaderAdapters.createAdapterRegistry();
readerRuntime.track(readerRequestManager);
const PDF_PROXY_TIMEOUT_MS = 60000;
if (!Map.prototype.getOrInsertComputed) { Map.prototype.getOrInsertComputed = function(key, callback) { if (this.has(key)) return this.get(key); const value = callback(key); this.set(key, value); return value; }; }
if (!Math.sumPrecise) { Math.sumPrecise = function(values) { let sum = 0, correction = 0; for (const value of values) { const next = sum + value; correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum; sum = next; } return sum + correction; }; }
const params = new URLSearchParams(location.search), readerId = params.get("id") || ""; let localReaderData = null; try { localReaderData = JSON.parse(sessionStorage.getItem(`reader-source:${readerId}`) || "null"); if (localReaderData) sessionStorage.removeItem(`reader-source:${readerId}`); } catch (_) {} let sourceUrl = params.get("url") || (localReaderData && localReaderData.url) || "", contentUrl = `https://voiceofml-search.hf.space/api/reader-content?url=${encodeURIComponent(sourceUrl)}`, downloadUrl = params.get("download") || (localReaderData && localReaderData.download) || sourceUrl, extension = (params.get("ext") || "").toLowerCase(), chapterManifestUrl = params.get("chapter_manifest") || "", fallbackUrl = params.get("fallback") || "";
let capability = readerRuntime.negotiate(VoiceOfMLReader.capability(extension));
let resolvedReaderData = localReaderData;
if (localReaderData) { if (localReaderData.title) params.set("title", localReaderData.title); if (localReaderData.extension) params.set("ext", localReaderData.extension); if (localReaderData.repo) params.set("path", [localReaderData.repo, ...(localReaderData.folder || [])].join("/")); }
try { const cached = sessionStorage.getItem(`reader-resolve:${readerId}`); if (cached) { resolvedReaderData = JSON.parse(cached); sessionStorage.removeItem(`reader-resolve:${readerId}`); } } catch (_) {}
const readerLifecycle = readerRuntime.state.lifecycle;
readerRuntime.update("source", { id: readerId, url: sourceUrl, contentUrl, downloadUrl, extension, metadata: resolvedReaderData });
readerRuntime.events.on("phase", ({ phase }) => { document.documentElement.dataset.readerPhase = phase; });
const unsubscribeReaderStore = VoiceOfMLReaderStore.subscribe?.((change) => { if (!change?.remote || readerLifecycle.disposed) return; if (change.type === "history-clear" || change.type === "history-remove" || change.url === sourceUrl) { if (!document.querySelector("#history-panel").hidden) renderHistory(); } if ((change.type === "bookmark" || change.type === "bookmark-remove") && (!change.url || change.url === sourceUrl) && !document.querySelector("#bookmarks-panel").hidden) renderBookmarks(); });
function setReaderPhase(phase) { return readerRuntime.setPhase(phase); }
function setReaderStage(stage) { return readerRuntime.setStage(stage); }
function classifyReaderError(error, fallback = "READER_PARSE") { const value = `${error?.name || ""} ${error?.message || error || ""}`; if (/AbortError|timeout|network|fetch|HTTP\s*\d+/i.test(value)) return "READER_NETWORK"; if (/EPUB_INVALID|corrupt|damage|truncated|central directory|end of data|invalid zip/i.test(value)) return "READER_CORRUPT"; return fallback; }
setReaderPhase("startup");
window.fetchFile = async (url) => {
  const requestUrl = String(url) === sourceUrl ? contentUrl : url;
  const response = await fetch(requestUrl);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const fileName = new URL(url).pathname.split("/").pop() || "book";
  return new File([await response.blob()], fileName, { type: response.headers.get("content-type") || "application/octet-stream" });
};
let returnUrl = params.get("return") || "", returnNavigationToken = params.get("nav") || "", returnNeedsReload = false;
function normalizeReaderReturnUrl(rawUrl) { try { const target = new URL(rawUrl || "/search/", location.origin); if (target.origin === location.origin && target.pathname === "/") return new URL("/search/", location.origin).href; return target.href; } catch (_) { return new URL("/search/", location.origin).href; } }
try { const state = history.state, saved = JSON.parse(sessionStorage.getItem("reader-navigation-current") || "null"); let stateUrl = state && state.voiceReaderOverlay && state.readerUrl ? new URL(state.readerUrl, location.origin) : null; if (!stateUrl && saved && saved.shareUrl === location.href && saved.readerUrl) stateUrl = new URL(saved.readerUrl, location.origin); const cleanStateUrl = stateUrl && new URL(stateUrl.href); if (cleanStateUrl) { cleanStateUrl.searchParams.delete("return"); cleanStateUrl.searchParams.delete("nav"); } if (stateUrl && stateUrl.origin === location.origin && stateUrl.pathname === "/search/static/reader.html" && cleanStateUrl.href === location.href) { if (!returnUrl) returnUrl = stateUrl.searchParams.get("return") || ""; if (!returnNavigationToken) returnNavigationToken = stateUrl.searchParams.get("nav") || ""; returnNeedsReload = true; } } catch (_) {}
 let sourceName = (() => { try { const name = decodeURIComponent(new URL(sourceUrl, location.href).pathname.split("/").pop() || ""); return name.replace(/\.[^.]+$/, "") || "在线阅读"; } catch (_) { return "在线阅读"; } })(), content = document.querySelector("#content"), status = document.querySelector("#status"), title = params.get("title") || sourceName, ocrUrl = params.get("ocr") || "", readerPathLabel = params.get("path") || "", folderReturnUrl = params.get("folder_url") || "", returnHistoryKey = returnNavigationToken ? "reader-return:" + returnNavigationToken : ""; const loadingIndicator = document.createElement("div"); loadingIndicator.className = "reader-loading-indicator"; loadingIndicator.setAttribute("role", "status"); loadingIndicator.innerHTML = '<span class="reader-loading-spinner" aria-hidden="true"></span><span>正在加载正文...</span>'; content.appendChild(loadingIndicator);
title = String(title).trim() || sourceName;
function applyReaderMetadata(data) { if (!data) return; resolvedReaderData = { ...(resolvedReaderData || {}), ...data }; applyReaderPathMetadata(resolvedReaderData); const originalTitle = String(resolvedReaderData.title || "").trim(), originalExtension = String(resolvedReaderData.original_extension || "").toLowerCase().replace(/^\./, ""); if (originalTitle) { title = originalTitle + (originalExtension && !originalTitle.toLowerCase().endsWith(`.${originalExtension}`) ? `.${originalExtension}` : ""); document.querySelector("#title").textContent = title; document.title = `${title} - VoiceOfML Reader`; } }
content.dataset.mode = capability.mode || "unsupported";
let canReturnWithHistory = false;
try { const target = new URL(returnUrl, location.origin), storedReturnUrl = returnHistoryKey ? sessionStorage.getItem(returnHistoryKey) : ""; canReturnWithHistory = !!returnHistoryKey && storedReturnUrl === target.href; } catch (_) {}
let zoom = Math.min(4, Math.max(0.25, Number(localStorage.getItem("reader-zoom") || 100) / 100));
let currentPage = 1, pageCount = 0, restoredEntry = null, saveTimer = 0;
let restorationApplied = false;
let pdfDocument = null, pdfPageManifest = null, pdfRenderGeneration = 0, pdfActiveRenders = 0, pdfShellsReady = Promise.resolve(), epubRendition = null, epubBook = null, epubLocation = "", epubProgress = 0, htmlFrame = null, foliateContinuous = false, foliateChapterRepository = null, foliateSectionVirtualizer = null, foliateSectionLoader = null, foliateSectionSettler = null, foliateSectionObserver = null, foliateScrollFrame = 0;
const pdfRenderWaiters = [];
let lastSavedProgress = "", progressSaveChain = Promise.resolve();
let historySuppressed = false, restorationReady = false, restorationFailed = false, markerFrame = 0, tocEntries = [], currentChapterIndex = -1, navigationGeneration = 0, pendingBookmarkSnapshot = null, editingBookmark = null, showingAllBookmarks = false, bookmarkRenderGeneration = 0, fullSearchGeneration = 0, mediaElement = null;
function nextReaderGeneration(name) { const value = readerRuntime.nextGeneration(name); if (name === "navigation") navigationGeneration = value; else if (name === "search") fullSearchGeneration = value; else if (name === "bookmarks") bookmarkRenderGeneration = value; else if (name === "pdf") pdfRenderGeneration = value; return value; }
function isReaderGenerationCurrent(name, value) { return readerRuntime.isCurrent(name, value); }
function syncReaderState() { readerRuntime.update("document", { title, zoom, page: currentPage, pageCount, restoredEntry, restorationReady }); readerRuntime.update("navigation", { tocEntries, currentChapterIndex }); readerRuntime.update("search", { results: typeof fullSearchResults === "undefined" ? [] : fullSearchResults, index: typeof fullSearchIndex === "undefined" ? -1 : fullSearchIndex }); readerRuntime.update("panel", { showingAllBookmarks, editingBookmark }); readerRuntime.updateFormat("pdf", { document: pdfDocument, manifest: pdfPageManifest, activeRenders: pdfActiveRenders }); readerRuntime.updateFormat("foliate", { rendition: epubRendition, book: epubBook, continuous: foliateContinuous, repository: foliateChapterRepository, virtualizer: foliateSectionVirtualizer }); readerRuntime.updateFormat("html", { frame: htmlFrame }); readerRuntime.updateFormat("media", { element: mediaElement }); }
for (const generationName of ["navigation", "search", "bookmarks", "pdf"]) nextReaderGeneration(generationName);
const viewport = document.querySelector("#viewport"), zoomInput = document.querySelector("#zoom"), pageInput = document.querySelector("#page-number"), loadingStatus = document.querySelector("#loading-status"), readerPath = document.querySelector("#reader-path"), bookmarkRibbon = document.querySelector("#bookmark-ribbon"), bookmarkPopover = document.querySelector("#bookmark-popover"); loadingStatus.textContent = "";
function foliateSectionRoot(article) { return article?.shadowRoot || article; }
function foliateSectionQuery(article, selector) { return foliateSectionRoot(article)?.querySelector(selector) || null; }
function foliateSectionCandidates() { return [...content.querySelectorAll(".foliate-continuous > article[data-section]:not(.foliate-section-placeholder)")].flatMap((article) => [article, ...foliateSectionRoot(article).querySelectorAll(":is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,img,table)")]); }
const foliateScrollAnchors = readerRuntime.track(VoiceOfMLReaderScroll.createScrollAnchorManager({ viewport, candidates: foliateSectionCandidates }));
function applyReaderPathMetadata(data) { if (!data) return; const folder = Array.isArray(data.folder) ? data.folder.join("/") : String(data.folder || ""), value = String(data.path || [data.repo, folder].filter(Boolean).join("/")).replace(/^\/+|\/+$/g, ""); if (value) { readerPath.textContent = value; readerPath.hidden = false; readerPath.setAttribute("aria-label", `筛选文件夹：${value}`); } }
applyReaderMetadata(resolvedReaderData);
new MutationObserver(() => { const seen = new Set(); for (const article of document.querySelectorAll(".foliate-continuous > article[data-section]")) { article.querySelectorAll("style,link[rel=stylesheet]").forEach((node) => node.remove()); const index = article.dataset.section; if (seen.has(index)) article.remove(); else seen.add(index); } }).observe(content, { childList: true, subtree: true });
bookmarkPopover.className = "bookmark-popover"; bookmarkPopover.setAttribute("role", "dialog"); bookmarkPopover.setAttribute("aria-modal", "true");
document.querySelector(".reader-panel-tabs")?.setAttribute("role", "tablist");
const bookmarksAllButton = document.createElement("button"), bookmarksHeader = document.querySelector("#bookmarks-panel .panel-view-header"), bookmarksSearchButton = bookmarksHeader.querySelector(".panel-search-toggle"), bookmarksHeaderActions = document.createElement("span"); bookmarksAllButton.id = "bookmarks-all"; bookmarksAllButton.className = "text-action"; bookmarksAllButton.type = "button"; bookmarksAllButton.textContent = "全部书签"; bookmarksAllButton.setAttribute("aria-pressed", "false"); bookmarksHeaderActions.append(bookmarksAllButton, bookmarksSearchButton); bookmarksHeader.appendChild(bookmarksHeaderActions);
const bookmarkLabelInput = document.createElement("input"), bookmarkExcerptInput = document.createElement("textarea"), bookmarkEditFields = document.createElement("div"); bookmarkLabelInput.id = "bookmark-label"; bookmarkLabelInput.maxLength = 120; bookmarkExcerptInput.id = "bookmark-excerpt-input"; bookmarkExcerptInput.maxLength = 500; bookmarkExcerptInput.rows = 3; bookmarkEditFields.className = "bookmark-edit-fields"; bookmarkEditFields.innerHTML = "<label>标题</label><label>摘要</label>"; bookmarkEditFields.children[0].appendChild(bookmarkLabelInput); bookmarkEditFields.children[1].appendChild(bookmarkExcerptInput); bookmarkPopover.insertBefore(bookmarkEditFields, bookmarkPopover.querySelector("div"));
const mediaTab = document.createElement("button"), mediaPanel = document.createElement("section"); mediaTab.id = "media-tab"; mediaTab.type = "button"; mediaTab.role = "tab"; mediaTab.dataset.panel = "media"; mediaTab.textContent = "播放"; mediaTab.hidden = !capability.features.media; mediaPanel.id = "media-panel"; mediaPanel.className = "reader-panel-view"; mediaPanel.dataset.panelView = "media"; mediaPanel.hidden = true; mediaPanel.innerHTML = '<div class="media-panel-content"><strong>播放状态</strong><span class="media-panel-time">尚未播放</span><button class="text-action media-panel-bookmark" type="button">在当前时间添加书签</button></div>'; document.querySelector(".reader-panel-tabs").prepend(mediaTab); document.querySelector("#history-panel").insertBefore(mediaPanel, document.querySelector("#toc-panel")); mediaPanel.querySelector(".media-panel-bookmark").addEventListener("click", () => bookmarkRibbon.click());
const loadingObserver = new MutationObserver(() => { if (content.querySelector(".reader-page, .reader-image, .reader-audio, .reader-video, .reader-text, .reader-markdown, .html-frame, .docx-body")) { loadingIndicator.remove(); loadingObserver.disconnect(); } }); loadingObserver.observe(content, { childList: true });
document.querySelector(".page-controls").hidden = !capability.features.pagination;
document.querySelector(".zoom-controls").hidden = !capability.features.zoom;
document.querySelector("#title").textContent = title + (extension && !title.toLowerCase().endsWith(`.${extension}`) ? `.${extension}` : ""); readerPath.textContent = readerPathLabel; readerPath.hidden = !readerPathLabel; status.hidden = true; document.title = title + " - VoiceOfML Reader";
new MutationObserver(() => { title = document.querySelector("#title").textContent; }).observe(document.querySelector("#title"), { childList: true });
function syncOriginalTitle() { const data = resolvedReaderData, node = document.querySelector("#title"); if (!data || !data.title || !data.original_extension || !node) return; const extension = String(data.original_extension).toLowerCase(), originalTitle = String(data.title).trim(), value = originalTitle + (originalTitle.toLowerCase().endsWith(`.${extension}`) ? "" : `.${extension}`); if (node.textContent !== value) node.textContent = value; }
new MutationObserver(syncOriginalTitle).observe(document.querySelector("#title"), { childList: true });
let readerTheme = localStorage.getItem("theme") === "light" ? "light" : "dark";
const THEME_SUN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>', THEME_MOON_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const readerThemeToggle = document.querySelector("#theme-toggle"); let themeAnimationTimer = 0;
  function applyReaderTheme(theme, persist = true, animate = true) { const anchor = foliateScrollAnchors.capture(); if (animate) { clearTimeout(themeAnimationTimer); document.documentElement.classList.add("theme-transition"); void document.documentElement.offsetWidth; } readerTheme = theme === "light" ? "light" : "dark"; document.documentElement.dataset.theme = readerTheme; readerThemeToggle.innerHTML = readerTheme === "dark" ? THEME_MOON_ICON : THEME_SUN_ICON; if (animate) { readerThemeToggle.classList.remove("is-changing"); void readerThemeToggle.offsetWidth; readerThemeToggle.classList.add("is-changing"); themeAnimationTimer = setTimeout(() => { document.documentElement.classList.remove("theme-transition"); readerThemeToggle.classList.remove("is-changing"); }, 280); } readerThemeToggle.title = readerTheme === "dark" ? "切换到白天模式" : "切换到夜间模式"; readerThemeToggle.setAttribute("aria-label", readerThemeToggle.title); readerThemeToggle.setAttribute("aria-pressed", String(readerTheme === "light")); const docxBody = content.querySelector(".docx-body"); if (docxBody) docxBody.classList.toggle("reader-document-dark", readerTheme === "dark"); if (epubRendition && epubRendition.setReaderTheme) epubRendition.setReaderTheme(readerTheme); else if (epubRendition && epubRendition.themes) epubRendition.themes.select(readerTheme === "dark" ? "reader-dark" : "reader-light"); if (persist) localStorage.setItem("theme", readerTheme); foliateScrollAnchors.restore(anchor); }
 applyReaderTheme(readerTheme, false, false); readerThemeToggle.innerHTML = readerTheme === "dark" ? THEME_MOON_ICON : THEME_SUN_ICON;
try { const folderTarget = new URL(folderReturnUrl, location.origin); if (readerPathLabel && folderTarget.origin === location.origin && folderTarget.pathname === "/search/" && folderTarget.hash.startsWith("#/")) { readerPath.textContent = readerPathLabel; readerPath.setAttribute("aria-label", `筛选文件夹：${readerPathLabel}`); readerPath.hidden = false; status.hidden = true; readerPath.addEventListener("click", () => { if (window.parent !== window) { window.parent.postMessage({ type: "voice-reader-navigate", url: folderTarget.href }, location.origin); return; } clearReturnNavigation(); location.assign(folderTarget.href); }); } } catch (_) {}
function clearReturnNavigation() { try { if (returnHistoryKey) sessionStorage.removeItem(returnHistoryKey); const saved = JSON.parse(sessionStorage.getItem("reader-navigation-current") || "null"); if (saved && (saved.readerUrl === location.href || saved.shareUrl === location.href)) sessionStorage.removeItem("reader-navigation-current"); } catch (_) {} }
document.querySelector("#back").addEventListener("click", async () => { clearTimeout(saveTimer); await Promise.race([saveProgress(), new Promise((resolve) => setTimeout(resolve, 300))]); if (window.parent !== window) { window.parent.postMessage({ type: "voice-reader-close" }, location.origin); return; } clearReturnNavigation(); try { const target = new URL(normalizeReaderReturnUrl(returnUrl), location.origin); if (target.origin === location.origin) { if (returnNeedsReload) location.replace(target.href); else if (canReturnWithHistory && history.length > 1) history.back(); else location.assign(target.href); return; } } catch (_) {} location.assign("/search/"); });
function setZoom(percent, persist = true) { const anchor = foliateScrollAnchors.capture(), normalized = VoiceOfMLReader.clampNumber(percent, 25, 400, 100), horizontalCenter = viewport.scrollWidth ? (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth : 0; zoom = normalized / 100; readerRuntime.update("document", { zoom }); content.style.setProperty("--reader-zoom", String(zoom)); zoomInput.value = String(normalized); if (epubRendition && epubRendition.themes) epubRendition.themes.fontSize(`${normalized}%`); if (htmlFrame && htmlFrame.contentDocument) htmlFrame.contentDocument.documentElement.style.zoom = String(zoom); if (pdfDocument) rerenderVisiblePdfPages(); viewport.scrollLeft = horizontalCenter * viewport.scrollWidth - viewport.clientWidth / 2; localStorage.setItem("reader-zoom", String(normalized)); foliateScrollAnchors.restore(anchor); if (persist) scheduleSave(); }
const handlePageNavigationFailure = () => fail("原文件加载失败，请检查网络后重试，或下载原文件。", "READER_NAVIGATION");
 setZoom(zoom * 100, false); for (const [id, delta] of [["#zoom-out", -10], ["#zoom-in", 10]]) document.querySelector(id).addEventListener("click", () => setZoom(Number(zoomInput.value) + delta));
zoomInput.addEventListener("change", () => setZoom(zoomInput.value)); zoomInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { setZoom(zoomInput.value); zoomInput.blur(); } });
pageInput.addEventListener("change", () => goToPage(pageInput.value).catch(handlePageNavigationFailure)); pageInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { goToPage(pageInput.value).catch(handlePageNavigationFailure); pageInput.blur(); } });
function turnViewport(direction) { const amount = Math.max(160, viewport.clientHeight * 0.86) * direction; if (htmlFrame?.contentWindow) htmlFrame.contentWindow.scrollBy({ top: amount, behavior: "smooth" }); else viewport.scrollBy({ top: amount, behavior: "smooth" }); }
document.addEventListener("keydown", event => { if (event.defaultPrevented || event.target.matches("input,textarea,select,button,a")) return; if (event.key === "PageDown" || event.key === " " || event.key === "ArrowDown") { event.preventDefault(); turnViewport(1); } else if (event.key === "PageUp" || event.key === "ArrowUp") { event.preventDefault(); turnViewport(-1); } });
document.querySelector("#page-prev").addEventListener("click", () => pageCount ? goToPage(currentPage - 1).catch(handlePageNavigationFailure) : turnViewport(-1)); document.querySelector("#page-next").addEventListener("click", () => pageCount ? goToPage(currentPage + 1).catch(handlePageNavigationFailure) : turnViewport(1));
async function goToPage(value) { if (!pageCount) return; const page = VoiceOfMLReader.clampNumber(value, 1, pageCount, 1); await pdfShellsReady; const shell = content.querySelector(`.reader-page[data-page="${page}"], .reader-docx-page[data-page="${page}"]`); if (shell) { if (shell.classList.contains("reader-page")) await renderPdfShell(shell, false, true); shell.scrollIntoView({ block: "start" }); if (!restorationApplied && restoredEntry && page === restoredEntry.page && restoredEntry.pageOffset) { viewport.scrollTop += restoredEntry.pageOffset; restorationApplied = true; } } currentPage = page; readerRuntime.update("document", { page: currentPage, pageCount }); pageInput.value = String(page); scheduleSave(); }
function scheduleSave() { if (readerLifecycle.disposed) return; readerRuntime.cancel(saveTimer); saveTimer = readerRuntime.schedule(saveProgress, 500); }
async function saveProgress() {
  if (readerLifecycle.disposed || !restorationReady || !validSource(sourceUrl) || historySuppressed) return;
  syncReaderState();
  syncCurrentPageFromMarker();
  const shell = pageCount
      ? content.querySelector(
          `.reader-page[data-page="${currentPage}"], .reader-docx-page[data-page="${currentPage}"]`,
        )
      : null,
    pageOffset = shell ? Math.max(0, viewport.scrollTop - shell.offsetTop) : 0,
    htmlScrollTop =
      htmlFrame && htmlFrame.contentWindow
        ? htmlFrame.contentWindow.scrollY
        : 0,
    readerUrl = new URL(location.href);
  readerUrl.searchParams.delete("return");
  readerUrl.searchParams.delete("nav");
  const foliatePosition = captureFoliateBookmarkPosition(), progress = {
      url: sourceUrl,
      title,
      extension,
      readerUrl: readerUrl.href,
      page: currentPage,
      pageCount,
      pageOffset,
      epubLocation,
      mediaTime:
        mediaElement && Number.isFinite(mediaElement.currentTime)
          ? mediaElement.currentTime
          : 0,
      scrollTop: viewport.scrollTop,
      htmlScrollTop,
      zoom: Math.round(zoom * 100),
      ...(foliatePosition || {}),
    },
    signature = JSON.stringify(progress);
  if (signature === lastSavedProgress) return progressSaveChain;
  lastSavedProgress = signature;
  progressSaveChain = progressSaveChain
    .catch(() => {})
    .then(() =>
      VoiceOfMLReaderStore.put({ ...progress, lastReadAt: Date.now() }),
    )
    .catch((error) => {
      if (lastSavedProgress === signature) lastSavedProgress = "";
      console.warn("Reader progress was not saved", error);
    });
  return progressSaveChain;
}
function emptyPanel(list, message) {
  list.innerHTML = `<div class="panel-empty">${message}</div>`;
}
function clearSearchHighlights(view) {
  for (const mark of view.querySelectorAll("mark.search-match"))
    mark.replaceWith(mark.textContent);
  view.normalize();
}
function highlightPanelItem(item, query) { const nodes = [], walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT), pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"); while (walker.nextNode()) if (!walker.currentNode.parentElement.closest(".panel-item-remove")) nodes.push(walker.currentNode); for (const node of nodes) { const text = node.data, matches = [...text.matchAll(pattern)]; if (!matches.length) continue; let start = 0; const fragment = document.createDocumentFragment(); for (const match of matches) { fragment.append(text.slice(start, match.index)); const mark = document.createElement("mark"); mark.className = "search-match"; mark.textContent = match[0]; fragment.append(mark); start = match.index + match[0].length; } fragment.append(text.slice(start)); node.replaceWith(fragment); } }
function filterPanel(view) { clearSearchHighlights(view); const query = (view.querySelector(".panel-search").value || "").trim().toLowerCase(); for (const item of view.querySelectorAll(".panel-item")) { const searchableText = [...item.children].filter((child) => !child.classList.contains("panel-item-remove")).map((child) => child.textContent).join(" ").toLowerCase(); item.hidden = !!query && !searchableText.includes(query); if (query && !item.hidden) highlightPanelItem(item, query); } }
let panelAnimationTimer = 0;
function setReaderPanelOpen(open, restoreFocus = false) { const panel = document.querySelector("#history-panel"), trigger = document.querySelector("#history"); readerRuntime.update("panel", { open }); clearTimeout(panelAnimationTimer); trigger.setAttribute("aria-expanded", String(open)); if (open) { panel.hidden = false; void panel.offsetWidth; panel.classList.add("is-open"); selectPanel(mediaElement ? "media" : "toc"); return; } panel.classList.remove("is-open"); panelAnimationTimer = setTimeout(() => { if (!panel.classList.contains("is-open")) panel.hidden = true; }, 250); if (restoreFocus) trigger.focus({ preventScroll: true }); }
function setPanelSearchOpen(button, open) { const input = button.closest(".reader-panel-view").querySelector(".panel-search"); button.setAttribute("aria-expanded", String(open)); if (open) { input.hidden = false; void input.offsetWidth; input.classList.add("is-open"); input.focus(); return; } input.classList.remove("is-open"); setTimeout(() => { if (!input.classList.contains("is-open")) input.hidden = true; }, 190); button.focus(); }
function selectPanel(name) { if (name === "media" && mediaTab.hidden) name = "bookmarks"; readerRuntime.update("panel", { selected: name }); if (typeof progressTools !== "undefined") progressTools.hidden = !["toc", "media"].includes(name); for (const button of document.querySelectorAll(".reader-panel-tabs button")) { const selected = button.dataset.panel === name; button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1; } for (const view of document.querySelectorAll(".reader-panel-view")) view.hidden = view.dataset.panelView !== name; if (name === "bookmarks") renderBookmarks(); if (name === "history") renderHistory(); if (name === "media" && mediaElement) mediaPanel.querySelector(".media-panel-time").textContent = `${formatMediaTime(mediaElement.currentTime)} / ${formatMediaTime(mediaElement.duration)}`; }
async function navigateTocEntry(index) { if (index < 0 || index >= tocEntries.length) return; const generation = nextReaderGeneration("navigation"), entry = tocEntries[index]; currentChapterIndex = index; try { if (foliateContinuous) await activateFoliateTocEntry(entry, generation); else { await entry.activate(); if (isReaderGenerationCurrent("navigation", generation)) setReaderPanelOpen(false, true); } } catch (error) { if (isReaderGenerationCurrent("navigation", generation)) console.warn("Reader navigation failed", error); } }
function setToc(entries) { tocEntries = (entries || []).map((entry) => ({ ...entry, href: String(entry.href || ""), label: cleanTocLabel(entry.label) })); currentChapterIndex = tocEntries.length ? 0 : -1; const tocTab = document.querySelector("#toc-tab"); tocTab.hidden = false; tocTab.textContent = tocEntries.length ? "目录" : "阅读"; const previous = document.querySelector("#toc-list"), list = previous.cloneNode(false); previous.replaceWith(list); for (const [index, entry] of tocEntries.entries()) { const row = document.createElement("div"); row.className = "panel-item toc-item"; row.style.setProperty("--toc-depth", String(entry.depth || 0)); const link = document.createElement("div"); link.className = "panel-item-main"; link.tabIndex = 0; link.setAttribute("role", "link"); link.textContent = entry.label; const activate = () => { if (!getSelection().toString()) navigateTocEntry(index); }; link.addEventListener("click", activate); link.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } }); row.appendChild(link); list.appendChild(row); } }
function cleanTocLabel(value) { return String(value || "未命名章节").replace(/[\uFFFD\u2610-\u2612\u25a1\u0000-\u001F\u007F]/gu, "").replace(/\s{2,}/gu, " ").trim() || "未命名章节"; }
function sameEpubPath(left, right) { try { left = decodeURIComponent(left); right = decodeURIComponent(right); } catch (_) {} return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`); }
function updateTocCurrentMark() { const rows = [...document.querySelectorAll("#toc-list .toc-item")]; if (pageCount > 1 && currentPage > 0) { let pageIndex = -1; for (const [index, row] of rows.entries()) { const match = row.textContent.match(/第\s*(\d+)\s*页/u); if (match && Number(match[1]) <= currentPage) pageIndex = index; } if (pageIndex >= 0) currentChapterIndex = pageIndex; } for (const [index, row] of rows.entries()) { let mark = row.querySelector(".toc-current-mark"); if (!mark) { mark = document.createElement("span"); mark.className = "toc-current-mark"; mark.textContent = "✓"; row.appendChild(mark); } mark.hidden = index !== currentChapterIndex; row.classList.toggle("is-current", index === currentChapterIndex); } }
function syncEpubTocLocation(location) { const href = location && location.start && String(location.start.href || "").split("#")[0]; if (!href) return; const index = tocEntries.findIndex((entry) => sameEpubPath(String(entry.href || "").split("#")[0], href)); if (index >= 0) { currentChapterIndex = index; updateTocCurrentMark(); } }
function syncFoliateScrollLocation() { if (!foliateContinuous || !tocEntries.length) return; const rows = [...document.querySelectorAll(".foliate-continuous article[data-section]")], top = viewport.getBoundingClientRect().top + 80; let sectionIndex = -1, sectionNode = null; for (const row of rows) if (row.getBoundingClientRect().top <= top) { sectionIndex = Number(row.dataset.section); sectionNode = row; } if (!sectionNode) return; let best = -1; for (const [index, entry] of tocEntries.entries()) { if (entry.sectionIndex !== sectionIndex) continue; let position = sectionNode.getBoundingClientRect().top; if (entry.fragment) { const anchor = foliateSectionQuery(sectionNode, `[id="${CSS.escape(entry.fragment)}"], [name="${CSS.escape(entry.fragment)}"]`); if (anchor) position = anchor.getBoundingClientRect().top; } if (position <= top || best < 0) best = index; } if (best >= 0 && best !== currentChapterIndex) { currentChapterIndex = best; updateTocCurrentMark(); updateProgressTools(); } }
function scheduleFoliateScrollSync() { if (foliateScrollFrame) return; foliateScrollFrame = requestAnimationFrame(() => { foliateScrollFrame = 0; syncFoliateScrollLocation(); const marker = viewport.getBoundingClientRect().top + 80, rows = [...document.querySelectorAll(".foliate-continuous article[data-section]")], current = rows.find((row) => { const rect = row.getBoundingClientRect(); return rect.top <= marker && rect.bottom > marker; }) || rows.find((row) => row.getBoundingClientRect().top > marker); if (current) foliateSectionVirtualizer?.trim(Number(current.dataset.section)); }); }
async function activateFoliateTocEntry(entry, generation = nextReaderGeneration("navigation")) { const href = String(entry.href || ""), target = await epubRendition?.book?.resolveHref(href), section = target && epubRendition.book.sections[target.index], sections = epubRendition.book.sections.filter((item) => item.linear !== "no"), visibleIndex = section ? sections.indexOf(section) : -1; if (!section || visibleIndex < 0) return; let node = document.querySelector(`.foliate-continuous > article[data-section="${visibleIndex}"]:not(.foliate-section-placeholder)`); if (!node && foliateSectionLoader) node = await foliateSectionLoader(visibleIndex); if (foliateSectionSettler) await foliateSectionSettler(); if (!node || !isReaderGenerationCurrent("navigation", generation)) return; const root = foliateSectionRoot(node), anchorDocument = { getElementById: (id) => root.querySelector(`[id="${CSS.escape(id)}"]`), querySelector: (selector) => root.querySelector(selector) }; let anchor = null; try { anchor = typeof target.anchor === "function" ? target.anchor(anchorDocument) : null; } catch (_) {} if (!anchor) { const fragment = href.split("#")[1] || "", id = fragment ? decodeURIComponent(fragment) : ""; anchor = id ? root.querySelector(`[id="${CSS.escape(id)}"], [name="${CSS.escape(id)}"]`) : null; } if (!isReaderGenerationCurrent("navigation", generation)) return; const destination = anchor || node; foliateScrollAnchors.invalidate(); viewport.scrollTop = Math.max(0, viewport.scrollTop + destination.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 8); currentChapterIndex = tocEntries.indexOf(entry); updateTocCurrentMark(); setReaderPanelOpen(false, true); }
document.addEventListener("click", async (event) => { const path = event.composedPath(), link = path.find((node) => node instanceof Element && node.matches?.("a[href]")), article = path.find((node) => node instanceof Element && node.matches?.(".foliate-continuous article[data-section]")); if (!link || !article || !epubRendition?.book) return; const raw = link.getAttribute("href") || ""; if (!raw || epubRendition.book.isExternal?.(raw) || /^(?:https?:|mailto:|tel:)/i.test(raw)) return; event.preventDefault(); const generation = nextReaderGeneration("navigation"), index = Number(article.dataset.section), section = epubRendition.book.sections.filter((item) => item.linear !== "no")[index]; let href = raw; try { href = section?.resolveHref?.(raw) || raw; } catch (_) {} try { await activateFoliateTocEntry({ href }, generation); } catch (error) { if (isReaderGenerationCurrent("navigation", generation)) console.warn("Reader navigation failed", error); } });
function placeReadingProgress() { const panel = document.querySelector("#history-panel"), tocPanel = document.querySelector("#toc-panel"), tocList = tocPanel.querySelector(".panel-list"), noToc = loadingStatus.hidden && !tocEntries.length && !mediaElement; progressTools.classList.toggle("reader-no-toc", noToc); tocPanel.querySelector(".panel-view-header strong").textContent = noToc ? "阅读状态" : "目录"; if (noToc && (progressTools.parentElement !== tocPanel || progressTools.nextElementSibling !== tocList)) tocPanel.insertBefore(progressTools, tocList); else if (!noToc && panel.lastElementChild !== progressTools) panel.appendChild(progressTools); }
async function navigateReader(rawUrl) { await saveProgress(); if (window.parent !== window) window.parent.postMessage({ type: "voice-reader-open", url: rawUrl }, location.origin); else location.assign(rawUrl); }
async function renderHistory() { const list = document.querySelector("#history-list"); list.textContent = ""; try { for (const entry of await VoiceOfMLReaderStore.list()) { const row = document.createElement("div"); row.className = "panel-item"; const link = document.createElement("button"); link.type = "button"; link.className = "panel-item-main"; link.textContent = entry.title || entry.url; link.addEventListener("click", () => navigateReader(entry.readerUrl)); const meta = document.createElement("small"); meta.textContent = `${entry.pageCount ? `第 ${entry.page || 1} / ${entry.pageCount} 页 · ` : ""}${new Date(entry.lastReadAt).toLocaleString()}`; const remove = document.createElement("button"); remove.type = "button"; remove.className = "panel-item-remove"; remove.textContent = "删除"; remove.addEventListener("click", async () => { await VoiceOfMLReaderStore.remove(entry.url); if (entry.url === sourceUrl) historySuppressed = true; row.remove(); if (!list.querySelector(".panel-item")) emptyPanel(list, "暂无阅读记录"); }); row.append(link, remove, meta); list.appendChild(row); } if (!list.childElementCount) emptyPanel(list, "暂无阅读记录"); filterPanel(document.querySelector("#history-view")); } catch (_) { emptyPanel(list, "无法读取本地记录"); } }
function readerProgressPercent() { if (foliateContinuous) { const position = captureFoliateBookmarkPosition(), count = epubBook?.sections?.filter((section) => section.linear !== "no").length || 0, article = position && document.querySelector(`.foliate-continuous article[data-section="${position.foliateSection}"]`), fraction = article ? Math.max(0, Math.min(1, position.foliateOffset / Math.max(1, article.getBoundingClientRect().height))) : 0; return count && position ? Math.round((position.foliateSection + fraction) / count * 1000) / 10 : 0; } if (epubLocation) { const location = epubRendition && epubRendition.currentLocation ? epubRendition.currentLocation() : null, percentage = location && location.start && Number.isFinite(location.start.percentage) ? location.start.percentage : epubProgress; return Math.round(Math.max(0, Math.min(1, percentage)) * 1000) / 10; } if (htmlFrame && htmlFrame.contentDocument) { const doc = htmlFrame.contentDocument.documentElement, win = htmlFrame.contentWindow; return Math.round(Math.max(0, Math.min(1, win.scrollY / Math.max(1, doc.scrollHeight - win.innerHeight))) * 1000) / 10; } const position = viewport.scrollTop / Math.max(1, viewport.scrollHeight - viewport.clientHeight); return Math.round(Math.max(0, Math.min(1, position)) * 1000) / 10; }
function excerptFromCaret(doc, root, x, y) { let node, offset = 0; const position = doc.caretPositionFromPoint ? doc.caretPositionFromPoint(x, y) : null; if (position) { node = position.offsetNode; offset = position.offset; } else if (doc.caretRangeFromPoint) { const range = doc.caretRangeFromPoint(x, y); if (range) { node = range.startContainer; offset = range.startOffset; } } if (!node || !root.contains(node)) return ""; if (node.nodeType !== Node.TEXT_NODE) { const first = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode(); if (!first) return ""; node = first; offset = 0; } const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT); walker.currentNode = node; let excerpt = node.data.slice(offset); while (excerpt.length < 220 && walker.nextNode()) excerpt += ` ${walker.currentNode.data}`; return excerpt.replace(/\s+/g, " ").trim().slice(0, 160); }
function bookmarkExcerpt() { if (["image", "audio", "video"].includes(capability.mode)) return ""; if (capability.mode === "pdf") { const shell = pageAtMarker(), items = shell && shell._bookmarkTextItems; if (items && items.length) { const rect = shell.getBoundingClientRect(), targetY = Math.max(0, bookmarkRibbon.getBoundingClientRect().bottom - rect.top) / Math.max(1, rect.height); let nearest = 0, distance = Infinity; items.forEach((item, index) => { const nextDistance = Math.abs(item.y - targetY); if (nextDistance < distance) { nearest = index; distance = nextDistance; } }); return items.slice(nearest).map((item) => item.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 160); } } const x = Math.round(viewport.getBoundingClientRect().width / 2), y = Math.round(bookmarkRibbon.getBoundingClientRect().bottom + 8), frames = [...document.querySelectorAll("iframe")].filter((frame) => { const rect = frame.getBoundingClientRect(); return rect.left <= x && rect.right >= x && rect.top <= y && rect.bottom >= y; }), frame = frames[frames.length - 1]; try { if (frame && frame.contentDocument && frame.contentDocument.body) { const rect = frame.getBoundingClientRect(); return excerptFromCaret(frame.contentDocument, frame.contentDocument.body, x - rect.left, y - rect.top); } } catch (_) {} const exact = excerptFromCaret(document, content, x, y); if (exact) return exact; const sourceText = foliateContinuous ? [...content.querySelectorAll(".foliate-continuous article[data-section]:not(.foliate-section-placeholder)")].map((article) => foliateSectionRoot(article).textContent).join(" ") : content.textContent, text = sourceText.replace(/\s+/g, " ").trim(), start = Math.floor(text.length * readerProgressPercent() / 100); return text.slice(start, start + 160).trim(); }
function captureFoliateBookmarkPosition() { if (!foliateContinuous) return null; const marker = viewport.getBoundingClientRect().top + 8, rows = [...document.querySelectorAll(".foliate-continuous article[data-section]")]; const article = rows.find((row) => { const rect = row.getBoundingClientRect(); return rect.top <= marker && rect.bottom > marker; }) || rows.find((row) => row.getBoundingClientRect().top > marker) || rows[rows.length - 1]; return article ? { foliateSection: Number(article.dataset.section), foliateOffset: marker - article.getBoundingClientRect().top, foliateTocIndex: currentChapterIndex } : null; }
async function restoreFoliateBookmarkPosition(entry) { const generation = nextReaderGeneration("navigation"); if (!foliateSectionLoader || !Number.isInteger(entry.foliateSection)) return; const article = await foliateSectionLoader(entry.foliateSection); if (foliateSectionSettler) await foliateSectionSettler(); if (!article || !isReaderGenerationCurrent("navigation", generation)) return; const marker = viewport.getBoundingClientRect().top + 8; foliateScrollAnchors.invalidate(); viewport.scrollTop = Math.max(0, viewport.scrollTop + article.getBoundingClientRect().top - marker + (Number(entry.foliateOffset) || 0)); if (Number.isInteger(entry.foliateTocIndex) && entry.foliateTocIndex >= 0 && entry.foliateTocIndex < tocEntries.length) currentChapterIndex = entry.foliateTocIndex; updateTocCurrentMark(); setReaderPanelOpen(false, true); }
async function seekFoliateProgress(percent) { const generation = nextReaderGeneration("navigation"), sections = epubBook?.sections?.filter((section) => section.linear !== "no") || []; if (!sections.length || !foliateSectionLoader) return; const position = Math.max(0, Math.min(0.999999, Number(percent) / 100)) * sections.length, index = Math.min(sections.length - 1, Math.floor(position)), article = await foliateSectionLoader(index); if (foliateSectionSettler) await foliateSectionSettler(); if (!article || !isReaderGenerationCurrent("navigation", generation)) return; const marker = viewport.getBoundingClientRect().top + 8, offset = article.getBoundingClientRect().height * (position - index); foliateScrollAnchors.invalidate(); viewport.scrollTop = Math.max(0, viewport.scrollTop + article.getBoundingClientRect().top - marker + offset); const section = sections[index], tocIndex = tocEntries.findIndex((entry) => { const target = epubBook.resolveHref(entry.href); return target && epubBook.sections[target.index] === section; }); if (tocIndex >= 0) currentChapterIndex = tocIndex; updateTocCurrentMark(); }
async function renderBookmarks() {
  const list = document.querySelector("#bookmarks-list"),
    generation = nextReaderGeneration("bookmarks");
  try {
    const entries = showingAllBookmarks
      ? await VoiceOfMLReaderStore.listAllBookmarks()
      : await VoiceOfMLReaderStore.listBookmarks(sourceUrl);
    if (!isReaderGenerationCurrent("bookmarks", generation)) return;
    list.textContent = "";
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "panel-item";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "panel-item-main";
      open.textContent = showingAllBookmarks
        ? `${entry.title || "未命名书籍"} · ${entry.label}`
        : entry.label;
      open.addEventListener("click", async () => {
        if (entry.url !== sourceUrl) {
          await navigateReader(entry.readerUrl);
          return;
        }
        if (Number.isInteger(entry.foliateSection) && foliateContinuous)
          await restoreFoliateBookmarkPosition(entry);
        else if (entry.epubLocation && epubRendition)
          await epubRendition.display(entry.epubLocation);
        else if (entry.page) {
          await goToPage(entry.page);
          if (Number.isFinite(entry.pageOffset)) {
            const shell = content.querySelector(
              `.reader-page[data-page="${entry.page}"], .reader-docx-page[data-page="${entry.page}"]`,
            );
            if (shell) viewport.scrollTop = shell.offsetTop + entry.pageOffset;
          }
        } else if (
          Number.isFinite(entry.htmlScrollTop) &&
          htmlFrame &&
          htmlFrame.contentWindow
        )
          htmlFrame.contentWindow.scrollTo(0, entry.htmlScrollTop);
        else viewport.scrollTop = entry.scrollTop || 0;
      });
      const excerpt = document.createElement("p");
      excerpt.className = "bookmark-excerpt";
      excerpt.textContent = entry.excerpt || "";
      excerpt.hidden = !entry.excerpt;
      const meta = document.createElement("small");
      meta.textContent = new Date(entry.createdAt).toLocaleString();
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "panel-item-remove";
      remove.textContent = "删除";
      remove.addEventListener("click", async () => {
        await VoiceOfMLReaderStore.removeBookmark(entry.id);
        row.remove();
        if (!list.querySelector(".panel-item")) emptyPanel(list, "暂无书签");
      });
      row.append(open, remove, excerpt, meta);
      list.appendChild(row);
    }
    if (!list.childElementCount) emptyPanel(list, "暂无书签");
    filterPanel(document.querySelector("#bookmarks-panel"));
  } catch (_) {
    if (isReaderGenerationCurrent("bookmarks", generation))
      emptyPanel(list, "无法读取书签");
  }
}
function pageAtMarker() {
  const y = bookmarkRibbon.getBoundingClientRect().bottom,
    pages = [...content.querySelectorAll(".reader-page, .reader-docx-page")];
  if (!pages.length) return null;
  return (
    pages.find((page) => {
      const rect = page.getBoundingClientRect();
      return rect.top <= y && rect.bottom > y;
    }) ||
    pages.find((page) => page.getBoundingClientRect().bottom > y) ||
    pages[pages.length - 1]
  );
}
function syncCurrentPageFromMarker() {
  const page = pageAtMarker();
  if (!page) return;
  const next = Number(page.dataset.page);
  if (!next || next === currentPage) return;
  currentPage = next;
  pageInput.value = String(next);
}
function scheduleMarkerSync() {
  if (markerFrame) return;
  markerFrame = requestAnimationFrame(() => {
    markerFrame = 0;
    syncCurrentPageFromMarker();
    scheduleSave();
  });
}
function formatMediaTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds),
    hours = Math.floor(total / 3600),
    minutes = Math.floor((total % 3600) / 60),
    secs = total % 60;
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
function captureBookmarkSnapshot() {
  if (mediaElement) {
    const time = Number.isFinite(mediaElement.currentTime)
      ? mediaElement.currentTime
      : 0;
    return {
      locator: `media:${Math.round(time * 10) / 10}`,
      label: `时间 ${formatMediaTime(time)}`,
      excerpt: "",
      progress: mediaElement.duration
        ? Math.round((time / mediaElement.duration) * 1000) / 10
        : 0,
      mediaTime: time,
      page: 0,
      pageOffset: 0,
      epubLocation: "",
      scrollTop: 0,
      htmlScrollTop: 0,
    };
  }
  syncCurrentPageFromMarker();
  const foliatePosition = captureFoliateBookmarkPosition();
  const shell = pageCount ? pageAtMarker() : null,
    pageOffset = shell ? Math.max(0, viewport.scrollTop - shell.offsetTop) : 0,
    progress = readerProgressPercent(),
    htmlScrollTop =
      htmlFrame && htmlFrame.contentWindow
        ? htmlFrame.contentWindow.scrollY
        : 0,
    scrollTop = viewport.scrollTop,
    pagedDocument =
      pageCount && !["text", "markdown"].includes(capability.mode),
    locator = foliatePosition
      ? `foliate:${foliatePosition.foliateSection}:${Math.round(foliatePosition.foliateOffset)}`
      : epubLocation
      ? `epub:${epubLocation}`
      : pagedDocument
        ? `page:${currentPage}:${Math.round(pageOffset)}`
        : `progress:${progress}:${Math.round(htmlFrame ? htmlScrollTop : scrollTop)}`;
  return {
    locator,
    label: pagedDocument
      ? `第 ${currentPage} / ${pageCount} 页`
      : `阅读进度 ${progress.toFixed(1)}%`,
    excerpt: bookmarkExcerpt(),
    progress,
    page: pagedDocument ? currentPage : 0,
    pageOffset,
    epubLocation,
    scrollTop,
    htmlScrollTop,
    ...(foliatePosition || {}),
  };
}
function setBookmarkDialogModal(open) {
  document.documentElement.classList.toggle("bookmark-dialog-open", open);
}
function closeBookmarkPopover() {
  pendingBookmarkSnapshot = null;
  editingBookmark = null;
  bookmarkPopover.hidden = true;
  bookmarkRibbon.setAttribute("aria-expanded", "false");
  setBookmarkDialogModal(false);
  bookmarkRibbon.focus();
}
bookmarkRibbon.addEventListener("click", () => {
  const prompt = document.querySelector("#bookmark-prompt");
  pendingBookmarkSnapshot = captureBookmarkSnapshot();
  editingBookmark = null;
  prompt.textContent = `在${pendingBookmarkSnapshot.label}添加书签？`;
  bookmarkLabelInput.value = pendingBookmarkSnapshot.label;
  bookmarkExcerptInput.value = pendingBookmarkSnapshot.excerpt || "";
  bookmarkPopover.hidden = false;
  bookmarkRibbon.setAttribute("aria-expanded", "true");
  setBookmarkDialogModal(true);
  bookmarkLabelInput.focus();
});
document
  .querySelector("#bookmark-cancel")
  .addEventListener("click", closeBookmarkPopover);
document.querySelector("#bookmark-add").addEventListener("click", async () => {
  const snapshot = pendingBookmarkSnapshot || captureBookmarkSnapshot(),
    now = Date.now(),
    label = bookmarkLabelInput.value.trim() || snapshot.label,
    excerpt = bookmarkExcerptInput.value.trim();
  if (editingBookmark) {
    await VoiceOfMLReaderStore.putBookmark({
      ...editingBookmark,
      label,
      excerpt,
    });
  } else {
    await VoiceOfMLReaderStore.putBookmark({
      id: `${sourceUrl}\0${snapshot.locator}`,
      url: sourceUrl,
      title,
      extension,
      readerUrl: location.href,
      label,
      excerpt,
      progress: snapshot.progress,
      mediaTime: snapshot.mediaTime,
      page: snapshot.page,
      pageOffset: snapshot.pageOffset,
      epubLocation: snapshot.epubLocation,
      foliateSection: snapshot.foliateSection,
      foliateOffset: snapshot.foliateOffset,
      foliateTocIndex: snapshot.foliateTocIndex,
      scrollTop: snapshot.scrollTop,
      htmlScrollTop: snapshot.htmlScrollTop,
      createdAt: now,
    });
  }
  pendingBookmarkSnapshot = null;
  editingBookmark = null;
  bookmarkPopover.hidden = true;
  bookmarkRibbon.setAttribute("aria-expanded", "false");
  setBookmarkDialogModal(false);
  if (!document.querySelector("#bookmarks-panel").hidden) renderBookmarks();
  bookmarkRibbon.focus();
});
bookmarkPopover.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeBookmarkPopover();
    return;
  }
  if (event.key !== "Tab") return;
  const buttons = [...bookmarkPopover.querySelectorAll("button")],
    first = buttons[0],
    last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
for (const button of document.querySelectorAll(".reader-panel-tabs button")) button.addEventListener("click", () => selectPanel(button.dataset.panel));
document.querySelector(".reader-panel-tabs").addEventListener("keydown", (event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; const tabs = [...document.querySelectorAll(".reader-panel-tabs button:not([hidden])")], current = tabs.indexOf(document.activeElement); if (current < 0) return; event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; selectPanel(tabs[next].dataset.panel); tabs[next].focus(); });
bookmarksAllButton.addEventListener("click", () => { showingAllBookmarks = !showingAllBookmarks; bookmarksAllButton.textContent = showingAllBookmarks ? "本书书签" : "全部书签"; bookmarksAllButton.setAttribute("aria-pressed", String(showingAllBookmarks)); renderBookmarks(); });
 for (const button of document.querySelectorAll(".panel-search-toggle")) { button.classList.remove("icon-button"); button.classList.add("text-action"); button.textContent = "搜索"; button.hidden = false; button.setAttribute("aria-expanded", "false"); button.addEventListener("click", () => setPanelSearchOpen(button, button.getAttribute("aria-expanded") !== "true")); }
 for (const input of document.querySelectorAll(".panel-search")) input.addEventListener("input", () => filterPanel(input.closest(".reader-panel-view"))); document.querySelector("#bookmarks-list").addEventListener("click", async (event) => { if (!mediaElement || event.target.closest(".panel-item-remove")) return; const row = event.target.closest(".panel-item"), index = row ? [...row.parentElement.children].indexOf(row) : -1; if (index < 0) return; const entries = showingAllBookmarks ? await VoiceOfMLReaderStore.listAllBookmarks() : await VoiceOfMLReaderStore.listBookmarks(sourceUrl); if (entries[index] && entries[index].mediaTime != null) mediaElement.currentTime = entries[index].mediaTime; });
document.querySelector("#history-clear").addEventListener("click", async () => { if (!confirm("清空全部阅读历史？")) return; await VoiceOfMLReaderStore.clearHistory(); historySuppressed = true; renderHistory(); });
readerThemeToggle.addEventListener("click", () => { const theme = readerTheme === "dark" ? "light" : "dark"; applyReaderTheme(theme); if (window.parent !== window) window.parent.postMessage({ type: "voice-reader-theme", theme }, location.origin); });
 window.addEventListener("storage", (event) => { if (event.key === "theme" && event.newValue) applyReaderTheme(event.newValue, false); }); readerThemeToggle.addEventListener("click", () => { readerThemeToggle.innerHTML = readerTheme === "dark" ? THEME_MOON_ICON : THEME_SUN_ICON; });
window.addEventListener("message", (event) => { if (event.origin === location.origin && event.source === window.parent && event.data && event.data.type === "voice-reader-theme-state") applyReaderTheme(event.data.theme, false); });
document.querySelector("#history").addEventListener("click", () => setReaderPanelOpen(document.querySelector("#history").getAttribute("aria-expanded") !== "true")); document.querySelector("#history-close").addEventListener("click", () => setReaderPanelOpen(false, true));
viewport.addEventListener("scroll", scheduleMarkerSync, { passive: true });
viewport.addEventListener("scroll", scheduleFoliateScrollSync, { passive: true });
viewport.addEventListener("scroll", foliateScrollAnchors.remember, { passive: true });
window.addEventListener("pagehide", saveProgress);
if (localReaderData?.repo) { const folderTarget = new URL("/search/", location.origin), folder = new URLSearchParams(); if (localReaderData.folder?.length) folder.set("folder_self", localReaderData.folder.join("/")); folderTarget.hash = "#/" + encodeURIComponent(localReaderData.repo) + (folder.toString() ? "?" + folder.toString() : ""); readerPath.onclick = () => window.parent !== window ? window.parent.postMessage({ type: "voice-reader-navigate", url: folderTarget.href }, location.origin) : location.assign(folderTarget.href); }
window.addEventListener("pagehide", disposeReader, { once: true });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveProgress(); });
  function validSource(raw) { try { const url = new URL(raw); if (url.protocol !== "https:" || !["huggingface.co", "hf-mirror.com"].includes(url.hostname)) return false; const readerAsset = /^\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\/(?:pdf_manifest\.json|objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:linearized\.pdf|page-manifest\.json|pages\/page-[0-9]{6}\.webp|(?:[a-z0-9-]+\/)?(chapter-manifest\.json|document\.(?:pdf|epub|mobi|azw3|fb2)|book\.epub|document\.docx|document\.html|audio\.mp3|video\.mp4)))$/.test(url.pathname); if (extension === "docx") return readerAsset; return /^\/datasets\/VoiceOfML\/[^/]+\/(resolve|raw)\//.test(url.pathname) || readerAsset; } catch (_) { return false; } }
  function validFallback(raw) { try { const url = new URL(raw); return url.protocol === "https:" && ["huggingface.co", "hf-mirror.com"].includes(url.hostname) && /\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:linearized\.pdf|(?:[a-z0-9-]+\/)?document\.pdf)$/.test(url.pathname); } catch (_) { return false; } }
function validOcr(raw) { try { const url = new URL(raw); return url.protocol === "https:" && url.hostname === "voiceofml-search.hf.space" && url.pathname.startsWith("/txt/"); } catch (_) { return false; } }
function loadScript(url) { return new Promise((resolve, reject) => { const script = document.createElement("script"); script.src = url; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); }); }
function disposeReader() { if (readerLifecycle.disposed) return; restorationReady = false; nextReaderGeneration("navigation"); nextReaderGeneration("search"); nextReaderGeneration("bookmarks"); nextReaderGeneration("pdf"); formatAdapters.dispose(); foliateSectionVirtualizer?.dispose(); foliateChapterRepository?.dispose(); foliateSectionObserver?.disconnect(); loadingObserver.disconnect(); clearTimeout(saveTimer); clearTimeout(themeAnimationTimer); clearTimeout(panelAnimationTimer); if (markerFrame) cancelAnimationFrame(markerFrame); if (foliateScrollFrame) cancelAnimationFrame(foliateScrollFrame); if (epubSeekFrame) cancelAnimationFrame(epubSeekFrame); saveTimer = 0; themeAnimationTimer = 0; panelAnimationTimer = 0; markerFrame = 0; foliateScrollFrame = 0; epubSeekFrame = 0; try { const destroying = pdfDocument?.destroy?.(); if (destroying?.catch) destroying.catch(() => {}); } catch (_) {} pdfDocument = null; if (mediaElement) { mediaElement.pause(); mediaElement.removeAttribute("src"); mediaElement.load(); mediaElement = null; } foliateSectionVirtualizer = null; foliateChapterRepository = null; foliateSectionLoader = null; foliateSectionSettler = null; epubRendition = null; epubBook = null; htmlFrame = null; readerRuntime.dispose(); }
function fail(message, code = "READER_PARSE") { if (readerLifecycle.disposed) return; readerRuntime.fail(code); content.dataset.errorCode = code; loadingStatus.hidden = true; loadingIndicator.remove(); const visibleMessage = `${message} [${readerLifecycle.stage}]`; content.innerHTML = `<div class="reader-error"></div>`; content.querySelector(".reader-error").textContent = visibleMessage; status.textContent = "无法打开"; }
function fetchWithReaderTimeout(url, timeoutMs = READER_PROXY_TIMEOUT_MS) { return readerRequestManager.request(url, timeoutMs); }
function fetchReaderResponse() { return fetchWithReaderTimeout(contentUrl, READER_PROXY_TIMEOUT_MS).then((response) => response.ok ? response : fetchWithReaderTimeout(sourceUrl, READER_PROXY_TIMEOUT_MS), () => fetchWithReaderTimeout(sourceUrl, READER_PROXY_TIMEOUT_MS)); }
function loadPdfTaskWithTimeout(pdfjs, options, url) { const task = pdfjs.getDocument(options(url)); return new Promise((resolve, reject) => { const timeout = setTimeout(() => { task.destroy().catch(() => {}); reject(new Error("reader PDF timeout")); }, PDF_PROXY_TIMEOUT_MS); task.promise.then((document) => { clearTimeout(timeout); resolve(document); }, (error) => { clearTimeout(timeout); reject(error); }); }); }
function loadPdfWithTimeout(pdfjs, options) { return loadPdfTaskWithTimeout(pdfjs, options, contentUrl).catch((error) => { if (error && error.name === "AbortError") throw error; return loadPdfTaskWithTimeout(pdfjs, options, sourceUrl); }); }
async function renderPdfPages(prepared) {
  const response = await prepared;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest.version !== 1 || manifest.kind !== "pdf-pages" || !Array.isArray(manifest.pages) || !manifest.pages.length) throw new Error("PDF_MANIFEST_INVALID");
  const rootMatch = String(sourceUrl).match(/\/objects\/([0-9a-f]{2}\/[0-9a-f]{64})\/page-manifest\.json$/);
  const entries = manifest.pages.map((item) => ({ page: Number(item.page), path: String(item.path || "") })).sort((a, b) => a.page - b.page);
  if (!rootMatch || entries.some((item, index) => item.page !== index + 1 || !new RegExp(`^objects/${rootMatch[1]}/pages/page-[0-9]{6}\\.webp$`).test(item.path))) throw new Error("PDF_MANIFEST_INVALID");
  pdfPageManifest = { entries }; pageCount = entries.length; pageInput.max = String(pageCount); document.querySelector("#page-total").textContent = `/ ${pageCount}`; status.textContent = `${pageCount} 页`;
  const observer = new IntersectionObserver((items) => items.forEach((entry) => { entry.target.dataset.renderVisible = entry.isIntersecting ? "1" : "0"; if (entry.isIntersecting) renderPdfManifestShell(entry.target); }), { root: viewport, rootMargin: "1200px 0px" });
  const pageObserver = new IntersectionObserver(() => scheduleMarkerSync(), { root: viewport, threshold: [0, 0.5, 1] });
  const createShell = (page) => { const shell = document.createElement("section"); shell.className = "reader-page"; shell.dataset.page = String(page); shell.style.aspectRatio = "1 / 1.414"; shell.tabIndex = 0; shell.setAttribute("role", "region"); shell.setAttribute("aria-label", `第 ${page} 页`); const image = new Image(); image.alt = `第 ${page} 页`; image.decoding = "async"; shell.appendChild(image); shell.addEventListener("focus", () => renderPdfManifestShell(shell)); observer.observe(shell); pageObserver.observe(shell); return shell; };
  const firstShell = createShell(1); content.appendChild(firstShell); await renderPdfManifestShell(firstShell, false, true);
  pdfShellsReady = (async () => { for (let start = 2; start <= pageCount; start += 24) { const fragment = document.createDocumentFragment(); for (let page = start; page < Math.min(start + 24, pageCount + 1); page++) fragment.appendChild(createShell(page)); content.appendChild(fragment); await new Promise((resolve) => setTimeout(resolve, 0)); } })(); await pdfShellsReady;
  if (restoredEntry && restoredEntry.page) await goToPage(restoredEntry.page); else syncCurrentPageFromMarker();
}
async function renderPdf(prepared) {
  const pdf = await prepared; pdfDocument = pdf; pageCount = pdf.numPages; pageInput.max = String(pageCount); document.querySelector("#page-total").textContent = `/ ${pageCount}`; status.textContent = `${pdf.numPages} 页`;
  const firstPage = await pdf.getPage(1), firstViewport = firstPage.getViewport({ scale: 1 });
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) renderPdfShell(entry.target); }), { root: viewport, rootMargin: matchMedia("(max-width: 700px)").matches ? "300px 0px" : "1200px 0px" });
  const pageObserver = new IntersectionObserver(() => scheduleMarkerSync(), { root: viewport, threshold: [0, 0.5, 1] });
  const createShell = (page) => { const shell = document.createElement("section"); shell.className = "reader-page"; shell.dataset.page = String(page); shell.style.aspectRatio = `${firstViewport.width} / ${firstViewport.height}`; shell.tabIndex = 0; shell.setAttribute("role", "region"); shell.setAttribute("aria-label", `第 ${page} 页`); const canvas = document.createElement("canvas"); canvas.setAttribute("aria-hidden", "true"); const textLayer = document.createElement("div"); textLayer.className = "reader-pdf-text"; textLayer.setAttribute("role", "document"); textLayer.setAttribute("aria-label", `第 ${page} 页正文`); shell.append(canvas, textLayer); shell.addEventListener("focus", () => renderPdfShell(shell)); observer.observe(shell); pageObserver.observe(shell); return shell; };
  const firstShell = createShell(1); content.appendChild(firstShell); await renderPdfShell(firstShell, false, true);
  pdfShellsReady = (async () => { for (let start = 2; start <= pdf.numPages; start += 24) { const fragment = document.createDocumentFragment(); for (let page = start; page < Math.min(start + 24, pdf.numPages + 1); page++) fragment.appendChild(createShell(page)); content.appendChild(fragment); await new Promise((resolve) => setTimeout(resolve, 0)); } })();
  await pdfShellsReady;
  if (typeof pdf.getOutline === "function") { try { const outline = await pdf.getOutline(), entries = []; const cleanLabel = (value) => String(value || "未命名章节").replace(/[\u2610-\u2612\u25a1]\s*[xX×]?\s*$/u, "").trim() || "未命名章节"; const append = async (items, depth = 0) => { for (const item of items || []) { let destination = item.dest, page = 0; if (typeof destination === "string") destination = await pdf.getDestination(destination); if (destination && destination[0]) { try { page = await pdf.getPageIndex(destination[0]) + 1; } catch (_) {} } entries.push({ label: page ? `${cleanLabel(item.title)} · 第 ${page} 页` : cleanLabel(item.title), depth, activate: async () => { if (page) await goToPage(page); } }); await append(item.items, depth + 1); } }; await append(outline); setToc(entries); } catch (error) { console.warn("PDF outline could not be loaded", error); } }
  if (restoredEntry && restoredEntry.page) await goToPage(restoredEntry.page); else syncCurrentPageFromMarker();
}
async function renderPdfText(page, shell) { if (shell.dataset.textReady === "1") return; const layer = shell.querySelector(".reader-pdf-text"); if (!layer || typeof page.getTextContent !== "function") return; try { const text = await page.getTextContent(), pdfViewport = page.getViewport({ scale: 1 }); shell._bookmarkTextItems = text.items.filter((item) => item.str && item.str.trim()).map((item) => { const point = item.transform && pdfViewport.convertToViewportPoint ? pdfViewport.convertToViewportPoint(item.transform[4], item.transform[5]) : null; return { text: item.str, y: point ? Math.max(0, Math.min(1, point[1] / Math.max(1, pdfViewport.height))) : 0 }; }); layer.textContent = ""; let positioned = false; for (const item of text.items) { const span = layer.ownerDocument.createElement("span"); span.textContent = item.str + (item.hasEOL ? "\n" : " "); const point = item.transform && pdfViewport.convertToViewportPoint ? pdfViewport.convertToViewportPoint(item.transform[4], item.transform[5]) : null; if (point) { positioned = true; const fontHeight = Math.hypot(item.transform[2] || 0, item.transform[3] || 0) || 12; span.style.left = `${point[0] / Math.max(1, pdfViewport.width) * 100}%`; span.style.top = `${point[1] / Math.max(1, pdfViewport.height) * 100}%`; span.style.fontSize = `${fontHeight / Math.max(1, pdfViewport.height) * 100}%`; } else span.style.position = "static"; layer.appendChild(span); } if (!positioned) layer.textContent = text.items.map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("").trim() || "此页没有可提取文本"; else if (!layer.textContent.trim()) layer.textContent = "此页没有可提取文本"; shell.dataset.textReady = "1"; } catch (error) { console.warn(`PDF page ${shell.dataset.page} text extraction failed`, error); } }
async function renderPdfShell(shell, force = false, priority = false) { if (!pdfDocument) return; if (shell.dataset.renderState === "rendering") { if (force) shell.dataset.pendingRerender = "1"; return shell._renderPromise; } if (!force && shell.dataset.renderState === "rendered") return; let finishRender; shell._renderPromise = new Promise((resolve) => { finishRender = resolve; }); const generation = pdfRenderGeneration; shell.dataset.renderState = "rendering"; await acquirePdfRenderSlot(priority); try { const page = await pdfDocument.getPage(Number(shell.dataset.page)), base = page.getViewport({ scale: 1 }), scale = Math.min(3, Math.max(0.5, shell.clientWidth / base.width)), rendered = page.getViewport({ scale }), canvas = shell.querySelector("canvas"); canvas.width = rendered.width; canvas.height = rendered.height; shell.style.aspectRatio = `${rendered.width} / ${rendered.height}`; await Promise.all([page.render({ canvasContext: canvas.getContext("2d"), viewport: rendered }).promise, renderPdfText(page, shell)]); if (!isReaderGenerationCurrent("pdf", generation) || shell.dataset.pendingRerender) { shell.dataset.renderState = "idle"; delete shell.dataset.pendingRerender; setTimeout(() => renderPdfShell(shell, true, priority), 0); return; } canvas.classList.add("ready"); shell.dataset.renderState = "rendered"; shell.dataset.renderUsedAt = String(Date.now()); trimPdfCanvases(); } catch (error) { shell.dataset.renderState = "idle"; console.warn(`PDF page ${shell.dataset.page} render failed`, error); const retries = Number(shell.dataset.renderRetries || 0); if (priority) throw error; if (retries < 3) { shell.dataset.renderRetries = String(retries + 1); setTimeout(() => renderPdfShell(shell, true), 400 * (retries + 1)); } } finally { releasePdfRenderSlot(); finishRender(); delete shell._renderPromise; } }
function acquirePdfRenderSlot(priority = false) { const limit = matchMedia("(max-width: 700px)").matches ? 1 : 2; if (pdfActiveRenders < limit) { pdfActiveRenders++; return Promise.resolve(); } return new Promise((resolve) => { const resume = () => { pdfActiveRenders++; resolve(); }; if (priority) pdfRenderWaiters.unshift(resume); else pdfRenderWaiters.push(resume); }); }
function releasePdfRenderSlot() { pdfActiveRenders = Math.max(0, pdfActiveRenders - 1); const resume = pdfRenderWaiters.shift(); if (resume) resume(); }
function trimPdfCanvases() { const limit = matchMedia("(max-width: 700px)").matches ? 7 : 11, rendered = [...content.querySelectorAll('.reader-page[data-render-state="rendered"]')]; if (rendered.length <= limit) return; rendered.sort((a, b) => Math.abs(Number(b.dataset.page) - currentPage) - Math.abs(Number(a.dataset.page) - currentPage) || Number(a.dataset.renderUsedAt || 0) - Number(b.dataset.renderUsedAt || 0)); while (rendered.length > limit) { const shell = rendered.shift(); if (Number(shell.dataset.page) === currentPage && rendered.length >= limit) { rendered.push(shell); continue; } const canvas = shell.querySelector("canvas"); canvas.width = 0; canvas.height = 0; canvas.classList.remove("ready"); shell.dataset.renderState = "idle"; } }
function rerenderVisiblePdfPages() { nextReaderGeneration("pdf"); for (const shell of content.querySelectorAll(".reader-page")) { const rect = shell.getBoundingClientRect(); if (rect.bottom >= -1200 && rect.top <= innerHeight + 1200) renderPdfShell(shell, true); } }
async function renderText(markdown, prepared) { const response = await prepared.response; if (!response.ok) throw new Error(`HTTP ${response.status}`); if (!markdown) await renderPlainText(response); else { const bytes = new Uint8Array(await response.arrayBuffer()), text = new TextDecoder(detectTextEncoding(bytes, title)).decode(bytes); await prepared.engines; const article = document.createElement("article"); article.className = "reader-markdown"; article.innerHTML = DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true } }); content.appendChild(article); const headings = [...article.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((heading) => heading.textContent.trim()); setToc(headings.map((heading) => ({ label: heading.textContent.trim(), depth: Number(heading.tagName.slice(1)) - 1, activate: () => heading.scrollIntoView({ block: "start" }) }))); } status.textContent = "已加载"; }
function sanitizeOfflineHtml(text) { const clean = DOMPurify.sanitize(text, { USE_PROFILES: { html: true }, ADD_TAGS: ["style"], FORBID_TAGS: ["base", "embed", "form", "iframe", "object", "script"], FORBID_ATTR: ["action", "formaction", "srcdoc"], ALLOWED_URI_REGEXP: /^data:image\/(?:gif|png|jpeg|webp);/i }), template = document.createElement("template"); template.innerHTML = clean; for (const style of template.content.querySelectorAll("style")) style.textContent = style.textContent.replace(/@import[^;]+;|url\s*\([^)]*\)/gi, ""); for (const element of template.content.querySelectorAll("[style]")) element.setAttribute("style", element.getAttribute("style").replace(/@import[^;]+;|url\s*\([^)]*\)/gi, "")); return template.innerHTML; }
async function renderHtml(prepared) { const response = await prepared.response; if (!response.ok) throw new Error(`HTTP ${response.status}`); const bytes = new Uint8Array(await response.arrayBuffer()), text = new TextDecoder(detectHtmlEncoding(bytes, title)).decode(bytes); await prepared.engine; const clean = sanitizeOfflineHtml(text), frame = document.createElement("iframe"); htmlFrame = frame; frame.className = "html-frame"; frame.setAttribute("sandbox", "allow-same-origin"); frame.setAttribute("referrerpolicy", "no-referrer"); frame.style.colorScheme = "only light"; const frameLoaded = new Promise((resolve) => frame.addEventListener("load", () => { repairHtmlContrast(frame); frame.contentDocument.documentElement.style.zoom = String(zoom); if (restoredEntry && Number.isFinite(restoredEntry.htmlScrollTop)) frame.contentWindow.scrollTo(0, restoredEntry.htmlScrollTop); frame.contentWindow.addEventListener("scroll", scheduleSave, { passive: true }); const headings = [...frame.contentDocument.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((heading) => heading.textContent.trim()); setToc(headings.map((heading) => ({ label: heading.textContent.trim(), depth: Number(heading.tagName.slice(1)) - 1, activate: () => heading.scrollIntoView({ block: "start" }) }))); resolve(); }, { once: true })); frame.srcdoc = clean + '<meta name="color-scheme" content="only light"><style>:root{color-scheme:only light!important;background:#fff!important}html,body{min-height:100%;background:#fff!important;color:#111!important}</style>'; content.appendChild(frame); await frameLoaded; status.textContent = "HTML"; }
function detectHtmlEncoding(bytes, hint = "") { const probe = String.fromCharCode(...bytes.subarray(0, 8192)), match = probe.match(/charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i); if (match) { const label = ({ gb2312: "gb18030", "gb-2312": "gb18030", gbk: "gb18030", "x-gbk": "gb18030" })[match[1].toLowerCase()] || match[1]; try { new TextDecoder(label); return label; } catch (_) {} } return detectTextEncoding(bytes, hint); }
function repairHtmlContrast(frame) { const doc = frame.contentDocument; if (!doc || !doc.body) return; const parseColor = (value) => { const parts = String(value).match(/[\d.]+/g); return parts && parts.length >= 3 ? [Number(parts[0]), Number(parts[1]), Number(parts[2]), parts[3] === undefined ? 1 : Number(parts[3])] : null; }, luminance = (color) => { const channels = color.slice(0, 3).map((value) => { const normalized = value / 255; return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4; }); return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722; }, background = (element) => { for (let current = element; current; current = current.parentElement) { const color = parseColor(frame.contentWindow.getComputedStyle(current).backgroundColor); if (color && color[3] > 0.1) return color; } return [255, 255, 255, 1]; }; const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT), elements = new Set(); while (walker.nextNode() && elements.size < 10000) if (walker.currentNode.data.trim()) elements.add(walker.currentNode.parentElement); for (const element of elements) { const foreground = parseColor(frame.contentWindow.getComputedStyle(element).color), backdrop = background(element); if (!foreground) continue; const light = luminance(foreground), dark = luminance(backdrop), contrast = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05); if (contrast < 3) element.style.setProperty("color", dark > 0.45 ? "#111" : "#f5f5f5", "important"); } }
async function renderPlainText(response) { const pre = document.createElement("pre"); pre.className = "reader-text"; const textNode = document.createTextNode(""); pre.appendChild(textNode); content.appendChild(pre); if (!response.body || !response.body.getReader) { const bytes = new Uint8Array(await response.arrayBuffer()); textNode.data = new TextDecoder(detectTextEncoding(bytes, title)).decode(bytes).replace(/\ufffd/g, ""); return; } const reader = response.body.getReader(), chunks = [], asciiPreview = []; let sampleSize = 0, displayedSampleSize = 0, streamDone = false, asciiPreviewPossible = true; while (!streamDone && sampleSize < 65540) { const { value, done } = await reader.read(); streamDone = done; if (value && value.length) { chunks.push(value); sampleSize += value.length; if (!displayedSampleSize && asciiPreviewPossible) { for (const byte of value) { if (!byte || byte >= 128) { asciiPreviewPossible = false; break; } asciiPreview.push(byte); } if (asciiPreview.length >= 8) { textNode.appendData(new TextDecoder("utf-8").decode(new Uint8Array(asciiPreview))); displayedSampleSize = asciiPreview.length; } } else if (displayedSampleSize === sampleSize - value.length) { let asciiLength = 0; while (asciiLength < value.length && value[asciiLength] > 0 && value[asciiLength] < 128) asciiLength++; if (asciiLength) { textNode.appendData(new TextDecoder("utf-8").decode(value.subarray(0, asciiLength))); displayedSampleSize += asciiLength; } } } } const sample = new Uint8Array(sampleSize); let sampleOffset = 0; for (const chunk of chunks) { sample.set(chunk, sampleOffset); sampleOffset += chunk.length; } const decoder = new TextDecoder(detectTextEncoding(sample, title)); let pending = "", frame = 0; const flush = () => { frame = 0; if (pending) { textNode.appendData(pending); pending = ""; } }, scheduleFlush = () => { if (!frame) frame = requestAnimationFrame(flush); }; pending = decoder.decode(sample.subarray(displayedSampleSize), { stream: !streamDone }).replace(/\ufffd/g, ""); scheduleFlush(); while (!streamDone) { const { value, done } = await reader.read(); if (done) { streamDone = true; break; } pending += decoder.decode(value, { stream: true }).replace(/\ufffd/g, ""); scheduleFlush(); } pending += decoder.decode().replace(/\ufffd/g, ""); if (frame) cancelAnimationFrame(frame); flush(); }
function detectTextEncoding(bytes, hint = "") { if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8"; if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le"; if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"; const evenNulls = bytes.filter((value, index) => !value && index % 2 === 0).length, oddNulls = bytes.filter((value, index) => !value && index % 2 === 1).length; if (oddNulls > bytes.length / 8 && oddNulls > evenNulls * 4) return "utf-16le"; if (evenNulls > bytes.length / 8 && evenNulls > oddNulls * 4) return "utf-16be"; try { new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true }); return "utf-8"; } catch (_) {} if (/[\u0400-\u04ff]/.test(hint)) return "windows-1251"; const candidates = /[\u3400-\u9fff]/.test(hint) ? ["gb18030", "big5"] : ["gb18030", "big5", "windows-1251", "windows-1252"]; let best = "gb18030", bestScore = -Infinity; for (const encoding of candidates) { try { const text = new TextDecoder(encoding).decode(bytes), controls = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length, replacements = (text.match(/\ufffd/g) || []).length, cjk = (text.match(/[\u3400-\u9fff]/g) || []).length, cyrillic = (text.match(/[\u0400-\u04ff]/g) || []).length, commonCjk = (text.match(/[的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经之进着等部家自理起现实都体制当本性应开合因由然前外政社义事相全与关各重新内正反明原利质向道命此变结解问意建公系军情者立代通题党程展料员革文总品活长求老基资级图统知组别期论运农指区战任处理世]/g) || []).length, score = Math.max(cjk + commonCjk * 5, cyrillic) - controls * 20 - replacements * 40; if (score > bestScore) { best = encoding; bestScore = score; } } catch (_) {} } return best; }
async function renderDocx(prepared) { const [response] = await prepared; if (!response.ok) throw new Error(`HTTP ${response.status}`); const bytes = await response.arrayBuffer(), styles = document.createElement("div"), body = document.createElement("div"); styles.className = "docx-styles"; body.className = "docx-body"; content.append(styles, body); await docx.renderAsync(bytes, body, styles, { className: "reader-docx", inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false, useBase64URL: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, renderChanges: false, renderComments: false, renderAltChunks: false, debug: false }); body.classList.toggle("reader-document-dark", readerTheme === "dark"); if (!(body.textContent || "").trim() && !body.querySelector("img, table, svg, canvas")) throw new Error("DOCX rendered no supported content"); const pages = [...body.querySelectorAll(":scope > .reader-docx-wrapper > section.reader-docx")]; if (pages.length) { pageCount = pages.length; pageInput.max = String(pageCount); document.querySelector("#page-total").textContent = `/ ${pageCount}`; document.querySelector(".page-controls").hidden = false; pages.forEach((page, index) => { page.classList.add("reader-docx-page"); page.dataset.page = String(index + 1); }); const headings = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((heading) => heading.textContent.trim()); setToc(headings.map((heading) => ({ label: heading.textContent.trim(), depth: Number(heading.tagName.slice(1)) - 1, activate: () => heading.scrollIntoView({ block: "start" }) }))); if (restoredEntry && restoredEntry.page) await goToPage(restoredEntry.page); else syncCurrentPageFromMarker(); } for (const link of body.querySelectorAll("a[href]")) { const href = link.getAttribute("href") || ""; if (!href.startsWith("#") && !/^https?:\/\//i.test(href)) link.removeAttribute("href"); else if (!href.startsWith("#")) { link.target = "_blank"; link.rel = "noopener noreferrer"; } } status.textContent = pageCount ? `${pageCount} 页` : "DOCX"; }
function renderMedia(mode) { const media = document.createElement(mode); mediaElement = media; media.className = mode === "audio" ? "reader-audio" : "reader-video"; media.controls = true; media.preload = "metadata"; if (mode === "video") media.playsInline = true; media.addEventListener("loadedmetadata", () => { if (restoredEntry && Number.isFinite(restoredEntry.mediaTime)) media.currentTime = restoredEntry.mediaTime; }); media.addEventListener("timeupdate", () => { const time = formatMediaTime(media.currentTime), timeNode = document.querySelector(".media-panel-time"); if (timeNode) timeNode.textContent = `${time} / ${formatMediaTime(media.duration)}`; scheduleSave(); }, { passive: true }); media.addEventListener("error", () => fail("媒体加载失败，请检查网络后重试，或下载原文件。", "READER_MEDIA"), { once: true }); media.src = contentUrl; content.appendChild(media); status.textContent = mode === "audio" ? "音频" : "视频"; }
new MutationObserver(() => { for (const row of document.querySelectorAll("#bookmarks-list .panel-item")) if (!row.querySelector(".panel-item-edit")) { const edit = document.createElement("button"); edit.type = "button"; edit.className = "panel-item-edit"; edit.textContent = "编辑"; edit.onclick = () => { const main = row.querySelector(".panel-item-main"), excerpt = row.querySelector(".bookmark-excerpt"); editingBookmark = { label: main.textContent, excerpt: excerpt ? excerpt.textContent : "" }; bookmarkLabelInput.value = editingBookmark.label; bookmarkExcerptInput.value = editingBookmark.excerpt; bookmarkPopover.hidden = false; setBookmarkDialogModal(true); bookmarkLabelInput.focus(); }; row.insertBefore(edit, row.querySelector(".panel-item-remove")); } }).observe(document.querySelector("#bookmarks-list"), { childList: true });
document.addEventListener("click", async (event) => { if (!event.target.closest(".panel-item-edit")) return; const row = event.target.closest(".panel-item"), rows = [...document.querySelectorAll("#bookmarks-list .panel-item")], index = rows.indexOf(row), entries = showingAllBookmarks ? await VoiceOfMLReaderStore.listAllBookmarks() : await VoiceOfMLReaderStore.listBookmarks(sourceUrl); if (entries[index]) { editingBookmark = { ...entries[index] }; document.querySelector("#bookmark-prompt").textContent = `编辑书签 · 阅读进度 ${(Number(editingBookmark.progress) || 0).toFixed(1)}%`; bookmarkLabelInput.value = editingBookmark.label || ""; bookmarkExcerptInput.value = editingBookmark.excerpt || ""; } }, true);
const documentProgressPercent = readerProgressPercent; readerProgressPercent = () => mediaElement && mediaElement.duration ? Math.round(mediaElement.currentTime / mediaElement.duration * 1000) / 10 : documentProgressPercent();
const progressTools = document.createElement("div"); progressTools.className = "reader-progress-tools"; progressTools.innerHTML = '<div class="reader-progress-row"><button class="reader-chapter-prev" type="button" aria-label="上一章" title="上一章"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7"/></svg></button><input class="reader-progress-range" type="range" min="0" max="100" step="0.1" value="0" aria-label="阅读进度"><span class="reader-progress-percent">0.0%</span><button class="reader-progress-undo" type="button" aria-label="撤销进度调整" title="撤销进度调整"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 8.3A6.5 6.5 0 1 1 6 16"/><path d="m7.2 8.3 3-.2"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg></button><button class="reader-chapter-next" type="button" aria-label="下一章" title="下一章"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7"/></svg></button></div>'; document.querySelector("#history-panel").appendChild(progressTools);
const readingProgressSummary = document.createElement("div"); readingProgressSummary.className = "reader-progress-summary"; readingProgressSummary.innerHTML = '<strong>阅读状态</strong><span class="reader-progress-summary-value">0.0%</span><button class="reader-progress-bookmark text-action" type="button">在当前位置添加书签</button>'; progressTools.prepend(readingProgressSummary); readingProgressSummary.querySelector(".reader-progress-bookmark").addEventListener("click", () => bookmarkRibbon.click()); function updateReadingProgressSummary() { const noToc = !tocEntries.length && !mediaElement; readingProgressSummary.hidden = !noToc; if (noToc) readingProgressSummary.querySelector(".reader-progress-summary-value").textContent = `${readerProgressPercent().toFixed(1)}%`; } updateReadingProgressSummary();
function syncTocTab() { const tab = document.querySelector("#toc-tab"); if (!tab) return; if (!tocEntries.length) { tab.hidden = false; tab.textContent = "阅读"; } else if (currentChapterIndex < 0) currentChapterIndex = 0; }
syncTocTab();
const progressRange = progressTools.querySelector(".reader-progress-range"), progressPercent = progressTools.querySelector(".reader-progress-percent"), progressUndo = progressTools.querySelector(".reader-progress-undo"), chapterPrev = progressTools.querySelector(".reader-chapter-prev"), chapterNext = progressTools.querySelector(".reader-chapter-next"); let previousProgressState = null, progressSeeking = false, epubSeekFrame = 0, epubSeekTarget = 0, epubSeekPromise = Promise.resolve();
function updateProgressTools() { if (progressSeeking) return; const percent = readerProgressPercent(); progressRange.value = String(percent); progressPercent.textContent = `${percent.toFixed(1)}%`; const hasChapters = tocEntries.length > 0, hasPreviousChapter = hasChapters && currentChapterIndex > 0, hasNextChapter = hasChapters && currentChapterIndex >= 0 && currentChapterIndex < tocEntries.length - 1; chapterPrev.hidden = !hasChapters; chapterNext.hidden = !hasChapters; chapterPrev.disabled = !hasPreviousChapter; chapterNext.disabled = !hasNextChapter; progressUndo.hidden = !previousProgressState; updateReadingProgressSummary(); placeReadingProgress(); }
function captureProgressState() { return mediaElement ? { mediaTime: mediaElement.currentTime } : htmlFrame && htmlFrame.contentWindow ? { htmlScrollTop: htmlFrame.contentWindow.scrollY } : { scrollTop: viewport.scrollTop }; }
function restoreProgressState(state) { if (!state) return; if (mediaElement && Number.isFinite(state.mediaTime)) mediaElement.currentTime = state.mediaTime; else if (htmlFrame && htmlFrame.contentWindow && Number.isFinite(state.htmlScrollTop)) htmlFrame.contentWindow.scrollTo(0, state.htmlScrollTop); else if (Number.isFinite(state.scrollTop)) viewport.scrollTop = state.scrollTop; updateProgressTools(); scheduleSave(); }
function flushEpubSeek() { if (epubSeekFrame) { cancelAnimationFrame(epubSeekFrame); epubSeekFrame = 0; epubSeekPromise = foliateContinuous ? seekFoliateProgress(epubSeekTarget) : Promise.resolve(epubRendition.display(epubBook.locations.cfiFromPercentage(epubSeekTarget / 100))).catch(() => {}); } return epubSeekPromise; }
function seekProgress(value, preserve = false) { if (!preserve || !previousProgressState) previousProgressState = captureProgressState(); const percent = Number(value); if (mediaElement && mediaElement.duration) mediaElement.currentTime = mediaElement.duration * percent / 100; else if (foliateContinuous) { epubSeekTarget = Math.max(0, Math.min(100, percent)); if (!epubSeekFrame) epubSeekFrame = requestAnimationFrame(() => { epubSeekFrame = 0; epubSeekPromise = seekFoliateProgress(epubSeekTarget); }); } else if (htmlFrame && htmlFrame.contentWindow) htmlFrame.contentWindow.scrollTo(0, Math.max(0, htmlFrame.contentDocument.documentElement.scrollHeight - htmlFrame.contentWindow.innerHeight) * percent / 100); else viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight) * percent / 100; updateProgressTools(); scheduleSave(); }
async function activateChapter(index) { if (index < 0 || index >= tocEntries.length || index === currentChapterIndex) return; try { await navigateTocEntry(index); } finally { updateProgressTools(); } }
progressRange.addEventListener("input", () => { progressPercent.textContent = `${Number(progressRange.value).toFixed(1)}%`; });
  progressRange.addEventListener("pointerdown", () => { progressSeeking = true; previousProgressState = captureProgressState(); }); progressRange.addEventListener("input", () => seekProgress(progressRange.value, true)); progressRange.addEventListener("pointerup", () => { flushEpubSeek().finally(() => { progressSeeking = false; updateProgressTools(); }); }); progressRange.addEventListener("pointercancel", () => { flushEpubSeek().finally(() => { progressSeeking = false; updateProgressTools(); }); }); progressUndo.addEventListener("click", () => { restoreProgressState(previousProgressState); previousProgressState = null; updateProgressTools(); }); chapterPrev.addEventListener("click", () => activateChapter(currentChapterIndex - 1)); chapterNext.addEventListener("click", () => activateChapter(currentChapterIndex + 1)); viewport.addEventListener("scroll", updateProgressTools, { passive: true }); registerReaderFormatAdapters(); updateProgressTools(); start().catch((error) => { console.error(error); fail("阅读文件解析失败，请刷新后重试，或下载原文件。", classifyReaderError(error)); });
 const fullSearchView = document.createElement("section");
fullSearchView.id = "full-search-view"; fullSearchView.className = "reader-panel-view full-search-view"; fullSearchView.dataset.panelView = "full-search"; fullSearchView.hidden = true;
fullSearchView.innerHTML = '<div class="full-search-bar"><input id="full-search-input" class="full-search-input" type="search" placeholder="搜索正文" aria-label="搜索正文"><button id="full-search-clear" class="icon-button" type="button" aria-label="清除全文搜索" title="清除">×</button></div><div id="full-search-status" class="full-search-status" role="status">输入关键词搜索正文</div><div class="full-search-nav"><button id="full-search-prev" type="button" disabled>上一个</button><button id="full-search-next" type="button" disabled>下一个</button></div><div id="full-search-results" class="full-search-results"></div>';
document.querySelector("#history-panel").insertBefore(fullSearchView, document.querySelector(".reader-panel-tabs"));
 const fullSearchButton = document.querySelector("#full-search-toggle"); fullSearchButton.textContent = "全文搜索"; fullSearchButton.setAttribute("aria-label", "全文搜索");
fullSearchButton.hidden = !capability.features.search;
let fullSearchResults = [], fullSearchIndex = -1;
const fullSearchInput = fullSearchView.querySelector("#full-search-input"), fullSearchStatus = fullSearchView.querySelector("#full-search-status"), fullSearchResultsNode = fullSearchView.querySelector("#full-search-results");
async function runFoliateFullSearch() { const query = fullSearchInput.value.trim(), generation = nextReaderGeneration("search"); if (!query || !epubRendition || typeof epubRendition.search !== "function") return; fullSearchResults = []; fullSearchResultsNode.textContent = ""; fullSearchStatus.textContent = "正在搜索正文…"; for await (const group of epubRendition.search({ query })) { let occurrence = 0; for (const item of group.subitems || []) { const excerpt = item.excerpt || { pre: "", match: query, post: "" }; fullSearchResults.push({ location: group.label || "电子书位置", cfi: item.cfi, occurrence: occurrence++, snippet: { text: `${excerpt.pre}${excerpt.match}${excerpt.post}`, matchStart: excerpt.pre.length, matchLength: excerpt.match.length, prefix: "", suffix: "" } }); if (fullSearchResults.length >= 100) break; } if (!isReaderGenerationCurrent("search", generation) || fullSearchResults.length >= 100) break; } if (!isReaderGenerationCurrent("search", generation)) return; for (const [index, result] of fullSearchResults.entries()) { const row = document.createElement("button"); row.type = "button"; row.className = "full-search-result"; const location = document.createElement("small"); location.className = "full-search-location"; location.textContent = result.location; row.append(location, fullSearchSnippetDom(result.snippet)); row.addEventListener("click", () => { fullSearchIndex = index; navigateFoliateSearchResult(result); }); fullSearchResultsNode.appendChild(row); } fullSearchStatus.textContent = fullSearchResults.length ? `${fullSearchResults.length}${fullSearchResults.length >= 100 ? "+" : ""} 个结果` : "没有找到匹配正文"; }
fullSearchInput.addEventListener("input", event => { if (capability.mode === "foliate") { event.stopImmediatePropagation(); clearFullSearchMarks(); runFoliateFullSearch().catch(error => { fullSearchStatus.textContent = `搜索失败：${error.message}`; }); } }, true);
function fullSearchEscape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
let fullSearchActiveMarks = [];
function clearFullSearchMarks() { for (const mark of fullSearchActiveMarks) { if (mark.tagName === "MARK") mark.replaceWith(mark.textContent); else mark.classList.remove("full-search-highlight"); } fullSearchActiveMarks = []; content.normalize(); for (const article of content.querySelectorAll(".foliate-continuous article[data-section]")) foliateSectionRoot(article).normalize(); }
function fullSearchTextNodes(root) { const nodes = [], walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT); while (walker.nextNode() && nodes.length < 20000) { const node = walker.currentNode; if (node.data && !node.parentElement.closest("script,style,mark.full-search-highlight,.reader-pdf-text")) nodes.push(node); } return nodes; }
function fullSearchSnippet(text, index, length) { const start = Math.max(0, index - 72), end = Math.min(text.length, index + length + 88); return { text: text.slice(start, end), matchStart: index - start, matchLength: length, prefix: start ? "…" : "", suffix: end < text.length ? "…" : "" }; }
function fullSearchSnippetDom(snippet) { const node = document.createElement("span"); node.className = "full-search-snippet"; if (snippet.prefix) node.append(snippet.prefix); node.append(snippet.text.slice(0, snippet.matchStart)); const mark = document.createElement("mark"); mark.className = "search-match"; mark.textContent = snippet.text.slice(snippet.matchStart, snippet.matchStart + snippet.matchLength); node.append(mark, snippet.text.slice(snippet.matchStart + snippet.matchLength)); if (snippet.suffix) node.append(snippet.suffix); return node; }
function fullSearchLocation(node, fallback) { const page = node.parentElement && node.parentElement.closest("[data-page]"); return page ? `第 ${page.dataset.page} 页` : fallback; }
function fullSearchDomMatches(root, fallback) { root = foliateSectionRoot(root); const query = fullSearchInput.value.trim(), pattern = new RegExp(fullSearchEscape(query), "giu"), nodes = fullSearchTextNodes(root), offsets = [], text = nodes.map((node) => { const start = offsets.length ? offsets[offsets.length - 1].end : 0; offsets.push({ node, start, end: start + node.data.length }); return node.data; }).join(""), matches = [...text.matchAll(pattern)].slice(0, 100), output = []; for (const match of [...matches].reverse()) { const end = match.index + match[0].length, parts = offsets.filter((part) => part.end > match.index && part.start < end), anchors = []; for (const part of [...parts].reverse()) { const start = Math.max(match.index, part.start) - part.start, finish = Math.min(end, part.end) - part.start, after = part.node.splitText(finish), selected = part.node.splitText(start), mark = part.node.ownerDocument.createElement("mark"); mark.className = "full-search-highlight"; mark.textContent = selected.data; selected.parentNode.replaceChild(mark, selected); fullSearchActiveMarks.push(mark); anchors.unshift(mark); } const first = anchors[0], source = nodes.find((node) => node === parts[0].node) || parts[0].node; output.unshift({ location: fullSearchLocation(source, fallback), snippet: fullSearchSnippet(text, match.index, match[0].length), target: first, activate: () => first.scrollIntoView({ block: "center" }) }); } return output; }
async function navigateFoliateSearchResult(result) { const generation = nextReaderGeneration("navigation"), resolved = await epubRendition?.resolveNavigation?.(result.cfi); if (!resolved || !isReaderGenerationCurrent("navigation", generation)) return; const section = epubBook?.sections?.[resolved.index], sections = epubBook?.sections?.filter((item) => item.linear !== "no") || [], visibleIndex = section ? sections.indexOf(section) : -1; if (visibleIndex < 0 || !foliateSectionLoader) return; const node = await foliateSectionLoader(visibleIndex); if (foliateSectionSettler) await foliateSectionSettler(); if (!node || !isReaderGenerationCurrent("navigation", generation)) return; clearFullSearchMarks(); const matches = fullSearchDomMatches(foliateSectionRoot(node), "电子书位置"), match = matches[Math.min(result.occurrence || 0, Math.max(0, matches.length - 1))]; if (!isReaderGenerationCurrent("navigation", generation) || !match) return; const targetRect = match.target.getBoundingClientRect(), viewportRect = viewport.getBoundingClientRect(); foliateScrollAnchors.invalidate(); viewport.scrollTop = Math.max(0, viewport.scrollTop + targetRect.top - viewportRect.top - (viewport.clientHeight - targetRect.height) / 2); const tocIndex = tocEntries.findIndex((entry) => { const target = epubBook.resolveHref(entry.href), targetSection = target && epubBook.sections[target.index]; return targetSection === section; }); if (tocIndex >= 0) { currentChapterIndex = tocIndex; updateTocCurrentMark(); } setReaderPanelOpen(false, true); }
async function fullSearchPdfMatches(query) { const output = [], pattern = new RegExp(fullSearchEscape(query), "giu"), highlightPattern = new RegExp(fullSearchEscape(query), "iu"); for (let page = 1; page <= pdfDocument.numPages && output.length < 100; page++) { const pdfPage = await pdfDocument.getPage(page), textContent = await pdfPage.getTextContent(), text = textContent.items.map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("").trim(), shell = content.querySelector(`.reader-page[data-page="${page}"]`); if (shell) { await renderPdfText(pdfPage, shell); for (const span of shell.querySelectorAll(".reader-pdf-text span")) if (highlightPattern.test(span.textContent)) { span.classList.add("full-search-highlight"); fullSearchActiveMarks.push(span); } } for (const match of text.matchAll(pattern)) { if (output.length >= 100) break; output.push({ location: `第 ${page} 页`, snippet: fullSearchSnippet(text, match.index, match[0].length), activate: () => goToPage(page) }); } } return output; }
async function runFullSearch() { const query = fullSearchInput.value.trim(); nextReaderGeneration("search"); const generation = fullSearchGeneration; fullSearchResults = []; fullSearchIndex = -1; fullSearchResultsNode.textContent = ""; fullSearchView.querySelectorAll(".full-search-nav button").forEach((button) => { button.disabled = true; }); if (!query) { fullSearchStatus.textContent = "输入关键词搜索正文"; return; } fullSearchStatus.textContent = "正在搜索正文…"; try { if (capability.mode === "pdf") fullSearchResults = pdfDocument ? await fullSearchPdfMatches(query) : []; else if (["text", "markdown", "docx"].includes(capability.mode)) fullSearchResults = fullSearchDomMatches(content, "阅读位置"); else if (capability.mode === "html") fullSearchResults = htmlFrame && htmlFrame.contentDocument && htmlFrame.contentDocument.body ? fullSearchDomMatches(htmlFrame.contentDocument.body, "HTML 阅读位置") : []; else if (capability.mode === "epub") { const contents = epubRendition && typeof epubRendition.getContents === "function" ? epubRendition.getContents() : []; if (!contents.length) throw new Error("EPUB 尚未加载可搜索章节"); for (const item of contents) { fullSearchResults.push(...fullSearchDomMatches(item.document.body, "EPUB 当前章节")); if (fullSearchResults.length >= 100) break; } fullSearchResults.length = Math.min(fullSearchResults.length, 100); } else throw new Error("此格式没有可搜索文本"); if (!isReaderGenerationCurrent("search", generation)) return; for (const result of fullSearchResults) { const row = document.createElement("button"); row.type = "button"; row.className = "full-search-result"; const location = document.createElement("small"); location.className = "full-search-location"; location.textContent = result.location; row.append(location, fullSearchSnippetDom(result.snippet)); row.addEventListener("click", async () => { await result.activate(); setReaderPanelOpen(false, true); }); fullSearchResultsNode.appendChild(row); } fullSearchStatus.textContent = fullSearchResults.length ? `${fullSearchResults.length}${fullSearchResults.length === 100 ? "+" : ""} 个结果` : "未找到正文匹配"; } catch (error) { if (isReaderGenerationCurrent("search", generation)) fullSearchStatus.textContent = error.message || "正文搜索不可用"; } finally { if (isReaderGenerationCurrent("search", generation)) fullSearchView.querySelectorAll(".full-search-nav button").forEach((button) => { button.disabled = !fullSearchResults.length; }); } }
function moveFullSearch(step) { if (!fullSearchResults.length) return; fullSearchIndex = (fullSearchIndex + step + fullSearchResults.length) % fullSearchResults.length; const result = fullSearchResults[fullSearchIndex]; Promise.resolve(result.activate()).then(() => fullSearchResultsNode.children[fullSearchIndex].scrollIntoView({ block: "nearest" })); }
fullSearchButton.addEventListener("click", () => { const panel = document.querySelector("#history-panel"), isOpen = panel.classList.contains("is-open"), isSelected = fullSearchView.hidden === false; if (isOpen && isSelected) { setReaderPanelOpen(false, true); return; } setReaderPanelOpen(true); selectPanel("full-search"); fullSearchInput.focus(); }); fullSearchInput.addEventListener("input", runFullSearch); fullSearchView.querySelector("#full-search-clear").addEventListener("click", () => { fullSearchInput.value = ""; runFullSearch(); fullSearchInput.focus(); }); fullSearchView.querySelector("#full-search-prev").addEventListener("click", () => moveFullSearch(-1)); fullSearchView.querySelector("#full-search-next").addEventListener("click", () => moveFullSearch(1));
fullSearchButton.addEventListener("click", (event) => { const panel = document.querySelector("#history-panel"); if (panel.classList.contains("is-open") && fullSearchView.hidden === false) { event.preventDefault(); event.stopImmediatePropagation(); clearFullSearchMarks(); selectPanel(tocEntries.length ? "toc" : "bookmarks"); } }, true); fullSearchInput.addEventListener("beforeinput", clearFullSearchMarks);
fullSearchView.querySelector("#full-search-clear").addEventListener("click", clearFullSearchMarks, true);

async function renderFoliate(prepared) {
  const response = await fetchReaderResponse();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await import("/search/static/foliate-reader/view.js?reader-v1");
  const bytes = await response.arrayBuffer(),
    view = document.createElement("foliate-view"),
    stream = document.createElement("div");
  view.className = "foliate-reader-view";
  stream.className = "foliate-continuous";
  content.replaceChildren(view, stream);
  epubRendition = view;
  await view.open(
    new File(
      [bytes],
      new URL(sourceUrl, location.href).pathname.split("/").pop() ||
        "book.epub",
      { type: response.headers.get("content-type") || "application/epub+zip" },
    ),
  );
  epubBook = view.book;
  view.style.display = "none";
  const sections = view.book.sections.filter(
    (section) => section.linear !== "no",
  );
  const createSection = async (index) => {
      const section = sections[index], doc = await section.createDocument(),
        assetUrl = (value) => {
          try {
            const path = section.resolveHref(value);
            return `https://voiceofml-search.hf.space/api/reader-resource?book=${encodeURIComponent(sourceUrl)}&path=${encodeURIComponent(path)}`;
          } catch (_) {
            return value;
          }
        };
      for (const element of doc.querySelectorAll(
        "img[src],source[src],audio[src],video[src],video[poster]",
      ))
        for (const name of ["src", "poster"]) {
          const value = element.getAttribute(name);
          if (value && !/^(?:data:|blob:|https?:)/i.test(value))
            element.setAttribute(name, assetUrl(value));
        }
      for (const element of doc.querySelectorAll("[srcset]")) {
        const value = element.getAttribute("srcset");
        if (value)
          element.setAttribute(
            "srcset",
            value
              .split(",")
              .map((part) => {
                const [url, ...descriptor] = part.trim().split(/\s+/);
                return [assetUrl(url), ...descriptor].join(" ");
              })
              .join(", "),
          );
      }
      for (const image of doc.querySelectorAll("image")) { const value = image.getAttributeNS("http://www.w3.org/1999/xlink", "href") || image.getAttribute("xlink:href") || image.getAttribute("href"); if (value && !/^(?:data:|blob:|https?:|#)/i.test(value)) { const proxy = assetUrl(value); image.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", proxy); image.setAttribute("href", proxy); } }
      const article = document.createElement("article");
      article.className = "foliate-continuous-section";
      article.dataset.section = String(index);
      const shadow = article.attachShadow({ mode: "open" }), baseStyle = document.createElement("style"), sectionBody = document.createElement("div");
      baseStyle.textContent = ":host{display:block;color:inherit}*{box-sizing:border-box}.reader-section-body{display:block;color:inherit;line-height:inherit}.reader-section-body>:first-child{margin-top:0!important}a{color:var(--reader-book-link)!important}img,svg,video{max-width:100%;height:auto}mark.full-search-highlight{background:#ffd54f;color:#111}";
      sectionBody.className = "reader-section-body";
      sectionBody.innerHTML = doc.body?.innerHTML || "";
      shadow.append(baseStyle, ...[...doc.querySelectorAll("style,link[rel=stylesheet]")].map((node) => node.cloneNode(true)), sectionBody);
      return article;
  };
  const observer = new IntersectionObserver(
    (items) =>
      items
        .filter((item) => item.isIntersecting)
        .forEach((item) => {
          const index = Number(item.target.dataset.section);
          if (item.target.classList.contains("foliate-section-placeholder")) { foliateChapterRepository.load(index).then(() => foliateSectionVirtualizer?.trim(index)).catch(() => {}); return; }
          const adjacentLoads = [index - 1, index + 1].filter((adjacent) => sections[adjacent]).map((adjacent) => foliateChapterRepository.load(adjacent));
          if (adjacentLoads.length) Promise.allSettled(adjacentLoads).then(() => foliateSectionVirtualizer?.trim(index));
        }),
    { root: viewport, rootMargin: "1000px" },
  );
  foliateSectionObserver = observer;
  foliateChapterRepository = VoiceOfMLReaderChapters.createChapterRepository({ count: sections.length, find: (index) => stream.querySelector(`article[data-section="${index}"]:not(.foliate-section-placeholder)`), create: createSection, commit: (index, article) => { const anchor = foliateScrollAnchors.capture(), placeholder = stream.querySelector(`article.foliate-section-placeholder[data-section="${index}"]`), next = [...stream.querySelectorAll("article[data-section]")].find((item) => Number(item.dataset.section) > index); if (placeholder) { observer.unobserve(placeholder); placeholder.replaceWith(article); } else stream.insertBefore(article, next || null); observer.observe(article); foliateScrollAnchors.observe(article); foliateScrollAnchors.restore(anchor); return article; } });
  foliateSectionVirtualizer = VoiceOfMLReaderVirtual.createSectionVirtualizer({ limit: 9, getLoaded: () => [...stream.querySelectorAll("article[data-section]:not(.foliate-section-placeholder)")], getIndex: (article) => Number(article.dataset.section), getHeight: (article) => article.getBoundingClientRect().height, virtualize: (article, index, height) => { const placeholder = document.createElement("article"); placeholder.className = "foliate-continuous-section foliate-section-placeholder"; placeholder.dataset.section = String(index); placeholder.style.setProperty("--foliate-placeholder-height", `${height}px`); placeholder.setAttribute("aria-hidden", "true"); observer.unobserve(article); foliateScrollAnchors.unobserve(article); article.replaceWith(placeholder); observer.observe(placeholder); return placeholder; }, release: (index) => foliateChapterRepository.release(index), preserve: (change) => foliateScrollAnchors.preserve(change) });
  foliateSectionLoader = (index) => foliateChapterRepository.load(index);
  foliateSectionSettler = async () => {
    const indices = [...stream.querySelectorAll("article[data-section]:not(.foliate-section-placeholder)")].map(
      (article) => Number(article.dataset.section),
    );
    await Promise.all(
      indices
        .flatMap((index) => [index - 1, index + 1])
        .filter((index) => sections[index])
        .map((index) => foliateChapterRepository.load(index)),
    );
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const tasks = foliateChapterRepository.pending;
      if (tasks.length) await Promise.allSettled(tasks);
    }
  };
  if (sections[0]) await foliateChapterRepository.load(0);
  const entries = [],
    append = (items, depth = 0) => {
      for (const item of items || []) {
        const href = item?.href ? String(item.href) : "";
        if (href)
          entries.push({
            label: item.label || "未命名章节",
            href,
            depth,
            activate: () => view.goTo(href),
          });
        append(item.subitems, depth + 1);
      }
    };
  append(view.book.toc);
  await Promise.all(entries.map(async (entry) => { try { const target = await view.book.resolveHref(entry.href), section = target && view.book.sections[target.index]; entry.sectionIndex = section ? sections.indexOf(section) : -1; const fragment = entry.href.split("#")[1] || ""; entry.fragment = fragment ? decodeURIComponent(fragment) : ""; } catch (_) { entry.sectionIndex = -1; entry.fragment = ""; } }));
  if (entries.length) setToc(entries);
  scheduleFoliateScrollSync();
  loadingIndicator.remove();
  loadingStatus.hidden = true;
  loadingObserver.disconnect();
  status.textContent = "EPUB";
}

// Chapter bundles are intentionally outside the EPUB engine: the manifest and
// first chapter are cheap to load, while later chapters enter through the viewport.
async function renderChapterManifest(prepared) {
  const response = await prepared;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const manifest = await response.json();
  if (
    manifest.version !== 1 ||
    manifest.kind !== "epub-chapters" ||
    !Array.isArray(manifest.chapters) ||
    !manifest.chapters.length
  )
    throw new Error("EPUB_INVALID");
  const frame = document.createElement("div");
  frame.className = "epub-frame";
  content.appendChild(frame);
  const loaded = new Set(),
    pending = new Map(),
    base = chapterManifestUrl || sourceUrl;
  const load = async (chapter) => {
    if (loaded.has(chapter.index)) return;
    if (pending.has(chapter.index)) return pending.get(chapter.index);
    const task = (async () => {
      const url = new URL(chapter.path, base).href;
      let result = await fetchWithReaderTimeout(
        `https://voiceofml-search.hf.space/api/reader-content?url=${encodeURIComponent(url)}`,
        READER_PROXY_TIMEOUT_MS,
      );
      if (!result.ok)
        result = await fetchWithReaderTimeout(url, READER_PROXY_TIMEOUT_MS);
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      const doc = new DOMParser().parseFromString(
        await result.text(),
        "text/html",
      );
      for (const node of doc.querySelectorAll(
        "script,iframe,object,embed,base,form",
      ))
        node.remove();
      for (const element of doc.querySelectorAll("*")) {
        for (const attribute of [...element.attributes])
          if (attribute.name.toLowerCase().startsWith("on"))
            element.removeAttribute(attribute.name);
        for (const name of ["src", "href", "poster"])
          if (element.hasAttribute(name)) {
            const value = element.getAttribute(name);
            if (!value.startsWith("#")) {
              try {
                element.setAttribute(name, new URL(value, url).href);
              } catch (_) {
                element.removeAttribute(name);
              }
            }
          }
      }
      const article = document.createElement("article");
      article.className = "reader-markdown reader-epub-chapter";
      article.dataset.chapter = String(chapter.index);
      article.innerHTML = doc.body ? doc.body.innerHTML : "";
      frame.appendChild(article);
      loaded.add(chapter.index);
      pending.delete(chapter.index);
      setToc(
        manifest.chapters.map((item) => ({
          label: item.title || `章节 ${item.index}`,
          depth: 0,
          activate: async () => {
            await load(item);
            const node = frame.querySelector(
              `.reader-epub-chapter[data-chapter="${item.index}"]`,
            );
            if (node) node.scrollIntoView({ block: "start" });
          },
        })),
      );
      const next = manifest.chapters.find(
        (item) => item.index === chapter.index + 1,
      );
      if (next) {
        const sentinel = document.createElement("div");
        sentinel.className = "reader-chapter-sentinel";
        sentinel.dataset.chapter = String(next.index);
        frame.appendChild(sentinel);
        observer.observe(sentinel);
      }
    })();
    pending.set(chapter.index, task);
    return task;
  };
  const observer = new IntersectionObserver(
    (entries) =>
      entries
        .filter((entry) => entry.isIntersecting)
        .forEach((entry) => {
          const chapter = manifest.chapters.find(
            (item) => item.index === Number(entry.target.dataset.chapter),
          );
          if (chapter)
            load(chapter).catch((error) =>
              console.warn("EPUB chapter could not be loaded", error),
            );
        }),
    { root: viewport, rootMargin: "900px 0px" },
  );
  await load(manifest.chapters[0]);
  status.textContent = `EPUB · ${manifest.chapters.length} 章`;
}

function renderImageDocument(image) { content.appendChild(image); status.textContent = "图片"; }
function renderMediaDocument() { return renderMedia(capability.mode); }
function disposeFormatResources(mode) { if (["pdf", "pdf-pages"].includes(mode)) { try { const task = pdfDocument?.destroy?.(); task?.catch?.(() => {}); } catch (_) {} pdfDocument = null; pdfPageManifest = null; } if (mode === "foliate") { foliateSectionObserver?.disconnect(); foliateSectionVirtualizer?.dispose(); foliateChapterRepository?.dispose(); foliateSectionVirtualizer = null; foliateChapterRepository = null; foliateSectionLoader = null; foliateSectionSettler = null; epubRendition = null; epubBook = null; } if (mode === "html") { htmlFrame?.remove?.(); htmlFrame = null; } if (["audio", "video"].includes(mode) && mediaElement) { mediaElement.pause(); mediaElement.removeAttribute("src"); mediaElement.load(); mediaElement = null; } }
function renderTextDocument(prepared) { return renderText(false, prepared); }
function renderMarkdownDocument(prepared) { return renderText(true, prepared); }
function registerReaderFormatAdapters() { for (const mode of Object.keys(VoiceOfMLReaderRuntime.FEATURE_MATRIX).filter((item) => item !== "unsupported")) formatAdapters.register(mode, { open: () => prepareDocumentDirect(), render: (prepared) => renderByMode(prepared), navigate: (value) => ["pdf", "pdf-pages", "docx"].includes(mode) ? goToPage(value) : Promise.resolve(), search: (query) => { fullSearchInput.value = query || ""; return runFullSearch(); }, progress: () => captureBookmarkSnapshot(), restore: (entry) => entry ? restoreProgressState(entry) : Promise.resolve(), dispose: () => disposeFormatResources(mode) }); }
async function renderByMode(prepared) { const renderers = { "epub-chapters": renderChapterManifest, "pdf-pages": renderPdfPages, pdf: renderPdf, image: renderImageDocument, text: renderTextDocument, markdown: renderMarkdownDocument, html: renderHtml, foliate: renderFoliate, docx: renderDocx, audio: renderMediaDocument, video: renderMediaDocument }; const renderer = renderers[capability.mode]; if (renderer) return renderer(prepared); }
async function start() {
  if (readerId) { const remote = await fetch(`https://voiceofml-search.hf.space/api/reader-resolve?id=${encodeURIComponent(readerId)}`).then((response) => response.ok ? response.json() : null).catch(() => null), resolved = remote || resolvedReaderData; if (resolved) { applyReaderMetadata(resolved); if (!readerPath.hidden && resolved.repo) { const folderTarget = new URL("/search/", location.origin); const folder = new URLSearchParams(); if (resolved.folder) folder.set("folder_self", resolved.folder); folderTarget.hash = "#/" + encodeURIComponent(resolved.repo) + (folder.toString() ? "?" + folder.toString() : ""); readerPath.onclick = () => window.parent !== window ? window.parent.postMessage({ type: "voice-reader-navigate", url: folderTarget.href }, location.origin) : location.assign(folderTarget.href); } status.hidden = true; } }
  if (readerId && !sourceUrl) { const resolved = resolvedReaderData || await fetch(`https://voiceofml-search.hf.space/api/reader-resolve?id=${encodeURIComponent(readerId)}`).then((response) => { if (!response.ok) throw new Error(`READER_RESOLVE_HTTP_${response.status}`); return response.json(); }); sourceUrl = resolved.url || ""; contentUrl = `https://voiceofml-search.hf.space/api/reader-content?url=${encodeURIComponent(sourceUrl)}`; downloadUrl = resolved.download || sourceUrl; if (resolved.extension) { extension = String(resolved.extension).toLowerCase(); capability = readerRuntime.negotiate(VoiceOfMLReader.capability(extension)); content.dataset.mode = capability.mode; document.querySelector(".page-controls").hidden = !capability.features.pagination; document.querySelector(".zoom-controls").hidden = !capability.features.zoom; } readerRuntime.update("source", { url: sourceUrl, contentUrl, downloadUrl, extension, metadata: resolved }); }
  if ((!validSource(sourceUrl) && !validSource(chapterManifestUrl) && !readerId) || capability.readerMode === VoiceOfMLReader.ReaderMode.UNSUPPORTED) return fail("此文件暂不支持在线阅读，请下载原文件。", "READER_UNSUPPORTED");
  formatAdapters.activate(capability.mode);
  applyReaderMetadata(resolvedReaderData);
  document.querySelector("#download").href = `https://voiceofml-search.hf.space/api/download?file=${encodeURIComponent(title)}&link=${encodeURIComponent(downloadUrl)}`;
  try {
    if (capability.mode === "foliate") { setReaderStage("foliate"); foliateContinuous = true; [restoredEntry] = await Promise.all([VoiceOfMLReaderStore.get(sourceUrl).catch(() => { restorationFailed = true; return null; }), renderFoliate(null)]); if (restoredEntry?.zoom) setZoom(restoredEntry.zoom, false); if (Number.isInteger(restoredEntry?.foliateSection)) await restoreFoliateBookmarkPosition(restoredEntry); else if (restoredEntry) viewport.scrollTop = restoredEntry.scrollTop || 0; if (!setReaderPhase("ready")) return; restorationReady = !restorationFailed; scheduleSave(); return; }
    setReaderStage("prepare");
    let prepared; [restoredEntry, prepared] = await Promise.all([VoiceOfMLReaderStore.get(sourceUrl).catch(() => { restorationFailed = true; return null; }), formatAdapters.active.open()]);
    if (restoredEntry && restoredEntry.zoom) setZoom(restoredEntry.zoom, false);
     await formatAdapters.active.render(prepared);
    loadingIndicator.remove(); loadingStatus.hidden = true; if (!pageCount && restoredEntry) viewport.scrollTop = restoredEntry.scrollTop || 0; if (!setReaderPhase("ready")) return; restorationReady = !restorationFailed; scheduleSave();
  } catch (error) {
    console.error(error);
    if (capability.mode === "epub-chapters" && validFallback(fallbackUrl)) { const target = new URL(location.href); target.searchParams.set("url", fallbackUrl); target.searchParams.set("ext", "pdf"); target.searchParams.delete("chapter_manifest"); target.searchParams.delete("fallback"); if (window.parent !== window) window.parent.postMessage({ type: "voice-reader-open", url: target.href }, location.origin); else location.replace(target.href); return; }
    const detail = error && error.message && !/^(?:FOLIATE_LOAD_FAILED|原文件加载失败)/u.test(error.message) ? ` (${error.message.slice(0, 180)})` : "";
    fail(error && error.message === "EPUB_INVALID" ? "源 EPUB 文件不完整或已损坏，请下载原文件检查。" : error && error.message === "FOLIATE_LOAD_TIMEOUT" ? "电子书正文加载超时，请检查源文件或网络后重试。" : `原文件加载失败，请检查网络后重试，或下载原文件。${detail}`, classifyReaderError(error, capability.mode === "foliate" ? "READER_CORRUPT" : "READER_PARSE"));
  }
}

function loadPdfDocument() { return import(PDFJS_URL).then((pdfjs) => { pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL; const options = (url) => ({ url, rangeChunkSize: 262144, disableAutoFetch: true, disableStream: true, wasmUrl: PDFJS_WASM_URL, cMapUrl: PDFJS_CMAP_URL, cMapPacked: true, standardFontDataUrl: PDFJS_STANDARD_FONT_URL, withCredentials: false }); return loadPdfWithTimeout(pdfjs, options); }); }
function loadTextDocument() { return fetchReaderResponse().then((response) => ({ response })); }
function loadMarkdownDocument() { return Promise.all([fetchReaderResponse(), Promise.all([loadScript(MARKED_URL), loadScript(PURIFY_URL)])]).then(([response, engines]) => ({ response, engines })); }
function loadHtmlDocument() { return Promise.all([fetchReaderResponse(), loadScript(PURIFY_URL)]).then(([response, engine]) => ({ response, engine })); }
function loadDocxDocument() { return Promise.all([fetchReaderResponse(), loadScript(JSZIP_URL).then(() => loadScript(DOCX_PREVIEW_URL))]); }
function loadMediaDocument() { return Promise.resolve(null); }
function loadImageDocument() { return new Promise((resolve, reject) => { const image = new Image(); image.className = "reader-image"; image.alt = title; image.decoding = "async"; let fallback = false; image.onload = () => resolve(image); image.onerror = () => { if (!fallback) { fallback = true; image.src = sourceUrl; } else reject(new Error("image load failed")); }; image.src = contentUrl; }); }
function loadChapterManifestDocument() { return fetchWithReaderTimeout(`https://voiceofml-search.hf.space/api/reader-content?url=${encodeURIComponent(chapterManifestUrl || sourceUrl)}`, READER_PROXY_TIMEOUT_MS).then((response) => response.ok || !chapterManifestUrl ? response : fetchWithReaderTimeout(chapterManifestUrl, READER_PROXY_TIMEOUT_MS)); }
function loadFoliateDocument() { return import("/search/static/foliate-reader/view.js?reader-v1").catch((error) => { setReaderStage("foliate-import"); throw error; }); }
function prepareDocumentDirect() {
  const loaders = {
    "epub-chapters": loadChapterManifestDocument,
    "pdf-pages": () => fetchWithReaderTimeout(`https://voiceofml-search.hf.space/api/reader-content?url=${encodeURIComponent(sourceUrl)}`, READER_PROXY_TIMEOUT_MS),
    pdf: loadPdfDocument,
    markdown: loadMarkdownDocument,
    html: loadHtmlDocument,
    text: loadTextDocument,
    foliate: loadFoliateDocument,
    docx: loadDocxDocument,
    audio: loadMediaDocument,
    video: loadMediaDocument,
    image: loadImageDocument,
  };
  return loaders[capability.mode] ? loaders[capability.mode]() : Promise.resolve(null);
}

async function renderPdfManifestShell(shell, force = false, priority = false) { if (shell.dataset.renderState === "rendering" || (!force && shell.dataset.renderState === "rendered")) return shell._renderPromise; let finish; shell._renderPromise = new Promise((resolve) => { finish = resolve; }); shell.dataset.renderState = "rendering"; await acquirePdfRenderSlot(priority); try { const entry = pdfPageManifest.entries[Number(shell.dataset.page) - 1], image = shell.querySelector("img"); image.src = new URL("/datasets/vomebook/Reader-Assets/resolve/main/" + entry.path, "https://huggingface.co").href; await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; }); shell.style.aspectRatio = `${image.naturalWidth || 1} / ${image.naturalHeight || 1}`; image.classList.add("ready"); shell.dataset.renderState = "rendered"; shell.dataset.renderUsedAt = String(Date.now()); } catch (error) { shell.dataset.renderState = "idle"; if (priority) throw error; } finally { releasePdfRenderSlot(); finish(); delete shell._renderPromise; } }

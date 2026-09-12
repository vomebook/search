import "/search/static/reader-request-manager.js";
import "/search/static/reader-chapter-repository.js";
import "/search/static/reader-scroll-anchor.js";
import "/search/static/reader-section-virtualizer.js";
import "/search/static/reader-runtime.js";
import "/search/static/reader-format-adapters.js";
import "/search/static/reader-security.js";
// Engines and Reader lifecycle.
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
readerRuntime.track(formatAdapters);
readerRuntime.track(window.__VOICE_PDF_PRELOAD__);
const readerAbortController = new AbortController();
const readerResources = new Set();
function readerAbortError() {
  return new DOMException("Reader work cancelled", "AbortError");
}
function assertReaderActive() {
  if (readerAbortController.signal.aborted || readerRuntime.state.lifecycle.disposed)
    throw readerAbortError();
}
function trackReaderResource(cleanup) {
  if (readerAbortController.signal.aborted) cleanup();
  else readerResources.add(cleanup);
  return () => readerResources.delete(cleanup);
}
function stopReaderWork() {
  readerAbortController.abort();
  for (const cleanup of readerResources) {
    try {
      cleanup();
    } catch (_) {}
  }
  readerResources.clear();
}
readerRuntime.track(stopReaderWork);
function awaitReader(promise) {
  return new Promise((resolve, reject) => {
    const signal = readerAbortController.signal,
      abort = () => reject(readerAbortError());
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
function waitForReader(delay = 0, animationFrame = false) {
  return new Promise((resolve, reject) => {
    assertReaderActive();
    const signal = readerAbortController.signal;
    const abort = () => {
      if (animationFrame) cancelAnimationFrame(handle);
      else clearTimeout(handle);
      reject(readerAbortError());
    };
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const handle = animationFrame ? requestAnimationFrame(done) : setTimeout(done, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}
// Polyfills for vendor engines (pdf.js, foliate): neither helper has a direct
// caller in first-party code, but both are required by pinned vendor bundles.
if (!Map.prototype.getOrInsertComputed) {
  Map.prototype.getOrInsertComputed = function (key, callback) {
    if (this.has(key)) return this.get(key);
    const value = callback(key);
    this.set(key, value);
    return value;
  };
}
if (!Math.sumPrecise) {
  Math.sumPrecise = function (values) {
    let sum = 0;
    let correction = 0;
    for (const value of values) {
      const next = sum + value;
      correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
      sum = next;
    }
    return sum + correction;
  };
}
// Source metadata and session navigation.
// GitHub Pages serves assets under /search/ and delegates document requests to HF.
// Folder returns use hash routes; explicit folder URLs take precedence over resolved metadata.
function readerContentUrl(url) {
  return `https://voiceofml-search.hf.space/api/reader-content?url=${encodeURIComponent(url)}`;
}
function normalizeSourceUrl(url) {
  return url.startsWith("/api/reader-bucket-resource?")
    ? new URL(url, "https://voiceofml-search.hf.space").href
    : url;
}
const params = new URLSearchParams(location.search);
const readerId = params.get("id") || "";
let localReaderData = null;
try {
  localReaderData = JSON.parse(sessionStorage.getItem(`reader-source:${readerId}`) || "null");
  if (localReaderData) sessionStorage.removeItem(`reader-source:${readerId}`);
} catch (_) {}
let sourceUrl = normalizeSourceUrl(
  params.get("url") || (!readerId && localReaderData && localReaderData.url) || ""
);
let contentUrl = readerContentUrl(sourceUrl);
let downloadUrl =
  params.get("download") || (localReaderData && localReaderData.download) || sourceUrl;
let extension = (params.get("ext") || "").toLowerCase();
let chapterManifestUrl = params.get("chapter_manifest") || "";
let capability = readerRuntime.negotiate(VoiceOfMLReader.capability(extension));
if (
  extension === "pdf" &&
  /\/api\/reader-bucket-resource\?/.test(sourceUrl) &&
  new URL(sourceUrl, location.href).searchParams.get("path")?.endsWith("page-manifest.json")
) {
  extension = "pdf-pages";
  capability = readerRuntime.negotiate(VoiceOfMLReader.capability(extension));
}
let resolvedReaderData = localReaderData;
let cachedReaderData = null;
let pdfFirstPagePreload = null;
if (localReaderData) {
  if (localReaderData.title) params.set("title", localReaderData.title);
  if (localReaderData.extension) params.set("ext", localReaderData.extension);
  if (localReaderData.repo)
    params.set("path", [localReaderData.repo, ...(localReaderData.folder || [])].join("/"));
}
try {
  const cached = sessionStorage.getItem(`reader-resolve:${readerId}`);
  if (cached) {
    cachedReaderData = JSON.parse(cached);
    resolvedReaderData = cachedReaderData;
    sessionStorage.removeItem(`reader-resolve:${readerId}`);
  }
} catch (_) {}
const readerLifecycle = readerRuntime.state.lifecycle;
readerRuntime.update("source", {
  id: readerId,
  url: sourceUrl,
  contentUrl,
  downloadUrl,
  extension,
  metadata: resolvedReaderData
});
readerRuntime.events.on("phase", ({ phase }) => {
  document.documentElement.dataset.readerPhase = phase;
});
readerRuntime.track(
  VoiceOfMLReaderStore.subscribe?.((change) => {
    if (!change?.remote || readerLifecycle.disposed) return;
    if (
      change.type === "history-clear" ||
      (change.type === "history-remove" && change.url === sourceUrl)
    ) {
      historySuppressed = true;
      readerRuntime.cancel(saveTimer);
      saveTimer = saveDeadline = 0;
    }
    if (
      ["history", "history-clear", "history-remove"].includes(change.type) &&
      !document.querySelector("#history-panel").hidden
    )
      renderHistory();
    if (
      ["bookmark", "bookmark-remove"].includes(change.type) &&
      (panelState.showingAllBookmarks || !change.url || change.url === sourceUrl) &&
      !document.querySelector("#bookmarks-panel").hidden
    )
      renderBookmarks();
  })
);
function setReaderPhase(phase) {
  return readerRuntime.setPhase(phase);
}
function setReaderStage(stage) {
  return readerRuntime.setStage(stage);
}
async function resolveReaderId(id) {
  const endpoint = `https://voiceofml-search.hf.space/api/reader-resolve?id=${encodeURIComponent(id)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await readerRequestManager.request(endpoint, READER_PROXY_TIMEOUT_MS);
    if (response.ok) return response.json();
    if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt)
      throw new Error(`HTTP ${response.status}`);
    await response.body?.cancel();
    await waitForReader(350);
  }
  throw new Error("Reader ID resolution failed");
}
function classifyReaderError(error, fallback = "READER_PARSE") {
  const value = `${error?.name || ""} ${error?.message || error || ""}`;
  if (/AbortError|timeout|network|fetch|HTTP\s*\d+/i.test(value)) return "READER_NETWORK";
  if (
    /EPUB_INVALID|corrupt|damage|truncated|central directory|end of data|invalid zip/i.test(value)
  )
    return "READER_CORRUPT";
  return fallback;
}
setReaderPhase("startup");
window.fetchFile = async (url) => {
  const requestUrl = String(url) === sourceUrl ? contentUrl : url;
  const response = await readerRequestManager.request(requestUrl, READER_PROXY_TIMEOUT_MS);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const fileName = new URL(url, location.href).pathname.split("/").pop() || "book";
  return new File(
    [
      await VoiceOfMLReaderSecurity.readBytes(
        response,
        VoiceOfMLReaderSecurity.LIMITS.archiveCompressedBytes
      )
    ],
    fileName,
    { type: response.headers.get("content-type") || "application/octet-stream" }
  );
};
const content = document.querySelector("#content");
document.querySelector(".reader-panel-tabs")?.setAttribute("role", "tablist");
const loadingIndicator = document.createElement("div");
loadingIndicator.className = "reader-loading-indicator";
loadingIndicator.setAttribute("role", "status");
loadingIndicator.innerHTML =
  '<span class="reader-loading-spinner" aria-hidden="true"></span><span>正在加载正文...</span>';
content.appendChild(loadingIndicator);
content.dataset.mode = capability.mode || "unsupported";
const status = document.querySelector("#status");
const loadingStatus = document.querySelector("#loading-status");
loadingStatus.textContent = "";
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
function updateDocumentState(patch) {
  return readerRuntime.update("document", patch);
}
function updateNavigationState(patch) {
  return readerRuntime.update("navigation", patch);
}
function updateSearchState(patch) {
  return readerRuntime.update("search", patch);
}
function publishSearchResults(generation, results) {
  return isReaderGenerationCurrent("search", generation) && updateSearchState({ results });
}
function updatePanelState(patch) {
  return readerRuntime.update("panel", patch);
}
updateDocumentState({
  title:
    String(
      params.get("title") || (localReaderData && localReaderData.title) || sourceName
    ).trim() || sourceName,
  zoom: Math.min(4, Math.max(0.25, Number(localStorage.getItem("reader-zoom") || 100) / 100))
});
function applyReaderMetadata(data) {
  if (data) resolvedReaderData = { ...(resolvedReaderData || {}), ...data };
  readerRuntime.update("source", { metadata: resolvedReaderData });
  const title = String(resolvedReaderData?.title || params.get("title") || sourceName).trim();
  const suffix = String(
    resolvedReaderData?.original_extension || (extension === "pdf-pages" ? "pdf" : extension)
  )
    .toLowerCase()
    .replace(/^\./, "");
  const value = title + (suffix && !title.toLowerCase().endsWith(`.${suffix}`) ? `.${suffix}` : "");
  updateDocumentState({ title: value });
  document.querySelector("#title").textContent = value;
  document.title = `${value} - VoiceOfML Reader`;
  applyReaderPathMetadata(resolvedReaderData);
}
let fallbackUrl = params.get("fallback") || "";
const ocrUrl = params.get("ocr") || "";
function normalizeReaderReturnUrl(rawUrl) {
  try {
    const target = new URL(rawUrl || "/search/", location.origin);
    if (target.origin === location.origin && target.pathname === "/")
      return new URL("/search/", location.origin).href;
    return target.href;
  } catch (_) {
    return new URL("/search/", location.origin).href;
  }
}
let returnUrl = params.get("return") || "";
const readerPathLabel = params.get("path") || "";
const folderReturnUrl = params.get("folder_url") || "";
let returnNavigationToken = params.get("nav") || "";
let returnNeedsReload = false;
try {
  const state = history.state;
  const saved = JSON.parse(sessionStorage.getItem("reader-navigation-current") || "null");
  let stateUrl =
    state && state.voiceReaderOverlay && state.readerUrl
      ? new URL(state.readerUrl, location.origin)
      : null;
  if (!stateUrl && saved && saved.shareUrl === location.href && saved.readerUrl)
    stateUrl = new URL(saved.readerUrl, location.origin);
  const cleanStateUrl = stateUrl && new URL(stateUrl.href);
  if (cleanStateUrl) {
    cleanStateUrl.searchParams.delete("return");
    cleanStateUrl.searchParams.delete("nav");
  }
  if (
    stateUrl &&
    stateUrl.origin === location.origin &&
    stateUrl.pathname === "/search/static/reader.html" &&
    cleanStateUrl.href === location.href
  ) {
    if (!returnUrl) returnUrl = stateUrl.searchParams.get("return") || "";
    if (!returnNavigationToken) returnNavigationToken = stateUrl.searchParams.get("nav") || "";
    returnNeedsReload = true;
  }
} catch (_) {}
const returnHistoryKey = returnNavigationToken ? `reader-return:${returnNavigationToken}` : "";
let canReturnWithHistory = false;
try {
  const target = new URL(returnUrl, location.origin);
  const storedReturnUrl = returnHistoryKey ? sessionStorage.getItem(returnHistoryKey) : "";
  canReturnWithHistory = !!returnHistoryKey && storedReturnUrl === target.href;
} catch (_) {}
let saveTimer = 0;
let saveDeadline = 0;
let chapterManifestLoader = null;
let folderNavigationTarget = null;
let bookmarkInvoker = null;
const bookmarkInertSiblings = new Map();
let pdfDocument = null;
let pdfPageManifest = null;
let pdfActiveRenders = 0;
let pdfShellsReady = Promise.resolve();
const pdfRenderWaiters = [];
trackReaderResource(() => {
  for (const waiter of pdfRenderWaiters.splice(0)) waiter.reject(readerAbortError());
});
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
let htmlFrame = null;
let lastSavedProgress = "";
let progressSaveChain = Promise.resolve();
let historySuppressed = false;
let restorationFailed = false;
let markerFrame = 0;
let pageNavigationLockUntil = 0;
let pendingBookmarkSnapshot = null;
let mediaElement = null;
function nextReaderGeneration(name) {
  return readerRuntime.nextGeneration(name);
}
function isReaderGenerationCurrent(name, value) {
  return !readerAbortController.signal.aborted && readerRuntime.isCurrent(name, value);
}
for (const generationName of ["navigation", "search", "bookmarks", "history", "pdf"])
  nextReaderGeneration(generationName);
function beginReaderNavigation() {
  if (epubSeekFrame) cancelAnimationFrame(epubSeekFrame);
  epubSeekFrame = 0;
  foliateScrollAnchors.invalidate();
  return nextReaderGeneration("navigation");
}
function reportNavigationError(error, generation) {
  if (isReaderGenerationCurrent("navigation", generation) && error?.name !== "AbortError")
    console.warn("Reader navigation failed", error);
}
const viewport = document.querySelector("#viewport");
const zoomInput = document.querySelector("#zoom");
const pageInput = document.querySelector("#page-number");
const readerPath = document.querySelector("#reader-path");
const bookmarkRibbon = document.querySelector("#bookmark-ribbon");
const bookmarkPopover = document.querySelector("#bookmark-popover");
for (const [selector, label] of [
  ["#back", "返回"],
  ["#page-prev", "上一页"],
  ["#page-next", "下一页"],
  ["#page-number", "页码"],
  ["#zoom-out", "缩小"],
  ["#zoom-in", "放大"],
  ["#zoom", "缩放百分比"],
  ["#bookmark-ribbon", "添加书签"],
  ["#history", "阅读选项"]
])
  document.querySelector(selector)?.setAttribute("aria-label", label);
function foliateSectionRoot(article) {
  return article?.shadowRoot || article;
}
function foliateSectionQuery(article, selector) {
  return foliateSectionRoot(article)?.querySelector(selector) || null;
}
function foliateSectionCandidates() {
  return [
    ...content.querySelectorAll(
      ".foliate-continuous > article[data-section]:not(.foliate-section-placeholder)"
    )
  ].flatMap((article) => [
    article,
    ...foliateSectionRoot(article).querySelectorAll(
      ":is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,img,table)"
    )
  ]);
}
const foliateScrollAnchors = readerRuntime.track(
  VoiceOfMLReaderScroll.createScrollAnchorManager({
    viewport,
    candidates: foliateSectionCandidates
  })
);
function applyReaderPathMetadata(data) {
  const folder = Array.isArray(data?.folder) ? data.folder.join("/") : String(data?.folder || "");
  const value = String(
    data?.path || [data?.repo, folder].filter(Boolean).join("/") || readerPathLabel
  ).replace(/^\/+|\/+$/g, "");
  folderNavigationTarget = null;
  try {
    const target = new URL(folderReturnUrl, location.origin);
    if (
      folderReturnUrl &&
      target.origin === location.origin &&
      target.pathname === "/search/" &&
      target.hash.startsWith("#/")
    )
      folderNavigationTarget = target;
  } catch (_) {}
  if (!folderNavigationTarget && data?.repo) {
    folderNavigationTarget = new URL("/search/", location.origin);
    const query = new URLSearchParams();
    if (folder) query.set("folder_self", folder);
    folderNavigationTarget.hash =
      "#/" + encodeURIComponent(data.repo) + (query.size ? "?" + query.toString() : "");
  }
  readerPath.textContent = value;
  readerPath.hidden = !value;
  readerPath.disabled = !folderNavigationTarget;
  readerPath.setAttribute("aria-label", `筛选文件夹：${value}`);
}
applyReaderMetadata(resolvedReaderData);
contentSanitizerObserver = new MutationObserver(() => {
  const seen = new Set();
  for (const article of document.querySelectorAll(".foliate-continuous > article[data-section]")) {
    article.querySelectorAll("style,link[rel=stylesheet]").forEach((node) => node.remove());
    const index = article.dataset.section;
    if (seen.has(index)) article.remove();
    else seen.add(index);
  }
});
contentSanitizerObserver.observe(content, { childList: true, subtree: true });
bookmarkPopover.className = "bookmark-popover";
bookmarkPopover.setAttribute("role", "dialog");
bookmarkPopover.setAttribute("aria-modal", "true");
bookmarkPopover.setAttribute("aria-labelledby", "bookmark-prompt");
const bookmarkLabelInput = document.createElement("input"),
  bookmarkExcerptInput = document.createElement("textarea"),
  bookmarkEditFields = document.createElement("div");
bookmarkLabelInput.id = "bookmark-label";
bookmarkLabelInput.maxLength = 120;
bookmarkExcerptInput.id = "bookmark-excerpt-input";
bookmarkExcerptInput.maxLength = 500;
bookmarkExcerptInput.rows = 3;
bookmarkEditFields.className = "bookmark-edit-fields";
bookmarkEditFields.innerHTML = "<label>标题</label><label>摘要</label>";
bookmarkEditFields.children[0].appendChild(bookmarkLabelInput);
bookmarkEditFields.children[1].appendChild(bookmarkExcerptInput);
bookmarkPopover.insertBefore(bookmarkEditFields, bookmarkPopover.querySelector("div"));
const bookmarksAllButton = document.createElement("button");
if (!document.querySelector("#bookmarks-panel .panel-search-toggle")) {
  const button = document.createElement("button");
  button.className = "panel-search-toggle";
  button.type = "button";
  document.querySelector("#bookmarks-panel .panel-view-header").appendChild(button);
}
bookmarksAllButton.id = "bookmarks-all";
bookmarksAllButton.className = "text-action";
bookmarksAllButton.type = "button";
bookmarksAllButton.textContent = "全部书签";
bookmarksAllButton.setAttribute("aria-pressed", "false");
const bookmarksHeader = document.querySelector("#bookmarks-panel .panel-view-header"),
  bookmarksSearchButton = bookmarksHeader.querySelector(".panel-search-toggle"),
  bookmarksHeaderActions = document.createElement("span");
bookmarksHeaderActions.append(bookmarksAllButton, bookmarksSearchButton);
bookmarksHeader.appendChild(bookmarksHeaderActions);
const mediaTab = document.createElement("button"),
  mediaPanel = document.createElement("section");
mediaTab.id = "media-tab";
mediaTab.type = "button";
mediaTab.role = "tab";
mediaTab.dataset.panel = "media";
mediaTab.textContent = "播放";
mediaTab.hidden = !capability.features.media;
mediaPanel.id = "media-panel";
mediaPanel.className = "reader-panel-view";
mediaPanel.dataset.panelView = "media";
mediaPanel.hidden = true;
mediaPanel.innerHTML =
  '<div class="media-panel-content"><strong>播放状态</strong><span class="media-panel-time">尚未播放</span><button class="text-action media-panel-bookmark" type="button">在当前时间添加书签</button></div>';
document.querySelector(".reader-panel-tabs").prepend(mediaTab);
document
  .querySelector("#history-panel")
  .insertBefore(mediaPanel, document.querySelector("#toc-panel"));
mediaPanel
  .querySelector(".media-panel-bookmark")
  .addEventListener("click", (event) => openBookmarkPopover(event.currentTarget));
const loadingObserver = new MutationObserver(() => {
  if (
    content.querySelector(
      ".reader-page, .reader-image, .reader-audio, .reader-video, .reader-text, .reader-markdown, .html-frame, .docx-body"
    )
  ) {
    loadingIndicator.remove();
    loadingObserver.disconnect();
  }
});
loadingObserver.observe(content, { childList: true });
document.querySelector(".page-controls").hidden = !capability.features.pagination;
document.querySelector(".zoom-controls").hidden = !capability.features.zoom;

status.hidden = true;
mediaTab.setAttribute("aria-controls", "media-panel");
mediaTab.setAttribute("aria-selected", "false");
mediaPanel.setAttribute("role", "tabpanel");
mediaPanel.setAttribute("aria-labelledby", "media-tab");
// Theme, toolbar, and document navigation.
let readerTheme = localStorage.getItem("theme") === "light" ? "light" : "dark";
const THEME_SUN_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
const THEME_MOON_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const readerThemeToggle = document.querySelector("#theme-toggle");
let themeAnimationTimer = 0;
readerThemeToggle.className = "theme-toggle";
function applyReaderTheme(theme, persist = true, animate = true) {
  const anchor = foliateScrollAnchors.capture();
  if (animate) {
    clearTimeout(themeAnimationTimer);
    document.documentElement.classList.add("theme-transition");
    void document.documentElement.offsetWidth;
  }
  readerTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = readerTheme;
  readerThemeToggle.innerHTML = readerTheme === "dark" ? THEME_MOON_ICON : THEME_SUN_ICON;
  if (animate) {
    readerThemeToggle.classList.remove("is-changing");
    void readerThemeToggle.offsetWidth;
    readerThemeToggle.classList.add("is-changing");
    themeAnimationTimer = setTimeout(() => {
      document.documentElement.classList.remove("theme-transition");
      readerThemeToggle.classList.remove("is-changing");
    }, 280);
  }
  readerThemeToggle.title = readerTheme === "dark" ? "切换到白天模式" : "切换到夜间模式";
  readerThemeToggle.setAttribute("aria-label", readerThemeToggle.title);
  readerThemeToggle.setAttribute("aria-pressed", String(readerTheme === "light"));
  const docxBody = content.querySelector(".docx-body");
  if (docxBody) docxBody.classList.toggle("reader-document-dark", readerTheme === "dark");
  if (persist) localStorage.setItem("theme", readerTheme);
  foliateScrollAnchors.restore(anchor);
}
applyReaderTheme(readerTheme, false, false);
function clearReturnNavigation() {
  try {
    if (returnHistoryKey) sessionStorage.removeItem(returnHistoryKey);
    const saved = JSON.parse(sessionStorage.getItem("reader-navigation-current") || "null");
    if (saved && (saved.readerUrl === location.href || saved.shareUrl === location.href))
      sessionStorage.removeItem("reader-navigation-current");
  } catch (_) {}
}
function navigateReaderFolder() {
  if (!folderNavigationTarget) return;
  if (window.parent !== window)
    window.parent.postMessage(
      { type: "voice-reader-navigate", url: folderNavigationTarget.href },
      location.origin
    );
  else {
    clearReturnNavigation();
    location.assign(folderNavigationTarget.href);
  }
}
readerPath.addEventListener("click", navigateReaderFolder);
document.querySelector("#back").addEventListener("click", async () => {
  clearTimeout(saveTimer);
  await Promise.race([saveProgress(), new Promise((resolve) => setTimeout(resolve, 300))]);
  if (window.parent !== window) {
    window.parent.postMessage({ type: "voice-reader-close" }, location.origin);
    return;
  }
  clearReturnNavigation();
  try {
    const target = new URL(normalizeReaderReturnUrl(returnUrl), location.origin);
    if (target.origin === location.origin) {
      if (returnNeedsReload) location.replace(target.href);
      else if (canReturnWithHistory && history.length > 1) {
        history.back();
      } else location.assign(target.href);
      return;
    }
  } catch (_) {}
  location.assign("/search/");
});
function setZoom(percent, persist = true) {
  const anchor = foliateScrollAnchors.capture();
  const normalized = VoiceOfMLReader.clampNumber(percent, 25, 400, 100);
  const horizontalCenter = viewport.scrollWidth
    ? (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth
    : 0;
  updateDocumentState({ zoom: normalized / 100 });
  content.style.setProperty("--reader-zoom", String(documentState.zoom));
  zoomInput.value = String(normalized);
  if (htmlFrame && htmlFrame.contentDocument)
    htmlFrame.contentDocument.documentElement.style.zoom = String(documentState.zoom);
  if (pdfDocument) rerenderVisiblePdfPages();
  if (capability.mode === "foliate")
    content.style.setProperty("--reader-zoom", String(documentState.zoom));
  viewport.scrollLeft = horizontalCenter * viewport.scrollWidth - viewport.clientWidth / 2;
  localStorage.setItem("reader-zoom", String(normalized));
  foliateScrollAnchors.restore(anchor);
  if (persist) scheduleSave();
}
const handlePageNavigationFailure = (error, generation) => {
  if (isReaderGenerationCurrent("navigation", generation) && error?.name !== "AbortError")
    fail("原文件加载失败，请检查网络后重试，或下载原文件。", "READER_NAVIGATION");
};
setZoom(documentState.zoom * 100, false);
for (const [id, delta] of [
  ["#zoom-out", -10],
  ["#zoom-in", 10]
]) {
  document.querySelector(id).addEventListener("click", () => {
    setZoom(Number(zoomInput.value) + delta);
  });
}
zoomInput.addEventListener("change", () => setZoom(zoomInput.value));
zoomInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    setZoom(zoomInput.value);
    zoomInput.blur();
  }
});
pageInput.addEventListener("change", () => goToPage(pageInput.value));
pageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    goToPage(pageInput.value);
    pageInput.blur();
  }
});
function turnViewport(direction) {
  beginReaderNavigation();
  const target = htmlFrame?.contentWindow || viewport;
  target.scrollBy({
    top:
      Math.max(160, (htmlFrame?.contentWindow?.innerHeight || viewport.clientHeight) * 0.86) *
      direction,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
  });
}
function handleReaderKeydown(event) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.target.closest?.(
      "input,textarea,select,button,a,audio,video,[contenteditable]:not([contenteditable=false])"
    )
  )
    return;
  if (["PageDown", " ", "ArrowDown", "PageUp", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    turnViewport(
      ["PageUp", "ArrowUp"].includes(event.key) || (event.key === " " && event.shiftKey) ? -1 : 1
    );
  }
}
document.addEventListener("keydown", handleReaderKeydown);
document
  .querySelector("#page-prev")
  .addEventListener("click", () =>
    documentState.pageCount ? goToPage(documentState.page - 1) : turnViewport(-1)
  );
document
  .querySelector("#page-next")
  .addEventListener("click", () =>
    documentState.pageCount ? goToPage(documentState.page + 1) : turnViewport(1)
  );

async function goToPage(value, generation = beginReaderNavigation()) {
  try {
    if (!documentState.pageCount || !isReaderGenerationCurrent("navigation", generation))
      return false;
    const page = VoiceOfMLReader.clampNumber(value, 1, documentState.pageCount, 1);
    await pdfShellsReady;
    if (!isReaderGenerationCurrent("navigation", generation)) return false;
    const shell = content.querySelector(
      `.reader-page[data-page="${page}"], .reader-docx-page[data-page="${page}"]`
    );
    if (!shell) return false;
    if (capability.mode === "pdf-pages") await renderPdfManifestShell(shell, false, true);
    else if (shell.classList.contains("reader-page")) await renderPdfShell(shell, false, true);
    if (!isReaderGenerationCurrent("navigation", generation)) return false;
    viewport.scrollTop = shell.offsetTop;
    pageNavigationLockUntil = performance.now() + 500;
    updateDocumentState({ page });
    pageInput.value = String(page);
    updateTocCurrentMark();
    updateProgressTools();
    scheduleSave();
    return true;
  } catch (error) {
    handlePageNavigationFailure(error, generation);
    return false;
  }
}
function scheduleSave() {
  if (readerLifecycle.disposed || readerAbortController.signal.aborted) return;
  const now = performance.now();
  if (!saveDeadline) saveDeadline = now + 2000;
  readerRuntime.cancel(saveTimer);
  saveTimer = readerRuntime.schedule(
    () => {
      saveTimer = 0;
      saveDeadline = 0;
      saveProgress();
    },
    Math.max(0, Math.min(500, saveDeadline - now))
  );
}
async function saveProgress(event) {
  if (
    readerLifecycle.disposed ||
    !documentState.restorationReady ||
    !validSource(sourceUrl) ||
    historySuppressed
  )
    return;
  if (event?.type !== "pagehide" && document.visibilityState !== "hidden")
    syncCurrentPageFromMarker();
  const shell = documentState.pageCount
    ? content.querySelector(
        `.reader-page[data-page="${documentState.page}"], .reader-docx-page[data-page="${documentState.page}"]`
      )
    : null;
  const pageOffset = shell ? Math.max(0, viewport.scrollTop - shell.offsetTop) : 0;
  const htmlScrollTop = htmlFrame && htmlFrame.contentWindow ? htmlFrame.contentWindow.scrollY : 0;
  const readerUrl = currentReaderUrl();
  const foliatePosition = captureFoliateBookmarkPosition() || captureChapterPosition();
  const progress = {
    url: sourceUrl,
    title: documentState.title,
    extension,
    readerUrl: readerUrl.href,
    page: documentState.page,
    pageCount: documentState.pageCount,
    pageOffset,
    mediaTime:
      mediaElement && Number.isFinite(mediaElement.currentTime) ? mediaElement.currentTime : 0,
    scrollTop: viewport.scrollTop,
    htmlScrollTop,
    zoom: Math.round(documentState.zoom * 100),
    ...(foliatePosition || {})
  };
  const signature = JSON.stringify(progress);
  if (signature === lastSavedProgress) return progressSaveChain;
  lastSavedProgress = signature;
  progressSaveChain = progressSaveChain
    .catch(() => {})
    .then(() => {
      if (!historySuppressed)
        return VoiceOfMLReaderStore.put({ ...progress, lastReadAt: Date.now() });
    })
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
  for (const mark of view.querySelectorAll("mark.search-match")) mark.replaceWith(mark.textContent);
  view.normalize();
}
function highlightPanelItem(item, query) {
  const nodes = [];
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  while (walker.nextNode())
    if (!walker.currentNode.parentElement.closest(".panel-item-remove"))
      nodes.push(walker.currentNode);
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  for (const node of nodes) {
    const text = node.data,
      matches = [...text.matchAll(pattern)];
    if (!matches.length) continue;
    let start = 0;
    const fragment = document.createDocumentFragment();
    for (const match of matches) {
      fragment.append(text.slice(start, match.index));
      const mark = document.createElement("mark");
      mark.className = "search-match";
      mark.textContent = match[0];
      fragment.append(mark);
      start = match.index + match[0].length;
    }
    fragment.append(text.slice(start));
    node.replaceWith(fragment);
  }
}
function filterPanel(view) {
  clearSearchHighlights(view);
  const query = (view.querySelector(".panel-search").value || "").trim().toLowerCase();
  for (const item of view.querySelectorAll(".panel-item")) {
    const searchableText = [...item.children]
      .filter((child) => !child.classList.contains("panel-item-remove"))
      .map((child) => child.textContent)
      .join(" ")
      .toLowerCase();
    item.hidden = !!query && !searchableText.includes(query);
    if (query && !item.hidden) highlightPanelItem(item, query);
  }
}
let panelAnimationTimer = 0;
function setReaderPanelOpen(open, restoreFocus = false) {
  readerRuntime.update("panel", { open });
  const panel = document.querySelector("#history-panel");
  clearTimeout(panelAnimationTimer);
  document.querySelector("#history").setAttribute("aria-expanded", String(open));
  if (open) {
    panel.hidden = false;
    void panel.offsetWidth;
    panel.classList.add("is-open");
    selectPanel(mediaElement ? "media" : "toc");
    return;
  }
  panel.classList.remove("is-open");
  panelAnimationTimer = setTimeout(() => {
    if (!panel.classList.contains("is-open")) panel.hidden = true;
  }, 250);
  if (restoreFocus) document.querySelector("#history").focus({ preventScroll: true });
}
function setPanelSearchOpen(button, open) {
  const input = button.closest(".reader-panel-view").querySelector(".panel-search");
  button.setAttribute("aria-expanded", String(open));
  if (open) {
    input.hidden = false;
    void input.offsetWidth;
    input.classList.add("is-open");
    input.focus();
    return;
  }
  input.classList.remove("is-open");
  setTimeout(() => {
    if (!input.classList.contains("is-open")) input.hidden = true;
  }, 190);
  button.focus();
}
function selectPanel(name) {
  if (name === "media" && mediaTab.hidden) name = "bookmarks";
  updatePanelState({ selected: name });
  if (progressTools) progressTools.hidden = !["toc", "media"].includes(name);
  for (const button of document.querySelectorAll(".reader-panel-tabs button")) {
    const selected = button.dataset.panel === name;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const view of document.querySelectorAll(".reader-panel-view"))
    view.hidden = view.dataset.panelView !== name;
  if (name === "bookmarks") renderBookmarks();
  if (name === "history") renderHistory();
  if (name === "media" && mediaElement)
    mediaPanel.querySelector(".media-panel-time").textContent =
      `${formatMediaTime(mediaElement.currentTime)} / ${formatMediaTime(mediaElement.duration)}`;
  updateProgressTools();
}
function headingTocEntries(root) {
  return [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")]
    .filter((heading) => heading.textContent.trim())
    .map((target) => ({
      label: target.textContent.trim(),
      depth: Number(target.tagName.slice(1)) - 1,
      target,
      activate: () => target.scrollIntoView({ block: "start" })
    }));
}
function syncHeadingLocation() {
  const marker = htmlFrame ? 8 : viewport.getBoundingClientRect().top + 8;
  let current = -1;
  for (const [index, entry] of navigationState.tocEntries.entries()) {
    if (!entry.target?.isConnected) continue;
    if (entry.target.getBoundingClientRect().top <= marker || current < 0) current = index;
  }
  if (current >= 0 && current !== navigationState.currentChapterIndex) {
    updateNavigationState({ currentChapterIndex: current });
    updateTocCurrentMark();
  }
}
function handleReaderPositionChange() {
  if (readerAbortController.signal.aborted) return;
  scheduleMarkerSync();
  scheduleFoliateScrollSync();
  foliateScrollAnchors.remember();
}
async function navigateTocEntry(index) {
  if (index < 0 || index >= navigationState.tocEntries.length) return;
  const generation = beginReaderNavigation(),
    entry = navigationState.tocEntries[index];
  try {
    const activated = foliateContinuous
      ? await activateFoliateTocEntry(entry, generation)
      : await entry.activate(generation);
    if (activated === false || !isReaderGenerationCurrent("navigation", generation)) return;
    updateNavigationState({ currentChapterIndex: index });
    updateTocCurrentMark();
    updateProgressTools();
    setReaderPanelOpen(false, true);
  } catch (error) {
    reportNavigationError(error, generation);
  }
}
function setToc(entries) {
  const normalizedEntries = (entries || []).map((entry) => ({
    ...entry,
    href: String(entry.href || ""),
    label: cleanTocLabel(entry.label)
  }));
  updateNavigationState({
    tocEntries: normalizedEntries,
    currentChapterIndex: normalizedEntries.length ? 0 : -1
  });
  const tocTab = document.querySelector("#toc-tab");
  tocTab.hidden = false;
  tocTab.textContent = normalizedEntries.length ? "目录" : "阅读";
  const previousList = document.querySelector("#toc-list"),
    list = previousList.cloneNode(false);
  previousList.replaceWith(list);
  for (const [index, entry] of normalizedEntries.entries()) {
    const row = document.createElement("div");
    row.className = "panel-item toc-item";
    row.style.setProperty("--toc-depth", String(entry.depth || 0));
    const link = document.createElement("div");
    link.className = "panel-item-main";
    link.tabIndex = 0;
    link.setAttribute("role", "link");
    link.textContent = entry.label;
    const activate = () => {
      if (!getSelection().toString()) navigateTocEntry(index);
    };
    link.addEventListener("click", activate);
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
    row.appendChild(link);
    list.appendChild(row);
  }
  updateTocCurrentMark();
}
function cleanTocLabel(value) {
  return (
    String(value || "未命名章节")
      .replace(/[\uFFFD\u2610-\u2612\u25a1\u0000-\u001F\u007F]/gu, "")
      .replace(/\s{2,}/gu, " ")
      .trim() || "未命名章节"
  );
}
function updateTocCurrentMark() {
  const rows = [...document.querySelectorAll("#toc-list .toc-item")];
  if (documentState.pageCount > 1 && documentState.page > 0) {
    let pageIndex = -1;
    for (const [index, row] of rows.entries()) {
      const match = row.textContent.match(/第\s*(\d+)\s*页/u);
      if (match && Number(match[1]) <= documentState.page) pageIndex = index;
    }
    if (pageIndex >= 0) updateNavigationState({ currentChapterIndex: pageIndex });
  }
  for (const [index, row] of rows.entries()) {
    let mark = row.querySelector(".toc-current-mark");
    if (!mark) {
      mark = document.createElement("span");
      mark.className = "toc-current-mark";
      mark.textContent = "✓";
      row.appendChild(mark);
    }
    mark.hidden = index !== navigationState.currentChapterIndex;
    row.classList.toggle("is-current", index === navigationState.currentChapterIndex);
  }
}
function syncFoliateScrollLocation() {
  if (!foliateContinuous || !navigationState.tocEntries.length) return;
  const rows = [...document.querySelectorAll(".foliate-continuous article[data-section]")],
    top = viewport.getBoundingClientRect().top + 80;
  let sectionIndex = -1,
    sectionNode = null;
  for (const row of rows)
    if (row.getBoundingClientRect().top <= top) {
      sectionIndex = Number(row.dataset.section);
      sectionNode = row;
    }
  if (!sectionNode) return;
  let best = -1;
  for (const [index, entry] of navigationState.tocEntries.entries()) {
    if (entry.sectionIndex !== sectionIndex) continue;
    let position = sectionNode.getBoundingClientRect().top;
    if (entry.fragment) {
      const anchor = foliateSectionQuery(
        sectionNode,
        `[id="${CSS.escape(entry.fragment)}"], [name="${CSS.escape(entry.fragment)}"]`
      );
      if (anchor) position = anchor.getBoundingClientRect().top;
    }
    if (position <= top || best < 0) best = index;
  }
  if (best >= 0 && best !== navigationState.currentChapterIndex) {
    updateNavigationState({ currentChapterIndex: best });
    updateTocCurrentMark();
    updateProgressTools();
  }
}
function refreshFoliateWindow() {
  foliateWindowFrame = 0;
  if (!foliateChapterRepository) return;
  const viewportRect = viewport.getBoundingClientRect();
  for (const placeholder of document.querySelectorAll(
    ".foliate-continuous article.foliate-section-placeholder[data-section]"
  )) {
    const rect = placeholder.getBoundingClientRect();
    if (rect.bottom > viewportRect.top - 1000 && rect.top < viewportRect.bottom + 1000)
      foliateChapterRepository.load(Number(placeholder.dataset.section)).catch(() => {});
  }
}
function scheduleFoliateWindowRefresh() {
  if (!foliateWindowFrame) foliateWindowFrame = requestAnimationFrame(refreshFoliateWindow);
}
function trimFoliateSections() {
  if (!foliateContinuous || !foliateSectionVirtualizer) return;
  const marker = viewport.getBoundingClientRect().top + 80,
    rows = [...document.querySelectorAll(".foliate-continuous article[data-section]")],
    current =
      rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top <= marker && rect.bottom > marker;
      }) || rows.find((row) => row.getBoundingClientRect().top > marker);
  if (current) foliateSectionVirtualizer.trim(Number(current.dataset.section));
}
function scheduleFoliateScrollSync() {
  if (foliateScrollFrame) return;
  foliateScrollFrame = requestAnimationFrame(() => {
    foliateScrollFrame = 0;
    syncFoliateScrollLocation();
    foliateScrollAnchors.whenIdle(trimFoliateSections);
  });
}
async function activateFoliateTocEntry(entry, generation = beginReaderNavigation()) {
  const book = epubRendition?.book,
    href = String(entry.href || ""),
    target = await epubRendition?.book?.resolveHref(href);
  if (!book || !isReaderGenerationCurrent("navigation", generation)) return false;
  const section = target && book.sections[target.index],
    sections = book.sections.filter((item) => item.linear !== "no"),
    visibleIndex = section ? sections.indexOf(section) : -1;
  if (!section || visibleIndex < 0 || !foliateSectionLoader) return false;
  let node = await foliateSectionLoader(visibleIndex);
  if (!isReaderGenerationCurrent("navigation", generation)) return false;
  if (foliateSectionSettler) await foliateSectionSettler();
  if (!isReaderGenerationCurrent("navigation", generation)) return false;
  if (!node?.isConnected) node = await foliateSectionLoader(visibleIndex);
  if (!node?.isConnected || !isReaderGenerationCurrent("navigation", generation)) return false;
  const root = foliateSectionRoot(node),
    anchorDocument = {
      getElementById: (id) => root.querySelector(`[id="${CSS.escape(id)}"]`),
      querySelector: (selector) => root.querySelector(selector)
    };
  let anchor = null;
  try {
    anchor = typeof target.anchor === "function" ? target.anchor(anchorDocument) : null;
  } catch (_) {}
  if (!anchor) {
    const fragment = href.split("#")[1] || "",
      id = fragment ? decodeURIComponent(fragment) : "";
    anchor = id ? root.querySelector(`[id="${CSS.escape(id)}"], [name="${CSS.escape(id)}"]`) : null;
  }
  const destination = anchor || node;
  foliateScrollAnchors.invalidate();
  viewport.scrollTop = Math.max(
    0,
    viewport.scrollTop +
      destination.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top -
      8
  );
  syncFoliateScrollLocation();
  updateTocCurrentMark();
  updateProgressTools();
  scheduleSave();
  setReaderPanelOpen(false, true);
  return true;
}
document.addEventListener("click", async (event) => {
  const path = event.composedPath(),
    link = path.find((node) => node instanceof Element && node.matches?.("a[href]")),
    article = path.find(
      (node) =>
        node instanceof Element && node.matches?.(".foliate-continuous article[data-section]")
    );
  if (!link || !article || !epubRendition?.book) return;
  const raw = link.getAttribute("href") || "";
  if (!raw || epubRendition.book.isExternal?.(raw) || /^(?:https?:|mailto:|tel:)/i.test(raw))
    return;
  event.preventDefault();
  const generation = beginReaderNavigation(),
    index = Number(article.dataset.section),
    section = epubRendition.book.sections.filter((item) => item.linear !== "no")[index];
  let href = raw;
  try {
    href = section?.resolveHref?.(raw) || raw;
  } catch (_) {}
  try {
    await activateFoliateTocEntry({ href }, generation);
  } catch (error) {
    reportNavigationError(error, generation);
  }
});
function placeReadingProgress() {
  const panel = document.querySelector("#history-panel"),
    tocPanel = document.querySelector("#toc-panel"),
    tocList = tocPanel.querySelector(".panel-list"),
    noToc = loadingStatus.hidden && !navigationState.tocEntries.length && !mediaElement;
  progressTools.classList.toggle("reader-no-toc", noToc);
  tocPanel.querySelector(".panel-view-header strong").textContent = noToc ? "阅读状态" : "目录";
  if (
    noToc &&
    (progressTools.parentElement !== tocPanel || progressTools.nextElementSibling !== tocList)
  )
    tocPanel.insertBefore(progressTools, tocList);
  else if (!noToc && panel.lastElementChild !== progressTools) panel.appendChild(progressTools);
}
function currentReaderUrl() {
  const url = new URL(location.href);
  for (const key of ["return", "nav", "bookmark", "bookmark_source"]) url.searchParams.delete(key);
  return url;
}
async function loadReaderRestoration() {
  try {
    const bookmarkId = params.get("bookmark"),
      bookmarkSource = params.get("bookmark_source");
    if (bookmarkId && bookmarkSource === sourceUrl) {
      const entries = await VoiceOfMLReaderStore.listBookmarks(sourceUrl);
      const bookmark = entries.find((entry) => entry.id === bookmarkId && entry.url === sourceUrl);
      if (bookmark) return bookmark;
    }
    return await VoiceOfMLReaderStore.get(sourceUrl);
  } catch (_) {
    restorationFailed = true;
    return null;
  }
}
function consumeBookmarkHandoff(entry) {
  if (!entry || entry.id !== params.get("bookmark") || entry.url !== params.get("bookmark_source"))
    return;
  const opening = new URL(location.href);
  const shareKey = (url) => {
    const key = new URL(url);
    key.searchParams.delete("return");
    key.searchParams.delete("nav");
    return key.href;
  };
  const cleanMatchingUrl = (raw) => {
    if (typeof raw !== "string" || !raw) return null;
    try {
      const url = new URL(raw, location.origin);
      if (
        url.origin !== location.origin ||
        url.pathname !== opening.pathname ||
        shareKey(url) !== shareKey(opening)
      )
        return null;
      url.searchParams.delete("bookmark");
      url.searchParams.delete("bookmark_source");
      return url.href;
    } catch (_) {
      return null;
    }
  };
  const cleanHistory = (owner) => {
    const url = cleanMatchingUrl(owner.location.href);
    if (!url) return;
    const state = owner.history.state;
    const readerUrl = state?.voiceReaderOverlay && cleanMatchingUrl(state.readerUrl);
    owner.history.replaceState(readerUrl ? { ...state, readerUrl } : state, "", url);
  };
  // Clean only this navigation, not a bookmark-ID cache. A new deliberate click
  // can reuse the same bookmark; overlay reload/Back uses the cleaned records.
  try {
    if (
      window.parent !== window &&
      window.parent.location.origin === location.origin &&
      window.frameElement?.matches("iframe.reader-overlay") &&
      window.parent.history.state?.voiceReaderOverlay === true &&
      cleanMatchingUrl(window.parent.history.state.readerUrl)
    )
      cleanHistory(window.parent);
  } catch (_) {}
  try {
    const saved = JSON.parse(sessionStorage.getItem("reader-navigation-current") || "null");
    const readerUrl = cleanMatchingUrl(saved?.readerUrl),
      shareUrl = cleanMatchingUrl(saved?.shareUrl);
    if (readerUrl && shareUrl)
      sessionStorage.setItem(
        "reader-navigation-current",
        JSON.stringify({ ...saved, readerUrl, shareUrl })
      );
  } catch (_) {}
  try {
    cleanHistory(window);
  } catch (_) {}
  params.delete("bookmark");
  params.delete("bookmark_source");
}
async function navigateReader(rawUrl, bookmark = null) {
  let target;
  try {
    target = new URL(rawUrl, location.origin);
    if (
      target.origin !== location.origin ||
      target.pathname !== "/search/static/reader.html" ||
      target.username ||
      target.password
    )
      return;
    target.searchParams.delete("bookmark");
    target.searchParams.delete("bookmark_source");
    if (bookmark) {
      if (
        typeof bookmark.id !== "string" ||
        !bookmark.id ||
        typeof bookmark.url !== "string" ||
        !bookmark.url
      )
        return;
      target.searchParams.set("bookmark", bookmark.id);
      target.searchParams.set("bookmark_source", bookmark.url);
    }
  } catch (_) {
    return;
  }
  const generation = beginReaderNavigation();
  await saveProgress();
  if (!isReaderGenerationCurrent("navigation", generation)) return;
  if (window.parent !== window)
    window.parent.postMessage({ type: "voice-reader-open", url: target.href }, location.origin);
  else location.assign(target.href);
}
async function renderHistory() {
  const list = document.querySelector("#history-list"),
    generation = nextReaderGeneration("history");
  try {
    const entries = await VoiceOfMLReaderStore.list();
    if (!isReaderGenerationCurrent("history", generation)) return;
    list.textContent = "";
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "panel-item";
      if (entry.mediaTime != null) row.dataset.mediaTime = String(entry.mediaTime);
      const link = document.createElement("button");
      link.type = "button";
      link.className = "panel-item-main";
      link.textContent = entry.title || entry.url;
      link.addEventListener("click", () => navigateReader(entry.readerUrl));
      const meta = document.createElement("small");
      meta.textContent = `${entry.pageCount ? `第 ${entry.page || 1} / ${entry.pageCount} 页 · ` : ""}${new Date(entry.lastReadAt).toLocaleString()}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "panel-item-remove";
      remove.textContent = "删除";
      remove.addEventListener("click", async () => {
        if (entry.url === sourceUrl) {
          historySuppressed = true;
          await progressSaveChain;
        }
        await VoiceOfMLReaderStore.remove(entry.url);
        renderHistory();
      });
      row.append(link, remove, meta);
      list.appendChild(row);
    }
    if (!list.childElementCount) emptyPanel(list, "暂无阅读记录");
    filterPanel(document.querySelector("#history-view"));
  } catch (_) {
    if (isReaderGenerationCurrent("history", generation)) emptyPanel(list, "无法读取本地记录");
  }
}
function readerProgressPercent() {
  if (mediaElement)
    return mediaElement.duration
      ? Math.round((mediaElement.currentTime / mediaElement.duration) * 1000) / 10
      : 0;
  if (foliateContinuous) {
    const position = captureFoliateBookmarkPosition(),
      count = epubBook?.sections?.filter((section) => section.linear !== "no").length || 0,
      article =
        position &&
        document.querySelector(
          `.foliate-continuous article[data-section="${position.foliateSection}"]`
        ),
      fraction = article
        ? Math.max(
            0,
            Math.min(
              1,
              position.foliateOffset / Math.max(1, article.getBoundingClientRect().height)
            )
          )
        : 0;
    return count && position
      ? Math.round(((position.foliateSection + fraction) / count) * 1000) / 10
      : 0;
  }
  if (htmlFrame && htmlFrame.contentDocument) {
    const doc = htmlFrame.contentDocument.documentElement,
      win = htmlFrame.contentWindow;
    return (
      Math.round(
        Math.max(0, Math.min(1, win.scrollY / Math.max(1, doc.scrollHeight - win.innerHeight))) *
          1000
      ) / 10
    );
  }
  return (
    Math.round(
      Math.max(
        0,
        Math.min(1, viewport.scrollTop / Math.max(1, viewport.scrollHeight - viewport.clientHeight))
      ) * 1000
    ) / 10
  );
}
function excerptFromCaret(doc, root, x, y) {
  let node,
    offset = 0;
  const position = doc.caretPositionFromPoint ? doc.caretPositionFromPoint(x, y) : null;
  if (position) {
    node = position.offsetNode;
    offset = position.offset;
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || !root.contains(node)) return "";
  if (node.nodeType !== Node.TEXT_NODE) {
    const first = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
    if (!first) return "";
    node = first;
    offset = 0;
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  walker.currentNode = node;
  let excerpt = node.data.slice(offset);
  while (excerpt.length < 220 && walker.nextNode()) excerpt += ` ${walker.currentNode.data}`;
  return excerpt.replace(/\s+/g, " ").trim().slice(0, 160);
}
function bookmarkExcerpt() {
  if (["image", "audio", "video"].includes(capability.mode)) return "";
  if (capability.mode === "pdf") {
    const shell = pageAtMarker(),
      items = shell && shell._bookmarkTextItems;
    if (items && items.length) {
      const rect = shell.getBoundingClientRect(),
        targetY =
          Math.max(0, bookmarkRibbon.getBoundingClientRect().bottom - rect.top) /
          Math.max(1, rect.height);
      let nearest = 0,
        distance = Infinity;
      items.forEach((item, index) => {
        const nextDistance = Math.abs(item.y - targetY);
        if (nextDistance < distance) {
          nearest = index;
          distance = nextDistance;
        }
      });
      return items
        .slice(nearest)
        .map((item) => item.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
    }
  }
  const x = Math.round(viewport.getBoundingClientRect().width / 2),
    y = Math.round(bookmarkRibbon.getBoundingClientRect().bottom + 8);
  const frames = [...document.querySelectorAll("iframe")].filter((frame) => {
    const rect = frame.getBoundingClientRect();
    return rect.left <= x && rect.right >= x && rect.top <= y && rect.bottom >= y;
  });
  const frame = frames[frames.length - 1];
  try {
    if (frame && frame.contentDocument && frame.contentDocument.body) {
      const rect = frame.getBoundingClientRect();
      return excerptFromCaret(
        frame.contentDocument,
        frame.contentDocument.body,
        x - rect.left,
        y - rect.top
      );
    }
  } catch (_) {}
  const exact = excerptFromCaret(document, content, x, y);
  if (exact) return exact;
  const sourceText = foliateContinuous
      ? [
          ...content.querySelectorAll(
            ".foliate-continuous article[data-section]:not(.foliate-section-placeholder)"
          )
        ]
          .map((article) => foliateSectionRoot(article).textContent)
          .join(" ")
      : content.textContent,
    text = sourceText.replace(/\s+/g, " ").trim(),
    start = Math.floor((text.length * readerProgressPercent()) / 100);
  return text.slice(start, start + 160).trim();
}
function captureFoliateBookmarkPosition() {
  if (!foliateContinuous) return null;
  const marker = viewport.getBoundingClientRect().top + 8,
    rows = [...document.querySelectorAll(".foliate-continuous article[data-section]")];
  const article =
    rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top <= marker && rect.bottom > marker;
    }) ||
    rows.find((row) => row.getBoundingClientRect().top > marker) ||
    rows[rows.length - 1];
  return article
    ? {
        foliateSection: Number(article.dataset.section),
        foliateOffset: marker - article.getBoundingClientRect().top,
        foliateTocIndex: navigationState.currentChapterIndex
      }
    : null;
}
async function restoreFoliateBookmarkPosition(entry, generation = beginReaderNavigation()) {
  try {
    if (
      !foliateSectionLoader ||
      !Number.isInteger(entry.foliateSection) ||
      !isReaderGenerationCurrent("navigation", generation)
    )
      return false;
    let article = await foliateSectionLoader(entry.foliateSection);
    if (!isReaderGenerationCurrent("navigation", generation)) return false;
    if (foliateSectionSettler) await foliateSectionSettler();
    if (!isReaderGenerationCurrent("navigation", generation)) return false;
    if (!article?.isConnected) article = await foliateSectionLoader(entry.foliateSection);
    if (!article?.isConnected || !isReaderGenerationCurrent("navigation", generation)) return false;
    const marker = viewport.getBoundingClientRect().top + 8;
    foliateScrollAnchors.invalidate();
    viewport.scrollTop = Math.max(
      0,
      viewport.scrollTop +
        article.getBoundingClientRect().top -
        marker +
        (Number(entry.foliateOffset) || 0)
    );
    if (
      Number.isInteger(entry.foliateTocIndex) &&
      entry.foliateTocIndex >= 0 &&
      entry.foliateTocIndex < navigationState.tocEntries.length
    )
      updateNavigationState({ currentChapterIndex: entry.foliateTocIndex });
    updateTocCurrentMark();
    updateProgressTools();
    scheduleSave();
    setReaderPanelOpen(false, true);
    return true;
  } catch (error) {
    reportNavigationError(error, generation);
    return false;
  }
}
async function seekFoliateProgress(percent, generation) {
  try {
    const sections = epubBook?.sections?.filter((section) => section.linear !== "no") || [];
    if (
      !sections.length ||
      !foliateSectionLoader ||
      !isReaderGenerationCurrent("navigation", generation)
    )
      return;
    const position = Math.max(0, Math.min(0.999999, Number(percent) / 100)) * sections.length,
      index = Math.min(sections.length - 1, Math.floor(position));
    let article = await foliateSectionLoader(index);
    if (!isReaderGenerationCurrent("navigation", generation)) return;
    if (foliateSectionSettler) await foliateSectionSettler();
    if (!isReaderGenerationCurrent("navigation", generation)) return;
    if (!article?.isConnected) article = await foliateSectionLoader(index);
    if (!article?.isConnected || !isReaderGenerationCurrent("navigation", generation)) return;
    const marker = viewport.getBoundingClientRect().top + 8,
      offset = article.getBoundingClientRect().height * (position - index);
    foliateScrollAnchors.invalidate();
    viewport.scrollTop = Math.max(
      0,
      viewport.scrollTop + article.getBoundingClientRect().top - marker + offset
    );
    syncFoliateScrollLocation();
    updateTocCurrentMark();
    updateProgressTools();
    scheduleSave();
  } catch (error) {
    reportNavigationError(error, generation);
  }
}
async function renderBookmarks() {
  const list = document.querySelector("#bookmarks-list"),
    generation = nextReaderGeneration("bookmarks");
  try {
    const entries = panelState.showingAllBookmarks
      ? await VoiceOfMLReaderStore.listAllBookmarks()
      : await VoiceOfMLReaderStore.listBookmarks(sourceUrl);
    if (!isReaderGenerationCurrent("bookmarks", generation)) return;
    list.textContent = "";
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "panel-item";
      row.dataset.bookmarkId = entry.id;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "panel-item-main";
      open.textContent = panelState.showingAllBookmarks
        ? `${entry.title || "未命名书籍"} · ${entry.label}`
        : entry.label;
      open.addEventListener("click", () =>
        entry.url !== sourceUrl
          ? navigateReader(entry.readerUrl, entry)
          : restoreFormat(capability.mode, entry)
      );
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
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "panel-item-edit";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => openBookmarkPopover(edit, entry));
      row.append(open, edit, remove, excerpt, meta);
      list.appendChild(row);
    }
    if (!list.childElementCount) emptyPanel(list, "暂无书签");
    filterPanel(document.querySelector("#bookmarks-panel"));
  } catch (_) {
    if (isReaderGenerationCurrent("bookmarks", generation)) emptyPanel(list, "无法读取书签");
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
  if (performance.now() < pageNavigationLockUntil) return;
  const page = pageAtMarker();
  if (!page) return;
  const next = Number(page.dataset.page);
  if (!next || next === documentState.page) return;
  updateDocumentState({ page: next });
  pageInput.value = String(next);
  updateTocCurrentMark();
  updateProgressTools();
}
function scheduleMarkerSync() {
  if (markerFrame) return;
  markerFrame = requestAnimationFrame(() => {
    markerFrame = 0;
    if (readerAbortController.signal.aborted) return;
    syncCurrentPageFromMarker();
    syncHeadingLocation();
    updateProgressTools();
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
    const time = Number.isFinite(mediaElement.currentTime) ? mediaElement.currentTime : 0;
    return {
      locator: `media:${Math.round(time * 10) / 10}`,
      label: `时间 ${formatMediaTime(time)}`,
      excerpt: "",
      progress: mediaElement.duration ? Math.round((time / mediaElement.duration) * 1000) / 10 : 0,
      mediaTime: time,
      page: 0,
      pageOffset: 0,
      scrollTop: 0,
      htmlScrollTop: 0
    };
  }
  syncCurrentPageFromMarker();
  const foliatePosition = captureFoliateBookmarkPosition() || captureChapterPosition();
  const shell = documentState.pageCount ? pageAtMarker() : null;
  const pageOffset = shell ? Math.max(0, viewport.scrollTop - shell.offsetTop) : 0;
  const progress = readerProgressPercent();
  const htmlScrollTop = htmlFrame && htmlFrame.contentWindow ? htmlFrame.contentWindow.scrollY : 0;
  const scrollTop = viewport.scrollTop;
  const pagedDocument = documentState.pageCount && !["text", "markdown"].includes(capability.mode);
  const locator = Number.isInteger(foliatePosition?.chapterIndex)
    ? `chapter:${foliatePosition.chapterIndex}:${Math.round(foliatePosition.chapterOffset)}`
    : foliatePosition
      ? `foliate:${foliatePosition.foliateSection}:${Math.round(foliatePosition.foliateOffset)}`
      : pagedDocument
        ? `page:${documentState.page}:${Math.round(pageOffset)}`
        : `progress:${progress}:${Math.round(htmlFrame ? htmlScrollTop : scrollTop)}`;
  return {
    locator,
    label: pagedDocument
      ? `第 ${documentState.page} / ${documentState.pageCount} 页`
      : `阅读进度 ${progress.toFixed(1)}%`,
    excerpt: bookmarkExcerpt(),
    progress,
    page: pagedDocument ? documentState.page : 0,
    pageOffset,
    scrollTop,
    htmlScrollTop,
    ...(foliatePosition || {})
  };
}
// Bookmark dialog owns focus and temporarily makes only its siblings inert.
function setBookmarkDialogModal(open) {
  document.documentElement.classList.toggle("bookmark-dialog-open", open);
  if (open) {
    for (let node = bookmarkPopover; node && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children)
        if (sibling !== node && !bookmarkInertSiblings.has(sibling)) {
          bookmarkInertSiblings.set(sibling, sibling.inert);
          sibling.inert = true;
        }
    }
  } else {
    for (const [node, inert] of bookmarkInertSiblings) node.inert = inert;
    bookmarkInertSiblings.clear();
  }
}
function openBookmarkPopover(invoker = bookmarkRibbon, entry = null) {
  if (!bookmarkPopover.hidden) return;
  bookmarkInvoker = invoker;
  pendingBookmarkSnapshot = entry ? null : captureBookmarkSnapshot();
  updatePanelState({ editingBookmark: entry ? { ...entry } : null });
  const snapshot = entry || pendingBookmarkSnapshot;
  document.querySelector("#bookmark-prompt").textContent = entry
    ? `编辑书签 · ${entry.label}`
    : `在${snapshot.label}添加书签？`;
  bookmarkLabelInput.value = snapshot.label || "";
  bookmarkExcerptInput.value = snapshot.excerpt || "";
  document.querySelector("#bookmark-add").textContent = entry ? "保存书签" : "添加书签";
  bookmarkPopover.hidden = false;
  invoker.setAttribute("aria-expanded", "true");
  invoker.setAttribute("aria-controls", bookmarkPopover.id);
  bookmarkLabelInput.focus();
  setBookmarkDialogModal(true);
}
function closeBookmarkPopover() {
  pendingBookmarkSnapshot = null;
  updatePanelState({ editingBookmark: null });
  bookmarkPopover.hidden = true;
  setBookmarkDialogModal(false);
  bookmarkInvoker?.setAttribute("aria-expanded", "false");
  (bookmarkInvoker?.isConnected ? bookmarkInvoker : bookmarkRibbon).focus({ preventScroll: true });
  bookmarkInvoker = null;
}
bookmarkRibbon.addEventListener("click", () => openBookmarkPopover(bookmarkRibbon));
document.querySelector("#bookmark-cancel").addEventListener("click", closeBookmarkPopover);
document.querySelector("#bookmark-add").addEventListener("click", async (event) => {
  const button = event.currentTarget,
    editing = panelState.editingBookmark;
  const snapshot = pendingBookmarkSnapshot || editing || captureBookmarkSnapshot();
  const label = bookmarkLabelInput.value.trim() || snapshot.label,
    excerpt = bookmarkExcerptInput.value.trim();
  button.disabled = true;
  try {
    await VoiceOfMLReaderStore.putBookmark(
      editing
        ? { ...editing, label, excerpt }
        : {
            ...snapshot,
            id: `${sourceUrl}\0${snapshot.locator}`,
            url: sourceUrl,
            title: documentState.title,
            extension,
            readerUrl: currentReaderUrl().href,
            label,
            excerpt,
            createdAt: Date.now()
          }
    );
    const invoker = bookmarkInvoker;
    closeBookmarkPopover();
    if (!document.querySelector("#bookmarks-panel").hidden) {
      await renderBookmarks();
      if (editing && invoker && !invoker.isConnected && document.activeElement === document.body)
        (
          document.querySelector(
            `#bookmarks-list [data-bookmark-id="${CSS.escape(editing.id)}"] .panel-item-edit`
          ) || bookmarksAllButton
        ).focus();
    }
  } catch (_) {
    document.querySelector("#bookmark-prompt").textContent = "书签保存失败，请重试。";
  } finally {
    button.disabled = false;
  }
});
bookmarkPopover.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeBookmarkPopover();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = [
    ...bookmarkPopover.querySelectorAll("input,textarea,select,button,a[href],[tabindex]")
  ].filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
  const first = controls[0],
    last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
for (const button of document.querySelectorAll(".reader-panel-tabs button"))
  button.addEventListener("click", () => selectPanel(button.dataset.panel));
document.querySelector(".reader-panel-tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...document.querySelectorAll(".reader-panel-tabs button:not([hidden])")],
    current = tabs.indexOf(document.activeElement);
  if (current < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  selectPanel(tabs[next].dataset.panel);
  tabs[next].focus();
});
bookmarksAllButton.addEventListener("click", () => {
  updatePanelState({ showingAllBookmarks: !panelState.showingAllBookmarks });
  bookmarksAllButton.textContent = panelState.showingAllBookmarks ? "本书书签" : "全部书签";
  bookmarksAllButton.setAttribute("aria-pressed", String(panelState.showingAllBookmarks));
  renderBookmarks();
});
for (const button of document.querySelectorAll(".panel-search-toggle")) {
  button.classList.remove("icon-button");
  button.classList.add("text-action");
  button.textContent = "搜索";
  button.hidden = false;
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () =>
    setPanelSearchOpen(button, button.getAttribute("aria-expanded") !== "true")
  );
}
for (const input of document.querySelectorAll(".panel-search")) {
  const view = input.closest(".reader-panel-view");
  input.type = "search";
  input.setAttribute(
    "aria-label",
    `搜索${view.querySelector(".panel-view-header strong")?.textContent || "列表"}`
  );
  input.addEventListener("input", (event) => {
    if (!event.isComposing) filterPanel(view);
  });
  input.addEventListener("compositionend", () => filterPanel(view));
}
document.querySelector("#history-clear").addEventListener("click", async () => {
  if (!confirm("清空全部阅读历史？")) return;
  historySuppressed = true;
  await progressSaveChain;
  await VoiceOfMLReaderStore.clearHistory();
  renderHistory();
});
readerThemeToggle.addEventListener("click", () => {
  const theme = readerTheme === "dark" ? "light" : "dark";
  applyReaderTheme(theme);
  if (window.parent !== window)
    window.parent.postMessage({ type: "voice-reader-theme", theme }, location.origin);
});
window.addEventListener("storage", (event) => {
  if (event.key === "theme" && event.newValue) applyReaderTheme(event.newValue, false);
});
window.addEventListener("message", (event) => {
  if (
    event.origin === location.origin &&
    event.source === window.parent &&
    event.data &&
    event.data.type === "voice-reader-theme-state"
  )
    applyReaderTheme(event.data.theme, false);
});
document
  .querySelector("#history")
  .addEventListener("click", () =>
    setReaderPanelOpen(document.querySelector("#history").getAttribute("aria-expanded") !== "true")
  );
document
  .querySelector("#history-close")
  .addEventListener("click", () => setReaderPanelOpen(false, true));
viewport.addEventListener("scroll", handleReaderPositionChange, { passive: true });
for (const type of ["wheel", "touchstart", "pointerdown"])
  viewport.addEventListener(type, beginReaderNavigation, { passive: true });
window.addEventListener("pagehide", (event) => {
  saveProgress(event);
  if (!event.persisted) disposeReader();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && !readerLifecycle.disposed) {
    scheduleFoliateScrollSync();
    updateProgressTools();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveProgress();
});

function validSource(raw) {
  try {
    const url = new URL(raw);
    const bucketPath = url.searchParams.get("path") || "";
    if (
      url.origin === "https://voiceofml-search.hf.space" &&
      url.pathname === "/api/reader-bucket-resource" &&
      /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}(?:\/[0-9a-f]{16})?\/(?:page-manifest\.json|pages\/page-[0-9]{6}\.webp)$/.test(
        bucketPath
      )
    )
      return true;
    if (url.protocol !== "https:" || !["huggingface.co", "hf-mirror.com"].includes(url.hostname))
      return false;
    const readerAsset =
      /^\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\/(?:pdf_manifest\.json|objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:linearized\.pdf|(?:[a-z0-9-]+\/)?(?:page-manifest\.json|pages\/page-[0-9]{6}\.webp|chapter-manifest\.json|document\.(?:pdf|epub|mobi|azw|azw3|fb2)|book\.epub|document\.docx|document\.html|audio\.mp3|video\.mp4|epub-chapters\/(?:chapter-manifest\.json|chapters\/chapter-[0-9]{4}\.xhtml|resources\/[A-Za-z0-9._~%+\-/]+|epub-search-index\.json\.gz))))$/.test(
        url.pathname
      );
    if (extension === "docx") return readerAsset;
    return /^\/datasets\/VoiceOfML\/[^/]+\/(resolve|raw)\//.test(url.pathname) || readerAsset;
  } catch (_) {
    return false;
  }
}
function validOcr(raw) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.hostname === "voiceofml-search.hf.space" &&
      url.pathname.startsWith("/txt/")
    );
  } catch (_) {
    return false;
  }
}
function validFallback(raw) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      ["huggingface.co", "hf-mirror.com"].includes(url.hostname) &&
      /\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:linearized\.pdf|(?:[a-z0-9-]+\/)?document\.pdf)$/.test(
        url.pathname
      )
    );
  } catch (_) {
    return false;
  }
}
function readerAssetObjectFamily(raw, base = location.href) {
  try {
    const url = new URL(raw, base);
    if (
      url.protocol !== "https:" ||
      !["huggingface.co", "hf-mirror.com"].includes(url.hostname) ||
      url.username ||
      url.password
    )
      return null;
    const match = url.pathname.match(
      /^\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\/(objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:[a-z0-9-]+\/)?)/
    );
    return match
      ? { url, prefix: url.pathname.slice(0, url.pathname.indexOf(match[1])) + match[1] }
      : null;
  } catch (_) {
    return null;
  }
}
function trustedReaderAssetManifestUrl(raw) {
  const family = readerAssetObjectFamily(raw);
  return family &&
    !family.url.search &&
    !family.url.hash &&
    /\/chapter-manifest\.json$/i.test(family.url.pathname)
    ? family.url.href
    : null;
}
function trustedChapterUrl(raw, base) {
  const manifest = readerAssetObjectFamily(base);
  if (!manifest || !/\/chapter-manifest\.json$/i.test(new URL(base, location.href).pathname))
    return null;
  try {
    const url = new URL(raw, base);
    return !url.search &&
      !url.hash &&
      url.origin === manifest.url.origin &&
      url.pathname.startsWith(manifest.prefix) &&
      /\.(?:xhtml?|html?)$/i.test(url.pathname)
      ? url.href
      : null;
  } catch (_) {
    return null;
  }
}
function trustedChapterResourceUrl(raw, base, attribute, manifestBase) {
  const value = String(raw || "").trim();
  if (!value || /^(?:data:|mailto:|tel:|javascript:)/i.test(value)) return null;
  // Chapters and resources can be siblings within the manifest's asset directory.
  const family = readerAssetObjectFamily(manifestBase);
  if (!family) return null;
  try {
    const url = new URL(value, base),
      path = url.pathname.toLowerCase();
    if (url.origin !== family.url.origin || !url.pathname.startsWith(family.prefix)) return null;
    const allowed =
      attribute === "href"
        ? /\.(?:x?html?|css|svg|png|jpe?g|gif|webp|woff2?|ttf|otf|mp3|mp4|m4a|webm|ogg)$/i.test(
            path
          )
        : /\.(?:svg|png|jpe?g|gif|webp|woff2?|ttf|otf|mp3|mp4|m4a|webm|ogg)$/i.test(path);
    return allowed ? url.href : null;
  } catch (_) {
    return null;
  }
}
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}
function fetchWithReaderTimeout(url, timeoutMs = READER_PROXY_TIMEOUT_MS) {
  return readerRequestManager.request(url, timeoutMs);
}
function fetchReaderUrl(rawUrl) {
  if (String(rawUrl).includes("/api/reader-bucket-resource?"))
    return fetchWithReaderTimeout(rawUrl);
  const proxyUrl = readerContentUrl(rawUrl);
  return fetchWithReaderTimeout(proxyUrl).then(
    (response) => (response.ok ? response : fetchWithReaderTimeout(rawUrl)),
    () => fetchWithReaderTimeout(rawUrl)
  );
}
function fetchReaderResponse() {
  const early = window.__VOICE_PDF_PRELOAD__;
  if (early?.manifest && early.manifestUrl === new URL(sourceUrl, location.href).href) {
    const pending = early.manifest;
    early.manifest = null;
    return pending.then(
      (response) => (response?.ok ? response : fetchReaderUrl(sourceUrl)),
      () => fetchReaderUrl(sourceUrl)
    );
  }
  return fetchReaderUrl(sourceUrl);
}
function preloadPdfFirstPage() {
  try {
    const manifestUrl = new URL(sourceUrl, location.href);
    let pageUrl;
    if (manifestUrl.pathname === "/api/reader-bucket-resource") {
      const path = manifestUrl.searchParams.get("path") || "";
      if (!path.endsWith("/page-manifest.json")) return;
      pageUrl = new URL(manifestUrl.href);
      pageUrl.searchParams.set(
        "path",
        path.replace(/\/page-manifest\.json$/, "/pages/page-000001.webp")
      );
    } else if (manifestUrl.pathname.endsWith("/page-manifest.json")) {
      pageUrl = new URL(
        manifestUrl.href.replace(/\/page-manifest\.json(?:\?.*)?$/, "/pages/page-000001.webp")
      );
    } else return;
    const early = window.__VOICE_PDF_PRELOAD__;
    if (early?.image && early.pageUrl === pageUrl.href) pdfFirstPagePreload = early.image;
    else if (!navigator.connection?.saveData) {
      pdfFirstPagePreload = new Image();
      pdfFirstPagePreload.decoding = "async";
      pdfFirstPagePreload.fetchPriority = "low";
      pdfFirstPagePreload.src = pageUrl.href;
    }
  } catch (_) {}
}
function pdfManifestRootPath() {
  try {
    const url = new URL(sourceUrl, location.href);
    const path =
      url.pathname === "/api/reader-bucket-resource"
        ? url.searchParams.get("path") || ""
        : decodeURIComponent(url.pathname).replace(
            /^\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\//,
            ""
          );
    const match = path.match(
      /^(objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/[0-9a-f]{16})\/page-manifest\.json$/
    );
    return match?.[1] || "";
  } catch (_) {
    return "";
  }
}
function pdfPageEntry(page) {
  if (!pdfPageManifest || page < 1 || page > pdfPageManifest.pageCount) return null;
  return (
    pdfPageManifest.entries?.[page - 1] || {
      page,
      path: `${pdfPageManifest.root}/pages/page-${String(page).padStart(6, "0")}.webp`
    }
  );
}
function trimPdfManifestImages(protectedShell) {
  const images = [...content.querySelectorAll('.reader-page[data-render-state="rendered"]')];
  if (images.length <= 25) return;
  images.sort(
    (a, b) =>
      Number(b === protectedShell) - Number(a === protectedShell) ||
      Math.abs(Number(a.dataset.page) - documentState.page) -
        Math.abs(Number(b.dataset.page) - documentState.page)
  );
  for (const shell of images.slice(25)) {
    shell.querySelector("img")?.remove();
    shell.dataset.renderState = "idle";
  }
}
const EPUB_HTML_TAGS = new Set(
  "a,abbr,address,area,article,aside,audio,b,base,bdi,bdo,blockquote,body,br,button,canvas,caption,cite,code,col,colgroup,data,datalist,dd,del,details,dfn,dialog,div,dl,dt,em,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,head,header,hgroup,hr,html,i,iframe,img,input,ins,kbd,label,legend,li,link,main,map,mark,menu,meta,meter,nav,noscript,object,ol,optgroup,option,output,p,picture,pre,progress,q,rp,rt,ruby,s,samp,script,search,section,select,slot,small,source,span,strong,style,sub,summary,sup,table,tbody,td,template,textarea,tfoot,th,thead,time,title,tr,track,u,ul,var,video,wbr".split(
    ","
  )
);

function normalizeEpubDocument(doc) {
  // Legacy CHM conversions can use an XHTML prefix even in HTML content.
  for (const element of [...doc.querySelectorAll("*")]) {
    const tagName = String(element.tagName || "").toLowerCase();
    const localName = tagName.includes(":") ? tagName.slice(tagName.lastIndexOf(":") + 1) : tagName;
    if (tagName === localName || !EPUB_HTML_TAGS.has(localName)) continue;
    const replacement = doc.createElement(localName);
    for (const attribute of [...element.attributes]) {
      if (!attribute.name.toLowerCase().startsWith("xmlns:"))
        replacement.setAttribute(attribute.name, attribute.value);
    }
    while (element.firstChild) replacement.appendChild(element.firstChild);
    element.replaceWith(replacement);
  }
  return doc;
}

function sanitizeReaderDocument(doc, { preserveEpubStyles = false } = {}) {
  const blocked = preserveEpubStyles
    ? "script,iframe,object,embed,base,form"
    : "script,iframe,object,embed,base,form,link,style";
  for (const node of doc.querySelectorAll(blocked)) node.remove();
  if (preserveEpubStyles) {
    for (const link of doc.querySelectorAll("link")) {
      const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
      if (!rel.includes("stylesheet") || !/^blob:/i.test(link.getAttribute("href") || ""))
        link.remove();
    }
    for (const style of doc.querySelectorAll("style")) {
      if (
        /(?:@import\s+|url\s*\(\s*[\"']?)(?:https?:|\/\/|javascript:)/i.test(
          style.textContent || ""
        )
      )
        style.remove();
    }
  }
  for (const element of doc.querySelectorAll("*"))
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase(),
        value = String(attribute.value || "").trim();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        ((name === "href" || name === "xlink:href" || name === "src") &&
          /^javascript:/i.test(value))
      )
        element.removeAttribute(attribute.name);
    }
  return doc;
}

function sanitizeEpubDocument(doc) {
  return sanitizeReaderDocument(normalizeEpubDocument(doc), { preserveEpubStyles: true });
}

function epubContentBody(doc) {
  const nestedBody = [...doc.querySelectorAll("body")].find((body) => body !== doc.body);
  return nestedBody || doc.body || doc.documentElement;
}
function disposeReader() {
  if (readerLifecycle.disposed) return;
  updateDocumentState({ restorationReady: false });
  readerRuntime.dispose();
  contentSanitizerObserver?.disconnect();
  contentSanitizerObserver = null;
  loadingObserver.disconnect();
  clearTimeout(saveTimer);
  clearTimeout(themeAnimationTimer);
  clearTimeout(panelAnimationTimer);
  for (const frame of [markerFrame, foliateScrollFrame, foliateWindowFrame, epubSeekFrame])
    if (frame) cancelAnimationFrame(frame);
  saveTimer =
    themeAnimationTimer =
    panelAnimationTimer =
    markerFrame =
    foliateScrollFrame =
    foliateWindowFrame =
    epubSeekFrame =
      0;
  VoiceOfMLReaderStore.dispose?.();
}
function fail(message, code = "READER_PARSE") {
  if (readerLifecycle.disposed || readerAbortController.signal.aborted) return;
  updateDocumentState({ restorationReady: false });
  readerRuntime.fail(code);
  stopReaderWork();
  readerRequestManager.dispose();
  formatAdapters.dispose();
  window.__VOICE_PDF_PRELOAD__?.dispose();
  loadingObserver.disconnect();
  content.dataset.errorCode = code;
  loadingStatus.hidden = true;
  loadingIndicator.remove();
  const visibleMessage = `${message} [${readerLifecycle.stage}]`;
  content.innerHTML = `<div class="reader-error"></div>`;
  content.querySelector(".reader-error").textContent = visibleMessage;
  status.textContent = "无法打开";
}

async function appendShellsBatched(createShell, total, batchSize) {
  for (let start = 2; start <= total; start += batchSize) {
    assertReaderActive();
    const fragment = document.createDocumentFragment();
    for (let page = start; page < Math.min(start + batchSize, total + 1); page++)
      fragment.appendChild(createShell(page));
    content.appendChild(fragment);
    await waitForReader();
  }
}
async function renderPdfPages(prepared) {
  const response = await prepared;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const manifest = VoiceOfMLReaderSecurity.validatePdfPageManifest(
    JSON.parse(
      await VoiceOfMLReaderSecurity.readText(response, VoiceOfMLReaderSecurity.LIMITS.manifestBytes)
    )
  );
  assertReaderActive();
  const entries =
    manifest.version === 1
      ? manifest.pages
          .map((item) => ({ page: Number(item.page), path: String(item.path || "") }))
          .sort((a, b) => a.page - b.page)
      : null;
  const rootMatch = entries
    ? entries[0]?.path.match(/^(objects\/[0-9a-f]{2}\/[0-9a-f]{64}(?:\/[0-9a-f]{16})?)\/pages\//)
    : pdfManifestRootPath()?.match(/^(objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/[0-9a-f]{16})$/);
  const totalPages = entries ? entries.length : manifest.page_count;
  if (
    !rootMatch ||
    (entries &&
      entries.some(
        (item, index) =>
          item.page !== index + 1 ||
          !new RegExp(`^${rootMatch[1]}/pages/page-[0-9]{6}\\.webp$`).test(item.path)
      ))
  )
    throw new Error("PDF_MANIFEST_INVALID");
  pdfPageManifest = { entries, root: rootMatch[1], pageCount: totalPages };
  updateDocumentState({ pageCount: totalPages });
  pageInput.max = String(totalPages);
  document.querySelector("#page-total").textContent = `/ ${totalPages}`;
  status.textContent = `${totalPages} 页`;
  if (Array.isArray(manifest.toc) && manifest.toc.length)
    setToc(
      manifest.toc.map((item) => ({
        label: `${item.title} · 第 ${item.page} 页`,
        depth: item.depth,
        activate: (generation) => goToPage(item.page, generation)
      }))
    );
  const observer = new IntersectionObserver(
    (items) => {
      if (readerAbortController.signal.aborted) return;
      for (const entry of items) if (entry.isIntersecting) renderPdfInBackground(entry.target);
    },
    { root: viewport, rootMargin: "1200px 0px" }
  );
  trackReaderResource(() => observer.disconnect());
  const createShell = (page) => {
    const shell = document.createElement("section");
    shell.className = "reader-page";
    shell.dataset.page = String(page);
    shell.style.aspectRatio = "1 / 1.414";
    shell.tabIndex = 0;
    shell.setAttribute("role", "region");
    shell.setAttribute("aria-label", `第 ${page} 页`);
    if (
      page === 1 &&
      pdfFirstPagePreload &&
      (!pdfFirstPagePreload.complete || pdfFirstPagePreload.naturalWidth)
    )
      shell.appendChild(pdfFirstPagePreload);
    shell.addEventListener("focus", () => renderPdfInBackground(shell));
    observer.observe(shell);
    return shell;
  };
  const firstShell = createShell(1);
  content.appendChild(firstShell);
  pdfShellsReady = appendShellsBatched(createShell, totalPages, 250);
  pdfShellsReady.catch(() => {});
  await renderPdfManifestShell(firstShell, false, true);
}
async function renderPdf(prepared) {
  const pdf = await prepared;
  assertReaderActive();
  pdfDocument = pdf;
  updateDocumentState({ pageCount: pdf.numPages });
  pageInput.max = String(documentState.pageCount);
  document.querySelector("#page-total").textContent = `/ ${documentState.pageCount}`;
  status.textContent = `${pdf.numPages} 页`;
  const firstPage = await pdf.getPage(1);
  assertReaderActive();
  const firstViewport = firstPage.getViewport({ scale: 1 });
  const observer = new IntersectionObserver(
    (entries) =>
      entries.forEach((entry) => {
        if (readerAbortController.signal.aborted) return;
        entry.target.dataset.renderVisible = entry.isIntersecting ? "1" : "0";
        if (entry.isIntersecting) renderPdfInBackground(entry.target);
      }),
    { root: document.querySelector("#viewport"), rootMargin: "1200px 0px" }
  );
  const pageObserver = new IntersectionObserver(() => scheduleMarkerSync(), {
    root: document.querySelector("#viewport"),
    threshold: [0, 0.5, 1]
  });
  trackReaderResource(() => {
    observer.disconnect();
    pageObserver.disconnect();
  });
  const createShell = (page) => {
    const shell = document.createElement("section");
    shell.className = "reader-page";
    shell.dataset.page = String(page);
    shell.style.aspectRatio = `${firstViewport.width} / ${firstViewport.height}`;
    shell.tabIndex = 0;
    shell.setAttribute("role", "region");
    shell.setAttribute("aria-label", `第 ${page} 页`);
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const textLayer = document.createElement("div");
    textLayer.className = "reader-pdf-text";
    textLayer.setAttribute("role", "document");
    textLayer.setAttribute("aria-label", `第 ${page} 页正文`);
    shell.append(canvas, textLayer);
    shell.addEventListener("focus", () => renderPdfInBackground(shell));
    observer.observe(shell);
    pageObserver.observe(shell);
    return shell;
  };
  const firstShell = createShell(1);
  content.appendChild(firstShell);
  await renderPdfShell(firstShell, false, true);
  pdfShellsReady = appendShellsBatched(createShell, pdf.numPages, 24);
  await pdfShellsReady;
  if (typeof pdf.getOutline === "function") {
    try {
      const outline = await pdf.getOutline(),
        entries = [];
      const cleanLabel = (value) =>
        String(value || "未命名章节")
          .replace(/[\u2610-\u2612\u25a1]\s*[xX×]?\s*$/u, "")
          .trim() || "未命名章节";
      const append = async (items, depth = 0) => {
        for (const item of items || []) {
          assertReaderActive();
          let destination = item.dest,
            page = 0;
          if (typeof destination === "string") destination = await pdf.getDestination(destination);
          if (destination && destination[0]) {
            try {
              page = (await pdf.getPageIndex(destination[0])) + 1;
            } catch (_) {}
          }
          entries.push({
            label: page ? `${cleanLabel(item.title)} · 第 ${page} 页` : cleanLabel(item.title),
            depth,
            activate: (generation) => (page ? goToPage(page, generation) : false)
          });
          await append(item.items, depth + 1);
        }
      };
      await append(outline);
      assertReaderActive();
      setToc(entries);
    } catch (error) {
      if (!readerAbortController.signal.aborted)
        console.warn("PDF outline could not be loaded", error);
    }
  }
  assertReaderActive();
}

function renderPdfInBackground(shell, force = false) {
  if (readerAbortController.signal.aborted) return;
  if (shell._backgroundRender) {
    if (force) shell.dataset.pendingRerender = "1";
    return shell._backgroundRender;
  }
  const task =
    capability.mode === "pdf-pages"
      ? renderPdfManifestShell(shell, force, true)
      : renderPdfShell(shell, force);
  shell._backgroundRender = task;
  task
    .catch((error) => {
      if (readerAbortController.signal.aborted || error?.name === "AbortError") return;
      console.warn(`PDF page ${shell.dataset.page} render failed`, error);
      const retries = Number(shell.dataset.renderRetries || 0);
      if (retries < 3) {
        shell.dataset.renderRetries = String(retries + 1);
        waitForReader(400 * (retries + 1))
          .then(() => {
            if (shell.isConnected) renderPdfInBackground(shell);
          })
          .catch(() => {});
      }
    })
    .finally(() => {
      if (shell._backgroundRender === task) delete shell._backgroundRender;
    });
}
function renderPdfManifestShell(shell, force = false, priority = false) {
  if (!shell) return Promise.reject(new Error("PDF page shell missing"));
  if (shell._renderPromise) return shell._renderPromise;
  if (!force && shell.dataset.renderState === "rendered") return Promise.resolve();
  shell.dataset.renderState = "rendering";
  const task = (async () => {
    let acquired = false;
    try {
      await acquirePdfRenderSlot(priority);
      acquired = true;
      assertReaderActive();
      const entry = pdfPageEntry(Number(shell.dataset.page));
      if (!entry) throw new Error("PDF page entry missing");
      let image = shell.querySelector("img");
      if (!image) {
        image = new Image();
        image.alt = `第 ${entry.page} 页`;
        image.decoding = "async";
        shell.appendChild(image);
      }
      const target = sourceUrl.includes("/api/reader-bucket-resource?")
        ? new URL(
            "https://voiceofml-search.hf.space/api/reader-bucket-resource?path=" +
              encodeURIComponent(entry.path),
            location.origin
          ).href
        : new URL(
            "/datasets/vomebook/Reader-Assets/resolve/main/" + entry.path,
            "https://huggingface.co"
          ).href;
      await new Promise((resolve, reject) => {
        let settled = false,
          timeout = 0,
          untrack = () => {};
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          untrack();
          image.onload = image.onerror = null;
          if (error) {
            image.removeAttribute("src");
            reject(error);
          } else resolve();
        };
        untrack = trackReaderResource(() => finish(readerAbortError()));
        if (settled) return;
        timeout = setTimeout(
          () => finish(new Error("PDF page image timeout")),
          READER_PROXY_TIMEOUT_MS
        );
        image.onload = () => finish();
        image.onerror = () => finish(new Error(`PDF page ${entry.page} image failed`));
        if (image.src !== target) image.src = target;
        if (image.complete && image.naturalWidth) finish();
      });
      assertReaderActive();
      shell.style.aspectRatio = `${image.naturalWidth || 1} / ${image.naturalHeight || 1}`;
      image.classList.add("ready");
      shell.dataset.renderState = "rendered";
      shell.dataset.renderUsedAt = String(Date.now());
      trimPdfManifestImages(shell);
      scheduleMarkerSync();
    } catch (error) {
      shell.querySelector("img")?.remove();
      shell.dataset.renderState = "idle";
      throw error;
    } finally {
      if (acquired) releasePdfRenderSlot();
    }
  })().finally(() => {
    if (shell._renderPromise === task) delete shell._renderPromise;
  });
  shell._renderPromise = task;
  return task;
}
function renderPdfShell(shell, force = false, priority = false) {
  if (shell._renderPromise) {
    if (force) shell.dataset.pendingRerender = "1";
    return shell._renderPromise;
  }
  if (!force && shell.dataset.renderState === "rendered") return Promise.resolve();
  shell.dataset.renderState = "rendering";
  const task = (async () => {
    let acquired = false;
    try {
      await acquirePdfRenderSlot(priority);
      acquired = true;
      assertReaderActive();
      const pdf = pdfDocument;
      if (!pdf) throw readerAbortError();
      do {
        delete shell.dataset.pendingRerender;
        const generation = readerRuntime.currentGeneration("pdf"),
          page = await awaitReader(pdf.getPage(Number(shell.dataset.page)));
        assertReaderActive();
        const base = page.getViewport({ scale: 1 }),
          scale = Math.min(3, Math.max(0.5, shell.clientWidth / base.width)),
          rendered = page.getViewport({ scale });
        const canvas = shell.querySelector("canvas");
        canvas.width = rendered.width;
        canvas.height = rendered.height;
        shell.style.aspectRatio = `${rendered.width} / ${rendered.height}`;
        const rendering = page.render({
          canvasContext: canvas.getContext("2d"),
          viewport: rendered
        });
        const untrack = trackReaderResource(() => rendering.cancel?.());
        try {
          await awaitReader(Promise.all([rendering.promise, renderPdfText(page, shell)]));
        } finally {
          untrack();
        }
        assertReaderActive();
        if (!isReaderGenerationCurrent("pdf", generation)) shell.dataset.pendingRerender = "1";
      } while (shell.dataset.pendingRerender);
      shell.querySelector("canvas").classList.add("ready");
      shell.dataset.renderState = "rendered";
      shell.dataset.renderUsedAt = String(Date.now());
      trimPdfCanvases(shell);
    } catch (error) {
      shell.dataset.renderState = "idle";
      throw error;
    } finally {
      if (acquired) releasePdfRenderSlot();
    }
  })().finally(() => {
    if (shell._renderPromise === task) delete shell._renderPromise;
  });
  shell._renderPromise = task;
  return task;
}

async function renderPdfText(page, shell) {
  if (shell.dataset.textReady === "1") return;
  const layer = shell.querySelector(".reader-pdf-text");
  if (!layer || typeof page.getTextContent !== "function") return;
  try {
    const text = await awaitReader(page.getTextContent());
    assertReaderActive();
    const pdfViewport = page.getViewport({ scale: 1 });
    shell._bookmarkTextItems = text.items
      .filter((item) => item.str && item.str.trim())
      .map((item) => {
        const point =
          item.transform && pdfViewport.convertToViewportPoint
            ? pdfViewport.convertToViewportPoint(item.transform[4], item.transform[5])
            : null;
        return {
          text: item.str,
          y: point ? Math.max(0, Math.min(1, point[1] / Math.max(1, pdfViewport.height))) : 0
        };
      });
    layer.textContent = "";
    let positioned = false;
    for (const item of text.items) {
      const span = layer.ownerDocument.createElement("span");
      span.textContent = item.str + (item.hasEOL ? "\n" : " ");
      const point =
        item.transform && pdfViewport.convertToViewportPoint
          ? pdfViewport.convertToViewportPoint(item.transform[4], item.transform[5])
          : null;
      if (point) {
        positioned = true;
        const fontHeight = Math.hypot(item.transform[2] || 0, item.transform[3] || 0) || 12;
        span.style.left = `${(point[0] / Math.max(1, pdfViewport.width)) * 100}%`;
        span.style.top = `${(point[1] / Math.max(1, pdfViewport.height)) * 100}%`;
        span.style.fontSize = `${(fontHeight / Math.max(1, pdfViewport.height)) * 100}%`;
      } else span.style.position = "static";
      layer.appendChild(span);
    }
    if (!positioned)
      layer.textContent =
        text.items
          .map((item) => item.str + (item.hasEOL ? "\n" : " "))
          .join("")
          .trim() || "此页没有可提取文本";
    else if (!layer.textContent.trim()) layer.textContent = "此页没有可提取文本";
    shell.dataset.textReady = "1";
    highlightPdfText(shell);
  } catch (error) {
    if (!readerAbortController.signal.aborted)
      console.warn(`PDF page ${shell.dataset.page} text extraction failed`, error);
  }
}
function highlightPdfText(shell, query = searchState.query) {
  if (!shell || readerAbortController.signal.aborted || !query) return;
  const pattern = new RegExp(fullSearchEscape(query), "iu");
  for (const span of shell.querySelectorAll(".reader-pdf-text span"))
    if (pattern.test(span.textContent) && !span.classList.contains("full-search-highlight")) {
      span.classList.add("full-search-highlight");
      fullSearchActiveMarks.push(span);
    }
}

function acquirePdfRenderSlot(priority = false) {
  if (readerAbortController.signal.aborted) return Promise.reject(readerAbortError());
  const limit = matchMedia("(max-width: 700px)").matches ? 1 : 2;
  if (pdfActiveRenders < limit) {
    pdfActiveRenders++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve: () => {
        pdfActiveRenders++;
        resolve();
      },
      reject
    };
    if (priority) pdfRenderWaiters.unshift(waiter);
    else pdfRenderWaiters.push(waiter);
  });
}
function releasePdfRenderSlot() {
  pdfActiveRenders = Math.max(0, pdfActiveRenders - 1);
  if (readerAbortController.signal.aborted) return;
  const waiter = pdfRenderWaiters.shift();
  if (waiter) waiter.resolve();
}
function trimPdfCanvases(protectedShell) {
  const limit = matchMedia("(max-width: 700px)").matches ? 7 : 11;
  const rendered = [...content.querySelectorAll('.reader-page[data-render-state="rendered"]')];
  if (rendered.length <= limit) return;
  rendered.sort((a, b) => {
    const aVisible =
      a === protectedShell ||
      a.dataset.renderVisible === "1" ||
      Number(a.dataset.page) === documentState.page;
    const bVisible =
      b === protectedShell ||
      b.dataset.renderVisible === "1" ||
      Number(b.dataset.page) === documentState.page;
    if (aVisible !== bVisible) return aVisible ? 1 : -1;
    const distance =
      Math.abs(Number(b.dataset.page) - documentState.page) -
      Math.abs(Number(a.dataset.page) - documentState.page);
    return distance || Number(a.dataset.renderUsedAt || 0) - Number(b.dataset.renderUsedAt || 0);
  });
  while (rendered.length > limit) {
    const shell = rendered.shift();
    if (
      shell === protectedShell ||
      shell.dataset.renderVisible === "1" ||
      Number(shell.dataset.page) === documentState.page
    )
      continue;
    const canvas = shell.querySelector("canvas");
    canvas.width = 0;
    canvas.height = 0;
    canvas.classList.remove("ready");
    shell.dataset.renderState = "idle";
  }
}

function rerenderVisiblePdfPages() {
  nextReaderGeneration("pdf");
  for (const shell of content.querySelectorAll(".reader-page")) {
    const rect = shell.getBoundingClientRect();
    if (rect.bottom >= -1200 && rect.top <= innerHeight + 1200) {
      if (shell._renderPromise) shell.dataset.pendingRerender = "1";
      else renderPdfInBackground(shell, true);
    }
  }
}
async function renderText(markdown, prepared) {
  let response = await prepared.response;
  if (!response.ok) response = await fetchReaderResponse();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!markdown) await renderPlainText(response);
  else {
    const bytes = await VoiceOfMLReaderSecurity.readBytes(
      response,
      VoiceOfMLReaderSecurity.LIMITS.documentBytes
    );
    const text = new TextDecoder(detectTextEncoding(bytes, documentState.title)).decode(bytes);
    await prepared.engines;
    const article = document.createElement("article");
    article.className = "reader-markdown";
    article.innerHTML = DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true } });
    content.appendChild(article);
    setToc(headingTocEntries(article));
  }
  status.textContent = "已加载";
}
// HTML documents retain an isolated, script-free scroll window.
function sanitizeOfflineHtml(text) {
  const clean = DOMPurify.sanitize(text, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["base", "embed", "form", "iframe", "object", "script"],
    FORBID_ATTR: ["action", "formaction", "srcdoc"],
    ALLOWED_URI_REGEXP: /^data:image\/(?:gif|png|jpeg|webp);/i
  });
  const template = document.createElement("template");
  template.innerHTML = clean;
  const stripUrls = (value) => value.replace(/@import[^;]+;|url\s*\([^)]*\)/gi, "");
  for (const style of template.content.querySelectorAll("style"))
    style.textContent = stripUrls(style.textContent);
  for (const element of template.content.querySelectorAll("[style]"))
    element.setAttribute("style", stripUrls(element.getAttribute("style")));
  return template.innerHTML;
}
async function renderHtml(prepared) {
  const response = await prepared.response;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await VoiceOfMLReaderSecurity.readBytes(response);
  const text = new TextDecoder(detectHtmlEncoding(bytes, documentState.title)).decode(bytes);
  await prepared.engine;
  assertReaderActive();
  const clean = sanitizeOfflineHtml(text);
  const frame = document.createElement("iframe");
  htmlFrame = frame;
  frame.className = "html-frame";
  frame.title = `${documentState.title} 正文`;
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.colorScheme = "only light";
  const frameLoaded = new Promise((resolve, reject) => {
    let untrack = () => {};
    const loaded = () => {
      untrack();
      try {
        assertReaderActive();
        repairHtmlContrast(frame);
        frame.contentDocument.documentElement.style.zoom = String(documentState.zoom);
        frame.contentWindow.addEventListener("scroll", handleReaderPositionChange, {
          passive: true
        });
        frame.contentDocument.addEventListener("keydown", handleReaderKeydown);
        for (const type of ["wheel", "touchstart", "pointerdown"])
          frame.contentDocument.addEventListener(type, beginReaderNavigation, { passive: true });
        setToc(headingTocEntries(frame.contentDocument));
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    untrack = trackReaderResource(() => {
      frame.removeEventListener("load", loaded);
      reject(readerAbortError());
    });
    frame.addEventListener("load", loaded, { once: true });
  });
  frame.srcdoc =
    clean +
    '<meta name="color-scheme" content="only light"><style>:root{color-scheme:only light!important;background:#fff!important}html,body{min-height:100%;background:#fff!important;color:#111!important}</style>';
  content.appendChild(frame);
  await frameLoaded;
  status.textContent = "HTML";
}

function detectHtmlEncoding(bytes, hint = "") {
  const probe = String.fromCharCode(...bytes.subarray(0, 8192));
  const match = probe.match(/charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i);
  if (match) {
    const label =
      { gb2312: "gb18030", "gb-2312": "gb18030", gbk: "gb18030", "x-gbk": "gb18030" }[
        match[1].toLowerCase()
      ] || match[1];
    try {
      new TextDecoder(label);
      return label;
    } catch (_) {}
  }
  return detectTextEncoding(bytes, hint);
}

function repairHtmlContrast(frame) {
  const doc = frame.contentDocument;
  if (!doc || !doc.body) return;
  const parseColor = (value) => {
    const parts = String(value).match(/[\d.]+/g);
    return parts && parts.length >= 3
      ? [
          Number(parts[0]),
          Number(parts[1]),
          Number(parts[2]),
          parts[3] === undefined ? 1 : Number(parts[3])
        ]
      : null;
  };
  const luminance = (color) => {
    const channels = color.slice(0, 3).map((value) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const background = (element) => {
    for (let current = element; current; current = current.parentElement) {
      const color = parseColor(frame.contentWindow.getComputedStyle(current).backgroundColor);
      if (color && color[3] > 0.1) return color;
    }
    return [255, 255, 255, 1];
  };
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const elements = new Set();
  while (walker.nextNode() && elements.size < 10000)
    if (walker.currentNode.data.trim()) elements.add(walker.currentNode.parentElement);
  for (const element of elements) {
    const foreground = parseColor(frame.contentWindow.getComputedStyle(element).color);
    const backdrop = background(element);
    if (!foreground) continue;
    const light = luminance(foreground),
      dark = luminance(backdrop);
    const contrast = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
    if (contrast < 3)
      element.style.setProperty("color", dark > 0.45 ? "#111" : "#f5f5f5", "important");
  }
}
async function renderPlainText(response) {
  assertReaderActive();
  const pre = document.createElement("pre");
  pre.className = "reader-text";
  content.appendChild(pre);
  const limit = VoiceOfMLReaderSecurity.LIMITS.documentBytes;
  VoiceOfMLReaderSecurity.assertResponseSize(response, limit);
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      const error = new Error("READER_RESOURCE_LIMIT");
      error.code = "READER_RESOURCE_LIMIT";
      throw error;
    }
    assertReaderActive();
    pre.textContent = new TextDecoder(detectTextEncoding(bytes, documentState.title))
      .decode(bytes)
      .replace(/\ufffd/g, "");
    return;
  }
  const reader = response.body.getReader(),
    sampleChunks = [];
  const untrack = trackReaderResource(() => {
    reader.cancel(readerAbortError()).catch(() => {});
  });
  let length = 0,
    sampleLength = 0,
    displayedSampleSize = 0,
    decoder = null,
    asciiPreviewPossible = true,
    asciiPrefixLength = 0;
  const appendDecoded = (value) => {
    const text = value.replace(/\ufffd/g, "");
    if (!text) return;
    // Search can split or normalize previous chunks while the response streams.
    const tail = pre.lastChild;
    if (tail?.nodeType === Node.TEXT_NODE) tail.appendData(text);
    else pre.appendChild(document.createTextNode(text));
  };
  const startDecoder = () => {
    const sample = new Uint8Array(sampleLength);
    let offset = 0;
    for (const chunk of sampleChunks) {
      sample.set(chunk, offset);
      offset += chunk.byteLength;
    }
    decoder = new TextDecoder(detectTextEncoding(sample, documentState.title));
    appendDecoded(decoder.decode(sample.subarray(displayedSampleSize), { stream: true }));
    sampleChunks.length = 0;
  };
  try {
    while (true) {
      const { value, done } = await awaitReader(reader.read());
      assertReaderActive();
      if (done) break;
      if (!value?.byteLength) continue;
      length += value.byteLength;
      if (length > limit) {
        const error = new Error("READER_RESOURCE_LIMIT");
        error.code = "READER_RESOURCE_LIMIT";
        throw error;
      }
      if (!decoder) {
        sampleChunks.push(value);
        sampleLength += value.byteLength;
        if (asciiPreviewPossible) {
          let asciiLength = 0;
          while (asciiLength < value.length && value[asciiLength] > 0 && value[asciiLength] < 128)
            asciiLength++;
          asciiPrefixLength += asciiLength;
          if (value[asciiLength] === 0) {
            // A split UTF-16 prefix must not leave an ASCII preview behind.
            pre.textContent = "";
            displayedSampleSize = 0;
            asciiPrefixLength = 0;
            asciiPreviewPossible = false;
          } else if (asciiLength < value.length) asciiPreviewPossible = false;
        }
        if (asciiPrefixLength >= 4 && asciiPrefixLength > displayedSampleSize) {
          let offset = 0;
          for (const chunk of sampleChunks) {
            const start = Math.max(0, displayedSampleSize - offset),
              end = Math.min(chunk.length, asciiPrefixLength - offset);
            if (end > start)
              appendDecoded(new TextDecoder("utf-8").decode(chunk.subarray(start, end)));
            offset += chunk.length;
            if (offset >= asciiPrefixLength) break;
          }
          displayedSampleSize = asciiPrefixLength;
        }
        if (sampleLength < 65540) continue;
        startDecoder();
      } else {
        appendDecoded(decoder.decode(value, { stream: true }));
      }
    }
    if (!decoder) startDecoder();
    appendDecoded(decoder.decode());
  } catch (reason) {
    try {
      await reader.cancel(reason);
    } catch (_) {}
    throw reason;
  } finally {
    untrack();
    reader.releaseLock();
  }
}
function detectTextEncoding(bytes, hint = "") {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const evenNulls = bytes.filter((value, index) => !value && index % 2 === 0).length;
  const oddNulls = bytes.filter((value, index) => !value && index % 2 === 1).length;
  if (oddNulls > bytes.length / 8 && oddNulls > evenNulls * 4) return "utf-16le";
  if (evenNulls > bytes.length / 8 && evenNulls > oddNulls * 4) return "utf-16be";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return "utf-8";
  } catch (_) {}
  if (/[\u0400-\u04ff]/.test(hint)) return "windows-1251";
  const candidates = /[\u3400-\u9fff]/.test(hint)
    ? ["gb18030", "big5"]
    : ["gb18030", "big5", "windows-1251", "windows-1252"];
  let best = "gb18030",
    bestScore = -Infinity;
  for (const encoding of candidates) {
    try {
      const text = new TextDecoder(encoding).decode(bytes);
      const controls = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length;
      const replacements = (text.match(/\ufffd/g) || []).length;
      const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
      const cyrillic = (text.match(/[\u0400-\u04ff]/g) || []).length;
      const commonCjk = (
        text.match(
          /[的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经之进着等部家自理起现实都体制当本性应开合因由然前外政社义事相全与关各重新内正反明原利质向道命此变结解问意建公系军情者立代通题党程展料员革文总品活长求老基资级图统知组别期论运农指区战任处理世]/g
        ) || []
      ).length;
      const score = Math.max(cjk + commonCjk * 5, cyrillic) - controls * 20 - replacements * 40;
      if (score > bestScore) {
        best = encoding;
        bestScore = score;
      }
    } catch (_) {}
  }
  return best;
}
async function renderChapterManifest(prepared) {
  const response = await prepared;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const manifest = VoiceOfMLReaderSecurity.validateChapterManifest(
    JSON.parse(
      await VoiceOfMLReaderSecurity.readText(response, VoiceOfMLReaderSecurity.LIMITS.manifestBytes)
    )
  );
  assertReaderActive();
  const frame = document.createElement("div");
  frame.className = "epub-frame";
  content.appendChild(frame);
  const loaded = new Set(),
    pending = new Map(),
    manifestBase = trustedReaderAssetManifestUrl(chapterManifestUrl || sourceUrl);
  const chapterBudget = VoiceOfMLReaderSecurity.createByteBudget();
  if (!manifestBase) throw new Error("EPUB_INVALID_MANIFEST_PATH");
  const chapterUrl = (chapter) => trustedChapterUrl(chapter.path, manifestBase);
  const resourceUrl = (raw, base, attribute) => {
    const value = String(raw || "").trim();
    if (!value || value.startsWith("#")) return null;
    return trustedChapterResourceUrl(value, base, attribute, manifestBase);
  };
  const insertChapter = (article) => {
    const existing = frame.querySelector(
      `.reader-epub-chapter[data-chapter="${article.dataset.chapter}"]`
    );
    if (existing) return existing;
    const next = [...frame.querySelectorAll(".reader-epub-chapter")].find(
      (node) => Number(node.dataset.chapter) > Number(article.dataset.chapter)
    );
    frame.insertBefore(article, next || null);
    return article;
  };
  const ensureSentinel = (chapter) => {
    if (readerAbortController.signal.aborted || loaded.has(chapter.index)) return null;
    const selector = `.reader-chapter-sentinel[data-chapter="${chapter.index}"]`;
    const existing = frame.querySelector(selector);
    if (existing) return existing;
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "reader-chapter-sentinel";
    marker.dataset.chapter = String(chapter.index);
    marker.textContent = `加载第 ${chapter.index} 章`;
    marker.setAttribute("aria-label", `重试加载第 ${chapter.index} 章`);
    marker.addEventListener("click", () => {
      marker.disabled = true;
      fetchChapter(chapter).catch((error) => {
        marker.disabled = false;
        console.warn("EPUB chapter could not be loaded", error);
      });
    });
    frame.appendChild(marker);
    chapterManifestObserver.observe(marker);
    return marker;
  };
  const setChapterToc = () =>
    setToc(
      manifest.chapters.map((item) => ({
        label: item.title || `章节 ${item.index}`,
        chapterIndex: item.index,
        depth: 0,
        activate: async (generation) => {
          await fetchChapter(item);
          if (!isReaderGenerationCurrent("navigation", generation)) return false;
          const node = frame.querySelector(`.reader-epub-chapter[data-chapter="${item.index}"]`);
          if (node) node.scrollIntoView({ block: "start" });
          scheduleSave();
        }
      }))
    );
  const fetchChapter = async (chapter) => {
    assertReaderActive();
    if (loaded.has(chapter.index)) return;
    if (pending.has(chapter.index)) return pending.get(chapter.index);
    const task = (async () => {
      const url = chapterUrl(chapter);
      if (!url) throw new Error("EPUB_INVALID_PATH");
      const result = await fetchReaderUrl(url);
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      const bytes = await VoiceOfMLReaderSecurity.readBytes(
        result,
        VoiceOfMLReaderSecurity.LIMITS.chapterBytes,
        chapterBudget
      );
      let inserted = false;
      try {
        assertReaderActive();
        const doc = sanitizeEpubDocument(
          new DOMParser().parseFromString(new TextDecoder().decode(bytes), "text/html")
        );
        for (const element of doc.querySelectorAll("*")) {
          for (const name of ["src", "href", "poster", "xlink:href"])
            if (element.hasAttribute(name)) {
              const value = element.getAttribute(name) || "";
              const resolved = resourceUrl(value, url, name === "href" ? "href" : "resource");
              if (resolved) element.setAttribute(name, resolved);
              else if (!(name === "href" && value.startsWith("#"))) element.removeAttribute(name);
            }
          if (element.hasAttribute("srcset")) element.removeAttribute("srcset");
        }
        const article = document.createElement("article");
        article.className = "reader-markdown reader-epub-chapter";
        article.dataset.chapter = String(chapter.index);
        article.innerHTML = doc.body ? doc.body.innerHTML : "";
        const marker = frame.querySelector(
          `.reader-chapter-sentinel[data-chapter="${chapter.index}"]`
        );
        if (marker) {
          chapterManifestObserver.unobserve(marker);
          marker.remove();
        }
        insertChapter(article);
        loaded.add(chapter.index);
        inserted = true;
        const entry = navigationState.tocEntries.find(
          (entry) => entry.chapterIndex === chapter.index
        );
        if (entry) entry.target = article;
        const next = manifest.chapters.find((item) => item.index === chapter.index + 1);
        if (next) ensureSentinel(next);
      } catch (error) {
        if (!inserted) chapterBudget.release(bytes.byteLength);
        throw error;
      }
    })().finally(() => {
      pending.delete(chapter.index);
      if (!loaded.has(chapter.index)) ensureSentinel(chapter);
    });
    pending.set(chapter.index, task);
    return task;
  };
  chapterManifestObserver = new IntersectionObserver(
    (entries) =>
      entries
        .filter((entry) => entry.isIntersecting)
        .forEach((entry) => {
          if (readerAbortController.signal.aborted) return;
          const chapter = manifest.chapters.find(
            (item) => item.index === Number(entry.target.dataset.chapter)
          );
          if (chapter)
            fetchChapter(chapter).catch((error) =>
              console.warn("EPUB chapter could not be loaded", error)
            );
        }),
    { root: viewport, rootMargin: "0px" }
  );
  trackReaderResource(() => {
    chapterManifestObserver?.disconnect();
    chapterManifestObserver = null;
    chapterManifestLoader = null;
  });
  chapterManifestLoader = async (index) => {
    const chapter = manifest.chapters.find((item) => item.index === index);
    if (!chapter) return null;
    await fetchChapter(chapter);
    return frame.querySelector(`.reader-epub-chapter[data-chapter="${index}"]`);
  };
  setChapterToc();
  await fetchChapter(manifest.chapters[0]);
  assertReaderActive();
  status.textContent = `EPUB · ${manifest.chapters.length} 章`;
}
async function renderDocx(prepared) {
  const [response] = await prepared;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await VoiceOfMLReaderSecurity.readBytes(
    response,
    VoiceOfMLReaderSecurity.LIMITS.documentBytes
  );
  VoiceOfMLReaderSecurity.inspectZip(bytes, {
    ...VoiceOfMLReaderSecurity.LIMITS,
    archiveCompressedBytes: VoiceOfMLReaderSecurity.LIMITS.documentBytes
  });
  const styles = document.createElement("div");
  styles.className = "docx-styles";
  const body = document.createElement("div");
  body.className = "docx-body";
  content.append(styles, body);
  await docx.renderAsync(bytes, body, styles, {
    className: "reader-docx",
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    useBase64URL: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderChanges: false,
    renderComments: false,
    renderAltChunks: false,
    debug: false
  });
  body.classList.toggle("reader-document-dark", readerTheme === "dark");
  if (!(body.textContent || "").trim() && !body.querySelector("img, table, svg, canvas"))
    throw new Error("DOCX rendered no supported content");
  const pages = [...body.querySelectorAll(":scope > .reader-docx-wrapper > section.reader-docx")];
  if (pages.length) {
    updateDocumentState({ pageCount: pages.length });
    pageInput.max = String(documentState.pageCount);
    document.querySelector("#page-total").textContent = `/ ${documentState.pageCount}`;
    document.querySelector(".page-controls").hidden = false;
    pages.forEach((page, index) => {
      page.classList.add("reader-docx-page");
      page.dataset.page = String(index + 1);
    });
    setToc(headingTocEntries(body));
  }
  for (const link of body.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") || "";
    if (!href.startsWith("#") && !/^https?:\/\//i.test(href)) link.removeAttribute("href");
    else if (!href.startsWith("#")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  status.textContent = documentState.pageCount ? `${documentState.pageCount} 页` : "DOCX";
}
function renderImageDocument(image) {
  assertReaderActive();
  content.appendChild(image);
  status.textContent = "图片";
}
function disposeFormatResources(mode) {
  if (["pdf", "pdf-pages"].includes(mode)) {
    pdfDocument = null;
    pdfPageManifest = null;
    pdfFirstPagePreload?.removeAttribute("src");
    pdfFirstPagePreload = null;
    for (const canvas of content.querySelectorAll(".reader-page canvas")) {
      canvas.width = 0;
      canvas.height = 0;
    }
    for (const image of content.querySelectorAll(".reader-page img")) image.removeAttribute("src");
  }
  if (mode === "foliate") {
    foliateSectionObserver?.disconnect();
    foliateSectionObserver = null;
    foliateSectionVirtualizer?.dispose();
    foliateChapterRepository?.dispose();
    foliateSectionVirtualizer = null;
    foliateChapterRepository = null;
    foliateSectionLoader = null;
    foliateSectionSettler = null;
    try {
      const closing = epubRendition?.close?.();
      closing?.catch?.(() => {});
    } catch (_) {}
    epubRendition = null;
    epubBook = null;
  }
  if (mode === "html") {
    htmlFrame?.remove();
    htmlFrame = null;
  }
  if (["audio", "video"].includes(mode) && mediaElement) {
    mediaElement.pause();
    mediaElement.removeAttribute("src");
    mediaElement.load();
    mediaElement = null;
  }
}
function renderTextDocument(prepared) {
  return renderText(false, prepared);
}
function renderMarkdownDocument(prepared) {
  return renderText(true, prepared);
}
function captureChapterPosition() {
  if (capability.mode !== "epub-chapters") return null;
  const marker = viewport.getBoundingClientRect().top + 8;
  const chapters = [...content.querySelectorAll(".reader-epub-chapter")];
  const chapter =
    chapters.find((node) => node.getBoundingClientRect().bottom > marker) ||
    chapters[chapters.length - 1];
  return chapter
    ? {
        chapterIndex: Number(chapter.dataset.chapter),
        chapterOffset: marker - chapter.getBoundingClientRect().top
      }
    : null;
}
async function restoreChapterPosition(entry, generation) {
  if (!chapterManifestLoader || !Number.isInteger(entry.chapterIndex)) return false;
  const chapter = await chapterManifestLoader(entry.chapterIndex);
  if (!chapter?.isConnected || !isReaderGenerationCurrent("navigation", generation)) return false;
  viewport.scrollTop +=
    chapter.getBoundingClientRect().top -
    viewport.getBoundingClientRect().top -
    8 +
    (Number(entry.chapterOffset) || 0);
  syncHeadingLocation();
  updateProgressTools();
  scheduleSave();
  return true;
}
async function restoreFormat(mode, entry, generation = beginReaderNavigation()) {
  try {
    if (!entry || !isReaderGenerationCurrent("navigation", generation)) return;
    if (mode === "epub-chapters" && Number.isInteger(entry.chapterIndex)) {
      if (!(await restoreChapterPosition(entry, generation))) return;
    } else if (mode === "foliate" && Number.isInteger(entry.foliateSection)) {
      if (!(await restoreFoliateBookmarkPosition(entry, generation))) return;
    } else if (documentState.pageCount && entry.page) {
      if (
        !(await goToPage(entry.page, generation)) ||
        !isReaderGenerationCurrent("navigation", generation)
      )
        return;
      const shell = content.querySelector(
        `.reader-page[data-page="${documentState.page}"], .reader-docx-page[data-page="${documentState.page}"]`
      );
      if (shell && Number.isFinite(entry.pageOffset))
        viewport.scrollTop = shell.offsetTop + entry.pageOffset;
      updateProgressTools();
      scheduleSave();
    } else await restoreProgressState(entry, generation);
    if (isReaderGenerationCurrent("navigation", generation)) consumeBookmarkHandoff(entry);
  } catch (error) {
    reportNavigationError(error, generation);
  }
}
function registerReaderFormatAdapters() {
  const formats = {
    "pdf-pages": [
      () => {
        preloadPdfFirstPage();
        return fetchReaderResponse();
      },
      renderPdfPages
    ],
    pdf: [loadPdfDocument, renderPdf],
    image: [loadImageDocument, renderImageDocument],
    text: [loadTextDocument, renderTextDocument],
    markdown: [loadMarkdownDocument, renderMarkdownDocument],
    html: [loadHtmlDocument, renderHtml],
    "epub-chapters": [loadChapterManifestDocument, renderChapterManifest],
    docx: [loadDocxDocument, renderDocx],
    audio: [loadMediaDocument, () => renderMedia("audio")],
    video: [loadMediaDocument, () => renderMedia("video")],
    foliate: [loadMediaDocument, renderFoliate]
  };
  for (const [mode, [open, render]] of Object.entries(formats))
    formatAdapters.register(mode, {
      open,
      render,
      restore: (entry, generation) => restoreFormat(mode, entry, generation),
      dispose: () => disposeFormatResources(mode)
    });
}
function renderMedia(mode) {
  assertReaderActive();
  const media = document.createElement(mode);
  media.className = mode === "audio" ? "reader-audio" : "reader-video";
  media.controls = true;
  media.setAttribute("aria-label", `${documentState.title} ${mode === "audio" ? "音频" : "视频"}`);
  media.preload = "metadata";
  if (mode === "video") media.playsInline = true;
  const refresh = () => {
    if (readerAbortController.signal.aborted) return;
    mediaPanel.querySelector(".media-panel-time").textContent =
      `${formatMediaTime(media.currentTime)} / ${formatMediaTime(media.duration)}`;
    scheduleMarkerSync();
  };
  for (const type of ["timeupdate", "durationchange", "loadedmetadata"])
    media.addEventListener(type, refresh, { passive: true });
  for (const type of ["pause", "ended", "seeked"])
    media.addEventListener(type, () => {
      refresh();
      saveProgress();
    });
  mediaElement = media;
  media.addEventListener(
    "error",
    () => fail("媒体加载失败，请检查网络后重试，或下载原文件。", "READER_MEDIA"),
    { once: true }
  );
  media.src = contentUrl;
  content.appendChild(media);
  status.textContent = mode === "audio" ? "音频" : "视频";
}
// Resolve once, then keep source URLs, capability, and presentation in sync.
async function resolveReaderSource() {
  if (!readerId || sourceUrl) return;
  setReaderStage("resolve");
  let resolved = cachedReaderData;
  if (!resolved?.url) {
    try {
      resolved = await resolveReaderId(readerId);
    } catch (error) {
      assertReaderActive();
      if (!localReaderData?.url) throw error;
      resolved = localReaderData;
    }
  }
  assertReaderActive();
  sourceUrl = normalizeSourceUrl(resolved.url || "");
  contentUrl = readerContentUrl(sourceUrl);
  downloadUrl = resolved.download || sourceUrl;
  chapterManifestUrl = resolved.chapter_manifest || "";
  fallbackUrl = resolved.fallback || "";
  if (resolved.extension) extension = String(resolved.extension).toLowerCase();
  if (
    extension === "pdf" &&
    sourceUrl.includes("/api/reader-bucket-resource?") &&
    new URL(sourceUrl).searchParams.get("path")?.endsWith("page-manifest.json")
  )
    extension = "pdf-pages";
  capability = readerRuntime.negotiate(VoiceOfMLReader.capability(extension));
  readerRuntime.update("source", {
    url: sourceUrl,
    contentUrl,
    downloadUrl,
    extension,
    metadata: resolved
  });
  applyReaderMetadata(resolved);
}
async function start() {
  const generation = readerRuntime.currentGeneration("navigation");
  await resolveReaderSource();
  assertReaderActive();
  if (readerId && /\/calibre-chm-epub-[^/]+\/document\.epub(?:$|\?)/i.test(sourceUrl)) {
    extension = "epub";
    readerRuntime.update("source", { extension });
    capability = readerRuntime.negotiate(VoiceOfMLReader.capability(extension));
    content.dataset.mode = capability.mode;
    document.querySelector(".page-controls").hidden = true;
  }
  syncCapabilityControls();
  if (
    (!validSource(sourceUrl) && !validSource(chapterManifestUrl) && !readerId) ||
    capability.readerMode === VoiceOfMLReader.ReaderMode.UNSUPPORTED
  )
    return fail("此文件暂不支持在线阅读，请下载原文件。", "READER_UNSUPPORTED");
  formatAdapters.activate(capability.mode);
  applyReaderMetadata(resolvedReaderData);
  document.querySelector("#download").href =
    `https://voiceofml-search.hf.space/api/download?file=${encodeURIComponent(documentState.title)}&link=${encodeURIComponent(downloadUrl)}`;
  if (validOcr(ocrUrl)) {
    const ocr = document.querySelector("#ocr") || document.createElement("a");
    ocr.id = "ocr";
    ocr.className = "text-button";
    ocr.target = "_blank";
    ocr.rel = "noopener noreferrer";
    ocr.textContent = "OCR";
    if (!ocr.parentElement) document.querySelector(".reader-actions")?.prepend(ocr);
    ocr.href = ocrUrl;
    ocr.hidden = false;
  }
  try {
    if (capability.mode === "foliate") {
      setReaderStage("foliate");
      foliateContinuous = true;
      const [restored] = await awaitReader(Promise.all([loadReaderRestoration(), renderFoliate()]));
      assertReaderActive();
      updateDocumentState({ restoredEntry: restored });
      if (isReaderGenerationCurrent("navigation", generation)) {
        if (restored?.zoom) setZoom(restored.zoom, false);
        await restoreFormat("foliate", restored, generation);
      }
      assertReaderActive();
      if (!setReaderPhase("ready")) return;
      updateDocumentState({ restorationReady: !restorationFailed });
      scheduleSave();
      return;
    }
    setReaderStage("prepare");
    const [restored, prepared] = await awaitReader(
      Promise.all([loadReaderRestoration(), formatAdapters.active.open()])
    );
    assertReaderActive();
    updateDocumentState({ restoredEntry: restored });
    if (isReaderGenerationCurrent("navigation", generation) && documentState.restoredEntry?.zoom)
      setZoom(documentState.restoredEntry.zoom, false);
    await formatAdapters.active.render(prepared);
    assertReaderActive();
    loadingIndicator.remove();
    loadingStatus.hidden = true;
    if (!setReaderPhase("ready")) return;
    if (documentState.restoredEntry && isReaderGenerationCurrent("navigation", generation))
      await formatAdapters.active.restore(documentState.restoredEntry, generation);
    assertReaderActive();
    updateDocumentState({ restorationReady: !restorationFailed });
    updateProgressTools();
    if (fullSearchInput.value.trim()) runFullSearch();
    scheduleSave();
  } catch (error) {
    if (readerAbortController.signal.aborted || error?.name === "AbortError") return;
    console.error(error);
    if (capability.mode === "epub-chapters" && validFallback(fallbackUrl)) {
      const target = new URL(location.href);
      target.searchParams.set("url", fallbackUrl);
      target.searchParams.set("ext", "pdf");
      target.searchParams.delete("chapter_manifest");
      target.searchParams.delete("fallback");
      if (window.parent !== window)
        window.parent.postMessage({ type: "voice-reader-open", url: target.href }, location.origin);
      else location.replace(target.href);
      return;
    }
    fail(
      error && error.message ? error.message : "原文件加载失败",
      classifyReaderError(error, capability.mode === "foliate" ? "READER_CORRUPT" : "READER_PARSE")
    );
  }
}
function loadPdfTaskWithTimeout(pdfjs, options, url) {
  assertReaderActive();
  const task = pdfjs.getDocument(options(url));
  return new Promise((resolve, reject) => {
    let timeout = 0,
      destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timeout);
      try {
        task.destroy()?.catch?.(() => {});
      } catch (_) {}
      reject(readerAbortError());
    };
    const untrack = trackReaderResource(destroy);
    timeout = setTimeout(() => {
      reject(new Error("reader PDF timeout"));
      untrack();
      destroy();
    }, READER_PROXY_TIMEOUT_MS);
    task.promise.then(
      (document) => {
        clearTimeout(timeout);
        if (readerAbortController.signal.aborted) {
          destroy();
          return;
        }
        resolve(document);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
        untrack();
        destroy();
      }
    );
  });
}
function loadPdfWithTimeout(pdfjs, options) {
  return loadPdfTaskWithTimeout(pdfjs, options, contentUrl).catch((error) => {
    assertReaderActive();
    if (error && error.name === "AbortError") throw error;
    return loadPdfTaskWithTimeout(pdfjs, options, sourceUrl);
  });
}
function loadPdfDocument() {
  return import(PDFJS_URL).then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    const options = (url) => ({
      url,
      rangeChunkSize: 1048576,
      disableAutoFetch: true,
      disableStream: true,
      wasmUrl: PDFJS_WASM_URL,
      cMapUrl: PDFJS_CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
      withCredentials: false
    });
    return loadPdfWithTimeout(pdfjs, options);
  });
}
function loadTextDocument() {
  return fetchReaderResponse().then((response) => ({ response }));
}
function loadMarkdownDocument() {
  return Promise.all([
    fetchReaderResponse(),
    Promise.all([loadScript(MARKED_URL), loadScript(PURIFY_URL)])
  ]).then(([response, engines]) => ({ response, engines }));
}
function loadHtmlDocument() {
  return Promise.all([fetchReaderResponse(), loadScript(PURIFY_URL)]).then(
    ([response, engine]) => ({ response, engine })
  );
}
function loadDocxDocument() {
  return Promise.all([
    fetchReaderResponse(),
    loadScript(JSZIP_URL).then(() => loadScript(DOCX_PREVIEW_URL))
  ]);
}
function loadMediaDocument() {
  return Promise.resolve(null);
}
function loadImageDocument() {
  assertReaderActive();
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.className = "reader-image";
    image.alt = documentState.title;
    image.decoding = "async";
    let fallback = false,
      settled = false,
      timeout = 0,
      untrack = () => {};
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      untrack();
      image.onload = image.onerror = null;
      if (error) {
        image.removeAttribute("src");
        reject(error);
      } else resolve(image);
    };
    untrack = trackReaderResource(() => finish(readerAbortError()));
    timeout = setTimeout(() => finish(new Error("image load timeout")), READER_PROXY_TIMEOUT_MS);
    image.onload = () => finish();
    image.onerror = () => {
      if (readerAbortController.signal.aborted) return finish(readerAbortError());
      if (!fallback) {
        fallback = true;
        image.src = sourceUrl;
      } else finish(new Error("image load failed"));
    };
    image.src = contentUrl;
  });
}
function loadChapterManifestDocument() {
  return fetchReaderUrl(chapterManifestUrl || sourceUrl);
}

// Foliate keeps a source-to-rendered text mapping because CFI addresses the
// original document, before sanitization and insertion into a shadow root.
function cloneFoliateDocument(source) {
  const doc = source.cloneNode(true),
    original = source.createTreeWalker(source, NodeFilter.SHOW_TEXT),
    cloned = doc.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  const sourceNodes = new WeakMap();
  while (original.nextNode() && cloned.nextNode())
    sourceNodes.set(cloned.currentNode, original.currentNode);
  return { doc: sanitizeEpubDocument(doc), sourceNodes };
}
function foliateSearchAnchor(source, sourceNodes, body, renderedBody) {
  const sourceWalker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const pairs = [];
  let offset = 0;
  while (sourceWalker.nextNode()) {
    const node = sourceWalker.currentNode;
    const original = sourceNodes.get(node);
    if (original) pairs.push({ original, offset });
    offset += node.length;
  }
  return (anchor) => {
    const range = anchor(source);
    if (!range || typeof range.intersectsNode !== "function") return null;
    const intervals = [];
    for (const { original, offset } of pairs) {
      if (!range.intersectsNode(original)) continue;
      const start = range.startContainer === original ? range.startOffset : 0;
      const end = range.endContainer === original ? range.endOffset : original.length;
      if (end > start) intervals.push({ start: offset + start, end: offset + end });
    }
    const walker = document.createTreeWalker(renderedBody, NodeFilter.SHOW_TEXT),
      selected = [];
    let offset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode,
        end = offset + node.length;
      for (const interval of intervals)
        if (interval.start < end && interval.end > offset)
          selected.push({
            node,
            start: Math.max(0, interval.start - offset),
            end: Math.min(node.length, interval.end - offset)
          });
      offset = end;
    }
    return selected;
  };
}
async function settleReaderImages(root) {
  const images = [...root.querySelectorAll("img[src],img[srcset]")];
  if (!images.length) return;
  let timeout = 0;
  const decoded = Promise.allSettled(
    images.map((image) =>
      typeof image.decode === "function"
        ? image.decode()
        : image.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            })
    )
  );
  try {
    await awaitReader(
      Promise.race([
        decoded,
        new Promise((resolve) => {
          timeout = setTimeout(resolve, 2500);
        })
      ])
    );
  } finally {
    clearTimeout(timeout);
  }
}
function rewriteFoliateResources(doc, section) {
  const safeEmbeddedValue = (value) =>
    /^(?:blob:|data:image\/(?:gif|png|jpe?g|webp);)/i.test(String(value || "").trim());
  const archiveResourceUrl = (value) => {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("#") || raw.includes("#") || safeEmbeddedValue(raw))
      return safeEmbeddedValue(raw) ? raw : null;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(raw)) return null;
    try {
      const resolved = String(
        (section.resolveResourceHref
          ? section.resolveResourceHref(raw)
          : section.resolveHref?.(raw)) || ""
      );
      if (
        !resolved ||
        /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(resolved) ||
        /[\\\x00]/.test(resolved) ||
        resolved.split("/").some((part) => !part || part === "." || part === "..")
      )
        return null;
      return `https://voiceofml-search.hf.space/api/reader-resource?book=${encodeURIComponent(sourceUrl)}&path=${encodeURIComponent(resolved)}`;
    } catch (_) {
      return null;
    }
  };
  for (const element of doc.querySelectorAll(
    "img[src],source[src],audio[src],video[src],video[poster]"
  )) {
    for (const name of ["src", "poster"])
      if (element.hasAttribute(name)) {
        const safe = archiveResourceUrl(element.getAttribute(name));
        if (safe) element.setAttribute(name, safe);
        else element.removeAttribute(name);
      }
  }
  for (const element of doc.querySelectorAll("[srcset]")) {
    const value = element.getAttribute("srcset") || "";
    const candidates = value
      .split(",")
      .map((part) => {
        const [raw, ...descriptor] = part.trim().split(/\s+/);
        const safe = archiveResourceUrl(raw);
        return safe ? [safe, ...descriptor].join(" ") : null;
      })
      .filter(Boolean);
    if (candidates.length) element.setAttribute("srcset", candidates.join(", "));
    else element.removeAttribute("srcset");
  }
  for (const image of doc.querySelectorAll("image")) {
    const value =
      image.getAttributeNS("http://www.w3.org/1999/xlink", "href") ||
      image.getAttribute("xlink:href") ||
      image.getAttribute("href");
    const safe = archiveResourceUrl(value);
    if (safe) {
      image.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", safe);
      image.setAttribute("href", safe);
    } else {
      image.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
      image.removeAttribute("xlink:href");
      image.removeAttribute("href");
    }
  }
  for (const link of doc.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") || "";
    if (/^(?:https?:|mailto:|tel:)/i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
}
async function createFoliateSection(section, index) {
  const source = await section.createDocument();
  const { doc, sourceNodes } = cloneFoliateDocument(source);
  assertReaderActive();
  rewriteFoliateResources(doc, section);
  const styles = [...doc.querySelectorAll("style,link")].map((node) => node.cloneNode(true));
  for (const node of doc.querySelectorAll("style,link")) node.remove();
  const article = document.createElement("article");
  article.dataset.section = String(index);
  const shadow = article.attachShadow({ mode: "open" }),
    baseStyle = document.createElement("style"),
    sectionBody = document.createElement("div");
  // Chapter styles live in a shadow root, so document-level preferences cannot reach them.
  baseStyle.textContent = `
    :host { display: block; color: inherit; }
    * { box-sizing: border-box; }
    .reader-section-body { display: block; color: inherit; line-height: inherit; }
    .reader-section-body > :first-child { margin-top: 0 !important; }
    a { color: var(--reader-book-link) !important; }
    img, svg, video { max-width: 100%; height: auto; }
    mark.full-search-highlight { background: #ffd54f; color: #111; }
    @media (prefers-contrast: more) {
      .reader-section-body a[href] { text-decoration: underline !important; }
      .reader-section-body mark.full-search-highlight { outline: 2px solid currentColor; }
    }
  `;
  sectionBody.className = "reader-section-body";
  const body = epubContentBody(doc);
  sectionBody.innerHTML = body ? body.innerHTML : "";
  article._resolveSearchAnchor = foliateSearchAnchor(source, sourceNodes, body, sectionBody);
  shadow.append(baseStyle, ...styles, sectionBody);
  await settleReaderImages(sectionBody);
  assertReaderActive();
  return article;
}
function setupFoliateWindow(stream, sections) {
  const observer = new IntersectionObserver(
    (entries) =>
      entries
        .filter((entry) => entry.isIntersecting)
        .forEach((entry) => {
          if (readerAbortController.signal.aborted || !foliateChapterRepository) return;
          const index = Number(entry.target.dataset.section);
          if (entry.target.classList.contains("foliate-section-placeholder")) {
            foliateChapterRepository
              .load(index)
              .then(() => foliateScrollAnchors.whenIdle(trimFoliateSections))
              .catch(() => {});
            return;
          }
          const adjacentLoads = [index - 1, index + 1]
            .filter((adjacent) => sections[adjacent])
            .map((adjacent) => foliateChapterRepository.load(adjacent));
          if (adjacentLoads.length)
            Promise.allSettled(adjacentLoads).then(() =>
              foliateScrollAnchors.whenIdle(trimFoliateSections)
            );
        }),
    { root: viewport, rootMargin: "1000px" }
  );
  foliateSectionObserver = observer;
  foliateChapterRepository = VoiceOfMLReaderChapters.createChapterRepository({
    count: sections.length,
    find: (index) =>
      stream.querySelector(`article[data-section="${index}"]:not(.foliate-section-placeholder)`),
    create: (index) => createFoliateSection(sections[index], index),
    commit: (index, article) =>
      foliateScrollAnchors.preserve(() => {
        const placeholder = stream.querySelector(
            `article.foliate-section-placeholder[data-section="${index}"]`
          ),
          next = [...stream.querySelectorAll("article[data-section]")].find(
            (item) => Number(item.dataset.section) > index
          );
        if (placeholder) {
          observer.unobserve(placeholder);
          placeholder.replaceWith(article);
        } else stream.insertBefore(article, next || null);
        observer.observe(article);
        foliateScrollAnchors.observe(article);
        scheduleFoliateWindowRefresh();
        return article;
      })
  });
  foliateSectionVirtualizer = VoiceOfMLReaderVirtual.createSectionVirtualizer({
    limit: 9,
    getLoaded: () => [
      ...stream.querySelectorAll("article[data-section]:not(.foliate-section-placeholder)")
    ],
    getIndex: (article) => Number(article.dataset.section),
    getHeight: (article) => article.getBoundingClientRect().height,
    canVirtualize: (article) => {
      const rect = article.getBoundingClientRect(),
        viewportRect = viewport.getBoundingClientRect();
      return rect.bottom < viewportRect.top - 1000 || rect.top > viewportRect.bottom + 1000;
    },
    virtualize: (article, index, height) => {
      const placeholder = document.createElement("article");
      placeholder.className = "foliate-section-placeholder";
      placeholder.dataset.section = String(index);
      placeholder.style.setProperty("--foliate-placeholder-height", `${height}px`);
      placeholder.setAttribute("aria-hidden", "true");
      observer.unobserve(article);
      foliateScrollAnchors.unobserve(article);
      article.replaceWith(placeholder);
      observer.observe(placeholder);
      return placeholder;
    },
    release: (index) => foliateChapterRepository.release(index),
    preserve: (change) => foliateScrollAnchors.preserve(change)
  });
  foliateSectionLoader = (index) => foliateChapterRepository.load(index);
  foliateSectionSettler = async () => {
    assertReaderActive();
    const repository = foliateChapterRepository,
      indices = [
        ...stream.querySelectorAll("article[data-section]:not(.foliate-section-placeholder)")
      ].map((article) => Number(article.dataset.section));
    await awaitReader(
      Promise.allSettled(
        indices
          .flatMap((index) => [index - 1, index + 1])
          .filter((index) => sections[index])
          .map((index) => repository.load(index))
      )
    );
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitForReader(0, true);
      const tasks = repository.pending;
      if (tasks.length) await awaitReader(Promise.allSettled(tasks));
    }
  };
}
async function foliateTocEntries(view, sections) {
  const entries = [];
  const append = (items, depth = 0) => {
    for (const item of items || []) {
      const href = item?.href ? String(item.href) : "";
      if (href)
        entries.push({
          label: item.label || "未命名章节",
          href,
          depth,
          activate: () => view.goTo(href)
        });
      append(item.subitems, depth + 1);
    }
  };
  append(view.book.toc);
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const target = await view.book.resolveHref(entry.href),
          section = target && view.book.sections[target.index];
        entry.sectionIndex = section ? sections.indexOf(section) : -1;
        const fragment = entry.href.split("#")[1] || "";
        entry.fragment = fragment ? decodeURIComponent(fragment) : "";
      } catch (_) {
        entry.sectionIndex = -1;
        entry.fragment = "";
      }
    })
  );
  assertReaderActive();
  return entries;
}
async function renderFoliate() {
  const [response] = await Promise.all([
    fetchReaderResponse(),
    import("/search/static/foliate-reader/view.js?reader-v1")
  ]);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await VoiceOfMLReaderSecurity.readBytes(
    response,
    VoiceOfMLReaderSecurity.LIMITS.archiveCompressedBytes
  );
  assertReaderActive();
  if (VoiceOfMLReaderSecurity.isZipContainer(extension, bytes))
    VoiceOfMLReaderSecurity.inspectZip(bytes);
  const view = document.createElement("foliate-view"),
    stream = document.createElement("div");
  view.className = "foliate-reader-view";
  stream.className = "foliate-continuous";
  content.replaceChildren(view, stream);
  epubRendition = view;
  await view.open(
    new File([bytes], new URL(sourceUrl).pathname.split("/").pop() || "book.epub", {
      type: response.headers.get("content-type") || "application/epub+zip"
    })
  );
  assertReaderActive();
  epubBook = view.book;
  view.style.display = "none";
  const sections = view.book.sections.filter((section) => section.linear !== "no");
  setupFoliateWindow(stream, sections);
  if (sections[0]) await foliateChapterRepository.load(0);
  assertReaderActive();
  const entries = await foliateTocEntries(view, sections);
  if (entries.length) setToc(entries);
  scheduleFoliateScrollSync();
  loadingIndicator.remove();
  loadingStatus.hidden = true;
  loadingObserver.disconnect();
  status.textContent = "EPUB";
}
// Reading progress controls and undo.
const progressTools = document.createElement("div");
progressTools.className = "reader-progress-tools";
progressTools.innerHTML =
  '<div class="reader-progress-row"><button class="reader-chapter-prev" type="button" aria-label="上一章" title="上一章"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7"/></svg></button><input class="reader-progress-range" type="range" min="0" max="100" step="0.1" value="0" aria-label="阅读进度"><span class="reader-progress-percent">0.0%</span><button class="reader-progress-undo" type="button" aria-label="撤销进度调整" title="撤销进度调整"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 8.3A6.5 6.5 0 1 1 6 16"/><path d="m7.2 8.3 3-.2"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg></button><button class="reader-chapter-next" type="button" aria-label="下一章" title="下一章"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7"/></svg></button></div>';
document.querySelector("#history-panel").appendChild(progressTools);
const readingProgressSummary = document.createElement("div");
readingProgressSummary.className = "reader-progress-summary";
readingProgressSummary.innerHTML =
  '<strong>阅读状态</strong><span class="reader-progress-summary-value">0.0%</span><button class="reader-progress-bookmark text-action" type="button">在当前位置添加书签</button>';
progressTools.prepend(readingProgressSummary);
readingProgressSummary
  .querySelector(".reader-progress-bookmark")
  .addEventListener("click", (event) => openBookmarkPopover(event.currentTarget));
function updateReadingProgressSummary() {
  const noToc = !navigationState.tocEntries.length && !mediaElement;
  readingProgressSummary.hidden = !noToc;
  if (noToc)
    readingProgressSummary.querySelector(".reader-progress-summary-value").textContent =
      `${readerProgressPercent().toFixed(1)}%`;
}
updateReadingProgressSummary();
function syncTocTab() {
  const tab = document.querySelector("#toc-tab");
  if (!tab) return;
  tab.hidden = !navigationState.tocEntries.length;
  if (navigationState.tocEntries.length && navigationState.currentChapterIndex < 0)
    updateNavigationState({ currentChapterIndex: 0 });
}
syncTocTab();
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
function updateProgressTools() {
  if (progressSeeking) return;
  const percent = readerProgressPercent();
  progressRange.value = String(percent);
  progressPercent.textContent = `${percent.toFixed(1)}%`;
  const hasChapters = navigationState.tocEntries.length > 0,
    hasPreviousChapter = hasChapters && navigationState.currentChapterIndex > 0,
    hasNextChapter =
      hasChapters &&
      navigationState.currentChapterIndex >= 0 &&
      navigationState.currentChapterIndex < navigationState.tocEntries.length - 1;
  chapterPrev.hidden = !hasChapters;
  chapterNext.hidden = !hasChapters;
  chapterPrev.disabled = !hasPreviousChapter;
  chapterNext.disabled = !hasNextChapter;
  progressUndo.hidden = !previousProgressState;
  updateReadingProgressSummary();
  placeReadingProgress();
}
function captureProgressState() {
  return foliateContinuous
    ? captureFoliateBookmarkPosition()
    : capability.mode === "epub-chapters"
      ? captureChapterPosition()
      : mediaElement
        ? { mediaTime: mediaElement.currentTime }
        : htmlFrame && htmlFrame.contentWindow
          ? { htmlScrollTop: htmlFrame.contentWindow.scrollY }
          : { scrollTop: viewport.scrollTop };
}
async function restoreProgressState(state, generation = beginReaderNavigation()) {
  if (!state || !isReaderGenerationCurrent("navigation", generation)) return;
  if (foliateContinuous && Number.isInteger(state.foliateSection))
    return restoreFoliateBookmarkPosition(state, generation);
  if (capability.mode === "epub-chapters" && Number.isInteger(state.chapterIndex))
    return restoreChapterPosition(state, generation);
  try {
    if (mediaElement && Number.isFinite(state.mediaTime)) {
      const media = mediaElement;
      if (!media.readyState)
        await new Promise((resolve, reject) => {
          const finish = (error) => {
            media.removeEventListener("loadedmetadata", loaded);
            media.removeEventListener("error", failed);
            untrack();
            if (error) reject(error);
            else resolve();
          };
          const loaded = () => finish(),
            failed = () => finish(new Error("Media metadata unavailable"));
          const untrack = trackReaderResource(() => finish(readerAbortError()));
          media.addEventListener("loadedmetadata", loaded, { once: true });
          media.addEventListener("error", failed, { once: true });
        });
      if (!isReaderGenerationCurrent("navigation", generation)) return;
      media.currentTime = state.mediaTime;
    } else if (htmlFrame && htmlFrame.contentWindow && Number.isFinite(state.htmlScrollTop))
      htmlFrame.contentWindow.scrollTo(0, state.htmlScrollTop);
    else if (Number.isFinite(state.scrollTop)) viewport.scrollTop = state.scrollTop;
    updateProgressTools();
    scheduleSave();
  } catch (error) {
    reportNavigationError(error, generation);
  }
}
function flushEpubSeek() {
  if (epubSeekFrame) {
    cancelAnimationFrame(epubSeekFrame);
    epubSeekFrame = 0;
    epubSeekPromise = seekFoliateProgress(epubSeekTarget.percent, epubSeekTarget.generation);
  }
  return epubSeekPromise;
}
function seekProgress(value, preserve = false) {
  if (!preserve || !previousProgressState) previousProgressState = captureProgressState();
  const generation = beginReaderNavigation(),
    percent = Math.max(0, Math.min(100, Number(value)));
  if (!isReaderGenerationCurrent("navigation", generation)) return;
  if (mediaElement && mediaElement.duration)
    mediaElement.currentTime = (mediaElement.duration * percent) / 100;
  else if (foliateContinuous) {
    epubSeekTarget = { percent, generation };
    epubSeekFrame = requestAnimationFrame(() => {
      epubSeekFrame = 0;
      epubSeekPromise = seekFoliateProgress(percent, generation);
    });
  } else if (htmlFrame && htmlFrame.contentWindow)
    htmlFrame.contentWindow.scrollTo(
      0,
      (Math.max(
        0,
        htmlFrame.contentDocument.documentElement.scrollHeight - htmlFrame.contentWindow.innerHeight
      ) *
        percent) /
        100
    );
  else
    viewport.scrollTop =
      (Math.max(0, viewport.scrollHeight - viewport.clientHeight) * percent) / 100;
  updateProgressTools();
  scheduleSave();
}
async function activateChapter(index) {
  if (
    index < 0 ||
    index >= navigationState.tocEntries.length ||
    index === navigationState.currentChapterIndex
  )
    return;
  try {
    await navigateTocEntry(index);
  } finally {
    updateProgressTools();
  }
}
progressRange.addEventListener("pointerdown", () => {
  beginReaderNavigation();
  progressSeeking = true;
  previousProgressState = captureProgressState();
});
progressRange.addEventListener("input", () => {
  progressPercent.textContent = `${Number(progressRange.value).toFixed(1)}%`;
  seekProgress(progressRange.value, true);
});
for (const type of ["pointerup", "pointercancel"])
  progressRange.addEventListener(type, () => {
    progressSeeking = false;
    const generation = readerRuntime.currentGeneration("navigation");
    flushEpubSeek().then(() => {
      if (isReaderGenerationCurrent("navigation", generation)) updateProgressTools();
    });
  });
progressUndo.addEventListener("click", () => {
  const state = previousProgressState;
  previousProgressState = null;
  progressSeeking = false;
  restoreProgressState(state);
  updateProgressTools();
});
chapterPrev.addEventListener("click", () =>
  activateChapter(navigationState.currentChapterIndex - 1)
);
chapterNext.addEventListener("click", () =>
  activateChapter(navigationState.currentChapterIndex + 1)
);
const fullSearchView = document.createElement("section");
fullSearchView.id = "full-search-view";
fullSearchView.className = "reader-panel-view full-search-view";
fullSearchView.dataset.panelView = "full-search";
fullSearchView.hidden = true;
fullSearchView.innerHTML =
  '<div class="full-search-bar"><input id="full-search-input" class="full-search-input" type="search" placeholder="搜索正文" aria-label="搜索正文"><button id="full-search-clear" class="icon-button" type="button" aria-label="清除全文搜索" title="清除">×</button></div><div id="full-search-status" class="full-search-status" role="status">输入关键词搜索正文</div><div class="full-search-nav"><button id="full-search-prev" type="button" disabled>上一个</button><button id="full-search-next" type="button" disabled>下一个</button></div><div id="full-search-results" class="full-search-results"></div>';
document
  .querySelector("#history-panel")
  .insertBefore(fullSearchView, document.querySelector(".reader-panel-tabs"));
const fullSearchButton = document.querySelector("#full-search-toggle");
fullSearchButton.textContent = "全文搜索";
fullSearchButton.setAttribute("aria-label", "全文搜索");
fullSearchButton.hidden = !capability.features.search;
const fullSearchInput = fullSearchView.querySelector("#full-search-input"),
  fullSearchStatus = fullSearchView.querySelector("#full-search-status"),
  fullSearchResultsNode = fullSearchView.querySelector("#full-search-results");
// Full-text search: format matching, result presentation, and navigation.
async function fullSearchFoliateMatches(query, generation) {
  const results = [];
  if (!epubRendition?.search) return results;
  for await (const group of epubRendition.search({ query })) {
    if (!isReaderGenerationCurrent("search", generation)) return [];
    let occurrence = 0;
    for (const item of group.subitems || []) {
      const excerpt = item.excerpt || { pre: "", match: query, post: "" };
      results.push({
        location: group.label || "电子书位置",
        cfi: item.cfi,
        occurrence: occurrence++,
        snippet: {
          text: `${excerpt.pre}${excerpt.match}${excerpt.post}`,
          matchStart: excerpt.pre.length,
          matchLength: excerpt.match.length,
          prefix: "",
          suffix: ""
        }
      });
      if (results.length === 100) return results;
    }
  }
  return results;
}
function fullSearchEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
let fullSearchActiveMarks = [];
function clearFullSearchMarks() {
  for (const mark of fullSearchActiveMarks) {
    if (mark.tagName === "MARK") mark.replaceWith(mark.textContent);
    else mark.classList.remove("full-search-highlight");
  }
  fullSearchActiveMarks = [];
  content.normalize();
  htmlFrame?.contentDocument?.body?.normalize();
  for (const article of content.querySelectorAll(".foliate-continuous article[data-section]"))
    foliateSectionRoot(article).normalize();
}
async function fullSearchTextNodes(root, generation) {
  const nodes = [],
    walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let visited = 0;
  while (walker.nextNode()) {
    if (!isReaderGenerationCurrent("search", generation)) return null;
    const node = walker.currentNode;
    if (
      node.data &&
      !node.parentElement.closest("script,style,mark.full-search-highlight,.reader-pdf-text")
    )
      nodes.push(node);
    if (++visited % 1000 === 0) await waitForReader();
  }
  return nodes;
}
function highlightTextParts(parts) {
  const marks = [];
  for (const { node, start, end } of [...parts].reverse()) {
    node.splitText(end);
    const selected = node.splitText(start),
      mark = node.ownerDocument.createElement("mark");
    mark.className = "full-search-highlight";
    mark.textContent = selected.data;
    selected.replaceWith(mark);
    fullSearchActiveMarks.push(mark);
    marks.unshift(mark);
  }
  return marks;
}
function fullSearchSnippet(text, index, length) {
  const start = Math.max(0, index - 72),
    end = Math.min(text.length, index + length + 88);
  return {
    text: text.slice(start, end),
    matchStart: index - start,
    matchLength: length,
    prefix: start ? "…" : "",
    suffix: end < text.length ? "…" : ""
  };
}
function fullSearchSnippetDom(snippet) {
  const node = document.createElement("span");
  node.className = "full-search-snippet";
  if (snippet.prefix) node.append(snippet.prefix);
  node.append(snippet.text.slice(0, snippet.matchStart));
  const mark = document.createElement("mark");
  mark.className = "search-match";
  mark.textContent = snippet.text.slice(
    snippet.matchStart,
    snippet.matchStart + snippet.matchLength
  );
  node.append(mark, snippet.text.slice(snippet.matchStart + snippet.matchLength));
  if (snippet.suffix) node.append(snippet.suffix);
  return node;
}
function fullSearchLocation(node, fallback) {
  const page = node.parentElement && node.parentElement.closest("[data-page]");
  return page ? `第 ${page.dataset.page} 页` : fallback;
}
async function fullSearchDomMatches(root, fallback, query, generation) {
  root = foliateSectionRoot(root);
  const nodes = await fullSearchTextNodes(root, generation);
  if (!nodes || !isReaderGenerationCurrent("search", generation)) return [];
  const offsets = [],
    chunks = [];
  let length = 0;
  for (const [index, node] of nodes.entries()) {
    offsets.push({ node, start: length, end: length + node.data.length });
    chunks.push(node.data);
    length += node.data.length;
    if (index % 1000 === 999) {
      await waitForReader();
      if (!isReaderGenerationCurrent("search", generation)) return [];
    }
  }
  const text = chunks.join(""),
    matches = [],
    output = [];
  // Limit displayed results, not the searched nodes; scan long text in chunks
  // with enough overlap to retain matches across each chunk boundary.
  let nextStart = 0;
  for (let start = 0; start < text.length && matches.length < 100; start += 65536) {
    const pattern = new RegExp(fullSearchEscape(query), "giu");
    const slice = text.slice(start, start + 65536 + query.length - 1);
    pattern.lastIndex = Math.max(0, nextStart - start);
    for (const match of slice.matchAll(pattern)) {
      if (match.index >= 65536) break;
      matches.push({ index: start + match.index, value: match[0] });
      nextStart = start + match.index + match[0].length;
      if (matches.length === 100) break;
    }
    await waitForReader();
    if (!isReaderGenerationCurrent("search", generation)) return [];
  }
  for (const match of matches.reverse()) {
    const end = match.index + match.value.length;
    const parts = offsets.filter((part) => part.end > match.index && part.start < end);
    const [target] = highlightTextParts(
      parts.map((part) => ({
        node: part.node,
        start: Math.max(match.index, part.start) - part.start,
        end: Math.min(end, part.end) - part.start
      }))
    );
    output.unshift({
      location: fullSearchLocation(parts[0].node, fallback),
      snippet: fullSearchSnippet(text, match.index, match.value.length),
      target,
      activate: () => {
        if (!target.isConnected) return false;
        target.scrollIntoView({ block: "center" });
      }
    });
  }
  return output;
}
async function navigateFoliateSearchResult(result, generation) {
  const resolved = await epubRendition?.resolveNavigation?.(result.cfi);
  if (!resolved || !isReaderGenerationCurrent("navigation", generation)) return;
  const section = epubBook?.sections?.[resolved.index],
    sections = epubBook?.sections?.filter((item) => item.linear !== "no") || [],
    visibleIndex = section ? sections.indexOf(section) : -1;
  if (visibleIndex < 0 || !foliateSectionLoader) return;
  let node = await foliateSectionLoader(visibleIndex);
  if (!isReaderGenerationCurrent("navigation", generation)) return;
  if (foliateSectionSettler) await foliateSectionSettler();
  if (!isReaderGenerationCurrent("navigation", generation)) return;
  if (!node?.isConnected) node = await foliateSectionLoader(visibleIndex);
  if (!node?.isConnected || !isReaderGenerationCurrent("navigation", generation)) return;
  clearFullSearchMarks();
  let target;
  if (typeof resolved.anchor === "function" && node._resolveSearchAnchor) {
    const parts = node._resolveSearchAnchor(resolved.anchor);
    if (!parts?.length) return false;
    [target] = highlightTextParts(parts);
  } else {
    // Some non-CFI engines expose only a section locator.
    const matches = await fullSearchDomMatches(
      foliateSectionRoot(node),
      "电子书位置",
      searchState.query,
      readerRuntime.currentGeneration("search")
    );
    target = matches[result.occurrence || 0]?.target;
  }
  if (!isReaderGenerationCurrent("navigation", generation) || !target) return false;
  const targetRect = target.getBoundingClientRect(),
    viewportRect = viewport.getBoundingClientRect();
  foliateScrollAnchors.invalidate();
  viewport.scrollTop = Math.max(
    0,
    viewport.scrollTop +
      targetRect.top -
      viewportRect.top -
      (viewport.clientHeight - targetRect.height) / 2
  );
  const tocIndex = navigationState.tocEntries.findIndex(
    (entry) => entry.sectionIndex === visibleIndex
  );
  if (tocIndex >= 0) {
    updateNavigationState({ currentChapterIndex: tocIndex });
    updateTocCurrentMark();
  }
  updateProgressTools();
  scheduleSave();
}
async function fullSearchPdfMatches(query, generation) {
  const pdf = pdfDocument,
    output = [],
    pattern = new RegExp(fullSearchEscape(query), "giu");
  if (!pdf) return output;
  for (let page = 1; page <= pdf.numPages && output.length < 100; page++) {
    if (!isReaderGenerationCurrent("search", generation)) return [];
    const pdfPage = await awaitReader(pdf.getPage(page));
    if (!isReaderGenerationCurrent("search", generation)) return [];
    const textContent = await awaitReader(pdfPage.getTextContent());
    if (!isReaderGenerationCurrent("search", generation)) return [];
    const text = textContent.items
      .map((item) => item.str + (item.hasEOL ? "\n" : " "))
      .join("")
      .trim();
    let matched = false;
    for (const match of text.matchAll(pattern)) {
      if (output.length >= 100) break;
      matched = true;
      output.push({
        location: `第 ${page} 页`,
        snippet: fullSearchSnippet(text, match.index, match[0].length),
        activate: (navigationGeneration) => goToPage(page, navigationGeneration)
      });
    }
    if (matched)
      highlightPdfText(content.querySelector(`.reader-page[data-page="${page}"]`), query);
  }
  return output;
}
function renderFullSearchResults() {
  fullSearchResultsNode.textContent = "";
  for (const [index, result] of searchState.results.entries()) {
    const row = document.createElement("button"),
      location = document.createElement("small");
    row.type = "button";
    row.className = "full-search-result";
    location.className = "full-search-location";
    location.textContent = result.location;
    row.append(location, fullSearchSnippetDom(result.snippet));
    row.addEventListener("click", () => activateFullSearchResult(index));
    fullSearchResultsNode.appendChild(row);
  }
  fullSearchView.querySelectorAll(".full-search-nav button").forEach((button) => {
    button.disabled = !searchState.results.length;
  });
}
async function runFullSearch() {
  const query = fullSearchInput.value.trim();
  const generation = nextReaderGeneration("search");
  beginReaderNavigation();
  clearFullSearchMarks();
  updateSearchState({ query, results: [], index: -1 });
  fullSearchResultsNode.textContent = "";
  fullSearchView.querySelectorAll(".full-search-nav button").forEach((button) => {
    button.disabled = true;
  });
  if (!query) {
    fullSearchStatus.textContent = "输入关键词搜索正文";
    return;
  }
  fullSearchStatus.textContent = "正在搜索正文…";
  try {
    if (capability.mode === "pdf")
      publishSearchResults(generation, await fullSearchPdfMatches(query, generation));
    else if (capability.mode === "foliate")
      publishSearchResults(generation, await fullSearchFoliateMatches(query, generation));
    else if (["text", "markdown", "docx"].includes(capability.mode))
      publishSearchResults(
        generation,
        await fullSearchDomMatches(content, "阅读位置", query, generation)
      );
    else if (capability.mode === "html")
      publishSearchResults(
        generation,
        htmlFrame?.contentDocument?.body
          ? await fullSearchDomMatches(
              htmlFrame.contentDocument.body,
              "HTML 阅读位置",
              query,
              generation
            )
          : []
      );
    else throw new Error("此格式没有可搜索文本");
    if (!isReaderGenerationCurrent("search", generation)) return;
    renderFullSearchResults();
    fullSearchStatus.textContent = searchState.results.length
      ? `${searchState.results.length}${searchState.results.length === 100 ? "+" : ""} 个结果`
      : "未找到正文匹配";
  } catch (error) {
    if (isReaderGenerationCurrent("search", generation))
      fullSearchStatus.textContent = error.message || "正文搜索不可用";
  } finally {
    if (isReaderGenerationCurrent("search", generation))
      fullSearchView.querySelectorAll(".full-search-nav button").forEach((button) => {
        button.disabled = !searchState.results.length;
      });
  }
}
async function activateFullSearchResult(index, closePanel = true) {
  const result = searchState.results[index];
  if (!result) return;
  const generation = beginReaderNavigation();
  updateSearchState({ index });
  try {
    const activated = result.cfi
      ? await navigateFoliateSearchResult(result, generation)
      : await result.activate(generation);
    if (
      activated === false ||
      !isReaderGenerationCurrent("navigation", generation) ||
      searchState.results[index] !== result
    )
      return;
    if (closePanel) setReaderPanelOpen(false, true);
    else fullSearchResultsNode.children[index]?.scrollIntoView({ block: "nearest" });
  } catch (error) {
    reportNavigationError(error, generation);
  }
}
function moveFullSearch(step) {
  if (searchState.results.length)
    return activateFullSearchResult(
      (searchState.index + step + searchState.results.length) % searchState.results.length,
      false
    );
}
function toggleFullSearch() {
  const panel = document.querySelector("#history-panel");
  if (panel.classList.contains("is-open") && !fullSearchView.hidden) {
    beginReaderNavigation();
    nextReaderGeneration("search");
    clearFullSearchMarks();
    updateSearchState({ results: [], index: -1 });
    renderFullSearchResults();
    selectPanel(navigationState.tocEntries.length ? "toc" : "bookmarks");
    return;
  }
  setReaderPanelOpen(true);
  selectPanel("full-search");
  fullSearchInput.focus();
  runFullSearch();
}
fullSearchButton.addEventListener("click", toggleFullSearch);
fullSearchInput.addEventListener("input", (event) => {
  if (!event.isComposing) runFullSearch();
});
fullSearchInput.addEventListener("compositionend", runFullSearch);
fullSearchView.querySelector("#full-search-clear").addEventListener("click", () => {
  fullSearchInput.value = "";
  runFullSearch();
  fullSearchInput.focus();
});
fullSearchView
  .querySelector("#full-search-prev")
  .addEventListener("click", () => moveFullSearch(-1));
fullSearchView
  .querySelector("#full-search-next")
  .addEventListener("click", () => moveFullSearch(1));
function syncCapabilityControls() {
  content.dataset.mode = capability.mode || "unsupported";
  document.querySelector(".page-controls").hidden = !capability.features.pagination;
  document.querySelector(".zoom-controls").hidden = !capability.features.zoom;
  mediaTab.hidden = !capability.features.media;
  fullSearchButton.hidden = !capability.features.search;
  bookmarkRibbon.hidden = !capability.features.bookmarks;
  readingProgressSummary.querySelector(".reader-progress-bookmark").hidden =
    !capability.features.bookmarks;
  if (
    (panelState.selected === "media" && mediaTab.hidden) ||
    (panelState.selected === "full-search" && fullSearchButton.hidden)
  )
    selectPanel("toc");
}
registerReaderFormatAdapters();
syncCapabilityControls();
updateProgressTools();
start().catch((error) => {
  if (readerAbortController.signal.aborted || error?.name === "AbortError") return;
  console.error(error);
  fail("阅读文件解析失败，请刷新后重试，或下载原文件。", classifyReaderError(error));
});

const DATA_URL = "data/search_data.json.gz";
const API_BASE = "https://voiceofml-search.hf.space";
const MIRROR_HOST = "hf-mirror.com";

function readSearchPreference(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
function writeSearchPreference(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* Preferences are optional. */ }
}
const HF_DATASET_BASE = "https://huggingface.co/datasets";
const WORKER_PROTOCOL_VERSION = 1;
const WORKER_REQUEST_TIMEOUT = 10000;
const WORKER_LOAD_TIMEOUT = 60000;
const APPEND_REQUEST_TIMEOUT = 5000;
const DOWNLOAD_CHECK_TIMEOUT = 8000;
const pendingSearchPages = getSearchTransport().pending;
// Detached compatibility projection for browser diagnostics; the controller owns recovery.
let pagingFailures = 0;

const ORDERED_EXTENSIONS = VoiceOfMLSearchFileTypes.orderedExtensions;
const FILE_ICON_MAP = VoiceOfMLSearchFileTypes.fileIconMap;

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="9" y2="9"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  csv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>',
  markdown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="11" y2="16"/><line x1="8" y1="13" x2="11" y2="10"/><line x1="13" y1="13" x2="16" y2="16"/><polyline points="13 16 16 13 19 16"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  ppt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/></svg>',
  xls: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/><line x1="8" y1="9" x2="16" y2="9"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
};

let sidebarIconStyleSheet = null;

function ensureSidebarIconStyles() {
  if (sidebarIconStyleSheet) return;
  const style = document.createElement("style");
  let css = "";
  for (const [key, markup] of Object.entries(ICONS)) {
    const svg = markup
      .replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"')
      .replace(/currentColor/g, "#000");
    const data = "data:image/svg+xml," + encodeURIComponent(svg);
    css += `.browser-file-icon.icon-${key}{-webkit-mask-image:url("${data}");mask-image:url("${data}")}`;
  }
  style.textContent = css;
  document.head.appendChild(style);
  sidebarIconStyleSheet = style;
}

function sidebarIconMarkup(key) {
  ensureSidebarIconStyles();
  return `<span class="browser-file-icon icon-${key}" aria-hidden="true"></span>`;
}

let extensionCounts = {};
let repoExtensionCounts = {};
let repoList = [];
let extensionList = [];
let readerMetadata = { available: false, count: 0, byRepo: {} };
const folderTreeCache = new Map();

let keepalivePending = null;
let lastKeepaliveAt = 0;
const KEEPALIVE_INTERVAL_MS = 45 * 1000;
const KEEPALIVE_MIN_GAP_MS = 30 * 1000;

function setExactSearchSectionVisible(visible, animate) {
  if (!DOM.exactSearchSection) return;
  if (!animate) DOM.exactSearchSection.style.transition = "none";
  DOM.exactSearchSection.classList.toggle("exact-section-hidden", !visible);
  // A visually collapsed control must not stay keyboard-reachable: otherwise a
  // hidden checkbox can silently change query semantics.
  DOM.exactSearchSection.inert = !visible;
  if (visible) DOM.exactSearchSection.removeAttribute("aria-hidden");
  else DOM.exactSearchSection.setAttribute("aria-hidden", "true");
  if (DOM.exactSearchToggle) DOM.exactSearchToggle.tabIndex = visible ? 0 : -1;
  if (!animate) {
    void DOM.exactSearchSection.offsetHeight;
    DOM.exactSearchSection.style.transition = "";
  }
}

function buildRecordLink(rec) {
  const repo = rec.Repo || "";
  return HF_DATASET_BASE + "/" + repo + "/resolve/main/" + encodeRecordPath(buildRecordRelativePath(rec));
}

function buildRecordPath(rec) {
  const repo = rec.Repo || "";
  return HF_DATASET_BASE + "/" + repo + "/blob/main/" + encodeRecordPath(buildRecordRelativePath(rec));
}

const readerAssetController = VoiceOfMLReaderAssets.create({
  bucketBase: API_BASE + "/api/reader-bucket-resource",
  buildRecordLink: record => buildRecordLink(record),
  getSearchViewKey: () => getSearchViewKey(),
  canWaitForPaint: () => !STATE.isMobile && STATE.leftSidebarOpen,
  resultsList: () => DOM.resultsList,
  isFirstViewReady: targetKey => STATE._loadedPage >= 1 && !STATE.isLoading && displayedSearchView?.key === targetKey
});

function loadReaderAssets(deferDecode) { return readerAssetController.loadReaderAssets(deferDecode); }
function loadReaderAssetsAfterFirstPaint() {
  return loadReaderAssets(readerAssetController.scheduling.state.delayUntilPaint);
}
function applyReaderAsset(record, repo, relativePath, originalLink) {
  return readerAssetController.applyReaderAsset(record, repo, relativePath, originalLink);
}
function getConvertedReaderRecords(repo) { return readerAssetController.getConvertedReaderRecords(repo); }

function getRecordLink(rec) {
  return rec.Link || buildRecordLink(rec);
}

function getReaderFolderUrl(rec) {
  var repo = String(rec.Repo || "").split("/").pop();
  if (!repo) return "";
  var folder = Array.isArray(rec.Folder) ? rec.Folder.join("/") : "";
  var sp = currentReaderSearchParams();
  if (folder) {
    sp.append("folder_self", folder);
    sp.set("path", folder);
  }
  var target = new URL("/search/", location.origin);
  target.hash = "#/" + repo + (sp.toString() ? "?" + sp.toString() : "");
  return target.href;
}

// Session handoff metadata is expendable; keep recent books within a fixed budget.
const readerSessionEntries = new Map();
let readerSessionInitialized = false;
function cacheReaderMetadata(id, data, source = false) {
  if (!id) return;
  const keys = [`reader-source:${id}`, `reader-resolve:${id}`];
  const remove = (bookId) => {
    sessionStorage.removeItem(`reader-source:${bookId}`);
    sessionStorage.removeItem(`reader-resolve:${bookId}`);
    readerSessionEntries.delete(bookId);
  };
  try {
    if (!readerSessionInitialized) {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        const match = /^reader-(?:source|resolve):(.+)$/.exec(key);
        if (match) readerSessionEntries.set(match[1], (readerSessionEntries.get(match[1]) || 0) +
          2 * (key.length + (sessionStorage.getItem(key) || "").length));
      }
      readerSessionInitialized = true;
    }
    const encoded = JSON.stringify(data);
    const values = [source ? encoded : sessionStorage.getItem(keys[0]), encoded];
    const bytes = values.reduce((sum, value, i) => sum + (value ? 2 * (keys[i].length + value.length) : 0), 0);
    readerSessionEntries.delete(id);
    readerSessionEntries.set(id, bytes);
    let total = [...readerSessionEntries.values()].reduce((sum, size) => sum + size, 0);
    while (readerSessionEntries.size > 128 || total > 512 * 1024) {
      const oldest = readerSessionEntries.keys().next().value;
      total -= readerSessionEntries.get(oldest);
      remove(oldest);
    }
    if (!readerSessionEntries.has(id)) return;
    for (;;) {
      try {
        if (source) sessionStorage.setItem(keys[0], encoded);
        sessionStorage.setItem(keys[1], encoded);
        return;
      } catch (_) {
        // A smaller browser quota or other session data may require more eviction.
        const oldest = readerSessionEntries.keys().next().value;
        remove(oldest);
        if (oldest === id) return;
      }
    }
  } catch (_) { /* Storage can be disabled; Reader can still resolve through the API. */ }
}

function getReaderLink(rec, returnUrl, cacheMetadata = true) {
  returnUrl = returnUrl || location.href;
  const readerRecord = Object.assign({}, rec, { Link: getRecordLink(rec), ReturnUrl: returnUrl, FolderUrl: getReaderFolderUrl(rec) });
  var readerUrl = VoiceOfMLReader.readerUrl(readerRecord, "/search/static/reader.html");
  if (cacheMetadata) try { var readerId = new URL(readerUrl, location.origin).searchParams.get("id"); if (readerId) { var sourceData = { url: readerRecord.ReaderLink || readerRecord.Link, download: readerRecord.Link, title: readerRecord.File, filename: String(readerRecord.File || "") + (readerRecord.Extension ? "." + readerRecord.Extension : ""), extension: readerRecord.ReaderExtension || readerRecord.Extension, original_extension: readerRecord.Extension, repo: String(readerRecord.Repo || "").split("/").pop(), folder: readerRecord.Folder, chapter_manifest: readerRecord.ReaderChapterManifest || "", pdf_document: readerRecord.ReaderPdfDocument || "" }; cacheReaderMetadata(readerId, sourceData, true); } } catch (_) {}
  return readerUrl;
}

// Reader host owns overlay and return-position state. Effects resolve live host hooks.
const readerReturnPosition = VoiceOfMLReaderReturn.create({
  readView: () => ({ hasContainer: !!DOM.resultsContainer, containerHeight: DOM.resultsContainer?.clientHeight || 0,
    resultCount: STATE.results.length, total: STATE.total, loading: STATE.isLoading, loadedPage: STATE._loadedPage,
    positionRestore: positionRestore && { preview: positionRestore.preview, key: positionRestore.key }, routeRevision: routeRenderId }),
  hasResult: index => !!STATE.results[index], getViewKey: () => getSearchViewKey(),
  getTop: () => getResultScrollTop(), setTop: top => setResultScrollTop(top),
  ensureHeights: () => ensureHeightTree(), findIndex: top => findVirtualIndex(top),
  getOffset: index => getVirtualOffset(index), getTotalHeight: () => getVirtualTotalHeight(),
  invalidateWindow: () => { VSCROLL.renderStart = -1; VSCROLL.renderEnd = -1; },
  renderVisible: () => renderVisible(), updateTrack: () => updateScrollTrack(),
  handoffReady: saved => readerSearchHandoffReady(saved),
  restoreScroll: (rendered, top) => restoreReaderReturnScroll(rendered, top)
});
const readerHost = VoiceOfMLReaderHost.create({
  hashRoute: true, position: readerReturnPosition,
  createNavigation: options => VoiceOfMLReaderNavigation.createNavigation("/search/static/reader.html", options),
  buildParams: () => buildSearchURLParams({ includeQuery: false, displaySizes: true }),
  readQuery: () => DOM.searchInput ? DOM.searchInput.value : STATE.query,
  currentParams: () => currentReaderSearchParams(),
  getViewKey: () => getSearchViewKey(), captureScroll: () => captureReaderReturnScroll(),
  restoreScroll: () => restoreReaderReturnScroll(), saveSnapshot: key => saveSearchViewSnapshot(key),
  snapshotChanged: (snapshot, key) => {
    const source = resultSnapshots.source(snapshot), current = displayedSearchView;
    return key === getSearchViewKey() && !!source && !!current && current.key === key &&
      current.revision === source.revision && resultSnapshots.snapshots.get(key) === snapshot &&
      (STATE.results.length !== snapshot.results.length || STATE._loadedPage !== snapshot.loadedPage);
  },
  restoreSnapshot: key => restoreSearchViewSnapshot(key, false),
  routeChanged: () => location.hash !== appliedRouteHash,
  applyRoute: preserve => ROUTER.apply(preserve),
  closeMobileSidebars: () => {
    if (STATE.isMobile && (STATE.leftSidebarOpen || STATE.rightSidebarOpen)) {
      STATE.leftSidebarOpen = false;
      STATE.rightSidebarOpen = false;
      updateSidebarVisibility();
      syncStateToURL();
    }
  },
  applyTheme: theme => { STATE.isDark = theme === "dark"; applyTheme(); writeSearchPreference("theme", theme); },
  navigate: url => navigateToReader(url), handleMessage: event => handleReaderMessage(event),
  syncFolder: url => syncReaderFolderFilter(url), normalizeReturn: url => normalizeReaderReturnUrl(url),
  openOverlay: (url, addHistory) => openReaderOverlay(url, addHistory),
  closeOverlay: (focus, scroll) => closeReaderOverlay(focus, scroll), reconcile: () => reconcileSearchDestination()
});
const readerNavigation = readerHost.navigation;
const READER_RETURN_SEARCH_KEYS = readerHost.keys;
// Read-only compatibility projections for existing browser diagnostics.
Object.defineProperties(window, {
  readerOverlay: { get: () => readerHost.overlay },
  readerClosing: { get: () => readerHost.closing },
  readerUiState: { get: () => readerHost.uiState },
  readerReturnSnapshot: { get: () => readerHost.returnSnapshot }
});
function syncReaderFolderFilter(rawUrl) {
  return readerHost.syncReaderFolderFilter(rawUrl);
}
function currentReaderSearchParams() {
  return readerHost.currentReaderSearchParams();
}
function normalizeReaderReturnUrl(rawUrl) {
  return readerHost.normalizeReaderReturnUrl(rawUrl);
}
function captureReaderReturnScroll() {
  return readerReturnPosition.capture();
}
function readerSearchHandoffReady(saved) {
  return readerReturnPosition.ready(saved);
}
function restoreReaderSearchHandoff() {
  readerReturnPosition.restoreHandoff(readerNavigation);
}
function restoreReaderReturnScroll(windowRendered = false, restoreTop = false) {
  readerReturnPosition.restore(windowRendered, restoreTop);
}
function closeReaderOverlay(restoreFocus = true, restoreScroll = true) {
  return readerHost.closeReaderOverlay(restoreFocus, restoreScroll);
}
function openReaderOverlay(url, addHistory = true) {
  readerHost.openReaderOverlay(url, addHistory);
}
function reconcileSearchDestination() {
  readerHost.reconcileSearchDestination();
}
function restoreReaderOverlay(state) {
  readerHost.restoreReaderOverlay(state);
}
function handleReaderMessage(event) {
  readerHost.handleReaderMessage(event);
}
function navigateToReader(rawUrl, returnUrl) {
  return readerHost.navigateToReader(rawUrl, returnUrl);
}
function restoreReaderFromSession() {
  readerHost.restoreReaderFromSession();
}

var warmedReaderAssets = new Set();
var warmedReaderSources = new Set();
var readerWarmupInFlight = 0;
let readerWarmupPending = null;
const readerWarmupRetryAt = new Map();
function cancelReaderWarmup() {
  if (readerWarmupPending) readerWarmupPending.cancel();
}
function startReaderSourceWarmup(base, readerId, sourceUrl, urgent = false) {
  const key = readerId ? "id:" + readerId : sourceUrl;
  if (!key) return;
  // A pointer press or keyboard focus on a different book supersedes the
  // single speculative slot. Hover-only transitions keep the existing bound.
  if (readerWarmupPending) {
    if (!urgent || readerWarmupPending.key === key) return;
    readerWarmupPending.cancel(true);
    // Aborting can synchronously notify listeners. Never displace a newer task
    // that such a listener may have started or leave its timeout unowned.
    if (readerWarmupPending) return;
  }
  if (warmedReaderSources.size >= 8 || warmedReaderSources.has(key) ||
      Date.now() < (readerWarmupRetryAt.get(key) || 0)) return;
  const controller = new AbortController();
  const task = { key, cancel(superseded = false) { finish(false, superseded); } };
  const finish = (success, superseded = false) => {
    if (readerWarmupPending !== task) return;
    clearTimeout(timer);
    readerWarmupPending = null;
    readerWarmupInFlight = 0;
    if (success) {
      warmedReaderSources.add(key);
      readerWarmupRetryAt.delete(key);
    } else {
      controller.abort();
      if (!superseded) {
        readerWarmupRetryAt.delete(key);
        readerWarmupRetryAt.set(key, Date.now() + 5000);
        if (readerWarmupRetryAt.size > 64) readerWarmupRetryAt.delete(readerWarmupRetryAt.keys().next().value);
      }
    }
  };
  readerWarmupPending = task;
  readerWarmupInFlight = 1;
  const timer = setTimeout(() => task.cancel(), 8000);
  (async () => {
    try {
      const url = base + (readerId ? "/api/reader-resolve?id=" + encodeURIComponent(readerId)
        : "/api/reader-content?url=" + encodeURIComponent(sourceUrl));
      const response = await fetch(url, { method: readerId ? "GET" : "HEAD", cache: "no-store",
        mode: "cors", signal: controller.signal });
      if (!response.ok) throw new Error("Reader warmup HTTP " + response.status);
      const data = readerId ? await response.json() : null;
      if (readerId && (!data || typeof data.url !== "string" || !data.url)) throw new Error("Invalid reader metadata");
      if (readerWarmupPending !== task || controller.signal.aborted) return;
      if (readerId) cacheReaderMetadata(readerId, data);
      finish(true);
    } catch (_) { finish(false); }
  })();
}
function warmReaderIntent(rawUrl, urgent = false) {
  if (!rawUrl || document.hidden || !navigator.onLine) return;
  var extension = "", sourceUrl = "", readerId = "";
  try {
    var readerUrl = new URL(rawUrl, location.origin);
    extension = (readerUrl.searchParams.get("ext") || "").toLowerCase();
    sourceUrl = readerUrl.searchParams.get("url") || "";
    readerId = readerUrl.searchParams.get("id") || "";
  } catch (_) { return; }
  var shellAssets = VoiceOfMLReaderResources.shellAssets("/search/static/");
  var engineAssets = VoiceOfMLReaderResources.engineAssets(extension, "/search/static/", "?reader-v1");
  var controlled = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  var preload = function(href) {
    var link = document.createElement("link");
    // Foliate files are all ES modules; a classic preload would not be reused.
    var module = href.endsWith(".mjs") || href.includes("/foliate-reader/") || (href.endsWith(".js") && !engineAssets.includes(href));
    link.rel = module ? "modulepreload" : "preload";
    if (!module) link.as = href.endsWith(".css") ? "style" : "script";
    link.fetchPriority = "low";
    link.href = href;
    link.addEventListener("error", () => { warmedReaderAssets.delete(href); link.remove(); }, { once: true });
    document.head.appendChild(link);
  };
  shellAssets.concat(engineAssets).forEach(function(href) {
    if (warmedReaderAssets.has(href)) return;
    warmedReaderAssets.add(href);
    var shellFile = href.endsWith("/reader.html");
    // Under SW control, store shell files in its cache first. A repeated link
    // preload is deduplicated after a pre-control warm, leaving classic shell
    // scripts uncached and on the Reader's critical path. The link then reads
    // the cached copy without a second download.
    if (shellFile || (controlled && !engineAssets.includes(href))) {
      fetch(href, { priority: "low", signal: AbortSignal.timeout(8000) })
        .then(response => {
          if (!response.ok) throw new Error("Reader shell HTTP " + response.status);
          return response.arrayBuffer();
        }).then(() => { if (!shellFile) preload(href); })
        .catch(() => warmedReaderAssets.delete(href));
      return;
    }
    preload(href);
  });
  startReaderSourceWarmup(API_BASE, readerId, sourceUrl, urgent);
  warmConnection();
}

function setupReaderIntentWarming() {
  window.addEventListener("pagehide", cancelReaderWarmup);
  window.addEventListener("offline", cancelReaderWarmup);
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelReaderWarmup(); });
  var warm = function(event) {
    if (event.target.closest('[data-action="download"], [data-download]')) return;
    var target = event.target.closest("[data-reader-url], [data-read-url]");
    if (target) warmReaderIntent(target.dataset.readerUrl || target.dataset.readUrl,
      event.type === "pointerdown" || event.type === "focusin");
  };
  ["pointerover", "pointerdown", "focusin"].forEach(function(type) { document.addEventListener(type, warm, { passive: true }); });
  var warmShell = () => warmReaderIntent("/search/static/reader.html");
  navigator.serviceWorker?.addEventListener("controllerchange", () => {
    for (const href of VoiceOfMLReaderResources.shellAssets("/search/static/")) warmedReaderAssets.delete(href);
    warmShell();
  });
  setTimeout(warmShell, 1500);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) warmShell(); });
}

function isReadableRecord(rec) {
  if (String(rec && (rec.ReaderExtension || rec.Extension) || "").toLowerCase() === "docx" && !rec.ReaderLink) return false;
  return VoiceOfMLReader.capability(rec && (rec.ReaderExtension || rec.Extension)).article;
}

function isDefaultReadableRecord(rec) {
  return VoiceOfMLReader.capability(rec && rec.Extension).article;
}

function getRecordPath(rec) {
  return rec.Path || buildRecordPath(rec);
}

function buildDownloadUrl(filename, link) {
  return API_BASE + "/api/download?file=" + encodeURIComponent(filename || "file") + "&link=" + encodeURIComponent(link || "");
}

function triggerDownload(url) {
  const iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), 60000);
}

const downloadBatches = VoiceOfMLDownloadBatch.create({
  downloadFileDetailed: (filename, link, options) => downloadFileDetailed(filename, link, options),
  showToast,
  render: (batch, uncertain, actions, reset) => VoiceOfMLDownloadQueue.render(batch, uncertain, actions, reset),
});

const downloadController = VoiceOfMLDownloadController.createDownloadController({
  buildCheckUrl: link => API_BASE + "/api/download/check?link=" + encodeURIComponent(link || ""),
  buildDownloadUrl,
  triggerDownload: url => triggerDownload(url),
  onUncertain: downloadBatches.onUncertain,
  showToast,
  isSpeculativeAllowed: () => !document.hidden && navigator.onLine,
  isBatchActive: downloadBatches.isActive,
  timeout: DOWNLOAD_CHECK_TIMEOUT,
});
const {
  downloadChecks,
  downloadCheckQueue,
  pendingDownloads,
  checkDownload,
  runDownloadCheck,
  pumpDownloadChecks,
  scheduleDownloadLaunch,
  downloadFile,
  downloadFileDetailed,
} = downloadController;
Object.defineProperty(globalThis, "activeDownloadChecks", {
  configurable: true,
  get: () => downloadController.activeDownloadChecks,
});

function renderDownloadBatch() { downloadBatches.render(); }

function getSelectedFiles() {
  const files = Object.keys(selectedIndices).map(Number).flatMap(index => {
    if (resultSnapshots.cloneTask) materializeSnapshotRange(resultSnapshots.cloneTask, index, index + 1, true);
    const record = STATE.results[index];
    if (!record) return [];
    return [{ filename: record.File + (record.Extension ? "." + record.Extension : ""), link: getRecordLink(record) }];
  });
  if (resultSnapshots.cloneTask) applySnapshotCloneHeights(resultSnapshots.cloneTask);
  return files;
}

function startDownloadBatch(items, retry = false) { downloadBatches.start(items, retry); }

function setupDownloadIntentWarming() {
  const warm = event => {
    if (document.hidden) return;
    const target = event.target.closest('[data-action="download"], [data-download]');
    if (!target) return;
    const owner = target.closest('[data-link]');
    if (owner && owner.dataset.link) checkDownload(owner.dataset.link, true);
  };
  ["pointerover", "pointerdown", "focusin"].forEach(type => document.addEventListener(type, warm, { passive: true }));
}

function getBrowserFileName(file) {
  var name = file && file.name ? String(file.name) : "file";
  var ext = file && file.ext ? String(file.ext) : "";
  if (!ext) return name;
  // Directory entries carry File and Extension separately. File may itself
  // end in the same suffix (e.g. "poster.jpg" + "jpg" => "poster.jpg.jpg").
  return name + "." + ext;
}

function getBrowserFileLink(repo, folderPath, file) {
  if (file && file.link) return file.link;
  if (!repo) return "";
  var fullName = getBrowserFileName(file);
  var relativePath = folderPath ? folderPath + "/" + fullName : fullName;
  return HF_DATASET_BASE + "/" + repo + "/resolve/main/" + relativePath.split("/").map(encodeURIComponent).join("/");
}

function openExternalWindow(url) {
  const popup = window.open(url, "_blank", "noopener,noreferrer");
  if (popup) popup.opener = null;
  return popup;
}

var EXT_FILTER_STORAGE_KEY = "voml_ext_filter:global";
const searchHistoryStore = VoiceOfMLSearchHistoryStore.create(() => sessionStorage);
let searchHistory;
function getSearchHistoryController() {
  return searchHistory || (searchHistory = VoiceOfMLSearchHistory.create({
    elements: () => ({ searchInput: DOM.searchInput, searchBox: DOM.searchBox,
      historyDropdown: DOM.historyDropdown, resultsContainer: DOM.resultsContainer }),
    store: searchHistoryStore, escapeHTML,
    recordHistory: () => STATE.recordHistory,
    isComposing: () => searchComposing,
    submitSearchQuery: (query, options) => submitSearchQuery(query, options)
  }));
}
function getHistory() { return searchHistoryStore.get(); }
function saveHistory(list) { searchHistoryStore.save(list); }

function mergeFolderFilters(selfs, subtrees) {
  const selfSet = new Set(selfs || []);
  return (selfs || []).concat((subtrees || []).filter(function(path) {
    return !selfSet.has(path);
  }));
}

function loadStoredExtensionFilters() {
  try {
    var data = JSON.parse(sessionStorage.getItem(EXT_FILTER_STORAGE_KEY) || "{}");
    return Array.isArray(data.values) ? data.values.filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}

function saveStoredExtensionFilters() {
  var values = (STATE.filterExtensions || []).filter(Boolean);
  try {
    if (!values.length) {
      sessionStorage.removeItem(EXT_FILTER_STORAGE_KEY);
    } else {
      sessionStorage.setItem(EXT_FILTER_STORAGE_KEY, JSON.stringify({ values: values }));
    }
  } catch (e) {}
}

function addHistoryItem(q) { getSearchHistoryController().addHistoryItem(q); }
function renderDropdown() { getSearchHistoryController().renderDropdown(); }
function hideSearchHistory(restoreFocus = false) { getSearchHistoryController().hideSearchHistory(restoreFocus); }
function setupSearchHistory() { getSearchHistoryController().setupSearchHistory(); }
function removeHistoryItem(q) { getSearchHistoryController().removeHistoryItem(q); }

function updateSelectionUI() {
  if (!DOM.multiSelectToggle || !DOM.multiActionBar) return;
  var count = Object.keys(selectedIndices).length;
  DOM.multiSelectedCount.textContent = count > 0 ? (STATE.isMobile ? "" : ("已选" + count + "项")) : "";
  if (DOM.mobileSelectedCount) {
    DOM.mobileSelectedCount.textContent = count > 0 ? ("已选" + count) : "";
    DOM.mobileSelectedCount.style.display = (STATE.isMobile && DOM.multiSelectToggle.checked && count > 0) ? "inline-block" : "none";
  }
  DOM.multiActionBar.style.display = DOM.multiSelectToggle.checked ? "" : "none";
  if (DOM.multiCopyLinks) DOM.multiCopyLinks.textContent = "复制链接";
  if (DOM.multiDeselect) DOM.multiDeselect.textContent = "取消选择";
  if (DOM.multiSelectToggle.checked) {
    document.body.classList.add("multiselect");
  } else {
    document.body.classList.remove("multiselect");
    selectedIndices = {};
    lastSelectedIndex = -1;
  }
  updateVisibleSelection();
}

function updateVisibleSelection() {
  var cbs = DOM.resultsList.querySelectorAll(".result-checkbox");
  for (var ci = 0; ci < cbs.length; ci++) {
    var idx = parseInt(cbs[ci].dataset.index);
    cbs[ci].checked = !!selectedIndices[idx];
    var item = cbs[ci].closest(".result-item");
    if (item) item.classList.toggle("selected", !!selectedIndices[idx]);
  }
}

async function loadData() {
  const intent = searchIntentId, key = getSearchViewKey();
  try {
    const metadata = await corpusWorkerRequest("load-corpus", { url: new URL(DATA_URL, document.baseURI).href }, WORKER_LOAD_TIMEOUT);
    repoList = Array.isArray(metadata.repos) ? metadata.repos : [];
    extensionCounts = {};
    for (const item of metadata.extensions || []) extensionCounts[item.name] = item.count || 0;
    repoExtensionCounts = metadata.extensionsByRepo || {};
    extensionList = (metadata.extensions || []).map(function(item) { return item.name; });
    readerMetadata = metadata.reader || { available: false, count: 0, byRepo: {} };
    return true;
  } catch (e) {
    console.error("Data load failed:", e);
    if (e && e.code === "PROTOCOL_MISMATCH" && intent === searchIntentId && key === getSearchViewKey()) showToast("本地搜索版本不匹配，请刷新页面");
    return false;
  }
}

var corpusClient;
function getCorpusClient() {
  return corpusClient ||= VoiceOfMLCorpusClient.create({
    protocol: WORKER_PROTOCOL_VERSION,
    requestTimeout: WORKER_REQUEST_TIMEOUT,
    loadTimeout: WORKER_LOAD_TIMEOUT,
    createWorker: () => window.Worker ? new Worker("static/search/index-worker.js") : null,
    corpusURL: () => new URL(DATA_URL, document.baseURI).href,
  });
}

function corpusWorkerRequest(type, payload, timeoutMs, signal) {
  return getCorpusClient().request(type, payload, timeoutMs, signal);
}

function toMirrorURL(url) {
  if (!url) return url;
  try {
    var parsed = new URL(url, window.location.origin);
    if (parsed.hostname === "huggingface.co") parsed.hostname = MIRROR_HOST;
    return parsed.toString();
  } catch (e) {
    return url;
  }
}

function getCopyableLink(link) {
  return STATE.useMirrorLinks ? toMirrorURL(link) : link;
}

function getPreviewLink(path) {
  return STATE.useMirrorLinks ? toMirrorURL(path) : path;
}

async function doSearchLocal(params) {
  const workerParams = Object.assign({}, params);
  delete workerParams.signal;
  const data = await corpusWorkerRequest("local-search", workerParams, WORKER_REQUEST_TIMEOUT, params.signal);
  return cloneSearchData({
    results: data.records || [],
    total: data.total || 0,
    page: data.page,
    page_size: data.pageSize,
    generation: data.snapshot_generation,
    anchor_index: data.anchor_index,
  });
}

function isValidSearchResponse(data, expectedPage, expectedPageSize) {
  return VoiceOfMLSearchValidation.isValidSearchResponse(data, expectedPage, expectedPageSize);
}

var searchTransport;
function getSearchTransport() {
  return searchTransport ||= VoiceOfMLSearchTransport.create({
    fetch: (url, options) => fetch(url, options),
    validate: (data, page, size) => isValidSearchResponse(data, page, size),
  });
}

function createSearchPageRequest(cacheKey, url, body, timeoutMs) {
  return getSearchTransport().createRequest(cacheKey, url, body, timeoutMs);
}

function fetchSearchPage(cacheKey, url, body, signal, timeoutMs) {
  return getSearchTransport().fetchPage(cacheKey, url, body, signal, timeoutMs);
}

function expireSearchRequests() {
  getSearchTransport().expire();
  getCorpusClient().expireRequests();
}

function noteSearchApiFailure(error) {
  if (error.name === "AbortError" || error.apiFailureNoted) return;
  error.apiFailureNoted = true;
  noteApiFailure();
}

async function doSearchAPI(params, append, requestId) {
  if (requestId !== searchRequestId) return false;
  if (append && STATE._pageCache[params.page]) {
    applySearchPage({ page: params.page, results: STATE._pageCache[params.page], total: STATE.total }, true);
    return true;
  }
  const base = getSearchApiBase();
  const body = buildSearchApiBody(params);
  const cacheKey = base + "|" + stableSearchStringify(body);
  let data = getCachedSearchResponse(cacheKey);
  if (!data) {
    try {
      data = await fetchSearchPage(cacheKey, base, body, params.signal, append ? APPEND_REQUEST_TIMEOUT : 10000);
      if (requestId !== searchRequestId || (params.signal && params.signal.aborted)) return false;
      noteApiSuccess();
      setCachedSearchResponse(cacheKey, data, append);
    } catch (error) {
      if (requestId === searchRequestId && !(params.signal && params.signal.aborted)) noteSearchApiFailure(error);
      throw error;
    }
  }
  if (requestId !== searchRequestId) return false;
  return applySearchPage(data, append);
}

function appendSearchResults(page, results = STATE._pageCache[page]) {
  const metadata = searchPageMetadata.get(results?.[0]);
  if (!checkSearchPageAppend({ ...metadata, results, total: metadata?.total ?? STATE.total })) return false;
  if (!STATE._resultBackend) STATE._resultBackend = "api";
  for (const record of results) STATE.results.push(record);
  extendSearchSnapshotBudget(STATE.results, results);
  delete STATE._pageCache[page];
  STATE._loadedPage = page;
  STATE.hasMore = STATE.results.length < STATE.total;
  return true;
}

function deferSearchAppend() {
  if (!VSCROLL.isDraggingThumb) return false;
  STATE._deferredAppendWhileDragging = true;
  STATE._pendingPage = 0;
  STATE.isLoading = false;
  return true;
}

// Network, cached and Worker pages share the same state transition.
function checkSearchPageAppend(data) {
  const expected = searchPageMetadata.get(STATE.results[0]);
  const generation = data.generation ?? searchPageMetadata.get(data.results?.[0])?.generation;
  // Static initial pages may have no comparable generation. Reacquire the
  // anchor's window before appending; an unchanged total cannot prove identity.
  if (!expected?.unverifiedInitial && data.total === STATE.total && (!expected?.generation || generation === expected.generation)) return true;
  const key = getSearchViewKey(), scroll = captureReaderReturnScroll();
  const record = STATE.results[scroll.index] || STATE.results[0];
  const position = { version: 1, key, index: scroll.index, offset: scroll.offset,
    anchorId: getResultStableId(record), loadedPage: STATE._loadedPage, savedAt: Date.now() };
  const returnTarget = getReturnPositionTarget(key);
  // A prefetched initial continuation reaches this guard before the ordinary
  // append assigns its API backend; keep recovery on that same backend.
  const backend = STATE._resultBackend || "api";
  searchResponseCache.clear();
  resultSnapshots.remove(key);
  STATE._pageCache = {};
  tryRestoreSearchPosition(key, { position, viewport: null, backend });
  if (returnTarget) setReturnPositionTarget(returnTarget);
  return false;
}

function applySearchPage(data, append) {
  if (append && !checkSearchPageAppend(data)) return false;
  rememberSearchPageMetadata(data);
  STATE.total = data.total;
  if (append) {
    STATE._pageCache[data.page] = data.results;
    if (deferSearchAppend()) return false;
    appendSearchResults(data.page);
  } else {
    STATE.results = data.results;
    STATE._loadedPage = 1;
    STATE._pageCache = {};
    STATE.hasMore = STATE.results.length < STATE.total;
  }
  return true;
}

function consumeCachedAppendPage() {
  if (!STATE._pageCache[STATE.page]) return false;
  if (!appendSearchResults(STATE.page)) return false;
  STATE.page = STATE._loadedPage;
  STATE._pendingPage = 0;
  STATE.isLoading = false;
  refreshVirtualAfterAppend();
  updateStatusBar();
  updateLoadInfo();
  syncStateToURL();
  prefetchNextPage();
  finishPagingAttempt(true);
  return true;
}

function cancelSearchPrefetch() {
  const previous = searchPrefetchAbortController;
  searchPrefetchAbortController = null;
  cancelPendingSearchCacheWrites();
  previous?.cacheWaits?.forEach(wait => wait.controller.abort());
  previous?.abort();
}

function cancelActiveSearch() {
  const id = ++searchId;
  searchRequestId++;
  const previous = searchAbortController;
  searchAbortController = new AbortController();
  cancelSearchPrefetch();
  previous?.abort();
  return id === searchId;
}

var searchPagePrefetch;
function prefetchSearchPages(base, template) {
  const prefetch = searchPagePrefetch ||= VoiceOfMLSearchPrefetch.create({
    readView: () => ({ key: getSearchViewKey(), loadedPage: STATE._loadedPage,
      total: STATE.total, pageSize: STATE.pageSize,
      generation: searchPageMetadata.get(STATE.results[0])?.generation,
      inactive: document.hidden || !navigator.onLine }),
    getGroup: () => searchPrefetchAbortController,
    setGroup: controller => { searchPrefetchAbortController = controller; },
    hasPage: page => !!STATE._pageCache[page],
    stringify: body => stableSearchStringify(body),
    getCached: key => getCachedSearchResponse(key),
    evictCached: key => { searchResponseCache.delete(key); },
    readRecent: (...args) => readRecentSearchPage(...args),
    fetchPage: (key, url, body, signal) => fetchSearchPage(key, url, body, signal, APPEND_REQUEST_TIMEOUT),
    validate: (...args) => validatePositionWindowPage(...args),
    acceptPage: (page, data) => {
      noteApiSuccess();
      rememberSearchPageMetadata(data);
      if (page > STATE._loadedPage) STATE._pageCache[page] = data.results;
    },
    scheduleReady: page => scheduleBottomLoad(0, page),
    writeCached: (key, data) => setCachedSearchResponse(key, data, true),
    onFailure: error => {
      // Generation changes are healthy API responses; foreground demand still
      // chooses the backend, including a now-ready local Worker.
      if (error.message === "RESTORE_PAGE_CHANGED") noteApiSuccess();
      else noteSearchApiFailure(error);
    },
  });
  return prefetch.prefetch(base, template);
}

function prefetchNextPage() {
  if (resultWindow) {
    const page = Math.floor(findVirtualIndex(getResultScrollTop()) / STATE.pageSize) + 1;
    for (let next = page + 1; next <= page + 2 && resultWindow.pending.size < 2; next++) loadResultWindowPage(next, true);
    return;
  }
  if (!STATE._loadedPage) return Promise.resolve();
  if (STATE._resultBackend === "local") return prefetchLocalSearchPage();
  if (!apiAvailable) return Promise.resolve();
  if (STATE.useLocalMode && STATE.dataLoaded && STATE._resultBackend !== "api") return Promise.resolve();
  if (STATE.filterFolderSelfs.length > 0 || STATE.filterFolderSubtrees.length > 0) return Promise.resolve();
  return prefetchSearchPages(getSearchApiBase(), buildCurrentSearchBody(1));
}

function prefetchLocalSearchPage() {
  if (!STATE.hasMore || document.hidden || readerHost.overlay) return Promise.resolve();
  const key = getSearchViewKey(), groupKey = "local|" + key;
  let controller = searchPrefetchAbortController;
  if (!controller || controller.signal.aborted || controller.groupKey !== groupKey) {
    controller?.abort();
    controller = new AbortController();
    controller.groupKey = groupKey;
    controller.active = new Map();
    controller.attempted = new Set();
    searchPrefetchAbortController = controller;
  }
  const page = STATE._loadedPage + 1;
  if (controller.active.has(page)) return controller.active.get(page);
  if (STATE._pageCache[page] || controller.active.size || controller.attempted.has(page)) return Promise.resolve();
  controller.attempted.clear();
  controller.attempted.add(page);
  const current = () => searchPrefetchAbortController === controller && !controller.signal.aborted
    && STATE._resultBackend === "local" && key === getSearchViewKey();
  const task = (async () => {
    const data = await doSearchLocal({ ...buildLocalSearchParams(page), signal: controller.signal });
    if (!current()) throw new DOMException("Cancelled", "AbortError");
    const metadata = searchPageMetadata.get(STATE.results[0]);
    const expected = metadata?.generation ? { generation: metadata.generation, total: STATE.total,
      query: { pageSize: STATE.pageSize } } : null;
    validatePositionWindowPage(data, page, STATE.pageSize, null);
    if (expected && (data.generation !== expected.generation || data.total !== expected.total)) return data;
    rememberSearchPageMetadata(data);
    if (page > STATE._loadedPage) {
      STATE._pageCache[page] = data.results;
      scheduleBottomLoad(0, page);
    }
    return data;
  })();
  controller.active.set(page, task);
  const release = () => {
    controller.active.delete(page);
    if (current() && STATE._loadedPage >= page) prefetchLocalSearchPage();
  };
  task.then(release, release);
  return task;
}

let localDataLoadTimer = null;
let localDataIdleCallback = null;
function scheduleBackgroundLocalDataLoad() {
  clearTimeout(localDataLoadTimer);
  if (localDataIdleCallback !== null) window.cancelIdleCallback(localDataIdleCallback);
  localDataIdleCallback = null;
  if (STATE.dataLoaded) return;
  var connection = navigator.connection;
  var delay = connection && (connection.saveData || /^(slow-)?2g$/.test(connection.effectiveType || "")) ? 2500 : 100;
  localDataLoadTimer = setTimeout(function() {
    localDataLoadTimer = null;
    var start = function() {
      localDataIdleCallback = null;
      localDataLoadTimer = null;
      if (!STATE.dataLoaded) ensureLocalDataLoaded(false, true);
    };
    if (typeof window.requestIdleCallback === "function") {
      localDataIdleCallback = window.requestIdleCallback(start, { timeout: 2500 });
    } else {
      localDataLoadTimer = setTimeout(start, 1000);
    }
  }, delay);
}

let repoApiCache = null;
let repoApiPending = null;
const extensionApiCache = new Map();
const extensionApiPending = new Map();

async function fetchRepos() {
  if (repoApiCache) return repoApiCache;
  if (repoApiPending) return repoApiPending;
  if (!apiAvailable) return null;
  repoApiPending = fetchMetadataList(API_BASE + "/api/repos")
    .then(function(data) {
      noteApiSuccess();
      repoApiCache = data;
      return data;
    })
    .catch(function(error) {
      if (!error || error.name !== "AbortError") noteApiFailure();
      return null;
    })
    .finally(function() { repoApiPending = null; });
  return repoApiPending;
}

async function fetchExtensions(repo) {
  var key = repo || "__global__";
  // The renderer augments its result with selected-only types. Keep that
  // mutable array separate from the reusable API inventory.
  if (extensionApiCache.has(key)) return extensionApiCache.get(key).slice();
  if (extensionApiPending.has(key)) return extensionApiPending.get(key);
  if (!apiAvailable) return null;
  var url = repo ? API_BASE + "/api/extensions?repo=" + encodeURIComponent(repo) : API_BASE + "/api/extensions";
  var pending = fetchMetadataList(url)
    .then(function(data) { noteApiSuccess(); extensionApiCache.set(key, data.slice()); return data; })
    .catch(function(error) { if (!error || error.name !== "AbortError") noteApiFailure(); return null; })
    .finally(function() { extensionApiPending.delete(key); });
  extensionApiPending.set(key, pending);
  return pending;
}

async function fetchFolderTree(repo, cacheKey) {
  cacheKey = cacheKey || repo;
  if (cacheKey && folderTreeCache.has(cacheKey)) return folderTreeCache.get(cacheKey);
  if (!apiAvailable) return null;
  try {
    var data = await fetchMetadataList(API_BASE + "/api/folders/" + encodeURIComponent(repo));
    noteApiSuccess();
    if (cacheKey && data) folderTreeCache.set(cacheKey, data);
    return data;
  } catch (e) { if (!e || e.name !== "AbortError") noteApiFailure(); return null; }
}
const BROWSER_API_CACHE_MAX = 200;
const browserApiCache = new BoundedResponseCache(BROWSER_API_CACHE_MAX, 5 * 60 * 1000);
const browserApiPending = new Map();
const sidebarInitialCache = new Map();
const sidebarInitialPending = new Map();
let sidebarScroll;
function getSidebarScroll() {
  return sidebarScroll || (sidebarScroll = VoiceOfMLSidebarScroll.create({
    content: () => DOM.sidebarContent, storageKey: "vomebook-search-sidebar-scroll-v1"
  }));
}

async function fetchJsonWithTimeout(url, timeoutMs, requireOK = false) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      if (requireOK) throw new Error("HTTP " + resp.status);
      return null;
    }
    return await resp.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchMetadataList(url) {
  const data = await fetchJsonWithTimeout(url, 5000, true);
  if (!Array.isArray(data)) throw new Error("Invalid metadata response");
  return data;
}

async function fetchWithTimeout(url, timeoutMs) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function warmConnection(force) {
  if (force === undefined) force = false;
  if (document.hidden || !navigator.onLine || keepalivePending) return keepalivePending;
  var now = Date.now();
  if (!force && now - lastKeepaliveAt < KEEPALIVE_MIN_GAP_MS) return null;
  lastKeepaliveAt = now;
  if (!apiAvailable) return null;
  keepalivePending = fetchWithTimeout(API_BASE + "/api/ping", 12000).catch(function() { return null; }).finally(function() {
    keepalivePending = null;
  });
  return keepalivePending;
}

function normalizeSidebarPayload(data, path) {
  path = path || "";
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data.repos)) return data;
  return {
    repo: data.repo || "",
    path: data.path || path,
    folders: (data.folders || []).map(function(item) {
      var name = item.n || "";
      return {
        name: name,
        path: path ? path + "/" + name : name,
        count: item.c || 0,
      };
    }),
    files: (data.files || []).map(function(item) {
      return {
        name: item.n || "",
        ext: item.e || "",
        hasTxt: !!item.t,
        size: item.s === undefined ? "" : item.s,
        link: "",
      };
    }),
  };
}

function setBrowserApiCache(cacheKey, data) {
  browserApiCache.set(cacheKey, data);
}

async function fetchFolderContents(repo, path) {
  if (!apiAvailable) return null;
  var cacheKey = repo + "|" + (path || "");
  if (browserApiCache.has(cacheKey)) return browserApiCache.get(cacheKey);
  if (browserApiPending.has(cacheKey)) return browserApiPending.get(cacheKey);
  try {
    var qs = path ? "?path=" + encodeURIComponent(path) : "";
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 12000);
    var promise = fetch(API_BASE + "/api/folders/" + encodeURIComponent(repo) + "/contents" + qs, { signal: controller.signal })
      .then(function(resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function(data) {
        if (data) {
          noteApiSuccess();
          setBrowserApiCache(cacheKey, data);
        }
        return data;
      })
      .catch(function(error) {
        if (!error || error.name !== "AbortError") noteApiFailure();
        return null;
      })
      .finally(function() {
        clearTimeout(timeoutId);
        browserApiPending.delete(cacheKey);
      });
    browserApiPending.set(cacheKey, promise);
    return await promise;
  } catch (e) { return null; }
}

function sidebarInitialUrlForRepo(repo) {
  return repo ? "/search/data/sidebar/repos/" + encodeURIComponent(repo) + ".json" : "/search/data/sidebar/global.json";
}

async function loadSidebarInitial(repo) {
  var key = repo || "__global__";
  if (sidebarInitialCache.has(key)) return sidebarInitialCache.get(key);
  if (sidebarInitialPending.has(key)) return sidebarInitialPending.get(key);
  var pending = fetchJsonWithTimeout(sidebarInitialUrlForRepo(repo), 4000)
    .then(function(raw) {
      if (!raw) return null;
      var data = normalizeSidebarPayload(raw);
      sidebarInitialCache.set(key, data);
      return data;
    })
    .catch(function() { return null; })
    .finally(function() { sidebarInitialPending.delete(key); });
  sidebarInitialPending.set(key, pending);
  return pending;
}

function getCurrentExtensionCounts() {
  if (STATE.mode === "repo" && STATE.repoFull) {
    const counts = {};
    for (const item of repoExtensionCounts[STATE.repoFull] || []) counts[item.name] = item.count || 0;
    return counts;
  }
  return extensionCounts;
}

const folderContentsCache = new BoundedResponseCache(100, 5 * 60 * 1000);

async function getFolderContents(repo, path) {
  const cacheKey = repo + "|" + (path || "");
  if (folderContentsCache.has(cacheKey)) {
    const val = folderContentsCache.get(cacheKey);
    return val;
  }
  const result = await corpusWorkerRequest("folder-contents", { repo: repo, path: path || "" }, WORKER_REQUEST_TIMEOUT);
  folderContentsCache.set(cacheKey, result);
  return result;
}

const STATE = {
  mode: "global",
  repo: null,
  repoFull: null,
  query: "",
  sort: "relevance",
  page: 1,
  pageSize: 100,
  total: 0,
  results: [],
  filterRepos: [],
  filterExtensions: [],
  filterFolders: [],
  filterFolderSubtrees: [],
  filterFolderSelfs: [],
  filterMinSize: null,
  filterMaxSize: null,
  useMirrorLinks: true,
  leftSidebarOpen: true,
  rightSidebarOpen: false,
  isMobile: false,
  isDark: true,
  isLoading: false,
  hasMore: false,
  browserPath: "",
  extensionList: [],
  extensionOtherCollapsed: true,
  folderTree: null,
  folderTreeCollapsed: {},
  searchFolders: true,
  exact: true,
  useLocalMode: true,
  recordHistory: true,
  sessionRestored: false,
  dataLoaded: false,
  resultsSkeletonActive: false,
  _pendingPage: 0,
  _loadedPage: 0,
  _pageCache: {},
  _initialActive: false,
  _deferredAppendWhileDragging: false,
};

const {
  openSearchSessionDB,
  persistSearchSession,
  restoreSearchSession,
} = VoiceOfMLSearchSession.createSearchSession({
  canPersist: () => location.pathname === "/search/" && location.hash.indexOf("#/") === 0,
  canRestore: target => {
    if (initialSearchDraft) return false;
    if (!target) return location.pathname === "/search/" && !location.search && !location.hash;
    return target.origin === location.origin
      && target.pathname === "/search/"
      && target.hash.indexOf("#/") === 0;
  },
});

const VSCROLL = VoiceOfMLVirtualHeights.createState();
let pendingResultEntrance = false;

const $ = (sel) => document.querySelector(sel);

const DOM = {};

function cacheDOM() {
  document.querySelectorAll('#header svg, .empty-state svg, #footer svg').forEach(node => {
    node.setAttribute('aria-hidden', 'true'); node.setAttribute('focusable', 'false');
  });
  DOM.announcement = $("#search-announcement");
  DOM.headerTitle = $("#header-title");
  DOM.headerLogo = $("#header-logo");
  DOM.headerLogo.setAttribute('aria-label', '马列之声主页');
  DOM.searchBox = $("#search-box");
  DOM.searchInput = $("#search-input");
  DOM.hamburgerBtn = $("#hamburger-btn");
  DOM.settingsBtn = $("#settings-btn");
  DOM.themeBtn = $("#theme-btn");
  DOM.mobileToggleBtn = $("#mobile-toggle-btn");
  DOM.themeIconLight = $("#theme-icon-light");
  DOM.themeIconDark = $("#theme-icon-dark");
  DOM.mobileIconPhone = $("#mobile-icon-phone");
  DOM.mobileIconDesktop = $("#mobile-icon-desktop");
  DOM.leftSidebar = $("#left-sidebar");
  DOM.rightSidebar = $("#right-sidebar");
  DOM.sidebarContent = $("#sidebar-content");
  DOM.sidebarTitle = $("#sidebar-title");
  DOM.sidebarBackBtn = $("#sidebar-back-btn");
  DOM.sidebarExpandBtn = $("#sidebar-expand-btn");
  DOM.resultsList = $("#results-list");
  DOM.resultsContainer = $("#results-container");
  DOM.emptyState = $("#empty-state");
  DOM.emptyDesc = $("#empty-desc");
  DOM.emptyRandomBtn = $("#empty-random-btn");
  DOM.resultCount = $("#result-count");
  DOM.clearFiltersBtn = $("#clear-filters-btn");
  DOM.sortSelect = $("#sort-select");
  DOM.mirrorLinksToggle = $("#mirror-links-toggle");
  DOM.loadInfo = $("#load-info");
  DOM.mobileSelectedCount = $("#mobile-selected-count");
  DOM.loadedCount = $("#loaded-count");
  DOM.totalCount = $("#total-count");
  DOM.currentResultPosition = $("#current-result-position");
  DOM.scrollTrack = $("#scroll-track");
  DOM.scrollThumb = $("#scroll-thumb");
  DOM.hitokoto = $("#hitokoto");
  DOM.randomBookBtn = $("#random-book-btn");
  DOM.randomTxtBtn = $("#random-txt-btn");
  DOM.overlay = $("#overlay");
  DOM.toast = $("#toast");
  DOM.filterRepoSection = $("#filter-repo-section");
  DOM.filterRepoList = $("#filter-repo-list");
  DOM.repoFilterCancel = $("#repo-filter-cancel");
  DOM.filterFolderSection = $("#filter-folder-section");
  DOM.filterFolderTree = $("#filter-folder-tree");
  DOM.folderFilterCancel = $("#folder-filter-cancel");
  DOM.filterExtList = $("#filter-ext-list");
  DOM.extFilterCancel = $("#ext-filter-cancel");
  DOM.filterMinSize = $("#filter-min-size");
  DOM.filterMaxSize = $("#filter-max-size");
  DOM.filterMinUnit = $("#filter-min-unit");
  DOM.filterMaxUnit = $("#filter-max-unit");
  DOM.closeFiltersBtn = $("#close-filters-btn");
  DOM.folderSelectAll = $("#folder-select-all");
  DOM.folderDeselectAll = $("#folder-deselect-all");
  DOM.folderToggleAll = $("#folder-toggle-all");
  DOM.extSelectAll = $("#ext-select-all");
  DOM.extDeselectAll = $("#ext-deselect-all");
  DOM.searchFoldersToggle = $("#search-folders-toggle");
  DOM.exactSearchToggle = $("#exact-search-toggle");
  DOM.exactSearchSection = $("#exact-search-section");
  DOM.localModeToggle = $("#local-mode-toggle");
  DOM.historyToggle = $("#history-toggle");
  DOM.historyDropdown = $("#search-history-dropdown");
  DOM.returnToPositionBtn = $("#return-to-position-btn");
  DOM.backToTopBtn = $("#restart-position-btn");
  DOM.retryPositionBtn = $("#retry-position-btn");
  DOM.cancelPositionBtn = $("#cancel-position-btn");
  DOM.positionRestoreStatus = $("#search-position-status");
  DOM.multiToggleLabel = $("#multi-toggle-label");
  DOM.multiSelectToggle = $("#multi-select-toggle");
  DOM.multiActionBar = $("#multi-action-bar");
  DOM.multiCopyLinks = $("#multi-copy-links");
  DOM.multiBatchDownload = $("#multi-batch-download");
  DOM.multiSelectAll = $("#multi-select-all");
  DOM.multiSelectedCount = $("#multi-selected-count");
  DOM.multiDeselect = $("#multi-deselect");
}

function syncSearchInputState() {
  if (!DOM.searchInput) return;
  const hasQuery = !!DOM.searchInput.value.trim();
  DOM.searchInput.dataset.hasQuery = hasQuery ? "true" : "false";
  DOM.searchBox?.classList.toggle("has-query", hasQuery);
}

function setSearchInputValue(value) {
  if (!DOM.searchInput) return;
  DOM.searchInput.value = value || "";
  syncSearchInputState();
}

function getFileIconType(ext) {
  return FILE_ICON_MAP[(ext || "").toLowerCase()] || "file";
}

let routeInitialized = false;
// Keep track of the last hash reflected in STATE, including normal state-driven
// replaceState updates, so a pending hashchange is not mistaken for that state.
let appliedRouteHash = window.location.hash;

function updateSidebarExpandButton() {
  if (!DOM.sidebarExpandBtn || !DOM.leftSidebar) return;
  const expanded = DOM.leftSidebar.classList.contains("expanded-wide");
  const visible = !STATE.isMobile && (STATE.mode === "repo" || expanded);
  DOM.sidebarExpandBtn.style.display = visible ? "" : "none";
  DOM.sidebarExpandBtn.classList.toggle("expanded", expanded);
  DOM.sidebarExpandBtn.setAttribute("aria-label", expanded ? "收起侧边栏" : "展开侧边栏");
  DOM.sidebarExpandBtn.title = expanded ? "收起侧边栏" : "展开侧边栏";
}

function updateSidebarHeader() {
  if (!DOM.sidebarTitle) return;
  const global = STATE.mode === "global";
  DOM.sidebarTitle.textContent = global ? "仓库列表" : (STATE.repo || "仓库");
  if (DOM.sidebarBackBtn) {
    if (global && document.activeElement === DOM.sidebarBackBtn) DOM.hamburgerBtn.focus({ preventScroll: true });
    DOM.sidebarBackBtn.hidden = global;
  }
  updateSidebarExpandButton();
}

function navigateSidebarParent() {
  if (STATE.mode !== "repo") return ROUTER.navigate("global");
  const parts = String(STATE.browserPath || "").split("/").filter(Boolean);
  const parent = parts.slice(0, -1).join("/");
  ROUTER.navigate(parts.length ? "repo" : "global", STATE.repo, parent);
}

function returnFromSidebar() {
  navigateSidebarParent();
}

function closeLeftSidebar() { getShell().closeLeftSidebar(); }
function closeRightSidebar() { getShell().closeRightSidebar(); }

const ROUTER = {
  parse: () => VoiceOfMLRoute.parse(window.location.hash),
  navigate: (mode, repo, folder) => getRouteNavigation().navigate(mode, repo, folder),
  apply: function(preserveSameView = false) {
    appliedRouteHash = window.location.hash;
    const route = this.parse();
    const prevMode = STATE.mode;
    const prevRepo = STATE.repo;
    const previousPath = STATE.browserPath;
    const previousSearchKey = routeInitialized ? getSearchViewKey() : null;
    const wasSidebarExpanded = DOM.leftSidebar && DOM.leftSidebar.classList.contains("expanded-wide");
    saveSearchViewSnapshot();
    STATE.mode = route.mode;
    STATE.repo = route.repo;
    STATE.repoFull = route.repo ? "VoiceOfML/" + route.repo : null;
    if (prevMode !== STATE.mode || prevRepo !== STATE.repo) {
      STATE.page = 1;
      if (STATE.results.length === 0) STATE.total = 0;
      prepareRouteTransitionResults();
      STATE.browserPath = "";
      STATE.filterFolders = [];
      STATE.filterFolderSubtrees = [];
      STATE.filterFolderSelfs = [];
      STATE.folderTreeCollapsed = {};
      folderContentsCache.clear();
    }
    const projected = VoiceOfMLRoute.project(route.params, STATE.mode, routeInitialized);
    STATE.query = projected.query;
    if (projected.queryTruncated) showToast("搜索内容已限制为 256 个字符");
    if (!searchComposing && !initialSearchDraft) setSearchInputValue(STATE.query);
    STATE.filterRepos = projected.filterRepos;
    STATE.filterExtensions = projected.filterExtensions === null ? loadStoredExtensionFilters() : projected.filterExtensions;
    if (projected.filterExtensions !== null) saveStoredExtensionFilters();
    STATE.browserPath = projected.browserPath;
    STATE.filterFolderSelfs = projected.filterFolderSelfs;
    STATE.filterFolderSubtrees = projected.filterFolderSubtrees;
    STATE.filterFolders = STATE.filterFolderSelfs.length || STATE.filterFolderSubtrees.length
      ? mergeFolderFilters(STATE.filterFolderSelfs, STATE.filterFolderSubtrees) : [];
    STATE.sort = projected.sort;
    DOM.sortSelect.value = STATE.sort;
    var ms = route.params.min_size;
    if (ms) {
      var parsed = parseSizeStr(ms);
      STATE.filterMinSize = parsed;
      var disp = bytesToDisplay(parsed);
      DOM.filterMinSize.value = disp.value;
      DOM.filterMinUnit.value = disp.unit;
    } else {
      STATE.filterMinSize = null;
      DOM.filterMinSize.value = "";
      DOM.filterMinUnit.value = "MB";
    }
    var mx = route.params.max_size;
    if (mx) {
      var parsedMx = parseSizeStr(mx);
      STATE.filterMaxSize = parsedMx;
      var dispMx = bytesToDisplay(parsedMx);
      DOM.filterMaxSize.value = dispMx.value;
      DOM.filterMaxUnit.value = dispMx.unit;
    } else {
      STATE.filterMaxSize = null;
      DOM.filterMaxSize.value = "";
      DOM.filterMaxUnit.value = "MB";
    }
    STATE.searchFolders = projected.searchFolders;
    if (DOM.searchFoldersToggle) DOM.searchFoldersToggle.checked = STATE.searchFolders;
    STATE.exact = projected.exact;
    if (DOM.exactSearchToggle) DOM.exactSearchToggle.checked = STATE.exact;
    STATE.useLocalMode = projected.useLocalMode;
    if (DOM.localModeToggle) DOM.localModeToggle.checked = STATE.useLocalMode;
    // Exact mode is implemented by the Worker as well, so the switch is always
    // relevant. Hiding it made a keyboard-reachable control change semantics.
    setExactSearchSectionVisible(true, false);
    STATE.recordHistory = projected.recordHistory;
    if (DOM.historyToggle) DOM.historyToggle.checked = STATE.recordHistory;
    STATE.useMirrorLinks = projected.useMirrorLinks;
    if (DOM.mirrorLinksToggle) DOM.mirrorLinksToggle.checked = STATE.useMirrorLinks;
    const keepMobileSidebarOpen = STATE.isMobile && STATE.leftSidebarOpen
      && prevMode === "repo" && route.mode === "global" && route.params.sidebar === "0";
    STATE.leftSidebarOpen = keepMobileSidebarOpen || projected.leftSidebarOpen;
    STATE.rightSidebarOpen = projected.rightSidebarOpen;
    const sameSearchView = previousSearchKey === getSearchViewKey();
    if (!sameSearchView) {
      if (routeInitialized) searchInputController.invalidateVisit();
      cancelPendingSearchControls();
      readerReturnPosition.invalidate();
      if (!cancelActiveSearch()) return;
    }
    const owner = searchId;
    if (!sameSearchView || (!preserveSameView && previousPath === STATE.browserPath)) cancelPositionRestore();
    if (owner !== searchId) return;
    updateSidebarVisibility();
    const keepSidebarExpanded = projected.wide
      || (prevMode !== STATE.mode && wasSidebarExpanded);
    DOM.leftSidebar.classList.toggle("expanded-wide", keepSidebarExpanded);
    this.updateUI();
    updateRandomTxtVisibility();
    if (sameSearchView && (preserveSameView || (prevMode === "repo" && previousPath !== STATE.browserPath))) {
      const routeId = ++routeRenderId;
      if (STATE.mode === "repo" && previousPath !== STATE.browserPath) renderBrowser(STATE.browserPath || "", routeId);
      retainFilterRenderingForRoute(routeId);
      routeInitialized = true;
      persistSearchSession();
      return;
    }
    if (prevMode !== STATE.mode || prevRepo !== STATE.repo) {
      this.onModeChanged();
      if (wasSidebarExpanded && !route.params.wide) syncStateToURL();
    } else {
      const routeId = ++routeRenderId;
      searchWithInitialFallback();
      renderSidebarAndFiltersDeferred(routeId);
    }
    routeInitialized = true;
    persistSearchSession();
  },
  updateUI: function() {
    DOM.headerLogo.href = "/search/";
    if (STATE.mode === "global") {
      DOM.headerTitle.textContent = "VoiceOfML";
      DOM.searchInput.placeholder = "搜索 VoiceOfML 数据仓库...";
      DOM.sidebarTitle.textContent = "仓库列表";
    } else {
      DOM.headerTitle.textContent = STATE.repo;
      DOM.searchInput.placeholder = "搜索 " + STATE.repo + "...";
    }
    updateSidebarHeader();
  },
  onModeChanged: function() {
    updateSidebarHeader();
    if (!STATE.isMobile && STATE.results.length === 0 && STATE.filterExtensions.length === 0) {
      DOM.resultsList.innerHTML = "";
      DOM.emptyState.style.display = "none";
      STATE.resultsSkeletonActive = true;
      renderResultsSkeleton();
    }
    const routeId = ++routeRenderId;
    searchWithInitialFallback();
    renderSidebarAndFiltersDeferred(routeId);
  },
};

/** @param {unknown} value */
function normalizeSearchSort(value) {
  return value === "name" || value === "size" ? value : "relevance";
}

function buildSearchURLParams(options = {}) {
  return VoiceOfMLRoute.buildParams(readRouteState(), fmtSizeUrl, options);
}

// Only URL-facing state crosses the routing boundary; result/scroll ownership stays here.
function readRouteState() {
  return {
    mode: STATE.mode, repo: STATE.repo, browserPath: STATE.browserPath,
    query: STATE.query, sort: STATE.sort,
    filterRepos: STATE.filterRepos.slice(), filterExtensions: STATE.filterExtensions.slice(),
    filterFolderSelfs: STATE.filterFolderSelfs.slice(), filterFolderSubtrees: STATE.filterFolderSubtrees.slice(),
    filterMinSize: STATE.filterMinSize, filterMaxSize: STATE.filterMaxSize,
    searchFolders: STATE.searchFolders, exact: STATE.exact, useLocalMode: STATE.useLocalMode,
    recordHistory: STATE.recordHistory, useMirrorLinks: STATE.useMirrorLinks,
    leftSidebarOpen: STATE.leftSidebarOpen, rightSidebarOpen: STATE.rightSidebarOpen,
    wide: DOM.leftSidebar.classList.contains("expanded-wide"),
  };
}
let routeNavigation;
function getRouteNavigation() {
  return routeNavigation || (routeNavigation = VoiceOfMLRouter.create({
    readState: readRouteState, buildParams: options => buildSearchURLParams(options),
    readerOpen: () => !!readerHost.overlay,
    currentURL: () => window.location.hash,
    setHash: url => { window.location.hash = url; },
    clearBrowserPath: () => { STATE.browserPath = ""; },
    replaceURL: url => history.replaceState(history.state, "", url),
    commitAppliedURL: url => { appliedRouteHash = url; },
    persistSession: () => persistSearchSession(),
  }));
}
function syncStateToURL() { getRouteNavigation().sync(); }

function renderSidebarAndFiltersDeferred(routeId) {
  if (!routeId || routeId === routeRenderId) renderSidebar(routeId);
  requestAnimationFrame(function() {
    if (routeId && routeId !== routeRenderId) return;
    renderFilters(routeId);
  });
}
// Readable host compatibility bridge; only the input controller writes these.
let searchTimer = null;
let searchComposing = false;
let searchInputReady = false;
let initialSearchDraft = false;
/** @type {VoiceOfMLInputController} */
let searchInputController;
let searchId = 0;
// Distinguish repeated searches/restorations of the same view, independently of paging.
let searchIntentId = 0;
let searchAbortController = null;
let searchPrefetchAbortController = null;
let searchRequestId = 0;
let filterSearchTimer = null;
let sizeFilterTimer = null;
const FILTER_SEARCH_DEBOUNCE_MS = 200;
let routeRenderId = 0;
// A path-only route change bumps routeRenderId for the browser, but must not
// orphan an unfinished filter render or its batched folder-tree tasks.
let apiAvailable = true;
let apiFailureCount = 0;
let apiProbeTimer = null;
let apiProbeInFlight = false;
const API_FAILURE_THRESHOLD = 3;
const API_RECOVERY_DELAY = 30000;
let localDataPromise = null;
const SEARCH_CACHE_TTL = 8 * 60 * 1000;
const SEARCH_CACHE_MAX = 60;
/** @type {BoundedResponseCache<{time: number, data: ReturnType<typeof cloneSearchData>}>} */
const searchResponseCache = new BoundedResponseCache(SEARCH_CACHE_MAX, SEARCH_CACHE_TTL);
const INITIAL_BASE_URL = "data/initial";
const initialPayloadCache = new Map();


function noteApiSuccess() {
  apiFailureCount = 0;
  apiAvailable = true;
  if (apiProbeTimer) {
    clearTimeout(apiProbeTimer);
    apiProbeTimer = null;
  }
}

function scheduleApiProbe() {
  if (apiProbeTimer || apiProbeInFlight) return;
  apiProbeTimer = setTimeout(async function() {
    apiProbeTimer = null;
    apiProbeInFlight = true;
    let recovered = false;
    try {
      const response = await fetchWithTimeout(API_BASE + "/api/repos", 4000);
      if (!response.ok) throw new Error("HTTP " + response.status);
      noteApiSuccess();
      recovered = true;
    } catch (e) {
      apiAvailable = false;
    } finally {
      apiProbeInFlight = false;
      if (!recovered) scheduleApiProbe();
    }
  }, API_RECOVERY_DELAY);
}

function noteApiFailure() {
  apiFailureCount++;
  if (apiFailureCount >= API_FAILURE_THRESHOLD) {
    apiAvailable = false;
    scheduleApiProbe();
  }
}

async function updateRandomTxtVisibility() {
  return getRandomDiscovery().updateRandomTxtVisibility();
}

function stableSearchStringify(value) {
  return VoiceOfMLSearchCanonical.stableStringify(value, () => stableSearchStringify);
}

const SEARCH_VIEW_SNAPSHOT_VERSION = VoiceOfMLSnapshotPolicy.VERSION;
const SEARCH_VIEW_SNAPSHOT_BYTES_MAX = VoiceOfMLSnapshotPolicy.BYTES_MAX;
const resultSnapshots = VoiceOfMLResultSnapshots.create({
  cloneResult: record => cloneSearchResult(record),
  materialized: (task, index) => materializedSnapshotRow(task, index),
  applyHeights: task => applySnapshotCloneHeights(task),
  isCurrent: task => STATE.results === task.results && getSearchViewKey() === task.key,
  completed: () => {
    displayedSearchView = null; rememberDisplayedSearchView();
    scheduleVirtualRender(); prefetchNextPage(); scheduleBottomLoad();
  }
});
const positionStorage = VoiceOfMLPositionStorage.create();
const positionPersistence = VoiceOfMLSearchPositions.create({
  storage: positionStorage, cloneResult: record => cloneSearchResult(record),
  metadata: record => searchPageMetadata.get(/** @type {object} */ (record))
});
let displayedSearchView = null;
let positionRestore = null;
let resultWindow = null;
let returnPositionTarget = null;
let positionControlScroll = null;
let positionEntryId = 0;

function getReturnPositionTarget(key = getSearchViewKey()) {
  return returnPositionTarget?.key === key ? returnPositionTarget : null;
}

function setReturnPositionTarget(position = null) {
  // Pin a copy so ordinary position saves cannot move the offered destination.
  returnPositionTarget = position ? { ...position } : null;
}

function resetPositionControlScroll() {
  positionControlScroll = { key: getSearchViewKey(), last: getResultScrollTop(), distance: 0, until: 0 };
}

function prepareReturnPosition(key, updateControls = true) {
  resetPositionControlScroll();
  const saved = positionPersistence.getPosition(key);
  setReturnPositionTarget(validSearchPosition(saved) && (saved.index > 0 || saved.offset > 0) ? saved : null);
  if (updateControls) updateSearchPositionControls();
}

function updateSearchPositionControls() {
  if (!getReturnPositionTarget()) setReturnPositionTarget();
  if (DOM.returnToPositionBtn) DOM.returnToPositionBtn.hidden = !returnPositionTarget || !!positionRestore;
  if (DOM.backToTopBtn) DOM.backToTopBtn.hidden = !STATE.results.length || getResultScrollTop() <= 0;
  if (DOM.positionRestoreStatus) DOM.positionRestoreStatus.hidden = !positionRestore;
  if (DOM.cancelPositionBtn) DOM.cancelPositionBtn.hidden = true;
}

function cancelPendingSearchControls() {
  searchInputController.cancelTimer();
  clearTimeout(filterSearchTimer);
  clearTimeout(sizeFilterTimer);
  filterSearchTimer = null;
  sizeFilterTimer = null;
}

function prepareSearchPositionNavigation({ fromStart, restorePosition }) {
  cancelPendingSearchControls();
  // The URL is the handoff contract for Reader navigation and session restore.
  // Publish the current controls before any async result work starts.
  syncStateToURL();
  // A deliberate trip to the top captures the currently displayed position.
  // During restoration (or when already at the top), retain the existing target.
  if (fromStart && !positionRestore && getResultScrollTop() > 0) setReturnPositionTarget();
  saveSearchViewSnapshot();
  const key = getSearchViewKey();
  if (fromStart) saveSearchPosition();
  const owner = searchId;
  cancelPositionRestore();
  if (owner !== searchId) return true;
  prepareReturnPosition(key, !fromStart);
  if (!restorePosition) return false;
  setReturnPositionTarget();
  return restoreSearchViewSnapshot(key);
}

function returnToSavedPosition() {
  const position = getReturnPositionTarget();
  if (position) return tryRestoreSearchPosition(position.key, { position });
  return false;
}

function backToSearchTop() {
  return doSearch(false, true);
}

function notePositionScrollIntent(event) {
  if (event.type === "keydown" && (event.isComposing || event.defaultPrevented ||
      !["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key) ||
      event.target.closest("input, textarea, select, button, a, [contenteditable]"))) return;
  if (!positionControlScroll || positionControlScroll.key !== getSearchViewKey()) resetPositionControlScroll();
  positionControlScroll.until = Date.now() + 1500;
}

function updateReturnPositionOnScroll() {
  const progress = positionControlScroll;
  if (progress?.key !== getSearchViewKey()) return;
  const top = getResultScrollTop();
  if (Date.now() <= progress.until) progress.distance += Math.abs(top - progress.last);
  progress.last = top;
  if (!positionRestore && progress.distance > Math.max(1200, DOM.resultsContainer.clientHeight * 2)) {
    setReturnPositionTarget();
    updateSearchPositionControls();
  }
}

function jumpToSearchResult(value) {
  if (!/^\d+$/.test(value)) { updateCurrentResultPosition(); return; }
  const requested = Number(value);
  if (!Number.isSafeInteger(requested) || requested < 1 || !STATE.total) { updateCurrentResultPosition(); return; }
  const index = Math.min(STATE.total - 1, Math.floor(requested) - 1);
  const key = getSearchViewKey();
  setReturnPositionTarget();
  if (!positionRestore && !resultWindow?.invalid && STATE.results[index]) setResultScrollTop(getVirtualOffset(index));
  else tryRestoreSearchPosition(key, { viewport: null, position: {
    version: 1, key, index, offset: 0, anchorId: "",
    loadedPage: Math.floor(index / STATE.pageSize) + 1, savedAt: Date.now()
  }});
  updateCurrentResultPosition();
}

function setupSearchPositionControls() {
  // Also relocate the control when an existing client still has the older shell.
  const positionActions = DOM.returnToPositionBtn?.parentElement;
  if (positionActions && DOM.positionRestoreStatus) positionActions.append(DOM.positionRestoreStatus);
  for (const type of ["wheel", "touchstart", "touchmove", "pointerdown"]) {
    DOM.resultsContainer.addEventListener(type, notePositionScrollIntent, { passive: true });
    DOM.scrollTrack.addEventListener(type, notePositionScrollIntent, { passive: true });
  }
  document.addEventListener("keydown", notePositionScrollIntent);
  DOM.resultsContainer.addEventListener("scroll", updateReturnPositionOnScroll, { passive: true });
  DOM.returnToPositionBtn?.addEventListener("click", returnToSavedPosition);
  DOM.backToTopBtn.addEventListener("click", backToSearchTop);
  DOM.retryPositionBtn.addEventListener("click", () => tryRestoreSearchPosition(getSearchViewKey()));
  DOM.cancelPositionBtn?.addEventListener("click", backToSearchTop);

  let edit = null;
  const editButton = document.getElementById('edit-result-position');
  editButton.addEventListener('click', () => {
    DOM.currentResultPosition.hidden = false;
    editButton.hidden = true;
    DOM.currentResultPosition.focus({ preventScroll: true });
  });
  DOM.currentResultPosition?.addEventListener("focus", event => {
    edit = { key: getSearchViewKey(), value: event.target.value };
    event.target.select();
  });
  DOM.currentResultPosition?.addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") edit = null;
      event.target.blur();
      editButton.focus({ preventScroll: true });
    }
  });
  DOM.currentResultPosition?.addEventListener("blur", event => {
    const previous = edit;
    edit = null;
    event.target.hidden = true;
    editButton.hidden = false;
    if (previous && previous.key === getSearchViewKey() && previous.value !== event.target.value)
      jumpToSearchResult(event.target.value.trim());
    else updateCurrentResultPosition();
  });
}
let displayedViewRevision = 0;
let measuredHeightRevision = 0;
const resultRowRecords = new WeakMap();
const searchPageMetadata = new WeakMap();

function rememberSearchPageMetadata(data) {
  if (data?.results?.[0] && typeof data.generation === "string" && data.generation) searchPageMetadata.set(data.results[0], {
    generation: data.generation, total: data.total, page: data.page, page_size: data.page_size });
}

async function readRecentSearchPage(key, page, expected, timeoutMs = 150, signal = null) {
  return positionPersistence.readRecentPage(key, page, expected, timeoutMs, signal);
}

async function loadCachedPreviewPage(window, page) {
  if (!window.generation || window.pages.has(page) || window.pending.has(page) || window.pending.size >= 3 || window.missingPages?.has(page)) return;
  const request = readRecentSearchPage(window.key, page, window);
  window.pending.set(page, request);
  try {
    const entry = await request;
    if (!resultWindowCurrent(window) || !positionRestore?.preview || VSCROLL.isDraggingThumb) return;
    if (!entry) { (window.missingPages ||= new Set()).add(page); return; }
    const start = (page - 1) * window.query.pageSize;
    if (start + entry.results.length > STATE.results.length) return;
    resultSnapshots.budget.invalidate(STATE.results);
    entry.results.forEach((record, offset) => {
      const index = start + offset;
      if (STATE.results[index]) return;
      STATE.results[index] = record; window.count++; VSCROLL.templateCache.delete(index);
    });
    window.pages.add(page);
    (positionRestore.cachedPages ||= new Map()).set(page, entry);
    VSCROLL.measuredWindowKey = ""; VSCROLL.renderStart = -1; VSCROLL.renderEnd = -1;
    renderVisible(); updateLoadInfo();
  } finally {
    window.pending.delete(page);
    if (resultWindowCurrent(window)) scheduleVirtualRender();
  }
}

function saveSearchViewport(position, view) {
  positionPersistence.saveViewport(position, view, {
    visibleEnd: findVirtualIndex(getResultScrollTop() + DOM.resultsContainer.clientHeight),
    pageSize: STATE.pageSize, measurementKey: getHeightMeasurementKey(), estimatedHeight: VSCROLL.estimatedHeight,
    heightAt: index => VSCROLL.heights[index] || VSCROLL.estimatedHeight
  });
}

async function readSearchViewport(key) {
  return positionPersistence.readViewport(key);
}

function validSearchViewport(viewport, position) {
  return VoiceOfMLPositionPolicy.validViewport(viewport, position, getResultStableId);
}

function showSavedSearchViewport(viewport, position, task) {
  if (!validSearchViewport(viewport, position)) return;
  const size = JSON.parse(position.key).pageSize;
  const results = new Array(Math.min(viewport.total, position.loadedPage * size));
  for (const [index, record] of viewport.records) if (Number.isInteger(index) && index >= 0 && index < results.length) results[index] = record;
  const snapshot = { version: SEARCH_VIEW_SNAPSHOT_VERSION, key: position.key, results, total: viewport.total,
    page: position.loadedPage, loadedPage: position.loadedPage, pageCache: {}, hasMore: results.length < viewport.total,
    window: { preview: true, generation: viewport.generation, pages: [], count: Object.keys(results).length }, estimatedHeight: viewport.estimatedHeight,
    heightCache: viewport.records.map(([, record, height]) => /** @type {SearchSnapshotHeightEntry} */ ([getResultStableId(record), {height, measurementKey: viewport.measurementKey}])),
    scroll: {index: position.index, offset: position.offset, viewKey: position.key}, savedAt: Date.now() };
  task.preview = true;
  resultSnapshots.put(position.key, snapshot);
  restoreSearchViewSnapshot(position.key, true, true);
  resultSnapshots.remove(position.key);
  showPositionRestoreStatus("已恢复上次画面，正在核对结果…");
}

function validSearchPosition(value) {
  return VoiceOfMLPositionPolicy.validPosition(value);
}

async function initSearchPositions() {
  await positionPersistence.init();
}

function rememberDisplayedSearchView() {
  if (STATE._loadedPage < 1) return;
  const previous = displayedSearchView;
  const key = getSearchViewKey();
  const unchanged = previous && previous.key === key && previous.results === STATE.results
    && previous.length === STATE.results.length && previous.total === STATE.total
    && previous.loadedPage === STATE._loadedPage && previous.pageCache === STATE._pageCache && previous.window === resultWindow;
  displayedSearchView = { key: getSearchViewKey(), results: STATE.results,
    resultBackend: STATE._resultBackend,
    total: STATE.total, loadedPage: STATE._loadedPage, pageCache: STATE._pageCache,
    length: STATE.results.length, window: resultWindow, revision: unchanged ? previous.revision : ++displayedViewRevision };
  if (STATE.results.length <= STATE.pageSize && !resultSnapshots.budget.has(STATE.results)) {
    getSearchSnapshotResultsBytes(STATE.results, !!resultWindow);
  }
}

function saveSearchPosition() {
  positionPersistence.cancelSave();
  const view = displayedSearchView;
  const target = view && getReturnPositionTarget(view.key);
  if (target) return target;
  if (!view || positionRestore || readerHost.overlay || !view.results.length || !VSCROLL.heights.length) return null;
  if (STATE.results !== view.results || (STATE.isLoading && view.key !== getSearchViewKey())) return positionPersistence.getPosition(view.key) || null;
  const index = Math.min(findVirtualIndex(getResultScrollTop()), view.results.length - 1);
  if (!view.results[index]) return positionPersistence.getPosition(view.key) || null;
  const position = { version: 1, key: view.key, index,
    offset: Math.max(0, getResultScrollTop() - getVirtualOffset(index)),
    anchorId: getResultStableId(view.results[index]), loadedPage: view.loadedPage,
    savedAt: Date.now() };
  return positionPersistence.save(position, () => saveSearchViewport(position, view));
}

function setupSearchPositionSaving() {
  DOM.resultsContainer.addEventListener("scroll", () => {
    if (positionRestore || STATE.isLoading || displayedSearchView?.key !== getSearchViewKey()) return;
    positionPersistence.scheduleSave(saveSearchPosition);
  }, { passive: true });
  // Query and route handlers save explicitly; capture only filters before mutation.
  for (const type of ["change", "click"]) document.addEventListener(type, event => {
    if (!(event.target instanceof Element)) return;
    const selector = type === "change"
      ? "#sort-select, #search-folders-toggle, #exact-search-toggle, #local-mode-toggle, #filter-repo-list input, #filter-ext-list input, #filter-folder-tree input, #filter-min-size, #filter-max-size, #filter-min-unit, #filter-max-unit"
      : "#clear-filters-btn, #repo-filter-cancel, #folder-filter-cancel, #ext-filter-cancel, #folder-select-all, #folder-deselect-all, #ext-select-all, #ext-deselect-all, .folder-self-toggle";
    if (event.target.closest(selector)) saveSearchViewSnapshot();
  }, true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveSearchPosition(); });
  window.addEventListener("pagehide", saveSearchPosition);
}

function showPositionRestoreStatus(message, retry = false) {
  DOM.retryPositionBtn.hidden = !retry;
  DOM.positionRestoreStatus.title = retry ? message : "";
  updateSearchPositionControls();
}

function cancelPositionRestore() {
  cancelSnapshotClone();
  positionEntryId++;
  const previousWindow = resultWindow;
  const previousRestore = positionRestore;
  resultWindow = null;
  positionRestore = null;
  updateResultWindowStatus();
  if (previousRestore) {
    STATE.isLoading = false;
    showPositionRestoreStatus("");
  }
  previousWindow?.controller.abort();
  previousRestore?.controller.abort();
}

const positionRestoration = VoiceOfMLPositionRestoration.create({
  validatePage: (data, page, size, expected) => validatePositionWindowPage(data, page, size, expected),
  isCurrent: task => positionRestore === task && task.key === getSearchViewKey(),
  readViewport: key => readSearchViewport(key),
  fetchPage: (query, page, signal, anchorId) => fetchPositionPageWithRecovery(query, page, signal, anchorId),
  showPreview: (viewport, position, task) => showSavedSearchViewport(viewport, position, task),
  isDragging: () => VSCROLL.isDraggingThumb,
  capturePreviewAnchor: () => {
    if (readerHost.overlay) return null;
    const anchor = captureReaderReturnScroll();
    return { index: anchor.index, offset: anchor.offset, anchorId: getResultStableId(STATE.results[anchor.index]) };
  },
  stableId: record => getResultStableId(record),
  estimatedHeight: () => VSCROLL.estimatedHeight,
  release: () => { positionRestore = null; showPositionRestoreStatus(""); },
  applyPreview: snapshot => applyValidatedSearchViewport(snapshot),
  snapshots: resultSnapshots,
  restoreSnapshot: key => restoreSearchViewSnapshot(key),
  completed: () => {},
  failed: message => { STATE.isLoading = false; showPositionRestoreStatus(message, true); },
  notify: message => showToast(message)
});

function tryRestoreSearchPosition(key, options = {}) {
  const previous = positionRestore?.key === key && positionRestore.failed && !options.position ? positionRestore : null;
  const position = options.position || previous?.position || positionPersistence.getPosition(key);
  if (!validSearchPosition(position)) return false;
  searchIntentId++;
  cancelPendingSearchControls();
  if (!options.position && positionRestore?.key === key && !positionRestore.failed) return true;
  if (!cancelActiveSearch()) return false;
  const owner = searchId;
  cancelPositionRestore();
  if (owner !== searchId) return false;
  setReturnPositionTarget();
  const task = VoiceOfMLPositionRestoration.createTask({ key, position, previous, backend: options.backend });
  positionRestore = task;
  STATE.isLoading = true;
  resetPagingRecovery();
  showPositionRestoreStatus("正在恢复上次位置…");
  void positionRestoration.run(task, options.viewport);
  return true;
}

function applyValidatedSearchViewport(snapshot) {
  const anchor = captureReaderReturnScroll();
  const previous = STATE.results;
  for (const key of Object.keys(snapshot.results)) {
    if (previous[key] && JSON.stringify(previous[key]) === JSON.stringify(snapshot.results[key])) snapshot.results[key] = previous[key];
    else { VSCROLL.templateCache.delete(Number(key)); VSCROLL.measuredRowKeys[key] = null; }
  }
  resultWindow?.controller.abort();
  resultWindow = { ...snapshot.window, key: snapshot.key, total: snapshot.total, query: {...JSON.parse(snapshot.key), resultBackend: snapshot.resultBackend},
    pages: new Set(snapshot.window.pages), pending: new Map(), failures: new Map(), controller: new AbortController() };
  STATE.results = snapshot.results; STATE.total = snapshot.total;
  STATE.page = STATE._loadedPage = snapshot.loadedPage;
  STATE.hasMore = snapshot.hasMore; STATE.isLoading = false;
  if (VSCROLL.heights.length > STATE.results.length) { VSCROLL.heights.length = STATE.results.length; VSCROLL.heightsDirty = true; }
  ensureVirtualHeights(STATE.results.length);
  VSCROLL.measuredWindowKey = "";
  refreshVirtualAfterAppend(false);
  setResultScrollTop(getVirtualOffset(Math.min(anchor.index, STATE.results.length - 1)) + anchor.offset);
  VSCROLL.renderStart = -1; VSCROLL.renderEnd = -1;
  rememberDisplayedSearchView(); renderVisible(); updateStatusBar(); updateLoadInfo(); updatePagingStatus();
  positionPersistence.scheduleSave(saveSearchPosition);
}

function validatePositionWindowPage(data, page, pageSize, expected) {
  VoiceOfMLSearchWindowPage.validate(data, page, pageSize, expected);
}

function resultWindowCurrent(window) {
  return resultWindow === window && window.key === getSearchViewKey() && !window.controller.signal.aborted;
}

function restartResultWindow() {
  const key = getSearchViewKey();
  saveSearchPosition();
  resultSnapshots.remove(key);
  cancelPositionRestore();
  tryRestoreSearchPosition(key);
}

function updateResultWindowStatus() {
  VoiceOfMLResultWindowStatus.update({
    window: resultWindow, getHost: () => DOM.resultsContainer.parentElement,
    retry: () => {
      if (!resultWindow) return;
      if (resultWindow.invalid) return restartResultWindow();
      const pages = [...resultWindow.failures.keys()];
      resultWindow.failures.clear(); updateResultWindowStatus();
      pages.forEach(page => loadResultWindowPage(page));
    },
  });
}

function isRecoverableSearchError(error) {
  return VoiceOfMLSearchRecovery.isRecoverable(error);
}

function waitForSearchRecovery(signal, delay, local) {
  return VoiceOfMLResultWindowLoader.waitForRecovery(signal, delay, local);
}

async function fetchPositionPageWithRecovery(query, page, signal, anchorId, demanded = () => true) {
  return VoiceOfMLResultWindowLoader.fetchWithRecovery({
    fetchPage: (query, page, signal, anchorId) => fetchPositionPage(query, page, signal, anchorId),
    isRecoverable: error => isRecoverableSearchError(error),
    isLocal: query => query.useLocalMode || query.folders.self.length || query.folders.subtree.length || !apiAvailable,
    wait: (signal, delay, local) => waitForSearchRecovery(signal, delay, local),
  }, query, page, signal, anchorId, demanded);
}

function resumeResultRecovery() {
  if (document.hidden || readerHost.overlay) return;
  if (positionRestore?.failed && isRecoverableSearchError(positionRestore.error)) {
    if (navigator.onLine || JSON.parse(positionRestore.key).useLocalMode) tryRestoreSearchPosition(positionRestore.key);
    return;
  }
  if (!resultWindow || resultWindow.invalid || (!navigator.onLine && !resultWindow.query.useLocalMode)) return;
  const start = Math.floor(findVirtualIndex(getResultScrollTop()) / STATE.pageSize);
  const end = Math.floor(findVirtualIndex(getResultScrollTop() + DOM.resultsContainer.clientHeight) / STATE.pageSize) + 2;
  for (const [page, error] of resultWindow.failures) {
    if (page >= start && page <= end && isRecoverableSearchError(error)) resultWindow.failures.delete(page);
  }
  resultWindow.prefetchFailures?.clear();
  updateResultWindowStatus();
  DOM.resultsList.querySelectorAll(".result-window-placeholder").forEach(row => row.remove());
  VSCROLL.renderStart = -1; VSCROLL.renderEnd = -1;
  scheduleVirtualRender();
}

function requestResultWindowPage(window, page, prefetch = false) {
  return VoiceOfMLResultWindowLoader.requestPage({
    readRecent: (key, page, expected, delay, signal) => readRecentSearchPage(key, page, expected, delay, signal),
    isCurrent: window => resultWindowCurrent(window),
    fetchPage: (query, page, signal, anchorId, demanded) => fetchPositionPageWithRecovery(query, page, signal, anchorId, demanded),
    validate: (data, page, size, expected) => validatePositionWindowPage(data, page, size, expected),
    scheduleRender: () => scheduleVirtualRender(),
  }, window, page, prefetch);
}

async function loadResultWindowPage(page, prefetch = false) {
  const window = resultWindow;
  if (!window || positionRestore || !resultWindowCurrent(window) || window.pages.has(page) || page < 1 || page > Math.ceil(window.total / window.query.pageSize)) return false;
  try {
    const data = await requestResultWindowPage(window, page, prefetch);
    if (!data || !resultWindowCurrent(window) || window.invalid || window.pages.has(page)) return false;
    if (prefetch || VSCROLL.isDraggingThumb) {
      if (!window.prefetched) window.prefetched = new Map();
      window.prefetched.set(page, data);
      while (window.prefetched.size > 3) window.prefetched.delete(window.prefetched.keys().next().value);
      return true;
    }
    const results = STATE.results;
    resultSnapshots.budget.invalidate(results);
    data.results.forEach((record, offset) => {
      const index = (page - 1) * window.query.pageSize + offset;
      results[index] = record; VSCROLL.templateCache.delete(index); VSCROLL.measuredRowKeys[index] = null;
    });
    STATE.results = results;
    window.pages.add(page); window.prefetched?.delete(page);
    window.failures.delete(page); updateResultWindowStatus();
    window.count += data.results.length;
    STATE._loadedPage = Math.max(1, Math.ceil(results.length / window.query.pageSize));
    STATE.page = STATE._loadedPage;
    STATE.hasMore = results.length < STATE.total;
    VSCROLL.measuredWindowKey = "";
    ensureVirtualHeights(results.length);
    VSCROLL.renderStart = -1; VSCROLL.renderEnd = -1;
    displayedSearchView = null;
    rememberDisplayedSearchView();
    renderVisible(); updateLoadInfo(); updatePagingStatus();
    positionPersistence.scheduleSave(saveSearchPosition);
    return true;
  } catch (error) {
    if (!resultWindowCurrent(window)) return false;
    if (prefetch && error.message !== "RESTORE_PAGE_CHANGED") {
      if (!window.prefetchFailures) window.prefetchFailures = new Set();
      window.prefetchFailures.add(page);
      if (window.prefetchFailures.size > 64) window.prefetchFailures.delete(window.prefetchFailures.values().next().value);
      return false;
    }
    window.failures.set(page, error);
    if (error.message === "RESTORE_PAGE_CHANGED") window.invalid = true;
    updateResultWindowStatus();
    DOM.resultsList.querySelectorAll(".result-window-placeholder").forEach(row => row.remove());
    VSCROLL.renderStart = -1; VSCROLL.renderEnd = -1;
    scheduleVirtualRender();
    return false;
  }
}

function ensureResultWindowPages(start, end) {
  if (resultSnapshots.cloneTask) {
    materializeSnapshotRange(resultSnapshots.cloneTask, start, end);
    return;
  }
  // A restored search window must keep loading visible pages; reader return state
  // is only a temporary scroll target and must not block normal pagination.
  if (!resultWindow || readerHost.overlay || VSCROLL.isDraggingThumb) return;
  const size = resultWindow.query.pageSize;
  if (positionRestore) {
    if (positionRestore.preview) for (let page = Math.floor(start / size) + 1; page <= Math.ceil(end / size); page++) loadCachedPreviewPage(resultWindow, page);
    return;
  }
  const scrollTop = getResultScrollTop();
  const viewEnd = scrollTop + DOM.resultsContainer.clientHeight;
  const visibleFirst = Math.floor(findVirtualIndex(scrollTop) / size) + 1;
  const visibleLast = Math.floor(findVirtualIndex(viewEnd) / size) + 1;
  const first = Math.floor(start / size) + 1;
  const last = Math.ceil(end / size);
  const pages = new Set();
  const add = page => {
    if (page >= 1 && page <= Math.ceil(resultWindow.total / size)) pages.add(page);
  };
  // Demand the page under the viewport before the surrounding overscan. A
  // large fling must never spend all three request slots on pages already
  // behind the user's current position.
  for (let page = visibleFirst; page <= visibleLast; page++) add(page);
  const direction = VSCROLL.scrollDirection || 1;
  for (let distance = 1; distance <= 4; distance++) {
    add(direction > 0 ? visibleLast + distance : visibleFirst - distance);
  }
  for (let page = first; page <= last; page++) add(page);
  pages.forEach(page => loadResultWindowPage(page));
  prefetchNextPage();
}

function createResultWindowPlaceholder(index) {
  const page = Math.floor(index / STATE.pageSize) + 1;
  return VoiceOfMLResultWindowStatus.createPlaceholder({
    index, page, contentVersion: VSCROLL.contentVersion,
    height: VSCROLL.heights[index] || VSCROLL.estimatedHeight,
    invalid: resultWindow?.invalid, failed: resultWindow?.failures.has(page),
  });
}

async function fetchPositionPage(query, page, signal, anchorId) {
  const mixed = query.folders.self.length || query.folders.subtree.length;
  const params = { q: query.query, repos: query.mode === "repo" ? [query.repo] : query.repos,
    extensions: query.extensions, folders: query.plainFolders, folderMatchMode: mixed ? "mixed" : "prefix",
    folderSelfs: query.folders.self, folderSubtrees: query.folders.subtree,
    minSize: query.minSize, maxSize: query.maxSize, sort: query.sort,
    searchFolders: query.searchFolders, exact: query.exact, page, pageSize: query.pageSize,
    ...(anchorId === undefined ? {} : { anchorId }) };
  if (query.resultBackend === "local" || (!query.resultBackend && (query.useLocalMode || mixed || !apiAvailable))) {
    const ok = STATE.dataLoaded || await ensureLocalDataLoaded(false, true);
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (!ok) throw new Error("LOCAL_UNAVAILABLE");
    return doSearchLocal({...params, signal});
  }
  const body = { q: params.q, repos: params.repos, extensions: params.extensions,
    folders: params.folders, min_size: params.minSize, max_size: params.maxSize,
    sort: params.sort, search_folders: params.searchFolders, exact: params.exact,
    page, page_size: params.pageSize,
    ...(anchorId === undefined ? {} : { anchor_id: anchorId }) };
  const url = query.mode === "repo" ? API_BASE + "/api/search/" + encodeURIComponent(query.repo.split("/").pop()) : API_BASE + "/api/search";
  try {
    const data = await fetchSearchPage(url + "|" + stableSearchStringify(body), url, body, signal, WORKER_REQUEST_TIMEOUT);
    noteApiSuccess();
    return data;
  } catch (error) {
    if (!signal.aborted) noteSearchApiFailure(error);
    throw error;
  }
}

function trimSearchViewSnapshots() {
  resultSnapshots.trim();
}
let searchViewKeyMemo = null;

function sameSearchFilterValues(current, saved) {
  // Retained aliases can mutate arrays without going through a filter handler.
  if (!saved || current.length !== saved.length) return false;
  for (let i = 0; i < current.length; i++) if (current[i] !== saved[i]) return false;
  return true;
}

function getSearchViewKey() {
  searchViewKeyMemo = VoiceOfMLSearchViewKey.resolve(() => ({state: STATE, surface: "pages", getSort: () => STATE.sort || "relevance"}),
    () => searchViewKeyMemo, () => sameSearchFilterValues, () => stableSearchStringify);
  return searchViewKeyMemo.key;
}
function getHeightMeasurementKey() {
  return (DOM.resultsContainer?.clientWidth || 0) + ":" + (STATE.isMobile ? "mobile" : "desktop") + ":" + (STATE.isDark ? "dark" : "light");
}
function getResultStableId(result) {
  return VoiceOfMLSearchIdentity.getResultStableId(result);
}
function cloneSearchResult(result) {
  const copy = VoiceOfMLSnapshotPolicy.cloneResult(result);
  if (copy && searchPageMetadata.has(result)) searchPageMetadata.set(/** @type {object} */ (copy), searchPageMetadata.get(result));
  return copy;
}
function cloneSearchPageCache(cache) {
  return resultSnapshots.copyPageCache(cache);
}

function getSearchSnapshotResultsBytes(results, sparse = false) {
  return resultSnapshots.budget.measure(results, sparse);
}

function extendSearchSnapshotBudget(results, page) {
  resultSnapshots.budget.extend(results, page);
}

function saveSearchViewSnapshot(key = displayedSearchView?.key) {
  const view = displayedSearchView;
  // Browsing from the top must not overwrite the snapshot offered by Return.
  if (getReturnPositionTarget(key)) return resultSnapshots.snapshots.get(key) || null;
  if (!DOM.resultsContainer || !view || positionRestore || key !== view.key || view.loadedPage < 1) return null;
  const position = saveSearchPosition();
  return resultSnapshots.save(view, position, {
    revision: measuredHeightRevision, measurementKey: getHeightMeasurementKey(),
    estimatedHeight: VSCROLL.estimatedHeight, heightCache: VSCROLL.heightCache
  });
}
function activateSearchView(key = getSearchViewKey()) {
  if (VSCROLL.viewKey === key) return;
  VSCROLL.viewKey = key;
  const snapshot = resultSnapshots.snapshots.get(key);
  VSCROLL.heightCache = new Map(snapshot?.heightCache || []);
}
function cancelSnapshotClone() {
  resultSnapshots.cancelClone();
}

function materializeSnapshotRange(task, start, end, deferHeights = false) {
  resultSnapshots.materializeRange(task, start, end, deferHeights);
}

function materializedSnapshotRow(task, index) {
  if (STATE.results !== task.results) return;
  VSCROLL.templateCache.delete(index); VSCROLL.measuredRowKeys[index] = null;
  if (index >= VSCROLL.renderStart && index < VSCROLL.renderEnd) {
    VSCROLL.renderStart = -1; VSCROLL.renderEnd = -1; scheduleVirtualRender();
  }
  const cached = VSCROLL.heightCache.get(getResultStableId(task.results[index]));
  if (cached?.measurementKey === getHeightMeasurementKey() && VSCROLL.heights[index] !== cached.height) {
    if (!task.heightAnchor) {
      const top = getResultScrollTop(), anchorIndex = findVirtualIndex(top);
      task.heightAnchor = { index: anchorIndex, offset: top - getVirtualOffset(anchorIndex) };
    }
    const previous = VSCROLL.heights[index] || VSCROLL.heightBase || VSCROLL.estimatedHeight;
    VSCROLL.heights[index] = cached.height;
    if (!VSCROLL.heightsDirty && VSCROLL.heightTree.length === VSCROLL.heights.length + 1) {
      VoiceOfMLSearchHeightIndex.fenwickAdd(VSCROLL.heightTree, index + 1, cached.height - previous);
    } else VSCROLL.heightsDirty = true;
  }
}

function applySnapshotCloneHeights(task) {
  const anchor = task.heightAnchor;
  task.heightAnchor = null;
  if (!anchor || STATE.results !== task.results) return;
  // Apply all cached height changes in this batch with one scroll compensation.
  refreshVirtualAfterAppend(false);
  const height = VSCROLL.heights[anchor.index] || VSCROLL.heightBase;
  const target = getVirtualOffset(anchor.index) + Math.min(anchor.offset, height - 1);
  if (Math.abs(getResultScrollTop() - target) > 0.5) setResultScrollTop(Math.max(0, target));
  VSCROLL.lastScrollTop = getResultScrollTop();
}

function restoreSearchViewSnapshot(key, restoreScroll = true, preserveRestore = false) {
  const snapshot = resultSnapshots.snapshots.get(key);
  if (!snapshot || snapshot.version !== SEARCH_VIEW_SNAPSHOT_VERSION || snapshot.loadedPage < 1) return restoreScroll && tryRestoreSearchPosition(key);
  searchIntentId++;
  if (!cancelActiveSearch()) return false;
  const owner = searchId;
  if (!preserveRestore) cancelPositionRestore();
  if (owner !== searchId) return false;
  cancelPendingSearchControls();
  STATE.results = resultSnapshots.restoreResults(snapshot, key, STATE.pageSize, restoreScroll, preserveRestore);
  STATE.total = snapshot.total;
  STATE.page = snapshot.page;
  STATE._loadedPage = snapshot.loadedPage;
  STATE._pageCache = cloneSearchPageCache(snapshot.pageCache);
  STATE._resultBackend = snapshot.resultBackend || null;
  STATE.hasMore = snapshot.hasMore;
  if (snapshot.window) resultWindow = { ...snapshot.window, key, total: snapshot.total, query: {...JSON.parse(key), resultBackend: snapshot.resultBackend},
    pages: new Set(snapshot.window.pages), pending: new Map(), failures: new Map(), controller: new AbortController() };
  STATE.isLoading = false;
  STATE.page = STATE._loadedPage;
  STATE._pendingPage = 0;
  STATE._deferredAppendWhileDragging = false;
  STATE._initialActive = false;
  setSearchVisualLoading(false);
  selectedIndices = {};
  lastSelectedIndex = -1;
  if (DOM.multiSelectToggle && DOM.multiSelectToggle.checked) updateSelectionUI();
  resetPagingRecovery();
  VSCROLL.viewKey = key;
  VSCROLL.estimatedHeight = snapshot.estimatedHeight || VSCROLL.estimatedHeight;
  VSCROLL.heightCache = new Map(snapshot.heightCache || []);
  (snapshot.heightRecords || []).forEach(function(record) { VSCROLL.heightCache.set(record[0], record[1]); });
  readerReturnPosition.setScroll(restoreScroll && snapshot.scroll ? /** @type {ReaderReturnPosition} */ (Object.assign({}, snapshot.scroll, { route: location.href, viewKey: key })) : null);
  resetVirtualScrollState();
  renderResults(false);
  updateStatusBar();
  updateLoadInfo();
  syncStateToURL();
  resultSnapshots.startClone();
  return true;
}

function cloneSearchData(data) {
  if (!data || !Array.isArray(data.results)) return data;
  rememberSearchPageMetadata(data);
  const copy = {
    ...data,
    results: data.results.slice(),
    total: data.total,
    page: data.page,
    page_size: data.page_size,
  };
  const identity = searchResponseCacheIdentities.get(data) || {};
  searchResponseCacheIdentities.set(data, identity);
  searchResponseCacheIdentities.set(copy, identity);
  return copy;
}

function getCachedSearchResponse(key) {
  const pending = pendingSearchCacheWrites.get(key);
  if (pending && pending.viewKey === getSearchViewKey()) return cloneSearchData(pending.data);
  var cached = searchResponseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.time > SEARCH_CACHE_TTL) {
    searchResponseCache.delete(key);
    return null;
  }
  return cloneSearchData(cached.data);
}

const pendingSearchCacheWrites = new Map();
const searchResponseCacheIdentities = new WeakMap();
let searchCacheWriteFrame = 0;
let searchCacheWriteTimer = null;

function cancelPendingSearchCacheWrites() {
  if (searchCacheWriteFrame) cancelAnimationFrame(searchCacheWriteFrame);
  clearTimeout(searchCacheWriteTimer);
  searchCacheWriteFrame = 0;
  searchCacheWriteTimer = null;
  pendingSearchCacheWrites.clear();
}

function setCachedSearchResponse(key, data, defer = false) {
  const cached = searchResponseCache.get(key)?.data;
  const identity = searchResponseCacheIdentities.get(data);
  if (cached && identity && searchResponseCacheIdentities.get(cached) === identity) return;
  if (!defer) {
    pendingSearchCacheWrites.delete(key);
    searchResponseCache.set(key, { time: Date.now(), data: cloneSearchData(data) });
    return;
  }
  // Retain at most the existing lookahead's three pages, never another queue of results.
  pendingSearchCacheWrites.delete(key);
  pendingSearchCacheWrites.set(key, { data: cloneSearchData(data), viewKey: getSearchViewKey() });
  while (pendingSearchCacheWrites.size > 3) pendingSearchCacheWrites.delete(pendingSearchCacheWrites.keys().next().value);
  if (searchCacheWriteFrame || searchCacheWriteTimer !== null) return;
  searchCacheWriteFrame = requestAnimationFrame(() => {
    searchCacheWriteFrame = 0;
    searchCacheWriteTimer = setTimeout(() => {
      searchCacheWriteTimer = null;
      const writes = [...pendingSearchCacheWrites];
      pendingSearchCacheWrites.clear();
      for (const [cacheKey, entry] of writes) if (entry.viewKey === getSearchViewKey()) {
        setCachedSearchResponse(cacheKey, entry.data);
      }
    }, 0);
  });
}

function buildCurrentSearchBody(page) {
  return buildSearchApiBody({
    q: STATE.query, page: page || STATE.page || 1, pageSize: STATE.pageSize,
    repos: STATE.mode === "global" ? STATE.filterRepos : null,
    extensions: STATE.filterExtensions, folders: STATE.filterFolders,
    minSize: STATE.filterMinSize, maxSize: STATE.filterMaxSize,
    sort: STATE.sort, searchFolders: STATE.searchFolders, exact: STATE.exact,
  });
}

function getCurrentSearchCacheKey(page) {
  return getSearchApiBase() + "|" + stableSearchStringify(buildCurrentSearchBody(page));
}

function getSearchApiBase() {
  return STATE.repoFull ? API_BASE + "/api/search/" + STATE.repo : API_BASE + "/api/search";
}

// Ordinary API requests use the existing prefix-folder contract. Mixed folder
// selection remains on the Worker path, with its separate camelCase protocol.
function buildSearchApiBody(params) {
  const body = { page: params.page || 1, page_size: params.pageSize || STATE.pageSize };
  if (params.q) body.q = params.q;
  if (!STATE.repoFull && params.repos?.length) body.repos = params.repos;
  if (params.extensions?.length) body.extensions = params.extensions;
  if (params.folders?.length) body.folders = params.folders;
  if (params.minSize !== null) body.min_size = params.minSize;
  if (params.maxSize !== null) body.max_size = params.maxSize;
  body.sort = normalizeSearchSort(params.sort);
  if (!params.searchFolders) body.search_folders = false;
  if (params.exact) body.exact = true;
  return body;
}

function readInitialSearchView() {
  return {
    page: STATE.page, query: STATE.query, sort: STATE.sort || "relevance",
    searchFolders: STATE.searchFolders, exact: STATE.exact,
    repoFilters: STATE.filterRepos.length, extensionFilters: STATE.filterExtensions.length,
    folderFilters: STATE.filterFolders.length, folderSelfFilters: STATE.filterFolderSelfs.length,
    folderSubtreeFilters: STATE.filterFolderSubtrees.length,
    minSize: STATE.filterMinSize, maxSize: STATE.filterMaxSize,
    mode: STATE.mode, repo: STATE.repo, repoFull: STATE.repoFull,
  };
}

var searchBootstrap;
function getSearchBootstrap() {
  return searchBootstrap ||= VoiceOfMLSearchBootstrap.create({
    view: () => readInitialSearchView(), intent: () => searchIntentId,
    viewKey: () => getSearchViewKey(),
    cache: initialPayloadCache, fetchJSON: (url, timeout) => fetchJsonWithTimeout(url, timeout),
    eligible: () => canUseInitialSearchPayload(), payloadURL: () => getInitialPayloadUrl(),
    tryPayload: (mode, repo, intent) => tryInitialSearchPayload(mode, repo, intent),
    applyPayload: (data, intent) => applyInitialSearchPayload(data, intent),
    cancelSearch: () => cancelActiveSearch(), commitPage: data => commitInitialSearchPage(data),
    cacheResponse: page => setCachedSearchResponse(getCurrentSearchCacheKey(1), page),
    markUnverified: (record, page) => searchPageMetadata.set(record, { unverifiedInitial: true,
      total: page.total, page: 1, page_size: page.page_size }),
    renderPage: () => renderInitialSearchPage(),
    syncRoute: () => {
      // A pending hash navigation must not be overwritten by an arriving payload.
      if (window.location.hash === appliedRouteHash) syncStateToURL();
      else if (!readerHost.overlay) persistSearchSession();
    },
    prefetch: () => prefetchNextPage(), scheduleLocalData: () => scheduleBackgroundLocalDataLoad(),
    search: () => doSearch(),
  });
}

function canUseInitialSearchPayload() {
  return VoiceOfMLInitialPayload.eligible(readInitialSearchView());
}

function getInitialPayloadUrl() {
  return VoiceOfMLInitialPayload.url(readInitialSearchView(), INITIAL_BASE_URL);
}

function applyInitialSearchPayload(data, intent = searchIntentId) {
  return getSearchBootstrap().apply(data, intent);
}

function commitInitialSearchPage(data) {
  STATE.total = data.total || 0;
  STATE.page = 1;
  STATE.results = data.results.slice();
  STATE._initialActive = true;
  STATE._resultBackend = null;
  STATE._loadedPage = 1;
  STATE._pageCache = {};
  STATE._pendingPage = 0;
  resetPagingRecovery();
  STATE.hasMore = STATE.results.length < STATE.total;
  STATE.isLoading = false;
  STATE.resultsSkeletonActive = false;
  setSearchVisualLoading(false);
  return { results: STATE.results, total: STATE.total, page: 1,
    page_size: STATE.pageSize, generation: data.generation };
}

function renderInitialSearchPage() {
  resetVirtualScrollState();
  clearResultsSkeleton();
  if (STATE.results.length === 0) {
    DOM.resultsList.innerHTML = "";
    DOM.emptyState.style.display = "flex";
  } else {
    DOM.emptyState.style.display = "none";
    renderResults();
  }
  updateStatusBar();
  updateLoadInfo();
}

async function tryInitialSearchPayload(searchMode, searchRepo, intent = ++searchIntentId) {
  return getSearchBootstrap().tryPayload(searchMode, searchRepo, intent);
}

async function searchWithInitialFallback() {
  const intent = ++searchIntentId;
  saveSearchViewSnapshot();
  // Retire the previous view before restoration can abort callbacks or await I/O.
  if (!cancelActiveSearch() || intent !== searchIntentId) return false;
  const owner = searchId;
  cancelPositionRestore();
  if (owner !== searchId || intent !== searchIntentId) return false;
  const key = getSearchViewKey(), entry = positionEntryId;
  prepareReturnPosition(key);
  if (resultSnapshots.snapshots.has(key)) {
    setReturnPositionTarget();
    return restoreSearchViewSnapshot(key);
  }
  const position = getReturnPositionTarget(key);
  const viewport = position ? await readSearchViewport(key) : null;
  if (intent !== searchIntentId || entry !== positionEntryId || key !== getSearchViewKey()) return false;
  if (validSearchViewport(viewport, position)) return tryRestoreSearchPosition(key, {position, viewport});
  return searchWithInitialFallbackFresh(intent);
}

function searchWithInitialFallbackFresh(intent = ++searchIntentId) {
  return getSearchBootstrap().fresh(intent);
}

function ensureLocalDataLoaded(triggerSearchAfterLoad, background) {
  if (STATE.dataLoaded) return Promise.resolve(true);
  const owner = searchId, intent = searchIntentId, key = getSearchViewKey();
  const isCurrent = () => owner === searchId && intent === searchIntentId && key === getSearchViewKey();
  if (!background && STATE.filterExtensions.length === 0) {
    STATE.isLoading = true;
    setSearchVisualLoading(true);
    STATE.resultsSkeletonActive = true;
    DOM.emptyState.style.display = "none";
    STATE.page = 1;
    STATE.results = [];
    renderResultsSkeleton();
    updateStatusBar();
    updateLoadInfo();
    showToast("正在加载本地数据...");
  } else if (!background) {
    STATE.isLoading = true;
    STATE.resultsSkeletonActive = false;
    DOM.emptyState.style.display = "none";
    setSearchVisualLoading(false);
  }
  // Share only data acquisition. Every caller keeps its own intent/continuation,
  // so an obsolete first caller cannot strand a newer search joining the load.
  if (!localDataPromise) {
    localDataPromise = loadData().catch(function(err) {
      console.error("Local data load failed:", err);
      return false;
    }).then(function(ok) {
      STATE.dataLoaded = ok;
      localDataPromise = null;
      if (ok) {
        STATE.extensionList = extensionList;
        updateRandomTxtVisibility();
      }
      return ok;
    });
  }
  return localDataPromise.then(function(ok) {
    if (!isCurrent()) return ok;
    if (ok) {
      if (STATE.mode === "repo") {
        renderFilters(routeRenderId);
      } else {
        renderExtensionFilter(routeRenderId);
        renderRepoFilter(routeRenderId);
      }
      if (!isCurrent()) return ok;
      if (STATE._initialActive) {
        STATE._initialActive = false;
      } else if (triggerSearchAfterLoad) {
        STATE.page = 1;
        STATE.results = [];
        doSearch();
      }
    } else if (!background) {
      STATE.isLoading = false;
      STATE.resultsSkeletonActive = false;
      setSearchVisualLoading(false);
    }
    return ok;
  });
}

function clearUnavailableSearchResults() {
  STATE.results = [];
  STATE.total = 0;
  STATE._loadedPage = 0;
  STATE._pageCache = {};
  STATE.hasMore = false;
  STATE.resultsSkeletonActive = false;
  selectedIndices = {};
  lastSelectedIndex = -1;
  keyboardResultIndex = -1;
  resetVirtualScrollState();
  DOM.resultsList.innerHTML = "";
  DOM.emptyState.style.display = "none";
}

function renderSearchBackendUnavailable(waiting) {
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  status.textContent = waiting ? "正在加载搜索数据…" : "搜索数据加载失败，请重试";
  status.className = "search-backend-status";
  DOM.resultsList.append(status);
  if (!waiting) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重试";
    retry.className = "search-backend-status";
    retry.addEventListener("click", () => doSearch());
    DOM.resultsList.append(retry);
  }
  updateStatusBar();
  updateLoadInfo();
}

function submitSearchQuery(query, { restore = false, record = false, refreshHistory = false, clearResults = false, blur = false, updateInput = restore } = {}) {
  if (Array.from(query).length > 256) {
    showToast("搜索内容不能超过 256 个字符");
    return;
  }
  // Another search can preempt the size debounce: include its visible input.
  applyPendingSizeFilters();
  cancelPendingSearchControls();
  saveSearchViewSnapshot();
  if (updateInput) setSearchInputValue(query);
  STATE.query = query;
  STATE.page = 1;
  if (clearResults) { STATE.results = []; keyboardResultIndex = -1; }
  if (record) addHistoryItem(query);
  if (refreshHistory) renderDropdown();
  // Publish the current route before the request settles. Reader return URLs
  // and browser session recovery must not capture the previous query.
  syncStateToURL();
  const result = doSearch(false, false, restore);
  if (blur) DOM.searchInput.blur();
  return result;
}

function initialSearchDraftIsCurrent() {
  return searchInputController.draftIsCurrent();
}

function finishInitialSearchInput(current) {
  searchInputController.finishStartup(current);
}

function setupSearchInput() {
  searchInputController = VoiceOfMLSearchInput.create({
    input: DOM.searchInput, navigation: window, ownership: VoiceOfMLSearchInputOwnership,
    clock: { setTimeout: (callback, delay) => window.setTimeout(callback, delay), clearTimeout: timer => window.clearTimeout(timer) },
    getHref: () => location.href,
    getEntryKey: () => /** @type {Window & {navigation?: {currentEntry?: {key?: string} | null}}} */ (window).navigation?.currentEntry?.key,
    getViewKey: () => routeInitialized ? getSearchViewKey() : null,
    syncInput: syncSearchInputState,
    submit: query => { submitSearchQuery(query, { record: true, refreshHistory: true }); },
    onState: state => {
      searchTimer = state.timer;
      searchComposing = state.composing;
      searchInputReady = state.ready;
      initialSearchDraft = state.dirty;
    }
  });
  searchInputController.mount();
}

function renderResultsSkeleton(count) {
  count = count || 8;
  var html = "";
  for (var i = 0; i < count; i++) {
    html += '<div class="result-skeleton-item" aria-hidden="true">' +
      '<div class="result-skeleton-icon skeleton-shimmer"></div>' +
      '<div class="result-skeleton-info">' +
        '<div class="result-skeleton-line title skeleton-shimmer"></div>' +
        '<div class="result-skeleton-line path skeleton-shimmer"></div>' +
        '<div class="result-skeleton-line meta skeleton-shimmer"></div>' +
      '</div>' +
      '<div class="result-skeleton-actions">' +
        '<div class="result-skeleton-btn skeleton-shimmer"></div>' +
        '<div class="result-skeleton-btn skeleton-shimmer"></div>' +
        '<div class="result-skeleton-btn skeleton-shimmer short"></div>' +
      '</div>' +
    '</div>';
  }
  DOM.resultsList.innerHTML = html;
}

function clearResultsSkeleton() {
  DOM.resultsList.querySelectorAll(".result-skeleton-item").forEach((row) => row.remove());
}

function buildLocalSearchParams(page) {
  var activeFolderFilters = [];
  var folderMatchMode = null;
  if (STATE.filterFolderSelfs.length > 0 || STATE.filterFolderSubtrees.length > 0) {
    activeFolderFilters = STATE.filterFolderSelfs.concat(
      STATE.filterFolderSubtrees.filter(function(path) {
        return STATE.filterFolderSelfs.indexOf(path) < 0;
      })
    );
    folderMatchMode = "mixed";
  }
  return {
    q: STATE.query,
    repos: STATE.mode === "repo" ? [STATE.repoFull] : (STATE.filterRepos.length > 0 ? STATE.filterRepos : null),
    extensions: STATE.filterExtensions.length > 0 ? STATE.filterExtensions : null,
    folders: activeFolderFilters.length > 0 ? activeFolderFilters : null,
    folderMatchMode: folderMatchMode,
    folderSelfs: STATE.filterFolderSelfs,
    folderSubtrees: STATE.filterFolderSubtrees,
    minSize: STATE.filterMinSize,
    maxSize: STATE.filterMaxSize,
    sort: STATE.sort,
    searchFolders: STATE.searchFolders,
    exact: STATE.exact,
    page,
    pageSize: STATE.pageSize,
  };
}

function doSearch(append, fromStart = false, restorePosition = false) {
  if (append && resultWindow) { loadResultWindowPage(STATE._loadedPage + 1); return; }
  if (append && !STATE._loadedPage) append = false;
  if (!append) searchIntentId++;
  if (!append && !cancelActiveSearch()) return;
  const owner = searchId;
  if (!append && prepareSearchPositionNavigation({ fromStart, restorePosition })) return;
  if (owner !== searchId) return;
  if (append && STATE.isLoading) return;
  if (append && !STATE._loadedPage) append = false;
  if (!append) STATE.page = 1;
  clearTimeout(filterSearchTimer);
  filterSearchTimer = null;
  const id = ++searchId;
  const intent = searchIntentId;
  const params = buildLocalSearchParams(STATE.page);
  if (append && STATE._pageCache[STATE.page]) {
    if (deferSearchAppend()) return;
    consumeCachedAppendPage();
    return;
  }
  STATE.isLoading = true;
  updatePagingStatus();
  setSearchVisualLoading(false);
  if (!append) {
    resetPagingRecovery();
    if (!canUseInitialSearchPayload()) STATE._initialActive = false;
    if (STATE.results.length === 0) DOM.emptyState.style.display = "none";
    selectedIndices = {};
    lastSelectedIndex = -1;
    if (DOM.multiSelectToggle && DOM.multiSelectToggle.checked) updateSelectionUI();
    STATE._pageCache = {};
    STATE._loadedPage = 0;
    STATE._pagingAppendScrollTop = null;
    STATE._resultBackend = null;
    STATE._pendingPage = 0;
    STATE._deferredAppendWhileDragging = false;
    if (scrollLoadTimer) {
      clearTimeout(scrollLoadTimer);
      scrollLoadTimer = null;
    }
    if (STATE.results.length === 0 && !STATE.resultsSkeletonActive) {
      clearResultsSkeleton();
    }
  }
  getSearchExecution().execute(params, append, id, intent);
}

// Only execution fields and bounded effects cross this boundary. The host
// retains synchronous cancellation, route/position preparation and rendering.
var searchExecution;
function getSearchExecution() {
  return searchExecution ||= VoiceOfMLSearchExecution.create({
    readView: () => ({ searchId, intent: searchIntentId, requestId: searchRequestId,
      page: STATE.page, _loadedPage: STATE._loadedPage, _pendingPage: STATE._pendingPage,
      _resultBackend: STATE._resultBackend, _initialActive: STATE._initialActive,
      _deferredAppendWhileDragging: STATE._deferredAppendWhileDragging,
      dataLoaded: STATE.dataLoaded, useLocalMode: STATE.useLocalMode,
      resultCount: STATE.results.length, apiAvailable }),
    update: patch => { Object.assign(STATE, patch); },
    signal: create => {
      if (create && !searchAbortController) searchAbortController = new AbortController();
      return searchAbortController.signal;
    },
    setLocalMode: enabled => {
      STATE.useLocalMode = enabled;
      if (DOM.localModeToggle) DOM.localModeToggle.checked = enabled;
    },
    clearPrefetch: () => { cancelSearchPrefetch(); STATE._pageCache = {}; },
    pendingLocal: (page, append) => {
      const controller = searchPrefetchAbortController;
      return append && controller?.groupKey === "local|" + getSearchViewKey()
        && !controller.signal.aborted && controller.active.get(page);
    },
    loadLocal: () => ensureLocalDataLoaded(false, true),
    searchLocal: params => doSearchLocal(params),
    searchAPI: (params, append, requestId) => doSearchAPI(params, append, requestId),
    retry: append => doSearch(append), applyPage: (data, append) => applySearchPage(data, append),
    clearUnavailableResults: () => clearUnavailableSearchResults(),
    renderUnavailable: waiting => renderSearchBackendUnavailable(waiting),
    renderPage: append => renderSearchPage(append), visualLoading: value => setSearchVisualLoading(value),
    prefetch: () => prefetchNextPage(), warmConnection: () => warmConnection(), syncURL: () => syncStateToURL(),
    notify: message => showToast(message), updateStatus: () => updateStatusBar(),
    finishPaging: (ok, error) => finishPagingAttempt(ok, error), updatePaging: () => updatePagingStatus(),
  });
}

function renderSearchPage(append) {
  DOM.resultsList.querySelectorAll(".search-backend-status").forEach(element => element.remove());
  if (append) {
    refreshVirtualAfterAppend();
  } else {
    DOM.resultsContainer.scrollTop = 0;
    resetVirtualScrollState();
    clearResultsSkeleton();
    if (STATE.results.length === 0) {
      DOM.resultsList.innerHTML = "";
      DOM.emptyState.style.display = "flex";
      DOM.emptyDesc.textContent = STATE.query
        ? '没有找到与 "' + STATE.query + '" 相关的结果'
        : "暂无数据";
    } else {
      DOM.emptyState.style.display = "none";
      renderResults(true);
    }
  }
  updateStatusBar();
  updateLoadInfo();
}

function renderResults(animate = false) {
  pendingResultEntrance = false;
  if (!positionRestore && STATE._loadedPage >= 1) rememberDisplayedSearchView();
  activateSearchView();
  clearResultsSkeleton();
  if (STATE.results.length === 0) {
    DOM.resultsList.innerHTML = "";
    resetVirtualScrollState();
    DOM.emptyState.style.display = "flex";
    DOM.emptyDesc.textContent = STATE.query
      ? '没有找到与 "' + STATE.query + '" 相关的结果'
      : "暂无数据";
    return;
  }
  DOM.emptyState.style.display = "none";
  ensureResultTemplateCache();
  ensureVirtualHeights(STATE.results.length);
  VSCROLL.renderStart = 0;
  VSCROLL.renderEnd = 0;
  pendingResultEntrance = animate;
  if (readerReturnPosition.scroll && !readerHost.overlay) {
    setResultScrollTop(getVirtualOffset(readerReturnPosition.scroll.index) + readerReturnPosition.scroll.offset, true);
    restoreReaderReturnScroll(true);
  } else renderVisible();
}

function animateVisibleResultRows() {
  let order = 0;
  DOM.resultsList.querySelectorAll(".result-item[data-index]").forEach(function(row) {
    if (Number(row.dataset.index) >= 30) return;
    row.style.setProperty("--result-enter-delay", (order * 3) + "ms");
    row.classList.add("result-enter");
    row.addEventListener("animationend", function() {
      row.classList.remove("result-enter");
      row.style.removeProperty("--result-enter-delay");
    }, { once: true });
    order += 1;
  });
}

let resultRows = null;
function getResultRows() {
  if (!resultRows) resultRows = VoiceOfMLResultRows.create({
    readView: () => ({ query: STATE.query, searchFolders: STATE.searchFolders, mode: STATE.mode }),
    escapeHTML: value => escapeHTML(value), highlightText: (text, query) => highlightText(text, query),
    getFileIconType: ext => getFileIconType(ext), formatSize: size => formatSize(size),
    getRecordLink: record => getRecordLink(record), getCopyableLink: link => getCopyableLink(link),
    getRecordPath: record => getRecordPath(record), getPreviewLink: path => getPreviewLink(path), icons: ICONS,
    readerAction(rec, recordLink) {
      const readerRecord = applyReaderAsset(rec, rec.Repo || "", buildRecordRelativePath(rec), recordLink);
      const record = isReadableRecord(readerRecord) ? readerRecord : (isDefaultReadableRecord(rec) ? rec : null);
      return {
        url: record ? getReaderLink(record, undefined, false) : "",
        label: record && ["audio", "video", "swf"].includes(VoiceOfMLReader.capability(record.ReaderExtension || record.Extension).mode) ? "在线播放" : "在线阅读",
      };
    },
    templates: VSCROLL.templateCache,
    contentVersion: () => VSCROLL.contentVersion,
    placeholder: index => createResultWindowPlaceholder(index),
    bindRecord: (row, record) => resultRowRecords.set(row, record),
  });
  return resultRows;
}
function buildResultHTML(rec, idx) { return getResultRows().buildHTML(rec, idx); }

function refreshResultReaderActions() {
  VSCROLL.templateCache.clear();
  for (const row of DOM.resultsList.querySelectorAll(".result-item[data-index]")) {
    const index = Number(row.dataset.index), record = STATE.results[index];
    if (!record) continue;
    const readerRecord = applyReaderAsset(record, record.Repo || "", buildRecordRelativePath(record), getRecordLink(record));
    const readerReady = isReadableRecord(readerRecord);
    let button = row.querySelector('[data-action="read"]');
    if (!readerReady && !isDefaultReadableRecord(record)) {
      if (button) { button.remove(); VSCROLL.measuredRowKeys[index] = null; }
      continue;
    }
    const actionRecord = readerReady ? readerRecord : record;
    if (!button) {
      button = document.createElement("button"); button.className = "result-action-btn"; button.dataset.action = "read";
      row.querySelector(".result-actions").appendChild(button);
      VSCROLL.measuredRowKeys[index] = null;
    }
    button.dataset.readerUrl = getReaderLink(actionRecord);
    const label = ["audio", "video", "swf"].includes(VoiceOfMLReader.capability(actionRecord.ReaderExtension || actionRecord.Extension).mode) ? "在线播放" : "在线阅读";
    if (button.textContent !== label) { button.textContent = label; VSCROLL.measuredRowKeys[index] = null; }
    button.setAttribute('aria-label', label + '：' + record.File + (record.Extension ? '.' + record.Extension : ''));
  }
  VSCROLL.measuredWindowKey = "";
  VSCROLL.renderStart = -1; VSCROLL.renderEnd = -1;
  scheduleVirtualRender();
}

function getResultsHTMLCacheKey() {
  return [
    STATE.query || "",
    STATE.searchFolders ? "1" : "0",
    STATE.useMirrorLinks ? "1" : "0",
    STATE.mode || "",
    STATE.repoFull || "",
    STATE.sort || "relevance",
    STATE.filterRepos.join(","),
    STATE.filterExtensions.join(","),
    STATE.filterFolderSelfs.join(","),
    STATE.filterFolderSubtrees.join(","),
    STATE.filterMinSize == null ? "" : String(STATE.filterMinSize),
    STATE.filterMaxSize == null ? "" : String(STATE.filterMaxSize),
  ].join("|");
}

function clearResultTemplateCache(key = getResultsHTMLCacheKey()) {
  VSCROLL.templateCache.clear();
  VSCROLL.templateCacheKey = key;
  VSCROLL.contentVersion++;
  VSCROLL.measuredWindowKey = "";
  VSCROLL.measuredRowKeys = [];
}

function ensureResultTemplateCache() {
  const key = getResultsHTMLCacheKey();
  if (VSCROLL.templateCacheKey !== key) clearResultTemplateCache(key);
}

function createResultRow(rec, idx) { return getResultRows().createRow(rec, idx); }

// The controller owns virtual rendering; paging/snapshots/thumb retain the shared state reference.
const RESULT_SCROLL_SEGMENT_HEIGHT = VoiceOfMLVirtualResults.segmentHeight;
let virtualResults;
function getVirtualResults() {
  return virtualResults ||= VoiceOfMLVirtualResults.create(VSCROLL, {
    elements: {
      get resultsContainer() { return DOM.resultsContainer; },
      get resultsList() { return DOM.resultsList; },
      get multiSelectToggle() { return DOM.multiSelectToggle; }
    },
    results: () => STATE.results, total: () => STATE.total,
    hasWindow: () => !!resultWindow, windowTotal: () => resultWindow.total,
    cloning: () => !!resultSnapshots.cloneTask, restoring: () => !!positionRestore,
    loadedPage: () => STATE._loadedPage, pendingEntrance: () => pendingResultEntrance,
    consumeEntrance: () => { pendingResultEntrance = false; },
    recordMeasurement: () => { measuredHeightRevision++; },
    recordForRow: row => resultRowRecords.get(row),
    resetKeyboardIndex: index => { keyboardResultIndex = index; },
    getHeightMeasurementKey: () => getHeightMeasurementKey(), getResultStableId: record => getResultStableId(record),
    ensureResultTemplateCache: () => ensureResultTemplateCache(), createResultRow: (record, index) => createResultRow(record, index),
    updateCurrentResultPosition: () => updateCurrentResultPosition(), maybeLoadNextPage: () => maybeLoadNextPage(),
    updateScrollThumb: () => updateScrollThumb(), updateScrollTrack: () => updateScrollTrack(),
    ensureResultWindowPages: (start, end) => ensureResultWindowPages(start, end),
    updateVisibleSelection: () => updateVisibleSelection(), animateVisibleResultRows: () => animateVisibleResultRows(),
    rememberDisplayedSearchView: () => rememberDisplayedSearchView(), cancelQuickScroll: () => cancelQuickScroll(),
    activateSearchView: () => activateSearchView(), clearResultTemplateCache: () => clearResultTemplateCache()
  });
}
function getResultScrollTop() { return getVirtualResults().getResultScrollTop(); }
function setResultScrollTop(value, restoreWindow = false) { return getVirtualResults().setResultScrollTop(value, restoreWindow); }
function scheduleVirtualRender(scrollIntent = false) { return getVirtualResults().scheduleVirtualRender(scrollIntent); }
function renderVisible() { return getVirtualResults().renderVisible(); }
function ensureHeightTree() { return getVirtualResults().ensureHeightTree(); }
function getVirtualTotalHeight() { return getVirtualResults().getVirtualTotalHeight(); }
function getVirtualOffset(index) { return getVirtualResults().getVirtualOffset(index); }
function findVirtualIndex(offset) { return getVirtualResults().findVirtualIndex(offset); }
function resetVirtualScrollState() { return getVirtualResults().resetVirtualScrollState(); }
function ensureVirtualHeights(len) { return getVirtualResults().ensureVirtualHeights(len); }
function refreshVirtualAfterAppend(updateView = true) { return getVirtualResults().refreshVirtualAfterAppend(updateView); }
function ensureVirtualViewportCovered() { return getVirtualResults().ensureVirtualViewportCovered(); }
function measureHeights(start = VSCROLL.renderStart, end = VSCROLL.renderEnd, anchor = null) { return getVirtualResults().measureHeights(start, end, anchor); }

function prepareRouteTransitionResults() {
  saveSearchViewSnapshot();
  cancelQuickScroll();
}

let searchAnnouncementTimer = 0;
function announceSearchStatus(message, resultKey = '') {
  if (!DOM.announcement) return;
  clearTimeout(searchAnnouncementTimer);
  if (!resultKey && DOM.announcement.textContent === message) DOM.announcement.textContent = '';
  searchAnnouncementTimer = setTimeout(() => {
    if (resultKey && (STATE.isLoading || resultKey !== STATE.query + '\0' + STATE.total)) return;
    if (DOM.announcement.textContent !== message) DOM.announcement.textContent = message;
    if (resultKey) DOM.announcement.dataset.resultKey = resultKey;
  }, 250);
}

function updateStatusBar() {
  DOM.resultsContainer?.setAttribute('aria-busy', String(STATE.isLoading));
  // Once an empty search has settled there is no visible multi-select toggle.
  // Exit the mode as well, so its action bar and selection cannot linger.
  if (!STATE.isLoading && STATE._loadedPage > 0 && STATE.total === 0 && DOM.multiSelectToggle?.checked) {
    DOM.multiSelectToggle.checked = false;
    updateSelectionUI();
  }
  if (DOM.announcement && !STATE.isLoading && STATE._loadedPage > 0) {
    const key = STATE.query + '\0' + STATE.total;
    if (DOM.announcement.dataset.resultKey !== key)
      announceSearchStatus((STATE.query ? '搜索“' + STATE.query + '”完成，' : '') +
        (STATE.total ? '共 ' + STATE.total.toLocaleString() + ' 条结果' : '没有找到结果'), key);
  }
  DOM.resultCount.textContent = STATE.total > 0 ? "共 " + STATE.total.toLocaleString() + " 条结果" : "";
  var has = STATE.filterRepos.length || STATE.filterExtensions.length || STATE.filterFolderSelfs.length || STATE.filterFolderSubtrees.length ||
            STATE.filterMinSize !== null || STATE.filterMaxSize !== null;
  DOM.clearFiltersBtn.style.display = has ? "" : "none";
  updateFilterCancelButtons();
  if (DOM.multiToggleLabel) DOM.multiToggleLabel.style.display = STATE.total > 0 ? "" : "none";
}

function updateFilterCancelButtons() {
  DOM.repoFilterCancel.hidden = STATE.filterRepos.length === 0;
  DOM.folderFilterCancel.hidden = STATE.filterFolderSelfs.length === 0 && STATE.filterFolderSubtrees.length === 0;
  DOM.extFilterCancel.hidden = STATE.filterExtensions.length === 0;
}

function setSearchVisualLoading(loading) {
  document.getElementById("search-box").classList.toggle("is-searching", loading);
  updateStatusBar();
}

function prepareFilterChange(clearResults) {
  // Merge completed query drafts too; a filter click must not discard typing.
  const query = searchTimer !== null && !searchComposing ? DOM.searchInput.value.trim() : null;
  applyPendingSizeFilters();
  cancelPendingSearchControls();
  saveSearchViewSnapshot();
  if (query !== null && Array.from(query).length <= 256) STATE.query = query;
  STATE.page = 1;
  if (clearResults) STATE.results = [];
}

function doFilterSearch(clearResults = false) {
  prepareFilterChange(clearResults);
  return doSearch(false, false, true);
}

function sizeInputToBytes(input, unitSelect) {
  const value = parseFloat(input.value);
  if (isNaN(value) || value < 0) return null;
  const factor = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[unitSelect.value] || 1;
  return Math.round(value * factor);
}

function applyPendingSizeFilters() {
  if (sizeFilterTimer === null) return;
  clearTimeout(sizeFilterTimer);
  sizeFilterTimer = null;
  STATE.filterMinSize = sizeInputToBytes(DOM.filterMinSize, DOM.filterMinUnit);
  STATE.filterMaxSize = sizeInputToBytes(DOM.filterMaxSize, DOM.filterMaxUnit);
}

function setupSizeFilterControls() {
  const schedule = () => {
    clearTimeout(sizeFilterTimer);
    sizeFilterTimer = setTimeout(() => {
      applyPendingSizeFilters();
      doFilterSearch(true);
    }, 500);
  };
  [DOM.filterMinSize, DOM.filterMaxSize].forEach(input => input.addEventListener("input", schedule));
  [DOM.filterMinUnit, DOM.filterMaxUnit].forEach(select => select.addEventListener("change", schedule));
}

function scheduleFilterSearch(clearResults = false) {
  searchIntentId++;
  prepareFilterChange(clearResults);
  if (!cancelActiveSearch()) return;
  const owner = searchId;
  cancelPositionRestore();
  if (owner !== searchId) return;
  resetPagingRecovery();
  STATE.isLoading = true;
  setSearchVisualLoading(true);
  syncStateToURL();
  filterSearchTimer = setTimeout(() => {
    filterSearchTimer = null;
    doFilterSearch();
  }, FILTER_SEARCH_DEBOUNCE_MS);
}

function updateCurrentResultPosition() {
  const label = /** @type {HTMLInputElement | null} */ (document.getElementById("current-result-position"));
  if (!label) return;
  const editing = document.activeElement === label;
  label.hidden = !editing;
  if (STATE.results.length || STATE.total) {
    const index = findVirtualIndex(getResultScrollTop());
    if (!editing && label.value !== String(index + 1)) label.value = String(index + 1);
    const display = document.getElementById('result-position-display');
    if (display && display.textContent !== String(index + 1)) display.textContent = String(index + 1);
  }
  updateSearchPositionControls();
}

function updateLoadInfo() {
  if (STATE.total === 0 && STATE.results.length === 0) {
    DOM.loadInfo.style.display = "none";
    return;
  }
  DOM.loadInfo.style.display = "";
  DOM.totalCount.textContent = STATE.total.toLocaleString();
  DOM.currentResultPosition.parentElement.style.setProperty("--position-width", String(Math.max(1, STATE.total).toLocaleString()).length + "ch");
  updateCurrentResultPosition();
  requestAnimationFrame(updateScrollTrack);
}

// Directory feature composition: bounded routing view and explicit site effects.
let sidebarDirectory, sidebarDirectoryView;
function getSidebarDirectoryView() {
  return sidebarDirectoryView || (sidebarDirectoryView = VoiceOfMLSidebarDirectoryView.create({
    content: DOM.sidebarContent, sidebar: DOM.leftSidebar, scroll: getSidebarScroll(),
    surface: "pages", escape: escapeHTML, updateHeader: () => updateSidebarHeader(),
    navigate: path => ROUTER.navigate("repo", STATE.repo, path),
    setPath: path => { STATE.browserPath = path; syncStateToURL(); },
    markup: {
    icon: key => sidebarIconMarkup(key),
    escape: value => escapeHTML(value),
    iconType: extension => getFileIconType(extension),
    formatSize: size => formatSize(size),
    name: file => getBrowserFileName(file),
    link: (repo, folder, file) => getBrowserFileLink(repo, folder, file),
    reader: (file, repo, folder) => getBrowserReaderUrl(file, repo, folder),
    },
  }));
}
function getSidebarDirectory() {
  return sidebarDirectory || (sidebarDirectory = VoiceOfMLSidebarDirectory.create({
    readView: () => ({mode: STATE.mode, repo: STATE.repo, repoFull: STATE.repoFull,
      browserPath: STATE.browserPath, routeId: routeRenderId, repos: repoList,
      apiAvailable: apiAvailable, useLocalMode: STATE.useLocalMode, dataLoaded: STATE.dataLoaded, tree: STATE.folderTree}),
    view: getSidebarDirectoryView(), scroll: getSidebarScroll(),
    renderRepos: repos => renderRepoListItems(repos), updateHeader: () => updateSidebarHeader(),
    initial: repo => loadSidebarInitial(repo), fetchRepos: () => fetchRepos(),
    fetchContents: (repo, path) => fetchFolderContents(repo, path),
    localContents: (repo, path) => getFolderContents(repo, path), ensureLocal: (force, silent) => ensureLocalDataLoaded(force, silent),
    cache: folderContentsCache, publishRepos: repos => { repoList = repos; },
    refreshAssets: refreshSidebarReaderAssets,
  }));
}

function refreshSidebarReaderAssets(list, currentRepo, path, routeId, readDisplayed) {
  var initialAssets = readerAssetController.state.assets;
  loadReaderAssetsAfterFirstPaint().then(function() {
    const displayedData = readDisplayed();
    if (!list.isConnected || !displayedData || readerAssetController.state.assets === initialAssets ||
        (routeId && routeId !== routeRenderId) || STATE.mode !== "repo" ||
        STATE.repoFull !== currentRepo || STATE.browserPath !== path) return;
    list.querySelectorAll('.browser-item[data-link]').forEach(function(row, index) {
      const file = (displayedData.files || [])[index];
      if (!file) return;
      const readerUrl = getBrowserReaderUrl(file, currentRepo, path);
      const fileRow = /** @type {HTMLElement} */ (row);
      if (readerUrl) fileRow.dataset.readerUrl = readerUrl;
      else delete fileRow.dataset.readerUrl;
      row.querySelector('.browser-name').setAttribute('aria-label', (readerUrl ? '打开阅读器：' : '下载文件：') + getBrowserFileName(file));
    });
  });
}

function renderSidebar(routeId) {
  getSidebarDirectory().render(routeId);
}

function renderRepoListItems(repos) {
  return getSidebarDirectoryView().repos(repos);
}

function renderRepoList(routeId) {
  return getSidebarDirectory().repos(routeId);
}

function renderBrowserListItems(list, data, currentRepo, path) {
  return getSidebarDirectoryView().items(list, data, currentRepo, path);
}

function getBrowserReaderUrl(file, repo, path) {
  const name = getBrowserFileName(file);
  const link = getBrowserFileLink(repo, path || "", file);
  const assetPath = path ? path + "/" + name : name;
  let record = { File: file.name, Extension: file.ext, Link: link };
  record = applyReaderAsset(record, repo, assetPath, link);
  return VoiceOfMLReader.readerUrl(record, "/search/static/reader.html");
}

function createSidebarBreadcrumb(path) {
  return getSidebarDirectoryView().breadcrumb(path);
}

function renderBrowser(path, routeId) {
  return getSidebarDirectory().browse(path, routeId);
}

// Filter feature composition: only filter state and effects cross this boundary.
let sidebarFilters, sidebarFolderTree, sidebarFilterLists;
function getSidebarFilters() {
  if (sidebarFilters) return sidebarFilters;
  sidebarFilterLists = VoiceOfMLSidebarFilterList.create({
    readSelection: () => STATE.filterExtensions, escape: escapeHTML,
  });
  sidebarFolderTree = VoiceOfMLSidebarFolderTree.create({
    container: DOM.filterFolderTree, toggleAll: DOM.folderToggleAll,
    readView: () => ({ tree: STATE.folderTree || [], collapsed: STATE.folderTreeCollapsed,
      subtrees: STATE.filterFolderSubtrees, selfs: STATE.filterFolderSelfs, mode: STATE.mode, routeId: routeRenderId }),
    setCollapsed: (path, collapsed) => { STATE.folderTreeCollapsed[path] = collapsed; },
    commitSelection: (subtrees, selfs) => {
      STATE.filterFolderSubtrees = subtrees;
      STATE.filterFolderSelfs = selfs;
      STATE.filterFolders = mergeFolderFilters(selfs, subtrees.filter(Boolean));
      updateFilterCancelButtons();
      scheduleFilterSearch();
    },
    notify: showToast, escape: escapeHTML, selection: VoiceOfMLSearchFolderSelection,
  });
  sidebarFilters = VoiceOfMLSidebarFilters.create({
    readView: () => ({ mode: STATE.mode, repo: STATE.repo, repoFull: STATE.repoFull, routeId: routeRenderId,
      repos: repoList || [], extensions: [], selectedRepos: STATE.filterRepos,
      selectedExtensions: STATE.filterExtensions, tree: STATE.folderTree || [],
      apiAvailable: apiAvailable, dataLoaded: STATE.dataLoaded }),
    elements: {repoSection: DOM.filterRepoSection, repoList: DOM.filterRepoList,
      folderSection: DOM.filterFolderSection, folderTree: DOM.filterFolderTree, extList: DOM.filterExtList},
    tree: sidebarFolderTree, lists: sidebarFilterLists, orderedExtensions: ORDERED_EXTENSIONS,
    cache: folderTreeCache,
    initial: repo => loadSidebarInitial(repo), fetchRepos: () => fetchRepos(),
    fetchExtensions: repo => fetchExtensions(repo), fetchFolders: (repo, full) => fetchFolderTree(repo, full),
    localFolders: repo => corpusWorkerRequest("folder-tree", {repo}, WORKER_REQUEST_TIMEOUT),
    hasExtensionCounts: () => !!(extensionList && extensionList.length),
    extensionCounts: repo => repo ? Object.fromEntries((repoExtensionCounts[repo] || []).map(item => [item.name, item.count || 0])) : extensionCounts,
    publishRepos: repos => { repoList = repos; },
    publishExtensions: extensions => { STATE.extensionList = extensions.map(item => item.name); },
    publishTree: (tree, resetCollapsed = false) => {
      STATE.folderTree = tree;
      if (resetCollapsed) STATE.folderTreeCollapsed = {};
    },
    selectRepos: values => { STATE.filterRepos = values; updateFilterCancelButtons(); scheduleFilterSearch(true); },
    selectExtensions: values => {
      STATE.filterExtensions = values;
      saveStoredExtensionFilters(); updateFilterCancelButtons(); scheduleFilterSearch();
    },
  });
  return sidebarFilters;
}
function renderFilters(routeId) { return getSidebarFilters().render(routeId); }
function retainFilterRenderingForRoute(routeId) { return getSidebarFilters().retain(routeId); }
function renderRepoFilter(routeId) { return getSidebarFilters().renderRepos(routeId); }
function renderExtensionFilter(routeId) { return getSidebarFilters().renderExtensions(routeId); }
function renderFilterFolderTree() { getSidebarFilters(); sidebarFolderTree.render(); }
function refreshFilterFolderSelectionState() { getSidebarFilters(); sidebarFolderTree.refresh(); }
function setAllFoldersCollapsed(collapsed) { getSidebarFilters(); sidebarFolderTree.setAllCollapsed(collapsed); }
function persistFolderSelection(subtrees, selfs) { getSidebarFilters(); sidebarFolderTree.persistSelection(subtrees, selfs); }

const quotation = VoiceOfMLQuotation.create({ element: () => DOM.hitokoto });
function setupHitokoto() { quotation.setup(); }

// Discovery owns random selection; asset loading and Reader/download lifecycles stay shared.
let randomDiscovery;
var randomReaderRequestId = 0;
function getRandomDiscovery() {
  return randomDiscovery || (randomDiscovery = VoiceOfMLRandomDiscovery.create({
    readView: () => ({ dataLoaded: STATE.dataLoaded, repoFull: STATE.repoFull, repo: STATE.repo, mode: STATE.mode }),
    requests: { get id() { return randomReaderRequestId; }, set id(value) { randomReaderRequestId = value; } },
    button: () => DOM.randomTxtBtn,
    apiBase: API_BASE,
    nativeCount: () => STATE.repoFull ? (readerMetadata.byRepo[STATE.repoFull] || 0) : (readerMetadata.count || 0),
    assetsLoaded: () => !!readerAssetController.state.assets,
    loadReaderAssets: () => loadReaderAssets(),
    getConvertedReaderRecords: repo => getConvertedReaderRecords(repo),
    localRecord: (repo, readerOnly) => corpusWorkerRequest("random-record", { repo, readerOnly }, WORKER_REQUEST_TIMEOUT),
    ensureLocalDataLoaded: () => ensureLocalDataLoaded(false, true),
    fetchStatus: (url, timeout) => fetchJsonWithTimeout(url, timeout),
    getRecordLink: rec => getRecordLink(rec),
    getReaderLink: (rec, returnUrl) => getReaderLink(rec, returnUrl),
    navigateToReader: (url, returnUrl) => navigateToReader(url, returnUrl),
    downloadFile: (filename, link, options) => downloadFile(filename, link, options),
    showToast: message => showToast(message),
    getRandomLocal: readerOnly => getRandomLocal(readerOnly),
    fetchRandomReaderRecord: (url, id, returnUrl) => fetchRandomReaderRecord(url, id, returnUrl),
    openReaderRecord: (rec, returnUrl) => openReaderRecord(rec, returnUrl)
  }));
}
async function getRandomLocal(readerOnly) {
  return getRandomDiscovery().getRandomLocal(readerOnly);
}
async function randomBook() {
  return getRandomDiscovery().randomBook();
}
async function fetchRandomReaderRecord(url, requestId, returnUrl) {
  return getRandomDiscovery().fetchRandomReaderRecord(url, requestId, returnUrl);
}
function openReaderRecord(rec, returnUrl) {
  return getRandomDiscovery().openReaderRecord(rec, returnUrl);
}
async function randomTxt() {
  return getRandomDiscovery().randomTxt();
}
let toastTimer;

function showToast(msg, dur) {
  announceSearchStatus(msg);
  dur = dur || 2000;
  DOM.toast.textContent = msg;
  DOM.toast.style.display = "";
  DOM.toast.style.animation = "none";
  void DOM.toast.offsetWidth;
  DOM.toast.style.animation = "toast-in 0.2s ease";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() {
    DOM.toast.style.display = "none";
  }, dur);
}
let scrollLoadTimer = null;
let scrollRecoveryTimer = null;
var selectedIndices = {};
var lastSelectedIndex = -1;

function readPagingView() {
  return {
    generation: searchRequestId, loadedPage: STATE._loadedPage, page: STATE.page,
    resultCount: STATE.results.length, hasMore: STATE.hasMore, loading: STATE.isLoading,
    suspended: !!resultSnapshots.cloneTask || !!positionRestore,
    inactive: document.hidden || !!readerHost.overlay, dragging: VSCROLL.isDraggingThumb,
    scrollTop: getResultScrollTop(), loadedHeight: getVirtualTotalHeight(),
    viewportHeight: DOM.resultsContainer ? DOM.resultsContainer.clientHeight : 0,
    appendScrollTop: STATE._pagingAppendScrollTop
  };
}
const pagingStatus = VoiceOfMLPagingStatus.create({
  getHost: () => DOM.loadInfo, revealHost: false,
  retry: () => pagingController.retry()
});
const pagingController = VoiceOfMLPagingController.create({
  policy: VoiceOfMLPagingPolicy,
  clock: { now: () => Date.now(), setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: timer => clearTimeout(timer) },
  readView: readPagingView,
  expireRequests: () => expireSearchRequests(),
  append: (page, scrollTop) => {
    STATE._pagingAppendScrollTop = scrollTop;
    STATE.page = page;
    doSearch(true);
  },
  onState: recovery => {
    pagingFailures = recovery.failures;
    pagingStatus.render(readPagingView(), recovery);
  }
});
function updatePagingStatus() {
  pagingController.updateStatus();
}
function resetPagingRecovery() {
  pagingController.reset();
}
function scheduleBottomLoad(delay = 0, readyPage = 0) {
  pagingController.schedule(delay, readyPage);
}
function finishPagingAttempt(success, error) {
  pagingController.finish(success, !!error && error.status >= 400 && error.status < 500 && !isRecoverableSearchError(error));
}
function retryBottomPage() {
  pagingController.retryBottom();
}
function maybeLoadNextPage(bottomOnly = false, retry = false) {
  pagingController.maybeLoad(bottomOnly, retry);
}

function consumeDeferredSearchAppend() {
  if (!STATE._deferredAppendWhileDragging) return false;
  STATE._deferredAppendWhileDragging = false;
  return consumeCachedAppendPage();
}

function recoverScrollState() {
  cancelQuickScroll();
  expireSearchRequests();
  if (!STATE.isLoading) resetPagingRecovery();
  scrollRecoveryTimer = null;
  if (VSCROLL.renderFrame) cancelAnimationFrame(VSCROLL.renderFrame);
  VSCROLL.renderFrame = 0;
  VSCROLL.renderAfterScroll = false;
  if (scrollLoadTimer) {
    clearTimeout(scrollLoadTimer);
    scrollLoadTimer = null;
  }
  VSCROLL.isDraggingThumb = false;
  if (consumeDeferredSearchAppend()) return;
  VSCROLL.renderStart = -1;
  VSCROLL.renderEnd = -1;
  renderVisible();
  updateScrollTrack();
  prefetchNextPage();
  scheduleScrollLoad(0);
  recoverSidebarState();
}

function recoverSidebarState() {
  if (!DOM.sidebarContent) return;
  var stuck = DOM.sidebarContent.querySelector(".sidebar-loading");
  if (!stuck) return;
  browserApiPending.clear();
  getSidebarDirectory().resetRetries();
  renderSidebar(routeRenderId);
  if (STATE.rightSidebarOpen) renderFilters(routeRenderId);
}

function scheduleScrollRecovery(delay) {
  if (delay === undefined) delay = 0;
  if (scrollRecoveryTimer) clearTimeout(scrollRecoveryTimer);
  scrollRecoveryTimer = setTimeout(recoverScrollState, delay);
}

function scheduleScrollLoad(delay) {
  if (VSCROLL.isDraggingThumb && delay > 0) return;
  if (scrollLoadTimer) clearTimeout(scrollLoadTimer);
  scrollLoadTimer = setTimeout(function() {
    scrollLoadTimer = null;
    if (VSCROLL.isDraggingThumb) return;
    if (consumeDeferredSearchAppend()) return;
    maybeLoadNextPage();
  }, delay);
}

function updateScrollTrack() {
  if (DOM.scrollTrack) {
    DOM.scrollTrack.style.top = DOM.resultsContainer.offsetTop + "px";
    DOM.scrollTrack.style.height = DOM.resultsContainer.clientHeight + "px";
    DOM.scrollTrack.style.bottom = "auto";
    DOM.scrollTrack.style.right = "";
    updateScrollThumb();
  }
}

function setupVirtualScroll() {
  DOM.resultsContainer.addEventListener("wheel", event => { if (event.deltaY > 0) retryBottomPage(); }, { passive: true });
  DOM.resultsContainer.addEventListener("touchend", retryBottomPage, { passive: true });
  DOM.resultsContainer.addEventListener("scrollend", () => scheduleBottomLoad(), { passive: true });
  DOM.resultsContainer.addEventListener("scroll", () => {
    updateCurrentResultPosition();
    readerReturnPosition.cancelOnScroll();
    if (!VSCROLL.isDraggingThumb) ensureVirtualViewportCovered();
    scheduleVirtualRender(true);
  }, { passive: true });
}

function updateScrollThumb() {
  const scrollTop = getResultScrollTop();
  const drag = VSCROLL.dragMetrics;
  const scrollHeight = drag ? drag.scrollHeight : getVirtualTotalHeight();
  const clientHeight = DOM.resultsContainer.clientHeight;
  if (scrollHeight <= clientHeight || !DOM.scrollTrack.clientHeight) { DOM.scrollTrack.classList.remove("visible"); return; }
  DOM.scrollTrack.classList.add("visible");
  const trackHeight = drag ? drag.trackHeight : DOM.scrollTrack.clientHeight;
  const th = drag ? drag.thumbHeight : Math.max(40, Math.min(trackHeight, (clientHeight / scrollHeight) * trackHeight));
  const tt = Math.min(1, scrollTop / Math.max(1, scrollHeight - clientHeight)) * (trackHeight - th);
  DOM.scrollThumb.style.height = th + "px";
  DOM.scrollThumb.style.transform = "translateY(" + tt + "px)";
}

let cancelQuickScroll = () => {};
function setupQuickScroll() {
  let startY, startST, dragRange, maxScrollTop;
  let dragFrame = 0;
  let pendingScrollTop = null;
  function applyPendingScrollTop() {
    dragFrame = 0;
    if (pendingScrollTop === null || !VSCROLL.isDraggingThumb) return;
    setResultScrollTop(pendingScrollTop);
    pendingScrollTop = null;
    renderVisible();
    updateScrollThumb();
  }
  function queueResultScrollTop(value) {
    pendingScrollTop = Math.max(0, Math.min(value, maxScrollTop));
    if (!dragFrame) dragFrame = requestAnimationFrame(applyPendingScrollTop);
  }
  function beginDrag(clientY) {
    cancelQuickScroll();
    updateScrollTrack();
    const scrollEl = DOM.resultsContainer;
    startY = clientY;
    startST = getResultScrollTop();
    dragRange = Math.max(1, DOM.scrollTrack.clientHeight - DOM.scrollThumb.clientHeight);
    maxScrollTop = Math.max(0, getVirtualTotalHeight() - scrollEl.clientHeight);
    VSCROLL.isDraggingThumb = true;
    VSCROLL.dragMetrics = { scrollHeight: getVirtualTotalHeight(), trackHeight: DOM.scrollTrack.clientHeight, thumbHeight: DOM.scrollThumb.clientHeight };
    DOM.resultsList.style.minHeight = Math.min(RESULT_SCROLL_SEGMENT_HEIGHT, scrollEl.scrollHeight) + "px";
  }
  function finishDrag() {
    if (dragFrame) cancelAnimationFrame(dragFrame);
    const requestedScrollTop = pendingScrollTop;
    applyPendingScrollTop();
    const finalScrollTop = requestedScrollTop === null ? getResultScrollTop() : requestedScrollTop;
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
    setResultScrollTop(finalScrollTop);
    renderVisible();
    VSCROLL.isDraggingThumb = false;
    VSCROLL.dragMetrics = null;
    DOM.resultsList.style.minHeight = "";
    updateScrollTrack();
  }
  function onMouseMove(e) {
    if (!VSCROLL.isDraggingThumb) return;
    moveDrag(e.clientY);
  }
  function moveDrag(clientY) {
    queueResultScrollTop(startST + (clientY - startY) / dragRange * maxScrollTop);
  }
  function completeDrag() {
    finishDrag();
    if (!consumeDeferredSearchAppend()) maybeLoadNextPage();
  }
  function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    completeDrag();
  }
  DOM.scrollThumb.addEventListener("mousedown", (e) => {
    beginDrag(e.clientY); e.preventDefault(); e.stopPropagation();
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
  function onTouchMove(e) {
    if (!VSCROLL.isDraggingThumb) return;
    e.preventDefault();
    moveDrag(e.touches[0].clientY);
  }
  function onTouchEnd() {
    document.removeEventListener("touchmove", onTouchMove);
    document.removeEventListener("touchend", onTouchEnd);
    document.removeEventListener("touchcancel", onTouchCancel);
    completeDrag();
  }
  function onTouchCancel() {
    cancelQuickScroll();
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
    renderVisible();
  }
  DOM.scrollThumb.addEventListener("touchstart", (e) => {
    beginDrag(e.touches[0].clientY); e.stopPropagation();
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd);
    document.addEventListener("touchcancel", onTouchCancel);
  });
  cancelQuickScroll = () => {
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    pendingScrollTop = null;
    VSCROLL.isDraggingThumb = false;
    VSCROLL.dragMetrics = null;
    DOM.resultsList.style.minHeight = "";
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("touchmove", onTouchMove);
    document.removeEventListener("touchend", onTouchEnd);
    document.removeEventListener("touchcancel", onTouchCancel);
  };
  window.addEventListener("blur", cancelQuickScroll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelQuickScroll(); });
}

let shell = null;
function getShell() {
  return shell || (shell = VoiceOfMLShell.create({
    readState: () => ({ isDark: STATE.isDark, isMobile: STATE.isMobile,
      leftSidebarOpen: STATE.leftSidebarOpen, rightSidebarOpen: STATE.rightSidebarOpen }),
    setDark: value => { STATE.isDark = value; },
    setMobile: value => { STATE.isMobile = value; },
    setSidebars: (left, right) => { STATE.leftSidebarOpen = left; STATE.rightSidebarOpen = right; },
    writePreference: writeSearchPreference,
    notifyReaderTheme: isDark => {
      if (readerHost.overlay && readerHost.overlay.contentWindow) readerHost.overlay.contentWindow.postMessage({ type: "voice-reader-theme-state", theme: isDark ? "dark" : "light" }, location.origin);
    },
    updateSidebarHeader, updateSelectionUI,
    scheduleScrollTrack: () => requestAnimationFrame(updateScrollTrack),
    syncURL: () => syncStateToURL(),
    view: VoiceOfMLShellView.create(() => ({ themeBtn: DOM.themeBtn, themeIconLight: DOM.themeIconLight,
      themeIconDark: DOM.themeIconDark, mobileToggleBtn: DOM.mobileToggleBtn,
      mobileIconPhone: DOM.mobileIconPhone, mobileIconDesktop: DOM.mobileIconDesktop,
      leftSidebar: DOM.leftSidebar, rightSidebar: DOM.rightSidebar, hamburgerBtn: DOM.hamburgerBtn,
      settingsBtn: DOM.settingsBtn, overlay: DOM.overlay }), true)
  }));
}
function toggleTheme() { getShell().toggleTheme(); }
function applyTheme() { getShell().applyTheme(); }
function toggleMobile() { getShell().toggleMobile(); }
function applyMobileMode() { getShell().applyMobileMode(); }
function autoDetectMobile() { return window.innerWidth <= 768; }
function focusSearchSidebar(sidebar) { VoiceOfMLShellView.focusSearchSidebar(sidebar); }
function toggleLeftSidebar(event) { getShell().toggleLeftSidebar(event); }
function toggleRightSidebar(event) { getShell().toggleRightSidebar(event); }
function updateSidebarVisibility() { getShell().updateSidebarVisibility(); }
let keyboardResultIndex = -1;

function focusKeyboardResult(index) {
  keyboardResultIndex = Math.max(0, Math.min(index, STATE.results.length - 1));
  const top = getVirtualOffset(keyboardResultIndex);
  const bottom = getVirtualOffset(keyboardResultIndex + 1);
  const viewTop = getResultScrollTop();
  const viewBottom = viewTop + DOM.resultsContainer.clientHeight;
  if (top < viewTop || bottom > viewBottom) {
    setResultScrollTop(top);
  }
  VSCROLL.renderStart = 0;
  VSCROLL.renderEnd = 0;
  renderVisible();
  DOM.resultsList.querySelectorAll(".result-item.keyboard-focus").forEach(function(item) { item.classList.remove("keyboard-focus"); });
  var el = DOM.resultsList.querySelector('.result-item[data-index="' + keyboardResultIndex + '"]');
  if (el) { el.classList.add("keyboard-focus"); el.focus({ preventScroll: true }); }
}

function setupKeyboard() {
  document.querySelector('.skip-link').addEventListener('click', event => {
    event.preventDefault(); hideSearchHistory();
    if (STATE.isMobile && (STATE.leftSidebarOpen || STATE.rightSidebarOpen)) {
      STATE.leftSidebarOpen = false; STATE.rightSidebarOpen = false;
      updateSidebarVisibility(); syncStateToURL();
    }
    DOM.resultsContainer.focus({ preventScroll: true });
  });
  document.addEventListener("keydown", function(e) {
    if (e.defaultPrevented || e.isComposing || searchComposing || e.keyCode === 229 || readerHost.overlay) return;
    const target = e.target instanceof Element ? e.target : document.activeElement;
    if (e.key === 'Escape' && target.closest('.sidebar')) {
      e.preventDefault();
      if (target.closest('#right-sidebar')) closeRightSidebar();
      else closeLeftSidebar();
      return;
    }
    const isInput = (target instanceof HTMLElement && target.isContentEditable) || !!target.closest("input, textarea, select");
    if (isInput && !(target === DOM.searchInput && e.key === "Escape")) return;
    if (["Enter", "ArrowDown", "ArrowUp"].includes(e.key) && target.closest("button, a, [role='button']")) return;
    if (e.key === "/" && !isInput) {
      e.preventDefault();
      DOM.searchInput.focus();
      DOM.searchInput.select();
      return;
    }
    if (e.key === "Escape") {
      if (STATE.rightSidebarOpen) { closeRightSidebar(); return; }
      if (STATE.leftSidebarOpen) { closeLeftSidebar(); return; }
      if (DOM.searchInput.value) {
        submitSearchQuery("", { clearResults: true, updateInput: true });
        return;
      }
      DOM.searchInput.blur();
      return;
    }
    if (e.key === "b" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      toggleLeftSidebar(e);
      return;
    }
    if (target.closest('.sidebar')) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (STATE.results.length === 0) return;
      e.preventDefault();
      if (e.key === "ArrowDown") focusKeyboardResult(keyboardResultIndex < 0 ? 0 : keyboardResultIndex + 1);
      else focusKeyboardResult(keyboardResultIndex < 0 ? 0 : keyboardResultIndex - 1);
      return;
    }
    if (e.key === "Enter") {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (keyboardResultIndex >= 0 && keyboardResultIndex < STATE.results.length) {
        const rec = STATE.results[keyboardResultIndex];
        if (!rec) { loadResultWindowPage(Math.floor(keyboardResultIndex / STATE.pageSize) + 1); return; }
        if (rec) openExternalWindow(getRecordLink(rec));
        return;
      }
    }
  });
  DOM.searchInput.addEventListener("keydown", function(e) {
    if (e.isComposing || searchComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      submitSearchQuery(DOM.searchInput.value.trim(), { record: true, clearResults: true, blur: true });
    }
  });
}

function clearAllFilters() {
  STATE.filterRepos = [];
  STATE.filterExtensions = [];
  STATE.filterFolders = [];
  STATE.filterFolderSubtrees = [];
  STATE.filterFolderSelfs = [];
  saveStoredExtensionFilters();
  STATE.filterMinSize = null;
  STATE.filterMaxSize = null;
  DOM.filterMinSize.value = "";
  DOM.filterMaxSize.value = "";
  renderFilters(routeRenderId);
  doFilterSearch(true);
  showToast("已清空所有筛选条件");
  syncStateToURL();
}

let resultInteractions = null;
function getResultInteractions() {
  if (!resultInteractions) resultInteractions = VoiceOfMLResultInteractions.create({
    elements: {
      resultsList: DOM.resultsList, sidebarContent: DOM.sidebarContent,
      multiSelectToggle: DOM.multiSelectToggle, multiCopyLinks: DOM.multiCopyLinks,
      multiBatchDownload: DOM.multiBatchDownload, multiDeselect: DOM.multiDeselect,
      multiSelectAll: DOM.multiSelectAll,
    },
    selection: {
      get indices() { return selectedIndices; }, set indices(value) { selectedIndices = value; },
      get lastIndex() { return lastSelectedIndex; }, set lastIndex(value) { lastSelectedIndex = value; },
    },
    hasRecord: index => !!(STATE.results[index] || resultSnapshots.cloneTask?.snapshot.results[index]),
    selectionRecords: () => resultSnapshots.cloneTask?.snapshot.results || STATE.results,
    resultCount: () => STATE.results.length,
    updateSelectionUI: () => updateSelectionUI(), getSelectedFiles: () => getSelectedFiles(),
    getCopyableLink: link => getCopyableLink(link), startDownloadBatch: items => startDownloadBatch(items),
    showToast: message => showToast(message),
    retryWindowPage(page) {
      if (!resultWindow) return false;
      if (resultWindow.invalid) restartResultWindow();
      else { resultWindow.failures.delete(page); loadResultWindowPage(page); }
      return true;
    },
    recordForRow: row => resultRowRecords.get(row),
    freshReaderLink: record => getReaderLink(applyReaderAsset(
      record, record.Repo || "", buildRecordRelativePath(record), getRecordLink(record))),
    downloadFile: (filename, link, options) => downloadFile(filename, link, options),
    navigateToReader: url => navigateToReader(url),
    navigateRepo: (repo, ...path) => ROUTER.navigate("repo", repo, ...path),
    currentRepo: () => STATE.repo,
    buildSearchURLParams: options => buildSearchURLParams(options),
    renderBrowser: folder => renderBrowser(folder, routeRenderId),
  });
  return resultInteractions;
}
function setupResultDelegation() { getResultInteractions().installDelegation(); }

async function init() {
  cacheDOM();
  renderDownloadBatch();
  getSidebarScroll().install();
  syncSearchInputState();
  setupSearchInput();
  // Session and position databases are independent; start both without
  // serializing their I/O. Route handling still waits for both to settle.
  const positionsReady = initSearchPositions();
  const restoredSession = restoreSearchSession();
  await positionsReady;
  setupSearchPositionControls();
  setupSearchPositionSaving();
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  STATE.sessionRestored = await restoredSession;
  setupReaderIntentWarming();
  STATE.isDark = readSearchPreference("theme") !== "light";
  applyTheme();
  const savedMobile = readSearchPreference("mobileMode");
  if (savedMobile === "mobile") STATE.isMobile = true;
  else if (savedMobile === "desktop") STATE.isMobile = false;
  else STATE.isMobile = autoDetectMobile();
  applyMobileMode();
  setupSearchHistory();
  DOM.historyToggle.addEventListener("change", function() {
    STATE.recordHistory = DOM.historyToggle.checked;
    if (!STATE.recordHistory) saveHistory([]);
  });
  if (DOM.mirrorLinksToggle) DOM.mirrorLinksToggle.addEventListener("change", function() {
    STATE.useMirrorLinks = DOM.mirrorLinksToggle.checked;
    syncStateToURL();
    clearResultTemplateCache();
    if (STATE.results.length > 0) renderResults();
  });
  getResultInteractions().installSelection();
  DOM.hamburgerBtn.addEventListener("click", toggleLeftSidebar);
  DOM.settingsBtn.addEventListener("click", toggleRightSidebar);
  DOM.closeFiltersBtn.addEventListener("click", closeRightSidebar);
  DOM.sidebarExpandBtn.addEventListener("click", function() {
    DOM.leftSidebar.classList.toggle("expanded-wide");
    updateSidebarHeader();
    syncStateToURL();
  });
  DOM.sidebarBackBtn.addEventListener("click", returnFromSidebar);
  DOM.themeBtn.addEventListener("click", toggleTheme);
  DOM.mobileToggleBtn.addEventListener("click", toggleMobile);
  DOM.clearFiltersBtn.addEventListener("click", clearAllFilters);
  DOM.repoFilterCancel.addEventListener("click", function() {
    STATE.filterRepos = [];
    updateFilterCancelButtons();
    renderRepoFilter(routeRenderId);
    scheduleFilterSearch(true);
  });
  DOM.folderFilterCancel.addEventListener("click", function() {
    persistFolderSelection(new Set(), new Set());
    refreshFilterFolderSelectionState();
  });
  DOM.extFilterCancel.addEventListener("click", function() {
    STATE.filterExtensions = [];
    saveStoredExtensionFilters();
    updateFilterCancelButtons();
    renderExtensionFilter(routeRenderId);
    scheduleFilterSearch(true);
  });
  DOM.searchFoldersToggle.addEventListener("change", function() {
    STATE.searchFolders = DOM.searchFoldersToggle.checked;
    clearResultTemplateCache();
    doFilterSearch(true);
  });
  DOM.exactSearchToggle.addEventListener("change", function() {
    STATE.exact = DOM.exactSearchToggle.checked;
    doFilterSearch(true);
  });
  DOM.localModeToggle.addEventListener("change", function() {
    STATE.useLocalMode = DOM.localModeToggle.checked;
    // Keep the switch visible in both backends: the Worker implements exact
    // mode, and a hidden but focusable control changed results unexpectedly.
    setExactSearchSectionVisible(true, true);
    if (DOM.exactSearchToggle) DOM.exactSearchToggle.checked = STATE.exact;
    doFilterSearch(true);
    syncStateToURL();
  });
  DOM.sortSelect.addEventListener("change", function() {
    STATE.sort = normalizeSearchSort(DOM.sortSelect.value);
    doFilterSearch(true);
    syncStateToURL();
  });
  DOM.overlay.addEventListener("click", function() {
    if (STATE.leftSidebarOpen) closeLeftSidebar();
    else if (STATE.rightSidebarOpen) closeRightSidebar();
  });
  DOM.randomBookBtn.addEventListener("click", randomBook);
  if (DOM.randomTxtBtn) DOM.randomTxtBtn.addEventListener("click", randomTxt);
  DOM.emptyRandomBtn.addEventListener("click", randomTxt);
  setupSizeFilterControls();
  DOM.extSelectAll.addEventListener("click", function() {
    var allExtensions = STATE.extensionList.slice();
    var selected = new Set(STATE.filterExtensions);
    STATE.filterExtensions = allExtensions.length > 0 && allExtensions.every(function(extension) { return selected.has(extension); }) ? [] : allExtensions;
    saveStoredExtensionFilters();
    renderExtensionFilter(routeRenderId);
    scheduleFilterSearch();
  });
  DOM.extDeselectAll.addEventListener("click", function() {
    var allExtNames = STATE.extensionList.slice();
    var currentSet = new Set(STATE.filterExtensions);
    STATE.filterExtensions = allExtNames.filter(function(e) { return !currentSet.has(e); });
    saveStoredExtensionFilters();
    renderExtensionFilter(routeRenderId);
    scheduleFilterSearch();
  });
  if (DOM.folderToggleAll) DOM.folderToggleAll.addEventListener("click", () =>
    setAllFoldersCollapsed(DOM.folderToggleAll.getAttribute("aria-expanded") === "true"));
  DOM.folderSelectAll.addEventListener("click", () => { getSidebarFilters(); sidebarFolderTree.selectAll(); });
  DOM.folderDeselectAll.addEventListener("click", () => { getSidebarFilters(); sidebarFolderTree.invertSelection(); });
  setupVirtualScroll();
  setupQuickScroll();
  setupKeyboard();
  setupResultDelegation();
  setupDownloadIntentWarming();
  window.addEventListener("message", handleReaderMessage);
  window.addEventListener("popstate", function(event) {
    // System back leaves the Reader even with its directory/search panel open.
    // Re-pushing an entry here (without a user activation) made Chromium mark
    // the whole search document skippable, so the next swipe skipped it.
    if (event.state?.voiceReaderOverlay) {
      restoreReaderOverlay(event.state);
      return;
    }
    // Setting location.hash can emit popstate before the caller returns.
    // Ordinary hash navigation belongs to hashchange; only Reader exits need
    // immediate reconciliation here (including traversals across two entries).
    if (readerHost.overlay) reconcileSearchDestination();
  });
  window.addEventListener("hashchange", function() {
    if (readerHost.overlay || appliedRouteHash === window.location.hash) return;
    reconcileSearchDestination();
  });
  window.addEventListener("resize", function() {
    if (!readSearchPreference("mobileMode")) {
      var wasMobile = STATE.isMobile;
      STATE.isMobile = autoDetectMobile();
      if (wasMobile !== STATE.isMobile) applyMobileMode();
    }
    scheduleScrollRecovery(60);
  });
  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "visible") {
      scheduleScrollRecovery();
      warmConnection(true);
    }
  });
  window.addEventListener("pageshow", function() { scheduleScrollRecovery(); });
  window.addEventListener("focus", function() { scheduleScrollRecovery(); warmConnection(); });
  window.addEventListener("online", function() { scheduleScrollRecovery(); warmConnection(true); });
  lastKeepaliveAt = Date.now();
  document.addEventListener("visibilitychange", resumeResultRecovery);
  window.addEventListener("pageshow", resumeResultRecovery);
  window.addEventListener("online", resumeResultRecovery);
  window.setInterval(function() { warmConnection(); }, KEEPALIVE_INTERVAL_MS);
  readerAssetController.scheduling.state.delayUntilPaint = true;
  const initialDraftCurrent = initialSearchDraftIsCurrent();
  ROUTER.apply();
  finishInitialSearchInput(initialDraftCurrent);
  restoreReaderSearchHandoff();
  restoreReaderFromSession();
  // Keep the first search paint independent of the multi-megabyte Reader sidecar.
  // API results already carry Reader fields; the sidecar is only enrichment for
  // local snapshots and directory browsing. Load it on the first real
  // interaction, or six seconds after load when the page never interacts.
  const scheduleReaderAssetsLoad = function() {
    var loaded = false;
    var load = function() {
      if (loaded) return;
      loaded = true;
      for (const type of ["pointerdown", "keydown", "focusin", "touchstart"]) {
        document.removeEventListener(type, load, true);
      }
      loadReaderAssets().then(function() {
        refreshResultReaderActions();
      });
    };
    for (const type of ["pointerdown", "keydown", "focusin", "touchstart"]) {
      document.addEventListener(type, load, { capture: true, passive: true });
    }
    var fallback = function() { setTimeout(load, 6000); };
    if (document.readyState === "complete") fallback();
    else window.addEventListener("load", fallback, { once: true });
  };
  scheduleReaderAssetsLoad();
  setupHitokoto();
}
document.addEventListener("DOMContentLoaded", init);

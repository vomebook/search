const DATA_URL = "data/search_data.json.gz";
const API_BASE = "https://voiceofml-search.hf.space";
const MIRROR_HOST = "hf-mirror.com";
const HF_DATASET_BASE = "https://huggingface.co/datasets";
const WORKER_PROTOCOL_VERSION = 1;
const WORKER_REQUEST_TIMEOUT = 10000;
const WORKER_LOAD_TIMEOUT = 60000;
const APPEND_REQUEST_TIMEOUT = 5000;
const DOWNLOAD_CHECK_TIMEOUT = 8000;
const pendingSearchPages = new Map();
let pagingCheckTimer = null;
let pagingFailures = 0;
let pagingRetryAt = 0;

const ORDERED_EXTENSIONS = [
  "pdf", "txt",
  "epub", "mobi", "azw3", "fb2", "djvu", "chm", "caj",
  "doc", "docx", "odt", "rtf",
  "ppt", "xlsx",
  "jpg", "png", "gif", "tif",
  "html", "htm", "aspx", "css", "js", "xml",
  "mht",
  "mp4", "flv", "swf", "rm", "rmvb",
  "mp3", "wav",
  "iso", "dat", "exe",
];

const FILE_ICON_MAP = {
  pdf: "pdf", txt: "text", mht: "text",
  epub: "book", mobi: "book", azw3: "book", fb2: "book", djvu: "book", chm: "book", caj: "book",
  doc: "doc", docx: "doc", odt: "doc", rtf: "doc",
  ppt: "ppt", pptx: "ppt", pps: "ppt",
  xls: "xls", xlsx: "xls", csv: "csv",
  jpg: "image", jpeg: "image", png: "image", gif: "image", tif: "image", tiff: "image",
  bmp: "image", webp: "image", svg: "image",
  html: "code", htm: "code", aspx: "code", css: "code", js: "code", xml: "code",
  json: "code", ini: "code", bat: "code",
  mp4: "video", flv: "video", swf: "video", rm: "video", rmvb: "video",
  wmv: "video", mpg: "video", mts: "video", f4v: "video", asx: "video",
  mp3: "audio", wav: "audio", wma: "audio", ape: "audio", m4a: "audio", mpga: "audio",
  iso: "archive", msi: "archive", dat: "archive",
  exe: "file", db: "database", itf: "database",
  url: "text", vcf: "text", hhc: "text",
  md: "markdown", markdown: "markdown",
};

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

let extensionCounts = {};
let repoExtensionCounts = {};
let repoList = [];
let extensionList = [];
let txtMetadata = { available: false, count: 0, byRepo: {} };
let readerMetadata = { available: false, count: 0, byRepo: {} };
let corpusWorker = null;
let corpusWorkerStartPromise = null;
let corpusWorkerRequestId = 0;
let corpusWorkerRestartCount = 0;
const corpusWorkerPending = new Map();
const folderTreeCache = new Map();

let keepalivePending = null;
let lastKeepaliveAt = 0;
const KEEPALIVE_INTERVAL_MS = 45 * 1000;
const KEEPALIVE_MIN_GAP_MS = 30 * 1000;

function setExactSearchSectionVisible(visible, animate) {
  if (!DOM.exactSearchSection) return;
  if (!animate) DOM.exactSearchSection.style.transition = "none";
  DOM.exactSearchSection.classList.toggle("exact-section-hidden", !visible);
  if (!animate) {
    void DOM.exactSearchSection.offsetHeight;
    DOM.exactSearchSection.style.transition = "";
  }
}

function buildRecordRelativePath(rec) {
  const filename = rec.File || "";
  const extension = rec.Extension || "";
  const fullName = extension ? filename + "." + extension : filename;
  const folders = Array.isArray(rec.Folder) ? rec.Folder : [];
  return folders.length > 0 ? folders.join("/") + "/" + fullName : fullName;
}

function buildRecordLink(rec) {
  const repo = rec.Repo || "";
  return HF_DATASET_BASE + "/" + repo + "/resolve/main/" + encodeRecordPath(buildRecordRelativePath(rec));
}

function buildRecordPath(rec) {
  const repo = rec.Repo || "";
  return HF_DATASET_BASE + "/" + repo + "/blob/main/" + encodeRecordPath(buildRecordRelativePath(rec));
}

function encodeRecordPath(path) {
  return String(path || "").split("/").map(encodeURIComponent).join("/");
}

var readerAssets = null;
var readerAssetsPending = null;
var readerAssetsRetryAt = 0;
var convertedReaderRecords = null;
var READER_ASSETS_COMPRESSED_LIMIT = 32 * 1024 * 1024;
var READER_ASSETS_EXPANDED_LIMIT = 128 * 1024 * 1024;

function readBoundedReaderStream(stream, limit, signal) {
  if (!stream || typeof stream.getReader !== "function") throw new Error("READER_ASSETS_UNAVAILABLE");
  var reader = stream.getReader(), chunks = [], total = 0;
  var abort = function() { reader.cancel().catch(function() {}); };
  if (signal) signal.addEventListener("abort", abort, { once: true });
  return (async function() {
    try {
      while (true) {
        if (signal && signal.aborted) throw new DOMException("Reader assets timed out", "AbortError");
        var part = await reader.read();
        if (signal && signal.aborted) throw new DOMException("Reader assets timed out", "AbortError");
        if (part.done) break;
        if (!part.value || !part.value.byteLength) continue;
        total += part.value.byteLength;
        if (total > limit) throw new Error("READER_ASSETS_LIMIT");
        chunks.push(part.value);
      }
      var bytes = new Uint8Array(total), offset = 0;
      chunks.forEach(function(chunk) { bytes.set(chunk, offset); offset += chunk.byteLength; });
      return bytes;
    } catch (error) {
      await Promise.resolve(reader.cancel(error)).catch(function() { return undefined; });
      throw error;
    } finally {
      if (signal) signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  })();
}

async function fetchReaderAssetMap() {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 10000);
  try {
    var response = await fetch("/search/data/reader_assets.json.gz", { signal: controller.signal });
    if (!response.ok || !response.body || typeof DecompressionStream === "undefined") throw new Error("READER_ASSETS_UNAVAILABLE");
    var compressedLength = Number(response.headers && response.headers.get && response.headers.get("content-length"));
    if (Number.isFinite(compressedLength) && compressedLength > READER_ASSETS_COMPRESSED_LIMIT) {
      await Promise.resolve().then(function() { return response.body.cancel(); }).catch(function() { return undefined; });
      throw new Error("READER_ASSETS_LIMIT");
    }
    var compressed = await readBoundedReaderStream(response.body, READER_ASSETS_COMPRESSED_LIMIT, controller.signal);
    var expandedStream = new Response(compressed).body.pipeThrough(new DecompressionStream("gzip"));
    var expanded = await readBoundedReaderStream(expandedStream, READER_ASSETS_EXPANDED_LIMIT, controller.signal);
    var data = JSON.parse(new TextDecoder().decode(expanded));
    if (!data || data.v !== 1 || !data.f || typeof data.f !== "object") throw new Error("READER_ASSETS_UNAVAILABLE");
    return data.f;
  } finally {
    clearTimeout(timer);
  }
}

function loadReaderAssets() {
  if (readerAssets) return Promise.resolve(readerAssets);
  if (Date.now() < readerAssetsRetryAt) return Promise.resolve({});
  if (readerAssetsPending) return readerAssetsPending;
  readerAssetsPending = fetchReaderAssetMap().then(function(assets) {
    readerAssets = assets;
    readerAssetsRetryAt = 0;
    convertedReaderRecords = null;
    return readerAssets;
  }).catch(function() {
    readerAssetsRetryAt = Date.now() + 5000;
    return {};
  }).finally(function() { readerAssetsPending = null; });
  return readerAssetsPending;
}

function applyReaderAsset(record, repo, relativePath, originalLink) {
  var asset = readerAssets && readerAssets[repo + "\0" + relativePath];
  var fields = VoiceOfMLReader.assetFields(asset, API_BASE + "/api/reader-bucket-resource");
  return fields ? Object.assign({}, record, fields, { DownloadLink: originalLink }) : record;
}

function getConvertedReaderRecords(repo) {
  if (!convertedReaderRecords) {
    convertedReaderRecords = [];
    Object.keys(readerAssets || {}).forEach(function(key) {
      var separator = key.indexOf("\0");
      if (separator <= 0) return;
      var sourceRepo = key.substring(0, separator);
      var relativePath = key.substring(separator + 1);
      var parts = relativePath.split("/");
      var filename = parts.pop() || "";
      var dot = filename.lastIndexOf(".");
      if (!sourceRepo.startsWith("VoiceOfML/") || dot <= 0 || parts.some(function(part) { return !part || part === "." || part === ".."; })) return;
      var record = { Repo: sourceRepo, File: filename.substring(0, dot), Extension: filename.substring(dot + 1), Folder: parts, HasTxt: false };
      var originalLink = buildRecordLink(record);
      var converted = applyReaderAsset(record, sourceRepo, relativePath, originalLink);
      if (converted !== record) convertedReaderRecords.push(converted);
    });
  }
  return repo ? convertedReaderRecords.filter(function(record) { return record.Repo === repo; }) : convertedReaderRecords;
}

function getRecordLink(rec) {
  return rec.Link || buildRecordLink(rec);
}

function getReaderFolderUrl(rec) {
  var repo = String(rec.Repo || "").split("/").pop();
  if (!repo) return "";
  var folder = Array.isArray(rec.Folder) ? rec.Folder.join("/") : "";
  var sp = currentReaderSearchParams();
  if (folder) sp.append("folder_self", folder);
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

function getReaderLink(rec, returnUrl) {
  returnUrl = returnUrl || location.href;
  const readerRecord = Object.assign({}, rec, { Link: getRecordLink(rec), ReturnUrl: returnUrl, FolderUrl: getReaderFolderUrl(rec) });
  if (rec.HasTxt && String(rec.Extension || "").toLowerCase() !== "txt") {
    const relPath = buildRecordRelativePath(rec);
    readerRecord.OcrUrl = API_BASE + "/txt/" + encodeRecordPath(VoiceOfMLReader.txtRelativePath(relPath));
  }
  var readerUrl = VoiceOfMLReader.readerUrl(readerRecord, "/search/static/reader.html");
  try { var readerId = new URL(readerUrl, location.origin).searchParams.get("id"); if (readerId) { var sourceData = { url: readerRecord.ReaderLink || readerRecord.Link, download: readerRecord.Link, title: readerRecord.File, extension: readerRecord.ReaderExtension || readerRecord.Extension, original_extension: readerRecord.Extension, repo: String(readerRecord.Repo || "").split("/").pop(), folder: readerRecord.Folder, chapter_manifest: readerRecord.ReaderChapterManifest || "", fallback: readerRecord.ReaderFallback || "" }; cacheReaderMetadata(readerId, sourceData, true); } } catch (_) {}
  return readerUrl;
}

function syncReaderFolderFilter(rawUrl) {
  try {
    var readerUrl = new URL(rawUrl, location.origin);
    var folderRaw = readerUrl.searchParams.get("folder_url");
    if (!folderRaw) return readerUrl.href;
    var folderUrl = new URL(folderRaw, location.origin);
    var mergedFolderUrl = readerNavigation.mergeSearchParams(folderUrl, currentReaderSearchParams(), {
      hashRoute: true,
      keys: READER_RETURN_SEARCH_KEYS
    });
    readerUrl.searchParams.set("folder_url", mergedFolderUrl.href);
    return readerUrl.href;
  } catch (_) { return rawUrl; }
}

const READER_RETURN_SEARCH_KEYS = Object.freeze([
  "q", "min_size", "max_size", "ext", "history", "mirror", "sort",
  "search_folders", "exact", "local", "sidebar", "filters", "wide"
]);

function currentReaderSearchParams() {
  const params = buildSearchURLParams({ includeQuery: false, displaySizes: true });
  const query = (DOM.searchInput ? DOM.searchInput.value : STATE.query).trim();
  if (query) params.set("q", query);
  return params;
}

function normalizeReaderReturnUrl(rawUrl) {
  try {
    const target = new URL(rawUrl || "/search/", location.origin);
    if (target.origin === location.origin && target.pathname === "/") return new URL("/search/", location.origin).href;
    return target.href;
  } catch (_) { return new URL("/search/", location.origin).href; }
}

var readerOverlay = null;
const readerNavigation = VoiceOfMLReaderNavigation.createNavigation("/search/static/reader.html");
var readerReturnScrollState = null;
var readerReturnSnapshot = null;
var readerReturnRestoreGeneration = 0;
var readerReturnRestoreActive = false;
function captureReaderReturnScroll() {
  if (!DOM.resultsContainer) return null;
  var top = getResultScrollTop(), index = 0, offset = top;
  if (STATE.results.length) {
    ensureHeightTree();
    index = findVirtualIndex(top);
    offset = top - getVirtualOffset(index);
  }
  return { route: location.href, viewKey: getSearchViewKey(), top: top, index: index, offset: offset };
}
function restoreReaderReturnScroll() {
  var saved = readerReturnScrollState;
  if (!saved) return;
  if (saved.route && saved.route !== location.href) { readerReturnScrollState = null; return; }
  if (saved.viewKey && saved.viewKey !== getSearchViewKey()) { readerReturnScrollState = null; return; }
  var generation = ++readerReturnRestoreGeneration;
  var attempts = 0;
  function restore() {
    if (generation !== readerReturnRestoreGeneration) return;
    if (!DOM.resultsContainer || !STATE.results.length) {
      if (++attempts < 20) requestAnimationFrame(restore);
      return;
    }
    ensureHeightTree();
    var index = Math.min(saved.index, STATE.results.length - 1);
    var target = Math.max(0, getVirtualOffset(index) + saved.offset);
    var max = Math.max(0, getVirtualTotalHeight() - DOM.resultsContainer.clientHeight);
    readerReturnRestoreActive = true;
    setResultScrollTop(Math.min(target, max));
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
    renderVisible();
    updateScrollTrack();
    readerReturnRestoreActive = false;
    if (++attempts < 4 && Math.abs(getResultScrollTop() - target) > 1) requestAnimationFrame(restore);
    else readerReturnScrollState = null;
  }
  restore();
  if (readerReturnScrollState === saved) requestAnimationFrame(function() { requestAnimationFrame(restore); });
}
function closeReaderOverlay(restoreFocus, restoreScroll) {
  if (!readerOverlay) return false;
  const returnFocus = readerNavigation.unmount();
  readerOverlay = null;
  if (restoreScroll !== false) {
    var saved = readerReturnScrollState;
    var snapshot = readerReturnSnapshot;
    var source = snapshot && searchSnapshotSources.get(snapshot);
    var currentView = displayedSearchView;
    var sameView = snapshot && source && saved && saved.viewKey === getSearchViewKey() &&
      currentView && currentView.key === saved.viewKey && currentView.revision === source.revision &&
      searchViewSnapshots.get(saved.viewKey) === snapshot;
    var changed = sameView && (STATE.results.length !== snapshot.results.length || STATE._loadedPage !== snapshot.loadedPage);
    if (changed) {
      readerReturnScrollState = null;
      restoreSearchViewSnapshot(saved.viewKey, false);
      readerReturnScrollState = Object.assign({}, saved, { route: location.href });
    }
    restoreReaderReturnScroll();
  }
  if (restoreScroll !== false) readerReturnSnapshot = null;
  if (restoreFocus !== false && returnFocus && returnFocus.isConnected) returnFocus.focus();
  return true;
}

function openReaderOverlay(url, addHistory) {
  if (addHistory !== false && !readerReturnScrollState) {
    readerReturnScrollState = captureReaderReturnScroll();
    readerReturnSnapshot = saveSearchViewSnapshot(readerReturnScrollState && readerReturnScrollState.viewKey || getSearchViewKey());
  }
  readerOverlay = readerNavigation.mount(url);
  if (addHistory !== false) readerNavigation.remember(url, readerReturnScrollState);
}

function restoreReaderOverlay(state) {
  if (!state || !state.voiceReaderOverlay || !state.readerUrl) {
    closeReaderOverlay();
    return;
  }
  try {
    var url = readerNavigation.parse(state.readerUrl);
    closeReaderOverlay(false, false);
    openReaderOverlay(url, false);
  } catch (_) {}
}

function handleReaderMessage(event) {
  if (!readerNavigation.accepts(event)) return;
  var message = event.data || {};
  if (message.type === "voice-reader-close") {
    try {
      var readerUrl = new URL(readerOverlay.src, location.origin);
      var returnUrl = readerUrl.searchParams.get("return");
      var target = returnUrl && new URL(returnUrl, location.origin);
      if ((!history.state || !history.state.voiceReaderOverlay) && target && target.origin === location.origin && target.pathname === "/search/") {
        var returnFocus = readerNavigation.returnFocus;
        closeReaderOverlay(false);
        history.replaceState(null, "", target.href);
        ROUTER.apply();
        if (returnFocus && returnFocus.isConnected) returnFocus.focus();
        return;
      }
    } catch (_) {}
    history.back();
    return;
  }
  if (message.type === "voice-reader-theme") {
    if (message.theme !== "dark" && message.theme !== "light") return;
    STATE.isDark = message.theme === "dark";
    applyTheme();
    localStorage.setItem("theme", message.theme);
    return;
  }
  if (message.type === "voice-reader-open") {
    try {
      readerOverlay = readerNavigation.replace(message.url, readerReturnScrollState);
    } catch (_) {}
    return;
  }
  if (message.type !== "voice-reader-navigate") return;
  try {
    var target = new URL(message.url, location.origin);
    if (target.origin !== location.origin || target.pathname !== "/search/") return;
    var mergedTarget = readerNavigation.mergeSearchParams(target, currentReaderSearchParams(), {
      hashRoute: true,
      keys: READER_RETURN_SEARCH_KEYS
    });
    closeReaderOverlay();
    history.replaceState(null, "", mergedTarget.href);
    ROUTER.apply();
  } catch (_) {}
}

function navigateToReader(rawUrl, returnUrl) {
  returnUrl = normalizeReaderReturnUrl(returnUrl || location.href);
  var url;
  try { url = readerNavigation.prepare(syncReaderFolderFilter(rawUrl), returnUrl); }
  catch (_) { return false; }
  if (STATE.isMobile) { STATE.leftSidebarOpen = false; STATE.rightSidebarOpen = false; updateSidebarVisibility(); }
  openReaderOverlay(url);
  return true;
}

function restoreReaderFromSession() {
  if (readerOverlay) return;
  try {
    var saved = readerNavigation.saved();
    if (!saved || saved.shareUrl !== location.href || !saved.readerUrl) return;
    var readerUrl = readerNavigation.parse(saved.readerUrl);
    readerReturnScrollState = saved.returnScroll || null;
    history.replaceState({ voiceReaderOverlay: true, readerUrl: readerUrl.href }, "", saved.shareUrl);
    openReaderOverlay(readerUrl, false);
  } catch (_) {}
}

var warmedReaderAssets = new Set();
var warmedReaderSources = new Set();
var readerWarmupInFlight = 0;
let readerWarmupPending = null;
const readerWarmupRetryAt = new Map();
function cancelReaderWarmup() {
  if (readerWarmupPending) readerWarmupPending.cancel();
}
function startReaderSourceWarmup(base, readerId, sourceUrl) {
  const key = readerId ? "id:" + readerId : sourceUrl;
  if (!key || readerWarmupPending || warmedReaderSources.size >= 8 || warmedReaderSources.has(key) ||
      Date.now() < (readerWarmupRetryAt.get(key) || 0)) return;
  const controller = new AbortController();
  const task = { cancel() { controller.abort(); finish(false); } };
  const finish = (success) => {
    if (readerWarmupPending !== task) return;
    clearTimeout(timer);
    readerWarmupPending = null;
    readerWarmupInFlight = 0;
    if (success) {
      warmedReaderSources.add(key);
      readerWarmupRetryAt.delete(key);
    } else {
      controller.abort();
      readerWarmupRetryAt.delete(key);
      readerWarmupRetryAt.set(key, Date.now() + 5000);
      if (readerWarmupRetryAt.size > 64) readerWarmupRetryAt.delete(readerWarmupRetryAt.keys().next().value);
    }
  };
  readerWarmupPending = task;
  readerWarmupInFlight = 1;
  const timer = setTimeout(task.cancel, 8000);
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
function warmReaderIntent(rawUrl) {
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
  shellAssets.concat(engineAssets).forEach(function(href) {
    if (warmedReaderAssets.has(href)) return;
    warmedReaderAssets.add(href);
    var link = document.createElement("link"); link.rel = href.indexOf("/foliate-reader/view.js") >= 0 ? "modulepreload" : "prefetch"; link.href = href; document.head.appendChild(link);
  });
  startReaderSourceWarmup(API_BASE, readerId, sourceUrl);
  warmConnection();
}

function setupReaderIntentWarming() {
  window.addEventListener("pagehide", cancelReaderWarmup);
  window.addEventListener("offline", cancelReaderWarmup);
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelReaderWarmup(); });
  var warm = function(event) {
    if (event.target.closest('[data-action="download"], [data-download]')) return;
    var target = event.target.closest("[data-reader-url], [data-read-url]");
    if (target) warmReaderIntent(target.dataset.readerUrl || target.dataset.readUrl);
  };
  ["pointerover", "pointerdown", "focusin"].forEach(function(type) { document.addEventListener(type, warm, { passive: true }); });
}

function isReadableRecord(rec) {
  if (String(rec && (rec.ReaderExtension || rec.Extension) || "").toLowerCase() === "docx" && !rec.ReaderLink) return false;
  return VoiceOfMLReader.capability(rec && (rec.ReaderExtension || rec.Extension)).article;
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

let downloadBatch = null;
const downloadController = VoiceOfMLDownloadController.createDownloadController({
  buildCheckUrl: link => API_BASE + "/api/download/check?link=" + encodeURIComponent(link || ""),
  buildDownloadUrl,
  triggerDownload: url => triggerDownload(url),
  showToast,
  isSpeculativeAllowed: () => !document.hidden && navigator.onLine,
  isBatchActive: () => !!(downloadBatch && !downloadBatch.done),
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
} = downloadController;
Object.defineProperty(globalThis, "activeDownloadChecks", {
  configurable: true,
  get: () => downloadController.activeDownloadChecks,
});

function renderDownloadBatch() {
  const batch = downloadBatch;
  if (!batch) return;
  let panel = document.getElementById("download-queue");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "download-queue";
    panel.className = "download-queue";
    panel.setAttribute("aria-label", "批量下载");
    panel.innerHTML = '<span role="status" aria-live="polite"></span><button type="button" data-queue="cancel">取消待下载</button><button type="button" data-queue="retry">重试失败项</button><button type="button" data-queue="close">关闭</button>';
    panel.addEventListener("click", event => {
      const action = event.target.dataset.queue;
      if (action === "cancel") {
        downloadBatch.cancelled = true;
        downloadBatch.abortController?.abort();
        renderDownloadBatch();
      }
      if (action === "retry" && downloadBatch.done) startDownloadBatch(downloadBatch.failed);
      if (action === "close" && downloadBatch.done) { panel.remove(); downloadBatch = null; }
    });
    document.body.appendChild(panel);
  }
  panel.querySelector('[role="status"]').textContent = `${batch.cancelled ? "已取消待下载 · " : ""}已发起 ${batch.started}/${batch.items.length} · 失败 ${batch.failed.length}。请在浏览器下载列表查看文件进度。`;
  panel.querySelector('[data-queue="cancel"]').hidden = batch.done || batch.cancelled;
  panel.querySelector('[data-queue="retry"]').hidden = !batch.done || !batch.failed.length;
  panel.querySelector('[data-queue="close"]').hidden = !batch.done;
}

function getSelectedFiles() {
  return Object.keys(selectedIndices).map(Number).flatMap(index => {
    const record = STATE.results[index];
    if (!record) return [];
    return [{ filename: record.File + (record.Extension ? "." + record.Extension : ""), link: getRecordLink(record) }];
  });
}

function startDownloadBatch(items) {
  if (downloadBatch && !downloadBatch.done) { showToast("已有批量任务，请先完成或取消"); return; }
  items = Array.from(new Map(items.filter(item => item.link).map(item => [item.link, item])).values());
  if (!items.length) { showToast("未选中任何文件"); return; }
  const batch = {
    items, next: 0, started: 0, failed: [], cancelled: false, done: false,
    abortController: new AbortController(),
  };
  downloadBatch = batch;
  renderDownloadBatch();
  Promise.all([runDownloadBatchWorker(batch), runDownloadBatchWorker(batch)]).then(() => {
    batch.done = true;
    renderDownloadBatch();
  });
}

async function runDownloadBatchWorker(batch) {
  while (!batch.cancelled && batch.next < batch.items.length) {
    const item = batch.items[batch.next++];
    const started = await downloadFile(item.filename, item.link, { quiet: true, batch });
    if (started) batch.started++;
    else if (!batch.cancelled) batch.failed.push(item);
    renderDownloadBatch();
  }
}

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
  if (name.toLowerCase().endsWith("." + ext.toLowerCase())) return name;
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

function bytesToDisplay(bytes) {
  if (bytes === null || bytes === undefined) return { value: "", unit: "MB" };
  if (bytes >= 1073741824) return { value: (bytes / 1073741824).toFixed(2).replace(/\.?0+$/, ""), unit: "GB" };
  if (bytes >= 1048576) return { value: (bytes / 1048576).toFixed(1).replace(/\.0$/, ""), unit: "MB" };
  if (bytes >= 1024) return { value: (bytes / 1024).toFixed(1).replace(/\.0$/, ""), unit: "KB" };
  return { value: String(bytes), unit: "B" };
}

function fmtSizeUrl(bytes) {
  if (bytes === null || bytes === undefined) return null;
  var d = bytesToDisplay(bytes);
  const formatted = d.value + d.unit;
  return parseSizeStr(formatted) === bytes ? formatted : String(bytes) + "B";
}

function parseSizeStr(str) {
  if (!str) return null;
  var m = String(str).match(/^([\d.]+)\s*(GB|MB|KB|B)?$/i);
  if (!m) return parseInt(str) || null;
  var val = parseFloat(m[1]);
  var unit = (m[2] || "B").toUpperCase();
  if (unit === "GB") val *= 1073741824;
  else if (unit === "MB") val *= 1048576;
  else if (unit === "KB") val *= 1024;
  return Math.round(val);
}
var HISTORY_KEY = "voml_search_history";
var HISTORY_MAX = 20;
var EXT_FILTER_STORAGE_KEY = "voml_ext_filter:global";

function getHistory() {
  try {
    return JSON.parse(sessionStorage.getItem(HISTORY_KEY)) || [];
  } catch (e) { return []; }
}

function saveHistory(list) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch (e) {}
}

function mergeFolderFilters(selfs, subtrees) {
  return (selfs || []).concat((subtrees || []).filter(function(path) {
    return (selfs || []).indexOf(path) < 0;
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

function addHistoryItem(q) {
  if (!q || !STATE.recordHistory) return;
  var list = getHistory();
  var idx = list.indexOf(q);
  if (idx >= 0) list.splice(idx, 1);
  list.unshift(q);
  saveHistory(list);
}

function renderDropdown() {
  if (!DOM.historyDropdown) return;
  var list = getHistory();
  if (list.length === 0) { DOM.historyDropdown.style.display = "none"; return; }
  var html = "";
  for (var h = 0; h < list.length; h++) {
    html += '<div class="history-item" data-query="' + escapeHTML(list[h]) + '">' +
      '<svg class="history-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
      '<span class="history-text">' + escapeHTML(list[h]) + '</span>' +
      '<button class="history-del" data-del="' + escapeHTML(list[h]) + '">&times;</button>' +
      '</div>';
  }
  html += '<div class="history-footer"><button class="history-clear-all">清空历史</button></div>';
  DOM.historyDropdown.innerHTML = html;
  DOM.historyDropdown.style.display = "";
}

function removeHistoryItem(q) {
  var list = getHistory();
  var idx = list.indexOf(q);
  if (idx >= 0) list.splice(idx, 1);
  saveHistory(list);
  renderDropdown();
}

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
  var cbs = DOM.resultsList.querySelectorAll(".result-checkbox");
  for (var ci = 0; ci < cbs.length; ci++) {
    var idx = parseInt(cbs[ci].dataset.index);
    cbs[ci].checked = !!selectedIndices[idx];
    var item = cbs[ci].closest(".result-item");
    if (item) item.classList.toggle("selected", !!selectedIndices[idx]);
  }
}

async function loadData() {
  try {
    const metadata = await corpusWorkerRequest("load-corpus", { url: new URL(DATA_URL, document.baseURI).href }, WORKER_LOAD_TIMEOUT);
    repoList = Array.isArray(metadata.repos) ? metadata.repos : [];
    extensionCounts = {};
    for (const item of metadata.extensions || []) extensionCounts[item.name] = item.count || 0;
    repoExtensionCounts = metadata.extensionsByRepo || {};
    extensionList = (metadata.extensions || []).map(function(item) { return item.name; });
    txtMetadata = metadata.txt || { available: false, count: 0, byRepo: {} };
    readerMetadata = metadata.reader || { available: false, count: 0, byRepo: {} };
    return true;
  } catch (e) {
    console.error("Data load failed:", e);
    if (e && e.code === "PROTOCOL_MISMATCH") showToast("本地搜索版本不匹配，请刷新页面");
    return false;
  }
}

function makeWorkerError(code, message) {
  var error = new Error(message || code);
  error.code = code;
  return error;
}

function rejectCorpusWorkerPending(error) {
  corpusWorkerPending.forEach(function(entry) {
    clearTimeout(entry.timer);
    entry.reject(error);
  });
  corpusWorkerPending.clear();
}

function terminateCorpusWorker(error) {
  var worker = corpusWorker;
  corpusWorker = null;
  corpusWorkerStartPromise = null;
  if (worker) worker.terminate();
  rejectCorpusWorkerPending(error || makeWorkerError("WORKER_TERMINATED", "Search Worker terminated"));
}

function postCorpusWorkerRequest(type, payload, timeoutMs) {
  if (!corpusWorker) return Promise.reject(makeWorkerError("WORKER_UNAVAILABLE", "Search Worker is unavailable"));
  const id = ++corpusWorkerRequestId;
  return new Promise(function(resolve, reject) {
    const expire = function() {
      if (!corpusWorkerPending.has(id)) return;
      clearTimeout(timer);
      corpusWorkerPending.delete(id);
      const error = makeWorkerError("WORKER_TIMEOUT", "Search Worker request timed out");
      terminateCorpusWorker(error);
      reject(error);
    };
    const duration = timeoutMs || WORKER_REQUEST_TIMEOUT;
    const timer = setTimeout(expire, duration);
    corpusWorkerPending.set(id, { resolve: resolve, reject: reject, timer: timer, expire: expire, deadline: Date.now() + duration });
    corpusWorker.postMessage({ protocol: WORKER_PROTOCOL_VERSION, type: type, id: id, payload: payload || {} });
  });
}

function ensureCorpusWorker() {
  if (corpusWorker) return Promise.resolve(corpusWorker);
  if (corpusWorkerStartPromise) return corpusWorkerStartPromise;
  if (!window.Worker) return Promise.reject(makeWorkerError("WORKER_UNAVAILABLE", "Web Workers are unavailable"));
  corpusWorkerStartPromise = new Promise(function(resolve, reject) {
    const worker = new Worker("static/index-worker.js");
    corpusWorker = worker;
    worker.addEventListener("message", function(event) {
      const message = event.data || {};
      if (message.type !== "response") return;
      const pending = corpusWorkerPending.get(message.id);
      if (!pending) return;
      corpusWorkerPending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.protocol !== WORKER_PROTOCOL_VERSION) {
        pending.reject(makeWorkerError("PROTOCOL_MISMATCH", "Refresh required: app/Worker protocol mismatch"));
        return;
      }
      if (!message.ok) pending.reject(makeWorkerError(message.error && message.error.code || "WORKER_ERROR", message.error && message.error.message));
      else pending.resolve(message.result);
    });
    function fail(event) {
      const error = makeWorkerError("WORKER_ERROR", event && event.message || "Search Worker failed");
      terminateCorpusWorker(error);
      reject(error);
    }
    worker.addEventListener("error", fail, { once: true });
    worker.addEventListener("messageerror", fail, { once: true });
    postCorpusWorkerRequest("handshake", {}, WORKER_REQUEST_TIMEOUT).then(function(result) {
      if (!result || result.protocol !== WORKER_PROTOCOL_VERSION) throw makeWorkerError("PROTOCOL_MISMATCH", "Refresh required: app/Worker protocol mismatch");
      corpusWorkerStartPromise = null;
      resolve(worker);
    }).catch(function(error) {
      terminateCorpusWorker(error);
      reject(error);
    });
  });
  return corpusWorkerStartPromise;
}

async function corpusWorkerRequest(type, payload, timeoutMs) {
  try {
    await ensureCorpusWorker();
    return await postCorpusWorkerRequest(type, payload, timeoutMs);
  } catch (error) {
    if (error && error.code === "PROTOCOL_MISMATCH") throw error;
    if (corpusWorkerRestartCount >= 1) throw error;
    corpusWorkerRestartCount++;
    terminateCorpusWorker(error);
    await ensureCorpusWorker();
    if (type !== "load-corpus") {
      await postCorpusWorkerRequest("load-corpus", { url: new URL(DATA_URL, document.baseURI).href }, WORKER_LOAD_TIMEOUT);
    }
    return postCorpusWorkerRequest(type, payload, timeoutMs);
  }
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
  const data = await corpusWorkerRequest("local-search", workerParams, WORKER_REQUEST_TIMEOUT);
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
  if (!data || !Array.isArray(data.results) || !Number.isSafeInteger(data.total) || data.total < 0
      || !Number.isInteger(data.page) || data.page !== expectedPage
      || !Number.isInteger(data.page_size) || data.page_size !== expectedPageSize) return false;
  const remaining = Math.max(0, data.total - (expectedPage - 1) * expectedPageSize);
  return data.results.length === Math.min(expectedPageSize, remaining)
    && data.results.every(record => record && typeof record === "object" && !Array.isArray(record));
}

// One entry owns its network request, deadline and cancellation subscriptions.
function createSearchPageRequest(cacheKey, url, body, timeoutMs) {
  const controller = new AbortController();
  const entry = { controller, deadline: Date.now() + timeoutMs, listeners: [] };
  const stopped = new Promise((resolve, reject) => {
    entry.expire = () => {
      reject(new Error("API_TIMEOUT"));
      controller.abort();
    };
    controller.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  });
  const timer = setTimeout(entry.expire, timeoutMs);
  const request = fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: controller.signal,
  }).then(async response => {
    if (!response.ok) throw Object.assign(new Error("HTTP " + response.status), { status: response.status });
    const data = await response.json();
    if (!isValidSearchResponse(data, body.page, body.page_size)) throw new Error("INVALID_API_RESPONSE");
    return data;
  });
  entry.promise = Promise.race([request, stopped]).finally(() => {
    clearTimeout(timer);
    entry.listeners.forEach(([owner, cancel]) => owner.removeEventListener("abort", cancel));
    if (pendingSearchPages.get(cacheKey) === entry) pendingSearchPages.delete(cacheKey);
  });
  pendingSearchPages.set(cacheKey, entry);
  return entry;
}

// Prefetch and foreground pagination join the same entry for each search/page.
function fetchSearchPage(cacheKey, url, body, signal, timeoutMs) {
  if (signal && signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  let entry = pendingSearchPages.get(cacheKey);
  if (entry && Date.now() >= entry.deadline) entry.expire();
  if (!entry || entry.controller.signal.aborted) entry = createSearchPageRequest(cacheKey, url, body, timeoutMs);
  if (signal) {
    const cancel = () => entry.controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    entry.listeners.push([signal, cancel]);
  }
  return entry.promise;
}

function expireSearchRequests() {
  const now = Date.now();
  pendingSearchPages.forEach(entry => { if (now >= entry.deadline) entry.expire(); });
  corpusWorkerPending.forEach(entry => { if (now >= entry.deadline) entry.expire(); });
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
      setCachedSearchResponse(cacheKey, data);
    } catch (error) {
      if (requestId === searchRequestId && !(params.signal && params.signal.aborted)) noteSearchApiFailure(error);
      throw error;
    }
  }
  if (requestId !== searchRequestId) return false;
  applySearchPage(data, append);
  return true;
}

function appendSearchResults(page, results = STATE._pageCache[page]) {
  if (!STATE._resultBackend) STATE._resultBackend = "api";
  STATE.results = STATE.results.concat(results);
  delete STATE._pageCache[page];
  STATE._loadedPage = page;
  STATE.hasMore = STATE.results.length < STATE.total;
}

function deferSearchAppend() {
  if (!VSCROLL.isDraggingThumb) return false;
  STATE._deferredAppendWhileDragging = true;
  STATE._pendingPage = 0;
  STATE.isLoading = false;
  return true;
}

// Network, cached and Worker pages share the same state transition.
function applySearchPage(data, append) {
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
  appendSearchResults(STATE.page);
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
  searchPrefetchAbortController?.abort();
  searchPrefetchAbortController = null;
}

function prefetchSearchPages(base, template) {
  const key = getSearchViewKey(), groupKey = base + "|" + stableSearchStringify(template);
  let controller = searchPrefetchAbortController;
  if (!controller || controller.signal.aborted || controller.groupKey !== groupKey) {
    controller?.abort();
    controller = new AbortController();
    controller.groupKey = groupKey;
    controller.active = new Map();
    controller.attempted = new Set();
    searchPrefetchAbortController = controller;
  }
  const current = () => searchPrefetchAbortController === controller && !controller.signal.aborted && key === getSearchViewKey();
  const pump = () => {
    if (!current() || document.hidden || !navigator.onLine) return;
    const last = Math.min(Math.ceil(STATE.total / STATE.pageSize), STATE._loadedPage + 3);
    for (const page of controller.attempted) if (page <= STATE._loadedPage) controller.attempted.delete(page);
    for (let page = STATE._loadedPage + 1; page <= last && controller.active.size < 2; page++) {
      if (STATE._pageCache[page] || controller.attempted.has(page)) continue;
      controller.attempted.add(page);
      const body = Object.assign({}, template, {page});
      const cacheKey = base + "|" + stableSearchStringify(body);
      const metadata = searchPageMetadata.get(STATE.results[0]);
      const expected = metadata?.generation ? {generation: metadata.generation, total: STATE.total, query: {pageSize: STATE.pageSize}} : null;
      const task = (async () => {
        let data = getCachedSearchResponse(cacheKey);
        if (data && expected && (data.generation !== expected.generation || data.total !== expected.total)) {
          searchResponseCache.delete(cacheKey); data = null;
        }
        if (!data && expected) data = await readRecentSearchPage(key, page, expected);
        if (!current()) return;
        if (!data) data = await fetchSearchPage(cacheKey, base, body, controller.signal, APPEND_REQUEST_TIMEOUT);
        if (!current()) return;
        validatePositionWindowPage(data, page, body.page_size, expected);
        noteApiSuccess();
        rememberSearchPageMetadata(data);
        setCachedSearchResponse(cacheKey, data);
        if (page > STATE._loadedPage) STATE._pageCache[page] = data.results;
        scheduleBottomLoad();
      })().catch(error => {
        if (current()) noteSearchApiFailure(error);
      }).finally(() => { controller.active.delete(page); pump(); });
      controller.active.set(page, task);
    }
  };
  pump();
  return controller.active.get(STATE._loadedPage + 1) || Promise.resolve();
}

function prefetchNextPage() {
  if (resultWindow) {
    const page = Math.floor(findVirtualIndex(getResultScrollTop()) / STATE.pageSize) + 1;
    for (let next = page + 1; next <= page + 2 && resultWindow.pending.size < 2; next++) loadResultWindowPage(next, true);
    return;
  }
  if (!STATE._loadedPage) return Promise.resolve();
  if (!apiAvailable) return Promise.resolve();
  if (STATE._resultBackend === "local" || (STATE.useLocalMode && STATE.dataLoaded && STATE._resultBackend !== "api")) return Promise.resolve();
  if (STATE.filterFolderSelfs.length > 0 || STATE.filterFolderSubtrees.length > 0) return Promise.resolve();
  return prefetchSearchPages(getSearchApiBase(), buildCurrentSearchBody(1));
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
  if (extensionApiCache.has(key)) return extensionApiCache.get(key);
  if (extensionApiPending.has(key)) return extensionApiPending.get(key);
  if (!apiAvailable) return null;
  var url = repo ? API_BASE + "/api/extensions?repo=" + encodeURIComponent(repo) : API_BASE + "/api/extensions";
  var pending = fetchMetadataList(url)
    .then(function(data) { noteApiSuccess(); extensionApiCache.set(key, data); return data; })
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
const browserApiCache = new Map();
const browserApiPending = new Map();
const BROWSER_API_CACHE_MAX = 200;
const sidebarInitialCache = new Map();
const sidebarInitialPending = new Map();

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
  if (browserApiCache.has(cacheKey)) browserApiCache.delete(cacheKey);
  browserApiCache.set(cacheKey, data);
  if (browserApiCache.size > BROWSER_API_CACHE_MAX) {
    const firstKey = browserApiCache.keys().next().value;
    browserApiCache.delete(firstKey);
  }
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

const folderContentsCache = new Map();
const FOLDER_CACHE_MAX = 100;

async function getFolderContents(repo, path) {
  const cacheKey = repo + "|" + (path || "");
  if (folderContentsCache.has(cacheKey)) {
    const val = folderContentsCache.get(cacheKey);
    folderContentsCache.delete(cacheKey);
    folderContentsCache.set(cacheKey, val);
    return val;
  }
  const result = await corpusWorkerRequest("folder-contents", { repo: repo, path: path || "" }, WORKER_REQUEST_TIMEOUT);
  if (folderContentsCache.size >= FOLDER_CACHE_MAX) {
    const firstKey = folderContentsCache.keys().next().value;
    folderContentsCache.delete(firstKey);
  }
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
    if (!target) return location.pathname === "/search/" && !location.search && !location.hash;
    return target.origin === location.origin
      && target.pathname === "/search/"
      && target.hash.indexOf("#/") === 0;
  },
});

const VSCROLL = {
  viewKey: "",
  renderStart: 0,
  renderEnd: 0,
  heights: [],
  heightsDirty: true,
  heightTree: [],
  templateCache: new Map(),
  templateCacheKey: "",
  contentVersion: 0,
  measuredWindowKey: "",
  measuredRowKeys: [],
  heightCache: new Map(),
  renderFrame: 0,
  estimatedHeight: 60,
  isDraggingThumb: false,
  lastScrollTop: 0,
  lastScrollTime: 0,
  scrollVelocity: 0,
};
let pendingResultEntrance = false;

const $ = (sel) => document.querySelector(sel);

const DOM = {};

function cacheDOM() {
  DOM.headerTitle = $("#header-title");
  DOM.headerLogo = $("#header-logo");
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

const HTML_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}
const sizeCache = {};

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (sizeCache[bytes] !== undefined) return sizeCache[bytes];
  if (typeof bytes === "string") bytes = parseInt(bytes);
  if (isNaN(bytes) || bytes === 0) return (sizeCache[bytes] = "");
  let result;
  if (bytes < 1024) result = bytes + " B";
  else if (bytes < 1048576) result = (bytes / 1024).toFixed(1) + " KB";
  else if (bytes < 1073741824) result = (bytes / 1048576).toFixed(1) + " MB";
  else result = (bytes / 1073741824).toFixed(2) + " GB";
  return (sizeCache[bytes] = result);
}

function getFileIconType(ext) {
  return FILE_ICON_MAP[(ext || "").toLowerCase()] || "file";
}

const highlightRegexCache = new Map();

function getHighlightRegexes(query) {
  const cached = highlightRegexCache.get(query);
  if (cached) return cached;
  const regexes = query.split(/\s+/).filter((t) => t.length > 0).map(function(tok) {
    const escapedTok = escapeHTML(tok);
    return new RegExp(
      `(${escapedTok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi"
    );
  });
  if (highlightRegexCache.size >= 20) highlightRegexCache.delete(highlightRegexCache.keys().next().value);
  highlightRegexCache.set(query, regexes);
  return regexes;
}

function highlightText(text, query) {
  if (!query || !text) return escapeHTML(text);
  const escaped = escapeHTML(text);
  const regexes = getHighlightRegexes(query);
  if (regexes.length === 0) return escaped;
  let result = escaped;
  for (const regex of regexes) {
    result = result.replace(regex, "<mark>$1</mark>");
  }
  return result;
}

let routeInitialized = false;
let sidebarBackGuardActive = false;
let sidebarBackGuardRoute = "";
let sidebarBackGuardRelease = null;

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
  if (DOM.sidebarBackBtn) DOM.sidebarBackBtn.hidden = global;
  updateSidebarExpandButton();
}

function ensureSidebarBackGuard() {
  if (!STATE.isMobile || !STATE.leftSidebarOpen) return;
  const route = location.href;
  if (sidebarBackGuardActive && sidebarBackGuardRoute === route) return;
  history.pushState({ voiceSidebarGuard: true }, "", route);
  sidebarBackGuardActive = true;
  sidebarBackGuardRoute = route;
}

function releaseSidebarBackGuard(onReleased) {
  if (!sidebarBackGuardActive) {
    onReleased();
    return;
  }
  sidebarBackGuardActive = false;
  sidebarBackGuardRoute = "";
  sidebarBackGuardRelease = onReleased;
  history.back();
}

function navigateSidebarParent() {
  if (STATE.mode !== "repo") return ROUTER.navigate("global");
  const parts = String(STATE.browserPath || "").split("/").filter(Boolean);
  const parent = parts.slice(0, -1).join("/");
  ROUTER.navigate(parts.length ? "repo" : "global", STATE.repo, parent);
}

function returnFromSidebar() {
  releaseSidebarBackGuard(navigateSidebarParent);
}

function closeLeftSidebar() {
  releaseSidebarBackGuard(function() {
    STATE.leftSidebarOpen = false;
    DOM.leftSidebar.classList.remove("expanded-wide");
    updateSidebarVisibility();
    syncStateToURL();
  });
}

function handleSidebarBackNavigation() {
  if (sidebarBackGuardRelease) {
    const release = sidebarBackGuardRelease;
    sidebarBackGuardRelease = null;
    release();
    return true;
  }
  if (!STATE.isMobile || !STATE.leftSidebarOpen || !sidebarBackGuardActive) return false;
  if (location.href !== sidebarBackGuardRoute) return false;
  sidebarBackGuardActive = false;
  sidebarBackGuardRoute = "";
  if (STATE.mode === "repo") navigateSidebarParent();
  else closeLeftSidebar();
  return true;
}

const ROUTER = {
  parse: function() {
    const hash = window.location.hash.replace(/^#/, "");
    const qIdx = hash.indexOf("?");
    const path = qIdx >= 0 ? hash.substring(0, qIdx) : hash;
    const queryString = qIdx >= 0 ? hash.substring(qIdx + 1) : "";
    const parts = path.split("/").filter(Boolean);
    const mode = parts.length === 0 ? "global" : "repo";
    const repo = parts.length === 0 ? null : parts[0];
    const params = {};
    if (queryString) {
      const sp = new URLSearchParams(queryString);
      sp.forEach(function(v, k) {
        if (k === "repo" || k === "folder_self" || k === "folder_subtree" || k === "folder") {
          if (!params[k]) params[k] = [];
          params[k].push(v);
        } else {
          params[k] = v;
        }
      });
    }
    return { mode: mode, repo: repo, params: params };
  },
  navigate: function(mode, repo, folder) {
    let hash = mode === "global" ? "#/" : "#/" + repo;
    const sp = buildSearchURLParams({ includeQuery: false, displaySizes: true });
    if (mode !== "global" && folder) sp.set("path", folder);
    else if (mode !== "global" && folder === undefined && STATE.browserPath) sp.set("path", STATE.browserPath);
    const qs = sp.toString();
    if (qs) hash += "?" + qs;
    if (mode === "global") STATE.browserPath = "";
    window.location.hash = hash;
  },
  apply: function() {
    const route = this.parse();
    const prevMode = STATE.mode;
    const prevRepo = STATE.repo;
    const wasSidebarExpanded = DOM.leftSidebar && DOM.leftSidebar.classList.contains("expanded-wide");
    saveSearchViewSnapshot();
    cancelPositionRestore();
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
    if (route.params.q !== undefined) {
      STATE.query = route.params.q;
      setSearchInputValue(STATE.query);
    } else {
      STATE.query = "";
      setSearchInputValue("");
    }
    if (route.params.repo) {
      STATE.filterRepos = (Array.isArray(route.params.repo) ? route.params.repo : [route.params.repo])
        .map(function(r) { return r.includes("/") ? r : "VoiceOfML/" + r; });
    } else {
      STATE.filterRepos = [];
    }
    if (route.params.ext !== undefined) {
      STATE.filterExtensions = route.params.ext ? route.params.ext.split(",").filter(Boolean) : [];
      saveStoredExtensionFilters();
    } else if (!routeInitialized) {
      STATE.filterExtensions = loadStoredExtensionFilters();
    } else {
      STATE.filterExtensions = [];
      saveStoredExtensionFilters();
    }
    if (route.params.path) {
      STATE.browserPath = route.params.path;
    } else {
      STATE.browserPath = "";
    }
    if (STATE.mode !== "global") {
      var urlSelfs = route.params.folder_self;
      var urlSubtrees = route.params.folder_subtree;
      urlSelfs = urlSelfs === undefined ? [] : (Array.isArray(urlSelfs) ? urlSelfs : [urlSelfs]);
      urlSubtrees = urlSubtrees === undefined ? [] : (Array.isArray(urlSubtrees) ? urlSubtrees : [urlSubtrees]);
      urlSelfs = urlSelfs.filter(function(path) { return typeof path === "string"; });
      urlSubtrees = urlSubtrees.filter(function(path) { return typeof path === "string"; });
      if (urlSelfs.length || urlSubtrees.length) {
        STATE.filterFolderSelfs = urlSelfs;
        STATE.filterFolderSubtrees = urlSubtrees;
        STATE.filterFolders = mergeFolderFilters(STATE.filterFolderSelfs, STATE.filterFolderSubtrees);
      } else {
        STATE.filterFolderSelfs = [];
        STATE.filterFolderSubtrees = [];
        STATE.filterFolders = [];
      }
    } else {
      STATE.filterFolderSelfs = [];
      STATE.filterFolderSubtrees = [];
      STATE.filterFolders = [];
    }
    STATE.sort = route.params.sort || "relevance";
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
    STATE.searchFolders = route.params.search_folders !== "false";
    if (DOM.searchFoldersToggle) DOM.searchFoldersToggle.checked = STATE.searchFolders;
    STATE.exact = route.params.exact !== "0";
    if (DOM.exactSearchToggle) DOM.exactSearchToggle.checked = STATE.exact;
    STATE.useLocalMode = route.params.local !== "0";
    if (DOM.localModeToggle) DOM.localModeToggle.checked = STATE.useLocalMode;
    setExactSearchSectionVisible(!STATE.useLocalMode, false);
    STATE.recordHistory = route.params.history !== "0";
    if (DOM.historyToggle) DOM.historyToggle.checked = STATE.recordHistory;
    STATE.useMirrorLinks = route.params.mirror !== "0";
    if (DOM.mirrorLinksToggle) DOM.mirrorLinksToggle.checked = STATE.useMirrorLinks;
    const keepMobileSidebarOpen = STATE.isMobile && STATE.leftSidebarOpen
      && prevMode === "repo" && route.mode === "global" && route.params.sidebar === "0";
    STATE.leftSidebarOpen = keepMobileSidebarOpen || route.params.sidebar !== "0";
    STATE.rightSidebarOpen = route.params.filters === "1";
    updateSidebarVisibility();
    const keepSidebarExpanded = route.params.wide === "1"
      || (prevMode !== STATE.mode && wasSidebarExpanded);
    DOM.leftSidebar.classList.toggle("expanded-wide", keepSidebarExpanded);
    this.updateUI();
    updateRandomTxtVisibility();
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

function buildSearchURLParams({ includeQuery = true, displaySizes = false } = {}) {
  const sp = new URLSearchParams();
  if (includeQuery && STATE.query) sp.set("q", STATE.query);
  if (STATE.filterExtensions.length > 0) sp.set("ext", STATE.filterExtensions.join(","));
  if (STATE.sort !== "relevance") sp.set("sort", STATE.sort);
  const sizeValue = displaySizes ? fmtSizeUrl : value => value;
  if (STATE.filterMinSize !== null) sp.set("min_size", sizeValue(STATE.filterMinSize));
  if (STATE.filterMaxSize !== null) sp.set("max_size", sizeValue(STATE.filterMaxSize));
  if (!STATE.searchFolders) sp.set("search_folders", "false");
  if (!STATE.exact) sp.set("exact", "0");
  if (!STATE.useLocalMode) sp.set("local", "0");
  if (!STATE.recordHistory) sp.set("history", "0");
  if (!STATE.useMirrorLinks) sp.set("mirror", "0");
  if (!STATE.leftSidebarOpen) sp.set("sidebar", "0");
  if (STATE.rightSidebarOpen) sp.set("filters", "1");
  if (DOM.leftSidebar.classList.contains("expanded-wide")) sp.set("wide", "1");
  return sp;
}

function syncStateToURL() {
  if (readerOverlay) return;
  let hash = STATE.mode === "global" ? "#/" : "#/" + STATE.repo;
  const sp = buildSearchURLParams();
  if (STATE.mode === "global") {
    STATE.filterRepos.forEach(function(r) {
      sp.append("repo", r.split("/").pop());
    });
  }
  if (STATE.mode !== "global" && STATE.browserPath) sp.set("path", STATE.browserPath);
  if (STATE.mode !== "global") {
    STATE.filterFolderSelfs.forEach(function(folder) { sp.append("folder_self", folder); });
    STATE.filterFolderSubtrees.forEach(function(folder) { sp.append("folder_subtree", folder); });
  }
  const qs = sp.toString();
  if (qs) hash += "?" + qs;
  if (window.location.hash !== hash) {
    const state = history.state && history.state.voiceSidebarGuard ? history.state : null;
    history.replaceState(state, "", hash);
    if (state && sidebarBackGuardActive) sidebarBackGuardRoute = location.href;
  }
  persistSearchSession();
}

function renderSidebarAndFiltersDeferred(routeId) {
  if (!routeId || routeId === routeRenderId) renderSidebar(routeId);
  requestAnimationFrame(function() {
    if (routeId && routeId !== routeRenderId) return;
    renderFilters(routeId);
  });
}
let searchTimer = null;
let searchComposing = false;
let composeSafetyTimer = null;
let searchId = 0;
let searchAbortController = null;
let searchPrefetchAbortController = null;
let searchRequestId = 0;
let filterSearchTimer = null;
let sizeFilterTimer = null;
const FILTER_SEARCH_DEBOUNCE_MS = 200;
let routeRenderId = 0;
let apiAvailable = true;
let apiFailureCount = 0;
let apiProbeTimer = null;
let apiProbeInFlight = false;
const API_FAILURE_THRESHOLD = 3;
const API_RECOVERY_DELAY = 30000;
let localDataPromise = null;
const SEARCH_CACHE_TTL = 8 * 60 * 1000;
const SEARCH_CACHE_MAX = 60;
const searchResponseCache = new Map();
const INITIAL_BASE_URL = "data/initial";
const initialPayloadCache = new Map();
let randomTxtStatusId = 0;

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
  if (!DOM.randomTxtBtn) return;
  const id = ++randomTxtStatusId;
  DOM.randomTxtBtn.style.display = "none";
  if (STATE.dataLoaded) {
    await loadReaderAssets();
    if (id !== randomTxtStatusId) return;
    const originalCount = STATE.repoFull ? (readerMetadata.byRepo[STATE.repoFull] || 0) : (readerMetadata.count || 0);
    const count = originalCount + getConvertedReaderRecords(STATE.repoFull || "").length;
    DOM.randomTxtBtn.style.display = count > 0 ? "" : "none";
    return;
  }
  const repo = STATE.mode === "repo" && STATE.repo ? STATE.repo : "";
  const url = repo ? API_BASE + "/api/random-reader/status?repo=" + encodeURIComponent(repo) : API_BASE + "/api/random-reader/status";
  try {
    const data = await fetchJsonWithTimeout(url, 4000);
    if (id !== randomTxtStatusId) return;
    DOM.randomTxtBtn.style.display = data && data.available ? "" : "none";
  } catch (e) {
    if (id === randomTxtStatusId) DOM.randomTxtBtn.style.display = "none";
  }
}

function stableSearchStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableSearchStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(function(k) {
      return JSON.stringify(k) + ":" + stableSearchStringify(value[k]);
    }).join(",") + "}";
  }
  return JSON.stringify(value);
}

const SEARCH_VIEW_SNAPSHOT_VERSION = 1;
const searchViewSnapshots = new Map();
const SEARCH_VIEW_SNAPSHOT_MAX = 20;
const SEARCH_VIEW_SNAPSHOT_BYTES_MAX = 8 * 1024 * 1024;
const SEARCH_POSITION_MAX = 500;
const SEARCH_POSITION_TTL = 90 * 24 * 60 * 60 * 1000;
const searchPositions = new Map();
let searchPositionDB = null;
let displayedSearchView = null;
let positionSaveTimer = null;
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
  const saved = searchPositions.get(key);
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
  clearTimeout(searchTimer);
  clearTimeout(filterSearchTimer);
  clearTimeout(sizeFilterTimer);
  searchTimer = null;
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
  cancelPositionRestore();
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
    }
  });
  DOM.currentResultPosition?.addEventListener("blur", event => {
    const previous = edit;
    edit = null;
    if (previous && previous.key === getSearchViewKey() && previous.value !== event.target.value)
      jumpToSearchResult(event.target.value.trim());
    else updateCurrentResultPosition();
  });
}
let lastPositionPruneAt = 0;
let displayedViewRevision = 0;
let measuredHeightRevision = 0;
const searchSnapshotSources = new WeakMap();
const searchViewportSnapshots = new Map();
const SEARCH_VIEWPORT_MAX = 64;
const SEARCH_VIEWPORT_BYTES_MAX = 64 * 1024;
const resultRowRecords = new WeakMap();
const searchViewportSources = new WeakMap();
const searchPageMetadata = new WeakMap();
const recentSearchPages = new Map();
const recentSearchPageSources = new WeakMap();
const RECENT_SEARCH_PAGE_MAX = 32;
const RECENT_SEARCH_PAGE_BYTES_MAX = 256 * 1024;
const RECENT_SEARCH_PAGE_TTL = 7 * 24 * 60 * 60 * 1000;

function rememberSearchPageMetadata(data) {
  if (data?.results?.[0] && typeof data.generation === "string") searchPageMetadata.set(data.results[0], {
    generation: data.generation, total: data.total, page: data.page, page_size: data.page_size });
}

function cacheRecentSearchPage(entry) {
  const id = JSON.stringify(entry.id);
  recentSearchPages.delete(id); recentSearchPages.set(id, entry);
  while (recentSearchPages.size > RECENT_SEARCH_PAGE_MAX) recentSearchPages.delete(recentSearchPages.keys().next().value);
}

function pruneSearchContentStore(store, limit, ttl) {
  const index = store.index("savedAt");
  const expired = index.openKeyCursor(IDBKeyRange.upperBound(Date.now() - ttl, true));
  expired.onsuccess = event => {
    const cursor = event.target.result;
    if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
  };
  let skipped = false;
  index.openKeyCursor(null, "prev").onsuccess = event => {
    const cursor = event.target.result;
    if (!cursor) return;
    // Jump over retained keys inside IndexedDB instead of visiting each in JS.
    if (!skipped) { skipped = true; cursor.advance(limit); return; }
    store.delete(cursor.primaryKey); cursor.continue();
  };
}

function saveRecentSearchPages(position, view, visibleEnd) {
  const size = JSON.parse(view.key).pageSize;
  let store;
  for (let page = Math.floor(position.index / size) + 1; page <= Math.floor(visibleEnd / size) + 1; page++) {
    const start = (page - 1) * size, length = Math.min(size, view.total - start);
    const metadata = view.window || searchPageMetadata.get(view.results[start]);
    if (!metadata?.generation || metadata.total !== view.total || (view.window && !view.window.pages.has(page))) continue;
    const id = [view.key, page], previous = recentSearchPages.get(JSON.stringify(id));
    const source = previous && recentSearchPageSources.get(previous);
    if (source?.first === view.results[start] && source.last === view.results[start + length - 1]
        && previous.generation === metadata.generation && Date.now() - previous.savedAt < 60000) {
      cacheRecentSearchPage(previous); continue;
    }
    const results = view.results.slice(start, start + length);
    if (results.length !== length || Object.keys(results).length !== length || results.some(record => !record)) continue;
    const entry = { id, key: view.key, page, page_size: size, total: view.total, generation: metadata.generation,
      results: results.map(cloneSearchResult), savedAt: Date.now() };
    if (new TextEncoder().encode(JSON.stringify(entry)).byteLength > RECENT_SEARCH_PAGE_BYTES_MAX) continue;
    cacheRecentSearchPage(entry);
    recentSearchPageSources.set(entry, {first: results[0], last: results[length - 1]});
    if (searchPositionDB?.objectStoreNames.contains("recent-pages")) try {
      if (!store) store = searchPositionDB.transaction("recent-pages", "readwrite").objectStore("recent-pages");
      store.put(entry);
    } catch (_) {}
  }
  if (store) try { pruneSearchContentStore(store, RECENT_SEARCH_PAGE_MAX, RECENT_SEARCH_PAGE_TTL); } catch (_) {}
}

async function readRecentSearchPage(key, page, expected) {
  const id = [key, page];
  let entry = recentSearchPages.get(JSON.stringify(id));
  if (!entry && searchPositionDB?.objectStoreNames.contains("recent-pages")) entry = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 150);
    try {
      const request = searchPositionDB.transaction("recent-pages").objectStore("recent-pages").get(id);
      request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
      request.onerror = () => { clearTimeout(timer); resolve(null); };
    } catch (_) { clearTimeout(timer); resolve(null); }
  });
  if (!entry || entry.key !== key || entry.savedAt < Date.now() - RECENT_SEARCH_PAGE_TTL || !expected.generation
      || !Array.isArray(entry.results) || Object.keys(entry.results).length !== entry.results.length) return null;
  try { validatePositionWindowPage(entry, page, expected.query.pageSize, expected); } catch (_) { return null; }
  cacheRecentSearchPage(entry);
  return entry;
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
  const visibleEnd = findVirtualIndex(getResultScrollTop() + DOM.resultsContainer.clientHeight);
  saveRecentSearchPages(position, view, visibleEnd);
  const previous = searchViewportSnapshots.get(view.key), source = previous && searchViewportSources.get(previous);
  const pageStart = Math.floor(position.index / STATE.pageSize) * STATE.pageSize;
  const generation = view.window?.generation || searchPageMetadata.get(view.results[pageStart])?.generation;
  if (source && previous.total === view.total && previous.generation === generation
      && previous.measurementKey === getHeightMeasurementKey() && Date.now() - previous.savedAt < 24 * 60 * 60 * 1000) {
    let covered = true;
    for (let index = position.index; index <= visibleEnd; index++) {
      const saved = source.get(index);
      if (!saved || saved.record !== view.results[index] || saved.height !== (VSCROLL.heights[index] || VSCROLL.estimatedHeight)) { covered = false; break; }
    }
    if (covered) return;
  }
  const start = Math.max(0, position.index - 24);
  const end = Math.min(view.results.length, position.index + 56);
  const records = [];
  for (let index = start; index < end; index++) {
    if (view.results[index]) records.push([index, cloneSearchResult(view.results[index]), VSCROLL.heights[index] || VSCROLL.estimatedHeight]);
  }
  const viewport = { key: position.key, savedAt: position.savedAt, anchorId: position.anchorId, index: position.index,
    total: view.total, generation, estimatedHeight: VSCROLL.estimatedHeight, measurementKey: getHeightMeasurementKey(), records: [] };
  // API records can include long URLs. Spend the budget on the visible screen
  // first, then its nearest neighbors, rather than discarding the whole preview.
  const distance = index => Math.max(position.index - index, index - visibleEnd, 0);
  records.sort((a, b) => distance(a[0]) - distance(b[0]) || a[0] - b[0]);
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify(viewport)).byteLength;
  for (const record of records) {
    const cost = encoder.encode(JSON.stringify(record)).byteLength + 1;
    if (bytes + cost > SEARCH_VIEWPORT_BYTES_MAX) continue;
    viewport.records.push(record); bytes += cost;
  }
  viewport.records.sort((a, b) => a[0] - b[0]);
  if (!viewport.records.some(([index]) => index === position.index)) return;
  searchViewportSnapshots.delete(viewport.key);
  searchViewportSnapshots.set(viewport.key, viewport);
  searchViewportSources.set(viewport, new Map(viewport.records.map(([index, , height]) => [index, {record: view.results[index], height}])));
  while (searchViewportSnapshots.size > SEARCH_VIEWPORT_MAX) searchViewportSnapshots.delete(searchViewportSnapshots.keys().next().value);
  if (searchPositionDB?.objectStoreNames.contains("viewports")) try {
    const tx = searchPositionDB.transaction("viewports", "readwrite"), store = tx.objectStore("viewports");
    store.put(viewport);
    pruneSearchContentStore(store, SEARCH_VIEWPORT_MAX, SEARCH_POSITION_TTL);
  } catch (_) {}
}

async function readSearchViewport(key) {
  if (searchViewportSnapshots.has(key)) return searchViewportSnapshots.get(key);
  if (!searchPositionDB?.objectStoreNames.contains("viewports")) return null;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 150);
    try {
      const request = searchPositionDB.transaction("viewports").objectStore("viewports").get(key);
      request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
      request.onerror = () => { clearTimeout(timer); resolve(null); };
    } catch (_) { clearTimeout(timer); resolve(null); }
  });
}

function validSearchViewport(viewport, position) {
  return !!position && !!viewport && viewport.key === position.key
    && viewport.savedAt >= Date.now() - SEARCH_POSITION_TTL && Number.isInteger(viewport.total) && viewport.total > position.index
    && Array.isArray(viewport.records) && viewport.records.length <= 80
    && viewport.records.some(([index, record]) => index === position.index && getResultStableId(record) === position.anchorId);
}

function showSavedSearchViewport(viewport, position, task) {
  if (!validSearchViewport(viewport, position)) return;
  const size = JSON.parse(position.key).pageSize;
  const results = new Array(Math.min(viewport.total, position.loadedPage * size));
  for (const [index, record] of viewport.records) if (Number.isInteger(index) && index >= 0 && index < results.length) results[index] = record;
  const snapshot = { version: SEARCH_VIEW_SNAPSHOT_VERSION, key: position.key, results, total: viewport.total,
    page: position.loadedPage, loadedPage: position.loadedPage, pageCache: {}, hasMore: results.length < viewport.total,
    window: { preview: true, generation: viewport.generation, pages: [], count: Object.keys(results).length }, estimatedHeight: viewport.estimatedHeight,
    heightCache: viewport.records.map(([, record, height]) => [getResultStableId(record), {height, measurementKey: viewport.measurementKey}]),
    scroll: {index: position.index, offset: position.offset, viewKey: position.key}, savedAt: Date.now() };
  task.preview = true;
  searchViewSnapshots.set(position.key, snapshot);
  restoreSearchViewSnapshot(position.key, true, true);
  searchViewSnapshots.delete(position.key);
  showPositionRestoreStatus("已恢复上次画面，正在核对结果…");
}

function validSearchPosition(value) {
  return value && value.version === 1 && typeof value.key === "string"
    && Number.isInteger(value.index) && value.index >= 0
    && Number.isFinite(value.offset) && value.offset >= 0
    && Number.isInteger(value.loadedPage) && value.loadedPage >= 1
    && typeof value.anchorId === "string" && value.savedAt > Date.now() - SEARCH_POSITION_TTL;
}

async function initSearchPositions() {
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 1500);
    try {
      const request = indexedDB.open("voice-search-positions", 4);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
        for (const name of ["positions", "viewports", "recent-pages"]) {
          const store = db.createObjectStore(name, {keyPath: name === "recent-pages" ? "id" : "key"});
          store.createIndex("savedAt", "savedAt");
        }
      };
      request.onerror = request.onblocked = () => { clearTimeout(timer); resolve(); };
      request.onsuccess = () => {
        searchPositionDB = request.result;
        searchPositionDB.onversionchange = () => { searchPositionDB.close(); searchPositionDB = null; };
        const transaction = searchPositionDB.transaction("positions", "readwrite");
        const store = transaction.objectStore("positions");
        store.getAll().onsuccess = event => {
          // The position store is capped at 500; read it in one database round trip.
          let count = 0;
          const values = event.target.result.sort((a, b) => b.savedAt - a.savedAt);
          for (const value of values) {
            if (!validSearchPosition(value) || ++count > SEARCH_POSITION_MAX) store.delete(value.key);
            else if (!searchPositions.has(value.key)) searchPositions.set(value.key, value);
          }
        };
        transaction.oncomplete = transaction.onabort = () => { clearTimeout(timer); resolve(); };
      };
    } catch (_) { clearTimeout(timer); resolve(); }
  });
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
}

function saveSearchPosition() {
  clearTimeout(positionSaveTimer);
  const view = displayedSearchView;
  const target = view && getReturnPositionTarget(view.key);
  if (target) return target;
  if (!view || positionRestore || readerOverlay || !view.results.length || !VSCROLL.heights.length) return null;
  if (STATE.results !== view.results || (STATE.isLoading && view.key !== getSearchViewKey())) return searchPositions.get(view.key) || null;
  const index = Math.min(findVirtualIndex(getResultScrollTop()), view.results.length - 1);
  if (!view.results[index]) return searchPositions.get(view.key) || null;
  const position = { version: 1, key: view.key, index,
    offset: Math.max(0, getResultScrollTop() - getVirtualOffset(index)),
    anchorId: getResultStableId(view.results[index]), loadedPage: view.loadedPage,
    savedAt: Date.now() };
  const previous = searchPositions.get(view.key);
  if (previous && position.savedAt - previous.savedAt < 1000 && previous.index === position.index
      && previous.offset === position.offset && previous.anchorId === position.anchorId
      && previous.loadedPage === position.loadedPage) return previous;
  // Initialization reads newest first; only sort when enforcing the small cap.
  searchPositions.set(view.key, position);
  saveSearchViewport(position, view);
  const prune = Date.now() - lastPositionPruneAt >= 60000 || searchPositions.size > SEARCH_POSITION_MAX;
  if (prune) {
    const ordered = Array.from(searchPositions.values()).sort((a, b) => b.savedAt - a.savedAt);
    ordered.forEach((item, i) => { if (!validSearchPosition(item) || i >= SEARCH_POSITION_MAX) searchPositions.delete(item.key); });
    lastPositionPruneAt = Date.now();
  }
  if (searchPositionDB) try {
    const transaction = searchPositionDB.transaction("positions", "readwrite");
    const store = transaction.objectStore("positions");
    store.put(position);
    let count = 0;
    if (prune) store.index("savedAt").openCursor(null, "prev").onsuccess = event => {
      const cursor = event.target.result;
      if (!cursor) return;
      if (!validSearchPosition(cursor.value) || ++count > SEARCH_POSITION_MAX) cursor.delete();
      cursor.continue();
    };
    transaction.onabort = () => {}; // Memory restoration still works if storage is unavailable.
  } catch (_) {}
  return position;
}

function setupSearchPositionSaving() {
  DOM.resultsContainer.addEventListener("scroll", () => {
    if (positionRestore || STATE.isLoading || displayedSearchView?.key !== getSearchViewKey()) return;
    clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(saveSearchPosition, 250);
  }, { passive: true });
  // Capture before controls mutate filters, clear results, or replace the route.
  for (const type of ["change", "click", "keydown"]) document.addEventListener(type, event => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("#results-container, #scroll-track, #search-position-status, #load-info")) return;
    if (type === "keydown" && !["Enter", "Escape"].includes(event.key)) return;
    saveSearchViewSnapshot();
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
  positionEntryId++;
  if (resultWindow) resultWindow.controller.abort();
  resultWindow = null;
  updateResultWindowStatus();
  if (!positionRestore) return;
  positionRestore.controller.abort();
  positionRestore = null;
  STATE.isLoading = false;
  showPositionRestoreStatus("");
}

function tryRestoreSearchPosition(key, options = {}) {
  const previous = positionRestore?.key === key && positionRestore.failed && !options.position ? positionRestore : null;
  let position = options.position || previous?.position || searchPositions.get(key);
  if (!validSearchPosition(position)) return false;
  cancelPendingSearchControls();
  if (!options.position && positionRestore?.key === key && !positionRestore.failed) return true;
  cancelPositionRestore();
  setReturnPositionTarget();
  searchAbortController?.abort();
  cancelSearchPrefetch();
  searchId++;
  searchRequestId++;
  const controller = new AbortController();
  const task = { key, controller, position: {...position}, lookup: previous?.lookup, ready: previous?.ready || new Map(), page: 0, results: [] };
  positionRestore = task;
  const current = () => positionRestore === task && key === getSearchViewKey() && !controller.signal.aborted;
  STATE.isLoading = true;
  resetPagingRecovery();
  showPositionRestoreStatus("正在恢复上次位置…");
  (async () => {
    try {
      const query = JSON.parse(key);
      const viewport = options.viewport === undefined ? await readSearchViewport(key) : options.viewport;
      if (!current()) return;
      showSavedSearchViewport(viewport, position, task);
      while (current()) {
        const lookup = task.lookup || await fetchPositionPageWithRecovery(query, 1, controller.signal, position.anchorId);
        if (!current()) return;
        validatePositionWindowPage(lookup, 1, query.pageSize);
        task.lookup = lookup; task.ready.set(1, lookup); task.page = 1;
        const total = lookup.total;
        const index = Number.isInteger(lookup.anchor_index) && lookup.anchor_index >= 0 && lookup.anchor_index < total
          ? lookup.anchor_index : Math.min(position.index, Math.max(0, total - 1));
        const targetPage = Math.floor(index / query.pageSize) + 1;
        const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
        const pages = Array.from({length: Math.min(lastPage, targetPage + 1) - Math.max(1, targetPage - 1) + 1}, (_, i) => Math.max(1, targetPage - 1) + i);
        const responses = await Promise.all(pages.map(async page => {
          try { return {page, data: task.ready.get(page) || await fetchPositionPageWithRecovery(query, page, controller.signal)}; }
          catch (error) { return {page, error}; }
        }));
        if (!current()) return;
        for (const {page, data, error} of responses) if (!error) {
          validatePositionWindowPage(data, page, query.pageSize, lookup);
          task.ready.set(page, data);
        }
        const failure = responses.find(response => response.error);
        if (failure) throw failure.error;
        while (task.preview && VSCROLL.isDraggingThumb && current()) await new Promise(resolve => setTimeout(resolve, 30));
        if (!current()) return;
        // A cached page is authoritative only after the current generation agrees.
        for (const [page, data] of task.cachedPages || []) {
          if (!task.ready.has(page) && data.generation === lookup.generation && data.total === total) task.ready.set(page, data);
        }
        if (task.preview && !readerOverlay) {
          const latest = captureReaderReturnScroll(), record = STATE.results[latest.index];
          const anchorId = getResultStableId(record);
          if (anchorId && anchorId !== position.anchorId) {
            position = {...position, index: latest.index, offset: latest.offset, anchorId};
            const available = [...task.ready.values()].some(data => data.results.some(item => getResultStableId(item) === anchorId));
            if (!available) { task.lookup = null; task.ready.clear(); continue; }
          } else if (anchorId) position = {...position, offset: latest.offset};
        }
        // Empty slots reserve scroll geometry only; visible slots are fetched on demand.
        const page = Math.min(lastPage, Math.max(position.loadedPage, targetPage + 1));
        const results = new Array(Math.min(total, page * query.pageSize));
        let found = -1;
        for (const [number, data] of task.ready) data.results.forEach((record, offset) => {
          const index = (number - 1) * query.pageSize + offset;
          results[index] = record;
          if (getResultStableId(record) === position.anchorId) found = index;
        });
        const snapshot = { version: SEARCH_VIEW_SNAPSHOT_VERSION, key, results, total,
          page, loadedPage: page, pageCache: {}, hasMore: results.length < total,
          window: { generation: lookup.generation, pages: [...task.ready.keys()], count: [...task.ready.values()].reduce((sum, data) => sum + data.results.length, 0) },
          estimatedHeight: VSCROLL.estimatedHeight, heightCache: [], heightRecords: [],
          scroll: { index: found < 0 ? index : found, offset: position.offset, viewKey: key }, savedAt: Date.now() };
        positionRestore = null;
        showPositionRestoreStatus("");
        if (task.preview && found === position.index) applyValidatedSearchViewport(snapshot);
        else {
          searchViewSnapshots.set(key, snapshot);
          restoreSearchViewSnapshot(key);
        }
        trimSearchViewSnapshots();
        if (found < 0 && position.anchorId) showToast("搜索结果已变化，已恢复到原位置附近");
        return;
      }
    } catch (error) {
      if (!current()) return;
      STATE.isLoading = false;
      task.failed = true;
      task.error = error;
      if (error.message === "RESTORE_PAGE_CHANGED") { task.lookup = null; task.ready.clear(); task.page = 0; }
      showPositionRestoreStatus(error.message === "RESTORE_PAGE_CHANGED"
        ? "搜索数据已更新，请重试恢复" : "暂时无法加载原位置附近的结果", true);
    }
  })();
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
  resultWindow = { ...snapshot.window, key: snapshot.key, total: snapshot.total, query: JSON.parse(snapshot.key),
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
  clearTimeout(positionSaveTimer); positionSaveTimer = setTimeout(saveSearchPosition, 250);
}

function validatePositionWindowPage(data, page, pageSize, expected) {
  if (!data || !Array.isArray(data.results) || data.page !== page || data.page_size !== pageSize ||
      !Number.isInteger(data.total) || data.total < 0 ||
      data.results.length !== Math.min(pageSize, Math.max(0, data.total - (page - 1) * pageSize)) ||
      data.results.some(record => !record || typeof record !== "object") ||
      (expected && (data.total !== expected.total || data.generation !== expected.generation))) throw new Error("RESTORE_PAGE_CHANGED");
}

function resultWindowCurrent(window) {
  return resultWindow === window && window.key === getSearchViewKey() && !window.controller.signal.aborted;
}

function restartResultWindow() {
  const key = getSearchViewKey();
  saveSearchPosition();
  searchViewSnapshots.delete(key);
  cancelPositionRestore();
  tryRestoreSearchPosition(key);
}

function updateResultWindowStatus() {
  let status = document.getElementById("search-window-status");
  if (!status && resultWindow && (resultWindow.invalid || resultWindow.failures.size)) {
    status = document.createElement("div");
    status.id = "search-window-status";
    status.setAttribute("role", "status");
    status.innerHTML = '<span></span> <button type="button" class="text-btn-sm"></button>';
    status.querySelector("button").onclick = () => {
      if (!resultWindow) return;
      if (resultWindow.invalid) return restartResultWindow();
      const pages = [...resultWindow.failures.keys()];
      resultWindow.failures.clear(); updateResultWindowStatus();
      pages.forEach(page => loadResultWindowPage(page));
    };
    DOM.resultsContainer.parentElement.appendChild(status);
  }
  if (status) {
    status.hidden = !resultWindow || (!resultWindow.invalid && !resultWindow.failures.size);
    status.querySelector("span").textContent = resultWindow?.invalid ? "搜索数据已更新" : "部分结果暂时无法加载";
    status.querySelector("button").textContent = resultWindow?.invalid ? "重新定位" : "重试加载";
  }
}

function isRecoverableSearchError(error) {
  if (!error || error.name === "AbortError") return false;
  if (error.status) return [408, 429, 500, 502, 503, 504].includes(error.status);
  return /API_TIMEOUT|WORKER_TIMEOUT|LOCAL_UNAVAILABLE|TimeoutError|network|fetch|offline|timed out/i.test(`${error.code || error.name || ""} ${error.message || ""}`) || error.message === "Load failed";
}

function waitForSearchRecovery(signal, delay, local) {
  return new Promise((resolve, reject) => {
    let elapsed = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      document.removeEventListener("visibilitychange", ready);
      window.removeEventListener("online", ready);
      window.removeEventListener("pageshow", ready);
    };
    const abort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    const ready = () => {
      if (elapsed && !document.hidden && (local || navigator.onLine)) { cleanup(); resolve(); }
    };
    const timer = setTimeout(() => { elapsed = true; ready(); }, delay);
    signal.addEventListener("abort", abort, { once: true });
    document.addEventListener("visibilitychange", ready);
    window.addEventListener("online", ready);
    window.addEventListener("pageshow", ready);
    if (signal.aborted) abort();
  });
}

async function fetchPositionPageWithRecovery(query, page, signal, anchorId, demanded = () => true) {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    try { return await fetchPositionPage(query, page, signal, anchorId); }
    catch (error) {
      if (signal.aborted || attempt >= 2 || !demanded() || !isRecoverableSearchError(error)) throw error;
      const local = query.useLocalMode || query.folders.self.length || query.folders.subtree.length || !apiAvailable;
      await waitForSearchRecovery(signal, (attempt + 1) * 750, local);
    }
  }
}

function resumeResultRecovery() {
  if (document.hidden || readerOverlay) return;
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
  if (window.prefetched?.has(page)) return Promise.resolve(window.prefetched.get(page));
  if (window.pending.has(page)) {
    const request = window.pending.get(page);
    if (!prefetch) request.demanded = true;
    return request;
  }
  if (prefetch && window.prefetchFailures?.has(page)) return Promise.resolve(null);
  if (window.pending.size >= 3 || window.failures.has(page) || window.invalid) return Promise.resolve(null);
  const request = (async () => {
    const cached = await readRecentSearchPage(window.key, page, window);
    if (!resultWindowCurrent(window)) return null;
    return cached || fetchPositionPageWithRecovery(window.query, page, window.controller.signal, undefined, () => request.demanded);
  })().then(data => {
    if (!data) return null;
    validatePositionWindowPage(data, page, window.query.pageSize, window);
    return data;
  }).finally(() => {
    window.pending.delete(page);
    if (resultWindowCurrent(window)) scheduleVirtualRender();
  });
  window.pending.set(page, request);
  request.demanded = !prefetch;
  return request;
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
    clearTimeout(positionSaveTimer); positionSaveTimer = setTimeout(saveSearchPosition, 250);
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
  // A restored search window must keep loading visible pages; reader return state
  // is only a temporary scroll target and must not block normal pagination.
  if (!resultWindow || readerOverlay || VSCROLL.isDraggingThumb) return;
  const size = resultWindow.query.pageSize;
  if (positionRestore) {
    if (positionRestore.preview) for (let page = Math.floor(start / size) + 1; page <= Math.ceil(end / size); page++) loadCachedPreviewPage(resultWindow, page);
    return;
  }
  for (let page = Math.floor(start / size) + 1; page <= Math.ceil(end / size); page++) loadResultWindowPage(page);
  const visiblePage = Math.floor(findVirtualIndex(getResultScrollTop()) / size) + 1;
  loadResultWindowPage(visiblePage + 1); loadResultWindowPage(visiblePage - 1);
  prefetchNextPage();
}

function createResultWindowPlaceholder(index) {
  const page = Math.floor(index / STATE.pageSize) + 1;
  const row = document.createElement("div");
  row.className = "result-item result-window-placeholder";
  row.dataset.index = String(index);
  row.dataset.contentVersion = String(VSCROLL.contentVersion);
  row.style.height = (VSCROLL.heights[index] || VSCROLL.estimatedHeight) + "px";
  if (resultWindow?.invalid || resultWindow?.failures.has(page)) {
    const button = document.createElement("button");
    button.className = "text-btn-sm"; button.dataset.windowPage = String(page);
    button.textContent = resultWindow.invalid ? "数据已更新，点击重新定位" : "加载失败，点击重试";
    row.appendChild(button);
  } else {
    row.setAttribute("aria-label", "正在加载结果");
    row.innerHTML = '<div class="window-placeholder-lines" aria-hidden="true"><i></i><i></i></div>';
  }
  return row;
}

async function fetchPositionPage(query, page, signal, anchorId) {
  const mixed = query.folders.self.length || query.folders.subtree.length;
  const params = { q: query.query, repos: query.mode === "repo" ? [query.repo] : query.repos,
    extensions: query.extensions, folders: query.plainFolders, folderMatchMode: mixed ? "mixed" : "prefix",
    folderSelfs: query.folders.self, folderSubtrees: query.folders.subtree,
    minSize: query.minSize, maxSize: query.maxSize, sort: query.sort,
    searchFolders: query.searchFolders, exact: query.exact, page, pageSize: query.pageSize,
    ...(anchorId === undefined ? {} : { anchorId }) };
  if (query.useLocalMode || mixed || !apiAvailable) {
    const ok = STATE.dataLoaded || await ensureLocalDataLoaded(false, true);
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (!ok) throw new Error("LOCAL_UNAVAILABLE");
    return doSearchLocal(params);
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
  let bytes = 0;
  for (const [key, snapshot] of Array.from(searchViewSnapshots).reverse()) {
    // Reserve room for position-only updates without serializing the results again.
    if (!snapshot.bytes) snapshot.bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength + 256;
    if (bytes + snapshot.bytes > SEARCH_VIEW_SNAPSHOT_BYTES_MAX) searchViewSnapshots.delete(key);
    else bytes += snapshot.bytes;
  }
  while (searchViewSnapshots.size > SEARCH_VIEW_SNAPSHOT_MAX) searchViewSnapshots.delete(searchViewSnapshots.keys().next().value);
}
function getSearchViewKey() {
  return stableSearchStringify({
    mode: STATE.mode,
    repo: STATE.repoFull || "",
    query: STATE.query || "",
    repos: STATE.filterRepos.slice().sort(),
    extensions: STATE.filterExtensions.slice().sort(),
    folders: {
      self: STATE.filterFolderSelfs.slice().sort(),
      subtree: STATE.filterFolderSubtrees.slice().sort(),
    },
    plainFolders: STATE.filterFolderSelfs.length || STATE.filterFolderSubtrees.length ? [] : STATE.filterFolders.slice().sort(),
    minSize: STATE.filterMinSize,
    maxSize: STATE.filterMaxSize,
    sort: STATE.sort || "relevance",
    searchFolders: STATE.searchFolders,
    exact: STATE.exact,
    useLocalMode: STATE.useLocalMode,
    pageSize: STATE.pageSize,
  });
}
function getHeightMeasurementKey() {
  return (DOM.resultsContainer?.clientWidth || 0) + ":" + (STATE.isMobile ? "mobile" : "desktop") + ":" + (STATE.isDark ? "dark" : "light");
}
function getResultStableId(result) {
  if (!result || typeof result !== "object") return "";
  if (result.Id || result.id) return String(result.Id || result.id);
  return `${result.Repo || ""}\0${buildRecordRelativePath(result)}`;
}
function cloneSearchResult(result) {
  const copy = result && typeof result === "object"
    ? Object.assign({}, result, Array.isArray(result.Folder) ? { Folder: result.Folder.slice() } : {})
    : result;
  if (copy && searchPageMetadata.has(result)) searchPageMetadata.set(copy, searchPageMetadata.get(result));
  return copy;
}
function cloneSearchPageCache(cache) {
  const copy = {};
  Object.keys(cache || {}).forEach(function(page) {
    copy[page] = Array.isArray(cache[page]) ? cache[page].map(cloneSearchResult) : cache[page];
  });
  return copy;
}
function saveSearchViewSnapshot(key = displayedSearchView?.key) {
  const view = displayedSearchView;
  // Browsing from the top must not overwrite the snapshot offered by Return.
  if (getReturnPositionTarget(key)) return searchViewSnapshots.get(key) || null;
  if (!DOM.resultsContainer || !view || positionRestore || key !== view.key || view.loadedPage < 1) return null;
  const position = saveSearchPosition();
  const existing = searchViewSnapshots.get(key);
  const source = existing && searchSnapshotSources.get(existing);
  const signature = `${view.revision}:${measuredHeightRevision}:${getHeightMeasurementKey()}`;
  if (source?.signature === signature) {
    if (position) existing.scroll = { ...position, viewKey: key };
    existing.savedAt = Date.now();
    searchViewSnapshots.delete(key);
    searchViewSnapshots.set(key, existing);
    return existing;
  }
  ensureHeightTree();
  const heightRecords = view.results.map(function(result, index) {
    const id = getResultStableId(result);
    const measurementKey = VSCROLL.measuredRowKeys[index];
    return id && measurementKey && VSCROLL.heights[index]
      ? [id, { height: VSCROLL.heights[index], measurementKey: measurementKey }]
      : null;
  }).filter(Boolean);
  const snapshot = {
    version: SEARCH_VIEW_SNAPSHOT_VERSION,
    key,
    results: source?.revision === view.revision ? existing.results : view.results.map(cloneSearchResult),
    total: view.total,
    page: view.loadedPage,
    loadedPage: view.loadedPage,
    pageCache: cloneSearchPageCache(view.pageCache),
    resultBackend: view.resultBackend,
    hasMore: view.results.length < view.total,
    window: view.window ? { generation: view.window.generation, pages: [...view.window.pages], count: view.window.count } : null,
    estimatedHeight: VSCROLL.estimatedHeight,
    heightCache: Array.from(VSCROLL.heightCache.entries()).map(([id, value]) => [id, Object.assign({}, value)]),
    heightRecords: heightRecords,
    scroll: position ? { ...position, viewKey: key } : { index: 0, offset: 0, viewKey: key },
    savedAt: Date.now(),
  };
  searchViewSnapshots.delete(key);
  searchViewSnapshots.set(key, snapshot);
  const resultsBytes = source?.revision === view.revision ? source.resultsBytes
    : new TextEncoder().encode(JSON.stringify(snapshot.results)).byteLength;
  snapshot.bytes = resultsBytes + new TextEncoder().encode(JSON.stringify({ ...snapshot, results: [] })).byteLength + 256;
  searchSnapshotSources.set(snapshot, { signature, revision: view.revision, resultsBytes });
  trimSearchViewSnapshots();
  return snapshot;
}
function activateSearchView(key = getSearchViewKey()) {
  if (VSCROLL.viewKey === key) return;
  VSCROLL.viewKey = key;
  const snapshot = searchViewSnapshots.get(key);
  VSCROLL.heightCache = new Map(snapshot?.heightCache || []);
}
function restoreSearchViewSnapshot(key, restoreScroll = true, preserveRestore = false) {
  const snapshot = searchViewSnapshots.get(key);
  if (!snapshot || snapshot.version !== SEARCH_VIEW_SNAPSHOT_VERSION || snapshot.loadedPage < 1) return restoreScroll && tryRestoreSearchPosition(key);
  if (!preserveRestore) cancelPositionRestore();
  cancelPendingSearchControls();
  if (searchAbortController) searchAbortController.abort();
  cancelSearchPrefetch();
  searchAbortController = new AbortController();
  searchId++;
  searchRequestId++;
  STATE.results = snapshot.results.map(cloneSearchResult);
  STATE.total = snapshot.total;
  STATE.page = snapshot.page;
  STATE._loadedPage = snapshot.loadedPage;
  STATE._pageCache = cloneSearchPageCache(snapshot.pageCache);
  STATE._resultBackend = snapshot.resultBackend || null;
  STATE.hasMore = snapshot.hasMore;
  if (snapshot.window) resultWindow = { ...snapshot.window, key, total: snapshot.total, query: JSON.parse(key),
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
  readerReturnScrollState = restoreScroll && snapshot.scroll ? Object.assign({}, snapshot.scroll, { route: location.href, viewKey: key }) : null;
  resetVirtualScrollState();
  renderResults(false);
  updateStatusBar();
  updateLoadInfo();
  syncStateToURL(true);
  return true;
}

function cloneSearchData(data) {
  if (!data || !Array.isArray(data.results)) return data;
  rememberSearchPageMetadata(data);
  return {
    ...data,
    results: data.results.slice(),
    total: data.total,
    page: data.page,
    page_size: data.page_size,
  };
}

function getCachedSearchResponse(key) {
  var cached = searchResponseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.time > SEARCH_CACHE_TTL) {
    searchResponseCache.delete(key);
    return null;
  }
  searchResponseCache.delete(key);
  searchResponseCache.set(key, cached);
  return cloneSearchData(cached.data);
}

function setCachedSearchResponse(key, data) {
  searchResponseCache.set(key, { time: Date.now(), data: cloneSearchData(data) });
  while (searchResponseCache.size > SEARCH_CACHE_MAX) {
    searchResponseCache.delete(searchResponseCache.keys().next().value);
  }
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
  body.sort = params.sort || "relevance";
  if (!params.searchFolders) body.search_folders = false;
  if (params.exact) body.exact = true;
  return body;
}

function canUseInitialSearchPayload() {
  return (STATE.page || 1) === 1
    && !STATE.query
    && (STATE.sort || "relevance") === "relevance"
    && STATE.searchFolders
    && STATE.exact
    && STATE.filterRepos.length === 0
    && STATE.filterExtensions.length === 0
    && STATE.filterFolders.length === 0
    && STATE.filterFolderSelfs.length === 0
    && STATE.filterFolderSubtrees.length === 0
    && STATE.filterMinSize === null
    && STATE.filterMaxSize === null;
}

function getInitialPayloadUrl() {
  if (STATE.mode === "repo" && STATE.repo) {
    return INITIAL_BASE_URL + "/repos/" + encodeURIComponent(STATE.repo) + ".json";
  }
  return INITIAL_BASE_URL + "/global.json";
}

function applyInitialSearchPayload(data) {
  if (!data || !Array.isArray(data.results) || !canUseInitialSearchPayload()) return false;
  if (STATE.mode === "repo" && data.repo !== STATE.repoFull) return false;
  if (STATE.mode === "global" && data.mode !== "global") return false;
  if (searchAbortController) searchAbortController.abort();
  cancelSearchPrefetch();
  searchAbortController = new AbortController();
  searchRequestId++;
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
  setCachedSearchResponse(getCurrentSearchCacheKey(1), {
    results: STATE.results,
    total: STATE.total,
    page: 1,
    page_size: STATE.pageSize,
  });
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
  syncStateToURL();
  prefetchNextPage();
  scheduleBackgroundLocalDataLoad();
  return true;
}

async function tryInitialSearchPayload(searchMode, searchRepo) {
  function isCurrentSearchRoute() {
    return STATE.mode === searchMode && STATE.repo === searchRepo;
  }
  if (!canUseInitialSearchPayload()) return false;
  var url = getInitialPayloadUrl();
  try {
    var data = initialPayloadCache.get(url);
    if (!data) {
      data = await fetchJsonWithTimeout(url, 6000);
      if (!isCurrentSearchRoute()) return false;
      if (!data) return false;
      initialPayloadCache.set(url, data);
    }
    if (!isCurrentSearchRoute()) return false;
    return applyInitialSearchPayload(data);
  } catch (e) {
    return false;
  }
}

async function searchWithInitialFallback() {
  saveSearchViewSnapshot();
  cancelPositionRestore();
  const key = getSearchViewKey(), entry = positionEntryId;
  prepareReturnPosition(key);
  if (searchViewSnapshots.has(key)) {
    setReturnPositionTarget();
    return restoreSearchViewSnapshot(key);
  }
  const position = getReturnPositionTarget(key);
  const viewport = position ? await readSearchViewport(key) : null;
  if (entry !== positionEntryId || key !== getSearchViewKey()) return false;
  if (validSearchViewport(viewport, position)) return tryRestoreSearchPosition(key, {position, viewport});
  return searchWithInitialFallbackFresh();
}

function searchWithInitialFallbackFresh() {
  var searchMode = STATE.mode;
  var searchRepo = STATE.repo;
  function isCurrentSearchRoute() {
    return STATE.mode === searchMode && STATE.repo === searchRepo;
  }
  if (canUseInitialSearchPayload()) {
    return tryInitialSearchPayload(searchMode, searchRepo).then(function(applied) {
      if (!applied && isCurrentSearchRoute()) doSearch();
      return applied;
    });
  }
  if (isCurrentSearchRoute()) doSearch();
  return Promise.resolve(false);
}

function ensureLocalDataLoaded(triggerSearchAfterLoad, background) {
  if (STATE.dataLoaded) return Promise.resolve(true);
  if (localDataPromise) return localDataPromise;
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
  localDataPromise = loadData().then(function(ok) {
    STATE.dataLoaded = ok;
    localDataPromise = null;
    if (ok) {
      STATE.extensionList = extensionList;
      updateRandomTxtVisibility();
      if (STATE.mode === "repo") {
        renderFilters(routeRenderId);
      } else {
        renderExtensionFilter(routeRenderId);
        renderRepoFilter(routeRenderId);
      }
      if (STATE._initialActive) {
        STATE._initialActive = false;
      } else if (triggerSearchAfterLoad) {
        STATE.page = 1;
        STATE.results = [];
        doSearch();
      }
    } else {
      if (!background) {
        STATE.isLoading = false;
        STATE.resultsSkeletonActive = false;
        setSearchVisualLoading(false);
      }
      showToast("本地数据加载失败");
      if (DOM.localModeToggle) DOM.localModeToggle.checked = false;
      STATE.useLocalMode = false;
      syncStateToURL();
      if (triggerSearchAfterLoad) doSearch();
    }
    return ok;
  }).catch(function(err) {
    console.error("Local data load failed:", err);
    STATE.dataLoaded = false;
    localDataPromise = null;
    if (!background) {
      STATE.isLoading = false;
      STATE.resultsSkeletonActive = false;
      setSearchVisualLoading(false);
    }
    if (DOM.localModeToggle) DOM.localModeToggle.checked = false;
    STATE.useLocalMode = false;
    showToast("本地数据加载失败");
    syncStateToURL();
    if (triggerSearchAfterLoad) doSearch();
    return false;
  });
  return localDataPromise;
}

function submitSearchQuery(query, { restore = false, record = false, refreshHistory = false, clearResults = false, blur = false, updateInput = restore } = {}) {
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

function debouncedSearch() {
  if (searchComposing) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function() {
    submitSearchQuery(DOM.searchInput.value.trim(), { record: true, refreshHistory: true });
  }, 100);
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

function doSearch(append, fromStart = false, restorePosition = false) {
  if (append && resultWindow) { loadResultWindowPage(STATE._loadedPage + 1); return; }
  if (!append && prepareSearchPositionNavigation({ fromStart, restorePosition })) return;
  if (append && STATE.isLoading) return;
  if (append && !STATE._loadedPage) append = false;
  if (!append) STATE.page = 1;
  clearTimeout(filterSearchTimer);
  filterSearchTimer = null;
  const id = ++searchId;
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
  const params = {
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
    page: STATE.page,
    pageSize: STATE.pageSize,
  };
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
    if (searchAbortController) searchAbortController.abort();
    cancelSearchPrefetch();
    searchAbortController = new AbortController();
    searchRequestId++;
    STATE._pageCache = {};
    STATE._loadedPage = 0;
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
  const continueInitialViaApi = !!(append && STATE._initialActive && !STATE.dataLoaded && apiAvailable && folderMatchMode !== "mixed");
  const continueApi = append && STATE._resultBackend === "api";
  const shouldUseLocalSearch = (append && STATE._resultBackend === "local") ||
    (!continueApi && !continueInitialViaApi && (STATE.useLocalMode || folderMatchMode === "mixed"));
  if (shouldUseLocalSearch) {
    if (!STATE.dataLoaded) {
      ensureLocalDataLoaded(false, false).then(ok => {
        if (id !== searchId) return;
        STATE.isLoading = false;
        if (ok) doSearch(append);
        else if (!append && folderMatchMode !== "mixed") doSearch();
        else finishPagingAttempt(false, new Error("LOCAL_UNAVAILABLE"));
      });
      return;
    } else {
      if (STATE._resultBackend !== "local") {
        cancelSearchPrefetch();
        STATE._pageCache = {};
      }
      STATE._resultBackend = "local";
      doSearchFallbackLocal(params, append, id);
      return;
    }
  }
  if (apiAvailable) {
    STATE._resultBackend = "api";
    if (append && STATE._pendingPage === STATE.page) {
      STATE.isLoading = false;
      return;
    }
    STATE._pendingPage = STATE.page;
    if (!searchAbortController) searchAbortController = new AbortController();
    params.signal = searchAbortController.signal;
    const requestId = searchRequestId;
    let pagingSucceeded = false;
    let pagingError = null;
    doSearchAPI(params, append, requestId).then(function(applied) {
      if (!applied) return;
      if (id !== searchId) return;
      if (STATE._deferredAppendWhileDragging) return;
      STATE.page = STATE._loadedPage;
      pagingSucceeded = true;
      renderSearchPage(append);
      prefetchNextPage();
      warmConnection();
      syncStateToURL();
    }).catch(function(err) {
      if (id !== searchId) return;
      pagingError = err.name === "AbortError" ? null : err;
      if (err.message === "API_TIMEOUT") {
        console.warn("API timeout");
        return handleApiSearchFailure(append, id);
      }
      if (err.name === "AbortError") {
        if (id === searchId) {
          STATE.isLoading = false;
          if (append) STATE.page = Math.max(1, STATE._loadedPage);
          if (!append) setSearchVisualLoading(false);
        }
        return;
      }
      console.warn("API search failed:", err);
      return handleApiSearchFailure(append, id);
    }).finally(function() {
      if (id === searchId) {
        STATE._pendingPage = 0;
        STATE.isLoading = false;
        STATE.resultsSkeletonActive = false;
        if (!append) setSearchVisualLoading(false);
        else updateStatusBar();
        if (append && !STATE._deferredAppendWhileDragging && (pagingSucceeded || pagingError)) finishPagingAttempt(pagingSucceeded, pagingError);
        else updatePagingStatus();
      }
    });
    return;
  }
  if (continueApi) {
    STATE.isLoading = false;
    STATE.page = STATE._loadedPage;
    finishPagingAttempt(false, new Error("API_UNAVAILABLE"));
    return;
  }
  if (!STATE.dataLoaded) {
    STATE.isLoading = false;
    setSearchVisualLoading(false);
    if (append) {
      STATE.page = Math.max(1, STATE._loadedPage);
      finishPagingAttempt(false);
    }
    showToast("数据加载中，请稍后...");
    return;
  }
  STATE._resultBackend = "local";
  doSearchFallbackLocal(params, append, id);
}

function handleApiSearchFailure(append, id) {
  if (id !== searchId) return Promise.resolve();
  if (append) {
    STATE.page = Math.max(1, STATE._loadedPage);
    showToast("加载更多失败，请重试");
    return Promise.resolve();
  }
  showToast("在线搜索失败，正在切换本地搜索...");
  return ensureLocalDataLoaded(false, false).then(function(ok) {
    if (!ok || id !== searchId) return;
    STATE.useLocalMode = true;
    if (DOM.localModeToggle) DOM.localModeToggle.checked = true;
    syncStateToURL();
    doSearch();
  });
}

function doSearchFallbackLocal(params, append, id) {
  (async function() {
    let pagingSucceeded = false;
    let pagingError = null;
    if (id !== searchId) return;
    try {
      const data = await doSearchLocal(params);
      if (id !== searchId) return;
      if (append && !data.results.length && STATE.results.length < data.total) throw new Error("EMPTY_LOCAL_PAGE");
      if (!applySearchPage(data, append)) return;
      STATE.page = STATE._loadedPage;
      pagingSucceeded = true;
      renderSearchPage(append);
      syncStateToURL();
    } catch (err) {
      console.error("Local Worker search failed:", err);
      if (id !== searchId) return;
      pagingError = err;
      if (append) {
        STATE.page = Math.max(1, STATE._loadedPage);
        return;
      }
      STATE.dataLoaded = false;
      if (params.folderMatchMode === "mixed") {
        showToast("本地目录筛选不可用，请刷新后重试");
      } else if (apiAvailable) {
        STATE.useLocalMode = false;
        if (DOM.localModeToggle) DOM.localModeToggle.checked = false;
        syncStateToURL();
        showToast("本地搜索不可用，正在切换在线搜索...");
        STATE.isLoading = false;
        if (append) STATE.page = STATE._loadedPage + 1;
        doSearch(append);
      } else {
        showToast("本地搜索不可用");
      }
    } finally {
      if (id === searchId) {
        STATE.isLoading = false;
        STATE.resultsSkeletonActive = false;
        if (!append) setSearchVisualLoading(false);
        else updateStatusBar();
        if (append && (pagingSucceeded || pagingError)) finishPagingAttempt(pagingSucceeded, pagingError);
        else updatePagingStatus();
      }
    }
  })();
}

function renderSearchPage(append) {
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
  if (readerReturnScrollState && !readerOverlay) {
    reconcileVirtualRows(STATE.results, 0, 0, 0, getVirtualTotalHeight());
    setResultScrollTop(getVirtualOffset(readerReturnScrollState.index) + readerReturnScrollState.offset);
  }
  renderVisible();
  if (readerReturnScrollState && !readerOverlay) restoreReaderReturnScroll();
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

function buildResultHTML(rec, idx) {
  const iconType = getFileIconType(rec.Extension);
  const titleHTML = highlightText(rec.File, STATE.query);
  const repoShort = escapeHTML((rec.Repo || "").split("/").pop());
  const sizeStr = formatSize(rec.Size);
  const recordLink = getRecordLink(rec);
  const readerRecord = applyReaderAsset(rec, rec.Repo || "", buildRecordRelativePath(rec), recordLink);
  const breadcrumb = (rec.Folder || []).map((f, j) => {
    const accum = (rec.Folder || []).slice(0, j + 1).join("/");
    const folderDisplay = STATE.searchFolders ? highlightText(f, STATE.query) : escapeHTML(f);
    const separator = j < (rec.Folder || []).length - 1 ? '<span class="path-sep">/</span>' : '';
    return '<span class="path-folder" data-folder="' + escapeHTML(accum) + '" data-repo="' + repoShort + '">' + folderDisplay + separator + '</span>';
  }).join("");
  const repoSeparator = (rec.Folder || []).length ? '<span class="path-sep">/</span>' : '';
  return (
    '<input type="checkbox" class="result-checkbox" data-index="' + idx + '">' +
    '<div class="result-file-icon">' + (ICONS[iconType] || ICONS.file) + '</div>' +
    '<div class="result-info">' +
      '<div class="result-title">' + titleHTML +
        (rec.Extension ? '<span style="opacity:0.5;font-size:12px">.' + escapeHTML(rec.Extension) + '</span>' : '') +
      '</div>' +
      '<div class="result-path"><span class="path-folder" data-folder="" data-repo="' + repoShort + '">' + repoShort + repoSeparator + '</span>' + breadcrumb + '</div>' +
      '<div class="result-meta">' +
        (STATE.mode === "global" ? '<span class="result-repo-tag" data-repo="' + repoShort + '">' + repoShort + '</span>' : '') +
        (sizeStr ? '<span class="result-size">' + sizeStr + '</span>' : '') +
      '</div>' +
    '</div>' +
    '<div class="result-actions">' +
      '<button class="result-action-btn" data-action="copy" data-link="' + escapeHTML(getCopyableLink(recordLink)) + '">复制链接</button>' +
      '<button class="result-action-btn primary" data-action="download" data-filename="' + escapeHTML(rec.File + (rec.Extension ? '.' + rec.Extension : '')) + '" data-link="' + escapeHTML(recordLink) + '">下载</button>' +
      '<a href="' + escapeHTML(getPreviewLink(getRecordPath(rec))) + '" class="result-action-btn" target="_blank" rel="noopener noreferrer">仓库查看</a>' +
      (isReadableRecord(readerRecord) ? '<button class="result-action-btn" data-action="read" data-reader-url="' + escapeHTML(getReaderLink(readerRecord)) + '">' + (["audio", "video"].indexOf(VoiceOfMLReader.capability(readerRecord.ReaderExtension || readerRecord.Extension).mode) >= 0 ? "在线播放" : "在线阅读") + '</button>' : '') +
    '</div>'
  );
}

function refreshResultReaderActions() {
  VSCROLL.templateCache.clear();
  for (const row of DOM.resultsList.querySelectorAll(".result-item[data-index]")) {
    const index = Number(row.dataset.index), record = STATE.results[index];
    if (!record) continue;
    const readerRecord = applyReaderAsset(record, record.Repo || "", buildRecordRelativePath(record), getRecordLink(record));
    if (!isReadableRecord(readerRecord)) continue;
    let button = row.querySelector('[data-action="read"]');
    if (!button) {
      button = document.createElement("button"); button.className = "result-action-btn"; button.dataset.action = "read";
      row.querySelector(".result-actions").appendChild(button);
      VSCROLL.measuredRowKeys[index] = null;
    }
    button.dataset.readerUrl = getReaderLink(readerRecord);
    const label = ["audio", "video"].includes(VoiceOfMLReader.capability(readerRecord.ReaderExtension || readerRecord.Extension).mode) ? "在线播放" : "在线阅读";
    if (button.textContent !== label) { button.textContent = label; VSCROLL.measuredRowKeys[index] = null; }
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

function clearResultTemplateCache() {
  VSCROLL.templateCache.clear();
  VSCROLL.templateCacheKey = getResultsHTMLCacheKey();
  VSCROLL.contentVersion++;
  VSCROLL.measuredWindowKey = "";
  VSCROLL.measuredRowKeys = [];
}

function ensureResultTemplateCache() {
  const key = getResultsHTMLCacheKey();
  if (VSCROLL.templateCacheKey !== key) clearResultTemplateCache();
}

function createResultRow(rec, idx) {
  if (!rec) return createResultWindowPlaceholder(idx);
  ensureResultTemplateCache();
  let template = VSCROLL.templateCache.get(idx);
  if (!template) {
    template = document.createElement("div");
    template.className = "result-item" + (idx % 2 === 1 ? " is-alt" : "");
    template.dataset.index = String(idx);
    template.dataset.contentVersion = String(VSCROLL.contentVersion);
    template.innerHTML = buildResultHTML(rec, idx);
    VSCROLL.templateCache.set(idx, template);
    if (VSCROLL.templateCache.size > 240) {
      VSCROLL.templateCache.delete(VSCROLL.templateCache.keys().next().value);
    }
  } else {
    VSCROLL.templateCache.delete(idx);
    VSCROLL.templateCache.set(idx, template);
  }
  const row = template.cloneNode(true);
  resultRowRecords.set(row, rec);
  return row;
}

// Keep native layout safely below Android WebView height limits. Positions,
// height measurements and the proxy thumb always use the full logical range.
const RESULT_SCROLL_SEGMENT_HEIGHT = 1000000;
let resultScrollOrigin = 0;
let resultScrollTarget = null;

function getResultScrollTop() {
  return resultScrollTarget ?? (resultScrollOrigin + DOM.resultsContainer.scrollTop);
}

function setResultScrollTop(value) {
  const total = getVirtualTotalHeight(), viewport = DOM.resultsContainer.clientHeight;
  const target = Math.max(0, Math.min(value, Math.max(0, total - viewport)));
  const physical = target - resultScrollOrigin;
  if (physical >= 0 && physical <= DOM.resultsContainer.scrollHeight - viewport) {
    // Native scrolling rounds subpixels. Round toward the requested row so
    // an exact boundary cannot land on the previous record after restoration.
    DOM.resultsContainer.scrollTop = Math.ceil(physical);
    updateCurrentResultPosition();
    return;
  }
  resultScrollTarget = target;
  VSCROLL.renderStart = -1; VSCROLL.renderEnd = -1;
  try { renderVisible(); } finally { resultScrollTarget = null; }
  updateCurrentResultPosition();
}

function layoutResultScrollSegment(topH, endH, totalH, logicalTop) {
  const viewport = DOM.resultsContainer.clientHeight;
  const limit = RESULT_SCROLL_SEGMENT_HEIGHT;
  const maxOrigin = Math.max(0, totalH - limit);
  const physical = logicalTop - resultScrollOrigin;
  if (resultScrollOrigin > maxOrigin || physical < limit / 4 || physical + viewport > limit * 3 / 4) {
    resultScrollOrigin = Math.max(0, Math.min(maxOrigin, logicalTop - limit / 2));
  }
  const top = DOM.resultsList.querySelector('.virtual-spacer-top');
  const bottom = DOM.resultsList.querySelector('.virtual-spacer-bottom');
  if (top) top.style.height = Math.max(0, topH - resultScrollOrigin) + 'px';
  if (bottom) bottom.style.height = Math.max(0, Math.min(totalH, resultScrollOrigin + limit) - endH) + 'px';
}

function reconcileVirtualRows(items, start, end, topH, bottomH) {
  const logicalTop = getResultScrollTop();
  const previousOrigin = resultScrollOrigin;
  let topSpacer = DOM.resultsList.querySelector(".virtual-spacer-top");
  let bottomSpacer = DOM.resultsList.querySelector(".virtual-spacer-bottom");
  if (!topSpacer) {
    topSpacer = document.createElement("div");
    topSpacer.className = "virtual-spacer virtual-spacer-top";
    DOM.resultsList.prepend(topSpacer);
  }
  if (!bottomSpacer) {
    bottomSpacer = document.createElement("div");
    bottomSpacer.className = "virtual-spacer virtual-spacer-bottom";
    DOM.resultsList.append(bottomSpacer);
  }
  const endH = getVirtualOffset(end);
  layoutResultScrollSegment(topH, endH, endH + bottomH, logicalTop);

  const existing = new Map();
  DOM.resultsList.querySelectorAll(".result-item[data-index]").forEach((row) => {
    const idx = Number(row.dataset.index);
    if (idx < start || idx >= end || Number(row.dataset.contentVersion) !== VSCROLL.contentVersion || resultRowRecords.get(row) !== items[idx]) row.remove();
    else existing.set(idx, row);
  });
  let cursor = topSpacer.nextSibling;
  for (let idx = start; idx < end; idx++) {
    const row = existing.get(idx) || createResultRow(items[idx], idx);
    if (row !== cursor) DOM.resultsList.insertBefore(row, cursor || bottomSpacer);
    cursor = row.nextSibling;
  }
  if (DOM.resultsList.lastElementChild !== bottomSpacer) DOM.resultsList.append(bottomSpacer);
  if (previousOrigin !== resultScrollOrigin || resultScrollTarget !== null) {
    DOM.resultsContainer.scrollTop = Math.ceil(logicalTop - resultScrollOrigin);
    resultScrollTarget = null;
  }
}

function scheduleVirtualRender() {
  if (VSCROLL.renderFrame) return;
  VSCROLL.renderFrame = requestAnimationFrame(() => {
    VSCROLL.renderFrame = 0;
    renderVisible();
  });
}

function renderVisible() {
  const items = STATE.results;
  const len = resultWindow ? resultWindow.total : items.length;
  ensureVirtualHeights(len);
  if (len === 0) {
    updateScrollTrack();
    return;
  }
  const container = DOM.resultsContainer;
  const scrollTop = getResultScrollTop();
  const viewH = container.clientHeight;
  const est = VSCROLL.estimatedHeight;
  const overscanItems = Math.max(10, Math.floor(viewH / (est || 60)));
  const now = performance.now();
  const elapsed = VSCROLL.lastScrollTime ? Math.max(1, now - VSCROLL.lastScrollTime) : 16;
  const instantVelocity = Math.abs(scrollTop - VSCROLL.lastScrollTop) / elapsed;
  VSCROLL.scrollVelocity = VSCROLL.scrollVelocity * 0.7 + instantVelocity * 0.3;
  VSCROLL.lastScrollTime = now;
  const extraScreens = VSCROLL.isDraggingThumb ? 0 : Math.min(3, Math.floor(VSCROLL.scrollVelocity / 1.5));
  const baseOverscanPx = overscanItems * (est || 60);
  const velocityOverscanPx = extraScreens * viewH;
  ensureHeightTree();
  const scrollingDown = scrollTop >= VSCROLL.lastScrollTop;
  VSCROLL.lastScrollTop = scrollTop;
  const safeStart = findVirtualIndex(Math.max(0, scrollTop - baseOverscanPx * 0.35));
  const safeEnd = Math.min(len, findVirtualIndex(scrollTop + viewH + baseOverscanPx * 0.35) + 1);
  ensureResultWindowPages(safeStart, safeEnd);
  updateCurrentResultPosition();
  if (!pendingResultEntrance && VSCROLL.renderStart <= safeStart && VSCROLL.renderEnd >= safeEnd) return;
  const beforePx = VSCROLL.isDraggingThumb
    ? viewH * 0.35
    : baseOverscanPx * (scrollingDown ? 1 : 2) + (scrollingDown ? 0 : velocityOverscanPx);
  const afterPx = VSCROLL.isDraggingThumb
    ? viewH * 0.35
    : baseOverscanPx * (scrollingDown ? 2 : 1) + (scrollingDown ? velocityOverscanPx : 0);
  let start = findVirtualIndex(Math.max(0, scrollTop - beforePx));
  let end = Math.min(len, findVirtualIndex(scrollTop + viewH + afterPx) + 1);
  if (end - start < 10 && len > 10) end = Math.min(start + 30, len);
  if (pendingResultEntrance && start === 0) end = Math.min(len, Math.max(end, 30));
  ensureResultWindowPages(start, end);
  if (start === VSCROLL.renderStart && end === VSCROLL.renderEnd) return;
  VSCROLL.renderStart = start;
  VSCROLL.renderEnd = end;
  const totalH = fenwickSum(VSCROLL.heightTree, len);
  const topH = fenwickSum(VSCROLL.heightTree, start);
  const endH = fenwickSum(VSCROLL.heightTree, end);
  const bottomH = Math.max(0, totalH - endH);
  const anchorIndex = findVirtualIndex(scrollTop);
  const anchor = { index: anchorIndex, offset: scrollTop - getVirtualOffset(anchorIndex) };
  reconcileVirtualRows(items, start, end, topH, bottomH);
  if (DOM.multiSelectToggle && DOM.multiSelectToggle.checked) updateSelectionUI();
  // Correct the rendered window before paint, using one content anchor.
  // A deferred measurement can otherwise run against another window/query.
  if (!VSCROLL.isDraggingThumb && measureHeights(start, end, anchor)) {
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
    scheduleVirtualRender();
  }
  updateScrollTrack();
  if (pendingResultEntrance) {
    pendingResultEntrance = false;
    animateVisibleResultRows();
  }
}

function ensureHeightTree() {
  const len = VSCROLL.heights.length;
  if (!VSCROLL.heightsDirty && VSCROLL.heightTree.length === len + 1) return;
  if (VSCROLL.sparseHeights) {
    const tree = new Array(len + 1);
    for (const key of Object.keys(VSCROLL.heights)) fenwickAdd(tree, Number(key) + 1, VSCROLL.heights[key] - VSCROLL.heightBase);
    VSCROLL.heightTree = tree; VSCROLL.heightsDirty = false;
    return;
  }
  const tree = new Array(len + 1).fill(0);
  const est = VSCROLL.estimatedHeight || 60;
  for (let i = 1; i <= len; i++) {
    tree[i] += VSCROLL.heights[i - 1] || est;
    const parent = i + (i & -i);
    if (parent <= len) tree[parent] += tree[i];
  }
  VSCROLL.heightTree = tree;
  VSCROLL.heightsDirty = false;
}

function fenwickAdd(tree, idx, delta) {
  if (!delta) return;
  for (let i = idx; i < tree.length; i += i & -i) tree[i] = (tree[i] || 0) + delta;
}

function fenwickSum(tree, idx) {
  let sum = VSCROLL.sparseHeights ? idx * VSCROLL.heightBase : 0;
  for (let i = idx; i > 0; i -= i & -i) sum += tree[i] || 0;
  return sum;
}

function getVirtualTotalHeight() {
  ensureHeightTree();
  return fenwickSum(VSCROLL.heightTree, VSCROLL.heights.length);
}

function getVirtualOffset(index) {
  ensureHeightTree();
  return fenwickSum(VSCROLL.heightTree, Math.max(0, Math.min(index, VSCROLL.heights.length)));
}

function findVirtualIndex(offset) {
  ensureHeightTree();
  const len = VSCROLL.heights.length;
  let idx = 0;
  let bit = 1;
  while ((bit << 1) < VSCROLL.heightTree.length) bit <<= 1;
  let sum = 0;
  for (; bit > 0; bit >>= 1) {
    const next = idx + bit;
    const height = (VSCROLL.heightTree[next] || 0) + (VSCROLL.sparseHeights ? (next & -next) * VSCROLL.heightBase : 0);
    if (next < VSCROLL.heightTree.length && sum + height <= offset) {
      idx = next;
      sum += height;
    }
  }
  return Math.min(Math.max(0, idx), Math.max(0, len - 1));
}

function resetVirtualScrollState() {
  resultScrollOrigin = 0;
  resultScrollTarget = null;
  rememberDisplayedSearchView();
  cancelQuickScroll();
  if (VSCROLL.renderFrame) cancelAnimationFrame(VSCROLL.renderFrame);
  VSCROLL.renderFrame = 0;
  activateSearchView();
  VSCROLL.renderStart = 0;
  VSCROLL.renderEnd = 0;
  VSCROLL.heights = [];
  VSCROLL.sparseHeights = !!resultWindow;
  VSCROLL.heightBase = VSCROLL.estimatedHeight || 60;
  VSCROLL.heightTree = [];
  VSCROLL.heightsDirty = true;
  VSCROLL.lastScrollTop = 0;
  VSCROLL.lastScrollTime = 0;
  VSCROLL.scrollVelocity = 0;
  VSCROLL.estimateMeasurementKey = "";
  clearResultTemplateCache();
  updateScrollTrack();
}

function prepareRouteTransitionResults() {
  saveSearchViewSnapshot();
  cancelQuickScroll();
}

function ensureVirtualHeights(len) {
  if (VSCROLL.heights.length >= len) return;
  const oldLen = VSCROLL.heights.length;
  if (VSCROLL.sparseHeights) {
    VSCROLL.heights.length = len; VSCROLL.measuredRowKeys.length = len;
    const measurementKey = getHeightMeasurementKey();
    for (const key of Object.keys(STATE.results)) if (Number(key) >= oldLen) {
      const cached = VSCROLL.heightCache.get(getResultStableId(STATE.results[key]));
      if (cached?.measurementKey === measurementKey) VSCROLL.heights[key] = cached.height;
    }
    VSCROLL.heightsDirty = true;
    return;
  }
  const canExtendTree = !VSCROLL.heightsDirty && VSCROLL.heightTree.length === oldLen + 1;
  VSCROLL.heights.length = len;
  VSCROLL.measuredRowKeys.length = len;
  const measurementKey = getHeightMeasurementKey();
  for (let i = oldLen; i < len; i++) {
    const cached = VSCROLL.heightCache.get(getResultStableId(STATE.results[i]));
    VSCROLL.heights[i] = cached?.measurementKey === measurementKey
      ? cached.height
      : VSCROLL.estimatedHeight;
  }
  if (canExtendTree) {
    const newPrefix = new Array(len - oldLen + 1).fill(0);
    for (let i = oldLen; i < len; i++) newPrefix[i - oldLen + 1] = newPrefix[i - oldLen] + VSCROLL.heights[i];
    VSCROLL.heightTree.length = len + 1;
    for (let i = oldLen + 1; i <= len; i++) {
      const rangeStart = i - (i & -i) + 1;
      const oldStart = Math.max(1, rangeStart);
      const oldEnd = Math.min(oldLen, i);
      const oldSum = oldEnd >= oldStart
        ? fenwickSum(VSCROLL.heightTree, oldEnd) - fenwickSum(VSCROLL.heightTree, oldStart - 1)
        : 0;
      const newStart = Math.max(oldLen + 1, rangeStart);
      const newSum = newPrefix[i - oldLen] - newPrefix[newStart - oldLen - 1];
      VSCROLL.heightTree[i] = oldSum + newSum;
    }
  } else {
    VSCROLL.heightsDirty = true;
  }
}

function refreshVirtualAfterAppend(updateView = true) {
  if (updateView && !positionRestore && STATE._loadedPage >= 1) rememberDisplayedSearchView();
  ensureVirtualHeights(STATE.results.length);
  const topSpacer = DOM.resultsList.querySelector(".virtual-spacer-top");
  const bottomSpacer = DOM.resultsList.querySelector(".virtual-spacer-bottom");
  if (!topSpacer || !bottomSpacer || VSCROLL.renderStart < 0 || VSCROLL.renderEnd <= VSCROLL.renderStart) {
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
    renderVisible();
    return;
  }
  ensureHeightTree();
  const topH = fenwickSum(VSCROLL.heightTree, VSCROLL.renderStart);
  const endH = fenwickSum(VSCROLL.heightTree, VSCROLL.renderEnd);
  const totalH = fenwickSum(VSCROLL.heightTree, VSCROLL.heights.length);
  const logicalTop = getResultScrollTop(), previousOrigin = resultScrollOrigin;
  layoutResultScrollSegment(topH, endH, totalH, logicalTop);
  if (previousOrigin !== resultScrollOrigin) DOM.resultsContainer.scrollTop = logicalTop - resultScrollOrigin;
}

function ensureVirtualViewportCovered() {
  if (VSCROLL.renderStart < 0 || VSCROLL.renderEnd <= VSCROLL.renderStart) return;
  const viewTop = getResultScrollTop();
  const viewBottom = viewTop + DOM.resultsContainer.clientHeight;
  if (viewTop < getVirtualOffset(VSCROLL.renderStart) || viewBottom > getVirtualOffset(VSCROLL.renderEnd)) renderVisible();
}

function measureHeights(start = VSCROLL.renderStart, end = VSCROLL.renderEnd, anchor = null) {
  if (VSCROLL.isDraggingThumb || start !== VSCROLL.renderStart || end !== VSCROLL.renderEnd) return false;
  const container = DOM.resultsContainer;
  const anchorIndex = anchor ? anchor.index : findVirtualIndex(getResultScrollTop());
  const anchorOffset = anchor ? anchor.offset : getResultScrollTop() - getVirtualOffset(anchorIndex);
  const rowMeasureKey = getHeightMeasurementKey();
  const measureKey = [rowMeasureKey, start, end].join(":");
  if (VSCROLL.measuredWindowKey === measureKey) return false;
  const els = DOM.resultsList.querySelectorAll(".result-item");
  const measurements = [];
  let measuredSum = 0;
  let measuredCount = 0;
  let changed = false;
  for (let i = 0; i < els.length; i++) {
    const idx = parseInt(els[i].dataset.index);
    if (!STATE.results[idx]) continue;
    if (!Number.isInteger(idx) || idx < 0 || idx >= VSCROLL.heights.length) continue;
    if (VSCROLL.measuredRowKeys[idx] === rowMeasureKey && VSCROLL.heights[idx] > 0) {
      measuredSum += VSCROLL.heights[idx];
      measuredCount++;
      continue;
    }
    const height = els[i].getBoundingClientRect().height;
    if (height <= 0) continue;
    measurements.push([idx, height]);
    measuredSum += height;
    measuredCount++;
    VSCROLL.measuredRowKeys[idx] = rowMeasureKey;
    measuredHeightRevision++;
    VSCROLL.heightCache.set(getResultStableId(STATE.results[idx]), { height, measurementKey: rowMeasureKey });
  }
  for (let i = 0; i < measurements.length; i++) {
    const idx = measurements[i][0];
    const height = measurements[i][1];
    if (VSCROLL.heights[idx] !== height) {
      const prev = VSCROLL.heights[idx] || VSCROLL.estimatedHeight || 60;
      VSCROLL.heights[idx] = height;
      if (!VSCROLL.heightsDirty && VSCROLL.heightTree.length === VSCROLL.heights.length + 1) {
        fenwickAdd(VSCROLL.heightTree, idx + 1, height - prev);
      } else {
        VSCROLL.heightsDirty = true;
      }
      changed = true;
    }
  }
  if (!VSCROLL.sparseHeights && measuredCount > 10 && VSCROLL.estimateMeasurementKey !== rowMeasureKey) {
    VSCROLL.estimateMeasurementKey = rowMeasureKey;
    const nextEstimate = measuredSum / measuredCount;
    if (Math.abs(nextEstimate - VSCROLL.estimatedHeight) > 1) {
      VSCROLL.estimatedHeight = nextEstimate;
      // Seed estimates at the top only. Rescaling the entire unseen list
      // from each new window moves the thumb and can clamp scrollTop to bottom.
      if (getResultScrollTop() === 0 && start === 0) {
        for (let index = 0; index < VSCROLL.heights.length; index++) {
          if (!VSCROLL.measuredRowKeys[index]) VSCROLL.heights[index] = nextEstimate;
        }
        VSCROLL.heightsDirty = true;
        changed = true;
      }
    }
  }
  if (changed) {
    refreshVirtualAfterAppend(false);
    const target = getVirtualOffset(anchorIndex) + Math.min(anchorOffset, VSCROLL.heights[anchorIndex] - 1);
    if (Math.abs(getResultScrollTop() - target) > 0.5) setResultScrollTop(Math.max(0, target));
    VSCROLL.lastScrollTop = getResultScrollTop();
  }
  VSCROLL.measuredWindowKey = measureKey;
  return changed;
}

function updateStatusBar() {
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
  cancelPendingSearchControls();
  saveSearchViewSnapshot();
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

function setupSizeFilterControls() {
  const schedule = () => {
    clearTimeout(sizeFilterTimer);
    sizeFilterTimer = setTimeout(() => {
      sizeFilterTimer = null;
      STATE.filterMinSize = sizeInputToBytes(DOM.filterMinSize, DOM.filterMinUnit);
      STATE.filterMaxSize = sizeInputToBytes(DOM.filterMaxSize, DOM.filterMaxUnit);
      doFilterSearch(true);
    }, 500);
  };
  [DOM.filterMinSize, DOM.filterMaxSize].forEach(input => input.addEventListener("input", schedule));
  [DOM.filterMinUnit, DOM.filterMaxUnit].forEach(select => select.addEventListener("change", schedule));
}

function scheduleFilterSearch(clearResults = false) {
  prepareFilterChange(clearResults);
  cancelPositionRestore();
  resetPagingRecovery();
  if (searchAbortController) searchAbortController.abort();
  cancelSearchPrefetch();
  searchId++;
  searchRequestId++;
  STATE.isLoading = true;
  setSearchVisualLoading(true);
  syncStateToURL(true);
  filterSearchTimer = setTimeout(() => {
    filterSearchTimer = null;
    doFilterSearch();
  }, FILTER_SEARCH_DEBOUNCE_MS);
}

function updateCurrentResultPosition() {
  const label = document.getElementById("current-result-position");
  if (!label) return;
  label.hidden = !(STATE.results.length || STATE.total);
  if (STATE.results.length || STATE.total) {
    const index = findVirtualIndex(getResultScrollTop());
    if (document.activeElement !== label) label.value = index + 1;
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
  DOM.currentResultPosition.style.setProperty("--position-width", String(Math.max(1, STATE.total)).length + "ch");
  updateCurrentResultPosition();
  requestAnimationFrame(updateScrollTrack);
}

function renderSidebar(routeId) {
  if (STATE.mode === "global") {
    renderRepoList(routeId);
  } else {
    renderBrowser(STATE.browserPath || "", routeId);
  }
}

function renderRepoListItems(repos) {
  var html = "";
  for (var i = 0; i < repos.length; i++) {
    var repo = repos[i];
    var short = repo.name.split("/").pop();
    html += '<div class="repo-list-item" data-repo="' + escapeHTML(short) + '">';
    html += '<svg class="repo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';
    html += '<span class="repo-name">' + escapeHTML(short) + '</span>';
    html += '<span class="repo-count">' + (repo.count || 0).toLocaleString() + '</span>';
    html += '</div>';
  }
  DOM.sidebarContent.innerHTML = html;
  updateSidebarHeader();
}

async function renderRepoList(routeId) {
  var repos = null;
  if (repoList && repoList.length > 0) {
    repos = repoList;
  } else {
    var initial = await loadSidebarInitial(null);
    if (initial && Array.isArray(initial.repos) && initial.repos.length) {
      if (routeId && routeId !== routeRenderId) return;
      renderRepoListItems(initial.repos);
      repos = initial.repos;
    }
    if (apiAvailable) {
      var freshRepos = await fetchRepos();
      if (freshRepos && Array.isArray(freshRepos) && freshRepos.length) repos = freshRepos;
    }
  }
  if (routeId && routeId !== routeRenderId) return;
  if (!repos || !Array.isArray(repos) || repos.length === 0) {
    DOM.sidebarContent.innerHTML = '<div class="sidebar-loading">暂无仓库</div>';
    updateSidebarHeader();
    return;
  }
  renderRepoListItems(repos);
}

function renderBrowserListItems(list, data, currentRepo, path) {
  list.innerHTML = "";
  for (var j = 0; j < (data.folders || []).length; j++) {
    var f = data.folders[j];
    var div = document.createElement("div");
    div.className = "browser-item";
    div.innerHTML = ICONS.folder + '<span class="browser-name">' + escapeHTML(f.name) + '</span><span class="browser-count">' + (f.count || 0).toLocaleString() + '</span>';
    div.addEventListener("click", (function(fp) { return function() { ROUTER.navigate("repo", STATE.repo, fp); }; })(f.path));
    list.appendChild(div);
  }
  for (var k = 0; k < (data.files || []).length; k++) {
    var f2 = data.files[k];
    var div2 = document.createElement("div");
    div2.className = "browser-item";
    var iconType = getFileIconType(f2.ext);
    var sizeStr = formatSize(f2.size);
    var browserFileName = getBrowserFileName(f2);
    var browserFileLink = getBrowserFileLink(currentRepo, path || "", f2);
    div2.dataset.link = browserFileLink;
    var browserAssetPath = path ? path + "/" + browserFileName : browserFileName;
    var warmBrowserRecord = applyReaderAsset({ File: f2.name, Extension: f2.ext, Link: browserFileLink }, currentRepo, browserAssetPath, browserFileLink);
    var warmReaderLink = VoiceOfMLReader.readerUrl(warmBrowserRecord, "/search/static/reader.html");
    if (warmReaderLink) div2.dataset.readerUrl = warmReaderLink;
    div2.innerHTML = (ICONS[iconType] || ICONS.file) +
      '<span class="browser-name">' + escapeHTML(browserFileName) + '</span>' +
      '<span class="browser-action" data-download="1">下载</span>' +
      (sizeStr ? '<span class="browser-size">' + sizeStr + '</span>' : '');
    div2.addEventListener("click", function(ff, ppath) {
      return function(e) {
        var fileLink = getBrowserFileLink(currentRepo, ppath, ff);
        if (e.target.closest(".browser-action")) {
          e.stopPropagation();
          if (fileLink) downloadFile(getBrowserFileName(ff), fileLink, { button: e.target.closest(".browser-action") });
          return;
        }
        var assetPath = ppath ? ppath + "/" + getBrowserFileName(ff) : getBrowserFileName(ff);
        var browserRecord = { File: ff.name, Extension: ff.ext, Link: fileLink, ReturnUrl: location.href };
        if (ff.hasTxt && String(ff.ext || "").toLowerCase() !== "txt") { var relPath = (ppath ? ppath + "/" : "") + getBrowserFileName(ff); browserRecord.OcrUrl = API_BASE + "/txt/" + encodeRecordPath(VoiceOfMLReader.txtRelativePath(relPath)); }
        browserRecord = applyReaderAsset(browserRecord, currentRepo, assetPath, fileLink);
        var readerLink = isReadableRecord(browserRecord) ? VoiceOfMLReader.readerUrl(browserRecord, "/search/static/reader.html") : "";
        if (readerLink) {
          navigateToReader(readerLink);
          return;
        }
        if (fileLink) {
          downloadFile(getBrowserFileName(ff), fileLink);
        }
      };
    }(f2, path || ""));
    list.appendChild(div2);
  }
}

function createSidebarBreadcrumb(path) {
  const breadcrumb = document.createElement("div");
  breadcrumb.className = "sidebar-breadcrumb";
  breadcrumb.setAttribute("aria-label", "当前路径");
  const parts = path ? path.split("/") : [];
  breadcrumb.innerHTML = '<span class="crumb-item' + (!path ? ' current' : '') + '" data-path="">根目录</span>';
  for (let i = 0; i < parts.length; i++) {
    const partPath = parts.slice(0, i + 1).join("/");
    breadcrumb.innerHTML += '<span class="crumb-sep">/</span>';
    breadcrumb.innerHTML += '<span class="crumb-item' + (i === parts.length - 1 ? ' current' : '') + '" data-path="' + escapeHTML(partPath) + '">' + escapeHTML(parts[i]) + '</span>';
  }
  breadcrumb.querySelectorAll(".crumb-item").forEach(function(item) {
    item.addEventListener("click", function() {
      if (!item.classList.contains("current")) ROUTER.navigate("repo", STATE.repo, item.dataset.path);
    });
  });
  return breadcrumb;
}

async function renderBrowser(path, routeId) {
  if (routeId && routeId !== routeRenderId) return;
  STATE.browserPath = path;
  syncStateToURL();
  DOM.sidebarContent.innerHTML = "";
  var currentRepo = STATE.repoFull;
  DOM.sidebarContent.appendChild(createSidebarBreadcrumb(path));
  const list = document.createElement("div");
  list.className = "browser-list";
  list.innerHTML = '<div class="sidebar-loading">加载中...</div>';
  DOM.sidebarContent.appendChild(list);
  var data = null;
  var initialData = null;
  if (!path) {
    var initial = await loadSidebarInitial(STATE.repo);
    if (initial && (!routeId || routeId === routeRenderId) && STATE.mode === "repo" && STATE.repo === currentRepo.split("/").pop() && STATE.browserPath === path) {
      renderBrowserListItems(list, initial, currentRepo, path);
      initialData = initial;
      data = initial;
    }
  }
  if (folderContentsCache.has(STATE.repoFull + "|" + (path || ""))) {
    data = folderContentsCache.get(STATE.repoFull + "|" + (path || ""));
  }
  if (!data && apiAvailable) {
    try {
      var repo = STATE.repo;
      var freshData = await fetchFolderContents(repo, path);
      if (routeId && routeId !== routeRenderId) return;
      if (STATE.mode !== "repo" || STATE.repo !== repo || STATE.browserPath !== path) return;
      if (freshData) data = freshData;
    } catch (e) {}
  }
  if (!data && STATE.dataLoaded) {
    try {
      data = await getFolderContents(STATE.repoFull, path);
      if (routeId && routeId !== routeRenderId) return;
      if (STATE.mode !== "repo" || STATE.repoFull !== currentRepo || STATE.browserPath !== path) return;
    } catch (e) {}
  }
  if (!data || (!data.folders && !data.files)) {
    if (initialData) return;
    if ((!routeId || routeId === routeRenderId) && STATE.mode === "repo" && STATE.browserPath === path) {
      var retryKey = STATE.repo + "|" + (path || "");
      var tries = sidebarRetryCounts.get(retryKey) || 0;
      if (tries < 2) {
        sidebarRetryCounts.set(retryKey, tries + 1);
        list.innerHTML = '<div class="sidebar-loading">加载失败，正在重试...</div>';
        setTimeout(function() {
          if ((!routeId || routeId === routeRenderId) && STATE.mode === "repo" && STATE.browserPath === path) renderBrowser(path, routeId || routeRenderId);
        }, 1200);
      } else {
        list.innerHTML = '<div class="sidebar-loading">加载失败</div>';
      }
    }
    return;
  }
  sidebarRetryCounts.delete(STATE.repo + "|" + (path || ""));
  renderBrowserListItems(list, data, currentRepo, path);
}

async function renderFilters(routeId) {
  var extensionPromise = renderExtensionFilter(routeId);
  if (STATE.mode === "global") {
    DOM.filterRepoSection.style.display = "";
    await renderRepoFilter(routeId);
  } else {
    DOM.filterRepoSection.style.display = "none";
  }
  if (STATE.mode === "repo") {
    var folderRepo = STATE.repo;
    var folderRepoFull = STATE.repoFull;
    DOM.filterFolderSection.style.display = "";
    DOM.filterFolderTree.innerHTML = '<div style="font-size:12px;color:var(--on-surface-variant);opacity:0.6">加载中...</div>';
    var folderTree = folderTreeCache.get(folderRepoFull) || null;
    var initialFolderTree = null;
    if (!folderTree || !folderTree.length) {
      try {
        var initialSidebar = await loadSidebarInitial(folderRepo);
        if (initialSidebar && Array.isArray(initialSidebar.folders)) {
          initialFolderTree = initialSidebar.folders.map(function(folder) {
            return { name: folder.name, path: folder.path || folder.name, count: folder.count || 0, children: [], hasChildren: false, hasDirectFiles: true };
          });
        }
      } catch (e) {}
    }
    if (!folderTree || !folderTree.length) {
      if (apiAvailable) {
        try {
          const tree = await fetchFolderTree(folderRepo, folderRepoFull);
          if (routeId && routeId !== routeRenderId) return;
          if (STATE.mode !== "repo" || STATE.repo !== folderRepo || STATE.repoFull !== folderRepoFull) return;
          if (tree) {
            folderTreeCache.set(folderRepoFull, tree);
            folderTree = tree;
          }
        } catch (e) {}
      }
    }
    if ((!folderTree || !folderTree.length) && STATE.dataLoaded) {
      try {
        const localTree = await corpusWorkerRequest("folder-tree", { repo: folderRepoFull }, WORKER_REQUEST_TIMEOUT);
        folderTree = localTree && localTree.tree || [];
        if (folderTree.length) folderTreeCache.set(folderRepoFull, folderTree);
      } catch (e) {}
    }
    if ((!folderTree || !folderTree.length) && initialFolderTree && initialFolderTree.length) {
      folderTree = initialFolderTree;
    }
    if (routeId && routeId !== routeRenderId) return;
    if (STATE.mode !== "repo" || STATE.repo !== folderRepo || STATE.repoFull !== folderRepoFull) return;
    STATE.folderTree = folderTree;
    if (STATE.folderTree && STATE.folderTree.length) initializeFolderTreeCollapsed(STATE.folderTree);
    renderFilterFolderTree();
  } else {
    DOM.filterFolderSection.style.display = "none";
  }
  await extensionPromise;
}

async function renderRepoFilter(routeId) {
  var repos = repoList;
  if (!repos || repos.length === 0) {
    try {
      var initial = await loadSidebarInitial(null);
      if (initial && Array.isArray(initial.repos)) repos = initial.repos;
    } catch (e) {}
  }
  if (apiAvailable && (!repos || repos.length === 0)) {
    try {
      repos = await fetchRepos();
    } catch (e) {}
  }
  if (routeId && routeId !== routeRenderId) return;
  repos = Array.isArray(repos) ? repos : [];
  var items = [];
  for (var i = 0; i < repos.length; i++) {
    items.push({
      key: repos[i].name,
      label: repos[i].name.split("/").pop(),
      count: repos[i].count,
    });
  }
  renderCheckboxList(DOM.filterRepoList, items, STATE.filterRepos, function(vals) {
    STATE.filterRepos = vals;
    updateFilterCancelButtons();
    scheduleFilterSearch(true);
  });
}

let extensionFilterRenderId = 0;

async function renderExtensionFilter(routeId) {
  var renderId = ++extensionFilterRenderId;
  var renderMode = STATE.mode;
  var renderRepo = STATE.repo;
  var renderRepoFull = STATE.repoFull;
  var extData = null;
  if (extensionList && extensionList.length > 0) {
    var currentCounts = renderMode === "repo" && renderRepoFull
      ? Object.fromEntries((repoExtensionCounts[renderRepoFull] || []).map(function(item) { return [item.name, item.count || 0]; }))
      : extensionCounts;
    var currentExtNames = Object.keys(currentCounts).sort();
    if (currentExtNames.length) {
      extData = [];
      for (var li = 0; li < currentExtNames.length; li++) {
        var lext = currentExtNames[li];
        extData.push({ name: lext, count: currentCounts[lext] || 0 });
      }
    }
  }
  if (extData === null && apiAvailable) {
    try {
      extData = await fetchExtensions(renderRepo);
    } catch (e) {}
  }
  if (renderId !== extensionFilterRenderId) return;
  if (routeId && routeId !== routeRenderId) return;
  if (STATE.mode !== renderMode || STATE.repo !== renderRepo || STATE.repoFull !== renderRepoFull) return;
  STATE.extensionList = extData && Array.isArray(extData)
    ? extData
      .filter(function(item) { return item && typeof item.name === "string"; })
      .map(function(item) { return item.name; })
    : [];
  extData = extData && Array.isArray(extData) ? extData : [];
  var extMap = {};
  for (var extIdx = 0; extIdx < extData.length; extIdx++) {
    if (extData[extIdx] && extData[extIdx].name) extMap[extData[extIdx].name] = true;
  }
  for (var selIdx = 0; selIdx < STATE.filterExtensions.length; selIdx++) {
    var selectedExt = STATE.filterExtensions[selIdx];
    if (selectedExt && !extMap[selectedExt]) {
      extData.push({ name: selectedExt, count: 0 });
      extMap[selectedExt] = true;
    }
  }
  var ordered = [];
  var rest = [];
  if (extData.length > 0) {
  for (var n = 0; n < extData.length; n++) {
    var e = extData[n];
    if (!e || typeof e.name !== "string") continue;
    var idx_e = ORDERED_EXTENSIONS.indexOf(e.name);
    if (idx_e >= 0) {
        ordered.push({ name: e.name, _idx: idx_e, count: e.count || 0 });
    } else {
      rest.push(e);
    }
    }
  }
  ordered.sort(function(a, b) { return a._idx - b._idx || a.name.localeCompare(b.name); });
  var items = [];
  for (var j = 0; j < ordered.length; j++) {
    items.push({ key: ordered[j].name, label: "." + ordered[j].name, count: ordered[j].count });
  }
  renderExtensionTree(DOM.filterExtList, items, rest, STATE.filterExtensions, function(vals) {
    STATE.filterExtensions = vals;
    saveStoredExtensionFilters();
    updateFilterCancelButtons();
    scheduleFilterSearch();
  });
}

function renderExtensionTree(container, items, rest, selected, onChange) {
  if (items.length === 0 && rest.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--on-surface-variant);opacity:0.6;padding:4px 0">暂无</div>';
    return;
  }
  var selectedSet = new Set(selected || []);
  var html = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    html.push('<label class="filter-checkbox-item"><input type="checkbox" value="' + escapeHTML(item.key) + '" ' + (selectedSet.has(item.key) ? 'checked' : '') + '><span>' + escapeHTML(item.label) + '</span><span class="checkbox-count">' + (item.count || 0).toLocaleString() + '</span></label>');
  }
  if (rest.length > 0) {
    var total = 0;
    var restSelectedCount = 0;
    for (var r = 0; r < rest.length; r++) {
      total += rest[r].count || 0;
      if (selectedSet.has(rest[r].name)) restSelectedCount++;
    }
    var parentChecked = restSelectedCount === rest.length;
    var collapsed = STATE.extensionOtherCollapsed !== false;
    html.push('<div class="filter-folder-item ext-other-row" style="--fdepth:0"><input type="checkbox" value="__OTHER__" ' + (parentChecked ? 'checked' : '') + '><span class="ext-other-spacer" aria-hidden="true"></span><button type="button" class="ext-other-toggle" aria-expanded="' + (collapsed ? 'false' : 'true') + '">其他 (' + rest.length + '种)<span class="folder-count">' + total.toLocaleString() + '</span></button></div>');
    html.push('<div class="tree-children ext-other-children" style="display:' + (collapsed ? 'none' : 'block') + '">');
    var restSorted = rest.slice().sort(function(a, b) { return a.name.localeCompare(b.name); });
    for (var s = 0; s < restSorted.length; s++) {
      var child = restSorted[s];
      html.push('<label class="filter-folder-item" style="--fdepth:1"><span class="tree-toggle-placeholder"></span><input type="checkbox" value="' + escapeHTML(child.name) + '" ' + (selectedSet.has(child.name) ? 'checked' : '') + '><span class="folder-name">.' + escapeHTML(child.name) + '</span><span class="folder-count">' + (child.count || 0).toLocaleString() + '</span></label>');
    }
    html.push('</div>');
  }
  container.innerHTML = html.join("");
  var parentCb = container.querySelector('input[value="__OTHER__"]');
  if (parentCb) {
    var initiallySelectedRestCount = 0;
    for (var initialIndex = 0; initialIndex < rest.length; initialIndex++) {
      if (selectedSet.has(rest[initialIndex].name)) initiallySelectedRestCount++;
    }
    parentCb.indeterminate = initiallySelectedRestCount > 0 && initiallySelectedRestCount < rest.length;
  }
  var refreshExtOtherParentState = function(nextSet) {
    var parent = container.querySelector('input[value="__OTHER__"]');
    if (!parent || rest.length === 0) return;
    var selectedRestCount = 0;
    for (var ri = 0; ri < rest.length; ri++) {
      if (nextSet.has(rest[ri].name)) selectedRestCount++;
    }
    parent.checked = selectedRestCount === rest.length;
    parent.indeterminate = selectedRestCount > 0 && selectedRestCount < rest.length;
  };
  var emit = function(nextSet) { onChange(Array.from(nextSet)); };
  container.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
    cb.addEventListener("change", function() {
      var nextSet = new Set(STATE.filterExtensions || []);
      if (cb.value === "__OTHER__") {
        for (var o = 0; o < rest.length; o++) {
          if (cb.checked) nextSet.add(rest[o].name);
          else nextSet.delete(rest[o].name);
        }
      } else if (cb.checked) nextSet.add(cb.value);
      else nextSet.delete(cb.value);
      container.querySelectorAll('input[type="checkbox"]').forEach(function(input) {
        if (input.value !== "__OTHER__") input.checked = nextSet.has(input.value);
      });
      refreshExtOtherParentState(nextSet);
      emit(nextSet);
    });
  });
  var toggleButton = container.querySelector(".ext-other-toggle");
  if (toggleButton) toggleButton.addEventListener("click", function() { toggleExtensionOther(toggleButton); });
}

function toggleExtensionOther(button) {
  var children = button.parentElement && button.parentElement.nextElementSibling;
  if (!children || !children.classList.contains("ext-other-children")) return false;
  var expanding = STATE.extensionOtherCollapsed !== false;
  STATE.extensionOtherCollapsed = !expanding;
  button.setAttribute("aria-expanded", expanding ? "true" : "false");
  children.getAnimations().forEach(function(animation) { animation.cancel(); });
  if (expanding) {
    children.style.display = "block";
    children.animate([
      { height: "0px", opacity: 0, transform: "translateY(-4px)", overflow: "hidden" },
      { height: children.scrollHeight + "px", opacity: 1, transform: "translateY(0)", overflow: "hidden" },
    ], { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  } else {
    var animation = children.animate([
      { height: children.scrollHeight + "px", opacity: 1, transform: "translateY(0)", overflow: "hidden" },
      { height: "0px", opacity: 0, transform: "translateY(-4px)", overflow: "hidden" },
    ], { duration: 150, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    animation.addEventListener("finish", function() {
      if (STATE.extensionOtherCollapsed) children.style.display = "none";
    }, { once: true });
  }
  return false;
}


function renderCheckboxList(container, items, selected, onChange) {
  if (items.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--on-surface-variant);opacity:0.6;padding:4px 0">暂无</div>';
    container._itemsKey = '';
    return;
  }
  const itemsKey = items.map(i => i.key).join(',') + '|' + items.map(i => i.count || 0).join(',');
  if (container._itemsKey !== itemsKey) {
    container.innerHTML = items.map(function(item) {
      return '<label class="filter-checkbox-item"><input type="checkbox" value="' + escapeHTML(item.key) + '" ' + (selected.indexOf(item.key) >= 0 ? 'checked' : '') + '><span>' + escapeHTML(item.label) + '</span>' + (item.count !== undefined ? '<span class="checkbox-count">' + item.count.toLocaleString() + '</span>' : '') + '</label>';
    }).join("");
    container._itemsKey = itemsKey;
    container._onChange = onChange;
    if (!container._hasDelegate) {
      container.addEventListener("change", function() {
        if (container._updating) return;
        container._onChange(Array.from(container.querySelectorAll("input:checked")).map(function(c) { return c.value; }));
      });
      container._hasDelegate = true;
    }
  } else {
    container._updating = true;
    container.querySelectorAll("input").forEach(function(cb) {
      cb.checked = selected.indexOf(cb.value) >= 0;
    });
    container._updating = false;
  }
  container._onChange = onChange;
}

function renderFilterFolderTree() {
  setupFolderTreeEvents();
  DOM.filterFolderTree.innerHTML = "";
  if (!STATE.folderTree || STATE.folderTree.length === 0) {
    DOM.filterFolderTree.innerHTML = '<div style="font-size:12px;color:var(--on-surface-variant);opacity:0.6">暂无目录</div>';
    return;
  }
  renderFilterTreeNodes(DOM.filterFolderTree, STATE.folderTree, 0);
}

function refreshFilterFolderSelectionState() {
  if (!DOM.filterFolderTree || !STATE.folderTree || STATE.folderTree.length === 0) return;
  const subtreeSet = getFolderSubtreeSet();
  const selfSet = getFolderSelfSet();
  DOM.filterFolderTree.querySelectorAll(".filter-folder-item").forEach(function(row) {
    const node = row._folderNode;
    if (node) applyFolderSelectionToNode(node, row, subtreeSet, selfSet);
  });
}

function setupFolderTreeEvents() {
  const tree = DOM.filterFolderTree;
  if (tree._eventsReady) return;
  tree._eventsReady = true;
  tree.addEventListener("change", event => {
    const row = event.target.closest(".filter-folder-item");
    if (row?._folderNode && event.target.matches('input[type="checkbox"]')) handleFolderCheckboxChange(row._folderNode);
  });
  tree.addEventListener("click", event => {
    const row = event.target.closest(".filter-folder-item");
    if (!row?._folderNode) return;
    const node = row._folderNode;
    if (event.target.closest(".folder-self-toggle")) {
      event.preventDefault();
      handleFolderSelfToggle(node);
    } else {
      const toggle = event.target.closest(".tree-toggle");
      if (!toggle) return;
      const children = row.nextElementSibling;
      const expanding = !!STATE.folderTreeCollapsed[node.path];
      STATE.folderTreeCollapsed[node.path] = !expanding;
      if (expanding && !children._childrenRendered) {
        renderFilterTreeNodes(children, node.children, Number(row.style.getPropertyValue("--fdepth")) + 1);
        children._childrenRendered = true;
      }
      toggle.setAttribute("aria-expanded", String(expanding));
      toggleFolderChildrenAnimated(children, toggle, expanding);
    }
  });
}

function toggleFolderChildrenAnimated(childContainer, toggle, expanding) {
  if (!childContainer || !toggle) return;
  childContainer.getAnimations().forEach(function(animation) { animation.cancel(); });
  toggle.getAnimations().forEach(function(animation) { animation.cancel(); });
  const glyph = toggle.querySelector(".tree-toggle-glyph");
  if (glyph) glyph.getAnimations().forEach(function(animation) { animation.cancel(); });
  const resetChildStyles = function() {
    ["height", "opacity", "transform", "overflow", "transition"].forEach(key => { childContainer.style[key] = ""; });
  };
  const stopTransition = function() {
    if (childContainer._transitionCleanup) {
      childContainer.removeEventListener("transitionend", childContainer._transitionCleanup);
      childContainer._transitionCleanup = null;
    }
    if (childContainer._transitionTimer) {
      clearTimeout(childContainer._transitionTimer);
      childContainer._transitionTimer = null;
    }
  };
  stopTransition();
  resetChildStyles();
  const duration = expanding ? 220 : 190;
  const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
  childContainer.style.display = "block";
  const height = childContainer.scrollHeight + "px";
  const setFrame = open => {
    childContainer.style.height = open ? height : "0px";
    childContainer.style.opacity = open ? "1" : "0";
    childContainer.style.transform = open ? "translateY(0)" : "translateY(-6px)";
  };
  setFrame(!expanding);
  childContainer.style.overflow = "hidden";
  void childContainer.offsetHeight;
  childContainer.style.transition = ["height", "opacity", "transform"].map(key => `${key} ${duration}ms ${easing}`).join(", ");
  setFrame(expanding);
  childContainer._transitionCleanup = function(event) {
    if (event.target !== childContainer || event.propertyName !== "height") return;
    stopTransition();
    resetChildStyles();
    childContainer.style.display = expanding ? "block" : "none";
  };
  childContainer.addEventListener("transitionend", childContainer._transitionCleanup);
  childContainer._transitionTimer = setTimeout(function() {
    if (childContainer._transitionCleanup) childContainer._transitionCleanup({ target: childContainer, propertyName: "height" });
  }, duration + 40);
  toggle.classList.toggle("expanded", expanding);
  if (glyph) {
    glyph.animate([
      { transform: expanding ? "rotate(-45deg)" : "rotate(45deg)" },
      { transform: expanding ? "rotate(45deg)" : "rotate(-45deg)" },
    ], { duration, easing, fill: "forwards" });
  }
}

function getFolderSubtreeSet() {
  return new Set(STATE.filterFolderSubtrees || []);
}

function initializeFolderTreeCollapsed(nodes) {
  for (let i = 0; i < (nodes || []).length; i++) {
    const node = nodes[i];
    if (node.path && !(node.path in STATE.folderTreeCollapsed)) STATE.folderTreeCollapsed[node.path] = false;
    if (node.children && node.children.length > 0) initializeFolderTreeCollapsed(node.children);
  }
}

function getFolderSelfSet() {
  return new Set(STATE.filterFolderSelfs || []);
}

function folderPathCovered(path, subtreeSet) {
  for (let prefix = path; prefix; ) {
    if (subtreeSet.has(prefix)) return true;
    const slash = prefix.lastIndexOf("/");
    prefix = slash < 0 ? "" : prefix.slice(0, slash);
  }
  return false;
}

function folderSelectionState(node, subtreeSet, selfSet) {
  if (!node) return { full: false, partial: false };
  if (folderPathCovered(node.path, subtreeSet)) return { full: true, partial: false };
  const direct = selfSet.has(node.path);
  const children = (node.children || []).map(child => folderSelectionState(child, subtreeSet, selfSet));
  let full;
  if (node.isRoot) {
    full = (!node.hasDirectFiles || direct) && (children.length ? children.every(child => child.full) : !!node.hasDirectFiles);
  } else if (node.showSelfToggle && !direct) {
    full = false;
  } else if (!node.hasChildren) {
    full = !!node.hasDirectFiles && direct || subtreeSet.has(node.path);
  } else {
    full = children.every(child => child.full) && (!node.hasDirectFiles || direct);
  }
  return { full, partial: !full && (direct || subtreeSet.has(node.path) || children.some(child => child.full || child.partial)) };
}

// Split covering ancestors before removing a branch or its direct files.
function splitFolderSelection(path, subtreeSet, selfSet, includeSelf = false, nodes = STATE.folderTree) {
  for (const node of nodes || []) {
    if (!node.isRoot && node.path !== path && !path.startsWith(node.path + "/")) continue;
    if (subtreeSet.has(node.path) && (includeSelf || node.path !== path)) {
      subtreeSet.delete(node.path);
      if (node.hasDirectFiles) selfSet.add(node.path);
      for (const child of node.children || []) subtreeSet.add(child.path);
    }
    if (node.path !== path) splitFolderSelection(path, subtreeSet, selfSet, includeSelf, node.children);
  }
}

function setNodeSubtreeSelection(node, enabled, subtreeSet, selfSet) {
  if (!node) return;
  if (!enabled) splitFolderSelection(node.path, subtreeSet, selfSet);
  const contains = path => node.isRoot || path === node.path || path.startsWith(node.path + "/");
  for (const path of subtreeSet) if (contains(path)) subtreeSet.delete(path);
  for (const path of selfSet) if (contains(path)) selfSet.delete(path);
  if (!enabled) return;
  if (!node.isRoot) subtreeSet.add(node.path);
  else {
    if (node.hasDirectFiles) selfSet.add(node.path);
    for (const child of node.children || []) subtreeSet.add(child.path);
  }
}

function normalizeFolderSelection(subtreeSet, selfSet) {
  const collapse = nodes => {
    for (const node of nodes || []) {
      collapse(node.children);
      if (!node.isRoot && folderSelectionState(node, subtreeSet, selfSet).full) subtreeSet.add(node.path);
    }
  };
  collapse(STATE.folderTree);
  for (const path of subtreeSet) {
    const slash = path.lastIndexOf("/");
    if (slash >= 0 && folderPathCovered(path.slice(0, slash), subtreeSet)) subtreeSet.delete(path);
  }
  for (const path of selfSet) if (folderPathCovered(path, subtreeSet)) selfSet.delete(path);
}

function persistFolderSelection(subtreeSet, selfSet) {
  normalizeFolderSelection(subtreeSet, selfSet);
  if (subtreeSet.size > 10000 || selfSet.size > 10000) {
    showToast("目录筛选最多支持 10000 项，请缩小选择范围");
    return;
  }
  STATE.filterFolderSubtrees = Array.from(subtreeSet);
  STATE.filterFolderSelfs = Array.from(selfSet);
  const merged = [];
  selfSet.forEach(function(path) { if (!merged.includes(path)) merged.push(path); });
  subtreeSet.forEach(function(path) { if (path && !merged.includes(path)) merged.push(path); });
  STATE.filterFolders = merged;
  updateFilterCancelButtons();
  scheduleFilterSearch();
}

function collectFolderNodePaths(nodes, subtreePaths, selfPaths) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node.isRoot && node.path) subtreePaths.push(node.path);
    if (node.hasDirectFiles) selfPaths.push(node.path);
    if (node.children && node.children.length > 0) {
      collectFolderNodePaths(node.children, subtreePaths, selfPaths);
    }
  }
}

function applyFolderSelectionToNode(node, row, subtreeSet, selfSet) {
  const cb = row.querySelector("input[type='checkbox']");
  if (!cb) return;
  const { full, partial } = folderSelectionState(node, subtreeSet, selfSet);
  cb.checked = full;
  cb.indeterminate = !full && partial;
  const selfBtn = row.querySelector(".folder-self-toggle");
  if (selfBtn) {
    const selfOn = selfSet.has(node.path) || folderPathCovered(node.path, subtreeSet);
    selfBtn.classList.toggle("active", selfOn);
    selfBtn.setAttribute("aria-pressed", selfOn ? "true" : "false");
  }
}

function renderFilterTreeNodes(container, nodes, depth) {
  const subtreeSet = getFolderSubtreeSet();
  const selfSet = getFolderSelfSet();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const has = node.children && node.children.length > 0;
    const row = document.createElement("div");
    row.className = "filter-folder-item";
    row.style.setProperty("--fdepth", depth);
    row.dataset.path = node.path;
    row._folderNode = node;
    var collapsed = !!STATE.folderTreeCollapsed[node.path];
    row.innerHTML = (has ? ('<button type="button" class="tree-toggle' + (collapsed ? '' : ' expanded') + '" aria-label="' + (collapsed ? '展开子文件夹' : '收起子文件夹') + '" title="' + (collapsed ? '展开' : '收起') + '"><span class="tree-toggle-glyph" aria-hidden="true"></span></button>') : '<span class="tree-toggle-placeholder"></span>') +
      '<input type="checkbox" value="' + escapeHTML(node.path) + '">' +
      '<span class="folder-name" title="' + escapeHTML(node.name) + '">' + escapeHTML(node.name) + '</span>' +
      (node.showSelfToggle ? '<button type="button" class="folder-self-toggle" data-path="' + escapeHTML(node.path) + '">本层文件</button>' : '') +
      '<span class="folder-count">' + (node.count || 0).toLocaleString() + '</span>';
    const toggle = row.querySelector(".tree-toggle");
    applyFolderSelectionToNode(node, row, subtreeSet, selfSet);
    container.appendChild(row);
    if (has) {
      const childDiv = document.createElement("div");
      childDiv.className = "tree-children";
      if (collapsed) childDiv.style.display = "none";
      if (!collapsed) renderFilterTreeNodes(childDiv, node.children, depth + 1);
      childDiv._childrenRendered = !collapsed;
      toggle.setAttribute("aria-expanded", String(!collapsed));
      container.appendChild(childDiv);
    }
  }
}

function handleFolderCheckboxChange(node) {
  const subtreeSet = getFolderSubtreeSet();
  const selfSet = getFolderSelfSet();
  const { full } = folderSelectionState(node, subtreeSet, selfSet);
  setNodeSubtreeSelection(node, !full, subtreeSet, selfSet);
  persistFolderSelection(subtreeSet, selfSet);
  refreshFilterFolderSelectionState();
}

function handleFolderSelfToggle(node) {
  const subtreeSet = getFolderSubtreeSet();
  const selfSet = getFolderSelfSet();
  splitFolderSelection(node.path, subtreeSet, selfSet, true);
  if (selfSet.has(node.path)) selfSet.delete(node.path);
  else selfSet.add(node.path);
  persistFolderSelection(subtreeSet, selfSet);
  refreshFilterFolderSelectionState();
}

const hitokotoState = { timer: null, controller: null, lastAt: 0, animation: null, suspended: false };

function hitokotoVisible() { return !document.hidden && !hitokotoState.suspended; }

function scheduleHitokoto() {
  clearTimeout(hitokotoState.timer);
  hitokotoState.timer = null;
  if (!hitokotoVisible() || hitokotoState.controller) return;
  hitokotoState.timer = setTimeout(fetchHitokoto, Math.max(0, 30000 - (Date.now() - hitokotoState.lastAt)));
}

async function fetchHitokoto() {
  if (!hitokotoVisible() || hitokotoState.controller) return;
  clearTimeout(hitokotoState.timer);
  hitokotoState.timer = null;
  const controller = new AbortController();
  hitokotoState.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch("https://vomebook-hitokoto.hf.space/", { signal: controller.signal });
    if (!resp.ok) throw new Error("Hitokoto unavailable");
    const data = await resp.json();
    if (hitokotoState.controller !== controller || !hitokotoVisible() || controller.signal.aborted) return;
    const text = data.hitokoto || data.text || data.content || data.sentence || "";
    if (typeof text === "string" && text) typewriter(DOM.hitokoto, text);
  } catch (_) {
    // Keep the current quotation on transient failures.
  } finally {
    clearTimeout(timeout);
    if (hitokotoState.controller === controller) {
      hitokotoState.controller = null;
      hitokotoState.lastAt = Date.now();
      scheduleHitokoto();
    }
  }
}

function resumeHitokotoAnimation() {
  const animation = hitokotoState.animation;
  if (!animation || animation.timer || !hitokotoVisible()) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    animation.el.textContent = animation.chars.join("");
    hitokotoState.animation = null;
    return;
  }
  animation.timer = setTimeout(() => {
    animation.timer = null;
    if (!hitokotoVisible()) return;
    animation.el.textContent = animation.chars.slice(0, ++animation.index).join("");
    if (animation.index >= animation.chars.length) hitokotoState.animation = null;
    else resumeHitokotoAnimation();
  }, animation.speed);
}

function typewriter(el, text, speed = 60) {
  if (hitokotoState.animation) clearTimeout(hitokotoState.animation.timer);
  el.style.opacity = "0.55";
  el.textContent = "";
  hitokotoState.animation = { el, chars: Array.from(text), index: 0, speed, timer: null };
  resumeHitokotoAnimation();
}

function updateHitokotoVisibility() {
  if (hitokotoVisible()) {
    resumeHitokotoAnimation();
    scheduleHitokoto();
  } else {
    clearTimeout(hitokotoState.timer);
    hitokotoState.timer = null;
    if (hitokotoState.controller) hitokotoState.controller.abort();
    hitokotoState.controller = null;
    if (hitokotoState.animation) {
      clearTimeout(hitokotoState.animation.timer);
      hitokotoState.animation.timer = null;
    }
  }
}

function setupHitokoto() {
  document.addEventListener("visibilitychange", updateHitokotoVisibility);
  window.addEventListener("pagehide", () => { hitokotoState.suspended = true; updateHitokotoVisibility(); });
  window.addEventListener("pageshow", () => { hitokotoState.suspended = false; updateHitokotoVisibility(); });
  updateHitokotoVisibility();
}

async function getRandomLocal(txtOnly) {
  const data = await corpusWorkerRequest("random-record", { repo: STATE.repoFull || "", txtOnly: false, readerOnly: !!txtOnly }, WORKER_REQUEST_TIMEOUT);
  return data && data.record || null;
}

async function randomBook() {
  showToast("正在随机下载书籍...");
  if (STATE.dataLoaded) {
    try {
      var localRec = await getRandomLocal(false);
      if (!localRec) throw new Error("NO_RECORD");
      var localFilename = (localRec.File || "file") + (localRec.Extension ? "." + localRec.Extension : "");
      await downloadFile(localFilename, getRecordLink(localRec), { skipCheck: true });
    } catch (e) {
      showToast("暂无可下载书籍");
    }
    return;
  }
  var url = STATE.repoFull
    ? API_BASE + "/api/random?repo=" + encodeURIComponent(STATE.repo)
    : API_BASE + "/api/random";
  fetch(url).then(function(resp) {
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.json();
    })
    .then(function(rec) {
      if (rec) {
        var filename = (rec.File || "file") + (rec.Extension ? "." + rec.Extension : "");
        downloadFile(filename, getRecordLink(rec), { skipCheck: true });
      } else {
        showToast("暂无可下载书籍");
      }
    })
    .catch(function() {
      async function fallback() {
        var rec = await getRandomLocal(false);
        if (rec) {
          var filename = (rec.File || "file") + (rec.Extension ? "." + rec.Extension : "");
          downloadFile(filename, getRecordLink(rec), { skipCheck: true });
        } else {
          showToast("暂无可下载书籍");
        }
      }
      if (STATE.dataLoaded) fallback().catch(function() { showToast("暂无可下载书籍"); });
      else ensureLocalDataLoaded(false, true).then(function(ok) { if (ok) return fallback(); throw new Error("LOCAL_UNAVAILABLE"); }).catch(function() { showToast("暂无可下载书籍"); });
    });
}

var randomReaderRequestId = 0;

function openReaderRecord(rec, returnUrl) {
  returnUrl = returnUrl || location.href;
  if (!rec || location.href !== returnUrl) return false;
  const url = getReaderLink(rec, returnUrl);
  if (!url) return false;
  return navigateToReader(url, returnUrl);
}

async function randomTxt() {
  var requestId = ++randomReaderRequestId;
  var returnUrl = location.href;
  showToast("正在随机打开书籍...");
  if (STATE.dataLoaded) {
    try {
      var originalCount = STATE.repoFull ? (readerMetadata.byRepo[STATE.repoFull] || 0) : (readerMetadata.count || 0);
      if (!originalCount && !readerAssets) await loadReaderAssets();
      else loadReaderAssets();
      var converted = getConvertedReaderRecords(STATE.repoFull || "");
      var useConverted = converted.length > 0 && Math.random() * (originalCount + converted.length) >= originalCount;
      var localRec = useConverted ? converted[Math.floor(Math.random() * converted.length)] : await getRandomLocal(true);
      if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
      if (!openReaderRecord(localRec, returnUrl)) throw new Error("NO_READER");
    } catch (e) {
      showToast("暂无可读书籍");
    }
    return;
  }
  var url = STATE.repoFull
    ? API_BASE + "/api/random-reader?repo=" + encodeURIComponent(STATE.repo)
    : API_BASE + "/api/random-reader";
  fetch(url).then(function(resp) {
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  }).then(function(rec) {
    if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
    if (!openReaderRecord(rec, returnUrl)) throw new Error("NO_READER");
  }).catch(function() {
    async function fallback() {
      if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
      var originalCount = STATE.repoFull ? (readerMetadata.byRepo[STATE.repoFull] || 0) : (readerMetadata.count || 0);
      if (!originalCount && !readerAssets) await loadReaderAssets();
      else loadReaderAssets();
      var converted = getConvertedReaderRecords(STATE.repoFull || "");
      var useConverted = converted.length > 0 && Math.random() * (originalCount + converted.length) >= originalCount;
      var rec = useConverted ? converted[Math.floor(Math.random() * converted.length)] : await getRandomLocal(true);
      if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
      if (!openReaderRecord(rec, returnUrl)) {
        showToast("暂无可读书籍");
      }
    }
    if (STATE.dataLoaded) fallback().catch(function() {
      showToast("暂无可读书籍");
    });
    else ensureLocalDataLoaded(false, true).then(function(ok) { if (ok) return fallback(); throw new Error("LOCAL_UNAVAILABLE"); }).catch(function() {
      showToast("暂无可读书籍");
    });
  });
}
let toastTimer;

function showToast(msg, dur) {
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
let scrollTicking = false;
let scrollLoadTimer = null;
let scrollRecoveryTimer = null;
const sidebarRetryCounts = new Map();
var selectedIndices = {};
var lastSelectedIndex = -1;

function isResultsAtBottom() {
  const container = DOM.resultsContainer;
  return STATE.results.length > 0 && container.clientHeight > 0 &&
    getVirtualTotalHeight() - getResultScrollTop() - container.clientHeight <= 4;
}

function updatePagingStatus() {
  if (!DOM.loadInfo) return;
  let button = document.getElementById("paging-status");
  if (!button) {
    button = document.createElement("button");
    button.id = "paging-status";
    button.type = "button";
    button.className = "text-btn-sm";
    button.textContent = "加载失败，重试";
    button.setAttribute("aria-live", "polite");
    button.addEventListener("click", () => {
      resetPagingRecovery();
      maybeLoadNextPage(false, true);
    });
    DOM.loadInfo.appendChild(button);
  }
  const loading = STATE.isLoading && STATE.page > STATE._loadedPage;
  button.hidden = !STATE.hasMore || loading || pagingFailures < 2;
  button.disabled = loading;
}

function resetPagingRecovery() {
  clearTimeout(pagingCheckTimer);
  pagingCheckTimer = null;
  pagingFailures = 0;
  pagingRetryAt = 0;
  updatePagingStatus();
}

function scheduleBottomLoad(delay = 0) {
  clearTimeout(pagingCheckTimer);
  const generation = searchRequestId;
  pagingCheckTimer = setTimeout(() => {
    pagingCheckTimer = null;
    if (generation === searchRequestId) maybeLoadNextPage(true);
  }, Math.max(delay, pagingRetryAt - Date.now()));
}

function finishPagingAttempt(success, error) {
  pagingFailures = success ? 0 : pagingFailures + 1;
  if (error && error.status >= 400 && error.status < 500 && !isRecoverableSearchError(error)) pagingFailures = 2;
  pagingRetryAt = success ? 0 : Date.now() + 750;
  updatePagingStatus();
  if (pagingFailures < 2) scheduleBottomLoad();
}

function retryBottomPage() {
  if (!isResultsAtBottom()) return;
  expireSearchRequests();
  if (!STATE.isLoading && Date.now() >= pagingRetryAt && pagingFailures >= 2) resetPagingRecovery();
  scheduleBottomLoad();
}

function maybeLoadNextPage(bottomOnly = false, retry = false) {
  if (positionRestore) return;
  expireSearchRequests();
  if (document.hidden || readerOverlay || pagingFailures >= 2 || Date.now() < pagingRetryAt) return;
  if (VSCROLL.isDraggingThumb) return;
  if (STATE.isLoading || !STATE.hasMore) return;
  const scrollTop = getResultScrollTop();
  const loadedHeight = getVirtualTotalHeight();
  const triggerPoint = loadedHeight * 0.05;
  if (retry || isResultsAtBottom() || (!bottomOnly && scrollTop >= triggerPoint)) {
    STATE.page = STATE._loadedPage + 1;
    doSearch(true);
  }
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
  scrollTicking = false;
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
  sidebarRetryCounts.clear();
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
    if (readerReturnScrollState && !readerReturnRestoreActive) { readerReturnRestoreGeneration++; readerReturnScrollState = null; }
    if (!VSCROLL.isDraggingThumb) ensureVirtualViewportCovered();
    if (!scrollTicking) {
      requestAnimationFrame(() => {
        renderVisible();
        if (VSCROLL.isDraggingThumb) updateScrollThumb();
        else {
          updateScrollTrack();
          maybeLoadNextPage();
        }
        scrollTicking = false;
      });
      scrollTicking = true;
    }
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
    applyPendingScrollTop();
    VSCROLL.isDraggingThumb = false;
    VSCROLL.dragMetrics = null;
    DOM.resultsList.style.minHeight = "";
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
    renderVisible();
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

function toggleTheme() {
  const btn = DOM.themeBtn;
  const rect = btn.getBoundingClientRect();
  const ripple = document.createElement("div");
  ripple.className = "theme-ripple";
  ripple.style.left = (rect.left + rect.width / 2) + "px";
  ripple.style.top = (rect.top + rect.height / 2) + "px";
  ripple.style.background = STATE.isDark ? "#fff" : "#1a1c1e";
  ripple.style.marginLeft = "-0px";
  ripple.style.marginTop = "-0px";
  document.body.appendChild(ripple);
  document.body.classList.add("theme-transitioning");
  STATE.isDark = !STATE.isDark;
  applyTheme();
  localStorage.setItem("theme", STATE.isDark ? "dark" : "light");
  ripple.addEventListener("animationend", () => {
    ripple.remove();
    document.body.classList.remove("theme-transitioning");
  });
}

function applyTheme() {
  if (STATE.isDark) {
    document.body.classList.remove("light");
    DOM.themeIconLight.style.display = "none";
    DOM.themeIconDark.style.display = "";
  } else {
    document.body.classList.add("light");
    DOM.themeIconLight.style.display = "";
    DOM.themeIconDark.style.display = "none";
  }
  if (readerOverlay && readerOverlay.contentWindow) readerOverlay.contentWindow.postMessage({ type: "voice-reader-theme-state", theme: STATE.isDark ? "dark" : "light" }, location.origin);
}

function toggleMobile() {
  STATE.isMobile = !STATE.isMobile;
  applyMobileMode();
  localStorage.setItem("mobileMode", STATE.isMobile ? "mobile" : "desktop");
}

function applyMobileMode() {
  if (STATE.isMobile) {
    document.body.classList.add("mobile");
    document.body.classList.remove("force-desktop");
    DOM.mobileIconPhone.style.display = "";
    DOM.mobileIconDesktop.style.display = "none";
    STATE.leftSidebarOpen = false;
    STATE.rightSidebarOpen = false;
  } else {
    document.body.classList.remove("mobile");
    document.body.classList.add("force-desktop");
    DOM.mobileIconPhone.style.display = "none";
    DOM.mobileIconDesktop.style.display = "";
    STATE.leftSidebarOpen = true;
    STATE.rightSidebarOpen = false;
  }
  updateSidebarVisibility();
  document.documentElement.classList.remove("mobile-boot");
  updateSidebarHeader();
  updateSelectionUI();
  requestAnimationFrame(updateScrollTrack);
}

function autoDetectMobile() { return window.innerWidth <= 768; }

function toggleLeftSidebar() {
  if (STATE.leftSidebarOpen) {
    closeLeftSidebar();
    return;
  }
  STATE.leftSidebarOpen = true;
  if (STATE.isMobile && STATE.leftSidebarOpen && STATE.rightSidebarOpen) STATE.rightSidebarOpen = false;
  updateSidebarVisibility();
  updateSidebarHeader();
  syncStateToURL();
  ensureSidebarBackGuard();
}

function toggleRightSidebar() {
  STATE.rightSidebarOpen = !STATE.rightSidebarOpen;
  if (STATE.rightSidebarOpen && STATE.leftSidebarOpen && STATE.isMobile) STATE.leftSidebarOpen = false;
  updateSidebarVisibility();
  syncStateToURL();
}

function updateSidebarVisibility() {
  DOM.leftSidebar.classList.toggle("collapsed", !STATE.leftSidebarOpen);
  DOM.leftSidebar.classList.toggle("open", STATE.leftSidebarOpen);
  DOM.rightSidebar.classList.toggle("collapsed", !STATE.rightSidebarOpen);
  DOM.rightSidebar.classList.toggle("open", STATE.rightSidebarOpen);
  DOM.overlay.style.display = "";
  DOM.overlay.classList.toggle("open", STATE.isMobile && (STATE.leftSidebarOpen || STATE.rightSidebarOpen));
}
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
  requestAnimationFrame(function() {
    DOM.resultsList.querySelectorAll(".result-item.keyboard-focus").forEach(function(item) { item.classList.remove("keyboard-focus"); });
    var el = DOM.resultsList.querySelector('.result-item[data-index="' + keyboardResultIndex + '"]');
    if (el) el.classList.add("keyboard-focus");
  });
}

function setupKeyboard() {
  document.addEventListener("keydown", function(e) {
    if (e.defaultPrevented || e.isComposing || searchComposing || e.keyCode === 229 || readerOverlay) return;
    const target = e.target instanceof Element ? e.target : document.activeElement;
    const isInput = target.isContentEditable || !!target.closest("input, textarea, select");
    if (isInput && !(target === DOM.searchInput && e.key === "Escape")) return;
    if (["Enter", "ArrowDown", "ArrowUp"].includes(e.key) && target.closest("button, a, [role='button']")) return;
    if (e.key === "/" && !isInput) {
      e.preventDefault();
      DOM.searchInput.focus();
      DOM.searchInput.select();
      return;
    }
    if (e.key === "Escape") {
      if (STATE.rightSidebarOpen || STATE.leftSidebarOpen) {
        STATE.leftSidebarOpen = false;
        STATE.rightSidebarOpen = false;
        updateSidebarVisibility();
        return;
      }
      if (DOM.searchInput.value) {
        submitSearchQuery("", { clearResults: true, updateInput: true });
        return;
      }
      DOM.searchInput.blur();
      return;
    }
    if (e.key === "b" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      toggleLeftSidebar();
      return;
    }
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

function setupResultDelegation() {
  DOM.resultsList.addEventListener("click", function(e) {
    const missing = e.target.closest("[data-window-page]");
    if (missing && resultWindow) {
      if (resultWindow.invalid) restartResultWindow();
      else { const page = Number(missing.dataset.windowPage); resultWindow.failures.delete(page); loadResultWindowPage(page); }
      return;
    }
    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn) {
      e.preventDefault();
      const action = actionBtn.dataset.action;
      if (action === "copy") {
        navigator.clipboard.writeText(actionBtn.dataset.link)
          .then(function() { showToast("链接已复制"); })
          .catch(function() { showToast("复制失败"); });
        return;
      }
      if (action === "download") {
        downloadFile(actionBtn.dataset.filename || "file", actionBtn.dataset.link || "", { button: actionBtn });
        return;
      }
      if (action === "read") {
        const record = resultRowRecords.get(actionBtn.closest(".result-item"));
        if (record) actionBtn.dataset.readerUrl = getReaderLink(applyReaderAsset(
          record, record.Repo || "", buildRecordRelativePath(record), getRecordLink(record)));
        navigateToReader(actionBtn.dataset.readerUrl);
        return;
      }
    }
    const repoTag = e.target.closest(".result-repo-tag");
    if (repoTag) {
      ROUTER.navigate("repo", repoTag.dataset.repo);
      return;
    }
    const folderLink = e.target.closest(".path-folder");
    if (folderLink) {
      const folder = folderLink.dataset.folder;
      const frepo = folderLink.dataset.repo;
      if (frepo && STATE.mode === "global") {
        let hash = "#/" + frepo;
        const sp = buildSearchURLParams({ displaySizes: true });
        if (folder) sp.append("folder_self", folder);
        const qs = sp.toString();
        window.location.hash = qs ? hash + "?" + qs : hash;
      } else if (folder !== undefined) {
        STATE.filterFolders = folder ? [folder] : [];
        STATE.filterFolderSubtrees = [];
        STATE.filterFolderSelfs = folder ? [folder] : [];
        renderFilters(routeRenderId);
        doFilterSearch(true);
      }
      return;
    }
  });
  DOM.sidebarContent.addEventListener("click", function(e) {
    const repoItem = e.target.closest(".repo-list-item");
    if (repoItem) {
      ROUTER.navigate("repo", repoItem.dataset.repo);
    }
  });
}

async function init() {
  cacheDOM();
  syncSearchInputState();
  await initSearchPositions();
  setupSearchPositionControls();
  setupSearchPositionSaving();
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  STATE.sessionRestored = await restoreSearchSession();
  setupReaderIntentWarming();
  STATE.isDark = localStorage.getItem("theme") !== "light";
  applyTheme();
  const savedMobile = localStorage.getItem("mobileMode");
  if (savedMobile === "mobile") STATE.isMobile = true;
  else if (savedMobile === "desktop") STATE.isMobile = false;
  else STATE.isMobile = autoDetectMobile();
  applyMobileMode();
  DOM.searchInput.addEventListener("input", () => {
    syncSearchInputState();
    debouncedSearch();
  });
  DOM.searchInput.addEventListener("compositionstart", function() {
    searchComposing = true;
    clearTimeout(composeSafetyTimer);
    composeSafetyTimer = setTimeout(function() { searchComposing = false; debouncedSearch(); }, 5000);
  });
  DOM.searchInput.addEventListener("compositionend", function() {
    searchComposing = false;
    clearTimeout(composeSafetyTimer);
    debouncedSearch();
  });
  var hideDropdown = function() {
    setTimeout(function() {
      if (!dropdownActive) DOM.historyDropdown.style.display = "none";
    }, 150);
  };
  var dropdownActive = false;
  DOM.searchInput.addEventListener("focus", function() {
    renderDropdown();
  });
  DOM.searchInput.addEventListener("blur", hideDropdown);
  var longPressTimer = null;
  DOM.historyDropdown.addEventListener("mouseenter", function() { dropdownActive = true; });
  DOM.historyDropdown.addEventListener("mouseleave", function() { dropdownActive = false; });
  DOM.historyDropdown.addEventListener("mousedown", function(e) {
    if (e.target.closest(".history-del")) return;
    if (e.target.closest(".history-clear-all")) { saveHistory([]); DOM.historyDropdown.style.display = "none"; return; }
    var item = e.target.closest(".history-item");
    if (item) longPressTimer = setTimeout(function() { removeHistoryItem(item.dataset.query); }, 600);
  });
  DOM.historyDropdown.addEventListener("mouseup", function() { clearTimeout(longPressTimer); });
  DOM.historyDropdown.addEventListener("mouseleave", function() { clearTimeout(longPressTimer); });
  DOM.historyDropdown.addEventListener("touchstart", function(e) {
    if (e.target.closest(".history-del")) return;
    var item = e.target.closest(".history-item");
    if (item) longPressTimer = setTimeout(function() { removeHistoryItem(item.dataset.query); }, 600);
  }, { passive: true });
  DOM.historyDropdown.addEventListener("touchend", function() { clearTimeout(longPressTimer); });
  DOM.historyDropdown.addEventListener("touchmove", function() { clearTimeout(longPressTimer); });
  DOM.historyDropdown.addEventListener("click", function(e) {
    var delBtn = e.target.closest(".history-del");
    if (delBtn) { removeHistoryItem(delBtn.dataset.del); return; }
    var item = e.target.closest(".history-item");
    if (item) {
      submitSearchQuery(item.dataset.query, { restore: true, blur: true });
      hideDropdown();
      return;
    }
  });
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
  if (DOM.multiSelectToggle) DOM.multiSelectToggle.addEventListener("change", updateSelectionUI);
  DOM.resultsList.addEventListener("click", function(e) {
    if (!DOM.multiSelectToggle || !DOM.multiSelectToggle.checked) return;
    var cb = e.target.closest(".result-checkbox");
    if (!cb) return;
    e.stopPropagation();
    var idx = parseInt(cb.dataset.index);
    if (e.shiftKey && lastSelectedIndex >= 0) {
      var lo = Math.min(lastSelectedIndex, idx);
      var hi = Math.max(lastSelectedIndex, idx);
      for (var si = lo; si <= hi; si++) if (STATE.results[si]) selectedIndices[si] = true;
    } else if (cb.checked) {
      selectedIndices[idx] = true;
    } else {
      delete selectedIndices[idx];
    }
    lastSelectedIndex = idx;
    updateSelectionUI();
  });
  if (DOM.multiCopyLinks) DOM.multiCopyLinks.addEventListener("click", function() {
    const links = getSelectedFiles().map(item => getCopyableLink(item.link));
    if (links.length === 0) { showToast("未选中任何文件"); return; }
    navigator.clipboard.writeText(links.join("\n")).then(function() {
      showToast("已复制 " + links.length + " 条链接");
    }).catch(function() { showToast("复制失败"); });
  });
  if (DOM.multiBatchDownload) DOM.multiBatchDownload.addEventListener("click", function() {
    startDownloadBatch(getSelectedFiles());
  });
  if (DOM.multiDeselect) DOM.multiDeselect.addEventListener("click", function() {
    selectedIndices = {};
    lastSelectedIndex = -1;
    updateSelectionUI();
  });
  if (DOM.multiSelectAll) DOM.multiSelectAll.addEventListener("click", function() {
    var allSelected = STATE.results.length > 0 && STATE.results.every(function(record, index) { return !record || selectedIndices[index]; });
    if (allSelected) selectedIndices = {};
    else for (var si = 0; si < STATE.results.length; si++) if (STATE.results[si]) selectedIndices[si] = true;
    lastSelectedIndex = allSelected ? -1 : STATE.results.length - 1;
    updateSelectionUI();
  });
  DOM.hamburgerBtn.addEventListener("click", toggleLeftSidebar);
  DOM.settingsBtn.addEventListener("click", toggleRightSidebar);
  DOM.closeFiltersBtn.addEventListener("click", function() {
    STATE.rightSidebarOpen = false;
    updateSidebarVisibility();
  });
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
    if (!STATE.dataLoaded && DOM.localModeToggle.checked) {
      STATE.useLocalMode = true;
      setExactSearchSectionVisible(false, true);
      prepareFilterChange(true);
      DOM.resultsList.innerHTML = "";
      DOM.emptyState.style.display = "none";
      updateStatusBar();
      updateLoadInfo();
      syncStateToURL();
      const key = getSearchViewKey();
      const id = ++searchId;
      ensureLocalDataLoaded(false, false).then(ok => {
        if (ok && id === searchId && key === getSearchViewKey()) doFilterSearch();
        else if (!ok && id === searchId) doSearch();
      });
      return;
    }
    STATE.useLocalMode = DOM.localModeToggle.checked;
    setExactSearchSectionVisible(!STATE.useLocalMode, true);
    if (DOM.exactSearchToggle) DOM.exactSearchToggle.checked = STATE.exact;
    doFilterSearch(true);
    syncStateToURL();
  });
  DOM.sortSelect.addEventListener("change", function() {
    STATE.sort = DOM.sortSelect.value;
    doFilterSearch(true);
    syncStateToURL();
  });
  DOM.overlay.addEventListener("click", function() {
    if (STATE.leftSidebarOpen) closeLeftSidebar();
    STATE.rightSidebarOpen = false;
    updateSidebarVisibility();
    syncStateToURL();
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
  DOM.folderSelectAll.addEventListener("click", function() {
    if (!STATE.folderTree || STATE.folderTree.length === 0) return;
    var subtreeSet = new Set();
    var selfSet = new Set();
    var currentSubtreeSet = getFolderSubtreeSet();
    var currentSelfSet = getFolderSelfSet();
    var allSelected = STATE.folderTree.every(function(node) { return folderSelectionState(node, currentSubtreeSet, currentSelfSet).full; });
    if (allSelected) {
      persistFolderSelection(subtreeSet, selfSet);
      refreshFilterFolderSelectionState();
      return;
    }
    for (var i = 0; i < STATE.folderTree.length; i++) {
      setNodeSubtreeSelection(STATE.folderTree[i], true, subtreeSet, selfSet);
    }
    persistFolderSelection(subtreeSet, selfSet);
    refreshFilterFolderSelectionState();
  });
  DOM.folderDeselectAll.addEventListener("click", function() {
    if (!STATE.folderTree || STATE.folderTree.length === 0) return;
    var subtreeSet = getFolderSubtreeSet();
    var selfSet = getFolderSelfSet();
    var allSubtreePaths = [];
    var allSelfPaths = [];
    collectFolderNodePaths(STATE.folderTree, allSubtreePaths, allSelfPaths);
    var nextSubtreeSet = new Set();
    var nextSelfSet = new Set();
    for (var j = 0; j < allSelfPaths.length; j++) {
      if (!selfSet.has(allSelfPaths[j]) && !folderPathCovered(allSelfPaths[j], subtreeSet)) nextSelfSet.add(allSelfPaths[j]);
    }
    persistFolderSelection(nextSubtreeSet, nextSelfSet);
    refreshFilterFolderSelectionState();
  });
  setupVirtualScroll();
  setupQuickScroll();
  setupKeyboard();
  setupResultDelegation();
  setupDownloadIntentWarming();
  window.addEventListener("message", handleReaderMessage);
  window.addEventListener("popstate", function(event) {
    if (readerOverlay || event.state?.voiceReaderOverlay) {
      restoreReaderOverlay(event.state);
      return;
    }
    if (handleSidebarBackNavigation()) return;
  });
  window.addEventListener("hashchange", function() {
    if (readerOverlay) return;
    ROUTER.apply();
  });
  window.addEventListener("resize", function() {
    if (!localStorage.getItem("mobileMode")) {
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
  ROUTER.apply();
  restoreReaderFromSession();
  loadReaderAssets().then(function() {
    refreshResultReaderActions();
    if (STATE.mode === "repo") {
      const routeId = ++routeRenderId;
      renderBrowser(STATE.browserPath || "", routeId);
      renderFilters(routeId);
    }
  });
  setupHitokoto();
}
document.addEventListener("DOMContentLoaded", init);

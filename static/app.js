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
let corpusWorker = null;
let corpusWorkerStartPromise = null;
let corpusWorkerEpoch = null;
let corpusWorkerRequestId = 0;
let corpusWorkerRestartCount = 0;
let corpusWorkerConsecutiveRestarts = 0;
const CORPUS_WORKER_MAX_CONSECUTIVE_RESTARTS = 1;
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

var readerAssets = null;
var readerAssetsPending = null;
var readerAssetsRetryAt = 0;
var readerAssetDelayUntilPaint = false;
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

function yieldReaderAssetLoad(signal) {
  return new Promise(function(resolve, reject) {
    var settled = false;
    var finish = function(callback, value) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    var abort = function() { finish(reject, new DOMException("Reader assets timed out", "AbortError")); };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      yieldConvertedReaderBuild().then(function() { finish(resolve); }, function(error) { finish(reject, error); });
    } catch (error) {
      finish(reject, error);
    }
  });
}

// Download may overlap initial rendering, but defer decompression/JSON work
// until the first result window has painted or the user needs Reader metadata.
var readerAssetParseWake = null;

/** @param {AbortSignal} signal @param {string | null} targetKey @returns {Promise<void>} */
function waitForReaderAssetFirstPaint(signal, targetKey) {
  if (!readerAssetDelayUntilPaint || !targetKey || STATE.isMobile || !STATE.leftSidebarOpen ||
      typeof MutationObserver !== "function" || !DOM.resultsList || getSearchViewKey() !== targetKey)
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false, firstFrame = 0, secondFrame = 0, observer = null;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (firstFrame) cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      if (observer) observer.disconnect();
      signal.removeEventListener("abort", abort);
      if (readerAssetParseWake === resume) readerAssetParseWake = null;
      readerAssetDelayUntilPaint = false;
      if (error) reject(error); else resolve();
    };
    const resume = () => finish(null);
    const abort = () => finish(new DOMException("Reader assets timed out", "AbortError"));
    const ready = () => STATE._loadedPage >= 1 && !STATE.isLoading && displayedSearchView?.key === targetKey;
    const afterPaint = () => {
      if (firstFrame || secondFrame || settled) return;
      if (typeof requestAnimationFrame === "function") {
        firstFrame = requestAnimationFrame(() => {
          firstFrame = 0;
          secondFrame = requestAnimationFrame(() => {
            secondFrame = 0;
            // The state may change between ready() and paint: don't decode an
            // old frame while the same view starts a fresh request.
            if (getSearchViewKey() !== targetKey || ready()) resume();
          });
        });
      }
    };
    // RAF may be paused; do not hold metadata forever when search stalls.
    const timer = setTimeout(resume, 750);
    readerAssetParseWake = resume;
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    observer = new MutationObserver(() => {
      if (getSearchViewKey() !== targetKey) { resume(); return; }
      if (ready()) afterPaint();
    });
    observer.observe(DOM.resultsList, { childList: true, subtree: true });
    if (ready()) afterPaint();
  });
}

async function fetchReaderAssetMap(deferDecode = false) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 10000);
  // renderBrowser runs inside route application. Capture the settled view key
  // in a microtask, rather than the intermediate state seen on entry.
  var firstView = deferDecode ? Promise.resolve().then(() => getSearchViewKey()).catch(() => null) : null;
  try {
    var firstViewKey = firstView ? await firstView : null;
    var response = await fetch("/search/data/reader_assets.json.gz", { signal: controller.signal });
    if (!response.ok || !response.body || typeof DecompressionStream === "undefined") throw new Error("READER_ASSETS_UNAVAILABLE");
    var compressedLength = Number(response.headers && response.headers.get && response.headers.get("content-length"));
    if (Number.isFinite(compressedLength) && compressedLength > READER_ASSETS_COMPRESSED_LIMIT) {
      await Promise.resolve().then(function() { return response.body.cancel(); }).catch(function() { return undefined; });
      throw new Error("READER_ASSETS_LIMIT");
    }
    var compressed = await readBoundedReaderStream(response.body, READER_ASSETS_COMPRESSED_LIMIT, controller.signal);
    if (firstView) await waitForReaderAssetFirstPaint(controller.signal, firstViewKey);
    if (controller.signal.aborted) throw new DOMException("Reader assets timed out", "AbortError");
    var expandedStream = new Response(compressed).body.pipeThrough(new DecompressionStream("gzip"));
    var expanded = await readBoundedReaderStream(expandedStream, READER_ASSETS_EXPANDED_LIMIT, controller.signal);
    // Keep decoding and parsing separate from decompression so a pending
    // interaction can run between these individually expensive operations.
    await yieldReaderAssetLoad(controller.signal);
    var text = new TextDecoder().decode(expanded);
    await yieldReaderAssetLoad(controller.signal);
    var data = JSON.parse(text);
    if (!data || data.v !== 1 || !data.f || typeof data.f !== "object") throw new Error("READER_ASSETS_UNAVAILABLE");
    return data.f;
  } finally {
    clearTimeout(timer);
  }
}

function loadReaderAssets(deferDecode) {
  if (!deferDecode) {
    readerAssetDelayUntilPaint = false;
    if (readerAssetParseWake) readerAssetParseWake();
  }
  if (readerAssets) return Promise.resolve(readerAssets);
  if (Date.now() < readerAssetsRetryAt) return Promise.resolve({});
  if (readerAssetsPending) return readerAssetsPending;
  readerAssetsPending = fetchReaderAssetMap(deferDecode === true).then(function(assets) {
    readerAssets = assets;
    readerAssetsRetryAt = 0;
    convertedReaderRecords = null;
    convertedReaderRecordsByRepo = null;
    return readerAssets;
  }).catch(function() {
    readerAssetsRetryAt = Date.now() + 5000;
    return {};
  }).finally(function() { readerAssetsPending = null; });
  return readerAssetsPending;
}

function loadReaderAssetsAfterFirstPaint() {
  return loadReaderAssets(readerAssetDelayUntilPaint);
}

function applyReaderAsset(record, repo, relativePath, originalLink) {
  var asset = readerAssets && readerAssets[repo + "\0" + relativePath];
  var fields = VoiceOfMLReader.assetFields(asset, API_BASE + "/api/reader-bucket-resource", String(record.Extension || record.extension || ""));
  return fields ? Object.assign({}, record, fields, { DownloadLink: originalLink }) : record;
}

let convertedReaderRecordsByRepo = null;
let convertedReaderRecordsPending = null;
const CONVERTED_READER_BATCH_SIZE = 256;
let convertedReaderYieldChannel = null;
const convertedReaderYieldQueue = [];

function yieldConvertedReaderBuild() {
  if (typeof MessageChannel === "undefined") return new Promise(resolve => setTimeout(resolve, 0));
  if (!convertedReaderYieldChannel) {
    convertedReaderYieldChannel = new MessageChannel();
    convertedReaderYieldChannel.port1.onmessage = () => convertedReaderYieldQueue.shift()?.();
  }
  return new Promise(resolve => { convertedReaderYieldQueue.push(resolve); convertedReaderYieldChannel.port2.postMessage(null); });
}

async function getConvertedReaderRecords(repo) {
  // The sidecar can have tens of thousands of entries. Build one complete
  // snapshot in small tasks so a first click or filter change cannot block UI.
  while (readerAssets && !convertedReaderRecords) {
    const snapshot = readerAssets;
    if (!convertedReaderRecordsPending || convertedReaderRecordsPending.snapshot !== snapshot) {
      const pending = { snapshot, promise: null };
      pending.promise = (async function() {
        const all = [], byRepo = Object.create(null), keys = Object.keys(snapshot);
        for (let i = 0; i < keys.length; i++) {
          if (readerAssets !== snapshot) return;
          const key = keys[i];
          const separator = key.indexOf("\0");
          if (separator > 0) {
            const sourceRepo = key.substring(0, separator);
            const relativePath = key.substring(separator + 1);
            const parts = relativePath.split("/");
            const filename = parts.pop() || "";
            const dot = filename.lastIndexOf(".");
            if (sourceRepo.startsWith("VoiceOfML/") && dot > 0 && !parts.some(function(part) { return !part || part === "." || part === ".."; })) {
              const record = { Repo: sourceRepo, File: filename.substring(0, dot), Extension: filename.substring(dot + 1), Folder: parts, HasTxt: false };
              const originalLink = buildRecordLink(record);
              const converted = applyReaderAsset(record, sourceRepo, relativePath, originalLink);
              if (converted !== record) {
                all.push(converted);
                (byRepo[sourceRepo] || (byRepo[sourceRepo] = [])).push(converted);
              }
            }
          }
          if ((i + 1) % CONVERTED_READER_BATCH_SIZE === 0 && i + 1 < keys.length) {
            await yieldConvertedReaderBuild();
          }
        }
        if (readerAssets === snapshot) {
          convertedReaderRecords = all;
          convertedReaderRecordsByRepo = byRepo;
        }
      })();
      convertedReaderRecordsPending = pending;
    }
    const pending = convertedReaderRecordsPending;
    try { await pending.promise; }
    finally { if (convertedReaderRecordsPending === pending) convertedReaderRecordsPending = null; }
  }
  if (!convertedReaderRecords) return [];
  return repo ? (convertedReaderRecordsByRepo[repo] || []) : convertedReaderRecords;
}

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
  var active = document.activeElement;
  var row = DOM.historyDropdown.contains(active) ? active.closest('.history-item') : null;
  var oldIndex = row ? Array.from(DOM.historyDropdown.querySelectorAll('.history-item')).indexOf(row) : -1;
  var list = getHistory();
  if (list.length === 0) { hideSearchHistory(!!row); return; }
  var html = "";
  for (var h = 0; h < list.length; h++) {
    html += '<div class="history-item" data-query="' + escapeHTML(list[h]) + '">' +
      '<svg class="history-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
      '<button type="button" class="history-text" aria-label="搜索：' + escapeHTML(list[h]) + '">' + escapeHTML(list[h]) + '</button>' +
      '<button type="button" class="history-del" aria-label="删除搜索历史：' + escapeHTML(list[h]) + '" data-del="' + escapeHTML(list[h]) + '">&times;</button>' +
      '</div>';
  }
  html += '<div class="history-footer"><button class="history-clear-all">清空历史</button></div>';
  DOM.historyDropdown.innerHTML = html;
  DOM.historyDropdown.style.display = "";
  if (row) {
    var index = list.indexOf(/** @type {HTMLElement} */ (row).dataset.query);
    var selector = index >= 0 && active.matches('.history-del') ? '.history-del' : '.history-text';
    DOM.historyDropdown.querySelectorAll('.history-item')[index >= 0 ? index : Math.min(oldIndex, list.length - 1)]
      .querySelector(selector).focus({ preventScroll: true });
  }
}

function hideSearchHistory(restoreFocus = false) {
  // Focus first: its normal focus listener may render history again.
  if (restoreFocus) DOM.searchInput.focus({ preventScroll: true });
  DOM.historyDropdown.style.display = "none";
}

function setupSearchHistory() {
  let hideTimer, pressTimer, pressed = false, hovering = false;
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!hovering && !DOM.searchBox.contains(document.activeElement)) hideSearchHistory();
    }, 150);
  };
  DOM.searchInput.addEventListener('focus', renderDropdown);
  DOM.searchBox.addEventListener('focusout', scheduleHide);
  DOM.historyDropdown.addEventListener('mouseenter', () => { hovering = true; });
  DOM.historyDropdown.addEventListener('mouseleave', () => { hovering = false; clearTimeout(pressTimer); scheduleHide(); });
  document.addEventListener('pointerdown', event => {
    if (!DOM.searchBox.contains(event.target)) hideSearchHistory();
  }, { passive: true });
  DOM.searchBox.addEventListener('keydown', event => {
    if (event.isComposing || searchComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey ||
        DOM.historyDropdown.style.display === 'none') return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); hideSearchHistory(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const buttons = Array.from(DOM.historyDropdown.querySelectorAll('.history-text'));
      if (!buttons.length) return;
      const row = event.target.closest('.history-item');
      const index = row ? Array.from(DOM.historyDropdown.querySelectorAll('.history-item')).indexOf(row) : -1;
      const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
      event.preventDefault(); event.stopPropagation();
      if (next < 0) DOM.searchInput.focus({ preventScroll: true });
      else buttons[Math.min(next, buttons.length - 1)].focus({ preventScroll: true });
    }
  });
  const startPress = event => {
    clearTimeout(pressTimer); pressed = false;
    if (event.target.closest('.history-del,.history-clear-all')) return;
    const row = event.target.closest('.history-item');
    if (row) pressTimer = setTimeout(() => { pressed = true; removeHistoryItem(row.dataset.query); }, 600);
  };
  DOM.historyDropdown.addEventListener('mousedown', startPress);
  DOM.historyDropdown.addEventListener('touchstart', startPress, { passive: true });
  for (const type of ['mouseup', 'touchend', 'touchmove', 'touchcancel'])
    DOM.historyDropdown.addEventListener(type, () => clearTimeout(pressTimer), { passive: true });
  DOM.historyDropdown.addEventListener('click', event => {
    if (pressed && event.detail !== 0) { pressed = false; return; }
    pressed = false;
    const remove = event.target.closest('.history-del');
    if (remove) { removeHistoryItem(remove.dataset.del); return; }
    if (event.target.closest('.history-clear-all')) { saveHistory([]); hideSearchHistory(true); return; }
    const row = event.target.closest('.history-item');
    if (row) {
      const restoreFocus = DOM.historyDropdown.contains(document.activeElement);
      submitSearchQuery(row.dataset.query, { restore: true, blur: true });
      hideSearchHistory();
      if (restoreFocus) DOM.resultsContainer.focus({ preventScroll: true });
    }
  });
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

function makeWorkerError(code, message) {
  return Object.assign(new Error(message || code), {code});
}

function rejectCorpusWorkerPending(error) {
  corpusWorkerPending.forEach(function(entry) {
    clearTimeout(entry.timer);
    entry.cleanup?.();
    entry.reject(error);
  });
  corpusWorkerPending.clear();
}

function terminateCorpusWorker(error, worker = corpusWorker) {
  // A timeout/error from a retired instance must not destroy its replacement.
  if (worker !== corpusWorker) return;
  corpusWorker = null;
  corpusWorkerStartPromise = null;
  if (worker) worker.terminate();
  rejectCorpusWorkerPending(error || makeWorkerError("WORKER_TERMINATED", "Search Worker terminated"));
}

function postCorpusWorkerRequest(type, payload, timeoutMs, signal, worker = corpusWorker) {
  if (signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  if (!worker || worker !== corpusWorker) return Promise.reject(makeWorkerError("WORKER_UNAVAILABLE", "Search Worker is unavailable"));
  const id = ++corpusWorkerRequestId;
  return new Promise(function(resolve, reject) {
    const expire = function() {
      if (!corpusWorkerPending.has(id)) return;
      clearTimeout(timer);
      cleanup();
      corpusWorkerPending.delete(id);
      const error = makeWorkerError("WORKER_TIMEOUT", "Search Worker request timed out");
      terminateCorpusWorker(error, worker);
      reject(error);
    };
    const duration = timeoutMs || WORKER_REQUEST_TIMEOUT;
    const timer = setTimeout(expire, duration);
    const cancel = () => {
      if (!corpusWorkerPending.has(id)) return;
      corpusWorkerPending.delete(id); clearTimeout(timer); cleanup();
      // Cancellation must settle even if structured cloning/posting fails.
      try {
        if (worker === corpusWorker) worker.postMessage({protocol: WORKER_PROTOCOL_VERSION, type: "cancel-search", id: ++corpusWorkerRequestId, payload: {requestId: id}});
      } catch (_) {}
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const cleanup = () => signal?.removeEventListener("abort", cancel);
    corpusWorkerPending.set(id, { worker, resolve, reject, timer, expire, cleanup, deadline: Date.now() + duration });
    signal?.addEventListener("abort", cancel, {once: true});
    try {
      worker.postMessage({ protocol: WORKER_PROTOCOL_VERSION, type: type, id: id, payload: payload || {} });
    } catch (error) {
      corpusWorkerPending.delete(id); clearTimeout(timer); cleanup();
      reject(error);
    }
    if (signal?.aborted) cancel();
  });
}

function ensureCorpusWorker() {
  if (corpusWorkerStartPromise) return corpusWorkerStartPromise;
  if (corpusWorker) return Promise.resolve(corpusWorker);
  const epoch = { worker: null, recovery: null, bootstrap: null };
  corpusWorkerEpoch = epoch;
  if (!window.Worker) return Promise.reject(makeWorkerError("WORKER_UNAVAILABLE", "Web Workers are unavailable"));
  let worker;
  try {
    worker = new Worker("static/search/index-worker.js");
  } catch (error) {
    return Promise.reject(error);
  }
  epoch.worker = worker;
  corpusWorker = worker;
  worker.addEventListener("message", function(event) {
    if (worker !== corpusWorker) return;
    const message = event.data || {};
    if (message.type !== "response") return;
    const pending = corpusWorkerPending.get(message.id);
    if (!pending || pending.worker !== worker) return;
    corpusWorkerPending.delete(message.id);
    clearTimeout(pending.timer);
    pending.cleanup?.();
    if (message.protocol !== WORKER_PROTOCOL_VERSION) {
      pending.reject(makeWorkerError("PROTOCOL_MISMATCH", "Refresh required: app/Worker protocol mismatch"));
      return;
    }
    if (!message.ok) pending.reject(makeWorkerError(message.error && message.error.code || "WORKER_ERROR", message.error && message.error.message));
    else pending.resolve(message.result);
  });
  function fail(event) {
    const error = makeWorkerError("WORKER_ERROR", event && event.message || "Search Worker failed");
    terminateCorpusWorker(error, worker);
  }
  worker.addEventListener("error", fail, { once: true });
  worker.addEventListener("messageerror", fail, { once: true });
  // Publish the shared startup promise before posting, including synchronous failures.
  corpusWorkerStartPromise = Promise.resolve().then(function() {
    return postCorpusWorkerRequest("handshake", {}, WORKER_REQUEST_TIMEOUT, null, worker);
  }).then(function(result) {
    if (!result || result.protocol !== WORKER_PROTOCOL_VERSION) throw makeWorkerError("PROTOCOL_MISMATCH", "Refresh required: app/Worker protocol mismatch");
    if (worker !== corpusWorker) throw makeWorkerError("WORKER_TERMINATED", "Search Worker terminated");
    corpusWorkerStartPromise = null;
    return worker;
  }).catch(function(error) {
    terminateCorpusWorker(error, worker);
    throw error;
  });
  return corpusWorkerStartPromise;
}

async function corpusWorkerRequest(type, payload, timeoutMs, signal) {
  const checkCancelled = () => {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  };
  checkCancelled();
  const start = ensureCorpusWorker();
  const epoch = corpusWorkerEpoch;
  try {
    const worker = await start;
    checkCancelled();
    const metadata = epoch.bootstrap ? await epoch.bootstrap : null;
    checkCancelled();
    const result = metadata && type === "load-corpus" && payload?.url === new URL(DATA_URL, document.baseURI).href
      ? metadata : await postCorpusWorkerRequest(type, payload, timeoutMs, signal, worker);
    checkCancelled();
    if (worker !== corpusWorker) throw makeWorkerError("WORKER_TERMINATED", "Search Worker terminated");
    corpusWorkerConsecutiveRestarts = 0;
    return result;
  } catch (error) {
    checkCancelled();
    if (error?.name === "AbortError" || error?.code === "PROTOCOL_MISMATCH") throw error;
    // All failed waiters on an epoch join one recovery, including late catch callbacks.
    if (!epoch.recovery) {
      if (corpusWorkerConsecutiveRestarts >= CORPUS_WORKER_MAX_CONSECUTIVE_RESTARTS) throw error;
      corpusWorkerConsecutiveRestarts++;
      corpusWorkerRestartCount++;
      epoch.recovery = Promise.resolve().then(async function() {
        terminateCorpusWorker(error, epoch.worker);
        const ready = ensureCorpusWorker();
        const replacement = corpusWorkerEpoch;
        if (!replacement.bootstrap) {
          replacement.bootstrap = ready.then(worker => postCorpusWorkerRequest("load-corpus", {
            url: new URL(DATA_URL, document.baseURI).href,
          }, WORKER_LOAD_TIMEOUT, null, worker));
        }
        const bootstrap = replacement.bootstrap;
        try {
          const metadata = await bootstrap;
          return { worker: replacement.worker, metadata };
        } finally {
          // A rejected load must not poison this live instance permanently.
          // Release only our bootstrap; retain the exhausted automatic retry
          // budget until a later explicit request actually succeeds.
          if (replacement.bootstrap === bootstrap) replacement.bootstrap = null;
        }
      });
    }
    // Bootstrap belongs to the shared replacement; cancelling one waiter must
    // not cancel it for the remaining callers.
    const { worker, metadata } = await epoch.recovery.catch(function(recoveryError) {
      checkCancelled();
      throw recoveryError;
    });
    checkCancelled();
    if (worker !== corpusWorker) throw makeWorkerError("WORKER_TERMINATED", "Search Worker terminated");
    const result = type === "load-corpus" && payload?.url === new URL(DATA_URL, document.baseURI).href
      ? metadata : await postCorpusWorkerRequest(type, payload, timeoutMs, signal, worker);
    checkCancelled();
    if (worker !== corpusWorker) throw makeWorkerError("WORKER_TERMINATED", "Search Worker terminated");
    corpusWorkerConsecutiveRestarts = 0;
    return result;
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
  const now = Date.now();
  getSearchTransport().expire();
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
  renderAfterScroll: false,
  estimatedHeight: 60,
  sparseHeights: false,
  heightBase: 60,
  isDraggingThumb: false,
  lastScrollTop: 0,
  lastScrollTime: 0,
  scrollVelocity: 0,
  scrollDirection: 1,
};
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

function closeLeftSidebar() {
  STATE.leftSidebarOpen = false;
  DOM.leftSidebar.classList.remove("expanded-wide");
  updateSidebarVisibility();
  syncStateToURL();
}

function closeRightSidebar() {
  STATE.rightSidebarOpen = false;
  updateSidebarVisibility();
  syncStateToURL();
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
    if (mode === "repo" && STATE.mode === "repo" && repo === STATE.repo) {
      STATE.filterFolderSelfs.forEach(function(path) { sp.append("folder_self", path); });
      STATE.filterFolderSubtrees.forEach(function(path) { sp.append("folder_subtree", path); });
    }
    if (mode !== "global" && folder) sp.set("path", folder);
    else if (mode !== "global" && folder === undefined && STATE.browserPath) sp.set("path", STATE.browserPath);
    const qs = sp.toString();
    if (qs) hash += "?" + qs;
    if (mode === "global") STATE.browserPath = "";
    window.location.hash = hash;
  },
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
    if (route.params.q !== undefined) {
      STATE.query = route.params.q;
      if (Array.from(STATE.query).length > 256) {
        STATE.query = Array.from(STATE.query).slice(0, 256).join("");
        showToast("搜索内容已限制为 256 个字符");
      }
      if (!searchComposing && !initialSearchDraft) setSearchInputValue(STATE.query);
    } else {
      STATE.query = "";
      if (!searchComposing && !initialSearchDraft) setSearchInputValue("");
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
    STATE.sort = normalizeSearchSort(route.params.sort);
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
    // Exact mode is implemented by the Worker as well, so the switch is always
    // relevant. Hiding it made a keyboard-reachable control change semantics.
    setExactSearchSectionVisible(true, false);
    STATE.recordHistory = route.params.history !== "0";
    if (DOM.historyToggle) DOM.historyToggle.checked = STATE.recordHistory;
    STATE.useMirrorLinks = route.params.mirror !== "0";
    if (DOM.mirrorLinksToggle) DOM.mirrorLinksToggle.checked = STATE.useMirrorLinks;
    const keepMobileSidebarOpen = STATE.isMobile && STATE.leftSidebarOpen
      && prevMode === "repo" && route.mode === "global" && route.params.sidebar === "0";
    STATE.leftSidebarOpen = keepMobileSidebarOpen || route.params.sidebar !== "0";
    STATE.rightSidebarOpen = route.params.filters === "1";
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
    const keepSidebarExpanded = route.params.wide === "1"
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
  if (readerHost.overlay) return;
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
    history.replaceState(history.state, "", hash);
  }
  appliedRouteHash = window.location.hash;
  persistSearchSession();
}

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
    const originalCount = STATE.repoFull ? (readerMetadata.byRepo[STATE.repoFull] || 0) : (readerMetadata.count || 0);
    if (originalCount) {
      // Native files already make the action available. Neither a slow sidecar
      // nor a full converted-pool build should delay showing this control.
      loadReaderAssets();
      DOM.randomTxtBtn.style.display = "";
      return;
    }
    await loadReaderAssets();
    if (id !== randomTxtStatusId) return;
    const count = (await getConvertedReaderRecords(STATE.repoFull || "")).length;
    if (id !== randomTxtStatusId) return;
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

function applyInitialSearchPayload(data, intent = searchIntentId) {
  if (intent !== searchIntentId) return false;
  if (!data || !Array.isArray(data.results) || !canUseInitialSearchPayload()) return false;
  if (STATE.mode === "repo" && data.repo !== STATE.repoFull) return false;
  if (STATE.mode === "global" && data.mode !== "global") return false;
  if (!cancelActiveSearch() || intent !== searchIntentId) return false;
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
    generation: data.generation,
  });
  if (STATE.results[0] && !(typeof data.generation === "string" && data.generation)) {
    searchPageMetadata.set(STATE.results[0], { unverifiedInitial: true,
      total: STATE.total, page: 1, page_size: STATE.pageSize });
  }
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
  // A hash navigation can be pending while this asynchronous payload arrives.
  // Keep the usual URL/session sync unless it would overwrite a newer route.
  if (window.location.hash === appliedRouteHash) syncStateToURL();
  else if (!readerHost.overlay) persistSearchSession();
  prefetchNextPage();
  scheduleBackgroundLocalDataLoad();
  return true;
}

async function tryInitialSearchPayload(searchMode, searchRepo, intent = ++searchIntentId) {
  const searchKey = getSearchViewKey();
  function isCurrentSearchRoute() {
    return intent === searchIntentId && getSearchViewKey() === searchKey &&
      STATE.mode === searchMode && STATE.repo === searchRepo;
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
    return applyInitialSearchPayload(data, intent);
  } catch (e) {
    return false;
  }
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
  var searchMode = STATE.mode;
  var searchRepo = STATE.repo;
  // A query/filter change while the payload loads has already started its own search;
  // a late fallback must not abort it and reset the user to page one.
  var searchKey = getSearchViewKey();
  function isCurrentSearchRoute() {
    return intent === searchIntentId && STATE.mode === searchMode && STATE.repo === searchRepo && getSearchViewKey() === searchKey;
  }
  if (canUseInitialSearchPayload()) {
    return tryInitialSearchPayload(searchMode, searchRepo, intent).then(function(applied) {
      if (!applied && isCurrentSearchRoute()) doSearch();
      return applied;
    });
  }
  if (isCurrentSearchRoute()) doSearch();
  return Promise.resolve(false);
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

function buildResultHTML(rec, idx) {
  const fileName = escapeHTML(rec.File + (rec.Extension ? '.' + rec.Extension : ''));
  const iconType = getFileIconType(rec.Extension);
  const titleHTML = highlightText(rec.File, STATE.query);
  const repoShort = escapeHTML((rec.Repo || "").split("/").pop());
  const sizeStr = formatSize(rec.Size);
  const recordLink = getRecordLink(rec);
  const readerRecord = applyReaderAsset(rec, rec.Repo || "", buildRecordRelativePath(rec), recordLink);
  const readerActionRecord = isReadableRecord(readerRecord) ? readerRecord
    : (isDefaultReadableRecord(rec) ? rec : null);
  const readerActionUrl = readerActionRecord ? getReaderLink(readerActionRecord, undefined, false) : "";
  const breadcrumb = (rec.Folder || []).map((f, j) => {
    const accum = (rec.Folder || []).slice(0, j + 1).join("/");
    const folderDisplay = STATE.searchFolders ? highlightText(f, STATE.query) : escapeHTML(f);
    const separator = j < (rec.Folder || []).length - 1 ? '<span class="path-sep">/</span>' : '';
    return '<span role="button" tabindex="0" class="path-folder" aria-label="筛选路径：' + escapeHTML(accum) + '" data-folder="' + escapeHTML(accum) + '" data-repo="' + repoShort + '">' + folderDisplay + separator + '</span>';
  }).join("");
  const repoSeparator = (rec.Folder || []).length ? '<span class="path-sep">/</span>' : '';
  return (
    '<input type="checkbox" class="result-checkbox" aria-label="选择文件：' + fileName + '" data-index="' + idx + '">' +
    '<div class="result-file-icon" aria-hidden="true">' + (ICONS[iconType] || ICONS.file) + '</div>' +
    '<div class="result-info">' +
      '<div class="result-title">' + titleHTML +
        (rec.Extension ? '<span style="opacity:0.5;font-size:12px">.' + escapeHTML(rec.Extension) + '</span>' : '') +
      '</div>' +
      '<div class="result-path"><span role="button" tabindex="0" class="path-folder" aria-label="筛选仓库路径：' + repoShort + '" data-folder="" data-repo="' + repoShort + '">' + repoShort + repoSeparator + '</span>' + breadcrumb + '</div>' +
      '<div class="result-meta">' +
        (STATE.mode === "global" ? '<button type="button" class="result-repo-tag" aria-label="打开仓库：' + repoShort + '" data-repo="' + repoShort + '">' + repoShort + '</button>' : '') +
        (sizeStr ? '<span class="result-size">' + sizeStr + '</span>' : '') +
      '</div>' +
    '</div>' +
    '<div class="result-actions">' +
      '<button class="result-action-btn" aria-label="复制链接：' + fileName + '" data-action="copy" data-link="' + escapeHTML(getCopyableLink(recordLink)) + '">复制链接</button>' +
      '<button class="result-action-btn primary" aria-label="下载：' + fileName + '" data-action="download" data-filename="' + fileName + '" data-link="' + escapeHTML(recordLink) + '">下载</button>' +
      '<a href="' + escapeHTML(getPreviewLink(getRecordPath(rec))) + '" aria-label="仓库查看：' + fileName + '（新窗口）" class="result-action-btn" target="_blank" rel="noopener noreferrer">仓库查看</a>' +
      (readerActionUrl ? '<button class="result-action-btn" aria-label="' + (["audio", "video", "swf"].includes(VoiceOfMLReader.capability(readerActionRecord.ReaderExtension || readerActionRecord.Extension).mode) ? "在线播放" : "在线阅读") + '：' + fileName + '" data-action="read" data-reader-url="' + escapeHTML(readerActionUrl) + '">' + (["audio", "video", "swf"].indexOf(VoiceOfMLReader.capability(readerActionRecord.ReaderExtension || readerActionRecord.Extension).mode) >= 0 ? "在线播放" : "在线阅读") + '</button>' : '') +
    '</div>'
  );
}

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

function createResultRow(rec, idx) {
  if (!rec) return createResultWindowPlaceholder(idx);
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
  row.tabIndex = -1;
  row.setAttribute('role', 'listitem');
  row.setAttribute('aria-label', rec.File + (rec.Extension ? '.' + rec.Extension : ''));
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

function setResultScrollTop(value, restoreWindow = false) {
  const total = getVirtualTotalHeight(), viewport = DOM.resultsContainer.clientHeight;
  const target = Math.max(0, Math.min(value, Math.max(0, total - viewport)));
  const physical = target - resultScrollOrigin;
  if (!restoreWindow && physical >= 0 && physical <= DOM.resultsContainer.scrollHeight - viewport) {
    // Native scrolling rounds subpixels. Round toward the requested row so
    // an exact boundary cannot land on the previous record after restoration.
    DOM.resultsContainer.scrollTop = Math.ceil(physical);
    updateCurrentResultPosition();
    return;
  }
  if (restoreWindow) {
    // Seed restored windows without velocity overscan from the position jump.
    VSCROLL.lastScrollTop = target;
    VSCROLL.lastScrollTime = 0;
    VSCROLL.scrollVelocity = 0;
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
  const focused = document.activeElement;
  const focusedRow = DOM.resultsList.contains(focused) ? /** @type {HTMLElement} */ (focused.closest('.result-item')) : null;
  const focusedRecord = focusedRow && resultRowRecords.get(focusedRow);
  // Validate once before reusing rows, not once for every new row.
  ensureResultTemplateCache();
  const logicalTop = getResultScrollTop();
  const previousOrigin = resultScrollOrigin;
  let topSpacer = DOM.resultsList.querySelector(".virtual-spacer-top");
  let bottomSpacer = DOM.resultsList.querySelector(".virtual-spacer-bottom");
  if (!topSpacer) {
    topSpacer = document.createElement("div");
    topSpacer.className = "virtual-spacer virtual-spacer-top";
    topSpacer.setAttribute('aria-hidden', 'true');
    DOM.resultsList.prepend(topSpacer);
  }
  if (!bottomSpacer) {
    bottomSpacer = document.createElement("div");
    bottomSpacer.className = "virtual-spacer virtual-spacer-bottom";
    bottomSpacer.setAttribute('aria-hidden', 'true');
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
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-posinset', String(idx + 1));
    row.setAttribute('aria-setsize', String(STATE.total));
    if (row !== cursor) DOM.resultsList.insertBefore(row, cursor || bottomSpacer);
    cursor = row.nextSibling;
  }
  if (DOM.resultsList.lastElementChild !== bottomSpacer) DOM.resultsList.append(bottomSpacer);
  if (focusedRow && !focused.isConnected) {
    const replacement = DOM.resultsList.querySelector('.result-item[data-index="' + focusedRow.dataset.index + '"]');
    const sameRecord = replacement && focusedRecord && resultRowRecords.get(replacement) === focusedRecord;
    const control = sameRecord && (focused === focusedRow ? replacement :
      Array.from(replacement.querySelectorAll('button,a,input,[role="button"]')).find(node =>
        node.className === focused.className && node.dataset.action === /** @type {HTMLElement} */ (focused).dataset.action &&
        node.getAttribute('aria-label') === focused.getAttribute('aria-label')));
    if (!control) keyboardResultIndex = findVirtualIndex(logicalTop) - 1;
    (control || DOM.resultsContainer).focus({ preventScroll: true });
  }
  if (previousOrigin !== resultScrollOrigin || resultScrollTarget !== null) {
    DOM.resultsContainer.scrollTop = Math.ceil(logicalTop - resultScrollOrigin);
    resultScrollTarget = null;
  }
}

function scheduleVirtualRender(scrollIntent = false) {
  const afterScroll = scrollIntent === true;
  if (afterScroll && !VSCROLL.renderAfterScroll) {
    VSCROLL.renderAfterScroll = true;
    if (!VSCROLL.isDraggingThumb) maybeLoadNextPage();
  }
  if (VSCROLL.renderFrame) return;
  VSCROLL.renderFrame = requestAnimationFrame(() => {
    VSCROLL.renderFrame = 0;
    const scrollTrackUpdated = renderVisible();
    if (VSCROLL.renderAfterScroll) {
      VSCROLL.renderAfterScroll = false;
      if (!scrollTrackUpdated) {
        if (VSCROLL.isDraggingThumb) updateScrollThumb();
        else updateScrollTrack();
      }
    }
  });
}

function renderVisible() {
  const items = STATE.results;
  const len = resultWindow ? resultWindow.total : items.length;
  ensureVirtualHeights(len);
  if (len === 0) {
    updateScrollTrack();
    return true;
  }
  const container = DOM.resultsContainer;
  const scrollTop = getResultScrollTop();
  const viewH = container.clientHeight;
  const est = VSCROLL.estimatedHeight;
  const overscanItems = Math.max(10, Math.floor(viewH / (est || 60)));
  const now = performance.now();
  const previousScrollTop = VSCROLL.lastScrollTop;
  const elapsed = VSCROLL.lastScrollTime ? Math.max(1, now - VSCROLL.lastScrollTime) : 16;
  const instantVelocity = Math.abs(scrollTop - previousScrollTop) / elapsed;
  VSCROLL.scrollVelocity = VSCROLL.scrollVelocity * 0.7 + instantVelocity * 0.3;
  VSCROLL.lastScrollTime = now;
  const extraScreens = VSCROLL.isDraggingThumb ? 0 : Math.min(3, Math.floor(VSCROLL.scrollVelocity / 1.5));
  const baseOverscanPx = overscanItems * (est || 60);
  const velocityOverscanPx = extraScreens * viewH;
  ensureHeightTree();
  const scrollingDown = scrollTop >= previousScrollTop;
  VSCROLL.scrollDirection = scrollingDown ? 1 : -1;
  VSCROLL.lastScrollTop = scrollTop;
  const totalH = getVirtualOffset(len);
  const segmentLimit = RESULT_SCROLL_SEGMENT_HEIGHT;
  const physicalTop = scrollTop - resultScrollOrigin;
  const maxOrigin = Math.max(0, totalH - segmentLimit);
  const segmentNeedsRecenter = resultScrollOrigin > maxOrigin
    || physicalTop < segmentLimit / 4
    || physicalTop + viewH > segmentLimit * 3 / 4;
  const safeStart = findVirtualIndex(Math.max(0, scrollTop - baseOverscanPx * 0.35));
  const safeEnd = Math.min(len, findVirtualIndex(scrollTop + viewH + baseOverscanPx * 0.35) + 1);
  ensureResultWindowPages(safeStart, safeEnd);
  updateCurrentResultPosition();
  if (!pendingResultEntrance && !segmentNeedsRecenter
      && VSCROLL.renderStart <= safeStart && VSCROLL.renderEnd >= safeEnd) return false;
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
  if (start === VSCROLL.renderStart && end === VSCROLL.renderEnd && !segmentNeedsRecenter) return false;
  VSCROLL.renderStart = start;
  VSCROLL.renderEnd = end;
  const topH = getVirtualOffset(start);
  const endH = getVirtualOffset(end);
  const bottomH = Math.max(0, totalH - endH);
  const anchorIndex = findVirtualIndex(scrollTop);
  const anchor = { index: anchorIndex, offset: scrollTop - getVirtualOffset(anchorIndex) };
  reconcileVirtualRows(items, start, end, topH, bottomH);
  if (DOM.multiSelectToggle && DOM.multiSelectToggle.checked) updateVisibleSelection();
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
  return true;
}

function ensureHeightTree() {
  VoiceOfMLSearchHeightIndex.ensureTree(VSCROLL);
}

function getVirtualTotalHeight() {
  return VoiceOfMLSearchHeightIndex.totalHeight(VSCROLL);
}

function getVirtualOffset(index) {
  return VoiceOfMLSearchHeightIndex.offsetOf(VSCROLL, index);
}

function findVirtualIndex(offset) {
  return VoiceOfMLSearchHeightIndex.indexAt(VSCROLL, offset);
}

function resetVirtualScrollState() {
  resultScrollOrigin = 0;
  resultScrollTarget = null;
  rememberDisplayedSearchView();
  cancelQuickScroll();
  if (VSCROLL.renderFrame) cancelAnimationFrame(VSCROLL.renderFrame);
  VSCROLL.renderFrame = 0;
  VSCROLL.renderAfterScroll = false;
  activateSearchView();
  VSCROLL.renderStart = 0;
  VSCROLL.renderEnd = 0;
  VSCROLL.heights = [];
  VSCROLL.sparseHeights = !!resultWindow || !!resultSnapshots.cloneTask;
  VSCROLL.heightBase = VSCROLL.estimatedHeight || 60;
  VSCROLL.heightTree = [];
  VSCROLL.heightsDirty = true;
  VSCROLL.lastScrollTop = 0;
  VSCROLL.lastScrollTime = 0;
  VSCROLL.scrollVelocity = 0;
  VSCROLL.scrollDirection = 1;
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
    const keys = resultWindow || resultSnapshots.cloneTask ? Object.keys(STATE.results)
      : Array.from({length: len - oldLen}, (_, offset) => oldLen + offset);
    for (const key of keys) if (Number(key) >= oldLen) {
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
    VoiceOfMLSearchHeightIndex.extendTree(VSCROLL, oldLen);
  } else {
    VSCROLL.heightsDirty = true;
  }
}

function refreshVirtualAfterAppend(updateView = true) {
  if (updateView && !positionRestore && STATE._loadedPage >= 1) rememberDisplayedSearchView();
  const previousLength = VSCROLL.heights.length;
  ensureVirtualHeights(STATE.results.length);
  const topSpacer = DOM.resultsList.querySelector(".virtual-spacer-top");
  const bottomSpacer = DOM.resultsList.querySelector(".virtual-spacer-bottom");
  if (!topSpacer || !bottomSpacer || VSCROLL.renderStart < 0 || VSCROLL.renderEnd <= VSCROLL.renderStart) {
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
    if (updateView) scheduleVirtualRender();
    return;
  }
  ensureHeightTree();
  const topH = getVirtualOffset(VSCROLL.renderStart);
  const endH = getVirtualOffset(VSCROLL.renderEnd);
  const totalH = getVirtualTotalHeight();
  const logicalTop = getResultScrollTop(), previousOrigin = resultScrollOrigin;
  layoutResultScrollSegment(topH, endH, totalH, logicalTop);
  if (previousOrigin !== resultScrollOrigin) DOM.resultsContainer.scrollTop = logicalTop - resultScrollOrigin;
  if (updateView) {
    const viewH = DOM.resultsContainer.clientHeight, estimate = VSCROLL.estimatedHeight || 60;
    const buffer = 2 * Math.max(10, Math.floor(viewH / estimate)) * estimate + 3 * viewH;
    if (!resultWindow && previousLength < STATE.results.length && VSCROLL.renderEnd < previousLength
        && topH <= logicalTop && endH >= logicalTop + viewH
        && getVirtualOffset(previousLength) > logicalTop + viewH + buffer) {
      updateScrollTrack();
      return;
    }
    // Coalesce page arrival with a pending scroll render when possible.
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
    scheduleVirtualRender();
  }
}

function ensureVirtualViewportCovered() {
  if (VSCROLL.renderStart < 0 || VSCROLL.renderEnd <= VSCROLL.renderStart) return;
  const viewTop = getResultScrollTop();
  const viewBottom = viewTop + DOM.resultsContainer.clientHeight;
  if (viewTop < getVirtualOffset(VSCROLL.renderStart) || viewBottom > getVirtualOffset(VSCROLL.renderEnd)) {
    // Let the scroll RAF perform the single DOM update for this frame. A
    // synchronous render here would duplicate layout and height measurement.
    VSCROLL.renderStart = -1;
    VSCROLL.renderEnd = -1;
  }
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
        VoiceOfMLSearchHeightIndex.fenwickAdd(VSCROLL.heightTree, idx + 1, height - prev);
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
  var initialAssets = readerAssets;
  loadReaderAssetsAfterFirstPaint().then(function() {
    const displayedData = readDisplayed();
    if (!list.isConnected || !displayedData || readerAssets === initialAssets ||
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

async function getRandomLocal(readerOnly) {
  const data = await corpusWorkerRequest("random-record", { repo: STATE.repoFull || "", readerOnly: !!readerOnly }, WORKER_REQUEST_TIMEOUT);
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

async function fetchRandomReaderRecord(url, requestId, returnUrl) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (requestId !== randomReaderRequestId || location.href !== returnUrl) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        await response.body?.cancel();
        const error = Object.assign(new Error(`HTTP ${response.status}`), {
          permanent: response.status < 500 && ![408, 429].includes(response.status)
        });
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (error.permanent || attempt || error instanceof SyntaxError || navigator.onLine === false) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

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
      var converted = await getConvertedReaderRecords(STATE.repoFull || "");
      if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
      var useConverted = converted.length > 0 && Math.random() * (originalCount + converted.length) >= originalCount;
      var localRec = useConverted ? converted[Math.floor(Math.random() * converted.length)] : await getRandomLocal(true);
      if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
      if (!openReaderRecord(localRec, returnUrl)) throw new Error("NO_READER");
    } catch (e) {
      if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
      showToast("暂无可读书籍");
    }
    return;
  }
  var url = STATE.repoFull
    ? API_BASE + "/api/random-reader?repo=" + encodeURIComponent(STATE.repo)
    : API_BASE + "/api/random-reader";
  return fetchRandomReaderRecord(url, requestId, returnUrl).then(function(rec) {
    if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
    if (!openReaderRecord(rec, returnUrl)) throw new Error("NO_READER");
  }).catch(function() {
    if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
    async function fallback() {
      if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
      var originalCount = STATE.repoFull ? (readerMetadata.byRepo[STATE.repoFull] || 0) : (readerMetadata.count || 0);
      if (!originalCount && !readerAssets) await loadReaderAssets();
      else loadReaderAssets();
      var converted = await getConvertedReaderRecords(STATE.repoFull || "");
      if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
      var useConverted = converted.length > 0 && Math.random() * (originalCount + converted.length) >= originalCount;
      var rec = useConverted ? converted[Math.floor(Math.random() * converted.length)] : await getRandomLocal(true);
      if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
      if (!openReaderRecord(rec, returnUrl)) {
        showToast("暂无可读书籍");
      }
    }
    if (STATE.dataLoaded) fallback().catch(function() {
      if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
      showToast("暂无可读书籍");
    });
    else ensureLocalDataLoaded(false, true).then(function(ok) { if (ok) return fallback(); throw new Error("LOCAL_UNAVAILABLE"); }).catch(function() {
      if (requestId !== randomReaderRequestId || location.href !== returnUrl) return;
      showToast("暂无可读书籍");
    });
  });
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
  writeSearchPreference("theme", STATE.isDark ? "dark" : "light");
  ripple.addEventListener("animationend", () => {
    ripple.remove();
    document.body.classList.remove("theme-transitioning");
  });
}

function applyTheme() {
  DOM.themeBtn.setAttribute('aria-label', STATE.isDark ? '切换到浅色主题' : '切换到深色主题');
  if (STATE.isDark) {
    document.body.classList.remove("light");
    DOM.themeIconLight.style.display = "none";
    DOM.themeIconDark.style.display = "";
  } else {
    document.body.classList.add("light");
    DOM.themeIconLight.style.display = "";
    DOM.themeIconDark.style.display = "none";
  }
  if (readerHost.overlay && readerHost.overlay.contentWindow) readerHost.overlay.contentWindow.postMessage({ type: "voice-reader-theme-state", theme: STATE.isDark ? "dark" : "light" }, location.origin);
}

function toggleMobile() {
  STATE.isMobile = !STATE.isMobile;
  applyMobileMode();
  writeSearchPreference("mobileMode", STATE.isMobile ? "mobile" : "desktop");
}

function applyMobileMode() {
  DOM.mobileToggleBtn.setAttribute('aria-label', STATE.isMobile ? '切换到电脑版' : '切换到手机版');
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

function focusSearchSidebar(sidebar) {
  const control = Array.from(sidebar.querySelectorAll('button,a[href],input,select,[tabindex="0"]'))
    .find(node => !node.disabled && node.getClientRects().length && !node.closest('[hidden],[inert]'));
  (control || sidebar).focus({ preventScroll: true });
}

function toggleLeftSidebar(event) {
  if (STATE.leftSidebarOpen) {
    closeLeftSidebar();
    return;
  }
  STATE.leftSidebarOpen = true;
  if (STATE.isMobile && STATE.leftSidebarOpen && STATE.rightSidebarOpen) STATE.rightSidebarOpen = false;
  updateSidebarVisibility();
  updateSidebarHeader();
  syncStateToURL();
  if (event?.detail === 0 || event?.type === 'keydown') focusSearchSidebar(DOM.leftSidebar);
}

function toggleRightSidebar(event) {
  if (STATE.rightSidebarOpen) return closeRightSidebar();
  STATE.rightSidebarOpen = true;
  if (STATE.rightSidebarOpen && STATE.leftSidebarOpen && STATE.isMobile) STATE.leftSidebarOpen = false;
  updateSidebarVisibility();
  syncStateToURL();
  if (event?.detail === 0 || event?.type === 'keydown') focusSearchSidebar(DOM.rightSidebar);
}

function updateSidebarVisibility() {
  const main = /** @type {HTMLElement} */ (document.querySelector('#main-content'));
  const covered = STATE.isMobile && (STATE.leftSidebarOpen || STATE.rightSidebarOpen);
  const focusCovered = covered && main.contains(document.activeElement);
  main.inert = covered;
  for (const [sidebar, button, open] of [[DOM.leftSidebar, DOM.hamburgerBtn, STATE.leftSidebarOpen],
      [DOM.rightSidebar, DOM.settingsBtn, STATE.rightSidebarOpen]]) {
    const restoreFocus = !open && sidebar.contains(document.activeElement);
    sidebar.inert = !open;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', sidebar === DOM.leftSidebar ? (open ? '关闭仓库导航' : '打开仓库导航') :
      (open ? '关闭搜索过滤' : '打开搜索过滤'));
    if (restoreFocus) button.focus({ preventScroll: true });
  }
  DOM.leftSidebar.classList.toggle("collapsed", !STATE.leftSidebarOpen);
  DOM.leftSidebar.classList.toggle("open", STATE.leftSidebarOpen);
  DOM.rightSidebar.classList.toggle("collapsed", !STATE.rightSidebarOpen);
  DOM.rightSidebar.classList.toggle("open", STATE.rightSidebarOpen);
  DOM.overlay.style.display = "";
  DOM.overlay.classList.toggle("open", STATE.isMobile && (STATE.leftSidebarOpen || STATE.rightSidebarOpen));
  if (focusCovered) focusSearchSidebar(STATE.rightSidebarOpen ? DOM.rightSidebar : DOM.leftSidebar);
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

function setupResultDelegation() {
  DOM.resultsList.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const path = event.target.closest('.path-folder[role="button"]');
    if (path && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.stopPropagation(); path.click();
    }
  });
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
      if (frepo && folder !== undefined) {
        // A result breadcrumb selects the complete directory subtree and
        // opens the same path in the left browser in one history entry.
        let hash = "#/" + encodeURIComponent(frepo);
        const sp = buildSearchURLParams({ displaySizes: true });
        if (folder) {
          sp.set("path", folder);
          sp.append("folder_subtree", folder);
        }
        const qs = sp.toString();
        const nextHash = qs ? hash + "?" + qs : hash;
        // A user may browse the sidebar elsewhere without changing filters,
        // then click the already-selected breadcrumb to return to it.
        if (window.location.hash === nextHash) renderBrowser(folder, routeRenderId);
        else window.location.hash = nextHash;
      }
      return;
    }
  });
  DOM.sidebarContent.addEventListener("click", function(e) {
    const repoItem = e.target.closest(".repo-list-item");
    if (repoItem) {
      ROUTER.navigate("repo", repoItem.dataset.repo);
      return;
    }
    const browserItem = e.target.closest(".browser-item");
    if (!browserItem) return;
    if (e.target.closest(".browser-action")) {
      e.stopPropagation();
      if (browserItem.dataset.link) {
        downloadFile(browserItem.dataset.filename || "file", browserItem.dataset.link,
          { button: browserItem.querySelector(".browser-action") });
      }
      return;
    }
    if (browserItem.dataset.type === "folder") {
      ROUTER.navigate("repo", STATE.repo, browserItem.dataset.path);
      return;
    }
    const readerLink = browserItem.dataset.readerUrl;
    if (readerLink) {
      navigateToReader(readerLink);
      return;
    }
    if (browserItem.dataset.link) {
      downloadFile(browserItem.dataset.filename || "file", browserItem.dataset.link);
    }
  });
}

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
      for (var si = lo; si <= hi; si++) if (STATE.results[si] || resultSnapshots.cloneTask?.snapshot.results[si]) selectedIndices[si] = true;
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
    const records = resultSnapshots.cloneTask?.snapshot.results || STATE.results;
    var allSelected = records.length > 0 && records.every(function(record, index) { return !record || selectedIndices[index]; });
    if (allSelected) selectedIndices = {};
    else for (var si = 0; si < records.length; si++) if (records[si]) selectedIndices[si] = true;
    lastSelectedIndex = allSelected ? -1 : STATE.results.length - 1;
    updateSelectionUI();
  });
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
  readerAssetDelayUntilPaint = true;
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

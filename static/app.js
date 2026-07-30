const DATA_URL = "data/search_data.json.gz";
const FOLDER_TREE_URL = "data/folder_tree.json.gz";
const FOLDER_BROWSER_URL = "data/folder_browser.json.gz";
const TXT_BASE = "https://voiceofml-search.hf.space/txt";
const API_BASE = "https://voiceofml-search.hf.space";
const MIRROR_HOST = "hf-mirror.com";
const HF_DATASET_BASE = "https://huggingface.co/datasets";

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

let RECORDS = [];

let PRECOMPUTED_FOLDER_TREES = {};

let PRECOMPUTED_FOLDER_BROWSER = {};
let wordIndex = {};
let wordIndexFilesOnly = {};
let extensionCounts = {};
let repoCounts = {};
let folderIndex = {};
let vocabSorted = [];
let vocabSortedFilesOnly = [];
let repoList = [];
let extensionList = [];
let allRecordIndices = [];
let sortedByNameIndices = [];
let sortedBySizeIndices = [];
let repoRecordIndices = {};
let repoSortedByNameIndices = {};
let repoSortedBySizeIndices = {};
let txtRecordIndices = [];
let repoTxtRecordIndices = {};
let fullTextIndexReady = false;
let fullTextIndexPromise = null;
let fullTextWorker = null;
let localSearchWorkerPromise = null;
let localSearchRequestId = 0;
let folderTreeDataPromise = null;
let folderBrowserDataPromise = null;
const folderTreeCache = new Map();

let keepalivePending = null;
let lastKeepaliveAt = 0;
const KEEPALIVE_INTERVAL_MS = 45 * 1000;
const KEEPALIVE_MIN_GAP_MS = 30 * 1000;

const RECORD_KEY_MAP = {
  r: "Repo",
  f: "File",
  e: "Extension",
  d: "Folder",
  s: "Size",
  t: "HasTxt",
};

function decodeRecord(rec) {
  if (!rec || rec.Repo !== undefined) return rec;
  return {
    Repo: rec.r || "",
    File: rec.f || "",
    Extension: rec.e || "",
    Folder: Array.isArray(rec.d) ? rec.d : [],
    Size: rec.s || "",
    HasTxt: !!rec.t,
  };
}

function decodeSearchPayload(data) {
  if (Array.isArray(data)) {
    return data.map(decodeRecord);
  }
  if (!data || typeof data !== "object") return [];
  const repos = Array.isArray(data.rp) ? data.rp : [];
  const folders = Array.isArray(data.fd) ? data.fd : [];
  const encodedRecords = Array.isArray(data.rc) ? data.rc : [];
  const records = new Array(encodedRecords.length);
  for (let i = 0; i < encodedRecords.length; i++) {
    const item = encodedRecords[i];
    if (!Array.isArray(item) || item.length < 6) {
      records[i] = { Repo: "", File: "", Extension: "", Folder: [], Size: "", HasTxt: false };
      continue;
    }
    const repo = Number.isInteger(item[0]) && item[0] >= 0 && item[0] < repos.length ? repos[item[0]] : "";
    const folder = Number.isInteger(item[3]) && item[3] >= 0 && item[3] < folders.length ? folders[item[3]] : [];
    records[i] = {
      Repo: repo,
      File: item[1] || "",
      Extension: item[2] || "",
      Folder: Array.isArray(folder) ? folder : [],
      Size: item[4] || "",
      HasTxt: !!item[5],
    };
  }
  return records;
}

function decodeTreeNode(node) {
  return decodeTreeNodeWithContext(node, "", false);
}

function decodeTreeNodeWithContext(node, parentPath, isRoot) {
  if (!node) return node;
  if (node.name !== undefined) {
    const decoded = Object.assign({}, node);
    if (decoded.path === undefined) {
      decoded.path = isRoot ? "" : (parentPath ? parentPath + "/" + (decoded.name || "") : (decoded.name || ""));
    }
    decoded.children = Array.isArray(decoded.children)
      ? decoded.children.map(function(child) { return decodeTreeNodeWithContext(child, decoded.path, false); })
      : [];
    decoded.hasChildren = decoded.hasChildren !== undefined ? !!decoded.hasChildren : decoded.children.length > 0;
    decoded.showSelfToggle = decoded.showSelfToggle !== undefined
      ? !!decoded.showSelfToggle
      : !!(decoded.path && decoded.hasDirectFiles && decoded.hasChildren);
    if (isRoot) decoded.isRoot = true;
    return decoded;
  }
  const name = node.n || "";
  const path = isRoot ? "" : (parentPath ? parentPath + "/" + name : name);
  const children = Array.isArray(node.ch)
    ? node.ch.map(function(child) { return decodeTreeNodeWithContext(child, path, false); })
    : [];
  const decoded = {
    name: name,
    path: path,
    count: node.c || 0,
    hasDirectFiles: !!node.df,
    hasChildren: children.length > 0,
    showSelfToggle: !!(path && node.df && children.length > 0),
    children: children,
  };
  if (isRoot) decoded.isRoot = true;
  return decoded;
}

function decodeFolderTreeData(data) {
  if (!data || Array.isArray(data)) return data || {};
  const decoded = {};
  for (const repo in data) {
    if (!Object.prototype.hasOwnProperty.call(data, repo)) continue;
    decoded[repo] = Array.isArray(data[repo]) ? data[repo].map(function(node) {
      return decodeTreeNodeWithContext(node, "", true);
    }) : [];
  }
  return decoded;
}

function decodeBrowserEntry(entry, currentPath) {
  if (!entry) return entry;
  if (entry.folders !== undefined) {
    const decoded = Object.assign({}, entry);
    decoded.current_path = decoded.current_path !== undefined ? decoded.current_path : (currentPath || "");
    decoded.folders = Array.isArray(decoded.folders) ? decoded.folders.map(function(item) {
      const folder = Object.assign({}, item);
      if (folder.path === undefined) {
        folder.path = currentPath ? currentPath + "/" + (folder.name || "") : (folder.name || "");
      }
      return folder;
    }) : [];
    return decoded;
  }
  return {
    folders: Array.isArray(entry.d) ? entry.d.map(function(item) {
      return {
        name: item.n || "",
        path: currentPath ? currentPath + "/" + (item.n || "") : (item.n || ""),
        count: item.c || 0,
      };
    }) : [],
    files: Array.isArray(entry.f) ? entry.f.map(function(item) {
      return { name: item.n || "", ext: item.e || "", hasTxt: !!item.t, size: item.s || "" };
    }) : [],
    current_path: currentPath || "",
  };
}

function decodeFolderBrowserData(data) {
  if (!data || Array.isArray(data)) return data || {};
  const decoded = {};
  for (const repo in data) {
    if (!Object.prototype.hasOwnProperty.call(data, repo)) continue;
    decoded[repo] = {};
    const repoBrowser = data[repo] || {};
    for (const path in repoBrowser) {
      if (!Object.prototype.hasOwnProperty.call(repoBrowser, path)) continue;
      decoded[repo][path] = decodeBrowserEntry(repoBrowser[path], path);
    }
  }
  return decoded;
}

function tokenize(text) {
  const tokens = [];
  const lower = text.toLowerCase();
  const alpha = lower.match(/[a-z0-9]+/g);
  if (alpha) tokens.push(...alpha);
  const chineseChars = [];
  for (const ch of lower) {
    if (("\u4e00" <= ch && ch <= "\u9fff") || ("\u3400" <= ch && ch <= "\u4dbf")) {
      chineseChars.push(ch);
      tokens.push(ch);
    }
  }
  for (let i = 0; i < chineseChars.length - 1; i++) {
    tokens.push(chineseChars[i] + chineseChars[i + 1]);
  }
  return [...new Set(tokens)];
}

function wildcardPatternToRegExp(pattern) {
  const escaped = String(pattern || "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\*/g, ".*").replace(/\?/g, "."), "i");
}

function matchesExactQuery(text, query) {
  const value = String(text || "");
  const pattern = String(query || "");
  if (pattern.indexOf("*") >= 0 || pattern.indexOf("?") >= 0) return wildcardPatternToRegExp(pattern).test(value);
  return value.toLowerCase().indexOf(pattern.toLowerCase()) >= 0;
}

function shouldUseLiteralLocalSearch(query) {
  return /[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf\s]/i.test(String(query || ""));
}

function setExactSearchSectionVisible(visible, animate) {
  if (!DOM.exactSearchSection) return;
  if (!animate) DOM.exactSearchSection.style.transition = "none";
  DOM.exactSearchSection.classList.toggle("exact-section-hidden", !visible);
  if (!animate) {
    void DOM.exactSearchSection.offsetHeight;
    DOM.exactSearchSection.style.transition = "";
  }
}

function editDistance(s1, s2, maxDist) {
  maxDist = maxDist || 2;
  if (Math.abs(s1.length - s2.length) > maxDist) return 999;
  let prev = [];
  for (let j = 0; j <= s2.length; j++) prev.push(j);
  for (let i = 0; i < s1.length; i++) {
    const curr = [i + 1];
    let minInRow = i + 1;
    for (let j = 0; j < s2.length; j++) {
      const cost = s1[i] === s2[j] ? 0 : 1;
      const val = Math.min(prev[j + 1] + 1, curr[j] + 1, prev[j] + cost);
      curr.push(val);
      if (val < minInRow) minInRow = val;
    }
    if (minInRow > maxDist) return 999;
    prev = curr;
  }
  return prev[prev.length - 1];
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

function getRecordLink(rec) {
  return rec.Link || buildRecordLink(rec);
}

function getRecordPath(rec) {
  return rec.Path || buildRecordPath(rec);
}

function buildDownloadUrl(filename, link) {
  return API_BASE + "/api/download?file=" + encodeURIComponent(filename || "file") + "&link=" + encodeURIComponent(link || "");
}

async function downloadFile(filename, link, options) {
  options = options || {};
  showToast("开始下载...");
  try {
    if (!options.skipCheck) {
      var resp = await fetchWithTimeout(API_BASE + "/api/download/check?link=" + encodeURIComponent(link || ""), DOWNLOAD_CHECK_TIMEOUT);
      if (!resp.ok) {
        var message = "下载失败";
        try {
          var data = await resp.json();
          if (data && data.error) message = data.error;
        } catch (e) {}
        showToast(message, 3500);
        return false;
      }
    }
    var a = document.createElement("a");
    a.href = buildDownloadUrl(filename, link);
    a.download = filename || "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (e) {
    console.error(e);
    showToast("下载失败，请稍后重试", 3500);
    return false;
  }
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

function openPendingWindow() {
  const popup = window.open("about:blank", "_blank");
  if (popup) popup.opener = null;
  return popup;
}

function buildIndex(includeFullText) {
  return new Promise(function(resolve) {
    if (includeFullText) {
      wordIndex = {};
      wordIndexFilesOnly = {};
      vocabSorted = [];
      vocabSortedFilesOnly = [];
    } else {
      extensionCounts = {};
      repoCounts = {};
      folderIndex = {};
      repoRecordIndices = {};
      txtRecordIndices = [];
      repoTxtRecordIndices = {};
    }
    let i = 0;
    const chunkSize = 5000;
    function processChunk() {
      const end = Math.min(i + chunkSize, RECORDS.length);
      for (; i < end; i++) {
        const rec = RECORDS[i];
        const repo = rec.Repo || "";
        const ext = (rec.Extension || "").toLowerCase();
        const folders = rec.Folder || [];
        if (!includeFullText) {
          rec._fileLower = (rec.File || "").toLowerCase();
          rec._repoLower = repo.toLowerCase();
          rec._folderPath = folders.join("/");
          rec._folderPathLower = rec._folderPath.toLowerCase();
          repoCounts[repo] = (repoCounts[repo] || 0) + 1;
          if (!repoRecordIndices[repo]) repoRecordIndices[repo] = [];
          repoRecordIndices[repo].push(i);
          if (rec.HasTxt) {
            txtRecordIndices.push(i);
            if (!repoTxtRecordIndices[repo]) repoTxtRecordIndices[repo] = [];
            repoTxtRecordIndices[repo].push(i);
          }
          if (ext) extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
        }
        if (includeFullText) {
          const text = [rec.File || "", ...folders].join(" ");
          const tokens = tokenize(text);
          for (const tok of tokens) {
            if (!wordIndex[tok]) wordIndex[tok] = [];
            wordIndex[tok].push(i);
          }
          const fileTokens = tokenize(rec.File || "");
          for (const tok of fileTokens) {
            if (!wordIndexFilesOnly[tok]) wordIndexFilesOnly[tok] = [];
            wordIndexFilesOnly[tok].push(i);
          }
        }
        if (!includeFullText) {
          if (!folderIndex[repo]) folderIndex[repo] = {};
          for (let d = 0; d <= folders.length; d++) {
            const fp = d === 0 ? "" : folders.slice(0, d).join("/");
            folderIndex[repo][fp] = (folderIndex[repo][fp] || 0) + 1;
          }
        }
      }
      if (i < RECORDS.length) {
        setTimeout(processChunk, 0);
      } else {
        if (includeFullText) {
          vocabSorted = Object.keys(wordIndex).map(function(tok) { return [tok, wordIndex[tok].length]; }).sort((a, b) => b[1] - a[1]);
          vocabSortedFilesOnly = Object.keys(wordIndexFilesOnly).map(function(tok) { return [tok, wordIndexFilesOnly[tok].length]; }).sort((a, b) => b[1] - a[1]);
          fullTextIndexReady = true;
        } else {
          repoList = Object.entries(repoCounts)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.name.localeCompare(b.name));
          extensionList = Object.keys(extensionCounts).sort();
          allRecordIndices = Array.from({ length: RECORDS.length }, function(_, idx) { return idx; });
          sortedByNameIndices = allRecordIndices.slice().sort(function(a, b) {
            return (RECORDS[a].File || "").localeCompare(RECORDS[b].File || "", "zh");
          });
          sortedBySizeIndices = allRecordIndices.slice().sort(function(a, b) {
            const sa = typeof RECORDS[a].Size === "number" ? RECORDS[a].Size : 0;
            const sb = typeof RECORDS[b].Size === "number" ? RECORDS[b].Size : 0;
            return sb - sa;
          });
          repoSortedByNameIndices = {};
          repoSortedBySizeIndices = {};
          for (const repoName in repoRecordIndices) {
            if (!Object.prototype.hasOwnProperty.call(repoRecordIndices, repoName)) continue;
            repoSortedByNameIndices[repoName] = repoRecordIndices[repoName].slice().sort(function(a, b) {
              return (RECORDS[a].File || "").localeCompare(RECORDS[b].File || "", "zh");
            });
            repoSortedBySizeIndices[repoName] = repoRecordIndices[repoName].slice().sort(function(a, b) {
              const sa = typeof RECORDS[a].Size === "number" ? RECORDS[a].Size : 0;
              const sb = typeof RECORDS[b].Size === "number" ? RECORDS[b].Size : 0;
              return sb - sa;
            });
          }
        }
        resolve();
      }
    }
    processChunk();
  });
}

function bytesToDisplay(bytes) {
  if (bytes === null || bytes === undefined || bytes === 0) return { value: "", unit: "MB" };
  if (bytes >= 1073741824) return { value: (bytes / 1073741824).toFixed(2).replace(/\.?0+$/, ""), unit: "GB" };
  if (bytes >= 1048576) return { value: (bytes / 1048576).toFixed(1).replace(/\.0$/, ""), unit: "MB" };
  if (bytes >= 1024) return { value: (bytes / 1024).toFixed(1).replace(/\.0$/, ""), unit: "KB" };
  return { value: String(bytes), unit: "B" };
}

function fmtSizeUrl(bytes) {
  if (bytes === null || bytes === undefined) return null;
  var d = bytesToDisplay(bytes);
  return d.value + d.unit;
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
var FOLDER_FILTER_STORAGE_PREFIX = "voml_folder_filter:";
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

function folderFilterStorageKey(repo) {
  return FOLDER_FILTER_STORAGE_PREFIX + (repo || "global");
}

function mergeFolderFilters(selfs, subtrees) {
  return (selfs || []).concat((subtrees || []).filter(function(path) {
    return (selfs || []).indexOf(path) < 0;
  }));
}

function loadStoredFolderFilters(repo) {
  try {
    var data = JSON.parse(sessionStorage.getItem(folderFilterStorageKey(repo)) || "{}");
    var selfs = Array.isArray(data.selfs) ? data.selfs.filter(Boolean) : [];
    var subtrees = Array.isArray(data.subtrees) ? data.subtrees.filter(Boolean) : [];
    return { selfs: selfs, subtrees: subtrees, folders: mergeFolderFilters(selfs, subtrees) };
  } catch (e) {
    return { selfs: [], subtrees: [], folders: [] };
  }
}

function loadStoredExtensionFilters() {
  try {
    var data = JSON.parse(sessionStorage.getItem(EXT_FILTER_STORAGE_KEY) || "{}");
    return Array.isArray(data.values) ? data.values.filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}

function saveStoredFolderFilters(repo) {
  if (!repo) return;
  var selfs = (STATE.filterFolderSelfs || []).filter(Boolean);
  var subtrees = (STATE.filterFolderSubtrees || []).filter(Boolean);
  try {
    if (!selfs.length && !subtrees.length) {
      sessionStorage.removeItem(folderFilterStorageKey(repo));
    } else {
      sessionStorage.setItem(folderFilterStorageKey(repo), JSON.stringify({ selfs: selfs, subtrees: subtrees }));
    }
  } catch (e) {}
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
    RECORDS = decodeSearchPayload(await loadGzipJSON(DATA_URL));
    await buildIndex(false);
    return true;
  } catch (e) {
    console.error("Data load failed:", e);
    return false;
  }
}

function ensureFullTextIndex() {
  if (fullTextIndexReady) return Promise.resolve(true);
  if (fullTextIndexPromise) return fullTextIndexPromise;
  if (window.Worker) {
    fullTextIndexPromise = new Promise(function(resolve, reject) {
      var workerPromise = localSearchWorkerPromise
        ? localSearchWorkerPromise
        : Promise.resolve(fullTextWorker || null);
      workerPromise.then(function(existingWorker) {
        if (fullTextIndexReady) { resolve(true); return; }
        var worker = existingWorker || fullTextWorker || new Worker("static/index-worker.js");
        function onMessage(event) {
          var data = event.data || {};
          if (data.type !== "fulltext-ready") return;
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          fullTextIndexReady = true;
          fullTextIndexPromise = null;
          fullTextWorker = worker;
          resolve(true);
        }
        function onError(err) {
          worker.removeEventListener("message", onMessage);
          fullTextIndexPromise = null;
          worker.terminate();
          fullTextWorker = null;
          reject(err);
        }
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError, { once: true });
        worker.postMessage(existingWorker || fullTextWorker ? { type: "build-fulltext" } : { type: "build-fulltext", records: RECORDS });
      }).catch(function(err) { reject(err); });
    }).catch(function() {
      fullTextIndexPromise = null;
      fullTextWorker = null;
      return buildIndex(true);
    });
    return fullTextIndexPromise;
  }
  fullTextIndexPromise = buildIndex(true).then(function() {
    fullTextIndexPromise = null;
    return true;
  }).catch(function(err) {
    fullTextIndexPromise = null;
    throw err;
  });
  return fullTextIndexPromise;
}

function ensureLocalSearchWorker() {
  if (fullTextWorker) return Promise.resolve(fullTextWorker);
  if (localSearchWorkerPromise) return localSearchWorkerPromise;
  if (!window.Worker) return Promise.resolve(null);
  localSearchWorkerPromise = new Promise(function(resolve, reject) {
    const worker = new Worker("static/index-worker.js");
    function onMessage(event) {
      if (!event.data || event.data.type !== "records-ready") return;
      worker.removeEventListener("message", onMessage);
      fullTextWorker = worker;
      localSearchWorkerPromise = null;
      resolve(worker);
    }
    worker.addEventListener("message", onMessage);
    worker.onerror = function(error) {
      localSearchWorkerPromise = null;
      worker.terminate();
      reject(error);
    };
    worker.postMessage({ type: "init-records", records: RECORDS });
  });
  return localSearchWorkerPromise;
}

function ensureFolderTreeData() {
  if (Object.keys(PRECOMPUTED_FOLDER_TREES).length > 0) return Promise.resolve(PRECOMPUTED_FOLDER_TREES);
  if (folderTreeDataPromise) return folderTreeDataPromise;
  folderTreeDataPromise = loadGzipJSON(FOLDER_TREE_URL).then(function(data) {
    PRECOMPUTED_FOLDER_TREES = decodeFolderTreeData(data || {});
    folderTreeDataPromise = null;
    return PRECOMPUTED_FOLDER_TREES;
  }).catch(function(err) {
    folderTreeDataPromise = null;
    throw err;
  });
  return folderTreeDataPromise;
}

function ensureFolderBrowserData() {
  if (Object.keys(PRECOMPUTED_FOLDER_BROWSER).length > 0) return Promise.resolve(PRECOMPUTED_FOLDER_BROWSER);
  if (folderBrowserDataPromise) return folderBrowserDataPromise;
  folderBrowserDataPromise = loadGzipJSON(FOLDER_BROWSER_URL).then(function(data) {
    PRECOMPUTED_FOLDER_BROWSER = decodeFolderBrowserData(data || {});
    folderBrowserDataPromise = null;
    return PRECOMPUTED_FOLDER_BROWSER;
  }).catch(function(err) {
    folderBrowserDataPromise = null;
    throw err;
  });
  return folderBrowserDataPromise;
}

async function loadGzipJSON(url) {
  var resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  var reader = resp.body.getReader();
  var chunks = [];
  var received = 0;
  while (true) {
    var doneVal = await reader.read();
    if (doneVal.done) break;
    chunks.push(doneVal.value);
    received += doneVal.value.length;
  }
  var buf;
  if (chunks.length === 1) {
    buf = chunks[0];
  } else {
    buf = new Uint8Array(received);
    var pos = 0;
    for (var c = 0; c < chunks.length; c++) {
      buf.set(chunks[c], pos);
      pos += chunks[c].length;
    }
  }
  var ds = new DecompressionStream("gzip");
  var stream = new Response(buf).body.pipeThrough(ds);
  return JSON.parse(await new Response(stream).text());
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

function scoreRecord(recIdx, tokens, searchFolders) {
  const rec = RECORDS[recIdx];
  let score = 0;
  const fname = rec._fileLower || "";
  const repo = rec._repoLower || "";
  const folderPath = rec._folderPathLower || "";
  for (const tok of tokens) {
    if (fname.includes(tok)) score += 3;
    if (searchFolders && folderPath.includes(tok)) score += 2;
    if (repo.includes(tok)) score += 1;
  }
  return score;
}

function applyFilters(indices, repos, extensions, folders, minSize, maxSize, folderMatchMode) {
  return indices.filter(idx => {
    const rec = RECORDS[idx];
    if (repos && repos.length > 0 && !repos.includes(rec.Repo)) return false;
    if (extensions && extensions.length > 0) {
      const ext = (rec.Extension || "").toLowerCase();
      if (!extensions.includes(ext)) return false;
    }
    if (folders && folders.length > 0) {
      const recFolders = rec.Folder || [];
      let matched = false;
      for (const f of folders) {
        const clean = f.replace(/^\/+|\/+$/g, "");
        if (folderMatchMode === "exact") {
          const recPath = rec._folderPath || "";
          if (recPath === clean) {
            matched = true;
            break;
          }
        } else if (clean === "") {
          if (recFolders.length === 0) { matched = true; break; }
        } else {
          for (let d = 0; d <= recFolders.length; d++) {
            const prefix = d === 0 ? "" : recFolders.slice(0, d).join("/");
            if (prefix === clean) { matched = true; break; }
          }
          if (matched) break;
        }
      }
      if (!matched) return false;
    }
    const size = rec.Size;
    if (size && typeof size === "number" && size > 0) {
      if (minSize !== null && size < minSize) return false;
      if (maxSize !== null && size > maxSize) return false;
    }
    return true;
  });
}

function doSearchLocalMain(params) {
  const q = (params.q || "").trim();
  const repos = params.repos || null;
  const extensions = params.extensions || null;
  const folders = params.folders || null;
  const minSize = params.minSize !== null ? params.minSize : null;
  const maxSize = params.maxSize !== null ? params.maxSize : null;
  const folderMatchMode = params.folderMatchMode || "prefix";
  const sort = params.sort || "relevance";
  const searchFolders = params.searchFolders !== false;
  const exactMode = params.exact || false;
  const page = params.page || 1;
  const pageSize = params.pageSize || 100;
  let matched = [];
  const activeIndex = searchFolders ? wordIndex : wordIndexFilesOnly;
  const activeVocabSorted = searchFolders ? vocabSorted : vocabSortedFilesOnly;
  if (!q) {
    if (repos && repos.length === 1 && !extensions && !folders && minSize === null && maxSize === null && folderMatchMode !== "mixed") {
      matched = sort === "name"
        ? (repoSortedByNameIndices[repos[0]] || [])
        : (sort === "size" ? (repoSortedBySizeIndices[repos[0]] || []) : (repoRecordIndices[repos[0]] || []));
    } else {
      matched = sort === "name" ? sortedByNameIndices : (sort === "size" ? sortedBySizeIndices : allRecordIndices);
    }
  } else if (exactMode || shouldUseLiteralLocalSearch(q)) {
    const hasWildcard = q.indexOf("*") >= 0 || q.indexOf("?") >= 0;
    const exactPattern = hasWildcard ? wildcardPatternToRegExp(q) : null;
    const exactQuery = hasWildcard ? "" : q.toLowerCase();
    for (var ei = 0; ei < RECORDS.length; ei++) {
      var rec = RECORDS[ei];
      var fn = rec._fileLower || "";
      var rn = rec._repoLower || "";
      var pf = rec._folderPathLower || "";
      var isMatch = hasWildcard
        ? exactPattern.test(fn) || exactPattern.test(rn) || (searchFolders && exactPattern.test(pf))
        : fn.includes(exactQuery) || rn.includes(exactQuery) || (searchFolders && pf.includes(exactQuery));
      if (isMatch) {
        matched.push(ei);
      }
    }
  } else {
    const tokens = tokenize(q);
    let tokenMatches = null;
    for (const tok of tokens) {
      let candidates = activeIndex[tok] || null;
      if (!candidates) {
        const fuzzyCandidates = [];
        for (const [vocab] of activeVocabSorted) {
          if (Math.abs(vocab.length - tok.length) > 2) continue;
          if (editDistance(tok, vocab) <= 2) {
            fuzzyCandidates.push(...(activeIndex[vocab] || []));
            if (fuzzyCandidates.length >= 200) break;
          }
        }
        candidates = fuzzyCandidates.length > 0 ? [...new Set(fuzzyCandidates)] : [];
      }
      if (candidates.length === 0) {
        tokenMatches = [];
        break;
      }
      if (tokenMatches === null) tokenMatches = [...candidates];
      else {
        const candidateSet = new Set(candidates);
        tokenMatches = tokenMatches.filter(i => candidateSet.has(i));
      }
      if (tokenMatches.length === 0) break;
    }
    matched = tokenMatches || [];
  }
  let filtered = matched;
    if (folderMatchMode === "mixed") {
      filtered = applyMixedFolderFilters(filtered, params.folderSelfs || [], params.folderSubtrees || []);
      filtered = applyFilters(filtered, repos, extensions, null, minSize, maxSize, "prefix");
    } else {
    filtered = applyFilters(filtered, repos, extensions, folders, minSize, maxSize, folderMatchMode);
  }
  const tokens = q ? tokenize(q) : [];
  let scored;
  if (!q && (sort === "name" || sort === "size")) {
    scored = filtered.map(function(idx) { return { idx: idx, score: 0 }; });
  } else {
    scored = filtered.map(idx => ({
      idx,
      score: q ? scoreRecord(idx, tokens, searchFolders) : 0
    }));
    if (sort === "name") {
      scored.sort((a, b) => (RECORDS[a.idx].File || "").localeCompare(RECORDS[b.idx].File || "", "zh"));
    } else if (sort === "size") {
      scored.sort((a, b) => {
        const sa = typeof RECORDS[a.idx].Size === "number" ? RECORDS[a.idx].Size : 0;
        const sb = typeof RECORDS[b.idx].Size === "number" ? RECORDS[b.idx].Size : 0;
        return sb - sa;
      });
    } else {
      scored.sort((a, b) => b.score - a.score);
    }
  }
  const total = scored.length;
  const start = (page - 1) * pageSize;
  const paged = scored.slice(start, start + pageSize).map(s => RECORDS[s.idx]);
  return { results: paged, total, page, pageSize };
}

async function doSearchLocal(params) {
  const needsFullText = !!(params.q && !params.exact && !shouldUseLiteralLocalSearch(params.q));
  try {
    if (needsFullText) await ensureFullTextIndex();
    else await ensureLocalSearchWorker();
  } catch (e) {
    return doSearchLocalMain(params);
  }
  if (!fullTextWorker) return doSearchLocalMain(params);
  const requestId = ++localSearchRequestId;
  const workerParams = Object.assign({}, params);
  delete workerParams.signal;
  const data = await new Promise(function(resolve, reject) {
    var settled = false;
    function cleanup() {
      fullTextWorker.removeEventListener("message", onMessage);
      fullTextWorker.removeEventListener("error", onError);
      clearTimeout(timer);
    }
    function onMessage(event) {
      var message = event.data || {};
      if (message.type !== "local-search-result" || message.id !== requestId) return;
      cleanup();
      settled = true;
      if (message.error) reject(new Error(message.error));
      else resolve(message.result || { indices: [], total: 0, page: params.page || 1, pageSize: params.pageSize || 100 });
    }
    function onError() {
      if (settled) return;
      cleanup();
      settled = true;
      reject(new Error("worker_error"));
    }
    var timer = setTimeout(function() {
      if (settled) return;
      cleanup();
      settled = true;
      reject(new Error("worker_timeout"));
    }, 10000);
    fullTextWorker.addEventListener("message", onMessage);
    fullTextWorker.addEventListener("error", onError);
    fullTextWorker.postMessage({ type: "local-search", id: requestId, params: workerParams });
  });
  return {
    results: (data.indices || []).map(function(idx) { return RECORDS[idx]; }),
    total: data.total || 0,
    page: data.page || params.page || 1,
    pageSize: data.pageSize || params.pageSize || 100,
  };
}

function applyMixedFolderFilters(indices, selfFolders, subtreeFolders) {
  if ((!selfFolders || selfFolders.length === 0) && (!subtreeFolders || subtreeFolders.length === 0)) {
    return indices;
  }
  const selfSet = new Set((selfFolders || []).map(function(path) {
    return String(path || "").replace(/^\/+|\/+$/g, "");
  }).filter(Boolean));
  const subtreeSet = new Set((subtreeFolders || []).map(function(path) {
    return String(path || "").replace(/^\/+|\/+$/g, "");
  }).filter(Boolean));
  return indices.filter(function(idx) {
    const rec = RECORDS[idx];
    const recFolders = rec.Folder || [];
    const recPath = rec._folderPath || "";
    if (selfSet.has(recPath)) return true;
    for (let d = 1; d <= recFolders.length; d++) {
      const prefix = recFolders.slice(0, d).join("/");
      if (subtreeSet.has(prefix)) return true;
    }
    return false;
  });
}

async function doSearchAPI(params, append, requestId) {
  if (requestId !== searchRequestId) {
    return false;
  }
  if (append && STATE._pageCache[params.page]) {
    if (VSCROLL.isDraggingThumb) {
      STATE._deferredAppendWhileDragging = true;
      STATE._pendingPage = 0;
      STATE.isLoading = false;
      return true;
    }
    var cp = params.page;
    STATE.results = STATE.results.concat(STATE._pageCache[cp]);
    delete STATE._pageCache[cp];
    STATE._loadedPage = cp;
    var np = cp + 1;
    while (STATE._pageCache[np]) {
      STATE.results = STATE.results.concat(STATE._pageCache[np]);
      delete STATE._pageCache[np];
      np++;
    }
    STATE._loadedPage = np - 1;
    STATE.hasMore = STATE.results.length < STATE.total;
    return true;
  }
  const q = params.q || "";
  const isRepo = !!STATE.repoFull;
  const base = isRepo ? API_BASE + "/api/search/" + STATE.repo : API_BASE + "/api/search";
  const body = {};
  if (q) body.q = q;
  body.page = params.page || 1;
  body.page_size = params.pageSize || STATE.pageSize;
  if (!isRepo && params.repos && params.repos.length > 0) body.repos = params.repos;
  if (params.extensions && params.extensions.length > 0) body.extensions = params.extensions;
  if (params.folders && params.folders.length > 0) body.folders = params.folders;
  if (params.minSize !== null) body.min_size = params.minSize;
  if (params.maxSize !== null) body.max_size = params.maxSize;
  body.sort = params.sort || "relevance";
  if (!params.searchFolders) body.search_folders = false;
  if (params.exact) body.exact = true;
  const cacheKey = base + "|" + stableSearchStringify(body);
  const cached = getCachedSearchResponse(cacheKey);
  if (cached) {
    STATE.total = cached.total;
    if (append) {
      if (VSCROLL.isDraggingThumb) {
        STATE._pageCache[cached.page] = cached.results;
        STATE._deferredAppendWhileDragging = true;
        STATE._pendingPage = 0;
        STATE.isLoading = false;
        return true;
      }
      STATE._pageCache[cached.page] = cached.results;
      var cachedNextPage = STATE._loadedPage + 1;
      while (STATE._pageCache[cachedNextPage]) {
        STATE.results = STATE.results.concat(STATE._pageCache[cachedNextPage]);
        delete STATE._pageCache[cachedNextPage];
        cachedNextPage++;
      }
      STATE._loadedPage = cachedNextPage - 1;
    } else {
      STATE.results = cached.results;
      STATE._loadedPage = 1;
      STATE._pageCache = {};
    }
    STATE.hasMore = STATE.results.length < STATE.total;
    return true;
  }
  const fetchOptions = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  var timeoutMs = append ? 5000 : 10000;
  var timeoutAbort = false;
  var timeoutController = new AbortController();
  var timeoutId = setTimeout(function() {
    timeoutAbort = true;
    timeoutController.abort();
  }, timeoutMs);
  fetchOptions.signal = timeoutController.signal;
  if (params.signal) {
    params.signal.addEventListener("abort", function() { timeoutController.abort(); });
  }
  var resp, data;
  try {
    resp = await fetch(base, fetchOptions);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    data = await resp.json();
    noteApiSuccess();
    setCachedSearchResponse(cacheKey, data);
  } catch (e) {
    clearTimeout(timeoutId);
    var cancelledByUser = params.signal && params.signal.aborted && !timeoutAbort;
    if (!cancelledByUser) noteApiFailure();
    if (timeoutAbort && (e.name === "AbortError" || e.name === "TimeoutError")) {
      throw new Error("API_TIMEOUT");
    }
    throw e;
  }
  clearTimeout(timeoutId);
  if (requestId !== searchRequestId) {
    return false;
  }
  STATE.total = data.total;
  if (append) {
    if (VSCROLL.isDraggingThumb) {
      STATE._pageCache[data.page] = data.results;
      STATE._deferredAppendWhileDragging = true;
      STATE._pendingPage = 0;
      STATE.isLoading = false;
      return true;
    }
    STATE._pageCache[data.page] = data.results;
    var nextPage = STATE._loadedPage + 1;
    var combinedNew = [];
    while (STATE._pageCache[nextPage]) {
      var pageItems = STATE._pageCache[nextPage];
      STATE.results = STATE.results.concat(pageItems);
      combinedNew = combinedNew.concat(pageItems);
      delete STATE._pageCache[nextPage];
      nextPage++;
    }
    STATE._loadedPage = nextPage - 1;
  } else {
    STATE.results = data.results;
    STATE._loadedPage = 1;
    STATE._pageCache = {};
  }
  STATE.hasMore = STATE.results.length < STATE.total;
  return true;
}

function consumeCachedAppendPage() {
  if (!STATE._pageCache[STATE.page]) return false;
  var cp = STATE.page;
  STATE.results = STATE.results.concat(STATE._pageCache[cp]);
  delete STATE._pageCache[cp];
  STATE._loadedPage = cp;
  var np = cp + 1;
  while (STATE._pageCache[np]) {
    STATE.results = STATE.results.concat(STATE._pageCache[np]);
    delete STATE._pageCache[np];
    np++;
  }
  STATE._loadedPage = np - 1;
  STATE.hasMore = STATE.results.length < STATE.total;
  STATE._pendingPage = 0;
  STATE.isLoading = false;
  ensureVirtualHeights(STATE.results.length);
  VSCROLL.renderStart = 0;
  VSCROLL.renderEnd = 0;
  requestAnimationFrame(renderVisible);
  updateStatusBar();
  updateLoadInfo();
  syncStateToURL();
  prefetchNextPage();
  return true;
}

function prefetchNextPage() {
  if (!apiAvailable) return;
  if (STATE.filterFolderSelfs.length > 0 || STATE.filterFolderSubtrees.length > 0) return;
  var nextPage = STATE._loadedPage + 1;
  var totalPages = Math.ceil(STATE.total / STATE.pageSize);
  if (nextPage > totalPages) return;
  if (STATE._pageCache[nextPage]) return;
  var reqId = searchRequestId;
  var q = STATE.query || "";
  var isRepo = !!STATE.repoFull;
  var base = isRepo ? API_BASE + "/api/search/" + STATE.repo : API_BASE + "/api/search";
  var body = {};
  if (q) body.q = q;
  body.page = nextPage;
  body.page_size = STATE.pageSize;
  if (!isRepo && STATE.filterRepos.length > 0) body.repos = STATE.filterRepos;
  if (STATE.filterExtensions.length > 0) body.extensions = STATE.filterExtensions;
  if (STATE.filterFolders.length > 0) body.folders = STATE.filterFolders;
  if (STATE.filterMinSize !== null) body.min_size = STATE.filterMinSize;
  if (STATE.filterMaxSize !== null) body.max_size = STATE.filterMaxSize;
  body.sort = STATE.sort || "relevance";
  if (!STATE.searchFolders) body.search_folders = false;
  if (STATE.exact) body.exact = true;
  var cacheKey = base + "|" + stableSearchStringify(body);
  var cached = getCachedSearchResponse(cacheKey);
  if (cached && cached.results) {
    STATE._pageCache[nextPage] = cached.results;
    return;
  }
  if (searchPrefetchAbortController) searchPrefetchAbortController.abort();
  var prefetchController = new AbortController();
  searchPrefetchAbortController = prefetchController;
  fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: prefetchController.signal,
  }).then(function(resp) {
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  }).then(function(data) {
    if (reqId !== searchRequestId) return;
    if (data && data.results) {
      noteApiSuccess();
      setCachedSearchResponse(cacheKey, data);
      STATE._pageCache[nextPage] = data.results;
    }
  }).catch(function(err) {
    if (err && err.name === "AbortError") return;
    noteApiFailure();
  }).finally(function() {
    if (searchPrefetchAbortController === prefetchController) {
      searchPrefetchAbortController = null;
    }
  });
}

async function fetchRepos() {
  if (!apiAvailable) return null;
  try {
    var resp = await fetchWithTimeout(API_BASE + "/api/repos", 5000);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var data = await resp.json();
    noteApiSuccess();
    return data;
  } catch (e) { noteApiFailure(); return null; }
}

async function fetchExtensions(repo) {
  if (!apiAvailable) return null;
  try {
    var url = repo
      ? API_BASE + "/api/extensions?repo=" + encodeURIComponent(repo)
      : API_BASE + "/api/extensions";
    var resp = await fetchWithTimeout(url, 5000);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var data = await resp.json();
    noteApiSuccess();
    return data;
  } catch (e) { noteApiFailure(); return null; }
}

async function fetchFolderTree(repo, cacheKey) {
  cacheKey = cacheKey || repo;
  if (cacheKey && folderTreeCache.has(cacheKey)) return folderTreeCache.get(cacheKey);
  if (!apiAvailable) return null;
  try {
    var resp = await fetchWithTimeout(API_BASE + "/api/folders/" + encodeURIComponent(repo), 5000);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var data = await resp.json();
    noteApiSuccess();
    if (cacheKey && data) folderTreeCache.set(cacheKey, data);
    return data;
  } catch (e) { noteApiFailure(); return null; }
}
const browserApiCache = new Map();
const browserApiPending = new Map();
const BROWSER_API_CACHE_MAX = 200;
const sidebarInitialCache = new Map();

async function fetchJsonWithTimeout(url, timeoutMs) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } finally {
    clearTimeout(timeoutId);
  }
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
    folders: (data.folders || data.d || []).map(function(item) {
      var name = item.name == null ? (item.n || "") : item.name;
      return {
        name: name,
        path: item.path || (path ? path + "/" + name : name),
        count: item.count == null ? (item.c || 0) : item.count,
      };
    }),
    files: (data.files || data.f || []).map(function(item) {
      return {
        name: item.name == null ? (item.n || "") : item.name,
        ext: item.ext == null ? (item.e || "") : item.ext,
        hasTxt: item.hasTxt == null ? !!item.t : !!item.hasTxt,
        size: item.size == null ? (item.s || "") : item.size,
        link: item.link || "",
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
        clearTimeout(timeoutId);
        browserApiPending.delete(cacheKey);
        if (data) {
          noteApiSuccess();
          setBrowserApiCache(cacheKey, data);
        }
        return data;
      })
      .catch(function(error) {
        clearTimeout(timeoutId);
        browserApiPending.delete(cacheKey);
        if (!error || error.name !== "AbortError") noteApiFailure();
        return null;
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
  try {
    var raw = await fetchJsonWithTimeout(sidebarInitialUrlForRepo(repo), 4000);
    if (!raw) return null;
    var data = normalizeSidebarPayload(raw);
    sidebarInitialCache.set(key, data);
    return data;
  } catch (e) {
    return null;
  }
}

function getCurrentExtensionCounts() {
  if (STATE.mode === "repo" && STATE.repoFull) {
    const counts = {};
    for (let i = 0; i < RECORDS.length; i++) {
      if (RECORDS[i].Repo === STATE.repoFull) {
        const ext = (RECORDS[i].Extension || "").toLowerCase();
        if (ext) counts[ext] = (counts[ext] || 0) + 1;
      }
    }
    return counts;
  }
  return extensionCounts;
}

function buildFilterFolderTree(repo) {
  if (PRECOMPUTED_FOLDER_TREES && PRECOMPUTED_FOLDER_TREES[repo]) {
    return PRECOMPUTED_FOLDER_TREES[repo];
  }
  if (!folderIndex[repo]) return [];
  const paths = Object.keys(folderIndex[repo]);
  const root = { name: repo.split("/").pop(), path: "", children: [], count: 0, isRoot: true };
  const nodeMap = { "": root };
  for (const p of paths.sort()) {
    if (!p) continue;
    const parts = p.split("/");
    for (let d = 1; d <= parts.length; d++) {
      const partial = parts.slice(0, d).join("/");
      if (nodeMap[partial]) continue;
      const parentPath = d > 1 ? parts.slice(0, d - 1).join("/") : "";
      const parent = nodeMap[parentPath];
      const node = { name: parts[d - 1], path: partial, children: [], count: 0 };
      nodeMap[partial] = node;
      if (parent) parent.children.push(node);
    }
  }
  for (const [fp, count] of Object.entries(folderIndex[repo])) {
    if (nodeMap[fp]) nodeMap[fp].count = count;
  }
  const dirMeta = {};
  for (let ri = 0; ri < RECORDS.length; ri++) {
    const rec = RECORDS[ri];
    if (rec.Repo !== repo) continue;
    const folders = Array.isArray(rec.Folder) ? rec.Folder : [];
    const dirPath = folders.join("/");
    if (!dirMeta[dirPath]) dirMeta[dirPath] = { hasDirectFiles: false };
    dirMeta[dirPath].hasDirectFiles = true;
  }
  for (const pathKey in nodeMap) {
    if (!Object.prototype.hasOwnProperty.call(nodeMap, pathKey)) continue;
    const node = nodeMap[pathKey];
    node.hasDirectFiles = !!(dirMeta[pathKey] && dirMeta[pathKey].hasDirectFiles);
    node.hasChildren = !!(node.children && node.children.length > 0);
    node.showSelfToggle = !!(node.hasDirectFiles && node.hasChildren);
  }
  return [root];
}
const folderContentsCache = new Map();
const FOLDER_CACHE_MAX = 100;

function getFolderContents(repo, path) {
  if (PRECOMPUTED_FOLDER_BROWSER && PRECOMPUTED_FOLDER_BROWSER[repo] && PRECOMPUTED_FOLDER_BROWSER[repo][path || ""]) {
    return PRECOMPUTED_FOLDER_BROWSER[repo][path || ""];
  }
  const cacheKey = repo + "|" + (path || "");
  if (folderContentsCache.has(cacheKey)) {
    const val = folderContentsCache.get(cacheKey);
    folderContentsCache.delete(cacheKey);
    folderContentsCache.set(cacheKey, val);
    return val;
  }
  const pathParts = (path || "").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const pathDepth = pathParts.length;
  const matching = RECORDS.filter(rec => {
    if (rec.Repo !== repo) return false;
    const folders = rec.Folder || [];
    if (folders.length < pathDepth) return false;
    for (let i = 0; i < pathDepth; i++) {
      if (folders[i] !== pathParts[i]) return false;
    }
    return true;
  });
  const subfolders = {};
  for (const rec of matching) {
    const folders = rec.Folder || [];
    if (folders.length > pathDepth) {
      const name = folders[pathDepth];
      subfolders[name] = (subfolders[name] || 0) + 1;
    }
  }
  const folderList = Object.entries(subfolders)
    .map(([name, count]) => ({
      name,
      path: pathParts.concat([name]).join("/"),
      count,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const fileList = matching
    .filter(rec => (rec.Folder || []).length === pathDepth)
    .map(rec => ({
      name: rec.File || "",
      ext: rec.Extension || "",
      link: getRecordLink(rec),
      path: getRecordPath(rec),
      hasTxt: rec.HasTxt || false,
      size: rec.Size || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const result = { folders: folderList, files: fileList, current_path: path };
  if (folderContentsCache.size >= FOLDER_CACHE_MAX) {
    const firstKey = folderContentsCache.keys().next().value;
    folderContentsCache.delete(firstKey);
  }
  folderContentsCache.set(cacheKey, result);
  return result;
}

function getRandom(repo) {
  if (repo) {
    const indices = repoRecordIndices[repo] || [];
    if (indices.length === 0) return null;
    return RECORDS[indices[Math.floor(Math.random() * indices.length)]];
  }
  let pool = RECORDS;
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
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
  repoList: [],
  extensionList: [],
  extensionOtherCollapsed: true,
  folderTree: null,
  folderTreeCollapsed: {},
  searchFolders: true,
  exact: true,
  useLocalMode: true,
  recordHistory: true,
  dataLoaded: false,
  resultsSkeletonActive: false,
  _pendingPage: 0,
  _loadedPage: 0,
  _pageCache: {},
  _initialActive: false,
  _deferredAppendWhileDragging: false,
};

const VSCROLL = {
  renderStart: 0,
  renderEnd: 0,
  heights: [],
  prefixHeights: [0],
  heightsDirty: true,
  heightTree: [],
  htmlCache: [],
  htmlCacheKey: "",
  estimatedHeight: 60,
  isDraggingThumb: false,
};

const $ = (sel) => document.querySelector(sel);

const DOM = {};

function cacheDOM() {
  DOM.headerTitle = $("#header-title");
  DOM.headerLogo = $("#header-logo");
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
  DOM.sidebarExpandBtn = $("#sidebar-expand-btn");
  DOM.resultsList = $("#results-list");
  DOM.resultsContainer = $("#results-container");
  DOM.resultsLoading = $("#results-loading");
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
  DOM.scrollTrack = $("#scroll-track");
  DOM.scrollThumb = $("#scroll-thumb");
  DOM.hitokoto = $("#hitokoto");
  DOM.randomBookBtn = $("#random-book-btn");
  DOM.randomTxtBtn = $("#random-txt-btn");
  DOM.overlay = $("#overlay");
  DOM.toast = $("#toast");
  DOM.filterRepoSection = $("#filter-repo-section");
  DOM.filterRepoList = $("#filter-repo-list");
  DOM.filterFolderSection = $("#filter-folder-section");
  DOM.filterFolderTree = $("#filter-folder-tree");
  DOM.filterExtList = $("#filter-ext-list");
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
  DOM.localModeToggleRow = $("#local-mode-toggle-row");
  DOM.historyToggle = $("#history-toggle");
  DOM.historyDropdown = $("#search-history-dropdown");
  DOM.multiToggleLabel = $("#multi-toggle-label");
  DOM.multiSelectToggle = $("#multi-select-toggle");
  DOM.multiActionBar = $("#multi-action-bar");
  DOM.multiCopyLinks = $("#multi-copy-links");
  DOM.multiBatchDownload = $("#multi-batch-download");
  DOM.multiSelectAll = $("#multi-select-all");
  DOM.multiSelectedCount = $("#multi-selected-count");
  DOM.multiDeselect = $("#multi-deselect");
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

function highlightText(text, query) {
  if (!query || !text) return escapeHTML(text);
  const escaped = escapeHTML(text);
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return escaped;
  let result = escaped;
  for (const tok of tokens) {
    const escapedTok = escapeHTML(tok);
    const regex = new RegExp(
      `(${escapedTok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi"
    );
    result = result.replace(regex, "<mark>$1</mark>");
  }
  return result;
}

let routeInitialized = false;
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
    const sp = new URLSearchParams();
    if (STATE.query) sp.set("q", STATE.query);
    if (mode !== "global" && folder !== undefined && folder !== null) sp.set("path", folder);
    else if (mode !== "global" && STATE.browserPath) sp.set("path", STATE.browserPath);
    if (STATE.filterExtensions.length > 0) sp.set("ext", STATE.filterExtensions.join(","));
    if (STATE.sort !== "relevance") sp.set("sort", STATE.sort);
    if (STATE.filterMinSize !== null) sp.set("min_size", fmtSizeUrl(STATE.filterMinSize));
    if (STATE.filterMaxSize !== null) sp.set("max_size", fmtSizeUrl(STATE.filterMaxSize));
    if (!STATE.searchFolders) sp.set("search_folders", "false");
    if (!STATE.exact) sp.set("exact", "0");
    if (!STATE.useLocalMode) sp.set("local", "0");
    if (!STATE.recordHistory) sp.set("history", "0");
    if (!STATE.useMirrorLinks) sp.set("mirror", "0");
    if (!STATE.leftSidebarOpen) sp.set("sidebar", "0");
    if (STATE.rightSidebarOpen) sp.set("filters", "1");
    if (DOM.leftSidebar.classList.contains("expanded-wide")) sp.set("wide", "1");
    const qs = sp.toString();
    if (qs) hash += "?" + qs;
    if (mode === "global") STATE.browserPath = "";
    window.location.hash = hash;
  },
  apply: function() {
    const route = this.parse();
    const prevMode = STATE.mode;
    const prevRepo = STATE.repo;
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
      DOM.leftSidebar.classList.remove("expanded-wide");
      if (DOM.sidebarExpandBtn) DOM.sidebarExpandBtn.textContent = "↔";
    }
    if (route.params.q !== undefined) {
      STATE.query = route.params.q;
      DOM.searchInput.value = STATE.query;
    } else if (prevMode !== STATE.mode || prevRepo !== STATE.repo) {
      STATE.query = "";
      DOM.searchInput.value = "";
    }
    if (route.params.repo) {
      STATE.filterRepos = (Array.isArray(route.params.repo) ? route.params.repo : [route.params.repo])
        .map(function(r) { return r.includes("/") ? r : "VoiceOfML/" + r; });
    } else if (prevMode !== STATE.mode || prevRepo !== STATE.repo) {
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
    } else if (prevMode !== STATE.mode || prevRepo !== STATE.repo) {
      STATE.browserPath = "";
    }
    if (STATE.mode !== "global") {
      var urlSelfs = route.params.folder_self;
      var urlSubtrees = route.params.folder_subtree;
      var legacyFolders = route.params.folder;
      urlSelfs = urlSelfs === undefined ? [] : (Array.isArray(urlSelfs) ? urlSelfs : [urlSelfs]);
      urlSubtrees = urlSubtrees === undefined ? [] : (Array.isArray(urlSubtrees) ? urlSubtrees : [urlSubtrees]);
      legacyFolders = legacyFolders === undefined ? [] : (Array.isArray(legacyFolders) ? legacyFolders : [legacyFolders]);
      urlSelfs = urlSelfs.filter(Boolean);
      urlSubtrees = urlSubtrees.filter(Boolean);
      legacyFolders = legacyFolders.filter(Boolean);
      if (urlSelfs.length || urlSubtrees.length || legacyFolders.length) {
        STATE.filterFolderSelfs = (urlSelfs.length || urlSubtrees.length) ? urlSelfs : legacyFolders.slice();
        STATE.filterFolderSubtrees = urlSubtrees;
        STATE.filterFolders = mergeFolderFilters(STATE.filterFolderSelfs, STATE.filterFolderSubtrees);
        saveStoredFolderFilters(STATE.repo);
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
    STATE.leftSidebarOpen = route.params.sidebar !== "0";
    STATE.rightSidebarOpen = route.params.filters === "1";
    updateSidebarVisibility();
    DOM.leftSidebar.classList.toggle("expanded-wide", route.params.wide === "1");
    if (DOM.sidebarExpandBtn) DOM.sidebarExpandBtn.textContent = route.params.wide === "1" ? "→" : "↔";
    this.updateUI();
    updateRandomTxtVisibility();
    if (prevMode !== STATE.mode || prevRepo !== STATE.repo) {
      this.onModeChanged();
      if (route.params.wide === "1") {
        DOM.leftSidebar.classList.add("expanded-wide");
        if (DOM.sidebarExpandBtn) DOM.sidebarExpandBtn.textContent = "→";
        syncStateToURL();
      }
    } else {
      const routeId = ++routeRenderId;
      searchWithInitialFallback();
      renderSidebarAndFiltersDeferred(routeId);
    }
    routeInitialized = true;
  },
  updateUI: function() {
    if (STATE.mode === "global") {
      DOM.headerTitle.textContent = "VoiceOfML";
      DOM.headerLogo.href = "https://huggingface.co/VoiceOfML";
      DOM.searchInput.placeholder = "搜索 VoiceOfML 数据仓库...";
      DOM.sidebarTitle.textContent = "仓库列表";
    } else {
      DOM.headerTitle.textContent = STATE.repo;
      DOM.headerLogo.href = "#/";
      DOM.searchInput.placeholder = "搜索 " + STATE.repo + "...";
      DOM.sidebarTitle.textContent = STATE.repo;
    }
  },
  onModeChanged: function() {
    if (DOM.sidebarExpandBtn) {
      DOM.sidebarExpandBtn.style.display = (STATE.mode === "repo" && !STATE.isMobile) ? "" : "none";
    }
    DOM.leftSidebar.classList.remove("expanded-wide");
    if (DOM.sidebarExpandBtn) DOM.sidebarExpandBtn.textContent = "↔";
    if (!STATE.isMobile && STATE.results.length === 0 && STATE.filterExtensions.length === 0) {
      DOM.resultsList.innerHTML = "";
      DOM.emptyState.style.display = "none";
      STATE.resultsSkeletonActive = true;
      DOM.resultsLoading.style.display = "none";
      renderResultsSkeleton();
    }
    const routeId = ++routeRenderId;
    searchWithInitialFallback();
    renderSidebarAndFiltersDeferred(routeId);
  },
};

function syncStateToURL() {
  let hash = STATE.mode === "global" ? "#/" : "#/" + STATE.repo;
  const sp = new URLSearchParams();
  if (STATE.query) sp.set("q", STATE.query);
  if (STATE.mode === "global") {
    STATE.filterRepos.forEach(function(r) {
      sp.append("repo", r.split("/").pop());
    });
  }
  if (STATE.filterExtensions.length > 0) sp.set("ext", STATE.filterExtensions.join(","));
   if (STATE.sort !== "relevance") sp.set("sort", STATE.sort);
  if (STATE.filterMinSize !== null) sp.set("min_size", STATE.filterMinSize);
  if (STATE.filterMaxSize !== null) sp.set("max_size", STATE.filterMaxSize);
  if (!STATE.searchFolders) sp.set("search_folders", "false");
  if (!STATE.exact) sp.set("exact", "0");
  if (!STATE.useLocalMode) sp.set("local", "0");
  if (!STATE.recordHistory) sp.set("history", "0");
  if (!STATE.useMirrorLinks) sp.set("mirror", "0");
  if (STATE.mode !== "global" && STATE.browserPath) sp.set("path", STATE.browserPath);
  if (!STATE.leftSidebarOpen) sp.set("sidebar", "0");
  if (STATE.rightSidebarOpen) sp.set("filters", "1");
  if (DOM.leftSidebar.classList.contains("expanded-wide")) sp.set("wide", "1");
  const qs = sp.toString();
  if (qs) hash += "?" + qs;
  if (window.location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
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
const DOWNLOAD_CHECK_TIMEOUT = 8000;
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
    const pool = STATE.repoFull ? (repoTxtRecordIndices[STATE.repoFull] || []) : txtRecordIndices;
    DOM.randomTxtBtn.style.display = pool.length > 0 ? "" : "none";
    return;
  }
  const repo = STATE.mode === "repo" && STATE.repo ? STATE.repo : "";
  const url = repo ? API_BASE + "/api/random-txt/status?repo=" + encodeURIComponent(repo) : API_BASE + "/api/random-txt/status";
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

function cloneSearchData(data) {
  if (!data || !Array.isArray(data.results)) return data;
  return {
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

function buildCurrentSearchBodyForCache(page) {
  var body = { page: page || STATE.page || 1, page_size: STATE.pageSize, sort: STATE.sort || "relevance" };
  if (STATE.query) body.q = STATE.query;
  if (STATE.mode === "global" && STATE.filterRepos.length > 0) body.repos = STATE.filterRepos;
  if (STATE.filterExtensions.length > 0) body.extensions = STATE.filterExtensions;
  if (STATE.filterFolders.length > 0) body.folders = STATE.filterFolders;
  if (STATE.filterMinSize !== null) body.min_size = STATE.filterMinSize;
  if (STATE.filterMaxSize !== null) body.max_size = STATE.filterMaxSize;
  if (!STATE.searchFolders) body.search_folders = false;
  if (STATE.exact) body.exact = true;
  return body;
}

function getCurrentSearchCacheKey(page) {
  var isRepo = !!STATE.repoFull;
  var base = isRepo ? API_BASE + "/api/search/" + STATE.repo : API_BASE + "/api/search";
  return base + "|" + stableSearchStringify(buildCurrentSearchBodyForCache(page));
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
  if (searchPrefetchAbortController) searchPrefetchAbortController.abort();
  searchAbortController = new AbortController();
  searchPrefetchAbortController = null;
  searchRequestId++;
  STATE.total = data.total || 0;
  STATE.page = 1;
  STATE.results = data.results.slice();
  STATE._initialActive = true;
  STATE._loadedPage = 1;
  STATE._pageCache = {};
  STATE._pendingPage = 0;
  STATE.hasMore = STATE.results.length < STATE.total;
  STATE.isLoading = false;
  STATE.resultsSkeletonActive = false;
  DOM.resultsLoading.style.display = "none";
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
  ensureLocalDataLoaded(false, true);
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

function searchWithInitialFallback() {
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
    DOM.resultsLoading.style.display = "none";
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
    DOM.resultsLoading.style.display = "none";
    DOM.emptyState.style.display = "none";
    setSearchVisualLoading(false);
  }
  localDataPromise = loadData().then(function(ok) {
    STATE.dataLoaded = ok;
    localDataPromise = null;
    if (ok) {
      STATE.repoList = repoList;
      STATE.extensionList = extensionList;
      updateRandomTxtVisibility();
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
        DOM.resultsLoading.style.display = "none";
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
      DOM.resultsLoading.style.display = "none";
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

function debouncedSearch() {
  if (searchComposing) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function() {
    STATE.query = DOM.searchInput.value.trim();
    STATE.page = 1;
    addHistoryItem(STATE.query);
    renderDropdown();
    doSearch();
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
  DOM.resultsList.classList.add("showing-skeleton");
}

function clearResultsSkeleton() {
  DOM.resultsList.classList.remove("showing-skeleton");
}

function doSearch(append) {
  const id = ++searchId;
  const searchStart = performance.now();
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
  DOM.resultsLoading.style.display = "none";
  setSearchVisualLoading(false);
  if (!append) {
    if (!canUseInitialSearchPayload()) STATE._initialActive = false;
    if (STATE.results.length === 0) DOM.emptyState.style.display = "none";
    selectedIndices = {};
    lastSelectedIndex = -1;
    if (DOM.multiSelectToggle && DOM.multiSelectToggle.checked) updateSelectionUI();
    if (apiAvailable && searchAbortController) searchAbortController.abort();
    if (searchPrefetchAbortController) searchPrefetchAbortController.abort();
    if (apiAvailable) searchAbortController = new AbortController();
    searchPrefetchAbortController = null;
    searchRequestId++;
    STATE._pageCache = {};
    STATE._loadedPage = 0;
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
  const shouldUseLocalSearch = !continueInitialViaApi && (STATE.useLocalMode || folderMatchMode === "mixed");
  if (shouldUseLocalSearch) {
    if (!STATE.dataLoaded) {
      if (STATE.useLocalMode && folderMatchMode !== "mixed" && apiAvailable) {
        ensureLocalDataLoaded(false, true);
      } else {
        STATE.isLoading = false;
        setSearchVisualLoading(false);
        DOM.resultsLoading.style.display = "none";
        ensureLocalDataLoaded(true, false);
        if (folderMatchMode === "mixed" && !STATE.useLocalMode) {
          showToast("正在加载目录筛选数据...");
        }
        return;
      }
    } else if (params.q && !params.exact && !shouldUseLiteralLocalSearch(params.q) && !fullTextIndexReady) {
      STATE.isLoading = false;
      setSearchVisualLoading(false);
      DOM.resultsLoading.style.display = "none";
      showToast("正在准备模糊搜索索引...");
      ensureFullTextIndex().then(function() {
        if (id === searchId) doSearch();
      }).catch(function(err) {
        console.error("Full-text index build failed:", err);
        STATE.useLocalMode = false;
        if (DOM.localModeToggle) DOM.localModeToggle.checked = false;
        syncStateToURL();
        if (id === searchId) doSearch();
      });
      return;
    } else {
      doSearchFallbackLocal(params, append, id);
      return;
    }
  }
  if (apiAvailable) {
    if (append && STATE._pendingPage === STATE.page) {
      STATE.isLoading = false;
      DOM.resultsLoading.style.display = "none";
      return;
    }
    STATE._pendingPage = STATE.page;
    if (!searchAbortController) searchAbortController = new AbortController();
    params.signal = searchAbortController.signal;
    const requestId = searchRequestId;
    doSearchAPI(params, append, requestId).then(function(applied) {
      if (!applied) return;
      if (id !== searchId) return;
      if (append) {
        ensureVirtualHeights(STATE.results.length);
        VSCROLL.renderStart = 0;
        VSCROLL.renderEnd = 0;
        requestAnimationFrame(function() { renderVisible(); });
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
          renderResults();
        }
      }
      updateStatusBar();
      updateLoadInfo();
      prefetchNextPage();
      warmConnection();
      syncStateToURL();
    }).catch(function(err) {
      if (err.message === "API_TIMEOUT") {
        console.warn("API timeout");
        return handleApiSearchFailure(append, id);
      }
      if (err.name === "AbortError") {
        if (id === searchId) {
          STATE.isLoading = false;
          DOM.resultsLoading.style.display = "none";
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
        DOM.resultsLoading.style.display = "none";
        if (!append) setSearchVisualLoading(false);
        else updateStatusBar();
      }
    });
    return;
  }
  if (!STATE.dataLoaded) {
    STATE.isLoading = false;
    DOM.resultsLoading.style.display = "none";
    setSearchVisualLoading(false);
    showToast("数据加载中，请稍后...");
    return;
  }
  doSearchFallbackLocal(params, append, id);
}

function handleApiSearchFailure(append, id) {
  if (id !== searchId) return Promise.resolve();
  if (append) {
    STATE.page = Math.max(1, STATE.page - 1);
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
    if (id !== searchId) return;
    try {
      const data = await doSearchLocal(params);
      if (id !== searchId) return;
      STATE.total = data.total;
      if (append) {
        if (VSCROLL.isDraggingThumb) {
          STATE._pageCache[params.page] = data.results;
          STATE._deferredAppendWhileDragging = true;
          STATE._pendingPage = 0;
          STATE.isLoading = false;
          return;
        }
        STATE.results = STATE.results.concat(data.results);
      } else {
        STATE.results = data.results;
      }
      STATE.hasMore = STATE.results.length < STATE.total;
      if (append) {
        ensureVirtualHeights(STATE.results.length);
        VSCROLL.renderStart = 0;
        VSCROLL.renderEnd = 0;
        requestAnimationFrame(function() { renderVisible(); });
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
          renderResults();
        }
      }
      updateStatusBar();
      updateLoadInfo();
      syncStateToURL();
    } catch (err) {
      console.error("Local fallback crashed:", err);
      if (id !== searchId) return;
      try {
        var fallbackData = doSearchLocalMain(params);
        if (id !== searchId) return;
        STATE.total = fallbackData.total;
        if (append) {
          STATE.results = STATE.results.concat(fallbackData.results);
        } else {
          STATE.results = fallbackData.results;
        }
        STATE.hasMore = STATE.results.length < STATE.total;
        if (!append) {
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
            renderResults();
          }
        }
        updateStatusBar();
        updateLoadInfo();
        syncStateToURL();
      } catch (err2) {
        showToast("搜索失败");
      }
    } finally {
      STATE.isLoading = false;
      STATE.resultsSkeletonActive = false;
      DOM.resultsLoading.style.display = "none";
      if (!append) setSearchVisualLoading(false);
      else updateStatusBar();
    }
  })();
}

function renderResults() {
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
  const cacheKey = getResultsHTMLCacheKey();
  if (VSCROLL.htmlCacheKey !== cacheKey) {
    VSCROLL.htmlCache = [];
    VSCROLL.htmlCacheKey = cacheKey;
  }
  ensureVirtualHeights(STATE.results.length);
  VSCROLL.renderStart = 0;
  VSCROLL.renderEnd = 0;
  renderVisible();
}

function buildResultHTML(rec, idx) {
  const iconType = getFileIconType(rec.Extension);
  const titleHTML = highlightText(rec.File, STATE.query);
  const repoShort = (rec.Repo || "").split("/").pop();
  const sizeStr = formatSize(rec.Size);
  const breadcrumb = (rec.Folder || []).map((f, j) => {
    const accum = (rec.Folder || []).slice(0, j + 1).join("/");
    const folderDisplay = STATE.searchFolders ? highlightText(f, STATE.query) : escapeHTML(f);
    return '<span class="path-sep">/</span><span class="path-folder" data-folder="' + escapeHTML(accum) + '" data-repo="' + repoShort + '">' + folderDisplay + '</span>';
  }).join("");
  return (
    '<input type="checkbox" class="result-checkbox" data-index="' + idx + '">' +
    '<div class="result-file-icon">' + (ICONS[iconType] || ICONS.file) + '</div>' +
    '<div class="result-info">' +
      '<div class="result-title">' + titleHTML +
        (rec.Extension ? '<span style="opacity:0.5;font-size:12px">.' + escapeHTML(rec.Extension) + '</span>' : '') +
      '</div>' +
      '<div class="result-path"><span class="path-folder" data-folder="" data-repo="' + repoShort + '">' + repoShort + '</span>' + breadcrumb + '</div>' +
      '<div class="result-meta">' +
        (STATE.mode === "global" ? '<span class="result-repo-tag" data-repo="' + repoShort + '">' + repoShort + '</span>' : '') +
        (sizeStr ? '<span class="result-size">' + sizeStr + '</span>' : '') +
      '</div>' +
    '</div>' +
    '<div class="result-actions">' +
      '<button class="result-action-btn" data-action="copy" data-link="' + escapeHTML(getCopyableLink(getRecordLink(rec))) + '">复制链接</button>' +
      '<button class="result-action-btn primary" data-action="download" data-filename="' + escapeHTML(rec.File + (rec.Extension ? '.' + rec.Extension : '')) + '" data-link="' + escapeHTML(getRecordLink(rec)) + '">下载</button>' +
      '<a href="' + escapeHTML(getPreviewLink(getRecordPath(rec))) + '" class="result-action-btn" target="_blank" rel="noopener noreferrer">仓库查看</a>' +
      (rec.HasTxt ? '<button class="result-action-btn" data-action="read" data-link="' + escapeHTML(getRecordLink(rec)) + '" data-repo="' + repoShort + '">在线阅读</button>' : '') +
    '</div>'
  );
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

function clearResultHTMLCache() {
  VSCROLL.htmlCache = [];
  VSCROLL.htmlCacheKey = getResultsHTMLCacheKey();
}

function getCachedResultHTML(rec, idx) {
  const key = getResultsHTMLCacheKey();
  if (VSCROLL.htmlCacheKey !== key) {
    VSCROLL.htmlCache = [];
    VSCROLL.htmlCacheKey = key;
  }
  if (VSCROLL.htmlCache[idx] === undefined) {
    VSCROLL.htmlCache[idx] = buildResultHTML(rec, idx);
  }
  return VSCROLL.htmlCache[idx];
}

function renderVisible() {
  const items = STATE.results;
  const len = items.length;
  if (len === 0) {
    updateScrollTrack();
    return;
  }
  const container = DOM.resultsContainer;
  const scrollTop = container.scrollTop;
  const viewH = container.clientHeight;
  const est = VSCROLL.estimatedHeight;
  const overscanItems = Math.max(10, Math.floor(viewH / (est || 60)));
  const overscanPx = overscanItems * (est || 60);
  ensurePrefixHeights();
  let start = findVirtualIndex(Math.max(0, scrollTop - overscanPx));
  let end = Math.min(len, findVirtualIndex(scrollTop + viewH + overscanPx) + 1);
  if (end - start < 10 && len > 10) end = Math.min(start + 30, len);
  if (start === VSCROLL.renderStart && end === VSCROLL.renderEnd) return;
  VSCROLL.renderStart = start;
  VSCROLL.renderEnd = end;
  const totalH = getVirtualTotalHeight();
  const topH = getVirtualOffset(start);
  let html = "";
  if (topH > 0) {
    html += '<div style="height:' + topH + 'px;flex-shrink:0"></div>';
  }
  for (let ri = start; ri < end; ri++) {
    const rec = items[ri];
    html += '<div class="result-item' + (ri % 2 === 1 ? ' is-alt' : '') + '" data-index="' + ri + '">' + getCachedResultHTML(rec, ri) + '</div>';
  }
  const bottomH = Math.max(0, totalH - getVirtualOffset(end));
  if (bottomH > 0) {
    html += '<div style="height:' + bottomH + 'px;flex-shrink:0"></div>';
  }
  var tpl = document.createElement("template");
  tpl.innerHTML = html;
  DOM.resultsList.replaceChildren(tpl.content);
  if (DOM.multiSelectToggle && DOM.multiSelectToggle.checked) updateSelectionUI();
  requestAnimationFrame(function() {
    if (measureHeights()) {
      VSCROLL.renderStart = -1;
      VSCROLL.renderEnd = -1;
      renderVisible();
      return;
    }
    updateScrollTrack();
  });
}

function ensurePrefixHeights() {
  const len = VSCROLL.heights.length;
  if (!VSCROLL.heightsDirty && VSCROLL.prefixHeights.length === len + 1 && VSCROLL.heightTree.length === len + 1) return;
  const prefix = new Array(len + 1);
  const tree = new Array(len + 1).fill(0);
  prefix[0] = 0;
  const est = VSCROLL.estimatedHeight || 60;
  for (let i = 0; i < len; i++) {
    const h = VSCROLL.heights[i] || est;
    prefix[i + 1] = prefix[i] + h;
    fenwickAdd(tree, i + 1, h);
  }
  VSCROLL.prefixHeights = prefix;
  VSCROLL.heightTree = tree;
  VSCROLL.heightsDirty = false;
}

function fenwickAdd(tree, idx, delta) {
  for (let i = idx; i < tree.length; i += i & -i) tree[i] += delta;
}

function fenwickSum(tree, idx) {
  let sum = 0;
  for (let i = idx; i > 0; i -= i & -i) sum += tree[i];
  return sum;
}

function getVirtualTotalHeight() {
  ensurePrefixHeights();
  return getVirtualOffset(VSCROLL.heights.length);
}

function getVirtualOffset(index) {
  ensurePrefixHeights();
  if (VSCROLL.heightTree.length === VSCROLL.heights.length + 1) {
    return fenwickSum(VSCROLL.heightTree, Math.max(0, Math.min(index, VSCROLL.heights.length)));
  }
  return VSCROLL.prefixHeights[index] || 0;
}

function findVirtualIndex(offset) {
  ensurePrefixHeights();
  const len = VSCROLL.heights.length;
  if (VSCROLL.heightTree.length === len + 1) {
    let idx = 0;
    let bit = 1;
    while ((bit << 1) < VSCROLL.heightTree.length) bit <<= 1;
    let sum = 0;
    for (; bit > 0; bit >>= 1) {
      const next = idx + bit;
      if (next < VSCROLL.heightTree.length && sum + VSCROLL.heightTree[next] <= offset) {
        idx = next;
        sum += VSCROLL.heightTree[next];
      }
    }
    return Math.min(Math.max(0, idx), Math.max(0, STATE.results.length - 1));
  }
  const prefix = VSCROLL.prefixHeights;
  let lo = 0;
  let hi = prefix.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (prefix[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(Math.max(0, lo), Math.max(0, STATE.results.length - 1));
}

function resetVirtualScrollState() {
  VSCROLL.renderStart = 0;
  VSCROLL.renderEnd = 0;
  VSCROLL.heights = [];
  VSCROLL.prefixHeights = [0];
  VSCROLL.heightTree = [];
  VSCROLL.heightsDirty = true;
  clearResultHTMLCache();
  updateScrollTrack();
}

function prepareRouteTransitionResults() {
  if (!DOM.resultsContainer || STATE.results.length === 0) return;
  DOM.resultsContainer.scrollTop = 0;
  VSCROLL.renderStart = -1;
  VSCROLL.renderEnd = -1;
  VSCROLL.heights = [];
  VSCROLL.prefixHeights = [0];
  VSCROLL.heightTree = [];
  VSCROLL.heightsDirty = true;
  clearResultHTMLCache();
  ensureVirtualHeights(Math.min(STATE.results.length, STATE.pageSize));
  renderVisible();
}

function ensureVirtualHeights(len) {
  if (VSCROLL.heights.length >= len) return;
  const oldLen = VSCROLL.heights.length;
  VSCROLL.heights.length = len;
  for (let i = oldLen; i < len; i++) {
    VSCROLL.heights[i] = VSCROLL.estimatedHeight;
  }
  VSCROLL.heightsDirty = true;
  if (VSCROLL.htmlCache.length < len) VSCROLL.htmlCache.length = len;
}

function measureHeights() {
  const els = DOM.resultsList.querySelectorAll(".result-item");
  let measuredSum = 0;
  let measuredCount = 0;
  let changed = false;
  for (let i = 0; i < els.length; i++) {
    const idx = parseInt(els[i].dataset.index);
    if (idx >= 0) {
      const h = els[i].getBoundingClientRect().height;
      if (h > 0) {
        measuredSum += h;
        measuredCount++;
      }
      if (h > 0 && VSCROLL.heights[idx] !== h) {
        const prev = VSCROLL.heights[idx] || VSCROLL.estimatedHeight || 60;
        VSCROLL.heights[idx] = h;
        if (!VSCROLL.heightsDirty && VSCROLL.heightTree.length === VSCROLL.heights.length + 1) {
          const delta = h - prev;
          fenwickAdd(VSCROLL.heightTree, idx + 1, delta);
          VSCROLL.prefixHeights = [0];
        } else {
          VSCROLL.heightsDirty = true;
        }
        changed = true;
      }
    }
  }
  if (measuredCount > 10) {
    const nextEstimate = measuredSum / measuredCount;
    if (Math.abs(nextEstimate - VSCROLL.estimatedHeight) > 1) {
      VSCROLL.estimatedHeight = nextEstimate;
      VSCROLL.heightsDirty = true;
      changed = true;
    }
  }
  return changed;
}

function updateStatusBar() {
  DOM.resultCount.textContent = STATE.total > 0 ? "共 " + STATE.total.toLocaleString() + " 条结果" : "";
  var has = STATE.filterRepos.length || STATE.filterExtensions.length || STATE.filterFolderSelfs.length || STATE.filterFolderSubtrees.length ||
            STATE.filterMinSize !== null || STATE.filterMaxSize !== null;
  DOM.clearFiltersBtn.style.display = has ? "" : "none";
  if (DOM.multiToggleLabel) DOM.multiToggleLabel.style.display = STATE.total > 0 ? "" : "none";
}

function setSearchVisualLoading(loading) {
  document.getElementById("search-box").classList.toggle("is-searching", loading);
  updateStatusBar();
}

function updateLoadInfo() {
  if (STATE.total === 0 && STATE.results.length === 0) {
    DOM.loadInfo.style.display = "none";
    return;
  }
  DOM.loadInfo.style.display = "";
  DOM.loadedCount.textContent = STATE.results.length.toLocaleString();
  DOM.totalCount.textContent = STATE.total.toLocaleString();
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
}

async function renderRepoList(routeId) {
  var repos = null;
  if (repoList && repoList.length > 0) {
    repos = repoList;
  } else if (apiAvailable) {
    var initial = await loadSidebarInitial(null);
    if (initial && Array.isArray(initial.repos) && initial.repos.length) {
      if (routeId && routeId !== routeRenderId) return;
      renderRepoListItems(initial.repos);
      repos = initial.repos;
    }
    var freshRepos = await fetchRepos();
    if (freshRepos && Array.isArray(freshRepos) && freshRepos.length) repos = freshRepos;
  }
  if (routeId && routeId !== routeRenderId) return;
  if (!repos || !Array.isArray(repos) || repos.length === 0) {
    DOM.sidebarContent.innerHTML = '<div class="sidebar-loading">暂无仓库</div>';
    return;
  }
  renderRepoListItems(repos);
  requestAnimationFrame(function() {
    for (var pi = 0; pi < repos.length; pi++) {
      var shortName = repos[pi].name.split("/").pop();
      if (shortName) fetchFolderContents(shortName, "").catch(function() {});
    }
  });
}

function renderBrowserListItems(list, data, currentRepo, path) {
  list.innerHTML = "";
  for (var j = 0; j < (data.folders || []).length; j++) {
    var f = data.folders[j];
    var div = document.createElement("div");
    div.className = "browser-item";
    div.innerHTML = ICONS.folder + '<span class="browser-name">' + escapeHTML(f.name) + '</span><span class="browser-count">' + (f.count || 0).toLocaleString() + '</span>';
    div.addEventListener("click", (function(fp) { return function() { renderBrowser(fp, ++routeRenderId); }; })(f.path));
    list.appendChild(div);
  }
  for (var k = 0; k < (data.files || []).length; k++) {
    var f2 = data.files[k];
    var div2 = document.createElement("div");
    div2.className = "browser-item";
    var iconType = getFileIconType(f2.ext);
    var sizeStr = formatSize(f2.size);
    var browserFileName = getBrowserFileName(f2);
    div2.innerHTML = (ICONS[iconType] || ICONS.file) +
      '<span class="browser-name">' + escapeHTML(browserFileName) + '</span>' +
      (f2.hasTxt ? '<span class="browser-action" data-read="1">阅读</span>' : '') +
      (sizeStr ? '<span class="browser-size">' + sizeStr + '</span>' : '');
    div2.addEventListener("click", function(ff, ppath) {
      return function(e) {
        if (e.target.closest(".browser-action")) {
          e.stopPropagation();
          var stem = ff.ext && ff.name && ff.name.toLowerCase().endsWith("." + ff.ext.toLowerCase())
            ? ff.name.slice(0, ff.name.lastIndexOf("."))
            : (ff.name || "");
          var txtPath_v = (ppath ? ppath + "/" : "") + stem;
          openExternalWindow(TXT_BASE + "/" + encodeURI(txtPath_v) + ".txt");
          return;
        }
        var fileLink = getBrowserFileLink(currentRepo, ppath, ff);
        if (fileLink) {
          var downloadName = getBrowserFileName(ff);
          downloadFile(downloadName, fileLink);
        }
      };
    }(f2, path || ""));
    list.appendChild(div2);
  }
}

async function renderBrowser(path, routeId) {
  if (routeId && routeId !== routeRenderId) return;
  STATE.browserPath = path;
  syncStateToURL();
  DOM.sidebarContent.innerHTML = "";
  var currentRepo = STATE.repoFull;
  const backBtn = document.createElement("div");
  backBtn.className = "back-to-global";
  backBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>返回全局搜索';
  backBtn.addEventListener("click", function() { ROUTER.navigate("global"); });
  DOM.sidebarContent.appendChild(backBtn);
  if (path) {
    const bc = document.createElement("div");
    bc.className = "sidebar-breadcrumb";
    const parts = path.split("/");
    bc.innerHTML = '<span class="crumb-item" data-path="">根目录</span>';
    for (var p = 0; p < parts.length; p++) {
      var pp = parts.slice(0, p + 1).join("/");
      bc.innerHTML += '<span class="crumb-sep">/</span>';
      bc.innerHTML += '<span class="crumb-item' + (p === parts.length - 1 ? ' current' : '') + '" data-path="' + escapeHTML(pp) + '">' + escapeHTML(parts[p]) + '</span>';
    }
    bc.querySelectorAll(".crumb-item").forEach(function(el) {
      el.addEventListener("click", function() {
        if (!el.classList.contains("current")) renderBrowser(el.dataset.path, ++routeRenderId);
      });
    });
    DOM.sidebarContent.appendChild(bc);
  }
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
  if (PRECOMPUTED_FOLDER_BROWSER && PRECOMPUTED_FOLDER_BROWSER[STATE.repoFull] && PRECOMPUTED_FOLDER_BROWSER[STATE.repoFull][path || ""]) {
    data = PRECOMPUTED_FOLDER_BROWSER[STATE.repoFull][path || ""];
  } else if (folderContentsCache.has(STATE.repoFull + "|" + (path || ""))) {
    data = getFolderContents(STATE.repoFull, path);
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
      await ensureFolderBrowserData();
      if (routeId && routeId !== routeRenderId) return;
      data = getFolderContents(STATE.repoFull, path);
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
    var folderTree = (folderTreeCache.get(folderRepoFull) || (PRECOMPUTED_FOLDER_TREES && PRECOMPUTED_FOLDER_TREES[folderRepoFull])) || null;
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
      folderTree = buildFilterFolderTree(folderRepoFull);
    }
    if (routeId && routeId !== routeRenderId) return;
    if (STATE.mode !== "repo" || STATE.repo !== folderRepo || STATE.repoFull !== folderRepoFull) return;
    STATE.folderTree = folderTree;
    if (STATE.folderTree && STATE.folderTree.length) initializeFolderTreeCollapsed(STATE.folderTree);
    renderFilterFolderTree();
  } else {
    DOM.filterFolderSection.style.display = "none";
  }
  await renderExtensionFilter(routeId);
}

async function renderRepoFilter(routeId) {
  var repos = repoList;
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
    STATE.page = 1;
    STATE.results = [];
    doSearch();
  });
}

async function renderExtensionFilter(routeId) {
  var extData = null;
  if (extensionList && extensionList.length > 0) {
    var currentCounts = getCurrentExtensionCounts();
    extData = [];
    var currentExtNames = Object.keys(currentCounts).sort();
    for (var li = 0; li < currentExtNames.length; li++) {
      var lext = currentExtNames[li];
      extData.push({ name: lext, count: currentCounts[lext] || 0 });
    }
  } else if (apiAvailable) {
    try {
      extData = await fetchExtensions(STATE.repo);
    } catch (e) {}
  }
  if (routeId && routeId !== routeRenderId) return;
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
    STATE.page = 1;
    saveStoredExtensionFilters();
    doSearch();
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
  const nodeMap = new Map();
  const collect = function(nodes) {
    for (let i = 0; i < (nodes || []).length; i++) {
      const node = nodes[i];
      if (node.path) nodeMap.set(node.path, node);
      if (node.children && node.children.length > 0) collect(node.children);
    }
  };
  collect(STATE.folderTree);
  DOM.filterFolderTree.querySelectorAll(".filter-folder-item").forEach(function(row) {
    const node = nodeMap.get(row.dataset.path || "");
    if (node) applyFolderSelectionToNode(node, row, subtreeSet, selfSet);
  });
}

function collectVisibleDescendantPaths(node, into) {
  into = into || [];
  for (let i = 0; i < (node.children || []).length; i++) {
    const child = node.children[i];
    if (!child.path) continue;
    into.push(child.path);
    if (child.children && child.children.length > 0 && !STATE.folderTreeCollapsed[child.path]) {
      collectVisibleDescendantPaths(child, into);
    }
  }
  return into;
}

function toggleFolderChildrenAnimated(childContainer, toggle, expanding) {
  if (!childContainer || !toggle) return;
  childContainer.getAnimations().forEach(function(animation) { animation.cancel(); });
  toggle.getAnimations().forEach(function(animation) { animation.cancel(); });
  const glyph = toggle.querySelector(".tree-toggle-glyph");
  if (glyph) glyph.getAnimations().forEach(function(animation) { animation.cancel(); });
  const resetChildStyles = function() {
    childContainer.style.height = "";
    childContainer.style.opacity = "";
    childContainer.style.transform = "";
    childContainer.style.overflow = "";
    childContainer.style.transition = "";
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
  if (expanding) {
    childContainer.style.display = "block";
    const targetHeight = childContainer.scrollHeight;
    childContainer.style.height = "0px";
    childContainer.style.opacity = "0";
    childContainer.style.transform = "translateY(-6px)";
    childContainer.style.overflow = "hidden";
    void childContainer.offsetHeight;
    childContainer.style.transition = "height 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms cubic-bezier(0.22, 1, 0.36, 1), transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
    childContainer.style.height = targetHeight + "px";
    childContainer.style.opacity = "1";
    childContainer.style.transform = "translateY(0)";
    childContainer._transitionCleanup = function(event) {
      if (event.target !== childContainer || event.propertyName !== "height") return;
      stopTransition();
      resetChildStyles();
      childContainer.style.display = "block";
    };
    childContainer.addEventListener("transitionend", childContainer._transitionCleanup);
    childContainer._transitionTimer = setTimeout(function() {
      if (childContainer._transitionCleanup) childContainer._transitionCleanup({ target: childContainer, propertyName: "height" });
    }, 260);
    toggle.classList.add("expanded");
    if (glyph) {
      glyph.animate([
        { transform: "rotate(-45deg)" },
        { transform: "rotate(45deg)" },
      ], {
        duration: 220,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      });
    }
    return;
  }
  childContainer.style.display = "block";
  const startHeight = childContainer.scrollHeight;
  childContainer.style.height = startHeight + "px";
  childContainer.style.opacity = "1";
  childContainer.style.transform = "translateY(0)";
  childContainer.style.overflow = "hidden";
  void childContainer.offsetHeight;
  childContainer.style.transition = "height 190ms cubic-bezier(0.22, 1, 0.36, 1), opacity 190ms cubic-bezier(0.22, 1, 0.36, 1), transform 190ms cubic-bezier(0.22, 1, 0.36, 1)";
  childContainer.style.height = "0px";
  childContainer.style.opacity = "0";
  childContainer.style.transform = "translateY(-6px)";
  childContainer._transitionCleanup = function(event) {
    if (event.target !== childContainer || event.propertyName !== "height") return;
    stopTransition();
    childContainer.style.display = "none";
    resetChildStyles();
  };
  childContainer.addEventListener("transitionend", childContainer._transitionCleanup);
  childContainer._transitionTimer = setTimeout(function() {
    if (childContainer._transitionCleanup) childContainer._transitionCleanup({ target: childContainer, propertyName: "height" });
  }, 230);
  toggle.classList.remove("expanded");
  if (glyph) {
      glyph.animate([
      { transform: "rotate(45deg)" },
      { transform: "rotate(-45deg)" },
    ], {
      duration: 190,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "forwards",
    });
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

function isNodeFullySelected(node, subtreeSet, selfSet) {
  if (!node) return false;
  if (node.isRoot) {
    const childNodes = node.children || [];
    if (childNodes.length === 0) return false;
    for (let i = 0; i < childNodes.length; i++) {
      if (!isNodeFullySelected(childNodes[i], subtreeSet, selfSet)) return false;
    }
    return true;
  }
  if (node.showSelfToggle && !selfSet.has(node.path)) return false;
  if (!node.hasChildren) {
    if (node.hasDirectFiles) return selfSet.has(node.path) || subtreeSet.has(node.path);
    return subtreeSet.has(node.path);
  }
  const childNodes = node.children || [];
  for (let i = 0; i < childNodes.length; i++) {
    if (!isNodeFullySelected(childNodes[i], subtreeSet, selfSet)) return false;
  }
  return !node.hasDirectFiles || selfSet.has(node.path);
}

function isNodePartiallySelected(node, subtreeSet, selfSet) {
  if (!node) return false;
  if (isNodeFullySelected(node, subtreeSet, selfSet)) return false;
  if (selfSet.has(node.path) || subtreeSet.has(node.path)) return true;
  const childNodes = node.children || [];
  for (let i = 0; i < childNodes.length; i++) {
    if (isNodeFullySelected(childNodes[i], subtreeSet, selfSet) || isNodePartiallySelected(childNodes[i], subtreeSet, selfSet)) {
      return true;
    }
  }
  return false;
}

function setNodeSubtreeSelection(node, enabled, subtreeSet, selfSet) {
  if (!node) return;
  if (!node.isRoot && enabled) {
    subtreeSet.add(node.path);
  }
  if (node.isRoot && !enabled) {
    subtreeSet.clear();
    selfSet.clear();
  }
  if (enabled) {
    if (node.hasDirectFiles && !node.isRoot) selfSet.add(node.path);
    const childNodes = node.children || [];
    for (let i = 0; i < childNodes.length; i++) {
      setNodeSubtreeSelection(childNodes[i], true, subtreeSet, selfSet);
    }
    return;
  }
  subtreeSet.delete(node.path);
  if (node.hasDirectFiles) selfSet.delete(node.path);
  const childNodes = node.children || [];
  for (let i = 0; i < childNodes.length; i++) {
    setNodeSubtreeSelection(childNodes[i], false, subtreeSet, selfSet);
  }
}

function persistFolderSelection(subtreeSet, selfSet) {
  STATE.filterFolderSubtrees = Array.from(subtreeSet);
  STATE.filterFolderSelfs = Array.from(selfSet);
  const merged = [];
  selfSet.forEach(function(path) { if (path) merged.push(path); });
  subtreeSet.forEach(function(path) { if (path && !merged.includes(path)) merged.push(path); });
  STATE.filterFolders = merged;
  saveStoredFolderFilters(STATE.repo);
  STATE.page = 1;
  doSearch();
}

function collectFolderNodePaths(nodes, subtreePaths, selfPaths) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node.isRoot && node.path) subtreePaths.push(node.path);
    if (!node.isRoot && node.hasDirectFiles) selfPaths.push(node.path);
    if (node.children && node.children.length > 0) {
      collectFolderNodePaths(node.children, subtreePaths, selfPaths);
    }
  }
}

function applyFolderSelectionToNode(node, row, subtreeSet, selfSet) {
  const cb = row.querySelector("input[type='checkbox']");
  if (!cb) return;
  const full = isNodeFullySelected(node, subtreeSet, selfSet);
  const partial = isNodePartiallySelected(node, subtreeSet, selfSet);
  cb.checked = full;
  cb.indeterminate = !full && partial;
  const selfBtn = row.querySelector(".folder-self-toggle");
  if (selfBtn) {
    const selfOn = selfSet.has(node.path);
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
    var collapsed = !!STATE.folderTreeCollapsed[node.path];
    row.innerHTML = (has ? ('<button type="button" class="tree-toggle' + (collapsed ? '' : ' expanded') + '" aria-label="' + (collapsed ? '展开子文件夹' : '收起子文件夹') + '" title="' + (collapsed ? '展开' : '收起') + '"><span class="tree-toggle-glyph" aria-hidden="true"></span></button>') : '<span class="tree-toggle-placeholder"></span>') +
      '<input type="checkbox" value="' + escapeHTML(node.path) + '">' +
      '<span class="folder-name" title="' + escapeHTML(node.name) + '">' + escapeHTML(node.name) + '</span>' +
      (node.showSelfToggle ? '<button type="button" class="folder-self-toggle" data-path="' + escapeHTML(node.path) + '">本层文件</button>' : '') +
      '<span class="folder-count">' + (node.count || 0).toLocaleString() + '</span>';
    const toggle = row.querySelector(".tree-toggle");
    const cb = row.querySelector("input[type='checkbox']");
    const selfBtn = row.querySelector(".folder-self-toggle");
    applyFolderSelectionToNode(node, row, subtreeSet, selfSet);
    cb.addEventListener("change", function() {
      handleFolderCheckboxChange(node);
    });
    if (selfBtn) {
      selfBtn.addEventListener("click", function(e) {
        e.preventDefault();
        e.stopPropagation();
        handleFolderSelfToggle(node);
      });
    }
    container.appendChild(row);
    if (has) {
      const childDiv = document.createElement("div");
      childDiv.className = "tree-children";
      if (collapsed) childDiv.style.display = "none";
      renderFilterTreeNodes(childDiv, node.children, depth + 1);
      toggle.addEventListener("click", function(currentNode) {
        return function(e) {
          e.stopPropagation();
          const expanding = !!STATE.folderTreeCollapsed[currentNode.path];
          STATE.folderTreeCollapsed[currentNode.path] = !expanding;
          toggleFolderChildrenAnimated(childDiv, toggle, expanding);
        };
      }(node));
      container.appendChild(childDiv);
    }
  }
}

function handleFolderCheckboxChange(node) {
  const subtreeSet = getFolderSubtreeSet();
  const selfSet = getFolderSelfSet();
  const full = isNodeFullySelected(node, subtreeSet, selfSet);
  setNodeSubtreeSelection(node, !full, subtreeSet, selfSet);
  persistFolderSelection(subtreeSet, selfSet);
  refreshFilterFolderSelectionState();
}

function handleFolderSelfToggle(node) {
  const subtreeSet = getFolderSubtreeSet();
  const selfSet = getFolderSelfSet();
  if (selfSet.has(node.path)) selfSet.delete(node.path);
  else selfSet.add(node.path);
  persistFolderSelection(subtreeSet, selfSet);
  refreshFilterFolderSelectionState();
}

function fetchHitokoto() {
  fetch("https://vomebook-hitokoto.hf.space/")
    .then(function(resp) { return resp.json(); })
    .then(function(data) {
      const text = data.hitokoto || data.text || data.content || data.sentence || "";
      if (text) typewriter(DOM.hitokoto, text);
    })
    .catch(function() { DOM.hitokoto.textContent = ""; });
}

function typewriter(el, text, speed) {
  speed = speed || 60;
  el.style.opacity = "0";
  el.textContent = "";
  setTimeout(function() {
    el.style.transition = "opacity 0.5s ease";
    el.style.opacity = "0.55";
  }, 100);
  let i = 0;
  const t = setInterval(function() {
    el.textContent = text.slice(0, i + 1);
    i++;
    if (i >= text.length) clearInterval(t);
  }, speed);
}

function randomBook() {
  showToast("正在随机下载...");
  if (STATE.dataLoaded) {
    var localRec = getRandom(STATE.repoFull);
    if (localRec) {
      var localFilename = (localRec.File || "file") + (localRec.Extension ? "." + localRec.Extension : "");
      downloadFile(localFilename, getRecordLink(localRec), { skipCheck: true });
    } else {
      showToast("暂无可用记录");
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
        showToast("暂无可用记录");
      }
    })
    .catch(function() {
      function fallback() {
        var rec = getRandom(STATE.repoFull);
        if (rec) {
          var filename = (rec.File || "file") + (rec.Extension ? "." + rec.Extension : "");
          downloadFile(filename, getRecordLink(rec), { skipCheck: true });
        } else {
          showToast("暂无可用记录");
        }
      }
      if (STATE.dataLoaded) fallback();
      else ensureLocalDataLoaded(false, true).then(fallback).catch(function() { showToast("暂无可用记录"); });
    });
}

function openTxtRecord(rec, popup) {
  if (!rec) return false;
  var relPath = buildRecordRelativePath(rec);
  var stem = relPath.indexOf(".") >= 0 ? relPath.substring(0, relPath.lastIndexOf(".")) : relPath;
  if (!stem) return false;
  const url = TXT_BASE + "/" + encodeURI(stem) + ".txt";
  if (popup) popup.location.replace(url);
  else openExternalWindow(url);
  return true;
}

function getRandomTxtLocal() {
  var repo = STATE.repoFull;
  var pool = repo ? (repoTxtRecordIndices[repo] || []) : txtRecordIndices;
  if (pool.length === 0) return null;
  return RECORDS[pool[Math.floor(Math.random() * pool.length)]];
}

function randomTxt() {
  showToast("正在随机打开文章...");
  var popup = openPendingWindow();
  if (STATE.dataLoaded) {
    var localRec = getRandomTxtLocal();
    if (!openTxtRecord(localRec, popup)) {
      if (popup) popup.close();
      showToast("暂无可读文章");
    }
    return;
  }
  var url = STATE.repoFull
    ? API_BASE + "/api/random-txt?repo=" + encodeURIComponent(STATE.repo)
    : API_BASE + "/api/random-txt";
  fetch(url).then(function(resp) {
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  }).then(function(rec) {
    if (!openTxtRecord(rec, popup)) throw new Error("NO_TXT");
  }).catch(function() {
    function fallback() {
      var rec = getRandomTxtLocal();
      if (!openTxtRecord(rec, popup)) {
        if (popup) popup.close();
        showToast("暂无可读文章");
      }
    }
    if (STATE.dataLoaded) fallback();
    else ensureLocalDataLoaded(false, true).then(fallback).catch(function() {
      if (popup) popup.close();
      showToast("暂无可读文章");
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

function maybeLoadNextPage() {
  if (VSCROLL.isDraggingThumb) return;
  if (STATE.isLoading || !STATE.hasMore) return;
  const scrollTop = DOM.resultsContainer.scrollTop;
  const loadedHeight = DOM.resultsList.scrollHeight;
  const triggerPoint = loadedHeight * 0.05;
  if (scrollTop >= triggerPoint) {
    STATE.page++;
    doSearch(true);
  }
}

function recoverScrollState() {
  scrollRecoveryTimer = null;
  scrollTicking = false;
  if (scrollLoadTimer) {
    clearTimeout(scrollLoadTimer);
    scrollLoadTimer = null;
  }
  VSCROLL.isDraggingThumb = false;
  if (DOM.scrollThumb) DOM.scrollThumb.classList.remove("dragging");
  if (STATE._deferredAppendWhileDragging) {
    STATE._deferredAppendWhileDragging = false;
    if (consumeCachedAppendPage()) return;
  }
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
    if (STATE._deferredAppendWhileDragging) {
      STATE._deferredAppendWhileDragging = false;
      if (consumeCachedAppendPage()) return;
    }
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
  DOM.resultsContainer.addEventListener("scroll", () => {
    updateScrollTrack();
    if (!scrollTicking) {
      requestAnimationFrame(() => {
        renderVisible();
        updateScrollThumb();
        maybeLoadNextPage();
        scrollTicking = false;
      });
      scrollTicking = true;
    }
    if (VSCROLL.isDraggingThumb) scheduleScrollLoad(120);
  }, { passive: true });
}

function updateScrollThumb() {
  const scrollTop = DOM.resultsContainer.scrollTop;
  const scrollHeight = DOM.resultsContainer.scrollHeight;
  const clientHeight = DOM.resultsContainer.clientHeight;
  if (scrollHeight <= clientHeight || !DOM.scrollTrack.clientHeight) { DOM.scrollTrack.classList.remove("visible"); return; }
  DOM.scrollTrack.classList.add("visible");
  const trackHeight = DOM.scrollTrack.clientHeight;
  const th = Math.max(40, Math.min(trackHeight, (clientHeight / scrollHeight) * trackHeight));
  const tt = (scrollTop / Math.max(1, scrollHeight - clientHeight)) * (trackHeight - th);
  DOM.scrollThumb.style.height = th + "px";
  DOM.scrollThumb.style.transform = "translateY(" + tt + "px)";
}

function setupQuickScroll() {
  let dragging = false, startY, startST;
  let dragTicking = false;
  function setResultScrollTop(value) {
    DOM.resultsContainer.scrollTop = value;
    if (!dragTicking) {
      dragTicking = true;
      requestAnimationFrame(function() {
        updateScrollThumb();
        dragTicking = false;
      });
    }
  }
  function onMouseMove(e) {
    const delta = e.clientY - startY;
    const dragRange = Math.max(1, DOM.scrollTrack.clientHeight - DOM.scrollThumb.clientHeight);
    const ratio = delta / dragRange;
    const scrollEl = DOM.resultsContainer;
    setResultScrollTop(startST + ratio * Math.max(1, scrollEl.scrollHeight - scrollEl.clientHeight));
  }
  function onMouseUp() {
    dragging = false;
    VSCROLL.isDraggingThumb = false;
    DOM.scrollThumb.classList.remove("dragging");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    if (STATE._deferredAppendWhileDragging) {
      STATE._deferredAppendWhileDragging = false;
      if (consumeCachedAppendPage()) return;
    }
    maybeLoadNextPage();
  }
  DOM.scrollThumb.addEventListener("mousedown", (e) => {
    dragging = true; VSCROLL.isDraggingThumb = true; DOM.scrollThumb.classList.add("dragging"); startY = e.clientY; startST = DOM.resultsContainer.scrollTop; e.preventDefault(); e.stopPropagation();
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
  function onTouchMove(e) {
    e.preventDefault();
    const delta = e.touches[0].clientY - startY;
    const dragRange = Math.max(1, DOM.scrollTrack.clientHeight - DOM.scrollThumb.clientHeight);
    const ratio = delta / dragRange;
    const scrollEl = DOM.resultsContainer;
    setResultScrollTop(startST + ratio * Math.max(1, scrollEl.scrollHeight - scrollEl.clientHeight));
  }
  function onTouchEnd() {
    dragging = false;
    VSCROLL.isDraggingThumb = false;
    DOM.scrollThumb.classList.remove("dragging");
    document.removeEventListener("touchmove", onTouchMove);
    document.removeEventListener("touchend", onTouchEnd);
    document.removeEventListener("touchcancel", onTouchEnd);
    if (STATE._deferredAppendWhileDragging) {
      STATE._deferredAppendWhileDragging = false;
      if (consumeCachedAppendPage()) return;
    }
    maybeLoadNextPage();
  }
  DOM.scrollThumb.addEventListener("touchstart", (e) => {
    dragging = true; VSCROLL.isDraggingThumb = true; DOM.scrollThumb.classList.add("dragging"); startY = e.touches[0].clientY; startST = DOM.resultsContainer.scrollTop; e.stopPropagation();
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd);
    document.addEventListener("touchcancel", onTouchEnd);
  });
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
  if (DOM.sidebarExpandBtn) DOM.sidebarExpandBtn.style.display = (STATE.mode === "repo" && !STATE.isMobile) ? "" : "none";
  updateSelectionUI();
  requestAnimationFrame(updateScrollTrack);
}

function autoDetectMobile() { return window.innerWidth <= 768; }

function toggleLeftSidebar() {
  STATE.leftSidebarOpen = !STATE.leftSidebarOpen;
  if (!STATE.leftSidebarOpen) {
    DOM.leftSidebar.classList.remove("expanded-wide");
    DOM.sidebarExpandBtn.textContent = "↔";
  }
  syncStateToURL();
  if (STATE.isMobile && STATE.leftSidebarOpen && STATE.rightSidebarOpen) STATE.rightSidebarOpen = false;
  updateSidebarVisibility();
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
  const viewTop = DOM.resultsContainer.scrollTop;
  const viewBottom = viewTop + DOM.resultsContainer.clientHeight;
  if (top < viewTop || bottom > viewBottom) {
    DOM.resultsContainer.scrollTop = top;
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
    const tag = document.activeElement.tagName;
    const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
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
        DOM.searchInput.value = "";
        STATE.query = "";
        STATE.page = 1;
        STATE.results = [];
        doSearch();
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
      if (STATE.results.length === 0) return;
      e.preventDefault();
      if (e.key === "ArrowDown") focusKeyboardResult(keyboardResultIndex < 0 ? 0 : keyboardResultIndex + 1);
      else focusKeyboardResult(keyboardResultIndex < 0 ? 0 : keyboardResultIndex - 1);
      return;
    }
    if (e.key === "Enter") {
      if (isInput && document.activeElement === DOM.searchInput) {
        e.preventDefault();
        STATE.query = DOM.searchInput.value.trim();
        STATE.page = 1;
        STATE.results = [];
        keyboardResultIndex = -1;
        addHistoryItem(STATE.query);
        doSearch();
        DOM.searchInput.blur();
        return;
      }
      if (keyboardResultIndex >= 0 && keyboardResultIndex < STATE.results.length) {
        const rec = STATE.results[keyboardResultIndex];
        if (rec) openExternalWindow(getRecordLink(rec));
        return;
      }
    }
  });
  DOM.searchInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      STATE.query = DOM.searchInput.value.trim();
      STATE.page = 1;
      STATE.results = [];
      keyboardResultIndex = -1;
      addHistoryItem(STATE.query);
      doSearch();
      DOM.searchInput.blur();
    }
  });
}

function clearAllFilters() {
  STATE.filterRepos = [];
  STATE.filterExtensions = [];
  STATE.filterFolders = [];
  STATE.filterFolderSubtrees = [];
  STATE.filterFolderSelfs = [];
  saveStoredFolderFilters(STATE.repo);
  saveStoredExtensionFilters();
  STATE.filterMinSize = null;
  STATE.filterMaxSize = null;
  STATE.page = 1;
  STATE.results = [];
  DOM.filterMinSize.value = "";
  DOM.filterMaxSize.value = "";
  renderFilters();
  doSearch();
  showToast("已清空所有筛选条件");
  syncStateToURL();
}

function setupResultDelegation() {
  DOM.resultsList.addEventListener("click", function(e) {
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
        downloadFile(actionBtn.dataset.filename || "file", actionBtn.dataset.link || "");
        return;
      }
      if (action === "read") {
        const link = actionBtn.dataset.link;
        const repoShort = actionBtn.dataset.repo || STATE.repo;
        const prefix = "https://huggingface.co/datasets/VoiceOfML/" + repoShort + "/resolve/main/";
        let relPath = "";
        if (link.indexOf(prefix) === 0) {
          relPath = decodeURIComponent(link.substring(prefix.length));
        }
        let stem = relPath;
        if (stem.indexOf(".") >= 0) {
          const lastDot = stem.lastIndexOf(".");
          const slashAfterDot = stem.indexOf("/", lastDot);
          if (slashAfterDot === -1) stem = stem.substring(0, lastDot);
        }
        openExternalWindow(TXT_BASE + "/" + encodeURI(stem) + ".txt");
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
        const sp = new URLSearchParams();
        if (STATE.query) sp.set("q", STATE.query);
        if (STATE.sort !== "relevance") sp.set("sort", STATE.sort);
        if (STATE.filterMinSize !== null) sp.set("min_size", fmtSizeUrl(STATE.filterMinSize));
        if (STATE.filterMaxSize !== null) sp.set("max_size", fmtSizeUrl(STATE.filterMaxSize));
        if (STATE.filterExtensions.length > 0) sp.set("ext", STATE.filterExtensions.join(","));
        if (!STATE.searchFolders) sp.set("search_folders", "false");
        if (!STATE.exact) sp.set("exact", "0");
        if (!STATE.useLocalMode) sp.set("local", "0");
        if (!STATE.recordHistory) sp.set("history", "0");
        if (!STATE.useMirrorLinks) sp.set("mirror", "0");
        if (!STATE.leftSidebarOpen) sp.set("sidebar", "0");
        if (STATE.rightSidebarOpen) sp.set("filters", "1");
        if (DOM.leftSidebar.classList.contains("expanded-wide")) sp.set("wide", "1");
        if (folder) sp.append("folder_self", folder);
        const qs = sp.toString();
        window.location.hash = qs ? hash + "?" + qs : hash;
      } else if (folder !== undefined) {
        STATE.filterFolders = folder ? [folder] : [];
        STATE.filterFolderSubtrees = [];
        STATE.filterFolderSelfs = folder ? [folder] : [];
        saveStoredFolderFilters(STATE.repo);
        STATE.page = 1;
        STATE.results = [];
        renderFilters();
        doSearch();
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

function init() {
  cacheDOM();
  STATE.isDark = localStorage.getItem("theme") !== "light";
  applyTheme();
  const savedMobile = localStorage.getItem("mobileMode");
  if (savedMobile === "mobile") STATE.isMobile = true;
  else if (savedMobile === "desktop") STATE.isMobile = false;
  else STATE.isMobile = autoDetectMobile();
  applyMobileMode();
  DOM.searchInput.addEventListener("input", debouncedSearch);
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
      DOM.searchInput.value = item.dataset.query;
      STATE.query = item.dataset.query;
      STATE.page = 1;
      STATE.results = [];
      doSearch();
      hideDropdown();
      DOM.searchInput.blur();
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
    clearResultHTMLCache();
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
      for (var si = lo; si <= hi; si++) selectedIndices[si] = true;
    } else if (cb.checked) {
      selectedIndices[idx] = true;
    } else {
      delete selectedIndices[idx];
    }
    lastSelectedIndex = idx;
    updateSelectionUI();
  });
  var getSelectedLinks = function(copyable) {
    var links = [];
    var indices = Object.keys(selectedIndices).map(Number);
    for (var li = 0; li < indices.length; li++) {
      var rec = STATE.results[indices[li]];
      if (rec) {
        var link = getRecordLink(rec);
        links.push(copyable ? getCopyableLink(link) : link);
      }
    }
    return links;
  };
  var getSelectedFilenames = function() {
    var names = [];
    var indices = Object.keys(selectedIndices).map(Number);
    for (var ni = 0; ni < indices.length; ni++) {
      var rec = STATE.results[indices[ni]];
      if (rec) names.push(rec.File + (rec.Extension ? "." + rec.Extension : ""));
    }
    return names;
  };
  if (DOM.multiCopyLinks) DOM.multiCopyLinks.addEventListener("click", function() {
    var links = getSelectedLinks(true);
    if (links.length === 0) { showToast("未选中任何文件"); return; }
    navigator.clipboard.writeText(links.join("\n")).then(function() {
      showToast("已复制 " + links.length + " 条链接");
    }).catch(function() { showToast("复制失败"); });
  });
  if (DOM.multiBatchDownload) DOM.multiBatchDownload.addEventListener("click", function() {
    var links = getSelectedLinks(false);
    var names = getSelectedFilenames();
    if (links.length === 0) { showToast("未选中任何文件"); return; }
    for (var bi = 0; bi < links.length; bi++) {
      setTimeout(function(name, link) { downloadFile(name, link); }, bi * 300, names[bi], links[bi]);
    }
    showToast("正在下载 " + links.length + " 个文件");
  });
  if (DOM.multiDeselect) DOM.multiDeselect.addEventListener("click", function() {
    selectedIndices = {};
    lastSelectedIndex = -1;
    updateSelectionUI();
  });
  if (DOM.multiSelectAll) DOM.multiSelectAll.addEventListener("click", function() {
    for (var si = 0; si < STATE.results.length; si++) selectedIndices[si] = true;
    lastSelectedIndex = STATE.results.length > 0 ? STATE.results.length - 1 : -1;
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
    DOM.sidebarExpandBtn.textContent = DOM.leftSidebar.classList.contains("expanded-wide") ? "→" : "↔";
    syncStateToURL();
  });
  DOM.themeBtn.addEventListener("click", toggleTheme);
  DOM.mobileToggleBtn.addEventListener("click", toggleMobile);
  DOM.clearFiltersBtn.addEventListener("click", clearAllFilters);
  DOM.searchFoldersToggle.addEventListener("change", function() {
    STATE.searchFolders = DOM.searchFoldersToggle.checked;
    clearResultHTMLCache();
    STATE.page = 1;
    STATE.results = [];
    doSearch();
  });
  DOM.exactSearchToggle.addEventListener("change", function() {
    STATE.exact = DOM.exactSearchToggle.checked;
    STATE.page = 1;
    STATE.results = [];
    doSearch();
  });
  DOM.localModeToggle.addEventListener("change", function() {
    if (!STATE.dataLoaded && DOM.localModeToggle.checked) {
      STATE.useLocalMode = true;
      setExactSearchSectionVisible(false, true);
      STATE.page = 1;
      STATE.results = [];
      DOM.resultsList.innerHTML = "";
      DOM.emptyState.style.display = "none";
      updateStatusBar();
      updateLoadInfo();
      syncStateToURL();
      ensureLocalDataLoaded(true, false);
      return;
    }
    STATE.useLocalMode = DOM.localModeToggle.checked;
    setExactSearchSectionVisible(!STATE.useLocalMode, true);
    if (DOM.exactSearchToggle) DOM.exactSearchToggle.checked = STATE.exact;
    STATE.page = 1;
    STATE.results = [];
    doSearch();
    syncStateToURL();
  });
  DOM.sortSelect.addEventListener("change", function() {
    STATE.sort = DOM.sortSelect.value;
    STATE.page = 1;
    STATE.results = [];
    doSearch();
    syncStateToURL();
  });
  DOM.overlay.addEventListener("click", function() {
    STATE.leftSidebarOpen = false;
    STATE.rightSidebarOpen = false;
    updateSidebarVisibility();
    syncStateToURL();
  });
  DOM.randomBookBtn.addEventListener("click", randomBook);
  if (DOM.randomTxtBtn) DOM.randomTxtBtn.addEventListener("click", randomTxt);
  DOM.emptyRandomBtn.addEventListener("click", randomBook);
  var sizeTimer_local;
  var sizeInputToBytes = function(input, unitSelect) {
    var val = parseFloat(input.value);
    if (isNaN(val) || val < 0) return null;
    var unit = unitSelect.value;
    if (unit === "KB") val *= 1024;
    else if (unit === "MB") val *= 1048576;
    else if (unit === "GB") val *= 1073741824;
    return Math.round(val);
  };
  var applySizeFilter = function() {
    clearTimeout(sizeTimer_local);
    sizeTimer_local = setTimeout(function() {
      STATE.filterMinSize = sizeInputToBytes(DOM.filterMinSize, DOM.filterMinUnit);
      STATE.filterMaxSize = sizeInputToBytes(DOM.filterMaxSize, DOM.filterMaxUnit);
      STATE.page = 1;
      STATE.results = [];
      doSearch();
    }, 500);
  };
  DOM.filterMinSize.addEventListener("input", applySizeFilter);
  DOM.filterMaxSize.addEventListener("input", applySizeFilter);
  DOM.filterMinUnit.addEventListener("change", applySizeFilter);
  DOM.filterMaxUnit.addEventListener("change", applySizeFilter);
  DOM.extSelectAll.addEventListener("click", function() {
    STATE.filterExtensions = STATE.extensionList.slice();
    STATE.page = 1;
    saveStoredExtensionFilters();
    renderExtensionFilter();
    doSearch();
  });
  DOM.extDeselectAll.addEventListener("click", function() {
    var allExtNames = STATE.extensionList.slice();
    var currentSet = new Set(STATE.filterExtensions);
    STATE.filterExtensions = allExtNames.filter(function(e) { return !currentSet.has(e); });
    STATE.page = 1;
    saveStoredExtensionFilters();
    renderExtensionFilter();
    doSearch();
  });
  DOM.folderSelectAll.addEventListener("click", function() {
    if (!STATE.folderTree || STATE.folderTree.length === 0) return;
    var subtreeSet = new Set();
    var selfSet = new Set();
    for (var i = 0; i < STATE.folderTree.length; i++) {
      setNodeSubtreeSelection(STATE.folderTree[i], true, subtreeSet, selfSet);
    }
    persistFolderSelection(subtreeSet, selfSet);
    renderFilterFolderTree();
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
    for (var i = 0; i < allSubtreePaths.length; i++) {
      if (!subtreeSet.has(allSubtreePaths[i])) nextSubtreeSet.add(allSubtreePaths[i]);
    }
    for (var j = 0; j < allSelfPaths.length; j++) {
      if (!selfSet.has(allSelfPaths[j])) nextSelfSet.add(allSelfPaths[j]);
    }
    persistFolderSelection(nextSubtreeSet, nextSelfSet);
    renderFilterFolderTree();
  });
  setupVirtualScroll();
  setupQuickScroll();
  setupKeyboard();
  setupResultDelegation();
  window.addEventListener("hashchange", function() {
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
  window.addEventListener("online", function() { warmConnection(true); });
  lastKeepaliveAt = Date.now();
  window.setInterval(function() { warmConnection(); }, KEEPALIVE_INTERVAL_MS);
  ROUTER.apply();
  fetchHitokoto();
  setInterval(fetchHitokoto, 30000);
}
document.addEventListener("DOMContentLoaded", init);

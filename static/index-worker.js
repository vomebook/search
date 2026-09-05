const WORKER_PROTOCOL_VERSION = 1;
const MAX_PAGE_SIZE = 500;
const SORT_PRECOMPUTE_DELAY_MS = 1000;

let records = [];
let recordIds = [];
let metadata = emptyMetadata();
let generation = 0;
let wordIndex = null;
let wordIndexFilesOnly = null;
let vocabSorted = [];
let vocabSortedFilesOnly = [];
let recordIndices = [];
let repoRecordIndices = {};
let txtRecordIndices = [];
let repoTxtRecordIndices = {};
let readerRecordIndices = [];
let repoReaderRecordIndices = {};
let sortedByName = [];
let sortedBySize = [];
let repoSortedByName = {};
let repoSortedBySize = {};
let nameOrderReady = false;
let sizeOrderReady = false;
let sortBuildTimer = null;

function emptyMetadata() {
  return { count: 0, repos: [], extensions: [], extensionsByRepo: {}, txt: { available: false, count: 0, byRepo: {} }, reader: { available: false, count: 0, byRepo: {} } };
}

function tokenize(text) {
  const tokens = [];
  const lower = String(text || "").toLowerCase();
  const alpha = lower.match(/[a-z0-9]+/g);
  if (alpha) tokens.push.apply(tokens, alpha);
  const chineseRuns = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || [];
  for (const run of chineseRuns) {
    for (const ch of run) tokens.push(ch);
    for (let i = 0; i < run.length - 1; i++) tokens.push(run[i] + run[i + 1]);
  }
  return Array.from(new Set(tokens));
}

function editDistance(s1, s2, maxDist) {
  if (Math.abs(s1.length - s2.length) > maxDist) return 999;
  let prev = Array.from({ length: s2.length + 1 }, (_, i) => i);
  for (let i = 0; i < s1.length; i++) {
    const curr = [i + 1];
    let rowMin = curr[0];
    for (let j = 0; j < s2.length; j++) {
      const value = Math.min(prev[j + 1] + 1, curr[j] + 1, prev[j] + (s1[i] === s2[j] ? 0 : 1));
      curr.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDist) return 999;
    prev = curr;
  }
  return prev[prev.length - 1];
}

function isChineseToken(token) {
  return /^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(token);
}

function couldBeFuzzy(token, word, maxDist) {
  if (isChineseToken(token) && token.length > 1 && token.length !== word.length) return false;
  if (Math.abs(token.length - word.length) > maxDist) return false;
  if (token.length < 4) return true;
  const counts = {};
  for (const ch of token) counts[ch] = (counts[ch] || 0) + 1;
  let diff = 0;
  for (const ch of word) {
    if (counts[ch] > 0) counts[ch] -= 1;
    else {
      diff += 1;
      if (diff > 2 * maxDist) return false;
    }
  }
  for (const ch of Object.keys(counts)) {
    diff += counts[ch];
    if (diff > 2 * maxDist) return false;
  }
  return true;
}

function wildcardPatternToRegExp(pattern) {
  const escaped = String(pattern || "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\*/g, ".*").replace(/\?/g, "."), "i");
}

function literalSearch(query) {
  return /[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf\s]/i.test(String(query || ""));
}

function decodeSearchPayload(data) {
  if (!data || typeof data !== "object") throw protocolError("INVALID_CORPUS", "Search corpus must be an object");
  if (data.v !== 2 || !Array.isArray(data.rp) || !Array.isArray(data.fd) || !Array.isArray(data.rc)) {
    throw protocolError("UNSUPPORTED_CORPUS", "Expected compact-v2 search corpus");
  }
  return data.rc.map((item) => {
    if (!Array.isArray(item) || item.length < 6) {
      return { Repo: "", File: "", Extension: "", Folder: [], Size: "", HasTxt: false };
    }
    return {
      Repo: Number.isInteger(item[0]) && data.rp[item[0]] !== undefined ? data.rp[item[0]] : "",
      File: item[1] || "",
      Extension: item[2] || "",
      Folder: Number.isInteger(item[3]) && Array.isArray(data.fd[item[3]]) ? data.fd[item[3]] : [],
      Size: item[4] === undefined ? "" : item[4],
      HasTxt: !!item[5],
    };
  });
}

async function fetchGzipJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw protocolError("CORPUS_FETCH_FAILED", "HTTP " + response.status);
  if (!response.body || typeof DecompressionStream === "undefined") {
    throw protocolError("GZIP_UNAVAILABLE", "Streaming gzip decompression is unavailable");
  }
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

function stableRecordId(record, occurrence) {
  const path = (record.Folder || []).concat([record.File || "", record.Extension || ""]).join("/");
  return [record.Repo || "", path, String(occurrence)].join("\u001f");
}

function compareRecordName(a, b) {
  return String(records[a].File || "").localeCompare(String(records[b].File || ""), "zh");
}

function compareRecordSize(a, b) {
  return (Number(records[b].Size) || 0) - (Number(records[a].Size) || 0);
}

function buildNameOrders() {
  if (nameOrderReady) return;
  sortedByName = recordIndices.slice().sort(compareRecordName);
  repoSortedByName = {};
  for (const repo of Object.keys(repoRecordIndices)) repoSortedByName[repo] = [];
  for (const index of sortedByName) repoSortedByName[records[index].Repo].push(index);
  nameOrderReady = true;
}

function buildSizeOrders() {
  if (sizeOrderReady) return;
  sortedBySize = recordIndices.slice().sort(compareRecordSize);
  repoSortedBySize = {};
  for (const repo of Object.keys(repoRecordIndices)) repoSortedBySize[repo] = [];
  for (const index of sortedBySize) repoSortedBySize[records[index].Repo].push(index);
  sizeOrderReady = true;
}

function scheduleSortOrders(expectedGeneration) {
  if (typeof setTimeout !== "function") return;
  sortBuildTimer = setTimeout(() => {
    if (generation === expectedGeneration) {
      buildNameOrders();
      buildSizeOrders();
    }
    sortBuildTimer = null;
  }, SORT_PRECOMPUTE_DELAY_MS);
}

function replaceCorpus(nextRecords) {
  if (sortBuildTimer !== null && typeof clearTimeout === "function") clearTimeout(sortBuildTimer);
  records = nextRecords;
  const repoCounts = {};
  const extensionCounts = {};
  const extensionsByRepo = {};
  const txtByRepo = {};
  const readerByRepo = {};
  const idOccurrences = {};
  let txtCount = 0;
  recordIds = new Array(records.length);
  recordIndices = new Array(records.length);
  repoRecordIndices = {};
  txtRecordIndices = [];
  repoTxtRecordIndices = {};
  readerRecordIndices = [];
  repoReaderRecordIndices = {};
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const repo = record.Repo || "";
    recordIndices[i] = i;
    if (!repoRecordIndices[repo]) repoRecordIndices[repo] = [];
    repoRecordIndices[repo].push(i);
    const extension = String(record.Extension || "").toLowerCase();
    repoCounts[repo] = (repoCounts[repo] || 0) + 1;
    if (extension) {
      extensionCounts[extension] = (extensionCounts[extension] || 0) + 1;
      if (!extensionsByRepo[repo]) extensionsByRepo[repo] = {};
      extensionsByRepo[repo][extension] = (extensionsByRepo[repo][extension] || 0) + 1;
    }
    if (record.HasTxt) {
      txtCount++;
      txtByRepo[repo] = (txtByRepo[repo] || 0) + 1;
      txtRecordIndices.push(i);
      if (!repoTxtRecordIndices[repo]) repoTxtRecordIndices[repo] = [];
      repoTxtRecordIndices[repo].push(i);
    }
    if (["pdf", "epub", "html", "htm", "txt", "md", "markdown", "jpg", "jpeg", "png", "gif", "bmp", "webp", "mp3", "mp4", "wav", "m4a", "flac", "mov", "mpga"].indexOf(extension) >= 0) {
      readerRecordIndices.push(i);
      readerByRepo[repo] = (readerByRepo[repo] || 0) + 1;
      if (!repoReaderRecordIndices[repo]) repoReaderRecordIndices[repo] = [];
      repoReaderRecordIndices[repo].push(i);
    }
    const base = [repo, (record.Folder || []).join("/"), record.File || "", record.Extension || ""].join("\u001f");
    const occurrence = idOccurrences[base] || 0;
    idOccurrences[base] = occurrence + 1;
    recordIds[i] = stableRecordId(record, occurrence);
  }
  metadata = {
    count: records.length,
    repos: Object.keys(repoCounts).map((name) => ({ name, count: repoCounts[name] })).sort((a, b) => a.name.localeCompare(b.name)),
    extensions: Object.keys(extensionCounts).sort().map((name) => ({ name, count: extensionCounts[name] })),
    extensionsByRepo: {},
    txt: { available: txtCount > 0, count: txtCount, byRepo: txtByRepo },
    reader: { available: readerRecordIndices.length > 0, count: readerRecordIndices.length, byRepo: readerByRepo },
  };
  for (const repo of Object.keys(extensionsByRepo)) {
    metadata.extensionsByRepo[repo] = Object.keys(extensionsByRepo[repo]).sort().map((name) => ({ name, count: extensionsByRepo[repo][name] }));
  }
  wordIndex = null;
  wordIndexFilesOnly = null;
  vocabSorted = [];
  vocabSortedFilesOnly = [];
  sortedByName = [];
  sortedBySize = [];
  repoSortedByName = {};
  repoSortedBySize = {};
  nameOrderReady = false;
  sizeOrderReady = false;
  sortBuildTimer = null;
  generation++;
  scheduleSortOrders(generation);
  return Object.assign({ state: "corpus-ready", generation }, metadata);
}

function buildFulltext() {
  if (wordIndex) return;
  wordIndex = {};
  wordIndexFilesOnly = {};
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const folders = Array.isArray(record.Folder) ? record.Folder : [];
    for (const token of tokenize([record.File || ""].concat(folders).join(" "))) {
      if (!wordIndex[token]) wordIndex[token] = [];
      wordIndex[token].push(i);
    }
    for (const token of tokenize(record.File || "")) {
      if (!wordIndexFilesOnly[token]) wordIndexFilesOnly[token] = [];
      wordIndexFilesOnly[token].push(i);
    }
  }
  vocabSorted = Object.keys(wordIndex).map((token) => [token, wordIndex[token].length]).sort((a, b) => b[1] - a[1]);
  vocabSortedFilesOnly = Object.keys(wordIndexFilesOnly).map((token) => [token, wordIndexFilesOnly[token].length]).sort((a, b) => b[1] - a[1]);
}

function applyFilters(indices, params) {
  const repos = params.repos || null;
  const extensions = params.extensions || null;
  const folders = params.folders || null;
  const selfFolders = new Set((params.folderSelfs || []).map(cleanPath).filter((path) => typeof path === "string"));
  const subtreeFolders = new Set((params.folderSubtrees || []).map(cleanPath).filter((path) => typeof path === "string"));
  return indices.filter((index) => {
    const record = records[index] || {};
    if (repos && repos.length && !repos.includes(record.Repo)) return false;
    if (extensions && extensions.length && !extensions.includes(String(record.Extension || "").toLowerCase())) return false;
    const recordFolders = Array.isArray(record.Folder) ? record.Folder : [];
    const folderPath = recordFolders.join("/");
    if (params.folderMatchMode === "mixed") {
      let matched = selfFolders.has(folderPath);
      for (let depth = 1; !matched && depth <= recordFolders.length; depth++) matched = subtreeFolders.has(recordFolders.slice(0, depth).join("/"));
      if ((selfFolders.size || subtreeFolders.size) && !matched) return false;
    } else if (folders && folders.length) {
      let matched = false;
      for (const folder of folders) {
        const clean = cleanPath(folder);
        if (params.folderMatchMode === "exact") matched = folderPath === clean;
        else if (!clean) matched = recordFolders.length === 0;
        else matched = folderPath === clean || folderPath.indexOf(clean + "/") === 0;
        if (matched) break;
      }
      if (!matched) return false;
    }
    if (typeof record.Size === "number" && record.Size > 0) {
      if (params.minSize !== null && record.Size < params.minSize) return false;
      if (params.maxSize !== null && record.Size > params.maxSize) return false;
    }
    return true;
  });
}

function cleanPath(path) {
  return String(path || "").replace(/^\/+|\/+$/g, "");
}

function emptySearchOrder(params) {
  const repos = params.repos || [];
  if (repos.length > 1) return null;
  if ((params.extensions && params.extensions.length)
      || (params.folders && params.folders.length)
      || (params.folderSelfs && params.folderSelfs.length)
      || (params.folderSubtrees && params.folderSubtrees.length)
      || params.minSize != null
      || params.maxSize != null) return null;
  const repo = repos.length === 1 ? repos[0] : null;
  if (params.sort === "name") buildNameOrders();
  else if (params.sort === "size") buildSizeOrders();
  if (repo) {
    if (params.sort === "name") return repoSortedByName[repo] || [];
    if (params.sort === "size") return repoSortedBySize[repo] || [];
    return repoRecordIndices[repo] || [];
  }
  if (params.sort === "name") return sortedByName;
  if (params.sort === "size") return sortedBySize;
  return recordIndices;
}

function pageResult(indices, params) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(params.pageSize) || 100));
  const pageIndices = indices.slice((page - 1) * pageSize, page * pageSize);
  return {
    records: pageIndices.map((index) => records[index]),
    ids: pageIndices.map((index) => recordIds[index]),
    total: indices.length,
    page,
    pageSize,
    generation,
  };
}

function searchLocal(params) {
  const query = String(params.q || "").trim();
  const searchFolders = params.searchFolders !== false;
  let matched = [];
  if (!query) {
    const order = emptySearchOrder(params);
    if (order !== null) return pageResult(order, params);
    matched = recordIndices.slice();
  } else if (params.exact || literalSearch(query)) {
    const wildcard = query.includes("*") || query.includes("?");
    const pattern = wildcard ? wildcardPatternToRegExp(query) : null;
    const lower = query.toLowerCase();
    for (let i = 0; i < records.length; i++) {
      const record = records[i] || {};
      const file = String(record.File || "").toLowerCase();
      const repo = String(record.Repo || "").toLowerCase();
      const folder = (record.Folder || []).join("/").toLowerCase();
      if (pattern ? pattern.test(file) || pattern.test(repo) || (searchFolders && pattern.test(folder)) : file.includes(lower) || repo.includes(lower) || (searchFolders && folder.includes(lower))) matched.push(i);
    }
  } else {
    buildFulltext();
    const activeIndex = searchFolders ? wordIndex : wordIndexFilesOnly;
    const activeVocab = searchFolders ? vocabSorted : vocabSortedFilesOnly;
    let tokenMatches = null;
    for (const token of tokenize(query)) {
      let candidates = activeIndex[token] || [];
      if (!candidates.length) {
        const fuzzy = [];
        for (const entry of activeVocab) {
          const vocab = entry[0];
          if (couldBeFuzzy(token, vocab, 2) && editDistance(token, vocab, 2) <= 2) fuzzy.push.apply(fuzzy, activeIndex[vocab] || []);
          if (fuzzy.length >= 200) break;
        }
        candidates = Array.from(new Set(fuzzy));
      }
      const candidateSet = new Set(candidates);
      tokenMatches = tokenMatches === null ? candidates.slice() : tokenMatches.filter((index) => candidateSet.has(index));
      if (!tokenMatches.length) break;
    }
    matched = tokenMatches || [];
  }
  const tokens = tokenize(query);
  const scored = applyFilters(matched, params).map((index) => {
    const record = records[index] || {};
    const file = String(record.File || "").toLowerCase();
    const repo = String(record.Repo || "").toLowerCase();
    const folder = (record.Folder || []).join("/").toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (file.includes(token)) score += 3;
      if (searchFolders && folder.includes(token)) score += 2;
      if (repo.includes(token)) score += 1;
    }
    return { index, score };
  });
  if (params.sort === "name") scored.sort((a, b) => String(records[a.index].File || "").localeCompare(String(records[b.index].File || ""), "zh"));
  else if (params.sort === "size") scored.sort((a, b) => (Number(records[b.index].Size) || 0) - (Number(records[a.index].Size) || 0));
  else if (query) scored.sort((a, b) => b.score - a.score);
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(params.pageSize) || 100));
  const pageItems = scored.slice((page - 1) * pageSize, page * pageSize);
  return {
    records: pageItems.map((item) => records[item.index]),
    ids: pageItems.map((item) => recordIds[item.index]),
    total: scored.length,
    page,
    pageSize,
    generation,
  };
}

function randomRecord(params) {
  const repo = params.repo || "";
  const txtOnly = !!params.txtOnly;
  const readerOnly = !!params.readerOnly;
  let candidates;
  if (readerOnly) candidates = repo ? (repoReaderRecordIndices[repo] || []) : readerRecordIndices;
  else if (txtOnly) candidates = repo ? (repoTxtRecordIndices[repo] || []) : txtRecordIndices;
  else if (repo) candidates = repoRecordIndices[repo] || [];
  else candidates = recordIndices;
  if (!candidates.length) return { record: null, id: null, generation };
  const randomValue = typeof params.randomValue === "number" ? params.randomValue : Math.random();
  const index = candidates[Math.min(candidates.length - 1, Math.floor(Math.max(0, randomValue) * candidates.length))];
  return { record: records[index], id: recordIds[index], generation };
}

function folderContents(params) {
  const repo = params.repo || "";
  const path = cleanPath(params.path);
  const parts = path ? path.split("/") : [];
  const folders = {};
  const files = [];
  for (const record of records) {
    if (record.Repo !== repo) continue;
    const recordFolders = record.Folder || [];
    if (recordFolders.length < parts.length || parts.some((part, index) => recordFolders[index] !== part)) continue;
    if (recordFolders.length > parts.length) {
      const name = recordFolders[parts.length];
      folders[name] = (folders[name] || 0) + 1;
    } else {
      files.push({ name: record.File || "", ext: record.Extension || "", hasTxt: !!record.HasTxt, size: record.Size || "" });
    }
  }
  return {
    folders: Object.keys(folders).sort().map((name) => ({ name, path: parts.concat([name]).join("/"), count: folders[name] })),
    files: files.sort((a, b) => a.name.localeCompare(b.name)),
    current_path: path,
    generation,
  };
}

function folderTree(params) {
  const repo = params.repo || "";
  const root = { name: repo.split("/").pop(), path: "", children: [], count: 0, isRoot: true, hasDirectFiles: false };
  const nodes = { "": root };
  for (const record of records) {
    if (record.Repo !== repo) continue;
    root.count++;
    const folders = record.Folder || [];
    let path = "";
    for (const name of folders) {
      const parent = nodes[path];
      path = path ? path + "/" + name : name;
      if (!nodes[path]) {
        nodes[path] = { name, path, children: [], count: 0, hasDirectFiles: false };
        parent.children.push(nodes[path]);
      }
      nodes[path].count++;
    }
    nodes[path].hasDirectFiles = true;
  }
  for (const path of Object.keys(nodes)) {
    const node = nodes[path];
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.hasChildren = node.children.length > 0;
    node.showSelfToggle = !!(node.path && node.hasDirectFiles && node.hasChildren);
  }
  return { tree: root.count ? [root] : [], generation };
}

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function dispatch(type, payload) {
  if (type === "handshake") return { protocol: WORKER_PROTOCOL_VERSION };
  if (type === "load-corpus") return replaceCorpus(decodeSearchPayload(await fetchGzipJSON(payload.url)));
  if (type === "replace-corpus") return replaceCorpus(decodeSearchPayload(payload.data));
  if (!records.length) throw protocolError("CORPUS_NOT_READY", "Search corpus is not ready");
  if (type === "metadata") return Object.assign({ generation }, metadata);
  if (type === "local-search") return searchLocal(payload || {});
  if (type === "random-record") return randomRecord(payload || {});
  if (type === "folder-contents") return folderContents(payload || {});
  if (type === "folder-tree") return folderTree(payload || {});
  throw protocolError("UNKNOWN_REQUEST", "Unknown Worker request: " + type);
}

self.addEventListener("message", async function(event) {
  const message = event.data || {};
  const id = message.id;
  if (message.protocol !== WORKER_PROTOCOL_VERSION) {
    self.postMessage({ protocol: WORKER_PROTOCOL_VERSION, type: "response", id, ok: false, error: { code: "PROTOCOL_MISMATCH", message: "Refresh required: app/Worker protocol mismatch" } });
    return;
  }
  try {
    const result = await dispatch(message.type, message.payload || {});
    self.postMessage({ protocol: WORKER_PROTOCOL_VERSION, type: "response", id, ok: true, result });
  } catch (error) {
    self.postMessage({
      protocol: WORKER_PROTOCOL_VERSION,
      type: "response",
      id,
      ok: false,
      error: { code: error && error.code || "WORKER_ERROR", message: String(error && error.message || error) },
    });
  }
});

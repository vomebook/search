const WORKER_PROTOCOL_VERSION = 1;
const MAX_PAGE_SIZE = 500;
const SORT_PRECOMPUTE_DELAY_MS = 1000;
// Bump when matching, filtering, collation or public record semantics change.
const SEARCH_SEMANTICS_VERSION = "worker-search-v2";
let snapshotGeneration = null;

let records = [];
let recordIds = [];
let recordSearchFields = new WeakMap();
let metadata = emptyMetadata();
let generation = 0;
const corpusInstance = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let wordIndex = null;
let wordIndexFilesOnly = null;
let vocabSorted = [];
let vocabSortedFilesOnly = [];
const searchOrderCache = new Map();
const SEARCH_ORDER_CACHE_MAX = 8;
let searchAnchorOwners = new WeakMap();
const searchAnchorCache = new Map();
const SEARCH_ANCHOR_ORDER_MAX = 8;
const SEARCH_ANCHOR_PER_ORDER_MAX = 8;
const SEARCH_ANCHOR_KEY_MAX = 4096;
let recordIndices = [];
let repoRecordIndices = Object.create(null);
let txtRecordIndices = [];
let repoTxtRecordIndices = Object.create(null);
let readerRecordIndices = [];
let repoReaderRecordIndices = Object.create(null);
let sortedByName = [];
let sortedBySize = [];
let repoSortedByName = Object.create(null);
let repoSortedBySize = Object.create(null);
let nameOrderReady = false;
let sizeOrderReady = false;
let sortBuildTimer = null;
let fulltextBuildTimer = null;
let fulltextBuild = null;
const searchJobs = new Map();
let indexYieldChannel = null;
const indexYieldQueue = [];
const FULLTEXT_BATCH_RECORDS = 256;
const FULLTEXT_BATCH_MS = 8;
const FULLTEXT_FOLDER_CACHE_MAX = 64;
const FULLTEXT_FOLDER_CACHE_UNITS = 65536;
const directoryIndexes = new Map();
const DIRECTORY_INDEX_MAX = 4;
const recordNameCollator = new Intl.Collator("zh");

function emptyMetadata() {
  return { count: 0, repos: [], extensions: [], extensionsByRepo: {}, txt: { available: false, count: 0, byRepo: {} }, reader: { available: false, count: 0, byRepo: {} } };
}

function tokenizeParts(text) {
  const chinese = [];
  const lower = String(text || "").toLowerCase();
  const alpha = lower.match(/[a-z0-9]+/g) || [];
  const chineseRuns = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || [];
  for (const run of chineseRuns) {
    for (const ch of run) chinese.push(ch);
    for (let i = 0; i < run.length - 1; i++) chinese.push(run[i] + run[i + 1]);
  }
  return {alpha, chinese};
}

function tokenize(text) {
  const parts = tokenizeParts(text);
  return Array.from(new Set(parts.alpha.concat(parts.chinese)));
}

function getRecordSearchFields(record) {
  let fields = recordSearchFields.get(record);
  if (fields) return fields;
  fields = {
    file: String(record.File || "").toLowerCase(),
    repo: String(record.Repo || "").toLowerCase(),
    folder: (record.Folder || []).join("/").toLowerCase(),
  };
  recordSearchFields.set(record, fields);
  return fields;
}

function folderTokenParts(build, text) {
  const cached = build.folderTokens.get(text);
  if (cached) {
    build.folderTokens.delete(text);
    build.folderTokens.set(text, cached);
    return cached.parts;
  }
  const parts = tokenizeParts(text);
  const units = text.length + parts.alpha.concat(parts.chinese).reduce((sum, token) => sum + token.length, 0);
  if (units <= FULLTEXT_FOLDER_CACHE_UNITS) {
    while (build.folderTokens.size >= FULLTEXT_FOLDER_CACHE_MAX || build.folderUnits + units > FULLTEXT_FOLDER_CACHE_UNITS) {
      const key = build.folderTokens.keys().next().value;
      build.folderUnits -= build.folderTokens.get(key).units;
      build.folderTokens.delete(key);
    }
    build.folderTokens.set(text, {parts, units});
    build.folderUnits += units;
  }
  return parts;
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
  const counts = Object.create(null);
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

function compileWildcardMatcher(pattern) {
  const tokens = String(pattern || "").replace(/\*+/g, "*").split("");
  const literals = tokens.map(char => char === "*" || char === "?" ? null
    : new RegExp("^" + char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"));
  const required = Array.from(new Set(tokens.filter(char => char !== "*" && char !== "?")))
    .map(char => new RegExp(char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const masks = new Map();
  function literalMask(char) {
    let mask = masks.get(char);
    if (!mask) {
      mask = literals.map(regex => regex && regex.test(char));
      if (masks.size >= 512) masks.clear();
      masks.set(char, mask);
    }
    return mask;
  }
  return { test(text) {
    // Reject fields missing a mandatory literal before allocating DP rows.
    for (const regex of required) if (!regex.test(text)) return false;
    // Substring glob matching in O(pattern length * text length), without
    // backtracking. Iterate UTF-16 units to retain the former non-u regex rules.
    let previous = new Uint8Array(tokens.length + 1);
    let current = new Uint8Array(tokens.length + 1);
    previous[0] = 1;
    for (let j = 0; j < tokens.length && tokens[j] === "*"; j++) previous[j + 1] = 1;
    if (previous[tokens.length]) return true;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const dot = char !== "\n" && char !== "\r" && char !== "\u2028" && char !== "\u2029";
      const mask = literalMask(char);
      current[0] = 1;
      for (let j = 0; j < tokens.length; j++) {
        if (tokens[j] === "*") {
          current[j + 1] = current[j] || (dot && previous[j + 1]);
        } else {
          current[j + 1] = previous[j] && (tokens[j] === "?" ? dot : mask[j]);
        }
      }
      if (current[tokens.length]) return true;
      [previous, current] = [current, previous];
    }
    return false;
  }};
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
  return new Response(stream).text();
}

async function corpusFingerprint(source) {
  if (typeof crypto === "undefined" || !crypto.subtle || typeof TextEncoder === "undefined") return null;
  const bytes = new TextEncoder().encode(source || "");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  // Browser upgrades may change ICU collation; only reuse within that runtime.
  const runtime = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const versionHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SEARCH_SEMANTICS_VERSION + runtime));
  const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
  return "worker:" + hex(versionHash) + ":" + hex(hash);
}

async function installCorpus(data, fingerprint) {
  if (fingerprint == null) fingerprint = await corpusFingerprint(JSON.stringify(data));
  const result = replaceCorpus(decodeSearchPayload(data));
  data = null;
  snapshotGeneration = fingerprint;
  return result;
}

async function installCorpusFromSource(source) {
  const fingerprint = await corpusFingerprint(source);
  const data = JSON.parse(source);
  source = null;
  const result = await installCorpus(data, fingerprint);
  return result;
}

function stableRecordId(record, occurrence) {
  const path = (record.Folder || []).concat([record.File || "", record.Extension || ""]).join("/");
  return [record.Repo || "", path, String(occurrence)].join("\u001f");
}

function compareRecordName(a, b) {
  return recordNameCollator.compare(String(records[a].File || ""), String(records[b].File || ""));
}

function compareRecordSize(a, b) {
  return (Number(records[b].Size) || 0) - (Number(records[a].Size) || 0);
}

function buildNameOrders() {
  if (nameOrderReady) return;
  sortedByName = recordIndices.slice().sort(compareRecordName);
  repoSortedByName = Object.create(null);
  for (const repo of Object.keys(repoRecordIndices)) repoSortedByName[repo] = [];
  for (const index of sortedByName) repoSortedByName[records[index].Repo].push(index);
  nameOrderReady = true;
}

function buildSizeOrders() {
  if (sizeOrderReady) return;
  sortedBySize = recordIndices.slice().sort(compareRecordSize);
  repoSortedBySize = Object.create(null);
  for (const repo of Object.keys(repoRecordIndices)) repoSortedBySize[repo] = [];
  for (const index of sortedBySize) repoSortedBySize[records[index].Repo].push(index);
  sizeOrderReady = true;
}

function scheduleSortOrders(expectedGeneration) {
  if (typeof setTimeout !== "function") return;
  sortBuildTimer = setTimeout(() => {
    sortBuildTimer = null;
    if (generation === expectedGeneration) {
      if (searchJobs.size) { scheduleSortOrders(expectedGeneration); return; }
      buildNameOrders();
      buildSizeOrders();
    }
  }, SORT_PRECOMPUTE_DELAY_MS);
}

function replaceCorpus(nextRecords) {
  snapshotGeneration = null;
  if (sortBuildTimer !== null && typeof clearTimeout === "function") clearTimeout(sortBuildTimer);
  if (fulltextBuildTimer !== null && typeof clearTimeout === "function") clearTimeout(fulltextBuildTimer);
  fulltextBuildTimer = null;
  fulltextBuild = null;
  directoryIndexes.clear();
  searchOrderCache.clear();
  searchAnchorOwners = new WeakMap();
  searchAnchorCache.clear();
  recordSearchFields = new WeakMap();
  records = nextRecords;
  const repoCounts = Object.create(null);
  const extensionCounts = Object.create(null);
  const extensionsByRepo = Object.create(null);
  const txtByRepo = Object.create(null);
  const readerByRepo = Object.create(null);
  const idOccurrences = Object.create(null);
  let txtCount = 0;
  recordIds = new Array(records.length);
  recordIndices = new Array(records.length);
  repoRecordIndices = Object.create(null);
  txtRecordIndices = [];
  repoTxtRecordIndices = Object.create(null);
  readerRecordIndices = [];
  repoReaderRecordIndices = Object.create(null);
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
      if (!extensionsByRepo[repo]) extensionsByRepo[repo] = Object.create(null);
      extensionsByRepo[repo][extension] = (extensionsByRepo[repo][extension] || 0) + 1;
    }
    if (record.HasTxt) {
      txtCount++;
      txtByRepo[repo] = (txtByRepo[repo] || 0) + 1;
      txtRecordIndices.push(i);
      if (!repoTxtRecordIndices[repo]) repoTxtRecordIndices[repo] = [];
      repoTxtRecordIndices[repo].push(i);
    }
    if (["pdf", "epub", "mobi", "azw", "azw3", "fb2", "fbz", "html", "htm", "txt", "md", "markdown", "jpg", "jpeg", "png", "gif", "bmp", "webp", "mp3", "mp4", "wav", "m4a", "flac", "mov", "mpga"].indexOf(extension) >= 0) {
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
    extensionsByRepo: Object.create(null),
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
  repoSortedByName = Object.create(null);
  repoSortedBySize = Object.create(null);
  nameOrderReady = false;
  sizeOrderReady = false;
  sortBuildTimer = null;
  generation++;
  scheduleSortOrders(generation);
  scheduleFulltext(generation, 1500);
  return Object.assign({ state: "corpus-ready", generation }, metadata);
}

function advanceFulltext(limit, deadline) {
  if (!fulltextBuild) fulltextBuild = { next: 0, all: Object.create(null), files: Object.create(null), folderTokens: new Map(), folderUnits: 0 };
  const build = fulltextBuild;
  const end = Math.min(records.length, build.next + limit);
  while (build.next < end) {
    const i = build.next++;
    const record = records[i];
    const folders = Array.isArray(record.Folder) ? record.Folder : [];
    const fileParts = tokenizeParts(record.File || "");
    const folderParts = folderTokenParts(build, folders.join(" "));
    // Preserve the original all-field alpha-before-Chinese insertion order.
    const allTokens = new Set(fileParts.alpha.concat(folderParts.alpha, fileParts.chinese, folderParts.chinese));
    for (const token of allTokens) {
      if (!build.all[token]) build.all[token] = [];
      build.all[token].push(i);
    }
    for (const token of new Set(fileParts.alpha.concat(fileParts.chinese))) {
      if (!build.files[token]) build.files[token] = [];
      build.files[token].push(i);
    }
    if (Date.now() >= deadline) break;
  }
  if (build.next < records.length) return;
  // Stable frequency buckets preserve the old descending stable sort, including
  // tie order used by fuzzy candidates, while allowing vocabulary work to yield.
  if (!build.allVocab) build.allVocab = createVocabularyBuild(build.all);
  if (!advanceVocabulary(build.allVocab, deadline)) return;
  if (!build.filesVocab) build.filesVocab = createVocabularyBuild(build.files);
  if (!advanceVocabulary(build.filesVocab, deadline)) return;
  // Publish only complete indexes. Foreground searches finish this same builder.
  wordIndex = build.all;
  wordIndexFilesOnly = build.files;
  vocabSorted = build.allVocab.output;
  vocabSortedFilesOnly = build.filesVocab.output;
  fulltextBuild = null;
}

function createVocabularyBuild(index) {
  return { index, keys: Object.keys(index), next: 0, groups: new Map(), counts: null,
    group: 0, item: 0, output: [] };
}

function advanceVocabulary(build, deadline) {
  let remaining = deadline === Infinity ? Infinity : 4096;
  while (build.next < build.keys.length) {
    if (remaining-- <= 0 || Date.now() >= deadline) return false;
    const token = build.keys[build.next++];
    const count = build.index[token].length;
    if (!build.groups.has(count)) build.groups.set(count, []);
    build.groups.get(count).push([token, count]);
  }
  if (!build.counts) build.counts = Array.from(build.groups.keys()).sort((a, b) => b - a);
  while (build.group < build.counts.length) {
    const group = build.groups.get(build.counts[build.group]);
    while (build.item < group.length) {
      if (remaining-- <= 0 || Date.now() >= deadline) return false;
      build.output.push(group[build.item++]);
    }
    build.group++;
    build.item = 0;
  }
  return true;
}

function scheduleFulltext(expectedGeneration, delay) {
  if (typeof setTimeout !== "function" || wordIndex) return;
  // Keep lazy construction on devices that explicitly report little memory.
  if (typeof navigator !== "undefined" && navigator.deviceMemory <= 2) return;
  fulltextBuildTimer = setTimeout(() => {
    if (generation !== expectedGeneration) return;
    fulltextBuildTimer = null;
    if (wordIndex) return;
    try {
      advanceFulltext(FULLTEXT_BATCH_RECORDS, Date.now() + FULLTEXT_BATCH_MS);
    } catch (_) {
      // Speculative work must not terminate the Worker. A demanded search can
      // retry construction and report a normal correlated protocol error.
      fulltextBuild = null;
      return;
    }
    if (!wordIndex) scheduleFulltext(expectedGeneration, 4);
  }, delay);
}

function buildFulltext() {
  if (wordIndex) return;
  if (fulltextBuildTimer !== null && typeof clearTimeout === "function") clearTimeout(fulltextBuildTimer);
  fulltextBuildTimer = null;
  advanceFulltext(records.length, Infinity);
}

function yieldSearchIndex() {
  if (typeof MessageChannel === "undefined") return new Promise(resolve => typeof setTimeout === "function" ? setTimeout(resolve, 0) : resolve());
  if (!indexYieldChannel) {
    indexYieldChannel = new MessageChannel();
    indexYieldChannel.port1.onmessage = () => indexYieldQueue.shift()?.();
  }
  // A message task permits cancellation without the nested-timer 4 ms clamp.
  return new Promise(resolve => { indexYieldQueue.push(resolve); indexYieldChannel.port2.postMessage(null); });
}

async function prepareSearchIndex(params, job) {
  const query = String(params.q || "").trim();
  if (wordIndex || !query || params.exact || literalSearch(query)) return;
  if (fulltextBuildTimer !== null && typeof clearTimeout === "function") clearTimeout(fulltextBuildTimer);
  fulltextBuildTimer = null;
  try {
    while (!wordIndex) {
      if (job.cancelled) throw protocolError("SEARCH_CANCELLED", "Search cancelled");
      if (job.generation !== generation) throw protocolError("CORPUS_REPLACED", "Search corpus changed");
      advanceFulltext(FULLTEXT_BATCH_RECORDS, Date.now() + FULLTEXT_BATCH_MS);
      if (!wordIndex) await yieldSearchIndex();
    }
    if (job.cancelled) throw protocolError("SEARCH_CANCELLED", "Search cancelled");
    if (job.generation !== generation) throw protocolError("CORPUS_REPLACED", "Search corpus changed");
  } finally {
    if (!wordIndex && job.generation === generation && !fulltextBuildTimer && searchJobs.size <= 1) scheduleFulltext(generation, 4);
  }
}

function buildFilterSets(params) {
  const repos = params.repos || null;
  const extensions = params.extensions || null;
  return {
    repoSet: repos && repos.length ? new Set(repos) : null,
    extensionSet: extensions && extensions.length
      ? new Set(extensions.map((extension) => String(extension || "").toLowerCase()))
      : null,
    folders: params.folders && params.folders.length
      ? params.folders.map(cleanPath)
      : null,
    selfFolders: new Set((params.folderSelfs || []).map(cleanPath).filter((path) => typeof path === "string")),
    subtreeFolders: new Set((params.folderSubtrees || []).map(cleanPath).filter((path) => typeof path === "string")),
  };
}

function matchesFolderFilters(recordFolders, folderPath, params, filters) {
  if (params.folderMatchMode === "mixed") {
    let matched = filters.selfFolders.has(folderPath);
    for (let depth = 1; !matched && depth <= recordFolders.length; depth++)
      matched = filters.subtreeFolders.has(recordFolders.slice(0, depth).join("/"));
    return !(filters.selfFolders.size || filters.subtreeFolders.size) || matched;
  }
  if (!filters.folders?.length) return true;
  for (const folder of filters.folders) {
    if (params.folderMatchMode === "exact" && folderPath === folder) return true;
    if (params.folderMatchMode !== "exact" && (!folder
        ? recordFolders.length === 0
        : folderPath === folder || folderPath.indexOf(folder + "/") === 0)) return true;
  }
  return false;
}

function applyFilters(indices, params) {
  const filters = buildFilterSets(params);
  return indices.filter((index) => {
    const record = records[index] || {};
    if (filters.repoSet && !filters.repoSet.has(record.Repo)) return false;
    if (filters.extensionSet && !filters.extensionSet.has(String(record.Extension || "").toLowerCase())) return false;
    const recordFolders = Array.isArray(record.Folder) ? record.Folder : [];
    const folderPath = recordFolders.join("/");
    if (!matchesFolderFilters(recordFolders, folderPath, params, filters)) return false;
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

function intersectCandidateLists(candidateLists, sorted = false) {
  if (!candidateLists.length) return [];
  if (sorted) {
    if (candidateLists.length === 1) return candidateLists[0].slice();
    const lists = candidateLists.slice().sort((a, b) => a.length - b.length);
    const matched = [];
    for (const index of lists[0]) {
      let found = true;
      for (let i = 1; i < lists.length; i++) {
        const list = lists[i];
        let low = 0, high = list.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (list[middle] < index) low = middle + 1;
          else high = middle;
        }
        if (list[low] !== index) { found = false; break; }
      }
      if (found) matched.push(index);
    }
    return matched;
  }
  const ordered = candidateLists[0];
  let probe = ordered;
  for (const candidates of candidateLists) if (candidates.length < probe.length) probe = candidates;
  const matched = new Set(probe);
  for (const candidates of candidateLists) {
    if (candidates === probe) continue;
    const allowed = new Set(candidates);
    for (const index of matched) if (!allowed.has(index)) matched.delete(index);
    if (!matched.size) break;
  }
  return ordered.filter((index) => matched.has(index));
}

function exactSearchScope(repos) {
  if (!repos?.length) return recordIndices;
  const unique = Array.from(new Set(repos));
  if (unique.length === 1) return repoRecordIndices[unique[0]] || [];
  const indices = [];
  for (const repo of unique) for (const index of repoRecordIndices[repo] || []) indices.push(index);
  return indices.sort((a, b) => a - b);
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

function findSearchAnchor(indices, anchorId) {
  const owner = searchAnchorOwners.get(indices) || {};
  const cached = searchAnchorCache.get(owner);
  if (cached?.has(anchorId)) {
    const index = cached.get(anchorId);
    cached.delete(anchorId); cached.set(anchorId, index);
    searchAnchorCache.delete(owner); searchAnchorCache.set(owner, cached);
    return index;
  }
  const index = indices.findIndex(index => {
    const record = records[index];
    const filename = (record.File || "") + (record.Extension ? "." + record.Extension : "");
    const path = (record.Folder || []).concat(filename).join("/");
    return `${record.Repo || ""}\0${path}` === anchorId;
  });
  if (anchorId.length <= SEARCH_ANCHOR_KEY_MAX) {
    const lookups = cached || new Map();
    lookups.set(anchorId, index);
    while (lookups.size > SEARCH_ANCHOR_PER_ORDER_MAX) lookups.delete(lookups.keys().next().value);
    // Owner tokens do not retain an evicted complete result order.
    searchAnchorOwners.set(indices, owner);
    searchAnchorCache.delete(owner); searchAnchorCache.set(owner, lookups);
    while (searchAnchorCache.size > SEARCH_ANCHOR_ORDER_MAX) searchAnchorCache.delete(searchAnchorCache.keys().next().value);
  }
  return index;
}

function pageResult(indices, params) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(params.pageSize) || 100));
  const pageItems = indices.slice((page - 1) * pageSize, page * pageSize);
  const result = {
    records: pageItems.map((index) => records[index]),
    ids: pageItems.map((index) => recordIds[index]),
    total: indices.length,
    page,
    pageSize,
    generation,
    snapshot_generation: snapshotGeneration || `worker:${corpusInstance}:${generation}`,
  };
  if (typeof params.anchorId === "string") {
    result.anchor_index = findSearchAnchor(indices, params.anchorId);
  }
  return result;
}

function searchLocal(params) {
  const query = String(params.q || "").trim();
  const searchFolders = params.searchFolders !== false;
  const cacheParams = Object.assign({}, params);
  delete cacheParams.page;
  delete cacheParams.pageSize;
  delete cacheParams.anchorId;
  const cacheKey = JSON.stringify(cacheParams);
  let ordered = searchOrderCache.get(cacheKey);
  if (ordered) {
    searchOrderCache.delete(cacheKey);
    searchOrderCache.set(cacheKey, ordered);
    return pageResult(ordered, params);
  }
  let matched = [];
  if (!query) {
    const order = emptySearchOrder(params);
    if (order !== null) return pageResult(order, params);
    matched = recordIndices.slice();
  } else if (params.exact || literalSearch(query)) {
    const wildcard = query.includes("*") || query.includes("?");
    const lower = query.toLowerCase();
    if (wildcard && query.replace(/\*/g, "") === "") {
      // A star-only pattern matches every string, including an empty field.
      matched = recordIndices.slice();
    } else {
      const pattern = wildcard ? compileWildcardMatcher(query) : null;
      for (const i of exactSearchScope(params.repos)) {
        const record = records[i] || {};
        const fields = getRecordSearchFields(record);
        if (pattern ? pattern.test(fields.file) || pattern.test(fields.repo) || (searchFolders && pattern.test(fields.folder)) : fields.file.includes(lower) || fields.repo.includes(lower) || (searchFolders && fields.folder.includes(lower))) matched.push(i);
      }
    }
  } else {
    buildFulltext();
    const activeIndex = searchFolders ? wordIndex : wordIndexFilesOnly;
    const activeVocab = searchFolders ? vocabSorted : vocabSortedFilesOnly;
    const tokenCandidates = [];
    let sortedCandidates = true;
    for (const token of tokenize(query)) {
      let candidates = activeIndex[token] || [];
      if (!candidates.length) {
        sortedCandidates = false;
        const fuzzy = [];
        for (const entry of activeVocab) {
          const vocab = entry[0];
          if (couldBeFuzzy(token, vocab, 2) && editDistance(token, vocab, 2) <= 2) fuzzy.push.apply(fuzzy, activeIndex[vocab] || []);
          if (fuzzy.length >= 200) break;
        }
        candidates = Array.from(new Set(fuzzy));
      }
      if (!candidates.length) {
        tokenCandidates.length = 0;
        break;
      }
      tokenCandidates.push(candidates);
    }
    matched = intersectCandidateLists(tokenCandidates, sortedCandidates);
  }
  const filtered = applyFilters(matched, params);
  if (params.sort === "name" || params.sort === "size") {
    ordered = filtered.sort(params.sort === "name" ? compareRecordName : compareRecordSize);
  } else {
    const tokens = tokenize(query);
    const scored = filtered.map((index) => {
      const record = records[index] || {};
      const fields = getRecordSearchFields(record);
      let score = 0;
      for (const token of tokens) {
        if (fields.file.includes(token)) score += 3;
        if (searchFolders && fields.folder.includes(token)) score += 2;
        if (fields.repo.includes(token)) score += 1;
      }
      return { index, score };
    });
    if (query) scored.sort((a, b) => b.score - a.score);
    ordered = scored.map((item) => item.index);
  }
  searchOrderCache.set(cacheKey, ordered);
  while (searchOrderCache.size > SEARCH_ORDER_CACHE_MAX) searchOrderCache.delete(searchOrderCache.keys().next().value);
  return pageResult(ordered, params);
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
  const directory = getDirectoryIndex(repo);
  const node = directory.nodes[path];
  const files = (directory.files[path] || []).map(index => {
    const record = records[index];
    return { name: record.File || "", ext: record.Extension || "", hasTxt: !!record.HasTxt, size: record.Size || "" };
  });
  return {
    folders: (node ? node.children.slice() : []).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map(child => ({ name: child.name, path: child.path, count: child.count })),
    files: files.sort((a, b) => a.name.localeCompare(b.name)),
    current_path: path,
    generation,
  };
}

function getDirectoryIndex(repo) {
  const cached = directoryIndexes.get(repo);
  if (cached) {
    directoryIndexes.delete(repo);
    directoryIndexes.set(repo, cached);
    return cached;
  }
  const root = { name: repo.split("/").pop(), path: "", children: [], count: 0, isRoot: true, hasDirectFiles: false };
  const nodes = Object.create(null);
  const directFiles = Object.create(null);
  nodes[""] = root;
  for (const index of repoRecordIndices[repo] || []) {
    const record = records[index];
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
    if (!directFiles[path]) directFiles[path] = [];
    directFiles[path].push(index);
  }
  for (const path of Object.keys(nodes)) {
    const node = nodes[path];
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.hasChildren = node.children.length > 0;
    node.showSelfToggle = !!(node.path && node.hasDirectFiles && node.hasChildren);
  }
  const directory = { tree: root.count ? [root] : [], nodes, files: directFiles };
  // Unknown repositories do not consume cache capacity. Stored file indices are
  // disjoint across repositories and therefore bounded by the loaded corpus.
  if (root.count) {
    directoryIndexes.set(repo, directory);
    while (directoryIndexes.size > DIRECTORY_INDEX_MAX) directoryIndexes.delete(directoryIndexes.keys().next().value);
  }
  return directory;
}

function folderTree(params) {
  return { tree: getDirectoryIndex(params.repo || "").tree, generation };
}

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function dispatch(type, payload, job) {
  if (type === "handshake") return { protocol: WORKER_PROTOCOL_VERSION };
  if (type === "cancel-search") {
    const pending = searchJobs.get(payload.requestId);
    if (pending) pending.cancelled = true;
    return {cancelled: !!pending};
  }
  if (type === "load-corpus") {
    return installCorpusFromSource(await fetchGzipJSON(payload.url));
  }
  if (type === "replace-corpus") return installCorpus(payload.data);
  if (!records.length) throw protocolError("CORPUS_NOT_READY", "Search corpus is not ready");
  if (type === "metadata") return Object.assign({ generation }, metadata);
  if (type === "local-search") {
    await prepareSearchIndex(payload || {}, job);
    if (job.cancelled) throw protocolError("SEARCH_CANCELLED", "Search cancelled");
    if (job.generation !== generation) throw protocolError("CORPUS_REPLACED", "Search corpus changed");
    return searchLocal(payload || {});
  }
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
  const job = {generation, cancelled: false};
  const searching = message.type === "local-search";
  try {
    if (searching) {
      if (searchJobs.size >= 32) throw protocolError("SEARCH_BUSY", "Search Worker is busy");
      searchJobs.set(id, job);
    }
    const result = await dispatch(message.type, message.payload || {}, job);
    self.postMessage({ protocol: WORKER_PROTOCOL_VERSION, type: "response", id, ok: true, result });
  } catch (error) {
    self.postMessage({
      protocol: WORKER_PROTOCOL_VERSION,
      type: "response",
      id,
      ok: false,
      error: { code: error && error.code || "WORKER_ERROR", message: String(error && error.message || error) },
    });
  } finally {
    if (searching && searchJobs.get(id) === job) searchJobs.delete(id);
  }
});

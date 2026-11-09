const WORKER_PROTOCOL_VERSION = 1;
const MAX_PAGE_SIZE = 500;
const MAX_CORPUS_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_CORPUS_EXPANDED_BYTES = 256 * 1024 * 1024;
const SORT_PRECOMPUTE_DELAY_MS = 1000;
// Bump when matching, filtering, collation or public record semantics change.
const SEARCH_SEMANTICS_VERSION = "worker-search-v6";
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
// Bound temporary membership allocation for dense-order reuse.
const SORT_REUSE_MAX_INDICES = 65536;
const EXACT_INDEX_MAX_INDICES = 65536;
let searchAnchorOwners = new WeakMap();
const searchAnchorCache = new Map();
const SEARCH_ANCHOR_ORDER_MAX = 8;
const SEARCH_ANCHOR_PER_ORDER_MAX = 8;
const SEARCH_ANCHOR_KEY_MAX = 4096;
let recordIndices = [];
let repoRecordIndices = Object.create(null);
// Unusual compact metadata retains its legacy field-coercion and error path;
// only ordinary string fields can use the repository-only wildcard proof.
let repoWildcardProofSafe = false;
let extensionSearchProofSafe = false;
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
const FULLTEXT_COMPACT_BATCH_TOKENS = 4096;
const FULLTEXT_FOLDER_CACHE_MAX = 64;
const FULLTEXT_FOLDER_CACHE_UNITS = 65536;
const directoryIndexes = new Map();
const DIRECTORY_INDEX_MAX = 4;
// Python compares lowercased Unicode code points; avoid UTF-16 surrogate ordering.
function compareCodepoints(left, right) {
  if (!/[\uD800-\uDFFF]/.test(left) && !/[\uD800-\uDFFF]/.test(right)) return left < right ? -1 : left > right ? 1 : 0;
  const a = Array.from(left, char => char.codePointAt(0));
  const b = Array.from(right, char => char.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
// Native file extensions understood by the Reader. Converted-only formats
// are supplied separately by the asset sidecar, not by this pool.
const NATIVE_READER_EXTENSIONS = new Set([
  "pdf", "djvu", "epub", "mobi", "azw", "azw3", "fb2", "fbz", "html", "htm",
  "txt", "md", "markdown", "vcf", "ini", "jpg", "jpeg", "png", "gif", "bmp",
  "tif", "tiff", "webp", "mp3", "mp4", "wav", "m4a", "flac", "mov", "mpga",
  "wma", "ape", "amr", "swf"
]);

function emptyMetadata() {
  return { count: 0, repos: [], extensions: [], extensionsByRepo: {}, reader: { available: false, count: 0, byRepo: {} } };
}

function tokenizeParts(text) {
  /** @type {string[]} */
  const chinese = [];
  const lower = String(text || "").toLowerCase();
  /** @type {string[]} */
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
    file: (String(record.File || "") + (record.Extension ? "." + String(record.Extension) : "")).toLowerCase(),
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

function fuzzyDistanceBudget(token) {
  // A two-edit radius makes every single character match every other one.
  if (token.length <= 1) return 0;
  return token.length <= 3 ? 1 : 2;
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
  const normalized = String(pattern || "");
  // Python's Unicode case-insensitive matcher equates Kelvin sign and long s
  // with ASCII k and s. JS non-unicode regex deliberately does not. Handle
  // these one-literal edge patterns without changing UTF-16/dot semantics.
  const special = normalized.replace(/^\*+|\*+$/g, "");
  if (normalized.includes("*") && /^[Kſ]$/.test(special)) {
    return new RegExp(special === "K" ? "[kK]" : "[sſ]", "i");
  }
  if (normalized.includes("*") && normalized.includes("?") && /^[*?]+$/.test(normalized)) {
    // Stars may match nothing; questions require adjacent regex-dot code units.
    const requiredLength = normalized.replace(/\*/g, "").length;
    return {test(text) {
      let run = 0;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) run = 0;
        else if (++run >= requiredLength) return true;
      }
      return false;
    }};
  }
  if (normalized.includes("?") && !normalized.includes("*")) {
    // Escaped literals and non-u dots have fixed width and cannot backtrack.
    const tokens = normalized.split("");
    const fixed = new RegExp(tokens.map(char => char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(""), "i");
    if (tokens.length < 128 || !tokens.some(char => char !== "?")) return fixed;
    const required = Array.from(new Set(tokens.filter(char => char !== "?")))
      .map(char => new RegExp(char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    return {test(text) {
      if (text.length > 4096) for (const literal of required) if (!literal.test(text)) return false;
      return fixed.test(text);
    }};
  }
  // Boundary stars may match zero characters in substring matching. Escaping
  // every remaining literal keeps regex work bounded and preserves /i rules.
  const core = normalized.replace(/^\*+|\*+$/g, "");
  if (core && !core.includes("*") && !core.includes("?")) {
    return new RegExp(core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  if (core.includes("*") && !core.includes("?") && /^[\x00-\x7f]+$/.test(core) && !/[\n\r]/.test(core)) {
    // Match literal chunks in leftmost order within a single regex-dot line.
    // Searching each escaped chunk separately avoids wildcard backtracking.
    const chunks = core.split(/\*+/).map(part => new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"));
    return {test(text) {
      for (const chunk of chunks) {
        chunk.lastIndex = 0;
        if (!chunk.test(text)) return false;
      }
      let start = 0;
      while (true) {
        const term = /[\n\r\u2028\u2029]/g;
        term.lastIndex = start;
        const foundTerm = term.exec(text);
        const end = foundTerm ? foundTerm.index : text.length;
        const line = text.slice(start, end);
        let position = 0;
        let matched = true;
        for (const chunk of chunks) {
          chunk.lastIndex = position;
          if (!chunk.exec(line)) { matched = false; break; }
          position = chunk.lastIndex;
        }
        if (matched) return true;
        if (!foundTerm) return false;
        start = end + 1;
      }
    }};
  }
  // One star separating a boundary run of questions from fixed literals is
  // equivalent to fixed-width dots in an unanchored search.
  const parts = core.split(/\*+/);
  if (parts.length === 2 && ((/^\?+$/.test(parts[0]) && !parts[1].includes("?"))
      || (/^\?+$/.test(parts[1]) && !parts[0].includes("?")))) {
    const fixed = parts.join("").split("").map(char => char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
    return new RegExp(fixed, "i");
  }
  const tokens = normalized.replace(/\*+/g, "*").split("");
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

function asciiSeparatorSearch(query, params) {
  // Only one ASCII term joined by common separators is eligible. Explicit
  // exact and wildcard queries retain their literal behavior.
  return !params.exact && /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/i.test(query);
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

async function readBoundedBytes(stream, limit) {
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw protocolError("CORPUS_TOO_LARGE", "Search corpus exceeds its size limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function fetchGzipJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw protocolError("CORPUS_FETCH_FAILED", "HTTP " + response.status);
  if (!response.body || typeof DecompressionStream === "undefined") {
    throw protocolError("GZIP_UNAVAILABLE", "Streaming gzip decompression is unavailable");
  }
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_CORPUS_COMPRESSED_BYTES) {
    await response.body.cancel().catch(() => {});
    throw protocolError("CORPUS_TOO_LARGE", "Search corpus exceeds its compressed size limit");
  }
  const compressed = await readBoundedBytes(response.body, MAX_CORPUS_COMPRESSED_BYTES);
  const stream = new Response(compressed).body.pipeThrough(new DecompressionStream("gzip"));
  const expanded = await readBoundedBytes(stream, MAX_CORPUS_EXPANDED_BYTES);
  return new TextDecoder("utf-8", {fatal:true}).decode(expanded);
}

async function corpusFingerprint(source) {
  if (typeof crypto === "undefined" || !crypto.subtle || typeof TextEncoder === "undefined") return null;
  const bytes = new TextEncoder().encode(source || "");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  // Keep snapshots isolated across runtime and Unicode-version changes.
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
  return compareCodepoints(String(records[a].File || "").toLowerCase(), String(records[b].File || "").toLowerCase());
}

function compareRecordSize(a, b) {
  return (Number(records[b].Size) || 0) - (Number(records[a].Size) || 0) || compareRecordName(a, b);
}

function buildNameOrders() {
  if (nameOrderReady) return;
  // Ordinary decoded records have immutable string names; compute the key
  // once instead of lowercasing during every sort comparison.
  if (repoWildcardProofSafe) {
    const keys = records.map(record => String(record.File || "").toLowerCase());
    const hasSurrogate = keys.map(key => /[\uD800-\uDFFF]/.test(key));
    sortedByName = recordIndices.slice().sort((a, b) => {
      const left = keys[a], right = keys[b];
      return hasSurrogate[a] || hasSurrogate[b] ? compareCodepoints(left, right)
        : left < right ? -1 : left > right ? 1 : 0;
    });
  } else {
    sortedByName = recordIndices.slice().sort(compareRecordName);
  }
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
  // Build all fallible metadata off to the side. A rejected corpus must never
  // expose its records under the previous generation or damage old indexes.
  const repoCounts = Object.create(null);
  const extensionCounts = Object.create(null);
  const extensionsByRepo = Object.create(null);
  const readerByRepo = Object.create(null);
  const idOccurrences = Object.create(null);
  const nextRecordIds = new Array(nextRecords.length);
  const nextRecordIndices = new Array(nextRecords.length);
  const nextRepoRecordIndices = Object.create(null);
  let nextRepoWildcardProofSafe = true;
  let nextExtensionSearchProofSafe = true;
  const nextReaderRecordIndices = [];
  const nextRepoReaderRecordIndices = Object.create(null);
  for (let i = 0; i < nextRecords.length; i++) {
    const record = nextRecords[i];
    if (typeof record.Repo !== "string" || typeof record.File !== "string"
        || !Array.isArray(record.Folder) || Array.prototype.some.call(record.Folder, part => typeof part !== "string")) {
      nextRepoWildcardProofSafe = false;
    }
    const repo = record.Repo || "";
    nextRecordIndices[i] = i;
    if (!nextRepoRecordIndices[repo]) nextRepoRecordIndices[repo] = [];
    nextRepoRecordIndices[repo].push(i);
    if (typeof record.Extension !== "string") nextExtensionSearchProofSafe = false;
    const extension = String(record.Extension || "").toLowerCase();
    repoCounts[repo] = (repoCounts[repo] || 0) + 1;
    if (extension) {
      extensionCounts[extension] = (extensionCounts[extension] || 0) + 1;
      if (!extensionsByRepo[repo]) extensionsByRepo[repo] = Object.create(null);
      extensionsByRepo[repo][extension] = (extensionsByRepo[repo][extension] || 0) + 1;
    }
    if (NATIVE_READER_EXTENSIONS.has(extension)) {
      nextReaderRecordIndices.push(i);
      readerByRepo[repo] = (readerByRepo[repo] || 0) + 1;
      if (!nextRepoReaderRecordIndices[repo]) nextRepoReaderRecordIndices[repo] = [];
      nextRepoReaderRecordIndices[repo].push(i);
    }
    const base = [repo, (record.Folder || []).join("/"), record.File || "", record.Extension || ""].join("\u001f");
    const occurrence = idOccurrences[base] || 0;
    idOccurrences[base] = occurrence + 1;
    nextRecordIds[i] = stableRecordId(record, occurrence);
  }
  const nextMetadata = {
    count: nextRecords.length,
    repos: Object.keys(repoCounts).map((name) => ({ name, count: repoCounts[name] })).sort((a, b) => a.name.localeCompare(b.name)),
    extensions: Object.keys(extensionCounts).sort().map((name) => ({ name, count: extensionCounts[name] })),
    extensionsByRepo: Object.create(null),
    reader: { available: nextReaderRecordIndices.length > 0, count: nextReaderRecordIndices.length, byRepo: readerByRepo },
  };
  for (const repo of Object.keys(extensionsByRepo)) {
    nextMetadata.extensionsByRepo[repo] = Object.keys(extensionsByRepo[repo]).sort().map((name) => ({ name, count: extensionsByRepo[repo][name] }));
  }
  // Publication is synchronous: existing searches see either complete snapshot.
  if (sortBuildTimer !== null && typeof clearTimeout === "function") clearTimeout(sortBuildTimer);
  if (fulltextBuildTimer !== null && typeof clearTimeout === "function") clearTimeout(fulltextBuildTimer);
  fulltextBuildTimer = null;
  fulltextBuild = null;
  directoryIndexes.clear();
  searchOrderCache.clear();
  searchAnchorOwners = new WeakMap();
  searchAnchorCache.clear();
  recordSearchFields = new WeakMap();
  snapshotGeneration = null;
  records = nextRecords;
  recordIds = nextRecordIds;
  recordIndices = nextRecordIndices;
  repoRecordIndices = nextRepoRecordIndices;
  readerRecordIndices = nextReaderRecordIndices;
  repoReaderRecordIndices = nextRepoReaderRecordIndices;
  metadata = nextMetadata;
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
  repoWildcardProofSafe = nextRepoWildcardProofSafe;
  extensionSearchProofSafe = nextExtensionSearchProofSafe;
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
  // Compact bounded slices before publishing either index, so metadata and
  // cancellation can run during a large corpus build.
  if (!build.allCompaction) build.allCompaction = { keys: build.allVocab.keys, next: 0 };
  if (!advancePostingCompaction(build.all, build.allCompaction, deadline)) return;
  if (!build.filesCompaction) build.filesCompaction = { keys: build.filesVocab.keys, next: 0 };
  if (!advancePostingCompaction(build.files, build.filesCompaction, deadline, build.all)) return;
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
    let group = build.groups.get(count);
    if (!group) { group = []; build.groups.set(count, group); }
    group.push([token, count]);
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

function advancePostingCompaction(index, build, deadline, sharedIndex = null) {
  let remaining = deadline === Infinity ? Infinity : FULLTEXT_COMPACT_BATCH_TOKENS;
  while (build.next < build.keys.length) {
    if (remaining-- <= 0 || Date.now() >= deadline) return false;
    const token = build.keys[build.next];
    const posting = index[token];
    const shared = sharedIndex && sharedIndex[token];
    // File postings are an ordered subset of all-field postings. Equal lengths
    // prove equal IDs, so immutable arrays can be shared without a second scan.
    index[token] = shared && shared.length === posting.length ? shared : Uint32Array.from(posting);
    build.next++;
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
  if (typeof MessageChannel === "undefined") return /** @type {Promise<void>} */ (new Promise(resolve => typeof setTimeout === "function" ? setTimeout(resolve, 0) : resolve()));
  if (!indexYieldChannel) {
    indexYieldChannel = new MessageChannel();
    indexYieldChannel.port1.onmessage = () => indexYieldQueue.shift()?.();
  }
  // A message task permits cancellation without the nested-timer 4 ms clamp.
  return new Promise(resolve => { indexYieldQueue.push(resolve); indexYieldChannel.port2.postMessage(null); });
}

function singleCharacterSearch(query, params) {
  // One code point has no fuzzy expansion: the complete literal scan also
  // includes filename, extension, repository and optional folder hits.
  return !params.exact && Array.from(query).length === 1 && !/[\s*?]/u.test(query);
}

async function prepareSearchIndex(params, job) {
  const query = String(params.q || "").trim();
  if (wordIndex || !query || params.exact || singleCharacterSearch(query, params)
      || (literalSearch(query) && !asciiSeparatorSearch(query, params))) return;
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
  const folders = params.folders && params.folders.length ? new Set(params.folders.map(cleanPath)) : null;
  const singleFolder = folders?.size === 1 ? folders.values().next().value : "";
  return {
    repoSet: repos && repos.length ? new Set(repos) : null,
    extensionSet: extensions && extensions.length
      ? new Set(extensions.map((extension) => String(extension || "").toLowerCase()))
      : null,
    folders,
    folderPrefix: singleFolder ? singleFolder + "/" : null,
    selfFolders: new Set((params.folderSelfs || []).map(cleanPath).filter((path) => typeof path === "string")),
    subtreeFolders: new Set((params.folderSubtrees || []).map(cleanPath).filter((path) => typeof path === "string")),
  };
}

function matchesFolderFilters(recordFolders, folderPath, params, filters) {
  if (params.folderMatchMode === "mixed") {
    let matched = filters.selfFolders.has(folderPath);
    // Direct-only selections do not need any ancestor prefixes.
    if (matched || !filters.subtreeFolders.size) return !(filters.selfFolders.size || filters.subtreeFolders.size) || matched;
    for (let depth = 1; !matched && depth <= recordFolders.length; depth++)
      matched = filters.subtreeFolders.has(recordFolders.slice(0, depth).join("/"));
    return matched;
  }
  if (!filters.folders) return true;
  if (params.folderMatchMode === "exact") return filters.folders.has(folderPath);
  // The API's root prefix denotes the entire selected repository scope.
  if (filters.folders.has("")) return true;
  if (!folderPath) return false;
  if (filters.folders.has(folderPath)) return true;
  if (filters.folderPrefix) return folderPath.startsWith(filters.folderPrefix);
  for (let end = folderPath.lastIndexOf("/"); end > 0; end = folderPath.lastIndexOf("/", end - 1)) {
    if (filters.folders.has(folderPath.slice(0, end))) return true;
  }
  return false;
}

function applyFilters(indices, params) {
  const filters = buildFilterSets(params);
  const hasFolderFilters = params.folderMatchMode === "mixed"
    ? filters.selfFolders.size || filters.subtreeFolders.size
    : !!filters.folders;
  return indices.filter((index) => {
    const record = records[index] || {};
    if (filters.repoSet && !filters.repoSet.has(record.Repo)) return false;
    if (filters.extensionSet && !filters.extensionSet.has(String(record.Extension || "").toLowerCase())) return false;
    if (hasFolderFilters) {
      const recordFolders = Array.isArray(record.Folder) ? record.Folder : [];
      const folderPath = recordFolders.join("/");
      if (!matchesFolderFilters(recordFolders, folderPath, params, filters)) return false;
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

function intersectCandidateLists(candidateLists, sorted = false) {
  if (!candidateLists.length) return [];
  if (sorted) {
    if (candidateLists.length === 1) return Array.from(candidateLists[0]);
    const lists = candidateLists.slice().sort((a, b) => a.length - b.length);
    const matched = [];
    if (lists[0].length >= 512) {
      // Dense sorted postings are cheaper to intersect with monotonic cursors.
      const cursors = new Array(lists.length).fill(0);
      outer: for (const index of lists[0]) {
        for (let i = 1; i < lists.length; i++) {
          const list = lists[i];
          let offset = cursors[i];
          while (offset < list.length && list[offset] < index) offset++;
          cursors[i] = offset;
          if (offset === list.length) break outer;
          if (list[offset] !== index) continue outer;
        }
        matched.push(index);
      }
      return matched;
    }
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

function indexedExactCandidates(term, params, scopeSize) {
  if (!wordIndex || !repoWildcardProofSafe || !extensionSearchProofSafe || !scopeSize) return null;
  const repos = params.repos;
  if (repos?.length && (!Array.isArray(repos) || repos.some(repo => typeof repo !== "string"))) return null;
  const selected = repos?.length ? new Set(repos) : null;
  const index = params.searchFolders === false ? wordIndexFilesOnly : wordIndex;
  let best = null;
  let bestSize = Math.min(EXACT_INDEX_MAX_INDICES, Math.floor(scopeSize / 2));
  const runs = term.match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) || [];
  for (const run of runs) for (let offset = 0; offset < run.length - 1; offset++) {
    const gram = run.slice(offset, offset + 2);
    if (metadata.extensions.some(extension => extension.name.includes(gram))) continue;
    const posting = index[gram] || [];
    const repoMatches = metadata.repos.filter(repo => (!selected || selected.has(repo.name))
      && repo.name.toLowerCase().includes(gram));
    const size = posting.length + repoMatches.reduce((total, repo) => total + repo.count, 0);
    if (size < bestSize) { best = {posting, repoMatches}; bestSize = size; }
  }
  if (best === null) return null;
  const candidates = new Set();
  for (const id of best.posting) if (!selected || selected.has(records[id].Repo)) candidates.add(id);
  for (const repo of best.repoMatches) for (const id of repoRecordIndices[repo.name]) candidates.add(id);
  return Array.from(candidates).sort((a, b) => a - b);
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
  const separator = anchorId.indexOf("\0");
  const anchorRepo = anchorId.slice(0, separator), anchorPath = anchorId.slice(separator + 1);
  const index = separator < 0 ? -1 : indices.findIndex(index => {
    const record = records[index];
    const repo = String(record.Repo || "");
    if (repo !== anchorRepo && (!repo.includes("\0") || !anchorId.startsWith(`${repo}\0`))) return false;
    const filename = (record.File || "") + (record.Extension ? "." + record.Extension : "");
    const path = (record.Folder || []).concat(filename).join("/");
    return repo === anchorRepo ? path === anchorPath : `${repo}\0${path}` === anchorId;
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

function searchLocal(params, preparedExact = null) {
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
  if (singleCharacterSearch(query, params) && preparedExact !== null) {
    matched = preparedExact;
  } else if (!query) {
    const order = emptySearchOrder(params);
    if (order !== null) return pageResult(order, params);
    const repos = params.repos;
    // Repository indexes preserve source order. Restrict only an ordinary
    // single nonempty string; other inputs keep the existing global scan.
    matched = Array.isArray(repos) && repos.length === 1 && typeof repos[0] === "string" && repos[0]
      ? (repoRecordIndices[repos[0]] || []).slice() : recordIndices.slice();
  } else if (params.exact || (literalSearch(query) && !asciiSeparatorSearch(query, params))) {
    // Whitespace separates independent literal terms, matching the HF API.
    // A term may still be a wildcard pattern; every term must match.
    const terms = query.split(/\s+/).filter(Boolean);
    matched = preparedExact === null ? exactSearchScope(params.repos).slice() : preparedExact;
    for (let termIndex = 0; preparedExact === null && termIndex < terms.length; termIndex++) {
      const term = terms[termIndex];
      const wildcard = term.includes("*") || term.includes("?");
      const lower = term.toLowerCase();
      if (wildcard && term.replace(/\*/g, "") === "") continue;
      const pattern = wildcard ? compileWildcardMatcher(term) : null;
      if (termIndex === 0) {
        const indexed = indexedExactCandidates(term, params, matched.length);
        if (indexed !== null) matched = indexed;
      }
      // The previous scan breaks here for an empty scope; avoid proving
      // universal terms against all repos repeatedly when nothing can match.
      if (!matched.length) break;
      // Every indexed Repo is a complete field in every candidate. If the
      // matcher accepts all of them, this AND term cannot remove a record.
      // For a small scope, the existing scan is cheaper than proving all repos.
      if (repoWildcardProofSafe && matched.length >= metadata.repos.length
          && pattern && term.includes("*") && term.includes("?")
          && /^[*?]+$/.test(term)
          && Object.keys(repoRecordIndices).every(repo => pattern.test(repo.toLowerCase()))) continue;
      matched = matched.filter(index => {
        const record = records[index] || {};
        const fields = getRecordSearchFields(record);
        return pattern
          ? pattern.test(fields.file) || pattern.test(fields.repo) || (searchFolders && pattern.test(fields.folder))
          : fields.file.includes(lower) || fields.repo.includes(lower) || (searchFolders && fields.folder.includes(lower));
      });
      if (!matched.length) break;
    }
  } else {
    buildFulltext();
    const activeIndex = searchFolders ? wordIndex : wordIndexFilesOnly;
    const activeVocab = searchFolders ? vocabSorted : vocabSortedFilesOnly;
    const tokenCandidates = [];
    let sortedCandidates = true;
    const scope = exactSearchScope(params.repos);
    const tokens = tokenize(query);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    // Any mandatory literal term can safely bound the literal-only fallback;
    // the fuzzy postings below still retain the complete vocabulary semantics.
    let literalScope = scope;
    for (const term of terms) {
      const indexed = indexedExactCandidates(term, params, literalScope.length);
      if (indexed !== null) literalScope = indexed;
    }
    const seen = new Set();
    for (const index of literalScope) {
      const fields = getRecordSearchFields(records[index]);
      if (terms.every(term => fields.file.includes(term) || fields.repo.includes(term)
          || (searchFolders && fields.folder.includes(term)))) seen.add(index);
    }
    for (const token of tokens) {
      let candidates = activeIndex[token] || [];
      // A missing vocabulary token with literal hits already has a complete
      // authoritative answer; do not expand every two-edit near match.
      if (!candidates.length && !(terms.length === 1 && seen.size)) {
        sortedCandidates = false;
        const fuzzy = new Set();
        const maxDist = fuzzyDistanceBudget(token);
        for (const entry of maxDist ? activeVocab : []) {
          const vocab = entry[0];
          if (couldBeFuzzy(token, vocab, maxDist) && editDistance(token, vocab, maxDist) <= maxDist) {
            for (const index of activeIndex[vocab] || []) fuzzy.add(index);
          }
        }
        candidates = Array.from(fuzzy);
      }
      if (!candidates.length) {
        tokenCandidates.length = 0;
        break;
      }
      tokenCandidates.push(candidates);
    }
    matched = intersectCandidateLists(tokenCandidates, sortedCandidates);
    for (const index of matched) seen.add(index);
    matched = Array.from(seen).sort((a, b) => a - b);
  }
  const filtered = applyFilters(matched, params);
  if (params.sort === "name" || params.sort === "size") {
    const repos = params.repos || [];
    const ready = params.sort === "name" ? nameOrderReady : sizeOrderReady;
    const byRepo = params.sort === "name" ? repoSortedByName : repoSortedBySize;
    const order = repos.length === 1 ? (byRepo[repos[0]] || []) : null;
    // Exact single-repo matches retain source order, so stable name ties match
    // the prepared repository order. Fuzzy, unusual and cold paths still sort.
    const exactSingleRepoName = query && params.sort === "name"
      && (params.exact || (literalSearch(query) && !asciiSeparatorSearch(query, params)))
      && repoWildcardProofSafe && Array.isArray(repos) && repos.length === 1
      && typeof repos[0] === "string" && repos[0];
    if ((!query || exactSingleRepoName) && ready && order && filtered.length <= SORT_REUSE_MAX_INDICES
        && filtered.length * 3 > order.length * 2) {
      const keep = new Set(filtered);
      ordered = order.filter(index => keep.has(index));
    } else {
      ordered = filtered.sort(params.sort === "name" ? compareRecordName : compareRecordSize);
    }
  } else if (!query || /^[*?]+$/.test(query)) {
    // These queries have no score tokens, so stable relevance keeps this order.
    ordered = filtered;
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

async function prepareSingleCharacter(params, job) {
  const query = String(params.q || "").trim();
  if (!singleCharacterSearch(query, params)) return null;
  const lower = query.toLowerCase(), scope = exactSearchScope(params.repos), matched = [];
  for (let start = 0; start < scope.length; start += FULLTEXT_BATCH_RECORDS) {
    if (job.cancelled) throw protocolError("SEARCH_CANCELLED", "Search cancelled");
    if (job.generation !== generation) throw protocolError("CORPUS_REPLACED", "Search corpus changed");
    const end = Math.min(scope.length, start + FULLTEXT_BATCH_RECORDS);
    for (let offset = start; offset < end; offset++) {
      const index = scope[offset], fields = getRecordSearchFields(records[index]);
      if (fields.file.includes(lower) || fields.repo.includes(lower)
          || (params.searchFolders !== false && fields.folder.includes(lower))) matched.push(index);
    }
    if (end < scope.length) await yieldSearchIndex();
  }
  if (job.cancelled) throw protocolError("SEARCH_CANCELLED", "Search cancelled");
  if (job.generation !== generation) throw protocolError("CORPUS_REPLACED", "Search corpus changed");
  return matched;
}

async function prepareLongWildcard(params, job) {
  const query = String(params.q || "").trim();
  // Ordinary searches keep their fast synchronous path. Expensive wildcard
  // scans yield between bounded batches so cancellation and metadata work.
  // Keep short glob scans on the existing fast path, including repository
  // proofs and dense-order reuse; only long patterns require cooperative work.
  if (query.length < 32 || !/[*?]/.test(query)
      || query.split(/\s+/).every(term => /^\*+$/.test(term))) return null;
  const cacheParams = Object.assign({}, params);
  delete cacheParams.page; delete cacheParams.pageSize; delete cacheParams.anchorId;
  if (searchOrderCache.has(JSON.stringify(cacheParams))) return null;
  const terms = query.split(/\s+/).filter(Boolean).map(term => ({
    lower: term.toLowerCase(),
    matcher: /[*?]/.test(term) ? compileWildcardMatcher(term) : null,
  }));
  const scope = exactSearchScope(params.repos);
  const matched = [];
  for (let start = 0; start < scope.length; start += FULLTEXT_BATCH_RECORDS) {
    if (job.cancelled) throw protocolError("SEARCH_CANCELLED", "Search cancelled");
    if (job.generation !== generation) throw protocolError("CORPUS_REPLACED", "Search corpus changed");
    const end = Math.min(scope.length, start + FULLTEXT_BATCH_RECORDS);
    for (let offset = start; offset < end; offset++) {
      const index = scope[offset], fields = getRecordSearchFields(records[index]);
      if (terms.every(({lower, matcher}) => matcher
        ? matcher.test(fields.file) || matcher.test(fields.repo) || (params.searchFolders !== false && matcher.test(fields.folder))
        : fields.file.includes(lower) || fields.repo.includes(lower) || (params.searchFolders !== false && fields.folder.includes(lower)))) matched.push(index);
    }
    if (end < scope.length) await yieldSearchIndex();
  }
  if (job.cancelled) throw protocolError("SEARCH_CANCELLED", "Search cancelled");
  if (job.generation !== generation) throw protocolError("CORPUS_REPLACED", "Search corpus changed");
  return matched;
}

function randomRecord(params) {
  if (params.txtOnly) throw protocolError("LEGACY_TXT_RETIRED", "Legacy OCR TXT selection is retired");
  const repo = params.repo || "";
  const readerOnly = !!params.readerOnly;
  let candidates;
  if (readerOnly) candidates = repo ? (repoReaderRecordIndices[repo] || []) : readerRecordIndices;
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
  return Object.assign(new Error(message), {code});
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
    if (Array.from(String(payload.q || "")).length > 256)
      throw protocolError("QUERY_TOO_LONG", "Search query exceeds 256 characters");
    await prepareSearchIndex(payload || {}, job);
    const prepared = await prepareSingleCharacter(payload || {}, job) ?? await prepareLongWildcard(payload || {}, job);
    if (job.cancelled) throw protocolError("SEARCH_CANCELLED", "Search cancelled");
    if (job.generation !== generation) throw protocolError("CORPUS_REPLACED", "Search corpus changed");
    return searchLocal(payload || {}, prepared);
  }
  if (type === "random-record") return randomRecord(payload || {});
  if (type === "folder-contents") return folderContents(payload || {});
  if (type === "folder-tree") return folderTree(payload || {});
  throw protocolError("UNKNOWN_REQUEST", "Unknown Worker request: " + type);
}

self.addEventListener("message", async function(event) {
  const message = /** @type {MessageEvent} */ (event).data || {};
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

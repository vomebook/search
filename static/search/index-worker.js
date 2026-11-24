/* global compareCodepoints, tokenizeParts, tokenize, isChineseToken, fuzzyDistanceBudget, literalSearch, intersectCandidateLists */
importScripts("./worker/domain/text.js");
importScripts("./worker/domain/intersection.js");

/** Decoded values remain untrusted: compact corpora historically preserve unusual field values. @typedef {{Repo: unknown, File: unknown, Extension: unknown, Folder: unknown[], Size: unknown, HasTxt: boolean}} SearchRecord */
/** Raw request values are deliberately not validated by the legacy protocol. @typedef {{q?: unknown, exact?: unknown, searchFolders?: unknown, repos?: unknown, extensions?: unknown, folders?: unknown, folderSelfs?: unknown, folderSubtrees?: unknown, folderMatchMode?: unknown, minSize?: unknown, maxSize?: unknown, page?: unknown, pageSize?: unknown, anchorId?: unknown, sort?: unknown, repo?: unknown, path?: unknown, txtOnly?: unknown, readerOnly?: unknown, randomValue?: unknown}} SearchParams */
/** @typedef {{generation: number, cancelled: boolean}} SearchJob */
/** @typedef {{name: string, count: number}} CountEntry */
/** @typedef {{count: number, repos: CountEntry[], extensions: CountEntry[], extensionsByRepo: Record<string, CountEntry[]>, reader: {available: boolean, count: number, byRepo: Record<string, number>}}} SearchMetadata */
/** @typedef {number[] | Uint32Array} Posting */
/** @typedef {Record<string, Posting>} PostingIndex */
/** @typedef {Map<number, string[]>} VocabularyByLength */
/** @typedef {{keys: string[], next: number, byLength: VocabularyByLength}} VocabularyBuild */
/** @typedef {{keys: string[], next: number}} PostingCompaction */
/** @typedef {{next: number, all: PostingIndex, files: PostingIndex, folderTokens: Map<string, {parts: ReturnType<typeof tokenizeParts>, units: number}>, folderUnits: number, allVocab?: VocabularyBuild, filesVocab?: VocabularyBuild, allCompaction?: PostingCompaction, filesCompaction?: PostingCompaction}} FulltextBuild */
/** @typedef {{name: string, path: string, children: DirectoryNode[], count: number, isRoot?: boolean, hasDirectFiles: boolean, hasChildren?: boolean, showSelfToggle?: boolean}} DirectoryNode */
/** @typedef {{tree: DirectoryNode[], nodes: Record<string, DirectoryNode>, files: Record<string, number[]>, canonicalPaths: boolean}} DirectoryIndex */

const WORKER_PROTOCOL_VERSION = 1;
const MAX_PAGE_SIZE = 500;
const MAX_CORPUS_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_CORPUS_EXPANDED_BYTES = 256 * 1024 * 1024;
const SORT_PRECOMPUTE_DELAY_MS = 1000;
// Bump when matching, filtering, collation or public record semantics change.
const SEARCH_SEMANTICS_VERSION = "worker-search-v8";
/** @type {string | null} */
let snapshotGeneration = null;

/** @type {SearchRecord[]} */
let records = [];
/** @type {string[]} */
let recordIds = [];
/** @type {WeakMap<Partial<SearchRecord>, {file: string, repo: string, folder: string}>} */
let recordSearchFields = new WeakMap();
let metadata = emptyMetadata();
let generation = 0;
const corpusInstance = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
/** @type {PostingIndex | null} */
let wordIndex = null;
/** @type {PostingIndex | null} */
let wordIndexFilesOnly = null;
/** @type {VocabularyByLength} */
let vocabByLength = new Map();
/** @type {VocabularyByLength} */
let vocabByLengthFilesOnly = new Map();
/** @type {Map<string, number[]>} */
const searchOrderCache = new Map();
const SEARCH_ORDER_CACHE_MAX = 8;
// Bound temporary membership allocation for dense-order reuse.
const SORT_REUSE_MAX_INDICES = 65536;
const EXACT_INDEX_MAX_INDICES = 65536;
const EXACT_INDEX_LOOKAHEAD_MAX_TERMS = 4;
const EXACT_INDEX_LOOKAHEAD_MAX_TERM_UNITS = 16;
const EXACT_INDEX_LOOKAHEAD_MAX_INDICES = 4096;
/** @type {WeakMap<number[], object>} */
let searchAnchorOwners = new WeakMap();
/** @type {Map<object, Map<string, number>>} */
const searchAnchorCache = new Map();
const SEARCH_ANCHOR_ORDER_MAX = 8;
const SEARCH_ANCHOR_PER_ORDER_MAX = 8;
const SEARCH_ANCHOR_KEY_MAX = 4096;
/** @type {number[]} */
let recordIndices = [];
/** @type {Record<string, number[]>} */
let repoRecordIndices = Object.create(null);
// Unusual compact metadata retains its legacy field-coercion and error path;
// only ordinary string fields can use the repository-only wildcard proof.
let repoWildcardProofSafe = false;
let extensionSearchProofSafe = false;
/** @type {number[]} */
let readerRecordIndices = [];
/** @type {Record<string, number[]>} */
let repoReaderRecordIndices = Object.create(null);
/** @type {number[]} */
let sortedByName = [];
/** @type {number[]} */
let sortedBySize = [];
/** @type {Record<string, number[]>} */
let repoSortedByName = Object.create(null);
/** @type {Record<string, number[]>} */
let repoSortedBySize = Object.create(null);
let nameOrderReady = false;
let sizeOrderReady = false;
/** @type {number | null} */
let sortBuildTimer = null;
/** @type {number | null} */
let fulltextBuildTimer = null;
/** @type {FulltextBuild | null} */
let fulltextBuild = null;
/** @type {Map<unknown, SearchJob>} */
const searchJobs = new Map();
/** @type {MessageChannel | null} */
let indexYieldChannel = null;
/** @type {Array<() => void>} */
const indexYieldQueue = [];
const FULLTEXT_BATCH_RECORDS = 256;
const FULLTEXT_BATCH_MS = 8;
const FULLTEXT_COMPACT_BATCH_TOKENS = 4096;
const FULLTEXT_FOLDER_CACHE_MAX = 64;
const FULLTEXT_FOLDER_CACHE_UNITS = 65536;
/** @type {Map<string, DirectoryIndex>} */
const directoryIndexes = new Map();
const DIRECTORY_INDEX_MAX = 4;
const FOLDER_SEARCH_MAX = 4096;
// Only formats readable from the original file belong in this pool. Ebooks
// requiring a chapter manifest are supplied separately by the asset sidecar.
const NATIVE_READER_EXTENSIONS = new Set([
  "pdf", "djvu", "html", "htm",
  "txt", "md", "markdown", "vcf", "ini", "jpg", "jpeg", "png", "gif", "bmp",
  "webp", "mp3", "mp4", "wav", "m4a", "flac", "mov", "mpga",
  "wma", "ape", "amr", "swf"
]);

/** @returns {SearchMetadata} */
function emptyMetadata() {
  return { count: 0, repos: [], extensions: [], extensionsByRepo: {}, reader: { available: false, count: 0, byRepo: {} } };
}

/** @param {Partial<SearchRecord>} record */
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

/** @param {FulltextBuild} build @param {string} text */
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
      const key = /** @type {string} */ (build.folderTokens.keys().next().value);
      build.folderUnits -= /** @type {{units: number}} */ (build.folderTokens.get(key)).units;
      build.folderTokens.delete(key);
    }
    build.folderTokens.set(text, {parts, units});
    build.folderUnits += units;
  }
  return parts;
}

/** @param {string} s1 @param {string} s2 @param {number} maxDist */
function editDistance(s1, s2, maxDist) {
  if (Math.abs(s1.length - s2.length) > maxDist) return 999;
  let prev = [0];
  for (let i = 1; i <= s2.length; i++) prev.push(i);
  for (let i = 0; i < s1.length; i++) {
    const curr = [i + 1];
    let rowMin = i + 1;
    // Both rows contain the columns already visited; prev has s2.length + 1.
    for (let j = 0; j < s2.length; j++) {
      const value = Math.min(/** @type {number} */ (prev[j + 1]) + 1, /** @type {number} */ (curr[j]) + 1, /** @type {number} */ (prev[j]) + (s1[i] === s2[j] ? 0 : 1));
      curr.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDist) return 999;
    prev = curr;
  }
  return /** @type {number} */ (prev[prev.length - 1]);
}

/** @param {string} token @param {string} word @param {number} maxDist */
function couldBeFuzzy(token, word, maxDist) {
  // The caller already restricted the length (including Chinese bigrams).
  if (token.length < 4) return true;
  /** @type {Record<string, number>} */
  const counts = Object.create(null);
  for (const ch of token) counts[ch] = (counts[ch] || 0) + 1;
  let diff = 0;
  for (const ch of word) {
    if (/** @type {number} */ (counts[ch]) > 0) counts[ch] = /** @type {number} */ (counts[ch]) - 1;
    else {
      diff += 1;
      if (diff > 2 * maxDist) return false;
    }
  }
  for (const ch of Object.keys(counts)) {
    diff += /** @type {number} */ (counts[ch]);
    if (diff > 2 * maxDist) return false;
  }
  return true;
}

/** @param {string} literal */
function escapeWildcardLiteral(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {string} pattern @returns {{test(text: string): boolean}} */
function compileFixedQuestionMatcher(pattern) {
  const tokens = Array.from(pattern);
  const fixed = new RegExp(tokens.map(char => char === "?" ? "." : escapeWildcardLiteral(char)).join(""), "i");
  const required = tokens.length < 128 ? [] : Array.from(new Set(tokens.filter(char => char !== "?")))
    .map(char => new RegExp(escapeWildcardLiteral(char), "i"));
  const pair = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;
  /** @type {RegExp | undefined} */
  let codepointFixed;
  return {test(text) {
    if (text.length > 4096) for (const literal of required) if (!literal.test(text)) return false;
    if (!pair.test(text)) return fixed.test(text);
    if (!codepointFixed) {
      // Use legacy /i, but prohibit boundaries inside surrogate pairs. The
      // guard makes the pair and dot alternatives mutually exclusive at each
      // valid position, so there is no variable-width wildcard backtracking.
      const boundary = String.raw`(?!(?<=[\uD800-\uDBFF])[\uDC00-\uDFFF])`;
      const dot = `(?:${pair.source}|.)` + boundary;
      const source = tokens.map(char => char === "?" ? dot : escapeWildcardLiteral(char)
        + (/^[\uD800-\uDBFF]$/.test(char) ? boundary : "")).join("");
      codepointFixed = new RegExp(boundary + source, "i");
    }
    return codepointFixed.test(text);
  }};
}

/** @param {string} pattern @returns {{test(text: string): boolean}} */
function compileWildcardMatcher(pattern) {
  const normalized = String(pattern || "");
  // Python's Unicode case-insensitive matcher equates Kelvin sign and long s
  // with ASCII k and s. JS non-unicode regex deliberately does not. Handle
  // these one-literal edge patterns without changing other /i rules.
  const special = normalized.replace(/^\*+|\*+$/g, "");
  if (normalized.includes("*") && /^[Kſ]$/.test(special)) {
    return new RegExp(special === "K" ? "[kK]" : "[sſ]", "i");
  }
  const questions = normalized.includes("?");
  if (questions && /^[*?]+$/.test(normalized)) {
    // Stars may match nothing; questions require adjacent non-newline code points.
    const requiredLength = normalized.replace(/\*/g, "").length;
    return {test(text) {
      if (text.length < requiredLength) return false;
      let run = 0;
      for (let i = 0; i < text.length; i++) {
        const code = text.codePointAt(i) ?? 0;
        if (code > 0xffff) i++;
        if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) run = 0;
        else if (++run >= requiredLength) return true;
      }
      return false;
    }};
  }
  if (questions && !normalized.includes("*")) return compileFixedQuestionMatcher(normalized);
  // Boundary stars may match zero characters in substring matching. Escaping
  // every remaining literal keeps regex work bounded and preserves /i rules.
  const core = normalized.replace(/^\*+|\*+$/g, "");
  if (core && !core.includes("*") && !core.includes("?")) {
    return new RegExp(escapeWildcardLiteral(core), "i");
  }
  if (core.includes("*") && !core.includes("?") && /^[\x00-\x7f]+$/.test(core) && !/[\n\r]/.test(core)) {
    // Match literal chunks in leftmost order within a single regex-dot line.
    // Searching each escaped chunk separately avoids wildcard backtracking.
    const chunks = core.split(/\*+/).map(part => new RegExp(escapeWildcardLiteral(part), "ig"));
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
  if (parts.length === 2 && ((/^\?+$/.test(/** @type {string} */ (parts[0])) && !/** @type {string} */ (parts[1]).includes("?"))
      || (/^\?+$/.test(/** @type {string} */ (parts[1])) && !/** @type {string} */ (parts[0]).includes("?")))) {
    return compileFixedQuestionMatcher(parts.join(""));
  }
  const collapsed = normalized.replace(/\*+/g, "*");
  // Star-only patterns keep their legacy UTF-16 literal matching.
  const tokens = questions ? Array.from(collapsed) : collapsed.split("");
  const literals = tokens.map(char => char === "*" || char === "?" ? null
    : new RegExp("^" + escapeWildcardLiteral(char) + "$", "i"));
  const required = Array.from(new Set(tokens.filter(char => char !== "*" && char !== "?")))
    .map(char => new RegExp(escapeWildcardLiteral(char), "i"));
  /** @type {Map<string, (boolean | null)[]>} */
  const masks = new Map();
  /** @param {string} char */
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
    // backtracking. For question globs, each row consumes one code point.
    let previous = new Uint8Array(tokens.length + 1);
    let current = new Uint8Array(tokens.length + 1);
    previous[0] = 1;
    for (let j = 0; j < tokens.length && tokens[j] === "*"; j++) previous[j + 1] = 1;
    if (previous[tokens.length]) return true;
    for (let i = 0; i < text.length;) {
      const width = questions && (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
      const char = width === 2 ? text.slice(i, i + 2) : text.charAt(i);
      i += width;
      const dot = char !== "\n" && char !== "\r" && char !== "\u2028" && char !== "\u2029";
      const mask = literalMask(char);
      current[0] = 1;
      for (let j = 0; j < tokens.length; j++) {
        if (tokens[j] === "*") {
          current[j + 1] = Number(current[j] || (dot && previous[j + 1]));
        } else {
          current[j + 1] = Number(previous[j] && (tokens[j] === "?" ? dot : mask[j]));
        }
      }
      if (current[tokens.length]) return true;
      [previous, current] = [current, previous];
    }
    return false;
  }};
}

/** @param {string} query @param {SearchParams} params */
function isExactSearch(query, params) {
  // An implicit literal query can still use fuzzy matching if it is one
  // ASCII term joined by common separators. Explicit exact always wins.
  return !!params.exact || (literalSearch(query) && !/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/i.test(query));
}

/** @param {unknown} input @returns {SearchRecord[]} */
function decodeSearchPayload(input) {
  if (!input || typeof input !== "object") throw protocolError("INVALID_CORPUS", "Search corpus must be an object");
  const data = /** @type {{v?: unknown, rp?: unknown, fd?: unknown, rc?: unknown}} */ (input);
  if (data.v !== 2 || !Array.isArray(data.rp) || !Array.isArray(data.fd) || !Array.isArray(data.rc)) {
    throw protocolError("UNSUPPORTED_CORPUS", "Expected compact-v2 search corpus");
  }
  /** @type {unknown[]} */
  const repos = data.rp;
  /** @type {unknown[]} */
  const folders = data.fd;
  /** @type {unknown[]} */
  const rows = data.rc;
  return rows.map((item) => {
    if (!Array.isArray(item) || item.length < 6) {
      return { Repo: "", File: "", Extension: "", Folder: [], Size: "", HasTxt: false };
    }
    /** @type {unknown[]} */
    const values = item;
    return {
      Repo: Number.isInteger(values[0]) && repos[/** @type {number} */ (values[0])] !== undefined ? repos[/** @type {number} */ (values[0])] : "",
      File: values[1] || "",
      Extension: values[2] || "",
      Folder: Number.isInteger(values[3]) && Array.isArray(folders[/** @type {number} */ (values[3])]) ? /** @type {unknown[]} */ (folders[/** @type {number} */ (values[3])]) : [],
      Size: values[4] === undefined ? "" : values[4],
      HasTxt: !!values[5],
    };
  });
}

/** @param {ReadableStream<Uint8Array>} stream @param {number} limit */
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

/** @param {string} url */
async function fetchGzipBytes(url) {
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
  const stream = /** @type {ReadableStream<BufferSource>} */ (new Response(compressed).body).pipeThrough(new DecompressionStream("gzip"));
  return readBoundedBytes(/** @type {ReadableStream<Uint8Array>} */ (stream), MAX_CORPUS_EXPANDED_BYTES);
}

function canFingerprintCorpus() {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof TextEncoder !== "undefined";
}

/** @param {Uint8Array<ArrayBuffer>} bytes */
function corpusFingerprintBytes(bytes) {
  return finishCorpusFingerprint(crypto.subtle.digest("SHA-256", bytes));
}

/** @param {Promise<ArrayBuffer>} contentHash */
async function finishCorpusFingerprint(contentHash) {
  const hash = await contentHash;
  // Keep snapshots isolated across runtime and Unicode-version changes.
  const runtime = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const versionHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SEARCH_SEMANTICS_VERSION + runtime));
  /** @param {ArrayBuffer} buffer */
  const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
  return "worker:" + hex(versionHash) + ":" + hex(hash);
}

/** @param {string} source */
async function corpusFingerprint(source) {
  if (!canFingerprintCorpus()) return null;
  return corpusFingerprintBytes(new TextEncoder().encode(source || ""));
}

/** @param {unknown} data @param {string | null} [fingerprint] @param {boolean} [fromJSON] */
async function installCorpus(data, fingerprint, fromJSON = false) {
  if (fingerprint === undefined) fingerprint = canFingerprintCorpus() ? await corpusFingerprint(JSON.stringify(data)) : null;
  const nextRecords = decodeSearchPayload(data);
  data = null;
  const result = replaceCorpus(nextRecords, fromJSON);
  snapshotGeneration = fingerprint;
  return result;
}

/** @param {string} url */
async function fetchGzipJSON(url) {
  /** @type {Uint8Array<ArrayBuffer> | null} */
  let expanded = await fetchGzipBytes(url);
  const source = new TextDecoder("utf-8", {fatal:true}).decode(expanded);
  // For valid UTF-8 the decoded text re-encodes to the original bytes, except
  // TextDecoder strips one leading UTF-8 BOM. Both byte caps count it as usual.
  const hasBOM = expanded[0] === 0xef && expanded[1] === 0xbb && expanded[2] === 0xbf;
  const pendingFingerprint = canFingerprintCorpus()
    ? corpusFingerprintBytes(hasBOM ? expanded.subarray(3) : expanded) : null;
  // Leave only the decoded text in this frame while WebCrypto settles.
  expanded = null;
  const fingerprint = await pendingFingerprint;
  return { data: /** @type {unknown} */ (JSON.parse(source)), fingerprint };
}

/** @param {SearchRecord} record @param {number} occurrence */
function stableRecordId(record, occurrence) {
  const path = (record.Folder || []).concat([record.File || "", record.Extension || ""]).join("/");
  return [record.Repo || "", path, String(occurrence)].join("\u001f");
}

/** @param {number} a @param {number} b */
function compareRecordName(a, b) {
  // Sort inputs are indices from the current corpus snapshot.
  return compareCodepoints(String(/** @type {SearchRecord} */ (records[a]).File || "").toLowerCase(), String(/** @type {SearchRecord} */ (records[b]).File || "").toLowerCase());
}

/** @param {number} a @param {number} b */
function compareRecordSize(a, b) {
  return (Number(/** @type {SearchRecord} */ (records[b]).Size) || 0) - (Number(/** @type {SearchRecord} */ (records[a]).Size) || 0) || compareRecordName(a, b);
}

/** @param {Record<string, number[]>} byRepo @param {number[]} order */
function populateRepoOrders(byRepo, order) {
  for (const repo of Object.keys(repoRecordIndices)) byRepo[repo] = [];
  // Repository buckets were initialized from the same snapshot. Appending in
  // global sort order preserves the same stable ties in each bucket.
  for (const index of order) /** @type {number[]} */ (byRepo[/** @type {string} */ (/** @type {SearchRecord} */ (records[index]).Repo)]).push(index);
}

function buildNameOrders() {
  if (nameOrderReady) return;
  // Ordinary decoded records have immutable string names; compute the key
  // once instead of lowercasing during every sort comparison.
  if (repoWildcardProofSafe) {
    const keys = records.map(record => String(record.File || "").toLowerCase());
    const hasSurrogate = keys.map(key => /[\uD800-\uDFFF]/.test(key));
    sortedByName = recordIndices.slice().sort((a, b) => {
      const left = /** @type {string} */ (keys[a]), right = /** @type {string} */ (keys[b]);
      return hasSurrogate[a] || hasSurrogate[b] ? compareCodepoints(left, right)
        : left < right ? -1 : left > right ? 1 : 0;
    });
  } else {
    sortedByName = recordIndices.slice().sort(compareRecordName);
  }
  repoSortedByName = Object.create(null);
  populateRepoOrders(repoSortedByName, sortedByName);
  nameOrderReady = true;
}

function buildSizeOrders() {
  if (sizeOrderReady) return;
  sortedBySize = recordIndices.slice().sort(compareRecordSize);
  repoSortedBySize = Object.create(null);
  populateRepoOrders(repoSortedBySize, sortedBySize);
  sizeOrderReady = true;
}

/** @param {number} expectedGeneration */
function scheduleSortOrders(expectedGeneration) {
  if (typeof setTimeout !== "function") return;
  sortBuildTimer = setTimeout(() => {
    sortBuildTimer = null;
    if (generation === expectedGeneration) {
      if (searchJobs.size) { scheduleSortOrders(expectedGeneration); return; }
      // Keep the useful name warmup, but never make incoming queries wait for
      // an unrelated second full-corpus sort. Size browse builds on demand.
      buildNameOrders();
    }
  }, SORT_PRECOMPUTE_DELAY_MS);
}

/** @param {SearchRecord} record @param {string} folderPath @param {number} occurrence */
function stableJSONRecordId(record, folderPath, occurrence) {
  // Parsed JSON arrays cannot shadow concat or its array-species constructor.
  // Preserve empty segments (including a leading slash for [""]).
  const path = (record.Folder.length ? folderPath + "/" : "") +
    [record.File || "", record.Extension || ""].join("/");
  return [record.Repo || "", path, String(occurrence)].join("\u001f");
}

/** @param {SearchRecord[]} nextRecords @param {boolean} [fromJSON] */
function replaceCorpus(nextRecords, fromJSON = false) {
  // Build all fallible metadata off to the side. A rejected corpus must never
  // expose its records under the previous generation or damage old indexes.
  /** @type {Record<string, number>} */
  const repoCounts = Object.create(null);
  /** @type {Record<string, number>} */
  const extensionCounts = Object.create(null);
  /** @type {Record<string, Record<string, number>>} */
  const extensionsByRepo = Object.create(null);
  /** @type {Record<string, number>} */
  const readerByRepo = Object.create(null);
  /** @type {Record<string, number>} */
  const idOccurrences = Object.create(null);
  /** @type {string[]} */
  const nextRecordIds = new Array(nextRecords.length);
  /** @type {number[]} */
  const nextRecordIndices = new Array(nextRecords.length);
  /** @type {Record<string, number[]>} */
  const nextRepoRecordIndices = Object.create(null);
  let nextRepoWildcardProofSafe = true;
  let nextExtensionSearchProofSafe = true;
  /** @type {number[]} */
  const nextReaderRecordIndices = [];
  /** @type {Record<string, number[]>} */
  const nextRepoReaderRecordIndices = Object.create(null);
  for (let i = 0; i < nextRecords.length; i++) {
    // Decoding constructs one record for each populated compact row.
    const record = /** @type {SearchRecord} */ (nextRecords[i]);
    if (typeof record.Repo !== "string" || typeof record.File !== "string"
        || !Array.isArray(record.Folder) || Array.prototype.some.call(record.Folder, part => typeof part !== "string")) {
      nextRepoWildcardProofSafe = false;
    }
    // Bracket access performs the legacy property-key coercion, including errors.
    const repo = /** @type {string} */ (record.Repo || "");
    nextRecordIndices[i] = i;
    if (!nextRepoRecordIndices[repo]) nextRepoRecordIndices[repo] = [];
    nextRepoRecordIndices[repo].push(i);
    if (typeof record.Extension !== "string") nextExtensionSearchProofSafe = false;
    const extension = String(record.Extension || "").toLowerCase();
    repoCounts[repo] = (repoCounts[repo] || 0) + 1;
    if (extension) {
      extensionCounts[extension] = (extensionCounts[extension] || 0) + 1;
      if (!extensionsByRepo[repo]) extensionsByRepo[repo] = Object.create(null);
      /** @type {Record<string, number>} */ (extensionsByRepo[repo])[extension] = (/** @type {Record<string, number>} */ (extensionsByRepo[repo])[extension] || 0) + 1;
    }
    if (NATIVE_READER_EXTENSIONS.has(extension)) {
      nextReaderRecordIndices.push(i);
      readerByRepo[repo] = (readerByRepo[repo] || 0) + 1;
      if (!nextRepoReaderRecordIndices[repo]) nextRepoReaderRecordIndices[repo] = [];
      nextRepoReaderRecordIndices[repo].push(i);
    }
    const folderPath = (record.Folder || []).join("/");
    const base = [repo, folderPath, record.File || "", record.Extension || ""].join("\u001f");
    const occurrence = idOccurrences[base] || 0;
    idOccurrences[base] = occurrence + 1;
    nextRecordIds[i] = fromJSON ? stableJSONRecordId(record, folderPath, occurrence) : stableRecordId(record, occurrence);
  }
  /** @type {SearchMetadata} */
  const nextMetadata = {
    count: nextRecords.length,
    repos: Object.keys(repoCounts).map((name) => ({ name, count: /** @type {number} */ (repoCounts[name]) })).sort((a, b) => a.name.localeCompare(b.name)),
    extensions: Object.keys(extensionCounts).sort().map((name) => ({ name, count: /** @type {number} */ (extensionCounts[name]) })),
    extensionsByRepo: Object.create(null),
    reader: { available: nextReaderRecordIndices.length > 0, count: nextReaderRecordIndices.length, byRepo: readerByRepo },
  };
  for (const repo of Object.keys(extensionsByRepo)) {
    const counts = /** @type {Record<string, number>} */ (extensionsByRepo[repo]);
    nextMetadata.extensionsByRepo[repo] = Object.keys(counts).sort().map((name) => ({ name, count: /** @type {number} */ (counts[name]) }));
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
  vocabByLength = new Map();
  vocabByLengthFilesOnly = new Map();
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

/** @param {number} limit @param {number} deadline */
function advanceFulltext(limit, deadline) {
  if (!fulltextBuild) fulltextBuild = { next: 0, all: Object.create(null), files: Object.create(null), folderTokens: new Map(), folderUnits: 0 };
  const build = fulltextBuild;
  const end = Math.min(records.length, build.next + limit);
  while (build.next < end) {
    const i = build.next++;
    const record = /** @type {SearchRecord} */ (records[i]);
    const folders = Array.isArray(record.Folder) ? record.Folder : [];
    const fileParts = tokenizeParts(record.File || "");
    const folderParts = folderTokenParts(build, folders.join(" "));
    // Preserve the original all-field alpha-before-Chinese insertion order.
    const allTokens = new Set(fileParts.alpha.concat(folderParts.alpha, fileParts.chinese, folderParts.chinese));
    for (const token of allTokens) {
      if (!build.all[token]) build.all[token] = [];
      /** @type {number[]} */ (build.all[token]).push(i);
    }
    for (const token of new Set(fileParts.alpha.concat(fileParts.chinese))) {
      if (!build.files[token]) build.files[token] = [];
      /** @type {number[]} */ (build.files[token]).push(i);
    }
    if (Date.now() >= deadline) break;
  }
  if (build.next < records.length) return;
  // Build vocabulary in bounded slices; reuse its keys for compaction.
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
  vocabByLength = build.allVocab.byLength;
  vocabByLengthFilesOnly = build.filesVocab.byLength;
  fulltextBuild = null;
}

/** @param {PostingIndex} index @returns {VocabularyBuild} */
function createVocabularyBuild(index) {
  return { keys: Object.keys(index), next: 0, byLength: new Map() };
}

/** @param {VocabularyBuild} build @param {number} deadline */
function advanceVocabulary(build, deadline) {
  let remaining = deadline === Infinity ? Infinity : 4096;
  while (build.next < build.keys.length) {
    if (remaining-- <= 0 || Date.now() >= deadline) return false;
    const token = /** @type {string} */ (build.keys[build.next++]);
    let bucket = build.byLength.get(token.length);
    if (!bucket) { bucket = []; build.byLength.set(token.length, bucket); }
    bucket.push(token);
  }
  return true;
}

/** @param {PostingIndex} index @param {PostingCompaction} build @param {number} deadline @param {PostingIndex | null} sharedIndex */
function advancePostingCompaction(index, build, deadline, sharedIndex = null) {
  let remaining = deadline === Infinity ? Infinity : FULLTEXT_COMPACT_BATCH_TOKENS;
  while (build.next < build.keys.length) {
    if (remaining-- <= 0 || Date.now() >= deadline) return false;
    const token = /** @type {string} */ (build.keys[build.next]);
    const posting = /** @type {Posting} */ (index[token]);
    const shared = sharedIndex && sharedIndex[token];
    // File postings are an ordered subset of all-field postings. Equal lengths
    // prove equal IDs, so immutable arrays can be shared without a second scan.
    index[token] = shared && shared.length === posting.length ? shared : Uint32Array.from(posting);
    build.next++;
  }
  return true;
}

/** @param {number} expectedGeneration @param {number} delay */
function scheduleFulltext(expectedGeneration, delay) {
  if (typeof setTimeout !== "function" || wordIndex) return;
  // Keep lazy construction on devices that explicitly report little memory.
  if (typeof navigator !== "undefined" && /** @type {WorkerNavigator & {deviceMemory: number}} */ (navigator).deviceMemory <= 2) return;
  fulltextBuildTimer = setTimeout(() => {
    if (generation !== expectedGeneration) return;
    fulltextBuildTimer = null;
    if (wordIndex) return;
    try {
      advanceFulltext(FULLTEXT_BATCH_RECORDS, Date.now() + FULLTEXT_BATCH_MS);
    } catch {
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
  return new Promise(/** @param {(value: void) => void} resolve */ resolve => { indexYieldQueue.push(resolve); /** @type {MessageChannel} */ (indexYieldChannel).port2.postMessage(null); });
}

/** @param {string} query @param {SearchParams} params */
function singleCharacterSearch(query, params) {
  // One code point has no fuzzy expansion: the complete literal scan also
  // includes filename, extension, repository and optional folder hits.
  return !params.exact && Array.from(query).length === 1 && !/[\s*?]/u.test(query);
}

/** @param {SearchJob} job */
function assertCurrentSearch(job) {
  // A cancelled job can also belong to a replaced corpus. Cancellation wins.
  if (job.cancelled) throw protocolError("SEARCH_CANCELLED", "Search cancelled");
  if (job.generation !== generation) throw protocolError("CORPUS_REPLACED", "Search corpus changed");
}

/** @param {SearchParams} params @param {SearchJob} job */
async function prepareSearchIndex(params, job) {
  const query = String(params.q || "").trim();
  if (wordIndex || !query || singleCharacterSearch(query, params) || isExactSearch(query, params)) return;
  if (fulltextBuildTimer !== null && typeof clearTimeout === "function") clearTimeout(fulltextBuildTimer);
  fulltextBuildTimer = null;
  try {
    while (!wordIndex) {
      assertCurrentSearch(job);
      advanceFulltext(FULLTEXT_BATCH_RECORDS, Date.now() + FULLTEXT_BATCH_MS);
      if (!wordIndex) await yieldSearchIndex();
    }
    assertCurrentSearch(job);
  } finally {
    if (!wordIndex && job.generation === generation && !fulltextBuildTimer && searchJobs.size <= 1) scheduleFulltext(generation, 4);
  }
}

/** @param {SearchParams} params */
function buildFilterSets(params) {
  const repos = /** @type {string[] | null} */ (params.repos || null);
  const extensions = /** @type {unknown[] | null} */ (params.extensions || null);
  const rawFolders = /** @type {unknown[] | null} */ (params.folders);
  const folders = rawFolders && rawFolders.length ? new Set(rawFolders.map(cleanPath)) : null;
  const singleFolder = folders?.size === 1 ? folders.values().next().value : "";
  return {
    repoSet: repos && repos.length ? new Set(repos) : null,
    extensionSet: extensions && extensions.length
      ? new Set(extensions.map((extension) => String(extension || "").toLowerCase()))
      : null,
    folders,
    folderPrefix: singleFolder ? singleFolder + "/" : null,
    selfFolders: new Set((/** @type {unknown[]} */ (params.folderSelfs || [])).map(cleanPath).filter((path) => typeof path === "string")),
    subtreeFolders: new Set((/** @type {unknown[]} */ (params.folderSubtrees || [])).map(cleanPath).filter((path) => typeof path === "string")),
  };
}

/** @param {unknown[]} recordFolders @param {string} folderPath @param {SearchParams} params @param {ReturnType<typeof buildFilterSets>} filters */
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

/** @param {SearchParams} params @returns {((index: number) => boolean) | null} */
function buildRecordFilter(params, filters = buildFilterSets(params)) {
  const hasFolderFilters = params.folderMatchMode === "mixed"
    ? filters.selfFolders.size || filters.subtreeFolders.size
    : !!filters.folders;
  if (!filters.repoSet && !filters.extensionSet && !hasFolderFilters
      && params.minSize == null && params.maxSize == null) return null;
  return (index) => {
    /** @type {Partial<SearchRecord>} */
    const record = records[index] || {};
    if (filters.repoSet && !filters.repoSet.has(/** @type {string} */ (record.Repo))) return false;
    if (filters.extensionSet && !filters.extensionSet.has(String(record.Extension || "").toLowerCase())) return false;
    if (hasFolderFilters) {
      const recordFolders = Array.isArray(record.Folder) ? record.Folder : [];
      const folderPath = recordFolders.join("/");
      if (!matchesFolderFilters(recordFolders, folderPath, params, filters)) return false;
    }
    if (typeof record.Size === "number" && record.Size >= 0) {
      if (params.minSize !== null && record.Size < /** @type {number} */ (params.minSize)) return false;
      if (params.maxSize !== null && record.Size > /** @type {number} */ (params.maxSize)) return false;
    }
    return true;
  };
}

/** @param {number[]} indices @param {SearchParams} params @param {ReturnType<typeof buildFilterSets>} [filters] */
function applyFilters(indices, params, filters) {
  const inScope = buildRecordFilter(params, filters);
  return inScope ? indices.filter(inScope) : indices.slice();
}

/** @param {SearchParams} params */
function filterEmptySearch(params) {
  const repos = params.repos;
  let scope = recordIndices;
  if (Array.isArray(repos) && repos.length === 1 && typeof repos[0] === "string" && repos[0]) {
    const repo = repos[0];
    scope = repoRecordIndices[repo] || [];
    if (params.folderMatchMode === "mixed") {
      // Peek without building an index or changing the directory LRU order.
      const directory = directoryIndexes.get(repo);
      if (directory?.canonicalPaths) {
        const filters = buildFilterSets(params);
        return applyFilters(warmFolderCandidates(directory, filters, scope.length) ?? scope, params, filters);
      }
    }
  }
  return applyFilters(scope, params);
}

/** @param {DirectoryIndex} directory @param {ReturnType<typeof buildFilterSets>} filters @param {number} scopeSize */
function warmFolderCandidates(directory, {selfFolders, subtreeFolders}, scopeSize) {
  // Leave broad selections to the scan; cap both traversal and ID sorting.
  const limit = Math.min(FOLDER_SEARCH_MAX, Math.floor(scopeSize / 4));
  let visits = selfFolders.size + subtreeFolders.size;
  if (!visits || visits > limit || subtreeFolders.has("")) return null;
  const paths = new Set(selfFolders);
  const pending = [];
  for (const path of subtreeFolders) {
    const node = directory.nodes[path];
    if (!node) continue;
    if (node.count > limit) return null;
    pending.push(node);
  }
  // On canonical paths, the directory edges are exactly the component
  // prefixes used by the predicate. Overlap is harmless and work is bounded.
  for (const node of pending) {
    if ((visits += node.children.length) > limit) return null;
    paths.add(node.path);
    for (const child of node.children) pending.push(child);
  }
  return collectDirectoryFiles(directory.files, paths, limit);
}

/** @param {DirectoryIndex["files"]} files @param {Set<string>} paths @param {number} limit */
function collectDirectoryFiles(files, paths, limit) {
  const lists = [];
  let count = 0;
  for (const path of paths) {
    const ids = files[path];
    if (!ids) continue;
    if ((count += ids.length) > limit) return null;
    lists.push(ids);
  }
  // Preflight bucket sizes before walking IDs. Each index is in one bucket;
  // restore source order for relevance and stable name/size ties.
  const candidates = [];
  for (const ids of lists) for (const id of ids) candidates.push(id);
  return candidates.sort((a, b) => a - b);
}

/** @param {unknown} path */
function cleanPath(path) {
  return String(path || "").replace(/^\/+|\/+$/g, "");
}

/** @param {unknown} input */
function exactSearchScope(input) {
  const repos = /** @type {string[] | undefined | null} */ (input);
  if (!repos?.length) return recordIndices;
  const unique = Array.from(new Set(repos));
  if (unique.length === 1) return repoRecordIndices[/** @type {string} */ (unique[0])] || [];
  const indices = [];
  for (const repo of unique) for (const index of repoRecordIndices[repo] || []) indices.push(index);
  return indices.sort((a, b) => a - b);
}

/** @param {string} term @param {SearchParams} params @param {number} scopeSize @param {number} [maxIndices] */
function indexedExactCandidates(term, params, scopeSize, maxIndices = EXACT_INDEX_MAX_INDICES) {
  if (!wordIndex || !repoWildcardProofSafe || !extensionSearchProofSafe || !scopeSize) return null;
  const repos = /** @type {unknown[] | null | undefined} */ (params.repos);
  if (repos?.length && (!Array.isArray(repos) || repos.some(repo => typeof repo !== "string"))) return null;
  const selected = repos?.length ? new Set(repos) : null;
  const index = /** @type {PostingIndex} */ (params.searchFolders === false ? wordIndexFilesOnly : wordIndex);
  let best = null;
  let bestSize = Math.min(maxIndices, Math.floor(scopeSize / 2));
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
  // Postings and metadata are published from the same corpus generation.
  for (const id of best.posting) if (!selected || selected.has(/** @type {string} */ (/** @type {SearchRecord} */ (records[id]).Repo))) candidates.add(id);
  for (const repo of best.repoMatches) for (const id of /** @type {number[]} */ (repoRecordIndices[repo.name])) candidates.add(id);
  return Array.from(candidates).sort((a, b) => a - b);
}

/** @param {SearchParams} params */
function emptySearchOrder(params) {
  const repos = /** @type {string[]} */ (params.repos || []);
  if (repos.length > 1) return null;
  if ((params.extensions && /** @type {unknown[]} */ (params.extensions).length)
      || (params.folders && /** @type {unknown[]} */ (params.folders).length)
      || (params.folderSelfs && /** @type {unknown[]} */ (params.folderSelfs).length)
      || (params.folderSubtrees && /** @type {unknown[]} */ (params.folderSubtrees).length)
      || params.minSize != null
      || params.maxSize != null) return null;
  const repo = repos.length === 1 ? repos[0] : null;
  if (params.sort === "name") {
    buildNameOrders();
    return repo ? (repoSortedByName[repo] || []) : sortedByName;
  }
  if (params.sort === "size") {
    buildSizeOrders();
    return repo ? (repoSortedBySize[repo] || []) : sortedBySize;
  }
  return repo ? (repoRecordIndices[repo] || []) : recordIndices;
}

/** @param {number[]} indices @param {string} anchorId */
function findSearchAnchor(indices, anchorId) {
  const owner = searchAnchorOwners.get(indices) || {};
  const cached = searchAnchorCache.get(owner);
  if (cached?.has(anchorId)) {
    const index = /** @type {number} */ (cached.get(anchorId));
    cached.delete(anchorId); cached.set(anchorId, index);
    searchAnchorCache.delete(owner); searchAnchorCache.set(owner, cached);
    return index;
  }
  const separator = anchorId.indexOf("\0");
  const anchorRepo = anchorId.slice(0, separator), anchorPath = anchorId.slice(separator + 1);
  const index = separator < 0 ? -1 : indices.findIndex(index => {
    const record = /** @type {SearchRecord} */ (records[index]);
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
    while (searchAnchorCache.size > SEARCH_ANCHOR_ORDER_MAX) searchAnchorCache.delete(/** @type {object} */ (searchAnchorCache.keys().next().value));
  }
  return index;
}

/** @param {number[]} indices @param {SearchParams} params */
function pageResult(indices, params) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(params.pageSize) || 100));
  const pageItems = indices.slice((page - 1) * pageSize, page * pageSize);
  /** @type {{records: SearchRecord[], ids: string[], total: number, page: number, pageSize: number, generation: number, snapshot_generation: string, anchor_index?: number}} */
  const result = {
    // Search orders and IDs refer to the same published corpus.
    records: pageItems.map((index) => /** @type {SearchRecord} */ (records[index])),
    ids: pageItems.map((index) => /** @type {string} */ (recordIds[index])),
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

/** @param {SearchParams} params */
function searchOrderKey(params) {
  const cacheParams = Object.assign({}, params);
  delete cacheParams.page;
  delete cacheParams.pageSize;
  delete cacheParams.anchorId;
  return JSON.stringify(cacheParams);
}

/** @param {number} index @param {string[]} tokens @param {boolean} searchFolders */
function relevanceScore(index, tokens, searchFolders) {
  const fields = getRecordSearchFields(records[index] || {});
  let score = 0;
  for (const token of tokens) {
    if (fields.file.includes(token)) score += 3;
    if (searchFolders && fields.folder.includes(token)) score += 2;
    if (fields.repo.includes(token)) score += 1;
  }
  return score;
}

/** @param {number[]} indices @param {string[]} tokens @param {boolean} searchFolders */
function orderByRelevance(indices, tokens, searchFolders) {
  // For many matches and few tokens, scores have a small integer range.
  // Appending in match order keeps ties stable without allocating scored rows.
  if (indices.length >= 1024 && tokens.length <= 8) {
    const buckets = Array.from({length: tokens.length * 6 + 1}, () => /** @type {number[]} */ ([]));
    for (const index of indices) {
      const bucket = /** @type {number[]} */ (buckets[relevanceScore(index, tokens, searchFolders)]);
      bucket.push(index);
    }
    return /** @type {number[]} */ ([]).concat(...buckets.reverse());
  }
  const scored = indices.map(index => ({ index, score: relevanceScore(index, tokens, searchFolders) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map(item => item.index);
}

/** @param {ReturnType<typeof getRecordSearchFields>} fields @param {string} lower @param {boolean} searchFolders */
function matchesLiteralFields(fields, lower, searchFolders) {
  return fields.file.includes(lower) || fields.repo.includes(lower) || (searchFolders && fields.folder.includes(lower));
}

/** @param {ReturnType<typeof getRecordSearchFields>} fields @param {{test(text: string): boolean}} pattern @param {boolean} searchFolders */
function matchesWildcardFields(fields, pattern, searchFolders) {
  return pattern.test(fields.file) || pattern.test(fields.repo) || (searchFolders && pattern.test(fields.folder));
}

/** @param {string} query @param {SearchParams} params @param {boolean} searchFolders */
function exactSearchMatches(query, params, searchFolders) {
  // Apply terms in order; unlike the cooperative scan, compile a later term
  // only if earlier terms did not exhaust the scope.
  const terms = query.split(/\s+/).filter(Boolean);
  // Borrow the scope: each term filter is nonmutating.
  let matched = exactSearchScope(params.repos);
  for (let termIndex = 0; termIndex < terms.length; termIndex++) {
    const term = /** @type {string} */ (terms[termIndex]);
    const wildcard = term.includes("*") || term.includes("?");
    const lower = term.toLowerCase();
    if (wildcard && term.replace(/\*/g, "") === "") continue;
    const pattern = wildcard ? compileWildcardMatcher(term) : null;
    if (termIndex === 0) matched = seedExactSearch(term, terms, query, params, matched);
    // Avoid proving universal terms against all repos when nothing can match.
    if (!matched.length) break;
    // Every indexed Repo is a complete field in every candidate. If the
    // matcher accepts all of them, this AND term cannot remove a record.
    // For a small scope, the existing scan is cheaper than proving all repos.
    if (repoWildcardProofSafe && matched.length >= metadata.repos.length
        && pattern && term.includes("*") && term.includes("?") && /^[*?]+$/.test(term)
        && Object.keys(repoRecordIndices).every(repo => pattern.test(repo.toLowerCase()))) continue;
    matched = matched.filter(index => {
      const fields = getRecordSearchFields(records[index] || {});
      return pattern ? matchesWildcardFields(fields, pattern, searchFolders) : matchesLiteralFields(fields, lower, searchFolders);
    });
    if (!matched.length) break;
  }
  return matched;
}

/** @param {string} term @param {string[]} terms @param {string} query @param {SearchParams} params @param {number[]} scope */
function seedExactSearch(term, terms, query, params, scope) {
  const indexed = indexedExactCandidates(term, params, scope.length);
  if (indexed !== null) return indexed;
  if (!wordIndex || !scope.length || terms.length <= 1
      || terms.length > EXACT_INDEX_LOOKAHEAD_MAX_TERMS || /[*?]/.test(query)) return scope;
  // A first term without a seed may still reject quickly, so cap the extra
  // probes. The first proven superset (even empty) retains source order.
  for (let i = 1; i < terms.length; i++) {
    const later = /** @type {string} */ (terms[i]);
    if (later.length > EXACT_INDEX_LOOKAHEAD_MAX_TERM_UNITS || terms.indexOf(later) !== i
        || !/[\u3400-\u4dbf\u4e00-\u9fff]{2}/.test(later)) continue;
    const seed = indexedExactCandidates(later, params, scope.length, EXACT_INDEX_LOOKAHEAD_MAX_INDICES);
    if (seed !== null) return seed;
  }
  return scope;
}

/** @param {SearchParams} params @param {number[] | null} preparedExact */
function searchLocal(params, preparedExact = null) {
  const query = String(params.q || "").trim();
  const searchFolders = params.searchFolders !== false;
  const cacheKey = searchOrderKey(params);
  let ordered = searchOrderCache.get(cacheKey);
  if (ordered) {
    searchOrderCache.delete(cacheKey);
    searchOrderCache.set(cacheKey, ordered);
    return pageResult(ordered, params);
  }
  let filtered;
  let exact;
  if (!query) {
    const order = emptySearchOrder(params);
    if (order !== null) return pageResult(order, params);
    filtered = filterEmptySearch(params);
  } else if ((singleCharacterSearch(query, params) && preparedExact !== null) || (exact = isExactSearch(query, params))) {
    // Copy a borrowed scope before any in-place result sort.
    filtered = applyFilters(preparedExact ?? exactSearchMatches(query, params, searchFolders), params);
  } else {
    buildFulltext();
    const activeIndex = /** @type {PostingIndex} */ (searchFolders ? wordIndex : wordIndexFilesOnly);
    const activeVocab = searchFolders ? vocabByLength : vocabByLengthFilesOnly;
    const scope = exactSearchScope(params.repos);
    const inScope = buildRecordFilter(params);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const termCandidates = [];
    // Repeated AND terms share candidates; retain the original term count
    // below because single-term literal hits suppress fuzzy expansion.
    for (const term of new Set(terms)) {
      // A literal hit may come from Repo or an unindexed substring while
      // another term needs fuzzy postings. Union within each term before AND.
      const literalScope = indexedExactCandidates(term, params, scope.length) ?? scope;
      const seen = new Set();
      for (const index of literalScope) {
        const fields = getRecordSearchFields(/** @type {SearchRecord} */ (records[index]));
        if (matchesLiteralFields(fields, term, searchFolders) && (!inScope || inScope(index))) seen.add(index);
      }
      const tokenCandidates = [];
      let sortedCandidates = true;
      for (const token of tokenize(term)) {
        let candidates = activeIndex[token] || [];
        // Only an exact posting in the selected scope can block expansion.
        // Probe lazily: one eligible posting is enough, and the intersection
        // can still use the original sorted list before final filtering.
        if (!(candidates.length && (!inScope || candidates.some(inScope)))
            && !(terms.length === 1 && seen.size)) {
          sortedCandidates = false;
          const fuzzy = new Set();
          const maxDist = fuzzyDistanceBudget(token);
          if (maxDist) {
            // Match editDistance's UTF-16 lengths. Chinese bigrams only
            // compare with equal-length words; single units have no budget.
            const radius = isChineseToken(token) ? 0 : maxDist;
            for (let length = token.length - radius; length <= token.length + radius; length++) {
              const words = activeVocab.get(length);
              if (!words) continue;
              for (const word of words) {
                if (couldBeFuzzy(token, word, maxDist) && editDistance(token, word, maxDist) <= maxDist) {
                  for (const index of activeIndex[word] || []) fuzzy.add(index);
                }
              }
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
      for (const index of intersectCandidateLists(tokenCandidates, sortedCandidates)) seen.add(index);
      // Intersection and union above only determine membership. Restore
      // record order before AND and scoring, so vocabulary order cannot affect ties.
      termCandidates.push(Array.from(seen).sort((a, b) => a - b));
      if (!seen.size) break;
    }
    const matched = intersectCandidateLists(termCandidates, true);
    filtered = inScope ? matched.filter(inScope) : matched;
  }
  if (params.sort === "name" || params.sort === "size") {
    ordered = orderByNameOrSize(filtered, query, params, exact);
  } else if (!query || /^[*?]+$/.test(query)) {
    // These queries have no score tokens, so stable relevance keeps this order.
    ordered = filtered;
  } else {
    ordered = orderByRelevance(filtered, tokenize(query), searchFolders);
  }
  searchOrderCache.set(cacheKey, ordered);
  while (searchOrderCache.size > SEARCH_ORDER_CACHE_MAX) searchOrderCache.delete(/** @type {string} */ (searchOrderCache.keys().next().value));
  return pageResult(ordered, params);
}

/** @param {number[]} filtered @param {string} query @param {SearchParams} params @param {boolean | undefined} exact */
function orderByNameOrSize(filtered, query, params, exact) {
  const repos = /** @type {string[]} */ (params.repos || []);
  const byName = params.sort === "name";
  const ready = byName ? nameOrderReady : sizeOrderReady;
  const byRepo = byName ? repoSortedByName : repoSortedBySize;
  // Keep the bucket lookup before the reuse proof: raw repo keys can throw
  // during coercion, even when the order is cold or not eligible for reuse.
  const order = repos.length === 1 ? (byRepo[/** @type {string} */ (repos[0])] || []) : null;
  // Exact single-repo matches retain source order, so stable name ties match
  // the prepared repository order. Fuzzy, unusual and cold paths still sort.
  // A prepared single character skipped classification. Punctuation can
  // still qualify as implicit exact, but an ordinary letter cannot.
  const exactSingleRepoName = query && byName && (exact ?? isExactSearch(query, params))
    && repoWildcardProofSafe && Array.isArray(repos) && repos.length === 1
    && typeof repos[0] === "string" && repos[0];
  if ((!query || exactSingleRepoName) && ready && order && filtered.length <= SORT_REUSE_MAX_INDICES
      && filtered.length * 3 > order.length * 2) {
    const keep = new Set(filtered);
    return order.filter(index => keep.has(index));
  }
  return filtered.sort(byName ? compareRecordName : compareRecordSize);
}

/** @param {SearchParams} params @param {SearchJob} job @param {"character" | "wildcard"} kind */
async function prepareLiteralScan(params, job, kind) {
  const query = String(params.q || "").trim();
  /** @type {(fields: ReturnType<typeof getRecordSearchFields>) => boolean} */
  let matches;
  if (kind === "character") {
    if (!singleCharacterSearch(query, params)) return null;
    const lower = query.toLowerCase();
    matches = fields => matchesLiteralFields(fields, lower, params.searchFolders !== false);
  } else {
    // Keep short globs on the synchronous path, including repository proofs.
    if (query.length < 32 || !/[*?]/.test(query)
        || query.split(/\s+/).every(term => /^\*+$/.test(term))) return null;
    if (searchOrderCache.has(searchOrderKey(params))) return null;
    const terms = query.split(/\s+/).filter(Boolean).map(term => ({
      lower: term.toLowerCase(),
      matcher: /[*?]/.test(term) ? compileWildcardMatcher(term) : null,
    }));
    matches = fields => terms.every(({lower, matcher}) => matcher
      ? matchesWildcardFields(fields, matcher, params.searchFolders !== false)
      : matchesLiteralFields(fields, lower, params.searchFolders !== false));
  }
  // Both cooperative scans visit records in source order and checkpoint at
  // the same batch boundaries, including empty scopes and the final batch.
  const scope = exactSearchScope(params.repos);
  const matched = [];
  for (let start = 0; start < scope.length; start += FULLTEXT_BATCH_RECORDS) {
    assertCurrentSearch(job);
    const end = Math.min(scope.length, start + FULLTEXT_BATCH_RECORDS);
    for (let offset = start; offset < end; offset++) {
      const index = /** @type {number} */ (scope[offset]);
      const fields = getRecordSearchFields(/** @type {SearchRecord} */ (records[index]));
      if (matches(fields)) matched.push(index);
    }
    if (end < scope.length) await yieldSearchIndex();
  }
  assertCurrentSearch(job);
  return matched;
}

/** @param {SearchParams} params */
function randomRecord(params) {
  if (params.txtOnly) throw protocolError("LEGACY_TXT_RETIRED", "Legacy OCR TXT selection is retired");
  const repo = /** @type {string} */ (params.repo || "");
  const readerOnly = !!params.readerOnly;
  let candidates;
  if (readerOnly) candidates = repo ? (repoReaderRecordIndices[repo] || []) : readerRecordIndices;
  else if (repo) candidates = repoRecordIndices[repo] || [];
  else candidates = recordIndices;
  if (!candidates.length) return { record: null, id: null, generation };
  // NaN previously indexed the array with the string "NaN", returning missing
  // record/id fields. Treat it like an absent randomValue instead.
  const randomValue = typeof params.randomValue === "number" && !Number.isNaN(params.randomValue) ? params.randomValue : Math.random();
  const index = /** @type {number} */ (candidates[Math.min(candidates.length - 1, Math.floor(Math.max(0, randomValue) * candidates.length))]);
  return { record: records[index], id: recordIds[index], generation };
}

/** @param {SearchParams} params */
function folderContents(params) {
  const repo = /** @type {string} */ (params.repo || "");
  const path = cleanPath(params.path);
  const directory = getDirectoryIndex(repo);
  const node = directory.nodes[path];
  const files = (directory.files[path] || []).map(index => {
    const record = /** @type {SearchRecord} */ (records[index]);
    return { name: record.File || "", ext: record.Extension || "", size: record.Size || "" };
  });
  return {
    folders: (node ? node.children.slice() : []).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map(child => ({ name: child.name, path: child.path, count: child.count })),
    files: files.sort((a, b) => /** @type {{localeCompare(value: unknown): number}} */ (a.name).localeCompare(b.name)),
    current_path: path,
    generation,
  };
}

/** @param {unknown[]} folders */
function canonicalDirectoryPath(folders) {
  // A compact folder array can be shared by many records. Older workers may
  // not have Object.hasOwn, and a legacy array may shadow slice/constructor.
  const own = Object.prototype.hasOwnProperty;
  if (own.call(folders, "slice") || own.call(folders, "constructor")) return false;
  for (const part of folders) if (typeof part !== "string" || !part || part.includes("/")) return false;
  return true;
}

/** @param {string} repo */
function getDirectoryIndex(repo) {
  const cached = directoryIndexes.get(repo);
  if (cached) {
    directoryIndexes.delete(repo);
    directoryIndexes.set(repo, cached);
    return cached;
  }
  /** @type {DirectoryNode} */
  const root = { name: /** @type {string} */ (repo.split("/").pop()), path: "", children: [], count: 0, isRoot: true, hasDirectFiles: false };
  /** @type {Record<string, DirectoryNode>} */
  const nodes = Object.create(null);
  /** @type {Record<string, number[]>} */
  const directFiles = Object.create(null);
  const checkedFolders = new WeakSet();
  let canonicalPaths = true;
  nodes[""] = root;
  for (const index of repoRecordIndices[repo] || []) {
    const record = /** @type {SearchRecord} */ (records[index]);
    root.count++;
    const folders = record.Folder || [];
    // The fast path needs the predicate's slice prefixes to match these edges.
    // Prove this only for the repository whose directory is already being built.
    if (canonicalPaths && !checkedFolders.has(folders)) {
      canonicalPaths = canonicalDirectoryPath(folders);
      if (canonicalPaths) checkedFolders.add(folders);
    }
    let path = "";
    for (const part of folders) {
      // Preserve the original value; concatenation and property access coerce it.
      const name = /** @type {string} */ (part);
      // Every traversed parent was created on the preceding iteration.
      const parent = /** @type {DirectoryNode} */ (nodes[path]);
      path = path ? path + "/" + name : name;
      if (!nodes[path]) {
        nodes[path] = { name, path, children: [], count: 0, hasDirectFiles: false };
        parent.children.push(/** @type {DirectoryNode} */ (nodes[path]));
      }
      /** @type {DirectoryNode} */ (nodes[path]).count++;
    }
    /** @type {DirectoryNode} */ (nodes[path]).hasDirectFiles = true;
    if (!directFiles[path]) directFiles[path] = [];
    /** @type {number[]} */ (directFiles[path]).push(index);
  }
  for (const path of Object.keys(nodes)) {
    const node = /** @type {DirectoryNode} */ (nodes[path]);
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.hasChildren = node.children.length > 0;
    node.showSelfToggle = node.hasDirectFiles && node.hasChildren;
  }
  const directory = { tree: root.count ? [root] : [], nodes, files: directFiles, canonicalPaths };
  // Unknown repositories do not consume cache capacity. Stored file indices are
  // disjoint across repositories and therefore bounded by the loaded corpus.
  if (root.count) {
    directoryIndexes.set(repo, directory);
    while (directoryIndexes.size > DIRECTORY_INDEX_MAX) directoryIndexes.delete(/** @type {string} */ (directoryIndexes.keys().next().value));
  }
  return directory;
}

/** @param {SearchParams} params */
function folderTree(params) {
  return { tree: getDirectoryIndex(/** @type {string} */ (params.repo || "")).tree, generation };
}

/** @param {string} code @param {string} message */
function protocolError(code, message) {
  return Object.assign(new Error(message), {code});
}

/** @param {unknown} type @param {unknown} input @param {SearchJob} job */
async function dispatch(type, input, job) {
  // Property access on primitives is intentional; replacing it with validation
  // would change legacy errors and the order in which they are reported.
  const payload = /** @type {Record<string, unknown>} */ (input);
  if (type === "handshake") return { protocol: WORKER_PROTOCOL_VERSION };
  if (type === "cancel-search") {
    const pending = searchJobs.get(payload.requestId);
    if (pending) pending.cancelled = true;
    return {cancelled: !!pending};
  }
  if (type === "load-corpus") {
    const {data, fingerprint} = await fetchGzipJSON(/** @type {string} */ (payload.url));
    return installCorpus(data, fingerprint, true);
  }
  if (type === "replace-corpus") return installCorpus(payload.data);
  // A successfully installed compact corpus can contain zero records.
  if (generation === 0) throw protocolError("CORPUS_NOT_READY", "Search corpus is not ready");
  if (type === "metadata") return Object.assign({ generation }, metadata);
  if (type === "local-search") {
    // The protocol historically forwards raw options, including unusual values.
    // Keep that behavior, with the assertion isolated to this operation.
    const params = /** @type {SearchParams} */ (payload);
    if (Array.from(String(params.q || "")).length > 256)
      throw protocolError("QUERY_TOO_LONG", "Search query exceeds 256 characters");
    // A complete cached order already includes filtering and sorting. Serve it
    // before a cooperative single-character scan can revisit the whole corpus.
    if (searchOrderCache.has(searchOrderKey(params))) {
      assertCurrentSearch(job);
      return searchLocal(params);
    }
    await prepareSearchIndex(params || {}, job);
    const prepared = await prepareLiteralScan(params || {}, job, "character")
      ?? await prepareLiteralScan(params || {}, job, "wildcard");
    assertCurrentSearch(job);
    return searchLocal(params || {}, prepared);
  }
  if (type === "random-record") return randomRecord(/** @type {SearchParams} */ (payload) || {});
  if (type === "folder-contents") return folderContents(/** @type {SearchParams} */ (payload) || {});
  if (type === "folder-tree") return folderTree(/** @type {SearchParams} */ (payload) || {});
  throw protocolError("UNKNOWN_REQUEST", "Unknown Worker request: " + /** @type {string} */ (type));
}

self.addEventListener("message", async function(event) {
  const message = /** @type {Record<string, unknown>} */ (/** @type {MessageEvent<unknown>} */ (event).data || {});
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
  } catch (caught) {
    const error = /** @type {{code?: string, message?: string} | null} */ (caught);
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

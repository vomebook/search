function tokenize(text) {
  const tokens = [];
  const lower = String(text || "").toLowerCase();
  const alpha = lower.match(/[a-z0-9]+/g);
  if (alpha) tokens.push.apply(tokens, alpha);
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

function wildcardPatternToRegExp(pattern) {
  const escaped = String(pattern || "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\*/g, ".*").replace(/\?/g, "."), "i");
}

function literalSearch(query) {
  return /[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf\s]/i.test(String(query || ""));
}

let records = [];
let wordIndex = {};
let wordIndexFilesOnly = {};
let vocabSorted = [];
let vocabSortedFilesOnly = [];

function applyFilters(indices, params) {
  const repos = params.repos || null;
  const extensions = params.extensions || null;
  const folders = params.folders || null;
  const selfFolders = new Set((params.folderSelfs || []).map((p) => String(p || "").replace(/^\/+|\/+$/g, "")).filter(Boolean));
  const subtreeFolders = new Set((params.folderSubtrees || []).map((p) => String(p || "").replace(/^\/+|\/+$/g, "")).filter(Boolean));
  return indices.filter((idx) => {
    const rec = records[idx] || {};
    if (repos && repos.length && !repos.includes(rec.Repo)) return false;
    if (extensions && extensions.length && !extensions.includes(String(rec.Extension || "").toLowerCase())) return false;
    const foldersOfRecord = Array.isArray(rec.Folder) ? rec.Folder : [];
    const folderPath = foldersOfRecord.join("/");
    if (params.folderMatchMode === "mixed") {
      let matched = selfFolders.has(folderPath);
      for (let d = 1; !matched && d <= foldersOfRecord.length; d++) matched = subtreeFolders.has(foldersOfRecord.slice(0, d).join("/"));
      if ((selfFolders.size || subtreeFolders.size) && !matched) return false;
    } else if (folders && folders.length) {
      let matched = false;
      for (const folder of folders) {
        const clean = String(folder || "").replace(/^\/+|\/+$/g, "");
        if (params.folderMatchMode === "exact") matched = folderPath === clean;
        else if (!clean) matched = foldersOfRecord.length === 0;
        else for (let d = 0; d <= foldersOfRecord.length; d++) if ((d ? foldersOfRecord.slice(0, d).join("/") : "") === clean) matched = true;
        if (matched) break;
      }
      if (!matched) return false;
    }
    if (typeof rec.Size === "number" && rec.Size > 0) {
      if (params.minSize !== null && rec.Size < params.minSize) return false;
      if (params.maxSize !== null && rec.Size > params.maxSize) return false;
    }
    return true;
  });
}

function searchLocal(params) {
  const query = String(params.q || "").trim();
  const searchFolders = params.searchFolders !== false;
  const activeIndex = searchFolders ? wordIndex : wordIndexFilesOnly;
  const activeVocab = searchFolders ? vocabSorted : vocabSortedFilesOnly;
  let matched = [];
  if (!query) {
    matched = Array.from({ length: records.length }, (_, i) => i);
  } else if (params.exact || literalSearch(query)) {
    const wildcard = query.includes("*") || query.includes("?");
    const pattern = wildcard ? wildcardPatternToRegExp(query) : null;
    const lower = query.toLowerCase();
    for (let i = 0; i < records.length; i++) {
      const rec = records[i] || {};
      const file = String(rec.File || "").toLowerCase();
      const repo = String(rec.Repo || "").toLowerCase();
      const folder = (Array.isArray(rec.Folder) ? rec.Folder : []).join("/").toLowerCase();
      if ((pattern ? pattern.test(file) || pattern.test(repo) || (searchFolders && pattern.test(folder)) : file.includes(lower) || repo.includes(lower) || (searchFolders && folder.includes(lower)))) matched.push(i);
    }
  } else {
    let tokenMatches = null;
    for (const token of tokenize(query)) {
      let candidates = activeIndex[token] || [];
      if (!candidates.length) {
        const fuzzy = [];
        for (const [vocab] of activeVocab) {
          if (Math.abs(vocab.length - token.length) <= 2 && editDistance(token, vocab, 2) <= 2) fuzzy.push(...(activeIndex[vocab] || []));
          if (fuzzy.length >= 200) break;
        }
        candidates = [...new Set(fuzzy)];
      }
      const candidateSet = new Set(candidates);
      tokenMatches = tokenMatches === null ? candidates.slice() : tokenMatches.filter((idx) => candidateSet.has(idx));
      if (!tokenMatches.length) break;
    }
    matched = tokenMatches || [];
  }
  let filtered = applyFilters(matched, params);
  const tokens = tokenize(query);
  const scored = filtered.map((idx) => {
    const rec = records[idx] || {};
    let score = 0;
    const file = String(rec.File || "").toLowerCase();
    const repo = String(rec.Repo || "").toLowerCase();
    const folder = (Array.isArray(rec.Folder) ? rec.Folder : []).join("/").toLowerCase();
    for (const token of tokens) { if (file.includes(token)) score += 3; if (searchFolders && folder.includes(token)) score += 2; if (repo.includes(token)) score += 1; }
    return { idx, score };
  });
  if (params.sort === "name") scored.sort((a, b) => String(records[a.idx].File || "").localeCompare(String(records[b.idx].File || ""), "zh"));
  else if (params.sort === "size") scored.sort((a, b) => (Number(records[b.idx].Size) || 0) - (Number(records[a.idx].Size) || 0));
  else if (query) scored.sort((a, b) => b.score - a.score);
  const page = params.page || 1;
  const pageSize = params.pageSize || 100;
  return { indices: scored.slice((page - 1) * pageSize, page * pageSize).map((item) => item.idx), total: scored.length, page, pageSize };
}

self.addEventListener("message", function(event) {
  const data = event.data || {};
  if (data.type === "init-records") {
    records = Array.isArray(data.records) ? data.records : [];
    self.postMessage({ type: "records-ready" });
    return;
  }
  if (data.type === "local-search") {
    try {
      self.postMessage({ type: "local-search-result", id: data.id, result: searchLocal(data.params || {}) });
    } catch (err) {
      self.postMessage({ type: "local-search-result", id: data.id, error: String(err && err.message || err) });
    }
    return;
  }
  if (data.type !== "build-fulltext") return;
  if (Array.isArray(data.records)) records = data.records;
  wordIndex = {};
  wordIndexFilesOnly = {};
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] || {};
    const folders = Array.isArray(rec.Folder) ? rec.Folder : [];
    const tokens = tokenize([rec.File || ""].concat(folders).join(" "));
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
  vocabSorted = Object.keys(wordIndex).map((tok) => [tok, wordIndex[tok].length]).sort((a, b) => b[1] - a[1]);
  vocabSortedFilesOnly = Object.keys(wordIndexFilesOnly).map((tok) => [tok, wordIndexFilesOnly[tok].length]).sort((a, b) => b[1] - a[1]);
  self.postMessage({
    type: "fulltext-ready",
  });
});

/**
 * VoiceOfML Search — Static Edition
 * Hash Router | In-Memory Search Index | GitHub Pages
 */
 
/* ═══════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════ */
 
const DATA_URL = "data/search_data.json.gz";
const TXT_BASE = "https://huggingface.co/spaces/VoiceOfML/Search/txt";
 
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
 
/* ═══════════════════════════════════════════════════════════
   Data & Index (In-Memory)
   ========================================================== */
 
let RECORDS = [];
let wordIndex = {};
let wordIndexFilesOnly = {};
let extensionCounts = {};
let repoCounts = {};
let folderIndex = {};
let didYouMeanVocab = {};
let didYouMeanVocabFilesOnly = {};
let didYouMeanSorted = [];
let didYouMeanSortedFilesOnly = [];
let repoList = [];
let extensionList = [];
 
function tokenize(text) {
  const tokens = [];
  const lower = text.toLowerCase();

  // ── English / numbers ──
  const alpha = lower.match(/[a-z0-9]+/g);
  if (alpha) tokens.push(...alpha);

  // ── Chinese (jieba-wasm, with fallback) ──
  // Mirror huggingface's tokenize: strip non-CJK, feed to jieba.lcut
  var chineseText = lower.replace(/[a-z0-9\s]+/g, " ");
  chineseText = chineseText.replace(/[^\u4e00-\u9fff\u3400-\u4dbf\s]+/g, " ");

  if (chineseText.trim()) {
    if (window._jiebaCut) {
      // jieba-wasm loaded → exact same behavior as Python jieba.lcut
      try {
        var jt = window._jiebaCut(chineseText.trim());
        for (var ji = 0; ji < jt.length; ji++) {
          var t = jt[ji].trim();
          if (t) tokens.push(t);
        }
      } catch (e) {
        console.warn("[tokenize] jieba error, falling back", e);
        jiebaFallback(lower, tokens);
      }
    } else {
      jiebaFallback(lower, tokens);
    }

    // Fallback: single chars for any CJK not covered by jieba
    // (jieba should cover all, but keep for safety — matches Python behavior)
    if (window._jiebaCut) {
      var jtJoined = " " + (window._jiebaCut(chineseText.trim()) || []).join(" ") + " ";
      for (var ci = 0; ci < lower.length; ci++) {
        var ch = lower[ci];
        if (("\u4e00" <= ch && ch <= "\u9fff") || ("\u3400" <= ch && ch <= "\u4dbf")) {
          if (jtJoined.indexOf(" " + ch + " ") < 0 && jtJoined.indexOf(ch) < 0) {
            tokens.push(ch);
          }
        }
      }
    }
  }

  return [...new Set(tokens)];
}

function jiebaFallback(lower, tokens) {
  var cjkChars = [];
  for (var i = 0; i < lower.length; i++) {
    if (("\u4e00" <= lower[i] && lower[i] <= "\u9fff") || ("\u3400" <= lower[i] && lower[i] <= "\u4dbf")) {
      cjkChars.push(lower[i]);
    }
  }
  if (cjkChars.length === 0) return;
  tokens.push.apply(tokens, cjkChars);

  var hasWordTokens = false;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    try {
      var seg = new Intl.Segmenter("zh-CN", { granularity: "word" });
      var segments = seg.segment(cjkChars.join(""));
      for (var iter = segments[Symbol.iterator](), s; !(s = iter.next()).done;) {
        if (s.value.isWordLike && s.value.segment.length > 1) {
          tokens.push(s.value.segment);
          hasWordTokens = true;
        }
      }
    } catch (e) {}
  }
  if (!hasWordTokens) {
    for (var j = 0; j < cjkChars.length - 1; j++) {
      tokens.push(cjkChars[j] + cjkChars[j + 1]);
    }
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
 
function buildIndex() {
  return new Promise(function(resolve) {
    wordIndex = {};
    wordIndexFilesOnly = {};
    extensionCounts = {};
    repoCounts = {};
    folderIndex = {};
    didYouMeanVocab = {};
    didYouMeanVocabFilesOnly = {};

    let i = 0;
    const chunkSize = 5000;

    function processChunk() {
      const end = Math.min(i + chunkSize, RECORDS.length);
      for (; i < end; i++) {
        const rec = RECORDS[i];
        const repo = rec.Repo || "";
        const ext = (rec.Extension || "").toLowerCase();

        repoCounts[repo] = (repoCounts[repo] || 0) + 1;
        if (ext) extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;

        const folders = rec.Folder || [];
        const text = [rec.File || "", ...folders].join(" ");
        const tokens = tokenize(text);
        for (const tok of tokens) {
          if (!wordIndex[tok]) wordIndex[tok] = [];
          wordIndex[tok].push(i);
          didYouMeanVocab[tok] = (didYouMeanVocab[tok] || 0) + 1;
        }

        const fileTokens = tokenize(rec.File || "");
        for (const tok of fileTokens) {
          if (!wordIndexFilesOnly[tok]) wordIndexFilesOnly[tok] = [];
          wordIndexFilesOnly[tok].push(i);
          didYouMeanVocabFilesOnly[tok] = (didYouMeanVocabFilesOnly[tok] || 0) + 1;
        }

        if (!folderIndex[repo]) folderIndex[repo] = {};
        for (let d = 0; d <= folders.length; d++) {
          const fp = d === 0 ? "" : folders.slice(0, d).join("/");
          folderIndex[repo][fp] = (folderIndex[repo][fp] || 0) + 1;
        }
      }

      if (i < RECORDS.length) {
        setTimeout(processChunk, 0);
      } else {
        repoList = Object.entries(repoCounts)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => a.name.localeCompare(b.name));
        extensionList = Object.keys(extensionCounts).sort();
        didYouMeanSorted = Object.entries(didYouMeanVocab).sort((a, b) => b[1] - a[1]);
        didYouMeanSortedFilesOnly = Object.entries(didYouMeanVocabFilesOnly).sort((a, b) => b[1] - a[1]);
        resolve();
      }
    }

    processChunk();
  });
}
 
async function loadData() {
  const bar = DOM.progressBar;
  const text = DOM.progressText;
  bar.style.width = "0%";
  text.textContent = "连接中...";

  try {
    const resp = await fetch(DATA_URL);
    if (!resp.ok) throw new Error("HTTP " + resp.status);

    const total = parseInt(resp.headers.get("Content-Length") || "0", 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total > 0) {
        const pct = Math.round((received / total) * 70);
        bar.style.width = pct + "%";
        text.textContent = "下载中 " + (pct > 40 ? formatSize(received) : "");
      } else {
        bar.style.width = Math.min(70, Math.round(received / 1024)) + "%";
        text.textContent = "下载中 " + formatSize(received);
      }
    }

    bar.style.width = "75%";
    text.textContent = "解压中...";

    let buf;
    if (chunks.length === 1) {
      buf = chunks[0];
    } else {
      buf = new Uint8Array(received);
      let pos = 0;
      for (const chunk of chunks) {
        buf.set(chunk, pos);
        pos += chunk.length;
      }
    }

    bar.style.width = "82%";
    const ds = new DecompressionStream("gzip");
    const stream = new Response(buf).body.pipeThrough(ds);
    const jsonText = await new Response(stream).text();

    bar.style.width = "90%";
    text.textContent = "解析中...";

    RECORDS = JSON.parse(jsonText);
    console.log("Loaded " + RECORDS.length.toLocaleString() + " records");

    bar.style.width = "95%";
    text.textContent = "建立索引...";

    await buildIndex();
    console.log("Index: " + Object.keys(wordIndex).length + " tokens, " + repoList.length + " repos");

    bar.style.width = "100%";
    text.textContent = "完成";

    setTimeout(function() {
      DOM.progressContainer.classList.add("progress-done");
    }, 400);

    return true;
  } catch (e) {
    console.error("Data load failed:", e);
    bar.style.width = "100%";
    bar.style.background = "var(--error)";
    text.textContent = "加载失败";
    return false;
  }
}
 
/* ═══════════════════════════════════════════════════════════
   Search Engine
   ========================================================== */
 
function scoreRecord(recIdx, tokens, searchFolders) {
  const rec = RECORDS[recIdx];
  let score = 0;
  const fname = (rec.File || "").toLowerCase();
  const repo = (rec.Repo || "").toLowerCase();
  for (const tok of tokens) {
    if (fname.includes(tok)) score += 3;
    if (searchFolders) {
      for (const folder of (rec.Folder || [])) {
        if (folder.toLowerCase().includes(tok)) score += 2;
      }
    }
    if (repo.includes(tok)) score += 1;
  }
  return score;
}
 
function applyFilters(indices, repos, extensions, folders, minSize, maxSize) {
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
        if (clean === "") {
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
 
function doSearchLocal(params) {
  const q = (params.q || "").trim();
  const repos = params.repos || null;
  const extensions = params.extensions || null;
  const folders = params.folders || null;
  const minSize = params.minSize !== null ? params.minSize : null;
  const maxSize = params.maxSize !== null ? params.maxSize : null;
  const sort = params.sort || "relevance";
  const searchFolders = params.searchFolders !== false;
  const exactMode = params.exact === true;
  const page = params.page || 1;
  const pageSize = params.pageSize || 100;

  let matched = [];
  let didYouMean = null;

  // ── Exact (substring) mode ──
  if (exactMode && q) {
    const qLower = q.toLowerCase();
    matched = [];
    for (let i = 0; i < RECORDS.length; i++) {
      const rec = RECORDS[i];
      const fname = (rec.File || "").toLowerCase();
      const repo = (rec.Repo || "").toLowerCase();
      const folderPath = (rec.Folder || []).join("/").toLowerCase();
      if (fname.indexOf(qLower) !== -1 || folderPath.indexOf(qLower) !== -1 || repo.indexOf(qLower) !== -1) {
        matched.push(i);
      }
    }
    let filtered = applyFilters(matched, repos, extensions, folders, minSize, maxSize);
    if (sort === "name") {
      filtered.sort(function(a, b) { return (RECORDS[a].File || "").localeCompare(RECORDS[b].File || "", "zh"); });
    } else if (sort === "size") {
      filtered.sort(function(a, b) {
        var sa = typeof RECORDS[a].Size === "number" ? RECORDS[a].Size : 0;
        var sb = typeof RECORDS[b].Size === "number" ? RECORDS[b].Size : 0;
        return sb - sa;
      });
    }
    var total = filtered.length;
    var start = (page - 1) * pageSize;
    var paged = filtered.slice(start, start + pageSize).map(function(i) { return RECORDS[i]; });
    return { results: paged, total: total, page: page, pageSize: pageSize, didYouMean: null };
  }

  const activeIndex = searchFolders ? wordIndex : wordIndexFilesOnly;
  const activeVocabSorted = searchFolders ? didYouMeanSorted : didYouMeanSortedFilesOnly;
  const activeVocab = searchFolders ? didYouMeanVocab : didYouMeanVocabFilesOnly;

  if (!q) {
    matched = Array.from({ length: RECORDS.length }, (_, i) => i);
  } else {
    const tokens = tokenize(q);

    let exactHits = null;
    for (const tok of tokens) {
      const idxs = activeIndex[tok];
      if (!idxs) { exactHits = []; break; }
      if (exactHits === null) exactHits = [...idxs];
      else {
        const idxsSet = new Set(idxs);
        exactHits = exactHits.filter(i => idxsSet.has(i));
      }
    }

    let fuzzy = new Set();
    for (const tok of tokens) {
      if (activeIndex[tok]) continue;
      const candidates = [];
      for (const [vocab] of activeVocabSorted) {
        if (Math.abs(vocab.length - tok.length) > 2) continue;
        if (editDistance(tok, vocab) <= 2) {
          candidates.push(...(activeIndex[vocab] || []));
          if (candidates.length >= 200) break;
        }
      }
      if (candidates.length > 0) {
        for (var ci = 0; ci < candidates.length; ci++) fuzzy.add(candidates[ci]);
      }
    }

    if (exactHits && exactHits.length > 0) {
      matched = exactHits;
      if (fuzzy.size > 0) {
        const exactSet = new Set(exactHits);
        fuzzy.forEach(function(i) { if (!exactSet.has(i)) matched.push(i); });
      }
    } else if (fuzzy.size > 0) {
      matched = Array.from(fuzzy);
    }

    if (matched.length < 10) {
      const suggestions = [];
      for (const tok of tokens) {
        if (activeIndex[tok]) continue;
        let best = null, bestDist = 999;
        for (const vocab of Object.keys(activeVocab)) {
          if (Math.abs(vocab.length - tok.length) > 2) continue;
          const dist = editDistance(tok, vocab);
          if (dist < bestDist) { bestDist = dist; best = vocab; }
        }
        if (best && bestDist <= 2) suggestions.push(best);
      }
      if (suggestions.length > 0) didYouMean = suggestions.join(" ");
    }
  }

  let filtered = applyFilters(matched, repos, extensions, folders, minSize, maxSize);
  const tokens = q ? tokenize(q) : [];
  const scored = filtered.map(idx => ({
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
 
  const total = scored.length;
  const start = (page - 1) * pageSize;
  const paged = scored.slice(start, start + pageSize).map(s => RECORDS[s.idx]);
 
  return { results: paged, total, page, pageSize, didYouMean };
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
 
/* ═══════════════════════════════════════════════════════════
   Folder Tree
   ========================================================== */
 
function buildFilterFolderTree(repo) {
  if (!folderIndex[repo]) return [];
  const paths = Object.keys(folderIndex[repo]);
  const root = { name: repo.split("/").pop(), path: "", children: [], count: 0 };
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
 
  return [root];
}
 
const folderContentsCache = new Map();
const FOLDER_CACHE_MAX = 100;

function getFolderContents(repo, path) {
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
      link: rec.Link || "",
      path: rec.Path || "",
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
  let pool = RECORDS;
  if (repo) pool = RECORDS.filter(r => r.Repo === repo);
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}
 
/* ═══════════════════════════════════════════════════════════
   State
   ═══════════════════════════════════════════════════════════ */
 
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
  didYouMean: null,
  filterRepos: [],
  filterExtensions: [],
  filterFolders: [],
  filterMinSize: null,
  filterMaxSize: null,
  leftSidebarOpen: true,
  rightSidebarOpen: false,
  isMobile: false,
  isDark: true,
  isLoading: false,
  hasMore: false,
  browserPath: "",
  exact: false,
  repoList: [],
  extensionList: [],
  folderTree: null,
  searchFolders: true,
  dataLoaded: false,
};

/* ═══════════════════════════════════════════════════════════
   Virtual Scroll State
   ═══════════════════════════════════════════════════════════ */

const VSCROLL = {
  renderStart: 0,
  renderEnd: 0,
  heights: [],
  estimatedHeight: 60,
};
 
/* ═══════════════════════════════════════════════════════════
   DOM References
   ═══════════════════════════════════════════════════════════ */
 
const $ = (sel) => document.querySelector(sel);
const DOM = {};
 
function cacheDOM() {
  DOM.progressContainer = $("#progress-container");
  DOM.progressBar = $("#progress-bar");
  DOM.progressText = $("#progress-text");
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
  DOM.didYouMean = $("#did-you-mean");
  DOM.clearFiltersBtn = $("#clear-filters-btn");
  DOM.sortSelect = $("#sort-select");
  DOM.loadInfo = $("#load-info");
  DOM.loadedCount = $("#loaded-count");
  DOM.totalCount = $("#total-count");
  DOM.scrollTrack = $("#scroll-track");
  DOM.scrollThumb = $("#scroll-thumb");
  DOM.hitokoto = $("#hitokoto");
  DOM.randomBookBtn = $("#random-book-btn");
  DOM.overlay = $("#overlay");
  DOM.toast = $("#toast");
  DOM.filterRepoSection = $("#filter-repo-section");
  DOM.filterRepoList = $("#filter-repo-list");
  DOM.filterFolderSection = $("#filter-folder-section");
  DOM.filterFolderTree = $("#filter-folder-tree");
  DOM.filterExtList = $("#filter-ext-list");
  DOM.filterMinSize = $("#filter-min-size");
  DOM.filterMaxSize = $("#filter-max-size");
  DOM.closeFiltersBtn = $("#close-filters-btn");
  DOM.folderSelectAll = $("#folder-select-all");
  DOM.folderDeselectAll = $("#folder-deselect-all");
  DOM.extSelectAll = $("#ext-select-all");
  DOM.extDeselectAll = $("#ext-deselect-all");
  DOM.searchFoldersToggle = $("#search-folders-toggle");
  DOM.exactSearchToggle = $("#exact-search-toggle");
}
 
/* ═══════════════════════════════════════════════════════════
   Utilities
   ═══════════════════════════════════════════════════════════ */
 
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
 
/* ═══════════════════════════════════════════════════════════
   Router (Hash-based)
   ═══════════════════════════════════════════════════════════ */
 
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
        if (k === "repo") {
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
    if (STATE.filterExtensions.length) sp.set("ext", STATE.filterExtensions.join(","));
    if (mode !== "global" && STATE.browserPath) sp.set("path", STATE.browserPath);
    if (STATE.sort !== "relevance") sp.set("sort", STATE.sort);
    if (STATE.filterMinSize !== null) sp.set("min_size", STATE.filterMinSize);
    if (STATE.filterMaxSize !== null) sp.set("max_size", STATE.filterMaxSize);
    if (!STATE.searchFolders) sp.set("search_folders", "false");
  if (STATE.exact) sp.set("exact", "1");
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
      STATE.results = [];
      STATE.total = 0;
      STATE.browserPath = "";
      STATE.filterFolders = [];
      STATE.exact = false;
      if (DOM.exactSearchToggle) DOM.exactSearchToggle.checked = false;
      STATE.folderTree = null;
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
 
    if (route.params.ext) {
      STATE.filterExtensions = route.params.ext.split(",").filter(Boolean);
    } else if (prevMode !== STATE.mode || prevRepo !== STATE.repo) {
      STATE.filterExtensions = [];
    }
 
    if (route.params.path) {
      STATE.browserPath = route.params.path;
    } else if (prevMode !== STATE.mode || prevRepo !== STATE.repo) {
      STATE.browserPath = "";
    }

    STATE.sort = route.params.sort || "relevance";
    DOM.sortSelect.value = STATE.sort;
    STATE.filterMinSize = route.params.min_size ? parseInt(route.params.min_size) : null;
    STATE.filterMaxSize = route.params.max_size ? parseInt(route.params.max_size) : null;
    DOM.filterMinSize.value = STATE.filterMinSize || "";
    DOM.filterMaxSize.value = STATE.filterMaxSize || "";
    STATE.searchFolders = route.params.search_folders !== "false";
    if (DOM.searchFoldersToggle) DOM.searchFoldersToggle.checked = STATE.searchFolders;
    STATE.exact = route.params.exact === "1";
    if (DOM.exactSearchToggle) DOM.exactSearchToggle.checked = STATE.exact;
 
    if (route.params.sidebar !== undefined) {
      STATE.leftSidebarOpen = route.params.sidebar !== "0";
      updateSidebarVisibility();
    }
    if (route.params.wide !== undefined) {
      DOM.leftSidebar.classList.toggle("expanded-wide", route.params.wide === "1");
      if (DOM.sidebarExpandBtn) DOM.sidebarExpandBtn.textContent = route.params.wide === "1" ? "→" : "↔";
    }
    this.updateUI();
 
    if (!STATE.dataLoaded) return;
 
    if (prevMode !== STATE.mode || prevRepo !== STATE.repo) {
      this.onModeChanged();
      if (route.params.wide === "1") {
        DOM.leftSidebar.classList.add("expanded-wide");
        if (DOM.sidebarExpandBtn) DOM.sidebarExpandBtn.textContent = "→";
        syncStateToURL();
      }
    } else {
      renderSidebar();
      renderFilters();
      doSearch();
    }
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
    renderSidebar();
    renderFilters();
    doSearch();
  },
};
 
/* ═══════════════════════════════════════════════════════════
   URL Sync
   ═══════════════════════════════════════════════════════════ */
 
function syncStateToURL() {
  let hash = STATE.mode === "global" ? "#/" : "#/" + STATE.repo;
  const sp = new URLSearchParams();
  if (STATE.query) sp.set("q", STATE.query);
  if (STATE.mode === "global") {
    STATE.filterRepos.forEach(function(r) {
      sp.append("repo", r.split("/").pop());
    });
  }
  if (STATE.filterExtensions.length) sp.set("ext", STATE.filterExtensions.join(","));
  if (STATE.sort !== "relevance") sp.set("sort", STATE.sort);
  if (STATE.filterFolders.length) sp.set("f", STATE.filterFolders.join(","));
  if (STATE.filterMinSize !== null) sp.set("min_size", STATE.filterMinSize);
  if (STATE.filterMaxSize !== null) sp.set("max_size", STATE.filterMaxSize);
  if (!STATE.searchFolders) sp.set("search_folders", "false");
  if (STATE.exact) sp.set("exact", "1");
  if (STATE.mode !== "global" && STATE.browserPath) sp.set("path", STATE.browserPath);
  if (!STATE.leftSidebarOpen) sp.set("sidebar", "0");
  if (DOM.leftSidebar.classList.contains("expanded-wide")) sp.set("wide", "1");
  const qs = sp.toString();
  if (qs) hash += "?" + qs;
 
  if (window.location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
}
 
/* ═══════════════════════════════════════════════════════════
   Debounce & Search Execution
   ═══════════════════════════════════════════════════════════ */
 
let searchTimer = null;
let searchId = 0;

function debouncedSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function() {
    STATE.query = DOM.searchInput.value.trim();
    STATE.page = 1;
    STATE.results = [];
    doSearch();
  }, 300);
}

function doSearch(append) {
  if (!STATE.dataLoaded) return;

  const id = ++searchId;

  const params = {
    q: STATE.query,
    repos: STATE.mode === "repo" ? [STATE.repoFull] : (STATE.filterRepos.length > 0 ? STATE.filterRepos : null),
    extensions: STATE.filterExtensions.length > 0 ? STATE.filterExtensions : null,
    folders: STATE.filterFolders.length > 0 ? STATE.filterFolders : null,
    minSize: STATE.filterMinSize,
    maxSize: STATE.filterMaxSize,
    sort: STATE.sort,
    searchFolders: STATE.searchFolders,
    exact: STATE.exact,
    page: STATE.page,
    pageSize: STATE.pageSize,
  };

  STATE.isLoading = true;
  DOM.resultsLoading.style.display = "flex";
  DOM.emptyState.style.display = "none";
  DOM.didYouMean.style.display = "none";

  requestAnimationFrame(function() {
    if (id !== searchId) return;
    try {
      const data = doSearchLocal(params);
      STATE.total = data.total;
      STATE.didYouMean = data.didYouMean || null;

      if (append) {
        STATE.results = STATE.results.concat(data.results);
      } else {
        STATE.results = data.results;
      }

      STATE.hasMore = STATE.results.length < STATE.total;
      renderResults();
      updateStatusBar();
      updateLoadInfo();

      if (STATE.didYouMean) {
        DOM.didYouMean.textContent = "你是不是想找: " + STATE.didYouMean;
        DOM.didYouMean.style.display = "inline";
      }

      syncStateToURL();
    } catch (err) {
      console.error(err);
      showToast("搜索失败");
    } finally {
      STATE.isLoading = false;
      DOM.resultsLoading.style.display = "none";
    }
  }, 0);
}
 
/* ═══════════════════════════════════════════════════════════
   Results Rendering
   ═══════════════════════════════════════════════════════════ */
 
function renderResults() {
  if (STATE.results.length === 0) {
    DOM.resultsList.innerHTML = "";
    VSCROLL.renderStart = 0;
    VSCROLL.renderEnd = 0;
    VSCROLL.heights = [];
    DOM.emptyState.style.display = "flex";
    DOM.emptyDesc.textContent = STATE.query
      ? '没有找到与 "' + STATE.query + '" 相关的结果'
      : "暂无数据";
    return;
  }

  DOM.emptyState.style.display = "none";

  const len = STATE.results.length;
  if (VSCROLL.heights.length < len) {
    const oldLen = VSCROLL.heights.length;
    VSCROLL.heights.length = len;
    for (let i = oldLen; i < len; i++) {
      VSCROLL.heights[i] = VSCROLL.estimatedHeight;
    }
  }
  VSCROLL.renderStart = 0;
  VSCROLL.renderEnd = 0;

  renderVisible();
}

function buildResultHTML(rec) {
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
      '<button class="result-action-btn" data-action="copy" data-link="' + escapeHTML(rec.Link) + '">复制链接</button>' +
      '<a href="' + escapeHTML(rec.Link) + '" class="result-action-btn primary" target="_blank">下载</a>' +
      '<a href="' + escapeHTML(rec.Path) + '" class="result-action-btn" target="_blank">仓库查看</a>' +
      (rec.HasTxt ? '<button class="result-action-btn" data-action="read" data-link="' + escapeHTML(rec.Link) + '" data-repo="' + repoShort + '">在线阅读</button>' : '') +
    '</div>'
  );
}

function renderVisible() {
  const items = STATE.results;
  const len = items.length;
  if (len === 0) return;

  const container = DOM.resultsContainer;
  const scrollTop = container.scrollTop;
  const viewH = container.clientHeight;
  const est = VSCROLL.estimatedHeight;
  const overscanItems = Math.max(10, Math.floor(viewH / (est || 60)));

  let cum = 0;
  let start = 0;
  for (let i = 0; i < len; i++) {
    const h = VSCROLL.heights[i] || est;
    if (cum + h > scrollTop - overscanItems * est) {
      start = i;
      break;
    }
    cum += h;
  }
  if (start < 0) start = 0;

  let end = start;
  let running = cum;
  while (end < len && running - scrollTop < viewH + overscanItems * est) {
    running += VSCROLL.heights[end] || est;
    end++;
  }
  if (end - start < 10 && len > 10) end = Math.min(start + 30, len);

  if (start === VSCROLL.renderStart && end === VSCROLL.renderEnd) return;

  VSCROLL.renderStart = start;
  VSCROLL.renderEnd = end;

  let topH = 0;
  for (let i = 0; i < start; i++) topH += VSCROLL.heights[i] || est;

  let html = "";
  if (topH > 0) {
    html += '<div style="height:' + topH + 'px;flex-shrink:0"></div>';
  }
  for (let ri = start; ri < end; ri++) {
    const rec = items[ri];
    html += '<div class="result-item" data-index="' + ri + '"' +
      (ri % 2 === 1 ? ' style="background:var(--surface-variant)"' : "") +
      '>' + buildResultHTML(rec) + '</div>';
  }
  let bottomH = 0;
  for (let bi = end; bi < len; bi++) bottomH += VSCROLL.heights[bi] || est;
  if (bottomH > 0) {
    html += '<div style="height:' + bottomH + 'px;flex-shrink:0"></div>';
  }
  var tpl = document.createElement("template");
  tpl.innerHTML = html;
  DOM.resultsList.replaceChildren(tpl.content);

  requestAnimationFrame(function() {
    measureHeights();
  });
}

function measureHeights() {
  const els = DOM.resultsList.querySelectorAll(".result-item");
  for (let i = 0; i < els.length; i++) {
    const idx = parseInt(els[i].dataset.index);
    if (idx >= 0) {
      const h = els[i].getBoundingClientRect().height;
      if (h > 0) VSCROLL.heights[idx] = h;
    }
  }
  const measured = VSCROLL.heights.filter(function(h) { return h > 0; });
  if (measured.length > 10) {
    let sum = 0;
    for (let i = 0; i < measured.length; i++) sum += measured[i];
    VSCROLL.estimatedHeight = sum / measured.length;
  }
}
 
function updateStatusBar() {
  DOM.resultCount.textContent = STATE.total > 0 ? "共 " + STATE.total.toLocaleString() + " 条结果" : "";
  const has = STATE.filterRepos.length || STATE.filterExtensions.length || STATE.filterFolders.length ||
            STATE.filterMinSize !== null || STATE.filterMaxSize !== null;
  DOM.clearFiltersBtn.style.display = has ? "" : "none";
}
 
function updateLoadInfo() {
  if (STATE.total === 0 && STATE.results.length === 0) {
    DOM.loadInfo.style.display = "none";
    return;
  }
  DOM.loadInfo.style.display = "";
  DOM.loadedCount.textContent = STATE.results.length.toLocaleString();
  DOM.totalCount.textContent = STATE.total.toLocaleString();
}
 
/* ═══════════════════════════════════════════════════════════
   Sidebar — Browser (Enter/Exit)
   ═══════════════════════════════════════════════════════════ */
 
function renderSidebar() {
  if (STATE.mode === "global") {
    renderRepoList();
  } else {
    renderBrowser(STATE.browserPath || "");
  }
}
 
function renderRepoList() {
  if (!repoList || repoList.length === 0) {
    DOM.sidebarContent.innerHTML = '<div class="sidebar-loading">暂无仓库</div>';
    return;
  }
  let html = "";
  for (let i = 0; i < repoList.length; i++) {
    const repo = repoList[i];
    const short = repo.name.split("/").pop();
    html += '<div class="repo-list-item" data-repo="' + escapeHTML(short) + '">';
    html += '<svg class="repo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';
    html += '<span class="repo-name">' + escapeHTML(short) + '</span>';
    html += '<span class="repo-count">' + (repo.count || 0).toLocaleString() + '</span>';
    html += '</div>';
  }
  DOM.sidebarContent.innerHTML = html;
}
 
function renderBrowser(path) {
  STATE.browserPath = path;
  syncStateToURL();
  DOM.sidebarContent.innerHTML = "";
 
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
    for (let i = 0; i < parts.length; i++) {
      const pp = parts.slice(0, i + 1).join("/");
      bc.innerHTML += '<span class="crumb-sep">/</span>';
      bc.innerHTML += '<span class="crumb-item' + (i === parts.length - 1 ? ' current' : '') + '" data-path="' + escapeHTML(pp) + '">' + escapeHTML(parts[i]) + '</span>';
    }
    bc.querySelectorAll(".crumb-item").forEach(function(el) {
      el.addEventListener("click", function() {
        if (!el.classList.contains("current")) renderBrowser(el.dataset.path);
      });
    });
    DOM.sidebarContent.appendChild(bc);
  }
 
  const list = document.createElement("div");
  list.className = "browser-list";
  list.innerHTML = '<div class="sidebar-loading">加载中...</div>';
  DOM.sidebarContent.appendChild(list);
 
  try {
    const data = getFolderContents(STATE.repoFull, path);
    list.innerHTML = "";
 
    for (let j = 0; j < (data.folders || []).length; j++) {
      const f = data.folders[j];
      const div = document.createElement("div");
      div.className = "browser-item";
      div.innerHTML = ICONS.folder + '<span class="browser-name">' + escapeHTML(f.name) + '</span><span class="browser-count">' + (f.count || 0).toLocaleString() + '</span>';
      div.addEventListener("click", (function(fp) { return function() { renderBrowser(fp); }; })(f.path));
      list.appendChild(div);
    }
 
    for (let k = 0; k < (data.files || []).length; k++) {
      const f2 = data.files[k];
      const div2 = document.createElement("div");
      div2.className = "browser-item";
      const iconType = getFileIconType(f2.ext);
      const sizeStr = formatSize(f2.size);
      div2.innerHTML = (ICONS[iconType] || ICONS.file) +
        '<span class="browser-name">' + escapeHTML(f2.name) + (f2.ext ? '.' + escapeHTML(f2.ext) : '') + '</span>' +
        (sizeStr ? '<span class="browser-size">' + sizeStr + '</span>' : '') +
        (f2.hasTxt ? '<span class="browser-action" data-read="1">📖 阅读</span>' : '');
      div2.addEventListener("click", function(ff) {
        return function(e) {
          if (e.target.closest(".browser-action")) {
            e.stopPropagation();
            const stem = ff.ext && ff.name.toLowerCase().endsWith("." + ff.ext.toLowerCase())
              ? ff.name.slice(0, ff.name.lastIndexOf("."))
              : ff.name;
            const txtPath = (path ? path + "/" : "") + stem;
            window.open(TXT_BASE + "/" + encodeURIComponent(txtPath) + ".txt", "_blank");
            return;
          }
          if (ff.link) window.open(ff.link, "_blank");
        };
      }(f2));
      list.appendChild(div2);
    }
  } catch (e) {
    list.innerHTML = '<div class="sidebar-loading">加载失败</div>';
  }
}
 
/* ═══════════════════════════════════════════════════════════
   Filters (Right Sidebar)
   ═══════════════════════════════════════════════════════════ */
 
function renderFilters() {
  if (STATE.mode === "global") {
    DOM.filterRepoSection.style.display = "";
    renderRepoFilter();
  } else {
    DOM.filterRepoSection.style.display = "none";
  }
 
  if (STATE.mode === "repo") {
    DOM.filterFolderSection.style.display = "";
    if (!STATE.folderTree) STATE.folderTree = buildFilterFolderTree(STATE.repoFull);
    renderFilterFolderTree();
  } else {
    DOM.filterFolderSection.style.display = "none";
  }
 
  renderExtensionFilter();
}
 
function renderRepoFilter() {
  const items = [];
  for (let i = 0; i < repoList.length; i++) {
    items.push({
      key: repoList[i].name,
      label: repoList[i].name.split("/").pop(),
      count: repoList[i].count,
    });
  }
  renderCheckboxList(DOM.filterRepoList, items, STATE.filterRepos, function(vals) {
    STATE.filterRepos = vals;
    STATE.page = 1;
    STATE.results = [];
    doSearch();
  });
}
 
function renderExtensionFilter() {
  const currentCounts = getCurrentExtensionCounts();
  const ordered = [];
  const rest = [];
  for (let i = 0; i < extensionList.length; i++) {
    const ext = extensionList[i];
    const idx = ORDERED_EXTENSIONS.indexOf(ext);
    if (idx >= 0) {
      ordered.push({ name: ext, _idx: idx, count: currentCounts[ext] || 0 });
    } else {
      rest.push({ name: ext, count: currentCounts[ext] || 0 });
    }
  }
  ordered.sort(function(a, b) { return a._idx - b._idx; });
 
  const items = [];
  for (let j = 0; j < ordered.length; j++) {
    items.push({ key: ordered[j].name, label: "." + ordered[j].name, count: ordered[j].count });
  }
  if (rest.length > 0) {
    let total = 0;
    for (let k = 0; k < rest.length; k++) { total += rest[k].count; }
    items.push({ key: "__OTHER__", label: "其他 (" + rest.length + "种)", count: total });
  }
 
  renderCheckboxList(DOM.filterExtList, items, STATE.filterExtensions, function(vals) {
    STATE.filterExtensions = vals.filter(function(v) { return v !== "__OTHER__"; });
    if (vals.indexOf("__OTHER__") >= 0) {
      for (let m = 0; m < rest.length; m++) {
        STATE.filterExtensions.push(rest[m].name);
      }
    }
    STATE.page = 1;
    STATE.results = [];
    doSearch();
  });
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
 
function renderFilterTreeNodes(container, nodes, depth) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const has = node.children && node.children.length > 0;
 
    const row = document.createElement("div");
    row.className = "filter-folder-item";
    row.style.setProperty("--fdepth", depth);
 
    const checked = STATE.filterFolders.indexOf(node.path) >= 0 ? "checked" : "";
    row.innerHTML = (has ? '<span class="tree-toggle expanded">▶</span>' : '<span style="width:16px;flex-shrink:0"></span>') +
      '<input type="checkbox" value="' + escapeHTML(node.path) + '" ' + checked + '>' +
      '<span>' + escapeHTML(node.name) + '</span>' +
      '<span style="font-size:10px;color:var(--on-surface-variant);margin-left:auto">' + (node.count || 0).toLocaleString() + '</span>';
 
    const toggle = row.querySelector(".tree-toggle");
    const cb = row.querySelector("input[type='checkbox']");
 
    cb.addEventListener("change", function() {
      handleFolderCheckboxChange(this);
    });
 
    container.appendChild(row);
 
    if (has) {
      const childDiv = document.createElement("div");
      childDiv.className = "tree-children";
      renderFilterTreeNodes(childDiv, node.children, depth + 1);
 
      toggle.addEventListener("click", function(childContainer, tgl) {
        return function(e) {
          e.stopPropagation();
          const hidden = childContainer.style.display === "none";
          childContainer.style.display = hidden ? "block" : "none";
          tgl.classList.toggle("expanded", hidden);
        };
      }(childDiv, toggle));
 
      container.appendChild(childDiv);
    }
  }
}
 
/* ═══════════════════════════════════════════════════════════
   Folder Filter Cascade Logic
   ═══════════════════════════════════════════════════════════ */
 
function cascadeDown(cb) {
  const row = cb.closest(".filter-folder-item");
  if (!row) return;
  const childContainer = row.nextElementSibling;
  if (!childContainer || !childContainer.classList.contains("tree-children")) return;
 
  childContainer.querySelectorAll("input[type='checkbox']").forEach(function(childCb) {
    childCb.checked = cb.checked;
    childCb.indeterminate = false;
    cascadeDown(childCb);
  });
}
 
function syncParent(cb) {
  const row = cb.closest(".filter-folder-item");
  if (!row) return;
 
  const parentChildren = row.parentElement;
  if (!parentChildren || !parentChildren.classList.contains("tree-children")) return;
 
  const parentRow = parentChildren.previousElementSibling;
  if (!parentRow || !parentRow.classList.contains("filter-folder-item")) return;
  const parentCb = parentRow.querySelector("input[type='checkbox']");
  if (!parentCb) return;
 
  const childCbs = [];
  for (let i = 0; i < parentChildren.children.length; i++) {
    const child = parentChildren.children[i];
    if (child.classList.contains("filter-folder-item")) {
      const c = child.querySelector("input[type='checkbox']");
      if (c) childCbs.push(c);
    }
  }
  if (childCbs.length === 0) return;
 
  let checkedCount = 0;
  for (let j = 0; j < childCbs.length; j++) {
    if (childCbs[j].checked) checkedCount++;
  }
 
  if (checkedCount === 0) {
    parentCb.checked = false;
    parentCb.indeterminate = false;
  } else if (checkedCount === childCbs.length) {
    parentCb.checked = true;
    parentCb.indeterminate = false;
  } else {
    parentCb.checked = false;
    parentCb.indeterminate = true;
  }
 
  syncParent(parentCb);
}
 
function updateIndeterminate(cb) {
  const row = cb.closest(".filter-folder-item");
  if (!row) return;
  const childContainer = row.nextElementSibling;
  if (!childContainer || !childContainer.classList.contains("tree-children")) {
    cb.indeterminate = false;
    return;
  }
 
  const childCbs = [];
  for (let i = 0; i < childContainer.children.length; i++) {
    const child = childContainer.children[i];
    if (child.classList.contains("filter-folder-item")) {
      const c = child.querySelector("input[type='checkbox']");
      if (c) childCbs.push(c);
    }
  }
  if (childCbs.length === 0) {
    cb.indeterminate = false;
    return;
  }
 
  let checkedCount = 0;
  for (let j = 0; j < childCbs.length; j++) {
    if (childCbs[j].checked) checkedCount++;
  }
 
  cb.indeterminate = (checkedCount > 0 && checkedCount < childCbs.length);
}
 
function collectFolderFilter() {
  const cbs = DOM.filterFolderTree.querySelectorAll("input[type='checkbox']:checked");
  STATE.filterFolders = [];
  for (let i = 0; i < cbs.length; i++) {
    STATE.filterFolders.push(cbs[i].value);
  }
  STATE.page = 1;
  STATE.results = [];
  doSearch();
  syncStateToURL();
}
 
function handleFolderCheckboxChange(cb) {
  cascadeDown(cb);
  const allCbs = DOM.filterFolderTree.querySelectorAll("input[type='checkbox']");
  allCbs.forEach(function(c) { syncParent(c); });
  allCbs.forEach(function(c) { updateIndeterminate(c); });
  collectFolderFilter();
}
 
/* ═══════════════════════════════════════════════════════════
   Hitokoto
   ═══════════════════════════════════════════════════════════ */
 
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
 
/* ═══════════════════════════════════════════════════════════
   Random Book
   ═══════════════════════════════════════════════════════════ */
 
function randomBook() {
  const rec = getRandom(STATE.repoFull);
  if (rec && rec.Link) {
    window.open(rec.Link, "_blank");
  } else {
    showToast("暂无可用记录");
  }
}
 
/* ═══════════════════════════════════════════════════════════
   Toast
   ═══════════════════════════════════════════════════════════ */
 
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
 
/* ═══════════════════════════════════════════════════════════
   Infinite Scroll & Quick Scroll
   ═══════════════════════════════════════════════════════════ */
 
let scrollTicking = false;
 
function setupVirtualScroll() {
  DOM.resultsContainer.addEventListener("scroll", () => {
    if (!scrollTicking) {
      requestAnimationFrame(() => {
        updateScrollThumb();
        renderVisible();
        if (!STATE.isLoading && STATE.hasMore) {
          const { scrollTop, scrollHeight, clientHeight } = DOM.resultsContainer;
          const loadedHeight = DOM.resultsList.scrollHeight;
          const triggerPoint = scrollHeight - clientHeight - loadedHeight * 0.95;
          if (scrollTop >= triggerPoint) {
            STATE.page++;
            doSearch(true);
          }
        }
        scrollTicking = false;
      });
      scrollTicking = true;
    }
  }, { passive: true });
}
 
function updateScrollThumb() {
  const { scrollTop, scrollHeight, clientHeight } = DOM.resultsContainer;
  if (scrollHeight <= clientHeight) { DOM.scrollTrack.classList.remove("visible"); return; }
  DOM.scrollTrack.classList.add("visible");
  const th = Math.max(30, (clientHeight / scrollHeight) * DOM.scrollTrack.clientHeight);
  const tt = (scrollTop / (scrollHeight - clientHeight)) * (DOM.scrollTrack.clientHeight - th);
  DOM.scrollThumb.style.height = th + "px";
  DOM.scrollThumb.style.top = tt + "px";
}
 
function setupQuickScroll() {
  let dragging = false, startY, startST;

  function onMouseMove(e) {
    const delta = e.clientY - startY;
    const ratio = delta / (DOM.scrollTrack.clientHeight - DOM.scrollThumb.clientHeight);
    DOM.resultsContainer.scrollTop = startST + ratio * (DOM.resultsContainer.scrollHeight - DOM.resultsContainer.clientHeight);
  }

  function onMouseUp() {
    dragging = false;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  DOM.scrollThumb.addEventListener("mousedown", (e) => {
    dragging = true; startY = e.clientY; startST = DOM.resultsContainer.scrollTop; e.preventDefault();
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  function onTouchMove(e) {
    const delta = e.touches[0].clientY - startY;
    const ratio = delta / (DOM.scrollTrack.clientHeight - DOM.scrollThumb.clientHeight);
    DOM.resultsContainer.scrollTop = startST + ratio * (DOM.resultsContainer.scrollHeight - DOM.resultsContainer.clientHeight);
  }

  function onTouchEnd() {
    dragging = false;
    document.removeEventListener("touchmove", onTouchMove);
    document.removeEventListener("touchend", onTouchEnd);
  }

  DOM.scrollThumb.addEventListener("touchstart", (e) => {
    dragging = true; startY = e.touches[0].clientY; startST = DOM.resultsContainer.scrollTop;
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd);
  });
}
 
/* ═══════════════════════════════════════════════════════════
   Theme & Mobile
   ═══════════════════════════════════════════════════════════ */
 
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
}
 
function autoDetectMobile() { return window.innerWidth <= 768; }
 
/* ═══════════════════════════════════════════════════════════
   Sidebar Visibility
   ═══════════════════════════════════════════════════════════ */
 
function toggleLeftSidebar() {
  STATE.leftSidebarOpen = !STATE.leftSidebarOpen;
  if (!STATE.leftSidebarOpen) {
    DOM.leftSidebar.classList.remove("expanded-wide");
    DOM.sidebarExpandBtn.textContent = "↔";
  }
  syncStateToURL();
  if (STATE.leftSidebarOpen && STATE.rightSidebarOpen) STATE.rightSidebarOpen = false;
  updateSidebarVisibility();
}
 
function toggleRightSidebar() {
  STATE.rightSidebarOpen = !STATE.rightSidebarOpen;
  if (STATE.rightSidebarOpen && STATE.leftSidebarOpen && STATE.isMobile) STATE.leftSidebarOpen = false;
  updateSidebarVisibility();
}
 
function updateSidebarVisibility() {
  DOM.leftSidebar.classList.toggle("collapsed", !STATE.leftSidebarOpen);
  DOM.leftSidebar.classList.toggle("open", STATE.leftSidebarOpen);
  DOM.rightSidebar.classList.toggle("collapsed", !STATE.rightSidebarOpen);
  DOM.rightSidebar.classList.toggle("open", STATE.rightSidebarOpen);
  DOM.overlay.style.display = (STATE.isMobile && (STATE.leftSidebarOpen || STATE.rightSidebarOpen)) ? "" : "none";
}
 
/* ═══════════════════════════════════════════════════════════
   Keyboard
   ═══════════════════════════════════════════════════════════ */
 
let keyboardResultIndex = -1;
 
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
      if (e.key === "ArrowDown") {
        keyboardResultIndex = Math.min(keyboardResultIndex + 1, STATE.results.length - 1);
      } else {
        keyboardResultIndex = Math.max(keyboardResultIndex - 1, 0);
      }
      var targetY = keyboardResultIndex * VSCROLL.estimatedHeight;
      DOM.resultsContainer.scrollTop = targetY;
      requestAnimationFrame(function() {
        var all = DOM.resultsList.querySelectorAll(".result-item");
        for (var ai = 0; ai < all.length; ai++) {
          var aidx = parseInt(all[ai].dataset.index);
          all[ai].style.background = (aidx % 2 === 1) ? "var(--surface-variant)" : "";
        }
        for (var ai = 0; ai < all.length; ai++) {
          if (parseInt(all[ai].dataset.index) === keyboardResultIndex) {
            all[ai].style.background = "var(--surface-variant)";
            break;
          }
        }
      });
      return;
    }
 
    if (e.key === "Enter") {
      if (isInput && document.activeElement === DOM.searchInput) {
        e.preventDefault();
        STATE.query = DOM.searchInput.value.trim();
        STATE.page = 1;
        STATE.results = [];
        keyboardResultIndex = -1;
        doSearch();
        DOM.searchInput.blur();
        return;
      }
      if (keyboardResultIndex >= 0 && keyboardResultIndex < STATE.results.length) {
        const rec = STATE.results[keyboardResultIndex];
        if (rec && rec.Link) window.open(rec.Link, "_blank");
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
      doSearch();
      DOM.searchInput.blur();
    }
  });
}
 
/* ═══════════════════════════════════════════════════════════
   Clear Filters
   ═══════════════════════════════════════════════════════════ */
 
function clearAllFilters() {
  STATE.filterRepos = [];
  STATE.filterExtensions = [];
  STATE.filterFolders = [];
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
 
/* ═══════════════════════════════════════════════════════════
   Event Delegation
   ═══════════════════════════════════════════════════════════ */
 
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
        window.open(TXT_BASE + "/" + encodeURIComponent(stem) + ".txt", "_blank");
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
        ROUTER.navigate("repo", frepo, folder || null);
      } else if (folder !== undefined) {
        STATE.filterFolders = folder ? [folder] : [];
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
 
/* ═══════════════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════════════ */
 
function init() {
  cacheDOM();
 
  STATE.isDark = localStorage.getItem("theme") !== "light";
  applyTheme();
 
  const savedMobile = localStorage.getItem("mobileMode");
  if (savedMobile === "mobile") STATE.isMobile = true;
  else if (savedMobile === "desktop") STATE.isMobile = false;
  else STATE.isMobile = autoDetectMobile();
  applyMobileMode();
 
  console.log("Loading data...");
  loadData().then(function(ok) {
    STATE.dataLoaded = ok;
    if (!ok) {
      DOM.resultsList.innerHTML = '<div class="empty-state"><div class="empty-title">数据加载失败</div><div class="empty-desc">请检查网络连接后刷新页面</div></div>';
      return;
    }
 
    STATE.repoList = repoList;
    STATE.extensionList = extensionList;
 
    DOM.searchInput.addEventListener("input", debouncedSearch);
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
      STATE.page = 1;
      STATE.results = [];
      doSearch();
    });
    if (DOM.exactSearchToggle) {
      DOM.exactSearchToggle.addEventListener("change", function() {
        STATE.exact = DOM.exactSearchToggle.checked;
        STATE.page = 1;
        STATE.results = [];
        doSearch();
      });
    }
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
    });
    DOM.randomBookBtn.addEventListener("click", randomBook);
    DOM.emptyRandomBtn.addEventListener("click", randomBook);
 
    let sizeTimer;
    const onSize = function() {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(function() {
        STATE.filterMinSize = DOM.filterMinSize.value ? parseInt(DOM.filterMinSize.value) : null;
        STATE.filterMaxSize = DOM.filterMaxSize.value ? parseInt(DOM.filterMaxSize.value) : null;
        STATE.page = 1;
        STATE.results = [];
        doSearch();
      }, 500);
    };
    DOM.filterMinSize.addEventListener("input", onSize);
    DOM.filterMaxSize.addEventListener("input", onSize);
 
    DOM.extSelectAll.addEventListener("click", function() {
      STATE.filterExtensions = extensionList.slice();
      STATE.page = 1;
      STATE.results = [];
      doSearch();
      renderExtensionFilter();
    });
    DOM.extDeselectAll.addEventListener("click", function() {
      const allExtNames = extensionList.slice();
      const currentSet = new Set(STATE.filterExtensions);
      STATE.filterExtensions = allExtNames.filter(function(e) { return !currentSet.has(e); });
      STATE.page = 1;
      STATE.results = [];
      doSearch();
      renderExtensionFilter();
    });
    DOM.folderSelectAll.addEventListener("click", function() {
      DOM.filterFolderTree.querySelectorAll("input[type='checkbox']").forEach(function(c) {
        c.checked = true;
        c.indeterminate = false;
      });
      collectFolderFilter();
    });
    DOM.folderDeselectAll.addEventListener("click", function() {
      DOM.filterFolderTree.querySelectorAll("input[type='checkbox']").forEach(function(c) {
        c.checked = !c.checked;
        c.indeterminate = false;
      });
      collectFolderFilter();
    });
 
    DOM.didYouMean.addEventListener("click", function() {
      if (STATE.didYouMean) {
        DOM.searchInput.value = STATE.didYouMean;
        STATE.query = STATE.didYouMean;
        STATE.page = 1;
        STATE.results = [];
        doSearch();
      }
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
        const wasMobile = STATE.isMobile;
        STATE.isMobile = autoDetectMobile();
        if (wasMobile !== STATE.isMobile) applyMobileMode();
      }
    });
 
    ROUTER.apply();
 
    fetchHitokoto();
    setInterval(fetchHitokoto, 30000);
  });
}
 
document.addEventListener("DOMContentLoaded", init);
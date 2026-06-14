/**
 * VoiceOfML Search — Data Loading Worker
 * Downloads, decompresses, parses, builds index off the main thread.
 * Stores results in IndexedDB for instant reload on repeat visits.
 */

const DB_NAME = "VoiceOfMLSearch";
const DB_VERSION = 1;
const STORE = "cache";

function openDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror = function(e) { reject(e.target.error); };
  });
}

function dbPut(db, key, value) {
  return new Promise(function(resolve, reject) {
    var tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = function() { resolve(); };
    tx.onerror = function(e) { reject(e.target.error); };
  });
}

function toArray(arr) { return arr; }

/* ═══════════════════════════════════════════════════════════
   Tokenization (mirrors app.js exactly)
   ═══════════════════════════════════════════════════════════ */

function tokenize(text) {
  var tokens = [];
  var lower = text.toLowerCase();
  var alpha = lower.match(/[a-z0-9]+/g);
  if (alpha) tokens.push.apply(tokens, alpha);
  var chineseChars = [];
  for (var i = 0; i < lower.length; i++) {
    var ch = lower[i];
    if (("\u4e00" <= ch && ch <= "\u9fff") || ("\u3400" <= ch && ch <= "\u4dbf")) {
      chineseChars.push(ch);
      tokens.push(ch);
    }
  }
  for (var j = 0; j < chineseChars.length - 1; j++) {
    tokens.push(chineseChars[j] + chineseChars[j + 1]);
  }
  var seen = {};
  var deduped = [];
  for (var k = 0; k < tokens.length; k++) {
    if (!seen[tokens[k]]) {
      seen[tokens[k]] = true;
      deduped.push(tokens[k]);
    }
  }
  return deduped;
}

/* ═══════════════════════════════════════════════════════════
   Build Index (mirrors app.js buildIndex + buildIndex chunking)
   ═══════════════════════════════════════════════════════════ */

function buildIndex(records) {
  return new Promise(function(resolve) {
    var wordIndex = {};
    var wordIndexFilesOnly = {};
    var extensionCounts = {};
    var repoCounts = {};
    var folderIndex = {};
    var didYouMeanVocab = {};
    var didYouMeanVocabFilesOnly = {};

    var i = 0;
    var len = records.length;
    var chunkSize = 5000;

    function processChunk() {
      var end = Math.min(i + chunkSize, len);
      for (; i < end; i++) {
        var rec = records[i];
        var repo = rec.Repo || "";
        var ext = (rec.Extension || "").toLowerCase();

        repoCounts[repo] = (repoCounts[repo] || 0) + 1;
        if (ext) extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;

        var folders = rec.Folder || [];
        var text = [rec.File || ""].concat(folders).join(" ");
        var tokens = tokenize(text);
        for (var t = 0; t < tokens.length; t++) {
          var tok = tokens[t];
          if (!wordIndex[tok]) wordIndex[tok] = [];
          wordIndex[tok].push(i);
          didYouMeanVocab[tok] = (didYouMeanVocab[tok] || 0) + 1;
        }

        var fileTokens = tokenize(rec.File || "");
        for (var u = 0; u < fileTokens.length; u++) {
          var ftok = fileTokens[u];
          if (!wordIndexFilesOnly[ftok]) wordIndexFilesOnly[ftok] = [];
          wordIndexFilesOnly[ftok].push(i);
          didYouMeanVocabFilesOnly[ftok] = (didYouMeanVocabFilesOnly[ftok] || 0) + 1;
        }

        if (!folderIndex[repo]) folderIndex[repo] = {};
        for (var d = 0; d <= folders.length; d++) {
          var fp = d === 0 ? "" : folders.slice(0, d).join("/");
          folderIndex[repo][fp] = (folderIndex[repo][fp] || 0) + 1;
        }
      }

      if (i < len) {
        self.postMessage({ type: "progress", stage: "index", percent: Math.round(90 + (i / len) * 8) });
        setTimeout(processChunk, 0);
      } else {
        var repoList = Object.keys(repoCounts).map(function(name) {
          return { name: name, count: repoCounts[name] };
        }).sort(function(a, b) { return a.name.localeCompare(b.name); });
        var extensionList = Object.keys(extensionCounts).sort();
        var didYouMeanSorted = Object.keys(didYouMeanVocab).map(function(k) {
          return [k, didYouMeanVocab[k]];
        }).sort(function(a, b) { return b[1] - a[1]; });
        var didYouMeanSortedFilesOnly = Object.keys(didYouMeanVocabFilesOnly).map(function(k) {
          return [k, didYouMeanVocabFilesOnly[k]];
        }).sort(function(a, b) { return b[1] - a[1]; });

        resolve({
          wordIndex: wordIndex,
          wordIndexFilesOnly: wordIndexFilesOnly,
          extensionCounts: extensionCounts,
          repoCounts: repoCounts,
          folderIndex: folderIndex,
          didYouMeanVocab: didYouMeanVocab,
          didYouMeanVocabFilesOnly: didYouMeanVocabFilesOnly,
          didYouMeanSorted: didYouMeanSorted,
          didYouMeanSortedFilesOnly: didYouMeanSortedFilesOnly,
          repoList: repoList,
          extensionList: extensionList,
        });
      }
    }

    processChunk();
  });
}

/* ═══════════════════════════════════════════════════════════
   Main Load Pipeline
   ═══════════════════════════════════════════════════════════ */

function formatSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

async function loadAndBuild(url) {
  // Download
  self.postMessage({ type: "progress", stage: "download", percent: 0, text: "连接中..." });

  var resp;
  try {
    resp = await fetch(url);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
  } catch (e) {
    self.postMessage({ type: "error", message: "下载失败: " + e.message });
    return;
  }

  var total = parseInt(resp.headers.get("Content-Length") || "0", 10);
  var etag = resp.headers.get("ETag") || "";
  var reader = resp.body.getReader();
  var chunks = [];
  var received = 0;

  try {
    while (true) {
      var result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      received += result.value.length;
      var pct = total > 0 ? Math.round((received / total) * 65) : Math.min(65, Math.round(received / 1024));
      self.postMessage({
        type: "progress",
        stage: "download",
        percent: pct,
        text: "下载中 " + formatSize(received),
      });
    }

    // Decompress
    self.postMessage({ type: "progress", stage: "decompress", percent: 72, text: "解压中..." });

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
    var jsonText = await new Response(stream).text();

    // Parse
    self.postMessage({ type: "progress", stage: "parse", percent: 82, text: "解析中..." });
    var records = JSON.parse(jsonText);

    self.postMessage({
      type: "progress",
      stage: "parsed",
      percent: 85,
      text: "已加载 " + records.length.toLocaleString() + " 条记录",
    });

    // Build Index
    self.postMessage({ type: "progress", stage: "index", percent: 88, text: "建立索引..." });
    var index = await buildIndex(records);

    var tokenCount = Object.keys(index.wordIndex).length;
    self.postMessage({
      type: "progress",
      stage: "index",
      percent: 96,
      text: "索引完成: " + tokenCount.toLocaleString() + " tokens",
    });

    // Store in IndexedDB
    self.postMessage({ type: "progress", stage: "cache", percent: 98, text: "缓存中..." });

    var db = await openDB();
    var tx = db.transaction(STORE, "readwrite");
    var store = tx.objectStore(STORE);

    store.put({
      version: records.length + "|" + received,
      count: records.length,
      size: received,
      etag: etag,
      builtAt: Date.now(),
    }, "meta");
    store.put(records, "records");
    store.put(index, "index");

    await new Promise(function(resolve, reject) {
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function(e) { reject(e.target.error); };
    });

    db.close();

    // Done
    self.postMessage({
      type: "ready",
      meta: { count: records.length, size: received, tokenCount: tokenCount },
    });
  } catch (e) {
    self.postMessage({ type: "error", message: e.message || "未知错误" });
  }
}

self.onmessage = function(e) {
  if (e.data.type === "load") {
    loadAndBuild(e.data.url);
  }
};

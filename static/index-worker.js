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

self.addEventListener("message", function(event) {
  const data = event.data || {};
  if (data.type !== "build-fulltext") return;
  const records = Array.isArray(data.records) ? data.records : [];
  const wordIndex = {};
  const wordIndexFilesOnly = {};
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
  self.postMessage({
    type: "fulltext-ready",
    wordIndex: wordIndex,
    wordIndexFilesOnly: wordIndexFilesOnly,
    vocabSorted: Object.keys(wordIndex).map(function(tok) { return [tok, wordIndex[tok].length]; }).sort(function(a, b) { return b[1] - a[1]; }),
    vocabSortedFilesOnly: Object.keys(wordIndexFilesOnly).map(function(tok) { return [tok, wordIndexFilesOnly[tok].length]; }).sort(function(a, b) { return b[1] - a[1]; }),
  });
});

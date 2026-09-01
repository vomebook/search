(function (root) {
  "use strict";
  const ReaderMode = Object.freeze({ UNSUPPORTED: 0, ORIGINAL: 1, CONVERTED: 2, PENDING: 3, FAILED: 4 });
  const modes = Object.freeze({
    pdf: "pdf", "pdf-pages": "pdf-pages", epub: "foliate", mobi: "foliate", azw: "foliate", azw3: "foliate", fb2: "foliate", fbz: "foliate", "epub-chapters": "epub-chapters", docx: "docx", html: "html", htm: "html", txt: "text", md: "markdown", markdown: "markdown",
    jpg: "image", jpeg: "image", png: "image", gif: "image", bmp: "image", webp: "image",
    mp3: "audio", wav: "audio", m4a: "audio", flac: "audio", mpga: "audio", audio: "audio",
    mp4: "video", mov: "video", video: "video",
  });
  const articleExtensions = Object.freeze(Object.keys(modes));
  function capability(extension) {
    const normalized = String(extension || "").toLowerCase();
    return Object.freeze({ extension: normalized, mode: modes[normalized] || null, readerMode: modes[normalized] ? ReaderMode.ORIGINAL : ReaderMode.UNSUPPORTED, article: !!modes[normalized] });
  }
  function clampNumber(value, minimum, maximum, fallback) { const numeric = Math.round(Number(value)); return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback; }
  function readerUrl(record, basePath) {
    const source = record && (record.ReaderLink || record.readerLink || record.Link || record.link);
    const readerExtension = record && (record.ReaderExtension || record.readerExtension || record.Extension || record.extension);
    if (!source || capability(readerExtension).readerMode === ReaderMode.UNSUPPORTED) return "";
    const assetMatch = source.match(/\/objects\/[0-9a-f]{2}\/([0-9a-f]{16})[0-9a-f]{48}\//i);
    const shortId = assetMatch ? assetMatch[1] : /^https:\/\/huggingface\.co\/datasets\//i.test(source) ? shortSourceId(source) : "";
    const params = new URLSearchParams(shortId ? { id: shortId, ext: readerExtension || "" } : { url: source, title: (record.File || record.name || "") + ((record.Extension || record.extension) ? "." + (record.Extension || record.extension) : ""), ext: readerExtension || "" });
    if (!shortId && (record.DownloadLink || record.downloadLink)) params.set("download", record.DownloadLink || record.downloadLink);
    if (!shortId && (record.OcrUrl || record.ocrUrl)) params.set("ocr", record.OcrUrl || record.ocrUrl);
     if (!shortId && (record.ReaderFallback || record.readerFallback)) params.set("fallback", record.ReaderFallback || record.readerFallback);
     if (!shortId && (record.ReaderChapterManifest || record.readerChapterManifest || record.ChapterManifest || record.chapterManifest)) params.set("chapter_manifest", record.ReaderChapterManifest || record.readerChapterManifest || record.ChapterManifest || record.chapterManifest);
    if (!shortId && (record.ReturnUrl || record.returnUrl)) params.set("return", record.ReturnUrl || record.returnUrl);
    const repo = String(record.Repo || record.repo || "").split("/").pop();
    const folder = Array.isArray(record.Folder || record.folder) ? (record.Folder || record.folder).join("/") : "";
      if (!shortId && repo) params.set("path", repo + (folder ? "/" + folder : ""));
      if (!shortId && (record.FolderUrl || record.folderUrl)) params.set("folder_url", record.FolderUrl || record.folderUrl);
   return (basePath || "/search/static/reader.html") + "?" + params.toString();
  }
  function shortSourceId(value) { let hash = 1469598103934665603n; for (const byte of new TextEncoder().encode(value)) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 1099511628211n); } return hash.toString(36).padStart(13, "0"); }
  root.VoiceOfMLReader = Object.freeze({ ReaderMode, articleExtensions, capability, clampNumber, readerUrl });
})(typeof self !== "undefined" ? self : window);

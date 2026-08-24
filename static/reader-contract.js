(function (root) {
  "use strict";
  const ReaderMode = Object.freeze({ UNSUPPORTED: 0, ORIGINAL: 1, CONVERTED: 2, PENDING: 3, FAILED: 4 });
  const modes = Object.freeze({
    pdf: "pdf", epub: "epub", txt: "text", md: "markdown", markdown: "markdown",
    jpg: "image", jpeg: "image", png: "image", gif: "image", bmp: "image", webp: "image",
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
    const params = new URLSearchParams({ url: source, title: (record.File || record.name || "") + ((record.Extension || record.extension) ? "." + (record.Extension || record.extension) : ""), ext: readerExtension || "" });
    if (record.DownloadLink || record.downloadLink) params.set("download", record.DownloadLink || record.downloadLink);
    if (record.OcrUrl || record.ocrUrl) params.set("ocr", record.OcrUrl || record.ocrUrl);
    if (record.ReturnUrl || record.returnUrl) params.set("return", record.ReturnUrl || record.returnUrl);
    return (basePath || "/search/static/reader.html") + "?" + params.toString();
  }
  root.VoiceOfMLReader = Object.freeze({ ReaderMode, articleExtensions, capability, clampNumber, readerUrl });
})(typeof self !== "undefined" ? self : window);

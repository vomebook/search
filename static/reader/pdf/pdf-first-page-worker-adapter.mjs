// Reader-only adapter for the pinned, uncompressed PDF.js 6.4.299 worker.
// The upstream bundle retains its Apache-2.0 license notice. Refuse to patch
// different bytes or unexpected source instead of weakening validation.
const MAX_BYTES = 3 * 1024 * 1024;

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0)
    throw new Error(`PDF_PREVIEW_WORKER_VERSION_MISMATCH:${label}`);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function makeFirstPageWorkerSource(source) {
  if (typeof source !== "string" || !source.includes('const workerVersion = "6.4.299";'))
    throw new Error("PDF_PREVIEW_WORKER_VERSION_MISMATCH:version");
  source = replaceOnce(source,
    'if (currentNode === this.toplevelPagesDict && lastKid instanceof Ref && !pageDictCache.has(lastKid)) {',
    'if ((this.readerFirstPageOnly ? lastKid === kids[0] : currentNode === this.toplevelPagesDict) && lastKid instanceof Ref && !pageDictCache.has(lastKid)) {', "page-tree");
  source = replaceOnce(source, 'promise = catalog.getPageDict(pageIndex);',
    `if (pageIndex === 0 && this.readerFirstPageOnly) {
        catalog.readerFirstPageOnly = true;
        promise = catalog.getPageDict(pageIndex).finally(() => { catalog.readerFirstPageOnly = false; });
      } else {
        promise = catalog.getPageDict(pageIndex);
      }`, "first-page");
  source = replaceOnce(source,
    `for (let last = kids.length - 1; last >= 0; last--) {
        const lastKid = kids[last];`,
    `// During the bounded validation message, request sibling dictionaries
      // together. Do not prefetch descendants or page image streams.
      if (this.readerValidationPrefetch && kids.length <= 4096) {
        for (const kid of kids) {
          if (kid instanceof Ref && !pageDictCache.has(kid)) {
            const pending = xref.fetchAsync(kid);
            pending.catch(() => {});
            this.readerValidationPromises.push(pending);
            pageDictCache.put(kid, pending);
          }
        }
      }
      for (let last = kids.length - 1; last >= 0; last--) {
        const lastKid = kids[last];`, "validation-prefetch");
  source = replaceOnce(source,
    `async initDocument(recoveryMode) {
    await this.ensureDoc("checkHeader");
    await this.ensureDoc("parseStartXRef");
    await this.ensureDoc("parse", [recoveryMode]);
    await this.ensureDoc("checkFirstPage", [recoveryMode]);
    await this.ensureDoc("checkLastPage", [recoveryMode]);
  }`,
    `async initDocument(recoveryMode, readerFirstPage = false) {
    await this.ensureDoc("checkHeader");
    await this.ensureDoc("parseStartXRef");
    await this.ensureDoc("parse", [recoveryMode]);
    this.pdfDocument.readerFirstPageOnly = readerFirstPage;
    try { await this.ensureDoc("checkFirstPage", [recoveryMode]); }
    finally { this.pdfDocument.readerFirstPageOnly = false; }
    if (!readerFirstPage) await this.ensureDoc("checkLastPage", [recoveryMode]);
  }`, "initialization");
  source = replaceOnce(source,
    'const workerHandlerName = docId + "_worker";\n    let handler = new MessageHandler(workerHandlerName, docId, port);',
    'const workerHandlerName = docId + "_worker";\n    let readerCountPending = false;\n    let handler = new MessageHandler(workerHandlerName, docId, port);', "document-state");
  source = replaceOnce(source,
    'await pdfManager.initDocument(recoveryMode);\n      const isPureXfa = await pdfManager.ensureDoc("isPureXfa");',
    `await pdfManager.initDocument(recoveryMode, !recoveryMode);
      readerCountPending = !recoveryMode;
      const isPureXfa = await pdfManager.ensureDoc("isPureXfa");
      const formInfo = await pdfManager.ensureDoc("formInfo");
      if ((isPureXfa || formInfo?.hasXfa) && !recoveryMode) {
        await pdfManager.ensureDoc("checkLastPage", [false]);
        readerCountPending = false;
      }`, "opening");
  source = replaceOnce(source,
    'function onSuccess(doc) {\n        ensureNotTerminated();\n        handler.send("GetDoc", {',
    `function onSuccess(doc) {
        ensureNotTerminated();
        if (readerCountPending) {
          doc.numPages = 1;
          doc.readerPageCountPending = true;
        }
        handler.send("GetDoc", {`, "document-result");
  source = replaceOnce(source,
    'handler.on("GetPage", async function ({\n      pageIndex\n    }) {',
    `let readerValidation = null;
    handler.on("ReaderValidatePageCount", function () {
      if (readerValidation) return readerValidation;
      readerValidation = (async () => {
        ensureNotTerminated();
        const manager = pdfManager;
        const catalog = manager.pdfDocument.catalog;
        catalog.readerValidationPromises = [];
        catalog.readerValidationPrefetch = true;
        try {
          try {
            await manager.ensureDoc("checkLastPage", [false]);
          } catch (reason) {
            if (!(reason instanceof XRefParseException)) throw reason;
            await manager.requestLoadedStream();
            ensureNotTerminated();
            await manager.initDocument(true);
          }
          const results = await Promise.allSettled(catalog.readerValidationPromises);
          const failed = results.find(result => result.status === "rejected");
          if (failed) throw failed.reason;
        } finally {
          catalog.readerValidationPrefetch = false;
          catalog.readerValidationPromises = null;
        }
        ensureNotTerminated();
        delete manager.pdfDocument.numPages;
        const count = await manager.ensureDoc("numPages");
        if (!Number.isSafeInteger(count) || count < 1) throw new Error("PDF_PAGE_COUNT_INVALID");
        return {count};
      })();
      return readerValidation;
    });
    handler.on("GetPage", async function ({
      pageIndex
    }) {`, "validation-message");
  return source;
}

export async function installFirstPageWorker(url, expectedDigest) {
  const owner = new AbortController();
  const timer = setTimeout(() => owner.abort(), 20000);
  try {
    const response = await fetch(url, {signal:owner.signal, credentials:"same-origin", cache:"force-cache"});
    if (!response.ok) throw new Error(`PDF_PREVIEW_WORKER_HTTP_${response.status}`);
    const encoded = response.headers.get("Content-Encoding");
    const declared = encoded && encoded !== "identity" ? 0 : Number(response.headers.get("Content-Length") || 0);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BYTES) throw new Error("PDF_PREVIEW_WORKER_SIZE");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("PDF_PREVIEW_WORKER_STREAM");
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("PDF_PREVIEW_WORKER_SIZE");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    if (!size || (declared && declared !== size)) throw new Error("PDF_PREVIEW_WORKER_SIZE");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    if (!/^[0-9a-f]{64}$/.test(expectedDigest || "") || digest !== expectedDigest)
      throw new Error("PDF_PREVIEW_WORKER_INTEGRITY");
    const source = makeFirstPageWorkerSource(new TextDecoder().decode(bytes));
    const blob = URL.createObjectURL(new Blob([source], {type:"text/javascript"}));
    try {
      const module = await import(blob);
      if (!module.WorkerMessageHandler) throw new Error("PDF_PREVIEW_WORKER_UNAVAILABLE");
      return module.WorkerMessageHandler;
    } finally { URL.revokeObjectURL(blob); }
  } finally { clearTimeout(timer); }
}

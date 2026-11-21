(/** @param {import('../../../typings/reader-security-strict').SecurityRoot} root */
function (root) {
  "use strict";
  const LIMITS = Object.freeze({
    documentBytes: 512 * 1024 * 1024,
    imagePageBytes: 64 * 1024 * 1024,
    // PDF is distinct from DjVu and other document formats. Range reads remain
    // preferred for large files to avoid downloading the entire body at once.
    pdfDocumentBytes: 2 * 1024 * 1024 * 1024,
    manifestBytes: 8 * 1024 * 1024,
    pdfPages: 100000,
    chapters: 10000,
    chapterBytes: 8 * 1024 * 1024,
    chapterTotalBytes: 512 * 1024 * 1024
  });
  /** @param {string} code */
  function error(code) {
    return Object.assign(new Error(code), { code });
  }
  /** @template {Response} T @param {T} response @param {number} limit @returns {T} */
  function assertResponseSize(response, limit) {
    const length = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > limit) throw error("READER_RESOURCE_LIMIT");
    return response;
  }
  function createByteBudget(limit = LIMITS.chapterTotalBytes) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid byte budget");
    let used = 0;
    /** @param {number} bytes */
    function reserve(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Invalid byte count");
      if (bytes > limit - used) throw error("READER_RESOURCE_LIMIT");
      used += bytes;
    }
    /** @param {number} bytes */
    function release(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > used)
        throw new RangeError("Invalid byte release");
      used -= bytes;
    }
    return Object.freeze({
      reserve,
      release,
      get used() {
        return used;
      },
      get remaining() {
        return limit - used;
      }
    });
  }

  // Failed reads release their reservations; successful reads retain them until
  // the caller releases discarded content. Share one budget across a book.
  /** @param {Response} response @param {number} [limit] @param {import('../../../typings/reader-security-strict').ByteBudget} [budget] */
  async function readBytes(response, limit = LIMITS.documentBytes, budget) {
    let reader,
      reserved = 0;
    try {
      assertResponseSize(response, limit);
      if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > limit) throw error("READER_RESOURCE_LIMIT");
        budget?.reserve(bytes.byteLength);
        return bytes;
      }
      reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        length += value.byteLength;
        if (length > limit) throw error("READER_RESOURCE_LIMIT");
        budget?.reserve(value.byteLength);
        reserved += value.byteLength;
        chunks.push(value);
      }
      const output = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return output;
    } catch (reason) {
      if (budget && reserved) budget.release(reserved);
      try {
        if (reader) await reader.cancel(reason);
        else await response.body?.cancel?.(reason);
      } catch (_) {}
      throw reason;
    } finally {
      reader?.releaseLock?.();
    }
  }
  /** @param {Response} response @param {number} [limit] @param {string} [encoding] @param {import('../../../typings/reader-security-strict').ByteBudget} [budget] */
  async function readText(response, limit, encoding = "utf-8", budget) {
    const decoder = new TextDecoder(encoding);
    const bytes = await readBytes(response, limit, budget);
    try {
      return decoder.decode(bytes);
    } catch (reason) {
      budget?.release(bytes.byteLength);
      throw reason;
    }
  }

  /** @param {unknown} input @returns {import('../../../typings/reader-security-strict').ValidatedChapterManifest} */
  function validateChapterManifest(input) {
    // The candidate is untrusted: the checks below determine what is accepted.
    const manifest = /** @type {import('../../../typings/reader-security-strict').ChapterManifestCandidate} */ (/** @type {unknown} */ (input));
    if (
      manifest?.version !== 1 ||
      manifest?.kind !== "epub-chapters" ||
      !Array.isArray(manifest.chapters) ||
      !manifest.chapters.length
    )
      throw error("EPUB_INVALID");
    if (manifest.chapters.length > LIMITS.chapters) throw error("READER_RESOURCE_LIMIT");
    let declaredBytes = 0,
      expectedIndex = 1;
    for (const chapter of manifest.chapters) {
      if (!chapter || !Number.isInteger(chapter.index) || chapter.index !== expectedIndex)
        throw error("EPUB_INVALID");
      expectedIndex += 1;
      if (
        typeof chapter.path !== "string" ||
        !chapter.path.trim() ||
        /^[a-z][a-z0-9+.-]*:/i.test(chapter.path) ||
        chapter.path.startsWith("/") ||
        chapter.path.includes("\\") ||
        chapter.path.split("/").some((part) => part === ".." || part === "." || !part)
      )
        throw error("EPUB_INVALID");
      const rawSize = chapter.bytes ?? chapter.size;
      const size = rawSize == null ? 0 : Number(rawSize);
      if (!Number.isFinite(size) || size < 0 || size > LIMITS.chapterBytes)
        throw error("READER_RESOURCE_LIMIT");
      declaredBytes += size;
    }
    if (declaredBytes > LIMITS.chapterTotalBytes) throw error("READER_RESOURCE_LIMIT");
    if (manifest.toc !== undefined) {
      if (!Array.isArray(manifest.toc)) throw error("EPUB_INVALID");
      for (const item of manifest.toc)
        if (!item || typeof item.title !== "string" || !item.title.trim() ||
            !Number.isInteger(item.chapter) || item.chapter < 1 || item.chapter > manifest.chapters.length ||
            !Number.isInteger(item.depth) || item.depth < 0 || item.depth > 64 ||
            typeof item.fragment !== "string") throw error("EPUB_INVALID");
    }
    if (manifest.search_index?.text_profile !== undefined &&
        manifest.search_index.text_profile !== "dom-text-v1") throw error("EPUB_INVALID");
    return /** @type {import('../../../typings/reader-security-strict').ValidatedChapterManifest} */ (/** @type {unknown} */ (manifest));
  }
  /** @param {unknown} input @returns {import('../../../typings/reader-security-strict').ValidatedPdfPageManifest} */
  function validatePdfPageManifest(input) {
    const manifest = /** @type {import('../../../typings/reader-security-strict').PdfPageManifestCandidate} */ (/** @type {unknown} */ (input));
    if (!manifest || manifest.version !== 2 || manifest.kind !== "pdf-pages")
      throw error("PDF_MANIFEST_INVALID");
    if (!Number.isInteger(manifest.page_count) || manifest.page_count < 1 || manifest.pages !== undefined)
      throw error("PDF_MANIFEST_INVALID");
    const pageCount = manifest.page_count;
    if (pageCount > LIMITS.pdfPages) throw error("READER_RESOURCE_LIMIT");
    if (manifest.codec !== undefined && !["webp", "jxl", "png", "mixed"].includes(manifest.codec))
      throw error("PDF_MANIFEST_INVALID");
    if (["jxl", "png", "mixed"].includes(manifest.codec) && (!Array.isArray(manifest.images) || manifest.images.length !== pageCount ||
        manifest.images.some(ref => (typeof ref?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ref.sha256)) ||
          !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > LIMITS.chapterBytes)))
      throw error("PDF_MANIFEST_INVALID");
    if (["png", "mixed"].includes(manifest.codec) && (manifest.source_format !== "djvu" ||
        (typeof manifest.source_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.source_sha256)) || manifest.codec === "mixed" &&
        manifest.images.some(ref => !["png", "jxl", "webp"].includes(ref.codec))))
      throw error("PDF_MANIFEST_INVALID");
    if (manifest.toc !== undefined) {
      if (!Array.isArray(manifest.toc) || manifest.toc.length > 2000)
        throw error("PDF_MANIFEST_INVALID");
      for (const item of manifest.toc) {
        if (
          !item ||
          typeof item.title !== "string" ||
          !item.title.trim() ||
          item.title.length > 500 ||
          !Number.isInteger(item.page) ||
          item.page < 1 ||
          item.page > pageCount ||
          !Number.isInteger(item.depth) ||
          item.depth < 0 ||
          item.depth > 32
        )
          throw error("PDF_MANIFEST_INVALID");
      }
    }
    if (manifest.ocr !== undefined) {
      if (typeof manifest.source_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.source_sha256))
        throw error("PDF_MANIFEST_INVALID");
      if (!Array.isArray(manifest.ocr) || manifest.ocr.length !== pageCount)
        throw error("PDF_MANIFEST_INVALID");
      for (const [index, page] of manifest.ocr.entries()) {
        const expected = String(index + 1).padStart(6, "0"),
          root = typeof page?.o === "string" ? PDF_OCR_ROOT.exec(page.o)?.[1] || "" : "";
        if (!page || page.p !== index + 1 || !PDF_OCR_PATH.test(page.o) ||
            page.o !== `${root}/ocr/page-${expected}.json.gz` ||
            pdfSourceRoot(root) !== `objects/${manifest.source_sha256.slice(0, 2)}/${manifest.source_sha256}` ||
            (typeof page.os !== "string" || !/^[0-9a-f]{64}$/.test(page.os)) ||
            !Number.isSafeInteger(page.ob) || page.ob < 1)
          throw error("PDF_MANIFEST_INVALID");
      }
    }
    return /** @type {import('../../../typings/reader-security-strict').ValidatedPdfPageManifest} */ (/** @type {unknown} */ (manifest));
  }
  const PDF_OCR_PATH = /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:[0-9a-f]{16}\/)?ocr\/(?:page-[0-9]{6}\.json\.gz|book-text\.json\.gz)$/;
  const PDF_OCR_PAGE_PATH = /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:[0-9a-f]{16}\/)?pages\/page-[0-9]{6}\.(?:webp|jxl|png)$/;
  const PDF_OCR_ROOT = /^(objects\/[0-9a-f]{2}\/[0-9a-f]{64}(?:\/[0-9a-f]{16})?)/;
  /** @param {unknown} path */
  function pdfSourceRoot(path) {
    return typeof path === "string" ? path.split("/").slice(0, 3).join("/") : "";
  }
  /** @param {unknown} input @returns {import('../../../typings/reader-security-strict').ValidatedPdfOcrManifest} */
  function validatePdfOcrManifest(input) {
    const manifest = /** @type {import('../../../typings/reader-security-strict').PdfOcrManifestCandidate} */ (/** @type {unknown} */ (input));
    if (!manifest || manifest.version !== 1 || manifest.kind !== "pdf-ocr" ||
        manifest.complete !== true || (typeof manifest.source_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.source_sha256)) ||
         !/layout-v\d+(?:-|$)/.test(String(manifest.profile || "")) ||
        !Number.isInteger(manifest.page_count) || manifest.page_count < 1 ||
        manifest.page_count > LIMITS.pdfPages || !Array.isArray(manifest.pages) ||
        manifest.pages.length !== manifest.page_count)
      throw error("PDF_OCR_MANIFEST_INVALID");
    let root = "";
    for (const [index, page] of manifest.pages.entries()) {
      const expected = String(index + 1).padStart(6, "0");
      const pageRoot = typeof page?.o === "string" ? PDF_OCR_ROOT.exec(page.o)?.[1] || "" : "";
      if (!page || page.p !== index + 1 || !PDF_OCR_PATH.test(page.o) ||
          page.o !== `${pageRoot}/ocr/page-${expected}.json.gz` ||
          (page.w !== undefined && (typeof page.w !== "string" || !PDF_OCR_PAGE_PATH.test(page.w) ||
            !page.w.endsWith(`/pages/page-${expected}.webp`) ||
            pdfSourceRoot(page.w) !== pdfSourceRoot(pageRoot))) ||
           (page.j !== undefined && (typeof page.j !== "string" || !PDF_OCR_PAGE_PATH.test(page.j) ||
            !page.j.endsWith(`/pages/page-${expected}.jxl`) ||
             pdfSourceRoot(page.j) !== pdfSourceRoot(pageRoot))) ||
          (page.r !== undefined && (typeof page.r !== "string" || !PDF_OCR_PAGE_PATH.test(page.r) ||
            !page.r.endsWith(`/pages/page-${expected}.png`) || pdfSourceRoot(page.r) !== pdfSourceRoot(pageRoot) ||
            manifest.source_format !== "djvu" || page.w !== undefined || page.j !== undefined ||
            page.rbucket !== "vomebook/pdf-pages-v2" || (typeof page.rs !== "string" || !/^[0-9a-f]{64}$/.test(page.rs)) ||
            !Number.isSafeInteger(page.rb) || page.rb < 1)) ||
          pdfSourceRoot(pageRoot) !== `objects/${manifest.source_sha256.slice(0, 2)}/${manifest.source_sha256}` ||
          (root && pdfSourceRoot(root) !== pdfSourceRoot(pageRoot)))
        throw error("PDF_OCR_MANIFEST_INVALID");
      root = pageRoot;
    }
    if (!manifest.book_text || typeof manifest.book_text.path !== "string" ||
        !PDF_OCR_PATH.test(manifest.book_text.path) || !manifest.book_text.path.endsWith('/ocr/book-text.json.gz') ||
        pdfSourceRoot(manifest.book_text.path) !== pdfSourceRoot(root) ||
        (typeof manifest.book_text.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.book_text.sha256)) ||
        !Number.isSafeInteger(manifest.book_text.bytes) || manifest.book_text.bytes < 1 ||
        (manifest.page_manifest !== undefined &&
          (!manifest.page_manifest || typeof manifest.page_manifest.path !== "string" ||
            !/^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:[0-9a-f]{16}\/)?page-manifest\.json$/.test(manifest.page_manifest.path) ||
            pdfSourceRoot(manifest.page_manifest.path) !== pdfSourceRoot(root))))
      throw error("PDF_OCR_MANIFEST_INVALID");
    return /** @type {import('../../../typings/reader-security-strict').ValidatedPdfOcrManifest} */ (/** @type {unknown} */ (manifest));
  }
  /** @param {unknown} input @param {number} pageNumber @returns {import('../../../typings/reader-security-strict').ValidatedPdfOcrPage} */
  function validatePdfOcrPage(input, pageNumber) {
    const payload = /** @type {import('../../../typings/reader-security-strict').PdfOcrPageCandidate} */ (/** @type {unknown} */ (input));
    if (!payload || payload.version !== 1 || payload.kind !== "pdf-ocr-page" ||
        payload.page !== pageNumber || !Array.isArray(payload.blocks) || payload.blocks.length > 10000 ||
        !Number.isFinite(payload.width) || payload.width <= 0 ||
        !Number.isFinite(payload.height) || payload.height <= 0)
      throw error("PDF_OCR_PAGE_INVALID");
    for (const block of payload.blocks) {
      const box = block?.b;
      if (!block || typeof block.t !== "string" || block.t.length > 4096 ||
          !Array.isArray(box) || box.length !== 4 || box.some((value) => !Number.isFinite(value)) ||
          box[0] < 0 || box[1] < 0 || box[2] > 1 || box[3] > 1 || box[2] < box[0] || box[3] < box[1])
        throw error("PDF_OCR_PAGE_INVALID");
    }
    return /** @type {import('../../../typings/reader-security-strict').ValidatedPdfOcrPage} */ (/** @type {unknown} */ (payload));
  }
  root.VoiceOfMLReaderSecurity = Object.freeze({
    LIMITS,
    assertResponseSize,
    createByteBudget,
    readBytes,
    readText,
    validateChapterManifest,
    validatePdfPageManifest,
    validatePdfOcrManifest,
    validatePdfOcrPage
  });
})(/** @type {import('../../../typings/reader-security-strict').SecurityRoot} */ (typeof self !== "undefined" ? self : globalThis));

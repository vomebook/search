(function (root) {
  "use strict";
  const LIMITS = Object.freeze({
    documentBytes: 512 * 1024 * 1024,
    archiveCompressedBytes: 512 * 1024 * 1024,
    archiveExpandedBytes: 1536 * 1024 * 1024,
    archiveEntries: 20000,
    archiveRatio: 200,
    manifestBytes: 8 * 1024 * 1024,
    pdfPages: 100000,
    chapters: 10000,
    chapterBytes: 8 * 1024 * 1024,
    chapterTotalBytes: 512 * 1024 * 1024
  });
  function error(code) {
    const value = new Error(code);
    value.code = code;
    return value;
  }
  function assertResponseSize(response, limit) {
    const length = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > limit) throw error("READER_RESOURCE_LIMIT");
    return response;
  }
  function createByteBudget(limit = LIMITS.chapterTotalBytes) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid byte budget");
    let used = 0;
    function reserve(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Invalid byte count");
      if (bytes > limit - used) throw error("READER_RESOURCE_LIMIT");
      used += bytes;
    }
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

  function inspectZip(bytes, limits = LIMITS) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (bytes.byteLength > limits.archiveCompressedBytes) throw error("READER_ARCHIVE_LIMIT");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    // EOCD must end at EOF, including its optional comment. File contents are
    // never searched for central-directory entries.
    for (
      let offset = bytes.byteLength - 22;
      offset >= Math.max(0, bytes.byteLength - 22 - 65535);
      offset--
    ) {
      if (
        view.getUint32(offset, true) === 0x06054b50 &&
        offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength
      ) {
        end = offset;
        break;
      }
    }
    if (end < 0) throw error("READER_ARCHIVE_INVALID");
    const disk = view.getUint16(end + 4, true),
      directoryDisk = view.getUint16(end + 6, true);
    const diskEntries = view.getUint16(end + 8, true),
      entries = view.getUint16(end + 10, true);
    const directorySize = view.getUint32(end + 12, true),
      directoryOffset = view.getUint32(end + 16, true);
    if (
      disk === 0xffff ||
      directoryDisk === 0xffff ||
      diskEntries === 0xffff ||
      entries === 0xffff ||
      directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff ||
      (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50)
    ) {
      throw error("READER_ARCHIVE_ZIP64_UNSUPPORTED");
    }
    if (disk || directoryDisk || diskEntries !== entries)
      throw error("READER_ARCHIVE_MULTIDISK_UNSUPPORTED");
    if (!entries || directoryOffset + directorySize !== end) throw error("READER_ARCHIVE_INVALID");
    if (entries > limits.archiveEntries) throw error("READER_ARCHIVE_LIMIT");
    let offset = directoryOffset,
      compressed = 0,
      expanded = 0;
    for (let index = 0; index < entries; index++) {
      if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
        throw error("READER_ARCHIVE_INVALID");
      const packed = view.getUint32(offset + 20, true),
        unpacked = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true),
        extraLength = view.getUint16(offset + 30, true),
        commentLength = view.getUint16(offset + 32, true);
      const startDisk = view.getUint16(offset + 34, true),
        localOffset = view.getUint32(offset + 42, true);
      if (
        packed === 0xffffffff ||
        unpacked === 0xffffffff ||
        localOffset === 0xffffffff ||
        startDisk === 0xffff
      ) {
        throw error("READER_ARCHIVE_ZIP64_UNSUPPORTED");
      }
      if (startDisk) throw error("READER_ARCHIVE_MULTIDISK_UNSUPPORTED");
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (!nameLength || next > end) throw error("READER_ARCHIVE_INVALID");
      const extraEnd = offset + 46 + nameLength + extraLength;
      for (let extra = offset + 46 + nameLength; extra < extraEnd; ) {
        if (extra + 4 > extraEnd) throw error("READER_ARCHIVE_INVALID");
        if (view.getUint16(extra, true) === 1) throw error("READER_ARCHIVE_ZIP64_UNSUPPORTED");
        extra += 4 + view.getUint16(extra + 2, true);
        if (extra > extraEnd) throw error("READER_ARCHIVE_INVALID");
      }
      if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50)
        throw error("READER_ARCHIVE_INVALID");
      const dataOffset =
        localOffset +
        30 +
        view.getUint16(localOffset + 26, true) +
        view.getUint16(localOffset + 28, true);
      if (dataOffset + packed > directoryOffset) throw error("READER_ARCHIVE_INVALID");
      compressed += packed;
      expanded += unpacked;
      if (
        expanded > limits.archiveExpandedBytes ||
        (packed === 0 ? unpacked > 0 : unpacked / packed > limits.archiveRatio)
      ) {
        throw error("READER_ARCHIVE_LIMIT");
      }
      offset = next;
    }
    if (offset !== end) throw error("READER_ARCHIVE_INVALID");
    return Object.freeze({ entries, compressed, expanded });
  }
  function validateChapterManifest(manifest) {
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
    return manifest;
  }
  function validatePdfPageManifest(manifest) {
    if (!manifest || ![1, 2].includes(manifest.version) || manifest.kind !== "pdf-pages")
      throw error("PDF_MANIFEST_INVALID");
    let pageCount = 0;
    if (manifest.version === 1) {
      if (!Array.isArray(manifest.pages) || !manifest.pages.length)
        throw error("PDF_MANIFEST_INVALID");
      pageCount = manifest.pages.length;
      if (pageCount > LIMITS.pdfPages) throw error("READER_RESOURCE_LIMIT");
      const seen = new Set();
      for (const item of manifest.pages) {
        if (
          !item ||
          !Number.isInteger(item.page) ||
          item.page < 1 ||
          seen.has(item.page) ||
          typeof item.path !== "string" ||
          !item.path.trim()
        )
          throw error("PDF_MANIFEST_INVALID");
        seen.add(item.page);
      }
    } else {
      if (
        !Number.isInteger(manifest.page_count) ||
        manifest.page_count < 1 ||
        manifest.pages !== undefined
      )
        throw error("PDF_MANIFEST_INVALID");
      pageCount = manifest.page_count;
      if (pageCount > LIMITS.pdfPages) throw error("READER_RESOURCE_LIMIT");
    }
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
    return manifest;
  }
  function isZipContainer(extension, bytes) {
    return (
      ["epub", "fbz"].includes(String(extension || "").toLowerCase()) ||
      !!(bytes && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
    );
  }
  root.VoiceOfMLReaderSecurity = Object.freeze({
    LIMITS,
    assertResponseSize,
    createByteBudget,
    readBytes,
    readText,
    inspectZip,
    validateChapterManifest,
    validatePdfPageManifest,
    isZipContainer
  });
})(typeof self !== "undefined" ? self : globalThis);

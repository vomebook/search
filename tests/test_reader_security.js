const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { deflateRawSync } = require("zlib");
const sandbox = { self: {}, TextDecoder, Uint8Array, DataView };
sandbox.self = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/reader-security.js"), "utf8"), sandbox);
const security = sandbox.VoiceOfMLReaderSecurity;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries, comment = Buffer.alloc(0)) {
  const locals = [], directory = [];
  let position = 0;
  for (const { name, data, deflate = false, descriptor = false, extra = Buffer.alloc(0) } of entries) {
    const filename = Buffer.from(name), packed = deflate ? deflateRawSync(data) : data;
    const crc = crc32(data), method = deflate ? 8 : 0, flags = descriptor ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(position, 42);
    const trailer = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      trailer.writeUInt32LE(0x08074b50);
      trailer.writeUInt32LE(crc, 4);
      trailer.writeUInt32LE(packed.length, 8);
      trailer.writeUInt32LE(data.length, 12);
    }
    locals.push(local, filename, packed, trailer);
    directory.push(central, filename, extra);
    position += local.length + filename.length + packed.length + trailer.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(position, 16);
  end.writeUInt16LE(comment.length, 20);
  return { bytes: Buffer.concat([...locals, central, end, comment]), directory: position, end: position + central.length };
}

function streamResponse(chunks, header = null) {
  const state = { reads: 0, cancels: 0, released: false };
  const response = {
    headers: { get: () => header },
    body: {
      cancel: async () => { state.cancels++; },
      getReader: () => ({
        read: async () => {
          const value = chunks[state.reads++];
          return value === undefined ? { done: true } : { value, done: false };
        },
        cancel: async () => { state.cancels++; },
        releaseLock: () => { state.released = true; },
      }),
    },
  };
  return { response, state };
}

async function main() {
  const valid = zip([{ name: "chapter.xhtml", data: Buffer.from("Readable chapter"), deflate: true, descriptor: true }], Buffer.from("ZIP comment PK\x05\x06"));
  assert.strictEqual(security.inspectZip(valid.bytes).entries, 1);
  assert.strictEqual(security.inspectZip(valid.bytes).compressed, deflateRawSync(Buffer.from("Readable chapter")).length);
  assert.strictEqual(security.inspectZip(valid.bytes).expanded, 16);
  assert.strictEqual(security.isZipContainer("mobi", valid.bytes), true);
  assert.strictEqual(security.isZipContainer("FBZ"), true);
  assert.strictEqual(security.isZipContainer("mobi", new Uint8Array(4)), false);
  for (const extension of ["epub", "fbz", "fb2", "mobi", "azw3"]) assert.strictEqual(security.isZipContainer(extension), ["epub", "fbz"].includes(extension));

  // A directory-looking payload must not redirect scanning away from the EOCD directory.
  const decoy = Buffer.alloc(46);
  decoy.writeUInt32LE(0x02014b50);
  decoy.writeUInt32LE(100, 20);
  decoy.writeUInt32LE(100, 24);
  decoy.writeUInt16LE(65535, 28);
  const bomb = zip([
    { name: "decoy.bin", data: decoy },
    { name: "chapter.xhtml", data: Buffer.alloc(1024 * 1024, 65), deflate: true },
  ]);
  assert.throws(() => security.inspectZip(bomb.bytes), /READER_ARCHIVE_LIMIT/);
  decoy.writeUInt32LE(0xffffffff, 24);
  const harmless = zip([{ name: "decoy.bin", data: decoy }]);
  assert.strictEqual(security.inspectZip(harmless.bytes).expanded, decoy.length);
  assert.throws(() => security.inspectZip(decoy), /READER_ARCHIVE_INVALID/);
  assert.throws(() => security.inspectZip(valid.bytes.subarray(0, valid.end + 10)), /READER_ARCHIVE_INVALID/);
  assert.throws(() => security.inspectZip(new Uint8Array(3)), /READER_ARCHIVE_INVALID/);
  assert.throws(() => security.inspectZip(valid.bytes, { ...security.LIMITS, archiveCompressedBytes: 1 }), /READER_ARCHIVE_LIMIT/);
  assert.throws(() => security.inspectZip(valid.bytes, { ...security.LIMITS, archiveExpandedBytes: 1 }), /READER_ARCHIVE_LIMIT/);
  assert.throws(() => security.inspectZip(valid.bytes, { ...security.LIMITS, archiveEntries: 0 }), /READER_ARCHIVE_LIMIT/);

  for (const [mutate, expected] of [
    [(b) => b.writeUInt32LE(valid.directory + 1, valid.end + 16), /READER_ARCHIVE_INVALID/],
    [(b) => { b.writeUInt16LE(2, valid.end + 8); b.writeUInt16LE(2, valid.end + 10); }, /READER_ARCHIVE_INVALID/],
    [(b) => b.writeUInt16LE(65535, valid.directory + 28), /READER_ARCHIVE_INVALID/],
    [(b) => b.writeUInt32LE(valid.directory, valid.directory + 42), /READER_ARCHIVE_INVALID/],
    [(b) => b.writeUInt32LE(0, 0), /READER_ARCHIVE_INVALID/],
    [(b) => b.writeUInt16LE(1, valid.end + 4), /READER_ARCHIVE_MULTIDISK_UNSUPPORTED/],
    [(b) => b.writeUInt16LE(1, valid.directory + 34), /READER_ARCHIVE_MULTIDISK_UNSUPPORTED/],
    [(b) => b.writeUInt16LE(0xffff, valid.end + 10), /READER_ARCHIVE_ZIP64_UNSUPPORTED/],
    [(b) => b.writeUInt32LE(0xffffffff, valid.directory + 24), /READER_ARCHIVE_ZIP64_UNSUPPORTED/],
  ]) {
    const bytes = Buffer.from(valid.bytes);
    mutate(bytes);
    assert.throws(() => security.inspectZip(bytes), expected);
  }
  const zip64Extra = zip([{ name: "a", data: Buffer.from("a"), extra: Buffer.from([1, 0, 0, 0]) }]);
  assert.throws(() => security.inspectZip(zip64Extra.bytes), /READER_ARCHIVE_ZIP64_UNSUPPORTED/);

  const chapterManifest = { version: 1, kind: "epub-chapters", chapters: [{ index: 1, path: "chapter.xhtml", bytes: 10 }] };
  security.validateChapterManifest(chapterManifest);
  for (const [chapter, expected] of [
    [{ index: 1, path: "chapter.xhtml", bytes: security.LIMITS.chapterBytes + 1 }, /READER_RESOURCE_LIMIT/],
    [{ index: 2, path: "chapter.xhtml" }, /EPUB_INVALID/],
    [{ index: 1, path: "../escape.xhtml" }, /EPUB_INVALID/],
  ]) assert.throws(() => security.validateChapterManifest({ ...chapterManifest, chapters: [chapter] }), expected);
  const validTocManifest = { version: 2, kind: "pdf-pages", page_count: 1, toc: [{ title: "第一章", page: 1, depth: 0 }] };
  security.validatePdfPageManifest(validTocManifest);
  security.validatePdfPageManifest({ version: 2, kind: "pdf-pages", page_count: 100, toc: [{ title: "第一章", page: 100, depth: 0 }] });
  assert.throws(() => security.validatePdfPageManifest({ version: 2, kind: "pdf-pages", page_count: 0 }), /PDF_MANIFEST_INVALID/);
  assert.throws(() => security.validatePdfPageManifest({ version: 2, kind: "pdf-pages", page_count: 1, pages: [] }), /PDF_MANIFEST_INVALID/);
  assert.throws(() => security.validatePdfPageManifest({ ...validTocManifest, toc: [{ title: "bad", page: 2, depth: 0 }] }), /PDF_MANIFEST_INVALID/);
  assert.throws(() => security.validatePdfPageManifest({ ...validTocManifest, pages: [] }), /PDF_MANIFEST_INVALID/);
  assert.throws(() => security.validatePdfPageManifest({ version: 1, kind: "pdf-pages", pages: [{ page: 1, path: "pages/page-000001.webp" }] }), /PDF_MANIFEST_INVALID/);

  const oversized = streamResponse([], "9");
  assert.throws(() => security.assertResponseSize(oversized.response, 8), /READER_RESOURCE_LIMIT/);
  await assert.rejects(security.readBytes(oversized.response, 8), /READER_RESOURCE_LIMIT/);
  assert.strictEqual(oversized.state.reads, 0);
  assert.strictEqual(oversized.state.cancels, 1);
  oversized.response.body.cancel = async () => { throw new Error("cancel failed"); };
  await assert.rejects(security.readBytes(oversized.response, 8), /READER_RESOURCE_LIMIT/);
  const overflow = streamResponse([new Uint8Array(5), new Uint8Array(5), new Uint8Array(5)]);
  await assert.rejects(security.readBytes(overflow.response, 8), /READER_RESOURCE_LIMIT/);
  assert.deepStrictEqual(overflow.state, { reads: 2, cancels: 1, released: true });
  assert.strictEqual(await security.readText(streamResponse([Buffer.from("text")]).response, 4), "text");

  const budget = security.createByteBudget(8);
  const first = streamResponse([new Uint8Array(3), new Uint8Array(3)]);
  const second = streamResponse([new Uint8Array(3), new Uint8Array(3)]);
  const results = await Promise.allSettled([security.readBytes(first.response, 8, budget), security.readBytes(second.response, 8, budget)]);
  assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.strictEqual(results.find((result) => result.status === "rejected").reason.code, "READER_RESOURCE_LIMIT");
  assert.strictEqual(budget.used, 6);
  assert.strictEqual(budget.remaining, 2);
  assert.strictEqual(first.state.cancels + second.state.cancels, 1);
  budget.release(6);
  assert.strictEqual(await security.readText(streamResponse([Buffer.from("retry")]).response, 8, "utf-8", budget), "retry");
  assert.strictEqual(budget.used, 5);
  const failed = streamResponse([new Uint8Array(2), new Uint8Array(9)]);
  await assert.rejects(security.readBytes(failed.response, 8, budget), /READER_RESOURCE_LIMIT/);
  assert.strictEqual(budget.used, 5);
  await assert.rejects(security.readBytes({ headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(4) }, 8, budget), /READER_RESOURCE_LIMIT/);
  assert.strictEqual(budget.used, 5);
  assert.throws(() => budget.release(6), /Invalid byte release/);
  assert.throws(() => budget.reserve(-1), /Invalid byte count/);
  assert.throws(() => security.createByteBudget(-1), /Invalid byte budget/);
  console.log("reader security contracts passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

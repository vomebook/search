import assert from "assert";
import { createHash } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

const { mkdtemp, readFile, rm } = fs.promises;
const { tmpdir } = os;
const { join } = path;
const { gzipSync } = zlib;

import { assertLiveReader, DEFAULT_READER_ASSETS_URL, fetchReaderAssets, validateReaderAssets } from "../../../scripts/data/fetch_reader_assets.mjs";

const valid = gzipSync(Buffer.from(JSON.stringify({ v: 1, f: { "VoiceOfML/Test\0Book.docx": { s: 2, m: "d", p: "objects/aa/hash/profile/document.docx" } } })));
assert.equal(validateReaderAssets(valid).v, 1);
assert.throws(() => validateReaderAssets(gzipSync(Buffer.from("{}"))), /invalid Reader Assets sidecar/);

async function main() {
  const root = await mkdtemp(join(tmpdir(), "reader-sidecar-"));
  const originalFetch = globalThis.fetch;
  const OriginalAbortController = globalThis.AbortController;
  try {
    globalThis.AbortController = class { constructor() { this.signal = {}; } abort() {} };
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => valid });
    const output = join(root, "data", "reader_assets.json.gz");
    await fetchReaderAssets(output, "https://example.test/reader_assets.json.gz", 1);
    assert.deepEqual(await readFile(output), valid);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.AbortController = OriginalAbortController;
    await rm(root, { recursive: true, force: true });
  }
  await testPinned();
  console.log("reader sidecar fetch: passed");
}

async function testPinned() {
  const root = await mkdtemp(join(tmpdir(), "reader-pinned-"));
  const output = join(root, "reader_assets.json.gz");
  const bucket = "vomebook/reader-assets-v2";
  const url = `https://huggingface.co/buckets/${bucket}/resolve/`;
  const checksum = bytes => createHash("sha256").update(bytes).digest("hex");
  const generation = "a".repeat(64);
  const catalog = {version: 3, kind: "reader-reading-catalog", generation, files: {},
    base_sidecar: { bucket, role: "runtime", bytes: valid.length, sha256: checksum(valid),
      path: `reader-index/snapshots/${checksum(valid)}/reader_assets.json.gz` }};
  const catalogPath = `reader-index/v3/generations/${generation}/catalog.json`;
  let bytes = Buffer.from(JSON.stringify(catalog));
  const expected = {generation, catalog_sha256: checksum(bytes)};
  const pointer = {version: 1, kind: "reader-reading-pointer", generation,
    catalog: {bucket, role: "runtime", path: catalogPath, bytes: bytes.length, sha256: expected.catalog_sha256}};
  const originalFetch = globalThis.fetch, requests = [];
  let pointerReads = 0, advance = false, snapshot = valid;
  try {
    globalThis.fetch = async input => {
      requests.push(input);
      if (input === url + catalogPath) return new Response(bytes);
      if (input === url + catalog.base_sidecar.path) return new Response(snapshot);
      if (input.startsWith(url + "reader-index/v3/current.json?pages_check=")) {
        pointerReads++;
        if (advance && pointerReads === 2) return new Response("absent", {status: 404});
        return Response.json(pointer);
      }
      if (input.startsWith(DEFAULT_READER_ASSETS_URL + "?pages_check=")) return new Response(valid);
      throw new Error(`unexpected unpinned request: ${input}`);
    };
    await fetchReaderAssets(output, DEFAULT_READER_ASSETS_URL, 1, expected);
    assert.deepEqual(requests, [url + catalogPath, url + catalog.base_sidecar.path]);
    const built = await readFile(output);
    assert.deepEqual(validateReaderAssets(built).f, validateReaderAssets(valid).f);
    const receipt = JSON.parse(await readFile(join(root, "reader_v3_receipt.json"), "utf8"));
    assert.equal(receipt.sidecar_sha256, checksum(built));
    await assertLiveReader(receipt, true);
    await assertLiveReader(receipt, false);
    await assert.rejects(assertLiveReader({...receipt, active: false}, false), /current Reader data differs/);
    await assert.rejects(assertLiveReader({...receipt, catalog_sha256: "b".repeat(64)}, true), /current HF Reader/);
    pointerReads = 0;
    advance = true;
    await assert.rejects(assertLiveReader(receipt, true), /current HF Reader/);
    await assert.rejects(fetchReaderAssets(output, DEFAULT_READER_ASSETS_URL, 1, {generation}), /expected both/);
    await assert.rejects(fetchReaderAssets(output, "https://example.test/invalid", 1, expected), /official immutable/);
    snapshot = Buffer.from(valid);
    snapshot[0] ^= 1;
    await assert.rejects(fetchReaderAssets(output, DEFAULT_READER_ASSETS_URL, 1, expected), /unified sidecar checksum/);
    bytes = Buffer.from(JSON.stringify({...catalog, base_sidecar: null}));
    await assert.rejects(fetchReaderAssets(output, DEFAULT_READER_ASSETS_URL, 1, expected), /pointer\/catalog digest/);
    await assert.rejects(fetchReaderAssets(output, DEFAULT_READER_ASSETS_URL, 1,
      {generation, catalog_sha256: checksum(bytes)}), /requires an immutable base_sidecar/);
    assert.deepEqual(await readFile(output), built);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, {recursive: true, force: true});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

const { mkdtemp, readFile, rmdir } = fs.promises;
const { tmpdir } = os;
const { join } = path;
const { gzipSync } = zlib;

import { fetchReaderAssets, validateReaderAssets } from "../scripts/fetch_reader_assets.mjs";

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
    await rmdir(root, { recursive: true });
  }
  console.log("reader sidecar fetch: passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

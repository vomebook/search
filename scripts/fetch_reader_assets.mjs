import fs from "fs";
import path from "path";
import urlModule from "url";
import zlib from "zlib";
import crypto from "node:crypto";

const { mkdir, rename, unlink, writeFile } = fs.promises;
const { dirname, join } = path;
const { fileURLToPath } = urlModule;
const { gunzipSync, gzipSync } = zlib;

export const DEFAULT_READER_ASSETS_URL = "https://huggingface.co/buckets/vomebook/reader-assets-v2/resolve/reader-index/reader_assets.json.gz";
const V3_BASE = "https://huggingface.co/buckets/vomebook/reader-assets-v2/resolve/";
const sha = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const MAX_V3_BYTES = 8 * 1024 * 1024;

export function projectV3(base, pointer, bytes) {
  const ref = pointer?.catalog, generation = pointer?.generation;
  if (pointer?.version !== 1 || pointer?.kind !== "reader-reading-pointer" || !sha(generation) ||
      ref?.bucket !== "vomebook/reader-assets-v2" || ref.role !== "runtime" ||
      ref.path !== `reader-index/v3/generations/${generation}/catalog.json` ||
      !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_V3_BYTES ||
      ref.bytes !== bytes.length || !sha(ref.sha256) || digest(bytes) !== ref.sha256) throw Error("invalid v3 pointer/catalog digest");
  const catalog = JSON.parse(bytes.toString("utf8"));
  if (catalog.version !== 3 || catalog.kind !== "reader-reading-catalog" || catalog.generation !== generation ||
      !catalog.files || typeof catalog.files !== "object" || Array.isArray(catalog.files)) throw Error("invalid v3 catalog");
  const files = { ...base.f };
  for (const [key, entry] of Object.entries(catalog.files)) {
    const resource = entry?.resource, source = entry?.source_sha256;
    if (!key || !sha(source) || !sha(entry.reading_generation) || resource?.bucket !== "vomebook/pdf-pages-v2" ||
        resource.role !== "runtime" || !sha(resource.sha256) || !Number.isSafeInteger(resource.bytes) || resource.bytes < 1 ||
        !new RegExp(`^objects/${source.slice(0, 2)}/${source}/[0-9a-f]{16}/reading-manifest\\.json$`).test(resource.path))
      throw Error("invalid v3 reading entry");
    files[key] = { s: 2, m: "p", p: resource.path, b: resource.bucket };
  }
  return { ...base, f: files, v3: { generation, catalog_sha256: ref.sha256, files: Object.keys(catalog.files).length } };
}

async function loadV3(signal) {
  async function read(path, missing = false) {
    const response = await fetch(V3_BASE + path, { signal, cache: "no-store" });
    if (missing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) throw Error(`v3 metadata HTTP ${response.status}`);
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_V3_BYTES) throw Error("v3 metadata too large");
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, size);
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  const packed = await read("reader-index/v3/current.json", true);
  if (!packed) return null;
  const pointer = JSON.parse(packed.toString("utf8"));
  if (!sha(pointer.generation) || pointer.catalog?.path !== `reader-index/v3/generations/${pointer.generation}/catalog.json`)
    throw Error("invalid v3 catalog path");
  return { pointer, bytes: await read(pointer.catalog.path) };
}

export function validateReaderAssets(bytes) {
  const data = JSON.parse(gunzipSync(bytes).toString("utf8"));
  if (!data || data.v !== 1 || !data.f || typeof data.f !== "object" || Array.isArray(data.f)) {
    throw new Error("invalid Reader Assets sidecar");
  }
  return data;
}

export async function fetchReaderAssets(output, url = DEFAULT_READER_ASSETS_URL, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Reader Assets request failed: HTTP ${response.status}`);
      let bytes = Buffer.from(await response.arrayBuffer());
      const base = validateReaderAssets(bytes);
      let active = null;
      if (url === DEFAULT_READER_ASSETS_URL) {
        const catalog = await loadV3(controller.signal);
        if (catalog) {
          const projected = projectV3(base, catalog.pointer, catalog.bytes);
          active = projected.v3;
          bytes = gzipSync(Buffer.from(JSON.stringify(projected)));
        } else if (base.v3) throw Error("previous v3 pointer disappeared");
      }
      await mkdir(dirname(output), { recursive: true });
      const temporary = `${output}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, output);
      if (url === DEFAULT_READER_ASSETS_URL) {
        const receipt = { version: 1, surface: "pages", active: active !== null,
          ...active, sidecar_sha256: digest(bytes), reader_contract: "pdf-reading-v3-v1" };
        await writeFile(join(dirname(output), "reader_v3_receipt.json"), JSON.stringify(receipt));
      }
      return;
    } catch (error) {
      lastError = error;
      await unlink(`${output}.tmp`).catch(() => {});
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("usage: node scripts/fetch_reader_assets.mjs OUTPUT [URL]");
  await fetchReaderAssets(output, process.argv[3] || DEFAULT_READER_ASSETS_URL);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

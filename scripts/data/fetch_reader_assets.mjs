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
const catalogPath = generation => `reader-index/v3/generations/${generation}/catalog.json`;

function validatePointer(pointer) {
  const ref = pointer?.catalog, generation = pointer?.generation;
  if (pointer?.version !== 1 || pointer?.kind !== "reader-reading-pointer" || !sha(generation) ||
      ref?.bucket !== "vomebook/reader-assets-v2" || ref.role !== "runtime" ||
      ref.path !== catalogPath(generation) || !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 1 || ref.bytes > MAX_V3_BYTES || !sha(ref.sha256)) throw Error("invalid v3 pointer/catalog reference");
  return ref;
}

function validateCatalog(pointer, bytes) {
  const ref = validatePointer(pointer);
  if (ref.bytes !== bytes.length || digest(bytes) !== ref.sha256) throw Error("invalid v3 pointer/catalog digest");
  const catalog = JSON.parse(bytes.toString("utf8"));
  if (catalog?.version !== 3 || catalog.kind !== "reader-reading-catalog" || catalog.generation !== pointer.generation ||
      !catalog.files || typeof catalog.files !== "object" || Array.isArray(catalog.files)) throw Error("invalid v3 catalog");
  return catalog;
}

export function projectV3(base, pointer, bytes, packedBase) {
  const catalog = validateCatalog(pointer, bytes);
  const { generation, catalog: ref } = pointer;
  if (catalog.base_sidecar) {
    const snapshot = validateBaseRef(catalog.base_sidecar);
    if (!packedBase || packedBase.length !== snapshot.bytes || digest(packedBase) !== snapshot.sha256)
      throw Error("unified sidecar checksum mismatch");
    base = validateReaderAssets(packedBase);
  }
  if (!base) throw Error("pinned v3 catalog requires an immutable base_sidecar");
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

function validateBaseRef(ref) {
  if (ref?.bucket !== "vomebook/reader-assets-v2" || ref.role !== "runtime" || !sha(ref.sha256) ||
      ref.path !== `reader-index/snapshots/${ref.sha256}/reader_assets.json.gz` ||
      !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_V3_BYTES)
    throw Error("invalid unified sidecar reference");
  return ref;
}

async function readV3(relativePath, signal, { limit = MAX_V3_BYTES, missing = false } = {}) {
  const response = await fetch(V3_BASE + relativePath, { signal, cache: "no-store" });
  if (missing && response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok || !response.body) throw Error(`v3 metadata HTTP ${response.status}`);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error("v3 metadata too large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

function validateExpected({ generation, catalog_sha256 }) {
  if (!sha(generation) || !sha(catalog_sha256) || /^0+$/.test(generation) || /^0+$/.test(catalog_sha256))
    throw Error("expected both Reader generation and catalog SHA-256");
}

function requireCurrent(pointer, expected) {
  if (pointer?.generation !== expected.generation || pointer.catalog.sha256 !== expected.catalog_sha256)
    throw Error("current HF Reader generation/catalog differs from the candidate");
}

async function readCurrent(signal, fresh) {
  const suffix = fresh ? `?pages_check=${crypto.randomUUID()}` : "";
  const raw = await readV3("reader-index/v3/current.json" + suffix, signal, { limit: 64 * 1024, missing: true });
  if (!raw) return null;
  const pointer = JSON.parse(raw.toString("utf8"));
  validatePointer(pointer);
  return pointer;
}

async function loadV3(signal, { expected, fresh = false, pinned = false } = {}) {
  let pointer, bytes;
  if (expected && !fresh) {
    // The pure Reader build never consults current.json or the legacy alias.
    const { generation, catalog_sha256 } = expected;
    const path = catalogPath(generation);
    bytes = await readV3(path, signal);
    pointer = { version: 1, kind: "reader-reading-pointer", generation,
      catalog: { bucket: "vomebook/reader-assets-v2", role: "runtime", path, bytes: bytes.length, sha256: catalog_sha256 } };
  } else {
    pointer = await readCurrent(signal, fresh);
    if (expected) requireCurrent(pointer, expected);
    if (!pointer) return null;
    bytes = await readV3(pointer.catalog.path, signal, { limit: pointer.catalog.bytes });
  }
  const catalog = validateCatalog(pointer, bytes);
  if (pinned && !catalog.base_sidecar) throw Error("pinned v3 catalog requires an immutable base_sidecar");
  const snapshot = catalog.base_sidecar ? validateBaseRef(catalog.base_sidecar) : null;
  const packedBase = snapshot ? await readV3(snapshot.path, signal, { limit: snapshot.bytes }) : null;
  return { pointer, bytes, packedBase };
}

export function validateReaderAssets(bytes) {
  const data = JSON.parse(gunzipSync(bytes).toString("utf8"));
  if (!data || data.v !== 1 || !data.f || typeof data.f !== "object" || Array.isArray(data.f)) {
    throw new Error("invalid Reader Assets sidecar");
  }
  return data;
}

async function legacySidecar(url, signal) {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Reader Assets request failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function receiptFor(bytes, active) {
  return { version: 1, surface: "pages", active: active !== null,
    ...active, sidecar_sha256: digest(bytes), reader_contract: "pdf-reading-v3-v1" };
}

async function materialize(url, signal, { expected, fresh = false, pinned = false } = {}) {
  // Preserve the ordinary fetch's legacy behavior. A pinned refresh uses only
  // the validated catalog and its digest-addressed base sidecar.
  const legacyUrl = fresh ? `${url}?pages_check=${crypto.randomUUID()}` : url;
  let bytes = pinned ? null : await legacySidecar(legacyUrl, signal);
  const base = bytes && validateReaderAssets(bytes);
  let active = null;
  if (url === DEFAULT_READER_ASSETS_URL) {
    const catalog = await loadV3(signal, { expected, fresh, pinned });
    if (catalog) {
      const projected = projectV3(base, catalog.pointer, catalog.bytes, catalog.packedBase);
      active = projected.v3;
      bytes = gzipSync(Buffer.from(JSON.stringify(projected)));
    } else if (base?.v3) throw Error("previous v3 pointer disappeared");
  }
  return { bytes, receipt: receiptFor(bytes, active) };
}

export async function assertLiveReader(receipt, pinned) {
  if (receipt?.active === true) validateExpected(receipt);
  else if (pinned || receipt?.active !== false) throw Error("missing candidate Reader identity");
  const signal = AbortSignal.timeout(30000);
  const expected = receipt.active ? receipt : undefined;
  const live = await materialize(DEFAULT_READER_ASSETS_URL, signal, { expected, fresh: true, pinned });
  if (Object.keys(live.receipt).length !== Object.keys(receipt).length ||
      Object.entries(live.receipt).some(([key, value]) => receipt[key] !== value))
    throw Error("current Reader data differs from the candidate; rebuild before deploying");
  // Check the mutable pointer again after verifying the immutable objects.
  const current = await readCurrent(signal, true);
  if (expected) requireCurrent(current, expected);
  else if (current) throw Error("HF Reader pointer appeared after the candidate was built");
}

export async function fetchReaderAssets(output, url = DEFAULT_READER_ASSETS_URL, attempts = 3, expected) {
  if (expected) {
    validateExpected(expected);
    if (url !== DEFAULT_READER_ASSETS_URL) throw Error("pinned Reader requires the official immutable bucket");
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const { bytes, receipt } = await materialize(url, controller.signal, { expected, pinned: Boolean(expected) });
      await mkdir(dirname(output), { recursive: true });
      const temporary = `${output}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, output);
      if (url === DEFAULT_READER_ASSETS_URL) {
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
  const [output, option, generation, catalog_sha256, ...extra] = process.argv.slice(2);
  if (output === "--check-live" && !option) {
    await assertLiveReader(JSON.parse(process.env.BUILT_READER_RECEIPT), process.env.READER_REFRESH === "true");
  } else if (output && option === "--expected" && !extra.length) {
    await fetchReaderAssets(output, DEFAULT_READER_ASSETS_URL, 3, { generation, catalog_sha256 });
  } else if (output && !output.startsWith("--") && !generation && !option?.startsWith("--")) {
    await fetchReaderAssets(output, option || DEFAULT_READER_ASSETS_URL);
  } else {
    throw new Error("usage: node scripts/data/fetch_reader_assets.mjs OUTPUT [URL | --expected GENERATION CATALOG_SHA256] | --check-live");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

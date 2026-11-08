import {createHash} from "node:crypto";
import {lstat, mkdir, rename, rm, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";

// Offline/candidate generation materializer. The caller chooses an immutable
// generation explicitly; this does not resolve or update a production pointer.
const BASE = "https://huggingface.co/buckets/vomebook/search-data-v1/resolve/";
const GEN_RE = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_SURFACE_BYTES = 96 * 1024 * 1024;
const MAX_FILES = 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function safeName(name, surface) {
  if (typeof name !== "string" || name.startsWith("/") || name.includes("\\") ||
      name.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x1f\x7f]/.test(name)) return false;
  if (["search_data.json.gz", "folder_tree.json.gz", "folder_browser.json.gz",
    "initial/global.json", "initial/manifest.json", "sidebar/global.json", "sidebar/manifest.json"].includes(name)) return true;
  if (surface === "space" && ["search_words.bin.gz", "search_ngrams_2.bin.gz", "search_ngrams_3.bin.gz"].includes(name)) return true;
  return /^(?:initial|sidebar)\/repos\/[^/]+\.json$/.test(name);
}

async function boundedBytes(url, maxBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, {signal: controller.signal, redirect: "follow", cache: "no-store"});
    if (!response.ok) throw new Error(`search data HTTP ${response.status}`);
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error("search data exceeds size limit");
    if (!response.body) throw new Error("search data response has no body");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("search data exceeds size limit");
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  } finally { clearTimeout(timeout); }
}

function validateManifest(manifest, generation, surface) {
  if (!manifest || typeof manifest !== "object" || manifest.version !== 1 ||
      manifest.kind !== "search-snapshot-local" || manifest.generation !== generation ||
      manifest.object_layout !== "objects/sha256/<first-two>/<sha256>" ||
      !manifest.files || !manifest.objects) throw new Error("invalid search generation manifest");
  const {generation: _generation, remote_writes: _writes, publication_ready: _ready,
    object_layout: _layout, objects: _objects, additional_checks: _checks, ...identity} = manifest;
  if (hash(Buffer.from(canonical(identity) + "\n")) !== generation) throw new Error("search generation identity mismatch");
  const assets = manifest.objects[surface], original = manifest.files[surface];
  if (!assets || typeof assets !== "object" || Array.isArray(assets) ||
      !original || typeof original !== "object" || Array.isArray(original)) throw new Error("invalid search surface");
  const names = Object.keys(assets).sort();
  if (!names.length || names.length > MAX_FILES || names.join("\0") !== Object.keys(original).sort().join("\0"))
    throw new Error("search member list mismatch");
  const required = ["search_data.json.gz", "folder_tree.json.gz", "folder_browser.json.gz",
    "initial/global.json", "initial/manifest.json", "sidebar/global.json", "sidebar/manifest.json"];
  if (surface === "space") required.push("search_words.bin.gz", "search_ngrams_2.bin.gz", "search_ngrams_3.bin.gz");
  if (required.some(name => !Object.hasOwn(assets, name))) throw new Error("required search member missing");
  let total = 0;
  for (const name of names) {
    const item = assets[name], source = original[name];
    if (!safeName(name, surface) || !item || !source || !GEN_RE.test(item.sha256 || "") ||
        item.sha256 !== source.sha256 || item.bytes !== source.bytes ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_OBJECT_BYTES ||
        item.object !== `objects/sha256/${item.sha256.slice(0, 2)}/${item.sha256}`)
      throw new Error(`invalid search member: ${name}`);
    total += item.bytes;
    if (total > MAX_SURFACE_BYTES) throw new Error("search surface exceeds size limit");
  }
  return names.map(name => ({name, ...assets[name]}));
}

export async function fetchSearchGeneration(generation, surface, target) {
  if (!GEN_RE.test(generation) || !["pages", "space"].includes(surface)) throw new Error("invalid generation or surface");
  const out = resolve(target), parent = dirname(out), temporary = `${out}.candidate-${process.pid}`;
  if (out === parent) throw new Error("invalid output directory");
  await mkdir(parent, {recursive: true});
  // Never merge into an existing output or overwrite prior data.
  await mkdir(temporary, {recursive: false});
  try {
    const raw = await boundedBytes(`${BASE}generations/${generation}/manifest.json`, MAX_MANIFEST_BYTES);
    const members = validateManifest(JSON.parse(raw.toString("utf8")), generation, surface);
    for (const item of members) {
      const bytes = await boundedBytes(BASE + item.object, item.bytes);
      if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error(`search member mismatch: ${item.name}`);
      const file = join(temporary, ...item.name.split("/"));
      await mkdir(dirname(file), {recursive: true});
      await writeFile(file, bytes, {flag: "wx"});
    }
    // Preserve the exact validated manifest so Space can independently check
    // its selected bytes before the ASGI application starts.
    await writeFile(join(temporary, "generation-manifest.json"), raw, {flag: "wx"});
    // Existing output must not be replaced. Call only with a caller-owned,
    // isolated build directory: this check and rename are not a shared lock.
    try { await lstat(out); throw new Error("output already exists"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await rename(temporary, out);
    return {generation, surface, files: members.length};
  } catch (error) {
    await rm(temporary, {recursive: true, force: true});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [generation, surface, output] = process.argv.slice(2);
  if (!generation || !surface || !output) throw new Error("usage: node fetch_search_generation.mjs GENERATION pages|space NEW_OUTPUT_DIR");
  console.log(JSON.stringify(await fetchSearchGeneration(generation, surface, output)));
}

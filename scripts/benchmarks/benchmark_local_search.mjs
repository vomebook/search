#!/usr/bin/env node
/**
 * Optional offline Pages search compute benchmark. No files are downloaded or
 * written. Supply a materialized generation and pin its expected identity:
 *
 * node scripts/benchmarks/benchmark_local_search.mjs --data-dir /path/to/data \
 *   --generation <64-hex-generation> [--iterations 7] [--warmup 1]
 *
 * O_NONBLOCK and O_NOFOLLOW are required; platforms without them fail closed.
 * Directory path components (including --data-dir) may be symlinks; the two
 * input files themselves must not be. This is not a parent-directory sandbox.
 *
 * Timings are direct searchLocal calls in one Node VM, not Worker message
 * dispatch, cooperative preparation, a browser, or end-to-end latency. The
 * first observation is separately reported; later calls reuse process state.
 * VM-only hit and miss counters verify the measured paths, adding a small
 * overhead to both. Full-order checks detect instability, not a consistently
 * incorrect order.
 */
import {createHash} from "node:crypto";
import {constants, fstatSync, openSync, closeSync, readFileSync, readSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {fileURLToPath} from "node:url";
import vm from "node:vm";
import {gunzipSync} from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workerPath = path.join(root, "static/search/index-worker.js");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const HEX = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const PAGE_SIZE = 500;
const queries = [
  {q: "手机", exact: true}, {q: "手机", exact: true, sort: "name"},
  {q: "手"}, {q: "手机"}, {q: "文化革命", exact: true},
  {q: "社会主义"}, {q: "马克思 资本论"}, {q: "手机.txt", exact: true},
  {q: "马克思*.pdf", exact: true}, {q: "?*.pdf", exact: true},
  {q: "*.pdf", exact: true}, {q: "不存在", exact: true},
];
const usage = "usage: node scripts/benchmarks/benchmark_local_search.mjs --data-dir DIR --generation SHA256 [--iterations 1..100] [--warmup 0..10]";
const pathPolicy = "Directory components, including --data-dir, may be symlinks; the manifest and corpus files must not be symlinks. O_NONBLOCK and O_NOFOLLOW are required; this is not a parent-directory sandbox.";

function parseArgs(args) {
  const options = {};
  const names = new Set(["--data-dir", "--generation", "--iterations", "--warmup"]);
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!names.has(name) || Object.hasOwn(options, name) || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(usage);
    }
    options[name] = args[++i];
  }
  if (!options["--data-dir"]?.trim() || !HEX.test(options["--generation"] || "")) throw new Error(usage);
  function integer(name, fallback, min, max) {
    const raw = options[name] ?? String(fallback);
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return value;
  }
  return {dataDir: path.resolve(options["--data-dir"]), generation: options["--generation"],
    iterations: integer("--iterations", 7, 1, 100), warmup: integer("--warmup", 1, 0, 10)};
}

// Same identity canonicalization and excluded publication fields as the
// generation materializer. The caller's pin, not the manifest alone, selects
// the generation; this does not authenticate a production pointer.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function readBounded(file, max) {
  // A blocking open can hang on a FIFO before fstat can reject it. Do not
  // silently fall back to unsafe flags if this platform lacks either one.
  if (!constants.O_NONBLOCK || !constants.O_NOFOLLOW)
    throw new Error("safe snapshot open requires O_NONBLOCK and O_NOFOLLOW support");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > max) throw new Error(`invalid file size or type: ${file}`);
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let size = 0, count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count;
    if (size !== stat.size) throw new Error(`file changed while reading: ${file}`);
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}

function validMember(item, limit) {
  return item && typeof item === "object" && !Array.isArray(item) && typeof item.sha256 === "string" && HEX.test(item.sha256) &&
    Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= limit;
}

function loadGeneration(dataDir, generation) {
  const manifestBytes = readBounded(path.join(dataDir, "generation-manifest.json"), MAX_MANIFEST_BYTES);
  const manifest = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(manifestBytes));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.version !== 1 ||
      manifest.kind !== "search-snapshot-local" || manifest.generation !== generation ||
      manifest.object_layout !== "objects/sha256/<first-two>/<sha256>") throw new Error("invalid or unexpected generation manifest");
  const {generation: _generation, remote_writes: _writes, publication_ready: _ready,
    object_layout: _layout, objects: _objects, additional_checks: _checks, ...identity} = manifest;
  if (hash(Buffer.from(canonical(identity) + "\n")) !== generation) throw new Error("generation identity mismatch");
  const member = manifest.files?.pages?.["search_data.json.gz"];
  const object = manifest.objects?.pages?.["search_data.json.gz"];
  if (!validMember(member, MAX_COMPRESSED_BYTES) || !validMember(object, MAX_COMPRESSED_BYTES) ||
      member.sha256 !== object.sha256 || member.bytes !== object.bytes ||
      object.object !== `objects/sha256/${member.sha256.slice(0, 2)}/${member.sha256}`)
    throw new Error("invalid Pages corpus manifest member");
  if (!validMember(manifest.source_payload, Number.MAX_SAFE_INTEGER) ||
      !Number.isSafeInteger(manifest.record_count) || manifest.record_count < 1) throw new Error("invalid corpus identity or record count");
  const compressed = readBounded(path.join(dataDir, "search_data.json.gz"), MAX_COMPRESSED_BYTES);
  if (compressed.length !== member.bytes || hash(compressed) !== member.sha256) throw new Error("Pages corpus gzip size or SHA-256 mismatch");
  const raw = gunzipSync(compressed, {maxOutputLength: MAX_EXPANDED_BYTES});
  // The generation pins the original source metadata and the Pages gzip
  // separately; JSON serialization can change between those two artifacts.
  const data = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw));
  if (!data || data.v !== 2 || !Array.isArray(data.rp) || !Array.isArray(data.fd) || !Array.isArray(data.rc) ||
      data.rc.length !== manifest.record_count) throw new Error("compact-v2 corpus or record count mismatch");
  return {data, manifestSha256: hash(manifestBytes), gzipSha256: member.sha256, gzipBytes: compressed.length,
    sourceSha256: manifest.source_payload.sha256, sourceBytes: manifest.source_payload.bytes,
    expandedSha256: hash(raw), expandedBytes: raw.length, count: data.rc.length};
}

function measure(fn) {
  const start = performance.now();
  const value = fn();
  return {value, ms: performance.now() - start};
}
function distribution(times) {
  const sorted = times.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {median_ms: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    min_ms: sorted[0], max_ms: sorted[sorted.length - 1]};
}
function digest(ids) { return hash(Buffer.from(JSON.stringify(ids), "utf8")); }

function benchmark(options, corpus, source) {
  // Instrument the exact hit return and miss branch. Fail closed if the
  // Worker's dispatch changes rather than silently reporting unverified paths.
  const boundary = `  if (ordered) {
    searchOrderCache.delete(cacheKey);
    searchOrderCache.set(cacheKey, ordered);
    return pageResult(ordered, params);
  }
  let matched = [];`;
  if (source.split(boundary).length !== 2) throw new Error("cannot instrument search order cache miss path");
  const instrumentedBoundary = boundary
    .replace("    return pageResult(ordered, params);",
      "    globalThis.__benchmarkSearchCacheHits++;\n    return pageResult(ordered, params);")
    .replace("  let matched = [];", "  globalThis.__benchmarkSearchCacheMisses++;\n  let matched = [];");
  const instrumented = source.replace(boundary, instrumentedBoundary);
  const context = {self: {addEventListener() {}, postMessage() {}},
    __benchmarkSearchCacheHits: 0, __benchmarkSearchCacheMisses: 0};
  vm.createContext(context);
  vm.runInContext(instrumented, context, {filename: "static/search/index-worker.js"});
  context.payload = corpus.data;
  const install = measure(() => vm.runInContext("replaceCorpus(decodeSearchPayload(payload))", context));
  if (install.value.count !== corpus.count) throw new Error("installed record count mismatch");
  delete context.payload;
  // The order cache contains record indices. Capture it immediately after the
  // uncached call, before requesting cached pages, and hash every stable ID.
  const controls = vm.runInContext(`({
    clear: () => searchOrderCache.clear(),
    indexed: () => wordIndex !== null,
    order: params => searchOrderCache.get(searchOrderKey(params)),
    ids: order => order.map(index => recordIds[index])
  })`, context);
  const results = [];
  for (const params of queries) {
    let expected = null;
    const uncachedTimes = [], cachedTimes = [];
    const sample = () => {
      controls.clear();
      const indexedBefore = controls.indexed();
      const request = {...params, page: 1, pageSize: PAGE_SIZE};
      const missesBefore = context.__benchmarkSearchCacheMisses, hitsBefore = context.__benchmarkSearchCacheHits;
      const uncached = measure(() => context.searchLocal(request));
      if (context.__benchmarkSearchCacheMisses !== missesBefore + 1 || context.__benchmarkSearchCacheHits !== hitsBefore)
        throw new Error(`uncached order path not observed: ${JSON.stringify(params)}`);
      const indexedAfter = controls.indexed();
      const order = controls.order(request);
      if (!Array.isArray(order)) throw new Error("missing cached search order");
      const orderedIds = Array.from(controls.ids(order));
      if (orderedIds.length > corpus.count || orderedIds.some(id => typeof id !== "string") ||
          uncached.value.total !== orderedIds.length || uncached.value.page !== 1 || uncached.value.pageSize !== PAGE_SIZE ||
          JSON.stringify(uncached.value.ids) !== JSON.stringify(orderedIds.slice(0, PAGE_SIZE)))
        throw new Error(`uncached order/page mismatch: ${JSON.stringify(params)}`);
      const uncachedHash = digest(orderedIds);
      if (expected && (expected.total !== orderedIds.length || expected.hash !== uncachedHash))
        throw new Error(`unstable uncached order: ${JSON.stringify(params)}`);
      expected = {total: orderedIds.length, hash: uncachedHash};
      const misses = context.__benchmarkSearchCacheMisses;
      const assertCacheHit = previousHits => {
        if (context.__benchmarkSearchCacheHits !== previousHits + 1 ||
            context.__benchmarkSearchCacheMisses !== misses || controls.order(request) !== order)
          throw new Error(`cached order not reused: ${JSON.stringify(params)}`);
      };
      const cachedHitsBefore = context.__benchmarkSearchCacheHits;
      const cached = measure(() => context.searchLocal(request));
      assertCacheHit(cachedHitsBefore);
      const pagedIds = [];
      const pages = Math.max(1, Math.ceil(orderedIds.length / PAGE_SIZE));
      for (let page = 1; page <= pages; page++) {
        let result = cached.value;
        if (page > 1) {
          const pageHitsBefore = context.__benchmarkSearchCacheHits;
          result = context.searchLocal({...request, page});
          assertCacheHit(pageHitsBefore);
        }
        const size = Math.min(PAGE_SIZE, orderedIds.length - pagedIds.length);
        if (result.total !== orderedIds.length || result.page !== page || result.pageSize !== PAGE_SIZE ||
            !Array.isArray(result.ids) || result.ids.length !== size || result.ids.some(id => typeof id !== "string"))
          throw new Error(`cached pagination mismatch: ${JSON.stringify(params)}, page ${page}`);
        pagedIds.push(...result.ids);
      }
      const cachedHash = digest(pagedIds);
      if (cachedHash !== uncachedHash) throw new Error(`cached full-order mismatch: ${JSON.stringify(params)}`);
      return {uncached_ms: uncached.ms, cached_ms: cached.ms, uncached_sha256: uncachedHash,
        cached_sha256: cachedHash, index_before: indexedBefore, index_after: indexedAfter};
    };
    const first = sample();
    for (let i = 0; i < options.warmup; i++) sample();
    let last;
    for (let i = 0; i < options.iterations; i++) {
      last = sample();
      uncachedTimes.push(last.uncached_ms);
      cachedTimes.push(last.cached_ms);
    }
    results.push({params, total: expected.total, first, warmup_runs: options.warmup, measured_runs: options.iterations,
      measured_index_before: last.index_before, measured_index_after: last.index_after,
      uncached: {...distribution(uncachedTimes), ordered_ids_sha256: last.uncached_sha256},
      cached: {...distribution(cachedTimes), ordered_ids_sha256: last.cached_sha256}});
  }
  return {install_ms: install.ms, queries: results};
}

function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") { console.log(`${usage}\n${pathPolicy}`); return; }
  const options = parseArgs(process.argv.slice(2));
  const corpus = loadGeneration(options.dataDir, options.generation);
  const workerBytes = readFileSync(workerPath);
  const report = benchmark(options, corpus, workerBytes.toString("utf8"));
  console.log(JSON.stringify({
    scope: "Warm-process offline single Node VM direct searchLocal calls, not real Worker dispatch, browser or end-to-end latency. Worker timers and cooperative preparation are not run; the direct single-character path differs from Worker dispatch. First observations follow fixed query order and may build indexes or fields; measured samples reuse process state. Order cache cleared before each uncached call; cached timing is first-page only. VM-only hit and miss counter increments add overhead to both paths; cache reuse, full-order verification and pagination are checked outside timings. No independent correctness oracle.",
    ordering_hash: "SHA-256 of UTF-8 JSON.stringify(array of all ordered stable ID strings)",
    validation: "Caller-pinned manifest identity and Pages gzip size and SHA-256, expanded compact-v2 shape and record count; source payload metadata is manifest-declared and source bytes are unavailable. Other generation members, provenance and live production pointer not verified.",
    node: process.version, versions: process.versions, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model || null,
    benchmark_source_sha256: hash(readFileSync(fileURLToPath(import.meta.url))), worker_source_sha256: hash(workerBytes),
    data_dir: options.dataDir, generation: options.generation, manifest_sha256: corpus.manifestSha256,
    corpus_gzip_sha256: corpus.gzipSha256, corpus_gzip_bytes: corpus.gzipBytes,
    manifest_source_payload_sha256: corpus.sourceSha256, manifest_source_payload_bytes: corpus.sourceBytes,
    corpus_expanded_sha256: corpus.expandedSha256, corpus_expanded_bytes: corpus.expandedBytes,
    records: corpus.count, iterations: options.iterations, warmup: options.warmup, ...report,
  }, null, 2));
}

try { main(); }
catch (error) { console.error(`benchmark failed: ${error.message}`); process.exitCode = 1; }

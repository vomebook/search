// Run explicitly: node --test tests/performance/test_benchmark_local_search.mjs
// Fixtures copy the real benchmark and Worker into temporary directories with synthetic data.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
import {gzipSync} from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = readFileSync(path.join(root, "scripts/benchmarks/benchmark_local_search.mjs"));
const worker = readFileSync(path.join(root, "static/search/index-worker.js"), "utf8");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

function fixture({bypassCache = false} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pages-benchmark-test-"));
  const scriptDir = path.join(dir, "scripts/benchmarks"), workerDir = path.join(dir, "static/search");
  const dataDir = path.join(dir, "data");
  mkdirSync(scriptDir, {recursive: true});
  mkdirSync(workerDir, {recursive: true});
  mkdirSync(dataDir);
  const scriptPath = path.join(scriptDir, "benchmark_local_search.mjs");
  const workerPath = path.join(workerDir, "index-worker.js");
  writeFileSync(scriptPath, script);
  writeFileSync(workerPath, worker);
  if (bypassCache) {
    const branch = "  let ordered = searchOrderCache.get(cacheKey);\n  if (ordered) {";
    assert.equal(worker.split(branch).length, 2, "injection point must be unique");
    writeFileSync(workerPath, worker.replace(branch, `  let ordered = searchOrderCache.get(cacheKey);
  if (ordered && params.q === "*.pdf") {
    searchOrderCache.delete(cacheKey);
    const recomputed = searchLocal(params);
    searchOrderCache.set(cacheKey, ordered);
    return recomputed;
  }
  if (ordered) {`));
    // Disable only the hit/miss probes to show that recomputation still passes
    // the ordering and original cache-entry identity checks.
    const probe = `context.__benchmarkSearchCacheHits !== previousHits + 1 ||
            context.__benchmarkSearchCacheMisses !== misses || controls.order(request) !== order`;
    const disabled = "controls.order(request) !== order";
    const benchmark = script.toString("utf8");
    assert.equal(benchmark.split(probe).length, 2, "probe must be unique");
    writeFileSync(scriptPath, benchmark.replace(probe, disabled));
  }
  const data = {v: 2, rp: ["Repo/A"], fd: [[]],
    rc: Array.from({length: 625}, (_, i) => [0, "手机", "pdf", 0, i % 10, 0])};
  const raw = Buffer.from(JSON.stringify(data));
  const compressed = gzipSync(raw);
  const member = {bytes: compressed.length, sha256: hash(compressed)};
  const manifest = {version: 1, kind: "search-snapshot-local", files: {pages: {"search_data.json.gz": {...member}}},
    record_count: data.rc.length, source_payload: {bytes: raw.length, sha256: hash(raw)},
    object_layout: "objects/sha256/<first-two>/<sha256>",
    objects: {pages: {"search_data.json.gz": {...member, object: `objects/sha256/${member.sha256.slice(0, 2)}/${member.sha256}`}}}};
  const corpusPath = path.join(dataDir, "search_data.json.gz");
  const manifestPath = path.join(dataDir, "generation-manifest.json");
  writeFileSync(corpusPath, compressed);
  function save(repin = true) {
    if (repin) {
      const {generation: _generation, remote_writes: _writes, publication_ready: _ready,
        object_layout: _layout, objects: _objects, additional_checks: _checks, ...identity} = manifest;
      manifest.generation = hash(Buffer.from(canonical(identity) + "\n"));
    }
    writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  save();
  function run(extra = [], generation = manifest.generation) {
    return spawnSync(process.execPath, [scriptPath, "--data-dir", dataDir, "--generation", generation,
      ...(extra.includes("--iterations") ? [] : ["--iterations", "1"]),
      ...(extra.includes("--warmup") ? [] : ["--warmup", "0"]), ...extra], {encoding: "utf8", timeout: 30000});
  }
  function inject(before, after) {
    assert.equal(worker.split(before).length, 2, "injection point must be unique");
    writeFileSync(workerPath, worker.replace(before, after));
  }
  return {dir, scriptPath, dataDir, corpusPath, manifestPath, data, raw, compressed, manifest, save, run, inject};
}

function withFixture(fn, options) {
  const f = fixture(options);
  try { fn(f); } finally { rmSync(f.dir, {recursive: true, force: true}); }
}
function failed(result, pattern) {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, "", "no partial benchmark report on error");
}

test("full stable ID order, pagination, sort ties, and source identity", () => withFixture(f => {
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.generation, f.manifest.generation);
  assert.equal(output.records, 625);
  assert.equal(output.worker_source_sha256, hash(Buffer.from(worker)));
  assert.equal(output.benchmark_source_sha256, hash(script));
  assert.equal(output.corpus_expanded_sha256, hash(f.raw));
  assert.equal(output.manifest_source_payload_sha256, f.manifest.source_payload.sha256);
  assert.match(output.scope, /not real Worker dispatch, browser/);
  const expected = Array.from({length: 625}, (_, i) => `Repo/A\u001f手机/pdf\u001f${i}`);
  for (const query of [output.queries.find(q => q.params.q === "*.pdf"),
    output.queries.find(q => q.params.q === "手机" && q.params.sort === "name")]) {
    assert.equal(query.total, 625);
    assert.equal(query.uncached.ordered_ids_sha256, hash(Buffer.from(JSON.stringify(expected))));
    assert.equal(query.cached.ordered_ids_sha256, query.uncached.ordered_ids_sha256);
    assert.equal(query.first.uncached_sha256, query.cached.ordered_ids_sha256);
  }
  assert.equal(output.queries[0].first.index_before, false);
  assert.equal(output.queries[0].first.index_after, false);
  assert.equal(output.queries.find(q => q.params.q === "不存在").total, 0);
}));

test("CLI requires an explicit directory and generation; validates all counts and options", () => withFixture(f => {
  for (const args of [[], ["--data-dir", f.dataDir], ["--generation", f.manifest.generation]]) {
    const result = spawnSync(process.execPath, [f.scriptPath, ...args], {encoding: "utf8"});
    failed(result, /usage:/);
  }
  for (const value of ["0", "101", "-1", "1.5", "1e1", "NaN", "01", "Infinity"]) {
    const result = spawnSync(process.execPath, [f.scriptPath, "--data-dir", f.dataDir, "--generation", f.manifest.generation,
      "--iterations", value], {encoding: "utf8"});
    failed(result, /--iterations must be an integer/);
  }
  for (const args of [["--warmup", "11"], ["--warmup", "-1"], ["--unknown", "1"], ["--data-dir", f.dataDir]]) {
    failed(f.run(args), /usage:|--warmup must be an integer/);
  }
  const help = spawnSync(process.execPath, [f.scriptPath, "--help"], {encoding: "utf8"});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--generation/);
}));

test("missing manifest, corpus, or expected generation fails closed", () => withFixture(f => {
  failed(f.run([], "0".repeat(64)), /unexpected generation/);
  rmSync(f.corpusPath);
  failed(f.run(), /ENOENT/);
  rmSync(f.manifestPath);
  failed(f.run(), /ENOENT/);
}));

test("manifest identity and Pages object metadata are checked", () => withFixture(f => {
  f.manifest.record_count++;
  f.save(false);
  failed(f.run(), /generation identity mismatch/);
  f.save();
  failed(f.run(), /record count mismatch/);
  f.manifest.record_count--;
  f.save();
  f.manifest.source_payload.bytes++;
  f.save(false);
  failed(f.run(), /generation identity mismatch/);
  f.manifest.source_payload.bytes--;
  delete f.manifest.files.pages["search_data.json.gz"];
  f.save();
  failed(f.run(), /invalid Pages corpus manifest member/);
}));

test("object path, gzip identity, source metadata and record count fail closed", () => {
  const cases = [
    [f => { delete f.manifest.files.pages["search_data.json.gz"].sha256; }, /invalid Pages corpus manifest member/],
    [f => { delete f.manifest.files.pages["search_data.json.gz"].bytes; }, /invalid Pages corpus manifest member/],
    [f => { delete f.manifest.objects.pages["search_data.json.gz"]; }, /invalid Pages corpus manifest member/],
    [f => { f.manifest.objects.pages["search_data.json.gz"].object = "objects/sha256/wrong"; }, /invalid Pages corpus manifest member/],
    [f => { f.manifest.objects.pages["search_data.json.gz"].sha256 = "0".repeat(64); }, /invalid Pages corpus manifest member/],
    [f => { const m = f.manifest.files.pages["search_data.json.gz"], o = f.manifest.objects.pages["search_data.json.gz"];
      m.sha256 = o.sha256 = "0".repeat(64); o.object = `objects/sha256/00/${o.sha256}`; }, /gzip size or SHA-256 mismatch/],
    [f => { f.manifest.files.pages["search_data.json.gz"].bytes++; f.manifest.objects.pages["search_data.json.gz"].bytes++; }, /gzip size or SHA-256 mismatch/],
    [f => { const bytes = Buffer.from(f.compressed); bytes[bytes.length - 1] ^= 1; writeFileSync(f.corpusPath, bytes); }, /gzip size or SHA-256 mismatch/],
    [f => { delete f.manifest.source_payload; }, /invalid corpus identity or record count/],
    [f => { f.manifest.source_payload.sha256 = "not-a-hash"; }, /invalid corpus identity or record count/],
    [f => { f.manifest.source_payload.bytes = 0; }, /invalid corpus identity or record count/],
    [f => { delete f.manifest.record_count; }, /invalid corpus identity or record count/],
    [f => { f.manifest.record_count++; }, /record count mismatch/],
  ];
  for (const [change, message] of cases) withFixture(f => { change(f); f.save(); failed(f.run(), message); });
});

test("a repinned invalid expanded JSON cannot pass even with matching gzip metadata", () => withFixture(f => {
  const compressed = gzipSync(Buffer.from("not JSON"));
  const member = {bytes: compressed.length, sha256: hash(compressed)};
  f.manifest.files.pages["search_data.json.gz"] = {...member};
  f.manifest.objects.pages["search_data.json.gz"] = {...member, object: `objects/sha256/${member.sha256.slice(0, 2)}/${member.sha256}`};
  writeFileSync(f.corpusPath, compressed);
  f.save();
  failed(f.run(), /benchmark failed:/);
}));

test("manifest source and expanded Pages JSON may have equivalent values but different bytes", () => withFixture(f => {
  const source = Buffer.from(JSON.stringify(f.data, null, 2) + "\n");
  assert.deepEqual(JSON.parse(source.toString("utf8")), JSON.parse(f.raw.toString("utf8")));
  assert.notEqual(hash(source), hash(f.raw));
  f.manifest.source_payload = {bytes: source.length, sha256: hash(source)};
  f.save();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.manifest_source_payload_bytes, source.length);
  assert.equal(output.manifest_source_payload_sha256, hash(source));
  assert.equal(output.corpus_expanded_bytes, f.raw.length);
  assert.equal(output.corpus_expanded_sha256, hash(f.raw));
  assert.match(output.validation, /source bytes are unavailable/);
}));

test("warmup and measured samples retain index state and reject a warmup tail permutation", () => withFixture(f => {
  const warm = f.run(["--warmup", "2", "--iterations", "2"]);
  assert.equal(warm.status, 0, warm.stderr);
  const output = JSON.parse(warm.stdout);
  assert.equal(output.warmup, 2);
  assert.equal(output.iterations, 2);
  const single = output.queries.find(q => q.params.q === "手");
  assert.equal(single.first.index_before, false);
  assert.equal(single.first.index_after, true);
  assert.equal(single.measured_index_before, true);
  assert.equal(single.measured_index_after, true);
  const point = "  searchOrderCache.set(cacheKey, ordered);\n  while (searchOrderCache.size > SEARCH_ORDER_CACHE_MAX)";
  f.inject(point, `  if (params.q === "*.pdf") {
    globalThis.benchFaultCount = (globalThis.benchFaultCount || 0) + 1;
    if (globalThis.benchFaultCount === 2) ordered.splice(500, ordered.length - 500, ...ordered.slice(500).reverse());
  }\n${point}`);
  failed(f.run(["--warmup", "1"]), /unstable uncached order:.*\*\.pdf/);
}));

test("a second uncached order with only its tail reversed is rejected", () => withFixture(f => {
  const point = "  searchOrderCache.set(cacheKey, ordered);\n  while (searchOrderCache.size > SEARCH_ORDER_CACHE_MAX)";
  f.inject(point, `  if (params.q === "*.pdf") {
    globalThis.benchFaultCount = (globalThis.benchFaultCount || 0) + 1;
    if (globalThis.benchFaultCount === 2) ordered.splice(500, ordered.length - 500, ...ordered.slice(500).reverse());
  }\n${point}`);
  failed(f.run(), /unstable uncached order:.*\*\.pdf/);
}));

test("cache bypass fault otherwise produces identical verified results", () => withFixture(f => {
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const query = JSON.parse(result.stdout).queries.find(item => item.params.q === "*.pdf");
  assert.equal(query.total, 625);
  assert.equal(query.cached.ordered_ids_sha256, query.uncached.ordered_ids_sha256);
}, {bypassCache: true}));

test("recomputing an identical order instead of hitting the cache is rejected", () => withFixture(f => {
  const point = "  let ordered = searchOrderCache.get(cacheKey);\n  if (ordered) {";
  // Return the same results and restore the original cache entry. A cache
  // existence or reference check alone cannot detect this redundant search.
  f.inject(point, `  let ordered = searchOrderCache.get(cacheKey);
  if (ordered && params.q === "*.pdf") {
    searchOrderCache.delete(cacheKey);
    const recomputed = searchLocal(params);
    searchOrderCache.set(cacheKey, ordered);
    return recomputed;
  }
  if (ordered) {`);
  failed(f.run(), /cached order not reused:.*\*\.pdf/);
}));

test("using a cached order via a different uninstrumented path is rejected", () => withFixture(f => {
  const point = "  let ordered = searchOrderCache.get(cacheKey);\n  if (ordered) {";
  f.inject(point, `  let ordered = searchOrderCache.get(cacheKey);
  if (ordered && params.q === "*.pdf") return pageResult(ordered, params);
  if (ordered) {`);
  failed(f.run(), /cached order not reused:.*\*\.pdf/);
}));

test("recomputing an identical cached page-two order is rejected", () => withFixture(f => {
  const point = "  let ordered = searchOrderCache.get(cacheKey);\n  if (ordered) {";
  f.inject(point, `  let ordered = searchOrderCache.get(cacheKey);
  if (ordered && params.q === "*.pdf" && Number(params.page) === 2) {
    searchOrderCache.delete(cacheKey);
    const recomputed = searchLocal(params);
    searchOrderCache.set(cacheKey, ordered);
    return recomputed;
  }
  if (ordered) {`);
  failed(f.run(), /cached order not reused:.*\*\.pdf/);
}));

test("cache instrumentation fails closed if the Worker cache branch changes", () => withFixture(f => {
  const point = "    searchOrderCache.set(cacheKey, ordered);\n    return pageResult(ordered, params);";
  f.inject(point, "    searchOrderCache.set(cacheKey, ordered);\n    return pageResult(ordered, {...params});");
  failed(f.run(), /cannot instrument search order cache miss path/);
}));

test("a cached page-two tail permutation is rejected", () => withFixture(f => {
  const point = "  if (typeof params.anchorId === \"string\") {\n    result.anchor_index = findSearchAnchor(indices, params.anchorId);";
  f.inject(point, `  if (params.q === "*.pdf" && Number(params.page) === 2) result.ids.reverse();\n${point}`);
  failed(f.run(), /cached full-order mismatch:.*\*\.pdf/);
}));

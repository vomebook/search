// Run explicitly: node --test tests/performance/test_benchmark_local_search.mjs
// Fixtures copy the real benchmark and Worker into temporary directories with synthetic data.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {constants, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {test as nodeTest} from "node:test";
import {constants as zlibConstants, crc32, deflateRawSync, gunzipSync, gzipSync, inflateRawSync} from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = readFileSync(path.join(root, "scripts/benchmarks/benchmark_local_search.mjs"));
const worker = readFileSync(path.join(root, "static/search/index-worker.js"), "utf8");
const safeOpenSupported = Boolean(constants.O_NONBLOCK && constants.O_NOFOLLOW);
// Skip only cases that require real snapshot opens; all others still run.
const snapshotTest = (name, fn) => nodeTest(name, {skip: safeOpenSupported ? false : "O_NONBLOCK or O_NOFOLLOW unavailable"}, fn);
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
  function run(extra = [], generation = manifest.generation, {sourceDir = dataDir, timeout = 30000} = {}) {
    return spawnSync(process.execPath, [scriptPath, "--data-dir", sourceDir, "--generation", generation,
      ...(extra.includes("--iterations") ? [] : ["--iterations", "1"]),
      ...(extra.includes("--warmup") ? [] : ["--warmup", "0"]), ...extra], {encoding: "utf8", timeout});
  }
  function inject(before, after) {
    assert.equal(worker.split(before).length, 2, "injection point must be unique");
    writeFileSync(workerPath, worker.replace(before, after));
  }
  function repinGzip(bytes) {
    const member = {bytes: bytes.length, sha256: hash(bytes)};
    manifest.files.pages["search_data.json.gz"] = {...member};
    manifest.objects.pages["search_data.json.gz"] = {...member, object: `objects/sha256/${member.sha256.slice(0, 2)}/${member.sha256}`};
    writeFileSync(corpusPath, bytes);
    save();
  }
  return {dir, scriptPath, workerPath, dataDir, corpusPath, manifestPath, data, raw, compressed, manifest, save, run, inject, repinGzip};
}

function withFixture(fn, options) {
  const f = fixture(options);
  try { fn(f); } finally { rmSync(f.dir, {recursive: true, force: true}); }
}
function failed(result, pattern) {
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, "", "no partial benchmark report on error");
}

function guardBeforeCorpusParseAndWorker(f) {
  const source = readFileSync(f.scriptPath, "utf8");
  const parse = '  const data = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw));';
  assert.equal(source.split(parse).length, 2, "corpus JSON parse point must be unique");
  writeFileSync(f.scriptPath, source.replace(parse, '  throw new Error("corpus JSON parse reached");\n  const data = null;'));
  rmSync(f.workerPath);
}

function rawGzip(raw, options = {}) {
  const header = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(raw), 0);
  trailer.writeUInt32LE(raw.length >>> 0, 4);
  return Buffer.concat([header, deflateRawSync(raw, options), trailer]);
}

function makeSymlink(t, target, link, type) {
  try { symlinkSync(target, link, type); return true; }
  catch (error) {
    if (["ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error.code) ||
        (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code))) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}

function makeFifo(t, file) {
  if (process.platform === "win32") { t.skip("POSIX FIFO unavailable on Windows"); return false; }
  const result = spawnSync("mkfifo", [file], {encoding: "utf8", timeout: 5000, env: {...process.env, LC_ALL: "C"}});
  if (result.error?.code === "ENOENT" ||
      (result.status !== 0 && /operation not supported|function not implemented|operation not permitted/i.test(result.stderr || ""))) {
    t.skip(`mkfifo or filesystem FIFO support unavailable: ${(result.stderr || result.error?.message || "").trim()}`);
    return false;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(file).isFIFO(), true, "fixture must be a FIFO");
  return true;
}

nodeTest("missing safe-open flags fail closed before opening input", () => {
  const importLine = 'import {constants, fstatSync, openSync, closeSync, readFileSync, readSync} from "node:fs";';
  const source = script.toString("utf8");
  assert.equal(source.split(importLine).length, 2, "fs import must be unique");
  for (const missing of ["O_NONBLOCK", "O_NOFOLLOW"]) withFixture(f => {
    const replacement = `import {constants as nodeFsConstants, fstatSync, closeSync, readFileSync, readSync} from "node:fs";
const constants = {...nodeFsConstants, O_NONBLOCK: 1, O_NOFOLLOW: 2, ${missing}: undefined};
const openSync = () => { throw new Error("unsafe open attempted"); };`;
    writeFileSync(f.scriptPath, source.replace(importLine, replacement));
    failed(f.run([], undefined, {timeout: 5000}), /safe snapshot open requires.*O_NONBLOCK.*O_NOFOLLOW/);
  });
});

for (const [name, key] of [["manifest", "manifestPath"], ["corpus", "corpusPath"]]) {
  for (const mode of ["direct", "leaf symlink", "directory symlink"]) {
    snapshotTest(`${name} FIFO without a writer fails promptly (${mode})`, t => withFixture(f => {
      rmSync(f[key]);
      const fifo = mode === "leaf symlink" ? path.join(f.dir, `${name}.fifo`) : f[key];
      if (!makeFifo(t, fifo)) return;
      if (mode === "leaf symlink" && !makeSymlink(t, fifo, f[key], "file")) return;
      const sourceDir = mode === "directory symlink" ? path.join(f.dir, "data-link") : f.dataDir;
      if (mode === "directory symlink" && !makeSymlink(t, f.dataDir, sourceDir, "dir")) return;
      const result = f.run([], undefined, {sourceDir, timeout: 5000});
      assert.notEqual(result.error?.code, "ETIMEDOUT", "benchmark blocked waiting for a FIFO writer");
      assert.ifError(result.error);
      failed(result, mode === "leaf symlink" ? /ELOOP/ : /invalid file size or type:/);
    }));
  }
}

snapshotTest("directory symlinks are allowed but manifest and corpus leaf symlinks are rejected", t => withFixture(f => {
  const alias = path.join(f.dir, "data-link");
  if (!makeSymlink(t, f.dataDir, alias, "dir")) return;
  const options = {sourceDir: alias};
  const result = f.run([], undefined, options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).generation, f.manifest.generation);
  for (const key of ["manifestPath", "corpusPath"]) {
    const original = `${f[key]}.original`;
    renameSync(f[key], original);
    if (!makeSymlink(t, path.basename(original), f[key], "file")) return;
    failed(f.run([], undefined, options), /ELOOP/);
    rmSync(f[key]);
    renameSync(original, f[key]);
  }
}));

for (const [name, key, limit] of [["manifest", "manifestPath", 1024 * 1024], ["corpus", "corpusPath", 32 * 1024 * 1024]]) {
  snapshotTest(`${name} directory with an in-range size is rejected as non-file`, t => withFixture(f => {
    rmSync(f[key]);
    mkdirSync(f[key]);
    writeFileSync(path.join(f[key], "entry"), "x");
    const stat = lstatSync(f[key]);
    assert.equal(stat.isDirectory(), true);
    if (stat.size < 1 || stat.size > limit) { t.skip("filesystem does not report an in-range directory size"); return; }
    failed(f.run(), /invalid file size or type:/);
  }));
}

snapshotTest("regular manifest and corpus sizes remain bounded", () => withFixture(f => {
  writeFileSync(f.manifestPath, "");
  failed(f.run(), /invalid file size or type:/);
  f.save();
  truncateSync(f.manifestPath, 1024 * 1024 + 1);
  failed(f.run(), /invalid file size or type:/);
  f.save();
  truncateSync(f.corpusPath, 0);
  failed(f.run(), /invalid file size or type:/);
  truncateSync(f.corpusPath, 32 * 1024 * 1024 + 1);
  failed(f.run(), /invalid file size or type:/);
}));

snapshotTest("full stable ID order, pagination, sort ties, and source identity", () => withFixture(f => {
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
  assert.match(output.gzip_compatibility, /exactly one DEFLATE gzip member with FLG=0/);
  assert.match(output.gzip_compatibility, /may reject historical inputs accepted by the production selector/);
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

nodeTest("CLI requires an explicit directory and generation; validates all counts and options", () => withFixture(f => {
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
  assert.match(help.stdout, /Directory components.*may be symlinks/);
  assert.match(help.stdout, /manifest and corpus files must not be symlinks/);
  assert.match(help.stdout, /exactly one DEFLATE gzip member with FLG=0/);
  assert.match(help.stdout, /may reject historical inputs accepted by the production selector/);
}));

snapshotTest("missing manifest, corpus, or expected generation fails closed", () => withFixture(f => {
  failed(f.run([], "0".repeat(64)), /unexpected generation/);
  rmSync(f.corpusPath);
  failed(f.run(), /ENOENT/);
  rmSync(f.manifestPath);
  failed(f.run(), /ENOENT/);
}));

snapshotTest("manifest identity and Pages object metadata are checked", () => withFixture(f => {
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

snapshotTest("object path, gzip identity, source metadata and record count fail closed", () => {
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

snapshotTest("a repinned invalid expanded JSON cannot pass even with matching gzip metadata", () => withFixture(f => {
  f.repinGzip(gzipSync(Buffer.from("not JSON")));
  failed(f.run(), /benchmark failed:/);
}));

nodeTest("Node raw inflate reports exactly the first DEFLATE stream and rejects incomplete streams", () => {
  let state = 0x12345678;
  const incompressible = Buffer.alloc(131072);
  for (let i = 0; i < incompressible.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    incompressible[i] = state & 255;
  }
  const inputs = [Buffer.alloc(0), Buffer.from("abc"), Buffer.alloc(16383, 97),
    Buffer.alloc(16384, 98), Buffer.alloc(16385, 99), Buffer.alloc(32768, 100), incompressible];
  const tails = [Buffer.alloc(8), gzipSync(Buffer.alloc(0)), Buffer.from([0xff, 0, 0x1f, 0x8b])];
  for (const raw of inputs) for (const options of [{level: 0}, {level: 9}, {strategy: zlibConstants.Z_FIXED}]) {
    const deflate = deflateRawSync(raw, options);
    if (raw.length === 32768) {
      const expectedType = options.level === 0 ? 0 : options.level === 9 ? 2 : 1;
      assert.equal((deflate[0] >> 1) & 3, expectedType, "exercise stored, dynamic and fixed blocks");
    }
    if (raw === incompressible) assert.ok(deflate.length > 65536, "exercise multiple input chunks");
    for (const tail of tails) {
      const result = inflateRawSync(Buffer.concat([deflate, tail]),
        {info: true, finishFlush: zlibConstants.Z_FINISH, maxOutputLength: Math.max(1, raw.length)});
      assert.deepEqual(result.buffer, raw);
      assert.equal(result.engine.bytesWritten, deflate.length, `first stream offset for ${raw.length} bytes`);
    }
    assert.throws(() => inflateRawSync(deflate.subarray(0, -1),
      {info: true, finishFlush: zlibConstants.Z_FINISH, maxOutputLength: Math.max(1, raw.length)}));
  }
});

snapshotTest("Python gzip reference vectors prove CRC32, zero output and member boundaries", () => withFixture(f => {
  // Python gzip.compress(..., mtime=0), independent of Node's gzip/CRC fixture builders.
  const empty = Buffer.from("1f8b080000000000020303000000000000000000", "hex");
  const ascii = Buffer.from("1f8b080000000000020333343236313533b7b004002639f4cb09000000", "hex");
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926); // CRC-32/ISO-HDLC check value.
  for (const [packed, raw] of [[empty, Buffer.alloc(0)], [ascii, Buffer.from("123456789")]]) {
    assert.deepEqual(gunzipSync(packed), raw);
    assert.equal(packed.readUInt32LE(packed.length - 8), crc32(raw));
    assert.equal(packed.readUInt32LE(packed.length - 4), raw.length);
    const result = inflateRawSync(packed.subarray(10),
      {info: true, finishFlush: zlibConstants.Z_FINISH, maxOutputLength: Math.max(1, raw.length)});
    assert.deepEqual(result.buffer, raw);
    assert.equal(result.engine.bytesWritten, packed.length - 18, "gzip trailer must remain unconsumed");
  }
  f.repinGzip(empty);
  failed(f.run(), /Unexpected end of JSON input/); // Empty gzip is valid; empty JSON is not.
  f.repinGzip(ascii);
  failed(f.run(), /compact-v2 corpus or record count mismatch/); // The valid JSON number is not a corpus.
  guardBeforeCorpusParseAndWorker(f);
  f.repinGzip(empty);
  failed(f.run(), /corpus JSON parse reached/);
  const badCrc = Buffer.from(empty), badSize = Buffer.from(empty);
  badCrc[badCrc.length - 8] ^= 1;
  badSize[badSize.length - 4] ^= 1;
  f.repinGzip(badCrc);
  failed(f.run(), /gzip CRC32 mismatch/);
  f.repinGzip(badSize);
  failed(f.run(), /gzip ISIZE mismatch/);
  f.repinGzip(Buffer.concat([empty, Buffer.from([0])]));
  failed(f.run(), /gzip must contain exactly one member with no trailing bytes/);
}));

snapshotTest("invalid UTF-8 is rejected before corpus JSON parse or Worker", () => withFixture(f => {
  const source = readFileSync(f.scriptPath, "utf8");
  const parse = '  const data = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw));';
  assert.equal(source.split(parse).length, 2);
  writeFileSync(f.scriptPath, source.replace(parse, '  const text = new TextDecoder("utf-8", {fatal: true}).decode(raw);\n  throw new Error("corpus JSON parse reached");\n  const data = JSON.parse(text);'));
  rmSync(f.workerPath);
  failed(f.run(), /corpus JSON parse reached/); // A valid UTF-8 control reaches the sentinel.
  const invalid = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  assert.doesNotThrow(() => JSON.parse(invalid.toString("utf8")), "a replacement decoder would accept this JSON");
  f.repinGzip(gzipSync(invalid));
  failed(f.run(), /encoded data.*not valid.*utf-8/i);
}));

snapshotTest("gzip validation runs before corpus JSON parse and before reading the Worker", () => withFixture(f => {
  const original = readFileSync(f.scriptPath);
  guardBeforeCorpusParseAndWorker(f);
  failed(f.run(), /corpus JSON parse reached/);
  writeFileSync(f.scriptPath, original);
  failed(f.run(), /ENOENT.*index-worker\.js/);
}));

snapshotTest("repinned multi-member gzip and trailing junk fail before JSON parse or Worker", () => withFixture(f => {
  const empty = gzipSync(Buffer.alloc(0));
  const split = Math.floor(f.raw.length / 2);
  const emptyBomb = Buffer.allocUnsafe(empty.length * 500000).fill(empty);
  const cases = [
    ["empty trailing member", Buffer.concat([f.compressed, empty])],
    ["two JSON halves", Buffer.concat([gzipSync(f.raw.subarray(0, split)), gzipSync(f.raw.subarray(split))])],
    ["empty leading member", Buffer.concat([empty, f.compressed])],
    ["empty members between JSON halves", Buffer.concat([gzipSync(f.raw.subarray(0, split)), empty, empty, gzipSync(f.raw.subarray(split))])],
    ["garbage", Buffer.concat([f.compressed, Buffer.from("garbage")])],
    ["zero padding", Buffer.concat([f.compressed, Buffer.alloc(8)])],
    ["incomplete subsequent member", Buffer.concat([f.compressed, empty.subarray(0, 5)])],
    ["500000 empty trailing members", Buffer.concat([f.compressed, emptyBomb])],
  ];
  assert.deepEqual(gunzipSync(cases[0][1]), f.raw);
  assert.deepEqual(gunzipSync(cases[1][1]), f.raw);
  assert.deepEqual(gunzipSync(cases[2][1]), f.raw);
  assert.deepEqual(gunzipSync(cases[3][1]), f.raw);
  guardBeforeCorpusParseAndWorker(f);
  for (const [name, bytes] of cases) {
    const previousGeneration = f.manifest.generation;
    f.repinGzip(bytes);
    assert.notEqual(f.manifest.generation, previousGeneration, `${name} must repin the manifest`);
    const result = f.run([], undefined, {timeout: 15000});
    assert.notEqual(result.error?.code, "ETIMEDOUT", `${name} blocked`);
    failed(result, /gzip must contain exactly one member with no trailing bytes/);
  }
}));

snapshotTest("gzip headers, DEFLATE, trailers, CRC32, and ISIZE fail closed before parsing", () => withFixture(f => {
  const change = (offset, value) => { const b = Buffer.from(f.compressed); b[offset] = value; return b; };
  const optionalHeader = change(3, 8);
  const named = Buffer.concat([optionalHeader.subarray(0, 10), Buffer.from("name\0"), optionalHeader.subarray(10)]);
  assert.deepEqual(gunzipSync(named), f.raw, "optional name is a valid gzip outside the benchmark subset");
  const crc = Buffer.from(f.compressed), size = Buffer.from(f.compressed);
  crc[crc.length - 8] ^= 1;
  size[size.length - 4] ^= 1;
  const longRaw = Buffer.concat([f.raw, Buffer.alloc(131072 - f.raw.length, 32)]);
  const longCrc = gzipSync(longRaw);
  assert.deepEqual(gunzipSync(longCrc), longRaw);
  longCrc[longCrc.length - 8] ^= 1;
  const invalidBlock = Buffer.concat([f.compressed.subarray(0, 10), Buffer.from([7]), Buffer.alloc(9)]);
  const cases = [
    ["short header", f.compressed.subarray(0, 19), /unsupported or truncated gzip header/],
    ["bad magic 1", change(0, 0), /unsupported or truncated gzip header/],
    ["bad magic 2", change(1, 0), /unsupported or truncated gzip header/],
    ["bad method", change(2, 0), /unsupported or truncated gzip header/],
    ...[1, 2, 4, 8, 16, 32, 64, 128].map(flag => [`flag ${flag}`, change(3, flag), /unsupported or truncated gzip header/]),
    ["valid optional name", named, /unsupported or truncated gzip header/],
    ["invalid deflate block", invalidBlock, /invalid block type/],
    ["truncated deflate", f.compressed.subarray(0, f.compressed.length - 9), /unexpected end|invalid|gzip must contain/],
    ...Array.from({length: 8}, (_, i) => [`truncated trailer ${i + 1}`,
      f.compressed.subarray(0, f.compressed.length - i - 1), /unexpected end|gzip must contain/]),
    ["CRC", crc, /gzip CRC32 mismatch/],
    ["long output CRC", longCrc, /gzip CRC32 mismatch/],
    ["ISIZE", size, /gzip ISIZE mismatch/],
  ];
  guardBeforeCorpusParseAndWorker(f);
  for (const [name, bytes, error] of cases) {
    f.repinGzip(bytes);
    const result = f.run();
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    failed(result, error);
  }
}));

snapshotTest("valid single members survive different block formats, headers and output chunk boundaries", () => withFixture(f => {
  const formats = [{level: 0}, {level: 9}, {strategy: zlibConstants.Z_FIXED}];
  for (const length of [16383, 16384, 16385, 32768]) for (const format of formats) {
    const raw = Buffer.concat([f.raw, Buffer.alloc(length - f.raw.length, 32)]);
    const packed = rawGzip(raw, format);
    // MTIME, XFL, and OS are informational and must not be constrained.
    packed.writeUInt32LE(0x12345678, 4);
    packed[8] = 7;
    packed[9] = 3;
    assert.deepEqual(gunzipSync(packed), raw);
    f.repinGzip(packed);
    const result = f.run();
    assert.equal(result.status, 0, `${length} ${JSON.stringify(format)}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).corpus_expanded_sha256, hash(raw));
  }
}));

snapshotTest("output cap accepts the boundary and rejects one byte over independently of ISIZE", () => withFixture(f => {
  const source = readFileSync(f.scriptPath, "utf8");
  const original = "const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;";
  assert.equal(source.split(original).length, 2);
  writeFileSync(f.scriptPath, source.replace(original, "const MAX_EXPANDED_BYTES = 32768;"));
  for (const length of [32767, 32768]) {
    const raw = Buffer.concat([f.raw, Buffer.alloc(length - f.raw.length, 32)]);
    f.repinGzip(gzipSync(raw));
    const result = f.run();
    assert.equal(result.status, 0, `${length}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).corpus_expanded_bytes, length);
  }
  guardBeforeCorpusParseAndWorker(f);
  const raw = Buffer.concat([f.raw, Buffer.alloc(32769 - f.raw.length, 32)]);
  const packed = gzipSync(raw);
  packed.writeUInt32LE(1, packed.length - 4); // An untrusted ISIZE cannot lower the real output size.
  f.repinGzip(packed);
  failed(f.run(), /larger than 32768 bytes|Cannot create a Buffer larger than 32768 bytes/);
}));

snapshotTest("actual 256 MiB boundary accepts exact output and rejects a repinned bomb before parsing", () => withFixture(f => {
  // Compress incrementally in a separate process rather than allocating a
  // 256 MiB input fixture. The decompressed output is valid JSON + whitespace.
  const generator = `const {createGzip}=require("node:zlib");
const {once}=require("node:events");
const raw=Buffer.from(process.argv[1],"base64"), chunk=Buffer.alloc(1024*1024,32), gz=createGzip();
gz.pipe(process.stdout);
(async()=>{let left=Number(process.argv[2])-raw.length;
if(!gz.write(raw)) await once(gz,"drain");
while(left>0){const n=Math.min(left,chunk.length);if(!gz.write(chunk.subarray(0,n))) await once(gz,"drain");left-=n;}
gz.end();})().catch(e=>{console.error(e);process.exitCode=1;});`;
  function compressedAtSize(size) {
    const generated = spawnSync(process.execPath, ["-e", generator, f.raw.toString("base64"), String(size)],
      {timeout: 60000, maxBuffer: 2 * 1024 * 1024});
    assert.ifError(generated.error);
    assert.equal(generated.status, 0, generated.stderr.toString());
    assert.equal(generated.stdout.readUInt32LE(generated.stdout.length - 4), size);
    return generated.stdout;
  }
  const limit = 256 * 1024 * 1024;
  guardBeforeCorpusParseAndWorker(f);
  f.repinGzip(compressedAtSize(limit));
  failed(f.run([], undefined, {timeout: 60000}), /corpus JSON parse reached/);
  const bomb = compressedAtSize(limit + 1);
  bomb.writeUInt32LE(1, bomb.length - 4); // Forged ISIZE must not bypass the output cap.
  f.repinGzip(bomb);
  failed(f.run([], undefined, {timeout: 60000}), /larger than 268435456 bytes|Cannot create a Buffer larger than 268435456 bytes/);
}));

snapshotTest("missing CRC support or unreliable raw inflate probe fails before JSON parse or Worker", () => withFixture(f => {
  const original = readFileSync(f.scriptPath, "utf8");
  const line = 'import * as zlib from "node:zlib";';
  assert.equal(original.split(line).length, 2);
  guardBeforeCorpusParseAndWorker(f);
  const guarded = readFileSync(f.scriptPath, "utf8");
  const cases = [
    ['const zlib = {...realZlib, crc32: undefined};', /Node zlib crc32 support is required/],
    ['const zlib = {...realZlib, inflateRawSync: (...args) => { const r = realZlib.inflateRawSync(...args); r.engine.bytesWritten = 4; return r; }};',
      /cannot reliably identify the end/],
    ['const zlib = {...realZlib, inflateRawSync: (...args) => { try { return realZlib.inflateRawSync(...args); } catch { return {buffer: Buffer.alloc(0), engine: {bytesWritten: 1}}; } }};',
      /cannot reliably identify the end/],
    ['const zlib = {...realZlib, inflateRawSync: (input, options) => realZlib.inflateRawSync(input, {...options, maxOutputLength: 100})};',
      /cannot reliably identify the end.*output bound/],
  ];
  for (const [mock, error] of cases) {
    writeFileSync(f.scriptPath, guarded.replace(line, `import * as realZlib from "node:zlib";\n${mock}`));
    failed(f.run(), error);
  }
}));

snapshotTest("manifest source and expanded Pages JSON may have equivalent values but different bytes", () => withFixture(f => {
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

snapshotTest("warmup and measured samples retain index state and reject a warmup tail permutation", () => withFixture(f => {
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

snapshotTest("a second uncached order with only its tail reversed is rejected", () => withFixture(f => {
  const point = "  searchOrderCache.set(cacheKey, ordered);\n  while (searchOrderCache.size > SEARCH_ORDER_CACHE_MAX)";
  f.inject(point, `  if (params.q === "*.pdf") {
    globalThis.benchFaultCount = (globalThis.benchFaultCount || 0) + 1;
    if (globalThis.benchFaultCount === 2) ordered.splice(500, ordered.length - 500, ...ordered.slice(500).reverse());
  }\n${point}`);
  failed(f.run(), /unstable uncached order:.*\*\.pdf/);
}));

snapshotTest("cache bypass fault otherwise produces identical verified results", () => withFixture(f => {
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const query = JSON.parse(result.stdout).queries.find(item => item.params.q === "*.pdf");
  assert.equal(query.total, 625);
  assert.equal(query.cached.ordered_ids_sha256, query.uncached.ordered_ids_sha256);
}, {bypassCache: true}));

snapshotTest("recomputing an identical order instead of hitting the cache is rejected", () => withFixture(f => {
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

snapshotTest("using a cached order via a different uninstrumented path is rejected", () => withFixture(f => {
  const point = "  let ordered = searchOrderCache.get(cacheKey);\n  if (ordered) {";
  f.inject(point, `  let ordered = searchOrderCache.get(cacheKey);
  if (ordered && params.q === "*.pdf") return pageResult(ordered, params);
  if (ordered) {`);
  failed(f.run(), /cached order not reused:.*\*\.pdf/);
}));

snapshotTest("recomputing an identical cached page-two order is rejected", () => withFixture(f => {
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

snapshotTest("cache instrumentation fails closed if the Worker cache branch changes", () => withFixture(f => {
  const point = "    searchOrderCache.set(cacheKey, ordered);\n    return pageResult(ordered, params);";
  f.inject(point, "    searchOrderCache.set(cacheKey, ordered);\n    return pageResult(ordered, {...params});");
  failed(f.run(), /cannot instrument search order cache miss path/);
}));

snapshotTest("a cached page-two tail permutation is rejected", () => withFixture(f => {
  const point = "  if (typeof params.anchorId === \"string\") {\n    result.anchor_index = findSearchAnchor(indices, params.anchorId);";
  f.inject(point, `  if (params.q === "*.pdf" && Number(params.page) === 2) result.ids.reverse();\n${point}`);
  failed(f.run(), /cached full-order mismatch:.*\*\.pdf/);
}));

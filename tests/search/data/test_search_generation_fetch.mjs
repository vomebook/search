import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {gzipSync} from "node:zlib";
import test from "node:test";
import {ensureSearchGeneration, fetchSearchGeneration} from "../../../scripts/data/fetch_search_generation.mjs";
import {prepareTestData} from "../../../scripts/data/prepare_test_data.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fixture() {
  const files = {}, objects = {}, bodies = new Map();
  for (const name of ["search_data.json.gz", "folder_tree.json.gz", "folder_browser.json.gz",
    "initial/global.json", "initial/manifest.json", "initial/repos/Test.json",
    "sidebar/global.json", "sidebar/manifest.json", "sidebar/repos/Test.json"]) {
    const bytes = Buffer.from(`fixture ${name}`), sha256 = hash(bytes);
    const object = `objects/sha256/${sha256.slice(0, 2)}/${sha256}`;
    files[name] = {sha256, bytes: bytes.length};
    objects[name] = {...files[name], object};
    bodies.set(object, bytes);
  }
  const identity = {version: 1, kind: "search-snapshot-local", files: {pages: files}};
  const generation = hash(Buffer.from(canonical(identity) + "\n"));
  const manifest = {...identity, generation, object_layout: "objects/sha256/<first-two>/<sha256>", objects: {pages: objects}};
  bodies.set(`generations/${generation}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
  return {generation, manifest, bodies};
}
async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "search-generation-")), originalFetch = globalThis.fetch;
  const f = {...fixture(), root, out: join(root, "data"), requests: []};
  globalThis.fetch = async url => {
    const base = "https://huggingface.co/buckets/vomebook/search-data-v1/resolve/";
    assert.ok(String(url).startsWith(base), "only immutable search bucket requests");
    const name = String(url).slice(base.length);
    f.requests.push(name);
    return f.bodies.has(name) ? new Response(f.bodies.get(name)) : new Response("missing", {status: 404});
  };
  try { await run(f); }
  finally { globalThis.fetch = originalFetch; await rm(root, {recursive: true, force: true}); }
}

test("first materialization validates and publishes all search members, then reuses matching bytes offline", async () => {
  await withFixture(async f => {
    const result = await ensureSearchGeneration(f.generation, "pages", f.out);
    assert.deepEqual(result, {generation: f.generation, surface: "pages", files: 9});
    assert.equal(f.requests.length, 10);
    for (const [name, member] of Object.entries(f.manifest.objects.pages)) {
      assert.deepEqual(await readFile(join(f.out, name)), f.bodies.get(member.object));
    }
    assert.deepEqual(JSON.parse(await readFile(join(f.out, "generation-manifest.json"))), f.manifest);
    await writeFile(join(f.out, "reader_assets.json.gz"), "independent Reader sidecar");
    await writeFile(join(f.out, "reader_v3_receipt.json"), "independent Reader receipt");
    globalThis.fetch = () => { throw new Error("reuse must be offline"); };
    assert.deepEqual(await ensureSearchGeneration(f.generation, "pages", f.out), result);
    assert.equal(await readFile(join(f.out, "reader_assets.json.gz"), "utf8"), "independent Reader sidecar");
    assert.deepEqual(await readdir(f.root), ["data"]);
  });
});

test("unhashed object name cannot escape output or replace the validated member name", async () => {
  await withFixture(async f => {
    const name = "initial/global.json", member = f.manifest.objects.pages[name];
    member.name = "../escape";
    f.bodies.set(`generations/${f.generation}/manifest.json`, Buffer.from(JSON.stringify(f.manifest)));
    await fetchSearchGeneration(f.generation, "pages", f.out);
    assert.deepEqual(await readdir(f.root), ["data"], "no writes outside output or temporary residue");
    assert.deepEqual(await readFile(join(f.out, name)), f.bodies.get(member.object));
    globalThis.fetch = () => { throw new Error("reuse must be offline"); };
    await ensureSearchGeneration(f.generation, "pages", f.out);
    // Even if the attacker puts valid bytes at the injected path, validation
    // must still inspect the manifest-key path and detect its corruption.
    await writeFile(join(f.root, "escape"), f.bodies.get(member.object));
    await writeFile(join(f.out, name), "X".repeat(member.bytes));
    await assert.rejects(ensureSearchGeneration(f.generation, "pages", f.out), /search member mismatch: initial\/global.json/);
    assert.deepEqual(await readFile(join(f.root, "escape")), f.bodies.get(member.object));
  });
});

test("data gates fail on an explicitly missing data directory instead of using checkout data", async () => {
  const root = await mkdtemp(join(tmpdir(), "search-data-target-"));
  try {
    for (const script of ["test_data_integrity.js", "test_corpus_oracle.js"]) {
      const result = spawnSync(process.execPath, [join("tests/search/data", script)], {
        encoding: "utf8", env: {...process.env, SEARCH_TEST_DATA_DIR: join(root, "missing")},
      });
      assert.notEqual(result.status, 0, script);
      assert.match(result.stderr, /ENOENT/);
      assert.ok(result.stderr.includes(join(root, "missing", "search_data.json.gz")), result.stderr);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("existing different generation is rejected without download or replacement", async () => {
  await withFixture(async f => {
    await ensureSearchGeneration(f.generation, "pages", f.out);
    const before = await readFile(join(f.out, "generation-manifest.json"));
    f.requests.length = 0;
    await assert.rejects(ensureSearchGeneration("a".repeat(64), "pages", f.out), /invalid search generation manifest/);
    assert.deepEqual(await readFile(join(f.out, "generation-manifest.json")), before);
    assert.equal(f.requests.length, 0);
    // The test entry point uses the configured baseline, never an ambient
    // production override or whatever generation happens to be on disk.
    const previous = process.env.SEARCH_DATA_GENERATION;
    process.env.SEARCH_DATA_GENERATION = f.generation;
    try { await assert.rejects(prepareTestData(f.out), /invalid search generation manifest/); }
    finally {
      if (previous === undefined) delete process.env.SEARCH_DATA_GENERATION;
      else process.env.SEARCH_DATA_GENERATION = previous;
    }
    assert.equal(f.requests.length, 0);
  });
});

for (const fault of ["corrupt", "missing", "extra", "symlink", "manifest"]) {
  test(`existing ${fault} data is rejected without repair or network fallback`, async () => {
    await withFixture(async f => {
      await ensureSearchGeneration(f.generation, "pages", f.out);
      const member = join(f.out, "initial", "global.json");
      if (fault === "corrupt") await writeFile(member, "X".repeat((await readFile(member)).length));
      if (fault === "missing") await rm(member);
      if (fault === "extra") await writeFile(join(f.out, "initial", "repos", "Stale.json"), "{}");
      if (fault === "symlink") {
        await rm(member);
        await symlink("manifest.json", member);
      }
      if (fault === "manifest") await writeFile(join(f.out, "generation-manifest.json"), "{}");
      const before = await readdir(f.out, {recursive: true});
      globalThis.fetch = () => { throw new Error("must not fetch"); };
      await assert.rejects(ensureSearchGeneration(f.generation, "pages", f.out), /search member|ENOENT|invalid search generation manifest/);
      assert.deepEqual(await readdir(f.out, {recursive: true}), before);
      assert.deepEqual(await readdir(f.root), ["data"]);
    });
  });
}

for (const fault of ["HTTP", "digest", "identity"]) {
  test(`first download ${fault} failure leaves no output or temporary directory and permits retry`, async () => {
    await withFixture(async f => {
      const name = fault === "identity" ? `generations/${f.generation}/manifest.json` : f.manifest.objects.pages["sidebar/global.json"].object;
      const original = f.bodies.get(name);
      if (fault === "HTTP") f.bodies.delete(name);
      if (fault === "digest") f.bodies.set(name, Buffer.from("X".repeat(original.length)));
      if (fault === "identity") f.bodies.set(name, Buffer.from(JSON.stringify({...f.manifest, injected: true})));
      await assert.rejects(ensureSearchGeneration(f.generation, "pages", f.out), /search data HTTP|search member mismatch|search generation identity mismatch/);
      assert.deepEqual(await readdir(f.root), []);
      f.bodies.set(name, original);
      await ensureSearchGeneration(f.generation, "pages", f.out);
      assert.deepEqual(await readdir(f.root), ["data"]);
    });
  });
}

test("test preparation uses its pinned config and independent Reader URL; Reader failure preserves reusable search data", async () => {
  await withFixture(async f => {
    // Isolate the entry point's real config lookup without changing checkout config.
    await cp(new URL("../../../scripts/data/", import.meta.url), join(f.root, "scripts/data"), {recursive: true});
    await mkdir(join(f.root, "config"));
    await writeFile(join(f.root, "config/search-data.json"), JSON.stringify({generation: f.generation}));
    const {prepareTestData: prepare} = await import(pathToFileURL(join(f.root, "scripts/data/prepare_test_data.mjs")));
    const searchFetch = globalThis.fetch, readerRequests = [];
    let failReader = false;
    const sidecar = gzipSync(Buffer.from(JSON.stringify({v: 1, f: {}})));
    globalThis.fetch = async url => {
      if (String(url).includes("/search-data-v1/")) return searchFetch(url);
      readerRequests.push(url);
      if (url === "https://huggingface.co/buckets/vomebook/reader-assets-v2/resolve/reader-index/reader_assets.json.gz") {
        return new Response(sidecar, {status: failReader ? 503 : 200});
      }
      assert.equal(url, "https://huggingface.co/buckets/vomebook/reader-assets-v2/resolve/reader-index/v3/current.json");
      return new Response("absent", {status: 404});
    };
    await prepare(f.out);
    assert.deepEqual(await readFile(join(f.out, "reader_assets.json.gz")), sidecar);
    assert.equal(f.requests.length, 10);
    assert.equal(readerRequests.length, 2);
    failReader = true;
    await assert.rejects(prepare(f.out), /Reader Assets request failed: HTTP 503/);
    assert.equal(f.requests.length, 10, "search reuse needs no downloads");
    assert.deepEqual(await readFile(join(f.out, "reader_assets.json.gz")), sidecar);
    assert.ok(!(await readdir(f.out)).some(name => name.endsWith(".tmp")));
    failReader = false;
    await prepare(f.out);
    assert.equal(f.requests.length, 10);
    assert.equal(readerRequests.length, 7, "Reader is independently refreshed on every preparation");
  });
});

test("HF workflow prepares newer revisions, preserves old checkout data, and propagates preparation failure", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/reader-refactor.yml", import.meta.url), "utf8");
  const block = workflow.split("      - name: Prepare Hugging Face data when supported by the captured revision\n")[1].split("      - name:")[0];
  const shell = block.split("        run: |\n")[1].split("\n").map(line => line.replace(/^          /, "")).join("\n");
  const root = await mkdtemp(join(tmpdir(), "hf-data-prepare-"));
  try {
    await writeFile(join(root, "data-sentinel"), "old checkout");
    for (const [scripts, code, prepared] of [
      [{}, 0, false],
      [{"data:prepare": "node -e \"require('fs').writeFileSync('prepared', 'ok')\""}, 0, true],
      [{"data:prepare": "node -e \"process.exit(23)\""}, 23, false],
    ]) {
      await rm(join(root, "prepared"), {force: true});
      await writeFile(join(root, "package.json"), JSON.stringify({private: true, scripts}));
      const result = spawnSync("bash", ["-c", shell], {cwd: root, encoding: "utf8",
        env: {...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || ""}`}});
      assert.equal(result.status, code, result.stdout + result.stderr);
      assert.equal((await readdir(root)).includes("prepared"), prepared);
      assert.equal(await readFile(join(root, "data-sentinel"), "utf8"), "old checkout");
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("production fetch retains create-only behavior and never overwrites existing output", async () => {
  await withFixture(async f => {
    await fetchSearchGeneration(f.generation, "pages", f.out);
    const before = await readFile(join(f.out, "generation-manifest.json"));
    await assert.rejects(fetchSearchGeneration(f.generation, "pages", f.out), /output already exists/);
    assert.deepEqual(await readFile(join(f.out, "generation-manifest.json")), before);
    assert.deepEqual(await readdir(f.root), ["data"]);
  });
});

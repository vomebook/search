import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DEPENDENCIES } from "../../../scripts/build/compose_app.mjs";
import { installPrecachePaths, installPrecacheRequests } from "../../support/shell_assets.mjs";

const project = "github";
const buildScript = fileURLToPath(new URL("../../../scripts/build/build_static_assets.mjs", import.meta.url));
const base = project === "github" ? "/search/" : "/";
const assetDir = project === "github" ? "static/" : "";
const reader = assetDir + "reader.html";
const staticBase = base + "static/";
const bundledSearchFiles = ["search/catalog/domain/record-path.js", "search/reader-host/application/navigation.js"];
const standalone = ["search/index-worker.js", "search/worker/domain/text.js", "search/worker/domain/intersection.js"];
const bundledReader = "reader/core/reader-bindings.mjs";
const readerContract = "reader/core/reader-contract.js";
const retainedFiles = ["style.css", "reader-resources.js", readerContract, "app.js", ...standalone];
const staticDir = new URL("../../../static/", import.meta.url);
const sourceWorker = readFileSync(new URL("sw.js", staticDir), "utf8");
const worker = sourceWorker.replace("const PRECACHE_URLS = [", `const PRECACHE_URLS = [
  "${staticBase}graph-only.js",
`);
const versionMarker = 'CACHE_VERSION = "development"';
const optional = {
  "manifest.json": '{"name":"Search"}',
  "data/generation-manifest.json": '{"generation":"first"}',
  "data/reader_assets.json.gz": "tiny binary fixture\0",
  "data/search_data.json.gz": "fixed corpus fixture\0",
  "data/initial/manifest.json": '{"urls":[]}',
  "data/initial/global.json": '{"records":[]}',
  "data/sidebar/manifest.json": '{"urls":[]}',
  "data/sidebar/global.json": '{"folders":[]}',
  "icons/z.svg": "<svg>Z</svg>",
  "icons/nested/a.svg": "<svg>A</svg>",
};
// Each run owns a tiny fresh tree (<20 KB) and removes it in finally.
async function build(overrides = {}, { extras = true, reverse = false, minify = false, failure = false, extraDevHost } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "sw-cache-build-"));
  const output = join(fixture, "out");
  function put(filename, content) {
    const target = join(fixture, filename);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  function run(command, args) {
    return spawnSync(command, args, {
      cwd: fixture, encoding: "utf8", timeout: 15000,
      env: { ...process.env, STATIC_OUTPUT_DIR: output },
    });
  }
  function minifyWorker() {
    const result = run(process.env.ESBUILD_BINARY, [join(output, "sw.js"), "--minify", "--target=es2019",
      "--charset=utf8", "--legal-comments=none", "--outfile=" + join(output, "sw.min.js")]);
    assert.equal(result.status, 0, result.stderr || String(result.error));
    put("out/sw.js", readFileSync(join(output, "sw.min.js")));
    rmSync(join(output, "sw.min.js"));
  }
  try {
    const fixtureResourcesPath = join(fixture, "static/reader-resources.js");
    const devOnly = [...bundledSearchFiles, ...(extraDevHost ? [extraDevHost] : []), bundledReader];
    put("static/reader-resources.js", `module.exports = {
      vendors: {}, searchHostFiles: ${JSON.stringify(devOnly.filter(file => file !== bundledReader))},
      bundleOnlyFiles: ${JSON.stringify(devOnly)},
      releaseFiles: () => ${JSON.stringify(["dep.js", "graph-only.js", ...retainedFiles])},
      shellAssets: base => [base + 'reader.html', base + '${readerContract}'],
      runtimePaths: base => [base + '${readerContract}', base + '${bundledReader}'],
      djvuDecoderAssets: () => [], ruffleAssets: () => []
    };`);
    let files = Object.entries({
      ...Object.fromEntries(retainedFiles.map(file => [assetDir + file, "void 0;"])),
      [assetDir + "dep.js"]: "export const value = 1;",
      [assetDir + "app.js"]: "import { value } from './dep.js'; console.log(value);",
      [assetDir + "graph-only.js"]: "self.extra = 1;",
      [assetDir + readerContract]: "self.reader = 1;",
      "index.html": `<h1>Search</h1><script src="${base}static/app.js"></script>`,
      [reader]: `<h1>Reader</h1><script src="${base}static/app.js"></script>`,
      "sw.js": worker,
      ...(extras ? optional : {}),
      ...overrides,
    });
    if (reverse) files.reverse();
    for (const [filename, content] of files) put("out/" + filename, content);
    if (minify) minifyWorker();
    const result = run(process.execPath, [buildScript]);
    if (failure) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /exactly one CACHE_VERSION = 'development' marker/);
      return;
    }
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const stamped = readFileSync(join(output, "sw.js"), "utf8");
    const version = stamped.match(/\bCACHE_VERSION\s*=\s*["']([a-f0-9]{64})["']/)?.[1];
    assert.ok(version, "build must stamp a SHA-256 cache version");
    assert.doesNotMatch(stamped, /CURRENT_HASHED_ASSETS\s*=\s*\[\]/);
    const graph = JSON.parse(stamped.match(/\bCURRENT_HASHED_ASSETS\s*=\s*(\[[^\]]*\])/)[1]);
    const outputUrl = file => {
      const dot = file.lastIndexOf(".");
      const stem = staticBase + file.slice(0, dot) + ".";
      const urls = graph.filter(url => url.startsWith(stem) && url.endsWith(file.slice(dot)));
      assert.equal(urls.length, 1, `${file} must remain in the current hashed graph`);
      assert.match(urls[0].slice(stem.length), /^[a-f0-9]{12}\.(?:js|css)$/);
      assert.ok(existsSync(join(output, assetDir + urls[0].slice(staticBase.length))), `${file} must still be emitted`);
      return urls[0];
    };
    const fixtureResources = createRequire(import.meta.url)(fixtureResourcesPath);
    const builtWorker = readFileSync(join(output, "sw.js"), "utf8");
    const install = await installPrecacheRequests(builtWorker, fixtureResources, staticBase);
    const pathOf = request => new URL(request.url).pathname;
    const paths = install.map(pathOf);
    assert.equal(new Set(paths).size, paths.length, "install must not double-fetch entries");
    assert.deepEqual(paths.filter(path => path.startsWith(staticBase)).sort(),
      [...retainedFiles.map(outputUrl), outputUrl("graph-only.js"), staticBase + "reader.html"].sort());
    assert.ok(builtWorker.includes(outputUrl("reader-resources.js")), "worker imports the hashed inventory");
    for (const file of devOnly) {
      const stem = file.slice(0, file.lastIndexOf(".") + 1);
      assert.ok(!graph.some(url => url.startsWith(staticBase + stem)), `${file} must not be in the production asset graph`);
    }
    assert.ok(paths.includes(base + "data/initial/global.json"));
    const shellDigest = createHash("sha256").update(readFileSync(join(output, reader))).digest("base64");
    assert.ok(stamped.includes(`READER_SHELL_INTEGRITY="sha256-${shellDigest}"`));
    const readerRequest = install.find(request => pathOf(request) === staticBase + "reader.html");
    assert.equal(readerRequest.integrity, `sha256-${shellDigest}`);
    assert.equal(readerRequest.cache, "no-cache");
    const searchDigest = createHash("sha256").update(readFileSync(join(output, "index.html"))).digest("base64");
    assert.ok(stamped.includes(`SEARCH_SHELL_INTEGRITY="sha256-${searchDigest}"`));
    const searchRequest = install.find(request => pathOf(request) === base);
    assert.equal(searchRequest.integrity, `sha256-${searchDigest}`);
    assert.equal(searchRequest.cache, "no-cache");
    if (extras) {
      const corpusDigest = createHash("sha256").update(readFileSync(join(output, "data/search_data.json.gz"))).digest("base64");
      assert.ok(stamped.includes(`CORPUS_INTEGRITY="sha256-${corpusDigest}"`));
    }
    assert.match(readFileSync(join(output, "index.html"), "utf8"), /app\.[a-f0-9]{12}\.js/);
    assert.match(readFileSync(join(output, reader), "utf8"), /app\.[a-f0-9]{12}\.js/);
    assert.equal(existsSync(join(output, assetDir + "app.js")), false);
    const snapshot = {};
    for (const filename of readdirSync(output, { recursive: true }).sort()) {
      const target = join(output, filename);
      if (statSync(target).isFile()) {
        snapshot[filename] = readFileSync(target).toString("base64");
      }
    }
    for (const file of devOnly) {
      const stem = file.slice(0, file.lastIndexOf(".") + 1);
      assert.ok(!Object.keys(snapshot).some(name => name.startsWith(assetDir + stem)), `${file} must not be emitted separately`);
    }
    return { version, snapshot };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    assert.equal(existsSync(fixture), false);
  }
}

const resources = createRequire(import.meta.url)("../../../static/reader-resources.js");
for (const inventory of [resources.shellAssets(staticBase), resources.runtimePaths(staticBase)]) {
  assert.ok(!inventory.some(url => url.startsWith(staticBase + "search/")));
  assert.ok(inventory.includes(staticBase + readerContract));
  assert.ok(inventory.includes(staticBase + "reader/search/reader-pdf-book-validate.mjs"));
}
const buildFiles = resources.buildFiles(project);
const releaseFiles = resources.releaseFiles(project);
assert.ok(!releaseFiles.includes(bundledReader));
assert.ok(!releaseFiles.includes("reader/reader-components.mjs"));
assert.ok(releaseFiles.includes("reader/formats/reader-text-format.mjs"), "speech imports the standalone formatter");
assert.ok(releaseFiles.includes("tts-client.js"), "the optional player must still be hashed and published");
assert.ok(resources.runtimePaths(staticBase).includes(staticBase + "tts-client.js"), "retain the warmed player for offline reuse");
assert.ok(!resources.shellAssets(staticBase).includes(staticBase + "tts-client.js"), "search must not warm the optional player");
const searchDeps = new Set(APP_DEPENDENCIES.filter(file => file.startsWith("search/")));
for (const file of searchDeps) {
  assert.ok(buildFiles.includes(file), `${file} must remain a composition input`);
  assert.ok(!releaseFiles.includes(file), `${file} must not be emitted separately`);
}
const sourcePrecache = await installPrecachePaths(sourceWorker, resources, staticBase);
for (const file of standalone) {
  assert.ok(releaseFiles.includes(file), `${file} must still be published`);
  assert.ok(sourcePrecache.includes(file), `${file} is required for offline Pages search`);
}

const baseline = await build();
assert.deepEqual(await build({}, { extraDevHost: "search/dev-only.js" }), baseline,
  "unused development inputs must not alter the production install or snapshot");
assert.deepEqual(await build({}, { reverse: true }), baseline, "identical bytes must produce identical output regardless of creation order/path");
assert.deepEqual(await build({}, { extras: false }), await build({}, { extras: false }), "missing optional HF data/icons must be supported deterministically");
for (const [filename, content] of Object.entries({
  "sw.js": worker.replace("skipWaiting();", "skipWaiting().catch(() => {});"),
  "index.html": `<h1>New search shell</h1><script src="${base}static/app.js"></script>`,
  [reader]: `<h1>New reader shell</h1><script src="${base}static/app.js"></script>`,
  [assetDir + "dep.js"]: "export const value = 2;",
  [assetDir + "graph-only.js"]: "self.extra = 2;",
  ...Object.fromEntries(Object.entries(optional).map(([name, text]) => [name, text + " "])),
})) {
  assert.notEqual((await build({ [filename]: content })).version, baseline.version, filename + " changes must rotate the cache");
}
assert.deepEqual(await build({
  "index.html": `<script src="${base}static/search/catalog/domain/record-path.js"></script><h1>Search</h1><script src="${base}static/app.js"></script>`,
}), baseline, "hash the final HTML after bundled scripts are removed");
for (const invalid of [worker.replace(versionMarker, 'OTHER_VERSION = "development"'),
  worker.replace(versionMarker, 'CACHE_VERSION = "stale"'), worker + "\nconst " + versionMarker + ";"]) {
  await build({ "sw.js": invalid }, { failure: true });
}
// Exercise a minifier-style combined declaration even without esbuild.
const compact = worker.replace(/;\nconst CACHE_VERSION/, ', CACHE_VERSION');
assert.deepEqual(await build({ "sw.js": compact }), await build({ "sw.js": compact }));
if (process.env.ESBUILD_BINARY) {
  assert.deepEqual(await build({}, { minify: true }), await build({}, { minify: true }));
  assert.notEqual((await build({ "sw.js": worker.replace("skipWaiting();", "skipWaiting().catch(() => {});") }, { minify: true })).version,
    (await build({}, { minify: true })).version);
} else {
  console.log("ESBUILD_BINARY unset: actual minification check skipped (compact marker syntax checked)");
}
console.log(`${project}: build-derived worker cache regression passed`);

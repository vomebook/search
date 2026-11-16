import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = "github";
const buildScript = fileURLToPath(new URL("../../../scripts/build/build_static_assets.mjs", import.meta.url));
const base = project === "github" ? "/search/" : "/";
const assetDir = project === "github" ? "static/" : "";
const reader = assetDir + "reader.html";
const prefix = project === "github" ? "vomebook-search-" : "voiceofml-search-hf-";
const worker = `const CACHE_PREFIX = '${prefix}';
const CACHE_VERSION = 'development';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const CURRENT_HASHED_ASSETS = [];
self.addEventListener('install', () => caches.open(CACHE_NAME));
`;
const optional = {
  "manifest.json": '{"name":"Search"}',
  "data/generation-manifest.json": '{"generation":"first"}',
  "data/reader_assets.json.gz": "tiny binary fixture\0",
  "data/initial/manifest.json": '{"urls":[]}',
  "data/initial/global.json": '{"records":[]}',
  "data/sidebar/manifest.json": '{"urls":[]}',
  "data/sidebar/global.json": '{"folders":[]}',
  "icons/z.svg": "<svg>Z</svg>",
  "icons/nested/a.svg": "<svg>A</svg>",
};
// Each run owns a tiny fresh tree (<20 KB) and removes it in finally.
function build(overrides = {}, { extras = true, reverse = false, minify = false, failure = false } = {}) {
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
    put("static/reader-resources.js", `module.exports = {
      vendors: {}, buildFiles: () => ['dep.js', 'app.js', 'graph-only.js'], djvuDecoderAssets: () => [], ruffleAssets: () => []
    };`);
    let files = Object.entries({
      [assetDir + "dep.js"]: "export const value = 1;",
      [assetDir + "app.js"]: "import { value } from './dep.js'; console.log(value);",
      [assetDir + "graph-only.js"]: "self.extra = 1;",
      "index.html": `<h1>Search</h1><script src="${base}static/app.js"></script>`,
      [reader]: `<h1>Reader</h1><script src="${base}static/app.js"></script>`,
      "sw.js": worker,
      ...(extras ? optional : {}),
      ...overrides,
    });
    if (reverse) files.reverse();
    for (const [filename, content] of files) put("out/" + filename, content);
    if (minify && project === "github") minifyWorker();
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
    if (minify && project === "hf") {
      minifyWorker();
      assert.ok(readFileSync(join(output, "sw.js"), "utf8").includes(version), "HF minification must preserve the version");
    }
    assert.doesNotMatch(stamped, /CURRENT_HASHED_ASSETS\s*=\s*\[\]/);
    assert.match(stamped, /graph-only\.[a-f0-9]{12}\.js/);
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
    return { version, snapshot };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    assert.equal(existsSync(fixture), false);
  }
}

const baseline = build();
assert.deepEqual(build({}, { reverse: true }), baseline, "identical bytes must produce identical output regardless of creation order/path");
assert.deepEqual(build({}, { extras: false }), build({}, { extras: false }), "missing optional HF data/icons must be supported deterministically");
for (const [filename, content] of Object.entries({
  "sw.js": worker.replace("'install'", "'activate'"),
  "index.html": `<h1>New search shell</h1><script src="${base}static/app.js"></script>`,
  [reader]: `<h1>New reader shell</h1><script src="${base}static/app.js"></script>`,
  [assetDir + "dep.js"]: "export const value = 2;",
  [assetDir + "graph-only.js"]: "self.extra = 2;",
  ...Object.fromEntries(Object.entries(optional).map(([name, text]) => [name, text + " "])),
})) {
  assert.notEqual(build({ [filename]: content }).version, baseline.version, filename + " changes must rotate the cache");
}
assert.deepEqual(build({
  "index.html": `<script src="${base}static/search/catalog/domain/record-path.js"></script><h1>Search</h1><script src="${base}static/app.js"></script>`,
}), baseline, "hash the final HTML after bundled scripts are removed");
for (const invalid of [worker.replace("CACHE_VERSION = 'development'", "OTHER_VERSION = 'development'"),
  worker.replace("'development'", "'stale'"), worker + "const CACHE_VERSION = 'development';"]) {
  build({ "sw.js": invalid }, { failure: true });
}
// Exercise a minifier-style combined declaration even without an esbuild install.
const compact = worker.replace(/;\nconst /g, ",").replaceAll("'", '"');
assert.deepEqual(build({ "sw.js": compact }), build({ "sw.js": compact }));
if (process.env.ESBUILD_BINARY) {
  assert.deepEqual(build({}, { minify: true }), build({}, { minify: true }));
  assert.notEqual(build({ "sw.js": worker.replace("'install'", "'activate'") }, { minify: true }).version,
    build({}, { minify: true }).version);
} else {
  console.log("ESBUILD_BINARY unset: actual minification check skipped (compact marker syntax checked)");
}
console.log(`${project}: build-derived worker cache regression passed`);

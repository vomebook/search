import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const loadResources = root => require(path.join(root, "static/reader-resources.js"));
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (items, value, index, all) =>
        value.startsWith("--")
          ? [...items, [value.slice(2), !all[index + 1] || all[index + 1].startsWith("--") ? true : all[index + 1]]]
          : items,
      []
    )
);
// The manual cross gate loads both inventories from the supplied roots, not cwd.
const resources = isMain && args.cross ? undefined : loadResources(process.cwd());
const sourceFiles = inventory => ["reader.html", ...inventory.readerFiles];
const sourceRequired = resources ? sourceFiles(resources) : [];
const required = sourceRequired;
const bundleOnly = new Set(resources?.bundleOnlyFiles);
// Source smoke assertions, not a substitute for runtime behavior tests.
const behavioral = [
  /\bVoiceOfMLReaderRuntime\s*\.\s*createReaderRuntime\s*\(/,
  /\bVoiceOfMLReaderAdapters\s*\.\s*createAdapterRegistry\s*\(/,
  /\bformatAdapters\s*\.\s*register\s*\(\s*mode\s*,/,
  /\bformatAdapters\s*\.\s*activate\s*\(\s*capability\s*\.\s*mode\s*\)/,
  /\bdisableStream\s*:\s*(?:true|false)\b/,
  /\bnextReaderGeneration\s*\(\s*["']navigation["']\s*\)/
];
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function staticRoot(root, artifact) {
  if (!artifact) return path.join(root, "static");
  return fs.existsSync(path.join(artifact, "static")) ? path.join(artifact, "static") : artifact;
}

function checkBehavior(root, inventory = resources) {
  const files = sourceFiles(inventory);
  const reader = ["reader.js", ...inventory.readerComponentFiles].map(file =>
    fs.readFileSync(path.join(root, "static", file), "utf8")).join("\n").replace(/\breaderContext\./g, "");
  for (const [, dependency] of reader.matchAll(/(?:\/static\/)([^"'\s]+\.(?:js|mjs))/g)) {
    assert(
      files.includes(dependency),
      `Reader dependency missing from inventory: ${dependency}`
    );
  }
  for (const marker of behavioral) {
    assert(marker.test(reader), `missing Reader source behavior in ${root}: ${marker}`);
  }
}

export function checkRuffleAssets(output) {
  const expected = {
    "ruffle.js": "26036a94567088dfb3de88a759e8ed10a4cea07b29500af36f345eef42420098",
    "core.ruffle.16d61072ac7fdc4d5013.js": "d27c6bdce2a34afb32e8dfa40970bc7e86cbcb912f92db7eb3e1ac70e943bd82",
    "core.ruffle.994eeef0a471a88cd0e3.js": "d89e507ee60d550629e9229aa1e4dd4f9e75ec7db271e0135cbc87dab042ea51",
    "172de42e6619eac8f371.wasm": "1ed33b9b71a6b01b9aafafed660be343ffeb2d246c5d79e6425a32bf93e38207",
    "878d548199cddef07035.wasm": "af9b6a13a8f5e8d305bc3ce28a4edf3f6242df1183e8576ad4ca086e9f21eaea",
    "LICENSE_APACHE": "62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a",
    "LICENSE_MIT": "4de9338a7879c68e911742a7d691f0797ff1ef8d8a6fb978b0c711e258fe959c"
  };
  assert(JSON.stringify(Object.keys(expected)) === JSON.stringify(resources.ruffleArchive.files), "Ruffle inventory mismatch");
  for (const [file, digest] of Object.entries(expected)) {
    const target = path.join(output, resources.ruffleArchive.directory, file);
    assert(fs.existsSync(target) && fs.statSync(target).isFile() && hash(target) === digest,
      `Ruffle asset missing or integrity mismatch: ${target}`);
  }
}

function checkAssets(output, hashed = false) {
  checkRuffleAssets(output);
  const djvuFiles = {
    "release-06c82c74447d-03087b1edf0c/scalar/djvu_rs.js": "f22b6f8af4d4da24770fc27a3b1ffa6681bcb8479081729d8bd1bca816d9fee4",
    "release-06c82c74447d-03087b1edf0c/scalar/djvu_rs_bg.wasm": "06c82c74447df20b4135312b50cbdef750f32095d790777e7f6fe439a1885b1e",
    "release-06c82c74447d-03087b1edf0c/scalar/djvu_rs.d.ts": "6ad2d946725c97a56e52d0d6f011161ca37410f44c8374937ad995e4506b613c",
    "release-06c82c74447d-03087b1edf0c/scalar/djvu_rs_bg.wasm.d.ts": "34d68557ba2c4a51c091439575279a6f9b7faee4451f5bdaa8bd6516eea69c4f",
    "release-06c82c74447d-03087b1edf0c/simd128/djvu_rs.js": "f22b6f8af4d4da24770fc27a3b1ffa6681bcb8479081729d8bd1bca816d9fee4",
    "release-06c82c74447d-03087b1edf0c/simd128/djvu_rs_bg.wasm": "03087b1edf0c3f61dc0e1f4b7284a87a1b6e7335d735afbec226b3b1e6e16c29",
    "release-06c82c74447d-03087b1edf0c/simd128/djvu_rs.d.ts": "6ad2d946725c97a56e52d0d6f011161ca37410f44c8374937ad995e4506b613c",
    "release-06c82c74447d-03087b1edf0c/simd128/djvu_rs_bg.wasm.d.ts": "34d68557ba2c4a51c091439575279a6f9b7faee4451f5bdaa8bd6516eea69c4f",
    "range-source-v0.46.0.zip": "8bbe1d43f04b83c1409e93724009592232e0c5389d8dc37aaa5432b53a1718a8",
    "THIRD_PARTY_NOTICES-v0.46.0.txt": "02e8a6fc5b0deb56fccf670137cefb20882b98db505b47420aebe8ae31f87444",
    "LICENSE.txt": "9b634d974fb7ccacccc877fa6b36016eb48884b09732485d7ad92b6294699163",
  };
  for (const [file, digest] of Object.entries(djvuFiles))
    assert(hash(path.join(output, "vendor/djvu-rs-reader", file)) === digest, `DjVu decoder integrity mismatch: ${file}`);
  assert(fs.statSync(path.join(output, "vendor/djvu-rs-reader/NOTICE.txt")).isFile(), "missing DjVu decoder notice");
  for (const vendor of Object.values(resources.vendors)) {
    assert(
      hash(path.join(output, vendor.path)) === vendor.sha256,
      `vendor integrity mismatch: ${vendor.path}`
    );
  }
  const files = new Set([...required, "app.js"].filter(file => !hashed || !bundleOnly.has(file))
    .map(file => hashed ? currentAsset(output, file) : file));
  for (const file of files) {
    const target = path.join(output, file);
    assert(fs.existsSync(target) && fs.statSync(target).isFile(), `missing Reader asset: ${file}`);
    const shortHash = path.basename(file).match(/\.([0-9a-f]{12})\.(?:js|mjs|css)$/)?.[1];
    if (shortHash) {
      assert(hash(target).startsWith(shortHash), `Reader asset hash mismatch: ${file}`);
    }
    // Vendor internals may contain optional paths; inspect our references to them only.
    if (file.split(path.sep).includes("vendor")) continue;
    const content = fs.readFileSync(target, "utf8");
    const refs = content.matchAll(/(["'])((?:\/(?:search\/)?static\/|\.\.?\/)[^"'\s]+)\1/g);
    for (const [, , url] of refs) {
      const ref = url.split(/[?#]/)[0];
      if (!ref.startsWith("/") && !/\.(?:js|mjs|css|html)$/.test(ref)) continue;
      const relative = ref.startsWith("/")
        ? ref.replace(/^\/(?:search\/)?static\//, "")
        : path.join(path.dirname(file), ref);
      const resolved = path.resolve(output, relative);
      assert(
        resolved.startsWith(`${path.resolve(output)}${path.sep}`),
        `invalid Reader asset: ${url}`
      );
      assert(fs.existsSync(resolved), `unresolved Reader reference in ${file}: ${url}`);
      if (ref.endsWith("/")) {
        assert(
          fs.statSync(resolved).isDirectory() && fs.readdirSync(resolved).length > 0,
          `empty or invalid Reader asset directory: ${url}`
        );
      } else {
        if (hashed && resources.buildFiles("github").includes(relative)) {
          throw new Error(`unversioned build dependency in ${file}: ${url}`);
        }
        files.add(relative);
      }
    }
  }
  for (const directory of ["vendor/cmaps", "vendor/standard_fonts", "vendor/wasm"]) {
    const target = path.join(output, directory);
    assert(
      fs.existsSync(target) &&
        fs.statSync(target).isDirectory() &&
        fs.readdirSync(target).length > 0,
      `missing or empty Reader vendor directory: ${directory}`
    );
  }
}

function currentAsset(output, filename) {
  if (!resources.buildFiles("github").includes(filename)) return filename;
  assert(!fs.existsSync(path.join(output, filename)), `obsolete asset alias: ${filename}`);
  const directory = path.dirname(filename), basename = path.basename(filename);
  const extension = path.extname(basename), stem = basename.slice(0, -extension.length);
  const matches = fs.readdirSync(path.join(output, directory)).filter(file => file.startsWith(stem + ".") &&
    file.endsWith(extension) && /^[0-9a-f]{12}$/.test(file.slice(stem.length + 1, -extension.length)));
  assert(matches.length === 1, `expected one current asset: ${filename}`);
  return path.join(directory, matches[0]);
}

// The app must warm the entire current Reader shell, not just have a valid
// content-addressed filename (even an empty file has a valid SHA-256).
export function assertReaderShellWarmed(app, project, current = file => file) {
  const staticBase = project === "github" ? "/search/static/" : "/static/";
  const shellAssets = resources.shellAssets(staticBase).map(url =>
    staticBase + current(url.slice(staticBase.length)).split(path.sep).join("/"));
  assert(app.includes(JSON.stringify(shellAssets)), "missing versioned Reader shell warming inventory");
}

function checkProject(root, artifact) {
  const source = path.join(root, "static");
  for (const file of sourceRequired) {
    const target = path.join(source, file);
    assert(
      fs.existsSync(target) && fs.statSync(target).isFile(),
      `missing source Reader file: ${file}`
    );
  }
  checkBehavior(root);
  const output = staticRoot(root, artifact);
  checkAssets(output, !!artifact);
  if (artifact) {
    assert(!fs.existsSync(path.join(output, "foliate-reader")), "obsolete Foliate runtime in release");
    const project = args.project || (fs.existsSync(path.join(root, "Dockerfile")) ? "hf" : "github");
    for (const file of resources.releaseFiles(project)) currentAsset(output, file);
    for (const file of bundleOnly) {
      const target = path.join(output, file), directory = path.dirname(target);
      const extension = path.extname(target), stem = path.basename(target, extension) + ".";
      assert(!fs.existsSync(directory) || !fs.readdirSync(directory).some(name =>
        name === path.basename(target) || (name.startsWith(stem) && name.endsWith(extension) &&
          /^[0-9a-f]{12}$/.test(name.slice(stem.length, -extension.length)))),
      `bundled script published separately: ${file}`);
    }
    const readerEntry = currentAsset(output, "reader.js");
    const readerBundle = fs.readFileSync(path.join(output, readerEntry), "utf8");
    const readerShell = fs.readFileSync(path.join(output, "reader.html"), "utf8");
    const staticBase = project === "github" ? "/search/static/" : "/static/";
    // Check just the relative imports emitted by the pinned compiler. The
    // bundle also has root-absolute classic bootstrap dependencies with their
    // own loading contract; do not add new hints for those side effects.
    const entryImports = [...readerBundle.matchAll(/\b(?:from|import)[ \t]*"\.\/([^"\s]+\.(?:js|mjs))"/g)]
      .map(match => match[1]);
    const visibleShell = readerShell.replace(/<!--[\s\S]*?-->/g, "");
    const preload = [...visibleShell.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*>/gi)].map(([tag]) => {
      assert(!/\bcrossorigin\b/i.test(tag), "Reader modulepreload must use the module's default credentials mode");
      return tag.match(/\bhref=(["'])([^"']+)\1/i)?.[2];
    });
    const expectedPreload = new Set([readerEntry, ...entryImports].map(file => staticBase + file));
    assert(entryImports.length > 0 && preload.length === expectedPreload.size &&
      new Set(preload).size === preload.length && preload.every(url => expectedPreload.has(url)),
      "Reader shell must preload exactly the hashed entry and its relative static imports");
    const shellPath = fs.existsSync(path.join(output, "index.html"))
      ? path.join(output, "index.html") : path.join(output, "../index.html");
    const shell = fs.readFileSync(shellPath, "utf8");
    const scripts = [...shell.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
    assert(scripts.length === 1 && /\/app\.[0-9a-f]{12}\.js$/.test(scripts[0]),
      "search shell must load one hashed app bundle");
    const app = fs.readFileSync(path.join(output, currentAsset(output, "app.js")), "utf8");
    assertReaderShellWarmed(app, project, file => currentAsset(output, file));
    const swPath = fs.existsSync(path.join(output, "sw.js"))
      ? path.join(output, "sw.js")
      : path.join(output, "../sw.js");
    const sw = fs.readFileSync(swPath, "utf8");
    const precache = JSON.parse(sw.match(/\bREADER_SHELL_ASSETS\s*=\s*(\[[^\]]*\])/)?.[1] || "[]");
    const verifyPrecachedModule = (file, visited) => {
      if (visited.has(file)) return;
      visited.add(file);
      assert(precache.includes(staticBase + file), `Reader boot module is not precached: ${file}`);
      const text = fs.readFileSync(path.join(output, file), "utf8");
      for (const [, dep] of text.matchAll(/\b(?:from|import)[ \t]*"((?:\.\.?\/|\/(?:search\/)?static\/)[^"\s]+\.(?:js|mjs))"/g)) {
        const target = new URL(dep, "https://reader.invalid" + staticBase + file);
        assert(target.origin === "https://reader.invalid" && target.pathname.startsWith(staticBase),
          `Reader boot dependency escaped the local static graph: ${dep}`);
        verifyPrecachedModule(target.pathname.slice(staticBase.length), visited);
      }
    };
    verifyPrecachedModule(readerEntry, new Set());
    assert(
      !/VoiceOfMLReaderResources\.(?:shellAssets|engineAssets)\(/.test(app),
      "unexpanded Reader warming inventory"
    );
    assert(
      !/VoiceOfMLReaderResources\.runtimePaths\(/.test(sw),
      "unexpanded Reader cache inventory"
    );
  }
  const manifest = sourceRequired.map(file => `${file}:${hash(path.join(source, file))}`).join("\n");
  return crypto.createHash("sha256").update(manifest).digest("hex");
}

const pagesHostFiles = [
  "search/reader-assets/infrastructure/scheduling.js",
  "search/corpus/application/client.js"
];
const pagesWorkerFiles = [
  "search/worker/domain/text.js",
  "search/worker/domain/intersection.js",
  "search/index-worker.js"
];

// Existing site adapters and type differences; their behavior is covered by
// the per-site gates. New differences in shared host files still fail closed.
const siteVariants = new Set([
  "reader/core/reader-security.js", // HF validates the image-page proxy manifest.
  "search/bootstrap/application/controller.js",
  "search/catalog/application/client.js", "search/catalog/domain/record-path.js",
  "search/discovery/application/random.js",
  "search/downloads/application/batch.js", "search/downloads/application/controller.js",
  "search/downloads/presentation/queue.js",
  "search/execution/application/controller.js", "search/execution/domain/policy.js",
  "search/positions/application/persistence.js", "search/positions/application/restoration.js",
  "search/positions/domain/policy.js", "search/positions/domain/view-key.js",
  "search/reader-assets/application/snapshot.js", "search/reader-assets/infrastructure/sidecar.js",
  "search/reader-host/application/host.js", "search/reader-host/application/navigation.js",
  "search/requests/application/prefetch-controller.js", "search/requests/application/response-store.js",
  "search/requests/infrastructure/shared-transport.js",
  "search/results/application/interactions.js", "search/results/presentation/row.js",
  "search/results/virtual/application/controller.js", "search/results/virtual/presentation/rows.js",
  "search/results/window/application/page-loader.js", "search/results/window/domain/page.js",
  "search/results/window/presentation/status.js",
  "search/routing/application/router.js", "search/routing/domain/route.js",
  "search/sidebar/application/directory.js", "search/sidebar/application/filters.js",
  "search/sidebar/presentation/directory.js", "search/sidebar/presentation/markup.js"
]);

const equal = (actual, expected, message) => assert(isDeepStrictEqual(actual, expected), message);

function checkSiteInventory(github, hf) {
  const without = (files, removed) => files.filter(file => !removed.includes(file));
  const expectOnly = (files, only, message) => equal(files.filter(file => only.includes(file)).sort(),
    [...only].sort(), message);

  expectOnly(github.searchHostFiles, pagesHostFiles, "Pages-only app host inventory mismatch");
  equal(hf.searchHostFiles, without(github.searchHostFiles, pagesHostFiles), "cross-project drift: app host order or membership");
  equal(hf.bundleOnlyFiles, without(github.bundleOnlyFiles, pagesHostFiles), "cross-project drift: bundle-only inventory");
  for (const key of ["readerFiles", "readerComponentFiles", "vendors", "pdfArchive", "ruffleArchive"]) {
    equal(hf[key], github[key], `cross-project drift: Reader resources ${key}`);
  }
  const resourceApi = (inventory, base) => ({
    runtime: inventory.runtimePaths(base), shell: inventory.shellAssets(base),
    ruffle: inventory.ruffleAssets(base), pdfSupport: inventory.pdfSupportAssets(base),
    djvu: inventory.djvuDecoderAssets(base), selectedDjvu: inventory.djvuSelectedAssets(base),
    simd: inventory.djvuSupportsSIMD(),
    vendorUrls: Object.keys(inventory.vendors).map(name => inventory.vendorUrl(name, base)),
    engines: ["pdf", "djvu", "djv", "md", "markdown", "html", "htm", "txt"].map(ext => inventory.engineAssets(ext, base)),
    customPdfWorker: inventory.engineAssets("pdf", base, base + "custom-wrapper.mjs"),
    bundle: inventory.bundleArguments("reader.js"), appBundle: inventory.bundleArguments("app.js")
  });
  for (const base of ["/search/static/", "/static/"]) {
    equal(resourceApi(hf, base), resourceApi(github, base), `cross-project drift: Reader resource API (${base})`);
  }

  const githubBuild = github.buildFiles("github");
  const githubRelease = github.releaseFiles("github");
  expectOnly(githubBuild, pagesWorkerFiles, "Pages-only Worker build inventory mismatch");
  expectOnly(githubRelease, pagesWorkerFiles, "Pages-only Worker release inventory mismatch");
  assert(pagesWorkerFiles.every(file => !github.searchHostFiles.includes(file)), "Pages Worker must stay outside the app bundle");
  equal(hf.buildFiles("hf"), without(githubBuild, [...pagesHostFiles, ...pagesWorkerFiles]),
    "cross-project drift: build inventory outside Pages-only assets");
  equal(hf.releaseFiles("hf"), without(githubRelease, pagesWorkerFiles),
    "cross-project drift: release inventory outside Pages-only Worker assets");
}

async function checkCompose(root, inventory, base) {
  const cwd = process.cwd();
  let compose;
  // The composer resolves its resources relative to cwd. Import each site's
  // module separately without running the CLI or writing build output.
  try {
    process.chdir(root);
    compose = await import(pathToFileURL(path.join(root, "scripts/build/compose_app.mjs")).href);
  } finally {
    process.chdir(cwd);
  }
  const dependencies = ["reader-resources.js", "reader/core/reader-contract.js", ...inventory.searchHostFiles];
  equal(compose.APP_DEPENDENCIES, dependencies, `app composition inventory mismatch: ${root}`);
  const script = file => `<script src="${base}${file}"></script>`;
  const retained = [...pagesWorkerFiles, "app.js"].map(script).join("");
  equal(compose.stripBundledScripts(dependencies.map(script).join("") + retained), retained,
    `app composition script stripping mismatch: ${root}`);

}

async function crossCheck(githubRoot, hfRoot) {
  assert(fs.realpathSync(githubRoot) !== fs.realpathSync(hfRoot), "cross gate requires two different project roots");
  const github = loadResources(githubRoot), hf = loadResources(hfRoot);
  checkSiteInventory(github, hf);
  for (const file of [...pagesHostFiles, ...pagesWorkerFiles]) {
    const target = path.join(githubRoot, "static", file);
    assert(fs.existsSync(target) && fs.statSync(target).isFile(), `missing Pages-only source asset: ${file}`);
    assert(!fs.existsSync(path.join(hfRoot, "static", file)), `unexpected Pages-only source asset in HF: ${file}`);
  }
  await checkCompose(githubRoot, github, "/search/static/");
  await checkCompose(hfRoot, hf, "/static/");
  const exact = [
    "reader/core/reader-store.js",
    "reader/pdf/reader-pdf-text.js",
    "reader/pdf/reader-pdf-range-cache.mjs",
    "reader/pdf/reader-pdf-range-hints.mjs",
    "reader/pdf/reader-pdf-text-store.mjs",
    "reader/search/reader-chapter-search-core.mjs",
    "reader/search/reader-chapter-search-proxy-url.mjs",
    "reader/search/reader-chapter-search-index.mjs",
    "reader/search/reader-pdf-search-stream.mjs",
    "reader/search/reader-pdf-search-decode.mjs",
    "reader/search/reader-pdf-partition-shape.mjs",
    "reader/search/reader-pdf-partition-config.mjs",
    "reader/search/reader-pdf-partition-policy.mjs",
    "reader/search/reader-pdf-partition-page.mjs",
    "reader/search/reader-pdf-partition-requests.mjs",
    "reader/search/reader-pdf-book-compact.mjs",
    "reader/search/reader-pdf-book-validate.mjs",
    "reader/search/workers/reader-pdf-book-search-worker.mjs",
    "reader/search/reader-pdf-book-search.mjs",
    "reader.css",
    "reader/core/reader-request-manager.js",
    "reader/formats/reader-chapter-repository.js",
    "reader/ui/reader-scroll-anchor.js",
    "reader/formats/reader-section-virtualizer.js",
    "reader/core/reader-runtime.js",
    "reader/formats/reader-format-adapters.js",
    "reader/pdf/reader-v3.mjs", "reader/pdf/reader-djvu-engine-worker.mjs", "reader/pdf/reader-djvu-worker.mjs", "reader/pdf/reader-djvu-scheduler.mjs",
    "reader/pdf/reader-djvu-adapter.mjs", "reader/pdf/reader-djvu-identity.mjs",
    "vendor/djvu-rs-reader/LICENSE.txt", "vendor/djvu-rs-reader/NOTICE.txt",
    "vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/scalar/djvu_rs.js",
    "vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/scalar/djvu_rs_bg.wasm",
    "vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/scalar/djvu_rs.d.ts",
    "vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/scalar/djvu_rs_bg.wasm.d.ts",
    "vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/simd128/djvu_rs.js",
    "vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/simd128/djvu_rs_bg.wasm",
    "vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/simd128/djvu_rs.d.ts",
    "vendor/djvu-rs-reader/release-06c82c74447d-03087b1edf0c/simd128/djvu_rs_bg.wasm.d.ts",
    "vendor/djvu-rs-reader/range-source-v0.46.0.zip",
    "vendor/djvu-rs-reader/THIRD_PARTY_NOTICES-v0.46.0.txt",
    "reader/search/reader-search-controller.mjs",
    "reader/search/reader-dom-search.mjs",
    "reader/formats/reader-image-loader.mjs",
    "reader/reader-components.mjs",
    "reader/ui/reader-document-styles.mjs",
    "reader/core/reader-diagnostics.mjs", "reader/core/reader-lifecycle.mjs", "reader/ui/reader-bookmarks.mjs",
    "reader/formats/reader-media-format.mjs", "reader/core/reader-document-loader.mjs", "reader/formats/reader-html-format.mjs",
    "reader/formats/reader-text-format.mjs",
    "reader/pdf/pdf-worker-wrapper.mjs", "reader/pdf/pdf-first-page-worker-adapter.mjs",
    "reader/ui/reader-speech.mjs", "tts-client.js"
  ];
  const chapterFormat = "reader/formats/reader-chapter-format.mjs";
  const chapterSource = root => fs.readFileSync(path.join(root, "static", chapterFormat), "utf8");
  const exportedHelper = "export function chapterOptionalText(value) {";
  const githubChapter = chapterSource(githubRoot), hfChapter = chapterSource(hfRoot);
  assert(!githubChapter.includes(exportedHelper) && hfChapter.includes(exportedHelper), "HF-only chapter helper export mismatch");
  equal(githubChapter, hfChapter.replace(exportedHelper, "function chapterOptionalText(value) {"),
    `cross-project drift: ${chapterFormat}`);

  const files = new Set([
    ...[...exact, ...hf.searchHostFiles.filter(file => !siteVariants.has(file))].map(file => `static/${file}`),
    "scripts/build/copy_reader_vendor.mjs",
    "scripts/build/check_reader_release.mjs",
    "tests/support/reader-contract-vectors.json"
  ]);
  for (const file of files) {
    assert(hash(path.join(githubRoot, file)) === hash(path.join(hfRoot, file)), `cross-project drift: ${file}`);
  }
  for (const file of siteVariants) {
    for (const root of [githubRoot, hfRoot]) {
      assert(fs.statSync(path.join(root, "static", file)).isFile(), `missing site variant: ${root}/static/${file}`);
    }
  }
  checkBehavior(githubRoot, github);
  checkBehavior(hfRoot, hf);
}

if (isMain) try {
  if (args.cross) {
    assert(typeof args["github-root"] === "string" && typeof args["hf-root"] === "string",
      "--cross requires --github-root and --hf-root");
    await crossCheck(path.resolve(args["github-root"]), path.resolve(args["hf-root"]));
    console.log("reader cross-project release gate ok");
  } else {
    const root = path.resolve(args.root || ".");
    const identity = checkProject(
      root,
      args["artifact-root"] ? path.resolve(args["artifact-root"]) : null
    );
    console.log(`reader release gate ok ${identity}`);
  }
} catch (error) {
  console.error(`reader release gate failed: ${error.message}`);
  process.exitCode = 1;
}

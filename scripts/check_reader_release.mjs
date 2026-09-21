import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const resources = createRequire(import.meta.url)(
  path.join(process.cwd(), "static/reader-resources.js")
);

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (items, value, index, all) =>
        value.startsWith("--")
          ? [...items, [value.slice(2), all[index + 1]?.startsWith("--") ? true : all[index + 1]]]
          : items,
      []
    )
);
const required = ["reader.html", ...resources.readerFiles, "foliate-reader/view.js"];
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

function checkBehavior(root) {
  const reader = fs.readFileSync(path.join(root, "static/reader.js"), "utf8");
  for (const [, dependency] of reader.matchAll(/(?:\/static\/)([^/"']+\.(?:js|mjs))/g)) {
    assert(
      resources.readerFiles.includes(dependency),
      `Reader dependency missing from inventory: ${dependency}`
    );
  }
  for (const marker of behavioral) {
    assert(marker.test(reader), `missing Reader source behavior in ${root}: ${marker}`);
  }
}

function checkAssets(output, hashed = false) {
  for (const vendor of Object.values(resources.vendors)) {
    assert(
      hash(path.join(output, vendor.path)) === vendor.sha256,
      `vendor integrity mismatch: ${vendor.path}`
    );
  }
  const files = new Set([...required, "app.js"].map(file => hashed ? currentAsset(output, file) : file));
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
  const extension = path.extname(filename), stem = filename.slice(0, -extension.length);
  const matches = fs.readdirSync(output).filter(file => file.startsWith(stem + ".") &&
    file.endsWith(extension) && /^[0-9a-f]{12}$/.test(file.slice(stem.length + 1, -extension.length)));
  assert(matches.length === 1, `expected one current asset: ${filename}`);
  return matches[0];
}

function checkProject(root, artifact) {
  const source = path.join(root, "static");
  for (const file of required) {
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
    const project = fs.existsSync(path.join(root, "index.html")) ? "github" : "hf";
    for (const file of resources.buildFiles(project)) currentAsset(output, file);
    const shellPath = fs.existsSync(path.join(output, "index.html"))
      ? path.join(output, "index.html") : path.join(output, "../index.html");
    const shell = fs.readFileSync(shellPath, "utf8");
    const scripts = [...shell.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
    assert(scripts.length === 1 && /\/app\.[0-9a-f]{12}\.js$/.test(scripts[0]),
      "search shell must load one hashed app bundle");
    const app = fs.readFileSync(path.join(output, currentAsset(output, "app.js")), "utf8");
    const swPath = fs.existsSync(path.join(output, "sw.js"))
      ? path.join(output, "sw.js")
      : path.join(output, "../sw.js");
    const sw = fs.readFileSync(swPath, "utf8");
    assert(
      !/VoiceOfMLReaderResources\.(?:shellAssets|engineAssets)\(/.test(app),
      "unexpanded Reader warming inventory"
    );
    assert(
      !/VoiceOfMLReaderResources\.runtimePaths\(/.test(sw),
      "unexpanded Reader cache inventory"
    );
  }
  const manifest = required.map((file) => `${file}:${hash(path.join(source, file))}`).join("\n");
  return crypto.createHash("sha256").update(manifest).digest("hex");
}

function crossCheck(githubRoot, hfRoot) {
  const exact = [
    "reader-resources.js",
    "reader-store.js",
    "reader-pdf-text.js",
    "search-session.js",
    "download-controller.js",
    "reader-navigation.js",
    "reader.css",
    "reader-request-manager.js",
    "reader-chapter-repository.js",
    "reader-scroll-anchor.js",
    "reader-section-virtualizer.js",
    "reader-runtime.js",
    "reader-format-adapters.js",
    "reader-security.js",
    "pdf-worker-wrapper.mjs"
  ];
  for (const file of exact) {
    assert(
      hash(path.join(githubRoot, "static", file)) === hash(path.join(hfRoot, "static", file)),
      `cross-project drift: ${file}`
    );
  }
  for (const file of ["compose_app.mjs", "copy_reader_vendor.mjs", "check_reader_release.mjs"]) {
    assert(
      hash(path.join(githubRoot, "scripts", file)) === hash(path.join(hfRoot, "scripts", file)),
      `cross-project drift: scripts/${file}`
    );
  }
  for (const root of [githubRoot, hfRoot]) checkBehavior(root);
  const vectors = "tests/reader-contract-vectors.json";
  if (fs.existsSync(path.join(githubRoot, vectors)) && fs.existsSync(path.join(hfRoot, vectors))) {
    assert(
      hash(path.join(githubRoot, vectors)) === hash(path.join(hfRoot, vectors)),
      "cross-project drift: Reader contract vectors"
    );
  }
}

try {
  if (args.cross) {
    crossCheck(path.resolve(args["github-root"]), path.resolve(args["hf-root"]));
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

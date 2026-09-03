import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).reduce((items, value, index, all) => value.startsWith("--") ? [...items, [value.slice(2), all[index + 1]?.startsWith("--") ? true : all[index + 1]]] : items, []));
const required = ["reader.html", "reader.css", "reader.js", "reader-contract.js", "reader-store.js", "reader-request-manager.js", "reader-chapter-repository.js", "reader-scroll-anchor.js", "reader-section-virtualizer.js", "reader-runtime.js", "reader-format-adapters.js", "pdf-worker-wrapper.mjs", "foliate-reader/view.js"];
const behavioral = ["createReaderRuntime", "createAdapterRegistry", "registerReaderFormatAdapters", "formatAdapters.activate(capability.mode)", "disableStream: true", "nextReaderGeneration(\"navigation\")"];
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const normalized = (file) => fs.readFileSync(file, "utf8").replaceAll("/search/static/", "/static/").replace(/\s+/g, "");
function assert(condition, message) { if (!condition) throw new Error(message); }
function staticRoot(root, artifact) { if (!artifact) return path.join(root, "static"); return fs.existsSync(path.join(artifact, "static")) ? path.join(artifact, "static") : artifact; }
function checkProject(root, artifact) {
  const source = path.join(root, "static"), output = staticRoot(root, artifact);
  for (const file of required) { assert(fs.existsSync(path.join(source, file)), `missing source Reader file: ${file}`); assert(fs.existsSync(path.join(output, file)), `missing built Reader file: ${file}`); }
  const reader = fs.readFileSync(path.join(source, "reader.js"), "utf8");
  for (const marker of behavioral) assert(reader.includes(marker), `missing Reader behavior: ${marker}`);
  const localRefs = [...reader.matchAll(/(?:import\s*)?["'](?:\/search)?\/static\/([^"']+)["']/g)].map((match) => match[1].split("?")[0]);
  for (const ref of localRefs) assert(fs.existsSync(path.join(output, ref)), `unresolved Reader import: ${ref}`);
  const vendorRefs = [...reader.matchAll(/vendor\/([a-z0-9.-]+\.([0-9a-f]{12})\.(?:js|mjs))/g)];
  for (const [, file, shortHash] of vendorRefs) { const target = path.join(output, "vendor", file); assert(fs.existsSync(target), `missing Reader vendor: ${file}`); assert(hash(target).startsWith(shortHash), `Reader vendor hash mismatch: ${file}`); }
  for (const directory of ["vendor/cmaps", "vendor/standard_fonts", "vendor/wasm"]) assert(fs.existsSync(path.join(output, directory)), `missing Reader vendor directory: ${directory}`);
  const manifest = required.map((file) => `${file}:${hash(path.join(source, file))}`).join("\n");
  return crypto.createHash("sha256").update(manifest).digest("hex");
}
function crossCheck(githubRoot, hfRoot) {
  const exact = ["reader-request-manager.js", "reader-chapter-repository.js", "reader-scroll-anchor.js", "reader-section-virtualizer.js", "pdf-worker-wrapper.mjs"];
  for (const file of exact) assert(hash(path.join(githubRoot, "static", file)) === hash(path.join(hfRoot, "static", file)), `cross-project drift: ${file}`);
  for (const file of ["reader-runtime.js", "reader-format-adapters.js"]) assert(normalized(path.join(githubRoot, "static", file)) === normalized(path.join(hfRoot, "static", file)), `cross-project runtime drift: ${file}`);
  for (const marker of behavioral) for (const root of [githubRoot, hfRoot]) assert(fs.readFileSync(path.join(root, "static/reader.js"), "utf8").includes(marker), `cross-project behavior missing: ${marker}`);
}
try {
  if (args.cross) crossCheck(path.resolve(args["github-root"]), path.resolve(args["hf-root"]));
  else { const root = path.resolve(args.root || "."), identity = checkProject(root, args["artifact-root"] ? path.resolve(args["artifact-root"]) : null); console.log(`reader release gate ok ${identity}`); }
} catch (error) { console.error(`reader release gate failed: ${error.message}`); process.exitCode = 1; }

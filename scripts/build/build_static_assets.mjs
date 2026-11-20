import { createHash } from "node:crypto";
import { existsSync, readdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { stripBundledPrecache, stripBundledScripts } from "./compose_app.mjs";
const resources = createRequire(import.meta.url)(join(process.cwd(), "static/reader-resources.js"));

const root = process.env.STATIC_OUTPUT_DIR || "_site";
const replacements = new Map();
const currentVendorAssets = new Set(Object.values(resources.vendors).map(vendor => "/search/static/" + vendor.path));
const rewrite = (text, filename) => {
  text = text.replace(/(["'])(\.\.?\/[^"'\s]+)\1/g, (match, quote, url) => {
    const target = join(dirname(filename), url);
    const versioned = replacements.get(`static/${target}`);
    if (!versioned) return match;
    let pinned = relative(dirname(filename), versioned.slice("static/".length));
    if (!pinned.startsWith(".")) pinned = "./" + pinned;
    return quote + pinned + quote;
  });
  text = text.replace(/VoiceOfMLReaderResources\.engineAssets\(([\w$]+),\s*"(\/search\/static\/)"\)/g,
    // DjVu selection belongs to the browser, never the build host. Its vendor
    // URLs are release-pinned; the other formats still need graph hash rewrites.
    (_, extension, base) => `(["djvu","djv"].includes(${extension})?VoiceOfMLReaderResources.djvuSelectedAssets(${JSON.stringify(base)}):` + JSON.stringify(Object.fromEntries(["pdf", "md", "markdown", "html", "htm"].map(ext => [ext, resources.engineAssets(ext, base)]))) + `[${extension}]||[])`);
  text = text.replace(/(?:VoiceOfMLReaderResources|readerPrecacheResources)\.(shellAssets|runtimePaths)\("(\/search\/static\/)"\)/g,
    (_, method, base) => JSON.stringify(resources[method](base)));
  for (const [original, versioned] of replacements) text = text.split(original).join(versioned);
  return text;
};
// Dependencies precede their consumers so a build pins the entire app/Worker
// pair and Reader module graph. Publish only the current content-addressed files.
for (const filename of resources.buildFiles("github")) {
  const source = join(root, "static", filename);
  const content = rewrite(readFileSync(source, "utf8"), filename);
  for (const match of content.matchAll(/(?:\/(?:search\/)?static\/|\.\/)vendor\/([A-Za-z0-9._-]+\.[0-9a-f]{12}\.(?:js|mjs|css))/g))
    currentVendorAssets.add("/search/static/vendor/" + match[1]);
  writeFileSync(source, content);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  const extension = extname(filename);
  const versioned = `${filename.slice(0, -extension.length)}.${hash}${extension}`;
  renameSync(source, join(root, "static", versioned));
  replacements.set(`static/${filename}`, `static/${versioned}`);
  replacements.set(`./${filename}`, `./${versioned}`);
}
for (const filename of ["index.html", "static/reader.html", "sw.js"]) {
  const target = join(root, filename);
  let content = readFileSync(target, "utf8");
  if (filename === "index.html") content = stripBundledScripts(content);
  if (filename === "sw.js") content = stripBundledPrecache(content, "/search/static/");
  content = rewrite(content, filename === "static/reader.html" ? "reader.html" : filename);
  if (filename === "sw.js") {
    content = content.replace(/CURRENT_HASHED_ASSETS\s*=\s*\[\]/,
      "CURRENT_HASHED_ASSETS=" + JSON.stringify([...replacements.values()].filter(url => url.startsWith("static/")).map(url => "/search/" + url).concat([...currentVendorAssets], resources.djvuDecoderAssets("/search/static/"), resources.ruffleAssets("/search/static/"))));
    content = content.replace(/\bREADER_SHELL_INTEGRITY\s*=\s*(["'])development\1/, () => {
      const digest = createHash("sha256").update(readFileSync(join(root, "static/reader.html"))).digest("base64");
      return `READER_SHELL_INTEGRITY="sha256-${digest}"`;
    });
  }
  writeFileSync(target, content);
}

// Hash the rewritten graph and shells, with the version still a fixed marker
// (including the resulting digest itself would make the hash self-referential).
const workerPath = join(root, "sw.js");
const worker = readFileSync(workerPath, "utf8");
const versionMarker = /\bCACHE_VERSION\s*=\s*(["'])development\1/g;
if ([...worker.matchAll(versionMarker)].length !== 1) {
  throw new Error("sw.js must contain exactly one CACHE_VERSION = 'development' marker");
}
const cacheHash = createHash("sha256");
function hashFile(filename) {
  const content = readFileSync(join(root, filename));
  cacheHash.update(JSON.stringify([filename, content.length]) + "\n").update(content);
}
for (const filename of ["sw.js", "index.html", "static/reader.html"]) hashFile(filename);
// Bootstrap data and icons are not content-addressed. Only use build output;
// HF's corresponding runtime data is not necessarily available during its build.
for (const filename of ["manifest.json", "data/generation-manifest.json", "data/reader_assets.json.gz",
  "data/initial/manifest.json", "data/initial/global.json", "data/sidebar/manifest.json", "data/sidebar/global.json"]) {
  if (existsSync(join(root, filename))) hashFile(filename);
}
function hashIcons(directory) {
  if (!existsSync(join(root, directory))) return;
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const filename = directory + "/" + entry.name;
    if (entry.isDirectory()) hashIcons(filename);
    else if (entry.isFile()) hashFile(filename);
  }
}
hashIcons("icons");
writeFileSync(workerPath, worker.replace(versionMarker, "CACHE_VERSION=" + JSON.stringify(cacheHash.digest("hex"))));

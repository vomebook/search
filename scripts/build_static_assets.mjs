import { createHash } from "node:crypto";
import { renameSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";
import { stripBundledScripts } from "./compose_app.mjs";
const resources = createRequire(import.meta.url)(join(process.cwd(), "static/reader-resources.js"));

const root = process.env.STATIC_OUTPUT_DIR || "_site";
const replacements = new Map();
const currentVendorAssets = new Set(Object.values(resources.vendors).map(vendor => "/search/static/" + vendor.path));
const rewrite = text => {
  text = text.replace(/VoiceOfMLReaderResources\.engineAssets\(([\w$]+),\s*"(\/search\/static\/)",\s*"(\?reader-v1)"\)/g,
    (_, extension, base, suffix) => "(" + JSON.stringify(Object.fromEntries(["pdf", "epub", "mobi", "azw", "azw3", "fb2", "fbz", "docx", "md", "markdown", "html", "htm"].map(ext => [ext, resources.engineAssets(ext, base, suffix)]))) + `[${extension}]||[])`);
  text = text.replace(/VoiceOfMLReaderResources\.(shellAssets|runtimePaths)\("(\/search\/static\/)"\)/g,
    (_, method, base) => JSON.stringify(resources[method](base)));
  for (const [original, versioned] of replacements) text = text.split(original).join(versioned);
  return text;
};
// Dependencies precede their consumers so a build pins the entire app/Worker
// pair and Reader module graph. Publish only the current content-addressed files.
for (const filename of resources.buildFiles("github")) {
  const source = join(root, "static", filename);
  const content = rewrite(readFileSync(source, "utf8"));
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
  content = rewrite(content);
  if (filename === "sw.js") content = content.replace(/CURRENT_HASHED_ASSETS\s*=\s*\[\]/,
    "CURRENT_HASHED_ASSETS=" + JSON.stringify([...replacements.values()].filter(url => url.startsWith("static/")).map(url => "/search/" + url).concat([...currentVendorAssets])));
  writeFileSync(target, content);
}

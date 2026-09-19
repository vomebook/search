import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const root = process.env.STATIC_OUTPUT_DIR || "_site";
const replacements = new Map();
const rewrite = text => {
  for (const [original, versioned] of replacements) text = text.split(original).join(versioned);
  return text;
};
// Dependencies precede their consumers so a build pins the entire app/Worker
// pair and Reader module graph. Unversioned copies support already-open shells.
for (const filename of [
  "index-worker.js", "reader-chapter-search-worker.mjs", "reader-chapter-search.mjs",
  "reader-contract.js", "reader-navigation.js", "reader-store.js",
  "reader-request-manager.js", "reader-chapter-repository.js", "reader-scroll-anchor.js",
  "reader-section-virtualizer.js", "reader-runtime.js", "reader-format-adapters.js",
  "reader-security.js", "reader-pdf-text.js", "pdf-worker-wrapper.mjs", "reader.css", "style.css", "reader.js", "app.js"
]) {
  const source = join(root, "static", filename);
  const content = rewrite(readFileSync(source, "utf8"));
  writeFileSync(source, content);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  const extension = extname(filename);
  const versioned = `${filename.slice(0, -extension.length)}.${hash}${extension}`;
  copyFileSync(source, join(root, "static", versioned));
  replacements.set(`static/${filename}`, `static/${versioned}`);
}
for (const filename of ["index.html", "static/reader.html", "sw.js"]) {
  const target = join(root, filename);
  writeFileSync(target, rewrite(readFileSync(target, "utf8")));
}

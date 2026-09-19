import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
const resources = createRequire(import.meta.url)(join(process.cwd(), "static/reader-resources.js"));

const output = process.argv[2] || "static/vendor";
mkdirSync(output, { recursive: true });
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) {
      response.resume();
      return download(new URL(response.headers.location, url), redirects + 1).then(resolve, reject);
    }
    if (response.statusCode !== 200) {
      response.resume();
      return reject(new Error(`${url}: HTTP ${response.statusCode}`));
    }
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve(Buffer.concat(chunks)));
    response.on("error", reject);
    });
    request.setTimeout(60000, () => request.destroy(new Error(`${url}: request timed out`)));
    request.on("error", reject);
  });
}

async function downloadWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await download(url); }
    catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function main() {
  const pdfArchive = await downloadWithRetry(resources.pdfArchive.url);
const pdfArchiveHash = createHash("sha256").update(pdfArchive).digest("hex");
if (pdfArchiveHash !== resources.pdfArchive.sha256) throw new Error(`pdfjs-dist archive SHA-256 ${pdfArchiveHash} does not match`);
const tar = gunzipSync(pdfArchive);
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512), name = header.subarray(0, 100).toString().replace(/\0.*$/, "");
  if (!name) break;
  const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, "").trim() || "0", 8);
  const relative = name.replace(/^package\//, "");
  if ((relative.startsWith("cmaps/") || relative.startsWith("standard_fonts/") || relative.startsWith("wasm/")) && !relative.endsWith("/")) {
    const target = join(output, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, tar.subarray(offset + 512, offset + 512 + size));
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
for (const {url, file: target, sha256: expected, path} of Object.values(resources.vendors)) {
  const bytes = await downloadWithRetry(url);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`${url}: SHA-256 ${actual} does not match ${expected}`);
  mkdirSync(dirname(join(output, target)), { recursive: true });
  const versioned = path.slice("vendor/".length);
  mkdirSync(dirname(join(output, versioned)), { recursive: true });
  writeFileSync(join(output, versioned), bytes);
}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

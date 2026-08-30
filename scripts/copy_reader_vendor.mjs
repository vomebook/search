import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

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
  const pdfArchive = await downloadWithRetry("https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz");
const pdfArchiveHash = createHash("sha256").update(pdfArchive).digest("hex");
  if (pdfArchiveHash !== "06f25e887adc6489f04c9fcb14198c77e4e5623a59a0bba5c4cea5838a4f1241") throw new Error(`pdfjs-dist archive SHA-256 ${pdfArchiveHash} does not match`);
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
for (const [url, target, expected] of [
  ["https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs", "pdf.min.mjs", "f80490490320511e5df18c580b9edd6b5db8058dceebaf6f161992e0a964b9e2"],
  ["https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs", "pdf.worker.min.mjs", "8ab0e5e30031b4a06ecfddd5ae9562f0227f830ee7ec9ed1a968b134243d2386"],
  ["https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js", "epub.min.js", "06eae15745107b4aa508c95538275251f69bfb9f1175621fc458d9f42ed082d4"],
  ["https://cdn.jsdelivr.net/npm/marked@18.0.11/lib/marked.umd.js", "marked.min.js", "69451c8541c9c1e7a4bf3ffc6f73c4d89633de92bfbe3e484dfe182ef8091f88"],
  ["https://cdn.jsdelivr.net/npm/dompurify@3.4.14/dist/purify.min.js", "purify.min.js", "c2f26ea4fc0d88141c9aa430eb515ac86fce59418ceebd85fa475b87a8d6c3e6"],
  ["https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js", "jszip.min.js", "acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e"],
  ["https://cdn.jsdelivr.net/npm/docx-preview@0.4.0/dist/docx-preview.min.js", "docx-preview.min.js", "051ef503f2677d53159a388b7384e950eda41ea4e47a103e5e36f124d7faea40"],
]) {
  const bytes = await downloadWithRetry(url);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`${url}: SHA-256 ${actual} does not match ${expected}`);
  mkdirSync(dirname(join(output, target)), { recursive: true });
  writeFileSync(join(output, target), bytes);
  const dot = target.lastIndexOf(".");
  const versioned = `${target.slice(0, dot)}.${actual.slice(0, 12)}${target.slice(dot)}`;
  mkdirSync(dirname(join(output, versioned)), { recursive: true });
  writeFileSync(join(output, versioned), bytes);
}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

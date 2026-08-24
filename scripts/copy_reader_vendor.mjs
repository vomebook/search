import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { join } from "node:path";

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
for (const [url, target, expected] of [
  ["https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.min.mjs", "pdf.min.mjs", "e0be3863c23c8af2305b16548febd58e7f8874a460253317d7771cddbc1c0f6d"],
  ["https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.worker.min.mjs", "pdf.worker.min.mjs", "0613f41490dd6aaceed7a93fbbd38c85e6d6aa60474b6588c6e7709cfbe18cb3"],
  ["https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js", "epub.min.js", "06eae15745107b4aa508c95538275251f69bfb9f1175621fc458d9f42ed082d4"],
  ["https://cdn.jsdelivr.net/npm/marked@18.0.10/lib/marked.umd.js", "marked.min.js", "eaccee2fb9fb3b2c09e873a5504da82507850d9e677bd720122ac49e2a03982a"],
  ["https://cdn.jsdelivr.net/npm/dompurify@3.4.14/dist/purify.min.js", "purify.min.js", "c2f26ea4fc0d88141c9aa430eb515ac86fce59418ceebd85fa475b87a8d6c3e6"],
]) {
  const bytes = await downloadWithRetry(url);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`${url}: SHA-256 ${actual} does not match ${expected}`);
  writeFileSync(join(output, target), bytes);
  const dot = target.lastIndexOf(".");
  const versioned = `${target.slice(0, dot)}.${actual.slice(0, 12)}${target.slice(dot)}`;
  writeFileSync(join(output, versioned), bytes);
}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

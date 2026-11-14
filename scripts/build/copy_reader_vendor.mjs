import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Agent, get } from "node:https";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const resources = createRequire(import.meta.url)(join(process.cwd(), "static/reader-resources.js"));

const output = process.argv[2] || "static/vendor";
const foliateOutputArgument = process.argv.indexOf("--foliate-output");
if (foliateOutputArgument >= 0 && !process.argv[foliateOutputArgument + 1])
  throw new Error("--foliate-output requires a directory");
const foliateOutput = foliateOutputArgument >= 0
  ? process.argv[foliateOutputArgument + 1]
  : process.argv.includes("--refresh-foliate")
    ? join(process.cwd(), "static/foliate-reader/vendor") : null;
// proxyEnv is supported by Node 22.21+, 24.5+, and later major versions.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 21) || major === 23 || (major === 24 && minor < 5))
  throw new Error("Node.js 22.21+, 24.5+, or later is required for proxy support");
const agent = new Agent({ proxyEnv: process.env });
// Per attempt, across redirects; allow ample room for the compressed PDF and Ruffle archives.
const DOWNLOAD_DEADLINE_MS = 180000;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
// Pinned PDF.js and Ruffle tars are ~36.3 MiB and ~29.3 MiB respectively.
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
function download(url, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error("Invalid download URL")); }
    if (parsed.protocol !== "https:") return reject(new Error("Download requires HTTPS"));
    const request = get(parsed, { agent, signal }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) {
        response.resume();
        let next;
        try { next = new URL(response.headers.location, parsed); }
        catch { return reject(new Error("Invalid download redirect")); }
        return download(next, signal, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed (HTTP ${response.statusCode})`));
      }
      const length = response.headers["content-length"];
      if (length && /^\d+$/.test(length) && Number(length) > MAX_DOWNLOAD_BYTES) {
        reject(new Error("Download response too large"));
        response.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_DOWNLOAD_BYTES) {
          reject(new Error("Download response too large"));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks, size)));
      response.on("error", () => reject(new Error("Download response failed")));
      response.on("aborted", () => reject(new Error("Download response aborted")));
    });
    request.on("error", () => reject(new Error("Download request failed")));
  });
}

async function downloadWithRetry(url, signal) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    signal.throwIfAborted();
    const deadline = AbortSignal.timeout(DOWNLOAD_DEADLINE_MS);
    try { return await download(url, AbortSignal.any([signal, deadline])); }
    catch (error) {
      signal.throwIfAborted();
      lastError = deadline.aborted ? new Error("Download deadline exceeded") : error;
      if (attempt < 3) await delay(1000 * (2 ** attempt), undefined, { signal });
    }
  }
  throw lastError;
}

async function main() {
  const vendors = Object.entries(resources.vendors);
  const foliateVendors = foliateOutput ? Object.values(resources.foliateVendors) : [];
  const items = [resources.pdfArchive, ...vendors.map(([, value]) => value), ...foliateVendors, resources.ruffleArchive];
  const downloaded = new Array(items.length);
  let next = 0;
  const controller = new AbortController();
  async function worker() {
    while (!controller.signal.aborted && next < items.length) {
      const index = next++;
      try {
        const { url, sha256 } = items[index];
        const bytes = await downloadWithRetry(url, controller.signal);
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== sha256) throw new Error("SHA-256 mismatch");
        downloaded[index] = bytes;
      } catch (error) {
        if (!controller.signal.aborted) {
          // Index identifies the entry in items without exposing URLs or proxy credentials.
          const message = typeof error?.message === "string" && /^(?:SHA-256 mismatch|Invalid download URL|Download requires HTTPS|Invalid download redirect|Download failed \(HTTP \d+\)|Download response failed|Download response aborted|Download request failed|Download response too large|Download deadline exceeded)$/.test(error.message)
            ? error.message : "unexpected error";
          const failure = new Error(`Resource ${index} download failed: ${message}`);
          controller.abort(failure);
          agent.destroy();
          throw failure;
        }
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  const ruffleTar = gunzipSync(downloaded[downloaded.length - 1], { maxOutputLength: MAX_ARCHIVE_BYTES });
  const expectedRuffle = new Set(resources.ruffleArchive.files);
  const extractedRuffle = new Map();
  for (let offset = 0; offset < ruffleTar.length;) {
    if (offset + 512 > ruffleTar.length) throw new Error("Truncated Ruffle archive");
    const header = ruffleTar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, "");
    if (!name) break;
    const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/, "").trim() || "0";
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid Ruffle archive entry size");
    const size = parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || offset + 512 + Math.ceil(size / 512) * 512 > ruffleTar.length) throw new Error("Truncated Ruffle archive");
    const file = name.startsWith("package/") ? name.slice(8) : "";
    if (expectedRuffle.has(file)) {
      if ((header[156] !== 0 && header[156] !== 48) || extractedRuffle.has(file)) throw new Error("Invalid Ruffle archive entry");
      extractedRuffle.set(file, ruffleTar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (extractedRuffle.size !== expectedRuffle.size) throw new Error("Ruffle archive missing required files");
  // Prepare every operation before touching existing output. Disk errors during the
  // commit below can still leave partial updates; this is not an atomic rollback.
  const writes = [];
  const removals = [];
  const ruffleOutput = join(output, resources.ruffleArchive.directory.slice("vendor/".length));
  for (const [file, bytes] of extractedRuffle) writes.push([join(ruffleOutput, file), bytes]);
  const tar = gunzipSync(downloaded[0], { maxOutputLength: MAX_ARCHIVE_BYTES });
const pdfGroups = new Set(["cmaps", "standard_fonts", "wasm"]);
const pdfFiles = new Set();
for (let offset = 0; offset < tar.length;) {
  if (offset + 512 > tar.length) throw new Error("Truncated PDF archive");
  const header = tar.subarray(offset, offset + 512), name = header.subarray(0, 100).toString().replace(/\0.*$/, "");
  if (!name) break;
  const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/, "").trim() || "0";
  if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid PDF archive entry size");
  const size = parseInt(sizeText, 8);
  if (!Number.isSafeInteger(size) || offset + 512 + Math.ceil(size / 512) * 512 > tar.length)
    throw new Error("Truncated PDF archive");
  const relative = name.startsWith("package/") ? name.slice(8) : "";
  const parts = relative.split("/");
  if (pdfGroups.has(parts[0]) && parts.length > 1 && !relative.endsWith("/")) {
    if ((header[156] !== 0 && header[156] !== 48) || parts.some(part => !part || part === "." || part === "..") || pdfFiles.has(relative))
      throw new Error("Invalid PDF archive entry");
    pdfFiles.add(relative);
    const target = join(output, relative);
    const bytes = tar.subarray(offset + 512, offset + 512 + size);
    writes.push([target, bytes]);
    if (foliateOutput) writes.push([join(foliateOutput, "pdfjs", relative), bytes]);
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
for (const group of pdfGroups) {
  if (![...pdfFiles].some(file => file.startsWith(group + "/")))
    throw new Error(`PDF archive missing required files: ${group}`);
}
for (const [index, [name, {path}]] of vendors.entries()) {
  const bytes = downloaded[index + 1];
  const versioned = path.slice("vendor/".length);
  writes.push([join(output, versioned), bytes]);
  if (foliateOutput && (name === "pdf" || name === "pdfWorker")) {
    const filename = name === "pdf" ? "pdf.mjs" : "pdf.worker.mjs";
    writes.push([join(foliateOutput, "pdfjs", filename), bytes]);
    removals.push(join(foliateOutput, "pdfjs", filename + ".map"));
  }
}
if (foliateOutput) for (const [index, {file}] of foliateVendors.entries()) {
  const bytes = downloaded[1 + vendors.length + index];
  const target = join(foliateOutput, file);
  writes.push([target, bytes]);
}
for (const [target, bytes] of writes) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
for (const target of removals) rmSync(target, { force: true });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

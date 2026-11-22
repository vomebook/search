import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Agent, get } from "node:https";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const resources = createRequire(import.meta.url)(join(process.cwd(), "static/reader-resources.js"));

const output = process.argv[2] || "static/vendor";
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

// Both checksum-pinned npm archives use the same tar layout. Select only
// the promised package files before constructing any output paths.
function extractArchive(compressed, label, select) {
  const tar = gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES });
  const files = new Map();
  for (let offset = 0; offset < tar.length;) {
    if (offset + 512 > tar.length) throw new Error(`Truncated ${label} archive`);
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, "");
    if (!name) break;
    const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/, "").trim() || "0";
    if (!/^[0-7]+$/.test(sizeText)) throw new Error(`Invalid ${label} archive entry size`);
    const size = parseInt(sizeText, 8);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || next > tar.length) throw new Error(`Truncated ${label} archive`);
    const file = name.startsWith("package/") ? name.slice(8) : "";
    if (select(file)) {
      if ((header[156] !== 0 && header[156] !== 48) || files.has(file) ||
          file.split("/").some(part => !part || part === "." || part === ".."))
        throw new Error(`Invalid ${label} archive entry`);
      files.set(file, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset = next;
  }
  return files;
}

async function main() {
  const vendors = Object.entries(resources.vendors);
  const items = [resources.pdfArchive, ...vendors.map(([, value]) => value), resources.ruffleArchive];
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
  const expectedRuffle = new Set(resources.ruffleArchive.files);
  const ruffle = extractArchive(downloaded.at(-1), "Ruffle", file => expectedRuffle.has(file));
  if (ruffle.size !== expectedRuffle.size) throw new Error("Ruffle archive missing required files");
  const pdfGroups = new Set(["cmaps", "standard_fonts", "wasm"]);
  const pdf = extractArchive(downloaded[0], "PDF", file => {
    const slash = file.indexOf("/");
    return slash > 0 && pdfGroups.has(file.slice(0, slash)) && !file.endsWith("/");
  });
  for (const group of pdfGroups) {
    if (![...pdf.keys()].some(file => file.startsWith(group + "/")))
      throw new Error(`PDF archive missing required files: ${group}`);
  }
  // Write nothing until every input and both archive inventories were validated.
  const ruffleOutput = join(output, resources.ruffleArchive.directory.slice("vendor/".length));
  const writes = [
    ...[...ruffle].map(([file, bytes]) => [join(ruffleOutput, file), bytes]),
    ...[...pdf].map(([file, bytes]) => [join(output, file), bytes]),
    ...vendors.map(([, {path}], index) => [join(output, path.slice("vendor/".length)), downloaded[index + 1]])
  ];
  for (const [target, bytes] of writes) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

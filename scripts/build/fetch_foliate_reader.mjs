import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { gunzipSync } from "node:zlib";

const resources = createRequire(import.meta.url)(join(process.cwd(), "static/reader-resources.js"));
const output = resolve(process.argv[2] || "static/foliate-reader");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const encodedPatch = readFileSync(join(scriptDir, "foliate-local.patch.b64"), "ascii").replace(/\s/g, "");
if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedPatch))
  throw new Error("Foliate local adaptation patch is not valid base64");
const localPatch = Buffer.from(encodedPatch, "base64").toString("utf8");

function download(url, redirects = 0) {
  return new Promise((resolvePromise, reject) => {
    const request = get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) {
        response.resume();
        return download(new URL(response.headers.location, url), redirects + 1).then(resolvePromise, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`${url}: HTTP ${response.statusCode}`));
      }
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolvePromise(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.setTimeout(180000, () => request.destroy(new Error(`${url}: request timed out`)));
    request.on("error", reject);
  });
}

async function downloadWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await download(url); }
    catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolvePromise => setTimeout(resolvePromise, 1000 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function extractPinnedFiles(archive) {
  const tar = gunzipSync(archive);
  const allowed = new Set(resources.foliateFiles);
  const extracted = new Set();
  const root = `foliate-js-${resources.foliateRevision}`;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0";
    const size = parseInt(sizeText, 8);
    const type = String.fromCharCode(header[156] || 48);
    const rootPrefix = `${root}/`;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid Foliate tar entry size: ${path}`);
    if (path.startsWith(rootPrefix) && (type === "0" || type === "\0")) {
      const file = path.slice(rootPrefix.length);
      if (allowed.has(file)) {
        const target = resolve(output, file);
        const rel = relative(output, target);
        if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`unsafe Foliate path: ${file}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, tar.subarray(offset + 512, offset + 512 + size));
        extracted.add(file);
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const missing = [...allowed].filter(file => !extracted.has(file));
  if (missing.length) throw new Error(`pinned Foliate archive is missing: ${missing.join(", ")}`);
}

function applyLocalPatch(patch) {
  const lines = patch.split(/\r?\n/);
  let index = 0;
  let changed = 0;
  while (index < lines.length) {
    const fileHeader = lines[index++].match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!fileHeader) continue;
    const file = fileHeader[2];
    const target = resolve(output, file);
    const rel = relative(output, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || !resources.foliateFiles.includes(file))
      throw new Error(`Foliate patch targets an unexpected path: ${file}`);
    const original = readFileSync(target, "utf8").split("\n");
    const result = [];
    let sourceIndex = 0;
    while (index < lines.length && !lines[index].startsWith("diff --git ")) {
      const hunk = lines[index].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!hunk) { index++; continue; }
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const targetIndex = oldCount === 0 ? oldStart : oldStart - 1;
      while (sourceIndex < targetIndex) result.push(original[sourceIndex++]);
      index++;
      while (index < lines.length && !lines[index].startsWith("@@ ") && !lines[index].startsWith("diff --git ")) {
        const line = lines[index++];
        if (line === "") {
          if (index === lines.length) break;
          throw new Error(`unexpected empty Foliate patch line in ${file}`);
        }
        const marker = line[0], text = line.slice(1);
        if (marker === "\\") continue;
        if (marker === " ") {
          if (original[sourceIndex] !== text) throw new Error(`Foliate patch context mismatch in ${file}`);
          result.push(original[sourceIndex++]);
        } else if (marker === "-") {
          if (original[sourceIndex] !== text) throw new Error(`Foliate patch removal mismatch in ${file}`);
          sourceIndex++;
        } else if (marker === "+") result.push(text);
        else throw new Error(`invalid Foliate patch line in ${file}: ${line}`);
      }
      changed++;
    }
    result.push(...original.slice(sourceIndex));
    writeFileSync(target, result.join("\n"));
  }
  if (!changed) throw new Error("Foliate local adaptation patch was empty or invalid");
}

async function main() {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const archive = await downloadWithRetry(resources.foliateArchive.url);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== resources.foliateArchive.sha256)
    throw new Error(`Foliate archive SHA-256 ${actual} does not match ${resources.foliateArchive.sha256}`);
  extractPinnedFiles(archive);
  applyLocalPatch(localPatch);
  console.log(`Foliate ${resources.foliateRevision} fetched, verified, and locally adapted at ${output}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

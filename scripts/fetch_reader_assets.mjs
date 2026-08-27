import fs from "fs";
import path from "path";
import urlModule from "url";
import zlib from "zlib";

const { mkdir, rename, unlink, writeFile } = fs.promises;
const { dirname } = path;
const { fileURLToPath } = urlModule;
const { gunzipSync } = zlib;

export const DEFAULT_READER_ASSETS_URL = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/reader_assets.json.gz";

export function validateReaderAssets(bytes) {
  const data = JSON.parse(gunzipSync(bytes).toString("utf8"));
  if (!data || data.v !== 1 || !data.f || typeof data.f !== "object" || Array.isArray(data.f)) {
    throw new Error("invalid Reader Assets sidecar");
  }
  return data;
}

export async function fetchReaderAssets(output, url = DEFAULT_READER_ASSETS_URL, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Reader Assets request failed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      validateReaderAssets(bytes);
      await mkdir(dirname(output), { recursive: true });
      const temporary = `${output}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, output);
      return;
    } catch (error) {
      lastError = error;
      await unlink(`${output}.tmp`).catch(() => {});
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("usage: node scripts/fetch_reader_assets.mjs OUTPUT [URL]");
  await fetchReaderAssets(output, process.argv[3] || DEFAULT_READER_ASSETS_URL);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

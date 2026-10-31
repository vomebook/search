import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { makeFirstPageWorkerSource } from "../static/reader/pdf/pdf-first-page-worker-adapter.mjs";

const bytes = readFileSync("static/vendor/pdf.worker.07ceb740d746.mjs");
assert.equal(createHash("sha256").update(bytes).digest("hex"),"07ceb740d746e5d9012fcf9f27d5c7dea09f7d2f5e74f5c8109e5787551a2333");
const source = bytes.toString("utf8"), patched = makeFirstPageWorkerSource(source);
assert.match(patched, /ReaderValidatePageCount/);
assert.match(patched, /readerPageCountPending/);
assert.match(patched, /ensureDoc\("checkLastPage", \[false\]\)/);
assert.match(patched, /requestLoadedStream\(\)/);
assert.match(patched, /readerFirstPageOnly/);
assert.throws(() => makeFirstPageWorkerSource(source.replace('const workerVersion = "6.4.299";', 'const workerVersion = "9.0.0";')),
  /PDF_PREVIEW_WORKER_VERSION_MISMATCH/);
assert.throws(() => makeFirstPageWorkerSource(source.replace('promise = catalog.getPageDict(pageIndex);', '')),
  /PDF_PREVIEW_WORKER_VERSION_MISMATCH/);
console.log("Pinned PDF first-page worker adapter and fail-closed checks passed");

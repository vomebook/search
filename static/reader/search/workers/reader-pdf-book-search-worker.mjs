import "../../core/reader-security.js";
import { searchBookText, validateBookText } from "../reader-book-text.js";
import { validPdfBookUrl } from "../reader-pdf-book-url.mjs";
import { validatePdfPartitionConfiguration } from "../reader-pdf-partition-config.mjs";
import { canPrefetchPdfPartition, canRetainPdfPartition } from "../reader-pdf-partition-policy.mjs";
import { pdfPartitionPageOffset, decoratePdfPartitionHits } from "../reader-pdf-partition-page.mjs";
import { createPdfPartitionRequests } from "../reader-pdf-partition-requests.mjs";
import { compactPdfBookPage } from "../reader-pdf-book-compact.mjs";
import { readPdfSearchBytes } from "../reader-pdf-search-stream.mjs";
import { readVerifiedPdfSearchText } from "../reader-pdf-search-decode.mjs";
import { validatePdfSearchPartition } from "../reader-pdf-partition-shape.mjs";

const aborted = () => new DOMException("Search cancelled", "AbortError");
const limit = self.VoiceOfMLReaderSecurity.LIMITS.chapterTotalBytes;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
let configuration, book, pendingBook, controller, active = 0, session;
const partitionRequests = createPdfPartitionRequests();

async function loadBook() {
  if (book) return book;
  if (pendingBook) return pendingBook;
  if (!validPdfBookUrl(configuration.url, self.location.href) ||
      !Number.isSafeInteger(configuration.bytes) || configuration.bytes < 1 || configuration.bytes > limit ||
      !/^[0-9a-f]{64}$/.test(configuration.sha256)) throw new Error("PDF_OCR_SOURCE_INVALID");
  const request = new AbortController();
  controller = request;
  const timer = setTimeout(() => request.abort(), 120000);
  pendingBook = (async () => {
    const response = await fetch(configuration.url, { signal: request.signal, credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let packed = await readPdfSearchBytes(response.body, request.signal, configuration.bytes, limit);
    if (packed.byteLength !== configuration.bytes) throw new Error("PDF_OCR_SIZE_MISMATCH");
    const decoding = readVerifiedPdfSearchText(packed, configuration.sha256, request.signal, limit);
    packed = null;
    const decoded = JSON.parse(await decoding);
    if (request.signal.aborted) throw aborted();
    const validated = validateBookText(decoded, configuration.pageCount, configuration.sourceSha);
    // Search needs offsets and hit boxes, not the duplicate full page layout.
    const compact = { pages: validated.pages };
    let deadline = performance.now() + 8;
    for (let index = 0; index < compact.pages.length; index++) {
      if (request.signal.aborted) throw aborted();
      const page = compact.pages[index];
      compact.pages[index] = compactPdfBookPage(page);
      if (index % 16 === 15 && performance.now() >= deadline) {
        await pause();
        deadline = performance.now() + 8;
      }
    }
    book = compact;
    self.postMessage({ bookReady: true });
    return book;
  })().finally(() => {
    clearTimeout(timer);
    pendingBook = null;
    if (controller === request) controller = null;
  });
  return pendingBook;
}

async function fetchPartitionBytes(part, signal) {
  const response = await fetch(part.url, {signal, credentials: "omit"});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readPdfSearchBytes(response.body, signal, part.bytes, limit);
}

async function loadSearchPartition(part, current, owners = null, prefetched = null) {
  return partitionRequests.run(current, owners, async signal => {
    let packed = prefetched || await fetchPartitionBytes(part, signal);
    const decoding = readVerifiedPdfSearchText(packed, part.sha256, signal, limit);
    packed = null;
    const value = JSON.parse(await decoding);
    if (!current() || signal.aborted) throw aborted();
    return validatePdfSearchPartition(value, part, configuration);
  });
}

async function searchPartitions(query, current, progress) {
  validatePdfPartitionConfiguration(configuration, self.location.href, limit);
  const counts = [], first = [];
  let total = 0, complete = false, retained = null;
  const remember = (number, part, local) => {
    retained = null;
    // Preserve the per-query owner and avoid retaining oversized verified text.
    if (!canRetainPdfPartition(part)) return;
    // The index owns this SHA-256-verified immutable snapshot and checkpoints.
    // Reuse is scoped to this query; no unverified or oversized body is kept.
    retained = {number, part, local};
  };
  const index = {async page(requested = 0) {
    const offset = pdfPartitionPageOffset(requested, total);
    if (!offset) return {total, offset, pageSize: 50, results: first.slice(), complete};
    const results = [];
    let skipped = 0;
    for (let i = 0; i < counts.length && results.length < 50; i++) {
      if (!current()) throw aborted();
      if (skipped + counts[i] <= offset) {skipped += counts[i]; continue;}
      let part, local;
      if (retained?.number === i) ({part, local} = retained);
      else {
        retained = null;
        part = await loadSearchPartition(configuration.partitions[i], current);
        local = await searchBookText(part, query, {current, yieldTask: pause});
        if (!current()) throw aborted();
        if (local.total !== counts[i]) throw new Error("PDF_V3_GENERATION_CHANGED");
        remember(i, part, local);
      }
      if (!current()) throw aborted();
      let position = Math.max(0, offset - skipped);
      while (position < local.total && results.length < 50) {
        const page = local.page(position);
        const hits = page.results.slice(position - page.offset, position - page.offset + 50 - results.length);
        results.push(...decoratePdfPartitionHits(hits, part.pages));
        position += hits.length;
      }
      skipped += counts[i];
    }
    return {total, offset, pageSize: 50, results, complete};
  }};
  const owners = new Set(), connection = self.navigator?.connection;
  let pending = null;
  try {
    for (let position = 0; position < configuration.partitions.length; position++) {
      if (!current()) throw aborted();
      const part = configuration.partitions[position], ahead = pending;
      pending = null;
      const valuePromise = ahead ? ahead.then(outcome => {
        if ("error" in outcome) throw outcome.error;
        return loadSearchPartition(part, current, owners, outcome.packed);
      }) : loadSearchPartition(part, current, owners);
      // Own failures immediately, including if starting lookahead throws.
      const valueOutcome = valuePromise.then(value => ({value}), error => ({error}));
      const next = configuration.partitions[position + 1];
      if (next && canPrefetchPdfPartition(connection, next.bytes)) {
        // Only compressed future bytes are retained. Each of the (at most
        // two) overlapping future transfers is capped independently.
        pending = partitionRequests.run(current, owners, signal => fetchPartitionBytes(next, signal))
          .then(packed => ({packed}), error => ({error}));
      }
      const outcome = await valueOutcome;
      if ("error" in outcome) throw outcome.error;
      const value = outcome.value;
      if (!current()) throw aborted();
      // Commit counts and progress strictly in manifest order; never publish a
      // later successful partition past a failed or unverified predecessor.
      const local = await searchBookText(value, query, {current, yieldTask: pause});
      if (!current()) throw aborted();
      counts.push(local.total);
      total += local.total;
      if (first.length < 50) first.push(...decoratePdfPartitionHits(local.page(0).results.slice(0, 50 - first.length), value.pages));
      await progress(index, part.end, configuration.pageCount);
      await pause();
    }
    complete = true;
    return index;
  } catch (error) {
    // A replacement search can start before this catch resumes; abort only
    // this search's lookahead, never another search or a result-page request.
    for (const request of owners) request.abort();
    throw error;
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === "init") { configuration = data.configuration; return; }
  if (data.type === "cancel") {
    active++;
    session = null;
    controller?.abort();
    partitionRequests.abort();
    return;
  }
  if (data.type !== "search" && data.type !== "page" && data.type !== "prefetch") return;
  const token = data.type === "search" ? ++active : active;
  const current = () => token === active;
  try {
    if (data.type === "search") {
      partitionRequests.abort();
      session = null;
      // Drain both search and result-page requests from the old session before
      // starting another load, including a switch to the legacy book path.
      await partitionRequests.wait();
      if (!current()) return;
      const query = String(data.query || "").trim();
      if (!query || query.length > 2048) throw new Error("请输入 1–2048 个字符");
      if (controller?.signal.aborted && pendingBook) await pendingBook.catch(() => {});
      const progress = async (partial, scanned, pages) => {
          const page = await partial.page(0);
          if (!current()) return;
          session = { id: data.id, index: partial };
          self.postMessage({ id: data.id, session: session.id, progress: true,
            scanned, pages, ...page });
      };
      const index = configuration.partitions
        ? await searchPartitions(query, current, progress)
        : await searchBookText(await loadBook(), query, {current, yieldTask: pause, progress});
      if (!current()) return;
      session = { id: data.id, index };
      self.postMessage({ id: data.id, session: session.id, ...await index.page(0) });
    } else if (data.type === "prefetch") {
      if (configuration.partitions) validatePdfPartitionConfiguration(configuration, self.location.href, limit);
      else await loadBook();
      // Keep the search index (and its methods) inside the Worker. Only its
      // cloneable identity is needed to preserve pagination after prefetch.
      if (current()) self.postMessage({ id: data.id, session: session?.id ?? null, ready: true });
    } else {
      if (!session || data.session !== session.id) throw aborted();
      const owner = session, page = await owner.index.page(data.offset);
      if (current() && session === owner) self.postMessage({ id: data.id, session: owner.id, ...page });
    }
  } catch (error) {
    if (current() && data.type === "search") session = null;
    if (current()) self.postMessage({ id: data.id, error: error.name === "AbortError"
      ? "全文搜索已取消或加载超时，请重试" : error.message });
  }
};

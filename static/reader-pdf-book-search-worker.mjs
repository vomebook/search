import "./reader-security.js";
import { searchBookText, validateBookText } from "./reader-book-text.js";

const aborted = () => new DOMException("Search cancelled", "AbortError");
const limit = self.VoiceOfMLReaderSecurity.LIMITS.chapterTotalBytes;
const bookPath = /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:[0-9a-f]{16}\/)?ocr\/book-text\.json\.gz$/;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
let configuration, book, pendingBook, controller, active = 0, session;

function validUrl(raw) {
  const url = new URL(raw, self.location.href);
  if (url.username || url.password || url.hash) return false;
  if (url.pathname === "/api/reader-bucket-resource")
    return (url.origin === self.location.origin || url.origin === "https://voiceofml-search.hf.space") &&
      url.searchParams.getAll("path").length === 1 &&
      [...url.searchParams.keys()].every(key => key === "path") &&
      bookPath.test(url.searchParams.get("path"));
  const prefix = /^\/datasets\/vomebook\/Reader-Assets\/resolve\/[^/]+\//.exec(url.pathname);
  return url.protocol === "https:" && ["huggingface.co", "hf-mirror.com"].includes(url.hostname) &&
    !url.search && !!prefix && bookPath.test(decodeURIComponent(url.pathname.slice(prefix[0].length)));
}

async function readBounded(stream, signal) {
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  const cancel = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw aborted();
      const { value, done } = await reader.read();
      if (signal.aborted) throw aborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("READER_RESOURCE_LIMIT");
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function loadBook() {
  if (book) return book;
  if (pendingBook) return pendingBook;
  if (!validUrl(configuration.url) ||
      !Number.isSafeInteger(configuration.bytes) || configuration.bytes < 1 || configuration.bytes > limit ||
      !/^[0-9a-f]{64}$/.test(configuration.sha256)) throw new Error("PDF_OCR_SOURCE_INVALID");
  const request = new AbortController();
  controller = request;
  const timer = setTimeout(() => request.abort(), 120000);
  pendingBook = (async () => {
    const response = await fetch(configuration.url, { signal: request.signal, credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const packed = await readBounded(response.body, request.signal);
    if (packed.byteLength !== configuration.bytes) throw new Error("PDF_OCR_SIZE_MISMATCH");
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", packed))]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    if (digest !== configuration.sha256) throw new Error("PDF_OCR_HASH_MISMATCH");
    const expanded = await readBounded(
      new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip")), request.signal);
    const decoded = JSON.parse(new TextDecoder().decode(expanded));
    if (request.signal.aborted) throw aborted();
    book = validateBookText(decoded, configuration.pageCount, configuration.sourceSha);
    return book;
  })().finally(() => {
    clearTimeout(timer);
    pendingBook = null;
    if (controller === request) controller = null;
  });
  return pendingBook;
}

self.onmessage = async ({ data }) => {
  if (data.type === "init") { configuration = data.configuration; return; }
  if (data.type === "cancel") {
    active++;
    session = null;
    controller?.abort();
    return;
  }
  if (data.type !== "search" && data.type !== "page") return;
  const token = data.type === "search" ? ++active : active;
  const current = () => token === active;
  try {
    if (data.type === "search") {
      session = null;
      const query = String(data.query || "").trim();
      if (!query || query.length > 2048) throw new Error("请输入 1–2048 个字符");
      if (controller?.signal.aborted && pendingBook) await pendingBook.catch(() => {});
      const source = await loadBook();
      if (!current()) return;
      const index = await searchBookText(source, query, {
        current, yieldTask: pause,
        progress: (partial, scanned, pages) => {
          if (!current()) return;
          session = { id: data.id, index: partial };
          self.postMessage({ id: data.id, session: session.id, progress: true,
            scanned, pages, ...partial.page(0) });
        }
      });
      if (!current()) return;
      session = { id: data.id, index };
      self.postMessage({ id: data.id, session: session.id, ...index.page(0) });
    } else {
      if (!session || data.session !== session.id) throw aborted();
      self.postMessage({ id: data.id, session: session.id, ...session.index.page(data.offset) });
    }
  } catch (error) {
    if (current()) self.postMessage({ id: data.id, error: error.name === "AbortError"
      ? "全文搜索已取消或加载超时，请重试" : error.message });
  }
};

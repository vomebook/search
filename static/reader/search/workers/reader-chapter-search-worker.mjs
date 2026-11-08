const PACKED_LIMIT = 64 * 1024 * 1024;
const TEXT_LIMIT = 256 * 1024 * 1024;
import {countMatches, resultPage, aborted, PAGE_SIZE} from "../reader-chapter-search-core.mjs";
import {isSearchIndexProxyURL} from "../reader-chapter-search-proxy-url.mjs";
import {validateIndex} from "../reader-chapter-search-index.mjs";

async function readBounded(stream, limit, signal) {
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
      if (size > limit) throw new Error("全文搜索数据超过大小限制");
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}


let configuration, indexPromise, chapters, active = 0, session, loadController;
async function loadIndex() {
  if (chapters) return chapters;
  if (indexPromise) return indexPromise;
  const controller = new AbortController();
  loadController = controller;
  const timer = setTimeout(() => controller.abort(), 60000);
  indexPromise = (async () => {
    const { index, chapters: expected } = configuration;
    const url = new URL(index.url, self.location.origin);
    if (!isSearchIndexProxyURL(url, "https://voiceofml-search.hf.space") ||
        !Number.isSafeInteger(index.bytes) || index.bytes <= 0 || index.bytes > PACKED_LIMIT ||
        !/^[0-9a-f]{64}$/.test(index.sha256)) throw new Error("全文搜索索引无效");
    const response = await fetch(url, { signal: controller.signal, credentials: "omit" });
    if (!response.ok) throw new Error(`全文搜索加载失败（HTTP ${response.status}），请重试`);
    const bytes = await readBounded(response.body, PACKED_LIMIT, controller.signal);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
    if (bytes.length !== index.bytes || sha !== index.sha256) throw new Error("全文搜索索引校验失败，请重试");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const text = await readBounded(stream, TEXT_LIMIT, controller.signal);
    const loaded = validateIndex(JSON.parse(new TextDecoder().decode(text)), expected, index.text_profile);
    if (controller.signal.aborted) throw aborted();
    chapters = loaded;
    return loaded;
  })().finally(() => {
    clearTimeout(timer);
    indexPromise = null;
    if (loadController === controller) loadController = null;
  });
  return indexPromise;
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = async ({ data }) => {
    if (data.type === "init") { configuration = data.configuration; return; }
    if (data.type === "cancel") { active++; session = null; loadController?.abort(); return; }
    const token = ++active, current = () => token === active;
    try {
      let offset = 0;
      if (data.type === "search") {
        session = null;
        const query = String(data.query || "").trim().replace(/\s+/gu, " ");
        if (!query || query.length > 2048) throw new Error("请输入 1–2048 个字符");
        if (loadController?.signal.aborted) await indexPromise.catch(() => {});
        const book = await loadIndex();
        if (!current()) return;
        const counts = await countMatches(book, query, current, async partial => {
          if (!current()) return;
          if (current()) self.postMessage({ id: data.id, progress: true,
            total: partial.total, scanned: partial.scanned, chapters: book.length,
            offset: 0, pageSize: PAGE_SIZE, results: partial.firstPage.slice() });
        });
        session = { ...counts, query, id: data.id };
      } else if (data.type === "page") {
        if (!session || data.session !== session.id) throw aborted();
        offset = Math.max(0, Math.min(Math.floor(data.offset / PAGE_SIZE) * PAGE_SIZE,
          Math.max(0, Math.ceil(session.total / PAGE_SIZE) - 1) * PAGE_SIZE));
      } else return;
      const result = offset ? await resultPage(chapters, session.query, session.counts, offset, current) : session.firstPage.slice();
      if (current()) self.postMessage({ id: data.id, session: session.id, total: session.total,
        offset, pageSize: PAGE_SIZE, results: result });
    } catch (error) {
      if (current()) self.postMessage({ id: data.id, error: error.name === "AbortError"
        ? "全文搜索已取消或加载超时，请重试" : error.message });
    }
  };
}

const PACKED_LIMIT = 64 * 1024 * 1024;
const TEXT_LIMIT = 256 * 1024 * 1024;
const PAGE_SIZE = 50;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
function cooperativeYield() {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < 8) return;
    await pause();
    last = performance.now();
  };
}
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const aborted = () => new DOMException("Search cancelled", "AbortError");

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

export function validateIndex(data, chapters) {
  if (data?.version !== 1 || data.kind !== "epub-search-index" ||
      !Array.isArray(data.chapters) || data.chapters.length !== chapters.length)
    throw new Error("全文搜索索引不完整，请重试");
  for (let i = 0; i < chapters.length; i++) {
    const item = data.chapters[i], expected = chapters[i];
    if (item?.index !== expected.index || item.path !== expected.path || typeof item.text !== "string")
      throw new Error("全文搜索索引与章节不一致");
    item.title = expected.title || `章节 ${expected.index}`;
  }
  return data.chapters;
}

// Scan bounded pieces so a new query can cancel even one very large chapter.
// Keep counts, rather than one object per hit; all matches remain pageable.
export async function scanText(text, query, visit, current = () => true, yieldWork = pause) {
  const pattern = new RegExp(escapePattern(query), "giu");
  let next = 0;
  for (let start = 0; start < text.length; start += 65536) {
    if (!current()) throw aborted();
    const part = text.slice(start, start + 65536 + query.length + 1);
    pattern.lastIndex = Math.max(0, next - start);
    let match;
    while ((match = pattern.exec(part))) {
      if (match.index >= 65536) break;
      const offset = start + match.index;
      next = offset + match[0].length;
      if (visit(offset, match[0].length) === false) return;
    }
    await yieldWork();
  }
  if (!current()) throw aborted();
}

export async function countMatches(chapters, query, current, progress = null) {
  const counts = [];
  const yieldWork = cooperativeYield();
  let total = 0;
  for (const chapter of chapters) {
    let count = 0;
    await scanText(chapter.text, query, () => { count++; }, current, yieldWork);
    counts.push(count);
    total += count;
    if (progress && (counts.length === 1 || (count && total <= PAGE_SIZE) ||
        counts.length % 8 === 0 || counts.length === chapters.length))
      await progress({ counts, total, scanned: counts.length });
  }
  return { counts, total };
}

export async function resultPage(chapters, query, counts, offset, current) {
  const results = [];
  const yieldWork = cooperativeYield();
  let skip = offset;
  for (let i = 0; i < chapters.length && results.length < PAGE_SIZE; i++) {
    if (!current()) throw aborted();
    if (skip >= counts[i]) { skip -= counts[i]; continue; }
    const chapter = chapters[i];
    await scanText(chapter.text, query, (start, length) => {
      if (skip) { skip--; return; }
      const before = Math.max(0, start - 72), after = Math.min(chapter.text.length, start + length + 88);
      results.push({
        chapterIndex: chapter.index, start, length,
        location: `第 ${chapter.index} 章 · ${chapter.title}`,
        snippet: { text: chapter.text.slice(before, after), matchStart: start - before,
          matchLength: length, prefix: before ? "…" : "", suffix: after < chapter.text.length ? "…" : "" }
      });
      return results.length < PAGE_SIZE;
    }, current, yieldWork);
  }
  return results;
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
    if (url.origin !== "https://voiceofml-search.hf.space" || url.pathname !== "/api/reader-content" ||
        url.username || url.password ||
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
    const loaded = validateIndex(JSON.parse(new TextDecoder().decode(text)), expected);
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
          const results = await resultPage(book.slice(0, partial.scanned), query, partial.counts, 0, current);
          if (current()) self.postMessage({ id: data.id, progress: true,
            total: partial.total, scanned: partial.scanned, chapters: book.length,
            offset: 0, pageSize: PAGE_SIZE, results });
        });
        session = { ...counts, query, id: data.id };
      } else if (data.type === "page") {
        if (!session || data.session !== session.id) throw aborted();
        offset = Math.max(0, Math.min(Math.floor(data.offset / PAGE_SIZE) * PAGE_SIZE,
          Math.max(0, Math.ceil(session.total / PAGE_SIZE) - 1) * PAGE_SIZE));
      } else return;
      const result = await resultPage(chapters, session.query, session.counts, offset, current);
      if (current()) self.postMessage({ id: data.id, session: session.id, total: session.total,
        offset, pageSize: PAGE_SIZE, results: result });
    } catch (error) {
      if (current()) self.postMessage({ id: data.id, error: error.name === "AbortError"
        ? "全文搜索已取消或加载超时，请重试" : error.message });
    }
  };
}

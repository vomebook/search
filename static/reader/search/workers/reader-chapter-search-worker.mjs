const PACKED_LIMIT = 64 * 1024 * 1024;
const TEXT_LIMIT = 256 * 1024 * 1024;
const PAGE_SIZE = 50;
const CHECKPOINT_STRIDE = 256;
const BIGRAM_FILTER_HASHES = 7;
const MAX_BIGRAM_FILTER_BYTES = 32 * 1024;
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
  if (![1, 2].includes(data?.version) || data.kind !== "epub-search-index" ||
      !Array.isArray(data.chapters) || data.chapters.length !== chapters.length)
    throw new Error("全文搜索索引不完整，请重试");
  for (let i = 0; i < chapters.length; i++) {
    const item = data.chapters[i], expected = chapters[i];
    if (item?.index !== expected.index || item.path !== expected.path || typeof item.text !== "string")
      throw new Error("全文搜索索引与章节不一致");
    if (data.version === 2 && item.bf !== undefined) {
      let binary;
      try { binary = atob(item.bf); }
      catch (_) { throw new Error("全文搜索过滤索引无效"); }
      if (binary.length < 32 || binary.length > MAX_BIGRAM_FILTER_BYTES ||
          (binary.length & (binary.length - 1)) !== 0)
        throw new Error("全文搜索过滤索引无效");
      const filter = new Uint8Array(binary.length);
      for (let j = 0; j < binary.length; j++) filter[j] = binary.charCodeAt(j);
      item.bigramFilter = filter;
      delete item.bf;
    }
    item.title = expected.title || `章节 ${expected.index}`;
  }
  return data.chapters;
}

function bigramHashes(gram) {
  let first = 2166136261, second = 0x9E3779B9;
  for (const character of gram) {
    const codepoint = character.codePointAt(0);
    first = Math.imul(first ^ codepoint, 16777619) >>> 0;
    second = (second ^ (codepoint + 0x9E3779B9 + ((second << 6) >>> 0) + (second >>> 2))) >>> 0;
  }
  second |= 1;
  return Array.from({ length: BIGRAM_FILTER_HASHES }, (_, probe) =>
    (first + Math.imul(probe, second)) >>> 0);
}

export function queryBigramFilters(query) {
  const characters = Array.from(query);
  if (characters.length < 2 || characters.some(character =>
    character.toLowerCase() !== character.toUpperCase())) return null;
  return characters.slice(1).map((character, index) => bigramHashes(characters[index] + character));
}

export function chapterMayContainBigrams(chapter, filters) {
  const bloom = chapter.bigramFilter;
  if (!filters || !bloom) return true;
  const mask = bloom.length * 8 - 1;
  for (const hashes of filters) for (const hash of hashes) {
    const bit = hash & mask;
    if (!(bloom[bit >> 3] & (1 << (bit & 7)))) return false;
  }
  return true;
}

// Scan bounded pieces so a new query can cancel even one very large chapter.
// Keep counts, rather than one object per hit; all matches remain pageable.
export async function scanText(text, query, visit, current = () => true, yieldWork = pause,
  startOffset = 0, matcher = null) {
  const pattern = matcher || new RegExp(escapePattern(query), "giu");
  let next = startOffset;
  for (let start = startOffset; start < text.length; start += 65536) {
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
  const counts = [], checkpoints = [], firstPage = [];
  const yieldWork = cooperativeYield();
  const pattern = new RegExp(escapePattern(query), "giu");
  const filters = queryBigramFilters(query);
  let total = 0;
  for (const [chapterIndex, chapter] of chapters.entries()) {
    let count = 0;
    if (chapterMayContainBigrams(chapter, filters)) {
      await scanText(chapter.text, query, (start, length) => {
        if ((total + count) % CHECKPOINT_STRIDE === 0)
          checkpoints.push({ ordinal: total + count, chapterIndex, start });
        count++;
        if (firstPage.length < PAGE_SIZE) firstPage.push(searchResult(chapter, start, length));
      }, current, yieldWork, 0, pattern);
    }
    counts.push(count);
    total += count;
    if (progress && (counts.length === 1 || (count && total <= PAGE_SIZE) ||
        counts.length % 8 === 0 || counts.length === chapters.length))
      await progress({ counts, total, scanned: counts.length, firstPage });
  }
  return { counts, checkpoints, total, firstPage };
}

function searchResult(chapter, start, length) {
  const before = Math.max(0, start - 72), after = Math.min(chapter.text.length, start + length + 88);
  return {
    chapterIndex: chapter.index, start, length,
    location: `第 ${chapter.index} 章 · ${chapter.title}`,
    snippet: { text: chapter.text.slice(before, after), matchStart: start - before,
      matchLength: length, prefix: before ? "…" : "", suffix: after < chapter.text.length ? "…" : "" }
  };
}

export async function resultPage(chapters, query, counts, offset, current, checkpoints = []) {
  const results = [];
  const pattern = new RegExp(escapePattern(query), "giu");
  const filters = queryBigramFilters(query);
  offset = Math.max(0, Math.floor(offset));
  let checkpoint = null;
  for (let low = 0, high = checkpoints.length - 1; low <= high;) {
    const middle = (low + high) >> 1;
    if (checkpoints[middle].ordinal <= offset) {
      checkpoint = checkpoints[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  const yieldWork = cooperativeYield();
  let skip = offset - (checkpoint?.ordinal || 0);
  const firstChapter = checkpoint?.chapterIndex || 0;
  for (let i = firstChapter; i < chapters.length && results.length < PAGE_SIZE; i++) {
    if (!current()) throw aborted();
    const start = checkpoint && i === firstChapter ? checkpoint.start : 0;
    if (!start && skip >= counts[i]) { skip -= counts[i]; continue; }
    const chapter = chapters[i];
    if (!chapterMayContainBigrams(chapter, filters)) continue;
    await scanText(chapter.text, query, (matchStart, length) => {
      if (skip) { skip--; return; }
      results.push(searchResult(chapter, matchStart, length));
      return results.length < PAGE_SIZE;
    }, current, yieldWork, start, pattern);
  }
  return results;
}

export function isSearchIndexProxyURL(url, origin) {
  if (url.origin !== origin || url.username || url.password || url.hash) return false;
  if (url.pathname === "/api/reader-content") return true;
  return url.pathname === "/api/reader-bucket-resource" &&
    url.searchParams.getAll("path").length === 1 &&
    [...url.searchParams.keys()].every(key => key === "path") &&
    /^chapters\/ebook\/(?:epub|mobi|azw3|fb2|chm)\/[0-9a-f]{64}\/[0-9a-f]{16}\/epub-search-index\.json\.gz$/.test(url.searchParams.get("path"));
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

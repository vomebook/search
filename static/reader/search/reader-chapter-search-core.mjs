/** @typedef {{index: number, title: string, path: string, text: string, bigramFilter?: Uint8Array | undefined}} SearchChapter */
/** @typedef {{ordinal: number, chapterIndex: number, start: number}} SearchCheckpoint */
/** @typedef {{text: string, matchStart: number, matchLength: number, prefix: string, suffix: string}} SearchSnippet */
/** @typedef {{chapterIndex: number, start: number, length: number, location: string, snippet: SearchSnippet}} SearchResult */
/** @typedef {{counts: number[], total: number, scanned: number, firstPage: SearchResult[]}} SearchProgress */
export const PAGE_SIZE = 50;
const CHECKPOINT_STRIDE = 256;
const BIGRAM_FILTER_HASHES = 7;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
function cooperativeYield() {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < 8) return;
    await pause();
    last = performance.now();
  };
}
/** @param {string} value */
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const aborted = () => new DOMException("Search cancelled", "AbortError");

/** @param {string} gram */
function bigramHashes(gram) {
  let first = 2166136261, second = 0x9E3779B9;
  for (const character of gram) {
    const codepoint = character.codePointAt(0);
    if (codepoint === undefined) continue;
    first = Math.imul(first ^ codepoint, 16777619) >>> 0;
    second = (second ^ (codepoint + 0x9E3779B9 + ((second << 6) >>> 0) + (second >>> 2))) >>> 0;
  }
  second |= 1;
  return Array.from({ length: BIGRAM_FILTER_HASHES }, (_, probe) =>
    (first + Math.imul(probe, second)) >>> 0);
}

/** @param {string} query @returns {number[][] | null} */
export function queryBigramFilters(query) {
  const characters = Array.from(query);
  if (characters.length < 2 || characters.some(character =>
    character.toLowerCase() !== character.toUpperCase())) return null;
  return characters.slice(1).map((character, index) => bigramHashes(characters[index] + character));
}

/** @param {SearchChapter} chapter @param {number[][] | null} filters */
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

/** @param {RegExp} pattern @param {string} part @param {number} start @param {number} next
 * @param {(start: number, length: number) => unknown} visit @returns {{next: number, stopped: boolean}} */
function scanChunk(pattern, part, start, next, visit) {
  pattern.lastIndex = Math.max(0, next - start);
  let match;
  while ((match = pattern.exec(part))) {
    if (match.index >= 65536) break;
    const offset = start + match.index;
    next = offset + match[0].length;
    if (visit(offset, match[0].length) === false) return {next, stopped: true};
  }
  return {next, stopped: false};
}
// Scan bounded pieces so a new query can cancel even one very large chapter.
// Keep counts, rather than one object per hit; all matches remain pageable.
/** @param {string} text @param {string} query @param {(start: number, length: number) => unknown} visit
 * @param {() => boolean} [current] @param {() => Promise<void>} [yieldWork] @param {number} [startOffset] @param {RegExp | null} [matcher] */
export async function scanText(text, query, visit, current = () => true, yieldWork = pause,
  startOffset = 0, matcher = null) {
  const pattern = matcher || new RegExp(escapePattern(query), "giu");
  let next = startOffset;
  for (let start = startOffset; start < text.length; start += 65536) {
    if (!current()) throw aborted();
    const part = text.slice(start, start + 65536 + query.length + 1);
    const scanned = scanChunk(pattern, part, start, next, visit);
    next = scanned.next;
    if (scanned.stopped) return;
    await yieldWork();
  }
  if (!current()) throw aborted();
}

/** @param {SearchChapter[]} chapters @param {string} query @param {() => boolean} current
 * @param {((progress: SearchProgress) => void | Promise<void>) | null} [progress] */
export async function countMatches(chapters, query, current, progress = null) {
  /** @type {number[]} */
  const counts = [];
  /** @type {SearchCheckpoint[]} */
  const checkpoints = [];
  /** @type {SearchResult[]} */
  const firstPage = [];
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

/** @param {SearchChapter} chapter @param {number} start @param {number} length @returns {SearchResult} */
function searchResult(chapter, start, length) {
  const before = Math.max(0, start - 72), after = Math.min(chapter.text.length, start + length + 88);
  return {
    chapterIndex: chapter.index, start, length,
    location: `第 ${chapter.index} 章 · ${chapter.title}`,
    snippet: { text: chapter.text.slice(before, after), matchStart: start - before,
      matchLength: length, prefix: before ? "…" : "", suffix: after < chapter.text.length ? "…" : "" }
  };
}

/** @param {SearchCheckpoint[]} checkpoints @param {number} offset @returns {SearchCheckpoint | null} */
function checkpointAt(checkpoints, offset) {
  let checkpoint = null;
  for (let low = 0, high = checkpoints.length - 1; low <= high;) {
    const middle = (low + high) >> 1;
    if (checkpoints[middle].ordinal <= offset) {
      checkpoint = checkpoints[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  return checkpoint;
}
/** @param {SearchCheckpoint | null} checkpoint @param {number} offset */
function pageOrigin(checkpoint, offset) {
  return {skip: offset - (checkpoint?.ordinal || 0), first: checkpoint?.chapterIndex || 0};
}
/** @param {SearchCheckpoint | null} checkpoint @param {number} first @param {number} current */
function pageStart(checkpoint, first, current) {
  return checkpoint && current === first ? checkpoint.start : 0;
}
/** @param {SearchChapter[]} chapters @param {string} query @param {number[]} counts @param {number} offset
 * @param {() => boolean} current @param {SearchCheckpoint[]} [checkpoints] @returns {Promise<SearchResult[]>} */
export async function resultPage(chapters, query, counts, offset, current, checkpoints = []) {
  /** @type {SearchResult[]} */
  const results = [];
  const pattern = new RegExp(escapePattern(query), "giu");
  const filters = queryBigramFilters(query);
  offset = Math.max(0, Math.floor(offset));
  const checkpoint = checkpointAt(checkpoints, offset);
  const yieldWork = cooperativeYield();
  const origin = pageOrigin(checkpoint, offset);
  let skip = origin.skip;
  const firstChapter = origin.first;
  for (let i = firstChapter; i < chapters.length && results.length < PAGE_SIZE; i++) {
    if (!current()) throw aborted();
    const start = pageStart(checkpoint, firstChapter, i);
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

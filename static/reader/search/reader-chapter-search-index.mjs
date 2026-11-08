const MAX_BIGRAM_FILTER_BYTES = 32 * 1024;
/** @typedef {{index: number, path: string, title?: unknown}} ExpectedChapter */
/** @typedef {{index: number, path: string, title?: unknown, text: string, bigramFilter?: unknown}} IndexedChapter */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && (typeof value === 'object' || typeof value === 'function'); }
/** @typedef {{index: number, path: string, text: string, bf?: unknown, bigramFilter?: unknown, title?: unknown}} RawChapter */
/** @param {unknown} value @returns {value is RawChapter} */
function isRawChapter(value) {
  return isRecord(value) && typeof value.index === 'number' && typeof value.path === 'string' && typeof value.text === 'string';
}
/** @param {unknown} value @returns {value is {version: 1 | 2, kind: string, chapters: unknown[], text_profile?: unknown}} */
function isIndex(value) {
  return isRecord(value) && (value.version === 1 || value.version === 2) && value.kind === 'epub-search-index' && Array.isArray(value.chapters);
}
/** @param {string} encoded @returns {Uint8Array} */
function decodeFilter(encoded) {
  let binary;
  try { binary = atob(encoded); }
  catch (_) { throw new Error("全文搜索过滤索引无效"); }
  if (binary.length < 32 || binary.length > MAX_BIGRAM_FILTER_BYTES || (binary.length & (binary.length - 1)) !== 0)
    throw new Error("全文搜索过滤索引无效");
  const filter=new Uint8Array(binary.length);
  for (let j=0;j<binary.length;j++) filter[j]=binary.charCodeAt(j);
  return filter;
}
/** @param {unknown} value @returns {value is IndexedChapter} */
function isValidChapter(value) {
  return isRawChapter(value);
}
/** @param {unknown[]} values @returns {values is IndexedChapter[]} */
function allValidChapters(values) { return values.every(isValidChapter); }
/** @param {unknown} value @param {ExpectedChapter | undefined} expected @param {1 | 2} version @returns {IndexedChapter} */
function validateChapter(value,expected,version) {
  if (!expected || !isRawChapter(value) || value.index!==expected.index || value.path!==expected.path)
    throw new Error("全文搜索索引与章节不一致");
  if (version===2 && value.bf!==undefined) {
    value.bigramFilter=decodeFilter(String(value.bf));delete value.bf;
  }
  const title=expected.title || `章节 ${expected.index}`;
  value.title=title;
  return value;
}
/** @param {unknown} data @param {ExpectedChapter[]} chapters @param {string | undefined} [textProfile] @returns {IndexedChapter[]} */
export function validateIndex(data,chapters,textProfile) {
  if (!isIndex(data) || data.chapters.length !== chapters.length) throw new Error("全文搜索索引不完整，请重试");
  if ((textProfile !== undefined && textProfile !== "dom-text-v1") || data.text_profile !== textProfile)
    throw new Error("全文搜索索引文本格式不一致，请重试");
  for (let i=0;i<chapters.length;i++) validateChapter(data.chapters[i],chapters[i],data.version);
  if (!allValidChapters(data.chapters)) throw new Error("全文搜索过滤索引无效");
  return data.chapters;
}

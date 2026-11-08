const PACKED_LIMIT = 64 * 1024 * 1024;
const TEXT_LIMIT = 256 * 1024 * 1024;
import {countMatches, resultPage, aborted, PAGE_SIZE} from "../reader-chapter-search-core.mjs";
import {isSearchIndexProxyURL} from "../reader-chapter-search-proxy-url.mjs";
import {validateIndex} from "../reader-chapter-search-index.mjs";

/** @param {ReadableStream<Uint8Array<ArrayBuffer>> | null} stream @param {number} limit @param {AbortSignal} signal */
async function readBounded(stream, limit, signal) {
  if (!stream) throw new Error("全文搜索索引无效");
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


/** @typedef {import('../reader-chapter-search-index.mjs').ExpectedChapter} ExpectedChapter */
/** @typedef {{url: string, bytes: number, sha256: string, text_profile?: string | undefined}} IndexReference */
/** @typedef {{index: IndexReference, chapters: ExpectedChapter[]}} Configuration */
/** @typedef {Awaited<ReturnType<typeof countMatches>> & {query: string, id: number}} SearchSession */
/** @typedef {{type: 'init', configuration: Configuration} | {type: 'cancel'} |
 * {type: 'search', id: number, query: unknown} | {type: 'page', id: number, session: number, offset: number}} ChapterMessage */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === 'object'; }
/** @param {unknown} value @returns {value is Configuration} */
function isConfiguration(value) {
  return isRecord(value) && isRecord(value.index) && typeof value.index.url === 'string' &&
    typeof value.index.bytes === 'number' && typeof value.index.sha256 === 'string' &&
    (value.index.text_profile === undefined || typeof value.index.text_profile === 'string') &&
    Array.isArray(value.chapters) && value.chapters.every(chapter => isRecord(chapter) &&
      typeof chapter.index === 'number' && typeof chapter.path === 'string');
}
/** @param {unknown} value @returns {value is ChapterMessage} */
function isMessage(value) {
  if (!isRecord(value)) return false;
  if (value.type === 'init') return isConfiguration(value.configuration);
  if (value.type === 'cancel') return true;
  if (value.type === 'search') return typeof value.id === 'number';
  return value.type === 'page' && typeof value.id === 'number' && typeof value.session === 'number' && typeof value.offset === 'number';
}
/** @type {Configuration | undefined} */
let configuration;
/** @type {Promise<import('../reader-chapter-search-core.mjs').SearchChapter[]> | undefined} */
let indexPromise;
/** @type {import('../reader-chapter-search-core.mjs').SearchChapter[] | undefined} */
let chapters;
/** @type {SearchSession | null} */
let session = null;
/** @type {AbortController | null} */
let loadController = null;
let active = 0;
/** @param {IndexReference} index @param {URL} url */
function validateIndexReference(index,url) {
  if (!isSearchIndexProxyURL(url, "https://voiceofml-search.hf.space") ||
      !Number.isSafeInteger(index.bytes) || index.bytes <= 0 || index.bytes > PACKED_LIMIT ||
      !/^[0-9a-f]{64}$/.test(index.sha256)) throw new Error("全文搜索索引无效");
}
/** @param {AbortController} controller @returns {Promise<import('../reader-chapter-search-core.mjs').SearchChapter[]>} */
async function fetchIndex(controller) {
  if (!configuration) throw new Error("全文搜索索引无效");
  const { index, chapters: expected } = configuration;
  const url = new URL(index.url, self.location.origin);
  validateIndexReference(index,url);
  const response = await fetch(url, { signal: controller.signal, credentials: "omit" });
  if (!response.ok) throw new Error(`全文搜索加载失败（HTTP ${response.status}），请重试`);
  const bytes = await readBounded(response.body, PACKED_LIMIT, controller.signal);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  if (bytes.length !== index.bytes || sha !== index.sha256) throw new Error("全文搜索索引校验失败，请重试");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await readBounded(stream, TEXT_LIMIT, controller.signal);
  /** @type {unknown} */
  const raw = JSON.parse(new TextDecoder().decode(text));
  const loaded = validateIndex(raw, expected, index.text_profile);
  if (controller.signal.aborted) throw aborted();
  chapters = loaded;
  return loaded;
}
async function loadIndex() {
  if (chapters) return chapters;
  if (indexPromise) return indexPromise;
  const controller = new AbortController();
  loadController = controller;
  const timer = setTimeout(() => controller.abort(), 60000);
  indexPromise = fetchIndex(controller).finally(() => {
    clearTimeout(timer);
    indexPromise = undefined;
    if (loadController === controller) loadController = null;
  });
  return indexPromise;
}
/** @param {string} query @param {number} id @param {() => boolean} current @param {{postMessage(message: unknown): void}} scope */
async function beginSearch(query,id,current,scope) {
  session = null;
  query = String(query || "").trim().replace(/\s+/gu, " ");
  if (!query || query.length > 2048) throw new Error("请输入 1–2048 个字符");
  if (loadController?.signal.aborted) await indexPromise?.catch(() => {});
  const book=await loadIndex();
  if (!current()) return;
  const counts=await countMatches(book,query,current,async partial=>{
    if (current()) scope.postMessage({id,progress:true,total:partial.total,scanned:partial.scanned,
      chapters:book.length,offset:0,pageSize:PAGE_SIZE,results:partial.firstPage.slice()});
  });
  session={...counts,query,id};
}
/** @param {number} requested @param {number} expected */
function pageOffset(requested,expected) {
  if (!session || expected !== session.id) throw aborted();
  return Math.max(0,Math.min(Math.floor(requested/PAGE_SIZE)*PAGE_SIZE,
    Math.max(0,Math.ceil(session.total/PAGE_SIZE)-1)*PAGE_SIZE));
}

/** @param {unknown} error */
function requestError(error) {
  const detail=error instanceof Error ? error : new Error(String(error));
  return detail.name === "AbortError" ? "全文搜索已取消或加载超时，请重试" : detail.message;
}
/** @param {Extract<ChapterMessage,{type:'search'|'page'}>} data @param {{postMessage(message: unknown): void}} scope */
async function handleRequest(data,scope) {
  const token=++active,current=()=>token===active;
  try {
    let offset=0;
    if (data.type === "search") {
      await beginSearch(String(data.query || ""),data.id,current,scope);
      if (!current()) return;
    } else offset=pageOffset(data.offset,data.session);
    if (!session || !chapters) throw aborted();
    const result=offset ? await resultPage(chapters,session.query,session.counts,offset,current) : session.firstPage.slice();
    if (current()) scope.postMessage({id:data.id,session:session.id,total:session.total,
      offset,pageSize:PAGE_SIZE,results:result});
  } catch (error) {
    if (current()) scope.postMessage({id:data.id,error:requestError(error)});
  }
}
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  const scope = self;
  scope.onmessage = event => {
    /** @type {unknown} */
    const data=event.data;
    if (!isMessage(data)) {
      if (isRecord(data) && data.type === 'init') configuration=undefined;
      if (isRecord(data) && typeof data.id === 'number') scope.postMessage({id:data.id,error:'全文搜索索引无效'});
      return;
    }
    if (data.type === "init") { configuration = data.configuration; return; }
    if (data.type === "cancel") { active++; session = null; loadController?.abort(); return; }
    return handleRequest(data,scope);
  };
}

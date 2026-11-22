import assert from "node:assert/strict";
import {countMatches, queryBigramFilters, resultPage, scanText}
  from "../../../static/reader/search/reader-chapter-search-core.mjs";
import {validateIndex} from "../../../static/reader/search/reader-chapter-search-index.mjs";
import {isSearchIndexProxyURL} from "../../../static/reader/search/reader-chapter-search-proxy-url.mjs";

const origin = "https://voiceofml-search.hf.space";
const indexURL = path => new URL(origin + "/api/reader-bucket-resource?path=" + encodeURIComponent(path));
const prefix = "chapters/ebook/epub/" + "a".repeat(64) + "/" + "b".repeat(16) + "/";
assert.ok(isSearchIndexProxyURL(new URL(origin + "/api/reader-content?url=source"), origin));
assert.equal(isSearchIndexProxyURL(new URL(origin + "/api/unrelated?path=book"), origin), false);
for (const extension of ["epub", "mobi", "azw3", "fb2", "chm"])
  assert.ok(isSearchIndexProxyURL(indexURL(prefix.replace("/epub/", "/" + extension + "/") + "epub-search-index.json.gz"), origin));
for (const path of [prefix + "chapter-manifest.json", prefix + "chapters/chapter-0001.xhtml",
                    prefix + "../epub-search-index.json.gz", prefix + "%2e%2e/epub-search-index.json.gz",
                    prefix.replace("/epub/", "/pdf/") + "epub-search-index.json.gz"])
  assert.equal(isSearchIndexProxyURL(indexURL(path), origin), false, path);
for (const url of [indexURL(prefix + "epub-search-index.json.gz").href + "&path=other",
                   indexURL(prefix + "epub-search-index.json.gz").href + "&other=1",
                   indexURL(prefix + "epub-search-index.json.gz").href + "#fragment",
                   indexURL(prefix + "epub-search-index.json.gz").href.replace("https://", "https://user@"),
                   indexURL(prefix + "epub-search-index.json.gz").href.replace(origin, "https://other.hf.space")])
  assert.equal(isSearchIndexProxyURL(new URL(url), origin), false, url);

const chapters = [
  { index: 1, title: "开头", path: "chapters/1.xhtml", text: "手机 手。机 a+b [term] " + "needle ".repeat(125) },
  { index: 2, title: "结尾", path: "chapters/2.xhtml", text: "needle ".repeat(130) + "远方命中" }
];
const progressPages = [];
const counted = await countMatches(chapters, "needle", () => true, partial => {
  assert.deepEqual(Object.keys(partial).sort(), ['firstPage', 'scanned', 'total']);
  progressPages.push({ total: partial.total, scanned: partial.scanned, results: partial.firstPage.slice() });
});
assert.equal(counted.total, 255);
assert.deepEqual(counted.counts, [125, 130]);
assert.deepEqual(progressPages.map(({scanned}) => scanned), [1, 2]);
assert.equal(progressPages[0].total, 125);
assert.equal(progressPages[0].results.length, 50);
assert.equal(progressPages.at(-1).total, 255);
assert.ok(counted.checkpoints.length >= 1);
const checkpointed = await countMatches([{ index: 3, title: "检查点", path: "chapters/3.xhtml", text: "needle ".repeat(600) }], "needle", () => true);
assert.deepEqual(checkpointed.checkpoints.map(checkpoint => checkpoint.ordinal), [0, 256, 512]);
// Compare accelerated paging against an independent full scan, including a
// checkpoint at the last hit of chapter one and a chapter with no results.
const denseBook = [257, 0, 280].map((count, i) => ({index:i+1, title:`Part ${i+1}`,
  path:`chapters/${i+1}.xhtml`, text:"😀 " + "needle ".repeat(count)}));
const dense = await countMatches(denseBook, "needle", () => true);
assert.deepEqual(dense.counts, [257, 0, 280]);
assert.deepEqual(dense.checkpoints.map(({ordinal}) => ordinal), [0, 256, 512]);
const oracle = denseBook.flatMap(chapter => [...chapter.text.matchAll(/needle/g)]
  .map(match => [chapter.index, match.index, match[0].length]));
for (const offset of [255, 256, 257, 500, 511, 512, 513, 536, 537]) {
  const page = await resultPage(denseBook, "needle", dense.counts, offset, () => true, dense.checkpoints);
  assert.deepEqual(page.map(hit => [hit.chapterIndex, hit.start, hit.length]), oracle.slice(offset, offset+50), `offset ${offset}`);
}
assert.deepEqual(counted.firstPage, await resultPage(chapters, "needle", counted.counts, 0, () => true, counted.checkpoints));
assert.deepEqual(await resultPage(chapters, "needle", [], 0, () => true), [],
  "a partial count snapshot must not return hits from chapters it has not counted");
const all = [];
for (let offset = 0; offset < counted.total; offset += 50) {
  const page = await resultPage(chapters, "needle", counted.counts, offset, () => true, counted.checkpoints);
  assert.ok(page.length <= 50);
  all.push(...page);
}
assert.equal(new Set(all.map(item => `${item.chapterIndex}:${item.start}`)).size, 255);
assert.equal(all.at(-1).chapterIndex, 2);
for (const query of ["手机", "手。机", "a+b", "[term]", "远方命中"])
  assert.equal((await countMatches(chapters, query, () => true)).total, 1, query);
const boundaryText = "x".repeat(65534) + "跨边界😀" + "y".repeat(65536) + "跨边界😀";
const found = [];
await scanText(boundaryText, "跨边界😀", (start, length) => found.push([start, length]));
assert.deepEqual(found.map(([start, length]) => boundaryText.slice(start, start + length)), ["跨边界😀", "跨边界😀"]);
// The first UTF-16 code unit of the emoji falls at the end of a scan chunk.
const emojiChapter = {index:1,title:"Unicode",path:"emoji.xhtml",text:"x".repeat(65535) + "😀手机"};
const emojiMatch = (await countMatches([emojiChapter], "😀手机", () => true)).firstPage;
assert.deepEqual(emojiMatch.map(hit => [hit.start, hit.length]), [[65535, 4]]);
const emojiSnippet = emojiMatch[0].snippet;
assert.equal(emojiSnippet.text.slice(emojiSnippet.matchStart, emojiSnippet.matchStart + emojiSnippet.matchLength), "😀手机");
const repeatedHits = [];
await scanText("x".repeat(65535) + "aaaaa", "aa", (start, length) => repeatedHits.push([start, length]));
assert.deepEqual(repeatedHits, [[65535, 2], [65537, 2]]);
const resumed = [];
await scanText("skip needle then needle", "needle", (start, length) => resumed.push([start, length]),
  () => true, async () => {}, 10, /needle/giu);
assert.deepEqual(resumed, [[17, 6]]);
let current = true;
const cancelled = scanText("x".repeat(1000000), "x", () => { current = false; }, () => current);
await assert.rejects(cancelled, { name: "AbortError" });
assert.equal(validateIndex({ version: 1, kind: "epub-search-index", chapters }, chapters).length, 2);
const indexedChapters = validateIndex({
  version: 2,
  kind: "epub-search-index",
  chapters: [
    { index: 1, title: "命中", path: "chapters/1.xhtml", text: "读手机书", bf: "CP0BAEAAAAAgAgIAEAAAAIRAAAAAAACAIAgAAAABAAA=" },
    { index: 2, title: "排除", path: "chapters/2.xhtml", text: "桌面电脑", bf: "AAAAYgAAAAACAAQQQAghAAAEAAAAgAAAhACIAAIIAAE=" }
  ]
}, [
  { index: 1, title: "命中", path: "chapters/1.xhtml" },
  { index: 2, title: "排除", path: "chapters/2.xhtml" }
]);
assert.equal(queryBigramFilters("MOBILE"), null);
const filteredCount = await countMatches(indexedChapters, "手机", () => true);
const fullScanCount = await countMatches(indexedChapters.map(({ bigramFilter, ...chapter }) => chapter), "手机", () => true);
assert.equal(filteredCount.total, 1);
assert.deepEqual(filteredCount.counts, fullScanCount.counts);
assert.deepEqual(await resultPage(indexedChapters, "手机", filteredCount.counts, 0, () => true),
  filteredCount.firstPage);
assert.throws(() => validateIndex({ version: 1, kind: "epub-search-index", chapters: chapters.slice(0, 1) }, chapters));
assert.throws(() => validateIndex({ version: 1, kind: "epub-search-index", chapters: [chapters[1], chapters[0]] }, chapters));
const exactIndex = { version: 1, kind: "epub-search-index", text_profile: "dom-text-v1", chapters };
assert.equal(validateIndex(exactIndex, chapters, "dom-text-v1").length, 2);
assert.throws(() => validateIndex(exactIndex, chapters));
assert.throws(() => validateIndex({ version: 1, kind: "epub-search-index", chapters }, chapters, "dom-text-v1"));
assert.throws(() => validateIndex({ ...exactIndex, text_profile: "unknown" }, chapters, "unknown"));
const literals = [{ index: 1, title: "literal", path: "chapters/1.xhtml", text: "&#0 &nbsp; ".repeat(70) }];
const literalCounts = await countMatches(literals, "&nbsp;", () => true);
assert.equal(literalCounts.total, 70);
assert.equal((await resultPage(literals, "&nbsp;", literalCounts.counts, 50, () => true)).length, 20);
// The same pure search logic serves both Worker backends. A sparse Bloom
// filter may reject a chapter, whereas an all-ones filter never does.
{
  const chapter = {index: 1, title: "filter", path: "1", text: "手机", bigramFilter: new Uint8Array(32)};
  assert.equal((await countMatches([chapter], "手机", () => true)).total, 0);
  chapter.bigramFilter.fill(255);
  assert.equal(queryBigramFilters("A"), null);
  assert.equal((await countMatches([chapter], "手机", () => true)).total, 1);
}
// Version-1 historical JSON can contain array-like filter properties rather
// than the decoded Uint8Array; preserve the old coercion and bit decisions.
{
  const bloom = Object.assign({length:32}, Object.fromEntries(Array.from({length:32}, (_, i) => [i,255])));
  const chapter = {index:1,title:42,path:"one",text:"手机",bigramFilter:bloom};
  const total = async () => (await countMatches([chapter], "手机", () => true)).total;
  assert.equal(await total(), 1);
  for (let i=0;i<32;i++) bloom[i]=0;
  assert.equal(await total(), 0);
  chapter.bigramFilter = {};
  assert.equal(await total(), 0);
}
// Force a cooperative yield without timing dependence. The currentness guard
// executes inside the real scan; after the yield it must check cancellation.
{
  const realPerformance = globalThis.performance;
  let now = 0;
  try {
    Object.defineProperty(globalThis, "performance", {configurable: true, value: {now: () => now}});
    const chapter = {index: 1, title: "yield", path: "1", text: "x".repeat(65536 * 3)};
    const result = await countMatches([chapter], "z", () => { now += 9; return true; });
    assert.equal(result.total, 0);
  } finally { Object.defineProperty(globalThis, "performance", {configurable: true, value: realPerformance}); }
}
// Boundary offsets, early stop, cancellation and Bloom-filter skips are
// exercised independently of the Worker transport and index loader.
{
  let visited = 0, yielded = 0;
  await scanText("needle needle", "needle", () => { visited++; return false; }, () => true,
    async () => { yielded++; });
  assert.equal(visited, 1); assert.equal(yielded, 0);
  await assert.rejects(scanText("needle", "needle", () => {}, () => false), {name:"AbortError"});
  const chapter = {index:1,title:"x",path:"1",text:"needle ".repeat(600)};
  const count = await countMatches([chapter], "needle", () => true);
  assert.equal((await resultPage([chapter], "needle", count.counts, 200, () => true, count.checkpoints)).length, 50);
  await assert.rejects(resultPage([chapter], "needle", count.counts, 1, () => false), {name:"AbortError"});
  const filtered = {index:2,title:"x",path:"2",text:"手机",bigramFilter:new Uint8Array(32)};
  assert.deepEqual(await resultPage([filtered], "手机", [1], 0, () => true), []);

  // Cancellation can arrive while yielding after the final chunk. The scan
  // must not report a successful completion or visit another hit.
  let live = true;
  const hits = [];
  await assert.rejects(scanText("a needle", "needle", (offset, length) => hits.push([offset, length]),
    () => live, async () => { live = false; }), {name:"AbortError"});
  assert.deepEqual(hits, [[2, 6]]);

  const withoutCheckpoint = await resultPage(chapters, "needle", counted.counts, counted.counts[0], () => true);
  assert.equal(withoutCheckpoint.length, 50);
  assert.ok(withoutCheckpoint.every(hit => hit.chapterIndex === 2));
  assert.deepEqual(withoutCheckpoint.map(hit => hit.start), Array.from({length: 50}, (_, i) => i * 7));
}
// Index identity, chapter alignment and Bloom-filter shape are checked before
// the Worker can search anything. Successful validation returns and updates
// the original records, matching the existing worker contract.
{
  const expected=[{index:1,path:'one.xhtml',title:'First'}];
  const entry={index:1,path:'one.xhtml',text:'手机',bf:btoa(String.fromCharCode(...new Uint8Array(32).fill(255)))};
  const data={version:2,kind:'epub-search-index',text_profile:'dom-text-v1',chapters:[entry]};
  const validated=validateIndex(data,expected,'dom-text-v1');
  assert.strictEqual(validated,data.chapters);assert.strictEqual(validated[0],entry);
  assert.equal(entry.title,'First');assert.equal('bf' in entry,false);assert.equal(entry.bigramFilter.length,32);
  const unfiltered = {version:2,kind:'epub-search-index',chapters:[{index:1,path:'one.xhtml',text:'手机'}]};
  assert.equal((await countMatches(validateIndex(unfiltered,expected), '手机', () => true)).total,1);
  assert.throws(() => validateIndex({...unfiltered, chapters:[{...unfiltered.chapters[0],index:2}]},expected),
    /全文搜索索引与章节不一致/);
  const nonString={version:2,kind:'epub-search-index',chapters:[{index:1,path:'one.xhtml',text:'x',bf:7}]};
  assert.throws(()=>validateIndex(nonString,expected),/全文搜索过滤索引无效/);
  for(const invalid of ['!',btoa('x'.repeat(31)),btoa('x'.repeat(33)),btoa('x'.repeat(65536))]) {
    const index={version:2,kind:'epub-search-index',chapters:[{index:1,path:'one.xhtml',text:'x',bf:invalid}]};
    assert.throws(()=>validateIndex(index,expected),/全文搜索过滤索引无效/);
  }
  for(const value of [null,{}, {version:3,kind:'epub-search-index',chapters:[]},
      {version:1,kind:'other',chapters:[]}, {version:1,kind:'epub-search-index',chapters:'not-array'}])
    assert.throws(()=>validateIndex(value,expected),/全文搜索索引不完整/);
  for(const value of [null,{}, {index:1,path:'wrong.xhtml',text:'x'}, {index:1,path:'one.xhtml',text:42}]) {
    const index={version:1,kind:'epub-search-index',chapters:[value]};
    assert.throws(()=>validateIndex(index,expected),/全文搜索索引与章节不一致/);
  }
  const emptyTitle={version:1,kind:'epub-search-index',chapters:[{index:1,path:'one.xhtml',text:'x'}]};
  assert.throws(() => validateIndex(emptyTitle, Array(1)), /全文搜索索引与章节不一致/,
    'matching array length alone does not establish chapter identity');
  assert.equal(validateIndex(emptyTitle,[{index:1,path:'one.xhtml'}])[0].title,'章节 1');
}
console.log("chapter search: complete counts, paging, literal matches, Unicode boundaries, cancellation and index identity passed");

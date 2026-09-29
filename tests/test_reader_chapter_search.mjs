import assert from "node:assert/strict";
import {
  chapterMayContainBigrams, countMatches, queryBigramFilters, resultPage, scanText, validateIndex
} from "../static/reader-chapter-search-worker.mjs";

const chapters = [
  { index: 1, title: "开头", path: "chapters/1.xhtml", text: "手机 手。机 a+b [term] " + "needle ".repeat(125) },
  { index: 2, title: "结尾", path: "chapters/2.xhtml", text: "needle ".repeat(130) + "远方命中" }
];
const progressPages = [];
const counted = await countMatches(chapters, "needle", () => true, partial => {
  progressPages.push({ total: partial.total, results: partial.firstPage.slice() });
});
assert.equal(counted.total, 255);
assert.deepEqual(counted.counts, [125, 130]);
assert.equal(progressPages[0].total, 125);
assert.equal(progressPages[0].results.length, 50);
assert.equal(progressPages.at(-1).total, 255);
assert.ok(counted.checkpoints.length >= 1);
const checkpointed = await countMatches([{ index: 3, title: "检查点", path: "chapters/3.xhtml", text: "needle ".repeat(600) }], "needle", () => true);
assert.deepEqual(checkpointed.checkpoints.map(checkpoint => checkpoint.ordinal), [0, 256, 512]);
assert.deepEqual(counted.firstPage, await resultPage(chapters, "needle", counted.counts, 0, () => true, counted.checkpoints));
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
const filters = queryBigramFilters("手机");
assert.ok(chapterMayContainBigrams(indexedChapters[0], filters));
assert.equal(chapterMayContainBigrams(indexedChapters[1], filters), false);
assert.equal(queryBigramFilters("MOBILE"), null);
const filteredCount = await countMatches(indexedChapters, "手机", () => true);
const fullScanCount = await countMatches(indexedChapters.map(({ bigramFilter, ...chapter }) => chapter), "手机", () => true);
assert.equal(filteredCount.total, 1);
assert.deepEqual(filteredCount.counts, fullScanCount.counts);
assert.deepEqual(await resultPage(indexedChapters, "手机", filteredCount.counts, 0, () => true),
  filteredCount.firstPage);
assert.throws(() => validateIndex({ version: 1, kind: "epub-search-index", chapters: chapters.slice(0, 1) }, chapters));
assert.throws(() => validateIndex({ version: 1, kind: "epub-search-index", chapters: [chapters[1], chapters[0]] }, chapters));
console.log("chapter search: complete counts, paging, literal matches, Unicode boundaries, cancellation and index identity passed");

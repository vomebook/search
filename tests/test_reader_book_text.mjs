import assert from "node:assert/strict";
import { hitBoxes, searchBookText } from "../static/reader-book-text.js";

const spans = [
  { start: 0, end: 1, box: [0, 0, 0.2, 1], block: 0 },
  { start: 1, end: 4, box: [0.2, 0, 0.6, 1], block: 1 },
  { start: 4, end: 9, box: [0.6, 0, 1, 1], block: 2 }
];
const first = { page: 1, text: "😀abcneedle", text_spans: spans };
assert.deepEqual(hitBoxes(first, 2, 3).map(hit => hit.block), [1]);
assert.deepEqual(hitBoxes(first, 5, 6).map(hit => hit.block), [2]);

const pages = [first, ...Array.from({ length: 5 }, (_, index) => ({
  page: index + 2, text: "needle ".repeat(61), text_spans: []
}))];
let partial;
const index = await searchBookText({ pages }, "needle", {
  yieldTask: async () => {},
  progress: (value, scanned) => {
    if (scanned === 1) partial = value.page(0);
  }
});
assert.equal(partial.total, 1);
assert.equal(index.total, 306);
const deep = index.page(250);
assert.equal(deep.results.length, 50);
assert.equal(deep.results[0].page, 6);
assert.equal(index.page(250), deep);
assert.notEqual(index.page(0).total, partial.total);
assert.equal(index.page(0).results[0].boxes[0].block, 2);

const unicodePage = { page: 1, text: "😀needle ".repeat(110), text_spans: Array.from({ length: 110 }, (_, block) => ({
  start: block * 8 + 1, end: block * 8 + 7, box: [0, 0, 1, 1], block
})) };
const unicodeIndex = await searchBookText({ pages: [unicodePage] }, "needle", { yieldTask: async () => {} });
for (const offset of [0, 50, 100]) {
  const result = unicodeIndex.page(offset);
  assert.equal(result.results[0].boxes[0].block, offset);
  assert.equal(result.results.at(-1).boxes[0].block, Math.min(offset + 49, 109));
}
console.log("reader book text search contracts passed");

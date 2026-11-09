import assert from "node:assert/strict";
import { hitBoxes, searchBookText, validateBookText } from "../../../static/reader/search/reader-book-text.js";

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

const deepBook = { pages: Array.from({ length: 3 }, (_, page) => ({
  page: page + 1, text: "needle ".repeat(300), text_spans: []
})) };
const deepIndex = await searchBookText(deepBook, "needle", { yieldTask: async () => {} });
assert.equal(deepIndex.page(500).results[0].page, 2);
assert.equal(deepIndex.page(500).results[0].start, 200 * "needle ".length);

// Differential oracle for the box-free v3 partition path and legacy box pages.
// Full result equality covers totals, UTF-16 offsets, snippets and mappings.
function bruteBookPage(book, query, requested, pageSize) {
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const hits = [];
  for (const page of book.pages) for (const match of page.text.matchAll(re)) {
    const start = match.index, length = match[0].length;
    const begin = Math.max(0, start - 72), end = Math.min(page.text.length, start + length + 88);
    hits.push({page:page.page,start,length,boxes:hitBoxes(page,start,length),
      snippet:{text:page.text.slice(begin,end),matchStart:start-begin,matchLength:length,
        prefix:begin?"…":"",suffix:end<page.text.length?"…":""}});
  }
  let offset = Math.max(0, Math.min(Math.max(0, hits.length - 1), Math.floor(requested)));
  offset = Math.floor(offset / pageSize) * pageSize;
  return {total:hits.length,offset,pageSize,results:hits.slice(offset,offset+pageSize)};
}
const mixedBook = {pages:[
  {page:1,text:("😀needle 中文 ".repeat(480))+"end"},
  {page:2,text:"😀needle 😀Needle needle",text_spans:[]},
  {page:3,text:"😀needle 中文 needle",text_spans:[
    {start:1,end:7,box:[0,0,.4,1],block:1,precision:"glyph"},
    {start:11,end:17,box:[.5,0,1,1],block:2} ]},
]};
for (const query of ["needle", "😀", "中文", "Needle", "absent"]) {
  const candidate = await searchBookText(mixedBook, query, {yieldTask:async()=>{}});
  for (const size of [1,13,50,51]) for (const offset of [0,1,49,50,255,256,477,10000])
    assert.deepEqual(candidate.page(offset,size),bruteBookPage(mixedBook,query,offset,size),
      JSON.stringify({query,size,offset}));
}
// Validate box-free pages without scanning their contents, while retaining
// every normal envelope and mapping validation for pages with boxes.
const validBook = {version:2,kind:"pdf-book-text",complete:true,offset_unit:"unicode-codepoint",page_count:1,
  source_sha256:"fixture",pages:[{page:1,text:"😀ab".repeat(20000),layout:{offset_unit:"unicode-codepoint"},text_spans:[]}]};
const originalCodePointIterator = String.prototype[Symbol.iterator];
let validationUnits = 0;
String.prototype[Symbol.iterator] = function (...args) {validationUnits += this.length;return originalCodePointIterator.apply(this,args);};
try {assert.equal(validateBookText(validBook,1,"fixture"),validBook);assert.equal(validationUnits,0);}
finally {String.prototype[Symbol.iterator] = originalCodePointIterator;}
const mappedBook = structuredClone(validBook);
mappedBook.pages[0].text = "😀abc";
mappedBook.pages[0].text_spans = [{start:1,end:4,box:[0,0,1,1]}];
assert.equal(validateBookText(mappedBook,1,"fixture"),mappedBook);
for (const span of [
  {start:1,end:5,box:[0,0,1,1]}, {start:0,end:1,box:[1,0,0,1]},
  {start:0,end:1,box:[0,0,1,Infinity]}, {start:0,end:0,box:[0,0,1,1]},
]) {
  mappedBook.pages[0].text_spans = [span];
  assert.throws(()=>validateBookText(mappedBook,1,"fixture"),/PDF_TEXT_MAPPING_INVALID/);
}
assert.throws(()=>validateBookText(validBook,2,"fixture"),/PDF_TEXT_INDEX_INCOMPLETE/);
assert.throws(()=>validateBookText(validBook,1,"wrong"),/PDF_TEXT_INDEX_INCOMPLETE/);
const invalidPage = structuredClone(validBook);invalidPage.pages[0].layout.offset_unit = "utf16";
assert.throws(()=>validateBookText(invalidPage,1,"fixture"),/PDF_TEXT_INDEX_INVALID/);

// Count the code-point iterator to detect a regression to a page-prefix scan,
// without relying on a device-specific timing threshold.
const longPartition = {pages:[{page:1,text:"😀needle ".repeat(20000)}]};
const originalIterator = String.prototype[Symbol.iterator];
let iteratedUnits = 0, longIndex;
String.prototype[Symbol.iterator] = function (...args) {
  iteratedUnits += this.length;
  return originalIterator.apply(this,args);
};
try {
  longIndex = await searchBookText(longPartition,"needle",{yieldTask:async()=>{}});
  iteratedUnits = 0;
  const result = longIndex.page(15000);
  assert.equal(result.results.length,50);
  assert.equal(result.results[0].start,15000*"😀needle ".length+2);
  assert.equal(iteratedUnits,0,"box-free pages must not count prefix code points");
} finally { String.prototype[Symbol.iterator] = originalIterator; }

// Page scanning cooperates with Worker cancellation without a timer per tiny
// set of pages. A deterministic fake clock proves the deadline and byte guard.
const schedulerClock=globalThis.performance;
try {
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>0}});
  let yields=0;
  const short={pages:Array.from({length:160},(_,index)=>({page:index+1,text:'x needle'}))};
  let fast=await searchBookText(short,'needle',{yieldTask:async()=>{yields++;}});
  assert.equal(fast.total,160);assert.equal(yields,0,'tiny pages should not schedule unnecessary timers');
  const bulky={pages:Array.from({length:40},(_,index)=>({page:index+1,text:'x'.repeat(20000)}))};
  yields=0;fast=await searchBookText(bulky,'absent',{yieldTask:async()=>{yields++;}});
  assert.equal(fast.total,0);assert.ok(yields>0,'byte budget must yield even when the clock does not advance');
  let live=true,firstYield;
  const blocked=new Promise(resolve=>{firstYield=resolve;});
  const cancelled=searchBookText(bulky,'absent',{current:()=>live,yieldTask:async()=>{
    firstYield();await new Promise(resolve=>{globalThis.__releaseBookTextYield=resolve;});}});
  await blocked;live=false;globalThis.__releaseBookTextYield();delete globalThis.__releaseBookTextYield;
  await assert.rejects(cancelled,error=>error.name==='AbortError');
  let finalLive=true,releaseFinal,startedFinal;
  const finalWaiting=new Promise(resolve=>{startedFinal=resolve;});
  const final=searchBookText({pages:[{page:1,text:'x'.repeat(300000)}]},'missing',{
    current:()=>finalLive,yieldTask:()=>new Promise(resolve=>{releaseFinal=resolve;startedFinal();})});
  await finalWaiting;finalLive=false;releaseFinal();
  await assert.rejects(final,error=>error.name==='AbortError','cancellation at the final yield must not resolve a stale index');
  yields=0;
  const dense={pages:[{page:1,text:'x'.repeat(4096)}]};
  const denseResult=await searchBookText(dense,'x',{yieldTask:async()=>{yields++;}});
  assert.equal(denseResult.total,4096);assert.equal(yields,2,'dense-match cancellation checkpoints remain unchanged');
  let clock=0;Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>clock+=9}});
  yields=0;await searchBookText(short,'needle',{yieldTask:async()=>{yields++;}});
  assert.ok(yields>0,'elapsed-time budget must retain cooperative yields');
} finally {Object.defineProperty(globalThis,'performance',{configurable:true,value:schedulerClock});}

console.log("reader book text search contracts passed");

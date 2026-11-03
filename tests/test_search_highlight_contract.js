const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Expectations were pinned against the original app.js before extraction.
function extractedFunctions() {
  const context = vm.createContext({});
  const filename = path.join(__dirname, "../static/search/highlight.js");
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, {filename});
  return {context, escapeHTML: context.escapeHTML, highlightText: context.highlightText,
    getHighlightRegex: context.getHighlightRegex};
}

test("HTML escaping preserves text and protects attribute and markup delimiters", () => {
  const {escapeHTML} = extractedFunctions();
  for (const [input, expected] of [
    ["A&B <tag> \" ' 中文", "A&amp;B &lt;tag&gt; &quot; &#39; 中文"],
    ["&amp;", "&amp;amp;"],
    ["", ""],
    [null, "null"],
    [undefined, "undefined"],
    [0, "0"],
    [false, "false"]
  ]) assert.equal(escapeHTML(input), expected);
});

test("highlighting matches raw text without marking tags or encoded entities", () => {
  const {highlightText} = extractedFunctions();
  const cases = [
    ["Tom & Jerry", "tom amp", "<mark>Tom</mark> &amp; Jerry"],
    ["abcab", "ab abc", "<mark>abc</mark><mark>ab</mark>"],
    ["<img src=x onerror='x'>", "img", "&lt;<mark>img</mark> src=x onerror=&#39;x&#39;&gt;"],
    ["<script>alert('x')</script>", "script", "&lt;<mark>script</mark>&gt;alert(&#39;x&#39;)&lt;/<mark>script</mark>&gt;"],
    ["A+B a.b [C] $5 (x)", "a+b a.b [c] $5 (x)",
      "<mark>A+B</mark> <mark>a.b</mark> <mark>[C]</mark> <mark>$5</mark> <mark>(x)</mark>"],
    ["中文😀 中文", "中文😀", "<mark>中文😀</mark> 中文"],
    ["a & b", "   ", "a &amp; b"],
    ["a & b", "", "a &amp; b"],
    [null, "a", "null"],
    [undefined, "a", "undefined"],
    [0, "a", "0"]
  ];
  for (const [text, query, expected] of cases) assert.equal(highlightText(text, query), expected);
});

test("highlight regexp is case-insensitive, deduplicated, reusable and literal", () => {
  const {getHighlightRegex, highlightText} = extractedFunctions();
  const regex = getHighlightRegex("ab ABC ab");
  assert.equal(regex.flags, "gi");
  assert.equal(regex.source, "ABC|ab");
  assert.equal(highlightText("AbC ab AB", "ab ABC ab"), "<mark>AbC</mark> <mark>ab</mark> <mark>AB</mark>");
  assert.equal(highlightText("AB", "ab ABC ab"), "<mark>AB</mark>");
  assert.equal(regex.lastIndex, 0);
  assert.equal(getHighlightRegex("   "), null);
  assert.throws(() => getHighlightRegex(42), {name: "TypeError"});
});

test("highlight cache is bounded FIFO and a hit does not change insertion order", () => {
  const {getHighlightRegex} = extractedFunctions();
  const first = getHighlightRegex("key0");
  const second = getHighlightRegex("key1");
  for (let i = 2; i < 20; i++) getHighlightRegex(`key${i}`);
  assert.equal(getHighlightRegex("key0"), first);
  getHighlightRegex("key20");
  assert.equal(getHighlightRegex("key1"), second);
  assert.notEqual(getHighlightRegex("key0"), first);
});

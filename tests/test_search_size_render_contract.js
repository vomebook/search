const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Expected behavior was pinned before extraction, separately from URL sizes.
function extractedFormatter() {
  const context = vm.createContext({});
  const filename = path.join(__dirname, "../static/search/size-format.js");
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, {filename});
  return context.formatSize;
}

test("display preserves binary boundaries and historical precision", () => {
  const formatSize = extractedFormatter();
  for (const [input, expected] of [
    [0, ""], [1, "1 B"], [1023, "1023 B"], [1024, "1.0 KB"], [1536, "1.5 KB"],
    [1048575, "1024.0 KB"], [1048576, "1.0 MB"], [1572864, "1.5 MB"],
    [1073741823, "1024.0 MB"], [1073741824, "1.00 GB"], [1610612736, "1.50 GB"],
    [-3, "-3 B"], [1.5, "1.5 B"], [Infinity, "Infinity GB"]
  ]) assert.equal(formatSize(input), expected, String(input));
});

test("display retains original coercion and empty-value behavior", () => {
  const formatSize = extractedFormatter();
  for (const [input, expected] of [
    [null, ""], [undefined, ""], [false, ""], [NaN, ""], ["", ""], ["0", ""],
    ["000", ""], ["  ", ""], ["1024", "1.0 KB"], ["2e3", "2 B"],
    ["1.5", "1 B"], ["0x10", "16 B"], ["invalid", ""], [true, "true B"]
  ]) assert.equal(formatSize(input), expected, String(input));
});

test("display retains prototype and normalized cache behavior", () => {
  const formatSize = extractedFormatter();
  assert.equal(typeof formatSize("toString"), "function");
  assert.equal(typeof formatSize("__proto__"), "object");
  assert.equal(formatSize("1.5"), "1 B");
  assert.equal(formatSize(1.5), "1.5 B");
  assert.equal(formatSize(1024), "1.0 KB");
  assert.equal(formatSize("1024"), "1.0 KB");
  const stringFirst = extractedFormatter();
  assert.equal(stringFirst("1.5"), "1 B");
  assert.equal(stringFirst(1.5), "1.5 B");
  const numericFirst = extractedFormatter();
  assert.equal(numericFirst(1.5), "1.5 B");
  assert.equal(numericFirst("1.5"), "1.5 B");
  const infinityFirst = extractedFormatter();
  assert.equal(infinityFirst("Infinity"), "");
  assert.equal(infinityFirst(Infinity), "Infinity GB");
  const numericInfinityFirst = extractedFormatter();
  assert.equal(numericInfinityFirst(Infinity), "Infinity GB");
  assert.equal(numericInfinityFirst("Infinity"), "Infinity GB");
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The expectations were captured from the original functions in app.js.
const sandbox = vm.createContext({});
const filename = path.join(__dirname, "../static/search/size-format.js");
vm.runInContext(fs.readFileSync(filename, "utf8"), sandbox, {filename});
const {bytesToDisplay, fmtSizeUrl, parseSizeStr} = sandbox;
for (const [input, value, unit] of [
  [null, "", "MB"], [undefined, "", "MB"], [0, "0", "B"], [1, "1", "B"],
  [1023, "1023", "B"], [1024, "1", "KB"], [1536, "1.5", "KB"],
  [1048576, "1", "MB"], [1572864, "1.5", "MB"],
  [1073741824, "1", "GB"], [1610612736, "1.5", "GB"]
]) {
  const display = bytesToDisplay(input);
  assert.equal(display.value, value); assert.equal(display.unit, unit);
}
for (const [text, expected] of [
  [null, null], [undefined, null], ["", null], ["0", 0], ["0B", 0],
  ["1 KB", 1024], ["0.5kB", 512], ["1.5MB", 1572864], ["1gb", 1073741824],
  ["3B", 3], ["12 bytes", 12], ["1e3", 1], ["-1", -1], ["garbage", null],
  [" 3MB", 3], ["1.2.3MB", 1258291]
]) assert.equal(parseSizeStr(text), expected, String(text));
assert.ok(Number.isNaN(parseSizeStr(".")));
assert.equal(fmtSizeUrl(null), null); assert.equal(fmtSizeUrl(undefined), null);
assert.equal(fmtSizeUrl(0), "0B"); assert.equal(fmtSizeUrl(1024), "1KB");
assert.equal(fmtSizeUrl(1025), "1025B"); assert.equal(fmtSizeUrl(1048577), "1048577B");
for (const bytes of [0, 1, 1023, 1024, 1025, 1048576, 1048577, 1073741824, 1073741825, Number.MAX_SAFE_INTEGER])
  assert.equal(parseSizeStr(fmtSizeUrl(bytes)), bytes, `URL size round trip: ${bytes}`);
// Preserve the original capture lookup if String.prototype.match is rebound.
vm.runInContext('String.prototype.match = function() { return []; };', sandbox);
assert.ok(Number.isNaN(parseSizeStr("1")));
console.log("search size formatting, parser compatibility and URL round trips passed");

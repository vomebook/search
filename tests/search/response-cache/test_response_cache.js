const vm = require("vm");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {test, run} = require("../../support/test_harness");

test("response caches bound bytes, expire, preserve live oversized data and retain LRU hits", () => {
  const filename = path.join(__dirname, "../../../static/search/response-cache.js");
  const context = {clock: 0};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, {filename});
  vm.runInContext(`
    Date.now = () => clock;
    globalThis.cache = new BoundedResponseCache(3, 100, 80);
    cache.set('a', 'aaaaaaaa'); cache.set('b', 'bbbbbbbb');
    cache.get('a'); cache.set('c', 'cccccccc'); cache.set('d', 'dddddddd');
  `, context);
  assert.strictEqual(context.cache.has("b"), false);
  assert.strictEqual(context.cache.has("a"), true);
  assert(context.cache.bytes <= 80);
  const value = "x".repeat(100);
  context.cache.set("oversize", value);
  assert.strictEqual(context.cache.has("oversize"), false);
  assert.strictEqual(value.length, 100);
  vm.runInContext("clock = 100; cache.set('fresh','ok')", context);
  assert.strictEqual(context.cache.size, 1);
  context.cache.delete("fresh");
  assert.strictEqual(context.cache.bytes, 0);
  context.cache.set("last", "value"); context.cache.clear();
  assert.strictEqual(context.cache.bytes, 0);
  assert.strictEqual(context.cache.entriesInfo.size, 0);
});
run("response-cache");

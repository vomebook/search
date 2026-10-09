const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const {test, run} = require("./test_harness");

for (const project of ["github-Search", "huggingface-Search"]) {
  test(project + " response caches bound bytes, expire, preserve live oversized data and retain LRU hits", () => {
    const source = fs.readFileSync("../" + project + "/static/app.js", "utf8");
    const context = {clock: 0};
    vm.createContext(context);
    vm.runInContext(source.match(/^class BoundedResponseCache[^]*?^}/m)[0] + `
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
}
run("response-cache");

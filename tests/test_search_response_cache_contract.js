const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Expectations were pinned against each site's original cache before extraction.
function fixture(limit = 3, ttl = 100, budget = 100) {
  const context = vm.createContext({clock: 0, limit, ttl, budget});
  const filename = path.join(__dirname, "../static/search/response-cache.js");
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, {filename});
  vm.runInContext(`Date.now = () => clock;
    globalThis.cache = new BoundedResponseCache(limit, ttl, budget);`, context);
  return {context, cache: context.cache, advance(value) {context.clock = value;}};
}

test("cache preserves LRU access order and exact expiration boundary", () => {
  const h = fixture(), c = h.cache;
  assert.equal(c.set("a", "A"), c);
  c.set("b", "B"); c.set("c", "C");
  assert.equal(c.get("a"), "A");
  c.set("d", "D");
  assert.equal(c.has("b"), false);
  assert.deepEqual([...c.keys()], ["c", "a", "d"]);
  h.advance(99); assert.equal(c.get("a"), "A");
  h.advance(100); assert.equal(c.get("a"), undefined);
  assert.equal(c.has("c"), false);
  assert.equal(c.size, 1, "only visited expired entries are deleted by reads");
  c.set("fresh", "F");
  assert.deepEqual([...c.keys()], ["fresh"]);
});

test("has promotes live entries and undefined values throw without insertion", () => {
  const {cache: c} = fixture();
  c.set("a", 1); c.set("b", 2); c.set("c", 3);
  assert.equal(c.has("a"), true);
  c.set("d", 4);
  assert.equal(c.has("b"), false);
  assert.throws(() => c.set("undefined", undefined), {name: "TypeError"});
  assert.equal(c.has("undefined"), false);
});

test("byte accounting bounds entries and bypasses oversize without corrupting survivors", () => {
  const {cache: c} = fixture(8, 100, 30);
  c.set("a", "1234"); // 2 * (key length 1 + JSON length 6) = 14
  c.set("b", "1234");
  assert.equal(c.bytes, 28);
  c.get("a"); c.set("c", "1234");
  assert.equal(c.has("b"), false);
  assert.equal(c.bytes, 28);
  c.set("huge", "x".repeat(100));
  assert.equal(c.has("huge"), false);
  assert.equal(c.bytes, 28);
  assert.equal(c.delete("missing"), false);
  assert.equal(c.delete("a"), true);
  assert.equal(c.bytes, 14);
  c.clear();
  assert.equal(c.size, 0); assert.equal(c.bytes, 0); assert.equal(c.entriesInfo.size, 0);
});

test("replacement resets TTL, byte count and LRU position", () => {
  const h = fixture(3, 100, 100), c = h.cache;
  c.set("a", "old"); c.set("b", "B");
  h.advance(90); c.set("a", "new value");
  assert.deepEqual([...c.keys()], ["b", "a"]);
  h.advance(100); assert.equal(c.get("b"), undefined); assert.equal(c.get("a"), "new value");
  h.advance(190); assert.equal(c.get("a"), undefined); assert.equal(c.bytes, 0);
});

test("oversize replacement and serialization errors retire the previous key", () => {
  const {cache: c} = fixture(5, 100, 80);
  c.set("replace", "old"); c.set("keep", "ok");
  c.set("replace", "x".repeat(100));
  assert.equal(c.has("replace"), false);
  assert.equal(c.get("keep"), "ok");
  c.set("replace", "old");
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => c.set("replace", cyclic), {name: "TypeError"});
  assert.equal(c.has("replace"), false);
  assert.equal(c.get("keep"), "ok");
});

test("the independent one-MiB entry cap rejects larger entries even with a larger total budget", () => {
  const {cache: c} = fixture(5, 100, 4 * 1024 * 1024);
  c.set("keep", {small: true});
  const before = c.bytes;
  c.set("large", {text: "x".repeat(600000)});
  assert.equal(c.has("large"), false);
  assert.deepEqual(c.get("keep"), {small: true});
  assert.equal(c.bytes, before);
});

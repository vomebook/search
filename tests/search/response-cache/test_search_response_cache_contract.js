const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Expectations were pinned against each site's original cache before extraction.
function fixture(limit = 3, ttl = 100, budget = 100) {
  const context = vm.createContext({clock: 0, limit, ttl, budget});
  const filename = path.join(__dirname, "../../../static/search/response-cache.js");
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
  // Access promotes but does not extend the insertion-based TTL.
  h.advance(199); assert.equal(c.get("fresh"), "F");
  h.advance(200); assert.equal(c.get("fresh"), undefined);
  for (const ttl of [0, -1]) {
    const instant = fixture(3, ttl, 100).cache;
    instant.set("a", 1); assert.equal(instant.size, 1);
    assert.equal(instant.get("a"), undefined); assert.equal(instant.bytes, 0);
  }
  const nan = fixture(3, NaN, 100), immortal = nan.cache;
  immortal.set("a", 1); nan.advance(1000000);
  assert.equal(immortal.get("a"), 1);
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

  // JSON escapes, surrogate pairs and keys are counted as UTF-16 code units,
  // not Unicode code points, UTF-8 bytes, or the unescaped value length.
  const unicode = fixture(3, 100, 32).cache;
  unicode.set("😀", "中\n😀"); // 2 * (2 + 7) = 18
  assert.equal(unicode.bytes, 18);
  unicode.set("b", "1234"); // 14; exact total budget is allowed
  assert.equal(unicode.bytes, 32); assert.equal(unicode.size, 2);
  unicode.set("c", ""); // 6; evicts the oldest
  assert.deepEqual([...unicode.keys()], ["b", "c"]);
  assert.equal(unicode.bytes, 20);
  for (const budget of [17, 18, 19]) {
    const boundary = fixture(3, 100, budget).cache;
    boundary.set("😀", "中\n😀");
    assert.equal(boundary.size, budget < 18 ? 0 : 1);
    assert.equal(boundary.bytes, budget < 18 ? 0 : 18);
  }
  // Options are not validated: zero/negative limits still allow one entry,
  // and a negative budget rejects even the smallest serialized entry.
  for (const limit of [0, -1]) {
    const limited = fixture(limit, 100, 100).cache;
    limited.set("a", 1); limited.set("b", 2);
    assert.deepEqual([...limited.keys()], ["b"]);
  }
  const negative = fixture(3, 100, -1).cache;
  negative.set("a", 1); assert.equal(negative.size, 0);
  const unbounded = fixture(3, 100, NaN).cache;
  unbounded.set("a", 1); assert.equal(unbounded.get("a"), 1);
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
  assert.deepEqual([...c.keys()], ["keep"]);
  assert.equal(c.bytes, 16); assert.equal(c.entriesInfo.size, 1);

  // Failure also prunes expired unrelated entries before serialization.
  const h = fixture(5, 100, 100), cache = h.cache;
  cache.set("expired", 1); h.advance(50);
  cache.set("replace", 2); cache.set("live", 3);
  h.advance(100);
  assert.throws(() => cache.set("replace", cyclic), {name: "TypeError"});
  assert.deepEqual([...cache.keys()], ["live"]);
  assert.equal(cache.bytes, 10); assert.equal(cache.entriesInfo.size, 1);
});

test("the independent one-MiB entry cap rejects larger entries even with a larger total budget", () => {
  const {cache: c} = fixture(5, 100, 4 * 1024 * 1024);
  c.set("keep", {small: true});
  const before = c.bytes;
  c.set("large", {text: "x".repeat(600000)});
  assert.equal(c.has("large"), false);
  assert.deepEqual(c.get("keep"), {small: true});
  assert.equal(c.bytes, before);
  // Sizes are even: test the nearest representable sizes around 1 MiB.
  const cap = 1024 * 1024;
  for (const delta of [-2, 0, 2]) {
    const boundary = fixture(2, 100, 2 * cap).cache;
    boundary.set("k", "x".repeat((cap + delta) / 2 - 3));
    assert.equal(boundary.size, delta > 0 ? 0 : 1);
    assert.equal(boundary.bytes, delta > 0 ? 0 : cap + delta);
  }
});

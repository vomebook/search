const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function random(seed) { let value = seed >>> 0; return () => ((value = Math.imul(value, 1664525) + 1013904223 >>> 0) / 0x100000000); }

function runVirtualizerModel(seed) {
  const rand = random(seed);
  for (let round = 0; round < 120; round++) {
    const count = 10 + Math.floor(rand() * 40), limit = 3 + Math.floor(rand() * 10), center = Math.floor(rand() * count), removed = new Set(), nodes = Array.from({ length: count }, (_, index) => ({ index, height: 100 + index }));
    const sandbox = { self: {} }; sandbox.self = sandbox; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../../static/reader/formats/reader-section-virtualizer.js"), "utf8"), sandbox);
    const virtualizer = sandbox.VoiceOfMLReaderVirtual.createSectionVirtualizer({ limit, getLoaded: () => nodes.filter((node) => !removed.has(node.index)), getIndex: (node) => node.index, getHeight: (node) => node.height, virtualize: (_node, index) => removed.add(index), release: () => {}, preserve: (change) => change() });
    const result = virtualizer.trim(center), retained = nodes.filter((node) => !removed.has(node.index));
    assert.ok(retained.length <= limit); assert.ok(retained.some((node) => node.index === center)); assert.strictEqual(result.retained, retained.length);
  }
}

for (const seed of [1, 7, 42, 20260903]) runVirtualizerModel(seed);
console.log("reader model contracts passed");

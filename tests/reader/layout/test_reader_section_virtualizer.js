const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadVirtualizer(options) {
  const sandbox = { self: {} };
  sandbox.self = sandbox;
  const filename = path.join(__dirname, "../../../static/reader/formats/reader-section-virtualizer.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  return sandbox.VoiceOfMLReaderVirtual.createSectionVirtualizer(options);
}

function main() {
  const nodes = Array.from({ length: 12 }, (_, index) => ({ index, height: 100 + index }));
  const removed = [];
  let preserveCalls = 0;
  const virtualizer = loadVirtualizer({ limit: 9, getLoaded: () => nodes.filter((node) => !removed.includes(node.index)), getIndex: (node) => node.index, getHeight: (node) => node.height, virtualize: (node, index, height) => removed.push(index) && { node, height }, release: () => {}, preserve: (change) => { preserveCalls += 1; return change(); } });
  const result = virtualizer.trim(6);
  assert.strictEqual(virtualizer.limit, 9);
  assert.strictEqual(result.removed, 3);
  assert.strictEqual(result.retained, 9);
  assert.strictEqual(removed.includes(6), false);
  assert.strictEqual(preserveCalls, 1);
  assert.strictEqual(virtualizer.trim(6).removed, 0);
  const protectedNodes = Array.from({ length: 12 }, (_, index) => ({ index, height: 100 }));
  const protectedRemoved = [];
  const protectedVirtualizer = loadVirtualizer({ limit: 9, getLoaded: () => protectedNodes.filter((node) => !protectedRemoved.includes(node.index)), getIndex: (node) => node.index, getHeight: (node) => node.height, canVirtualize: (node) => node.index < 2, virtualize: (_node, index) => protectedRemoved.push(index), release: () => {} });
  const protectedResult = protectedVirtualizer.trim(6);
  assert.strictEqual(protectedResult.removed, 2);
  assert.deepStrictEqual(protectedRemoved, [0, 1]);
  assert.strictEqual(protectedResult.retained, 10);
  const defaulted = loadVirtualizer({ limit: 0, getLoaded: () => [], getIndex: node => node.index,
    getHeight: node => node.height, virtualize: () => {}, release: () => {} });
  assert.strictEqual(defaulted.limit, 9);
  assert.strictEqual(defaulted.trim(NaN).retained, 0);
  virtualizer.dispose();
  assert.strictEqual(virtualizer.trim(0).removed, 0);
  const fallback = {};
  const filename = path.join(__dirname, "../../../static/reader/formats/reader-section-virtualizer.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), fallback, { filename });
  assert.strictEqual(typeof fallback.VoiceOfMLReaderVirtual.createSectionVirtualizer, "function");
  console.log("reader section virtualizer contracts passed");
}

main();

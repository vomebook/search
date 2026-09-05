const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadVirtualizer(options) {
  const sandbox = { self: {} };
  sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/reader-section-virtualizer.js"), "utf8"), sandbox);
  return sandbox.VoiceOfMLReaderVirtual.createSectionVirtualizer(options);
}

function main() {
  const nodes = Array.from({ length: 12 }, (_, index) => ({ index, height: 100 + index }));
  const removed = [];
  let preserveCalls = 0;
  const virtualizer = loadVirtualizer({ limit: 9, getLoaded: () => nodes.filter((node) => !removed.includes(node.index)), getIndex: (node) => node.index, getHeight: (node) => node.height, virtualize: (node, index, height) => removed.push(index) && { node, height }, release: () => {}, preserve: (change) => { preserveCalls += 1; return change(); } });
  const result = virtualizer.trim(6);
  assert.strictEqual(result.removed, 3);
  assert.strictEqual(result.retained, 9);
  assert.strictEqual(removed.includes(6), false);
  assert.strictEqual(preserveCalls, 1);
  assert.strictEqual(virtualizer.trim(6).removed, 0);
  virtualizer.dispose();
  assert.strictEqual(virtualizer.trim(0).removed, 0);
  console.log("reader section virtualizer contracts passed");
}

main();

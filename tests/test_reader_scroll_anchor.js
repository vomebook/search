const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadManager(options) {
  const sandbox = { self: {} };
  sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/reader-scroll-anchor.js"), "utf8"), sandbox);
  return sandbox.VoiceOfMLReaderScroll.createScrollAnchorManager(options);
}

function main() {
  const frames = new Map();
  let nextFrame = 1, resizeCallback;
  class ResizeObserverMock {
    constructor(callback) { resizeCallback = callback; this.observed = new Set(); this.disconnected = false; }
    observe(node) { this.observed.add(node); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
  }
  const viewport = { scrollTop: 200, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
  const article = { isConnected: true, top: 0, height: 400, getBoundingClientRect() { return { top: this.top - viewport.scrollTop, bottom: this.top - viewport.scrollTop + this.height, height: this.height }; } };
  const paragraph = { isConnected: true, top: 210, height: 30, getBoundingClientRect() { return { top: this.top - viewport.scrollTop, bottom: this.top - viewport.scrollTop + this.height, height: this.height }; } };
  const manager = loadManager({ viewport, candidates: () => [article, paragraph], ResizeObserverImpl: ResizeObserverMock, requestFrame: (callback) => { const id = nextFrame++; frames.set(id, callback); return id; }, cancelFrame: (id) => frames.delete(id) });

  const anchor = manager.capture();
  assert.strictEqual(anchor.node, paragraph);
  assert.strictEqual(anchor.offset, 10);
  paragraph.top += 50;
  assert.strictEqual(manager.restore(anchor), true);
  assert.strictEqual(viewport.scrollTop, 250);
  assert.strictEqual(paragraph.getBoundingClientRect().top, 10);

  manager.observe(article);
  manager.capture();
  paragraph.top += 40;
  resizeCallback();
  assert.strictEqual(frames.size, 0);
  assert.strictEqual(viewport.scrollTop, 290);

  manager.preserve(() => { paragraph.top += 25; });
  assert.strictEqual(viewport.scrollTop, 315);
  manager.remember();
  assert.strictEqual(frames.size, 1);
  manager.invalidate();
  assert.strictEqual(frames.size, 0);
  assert.strictEqual(manager.restore(anchor), false);
  manager.dispose();
  assert.strictEqual(frames.size, 0);
  paragraph.top += 100;
  assert.strictEqual(manager.restore(anchor), false);
  console.log("reader scroll anchor contracts passed");
}

main();

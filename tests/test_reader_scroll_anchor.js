const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadManager(options) {
  const sandbox = { self: {} };
  sandbox.self = sandbox;
  const filename = path.join(__dirname, "../static/reader/ui/reader-scroll-anchor.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  return sandbox.VoiceOfMLReaderScroll.createScrollAnchorManager(options);
}

function main() {
  const frames = new Map();
  let nextFrame = 1, resizeCallback;
  class ResizeObserverMock {
    constructor(callback) { resizeCallback = callback; this.observed = new Set(); this.disconnected = false; }
    observe(node) { this.observed.add(node); }
    unobserve(node) { this.observed.delete(node); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
  }
  let idleCallback;
  const listeners = new Map();
  const viewport = { scrollTop: 200, getBoundingClientRect: () => ({ top: 0, bottom: 100 }), addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: (name) => listeners.delete(name) };
  const article = { isConnected: true, top: 0, height: 400, getBoundingClientRect() { return { top: this.top - viewport.scrollTop, bottom: this.top - viewport.scrollTop + this.height, height: this.height }; } };
  const paragraph = { isConnected: true, top: 210, height: 30, getBoundingClientRect() { return { top: this.top - viewport.scrollTop, bottom: this.top - viewport.scrollTop + this.height, height: this.height }; } };
  const manager = loadManager({ viewport, candidates: () => [article, paragraph], ResizeObserverImpl: ResizeObserverMock, requestFrame: (callback) => { const id = nextFrame++; frames.set(id, callback); return id; }, cancelFrame: (id) => frames.delete(id), setTimer: (callback) => { idleCallback = callback; return 1; }, clearTimer: () => { idleCallback = null; } });

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

  listeners.get("wheel")();
  listeners.get("scroll")();
  assert.strictEqual(manager.scrolling, true);
  manager.capture();
  manager.preserve(() => { paragraph.top += 25; });
  assert.strictEqual(viewport.scrollTop, 315, "synchronous insertion preserves a line during scrolling");
  paragraph.top += 60;
  resizeCallback();
  assert.strictEqual(viewport.scrollTop, 315);
  let idleRuns = 0;
  manager.whenIdle(() => { idleRuns += 1; });
  assert.strictEqual(idleRuns, 0);
  idleCallback();
  assert.strictEqual(manager.scrolling, false);
  assert.strictEqual(idleRuns, 1);

  manager.preserve(() => { paragraph.top += 25; });
  assert.strictEqual(viewport.scrollTop, 340);
  manager.remember();
  assert.strictEqual(frames.size, 0);
  manager.invalidate();
  assert.strictEqual(frames.size, 0);
  assert.strictEqual(manager.restore(anchor), false);
  manager.dispose();
  assert.strictEqual(frames.size, 0);
  paragraph.top += 100;
  assert.strictEqual(manager.restore(anchor), false);

  // Check scheduled restoration, invalidation, cancellation and idle execution
  // using independent controllable browser-like frame and timer queues.
  const queuedFrames = new Map(), timers = new Map(), activeListeners = new Map();
  let frameId = 0, timerId = 0, observer;
  class Observer {
    constructor(callback) { this.callback = callback; this.nodes = new Set(); this.disconnected = false; observer = this; }
    observe(node) { this.nodes.add(node); }
    unobserve(node) { this.nodes.delete(node); }
    disconnect() { this.disconnected = true; this.nodes.clear(); }
  }
  const scope = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
    addEventListener: (name, callback) => activeListeners.set(name, callback),
    removeEventListener: (name) => activeListeners.delete(name) };
  const node = { isConnected: true, top: 10,
    getBoundingClientRect() { return { top: this.top - scope.scrollTop, bottom: this.top - scope.scrollTop + 20, height: 20 }; },
    contains(other) { return other === this.child; } };
  const tie = { isConnected: true,
    getBoundingClientRect() { return { top: node.top - scope.scrollTop, bottom: node.top - scope.scrollTop + 40, height: 40 }; } };
  let candidates = [tie, node];
  const second = loadManager({ viewport: scope, candidates: () => candidates, ResizeObserverImpl: Observer,
    requestFrame: callback => { const id = ++frameId; queuedFrames.set(id, callback); return id; },
    cancelFrame: id => queuedFrames.delete(id),
    setTimer: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimer: id => timers.delete(id) });
  let immediate = 0;
  second.whenIdle(() => { immediate += 1; });
  assert.strictEqual(immediate, 1);
  second.observe(node);
  const initial = second.capture();
  assert.strictEqual(initial.node, node);
  assert.strictEqual(second.preserve(() => { node.top += 15; return "retained"; }), "retained");
  assert.strictEqual(scope.scrollTop, 15);
  assert.strictEqual(queuedFrames.size, 1);
  node.top += 5;
  const queued = [...queuedFrames.entries()][0];
  queuedFrames.delete(queued[0]);
  queued[1](0);
  assert.strictEqual(scope.scrollTop, 20, "frame restoration handles later layout movement");
  activeListeners.get("touchstart")();
  const userAnchor = second.capture();
  node.top += 7;
  assert.strictEqual(second.restore(userAnchor), false, "active scrolling retains user ownership");
  assert.strictEqual(scope.scrollTop, 20);
  const firstTimer = [...timers.keys()][0];
  activeListeners.get("scroll")();
  assert.strictEqual(timers.has(firstTimer), false);
  assert.strictEqual(timers.size, 1);
  const beforeDispose = second.capture();
  second.unobserve(node);
  candidates = [];
  assert.strictEqual(second.capture(), null, "unobserving the anchored node clears the snapshot");
  candidates = [node];
  second.preserve(() => {});
  assert.strictEqual(queuedFrames.size, 0, "scrolling changes do not queue a later restoration");
  const end = [...timers.entries()][0];
  timers.delete(end[0]);
  end[1]();
  second.preserve(() => {});
  assert.strictEqual(queuedFrames.size, 1);
  second.invalidate();
  assert.strictEqual(queuedFrames.size, 0, "invalidation cancels pending restoration");
  activeListeners.get("pointerdown")();
  second.dispose();
  second.dispose();
  assert.strictEqual(second.capture(), null);
  assert.strictEqual(second.restore(beforeDispose), false);
  assert.strictEqual(timers.size, 0);
  assert.strictEqual(activeListeners.size, 0);
  assert.strictEqual(observer.disconnected, true);

  const noObserver = loadManager({ viewport: scope, candidates: () => [], ResizeObserverImpl: null,
    requestFrame: () => 1, cancelFrame: () => {}, setTimer: () => 1, clearTimer: () => {} });
  noObserver.observe(node);
  noObserver.unobserve(node);
  assert.strictEqual(noObserver.capture(), null);
  noObserver.dispose();

  const filename = path.join(__dirname, "../static/reader/ui/reader-scroll-anchor.js");
  const fallback = {};
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), fallback, { filename });
  assert.strictEqual(typeof fallback.VoiceOfMLReaderScroll.createScrollAnchorManager, "function");
  console.log("reader scroll anchor contracts passed");
}

main();

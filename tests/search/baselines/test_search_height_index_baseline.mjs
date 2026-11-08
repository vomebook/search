// Expectations were pinned against the original inline Fenwick helpers before extraction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const modulePath = path.join(root, 'static/search/domain/height-index.js');
const source = fs.readFileSync(modulePath, 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context, {filename: modulePath});
const api = context.VoiceOfMLSearchHeightIndex;
const {fenwickAdd, ensureTree, extendTree, totalHeight, offsetOf, indexAt} = api;

function state(heights, extra = {}) {
  return {heights, heightTree: [], heightsDirty: true, sparseHeights: false, heightBase: 60,
    estimatedHeight: 60, ...extra};
}

function oracle(heights) {
  const sums = [0];
  for (const height of heights) sums.push(sums[sums.length - 1] + height);
  return sums;
}

test('prefix sums match the naive oracle for zero, missing and fractional heights', () => {
  const heights = [0, 12, 0.5, 77, 0, 3.25];
  const dense = state(heights);
  const sums = oracle(heights.map(height => height || 60));
  assert.strictEqual(totalHeight(dense), sums[heights.length]);
  assert.equal(offsetOf(dense, 0), 0);
  for (let index = 0; index <= heights.length; index++) {
    assert.equal(offsetOf(dense, index), sums[index], `offset ${index}`);
  }
  assert.equal(offsetOf(dense, -5), 0);
  assert.equal(offsetOf(dense, 99), sums[heights.length]);
  const empty = state([]);
  assert.equal(totalHeight(empty), 0);
  assert.equal(offsetOf(empty, 0), 0);
  assert.equal(indexAt(empty, 0), 0);
});

test('indexAt returns the row containing an offset and clamps out-of-range probes', () => {
  const heights = [10, 20, 30, 40];
  const dense = state(heights);
  const rows = [];
  let offset = 0;
  for (const height of heights) {
    rows.push(offset, offset + height / 2, offset + height - 0.001);
    offset += height;
  }
  for (const probe of rows) {
    const expected = heights.findIndex((height, index) =>
      probe >= oracle(heights)[index] && probe < oracle(heights)[index + 1]);
    assert.strictEqual(indexAt(dense, probe), expected, `probe ${probe}`);
  }
  assert.strictEqual(indexAt(dense, -100), 0);
  assert.strictEqual(indexAt(dense, 0), 0);
  assert.strictEqual(indexAt(dense, 99), 3);
  assert.strictEqual(indexAt(dense, 100), 3);
  assert.strictEqual(indexAt(dense, 12345), 3);
  assert.deepEqual(indexAtObject(dense, 25), {index: 1, sum: 10});
});

/** Re-derives the original binary-search accumulator for an equivalence check. */
function indexAtObject(current, offset) {
  const tree = ensureTree(current);
  let index = 0;
  let bit = 1;
  while ((bit << 1) < tree.length) bit <<= 1;
  let sum = 0;
  for (; bit > 0; bit >>= 1) {
    const next = index + bit;
    const height = (tree[next] || 0) + (current.sparseHeights ? (next & -next) * current.heightBase : 0);
    if (next < tree.length && sum + height <= offset) {
      index = next;
      sum += height;
    }
  }
  return {index: Math.min(Math.max(0, index), Math.max(0, current.heights.length - 1)), sum};
}

test('dense builds use each row height or the estimate and stay cached until dirty', () => {
  const first = state([5, 0, 15], {estimatedHeight: 25});
  const tree = ensureTree(first);
  assert.deepEqual(oracle([5, 25, 15]), [0, 5, 30, 45]);
  assert.equal(totalHeight(first), 45);
  assert.equal(first.heightTree, tree, 'clean tree is reused');
  assert.equal(first.heightsDirty, false);
  first.heights[1] = 7;
  assert.equal(totalHeight(first), 45, 'dirty flag owns invalidation');
  first.heightsDirty = true;
  assert.equal(totalHeight(first), 27);
  assert.notEqual(first.heightTree, tree);
  const noEstimate = state([2], {estimatedHeight: 0});
  assert.equal(totalHeight(noEstimate), 2, 'a present height wins over a falsy estimate');
  const missing = state([0], {estimatedHeight: undefined});
  assert.equal(totalHeight(missing), 60);
});

test('sparse trees store per-row deltas over the shared base', () => {
  const sparse = state([100, 100, 100, 100], {sparseHeights: true, heightBase: 100});
  assert.equal(totalHeight(sparse), 400);
  assert.equal(offsetOf(sparse, 2), 200);
  sparse.heightTree = ensureTree(sparse);
  fenwickAdd(sparse.heightTree, 2, 60);
  assert.equal(totalHeight(sparse), 460);
  assert.equal(offsetOf(sparse, 2), 260);
  assert.equal(offsetOf(sparse, 1), 100);
  sparse.heights = [100, 100, 100, 100, 140];
  sparse.heightsDirty = true;
  assert.equal(ensureTree(sparse).length, 6, 'the rebuilt tree covers every row');
  assert.equal(totalHeight(sparse), 540, 'sparse rows store height minus base');
  assert.equal(offsetOf(sparse, 4), 400);
  assert.equal(offsetOf(sparse, 5), 540);
  assert.equal(indexAt(sparse, 0), 0);
  assert.equal(indexAt(sparse, 99), 0);
  assert.equal(indexAt(sparse, 100), 1);
  assert.equal(indexAt(sparse, 159), 1);
  assert.equal(indexAt(sparse, 159.5), 1);
  assert.equal(indexAt(sparse, 160), 1);
  assert.equal(indexAt(sparse, 200), 2);
  assert.equal(indexAt(sparse, 219), 2);
  assert.equal(indexAt(sparse, 260), 2);
  assert.equal(indexAt(sparse, 400), 4, 'sparse lookups resolve on the padded grid');
  assert.equal(indexAt(sparse, 440), 4);
  assert.equal(indexAt(sparse, 539), 4);
  assert.equal(extendTree(sparse, 4), false, 'sparse appends refuse in-place extension');
  sparse.heightsDirty = true;
  assert.equal(sparse.heightsDirty, true);
  const sparseZeroBase = state([0, 3, 0], {sparseHeights: true, heightBase: 0});
  assert.equal(totalHeight(sparseZeroBase), 3);
  assert.equal(offsetOf(sparseZeroBase, 3), 3);
  assert.equal(indexAt(sparseZeroBase, 2), 1);
});

test('append extension is equivalent to a full rebuild for every growth pattern', () => {
  for (const start of [0, 1, 2, 3, 7, 8, 15]) {
    for (const grow of [1, 2, 5, 9]) {
      const heights = Array.from({length: start}, (_, index) => (index % 3) * 7 + 4);
      const dense = state(heights, {estimatedHeight: 11});
      ensureTree(dense);
      const before = dense.heightTree;
      const added = Array.from({length: grow}, (_, index) => (index % 4) * 3 + 1);
      dense.heights = heights.concat(added);
      assert.equal(extendTree(dense, start), true, `extend ${start}+${grow}`);
      assert.equal(dense.heightTree, before, 'extended tree is mutated in place');
      const rebuilt = state(dense.heights, {estimatedHeight: 11});
      ensureTree(rebuilt);
      assert.deepEqual(dense.heightTree, rebuilt.heightTree, `tree ${start}+${grow}`);
      const sums = oracle(dense.heights);
      for (let index = 0; index <= dense.heights.length; index++) {
        assert.equal(offsetOf(dense, index), sums[index], `prefix ${start}+${grow} ${index}`);
      }
      for (let probe = -1; probe <= sums[sums.length - 1] + 1; probe++) {
        assert.equal(indexAt(dense, probe), indexAt(rebuilt, probe), `probe ${start}+${grow} ${probe}`);
      }
    }
  }
});

test('extension refuses stale or resized trees and marks them dirty', () => {
  const stale = state([5, 6], {estimatedHeight: 5});
  ensureTree(stale);
  stale.heights = [5, 6, 7];
  stale.heightsDirty = true;
  assert.equal(extendTree(stale, 2), false);
  assert.equal(stale.heightsDirty, true);
  const truncated = state([5, 6], {estimatedHeight: 5});
  ensureTree(truncated);
  truncated.heights = [5, 6, 7];
  truncated.heightTree.length = 2;
  assert.equal(extendTree(truncated, 2), false);
  assert.equal(truncated.heightsDirty, true);
  const noGrowth = state([5, 6], {estimatedHeight: 5});
  ensureTree(noGrowth);
  assert.equal(extendTree(noGrowth, 2), true, 'same-length extension is a no-op refresh');
  assert.deepEqual(Array.from(noGrowth.heightTree), [0, 5, 11]);
});

test('fenwickAdd ignores zero deltas and creates missing sparse slots', () => {
  const tree = [0, 0, 0, 0, 0];
  fenwickAdd(tree, 1, 0);
  assert.deepEqual(tree, [0, 0, 0, 0, 0]);
  fenwickAdd(tree, 1, 4);
  fenwickAdd(tree, 2, 6);
  assert.deepEqual(tree, [0, 4, 10, 0, 10]);
  const sparse = state([0, 0], {sparseHeights: true, heightBase: 0});
  ensureTree(sparse);
  fenwickAdd(sparse.heightTree, 2, 5);
  assert.equal(offsetOf(sparse, 2), 5);
  assert.equal(offsetOf(sparse, 1), 0);
  assert.equal(indexAt(sparse, 0), 1, 'the earliest row whose prefix exceeds the offset wins');
  assert.equal(indexAt(sparse, 4), 1);
  assert.equal(indexAt(sparse, 5), 1);
});

test('input exceptions and shared namespace identity propagate unchanged', () => {
  const broken = new Proxy({}, {get() { throw new Error('boom'); }});
  assert.throws(() => totalHeight(broken), /boom/);
  assert.equal(typeof api, 'object');
  assert.strictEqual(context.VoiceOfMLSearchHeightIndex, api);
  assert.deepEqual(Object.keys(api).sort(),
    ['ensureTree', 'extendTree', 'fenwickAdd', 'indexAt', 'offsetOf', 'totalHeight']);
});

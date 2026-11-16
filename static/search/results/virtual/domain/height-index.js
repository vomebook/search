// Fenwick-backed row height index shared by both search sites. The host keeps
// the height array, measurement cache and DOM; this module owns only the prefix
// sums, offset lookup and the append-friendly tree extension.
// Statements mirror the original inline helpers so numeric behavior stays identical.
// The IIFE keeps the helpers out of the classic-script global scope (no Annex B leak).
(function () {
  /**
   * @typedef {{heights: readonly number[], heightTree: number[], heightsDirty: boolean,
   *   sparseHeights: boolean, heightBase: number, estimatedHeight?: number}} HeightIndexState
   */

  /**
   * @param {number[]} tree
   * @param {number} idx
   * @param {number} delta
   */
  function fenwickAdd(tree, idx, delta) {
    if (!delta) return;
    for (let i = idx; i < tree.length; i += i & -i) tree[i] = (tree[i] || 0) + delta;
  }

  /**
   * @param {readonly number[]} tree
   * @param {number} idx
   * @param {boolean} sparse
   * @param {number} base
   * @returns {number}
   */
  function prefixSum(tree, idx, sparse, base) {
    let sum = sparse ? idx * base : 0;
    for (let i = idx; i > 0; i -= i & -i) sum += tree[i] || 0;
    return sum;
  }

  /**
   * @param {HeightIndexState} state
   * @returns {number[]}
   */
  function buildTree(state) {
    const heights = state.heights;
    const len = heights.length;
    if (state.sparseHeights) {
      /** @type {number[]} */
      const sparse = new Array(len + 1);
      for (const key of Object.keys(heights)) {
        const height = /** @type {number} */ (heights[Number(key)]);
        fenwickAdd(sparse, Number(key) + 1, height - state.heightBase);
      }
      return sparse;
    }
    /** @type {number[]} */
    const tree = new Array(len + 1).fill(0);
    const est = state.estimatedHeight || 60;
    for (let i = 1; i <= len; i++) {
      const row = /** @type {number} */ (tree[i]);
      tree[i] = row + (heights[i - 1] || est);
      const parent = i + (i & -i);
      if (parent <= len) tree[parent] = /** @type {number} */ (tree[parent]) + /** @type {number} */ (tree[i]);
    }
    return tree;
  }

  /**
   * Rebuild the tree only when the height array changed shape or values.
   * @param {HeightIndexState} state
   * @returns {number[]}
   */
  function ensureTree(state) {
    const len = state.heights.length;
    if (!state.heightsDirty && state.heightTree.length === len + 1) return state.heightTree;
    state.heightTree = buildTree(state);
    state.heightsDirty = false;
    return state.heightTree;
  }

  /**
   * Grow the tree for appended rows without rebuilding earlier prefix ranges.
   * Callers must have already set `heights.length` to `len`.
   * @param {HeightIndexState} state
   * @param {number} previousLength
   * @returns {boolean} whether the tree was extended in place
   */
  function extendTree(state, previousLength) {
    const len = state.heights.length;
    const oldLen = previousLength;
    if (state.sparseHeights) return false;
    const canExtendTree = !state.heightsDirty && state.heightTree.length === oldLen + 1;
    if (!canExtendTree) {
      state.heightsDirty = true;
      return false;
    }
    /** @type {number[]} */
    const newPrefix = new Array(len - oldLen + 1).fill(0);
    for (let i = oldLen; i < len; i++) {
      const previous = /** @type {number} */ (newPrefix[i - oldLen]);
      const height = /** @type {number} */ (state.heights[i]);
      newPrefix[i - oldLen + 1] = previous + height;
    }
    state.heightTree.length = len + 1;
    for (let i = oldLen + 1; i <= len; i++) {
      const rangeStart = i - (i & -i) + 1;
      const oldStart = Math.max(1, rangeStart);
      const oldEnd = Math.min(oldLen, i);
      const oldSum = oldEnd >= oldStart
        ? prefixSum(state.heightTree, oldEnd, false, 0) - prefixSum(state.heightTree, oldStart - 1, false, 0)
        : 0;
      const newStart = Math.max(oldLen + 1, rangeStart);
      const newSum = /** @type {number} */ (newPrefix[i - oldLen]) - /** @type {number} */ (newPrefix[newStart - oldLen - 1]);
      state.heightTree[i] = oldSum + newSum;
    }
    return true;
  }

  /**
   * @param {HeightIndexState} state
   * @returns {number}
   */
  function totalHeight(state) {
    return prefixSum(ensureTree(state), state.heights.length, state.sparseHeights, state.heightBase);
  }

  /**
   * @param {HeightIndexState} state
   * @param {number} index
   * @returns {number}
   */
  function offsetOf(state, index) {
    const clamped = Math.max(0, Math.min(index, state.heights.length));
    return prefixSum(ensureTree(state), clamped, state.sparseHeights, state.heightBase);
  }

  /**
   * Return the row containing `offset`, clamped to the current row range.
   * @param {HeightIndexState} state
   * @param {number} offset
   * @returns {number}
   */
  function indexAt(state, offset) {
    const tree = ensureTree(state);
    const len = state.heights.length;
    let idx = 0;
    let bit = 1;
    while ((bit << 1) < tree.length) bit <<= 1;
    let sum = 0;
    for (; bit > 0; bit >>= 1) {
      const next = idx + bit;
      const height = (tree[next] || 0) + (state.sparseHeights ? (next & -next) * state.heightBase : 0);
      if (next < tree.length && sum + height <= offset) {
        idx = next;
        sum += height;
      }
    }
    return Math.min(Math.max(0, idx), Math.max(0, len - 1));
  }

  /** @type {typeof globalThis & {VoiceOfMLSearchHeightIndex: typeof VoiceOfMLSearchHeightIndex}} */
  const globals = globalThis;
  globals.VoiceOfMLSearchHeightIndex = {fenwickAdd, ensureTree, extendTree, totalHeight, offsetOf, indexAt};
})();

// Intersect posting lists without changing the first list's order in unsorted mode.
/** @overload @param {(number[] | Uint32Array)[]} candidateLists @param {true} sorted @returns {number[]} */
/** @overload @param {(number[] | Uint32Array)[]} candidateLists @param {boolean} [sorted] @returns {number[] | Uint32Array} */
/**
 * @param {(number[] | Uint32Array)[]} candidateLists
 * @param {boolean} [sorted]
 * @returns {number[] | Uint32Array}
 */
function intersectCandidateLists(candidateLists, sorted = false) {
  if (!candidateLists.length) return [];
  const first = /** @type {number[] | Uint32Array} */ (candidateLists[0]);
  if (sorted) {
    if (candidateLists.length === 1) return Array.from(first);
    const lists = candidateLists.slice().sort((a, b) => a.length - b.length);
    const shortest = /** @type {number[] | Uint32Array} */ (lists[0]);
    /** @type {number[]} */
    const matched = [];
    if (shortest.length >= 512) {
      // Dense sorted postings are cheaper to intersect with monotonic cursors.
      /** @type {number[]} */
      const cursors = new Array(lists.length).fill(0);
      outer: for (const index of shortest) {
        for (let i = 1; i < lists.length; i++) {
          const list = /** @type {number[] | Uint32Array} */ (lists[i]);
          let offset = /** @type {number} */ (cursors[i]);
          while (offset < list.length && /** @type {number} */ (list[offset]) < index) offset++;
          cursors[i] = offset;
          if (offset === list.length) break outer;
          if (list[offset] !== index) continue outer;
        }
        matched.push(index);
      }
      return matched;
    }
    for (const index of shortest) {
      let found = true;
      for (let i = 1; i < lists.length; i++) {
        const list = /** @type {number[] | Uint32Array} */ (lists[i]);
        let low = 0, high = list.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (/** @type {number} */ (list[middle]) < index) low = middle + 1;
          else high = middle;
        }
        if (list[low] !== index) { found = false; break; }
      }
      if (found) matched.push(index);
    }
    return matched;
  }
  const ordered = first;
  let probe = ordered;
  for (const candidates of candidateLists) if (candidates.length < probe.length) probe = candidates;
  const matched = new Set(probe);
  for (const candidates of candidateLists) {
    if (candidates === probe) continue;
    const allowed = new Set(candidates);
    for (const index of matched) if (!allowed.has(index)) matched.delete(index);
    if (!matched.size) break;
  }
  return ordered.filter((index) => matched.has(index));
}

// Pure search text algorithms shared by the classic search worker.
/* exported compareCodepoints, tokenizeParts, tokenize, isChineseToken, fuzzyDistanceBudget, literalSearch */
// Python compares lowercased Unicode code points; avoid UTF-16 surrogate ordering.
/** @param {string} left @param {string} right */
function compareCodepoints(left, right) {
  if (!/[\uD800-\uDFFF]/.test(left) && !/[\uD800-\uDFFF]/.test(right)) return left < right ? -1 : left > right ? 1 : 0;
  const a = Array.from(left, char => /** @type {number} */ (char.codePointAt(0)));
  const b = Array.from(right, char => /** @type {number} */ (char.codePointAt(0)));
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = /** @type {number} */ (a[i]), y = /** @type {number} */ (b[i]);
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

/** @param {unknown} text */
function tokenizeParts(text) {
  /** @type {string[]} */
  const chinese = [];
  const lower = String(text || "").toLowerCase();
  /** @type {string[]} */
  const alpha = lower.match(/[a-z0-9]+/g) || [];
  const chineseRuns = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || [];
  for (const run of chineseRuns) {
    for (const ch of run) chinese.push(ch);
    for (let i = 0; i < run.length - 1; i++) chinese.push(run.charAt(i) + run.charAt(i + 1));
  }
  return {alpha, chinese};
}

/** @param {unknown} text */
function tokenize(text) {
  const parts = tokenizeParts(text);
  return Array.from(new Set(parts.alpha.concat(parts.chinese)));
}

/** @param {string} token */
function isChineseToken(token) {
  return /^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(token);
}

/** @param {string} token */
function fuzzyDistanceBudget(token) {
  // A two-edit radius makes every single character match every other one.
  if (token.length <= 1) return 0;
  return token.length <= 3 ? 1 : 2;
}

/** @param {unknown} query */
function literalSearch(query) {
  return /[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf\s]/i.test(String(query || ""));
}

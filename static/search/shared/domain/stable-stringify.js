// Pure canonicalization used for search view and request cache identities.
// The caller supplies a lazy recursive binding so replacement during a getter
// retains the original host function's evaluation order.
(function () {
  /**
   * @param {unknown} value
   * @param {() => (value: unknown) => string | undefined} getVisit
   * @returns {string | undefined}
   */
  function stableStringify(value, getVisit) {
    if (Array.isArray(value)) return "[" + value.map(getVisit()).join(",") + "]";
    if (value && typeof value === "object") {
      const record = /** @type {Record<string, unknown>} */ (value);
      return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + getVisit()(record[key])).join(",") + "}";
    }
    return JSON.stringify(value);
  }

  /** @type {typeof globalThis & {VoiceOfMLSearchCanonical: typeof VoiceOfMLSearchCanonical}} */
  const globals = globalThis;
  globals.VoiceOfMLSearchCanonical = {stableStringify};
})();

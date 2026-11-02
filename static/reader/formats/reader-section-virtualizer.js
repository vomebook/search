(function (root) {
  "use strict";

  /**
   * @template {Element} T
   * @param {{limit: number, getLoaded: () => T[], getIndex: (node: T) => number,
   *   getHeight: (node: T) => number, virtualize: (node: T, index: number, height: number) => unknown,
   *   release: (index: number) => unknown, preserve?: (change: () => void) => void,
   *   canVirtualize?: (node: T, index: number) => boolean}} options
   */
  function createSectionVirtualizer({
    limit,
    getLoaded,
    getIndex,
    getHeight,
    virtualize,
    release,
    preserve = (change) => change(),
    canVirtualize = (_node, _index) => true
  }) {
    const maximum = Math.max(3, Number(limit) || 9);
    let disposed = false;

    /** @param {number} centerIndex */
    function trim(centerIndex) {
      if (disposed || !Number.isInteger(centerIndex))
        return { removed: 0, retained: getLoaded().length };
      const loaded = getLoaded();
      const count = Math.max(0, loaded.length - maximum);
      if (!count) return { removed: 0, retained: loaded.length };
      const targets = loaded
        .filter((node) => getIndex(node) !== centerIndex && canVirtualize(node, getIndex(node)))
        .sort(
          (left, right) =>
            Math.abs(getIndex(right) - centerIndex) - Math.abs(getIndex(left) - centerIndex) ||
            getIndex(left) - getIndex(right)
        )
        .slice(0, count);
      let removed = 0;
      preserve(() => {
        for (const node of targets) {
          const index = getIndex(node);
          virtualize(node, index, Math.max(1, getHeight(node)));
          release(index);
          removed += 1;
        }
      });
      return { removed, retained: loaded.length - removed };
    }

    function dispose() {
      disposed = true;
    }
    return Object.freeze({
      trim,
      dispose,
      get limit() {
        return maximum;
      }
    });
  }

  root.VoiceOfMLReaderVirtual = Object.freeze({ createSectionVirtualizer });
})(typeof self !== "undefined" ? self : globalThis);

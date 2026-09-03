(function(root) {
  "use strict";

  function createSectionVirtualizer({ limit, getLoaded, getIndex, getHeight, virtualize, release, preserve = (change) => change() }) {
    const maximum = Math.max(3, Number(limit) || 9);
    let disposed = false;

    function trim(centerIndex) {
      if (disposed || !Number.isInteger(centerIndex)) return { removed: 0, retained: getLoaded().length };
      const loaded = getLoaded();
      const count = Math.max(0, loaded.length - maximum);
      if (!count) return { removed: 0, retained: loaded.length };
      const targets = loaded
        .filter((node) => getIndex(node) !== centerIndex)
        .sort((left, right) => Math.abs(getIndex(right) - centerIndex) - Math.abs(getIndex(left) - centerIndex) || getIndex(left) - getIndex(right))
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

    function dispose() { disposed = true; }
    return Object.freeze({ trim, dispose, get limit() { return maximum; } });
  }

  root.VoiceOfMLReaderVirtual = Object.freeze({ createSectionVirtualizer });
})(typeof self !== "undefined" ? self : globalThis);

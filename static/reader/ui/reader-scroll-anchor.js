(function (root) {
  "use strict";

  /** @typedef {{node: Element, offset: number, generation: number}} ScrollAnchor */
  /**
   * @param {{viewport: Element, candidates: () => Element[],
   *   ResizeObserverImpl?: typeof ResizeObserver, requestFrame?: typeof requestAnimationFrame,
   *   cancelFrame?: typeof cancelAnimationFrame, setTimer?: typeof setTimeout,
   *   clearTimer?: typeof clearTimeout, scrollIdleDelay?: number}} options
   */
  function createScrollAnchorManager({
    viewport,
    candidates,
    ResizeObserverImpl = root.ResizeObserver,
    requestFrame = root.requestAnimationFrame.bind(root),
    cancelFrame = root.cancelAnimationFrame.bind(root),
    setTimer = root.setTimeout.bind(root),
    clearTimer = root.clearTimeout.bind(root),
    scrollIdleDelay = 140
  }) {
    /** @type {ScrollAnchor | null} */
    let anchor = null;
    let restoreFrame = 0;
    let disposed = false;
    let generation = 0;
    let scrolling = false;
    let scrollTimer = 0;
    /** @type {Set<() => void>} */
    const idleTasks = new Set();

    /** @param {Element | null | undefined} node @returns {ScrollAnchor | null} */
    function measure(node) {
      if (!node?.isConnected) return null;
      const viewportRect = viewport.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      return { node, offset: rect.top - viewportRect.top, generation };
    }

    function capture() {
      if (disposed) return null;
      const viewportRect = viewport.getBoundingClientRect();
      const marker = viewportRect.top + 8;
      let selected = null, distance = Infinity, height = Infinity, offset = 0;
      for (const node of candidates()) {
        if (!node?.isConnected) continue;
        const rect = node.getBoundingClientRect();
        if (!(rect.height > 0 && rect.bottom > marker && rect.top < viewportRect.bottom)) continue;
        const delta = Math.abs(rect.top - marker);
        if (delta > distance || (delta === distance && rect.height >= height)) continue;
        selected = node;
        distance = delta;
        height = rect.height;
        offset = rect.top - viewportRect.top;
      }
      if (selected?.isConnected) anchor = { node: selected, offset, generation };
      return anchor;
    }

    /** @param {ScrollAnchor | null} [snapshot] */
    function restore(snapshot = anchor) {
      if (disposed || snapshot?.generation !== generation || !snapshot.node?.isConnected)
        return false;
      if (scrolling) {
        capture();
        return false;
      }
      const current = measure(snapshot.node);
      if (!current) return false;
      const delta = current.offset - snapshot.offset;
      if (Math.abs(delta) > 0.5) viewport.scrollTop += delta;
      anchor = measure(snapshot.node);
      return true;
    }

    /** @param {ScrollAnchor | null} [snapshot] */
    function scheduleRestore(snapshot = anchor) {
      if (disposed || !snapshot || restoreFrame) return;
      restoreFrame = requestFrame(() => {
        restoreFrame = 0;
        restore(anchor);
      });
    }

    function remember() {
      if (disposed) return;
      if (restoreFrame) {
        cancelFrame(restoreFrame);
        restoreFrame = 0;
      }
      capture();
    }

    /** @template T @param {() => T} change @returns {T} */
    function preserve(change) {
      const snapshot = capture();
      const result = change();
      if (scrolling && snapshot?.node?.isConnected) {
        // This synchronous layout change must not move the line under a moving finger.
        const current = measure(snapshot.node);
        if (current && snapshot.generation === generation)
          viewport.scrollTop += current.offset - snapshot.offset;
        capture();
        return result;
      }
      restore(snapshot);
      scheduleRestore(snapshot);
      return result;
    }

    function finishScroll() {
      scrollTimer = 0;
      scrolling = false;
      const tasks = [...idleTasks];
      idleTasks.clear();
      for (const task of tasks) task();
      capture();
    }

    function scheduleScrollEnd() {
      if (disposed) return;
      if (scrollTimer) clearTimer(scrollTimer);
      scrollTimer = setTimer(finishScroll, scrollIdleDelay);
    }

    function handleScrollIntent() {
      scrolling = true;
      scheduleScrollEnd();
    }
    function handleScroll() {
      if (scrolling) scheduleScrollEnd();
    }

    /** @param {() => void} task */
    function whenIdle(task) {
      if (disposed || typeof task !== "function") return;
      if (!scrolling) task();
      else idleTasks.add(task);
    }

    viewport.addEventListener?.("scroll", handleScroll, { passive: true });
    for (const name of ["wheel", "touchstart", "pointerdown"])
      viewport.addEventListener?.(name, handleScrollIntent, { passive: true });
    const resizeObserver = ResizeObserverImpl
      ? new ResizeObserverImpl(() => (scrolling ? capture() : restore(anchor)))
      : null;
    /** @param {Element} node */
    function observe(node) {
      resizeObserver?.observe(node);
      if (!anchor) capture();
    }
    /** @param {Element} node */
    function unobserve(node) {
      resizeObserver?.unobserve(node);
      // Web IDL converts undefined to null; the assertion keeps runtime behavior unchanged.
      if (anchor?.node === node || node?.contains?.(/** @type {Node | null} */ (anchor?.node))) anchor = null;
    }
    function invalidate() {
      generation += 1;
      if (restoreFrame) cancelFrame(restoreFrame);
      restoreFrame = 0;
      anchor = null;
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      viewport.removeEventListener?.("scroll", handleScroll);
      for (const name of ["wheel", "touchstart", "pointerdown"])
        viewport.removeEventListener?.(name, handleScrollIntent);
      if (scrollTimer) clearTimer(scrollTimer);
      scrollTimer = 0;
      scrolling = false;
      idleTasks.clear();
      resizeObserver?.disconnect();
      invalidate();
    }

    return Object.freeze({
      capture,
      restore,
      remember,
      preserve,
      observe,
      unobserve,
      invalidate,
      dispose,
      whenIdle,
      get scrolling() {
        return scrolling;
      }
    });
  }

  root.VoiceOfMLReaderScroll = Object.freeze({ createScrollAnchorManager });
})(typeof self !== "undefined" ? self : globalThis);

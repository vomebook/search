(function(root) {
  "use strict";

  function createScrollAnchorManager({ viewport, candidates, ResizeObserverImpl = root.ResizeObserver, requestFrame = root.requestAnimationFrame.bind(root), cancelFrame = root.cancelAnimationFrame.bind(root), setTimer = root.setTimeout.bind(root), clearTimer = root.clearTimeout.bind(root), scrollIdleDelay = 140 }) {
    let anchor = null;
    let captureFrame = 0;
    let restoreFrame = 0;
    let disposed = false;
    let generation = 0;
    let scrolling = false;
    let scrollTimer = 0;
    const idleTasks = new Set();

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
      const measured = candidates()
        .filter((node) => node?.isConnected)
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.height > 0 && rect.bottom > viewportRect.top && rect.top < viewportRect.bottom);
      const selected = measured.filter(({ rect }) => rect.bottom > marker).sort((left, right) => Math.abs(left.rect.top - marker) - Math.abs(right.rect.top - marker) || left.rect.height - right.rect.height)[0];
      anchor = measure(selected?.node) || anchor;
      return anchor;
    }

    function restore(snapshot = anchor) {
      if (disposed || snapshot?.generation !== generation || !snapshot.node?.isConnected) return false;
      if (scrolling) { capture(); return false; }
      const current = measure(snapshot.node);
      if (!current) return false;
      const delta = current.offset - snapshot.offset;
      if (Math.abs(delta) > 0.5) viewport.scrollTop += delta;
      anchor = measure(snapshot.node);
      return true;
    }

    function scheduleRestore(snapshot = anchor) {
      if (disposed || !snapshot || restoreFrame) return;
      restoreFrame = requestFrame(() => {
        restoreFrame = 0;
        restore(snapshot);
      });
    }

    function remember() {
      if (disposed) return;
      if (restoreFrame) {
        cancelFrame(restoreFrame);
        restoreFrame = 0;
      }
      if (captureFrame) return;
      captureFrame = requestFrame(() => {
        captureFrame = 0;
        capture();
      });
    }

    function preserve(change) {
      const snapshot = capture();
      const result = change();
      if (scrolling) { capture(); return result; }
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

    function handleScrollIntent() { scrolling = true; scheduleScrollEnd(); }
    function handleScroll() { if (scrolling) scheduleScrollEnd(); }

    function whenIdle(task) {
      if (disposed || typeof task !== "function") return;
      if (!scrolling) task();
      else idleTasks.add(task);
    }

    viewport.addEventListener?.("scroll", handleScroll, { passive: true });
    for (const name of ["wheel", "touchstart", "pointerdown"]) viewport.addEventListener?.(name, handleScrollIntent, { passive: true });
    const resizeObserver = ResizeObserverImpl ? new ResizeObserverImpl(() => scrolling ? capture() : restore(anchor)) : null;
    function observe(node) { resizeObserver?.observe(node); if (!anchor) capture(); }
    function unobserve(node) { resizeObserver?.unobserve(node); if (anchor?.node === node || node?.contains?.(anchor?.node)) anchor = null; }
    function invalidate() { generation += 1; if (captureFrame) cancelFrame(captureFrame); if (restoreFrame) cancelFrame(restoreFrame); captureFrame = 0; restoreFrame = 0; anchor = null; }
    function dispose() { if (disposed) return; disposed = true; viewport.removeEventListener?.("scroll", handleScroll); for (const name of ["wheel", "touchstart", "pointerdown"]) viewport.removeEventListener?.(name, handleScrollIntent); if (scrollTimer) clearTimer(scrollTimer); scrollTimer = 0; scrolling = false; idleTasks.clear(); resizeObserver?.disconnect(); invalidate(); }

    return Object.freeze({ capture, restore, remember, preserve, observe, unobserve, invalidate, dispose, whenIdle, get scrolling() { return scrolling; } });
  }

  root.VoiceOfMLReaderScroll = Object.freeze({ createScrollAnchorManager });
})(typeof self !== "undefined" ? self : globalThis);

(function(root) {
  "use strict";

  function createScrollAnchorManager({ viewport, candidates, ResizeObserverImpl = root.ResizeObserver, requestFrame = root.requestAnimationFrame.bind(root), cancelFrame = root.cancelAnimationFrame.bind(root) }) {
    let anchor = null;
    let captureFrame = 0;
    let restoreFrame = 0;
    let disposed = false;
    let generation = 0;

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
      restore(snapshot);
      scheduleRestore(snapshot);
      return result;
    }

    const resizeObserver = ResizeObserverImpl ? new ResizeObserverImpl(() => restore(anchor)) : null;
    function observe(node) { resizeObserver?.observe(node); if (!anchor) capture(); }
    function invalidate() { generation += 1; if (captureFrame) cancelFrame(captureFrame); if (restoreFrame) cancelFrame(restoreFrame); captureFrame = 0; restoreFrame = 0; anchor = null; }
    function dispose() { if (disposed) return; disposed = true; resizeObserver?.disconnect(); invalidate(); }

    return Object.freeze({ capture, restore, remember, preserve, observe, invalidate, dispose });
  }

  root.VoiceOfMLReaderScroll = Object.freeze({ createScrollAnchorManager });
})(typeof self !== "undefined" ? self : globalThis);

// Search geometry and focus handoff. The search host supplies only viewport operations.
(function () {
  /** @param {ReaderReturnDependencies} deps */
  function create(deps) {
    /** @type {ReaderReturnPosition | null} */
    let scroll = null;
    let generation = 0, active = false;
    function captureReaderReturnScroll() {
      const view = deps.readView();
      if (!view.hasContainer) return null;
      const top = deps.getTop();
      let index = 0, offset = top;
      if (view.resultCount) {
        deps.ensureHeights();
        index = deps.findIndex(top);
        offset = top - deps.getOffset(index);
      }
      const element = document.activeElement;
      const focus = element instanceof HTMLElement && element.id ? { id: element.id,
        start: element instanceof HTMLInputElement ? element.selectionStart : null,
        end: element instanceof HTMLInputElement ? element.selectionEnd : null,
        direction: element instanceof HTMLInputElement ? element.selectionDirection : null } : null;
      return { route: location.href, viewKey: deps.getViewKey(), top, index, offset, focus };
    }
    /** @param {ReaderReturnPosition} saved */
    function readerSearchHandoffReady(saved) {
      const view = deps.readView();
      // A usable preview keeps ownership of its adjacent-page validation.
      if (view.loading || !view.loadedPage || !view.resultCount) return false;
      if (view.positionRestore && (!view.positionRestore.preview || view.positionRestore.key !== saved.viewKey)) return false;
      return deps.hasResult(Math.min(saved.index, Math.max(0, view.total - 1)));
    }
    function restoreReaderReturnScroll(windowRendered = false, restoreTop = false) {
      if (!scroll) return;
      const saved = scroll;
      if (saved.route && saved.route !== location.href) { scroll = null; return; }
      if (saved.viewKey && saved.viewKey !== deps.getViewKey()) { scroll = null; return; }
      const owner = ++generation;
      let attempts = 0;
      function restore() {
        if (owner !== generation || saved.viewKey !== deps.getViewKey() || saved.route !== location.href) return;
        const view = deps.readView();
        if (!view.hasContainer || !view.resultCount) {
          if (++attempts < 20) requestAnimationFrame(restore);
          return;
        }
        deps.ensureHeights();
        const index = Math.min(saved.index, view.resultCount - 1);
        const target = Math.max(0, restoreTop ? saved.top : deps.getOffset(index) + saved.offset);
        const max = Math.max(0, deps.getTotalHeight() - view.containerHeight);
        active = true;
        deps.setTop(Math.min(target, max));
        if (!windowRendered) deps.invalidateWindow();
        deps.renderVisible();
        windowRendered = false;
        deps.updateTrack();
        active = false;
        if (++attempts < 4 && Math.abs(deps.getTop() - target) > 1) requestAnimationFrame(restore);
        else scroll = null;
      }
      restore();
      if (scroll === saved) requestAnimationFrame(() => requestAnimationFrame(restore));
    }
    /** @param {ReturnType<SearchReaderNavigationApi['createNavigation']>} navigation */
    function restoreReaderSearchHandoff(navigation) {
      /** @type {ReaderReturnPosition | null | undefined} */
      let saved;
      try {
        const handoff = JSON.parse(sessionStorage.getItem("reader-navigation-restore") || "null");
        sessionStorage.removeItem("reader-navigation-restore");
        if (!handoff || handoff.returnUrl !== location.href) return;
        const current = /** @type {{readerUrl?: string; returnScroll?: ReaderReturnPosition} | null} */ (navigation.saved());
        if (!current || current.readerUrl !== handoff.readerUrl) return;
        const url = navigation.parse(handoff.readerUrl);
        const token = url.searchParams.get("nav");
        if (!token || sessionStorage.getItem("reader-return:" + token) !== location.href) return;
        saved = current.returnScroll;
        if (!saved || saved.route !== location.href || saved.viewKey !== deps.getViewKey() ||
            !Number.isInteger(saved.index) || saved.index < 0 || !Number.isFinite(saved.offset) || !Number.isFinite(saved.top)) return;
      } catch (_) { return; }
      const position = saved;
      const route = location.href;
      let cancelled = false;
      const cancel = () => { cancelled = true; cleanup(); };
      const events = ["pointerdown", "keydown", "focusin", "input", "compositionstart", "wheel", "touchstart"];
      const cleanup = () => { for (const type of events) document.removeEventListener(type, cancel, true); };
      for (const type of events) document.addEventListener(type, cancel, true);
      const revision = deps.readView().routeRevision;
      const deadline = Date.now() + 30000;
      const restore = () => {
        if (cancelled || revision !== deps.readView().routeRevision || location.href !== route || position.viewKey !== deps.getViewKey() || Date.now() > deadline) {
          cleanup(); return;
        }
        if (!deps.handoffReady(position)) { requestAnimationFrame(restore); return; }
        cleanup();
        scroll = position;
        deps.restoreScroll(false, true);
        const focus = position.focus;
        const element = focus && document.getElementById(focus.id);
        if (!element || (document.activeElement !== document.body && document.activeElement !== element)) return;
        element.focus({ preventScroll: true });
        if (element instanceof HTMLInputElement && Number.isInteger(focus.start) && Number.isInteger(focus.end) &&
            focus.direction && ["forward", "backward", "none"].includes(focus.direction)) {
          try { element.setSelectionRange(focus.start, focus.end, focus.direction); } catch (_) {}
        }
      };
      requestAnimationFrame(restore);
    }
    return Object.freeze({
      capture: captureReaderReturnScroll, ready: readerSearchHandoffReady,
      restore: restoreReaderReturnScroll, restoreHandoff: restoreReaderSearchHandoff,
      get scroll() { return scroll; },
      /** @param {ReaderReturnPosition | null} value */
      setScroll(value) { scroll = value; },
      invalidate() { generation++; },
      cancelOnScroll() { if (scroll && !active) { generation++; scroll = null; } }
    });
  }
  globalThis.VoiceOfMLReaderReturn = Object.freeze({ create });
})();

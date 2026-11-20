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
      const row = element?.matches('button[data-action="read"]') &&
        /** @type {HTMLElement | null} */ (element.closest('#results-list .result-item[data-reader-return-key]'));
      const saved = { route: location.href, viewKey: deps.getViewKey(), top, index, offset, focus };
      const key = row && row.dataset.readerReturnKey;
      return key ? { ...saved, resultFocus: { index: Number(row.dataset.index), key } } : saved;
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
    /** @param {ReaderReturnPosition} saved */
    function restoreReaderReturnFocus(saved) {
      if (saved.route !== location.href || saved.viewKey !== deps.getViewKey()) return;
      const { focus, resultFocus } = saved;
      let element = focus && document.getElementById(focus.id);
      if (resultFocus && typeof resultFocus.key === "string" && resultFocus.key &&
          Number.isInteger(resultFocus.index) && resultFocus.index >= 0) {
        const rows = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#results-list .result-item[data-reader-return-key]'))];
        const matches = rows.filter(row => row.dataset.readerReturnKey === resultFocus.key);
        const row = matches.find(row => Number(row.dataset.index) === resultFocus.index) ||
          (matches.length === 1 ? matches[0] : null);
        element = row?.querySelector('button[data-action="read"]') || null;
      }
      if (!element || (document.activeElement !== document.body && document.activeElement !== element)) return;
      element.focus({ preventScroll: true });
      if (focus && !resultFocus && element instanceof HTMLInputElement && Number.isInteger(focus.start) && Number.isInteger(focus.end) &&
          focus.direction && ["forward", "backward", "none"].includes(focus.direction)) {
        try { element.setSelectionRange(focus.start, focus.end, focus.direction); } catch (_) {}
      }
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
        restoreReaderReturnFocus(position);
      };
      requestAnimationFrame(restore);
    }
    return Object.freeze({
      capture: captureReaderReturnScroll, ready: readerSearchHandoffReady,
      restore: restoreReaderReturnScroll, restoreHandoff: restoreReaderSearchHandoff, restoreFocus: restoreReaderReturnFocus,
      get scroll() { return scroll; },
      /** @param {ReaderReturnPosition | null} value */
      setScroll(value) { scroll = value; },
      invalidate() { generation++; },
      cancelOnScroll() { if (scroll && !active) { generation++; scroll = null; } }
    });
  }
  globalThis.VoiceOfMLReaderReturn = Object.freeze({ create });
})();

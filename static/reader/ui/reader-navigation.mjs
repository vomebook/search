export function createReaderNavigation(readerContext) {
  function beginReaderNavigation() {
    if (readerContext.epubSeekFrame) cancelAnimationFrame(readerContext.epubSeekFrame);
    readerContext.epubSeekFrame = 0;
    readerContext.foliateScrollAnchors.invalidate();
    return readerContext.nextReaderGeneration("navigation");
  }

  function clearReturnNavigation() {
    try {
      if (readerContext.returnHistoryKey) sessionStorage.removeItem(readerContext.returnHistoryKey);
      const saved = JSON.parse(sessionStorage.getItem("reader-navigation-current") || "null");
      if (saved && (saved.readerUrl === location.href || saved.shareUrl === location.href))
        sessionStorage.removeItem("reader-navigation-current");
    } catch (_) {}
  }

  function navigateReaderFolder() {
    if (!readerContext.folderNavigationTarget) return;
    if (window.parent !== window)
      window.parent.postMessage(
        { type: "voice-reader-navigate", url: readerContext.folderNavigationTarget.href },
        location.origin
      );
    else {
      readerContext.clearReturnNavigation();
      location.assign(readerContext.folderNavigationTarget.href);
    }
  }

  function turnViewport(direction) {
    readerContext.beginReaderNavigation();
    const target = readerContext.htmlFrame?.contentWindow || readerContext.viewport;
    target.scrollBy({
      top:
        Math.max(160, (readerContext.htmlFrame?.contentWindow?.innerHeight || readerContext.viewport.clientHeight) * 0.86) *
        direction,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
    });
  }

  function handleReaderKeydown(event) {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    if (event.key === "Escape" && readerContext.panelState.open && readerContext.bookmarkPopover.hidden) {
      event.preventDefault();
      if (readerContext.readerUiHistoryState === "full-search") readerContext.closeFullSearchView();
      else readerContext.setReaderPanelOpen(false, true);
      return;
    }
    // Panel lists scroll independently. Inspect the composed path so a control
    // inside a chapter Shadow DOM is not mistaken for the reading surface.
    if ((event.composedPath?.() || [event.target]).some(node => node.closest?.(
      '#history-panel,input,textarea,select,button,a,audio,video,[role="button"],[role="link"],[contenteditable]:not([contenteditable=false])'
    )))
      return;
    if (["PageDown", " ", "ArrowDown", "PageUp", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      readerContext.turnViewport(
        ["PageUp", "ArrowUp"].includes(event.key) || (event.key === " " && event.shiftKey) ? -1 : 1
      );
    }
  }

  function handleReaderOutsideClick(event) {
    if (readerContext.readerLifecycle.disposed || readerContext.readerAbortController.signal.aborted ||
        !readerContext.panelState.open || !readerContext.bookmarkPopover.hidden) return;
    const path = event.composedPath();
    if (path.includes(document.querySelector("#history-panel")) || path.includes(document.querySelector("#history")) ||
        path.includes(readerContext.bookmarkPopover) || path.includes(readerContext.bookmarkRibbon)) return;
    // Do not consume the content click or move focus: text selection and book
    // links keep their ordinary behavior, including inside the HTML iframe.
    readerContext.setReaderPanelOpen(false);
  }

  function readerPageScrollTop(shell) {
    return readerContext.viewport.scrollTop + shell.getBoundingClientRect().top -
      readerContext.viewport.getBoundingClientRect().top - readerContext.viewport.clientTop;
  }

  async function goToPage(value, generation = readerContext.beginReaderNavigation()) {
    try {
      if (!readerContext.documentState.pageCount || !readerContext.isReaderGenerationCurrent("navigation", generation))
        return false;
      const page = VoiceOfMLReader.clampNumber(value, 1, readerContext.documentState.pageCount, 1);
      readerContext.pdfShellWindow?.ensure(page);
      // The first page is usable before the background shell queue finishes.
      // Only wait when the requested shell has not been materialized yet.
      let shell = readerContext.content.querySelector(
        `.reader-page[data-page="${page}"]`
      );
      if (!shell && ["pdf-pages", "image-pages"].includes(readerContext.capability.mode)) {
        await readerContext.pdfShellsReady;
        shell = readerContext.content.querySelector(`.reader-page[data-page="${page}"]`);
      }
      if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
      if (!shell) return false;
      const imagePage = ["pdf-pages", "image-pages"].includes(readerContext.capability.mode);
      if (imagePage && shell.dataset.renderState !== "rendered")
        readerContext.prioritizePdfManifestPrefetch(readerContext.pdfPageManifest?.pageUrl(page));
      const pendingPdf =
        !imagePage && shell.classList.contains("reader-page")
          ? readerContext.renderPdfInBackground(shell, false, true)
          : null;
      if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
      readerContext.viewport.scrollTop = readerContext.readerPageScrollTop(shell);
      if (imagePage && shell.dataset.renderState === "rendered") readerContext.renderPdfOcrText(shell);
      readerContext.pageNavigationLockUntil = performance.now() + 500;
      if (pendingPdf) readerContext.cancelSpeculativePdfRenders(shell);
      const pendingImage = imagePage ? readerContext.renderPdfInBackground(shell, false, true) : null;
      if (imagePage && shell.dataset.renderState !== "rendered") readerContext.cancelSpeculativePdfRenders(shell);
      readerContext.updateDocumentState({ page });
      readerContext.pageInput.value = String(page);
      readerContext.updateTocCurrentMark();
      readerContext.updateProgressTools();
      pendingPdf?.catch(() => {});
      pendingImage?.catch(() => {});
      if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
      readerContext.scheduleSave();
      return true;
    } catch (error) {
      readerContext.handlePageNavigationFailure(error, generation);
      return false;
    }
  }

  function handleReaderPositionChange() {
    if (readerContext.readerAbortController.signal.aborted) return;
    readerContext.notePdfViewportMotion?.();
    if (readerContext.viewport.scrollTop !== readerContext.pdfLastScrollTop) readerContext.pdfScrollDirection = readerContext.viewport.scrollTop > readerContext.pdfLastScrollTop ? 1 : -1;
    readerContext.pdfLastScrollTop = readerContext.viewport.scrollTop;
    readerContext.pdfShellWindow?.schedule();
    readerContext.scheduleVisiblePdfRenderReconciliation?.(true);
    readerContext.scheduleMarkerSync();
    readerContext.scheduleFoliateScrollSync();
    readerContext.foliateScrollAnchors.remember();
  }

  async function navigateReader(rawUrl, bookmark = null) {
    let target;
    try {
      target = new URL(rawUrl, location.origin);
      if (
        target.origin !== location.origin ||
        target.pathname !== "/search/static/reader.html" ||
        target.username ||
        target.password
      )
        return;
      target.searchParams.delete("bookmark");
      target.searchParams.delete("bookmark_source");
      if (bookmark) {
        if (
          typeof bookmark.id !== "string" ||
          !bookmark.id ||
          typeof bookmark.url !== "string" ||
          !bookmark.url
        )
          return;
        target.searchParams.set("bookmark", bookmark.id);
        target.searchParams.set("bookmark_source", bookmark.url);
      }
    } catch (_) {
      return;
    }
    const generation = readerContext.beginReaderNavigation();
    await readerContext.saveProgress();
    if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return;
    if (window.parent !== window)
      window.parent.postMessage({ type: "voice-reader-open", url: target.href }, location.origin);
    else location.assign(target.href);
  }

  function notePdfScrollIntent() {
    readerContext.pdfUserHasScrolled = true;
    readerContext.beginReaderNavigation();
  }

  function installReaderTapSelectionClear(region, eventRoot = region.ownerDocument) {
    let tap = null;
    const down = (event) => {
      tap = null;
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      const target = event.composedPath()[0];
      if (target.closest?.("a,button,input,textarea,select,[contenteditable]")) return;
      const root = target.getRootNode();
      const selection = root.getSelection?.() || eventRoot.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      tap = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(),
        selection, anchor: selection.anchorNode, anchorOffset: selection.anchorOffset,
        focus: selection.focusNode, focusOffset: selection.focusOffset };
    };
    const move = (event) => {
      if (tap && event.pointerId === tap.id && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 8)
        tap = null;
    };
    const up = (event) => {
      const start = tap;
      tap = null;
      if (!start || event.pointerId !== start.id || performance.now() - start.time > 300 ||
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
      const selection = start.selection;
      if (selection.anchorNode === start.anchor && selection.anchorOffset === start.anchorOffset &&
          selection.focusNode === start.focus && selection.focusOffset === start.focusOffset)
        selection.removeAllRanges();
    };
    const cancel = () => { tap = null; };
    region.addEventListener("pointerdown", down, { passive: true });
    eventRoot.addEventListener("pointermove", move, { passive: true });
    eventRoot.addEventListener("pointerup", up, { passive: true });
    eventRoot.addEventListener("pointercancel", cancel, { passive: true });
    readerContext.trackReaderResource(() => {
      region.removeEventListener("pointerdown", down);
      eventRoot.removeEventListener("pointermove", move);
      eventRoot.removeEventListener("pointerup", up);
      eventRoot.removeEventListener("pointercancel", cancel);
      tap = null;
    });
  }

  return {
    beginReaderNavigation,
    clearReturnNavigation,
    navigateReaderFolder,
    turnViewport,
    handleReaderKeydown,
    handleReaderOutsideClick,
    readerPageScrollTop,
    goToPage,
    handleReaderPositionChange,
    navigateReader,
    notePdfScrollIntent,
    installReaderTapSelectionClear
  };
}

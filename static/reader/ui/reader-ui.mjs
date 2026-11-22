/** @param {import('../../../typings/reader-ui-component-strict').ReaderUiContext} readerContext */
export function createReaderUi(readerContext) {
  /** @param {string} message @param {number} [duration] */
  function showDownloadFeedback(message, duration = 4000) {
    clearTimeout(readerContext.downloadFeedbackTimer);
    readerContext.downloadFeedback.textContent = message;
    readerContext.downloadFeedback.hidden = !message;
    if (message && duration) readerContext.downloadFeedbackTimer = setTimeout(() => readerContext.showDownloadFeedback(""), duration);
  }

  /** @param {import('../../../typings/reader-ui-component-strict').ReaderUiDocumentPatch} patch */
  function updateDocumentState(patch) {
    return readerContext.readerRuntime.update("document", patch);
  }

  /** @param {import('../../../typings/reader-ui-component-strict').ReaderUiPanelPatch} patch */
  function updatePanelState(patch) {
    return readerContext.readerRuntime.update("panel", patch);
  }

  function applyPageInversion(persist = false) {
    document.documentElement.dataset.pageInverted = String(readerContext.pageInverted);
    readerContext.pageInvertToggle.textContent = readerContext.pageInverted ? "关闭页面反色" : "页面反色";
    readerContext.pageInvertToggle.title = readerContext.pageInvertToggle.textContent;
    readerContext.pageInvertToggle.setAttribute("aria-label", readerContext.pageInvertToggle.textContent);
    readerContext.pageInvertToggle.setAttribute("aria-pressed", String(readerContext.pageInverted));
    if (persist) {
      try { localStorage.setItem("reader-page-inversion", String(readerContext.pageInverted)); } catch (_) {}
    }
  }

  /** @param {string} theme @param {boolean} [persist] @param {boolean} [animate] */
  function applyReaderTheme(theme, persist = true, animate = true) {
    const anchor = readerContext.chapterScrollAnchors.capture();
    if (animate) {
      clearTimeout(readerContext.themeAnimationTimer);
      document.documentElement.classList.add("theme-transition");
      void document.documentElement.offsetWidth;
    } else {
      clearTimeout(readerContext.themeAnimationTimer);
      document.documentElement.classList.remove("theme-transition");
      readerContext.readerThemeToggle.classList.remove("is-changing");
    }
    readerContext.readerTheme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = readerContext.readerTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", readerContext.readerTheme === "light" ? "#f4f5f6" : "#111315");
    const frame = readerContext.htmlFrame;
    const frameRoot = frame?.contentDocument?.documentElement;
    if (frame && frameRoot?.hasAttribute("data-reader-theme")) {
      frameRoot.dataset.readerTheme = readerContext.readerTheme;
      readerContext.repairHtmlContrast(frame);
    }
    readerContext.readerThemeToggle.innerHTML = readerContext.readerTheme === "dark" ? readerContext.THEME_MOON_ICON : readerContext.THEME_SUN_ICON;
    if (animate) {
      readerContext.readerThemeToggle.classList.remove("is-changing");
      void readerContext.readerThemeToggle.offsetWidth;
      readerContext.readerThemeToggle.classList.add("is-changing");
      readerContext.themeAnimationTimer = setTimeout(() => {
        document.documentElement.classList.remove("theme-transition");
        readerContext.readerThemeToggle.classList.remove("is-changing");
      }, 280);
    }
    readerContext.readerThemeToggle.title = readerContext.readerTheme === "dark" ? "切换到白天模式" : "切换到夜间模式";
    readerContext.readerThemeToggle.setAttribute("aria-label", readerContext.readerThemeToggle.title);
    readerContext.readerThemeToggle.setAttribute("aria-pressed", String(readerContext.readerTheme === "light"));
    if (persist) {
      try { localStorage.setItem("theme", readerContext.readerTheme); } catch (_) {}
    }
    readerContext.chapterScrollAnchors.restore(anchor);
  }

  /** @param {number} percent @param {boolean} [persist] */
  function setZoom(percent, persist = true) {
    const anchor = readerContext.chapterScrollAnchors.capture();
    const mode = readerContext.capability.mode;
    const pdfAnchor = mode === "pdf" || mode === "pdf-pages" || mode === "image-pages"
      ? readerContext.pageAtMarker() : null;
    const pdfBounds = pdfAnchor?.getBoundingClientRect();
    const pdfOffset = pdfBounds ? (readerContext.viewport.getBoundingClientRect().top - pdfBounds.top) / Math.max(1, pdfBounds.height) : 0;
    const pdfAtEnd = !!pdfBounds && readerContext.viewport.scrollTop > 0 &&
      readerContext.viewport.scrollHeight - readerContext.viewport.clientHeight - readerContext.viewport.scrollTop <= 2;
    const normalized = VoiceOfMLReader.clampNumber(percent, 25, 400, 100);
    const horizontalCenter = readerContext.viewport.scrollWidth
      ? (readerContext.viewport.scrollLeft + readerContext.viewport.clientWidth / 2) / readerContext.viewport.scrollWidth
      : 0;
    readerContext.updateDocumentState({ zoom: normalized / 100 });
    readerContext.content.style.setProperty("--reader-zoom", String(readerContext.documentState.zoom));
    readerContext.zoomInput.value = String(normalized);
    readerContext.pdfShellWindow?.resize();
    if (pdfAnchor?.isConnected) {
      if (pdfAtEnd) readerContext.viewport.scrollTop = readerContext.viewport.scrollHeight - readerContext.viewport.clientHeight;
      else {
        const bounds = pdfAnchor.getBoundingClientRect();
        readerContext.viewport.scrollTop += bounds.top - readerContext.viewport.getBoundingClientRect().top + pdfOffset * bounds.height;
      }
    }
    if (readerContext.htmlFrame && readerContext.htmlFrame.contentDocument)
      readerContext.htmlFrame.contentDocument.documentElement.style.zoom = String(readerContext.documentState.zoom);
    if (readerContext.pdfDocument) readerContext.rerenderVisiblePdfPages();
    readerContext.viewport.scrollLeft = horizontalCenter * readerContext.viewport.scrollWidth - readerContext.viewport.clientWidth / 2;
    if (persist) {
      readerContext.zoomChangedByUser = true;
      try { localStorage.setItem("reader-zoom", String(normalized)); } catch (_) {}
    }
    readerContext.chapterScrollAnchors.restore(anchor);
    if (persist) readerContext.scheduleSave();
  }

  /** @param {Element} list @param {string} message */
  function emptyPanel(list, message) {
    list.innerHTML = `<div class="panel-empty">${message}</div>`;
  }

  /** @param {HTMLElement} item @param {string} query */
  function highlightPanelItem(item, query) {
    /** @type {Text[]} */
    const nodes = [];
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = /** @type {Text} */ (walker.currentNode);
      if (!/** @type {HTMLElement} */ (node.parentElement).closest(".panel-item-remove")) nodes.push(node);
    }
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    for (const node of nodes) {
      const text = node.data,
        matches = [...text.matchAll(pattern)];
      if (!matches.length) continue;
      let start = 0;
      const fragment = document.createDocumentFragment();
      for (const match of matches) {
        fragment.append(text.slice(start, match.index));
        const mark = document.createElement("mark");
        mark.className = "search-match";
        mark.textContent = match[0];
        fragment.append(mark);
        start = match.index + match[0].length;
      }
      fragment.append(text.slice(start));
      node.replaceWith(fragment);
    }
  }

  /** @param {HTMLElement} view @param {{resetScroll?: boolean}} [options] */
  function filterPanel(view, {resetScroll = true} = {}) {
    const input = /** @type {HTMLInputElement} */ (view.querySelector(".panel-search"));
    const query = input.hidden ? "" : (input.value || "").trim().toLowerCase();
    let status = /** @type {HTMLElement | null} */ (view.querySelector(".panel-filter-empty"));
    if (!status) {
      status = document.createElement("div");
      status.className = "panel-filter-empty panel-empty";
      status.setAttribute("role", "status");
      status.textContent = "没有匹配的内容";
      status.hidden = true;
      view.appendChild(status);
    }
    const state = view.id === "toc-panel" ? readerContext.tocVirtualState : null;
    if (state) {
      // Filter the full logical TOC, not just the currently mounted window.
      if (query === state.query) {
        status.hidden = !query || state.matches.length > 0;
        return;
      }
      readerContext.clearSearchHighlights(view);
      state.query = query;
      state.matches = [];
      state.entries.forEach((entry, index) => {
        if (!query || entry.label.toLowerCase().includes(query)) state.matches.push(index);
      });
      state.list.style.height = `${state.matches.length * readerContext.TOC_VIRTUAL_ROW_HEIGHT}px`;
      if (resetScroll) state.panelView.scrollTop = 0;
      state.render();
      status.hidden = !query || state.matches.length > 0;
      return;
    }
    readerContext.clearSearchHighlights(view);
    const items = /** @type {NodeListOf<HTMLElement>} */ (view.querySelectorAll(".panel-item"));
    if (!query) {
      for (const item of items) if (item.hidden) item.hidden = false;
      status.hidden = true;
      return;
    }
    let count = 0;
    for (const item of items) {
      const searchableText = [...item.children]
        .filter((child) => !child.classList.contains("panel-item-remove"))
        .map((child) => child.textContent)
        .join(" ")
        .toLowerCase();
      item.hidden = !searchableText.includes(query);
      if (!item.hidden) {
        count++;
        readerContext.highlightPanelItem(item, query);
      }
    }
    status.hidden = count > 0 || !!view.querySelector(".panel-list > .panel-empty");
  }

  /** @param {string} state */
  function notifyReaderUiState(state) {
    readerContext.readerUiHistoryState = state;
    if (readerContext.isReaderOverlayFrame())
      window.parent.postMessage({ type: "voice-reader-ui-state", state }, location.origin);
  }

  /** @param {boolean} open @param {boolean} [restoreFocus] @param {boolean} [focusPanel] */
  function setReaderPanelOpen(open, restoreFocus = false, focusPanel = false) {
    readerContext.readerRuntime.update("panel", { open });
    const panel = /** @type {HTMLElement} */ (document.querySelector("#history-panel"));
    const focusWasInside = panel.contains(document.activeElement);
    clearTimeout(readerContext.panelAnimationTimer);
    /** @type {HTMLElement} */ (document.querySelector("#history")).setAttribute("aria-expanded", String(open));
    if (open) {
      readerContext.readerPanelInteractionSerial++;
      panel.hidden = false;
      panel.inert = false;
      void panel.offsetWidth;
      panel.classList.add("is-open");
      readerContext.selectPanel(readerContext.panelState.selected === "full-search" ? "full-search" : readerContext.mediaElement ? "media" : "toc");
      readerContext.updateTocCurrentMark();
      notifyReaderUiState(readerContext.panelState.selected === "full-search" ? "full-search" : "panel");
      // Only an explicit keyboard/assistive activation moves focus. Automatic
      // directory discovery and ordinary pointer opening leave reading alone.
      if (focusPanel) /** @type {HTMLElement} */ (panel.querySelector('#full-search-view:not([hidden]) input') ||
        panel.querySelector('.reader-panel-tabs button[aria-selected="true"]:not([hidden])') ||
        panel.querySelector('#history-close')).focus({ preventScroll: true });
      return;
    }
    panel.classList.remove("is-open");
    panel.inert = true;
    readerContext.panelAnimationTimer = setTimeout(() => {
      if (!panel.classList.contains("is-open")) panel.hidden = true;
    }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 190);
    notifyReaderUiState("base");
    if (restoreFocus || focusWasInside) /** @type {HTMLElement} */ (document.querySelector("#history")).focus({ preventScroll: true });
  }

  /** @param {HTMLElement} button @param {boolean} open */
  function setPanelSearchOpen(button, open) {
    const view = /** @type {HTMLElement} */ (button.closest(".reader-panel-view")), input = /** @type {HTMLInputElement} */ (view.querySelector(".panel-search"));
    button.setAttribute("aria-expanded", String(open));
    input.inert = !open;
    if (open) {
      input.hidden = false;
      void input.offsetWidth;
      input.classList.add("is-open");
      input.focus();
      return;
    }
    if (input.value) { input.value = ""; readerContext.filterPanel(view); }
    if (view.id === "toc-panel") view.querySelector(".panel-filter-empty")?.setAttribute("hidden", "");
    input.classList.remove("is-open");
    setTimeout(() => {
      if (!input.classList.contains("is-open")) input.hidden = true;
    }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150);
    button.focus();
  }

  /** @param {string} name */
  function selectPanel(name) {
    if (name === "media" && readerContext.mediaTab.hidden) name = "bookmarks";
    if (readerContext.panelState.open && name !== readerContext.panelState.selected)
      readerContext.readerPanelInteractionSerial++;
    readerContext.updatePanelState({ selected: name });
    if (readerContext.progressTools) readerContext.progressTools.hidden = !["toc", "media"].includes(name);
    for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(".reader-panel-tabs button"))) {
      const selected = button.dataset.panel === name;
      // With no TOC this view still contains reading progress. Give the
      // visible tablist a real selected tab rather than a hidden tab stop.
      if (selected && name === "toc" && button.hidden) {
        button.textContent = "阅读";
        button.hidden = false;
      }
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const view of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".reader-panel-view")))
      view.hidden = view.dataset.panelView !== name;
    if (name === "full-search") notifyReaderUiState("full-search");
    else if (readerContext.panelState.open) notifyReaderUiState("panel");
    if (name === "bookmarks") readerContext.renderBookmarks();
    if (name === "history") readerContext.renderHistory();
    if (name === "media" && readerContext.mediaElement)
      /** @type {HTMLElement} */ (readerContext.mediaPanel.querySelector(".media-panel-time")).textContent =
        `${readerContext.formatMediaTime(readerContext.mediaElement.currentTime)} / ${readerContext.formatMediaTime(readerContext.mediaElement.duration)}`;
    readerContext.updateProgressTools();
  }

  async function renderHistory() {
    const list = /** @type {HTMLElement} */ (document.querySelector("#history-list")),
      generation = readerContext.nextReaderGeneration("history");
    try {
      const entries = await VoiceOfMLReaderStore.list();
      if (!readerContext.isReaderGenerationCurrent("history", generation)) return;
      list.textContent = "";
      for (const entry of entries) {
        const row = document.createElement("div");
        row.className = "panel-item";
        if (entry.mediaTime != null) row.dataset.mediaTime = String(entry.mediaTime);
        const link = document.createElement("button");
        link.type = "button";
        link.className = "panel-item-main";
        link.textContent = entry.title || entry.url;
        link.addEventListener("click", () => readerContext.navigateReader(/** @type {string} */ (entry.readerUrl), null, true));
        const meta = document.createElement("small");
        meta.textContent = `${entry.pageCount ? `第 ${entry.page || 1} / ${entry.pageCount} 页 · ` : ""}${new Date(entry.lastReadAt).toLocaleString()}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "panel-item-remove";
        remove.textContent = "删除";
        remove.setAttribute("aria-label", `删除阅读记录：${entry.title || entry.url}`);
        remove.addEventListener("click", async () => {
          if (entry.url === readerContext.sourceUrl) {
            readerContext.historySuppressed = true;
            await readerContext.progressSaveChain;
          }
          await VoiceOfMLReaderStore.remove(entry.url);
          readerContext.renderHistory();
        });
        row.append(link, remove, meta);
        list.appendChild(row);
      }
      if (!list.childElementCount) readerContext.emptyPanel(list, "暂无阅读记录");
      readerContext.filterPanel(/** @type {HTMLElement} */ (document.querySelector("#history-view")));
    } catch (_) {
      if (readerContext.isReaderGenerationCurrent("history", generation)) readerContext.emptyPanel(list, "无法读取本地记录");
    }
  }

  return {
    showDownloadFeedback,
    updateDocumentState,
    updatePanelState,
    applyPageInversion,
    applyReaderTheme,
    setZoom,
    emptyPanel,
    highlightPanelItem,
    filterPanel,
    setReaderPanelOpen,
    setPanelSearchOpen,
    selectPanel,
    renderHistory
  };
}

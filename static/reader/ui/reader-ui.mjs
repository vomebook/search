export function createReaderUi(readerContext) {
  function showDownloadFeedback(message, duration = 4000) {
    clearTimeout(readerContext.downloadFeedbackTimer);
    readerContext.downloadFeedback.textContent = message;
    readerContext.downloadFeedback.hidden = !message;
    if (message && duration) readerContext.downloadFeedbackTimer = setTimeout(() => readerContext.showDownloadFeedback(""), duration);
  }

  function updateDocumentState(patch) {
    return readerContext.readerRuntime.update("document", patch);
  }

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

  function applyReaderTheme(theme, persist = true, animate = true) {
    const anchor = readerContext.foliateScrollAnchors.capture();
    if (animate) {
      clearTimeout(readerContext.themeAnimationTimer);
      document.documentElement.classList.add("theme-transition");
      void document.documentElement.offsetWidth;
    }
    readerContext.readerTheme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = readerContext.readerTheme;
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
    for (const article of readerContext.content.querySelectorAll(".foliate-continuous > article"))
      article.classList.toggle("reader-document-dark", readerContext.readerTheme === "dark");
    if (persist) {
      try { localStorage.setItem("theme", readerContext.readerTheme); } catch (_) {}
    }
    readerContext.foliateScrollAnchors.restore(anchor);
  }

  function setZoom(percent, persist = true) {
    const anchor = readerContext.foliateScrollAnchors.capture();
    const pdfAnchor = readerContext.pdfHybridUrl ? readerContext.pageAtMarker() : null;
    const pdfBounds = pdfAnchor?.getBoundingClientRect();
    const pdfOffset = pdfBounds ? (readerContext.viewport.getBoundingClientRect().top - pdfBounds.top) / Math.max(1, pdfBounds.height) : 0;
    const normalized = VoiceOfMLReader.clampNumber(percent, 25, 400, 100);
    const horizontalCenter = readerContext.viewport.scrollWidth
      ? (readerContext.viewport.scrollLeft + readerContext.viewport.clientWidth / 2) / readerContext.viewport.scrollWidth
      : 0;
    readerContext.updateDocumentState({ zoom: normalized / 100 });
    readerContext.content.style.setProperty("--reader-zoom", String(readerContext.documentState.zoom));
    readerContext.zoomInput.value = String(normalized);
    readerContext.pdfShellWindow?.resize();
    if (pdfAnchor?.isConnected) {
      const bounds = pdfAnchor.getBoundingClientRect();
      readerContext.viewport.scrollTop += bounds.top - readerContext.viewport.getBoundingClientRect().top + pdfOffset * bounds.height;
    }
    if (readerContext.htmlFrame && readerContext.htmlFrame.contentDocument)
      readerContext.htmlFrame.contentDocument.documentElement.style.zoom = String(readerContext.documentState.zoom);
    if (readerContext.pdfDocument) readerContext.rerenderVisiblePdfPages();
    if (readerContext.capability.mode === "foliate")
      readerContext.content.style.setProperty("--reader-zoom", String(readerContext.documentState.zoom));
    readerContext.viewport.scrollLeft = horizontalCenter * readerContext.viewport.scrollWidth - readerContext.viewport.clientWidth / 2;
    if (persist) {
      readerContext.zoomChangedByUser = true;
      try { localStorage.setItem("reader-zoom", String(normalized)); } catch (_) {}
    }
    readerContext.foliateScrollAnchors.restore(anchor);
    if (persist) readerContext.scheduleSave();
  }

  function emptyPanel(list, message) {
    list.innerHTML = `<div class="panel-empty">${message}</div>`;
  }

  function highlightPanelItem(item, query) {
    const nodes = [];
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    while (walker.nextNode())
      if (!walker.currentNode.parentElement.closest(".panel-item-remove"))
        nodes.push(walker.currentNode);
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

  function filterPanel(view) {
    readerContext.clearSearchHighlights(view);
    const query = (view.querySelector(".panel-search").value || "").trim().toLowerCase();
    for (const item of view.querySelectorAll(".panel-item")) {
      const searchableText = [...item.children]
        .filter((child) => !child.classList.contains("panel-item-remove"))
        .map((child) => child.textContent)
        .join(" ")
        .toLowerCase();
      item.hidden = !!query && !searchableText.includes(query);
      if (query && !item.hidden) readerContext.highlightPanelItem(item, query);
    }
  }

  function notifyReaderUiState(state) {
    readerContext.readerUiHistoryState = state;
    if (readerContext.isReaderOverlayFrame())
      window.parent.postMessage({ type: "voice-reader-ui-state", state }, location.origin);
  }

  function setReaderPanelOpen(open, restoreFocus = false, focusPanel = false) {
    readerContext.readerRuntime.update("panel", { open });
    const panel = document.querySelector("#history-panel");
    const focusWasInside = panel.contains(document.activeElement);
    clearTimeout(readerContext.panelAnimationTimer);
    document.querySelector("#history").setAttribute("aria-expanded", String(open));
    if (open) {
      readerContext.readerPanelInteractionSerial++;
      panel.hidden = false;
      panel.inert = false;
      void panel.offsetWidth;
      panel.classList.add("is-open");
      readerContext.selectPanel(readerContext.panelState.selected === "full-search" ? "full-search" : readerContext.mediaElement ? "media" : "toc");
      readerContext.updateTocCurrentMark();
      readerContext.notifyReaderUiState(readerContext.panelState.selected === "full-search" ? "full-search" : "panel");
      // Only an explicit keyboard/assistive activation moves focus. Automatic
      // directory discovery and ordinary pointer opening leave reading alone.
      if (focusPanel) (panel.querySelector('#full-search-view:not([hidden]) input') ||
        panel.querySelector('.reader-panel-tabs button[aria-selected="true"]:not([hidden])') ||
        panel.querySelector('#history-close')).focus({ preventScroll: true });
      return;
    }
    panel.classList.remove("is-open");
    panel.inert = true;
    readerContext.panelAnimationTimer = setTimeout(() => {
      if (!panel.classList.contains("is-open")) panel.hidden = true;
    }, 250);
    readerContext.notifyReaderUiState("base");
    if (restoreFocus || focusWasInside) document.querySelector("#history").focus({ preventScroll: true });
  }

  function setPanelSearchOpen(button, open) {
    const input = button.closest(".reader-panel-view").querySelector(".panel-search");
    button.setAttribute("aria-expanded", String(open));
    input.inert = !open;
    if (open) {
      input.hidden = false;
      void input.offsetWidth;
      input.classList.add("is-open");
      input.focus();
      return;
    }
    input.classList.remove("is-open");
    setTimeout(() => {
      if (!input.classList.contains("is-open")) input.hidden = true;
    }, 190);
    button.focus();
  }

  function selectPanel(name) {
    if (name === "media" && readerContext.mediaTab.hidden) name = "bookmarks";
    readerContext.updatePanelState({ selected: name });
    if (readerContext.progressTools) readerContext.progressTools.hidden = !["toc", "media"].includes(name);
    for (const button of document.querySelectorAll(".reader-panel-tabs button")) {
      const selected = button.dataset.panel === name;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const view of document.querySelectorAll(".reader-panel-view"))
      view.hidden = view.dataset.panelView !== name;
    if (name === "full-search") readerContext.notifyReaderUiState("full-search");
    else if (readerContext.panelState.open) readerContext.notifyReaderUiState("panel");
    if (name === "bookmarks") readerContext.renderBookmarks();
    if (name === "history") readerContext.renderHistory();
    if (name === "media" && readerContext.mediaElement)
      readerContext.mediaPanel.querySelector(".media-panel-time").textContent =
        `${readerContext.formatMediaTime(readerContext.mediaElement.currentTime)} / ${readerContext.formatMediaTime(readerContext.mediaElement.duration)}`;
    readerContext.updateProgressTools();
  }

  async function renderHistory() {
    const list = document.querySelector("#history-list"),
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
        link.addEventListener("click", () => readerContext.navigateReader(entry.readerUrl));
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
      readerContext.filterPanel(document.querySelector("#history-view"));
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
    notifyReaderUiState,
    setReaderPanelOpen,
    setPanelSearchOpen,
    selectPanel,
    renderHistory
  };
}

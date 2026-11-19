/** @param {import('../../../typings/reader-bindings-strict').ReaderBindingsContext} readerContext */
export function createReaderBindings(readerContext) {
  function trackStartupOwners() {
    readerContext.readerRuntime.track(readerContext.readerRequestManager);
    readerContext.readerRuntime.track(readerContext.formatAdapters);
    readerContext.readerRuntime.track(window.__VOICE_PDF_PRELOAD__);
    readerContext.readerRuntime.track(window.__VOICE_READER_CHAPTER_PRELOAD__);
  }

  function trackWorkCancellation() {
    readerContext.readerRuntime.track(readerContext.stopReaderWork);
  }

  function trackEarlySourceResolution() {
    readerContext.trackReaderResource(() => window.__VOICE_READER_RESOLVE__?.dispose());
  }

  function publishDiagnosticsAndInstallCompatibility() {
    window.VoiceOfMLReaderPdfDiagnostics = readerContext.pdfDiagnostics;
    readerContext.trackReaderResource(() => {
      readerContext.pdfPageTimings.length = 0;
      if (window.VoiceOfMLReaderPdfDiagnostics === readerContext.pdfDiagnostics) delete window.VoiceOfMLReaderPdfDiagnostics;
    });

    // Polyfills for vendor engines (pdf.js, foliate): neither helper has a direct
    // caller in first-party code, but both are required by pinned vendor bundles.
    if (!Map.prototype.getOrInsertComputed) {
      Map.prototype.getOrInsertComputed = function (key, callback) {
        if (this.has(key)) return this.get(key);
        const value = callback(key);
        this.set(key, value);
        return value;
      };
    }
    if (!Math.sumPrecise) {
      Math.sumPrecise = function (values) {
        let sum = 0;
        let correction = 0;
        for (const value of values) {
          const next = sum + value;
          correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
          sum = next;
        }
        return sum + correction;
      };
    }
  }

  function readSelectedSourceSession() {
    try {
      const value = /** @type {unknown} */ (JSON.parse(sessionStorage.getItem(`reader-source:${readerContext.readerId}`) || "null"));
      readerContext.localReaderData = value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
      if (readerContext.localReaderData) sessionStorage.removeItem(`reader-source:${readerContext.readerId}`);
    } catch (_) {}
    return readerContext.localReaderData;
  }

  function normalizeConvertedPdfMode() {
    if (
      readerContext.extension === "pdf" &&
      /\/api\/reader-bucket-resource\?/.test(readerContext.sourceUrl) &&
      new URL(readerContext.sourceUrl, location.href).searchParams.get("path")?.endsWith("page-manifest.json")
    ) {
      readerContext.extension = "pdf-pages";
      readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability(readerContext.extension));
    }
  }

  function applySourceSessionAndCachedMetadata() {
    const source = readerContext.localReaderData;
    if (source && typeof source === "object") {
      if ("title" in source && source.title) readerContext.params.set("title", String(source.title));
      if ("extension" in source && source.extension) readerContext.params.set("ext", String(source.extension));
      if ("repo" in source && source.repo) {
        const folder = "folder" in source ? source.folder : null;
        readerContext.params.set("path", [source.repo, ...(Array.isArray(folder) || typeof folder === "string" ? folder : [])].join("/"));
      }
    }
    try {
      const cached = sessionStorage.getItem(`reader-resolve:${readerContext.readerId}`);
      if (cached) {
        const value = /** @type {unknown} */ (JSON.parse(cached));
        readerContext.cachedReaderData = value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
        readerContext.resolvedReaderData = readerContext.cachedReaderData;
        sessionStorage.removeItem(`reader-resolve:${readerContext.readerId}`);
      }
    } catch (_) {}
  }

  function publishSourceAndSubscribeToStore() {
    readerContext.readerRuntime.update("source", {
      id: readerContext.readerId,
      url: readerContext.sourceUrl,
      contentUrl: readerContext.contentUrl,
      downloadUrl: readerContext.downloadUrl,
      extension: readerContext.extension,
      metadata: readerContext.resolvedReaderData
    });
    readerContext.readerRuntime.events.on("phase", (detail) => {
      if (detail && typeof detail === "object" && "phase" in detail && typeof detail.phase === "string")
        document.documentElement.dataset.readerPhase = detail.phase;
    });
    readerContext.readerRuntime.track(
      VoiceOfMLReaderStore.subscribe?.((change) => {
        if (!change?.remote || typeof change.type !== "string" || readerContext.readerLifecycle.disposed) return;
        if (
          change.type === "history-clear" ||
          (change.type === "history-remove" && change.url === readerContext.sourceUrl)
        ) {
          readerContext.historySuppressed = true;
          readerContext.readerRuntime.cancel(readerContext.saveTimer);
          readerContext.saveTimer = readerContext.saveDeadline = 0;
        }
        if (
          ["history", "history-clear", "history-remove"].includes(change.type) &&
          !/** @type {HTMLElement} */ (document.querySelector("#history-panel")).hidden
        )
          readerContext.renderHistory();
        if (
          ["bookmark", "bookmark-remove"].includes(change.type) &&
          (readerContext.panelState.showingAllBookmarks || !change.url || change.url === readerContext.sourceUrl) &&
          !/** @type {HTMLElement} */ (document.querySelector("#bookmarks-panel")).hidden
        )
          readerContext.renderBookmarks();
      })
    );

    readerContext.setReaderPhase("startup");
    /** @param {string} url */
    window.fetchFile = async (url) => {
      const requestUrl = String(url) === readerContext.sourceUrl ? readerContext.contentUrl : url;
      const response = await readerContext.readerRequestManager.request(requestUrl, readerContext.READER_PROXY_TIMEOUT_MS);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const fileName = new URL(url, location.href).pathname.split("/").pop() || "book";
      return new File(
        [
          await VoiceOfMLReaderSecurity.readBytes(
            response,
            VoiceOfMLReaderSecurity.LIMITS.archiveCompressedBytes
          )
        ],
        fileName,
        { type: response.headers.get("content-type") || "application/octet-stream" }
      );
    };
  }

  function initializePanelAccessibility() {
    document.querySelectorAll('.reader-toolbar svg, #history-panel > header svg').forEach(node => {
      node.setAttribute('aria-hidden', 'true'); node.setAttribute('focusable', 'false');
    });
    document.querySelector(".reader-panel-tabs")?.setAttribute("role", "tablist");
    document.querySelector(".reader-skip-link")?.addEventListener("click", (event) => {
      event.preventDefault();
      readerContext.setReaderPanelOpen(false);
      readerContext.viewport.focus({ preventScroll: true });
    });
  }

  function mountInitialLoadingFeedback() {
    readerContext.loadingIndicator.className = "reader-loading-indicator";
    readerContext.loadingIndicator.setAttribute("role", "status");
    readerContext.loadingIndicator.innerHTML =
      '<span class="reader-loading-spinner" aria-hidden="true"></span><span>正在加载正文...</span>';
    readerContext.content.appendChild(readerContext.loadingIndicator);
    readerContext.content.dataset.mode = readerContext.capability.mode || "unsupported";
  }

  function bindDownloadAction() {
    readerContext.downloadButton.addEventListener("click", readerContext.startReaderDownload);
    readerContext.loadingStatus.textContent = "";
  }

  function initializeDocumentTitle() {
    let savedZoom = null;
    try { savedZoom = localStorage.getItem("reader-zoom"); } catch (_) {}
    const source = readerContext.localReaderData;
    const localTitle = source && typeof source === "object" && "title" in source ? source.title : null;
    readerContext.updateDocumentState({
      title:
        String(
          readerContext.params.get("title") || localTitle || readerContext.sourceName
        ).trim() || readerContext.sourceName,
      zoom: Math.min(4, Math.max(0.25, Number(savedZoom || 100) / 100))
    });
  }

  function restoreReturnNavigation() {
    try {
      const state = history.state;
      const saved = JSON.parse(sessionStorage.getItem("reader-navigation-current") || "null");
      let stateUrl =
        state && state.voiceReaderOverlay && state.readerUrl
          ? new URL(state.readerUrl, location.origin)
          : null;
      if (!stateUrl && saved && saved.shareUrl === location.href && saved.readerUrl)
        stateUrl = new URL(saved.readerUrl, location.origin);
      const cleanStateUrl = stateUrl && new URL(stateUrl.href);
      if (cleanStateUrl) {
        cleanStateUrl.searchParams.delete("return");
        cleanStateUrl.searchParams.delete("nav");
      }
      if (
        stateUrl &&
        stateUrl.origin === location.origin &&
        stateUrl.pathname === "/search/static/reader.html" &&
        /** @type {URL} */ (cleanStateUrl).href === location.href
      ) {
        if (!readerContext.returnUrl) readerContext.returnUrl = stateUrl.searchParams.get("return") || "";
        if (!readerContext.returnNavigationToken) readerContext.returnNavigationToken = stateUrl.searchParams.get("nav") || "";
        readerContext.returnNeedsReload = true;
      }
    } catch (_) {}
  }

  function validateReturnHistory() {
    try {
      const target = new URL(readerContext.returnUrl, location.origin);
      const storedReturnUrl = readerContext.returnHistoryKey ? sessionStorage.getItem(readerContext.returnHistoryKey) : "";
      readerContext.canReturnWithHistory = !!readerContext.returnHistoryKey && storedReturnUrl === target.href;
    } catch (_) {}
  }

  function ownChapterSearchClient() {
    readerContext.trackReaderResource(() => {
      readerContext.chapterSearchClient?.dispose();
      readerContext.chapterSearchClient = null;
    });
  }

  function ownIndependentPdfResources() {
    readerContext.trackReaderResource(() => {
      readerContext.pdfV3Repository?.dispose(); readerContext.pdfTextLayerRepository?.dispose();
    });
  }

  function ownPdfBookSearchClient() {
    readerContext.trackReaderResource(() => {
      readerContext.pdfBookSearchClient?.dispose();
      readerContext.pdfBookSearchClient = null;
      clearTimeout(readerContext.pdfBookSearchPrefetchTimer);
      readerContext.pdfBookSearchPrefetchTimer = 0;
      readerContext.pdfBookSearchPrefetchPromise = null;
    });
  }

  function ownPdfPrefetchAndQueues() {
    readerContext.trackReaderResource(readerContext.clearPdfManifestPrefetches);
    readerContext.trackReaderResource(() => {
      for (const waiter of readerContext.pdfRenderWaiters.splice(0)) waiter.reject(readerContext.readerAbortError());
      for (const waiter of readerContext.pdfTextWaiters.splice(0)) waiter.reject(readerContext.readerAbortError());
    });
  }

  function initializeGenerations() {
    for (const generationName of ["navigation", "search", "bookmarks", "history", "pdf"])
      readerContext.nextReaderGeneration(generationName);
  }

  function labelToolbarControls() {
    for (const [selector, label] of [
      ["#back", "返回"],
      ["#page-prev", "上一页"],
      ["#page-next", "下一页"],
      ["#page-number", "页码"],
      ["#zoom-out", "缩小"],
      ["#zoom-in", "放大"],
      ["#zoom", "缩放百分比"],
      ["#bookmark-ribbon", "添加书签"],
      ["#history", "阅读选项"]
    ])
      document.querySelector(selector)?.setAttribute("aria-label", label);
  }

  function applyMetadataAndWatchSanitizedContent() {
    readerContext.applyReaderMetadata(readerContext.resolvedReaderData);
    readerContext.contentSanitizerObserver = new MutationObserver(() => {
      const seen = new Set();
      for (const article of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".foliate-continuous > article[data-section]"))) {
        article.querySelectorAll("style,link[rel=stylesheet]").forEach((node) => node.remove());
        const index = article.dataset.section;
        if (seen.has(index)) article.remove();
        else seen.add(index);
      }
    });
    readerContext.contentSanitizerObserver.observe(readerContext.content, { childList: true, subtree: true });
    readerContext.bookmarkPopover.className = "bookmark-popover";
    readerContext.bookmarkPopover.setAttribute("role", "dialog");
    readerContext.bookmarkPopover.setAttribute("aria-modal", "true");
    readerContext.bookmarkPopover.setAttribute("aria-labelledby", "bookmark-prompt");
  }

  function initializeBookmarkEditor() {
    readerContext.bookmarkLabelInput.id = "bookmark-label";
    readerContext.bookmarkLabelInput.maxLength = 120;
    readerContext.bookmarkExcerptInput.id = "bookmark-excerpt-input";
    readerContext.bookmarkExcerptInput.maxLength = 500;
    readerContext.bookmarkExcerptInput.rows = 3;
    readerContext.bookmarkEditFields.className = "bookmark-edit-fields";
    readerContext.bookmarkEditFields.innerHTML = "<label>标题</label><label>摘要</label>";
    readerContext.bookmarkEditFields.children[0].appendChild(readerContext.bookmarkLabelInput);
    readerContext.bookmarkEditFields.children[1].appendChild(readerContext.bookmarkExcerptInput);
    readerContext.bookmarkPopover.insertBefore(readerContext.bookmarkEditFields, readerContext.bookmarkPopover.querySelector("div"));
  }

  function initializeBookmarkSearchControls() {
    if (!document.querySelector("#bookmarks-panel .panel-search-toggle")) {
      const button = document.createElement("button");
      button.className = "panel-search-toggle";
      button.type = "button";
      /** @type {Element} */ (document.querySelector("#bookmarks-panel .panel-view-header")).appendChild(button);
    }
    readerContext.bookmarksAllButton.id = "bookmarks-all";
    readerContext.bookmarksAllButton.className = "text-action";
    readerContext.bookmarksAllButton.type = "button";
    readerContext.bookmarksAllButton.textContent = "全部书签";
    readerContext.bookmarksAllButton.setAttribute("aria-pressed", "false");
  }

  function mountBookmarkHeaderActions() {
    readerContext.bookmarksHeaderActions.append(readerContext.bookmarksAllButton, readerContext.bookmarksSearchButton);
    readerContext.bookmarksHeader.appendChild(readerContext.bookmarksHeaderActions);
  }

  function mountMediaPanel() {
    readerContext.mediaTab.id = "media-tab";
    readerContext.mediaTab.type = "button";
    readerContext.mediaTab.role = "tab";
    readerContext.mediaTab.dataset.panel = "media";
    readerContext.mediaTab.textContent = "播放";
    readerContext.mediaTab.hidden = !readerContext.capability.features.media;
    readerContext.mediaPanel.id = "media-panel";
    readerContext.mediaPanel.className = "reader-panel-view";
    readerContext.mediaPanel.dataset.panelView = "media";
    readerContext.mediaPanel.hidden = true;
    readerContext.mediaPanel.innerHTML =
      '<div class="media-panel-content"><strong>播放状态</strong><span class="media-panel-time">尚未播放</span><button class="text-action media-panel-bookmark" type="button">在当前时间添加书签</button></div>';
    /** @type {Element} */ (document.querySelector(".reader-panel-tabs")).prepend(readerContext.mediaTab);
    /** @type {Element} */ (document.querySelector("#history-panel"))
      .insertBefore(readerContext.mediaPanel, document.querySelector("#toc-panel"));
    /** @type {Element} */ (readerContext.mediaPanel.querySelector(".media-panel-bookmark"))
      .addEventListener("click", (event) => readerContext.openBookmarkPopover(event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined));
    /** @type {HTMLElement} */ (document.querySelector(".page-controls")).hidden = !readerContext.capability.features.pagination;
    /** @type {HTMLElement} */ (document.querySelector(".zoom-controls")).hidden = !readerContext.capability.features.zoom;

    readerContext.status.hidden = true;
    readerContext.mediaTab.setAttribute("aria-controls", "media-panel");
    readerContext.mediaTab.setAttribute("aria-selected", "false");
    readerContext.mediaPanel.setAttribute("role", "tabpanel");
    readerContext.mediaPanel.setAttribute("aria-labelledby", "media-tab");
  }

  function restoreAndBindPageInversion() {
    try { readerContext.pageInverted = localStorage.getItem("reader-page-inversion") === "true"; } catch (_) {}

    readerContext.pageInvertToggle.addEventListener("click", () => {
      readerContext.pageInverted = !readerContext.pageInverted;
      readerContext.applyPageInversion(true);
    });
    readerContext.applyPageInversion();
  }

  function restoreReaderThemeAndBindReturn() {
    readerContext.readerThemeToggle.className = "theme-toggle";

    readerContext.applyReaderTheme(readerContext.readerTheme, false, false);

    readerContext.readerPath.addEventListener("click", readerContext.navigateReaderFolder);
    document.querySelector("#reader-panel-path")?.addEventListener("click", readerContext.navigateReaderFolder);
    let closing = false;
    window.addEventListener("pageshow", event => { if (event.persisted) closing = false; });
    /** @type {Element} */ (document.querySelector("#back")).addEventListener("click", async () => {
      if (closing) return;
      closing = true;
      clearTimeout(readerContext.saveTimer);
      if (readerContext.isReaderOverlayFrame()) {
        const progress = readerContext.captureProgressEntry();
        if (progress) {
          readerContext.lastSavedProgress = JSON.stringify(progress);
          progress.closeTime = Date.now();
        }
        window.parent.postMessage({ type: "voice-reader-close", progress }, location.origin);
        return;
      }
      await Promise.race([readerContext.saveProgress(), new Promise((resolve) => setTimeout(resolve, 300))]);
      readerContext.clearReturnNavigation();
      try {
        const target = new URL(readerContext.normalizeReaderReturnUrl(readerContext.returnUrl), location.origin);
        if (target.origin === location.origin) {
          if (readerContext.returnNeedsReload) location.replace(target.href);
          else if (readerContext.canReturnWithHistory && history.length > 1) history.back();
          else location.assign(target.href);
          return;
        }
      } catch (_) {}
      location.assign("/search/");
    });
    // Replay a Back tap made before this handler was bound.
    if (window.__VOICE_READER_EARLY_BACK__?.()) /** @type {HTMLButtonElement} */ (document.querySelector("#back")).click();
  }

  function bindZoomAndPageControls() {
    readerContext.setZoom(readerContext.documentState.zoom * 100, false);
    for (const [id, delta] of /** @type {[string, number][]} */ ([
      ["#zoom-out", -10],
      ["#zoom-in", 10]
    ])) {
      /** @type {Element} */ (document.querySelector(id)).addEventListener("click", () => {
        readerContext.setZoom(Number(readerContext.zoomInput.value) + delta);
      });
    }
    readerContext.zoomInput.addEventListener("change", () => readerContext.setZoom(readerContext.zoomInput.value));
    readerContext.zoomInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        readerContext.setZoom(readerContext.zoomInput.value);
        readerContext.zoomInput.blur();
      }
    });
    readerContext.pageInput.addEventListener("change", () => readerContext.goToPage(readerContext.pageInput.value));
    readerContext.pageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        readerContext.goToPage(readerContext.pageInput.value);
        readerContext.pageInput.blur();
      }
    });

    document.addEventListener("keydown", readerContext.handleReaderKeydown);
    /** @type {Element} */ (document.querySelector("#page-prev"))
      .addEventListener("click", () =>
        readerContext.documentState.pageCount ? readerContext.goToPage(readerContext.documentState.page - 1) : readerContext.turnViewport(-1)
      );
    /** @type {Element} */ (document.querySelector("#page-next"))
      .addEventListener("click", () =>
        readerContext.documentState.pageCount ? readerContext.goToPage(readerContext.documentState.page + 1) : readerContext.turnViewport(1)
      );
  }

  function bindReaderUiHistory() {
    if (window !== window.top) return;
    const readerUrl = location.href;
    let loadingSearch = false;
    /** @param {PopStateEvent} event */
    const restoreSearchDocument = (event) => {
      if (!event.isTrusted || loadingSearch || readerContext.readerLifecycle.disposed) return;
      // Reloading an overlay URL creates a standalone Reader document which can
      // still own the preceding same-document search entries. Back changes the
      // URL/state first; load THAT document without another traversal or rewrite.
      if (!["/search/", "/search/index.html"].includes(location.pathname)) return;
      loadingSearch = true;
      try {
        sessionStorage.removeItem("reader-navigation-restore");
        const saved = JSON.parse(sessionStorage.getItem("reader-navigation-current") || "null");
        if (saved?.shareUrl === readerUrl && saved.readerUrl) {
          const source = new URL(saved.readerUrl, location.origin);
          const returnUrl = source.searchParams.get("return");
          const token = source.searchParams.get("nav");
          if (source.origin === location.origin && returnUrl === location.href && token &&
              sessionStorage.getItem(`reader-return:${token}`) === returnUrl) {
            // The host saves focus/scroll before mounting. The app consumes this
            // handoff after loading results; it is not a history-entry identity.
            sessionStorage.setItem("reader-navigation-restore", JSON.stringify({
              readerUrl: saved.readerUrl, returnUrl
            }));
          }
        }
      } catch (_) {}
      location.reload();
    };
    /** @param {PageTransitionEvent} event */
    const resume = (event) => { if (event.persisted) loadingSearch = false; };
    window.addEventListener("popstate", restoreSearchDocument);
    window.addEventListener("pageshow", resume);
    // A failed book load stops book work but leaves this document's error UI
    // alive. Keep browser navigation until the document/runtime is disposed.
    readerContext.readerRuntime.track(() => {
      window.removeEventListener("popstate", restoreSearchDocument);
      window.removeEventListener("pageshow", resume);
    });
  }

  function bindPanelBookmarkAndLifecycleControls() {
    document.addEventListener("click", readerContext.handleReaderOutsideClick);
    readerContext.trackReaderResource(() => document.removeEventListener("click", readerContext.handleReaderOutsideClick));
    readerContext.trackReaderResource(() => { readerContext.headingLocationCache?.dispose(); readerContext.headingLocationCache = null; });

    document.addEventListener("click", async (event) => {
      const path = event.composedPath(),
        link = /** @type {Element | undefined} */ (path.find((node) => node instanceof Element && node.matches?.("a[href]"))),
        article = /** @type {HTMLElement | undefined} */ (path.find(
          (node) =>
            node instanceof Element && node.matches?.(".foliate-continuous article[data-section]")
        ));
      if (!link || !article || !readerContext.epubRendition?.book) return;
      const raw = link.getAttribute("href") || "";
      if (!raw || readerContext.epubRendition.book.isExternal?.(raw) || /^(?:https?:|mailto:|tel:)/i.test(raw))
        return;
      event.preventDefault();
      const generation = readerContext.beginReaderNavigation(),
        index = Number(article.dataset.section),
        section = index < 0 ? readerContext.epubRendition.book.sections[-index - 1]
          : readerContext.epubRendition.book.sections.filter((item) => item.linear !== "no")[index];
      let href = raw;
      try {
        href = section?.resolveHref?.(raw) || raw;
      } catch (_) {}
      try {
        await readerContext.activateFoliateTocEntry({ href }, generation);
      } catch (error) {
        readerContext.reportNavigationError(error, generation);
      }
    });

    // Bookmark dialog owns focus and temporarily makes only its siblings inert.

    readerContext.bookmarkRibbon.addEventListener("click", () => readerContext.openBookmarkPopover(readerContext.bookmarkRibbon));
    /** @type {Element} */ (document.querySelector("#bookmark-cancel")).addEventListener("click", readerContext.closeBookmarkPopover);
    /** @type {Element} */ (document.querySelector("#bookmark-add")).addEventListener("click", async (event) => {
      const button = /** @type {HTMLButtonElement} */ (event.currentTarget),
        editing = readerContext.panelState.editingBookmark;
      const snapshot = readerContext.pendingBookmarkSnapshot || editing || readerContext.captureBookmarkSnapshot();
      const label = readerContext.bookmarkLabelInput.value.trim() || snapshot.label,
        excerpt = readerContext.bookmarkExcerptInput.value.trim();
      button.disabled = true;
      try {
        await VoiceOfMLReaderStore.putBookmark(
          editing
            ? { ...editing, label, excerpt }
            : {
                ...snapshot,
                id: `${readerContext.sourceUrl}\0${snapshot.locator}`,
                url: readerContext.sourceUrl,
                title: readerContext.documentState.title,
                extension: readerContext.extension,
                readerUrl: readerContext.currentReaderUrl().href,
                label,
                excerpt,
                createdAt: Date.now()
              }
        );
        const invoker = readerContext.bookmarkInvoker;
        readerContext.closeBookmarkPopover();
        if (!/** @type {HTMLElement} */ (document.querySelector("#bookmarks-panel")).hidden) {
          await readerContext.renderBookmarks();
          if (editing && invoker && !invoker.isConnected && document.activeElement === document.body)
            (
              /** @type {HTMLElement} */ (document.querySelector(
                `#bookmarks-list [data-bookmark-id="${CSS.escape(editing.id)}"] .panel-item-edit`
              )) || readerContext.bookmarksAllButton
            ).focus();
        }
      } catch (_) {
        /** @type {Element} */ (document.querySelector("#bookmark-prompt")).textContent = "书签保存失败，请重试。";
      } finally {
        button.disabled = false;
      }
    });
    readerContext.bookmarkPopover.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        readerContext.closeBookmarkPopover();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...readerContext.bookmarkPopover.querySelectorAll("input,textarea,select,button,a[href],[tabindex]")
      ].filter((node) => !/** @type {HTMLButtonElement} */ (node).disabled && /** @type {HTMLElement} */ (node).tabIndex >= 0 && node.getClientRects().length);
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        /** @type {HTMLElement} */ (last).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        /** @type {HTMLElement} */ (first).focus();
      }
    });
    for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(".reader-panel-tabs button")))
      button.addEventListener("click", () => readerContext.selectPanel(button.dataset.panel));
    /** @type {HTMLElement} */ (document.querySelector(".reader-panel-tabs")).addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = [.../** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(".reader-panel-tabs button:not([hidden])"))],
        current = tabs.findIndex(tab => tab === document.activeElement);
      if (current < 0) return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      readerContext.selectPanel(tabs[next].dataset.panel);
      tabs[next].focus();
    });
    readerContext.bookmarksAllButton.addEventListener("click", () => {
      readerContext.updatePanelState({ showingAllBookmarks: !readerContext.panelState.showingAllBookmarks });
      readerContext.bookmarksAllButton.textContent = readerContext.panelState.showingAllBookmarks ? "本书书签" : "全部书签";
      readerContext.bookmarksAllButton.setAttribute("aria-pressed", String(readerContext.panelState.showingAllBookmarks));
      readerContext.renderBookmarks();
    });
    for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(".panel-search-toggle"))) {
      button.classList.remove("icon-button");
      button.classList.add("text-action");
      button.textContent = "搜索";
      button.hidden = false;
      button.setAttribute("aria-expanded", "false");
      const view = /** @type {Element} */ (button.closest(".reader-panel-view")), input = /** @type {Element} */ (view.querySelector(".panel-search"));
      input.id ||= `${view.id}-search`;
      button.setAttribute("aria-controls", input.id);
      button.setAttribute("aria-label", `搜索${view.querySelector(".panel-view-header strong")?.textContent || "列表"}`);
      button.addEventListener("click", () =>
        readerContext.setPanelSearchOpen(button, button.getAttribute("aria-expanded") !== "true")
      );
    }
    for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll(".panel-search"))) {
      const view = /** @type {Element} */ (input.closest(".reader-panel-view"));
      input.type = "search";
      input.setAttribute(
        "aria-label",
        `搜索${view.querySelector(".panel-view-header strong")?.textContent || "列表"}`
      );
      input.addEventListener("input", (event) => {
        if (!/** @type {InputEvent} */ (event).isComposing) readerContext.filterPanel(view);
      });
      input.addEventListener("compositionend", () => readerContext.filterPanel(view));
    }
    /** @type {Element} */ (document.querySelector("#history-clear")).addEventListener("click", async () => {
      if (!confirm("清空全部阅读历史？")) return;
      readerContext.historySuppressed = true;
      await readerContext.progressSaveChain;
      await VoiceOfMLReaderStore.clearHistory();
      readerContext.renderHistory();
    });
    // A close snapshot can fail after the iframe has been detached, so report
    // a full history proactively without blocking Reader startup or closing.
    try {
      Promise.resolve(VoiceOfMLReaderStore.isHistoryFull?.()).then((full) => {
        if (!full || readerContext.readerLifecycle.disposed) return;
        return VoiceOfMLReaderStore.get(readerContext.sourceUrl).then((entry) => {
          if (!entry && !readerContext.readerLifecycle.disposed)
            readerContext.progressNotSaved({ name: "ReaderHistoryFullError" });
        });
      }).catch(() => {});
    } catch (_) {}
    readerContext.readerThemeToggle.addEventListener("click", () => {
      const theme = readerContext.readerTheme === "dark" ? "light" : "dark";
      readerContext.applyReaderTheme(theme);
      if (readerContext.isReaderOverlayFrame())
        window.parent.postMessage({ type: "voice-reader-theme", theme }, location.origin);
    });
    window.addEventListener("storage", (event) => {
      if (event.key === "theme" && event.newValue) readerContext.applyReaderTheme(event.newValue, false);
    });
    window.addEventListener("voice-reader-dispose", () => {
      readerContext.saveProgress();
      readerContext.disposeReader();
    });
    window.addEventListener("message", (event) => {
      if (
        event.origin === location.origin &&
        event.source === window.parent &&
        event.data?.type === "voice-reader-abort"
      ) {
        readerContext.saveProgress();
        readerContext.disposeReader();
        return;
      }
      if (
        event.origin === location.origin &&
        event.source === window.parent &&
        event.data &&
        event.data.type === "voice-reader-theme-state"
      )
        readerContext.applyReaderTheme(event.data.theme, false);
    });
    /** @type {HTMLButtonElement} */ (document.querySelector("#history"))
      .addEventListener("click", (event) =>
        readerContext.setReaderPanelOpen(/** @type {Element} */ (document.querySelector("#history")).getAttribute("aria-expanded") !== "true", false, event.detail === 0)
      );
    /** @type {Element} */ (document.querySelector("#history-close"))
      .addEventListener("click", () => readerContext.setReaderPanelOpen(false, true));
    readerContext.viewport.addEventListener("scroll", readerContext.handleReaderPositionChange, { passive: true });

    for (const type of ["wheel", "touchstart", "pointerdown"])
      readerContext.viewport.addEventListener(type, readerContext.notePdfScrollIntent, { passive: true });
  }

  function bindPdfPointerSelection() {
    readerContext.installReaderTapSelectionClear(readerContext.viewport);
    readerContext.viewport.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse") {
        readerContext.pdfSelectionPointer = null;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const run = target?.closest(".reader-pdf-text-run");
      const selection = document.getSelection();
      const selectedRun = selection && !selection.isCollapsed && target?.closest(".reader-page")
        ? selection.anchorNode?.parentElement?.closest(".reader-pdf-text-run") : null;
      const origin = run || selectedRun;
      const caret = !event.shiftKey && event.button === 0 ? readerContext.independentTextCaret(document, event.clientX, event.clientY) : null;
      readerContext.pdfSelectionPointer = origin
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, frame: 0,
            page: origin.closest(".reader-page"), anchorNode: caret?.node || (run ? null : selection?.anchorNode || null),
            anchorOffset: caret?.offset ?? (run ? 0 : selection?.anchorOffset ?? 0), caret: run ? caret : null } : null;
    }, { passive: false });
    readerContext.viewport.addEventListener("mousedown", (event) => {
      const caret = readerContext.pdfSelectionPointer?.caret;
      if (!caret || event.button !== 0 || event.shiftKey || event.detail > 1) return;
      // Start independent-text drags at the mapped caret, without native
      // edge auto-scroll. PointerEvent.detail is always zero in Chromium;
      // use MouseEvent.detail so double/triple clicks retain native selection.
      event.preventDefault();
      document.getSelection()?.setBaseAndExtent(caret.node, caret.offset, caret.node, caret.offset);
    }, { passive: false });
    document.addEventListener("pointermove", (event) => {
      const start = readerContext.pdfSelectionPointer;
      if (event.pointerType !== "mouse" || !start || start.id !== event.pointerId ||
          Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return;
      const selection = document.getSelection();
      if (!start.anchorNode && selection?.rangeCount && selection.anchorNode && start.page?.contains(selection.anchorNode) &&
          selection.anchorNode.parentElement?.closest(".reader-pdf-text-run")) {
        start.anchorNode = selection.anchorNode;
        start.anchorOffset = selection.anchorOffset;
      }
      if (start.anchorNode) {
        start.endX = event.clientX;
        start.endY = event.clientY;
        if (!start.frame) start.frame = requestAnimationFrame(() => {
          start.frame = 0;
          if (readerContext.pdfSelectionPointer === start)
            readerContext.correctPdfCrossPageSelection(start.endX ?? start.x, start.endY ?? start.y, start);
        });
      }
    }, { passive: true });
    document.addEventListener("pointerup", (event) => {
      const start = readerContext.pdfSelectionPointer;
      readerContext.pdfSelectionPointer = null;
      if (event.pointerType !== "mouse" || !["pdf", "pdf-pages"].includes(/** @type {string} */ (readerContext.capability.mode)) ||
          !start || start.id !== event.pointerId ||
          Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return;
      const x = event.clientX, y = event.clientY;
      requestAnimationFrame(() => readerContext.correctPdfCrossPageSelection(x, y, start));
    }, { passive: true });
    document.addEventListener("pointercancel", () => { readerContext.pdfSelectionPointer = null; }, { passive: true });
  }

  function bindSelectionAndPageLifecycle() {
    document.addEventListener("selectionchange", () => {
      if (readerContext.pdfSelectionBoundaryUpdate ||
          !["pdf", "pdf-pages"].includes(/** @type {string} */ (readerContext.capability.mode))) return;
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.anchorNode || !selection.focusNode) return;
      const runs = [...readerContext.content.querySelectorAll(".reader-pdf-text-run")]
        .filter((run) => run.firstChild?.nodeType === Node.TEXT_NODE);
      if (!runs.length) return;
      const anchorRun = selection.anchorNode?.parentElement?.closest(".reader-pdf-text-run");
      const focusRun = selection.focusNode?.parentElement?.closest(".reader-pdf-text-run");
      if (!anchorRun && !focusRun) return;
      if (focusRun) return;
      // Separators (line ends, inter-block gaps) are selectable text nodes
      // directly inside the layer; a focus there is already valid text.
      const focusElement = selection.focusNode?.nodeType === Node.ELEMENT_NODE
        ? /** @type {Element} */ (selection.focusNode) : selection.focusNode?.parentElement;
      if (focusElement?.closest(".reader-pdf-text")) return;
      const beforeAnchor = selection.focusNode && selection.anchorNode &&
        (selection.focusNode === selection.anchorNode
          ? selection.focusOffset < selection.anchorOffset
          : Boolean(selection.focusNode.compareDocumentPosition(selection.anchorNode) & Node.DOCUMENT_POSITION_FOLLOWING));
      // Clamp to the run nearest the focus in document order. Choosing the
      // first/last run of the whole book jumps to a distant retained page
      // when the focus lands on a page whose text layer is not loaded yet.
      const focus = document.createRange();
      focus.setStart(selection.focusNode, selection.focusOffset);
      let low = 0, high = runs.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (focus.comparePoint(/** @type {Node} */ (runs[middle].firstChild), 0) < 0) low = middle + 1;
        else high = middle;
      }
      const target = beforeAnchor ? runs[Math.min(low, runs.length - 1)] : runs[Math.max(low - 1, 0)];
      const node = target.firstChild;
      if (!(node instanceof Text)) return;
      readerContext.pdfSelectionBoundaryUpdate = true;
      try {
        selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, node,
          beforeAnchor ? 0 : node.length);
      } finally {
        readerContext.pdfSelectionBoundaryUpdate = false;
      }
    }, { passive: true });
    window.addEventListener("pagehide", (event) => {
      readerContext.saveProgress(event);
      if (!event.persisted) readerContext.disposeReader();
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && !readerContext.readerLifecycle.disposed) {
        readerContext.scheduleFoliateScrollSync();
        readerContext.updateProgressTools();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") readerContext.saveProgress();
      if (document.hidden) readerContext.stopPdfManifestPrefetch();
      else readerContext.queuePdfManifestPrefetch();
    });
    window.addEventListener("offline", readerContext.stopPdfManifestPrefetch);
    window.addEventListener("online", () => readerContext.queuePdfManifestPrefetch());
  }

  function mountProgressControls() {
    readerContext.progressTools.className = "reader-progress-tools";
    readerContext.progressTools.innerHTML =
      '<div class="reader-progress-row"><button class="reader-chapter-prev" type="button" aria-label="上一章" title="上一章"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7"/></svg></button><input class="reader-progress-range" type="range" min="0" max="100" step="0.1" value="0" aria-label="阅读进度"><span class="reader-progress-percent">0.0%</span><button class="reader-progress-undo" type="button" aria-label="撤销进度调整" title="撤销进度调整"><svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path fill="currentColor" stroke="none" d="M22 50.5a28.5 28.5 0 1 1 11.4 22.8l-5.3 5.3A36 36 0 1 0 14.5 50.5H3l16 16 16-16z"/><circle cx="50.5" cy="50.5" r="8" fill="currentColor" stroke="none"/></svg></button><button class="reader-chapter-next" type="button" aria-label="下一章" title="下一章"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7"/></svg></button></div>';
    /** @type {Element} */ (document.querySelector("#history-panel")).appendChild(readerContext.progressTools);
  }

  function mountProgressSummary() {
    readerContext.readingProgressSummary.className = "reader-progress-summary";
    readerContext.readingProgressSummary.innerHTML =
      '<strong>阅读状态</strong><span class="reader-progress-summary-value">0.0%</span><button class="reader-progress-bookmark text-action" type="button">在当前位置添加书签</button>';
    readerContext.progressTools.prepend(readerContext.readingProgressSummary);
    /** @type {Element} */ (readerContext.readingProgressSummary.querySelector(".reader-progress-bookmark"))
      .addEventListener("click", (event) => readerContext.openBookmarkPopover(event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined));

    readerContext.updateReadingProgressSummary();

    readerContext.syncTocTab();
  }

  function bindProgressActions() {
    let seekChanged = false;
    const startSeeking = () => {
      if (readerContext.progressSeeking) return;
      readerContext.progressSeeking = true;
      seekChanged = false;
    };
    const finishSeeking = () => {
      if (!readerContext.progressSeeking) return;
      readerContext.progressSeeking = false;
      const generation = readerContext.readerRuntime.currentGeneration("navigation");
      readerContext.flushEpubSeek().then(() => {
        if (readerContext.isReaderGenerationCurrent("navigation", generation)) readerContext.updateProgressTools();
      });
    };
    readerContext.progressRange.addEventListener("pointerdown", startSeeking);
    const seekKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"];
    readerContext.progressRange.addEventListener("keydown", (event) => {
      if (seekKeys.includes(event.key) && !event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey)
        startSeeking();
    });
    readerContext.progressRange.addEventListener("keyup", (event) => {
      if (seekKeys.includes(event.key)) finishSeeking();
    });
    readerContext.progressRange.addEventListener("blur", finishSeeking);
    readerContext.progressRange.addEventListener("input", () => {
      readerContext.progressPercent.textContent = `${Number(readerContext.progressRange.value).toFixed(1)}%`;
      readerContext.progressRange.setAttribute("aria-valuetext", readerContext.progressPercent.textContent);
      // A key or pointer press may leave the value unchanged. Snapshot only on input.
      readerContext.seekProgress(readerContext.progressRange.value, readerContext.progressSeeking && seekChanged);
      seekChanged = true;
    });
    for (const type of ["pointerup", "pointercancel"])
      readerContext.progressRange.addEventListener(type, finishSeeking);
    readerContext.progressUndo.addEventListener("click", () => {
      const restoreFocus = document.activeElement === readerContext.progressUndo;
      const state = readerContext.previousProgressState;
      readerContext.previousProgressState = null;
      readerContext.progressSeeking = false;
      readerContext.restoreProgressState(state);
      readerContext.updateProgressTools();
      if (restoreFocus) readerContext.progressRange.focus({ preventScroll: true });
    });
    readerContext.chapterPrev.addEventListener("click", () =>
      readerContext.activateChapter(readerContext.adjacentTocIndex(-1))
    );
    readerContext.chapterNext.addEventListener("click", () =>
      readerContext.activateChapter(readerContext.adjacentTocIndex(1))
    );
  }

  function ownDomSearchController() {
    readerContext.trackReaderResource(readerContext.domSearch.dispose);
  }

  function ownSearchViewController() {
    readerContext.trackReaderResource(readerContext.fullSearchController.dispose);
  }

  function ownPdfSearchStorageAndStart() {
    readerContext.trackReaderResource(() => {
      readerContext.pdfPersistentTextStore?.dispose();
      readerContext.pdfPersistentTextStore = readerContext.pdfPersistentTextOpening = readerContext.pdfPersistentTextVersion = null;
      readerContext.pdfSearchTextCache.clear();
      readerContext.pdfSearchTextCacheBytes = 0;
    });

    readerContext.registerReaderFormatAdapters();
    readerContext.syncCapabilityControls();
    readerContext.updateProgressTools();
    readerContext.start().catch((error) => {
      if (readerContext.readerAbortController.signal.aborted || error?.name === "AbortError") return;
      console.error(error);
      const code = readerContext.classifyReaderError(error);
      readerContext.fail("阅读文件解析失败，请刷新后重试，或下载原文件。", typeof code === "string" ? code : "READER_PARSE");
    });
  }

  return {
    trackStartupOwners,
    trackWorkCancellation,
    trackEarlySourceResolution,
    publishDiagnosticsAndInstallCompatibility,
    readSelectedSourceSession,
    normalizeConvertedPdfMode,
    applySourceSessionAndCachedMetadata,
    publishSourceAndSubscribeToStore,
    initializePanelAccessibility,
    mountInitialLoadingFeedback,
    bindDownloadAction,
    initializeDocumentTitle,
    restoreReturnNavigation,
    validateReturnHistory,
    ownChapterSearchClient,
    ownIndependentPdfResources,
    ownPdfBookSearchClient,
    ownPdfPrefetchAndQueues,
    initializeGenerations,
    labelToolbarControls,
    applyMetadataAndWatchSanitizedContent,
    initializeBookmarkEditor,
    initializeBookmarkSearchControls,
    mountBookmarkHeaderActions,
    mountMediaPanel,
    restoreAndBindPageInversion,
    restoreReaderThemeAndBindReturn,
    bindZoomAndPageControls,
    bindReaderUiHistory,
    bindPanelBookmarkAndLifecycleControls,
    bindPdfPointerSelection,
    bindSelectionAndPageLifecycle,
    mountProgressControls,
    mountProgressSummary,
    bindProgressActions,
    ownDomSearchController,
    ownSearchViewController,
    ownPdfSearchStorageAndStart
  };
}

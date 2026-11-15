// Coordinates the search/Reader handoff; reader-navigation owns iframe/history mechanics.
(function () {
  /** @param {ReaderHostDependencies} deps */
  function create(deps) {
    const position = deps.position;
    /** @type {HTMLIFrameElement | null} */
    let overlay = null;
    let revision = 0, closing = false, uiState = "base";
    /** @type {ReaderHostSnapshot | null} */
    let snapshot = null;
    const keys = Object.freeze([
      "q", "min_size", "max_size", "ext", "history", "mirror", "sort",
      "search_folders", "exact", ...(deps.hashRoute ? ["local"] : []), "sidebar", "filters", "wide"
    ]);
    const navigation = deps.createNavigation({
      resume: url => deps.navigate(url),
      close: () => { if (overlay) deps.handleMessage({ origin: location.origin,
        source: overlay.contentWindow, data: { type: "voice-reader-close" } }); }
    });
    function currentReaderSearchParams() {
      const params = deps.buildParams();
      if (deps.hashRoute) {
        const query = deps.readQuery().trim();
        if (query) params.set("q", query);
      }
      return params;
    }
    /** @param {string} rawUrl */
    function normalizeReaderReturnUrl(rawUrl) {
      if (!deps.hashRoute) return rawUrl;
      try {
        const target = new URL(rawUrl || "/search/", location.origin);
        if (target.origin === location.origin && target.pathname === "/") return new URL("/search/", location.origin).href;
        return target.href;
      } catch (_) { return new URL("/search/", location.origin).href; }
    }
    /** @param {URL} target */
    function merge(target) {
      return navigation.mergeSearchParams(target, deps.currentParams(), { hashRoute: deps.hashRoute, keys });
    }
    /** @param {string} rawUrl */
    function syncReaderFolderFilter(rawUrl) {
      try {
        const readerUrl = new URL(rawUrl, location.origin);
        const raw = readerUrl.searchParams.get("folder_url");
        if (!raw) return readerUrl.href;
        readerUrl.searchParams.set("folder_url", merge(new URL(raw, location.origin)).href);
        return readerUrl.href;
      } catch (_) { return rawUrl; }
    }
    function closeReaderOverlay(restoreFocus = true, restoreScroll = true) {
      if (deps.hashRoute) { restoreFocus = restoreFocus !== false; restoreScroll = restoreScroll !== false; }
      if (!overlay) return false;
      revision++;
      closing = false;
      uiState = "base";
      overlay = null;
      const returnFocus = navigation.unmount();
      if (overlay) return true;
      if (restoreScroll) {
        const saved = position.scroll;
        if (saved && snapshot && deps.snapshotChanged(snapshot, saved.viewKey)) {
          position.setScroll(null);
          deps.restoreSnapshot(saved.viewKey);
          position.setScroll({ ...saved, route: location.href });
        }
        deps.restoreScroll();
        snapshot = null;
      }
      if (restoreFocus && returnFocus && returnFocus.isConnected) returnFocus.focus();
      return true;
    }
    /** @param {URL} url @param {boolean} [addHistory] */
    function openReaderOverlay(url, addHistory = true) {
      if (deps.hashRoute) addHistory = addHistory !== false;
      revision++;
      if (addHistory && !position.scroll) {
        const saved = deps.captureScroll();
        position.setScroll(saved);
        snapshot = deps.saveSnapshot(saved?.viewKey || deps.getViewKey());
      }
      overlay = navigation.mount(url);
      uiState = "base";
      closing = false;
      if (addHistory) navigation.remember(url, /** @type {object} */ (position.scroll));
    }
    function reconcileSearchDestination() {
      if ((deps.hashRoute ? location.pathname !== "/search/" : location.pathname.split("/").filter(Boolean).length > 1) || history.state?.voiceReaderOverlay) return;
      const previous = overlay, owner = revision;
      // Apply the destination before disposal can synchronously start new work.
      if (deps.routeChanged()) deps.applyRoute(deps.hashRoute || !!previous);
      if (overlay !== previous || (deps.hashRoute && revision !== owner)) return;
      deps.closeOverlay();
    }
    /** @param {{voiceReaderOverlay?: boolean; readerUrl?: string} | null} state */
    function restoreReaderOverlay(state) {
      if (!state || !state.voiceReaderOverlay || !state.readerUrl) {
        deps.reconcile(); return;
      }
      try {
        const url = navigation.parse(state.readerUrl);
        const owner = revision + (overlay ? 1 : 0);
        deps.closeOverlay(false, false);
        if (revision !== owner) return;
        deps.openOverlay(url, false);
      } catch (_) {}
    }
    /** @param {ReaderHostMessage} event */
    function handleReaderMessage(event) {
      if (!navigation.accepts(/** @type {MessageEvent} */ (event))) return;
      const message = event.data || {};
      if (message.type === "voice-reader-close") {
        if (closing) return;
        navigation.persistProgress(message.progress);
        closing = true;
        uiState = "base";
        navigation.dismiss();
        let returnUrl = deps.hashRoute ? "/search/" : "/";
        try {
          const target = new URL(new URL(/** @type {HTMLIFrameElement} */ (overlay).src, location.origin).searchParams.get("return") || returnUrl, location.origin);
          if (target.origin === location.origin && (!deps.hashRoute || target.pathname === "/search/")) returnUrl = target.href;
          else if (deps.hashRoute) returnUrl = new URL("/search/", location.origin).href;
        } catch (_) {}
        if (!history.state?.voiceReaderOverlay) {
          const returnFocus = navigation.returnFocus;
          history.replaceState(history.state, "", returnUrl);
          deps.reconcile();
          if (deps.hashRoute && returnFocus && returnFocus.isConnected) returnFocus.focus();
          return;
        }
        const previous = overlay;
        history.back();
        // A delayed Back still owns its Reader entry for Forward.
        setTimeout(() => {
          if (!closing || overlay !== previous) return;
          navigation.showCloseRecovery(returnUrl);
        }, 1000);
        return;
      }
      if (message.type === "voice-reader-ui-state") {
        if (closing) return;
        if (typeof message.state === "string" && ["base", "panel", "full-search"].includes(message.state)) uiState = message.state;
        return;
      }
      if (message.type === "voice-reader-theme") {
        if (message.theme !== "dark" && message.theme !== "light") return;
        deps.applyTheme(message.theme);
        return;
      }
      if (message.type === "voice-reader-open") {
        try { overlay = navigation.replace(/** @type {string} */ (message.url), /** @type {object} */ (position.scroll)); } catch (_) {}
        return;
      }
      if (message.type !== "voice-reader-navigate") return;
      try {
        const target = new URL(/** @type {string} */ (message.url), location.origin);
        if (target.origin !== location.origin || (deps.hashRoute ? target.pathname !== "/search/" : target.pathname.split("/").filter(Boolean).length !== 1)) return;
        history.replaceState(null, "", merge(target).href);
        deps.reconcile();
      } catch (_) {}
    }
    /** @param {string} rawUrl @param {string} [returnUrl] */
    function navigateToReader(rawUrl, returnUrl) {
      let target;
      try { target = navigation.parse(deps.syncFolder(rawUrl)); }
      catch (_) { return false; }
      deps.closeMobileSidebars();
      const url = navigation.prepare(target.href, deps.normalizeReturn(returnUrl || location.href));
      deps.openOverlay(url);
      return true;
    }
    function restoreReaderFromSession() {
      if (overlay) return;
      try {
        const saved = /** @type {{shareUrl?: string; readerUrl?: string; returnScroll?: ReaderReturnPosition} | null} */ (navigation.saved());
        if (!saved || saved.shareUrl !== location.href || !saved.readerUrl) return;
        const url = navigation.parse(saved.readerUrl);
        position.setScroll(saved.returnScroll || null);
        history.replaceState({ voiceReaderOverlay: true, readerUrl: url.href }, "", saved.shareUrl);
        deps.openOverlay(url, false);
      } catch (_) {}
    }
    return Object.freeze({ navigation, keys, currentReaderSearchParams, normalizeReaderReturnUrl, syncReaderFolderFilter,
      closeReaderOverlay, openReaderOverlay, reconcileSearchDestination, restoreReaderOverlay,
      handleReaderMessage, navigateToReader, restoreReaderFromSession,
      get overlay() { return overlay; }, get closing() { return closing; },
      get uiState() { return uiState; }, get returnSnapshot() { return snapshot; }
    });
  }
  globalThis.VoiceOfMLReaderHost = Object.freeze({ create });
})();

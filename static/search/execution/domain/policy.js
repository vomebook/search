// Appends retain the backend that produced their first page, even when the
// user's mode preference or API availability has changed in the meantime.
(function () {
  /** @param {SearchExecutionView} view @param {boolean | undefined} append @param {string | null | undefined} folderMatchMode */
  function backend(view, append, folderMatchMode) {
    const continueApi = append && view._resultBackend === "api";
    const continueInitialViaApi = append && view._initialActive && !view.dataLoaded && view.apiAvailable && folderMatchMode !== "mixed";
    if ((append && view._resultBackend === "local") ||
        (!continueApi && !continueInitialViaApi && (view.useLocalMode || folderMatchMode === "mixed"))) return "local";
    if (view.apiAvailable) return "api";
    return continueApi ? "unavailable" : "local-fallback";
  }
  globalThis.VoiceOfMLSearchExecutionPolicy = { backend };
})();

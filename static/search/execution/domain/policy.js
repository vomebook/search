// Appends retain the backend that produced their first page, even when the
// user's mode preference or API availability has changed in the meantime.
(function () {
  /** @param {SearchExecutionView} view @param {boolean | undefined} append */
  function backend(view, append) {
    if (append && view._resultBackend === "local") return "local";
    if (append && view._resultBackend === "api") return view.apiAvailable ? "api" : "unavailable";
    // Static initial pages can continue on the API while the local corpus warms up.
    if (append && view._initialActive && !view.dataLoaded && view.apiAvailable) return "api";
    if (view.useLocalMode) return "local";
    return view.apiAvailable ? "api" : "local-fallback";
  }
  globalThis.VoiceOfMLSearchExecutionPolicy = { backend };
})();

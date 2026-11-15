// The status button has no recovery state; rendering follows the controller projection.
(function () {
  /** @param {VoiceOfMLPagingStatusOptions} options */
  function create(options) {
    /** @param {VoiceOfMLPagingView} view @param {VoiceOfMLPagingRecovery} recovery */
    function render(view, recovery) {
      const host = options.getHost();
      if (!host) return;
      const document = host.ownerDocument;
      let button = /** @type {HTMLButtonElement | null} */ (document.getElementById("paging-status"));
      if (!button) {
        button = document.createElement("button");
        button.id = "paging-status";
        button.type = "button";
        button.className = "text-btn-sm";
        if (!options.revealHost) button.textContent = "加载失败，重试";
        button.setAttribute("aria-live", "polite");
        button.addEventListener("click", options.retry);
        host.appendChild(button);
      }
      const loading = view.loading && view.page > view.loadedPage;
      button.hidden = !view.hasMore || loading || recovery.failures < 2;
      button.disabled = loading;
      // Space clears hidden text and exposes the footer; Pages retains its creation label.
      if (options.revealHost) button.textContent = button.hidden ? "" : "加载失败，重试";
      if (options.revealHost && !button.hidden) host.style.display = "";
    }
    return { render };
  }
  globalThis.VoiceOfMLPagingStatus = { create };
})();

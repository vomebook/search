// Pure rules for bottom recovery and one-scroll-intent lookahead consumption.
(function () {
  /** @param {VoiceOfMLPagingView} view */
  function isAtBottom(view) {
    return view.resultCount > 0 && view.viewportHeight > 0 &&
      view.loadedHeight - view.scrollTop - view.viewportHeight <= 4;
  }
  /** @param {VoiceOfMLPagingView} view @param {number} readyPage */
  function acceptsReadyPage(view, readyPage) {
    return !readyPage || (readyPage === view.loadedPage + 1 &&
      (view.appendScrollTop !== view.scrollTop || isAtBottom(view)));
  }
  /** @param {VoiceOfMLPagingView} view @param {VoiceOfMLPagingRecovery} recovery
   * @param {number} now @param {boolean} bottomOnly @param {boolean} retry */
  function shouldLoad(view, recovery, now, bottomOnly, retry) {
    return !view.suspended && !view.inactive && !view.dragging && !view.loading && view.hasMore &&
      recovery.failures < 2 && now >= recovery.retryAt &&
      (retry || isAtBottom(view) || (!bottomOnly && view.scrollTop >= view.loadedHeight * 0.05));
  }
  /** @param {number} failures @param {boolean} success @param {boolean} terminal @param {number} now
   * @returns {VoiceOfMLPagingRecovery} */
  function afterAttempt(failures, success, terminal, now) {
    return { failures: terminal ? 2 : success ? 0 : failures + 1, retryAt: success ? 0 : now + 750 };
  }
  globalThis.VoiceOfMLPagingPolicy = { isAtBottom, acceptsReadyPage, shouldLoad, afterAttempt };
})();

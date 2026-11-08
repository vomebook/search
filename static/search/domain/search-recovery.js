// Search retry eligibility only. Scheduling, cancellation and I/O stay in the host.
(function () {
  /**
   * Preserve the original property access and coercion order, including getters.
   * @param {{name?: string | undefined, status?: number | undefined, code?: string | undefined, message?: string | undefined} | null | undefined} error
   * @returns {boolean}
   */
  function isRecoverable(error) {
    if (!error || error.name === "AbortError") return false;
    if (error.status) return [408, 429, 500, 502, 503, 504].includes(error.status);
    return /API_TIMEOUT|WORKER_TIMEOUT|LOCAL_UNAVAILABLE|TimeoutError|network|fetch|offline|timed out/i.test(`${error.code || error.name || ""} ${error.message || ""}`) || error.message === "Load failed";
  }

  /** @type {typeof globalThis & {VoiceOfMLSearchRecovery: typeof VoiceOfMLSearchRecovery}} */
  const globals = globalThis;
  globals.VoiceOfMLSearchRecovery = {isRecoverable};
})();

// Reader asset sidecar ownership; site-specific behavior is retained.
(function () {
/** @param {ReaderAssetPaintDependencies} deps */
function create(deps) {
/** @type {ReaderAssetSchedulingState} */
const state = { delayUntilPaint: false, parseWake: null, channel: null };
/** @type {(() => void)[]} */
const queue = [];
/** @returns {Promise<void>} */
function yieldConvertedReaderBuild() {
  if (typeof MessageChannel === "undefined") return new Promise(resolve => setTimeout(resolve, 0));
  if (!state.channel) {
    state.channel = new MessageChannel();
    state.channel.port1.onmessage = () => queue.shift()?.();
  }
  return new Promise(resolve => { queue.push(resolve); /** @type {MessageChannel} */ (state.channel).port2.postMessage(null); });
}

/** @param {AbortSignal} signal @param {string | null} targetKey @returns {Promise<void>} */
function waitForReaderAssetFirstPaint(signal, targetKey) {
  if (!state.delayUntilPaint || !targetKey || !deps.canWaitForPaint() ||
      typeof MutationObserver !== "function" || !deps.resultsList() || deps.getSearchViewKey() !== targetKey)
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false, firstFrame = 0, secondFrame = 0;
    /** @type {MutationObserver | null} */
    let observer = null;
    /** @param {DOMException | null} error */
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (firstFrame) cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      if (observer) observer.disconnect();
      signal.removeEventListener("abort", abort);
      if (state.parseWake === resume) state.parseWake = null;
      state.delayUntilPaint = false;
      if (error) reject(error); else resolve();
    };
    const resume = () => finish(null);
    const abort = () => finish(new DOMException("Reader assets timed out", "AbortError"));
    const ready = () => deps.isFirstViewReady(targetKey);
    const afterPaint = () => {
      if (firstFrame || secondFrame || settled) return;
      if (typeof requestAnimationFrame === "function") {
        firstFrame = requestAnimationFrame(() => {
          firstFrame = 0;
          secondFrame = requestAnimationFrame(() => {
            secondFrame = 0;
            // The state may change between ready() and paint: don't decode an
            // old frame while the same view starts a fresh request.
            if (deps.getSearchViewKey() !== targetKey || ready()) resume();
          });
        });
      }
    };
    // RAF may be paused; do not hold metadata forever when search stalls.
    const timer = setTimeout(resume, 750);
    state.parseWake = resume;
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    observer = new MutationObserver(() => {
      if (deps.getSearchViewKey() !== targetKey) { resume(); return; }
      if (ready()) afterPaint();
    });
    observer.observe(/** @type {HTMLElement} */ (deps.resultsList()), { childList: true, subtree: true });
    if (ready()) afterPaint();
  });
}

return { state, yieldConvertedReaderBuild, waitForReaderAssetFirstPaint };
}

globalThis.VoiceOfMLReaderAssetScheduling = { create };
})();

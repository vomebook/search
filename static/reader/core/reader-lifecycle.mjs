export function createReaderLifecycle(readerContext) {
  function readerAbortError() {
    return new DOMException("Reader work cancelled", "AbortError");
  }

  function assertReaderActive() {
    if (readerContext.readerAbortController.signal.aborted || readerContext.readerRuntime.state.lifecycle.disposed)
      throw readerContext.readerAbortError();
  }

  function trackReaderResource(cleanup) {
    if (readerContext.readerAbortController.signal.aborted) cleanup();
    else readerContext.readerResources.add(cleanup);
    return () => readerContext.readerResources.delete(cleanup);
  }

  function stopReaderWork() {
    readerContext.readerAbortController.abort();
    for (const cleanup of readerContext.readerResources) {
      try {
        cleanup();
      } catch (_) {}
    }
    readerContext.readerResources.clear();
  }

  function awaitReader(promise, extraSignal = null) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const signals = extraSignal ? [readerContext.readerAbortController.signal, extraSignal] : [readerContext.readerAbortController.signal];
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signals.forEach(signal => signal.removeEventListener("abort", abort));
        callback(value);
      };
      const abort = () => finish(reject, readerContext.readerAbortError());
      Promise.resolve(promise)
        .then(value => finish(resolve, value), error => finish(reject, error));
      if (signals.some(signal => signal.aborted)) abort();
      else signals.forEach(signal => signal.addEventListener("abort", abort, { once: true }));
    });
  }

  function waitForReader(delay = 0, animationFrame = false) {
    return new Promise((resolve, reject) => {
      readerContext.assertReaderActive();
      const signal = readerContext.readerAbortController.signal;
      const abort = () => {
        if (animationFrame) cancelAnimationFrame(handle);
        else clearTimeout(handle);
        reject(readerContext.readerAbortError());
      };
      const done = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const handle = animationFrame ? requestAnimationFrame(done) : setTimeout(done, delay);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  function setReaderPhase(phase) {
    return readerContext.readerRuntime.setPhase(phase);
  }

  function setReaderStage(stage) {
    return readerContext.readerRuntime.setStage(stage);
  }

  function classifyReaderError(error, fallback = "READER_PARSE") {
    if (["READER_ENGINE_NETWORK", "READER_RESTORE", "READER_PDF_TRANSPORT"].includes(error?.code)) return error.code;
    const value = `${error?.name || ""} ${error?.message || error || ""}`;
    if (/AbortError|timeout|network|fetch|HTTP\s*\d+/i.test(value)) return "READER_NETWORK";
    if (
      /EPUB_INVALID|corrupt|damage|truncated|central directory|end of data|invalid zip/i.test(value)
    )
      return "READER_CORRUPT";
    return fallback;
  }

  function markReaderContentReady() {
    if (["foliate", "epub-chapters"].includes(readerContext.capability?.mode) && readerContext.loadingIndicator.isConnected)
      readerContext.foliateScrollAnchors.preserve(() => readerContext.loadingIndicator.remove());
    else readerContext.loadingIndicator.remove();
    readerContext.loadingStatus.hidden = true;
  }

  function nextReaderGeneration(name) {
    const generation = readerContext.readerRuntime.nextGeneration(name);
    if (name === "search") readerContext.drainPdfTextWaiters();
    return generation;
  }

  function isReaderGenerationCurrent(name, value) {
    return !readerContext.readerAbortController.signal.aborted && readerContext.readerRuntime.isCurrent(name, value);
  }

  function reportNavigationError(error, generation) {
    if (readerContext.isReaderGenerationCurrent("navigation", generation) && error?.name !== "AbortError")
      console.warn("Reader navigation failed", error);
  }

  function disposeReader() {
    if (readerContext.readerLifecycle.disposed) return;
    readerContext.updateDocumentState({ restorationReady: false });
    readerContext.readerRuntime.dispose();
    readerContext.contentSanitizerObserver?.disconnect();
    readerContext.contentSanitizerObserver = null;
    clearTimeout(readerContext.saveTimer);
    clearTimeout(readerContext.themeAnimationTimer);
    clearTimeout(readerContext.panelAnimationTimer);
    for (const frame of [readerContext.markerFrame, readerContext.foliateScrollFrame, readerContext.foliateWindowFrame, readerContext.epubSeekFrame])
      if (frame) cancelAnimationFrame(frame);
    readerContext.saveTimer =
      readerContext.themeAnimationTimer =
      readerContext.panelAnimationTimer =
      readerContext.markerFrame =
      readerContext.foliateScrollFrame =
      readerContext.foliateWindowFrame =
      readerContext.epubSeekFrame =
        0;
    VoiceOfMLReaderStore.dispose?.();
  }

  function fail(message, code = "READER_PARSE") {
    if (readerContext.readerLifecycle.disposed || readerContext.readerAbortController.signal.aborted) return;
    readerContext.updateDocumentState({ restorationReady: false });
    readerContext.readerRuntime.fail(code);
    if (["READER_PDF_TRANSPORT", "READER_MEDIA"].includes(code)) readerContext.setReaderPanelOpen(false);
    readerContext.stopReaderWork();
    readerContext.readerRequestManager.dispose();
    readerContext.formatAdapters.dispose();
    window.__VOICE_PDF_PRELOAD__?.dispose();
    readerContext.content.dataset.errorCode = code;
    readerContext.loadingStatus.hidden = true;
    readerContext.markReaderContentReady();
    const visibleMessage = `${message} [${readerContext.readerLifecycle.stage}]`;
    readerContext.content.innerHTML = `<div class="reader-error" role="alert"></div>`;
    readerContext.content.querySelector(".reader-error").textContent = visibleMessage;
    if (["READER_ENGINE_NETWORK", "READER_RESTORE", "READER_PDF_TRANSPORT", "READER_MEDIA"].includes(code)) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "text-button";
      retry.id = "reader-engine-retry";
      retry.textContent = "重试加载";
      // Reload clears the browser's failed module map and preserves this book URL.
      retry.addEventListener("click", async () => {
        if (["READER_PDF_TRANSPORT", "READER_MEDIA"].includes(code)) {
          let timer;
          try {
            await Promise.race([readerContext.progressSaveChain,
              new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
          } finally { clearTimeout(timer); }
          if (readerContext.readerLifecycle.disposed) return;
        }
        location.reload();
      });
      readerContext.content.querySelector(".reader-error").append(document.createElement("br"), retry);
    }
    readerContext.status.textContent = "无法打开";
  }

  return {
    readerAbortError,
    assertReaderActive,
    trackReaderResource,
    stopReaderWork,
    awaitReader,
    waitForReader,
    setReaderPhase,
    setReaderStage,
    classifyReaderError,
    markReaderContentReady,
    nextReaderGeneration,
    isReaderGenerationCurrent,
    reportNavigationError,
    disposeReader,
    fail
  };
}

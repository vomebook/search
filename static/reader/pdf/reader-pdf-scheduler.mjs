export function createReaderPdfScheduler(readerContext) {
  function pdfManifestPrefetchConcurrency() {
    const type = navigator.connection?.effectiveType;
    if (type === "slow-2g" || type === "2g") return 1;
    if (type === "3g") return 1;
    if (matchMedia("(max-width: 700px)").matches) return 2;
    return readerContext.PDF_MANIFEST_PREFETCH_CONCURRENCY;
  }

  function pdfManifestPrefetchMaxPages() {
    const type = navigator.connection?.effectiveType;
    if (type === "slow-2g" || type === "2g") return 8;
    if (type === "3g") return 16;
    return matchMedia("(max-width: 700px)").matches ? 24 : readerContext.PDF_MANIFEST_PREFETCH_MAX_PAGES;
  }

  function canPrefetchPdfImages() {
    const connection = navigator.connection;
    return !connection?.saveData && !["slow-2g", "2g"].includes(connection?.effectiveType);
  }

  function cancelPdfManifestPrefetch(record) {
    if (!record) return;
    readerContext.pdfManifestPrefetchActive.delete(record);
    clearTimeout(record.timeout);
    if (readerContext.pdfManifestPrefetches.get(record.url) === record) readerContext.pdfManifestPrefetches.delete(record.url);
    record.image.onload = record.image.onerror = null;
    record.image.removeAttribute("src");
  }

  function stopPdfManifestPrefetch() {
    clearTimeout(readerContext.pdfManifestPrefetchTimer);
    readerContext.pdfManifestPrefetchTimer = 0;
    for (const record of [...readerContext.pdfManifestPrefetchActive]) readerContext.cancelPdfManifestPrefetch(record);
  }

  function trimPdfManifestPrefetches() {
    while (readerContext.pdfManifestPrefetches.size > readerContext.PDF_MANIFEST_PREFETCH_LIMIT || readerContext.pdfRetainedPixels() > readerContext.pdfPixelBudget()) {
      const victim = [...readerContext.pdfManifestPrefetches.values()].find((record) => !readerContext.pdfManifestPrefetchActive.has(record));
      if (!victim) return;
      readerContext.pdfManifestPrefetches.delete(victim.url);
      victim.image.onload = victim.image.onerror = null;
      victim.image.removeAttribute("src");
    }
  }

  function pdfPixelBudget() {
    const lowMemory = Number(navigator.deviceMemory) > 0 && Number(navigator.deviceMemory) <= 2;
    return (lowMemory ? 32 : matchMedia("(max-width: 700px)").matches ? 48 : 96) * 1024 * 1024 / 4;
  }

  function pdfSurfacePixels(surface) {
    return surface?.tagName === "CANVAS" ? surface.width * surface.height :
      (surface?.naturalWidth || 0) * (surface?.naturalHeight || 0);
  }

  function pdfRetainedPixels() {
    let pixels = 0;
    for (const surface of readerContext.content.querySelectorAll(".reader-page > canvas, .reader-page > img"))
      pixels += readerContext.pdfSurfacePixels(surface);
    for (const record of readerContext.pdfManifestPrefetches.values()) pixels += readerContext.pdfSurfacePixels(record.image);
    return pixels;
  }

  function trimPdfSurfaces(protectedShell) {
    readerContext.trimPdfManifestPrefetches();
    const shells = [...readerContext.content.querySelectorAll('.reader-page[data-render-state="rendered"]')];
    const canvasLimit = matchMedia("(max-width: 700px)").matches ? 7 : 11;
    let canvases = shells.filter(shell => shell.querySelector("canvas.ready")).length;
    let images = shells.filter(shell => shell.querySelector("img.ready")).length;
    let pixels = readerContext.pdfRetainedPixels();
    const retentionPage = Number(readerContext.pageAtMarker()?.dataset.page) || readerContext.documentState.page;
    const distance = shell => {
      const delta = Number(shell.dataset.page) - retentionPage;
      return Math.abs(delta) * (delta * readerContext.pdfScrollDirection < 0 ? 2 : 1);
    };
    shells.sort((a, b) => distance(b) - distance(a) ||
      Number(a.dataset.renderUsedAt || 0) - Number(b.dataset.renderUsedAt || 0));
    for (const shell of shells) {
      const canvas = shell.querySelector("canvas.ready"), image = shell.querySelector("img.ready");
      if (pixels <= readerContext.pdfPixelBudget() && !(canvas && canvases > canvasLimit) && !(image && images > 25)) continue;
      if (readerContext.isPdfPageVisible(shell) || Number(shell.dataset.page) === retentionPage || readerContext.pdfSelectionIntersects(shell)) continue;
      shell._textEpoch = (shell._textEpoch || 0) + 1;
      if (canvas) {
        pixels -= readerContext.pdfSurfacePixels(canvas);
        canvas.width = canvas.height = 0;
        canvas.classList.remove("ready");
        canvases--;
      }
      if (image) {
        pixels -= readerContext.pdfSurfacePixels(image);
        image.removeAttribute("src");
        image.remove();
        shell._v3PreviewRelease?.();
        images--;
      }
      shell.querySelector(".reader-pdf-text")?.replaceChildren();
      shell._bookmarkTextItems = [];
      shell.dataset.textReady = "0";
      shell.dataset.renderState = "idle";
      const pageState = shell.querySelector(".reader-page-state");
      if (pageState) readerContext.setPdfPageLoadingState(pageState, shell.dataset.page);
    }
    readerContext.domSearch.pruneMarks();
  }

  function clearPdfManifestPrefetches() {
    readerContext.stopPdfManifestPrefetch();
    readerContext.pdfManifestPrefetchNext = 0;
    readerContext.pdfManifestPrefetchOrigin = 0;
    readerContext.pdfManifestPrefetchCount = 0;
    readerContext.pdfManifestPrefetchWrapped = false;
    readerContext.pdfManifestShells.length = 0;
    for (const { image } of readerContext.pdfManifestPrefetches.values()) {
      image.onload = image.onerror = null;
      image.removeAttribute("src");
    }
    readerContext.pdfManifestPrefetches.clear();
  }

  function takePdfManifestPrefetch(target) {
    const record = readerContext.pdfManifestPrefetches.get(target);
    if (!record) return null;
    readerContext.pdfManifestPrefetches.delete(target);
    readerContext.pdfManifestPrefetchActive.delete(record);
    clearTimeout(record.timeout);
    record.image.onload = record.image.onerror = null;
    return record.image;
  }

  function queuePdfManifestPrefetch(delay = 250) {
    if (readerContext.readerAbortController.signal.aborted || !readerContext.pdfManifestPrefetchOrigin || !readerContext.canPrefetchPdfImages()) return;
    clearTimeout(readerContext.pdfManifestPrefetchTimer);
    readerContext.pdfManifestPrefetchTimer = setTimeout(() => {
      readerContext.pdfManifestPrefetchTimer = 0;
      if (readerContext.readerAbortController.signal.aborted || document.hidden || !navigator.onLine ||
          readerContext.pdfManifestPrefetchActive.size >= readerContext.pdfManifestPrefetchConcurrency() ||
          readerContext.pdfManifestPrefetchCount >= readerContext.pdfManifestPrefetchMaxPages() ||
          (readerContext.pdfActiveRenders && readerContext.content.querySelector('.reader-page[data-render-visible="1"][data-render-state="rendering"]'))) return;
      while (readerContext.pdfManifestPrefetchActive.size < readerContext.pdfManifestPrefetchConcurrency()) {
        if (readerContext.pdfManifestPrefetchCount >= readerContext.pdfManifestPrefetchMaxPages()) return;
        if (readerContext.pdfManifestPrefetchWrapped && readerContext.pdfManifestPrefetchNext >= readerContext.pdfManifestPrefetchOrigin) return;
        if (readerContext.pdfManifestPrefetchNext > readerContext.documentState.pageCount) {
          readerContext.pdfManifestPrefetchNext = 1;
          readerContext.pdfManifestPrefetchWrapped = true;
        }
        const next = readerContext.pdfManifestPrefetchNext++;
        const shell = readerContext.pdfManifestShells[next];
        if (shell && ["rendering", "rendered"].includes(shell.dataset.renderState)) continue;
        const url = readerContext.pdfPageManifest.pageUrl(next);
        if (readerContext.pdfManifestPrefetches.has(url)) continue;
        const image = new Image();
        const record = { image, url, timeout: 0 };
        image.decoding = "async";
        image.fetchPriority = "low";
        const finish = (failed) => {
          if (!readerContext.pdfManifestPrefetchActive.has(record)) return;
          readerContext.pdfManifestPrefetchActive.delete(record);
          clearTimeout(record.timeout);
          image.onload = image.onerror = null;
          if (failed) {
            readerContext.pdfManifestPrefetches.delete(url);
            image.removeAttribute("src");
          }
          readerContext.trimPdfManifestPrefetches();
          readerContext.queuePdfManifestPrefetch();
        };
        image.onload = () => finish(false);
        image.onerror = () => finish(true);
        readerContext.pdfManifestPrefetches.set(url, record);
        readerContext.pdfManifestPrefetchActive.add(record);
        readerContext.pdfManifestPrefetchCount++;
        record.timeout = setTimeout(() => finish(true), 15000);
        image.src = url;
        readerContext.trimPdfManifestPrefetches();
      }
    }, delay);
  }

  function prioritizePdfManifestPrefetch(target) {
    for (const record of [...readerContext.pdfManifestPrefetchActive]) {
      if (record.url !== target) readerContext.cancelPdfManifestPrefetch(record);
    }
    const record = readerContext.pdfManifestPrefetches.get(target);
    if (record && readerContext.pdfManifestPrefetchActive.has(record)) record.image.fetchPriority = "high";
  }

  function schedulePdfManifestPrefetch(page) {
    if (readerContext.pdfV3Manifest) return;
    if (!["pdf-pages", "image-pages"].includes(readerContext.capability.mode) || !readerContext.pdfPageManifest) return;
    const origin = Math.max(1, Math.min(readerContext.documentState.pageCount + 1, page + 1));
    if (readerContext.pdfManifestPrefetchOrigin === origin && readerContext.pdfManifestPrefetchNext) {
      if (!readerContext.pdfManifestPrefetchActive.size && !readerContext.pdfManifestPrefetchTimer) readerContext.queuePdfManifestPrefetch();
      return;
    }
    readerContext.stopPdfManifestPrefetch();
    readerContext.pdfManifestPrefetchOrigin = readerContext.pdfManifestPrefetchNext = origin;
    readerContext.pdfManifestPrefetchWrapped = false;
    readerContext.queuePdfManifestPrefetch();
  }

  function trimPdfManifestImages(protectedShell) {
    readerContext.trimPdfSurfaces(protectedShell);
  }

  function refreshNearbyPdfPages() {
    if (!readerContext.documentState.restorationReady || !["pdf", "pdf-pages", "image-pages"].includes(readerContext.capability.mode)) return;
    const page = readerContext.documentState.page;
    for (const offset of [0, 1, 2, 3, -1]) {
      const candidate = page + offset * readerContext.pdfScrollDirection;
      const shell = readerContext.content.querySelector(`.reader-page[data-page="${candidate}"]`);
      if (shell && shell.dataset.renderState !== "rendered") readerContext.renderPdfInBackground(shell);
    }
  }

  function cancelSpeculativePdfRenders(protectedShell) {
    for (const shell of readerContext.content.querySelectorAll('.reader-page')) {
      if (!shell._hybridRenderPromise && shell.dataset.renderState !== "rendering") continue;
      if (!shell._pdfRenderOwnsSlot && !shell._renderStarted) continue;
      if (
        shell === protectedShell ||
        readerContext.isPdfPageVisible(shell) || readerContext.pdfSelectionIntersects(shell)
      )
        continue;
      shell._pdfRenderCancelled = true;
      shell._renderCancel?.();
      shell._hybridCancel?.();
    }
  }

  function promotePdfRenderWaiter(shell) {
    for (const waiter of readerContext.pdfRenderWaiters) {
      if (waiter.shell === shell) waiter.priority = Math.max(waiter.priority, readerContext.pdfPagePriority(shell));
    }
  }

  function acquirePdfRenderSlot(priority = false, shell = null, signal = null) {
    if (readerContext.readerAbortController.signal.aborted) return Promise.reject(readerContext.readerAbortError());
    if (signal?.aborted) return Promise.reject(readerContext.readerAbortError());
    const limit = matchMedia("(max-width: 700px)").matches ? 1 : 2;
    if (readerContext.pdfActiveRenders < limit) {
      readerContext.pdfActiveRenders++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const remove = () => {
        const index = readerContext.pdfRenderWaiters.indexOf(waiter);
        if (index >= 0) readerContext.pdfRenderWaiters.splice(index, 1);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        remove();
        reject(readerContext.readerAbortError());
      };
      priority = readerContext.normalizePdfPriority(priority);
      const waiter = {
        shell,
        priority,
        resolve: () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          readerContext.pdfActiveRenders++;
          resolve();
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          reject(error);
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      const index = readerContext.pdfRenderWaiters.findIndex((item) => item.priority < priority);
      if (index < 0) readerContext.pdfRenderWaiters.push(waiter);
      else readerContext.pdfRenderWaiters.splice(index, 0, waiter);
    });
  }

  function releasePdfRenderSlot() {
    readerContext.pdfActiveRenders = Math.max(0, readerContext.pdfActiveRenders - 1);
    if (readerContext.readerAbortController.signal.aborted) return;
    let index = -1, best = -1, nearest = Infinity;
    for (let i = 0; i < readerContext.pdfRenderWaiters.length; i++) {
      const waiter = readerContext.pdfRenderWaiters[i], value = waiter.shell ? readerContext.pdfPagePriority(waiter.shell) : waiter.priority;
      const rect = waiter.shell?.getBoundingClientRect(), bounds = readerContext.viewport.getBoundingClientRect();
      const distance = rect ? Math.max(bounds.top - rect.bottom, rect.top - bounds.bottom, 0) : Infinity;
      if (value > best || (value === best && distance < nearest)) {
        best = value; nearest = distance; index = i;
      }
    }
    if (index < 0) index = 0;
    const waiter = readerContext.pdfRenderWaiters.splice(index, 1)[0];
    if (waiter) waiter.resolve();
  }

  function acquirePdfTextSlot(priority = false, request = null) {
    if (readerContext.readerAbortController.signal.aborted) return Promise.reject(readerContext.readerAbortError());
    return new Promise((resolve, reject) => {
      readerContext.pdfTextWaiters.push({ priority, request, resolve, reject });
      readerContext.drainPdfTextWaiters();
    });
  }

  function drainPdfTextWaiters() {
    if (readerContext.readerAbortController.signal.aborted) return;
    const limit = matchMedia("(max-width: 700px)").matches ? 2 : 3;
    for (let index = readerContext.pdfTextWaiters.length - 1; index >= 0; index--) {
      const request = readerContext.pdfTextWaiters[index].request;
      if (request && !request.demanded && !readerContext.isReaderGenerationCurrent("search", request.generation)) {
        if (readerContext.pdfTextContentPromises.get(request.page)?.request === request)
          readerContext.pdfTextContentPromises.delete(request.page);
        readerContext.pdfTextWaiters.splice(index, 1)[0].reject(readerContext.readerAbortError());
      }
    }
    while (readerContext.pdfActiveTextLoads < limit) {
      let index = readerContext.pdfTextWaiters.findIndex(waiter => waiter.priority || waiter.request?.demanded);
      if (index < 0) index = readerContext.pdfTextWaiters.findIndex(waiter =>
        !waiter.request || readerContext.pdfActiveSearchTextLoads < limit - 1);
      if (index < 0) return;
      const waiter = readerContext.pdfTextWaiters.splice(index, 1)[0];
      const background = !!waiter.request && !waiter.request.demanded;
      readerContext.pdfActiveTextLoads++;
      if (background) readerContext.pdfActiveSearchTextLoads++;
      waiter.resolve(background);
    }
  }

  function releasePdfTextSlot(background = false) {
    readerContext.pdfActiveTextLoads = Math.max(0, readerContext.pdfActiveTextLoads - 1);
    if (background) readerContext.pdfActiveSearchTextLoads = Math.max(0, readerContext.pdfActiveSearchTextLoads - 1);
    readerContext.drainPdfTextWaiters();
  }

  function trimPdfCanvases(protectedShell) {
    readerContext.trimPdfSurfaces(protectedShell);
  }

  function rerenderVisiblePdfPages() {
    readerContext.nextReaderGeneration("pdf");
    for (const shell of readerContext.content.querySelectorAll(".reader-page")) {
      const rect = shell.getBoundingClientRect();
      if (rect.bottom >= -1200 && rect.top <= innerHeight + 1200) {
        if (shell._renderPromise) shell.dataset.pendingRerender = "1";
        else readerContext.renderPdfInBackground(shell, true);
      }
    }
  }

  return {
    pdfManifestPrefetchConcurrency,
    pdfManifestPrefetchMaxPages,
    canPrefetchPdfImages,
    cancelPdfManifestPrefetch,
    stopPdfManifestPrefetch,
    trimPdfManifestPrefetches,
    pdfPixelBudget,
    pdfSurfacePixels,
    pdfRetainedPixels,
    trimPdfSurfaces,
    clearPdfManifestPrefetches,
    takePdfManifestPrefetch,
    queuePdfManifestPrefetch,
    prioritizePdfManifestPrefetch,
    schedulePdfManifestPrefetch,
    trimPdfManifestImages,
    refreshNearbyPdfPages,
    cancelSpeculativePdfRenders,
    promotePdfRenderWaiter,
    acquirePdfRenderSlot,
    releasePdfRenderSlot,
    acquirePdfTextSlot,
    drainPdfTextWaiters,
    releasePdfTextSlot,
    trimPdfCanvases,
    rerenderVisiblePdfPages
  };
}

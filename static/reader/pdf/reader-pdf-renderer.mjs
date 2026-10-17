export function createReaderPdfRenderer(readerContext) {
  function setPdfPageLoadingState(pageState, page) {
    pageState.dataset.state = "loading";
    pageState.setAttribute("role", "status");
    pageState.setAttribute("aria-label", `正在加载第 ${page} 页`);
    pageState.replaceChildren();
    pageState.hidden = false;
  }

  function isPdfPageVisible(shell) {
    const pageRect = shell?.getBoundingClientRect?.();
    const viewportRect = readerContext.viewport?.getBoundingClientRect?.();
    return !!pageRect && !!viewportRect && pageRect.bottom > viewportRect.top && pageRect.top < viewportRect.bottom;
  }

  function pdfPagePriority(shell) {
    const pageRect = shell?.getBoundingClientRect?.();
    const viewportRect = readerContext.viewport?.getBoundingClientRect?.();
    if (!pageRect || !viewportRect) return 0;
    if (pageRect.top >= viewportRect.top && pageRect.bottom <= viewportRect.bottom) return 3;
    if (pageRect.bottom > viewportRect.top && pageRect.top < viewportRect.bottom) return 2;
    return pageRect.bottom > viewportRect.top - readerContext.PDF_PREFETCH_MARGIN &&
      pageRect.top < viewportRect.bottom + readerContext.PDF_PREFETCH_MARGIN ? 1 : 0;
  }

  function normalizePdfPriority(priority) {
    return priority === true ? 3 : Math.max(0, Math.min(3, Number(priority) || 0));
  }

  function renderPdfInBackground(shell, force = false, priority = readerContext.pdfPagePriority(shell)) {
    priority = readerContext.normalizePdfPriority(priority);
    if (readerContext.readerAbortController.signal.aborted) return;
    if (!force && shell.dataset.renderFailed === "1") return;
    if (priority >= 2 && (force || shell.dataset.renderState !== "rendered") &&
        readerContext.pdfActiveRenders >= (matchMedia("(max-width: 700px)").matches ? 1 : 2))
      readerContext.cancelSpeculativePdfRenders(shell);
    if (priority) {
      shell.dataset.renderPriority = "1";
      readerContext.promotePdfRenderWaiter(shell);
    }
    if (shell._backgroundRender) {
      if (priority >= 2 && shell._pdfRenderCancelled) shell._resumePdfDemand = true;
      if (priority && ["pdf-pages", "image-pages"].includes(readerContext.capability.mode)) {
        const image = shell.querySelector("img");
        if (image) image.fetchPriority = priority >= 3 ? "high" : "auto";
      }
      if (force) {
        shell.dataset.pendingRerender = "1";
        if (readerContext.pdfHybridUrl) shell.dataset.pendingHybridRerender = "1";
      }
      return shell._backgroundRender;
    }
    const task =
        ["pdf-pages", "image-pages"].includes(readerContext.capability.mode)
        ? readerContext.renderPdfManifestShell(shell, force, priority)
        : readerContext.renderPdfShell(shell, force, priority);
    shell._backgroundRender = task;
    task
      .then(() => { delete shell.dataset.renderRetries; delete shell.dataset.renderFailed; })
      .catch((error) => {
        if (readerContext.readerAbortController.signal.aborted || error?.name === "AbortError") return;
        // Hybrid preview cancellation after PDF canvas completion is not a user-visible failure
        if (shell.dataset.pdfPresented === "1") return;
        console.warn(`PDF page ${shell.dataset.page} render failed`, error);
        const retries = Number(shell.dataset.renderRetries || 0);
        const pageState = shell.querySelector(".reader-page-state");
        if (pageState && !shell.querySelector("canvas.ready, img.ready")) {
          pageState.dataset.state = "error";
          pageState.removeAttribute("aria-label");
          pageState.hidden = false;
          pageState.textContent = retries < 3 ? "页面加载失败，正在重试..." : "页面加载失败";
        }
        if (retries < 3) {
          shell.dataset.renderRetries = String(retries + 1);
          readerContext.waitForReader(400 * (retries + 1))
            .then(() => {
              if (shell.isConnected) readerContext.renderPdfInBackground(shell);
            })
            .catch(() => {});
        } else {
          shell.dataset.renderFailed = "1";
          if (pageState && !pageState.hidden) {
            const retry = document.createElement("button");
            retry.type = "button";
            retry.textContent = "重试";
            retry.title = "重试加载此页";
            retry.addEventListener("click", () => {
              delete shell.dataset.renderFailed;
              delete shell.dataset.renderRetries;
              readerContext.setPdfPageLoadingState(pageState, shell.dataset.page);
              readerContext.renderPdfInBackground(shell, true, 3);
            }, {once:true});
            pageState.append(retry);
          }
        }
      })
      .finally(() => {
        if (shell._backgroundRender === task) delete shell._backgroundRender;
        delete shell._pdfRenderCancelled;
        if (shell._resumePdfDemand || shell._pdfRenderNeedsRequeue) {
          delete shell._resumePdfDemand;
          if (!readerContext.readerAbortController.signal.aborted && shell.isConnected &&
              readerContext.isPdfPageVisible(shell) && shell.dataset.renderState !== "rendered" &&
              shell.dataset.renderFailed !== "1") {
            delete shell._pdfRenderNeedsRequeue;
            queueMicrotask(() => readerContext.renderPdfInBackground(shell, false, readerContext.pdfPagePriority(shell)));
          }
        }
      });
    return task;
  }

  function pdfPrimarySource() {
    return readerContext.pdfV3Manifest ? readerContext.v3ResourceUrl(readerContext.pdfV3Manifest.primary.resource) : "";
  }

  function renderPdfManifestShell(shell, force = false, priority = false) {
    if (!readerContext.pdfHybridUrl) return readerContext.renderPdfImageShell(shell, force, priority);
    if (!force && shell.querySelector("canvas.ready")) return Promise.resolve();
    if (shell._hybridRenderPromise) {
      if (force) shell.dataset.pendingHybridRerender = "1";
      return shell._hybridReadyPromise;
    }
    const controller = new AbortController();
    shell._hybridCancel = () => { controller.abort(); shell._renderCancel?.(); };
    const pdfTask = readerContext.renderHybridPdfCanvas(shell, controller.signal, priority);
    const previewTask = (async () => {
      if (readerContext.isPdfPageVisible(shell) && !readerContext.pdfDocument)
        return readerContext.renderPdfImageShell(shell, false, priority);
      async function waitForPrimaryDocument() {
        const pending = readerContext.pdfHybridDocumentPromise;
        if (!pending) return false;
        const ready = pending.then(() => true, () => false);
        const deadline = performance.now() + readerContext.PDF_HYBRID_DOCUMENT_GRACE_MS;
        while (!controller.signal.aborted && !readerContext.readerAbortController.signal.aborted) {
          if (readerContext.pdfDocument) return true;
          if (readerContext.isPdfPageVisible(shell)) return false;
          const remaining = deadline - performance.now();
          if (remaining <= 0) return false;
          const result = await Promise.race([ready, readerContext.waitForReader(Math.min(100, remaining)).then(() => null)]);
          if (result !== null) return result;
        }
        throw readerContext.readerAbortError();
      }
      const documentReady = await waitForPrimaryDocument();
      if (!documentReady) return readerContext.renderPdfImageShell(shell, false, priority);
      // Keep speculation PDF-only without losing the per-page fallback if this
      // shell becomes visible while its PDF page read or draw is still pending.
      let pdfSettled = false;
      pdfTask.then(() => { pdfSettled = true; }, () => { pdfSettled = true; });
      while (!readerContext.isPdfPageVisible(shell) && !pdfSettled) {
        if (controller.signal.aborted || !shell.isConnected) throw readerContext.readerAbortError();
        await readerContext.waitForReader(100);
      }
      if (controller.signal.aborted || !shell.isConnected) throw readerContext.readerAbortError();
      if (await Promise.race([pdfTask.then(() => "pdf", () => "preview"), readerContext.waitForReader(readerContext.pdfScrollActivity?.(true) ? 0 : 150).then(() => "preview")]) === "pdf") return pdfTask;
      if (controller.signal.aborted || !shell.isConnected) throw readerContext.readerAbortError();
      if (shell.querySelector("canvas.ready") || shell.dataset.pdfPresented === "1") return pdfTask;
      return readerContext.renderPdfImageShell(shell, false, priority);
    })();
    const ready = Promise.any([pdfTask, previewTask]).catch(error => {
      if (controller.signal.aborted || readerContext.readerAbortController.signal.aborted) throw readerContext.readerAbortError();
      throw error.errors?.[1] || error.errors?.[0] || error;
    });
    shell._hybridReadyPromise = ready;
    const complete = Promise.allSettled([pdfTask, previewTask]).finally(() => {
      if (shell._hybridRenderPromise === complete) {
        delete shell._hybridRenderPromise; delete shell._hybridReadyPromise; delete shell._hybridCancel;
        if (shell.dataset.pendingHybridRerender && shell.isConnected && !readerContext.readerLifecycle.disposed) {
          delete shell.dataset.pendingHybridRerender;
          readerContext.renderPdfInBackground(shell, true);
        }
      }
    });
    shell._hybridRenderPromise = complete;
    return ready;
  }

  async function renderHybridPdfCanvas(shell, signal, priority) {
    let acquired = false, canvas = null, rendering = null;
    const cancel = () => rendering?.cancel?.();
    const untrack = readerContext.trackReaderResource(() => { rendering?.cancel?.(); shell._hybridCancel?.(); });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const pdf = await readerContext.awaitReader(readerContext.pdfHybridDocumentPromise, signal);
      do {
        const generation = readerContext.readerRuntime.currentGeneration("pdf");
        if (signal.aborted || !shell.isConnected) throw readerContext.readerAbortError();
        if (!acquired) {
          // Admit page reads too: getPage can demand ranges before canvas rendering.
          await readerContext.measurePdf(readerContext.acquirePdfRenderSlot(priority, shell, signal), "queue", Number(shell.dataset.page));
          acquired = true;
          shell._pdfRenderOwnsSlot = true;
        }
        if (signal.aborted || !shell.isConnected) throw readerContext.readerAbortError();
        const page = await readerContext.measurePdf(readerContext.awaitReader(pdf.getPage(Number(shell.dataset.page)), signal), "page", Number(shell.dataset.page));
        if (signal.aborted || !shell.isConnected) throw readerContext.readerAbortError();
        const base = page.getViewport({ scale: 1 });
        const geometry = readerContext.pdfV3Map.pages[Number(shell.dataset.page) - 1];
        if (Math.abs((base.width / base.height) / (geometry.width / geometry.height) - 1) > .01)
          throw new Error("PDF_V3_DOCUMENT_GEOMETRY_MISMATCH");
        const view = page.getViewport({ scale: Math.min(3, shell.clientWidth / base.width) });
        const outputScale = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
        canvas = document.createElement("canvas"); canvas.setAttribute("aria-hidden", "true");
        canvas.width = Math.ceil(view.width * outputScale); canvas.height = Math.ceil(view.height * outputScale);
        rendering = page.render({ canvasContext: canvas.getContext("2d"), viewport: view,
          transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0] });
        await readerContext.measurePdf(readerContext.awaitReader(rendering.promise, signal), "draw", Number(shell.dataset.page)); rendering = null;
        while (!readerContext.pdfV3Manifest && readerContext.pdfSelectionIntersects(shell) && !signal.aborted) await readerContext.waitForReader(100);
        if (signal.aborted || !shell.isConnected) throw readerContext.readerAbortError();
        if (!readerContext.isReaderGenerationCurrent("pdf", generation)) { canvas.width = canvas.height = 0; continue; }
        const anchor = readerContext.content.querySelector(`.reader-page[data-page="${readerContext.documentState.page}"]`);
        const oldTop = anchor?.getBoundingClientRect().top;
        canvas.classList.add("ready");
        const previous = shell.querySelector("canvas");
        if (previous) { previous.replaceWith(canvas); previous.width = previous.height = 0; }
        else shell.prepend(canvas);
        shell.style.aspectRatio = `${base.width} / ${base.height}`;
        shell._renderCancel?.(); shell.querySelector("img")?.remove(); shell._v3PreviewRelease?.();
        const state = shell.querySelector(".reader-page-state"); if (state) state.hidden = true;
        shell.dataset.pdfPresented = "1"; shell.dataset.renderState = "rendered";
        delete shell.dataset.pendingHybridRerender;
        shell.dataset.renderUsedAt = String(Date.now());
        if (anchor) readerContext.viewport.scrollTop += anchor.getBoundingClientRect().top - oldTop;
        readerContext.pdfShellWindow?.remember(shell); readerContext.trimPdfCanvases(shell);
        (readerContext.ocrManifestUrl ? readerContext.renderPdfOcrText(shell) : readerContext.renderPdfText(page, shell, signal)).catch(() => {});
        readerContext.scheduleMarkerSync(); canvas = null; return;
      } while (true);
    } finally {
      rendering?.cancel?.(); if (canvas) canvas.width = canvas.height = 0;
      if (acquired) { delete shell._pdfRenderOwnsSlot; readerContext.releasePdfRenderSlot(); }
      signal.removeEventListener("abort", cancel); untrack();
    }
  }

  function renderPdfImageShell(shell, force = false, priority = false) {
    if (!shell) return Promise.reject(new Error("PDF page shell missing"));
    if (shell._renderPromise) return shell._renderPromise;
    if (!force && shell.dataset.renderState === "rendered") return Promise.resolve();
    shell.dataset.renderState = "rendering";
    const renderController = new AbortController();
    shell._renderCancel = () => renderController.abort();
    shell._renderStarted = false;
    priority = readerContext.normalizePdfPriority(priority || readerContext.pdfPagePriority(shell));
    shell._renderActivePriority = String(priority);
    const task = (async () => {
      let acquired = false;
      try {
        await readerContext.measurePdf(readerContext.acquirePdfRenderSlot(priority, shell, renderController.signal), "queue", Number(shell.dataset.page));
        acquired = true;
        shell._renderStarted = true;
        readerContext.assertReaderActive();
        const entry = readerContext.pdfPageEntry(Number(shell.dataset.page));
        if (!entry) throw new Error("PDF page entry missing");
         let target = readerContext.pdfPageManifest.pageUrl(entry.page);
         if (readerContext.pdfV3Manifest) {
            const preview = await readerContext.pdfV3Repository.preview(readerContext.pdfV3Manifest, readerContext.pdfV3Map, entry.page, renderController.signal);
           shell._v3PreviewEntry = preview.entry;
           readerContext.assertReaderActive();
           if (renderController.signal.aborted) throw readerContext.readerAbortError();
           shell._v3PreviewRelease?.();
           target = URL.createObjectURL(preview.blob);
           const release = () => { URL.revokeObjectURL(target); readerContext.pdfV3BlobReleases.delete(release); delete shell._v3PreviewRelease; };
           shell._v3PreviewRelease = release;
           readerContext.pdfV3BlobReleases.add(release);
         }
        let loadText = null;
        let image = shell.querySelector("img");
         const pageState = shell.querySelector(".reader-page-state");
         if (!image) {
          image = readerContext.takePdfManifestPrefetch(target) || new Image();
          image.alt = `第 ${entry.page} 页`;
          image.decoding = "async";
          shell.appendChild(image);
        }
        image.fetchPriority = priority >= 3 ? "high" : priority >= 1 ? "auto" : "low";
        if (priority >= 2 && readerContext.ocrManifestUrl && !navigator.connection?.saveData)
          loadText = readerContext.renderPdfOcrText(shell);
        loadText?.catch(() => {});
        await readerContext.imageLoader.load(image, target, renderController.signal);
        readerContext.assertReaderActive();
         if (shell.dataset.pdfPresented === "1") return;
         if (readerContext.pdfV3Manifest) {
           const geometry = readerContext.pdfV3Map.pages[entry.page - 1];
           // Vector previews have fractional intrinsic sizes. The pipeline
           // records math.ceil(width/height); browsers round naturalWidth.
           const tolerance = shell._v3PreviewEntry.codec === "svg" ? 1 : 0;
           if (Math.abs(image.naturalWidth - shell._v3PreviewEntry.width) > tolerance ||
               Math.abs(image.naturalHeight - shell._v3PreviewEntry.height) > tolerance ||
               Math.abs((image.naturalWidth / image.naturalHeight) / (geometry.width / geometry.height) - 1) > .01)
             throw new Error("PDF_V3_PREVIEW_GEOMETRY_MISMATCH");
         }
         shell.style.aspectRatio = `${image.naturalWidth || 1} / ${image.naturalHeight || 1}`;
         if (priority >= 2 && readerContext.ocrManifestUrl && !navigator.connection?.saveData)
           loadText ||= readerContext.renderPdfOcrText(shell);
        loadText?.catch(() => {});
        image.classList.add("ready");
        if (pageState) pageState.hidden = true;
        shell.dataset.renderState = "rendered";
        delete shell.dataset.renderRetries;
        delete shell.dataset.renderFailed;
        shell.dataset.renderUsedAt = String(Date.now());
        readerContext.pdfShellWindow?.remember(shell);
        if (readerContext.isPdfPageVisible(shell) || !readerContext.pdfManifestPrefetchOrigin) readerContext.schedulePdfManifestPrefetch(entry.page);
        else if (!readerContext.pdfManifestPrefetchActive.size && !readerContext.pdfManifestPrefetchTimer) readerContext.queuePdfManifestPrefetch();
        readerContext.trimPdfManifestImages(shell);
        readerContext.scheduleMarkerSync();
      } catch (error) {
        shell.querySelector("img")?.remove();
        shell._v3PreviewRelease?.();
        // The outer background task owns the user-visible error/retry state.
        // Preview cancellation is expected during the PDF handoff and must
        // not flash a false page failure.
        if (shell.dataset.pdfPresented !== "1") shell.dataset.renderState = "idle";
        throw error;
      } finally {
        if (acquired) readerContext.releasePdfRenderSlot();
      }
    })().finally(() => {
      if (shell._renderPromise === task) delete shell._renderPromise;
      if (shell._renderCancel) delete shell._renderCancel;
      delete shell._renderStarted;
      delete shell._renderActivePriority;
    });
    shell._renderPromise = task;
    return task;
  }

  function renderPdfShell(shell, force = false, priority = false) {
    if (shell._renderPromise) {
      if (force) shell.dataset.pendingRerender = "1";
      return shell._renderPromise;
    }
    if (!force && shell.dataset.renderState === "rendered") return Promise.resolve();
    shell.dataset.renderState = "rendering";
    const loadingState = shell.querySelector(".reader-page-state");
    if (loadingState && !shell.querySelector("canvas.ready, img.ready"))
      readerContext.setPdfPageLoadingState(loadingState, shell.dataset.page);
    const renderController = new AbortController();
    priority = readerContext.normalizePdfPriority(priority || readerContext.pdfPagePriority(shell));
    let activeRendering = null;
    shell._renderCancel = () => {
      renderController.abort();
      activeRendering?.cancel?.();
    };
    const task = (async () => {
      let acquired = false;
      try {
        await readerContext.measurePdf(readerContext.acquirePdfRenderSlot(priority, shell, renderController.signal), "queue", Number(shell.dataset.page));
        acquired = true;
        shell._pdfRenderOwnsSlot = true;
        readerContext.assertReaderActive();
        if (renderController.signal.aborted) throw readerContext.readerAbortError();
        const pdf = readerContext.pdfDocument;
        if (!pdf) throw readerContext.readerAbortError();
        do {
          delete shell.dataset.pendingRerender;
          const generation = readerContext.readerRuntime.currentGeneration("pdf"),
            pageNumber = Number(shell.dataset.page),
            page = await readerContext.measurePdf(readerContext.awaitReader(pdf.getPage(pageNumber), renderController.signal), "page", pageNumber);
          readerContext.assertReaderActive();
          if (renderController.signal.aborted) throw readerContext.readerAbortError();
          const base = page.getViewport({ scale: 1 }),
            scale = Math.min(3, shell.clientWidth / base.width),
            viewport = page.getViewport({ scale }),
            outputScale = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
          const canvas = shell.querySelector("canvas");
          canvas.width = Math.ceil(viewport.width * outputScale);
          canvas.height = Math.ceil(viewport.height * outputScale);
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          shell.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
          const rendering = page.render({
            canvasContext: canvas.getContext("2d"),
            viewport,
            transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
          });
          activeRendering = rendering;
          const untrack = readerContext.trackReaderResource(() => rendering.cancel?.());
          const textTask = readerContext.renderPdfText(page, shell, renderController.signal);
          textTask.catch(() => {});
          try {
            // The canvas is the first visible result. Text extraction can need a
            // separate range and must not delay the visual first page.
            await readerContext.measurePdf(readerContext.awaitReader(rendering.promise, renderController.signal), "draw", Number(shell.dataset.page));
          } finally {
            untrack();
            activeRendering = null;
          }
          readerContext.assertReaderActive();
          if (renderController.signal.aborted) throw readerContext.readerAbortError();
          if (!readerContext.isReaderGenerationCurrent("pdf", generation)) shell.dataset.pendingRerender = "1";
        } while (shell.dataset.pendingRerender);
        shell.querySelector("canvas").classList.add("ready");
        const pageState = shell.querySelector(".reader-page-state");
        if (pageState) pageState.hidden = true;
        shell.dataset.renderState = "rendered";
        shell.dataset.renderUsedAt = String(Date.now());
        readerContext.pdfShellWindow?.remember(shell);
        readerContext.trimPdfCanvases(shell);
        delete shell.dataset.renderRetries;
        delete shell.dataset.renderFailed;
      } catch (error) {
        shell.dataset.renderState = "idle";
        throw error;
      } finally {
        if (acquired) { delete shell._pdfRenderOwnsSlot; readerContext.releasePdfRenderSlot(); }
      }
    })().finally(() => {
      if (shell._renderPromise === task) delete shell._renderPromise;
      if (shell._renderCancel) delete shell._renderCancel;
    });
    shell._renderPromise = task;
    return task;
  }

  return {
    setPdfPageLoadingState,
    isPdfPageVisible,
    pdfPagePriority,
    normalizePdfPriority,
    renderPdfInBackground,
    pdfPrimarySource,
    renderPdfManifestShell,
    renderHybridPdfCanvas,
    renderPdfImageShell,
    renderPdfShell
  };
}

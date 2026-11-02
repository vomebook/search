// Preserve the previous 2x baseline on desktops and low-memory devices, but
// use high-density mobile pixels when the additional canvas fits the budget.
export function pdfOutputScale(viewport) {
  const dpr = Math.max(1, Number(window.devicePixelRatio) || 1), baseline = Math.min(2, dpr);
  if (!matchMedia("(max-width: 700px)").matches || (Number(navigator.deviceMemory) > 0 && Number(navigator.deviceMemory) <= 2))
    return baseline;
  const width = Number(viewport.width), height = Number(viewport.height);
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return baseline;
  const affordable = Math.sqrt(6_000_000 / ((width + 1) * (height + 1)));
  return Math.max(baseline, Math.min(3, dpr, affordable));
}

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
      if (readerContext.capability.mode === "image-pages" && readerContext.pdfPageManifest)
        readerContext.prioritizePdfManifestPrefetch(readerContext.pdfPageManifest.pageUrl(Number(shell.dataset.page)));
    }
    if (shell._backgroundRender) {
      if (priority >= 2 && shell._pdfRenderCancelled) shell._resumePdfDemand = true;
      if (priority && readerContext.capability.mode === "image-pages") {
        const image = shell.querySelector("img");
        if (image) image.fetchPriority = priority >= 3 ? "high" : "auto";
      }
      if (force) {
        shell.dataset.pendingRerender = "1";
      }
      return shell._backgroundRender;
    }
    const task =
        readerContext.capability.mode === "image-pages"
        ? readerContext.renderPdfImageShell(shell, force, priority)
        : readerContext.capability.mode === "pdf-pages"
        ? Promise.reject(new Error("PDF_PRIMARY_REQUIRED"))
        : readerContext.renderPdfShell(shell, force, priority);
    shell._backgroundRender = task;
    task
      .then(() => { delete shell.dataset.renderRetries; delete shell.dataset.renderFailed; })
      .catch((error) => {
        if (readerContext.readerAbortController.signal.aborted || error?.name === "AbortError") return;
        console.warn(`PDF page ${shell.dataset.page} render failed`, error);
        if (error?.message === "DJVU_CANVAS_LIMIT_EXCEEDED") {
          const pageState = shell.querySelector(".reader-page-state");
          if (pageState) {
            pageState.dataset.state = "error";
            pageState.removeAttribute("aria-label");
            pageState.hidden = false;
            pageState.textContent = "页面超过浏览器绘制上限，请缩小后重试。";
          }
          shell.dataset.renderFailed = "1";
          return;
        }
        if (String(error?.message || '').startsWith('DJVU_')) {
          const pageState = shell.querySelector('.reader-page-state');
          if (pageState) {
            pageState.dataset.state = 'error';
            pageState.removeAttribute('aria-label');
            pageState.hidden = false;
            pageState.textContent = `DjVu 页面解码失败（${error.message}），请重新打开原文件。`;
          }
          shell.dataset.renderFailed = '1';
          return;
        }
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
        const cancelled = shell._pdfRenderCancelled;
        delete shell._pdfRenderCancelled;
        if (shell.dataset.pendingRerender && !shell._renderPromise && shell.isConnected &&
            !readerContext.readerAbortController.signal.aborted && shell.dataset.renderFailed !== "1") {
          delete shell.dataset.pendingRerender;
          if (!cancelled || readerContext.isPdfPageVisible(shell))
            queueMicrotask(() => readerContext.renderPdfInBackground(shell, true, readerContext.pdfPagePriority(shell)));
          return;
        }
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
    if (readerContext.capability.mode !== "pdf-pages") return "";
    // DjVu is opened by its own reader, never handed to PDF.js.
    if (readerContext.pdfV3Manifest)
      return readerContext.pdfV3Manifest.primary.kind === "pdf" ? readerContext.v3ResourceUrl(readerContext.pdfV3Manifest.primary.resource) : "";
    const candidate = readerContext.normalizeSourceUrl(readerContext.params.get("pdf_document") || readerContext.resolvedReaderData?.pdf_document ||
      (readerContext.resolvedReaderData?.original_extension === "pdf" || /\.pdf(?:$|[?#])/i.test(readerContext.downloadUrl)
        ? readerContext.downloadUrl : ""));
    try {
      const parsed = new URL(candidate, location.href);
      const path = parsed.searchParams.get("path") || parsed.pathname;
      return readerContext.validSource(parsed.href) && /\.pdf$/i.test(path) ? parsed.href : "";
    } catch (_) { return ""; }
  }

  // Applies a page-geometry change (aspect ratio, surface swap) while keeping
  // the reading anchor at the same visual position.
  function applyPdfShellGeometry(change) {
    const anchor = readerContext.content.querySelector(`.reader-page[data-page="${readerContext.documentState.page}"]`);
    const viewportTop = readerContext.viewport.getBoundingClientRect().top;
    const before = anchor?.getBoundingClientRect();
    const atEnd = readerContext.viewport.scrollTop > 0 &&
      readerContext.viewport.scrollHeight - readerContext.viewport.clientHeight - readerContext.viewport.scrollTop <= 2;
    const fraction = before ? Math.max(0, (viewportTop - before.top) / Math.max(1, before.height)) : 0;
    change();
    if (!before || !anchor.isConnected) return;
    if (atEnd) {
      readerContext.viewport.scrollTop = readerContext.viewport.scrollHeight - readerContext.viewport.clientHeight;
      return;
    }
    const after = anchor.getBoundingClientRect();
    const delta = after.top - before.top + fraction * (after.height - before.height);
    if (Math.abs(delta) >= .5) readerContext.viewport.scrollTop += delta;
  }

  // Reveal ordinary image pages only after decoding; respect reduced motion.
  function revealPdfSurface(shell, surface, fade) {
    surface.classList.add("ready");
    if (fade && readerContext.capability?.mode === "image-pages")
      surface.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "ease" });
  }

  function pdfSurfaceFades(shell) {
    return !shell.querySelector("canvas.ready, img.ready") && readerContext.isPdfPageVisible(shell) &&
      !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  }

  // Waits until a loaded page image is decoded, so its first painted frame is
  // the complete page rather than rows arriving from the top. Bounded: a
  // hidden (parked) Reader may defer decoding without blocking the page.
  async function decodePdfImage(image, signal) {
    if (typeof image.decode !== "function") return;
    let timer = 0;
    try {
      await readerContext.awaitReader(Promise.race([
        image.decode().catch(() => {}),
        new Promise(resolve => { timer = setTimeout(resolve, 2000); })
      ]), signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /** @param {boolean | number} priority */
  function renderPdfImageShell(shell, force = false, priority = false) {
    if (!shell) return Promise.reject(new Error("PDF page shell missing"));
    if (readerContext.capability?.mode !== "image-pages")
      return Promise.reject(new Error("PDF_PRIMARY_REQUIRED"));
    const loadingState = shell.querySelector(".reader-page-state");
    if (loadingState?.hidden && readerContext.documentState.restorationReady && !shell.querySelector("canvas.ready, img.ready"))
      readerContext.setPdfPageLoadingState(loadingState, shell.dataset.page);
    if (shell._renderPromise) return shell._renderPromise;
    if (!force && shell.dataset.renderState === "rendered") return Promise.resolve();
    priority = readerContext.normalizePdfPriority(priority || readerContext.pdfPagePriority(shell));
    const evicted = shell._pdfImageEvictedAt;
    if (!force && /** @type {number} */ (priority) < 2 && evicted && !readerContext.isPdfPageVisible(shell) &&
        evicted.page === readerContext.documentState.page && evicted.zoom === readerContext.documentState.zoom &&
        evicted.direction === readerContext.pdfScrollDirection && evicted.budget === readerContext.pdfPixelBudget() &&
        evicted.width === readerContext.viewport.clientWidth && evicted.height === readerContext.viewport.clientHeight)
      return Promise.resolve();
    delete shell._pdfImageEvictedAt;
    shell.dataset.renderState = "rendering";
    const renderController = new AbortController();
    shell._renderCancel = () => renderController.abort();
    shell._renderStarted = false;
    shell._renderActivePriority = String(priority);
    const task = (async () => {
      let acquired = false;
      try {
        // Page images are network-bound, not canvas work: they use their own
        // priority-ordered pool, where visible demand preempts speculation.
        await readerContext.measurePdf(readerContext.acquirePdfPreviewSlot(priority, shell, renderController.signal), "queue", Number(shell.dataset.page));
        acquired = true;
        shell._renderStarted = true;
        readerContext.assertReaderActive();
        // The page may have become visible while it waited for a slot.
        priority = Math.max(/** @type {number} */ (priority), readerContext.pdfPagePriority(shell));
        shell._renderActivePriority = String(priority);
        const entry = readerContext.pdfPageEntry(Number(shell.dataset.page));
        if (!entry) throw new Error("PDF page entry missing");
        const target = readerContext.pdfPageManifest.pageUrl(entry.page);
        const progressive = (readerContext.pdfPageManifest.pageCodec?.(entry.page) || readerContext.pdfPageManifest.codec) === "jxl";
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
        if (progressive) image.classList.add("progressive");
        if (priority >= 2 && readerContext.ocrManifestUrl && !navigator.connection?.saveData)
          loadText = readerContext.renderPdfOcrText(shell);
        loadText?.catch(() => {});
        await readerContext.imageLoader.load(image, target, renderController.signal);
        readerContext.assertReaderActive();
        // Reveal only a fully decoded page, never one painting from the top.
        if (!progressive) await decodePdfImage(image, renderController.signal);
        readerContext.assertReaderActive();
        const fade = pdfSurfaceFades(shell);
        readerContext.applyPdfShellGeometry(() => {
          shell.style.aspectRatio = `${image.naturalWidth || 1} / ${image.naturalHeight || 1}`;
          shell.dataset.pageGeometry = "1";
          revealPdfSurface(shell, image, fade);
          readerContext.seedPdfPageGeometry?.(image.naturalWidth, image.naturalHeight);
        });
        // A speculative page may become visible while its image is loading.
        // The visibility observer saw "rendering" then, so it could not attach
        // text; do not keep the stale admission priority after image completion.
        if ((priority >= 2 || readerContext.isPdfPageVisible(shell)) && readerContext.ocrManifestUrl && !navigator.connection?.saveData)
          loadText ||= readerContext.renderPdfOcrText(shell);
        loadText?.catch(() => {});
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
        // The outer background task owns user-visible error/retry state.
        // Set idle so the reconciliation scheduler can retry if this becomes visible.
        shell.dataset.renderState = "idle";
        throw error;
      } finally {
        if (acquired) readerContext.releasePdfPreviewSlot(shell);
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
        let canvas = null;
        do {
          delete shell.dataset.pendingRerender;
          const generation = readerContext.readerRuntime.currentGeneration("pdf"),
            pageNumber = Number(shell.dataset.page),
            page = await readerContext.measurePdf(readerContext.awaitReader(pdf.getPage(pageNumber), renderController.signal), "page", pageNumber);
          readerContext.assertReaderActive();
          if (renderController.signal.aborted) throw readerContext.readerAbortError();
          const base = page.getViewport({ scale: 1 }),
            scale = Math.min(pdf.readerRenderScaleLimit ?? 3, shell.clientWidth / base.width),
            viewport = page.getViewport({ scale }),
            outputScale = pdfOutputScale(viewport);
          if (readerContext.pdfV3Map) {
            const geometry = readerContext.pdfV3Map.pages[pageNumber - 1];
            if (Math.abs((base.width / base.height) / (geometry.width / geometry.height) - 1) > .01)
              throw new Error("PDF_V3_DOCUMENT_GEOMETRY_MISMATCH");
          }
          canvas = shell.querySelector("canvas");
          if (!canvas) {
            canvas = document.createElement("canvas");
            canvas.setAttribute("aria-hidden", "true");
            shell.prepend(canvas);
          }
          // Resizing clears a canvas; never expose it as complete until the
          // replacement render has finished.
          canvas.classList.remove("ready");
          const targetWidth = Math.ceil(viewport.width * outputScale), targetHeight = Math.ceil(viewport.height * outputScale);
          if (pdf.readerMaxCanvasPixels && targetWidth * targetHeight > pdf.readerMaxCanvasPixels) {
            if (!readerContext.isReaderGenerationCurrent("pdf", generation)) {
              shell.dataset.pendingRerender = "1";
              continue;
            }
            throw new Error("DJVU_CANVAS_LIMIT_EXCEEDED");
          }
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          shell.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
          const rendering = page.render({
            canvasContext: canvas.getContext("2d"),
            viewport,
            readerPriority: Math.max(Number(priority), readerContext.pdfPagePriority(shell)),
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
        canvas.classList.add("ready");
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
    pdfOutputScale,
    setPdfPageLoadingState,
    isPdfPageVisible,
    pdfPagePriority,
    normalizePdfPriority,
    renderPdfInBackground,
    pdfPrimarySource,
    renderPdfImageShell,
    renderPdfShell,
    applyPdfShellGeometry,
    revealPdfSurface,
    pdfSurfaceFades
  };
}

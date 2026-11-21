// A narrow high-DPR viewport can show the same physical pixels as a wide
// desktop viewport. Bound the backing store, not the mobile density ratio.
/** @param {import('../../../typings/reader-pdf-renderer-strict').PdfViewport} viewport */
export function pdfOutputScale(viewport) {
  const reported = Number(window.devicePixelRatio);
  const dpr = Number.isFinite(reported) && reported > 0 ? reported : 1;
  const memory = Number(/** @type {Navigator & {deviceMemory?: number}} */ (navigator).deviceMemory);
  const lowMemory = memory > 0 && memory <= 2;
  const width = Number(viewport.width), height = Number(viewport.height);
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return Math.min(2, dpr);
  // For DjVu this limits the display canvas only, not the native decode.
  const budget = lowMemory ? 4_000_000 : 6_000_000;
  if (Math.ceil(width * dpr) * Math.ceil(height * dpr) <= budget) return dpr;
  // Leave room for the ceil on both axes. The limiting scale may be below
  // 1 for very large or unusually shaped pages.
  // Positive root of (width * scale + 1) * (height * scale + 1) = budget.
  const sum = width + height;
  return 2 * (budget - 1) / (sum + Math.hypot(sum, 2 * Math.sqrt(width * height * (budget - 1))));
}

/** @param {import('../../../typings/reader-pdf-renderer-strict').PdfRendererContext} readerContext */
export function createReaderPdfRenderer(readerContext) {
  /** @param {HTMLElement} pageState @param {string | number | undefined} page */
  function setPdfPageLoadingState(pageState, page) {
    pageState.dataset.state = "loading";
    pageState.setAttribute("role", "status");
    pageState.setAttribute("aria-label", `正在加载第 ${page} 页`);
    pageState.replaceChildren();
    pageState.hidden = false;
  }

  /** @param {import('../../../typings/reader-pdf-renderer-strict').PdfShell} shell */
  function isPdfPageVisible(shell) {
    const pageRect = shell?.getBoundingClientRect?.();
    const viewportRect = readerContext.viewport?.getBoundingClientRect?.();
    return !!pageRect && !!viewportRect && pageRect.bottom > viewportRect.top && pageRect.top < viewportRect.bottom;
  }

  /** @param {import('../../../typings/reader-pdf-renderer-strict').PdfShell} shell */
  function pdfPagePriority(shell) {
    const pageRect = shell?.getBoundingClientRect?.();
    const viewportRect = readerContext.viewport?.getBoundingClientRect?.();
    if (!pageRect || !viewportRect) return 0;
    if (pageRect.top >= viewportRect.top && pageRect.bottom <= viewportRect.bottom) return 3;
    if (pageRect.bottom > viewportRect.top && pageRect.top < viewportRect.bottom) return 2;
    return pageRect.bottom > viewportRect.top - readerContext.PDF_PREFETCH_MARGIN &&
      pageRect.top < viewportRect.bottom + readerContext.PDF_PREFETCH_MARGIN ? 1 : 0;
  }

  /** @param {boolean | number} priority */
  function normalizePdfPriority(priority) {
    return priority === true ? 3 : Math.max(0, Math.min(3, Number(priority) || 0));
  }

  /** @param {import('../../../typings/reader-pdf-renderer-strict').PdfShell} shell @param {boolean} [force] @param {boolean | number} [priority] */
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
      .catch((/** @type {unknown} */ reason) => {
        const error = /** @type {{ name?: string, message?: string } | null | undefined} */ (reason);
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
            const message = error?.message || '';
            // Terminal transient range failures are handled at the document
            // level. Don't call integrity/transport failures decode errors.
            pageState.textContent = /^DJVU_(?:RANGE_|SOURCE_CHANGED)/.test(message)
              ? `DjVu 原文件读取或校验失败（${message}），请检查原文件。`
              : `DjVu 页面解码失败（${message}），请重新打开原文件。`;
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
  /** @param {() => void} change */
  function applyPdfShellGeometry(change) {
    const anchor = readerContext.content.querySelector(`.reader-page[data-page="${readerContext.documentState.page}"]`);
    const viewportTop = readerContext.viewport.getBoundingClientRect().top;
    const before = anchor?.getBoundingClientRect();
    const atEnd = readerContext.viewport.scrollTop > 0 &&
      readerContext.viewport.scrollHeight - readerContext.viewport.clientHeight - readerContext.viewport.scrollTop <= 2;
    const fraction = before ? Math.max(0, (viewportTop - before.top) / Math.max(1, before.height)) : 0;
    change();
    if (!before || !anchor || !anchor.isConnected) return;
    if (atEnd) {
      readerContext.viewport.scrollTop = readerContext.viewport.scrollHeight - readerContext.viewport.clientHeight;
      return;
    }
    const after = anchor.getBoundingClientRect();
    const delta = after.top - before.top + fraction * (after.height - before.height);
    if (Math.abs(delta) >= .5) readerContext.viewport.scrollTop += delta;
  }

  // Reveal ordinary image pages only after decoding; respect reduced motion.
  /** @param {HTMLElement} surface @param {boolean} fade */
  function revealPdfSurface(surface, fade) {
    surface.classList.add("ready");
    if (fade && readerContext.capability?.mode === "image-pages")
      surface.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "ease" });
  }

  /** @param {import('../../../typings/reader-pdf-renderer-strict').PdfShell} shell */
  function pdfSurfaceFades(shell) {
    return !shell.querySelector("canvas.ready, img.ready") && readerContext.isPdfPageVisible(shell) &&
      !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  }

  // Waits until a loaded page image is decoded, so its first painted frame is
  // the complete page rather than rows arriving from the top. Bounded: a
  // hidden (parked) Reader may defer decoding without blocking the page.
  /** @param {HTMLImageElement} image @param {AbortSignal} signal */
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

  /** @param {Uint8Array} bytes */
  function hasAvifBrand(bytes) {
    if (bytes.byteLength < 16) return false;
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = header.getUint32(0);
    if (header.getUint32(4) !== 0x66747970 /* ftyp */ || size < 16 || size > bytes.byteLength || size % 4)
      return false;
    const avif = 0x61766966;
    if (header.getUint32(8) === avif) return true;
    // Skip minor_version; only major_brand and compatible_brands identify the format.
    for (let offset = 16; offset < size; offset += 4)
      if (header.getUint32(offset) === avif) return true;
    return false;
  }

  /** @param {HTMLImageElement} image @param {string} url @param {AbortSignal} signal
   * @param {import('../../../typings/reader-page-window-strict').ImagePageIntegrity} expected */
  async function loadVerifiedAvifPage(image, url, signal, expected) {
    const target = new URL(url);
    target.searchParams.set("sha256", expected.sha256);
    target.searchParams.set("bytes", String(expected.bytes));
    // The exact proxy route rejects partial and conditional requests. Reuse
    // fresh immutable responses without sending validators for stale entries.
    const response = await readerContext.fetchWithReaderTimeout(target.href, readerContext.READER_PROXY_TIMEOUT_MS,
      { signal, priority: image.fetchPriority, cache: "force-cache", redirect: "error" });
    if (response.status !== 200 || response.headers.get("Content-Range") ||
        response.headers.get("Content-Type") !== "image/avif") {
      void response.body?.cancel().catch(() => {});
      throw new Error(response.ok ? "IMAGE_PAGE_RESPONSE_INVALID" : `HTTP ${response.status}`);
    }
    const bytes = await VoiceOfMLReaderSecurity.readBytes(response, expected.bytes);
    if (bytes.byteLength !== expected.bytes) throw new Error("IMAGE_PAGE_SIZE_MISMATCH");
    if (!hasAvifBrand(bytes)) throw new Error("IMAGE_PAGE_FORMAT_MISMATCH");
    signal.throwIfAborted();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    if (Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") !== expected.sha256)
      throw new Error("IMAGE_PAGE_DIGEST_MISMATCH");
    signal.throwIfAborted();
    readerContext.assertReaderActive();
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "image/avif" }));
    try {
      await readerContext.imageLoader.load(image, blobUrl, signal);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  /** @param {import('../../../typings/reader-pdf-renderer-strict').PdfShell} shell @param {boolean} [force] @param {boolean | number} [priority] */
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
        const manifest = /** @type {import('../../../typings/reader-pdf-renderer-strict').PdfPageManifest} */ (readerContext.pdfPageManifest);
        const target = manifest.pageUrl(entry.page);
        const progressive = (manifest.pageCodec?.(entry.page) || manifest.codec) === "jxl";
        let loadText = null;
        let image = shell.querySelector("img");
        const pageState = shell.querySelector(".reader-page-state");
        if (!image) {
          image = (manifest.codec === "avif" ? null : readerContext.takePdfManifestPrefetch(target)) || new Image();
          image.alt = `第 ${entry.page} 页`;
          image.decoding = "async";
          shell.appendChild(image);
        }
        image.fetchPriority = priority >= 3 ? "high" : priority >= 1 ? "auto" : "low";
        if (progressive) image.classList.add("progressive");
        if (priority >= 2 && readerContext.ocrManifestUrl && !/** @type {Navigator & {connection?: {saveData?: boolean}}} */ (navigator).connection?.saveData)
          loadText = readerContext.renderPdfOcrText(shell);
        loadText?.catch(() => {});
        if (manifest.codec === "avif") {
          const integrity = manifest.avifPages?.[entry.page - 1];
          if (!integrity) throw new Error("IMAGE_MANIFEST_INVALID");
          await loadVerifiedAvifPage(image, target, renderController.signal, integrity);
        } else await readerContext.imageLoader.load(image, target, renderController.signal);
        readerContext.assertReaderActive();
        // Reveal only a fully decoded page, never one painting from the top.
        if (!progressive) await decodePdfImage(image, renderController.signal);
        readerContext.assertReaderActive();
        const fade = pdfSurfaceFades(shell);
        readerContext.applyPdfShellGeometry(() => {
          shell.style.aspectRatio = `${image.naturalWidth || 1} / ${image.naturalHeight || 1}`;
          shell.dataset.pageGeometry = "1";
          revealPdfSurface(image, fade);
          readerContext.seedPdfPageGeometry?.(image.naturalWidth, image.naturalHeight);
        });
        // A speculative page may become visible while its image is loading.
        // The visibility observer saw "rendering" then, so it could not attach
        // text; do not keep the stale admission priority after image completion.
        if ((priority >= 2 || readerContext.isPdfPageVisible(shell)) && readerContext.ocrManifestUrl && !/** @type {Navigator & {connection?: {saveData?: boolean}}} */ (navigator).connection?.saveData)
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

  /** @param {import('../../../typings/reader-pdf-renderer-strict').PdfShell} shell @param {boolean} [force] @param {boolean | number} [priority] */
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
    /** @type {import('../../../typings/reader-pdf-renderer-strict').PdfRenderTask | null} */
    let activeRendering = null;
    const cancel = () => {
      renderController.abort();
      activeRendering?.cancel?.();
    };
    shell._renderCancel = cancel;
    const task = (async () => {
      let acquired = false;
      /** @type {HTMLCanvasElement | null} */
      let drawCanvas = null;
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
            pageNumber = Number(shell.dataset.page);
          // PDF.js has no cancelable getPage. Native DjVu geometry is queued
          // on the same worker as decoding, so cancel the request, not just the wait.
          const pageRequest = pdf.getPageForRender
            ? pdf.getPageForRender(pageNumber, Math.max(Number(priority), readerContext.pdfPagePriority(shell)),
              AbortSignal.any([renderController.signal, readerContext.readerAbortController.signal]))
            : pdf.getPage(pageNumber);
          const page = await readerContext.measurePdf(readerContext.awaitReader(pageRequest, renderController.signal), "page", pageNumber);
          readerContext.assertReaderActive();
          if (renderController.signal.aborted) throw readerContext.readerAbortError();
          const base = page.getViewport({ scale: 1 }),
            scale = Math.min(pdf.readerRenderScaleLimit ?? 3, shell.clientWidth / base.width),
            viewport = page.getViewport({ scale }),
            outputScale = pdfOutputScale(viewport);
          if (readerContext.pdfV3Map) {
            const geometry = /** @type {{width: number, height: number}} */ (readerContext.pdfV3Map.pages[pageNumber - 1]);
            if (Math.abs((base.width / base.height) / (geometry.width / geometry.height) - 1) > .01)
              throw new Error("PDF_V3_DOCUMENT_GEOMETRY_MISMATCH");
          }
          canvas = shell.querySelector("canvas");
          if (!canvas) {
            canvas = document.createElement("canvas");
            canvas.setAttribute("aria-hidden", "true");
            shell.prepend(canvas);
          }
          const targetWidth = Math.ceil(viewport.width * outputScale), targetHeight = Math.ceil(viewport.height * outputScale);
          if (pdf.readerMaxCanvasPixels && targetWidth * targetHeight > pdf.readerMaxCanvasPixels) {
            if (!readerContext.isReaderGenerationCurrent("pdf", generation)) {
              shell.dataset.pendingRerender = "1";
              continue;
            }
            throw new Error("DJVU_CANVAS_LIMIT_EXCEEDED");
          }
          // Only foreground demand can evict completed neighbors before drawing.
          // A speculative render can be cancelled; evicting first would make a
          // previously available page needlessly slow when the user returns.
          if (Math.max(Number(priority), readerContext.pdfPagePriority(shell)) >= 2)
            readerContext.trimPdfSurfaces(shell, targetWidth * targetHeight);
          // Resizing clears the frame; only now does this draw own the backing store.
          drawCanvas = canvas;
          canvas.classList.remove("ready");
          // Avoid a transient targetWidth × oldHeight backing allocation.
          if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
            canvas.width = 0;
            canvas.height = 0;
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
        // Idle shells aren't eviction candidates. Release only the unpublished
        // pixels this task allocated, before another draw can reuse the canvas.
        if (drawCanvas && shell._renderCancel === cancel && !drawCanvas.classList.contains("ready") &&
            (renderController.signal.aborted || readerContext.readerAbortController.signal.aborted ||
             /** @type {{name?: string} | null} */ (error)?.name === "AbortError"))
          drawCanvas.width = drawCanvas.height = 0;
        shell.dataset.renderState = "idle";
        throw error;
      } finally {
        if (acquired) { delete shell._pdfRenderOwnsSlot; readerContext.releasePdfRenderSlot(); }
      }
    })().finally(() => {
      if (shell._renderPromise === task) delete shell._renderPromise;
      if (shell._renderCancel === cancel) delete shell._renderCancel;
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
    pdfSurfaceFades
  };
}

/** @param {unknown} original */
function originalImageFallbackExtension(original) {
  const extension = typeof original === "string" ? original.toLowerCase() : "";
  return ["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(extension) ? extension : "";
}

/** @param {import('../../../typings/reader-controller-strict').ReaderFormatControllerContext} readerContext */
export function createReaderFormatController(readerContext) {
  /** @param {string} mode */
  function disposeFormatResources(mode) {
    if (mode === "epub-chapters") {
      readerContext.chapterManifestCleanup?.();
      readerContext.chapterManifestCleanup = null;
    }
    if (mode === "swf") {
      readerContext.swfPlayer?.remove();
      readerContext.swfPlayer = null;
    }
    if (["pdf", "pdf-pages", "image-pages"].includes(mode)) {
      readerContext.fullSearchController.resetAvailability();
      readerContext.pdfDocument = null;
      readerContext.pdfPageManifest = null;
      readerContext.pdfOcrManifest = null;
      readerContext.pdfOcrManifestPromise = null;
      readerContext.pdfV3Repository?.dispose(); readerContext.pdfTextLayerRepository?.dispose();
      readerContext.pdfV3Repository = readerContext.pdfTextLayerRepository = null;
      readerContext.pdfV3Manifest = readerContext.pdfV3Map = null;
      readerContext.pdfTextContentCache.clear();
      readerContext.pdfTextContentPromises.clear();
      readerContext.pdfTextContentCacheBytes = 0;
      readerContext.pdfOcrPageCache.clear();
      readerContext.pdfOcrPageCacheBytes = 0;
      readerContext.clearPdfManifestPrefetches();
      readerContext.pdfBookSearchClient?.dispose();
      readerContext.pdfBookSearchClient = null;
      readerContext.pdfShellWindow?.dispose();
      readerContext.pdfFirstPagePreload?.removeAttribute("src");
      readerContext.pdfFirstPagePreload = null;
      for (const canvas of /** @type {NodeListOf<HTMLCanvasElement>} */ (readerContext.content.querySelectorAll(".reader-page canvas"))) {
        canvas.width = 0;
        canvas.height = 0;
      }
      for (const image of readerContext.content.querySelectorAll(".reader-page img")) image.removeAttribute("src");
    }
    if (mode === "html") {
      readerContext.htmlFrame?.remove();
      readerContext.htmlFrame = null;
      readerContext.content.classList.remove("reader-content--spreadsheet");
    }
    if (["audio", "video"].includes(mode) && readerContext.mediaElement) {
      readerContext.mediaElement.pause();
      readerContext.mediaElement.removeAttribute("src");
      readerContext.mediaElement.load();
      readerContext.mediaElement = null;
    }
  }

  function openImagePages() {
    const manifest = readerContext.fetchReaderResponse();
    const generation = readerContext.readerRuntime.currentGeneration("navigation");
    // The trusted source determines the first WebP URL; the manifest still
    // determines whether any image can be displayed. Don't speculate while a
    // saved position is unknown, or if its lookup failed.
    void readerContext.readerRestorationPromise?.then(entry => {
      if (entry !== null || readerContext.restorationFailed ||
          !readerContext.isReaderGenerationCurrent("navigation", generation)) return;
      // If we can recover with the original, only request converted pages
      // after the manifest validates. Keep the overlap for other sources.
      if (originalImageFallbackExtension(readerContext.resolvedReaderData?.original_extension) &&
          readerContext.validSource(readerContext.downloadUrl)) return;
      return readerContext.preloadPdfFirstPage(1, generation);
    }).catch(() => {});
    return manifest;
  }

  function registerReaderFormatAdapters() {
    /** @template T @param {() => T | PromiseLike<T>} open @param {(value: Awaited<T>) => unknown} render */
    function pair(open, render) {
      return { open, render: /** @param {unknown} value */ (value) => render(/** @type {Awaited<T>} */ (value)) };
    }
    const formats = {
      "pdf-pages": pair(() => readerContext.fetchReaderResponse(), readerContext.renderPdfPages),
      "image-pages": pair(openImagePages, readerContext.renderImagePages),
      pdf: pair(() => {
        if (readerContext.extension !== "djvu") return readerContext.loadPdfDocument();
        readerContext.releasePdfWorker?.();
        // Keep the loader separate: its worker URL is relative to the loader module.
        const loaderUrl = "/search/static/reader/pdf/reader-djvu-loader.mjs";
        return import(loaderUrl).then(/** @param {typeof import('../pdf/reader-djvu-loader.mjs')} module */ module => module.openNativeDjvu(readerContext));
      }, readerContext.renderPdf),
      image: pair(readerContext.loadImageDocument, readerContext.renderImageDocument),
      text: pair(readerContext.loadTextDocument, readerContext.renderTextDocument),
      markdown: pair(readerContext.loadMarkdownDocument, readerContext.renderMarkdownDocument),
      html: pair(readerContext.loadHtmlDocument, readerContext.renderHtml),
      "epub-chapters": pair(readerContext.loadChapterManifestDocument, readerContext.renderChapterManifest),
      audio: pair(readerContext.loadMediaDocument, () => readerContext.renderMedia("audio")),
      video: pair(readerContext.loadMediaDocument, () => readerContext.renderMedia("video")),
      swf: pair(readerContext.loadSwfDocument, readerContext.renderSwf)
    };
    for (const [mode, {open, render}] of Object.entries(formats))
      readerContext.formatAdapters.register(mode, {
        open,
        render,
        restore: (entry, generation) => readerContext.restoreFormat(mode, entry, generation),
        dispose: () => readerContext.disposeFormatResources(mode)
      });
  }

  async function resolveReaderSource() {
    if (!readerContext.readerId || readerContext.sourceUrl) return;
    readerContext.setReaderStage("resolve");
    let resolved = readerContext.cachedReaderData;
    if (!resolved?.url) {
      try {
        resolved = await readerContext.resolveReaderId(readerContext.readerId);
      } catch (error) {
        readerContext.assertReaderActive();
        if (!readerContext.localReaderData?.url) throw error;
        resolved = readerContext.localReaderData;
      }
    }
    readerContext.assertReaderActive();
    if (!resolved) throw new Error("Invalid reader metadata");
    if (typeof resolved.original_extension === "string" && resolved.original_extension.toLowerCase().replace(/^\./,'') === 'djvu' &&
        typeof resolved.extension === "string" && resolved.extension.toLowerCase() === 'pdf-pages') {
      // Links saved before the direct reader may still resolve to an old page
      // stream. Use their original download URL, never the legacy page images.
      if (typeof resolved.download !== "string" || !readerContext.validSource(resolved.download) || !/\.djvu$/i.test(new URL(resolved.download).pathname))
        throw new Error('DJVU_ORIGINAL_SOURCE_REQUIRED');
      resolved = {...resolved,url:resolved.download,extension:'djvu'};
    }
    readerContext.sourceUrl = readerContext.normalizeSourceUrl(typeof resolved.url === "string" ? resolved.url : "");
    readerContext.contentUrl = readerContext.readerContentUrl(readerContext.sourceUrl);
    readerContext.downloadUrl = typeof resolved.download === "string" && resolved.download || readerContext.sourceUrl;
    readerContext.chapterManifestUrl = typeof resolved.chapter_manifest === "string" ? resolved.chapter_manifest : "";
    if (typeof resolved.extension === "string" && resolved.extension) readerContext.extension = resolved.extension.toLowerCase();
    if (
      readerContext.extension === "pdf" &&
      readerContext.sourceUrl.includes("/api/reader-bucket-resource?") &&
      new URL(readerContext.sourceUrl).searchParams.get("path")?.endsWith("page-manifest.json")
    )
      readerContext.extension = "pdf-pages";
    readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability(readerContext.extension));
    if (readerContext.capability.mode !== "pdf" && !readerContext.pdfPrimarySource()) readerContext.releasePdfWorker?.();
    readerContext.readerRuntime.update("source", {
      url: readerContext.sourceUrl,
      contentUrl: readerContext.contentUrl,
      downloadUrl: readerContext.downloadUrl,
      extension: readerContext.extension,
      metadata: resolved
    });
    readerContext.applyReaderMetadata(resolved);
  }

  async function start() {
    const generation = readerContext.readerRuntime.currentGeneration("navigation");
    // Resolve the original source and import its known engine concurrently.
    if (readerContext.extension === "pdf" || /\.pdf(?:$|[?#])/i.test(readerContext.sourceUrl)) readerContext.preloadPdfEngine().catch(() => {});
    readerContext.readerSourcePromise = readerContext.measurePdf(readerContext.resolveReaderSource(), "resolve");
    await readerContext.readerSourcePromise;
    readerContext.assertReaderActive();
    readerContext.syncCapabilityControls();
    readerContext.downloadButton.href = readerContext.readerDownloadUrl(readerContext.documentState.title, readerContext.downloadUrl);
    if (
      (!readerContext.validSource(readerContext.sourceUrl) && !readerContext.validSource(readerContext.chapterManifestUrl) && !readerContext.readerId) ||
      readerContext.capability.readerMode === VoiceOfMLReader.ReaderMode.UNSUPPORTED ||
      !readerContext.capability.mode
    )
      return readerContext.fail("此文件暂不支持在线阅读，请下载原文件。", "READER_UNSUPPORTED");
    readerContext.formatAdapters.activate(readerContext.capability.mode);
    readerContext.applyReaderMetadata(readerContext.resolvedReaderData);
    try {
      readerContext.setReaderStage("prepare");
      const restorationPromise = readerContext.loadReaderRestoration();
      readerContext.readerRestorationPromise = restorationPromise;
      const prepareResources = new Set(readerContext.readerResources);
      try {
        const active = readerContext.formatAdapters.active;
        if (!active) throw new Error("READER_ADAPTER_MISSING");
        const prepared = await readerContext.awaitReader(active.open());
        readerContext.assertReaderActive();
        const renderer = readerContext.formatAdapters.active;
        if (!renderer) throw new Error("READER_ADAPTER_MISSING");
        await renderer.render(prepared);
      } catch (error) {
        readerContext.assertReaderActive();
        const originalExtension = originalImageFallbackExtension(readerContext.resolvedReaderData?.original_extension);
        const mode = readerContext.capability.mode;
        if ((mode !== "image-pages" && (mode !== "image" || readerContext.sourceUrl === readerContext.downloadUrl)) ||
            !readerContext.validSource(readerContext.downloadUrl) || !originalExtension) throw error;
        for (const cleanup of [...readerContext.readerResources]) {
          if (prepareResources.has(cleanup)) continue;
          cleanup();
          readerContext.readerResources.delete(cleanup);
        }
        readerContext.formatAdapters.dispose();
        readerContext.content.replaceChildren();
        readerContext.extension = originalExtension;
        readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability(readerContext.extension));
        readerContext.readerRuntime.update("source", { extension: readerContext.extension });
        readerContext.updateDocumentState({ page: 1, pageCount: 0 });
        if (!readerContext.capability.mode) throw new Error("READER_ADAPTER_MISSING");
        readerContext.formatAdapters.activate(readerContext.capability.mode);
        readerContext.syncCapabilityControls();
        await readerContext.renderImageDocument(await readerContext.loadImageDocument(readerContext.downloadUrl));
      }
      readerContext.assertReaderActive();
      readerContext.markReaderContentReady();
      const restored = await readerContext.awaitReader(restorationPromise);
      // Capture the match before restoration consumes the bookmark parameters.
      const explicitBookmark = readerContext.capability.mode === "markdown" && restored?.id &&
        restored.id === readerContext.params.get("bookmark") && restored.url === readerContext.params.get("bookmark_source");
      await readerContext.applyInitialRestoration(restored, generation);
      readerContext.assertReaderActive();
      // A Markdown anchor overrides ordinary progress, but not a matched bookmark.
      if (readerContext.capability.mode === "markdown" && !explicitBookmark && location.hash &&
          readerContext.isReaderGenerationCurrent("navigation", generation)) {
        try {
          const id = decodeURIComponent(location.hash.slice(1));
          const article = readerContext.content.querySelector(".reader-markdown");
          const target = [...(article?.querySelectorAll("[id], [name]") || [])]
            .find(element => element.id === id || element.getAttribute("name") === id);
          target?.scrollIntoView({ block: "start" });
        } catch (_) {}
      }
      if (!readerContext.setReaderPhase("ready")) return;
      readerContext.updateDocumentState({ restorationReady: !readerContext.restorationFailed });
      readerContext.schedulePdfBookSearchPrefetch();
      readerContext.updateProgressTools();
      if (readerContext.fullSearchInput.value.trim()) readerContext.runFullSearch();
      readerContext.scheduleSave();
    } catch (error) {
      const detail = error !== null && (typeof error === "object" || typeof error === "function") ? error : null;
      if (readerContext.readerAbortController.signal.aborted || (detail && "name" in detail && detail.name === "AbortError")) return;
      console.error(error);
      const message = detail && "code" in detail && detail.code === "READER_PDF_RATE_LIMIT" ? "请求过于频繁，请稍后重试加载。" :
        detail && "message" in detail && typeof detail.message === "string" && detail.message ? detail.message : "原文件加载失败";
      const fallback = "READER_PARSE";
      const code = readerContext.classifyReaderError(error, fallback);
      readerContext.fail(message, typeof code === "string" ? code : fallback);
    }
  }

  function syncCapabilityControls() {
    readerContext.content.dataset.mode = readerContext.capability.mode || "unsupported";
    readerContext.pageInvertToggle.hidden = readerContext.capability.mode !== "pdf" && readerContext.capability.mode !== "pdf-pages";
    /** @type {HTMLElement} */ (document.querySelector(".page-controls")).hidden = !readerContext.capability.features.pagination;
    /** @type {HTMLElement} */ (document.querySelector(".zoom-controls")).hidden = !readerContext.capability.features.zoom;
    readerContext.mediaTab.hidden = !readerContext.capability.features.media;
    const noNativeText = !!readerContext.pdfDocument?.readerNoSearchableText && !readerContext.ocrManifestUrl;
    const searchOpen = readerContext.panelState.selected === "full-search";
    if (noNativeText && !searchOpen && document.activeElement === readerContext.fullSearchButton)
      /** @type {HTMLElement} */ (document.querySelector("#history")).focus({ preventScroll: true });
    readerContext.fullSearchButton.hidden = !readerContext.capability.features.search || (noNativeText && !searchOpen);
    readerContext.bookmarkRibbon.hidden = !readerContext.capability.features.bookmarks;
    /** @type {HTMLElement} */ (readerContext.readingProgressSummary.querySelector(".reader-progress-bookmark")).hidden =
      !readerContext.capability.features.bookmarks;
    if (readerContext.panelState.selected === "full-search" && readerContext.fullSearchButton.hidden)
      readerContext.closeFullSearchView();
    if (
      (readerContext.panelState.selected === "media" && readerContext.mediaTab.hidden) ||
      (readerContext.panelState.selected === "full-search" && readerContext.fullSearchButton.hidden)
    )
      readerContext.selectPanel("toc");
  }

  return {
    disposeFormatResources,
    registerReaderFormatAdapters,
    resolveReaderSource,
    start,
    syncCapabilityControls
  };
}

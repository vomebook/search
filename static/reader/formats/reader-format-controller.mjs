export function createReaderFormatController(readerContext) {
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
      readerContext.pdfDocument = null;
      readerContext.pdfPageManifest = null;
      readerContext.pdfOcrManifest = null;
      readerContext.pdfOcrManifestPromise = null;
      readerContext.pdfV3Repository?.dispose(); readerContext.pdfTextLayerRepository?.dispose();
      for (const shell of readerContext.pdfManifestShells) shell?._v3PreviewRelease?.();
      readerContext.pdfV3Repository = readerContext.pdfTextLayerRepository = null;
      readerContext.pdfV3Manifest = readerContext.pdfV3Map = null;
      readerContext.pdfHybridUrl = ""; readerContext.pdfHybridDocumentPromise = null;
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
      for (const canvas of readerContext.content.querySelectorAll(".reader-page canvas")) {
        canvas.width = 0;
        canvas.height = 0;
      }
      for (const image of readerContext.content.querySelectorAll(".reader-page img")) image.removeAttribute("src");
    }
    if (mode === "foliate") {
      readerContext.foliateSectionObserver?.disconnect();
      readerContext.foliateSectionObserver = null;
      readerContext.foliateSectionVirtualizer?.dispose();
      readerContext.foliateChapterRepository?.dispose();
      readerContext.foliateSectionVirtualizer = null;
      readerContext.foliateChapterRepository = null;
      readerContext.foliateSectionLoader = null;
      readerContext.foliateSectionSettler = null;
      try {
        const closing = readerContext.epubRendition?.close?.();
        closing?.catch?.(() => {});
      } catch (_) {}
      readerContext.epubRendition = null;
      readerContext.epubBook = null;
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

  function registerReaderFormatAdapters() {
    const formats = {
      "pdf-pages": [
        () => {
          return readerContext.fetchReaderResponse();
        },
        readerContext.renderPdfPages
      ],
      "image-pages": [
        () => readerContext.fetchReaderResponse(),
        readerContext.renderImagePages
      ],
      pdf: [readerContext.loadPdfDocument, readerContext.renderPdf],
      image: [readerContext.loadImageDocument, readerContext.renderImageDocument],
      text: [readerContext.loadTextDocument, readerContext.renderTextDocument],
      markdown: [readerContext.loadMarkdownDocument, readerContext.renderMarkdownDocument],
      html: [readerContext.loadHtmlDocument, readerContext.renderHtml],
      "epub-chapters": [readerContext.loadChapterManifestDocument, readerContext.renderChapterManifest],
      audio: [readerContext.loadMediaDocument, () => readerContext.renderMedia("audio")],
      video: [readerContext.loadMediaDocument, () => readerContext.renderMedia("video")],
      swf: [readerContext.loadSwfDocument, readerContext.renderSwf],
      foliate: [readerContext.loadMediaDocument, readerContext.renderFoliate]
    };
    for (const [mode, [open, render]] of Object.entries(formats))
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
    readerContext.sourceUrl = readerContext.normalizeSourceUrl(resolved.url || "");
    readerContext.contentUrl = readerContext.readerContentUrl(readerContext.sourceUrl);
    readerContext.downloadUrl = resolved.download || readerContext.sourceUrl;
    readerContext.chapterManifestUrl = resolved.chapter_manifest || "";
    readerContext.fallbackUrl = resolved.fallback || "";
    if (resolved.extension) readerContext.extension = String(resolved.extension).toLowerCase();
    if (
      readerContext.extension === "pdf" &&
      readerContext.sourceUrl.includes("/api/reader-bucket-resource?") &&
      new URL(readerContext.sourceUrl).searchParams.get("path")?.endsWith("page-manifest.json")
    )
      readerContext.extension = "pdf-pages";
    readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability(readerContext.extension));
    if (readerContext.capability.mode !== "pdf") readerContext.releasePdfWorker?.();
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
    if (readerContext.readerId && /\/calibre-chm-epub-[^/]+\/document\.epub(?:$|\?)/i.test(readerContext.sourceUrl)) {
      readerContext.extension = "epub";
      readerContext.readerRuntime.update("source", { extension: readerContext.extension });
      readerContext.capability = readerContext.readerRuntime.negotiate(VoiceOfMLReader.capability(readerContext.extension));
      readerContext.content.dataset.mode = readerContext.capability.mode;
      document.querySelector(".page-controls").hidden = true;
    }
    readerContext.syncCapabilityControls();
    readerContext.downloadButton.href = readerContext.readerDownloadUrl(readerContext.documentState.title, readerContext.downloadUrl);
    if (
      (!readerContext.validSource(readerContext.sourceUrl) && !readerContext.validSource(readerContext.chapterManifestUrl) && !readerContext.readerId) ||
      readerContext.capability.readerMode === VoiceOfMLReader.ReaderMode.UNSUPPORTED
    )
      return readerContext.fail("此文件暂不支持在线阅读，请下载原文件。", "READER_UNSUPPORTED");
    readerContext.formatAdapters.activate(readerContext.capability.mode);
    readerContext.applyReaderMetadata(readerContext.resolvedReaderData);
    if (readerContext.validOcr(readerContext.ocrUrl)) {
      const ocr = document.querySelector("#ocr") || document.createElement("a");
      ocr.id = "ocr";
      ocr.className = "text-button";
      ocr.target = "_blank";
      ocr.rel = "noopener noreferrer";
      ocr.textContent = "OCR";
      if (!ocr.parentElement) document.querySelector(".reader-actions")?.prepend(ocr);
      ocr.href = readerContext.ocrUrl;
      ocr.hidden = false;
    }
    try {
      if (readerContext.capability.mode === "foliate") {
        readerContext.setReaderStage("foliate");
        readerContext.foliateContinuous = true;
        const restorationPromise = readerContext.loadReaderRestoration();
        readerContext.readerRestorationPromise = restorationPromise;
        await readerContext.awaitReader(readerContext.renderFoliate());
        readerContext.assertReaderActive();
        const restored = await readerContext.awaitReader(restorationPromise);
        await readerContext.applyInitialRestoration(restored, generation);
        readerContext.initialReaderTargetSection = null;
        readerContext.assertReaderActive();
        if (!readerContext.setReaderPhase("ready")) return;
        readerContext.updateDocumentState({ restorationReady: !readerContext.restorationFailed });
        readerContext.scheduleSave();
        return;
      }
      readerContext.setReaderStage("prepare");
      const restorationPromise = readerContext.loadReaderRestoration();
      readerContext.readerRestorationPromise = restorationPromise;
      const prepareResources = new Set(readerContext.readerResources);
      try {
        const prepared = await readerContext.awaitReader(readerContext.formatAdapters.active.open());
        readerContext.assertReaderActive();
        await readerContext.formatAdapters.active.render(prepared);
      } catch (error) {
        readerContext.assertReaderActive();
        const originalExtension = String(readerContext.resolvedReaderData?.original_extension || "").toLowerCase();
        if (readerContext.capability.mode !== "image-pages" || !readerContext.validSource(readerContext.downloadUrl) ||
            !["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(originalExtension)) throw error;
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
        readerContext.formatAdapters.activate(readerContext.capability.mode);
        readerContext.syncCapabilityControls();
        await readerContext.renderImageDocument(await readerContext.loadImageDocument(readerContext.downloadUrl));
      }
      readerContext.assertReaderActive();
      readerContext.markReaderContentReady();
      const restored = await readerContext.awaitReader(restorationPromise);
      await readerContext.applyInitialRestoration(restored, generation);
      readerContext.assertReaderActive();
      if (!readerContext.setReaderPhase("ready")) return;
      readerContext.updateDocumentState({ restorationReady: !readerContext.restorationFailed });
      readerContext.schedulePdfBookSearchPrefetch();
      readerContext.updateProgressTools();
      if (readerContext.fullSearchInput.value.trim()) readerContext.runFullSearch();
      readerContext.scheduleSave();
    } catch (error) {
      if (readerContext.readerAbortController.signal.aborted || error?.name === "AbortError") return;
      console.error(error);
      if (
        error?.code !== "READER_RESTORE" &&
        readerContext.capability.mode === "epub-chapters" &&
        readerContext.validFallback(readerContext.fallbackUrl)
      ) {
        const target = new URL(location.href);
        target.searchParams.set("url", readerContext.fallbackUrl);
        target.searchParams.set("ext", "pdf");
        target.searchParams.delete("chapter_manifest");
        target.searchParams.delete("fallback");
        if (window.parent !== window)
          window.parent.postMessage({ type: "voice-reader-open", url: target.href }, location.origin);
        else location.replace(target.href);
        return;
      }
      readerContext.fail(
        error && error.message ? error.message : "原文件加载失败",
        readerContext.classifyReaderError(error, readerContext.capability.mode === "foliate" ? "READER_CORRUPT" : "READER_PARSE")
      );
    }
  }

  function syncCapabilityControls() {
    readerContext.content.dataset.mode = readerContext.capability.mode || "unsupported";
    readerContext.pageInvertToggle.hidden = !["pdf", "pdf-pages"].includes(readerContext.capability.mode);
    document.querySelector(".page-controls").hidden = !readerContext.capability.features.pagination;
    document.querySelector(".zoom-controls").hidden = !readerContext.capability.features.zoom;
    readerContext.mediaTab.hidden = !readerContext.capability.features.media;
    readerContext.fullSearchButton.hidden = !readerContext.capability.features.search;
    readerContext.bookmarkRibbon.hidden = !readerContext.capability.features.bookmarks;
    readerContext.readingProgressSummary.querySelector(".reader-progress-bookmark").hidden =
      !readerContext.capability.features.bookmarks;
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
